const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { files, createAssets } = require('../public-assets.cjs');

const source = fs.readFileSync(path.join(__dirname, '../pwa.js'), 'utf8');
const current = '1111111111111111', latest = '2222222222222222';
const settle = () => new Promise(resolve => setImmediate(resolve));
function browser({ coarse = false, version = current } = {}) {
  const elements = { 'app-update': { hidden: true }, 'app-update-message': {}, 'app-update-button': {}, destination: { value: '颐和园' } };
  const viewport = { content: 'width=device-width, initial-scale=1' };
  const document = Object.assign(new EventTarget(), { hidden: false, querySelector: selector => selector === 'meta[name="viewport"]' ? viewport : { content: version }, getElementById: id => elements[id] });
  const navigator = { onLine: true };
  const calls = [], intervals = [], timers = new Map();
  const state = { version: current, fail: false, reloads: 0, language: 'zh' };
  let languageChanged;
  const window = Object.assign(new EventTarget(), {
    matchMedia: () => ({ matches: coarse }),
    location: { reload() { state.reloads++; } },
    I18n: { t: text => state.language === 'zh' ? text : 'en:' + text, onChange(fn) { languageChanged = fn; } }
  });
  const context = {
    document, navigator, window, AbortController,
    setInterval(fn, delay) { intervals.push({ fn, delay }); },
    setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      calls.push({ url, options });
      if (state.fail) throw new Error('Network failed');
      return { ok: true, json: async () => ({ version: state.version }) };
    }
  };
  vm.runInNewContext(source, context);
  return { elements, document, navigator, window, state, calls, intervals, timers, viewport, translate() { languageChanged(); } };
}

function zoomEvent(page, type, target, touches) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  if (touches) Object.defineProperty(event, 'touches', { value: touches.map(target => ({ target })) });
  page.document.dispatchEvent(event);
  return event.defaultPrevented;
}
const outside = { closest: () => null };
const mapSurface = { closest: selector => selector === '#map' ? {} : null };
const metroSurface = { closest: selector => selector === '#metro-map' ? {} : null };
const mapCard = { closest: () => ({}) };

test('phone page zoom is blocked without cancelling single-finger scrolling or taps', () => {
  const page = browser({ coarse: true });
  assert.match(page.viewport.content, /maximum-scale=1, user-scalable=no/);
  assert.match(page.viewport.content, /viewport-fit=cover/);
  for (const type of ['touchstart', 'touchmove']) {
    assert.equal(zoomEvent(page, type, outside, [outside]), false);
    assert.equal(zoomEvent(page, type, outside, [outside, outside]), true);
  }
  for (const type of ['gesturestart', 'gesturechange', 'dblclick']) assert.equal(zoomEvent(page, type, outside), true);
  assert.equal(zoomEvent(page, 'click', outside), false);
  assert.equal(zoomEvent(page, 'touchend', outside, []), false);
});

test('map gestures remain available, while map cards and touches spanning the form are locked', () => {
  const page = browser({ coarse: true });
  for (const type of ['touchstart', 'touchmove']) {
    assert.equal(zoomEvent(page, type, mapSurface, [mapSurface, mapSurface]), false);
    assert.equal(zoomEvent(page, type, mapSurface, [mapSurface, outside]), true);
    assert.equal(zoomEvent(page, type, mapCard, [mapCard, mapCard]), true);
  }
  for (const type of ['gesturestart', 'gesturechange', 'dblclick']) {
    assert.equal(zoomEvent(page, type, mapSurface), false);
    assert.equal(zoomEvent(page, type, mapCard), true);
  }
});

test('desktop browser zoom is unchanged and phone restrictions do not depend on update metadata', () => {
  const desktop = browser();
  assert.equal(desktop.viewport.content, 'width=device-width, initial-scale=1');
  for (const type of ['gesturestart', 'gesturechange', 'dblclick']) assert.equal(zoomEvent(desktop, type, outside), false);
  assert.equal(zoomEvent(desktop, 'touchmove', outside, [outside, outside]), false);
  const phone = browser({ coarse: true, version: '__APP_VERSION__' });
  assert.equal(zoomEvent(phone, 'gesturestart', outside), true);
  assert.equal(phone.calls.length, 0);
});

test('metro pinch and double tap stay inside its map without enabling page zoom', () => {
  const page = browser({ coarse: true });
  assert.equal(zoomEvent(page, 'touchmove', metroSurface, [metroSurface, metroSurface]), false);
  assert.equal(zoomEvent(page, 'gesturestart', metroSurface), false);
  assert.equal(zoomEvent(page, 'dblclick', metroSurface), false);
  assert.equal(zoomEvent(page, 'touchmove', metroSurface, [metroSurface, outside]), true);
});

test('startup checks the server without caching or refreshing the current page', async () => {
  const page = browser(); await settle();
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url, '/app-version.json');
  assert.equal(page.calls[0].options.cache, 'no-store');
  assert.equal(page.elements['app-update'].hidden, true);
  assert.equal(page.state.reloads, 0);
  assert.equal(page.timers.size, 0);
});

