// Explicit live release gate; never runs as part of the offline test suite.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalize } from './contract.js';
import { validPageResponse } from './menu-v2.js';
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
if (!args.includes('--endpoint')) throw new Error('Supply --endpoint for an authorized v2 proxy; this gate transmits fixture photos.');
const endpoint = new URL(option('--endpoint'));
if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) throw new Error('Use HTTPS for remote proxies.');
const directory = resolve(args.includes('--fixtures') ? option('--fixtures') : new URL('./fixtures', import.meta.url).pathname);
let failures = 0;
for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
  const expected = JSON.parse(readFileSync(join(directory, file)));
  const jpeg = readFileSync(join(directory, file.replace(/\.json$/, '.jpg')));
  const started = Date.now();
  const response = await fetch(new URL('/api/v2/menu-pages/analyze', endpoint), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ requestId: randomUUID(), pageId: randomUUID(), jpegBase64: jpeg.toString('base64') })
  });
  if (!response.ok) { console.log(`${file}: FAIL HTTP ${response.status}`); failures++; continue; }
  const actual = await response.json();
  const matched = expected.dishes.every(d => actual.dishes?.some(a => normalize(a.name) === normalize(d.name)
    && normalize(a.price ?? '') === normalize(d.price ?? '')
    && a.compositionStatus === d.compositionStatus));
  const pass = validPageResponse(actual) && actual.status === expected.status && actual.dishes.length === expected.dishes.length && matched;
  console.log(`${file}: ${pass ? 'PASS' : 'FAIL'}; ${actual.dishes?.length ?? 0}/${expected.dishes.length} dishes; ${Date.now() - started} ms`);
  if (!pass) failures++;
  // Composition requires a separate human comparison; name/price counts do not certify dietary safety.
}
process.exitCode = failures ? 1 : 0;
