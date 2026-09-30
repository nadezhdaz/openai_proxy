import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema, systemMessage, validRequest, validResponse } from './contract.js';

export function createApp({ fetchGPT = fetch, env = process.env, log = console.log } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.set('trust proxy', Number(env.TRUST_PROXY_HOPS || 0));
  app.use(express.json({ limit: '40kb' }));
  const requests = new Map();
  const rates = new Map();
  const budgetPath = env.BUDGET_FILE || './data/budget.json';
  const maxDaily = Number(env.MAX_DAILY_REQUESTS || 200);
  const tokenBudget = Number(env.MAX_DAILY_TOKENS || 2_000_000);
  const minuteLimit = Number(env.REQUESTS_PER_MINUTE || 6);
  const model = env.OPENAI_MODEL || 'gpt-4o-mini-2024-07-18';
  const ttl = 10 * 60 * 1000;
  const maxOutput = 1600;
  if (![maxDaily, tokenBudget, minuteLimit].every(value => Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(Number(env.TRUST_PROXY_HOPS || 0)) || Number(env.TRUST_PROXY_HOPS || 0) < 0) {
    throw new Error('Invalid limits or TRUST_PROXY_HOPS');
  }

  function reserve(inputBytes) {
    const day = new Date().toISOString().slice(0, 10);
    let budget = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, 'utf8')) : { day, count: 0, tokens: 0 };
    if (budget.day !== day) budget = { day, count: 0, tokens: 0 };
    if (![budget.count, budget.tokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid_budget');
    // ponytail: conservative byte-to-token reservation, no refunds; use shared accounting before scaling beyond one instance.
    const tokens = inputBytes + maxOutput + Buffer.byteLength(systemMessage) + 512;
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

  async function generate(messages, structured) {
    if (!env.OPENAI_API_KEY) return { status: 503, body: { error: 'not_configured' } };
    const upstream = await fetchGPT('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(45000),
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxOutput,
        ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'menu_recommendations_v1', strict: true, schema } } } : {}) })
    });
    if (!upstream.ok) return { status: upstream.status === 429 ? 429 : 502, body: { error: 'upstream_error' } };
    const result = await upstream.json();
    const choice = result.choices?.[0];
    if (choice?.message?.refusal) return { status: 422, body: { error: 'model_refusal' } };
    if (choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string') return { status: 502, body: { error: 'incomplete_response' } };
    return { status: 200, body: structured ? JSON.parse(choice.message.content) : { result: choice.message.content } };
  }

  app.post('/api/v1/recommendations', async (req, res) => {
    const started = Date.now();
    if (!validRequest(req.body)) return res.status(400).json({ error: 'invalid_request' });
    const { menuText, profile, requestId } = req.body;
    // Send only dietary fields, not local profile identifiers or timestamps.
    const input = JSON.stringify({ menuText, profile: { goal: profile.goal, strictness: profile.strictness, restrictions: profile.restrictions, exclusions: profile.exclusions, preferences: profile.preferences } });
    const hash = createHash('sha256').update(input).digest('hex');
    for (const [key, value] of requests) if (value.expires < Date.now() && value.done) requests.delete(key);
    let entry = requests.get(requestId);
    if (entry && entry.hash !== hash) return res.status(409).json({ error: 'request_id_conflict' });
    try {
      if (!entry) {
        if (requests.size >= 1000) return res.status(503).json({ error: 'busy' });
        if (!reserve(Buffer.byteLength(input))) return res.status(503).json({ error: 'budget_limit' });
        entry = { hash, expires: Date.now() + ttl, done: false };
        entry.promise = generate([{ role: 'system', content: systemMessage }, { role: 'user', content: input }], true)
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

  // Legacy routes keep their original request/response shape, but share limits and spend caps.
  app.post('/api/ask-gpt', async (req, res) => {
    if (typeof req.body?.prompt !== 'string' || !req.body.prompt.trim() || Buffer.byteLength(req.body.prompt) > 24000) return res.status(400).json({ error: 'invalid_prompt' });
    try {
      if (!reserve(Buffer.byteLength(req.body.prompt))) return res.status(503).json({ error: 'budget_limit' });
      const result = await generate([{ role: 'system', content: systemMessage }, { role: 'user', content: req.body.prompt }], false);
      res.status(result.status).json(result.body);
    } catch { res.status(502).json({ error: 'upstream_failure' }); }
  });
  const upload = multer({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.post('/api/analyze-image', upload.single('file'), async (req, res) => {
    if (!req.file || !['image/jpeg', 'image/png'].includes(req.file.mimetype)) return res.status(400).json({ error: 'invalid_image' });
    const context = req.body.context || 'Проанализируй меню по правилам питания.';
    if (typeof context !== 'string' || Buffer.byteLength(context) > 24000) return res.status(400).json({ error: 'invalid_context' });
    try {
      // Reserve conservatively for image tokens as well as text.
      if (!reserve(30000 + Buffer.byteLength(context))) return res.status(503).json({ error: 'budget_limit' });
      const result = await generate([{ role: 'system', content: systemMessage }, { role: 'user', content: [
        { type: 'text', text: context }, { type: 'image_url', image_url: { url: `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`, detail: 'low' } }
      ] }], false);
      res.status(result.status).json(result.body);
    } catch { res.status(502).json({ error: 'upstream_failure' }); }
  });
  app.use((error, _req, res, _next) => res.status(error.status === 413 || error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'invalid_body' }));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
  createApp().listen(process.env.PORT || 3000, () => console.log('WhatToEat proxy ready'));
}
