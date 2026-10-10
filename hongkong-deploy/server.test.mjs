import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { createSiteServer } from './out/server.mjs';

function requestWithHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    get(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode, headers: response.headers,
      })));
    }).on('error', reject);
  });
}

test('Hong Kong adapter preserves pages, HTTPS origin and map proxy restrictions', async t => {
  const server = createSiteServer({ AMAP_JS_KEY: 'test-public-key', AMAP_SECURITY_CODE: 'test-private-code' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /site-config\.js/);
  assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(base, { method: 'HEAD' })).headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/amap.private.env`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal((await requestWithHeaders(base, { Host: 'attacker.example' })).status, 400);
  const config = await requestWithHeaders(`${base}/site-config.js`, { Host: 'example.com', 'X-Forwarded-Proto': 'https' });
  const text = await config.text();
  assert.match(text, /https:\/\/example\.com\/_AMapService/);
  assert.match(text, /test-public-key/);
  assert.doesNotMatch(text, /test-private-code/);
  assert.equal((await fetch(`${base}/_AMapService/v3/place/text`)).status, 403);
  assert.equal((await fetch(`${base}/_AMapService/v3/place/text`, { headers: { Referer: 'https://attacker.example/' } })).status, 403);
  assert.equal((await fetch(`${base}/_AMapService/not-allowed`, { headers: { Referer: base } })).status, 404);

  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async input => {
    upstream = new URL(input);
    return new Response('callback({"status":"1"})', { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const proxy = await requestWithHeaders(`${base}/_AMapService/v3/place/text?key=wrong&jscode=wrong&callback=callback`, { Host: 'example.com', 'X-Forwarded-Proto': 'https', Referer: 'https://example.com/' });
    assert.equal(proxy.status, 200);
    assert.equal(proxy.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(proxy.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await proxy.text(), /^callback\(/);
    assert.equal(upstream.hostname, 'restapi.amap.com');
    assert.equal(upstream.searchParams.get('key'), 'test-public-key');
    assert.equal(upstream.searchParams.get('jscode'), 'test-private-code');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('downloaded server requires both of its own map credentials', async t => {
  for (const env of [{}, { AMAP_JS_KEY: 'own-key' }, { AMAP_SECURITY_CODE: 'own-code' }]) {
    const server = createSiteServer(env);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await (await fetch(`${base}/site-config.js`)).text();
    assert.doesNotMatch(config, /own-key|own-code|serviceHost/);
    assert.equal((await fetch(`${base}/_AMapService/v3/place/text`)).status, 503);
  }
});