test('a published version prompts without changing input, and only a click refreshes', async () => {
  const page = browser(); await settle();
  page.state.version = latest;
  assert.equal(page.intervals[0].delay, 60000);
  await page.intervals[0].fn();
  assert.equal(page.elements['app-update'].hidden, false);
  assert.equal(page.elements.destination.value, '颐和园');
  assert.equal(page.state.reloads, 0);
  await page.elements['app-update-button'].onclick();
  assert.equal(page.state.reloads, 1);
});

test('background and offline checks wait; foreground and reconnection check immediately', async () => {
  const page = browser(); await settle();
  page.document.hidden = true;
  await page.intervals[0].fn();
  assert.equal(page.calls.length, 1);
  page.document.hidden = false;
  page.document.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(page.calls.length, 2);
  page.navigator.onLine = false;
  await page.intervals[0].fn();
  assert.equal(page.calls.length, 2);
  page.navigator.onLine = true;
  page.window.dispatchEvent(new Event('online')); await settle();
  assert.equal(page.calls.length, 3);
  page.window.dispatchEvent(new Event('focus')); await settle();
  assert.equal(page.calls.length, 4);
  page.window.dispatchEvent(new Event('pageshow')); await settle();
  assert.equal(page.calls.length, 5);
});

test('checks fail quietly and an unavailable update keeps input on the current page', async () => {
  const page = browser(); await settle();
  page.state.fail = true;
  await page.intervals[0].fn();
  assert.equal(page.elements['app-update'].hidden, true);
  page.state.fail = false; page.state.version = latest;
  await page.intervals[0].fn();
  page.state.fail = true;
  await page.elements['app-update-button'].onclick();
  assert.equal(page.state.reloads, 0);
  assert.equal(page.elements.destination.value, '颐和园');
  assert.equal(page.elements['app-update-button'].disabled, false);
  assert.match(page.elements['app-update-message'].textContent, /稍后重试/);
  page.state.fail = false;
  await page.elements['app-update-button'].onclick();
  assert.equal(page.state.reloads, 1);
});

test('offline updates are disabled, translations follow the existing language setting', async () => {
  const page = browser(); await settle(); page.state.version = latest;
  await page.intervals[0].fn();
  page.navigator.onLine = false; page.window.dispatchEvent(new Event('offline'));
  const count = page.calls.length;
  await page.elements['app-update-button'].onclick();
  assert.equal(page.calls.length, count);
  assert.equal(page.state.reloads, 0);
  assert.equal(page.elements['app-update-button'].disabled, true);
  assert.match(page.elements['app-update-message'].textContent, /联网/);
  page.state.language = 'en'; page.translate();
  assert.match(page.elements['app-update-button'].textContent, /^en:/);
});

test('invalid responses do not advertise a version; a rollback removes the notice', async () => {
  const page = browser(); await settle();
  for (const version of [null, {}, 'bad', 1234567890123456]) {
    page.state.version = version; await page.intervals[0].fn();
    assert.equal(page.elements['app-update'].hidden, true);
  }
  page.state.version = latest; await page.intervals[0].fn();
  assert.equal(page.elements['app-update'].hidden, false);
  page.state.version = current; await page.intervals[0].fn();
  assert.equal(page.elements['app-update'].hidden, true);
});

test('build metadata agrees with the page and only shipped UI changes alter the version', () => {
  const assets = createAssets(true);
  const version = JSON.parse(assets['/app-version.json'].content).version;
  assert.match(version, /^[a-f0-9]{16}$/);
  assert.match(assets['/index.html'].content, new RegExp('name="app-version" content="' + version + '"'));
  assert.equal(JSON.parse(createAssets(true)['/app-version.json'].content).version, version);
  assert.equal((assets['/index.html'].content.match(/src="\/site-config\.js"/g) || []).length, 1);
  const manifest = JSON.parse(assets['/manifest.webmanifest'].content);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  for (const icon of manifest.icons) {
    const png = Buffer.from(assets[icon.src].content, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), Number(icon.sizes.split('x')[0]));
  }
  const tempBase = path.resolve(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(tempBase, 'manmanhang-pwa-'));
  try {
    for (const name of [...Object.keys(files), 'public-assets.cjs']) fs.copyFileSync(path.join(__dirname, '..', name), path.join(temp, name));
    const fixture = require(path.join(temp, 'public-assets.cjs'));
    assert.equal(JSON.parse(fixture.createAssets(true)['/app-version.json'].content).version, version);
    fs.appendFileSync(path.join(temp, 'styles.css'), '\n/* published style edit */\n');
    assert.notEqual(JSON.parse(fixture.createAssets(true)['/app-version.json'].content).version, version);
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), tempBase);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('iPhone 16 Pro startup images are published as dimension-matched PNGs', () => {
  const assets=createAssets(true);
  const html=assets['/index.html'].content;
  assert.match(html,/apple-mobile-web-app-status-bar-style" content="black-translucent/);
  assert.equal(JSON.parse(assets['/manifest.webmanifest'].content).background_color,'#a1e6fd');
  for (const [width,height] of [[1206,2622],[2622,1206]]) {
    const image=assets['/startup-'+width+'x'+height+'.png'];
    assert.equal(image.type,'image/png');
    assert.equal(image.binary,true);
    const png=Buffer.from(image.content,'base64');
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),width);
    assert.equal(png.readUInt32BE(20),height);
    assert.ok(html.includes('href="/startup-'+width+'x'+height+'.png"'));
  }
});
