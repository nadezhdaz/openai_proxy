import express from 'express';
import cors from 'cors';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema, systemMessage, validRequest, validResponse } from './contract.js';
import { pageSchema, pageMessage, recommendationMessage, validPageRequest, validPageResponse, validCatalogRequest, validCatalogResponse, dietaryProfile } from './menu-v2.js';
import { randomUUID } from 'node:crypto';

export function createApp({ fetchGPT = fetch, env = process.env, log = console.log } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.set('trust proxy', Number(env.TRUST_PROXY_HOPS || 0));
  app.use('/api/v2/menu-pages/analyze', express.json({ limit: '4200kb' }));
  app.use('/api/v2/recommendations', express.json({ limit: '600kb' }));
  app.use(express.json({ limit: '40kb' }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff'); next(); });
  const requests = new Map();
  const rates = new Map();
  const budgetPath = env.BUDGET_FILE || './data/budget.json';
  const maxDaily = Number(env.MAX_DAILY_REQUESTS || 200);
  const tokenBudget = Number(env.MAX_DAILY_TOKENS || 2_000_000);
  const minuteLimit = Number(env.REQUESTS_PER_MINUTE || 60);
  const model = env.OPENAI_MODEL || 'gpt-4o-mini-2024-07-18';
  const ttl = 10 * 60 * 1000;
  const maxOutput = 1600;
  if (![maxDaily, tokenBudget, minuteLimit].every(value => Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(Number(env.TRUST_PROXY_HOPS || 0)) || Number(env.TRUST_PROXY_HOPS || 0) < 0) {
    throw new Error('Invalid limits or TRUST_PROXY_HOPS');
  }

  function reserve(inputBytes, outputLimit = maxOutput) {
    const day = new Date().toISOString().slice(0, 10);
    let budget = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, 'utf8')) : { day, count: 0, tokens: 0 };
    if (!budget || typeof budget.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(budget.day)
        || !Number.isFinite(Date.parse(budget.day)) || new Date(budget.day).toISOString().slice(0, 10) !== budget.day
        || budget.day > day || ![budget.count, budget.tokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('invalid_budget');
    }
    if (budget.day !== day) budget = { day, count: 0, tokens: 0 };
    // ponytail: conservative byte-to-token reservation, no refunds; use shared accounting before scaling beyond one instance.
    const tokens = inputBytes + outputLimit + Buffer.byteLength(systemMessage) + 512;
    if (budget.count >= maxDaily || budget.tokens + tokens > tokenBudget) return false;
    mkdirSync(dirname(budgetPath), { recursive: true });
    writeFileSync(`${budgetPath}.tmp`, JSON.stringify({ day, count: budget.count + 1, tokens: budget.tokens + tokens }));
    renameSync(`${budgetPath}.tmp`, budgetPath);
    return true;
  }

  app.use('/api', (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of rates) if (value.until < now) rates.delete(key);
    if (rates.size >= 10000 && !rates.has(req.ip)) return res.status(429).json({ error: 'rate_limit' });
    let rate = rates.get(req.ip);
    if (!rate) {
      rate = { count: 0, until: now + 60000 };
      const key = req.ip;
      rates.set(key, rate);
      setTimeout(() => { if (rates.get(key) === rate) rates.delete(key); }, 60000).unref();
    }
    if (++rate.count > minuteLimit) return res.status(429).set('Retry-After', '60').json({ error: 'rate_limit' });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  async function generate(messages, outputSchema = schema, schemaName = 'menu_recommendations_v1', outputLimit = maxOutput) {
    if (!env.OPENAI_API_KEY) return { status: 503, body: { error: 'not_configured' } };
    const upstream = await fetchGPT('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(45000),
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: outputLimit, store: false,
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: outputSchema } } })
    });
    if (!upstream.ok) return { status: upstream.status === 429 ? 429 : 502, body: { error: 'upstream_error' } };
    const result = await upstream.json();
    const choice = result.choices?.[0];
    if (choice?.message?.refusal) return { status: 422, body: { error: 'model_refusal' } };
    if (choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string') return { status: 502, body: { error: 'incomplete_response' } };
    return { status: 200, body: JSON.parse(choice.message.content) };
  }

  app.post('/api/v1/recommendations', async (req, res) => {
    const started = Date.now();
    if (!validRequest(req.body)) return res.status(400).json({ error: 'invalid_request' });
    const { menuText, profile, requestId } = req.body;
    // Send only dietary fields, not local profile identifiers or timestamps.
    const input = JSON.stringify({ menuText, profile: { goal: profile.goal, dietMode: profile.dietMode, strictness: profile.strictness, restrictions: profile.restrictions, exclusions: profile.exclusions, preferences: profile.preferences } });
    const hash = createHash('sha256').update(input).digest('hex');
    for (const [key, value] of requests) if (value.expires < Date.now() && value.done) requests.delete(key);
    let entry = requests.get(requestId);
    if (entry && entry.hash !== hash) return res.status(409).json({ error: 'request_id_conflict' });
    try {
      if (!entry) {
        if (requests.size >= 1000) return res.status(503).json({ error: 'busy' });
        if (!reserve(Buffer.byteLength(input))) return res.status(503).json({ error: 'budget_limit' });
        entry = { hash, expires: Date.now() + ttl, done: false };
        entry.promise = generate([{ role: 'system', content: systemMessage }, { role: 'user', content: input }])
          .then(result => {
            if (result.status === 200 && !validResponse(result.body, menuText)) return { status: 502, body: { error: 'invalid_response' } };
            return result;
          }).catch(error => ({ status: error.name === 'TimeoutError' ? 504 : 502, body: { error: error.name === 'TimeoutError' ? 'upstream_timeout' : 'upstream_failure' } }))
          .finally(() => {
            entry.done = true;
            entry.expires = Date.now() + ttl;
            setTimeout(() => { if (requests.get(requestId) === entry) requests.delete(requestId); }, ttl).unref();
          });
        requests.set(requestId, entry);
      }
      const result = await entry.promise;
      log(JSON.stringify({ requestId, status: result.status, elapsedMs: Date.now() - started }));
      res.status(result.status).json(result.body);
    } catch { res.status(503).json({ error: 'budget_storage_unavailable' }); }
  });

  // The cache keeps hashes and structured answers, never image bodies after generation.
  async function cachedV2(req, res, input, tokens, outputLimit, run) {
    const started = Date.now();
    const hash = createHash('sha256').update(req.path).update(input).digest('hex');
    const key = req.body.requestId;
    let entry = requests.get(key);
    if (entry && entry.done && entry.expires < Date.now()) { requests.delete(key); entry = null; }
    if (entry && entry.hash !== hash) return res.status(409).json({ error: 'request_id_conflict' });
    try {
      if (!entry) {
        for (const [id, old] of requests) if (old.done && old.expires < Date.now()) requests.delete(id);
        if (requests.size >= 1000) return res.status(503).json({ error: 'busy' });
        if (!reserve(tokens, outputLimit)) return res.status(503).json({ error: 'budget_limit' });
        entry = { hash, done: false, expires: Date.now() + ttl };
        entry.promise = run().catch(error => ({ status: error.name === 'TimeoutError' ? 504 : 502,
          body: { error: error.name === 'TimeoutError' ? 'upstream_timeout' : 'upstream_failure' } }))
          .finally(() => {
            entry.done = true; entry.expires = Date.now() + ttl;
            setTimeout(() => { if (requests.get(key) === entry) requests.delete(key); }, ttl).unref();
          });
        requests.set(key, entry);
      }
      const result = await entry.promise;
      log(JSON.stringify({ requestId: key, stage: req.path.endsWith('analyze') ? 'reading' : 'ranking', status: result.status, elapsedMs: Date.now() - started }));
      res.status(result.status).json(result.body);
    } catch { res.status(503).json({ error: 'budget_storage_unavailable' }); }
  }
  app.post('/api/v2/menu-pages/analyze', async (req, res) => {
    if (!validPageRequest(req.body)) return res.status(400).json({ error: 'invalid_request' });
    const { pageId, jpegBase64 } = req.body;
    await cachedV2(req, res, JSON.stringify({ pageId, jpegBase64 }), 150000 + Buffer.byteLength(pageMessage), 12000, async () => {
      const result = await generate([{ role: 'system', content: pageMessage }, { role: 'user', content: [
        { type: 'text', text: 'Прочитай блюда на этой странице.' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}`, detail: 'high' } }
      ] }], pageSchema, 'menu_page_v2', 12000);
      if (result.status !== 200) return result;
      if (!validPageResponse(result.body)) return { status: 502, body: { error: 'invalid_response' } };
      return { status: 200, body: { ...result.body, pageId,
        dishes: result.body.dishes.map(d => ({ ...d, id: randomUUID(), pageId })) } };
    });
  });
  app.post('/api/v2/recommendations', async (req, res) => {
    if (!validCatalogRequest(req.body)) return res.status(400).json({ error: 'invalid_request' });
    const { menu, profile } = req.body;
    const input = JSON.stringify({ menu, profile: dietaryProfile(profile) });
    await cachedV2(req, res, input, Buffer.byteLength(input) + Buffer.byteLength(recommendationMessage), maxOutput, async () => {
      const result = await generate([{ role: 'system', content: recommendationMessage }, { role: 'user', content: input }]);
      if (result.status === 200 && !validCatalogResponse(result.body, menu)) return { status: 502, body: { error: 'invalid_response' } };
      return result;
    });
  });

  app.use((error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).json({ error: 'invalid_body' }));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
  createApp().listen(process.env.PORT || 3000, () => console.log('WhatToEat proxy ready'));
}
