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
  globalThis.fetch = async (url, options) => { assert.equal(options.redirect, 'manual'); upstream = url; return new Response('{"status":"1"}', { headers: { 'Content-Type': 'application/json' } }); };
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
  assert.match(await (await worker.fetch(new Request(base), env)).text(), /i18n.js/);
  const languageAsset = await worker.fetch(new Request(base + '/i18n.js'), env);
  assert.equal(languageAsset.status, 200);
  assert.match(await languageAsset.text(), /window.I18n/);
  assert.equal((await worker.fetch(new Request(base + '/deployment-secrets.local.json'), env)).status, 404);
  assert.equal((await worker.fetch(new Request(base + '/README.md'), env)).status, 404);
});

test('hosted sightseeing UI includes the merged feature and exactly one runtime configuration', async () => {
  const page = await (await worker.fetch(new Request(base), env)).text();
  assert.match(page, /id="tour-places"/);
  assert.match(page, /id="plan-tour"/);
  assert.match(page, /value="auto"/);
  assert.equal((page.match(/src="\/site-config\.js"/g) || []).length, 1);
  assert.doesNotMatch(page, /基础路线测试版/);
  const optimizer = await (await worker.fetch(new Request(base + '/route-optimizer.js'), env)).text();
  assert.match(optimizer, /optimizeTourRoute/);
  for (const name of ['/tour-preview/index.html', '/tour-preview/local-map-source.json', '/tests/planning-ui.test.cjs', '/package.json']) assert.equal((await worker.fetch(new Request(base + name), env)).status, 404);
});

test('JSONP from all supported route endpoints has an executable content type', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('amapCallback({"status":"1"});', { headers: { 'Content-Type': 'application/json' } });
  try {
    for (const api of ['place/text', 'direction/driving', 'direction/walking', 'direction/transit/integrated']) {
      const response = await worker.fetch(new Request(base + '/_AMapService/v3/' + api + '?callback=amapCallback', { headers: { Referer: base + '/' } }), env);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Type'), /^text\/javascript/);
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.equal(await response.text(), 'amapCallback({"status":"1"});');
    }
  } finally { globalThis.fetch = original; }
});

test('proxy supports map styles and cycling while preserving provider errors', async () => {
  const original = globalThis.fetch;
  let target;
  globalThis.fetch = async (url) => { target = url; return new Response('{"status":"0"}', { status: 429, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const styles = await worker.fetch(new Request(base + '/_AMapService/v4/map/styles', { headers: { Origin: base } }), env);
    assert.equal(target.origin, 'https://webapi.amap.com'); assert.equal(styles.status, 429);
    const cycling = await worker.fetch(new Request(base + '/_AMapService/v4/direction/bicycling', { headers: { Referer: base + '/' } }), env);
    assert.equal(target.origin, 'https://restapi.amap.com'); assert.equal(cycling.status, 429);
    assert.match(cycling.headers.get('Content-Type'), /^application\/json/);
  } finally { globalThis.fetch = original; }
});

test('proxy rejects unsupported methods and bad referers, and reports upstream outages', async () => {
  assert.equal((await worker.fetch(new Request(base, { method: 'POST' }), env)).status, 405);
  assert.equal((await worker.fetch(new Request(base + '/_AMapService/v3/place/text', { headers: { Referer: 'not a URL' } }), env)).status, 403);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Offline'); };
  try {
    const response = await worker.fetch(new Request(base + '/_AMapService/v3/place/text', { headers: { Origin: base } }), env);
    assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /test-secret/);
  } finally { globalThis.fetch = original; }

});

test('SDK JSONP responses are executable under nosniff and coordinate conversion is permitted', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('sdkCallback({"status":"1","info":"ok","locations":"116,39"})', { headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
  try {
    const response = await worker.fetch(new Request(base + '/_AMapService/v3/assistant/coordinate/convert?callback=sdkCallback', { headers: { Referer: base + '/' } }), env);
    assert.equal(response.status, 200); assert.match(response.headers.get('Content-Type'), /text\/javascript/); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff'); assert.match(await response.text(), /^sdkCallback\(/);
    const json = await worker.fetch(new Request(base + '/_AMapService/v3/assistant/coordinate/convert', { headers: { Referer: base + '/' } }), env); assert.match(json.headers.get('Content-Type'), /application\/json/);
  } finally { globalThis.fetch = original; }
});

test('proxy failure diagnostics redact upstream URLs, credentials, and coordinates', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let diagnostic;
  globalThis.fetch = async (url) => { throw new TypeError('Diagnostic failure: ' + url.href + ' ' + env.AMAP_SECURITY_CODE + ' 116.397,39.908 ' + encodeURIComponent('116.397,39.908')); };
  console.error = (...values) => { diagnostic = JSON.stringify(values); };
  try {
    const response = await worker.fetch(new Request(base + '/_AMapService/v3/assistant/coordinate/convert?locations=116.397,39.908', { headers: { Referer: base + '/' } }), env);
    assert.equal(response.status, 502);
    assert.equal(await response.text(), 'Map service temporarily unavailable');
    assert.match(diagnostic, /Diagnostic failure/);
    assert.doesNotMatch(diagnostic, /test-key|test-secret|116\.397|39\.908|https:\/\/restapi/);
  } finally { globalThis.fetch = originalFetch; console.error = originalError; }
});

test('proxy rejects provider redirects without following them or exposing their destination', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let calls = 0;
  console.error = () => {};
  try {
    for (const status of [301, 302, 307, 308]) {
      globalThis.fetch = async (url, options) => {
        assert.equal(options.redirect, 'manual');
        calls += 1;
        return new Response('redirect body', { status, headers: { Location: 'https://other.example.com/?key=test-key&jscode=test-secret' } });
      };
      const response = await worker.fetch(new Request(base + '/_AMapService/v3/assistant/coordinate/convert', { headers: { Referer: base + '/' } }), env);
      assert.equal(response.status, 502);
      assert.equal(response.headers.get('Location'), null);
      assert.equal(await response.text(), 'Map service temporarily unavailable');
    }
    assert.equal(calls, 4);
  } finally { globalThis.fetch = originalFetch; console.error = originalError; }
});
