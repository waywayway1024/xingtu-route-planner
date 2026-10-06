import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
const base = 'https://route.example.com';
const env = { AMAP_JS_KEY: 'test-key', AMAP_SECURITY_CODE: 'test-secret' };
test('public configuration exposes the JS key but never the security secret', async () => {
  const response = await worker.fetch(new Request(base + '/site-config.js'), env);
  const text = await response.text();
  assert.match(text, /test-key/);
  assert.doesNotMatch(text, /test-secret/);
  assert.match(text, /managed/);
});
test('proxy rejects cross-origin use, unknown paths, and missing configuration', async () => {
  assert.equal((await worker.fetch(new Request(base + '/_AMapService/v3/place/text', { headers: { Origin: 'https://other.example.com' } }), env)).status, 403);
  assert.equal((await worker.fetch(new Request(base + '/_AMapService/arbitrary', { headers: { Origin: base } }), env)).status, 404);
  assert.equal((await worker.fetch(new Request(base + '/_AMapService/v3/place/text'), {})).status, 503);
});
test('proxy forwards to the fixed provider and replaces caller-supplied credentials', async () => {
  const original = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (url) => { upstream = url; return new Response('{"status":"1"}', { headers: { 'Content-Type': 'application/json' } }); };
  try {
    const response = await worker.fetch(new Request(base + '/_AMapService/v3/place/text?key=other&jscode=other&keywords=station', { headers: { Referer: base + '/' } }), env);
    assert.equal(response.status, 200);
    assert.equal(upstream.origin, 'https://restapi.amap.com');
    assert.equal(upstream.searchParams.get('key'), env.AMAP_JS_KEY);
    assert.equal(upstream.searchParams.get('jscode'), env.AMAP_SECURITY_CODE);
    assert.doesNotMatch(await response.text(), /test-secret/);
  } finally { globalThis.fetch = original; }
});
test('hosted build uses runtime configuration and does not publish local deployment files', async () => {
  assert.match(await (await worker.fetch(new Request(base), env)).text(), /site-config.js/);
  assert.equal((await worker.fetch(new Request(base + '/deployment-secrets.local.json'), env)).status, 404);
  assert.equal((await worker.fetch(new Request(base + '/README.md'), env)).status, 404);
});
