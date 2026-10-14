import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from './server.js';
import { validRequest, validResponse } from './contract.js';

const profile = { goal: 'Похудение', strictness: 'Обычно', restrictions: { avoidFatty: true, avoidFried: true, avoidCreamSauces: true, avoidSugarDesserts: true, avoidAlcohol: true }, exclusions: ['молоко'], preferences: ['овощи'] };
const result = { status: 'ok', summary: 'Можно рассмотреть салат', topChoices: [{ dishId: null, dishName: 'Греческий салат', confidence: 0.8, reasonShort: 'Овощи', reasonDetails: [], warnings: ['Уточните состав'], modifications: [], askUserClarification: null }], alternatives: [], rejectedHighlights: [] };

test('strict response validates membership, no choices, counts and confidence', () => {
  assert.ok(validResponse(result, 'Греческий салат'));
  assert.equal(validResponse(result, 'Другой салат'), false);
  assert.equal(validResponse({ ...result, topChoices: Array(4).fill(result.topChoices[0]) }, 'Греческий салат'), false);
  assert.equal(validResponse({ ...result, topChoices: [{ ...result.topChoices[0], confidence: '0.5' }] }, 'Греческий салат'), false);
  assert.ok(validResponse({ ...result, status: 'noSuitableChoices', topChoices: [] }, 'Греческий салат'));
});

test('HTTP contract, full menu/profile, idempotency, caps and removed legacy routes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'whattoeat-'));
  let calls = 0;
  const app = createApp({ env: { OPENAI_API_KEY: 'test', BUDGET_FILE: join(dir, 'budget.json'), MAX_DAILY_REQUESTS: '3', REQUESTS_PER_MINUTE: '100' }, log: () => {}, fetchGPT: async (_url, options) => {
    calls++;
    const sent = JSON.parse(options.body);
    if (sent.response_format) {
      const input = JSON.parse(sent.messages[1].content);
      assert.ok(input.menuText.endsWith('LAST DISH'));
      assert.equal(input.profile.restrictions.avoidAlcohol, true);
      assert.equal(input.profile.restrictions.avoidSugarDesserts, true);
      assert.equal(input.profile.id, undefined);
      assert.equal(sent.response_format.json_schema.strict, true);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: sent.response_format ? JSON.stringify(result) : 'Ответ' } }] }));
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = { menuText: 'Греческий салат\n' + 'Описание\n'.repeat(80) + 'LAST DISH', profile, requestId: randomUUID() };
  const replies = await Promise.all([post('/api/v1/recommendations', body), post('/api/v1/recommendations', body)]);
  assert.deepEqual(await replies[0].json(), result);
  assert.equal(replies[1].status, 200);
  assert.equal(calls, 1);
  assert.equal((await post('/api/v1/recommendations', { ...body, menuText: 'Другое меню' })).status, 409);
  assert.equal((await post('/api/v1/recommendations', { ...body, requestId: randomUUID(), menuText: 'x'.repeat(24001) })).status, 400);
  assert.equal((await post('/api/ask-gpt', { prompt: 'Вопрос' })).status, 404);
  assert.equal((await post('/api/analyze-image', {})).status, 404);
  assert.equal(calls, 1);
  await post('/api/v1/recommendations', { ...body, requestId: randomUUID() });
  await post('/api/v1/recommendations', { ...body, requestId: randomUUID() });
  assert.equal((await post('/api/v1/recommendations', { ...body, requestId: randomUUID() })).status, 503);

  const limited = createApp({ env: { REQUESTS_PER_MINUTE: '1', BUDGET_FILE: join(dir, 'unused.json') }, log: () => {} }).listen(0, '127.0.0.1');
  await new Promise(resolve => limited.once('listening', resolve));
  t.after(() => limited.close());
  const url = `http://127.0.0.1:${limited.address().port}/api/v1/recommendations`;
  const invalid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('access-control-allow-origin'), '*');
  const throttled = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('retry-after'), '60');
});

test('corrupt budget fails closed; valid previous day resets', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'whattoeat-budget-'));
  const path = join(dir, 'budget.json');
  let calls = 0;
  const server = createApp({ env: { OPENAI_API_KEY: 'test', BUDGET_FILE: path, REQUESTS_PER_MINUTE: '100' }, log: () => {}, fetchGPT: async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = () => fetch(`http://127.0.0.1:${server.address().port}/api/v1/recommendations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ menuText: 'Греческий салат', profile, requestId: randomUUID() })
  });
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (const state of [null, {}, { day: 'invalid', count: 0, tokens: 0 },
    { day: '2026-02-30', count: 0, tokens: 0 }, { day: tomorrow, count: 0, tokens: 0 },
    { day: yesterday, count: 'corrupt', tokens: -1 }, { day: today, count: -1, tokens: 0 }]) {
    const original = JSON.stringify(state);
    writeFileSync(path, original);
    const reply = await post();
    assert.equal(reply.status, 503);
    assert.deepEqual(await reply.json(), { error: 'budget_storage_unavailable' });
    assert.equal(readFileSync(path, 'utf8'), original);
  }
  assert.equal(calls, 0);
  writeFileSync(path, JSON.stringify({ day: yesterday, count: 200, tokens: 2000000 }));
  assert.equal((await post()).status, 200);
  assert.equal(calls, 1);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.day, today);
  assert.equal(saved.count, 1);
});

test('diet mode is optional, validated and forwarded', async t => {
  const body = { menuText: 'Греческий салат', profile, requestId: randomUUID() };
  assert.ok(validRequest(body));
  assert.ok(validRequest({ ...body, profile: { ...profile, dietMode: 'Low FODMAP' } }));
  assert.equal(validRequest({ ...body, profile: { ...profile, dietMode: 'unknown' } }), false);
  const dir = mkdtempSync(join(tmpdir(), 'whattoeat-diet-'));
  const app = createApp({ env: { OPENAI_API_KEY: 'test', BUDGET_FILE: join(dir, 'budget.json') }, log: () => {}, fetchGPT: async (_url, options) => {
    const sent = JSON.parse(options.body);
    assert.equal(JSON.parse(sent.messages[1].content).profile.dietMode, 'Low FODMAP');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  }});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/recommendations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, profile: { ...profile, dietMode: 'Low FODMAP' } }) });
  assert.equal(response.status, 200);
});
