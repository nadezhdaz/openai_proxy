import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.js';
import { validPageRequest, validPageResponse, validCatalogRequest, validCatalogResponse } from './menu-v2.js';

const photo = jpeg.encode({ width: 2, height: 2, data: Buffer.alloc(16, 255) }, 90).data.toString('base64');
const extracted = JSON.parse(readFileSync(new URL('./fixtures/two-column-menu.json', import.meta.url)));
const profile = { goal: 'Поддержание', dietMode: 'Low FODMAP', strictness: 'Обычно', restrictions: Object.fromEntries(['avoidFatty', 'avoidFried', 'avoidCreamSauces', 'avoidSugarDesserts', 'avoidAlcohol'].map(k => [k, false])), exclusions: [], preferences: [] };
const page = () => ({ requestId: randomUUID(), pageId: randomUUID(), jpegBase64: photo });
function recommendations(dish) {
  return { status: 'ok', summary: 'Подборка по прочитанным блюдам', topChoices: [{ dishId: dish.id, dishName: dish.name, confidence: 0.8, reasonShort: 'Подходит под правила', reasonDetails: [], warnings: [], modifications: [], askUserClarification: null }], alternatives: [], rejectedHighlights: [] };
}

test('image validation rejects fake, oversized, malformed and remote image data', () => {
  assert.ok(validPageRequest(page()));
  for (const value of ['https://example.com/photo.jpg', 'not base64', Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 1, 0, 1, 0, 255, 217]).toString('base64'), '/'.repeat(4194305)]) {
    assert.equal(validPageRequest({ ...page(), jpegBase64: value }), false);
  }
  assert.equal(validPageRequest({ ...page(), pageId: '../outside' }), false);
});

test('page contract preserves seven source dishes; ambiguity and missing composition stay explicit', () => {
  assert.ok(validPageResponse(extracted));
  assert.equal(extracted.dishes.length, 7);
  assert.deepEqual(extracted.dishes.map(d => d.price), ['790', '890', '750', '850', '990', '750', '1090']);
  assert.ok(validPageResponse({ status: 'partial', issues: ['Мелкий текст'], dishes: [{ name: 'Салат', description: null, price: null, compositionStatus: 'unreadable' }] }));
  assert.ok(validPageResponse({ status: 'unreadable', issues: ['Текст размытый'], dishes: [] }));
  assert.equal(validPageResponse({ ...extracted, dishes: [{ ...extracted.dishes[0], name: '790' }] }), false);
  assert.equal(validPageResponse({ ...extracted, dishes: [{ ...extracted.dishes[0], description: 'Выдуманный состав', compositionStatus: 'notListed' }] }), false);
  assert.equal(validPageResponse({ status: 'readable', issues: [], dishes: [] }), false);
});

test('catalog references stable IDs; same name with different composition is allowed', () => {
  const dish = { ...extracted.dishes[0], id: randomUUID(), pageId: randomUUID() };
  assert.ok(validCatalogRequest({ menu: [dish], profile, requestId: randomUUID() }));
  assert.ok(validCatalogResponse(recommendations(dish), [dish]));
  assert.equal(validCatalogResponse(recommendations({ ...dish, id: randomUUID() }), [dish]), false);
  assert.equal(validCatalogResponse(recommendations({ ...dish, name: 'Другое блюдо' }), [dish]), false);
  const other = { ...dish, id: randomUUID(), description: 'Другой состав' };
  const result = { ...recommendations(dish), alternatives: recommendations(other).topChoices };
  assert.ok(validCatalogResponse(result, [dish, other]));
  assert.equal(validCatalogResponse({ ...result, alternatives: result.topChoices }, [dish, other]), false);
  assert.equal(validCatalogRequest({ menu: [dish, dish], profile, requestId: randomUUID() }), false);
});

test('v2 HTTP: image-only extraction, idempotency, ranking membership, budgets and content-free logs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'whattoeat-v2-'));
  let calls = 0;
  let invalidRanking = false;
  const logs = [];
  const server = createApp({ env: { OPENAI_API_KEY: 'test', BUDGET_FILE: join(directory, 'budget.json'), REQUESTS_PER_MINUTE: '100' }, log: value => logs.push(value), fetchGPT: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    const extraction = Array.isArray(body.messages[1].content);
    assert.equal(body.store, false);
    let answer;
    if (extraction) {
      assert.equal(body.messages[1].content[1].image_url.url, `data:image/jpeg;base64,${photo}`);
      assert.ok(!options.body.includes('exclusions'));
      answer = extracted;
    } else {
      const input = JSON.parse(body.messages[1].content);
      assert.equal(input.profile.id, undefined);
      assert.equal(input.profile.dietMode, 'Low FODMAP');
      answer = recommendations(input.menu[0]);
      if (invalidRanking) answer.topChoices[0].dishId = randomUUID();
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }));
  }}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = page();
  const [first, repeated] = await Promise.all([post('/api/v2/menu-pages/analyze', body), post('/api/v2/menu-pages/analyze', body)]);
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.deepEqual(await repeated.json(), result);
  assert.equal(result.dishes.length, 7);
  assert.equal(new Set(result.dishes.map(d => d.id)).size, 7);
  assert.ok(result.dishes.every(d => d.pageId === body.pageId));
  assert.equal(calls, 1);
  assert.equal((await post('/api/v2/menu-pages/analyze', { ...body, pageId: randomUUID() })).status, 409);
  assert.equal((await post('/api/v2/menu-pages/analyze', { ...body, requestId: randomUUID(), jpegBase64: 'https://example.com' })).status, 400);
  const ranking = { requestId: randomUUID(), menu: result.dishes, profile: { ...profile, id: 'local-secret' } };
  assert.equal((await post('/api/v2/recommendations', ranking)).status, 200);
  assert.equal((await post('/api/v2/recommendations', ranking)).status, 200);
  assert.equal(calls, 2);
  invalidRanking = true;
  assert.equal((await post('/api/v2/recommendations', { ...ranking, requestId: randomUUID() })).status, 502);
  assert.ok(logs.every(line => !line.includes(photo.slice(0, 100)) && !line.includes('Тонкацу') && !line.includes('exclusions')));
  assert.equal(readFileSync(join(directory, 'budget.json'), 'utf8').includes('jpeg'), false);
});
