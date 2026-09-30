import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from './server.js';
import { validResponse } from './contract.js';

const profile = { goal: 'Похудение', strictness: 'Обычно', restrictions: { avoidFatty: true, avoidFried: true, avoidCreamSauces: true, avoidSugarDesserts: true, avoidAlcohol: true }, exclusions: ['молоко'], preferences: ['овощи'] };
const result = { status: 'ok', summary: 'Можно рассмотреть салат', topChoices: [{ dishId: null, dishName: 'Греческий салат', confidence: 0.8, reasonShort: 'Овощи', reasonDetails: [], warnings: ['Уточните состав'], modifications: [], askUserClarification: null }], alternatives: [], rejectedHighlights: [] };

test('strict response validates membership, no choices, counts and confidence', () => {
  assert.ok(validResponse(result, 'Греческий салат'));
  assert.equal(validResponse(result, 'Другой салат'), false);
  assert.equal(validResponse({ ...result, topChoices: Array(4).fill(result.topChoices[0]) }, 'Греческий салат'), false);
  assert.equal(validResponse({ ...result, topChoices: [{ ...result.topChoices[0], confidence: '0.5' }] }, 'Греческий салат'), false);
  assert.ok(validResponse({ ...result, status: 'noSuitableChoices', topChoices: [] }, 'Греческий салат'));
});

test('HTTP contract, full menu/profile, idempotency, caps and legacy routes', async t => {
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
  assert.deepEqual(await (await post('/api/ask-gpt', { prompt: 'Вопрос' })).json(), { result: 'Ответ' });
  await post('/api/ask-gpt', { prompt: 'Вопрос' });
  assert.equal((await post('/api/ask-gpt', { prompt: 'Вопрос' })).status, 503);

  const limited = createApp({ env: { REQUESTS_PER_MINUTE: '1', BUDGET_FILE: join(dir, 'unused.json') }, log: () => {} }).listen(0, '127.0.0.1');
  await new Promise(resolve => limited.once('listening', resolve));
  t.after(() => limited.close());
  const url = `http://127.0.0.1:${limited.address().port}/api/ask-gpt`;
  const invalid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('access-control-allow-origin'), '*');
  const throttled = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('retry-after'), '60');
});
