const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM adapter exercises the app's actual handlers without calling AMap.
function fixture(savedLanguage = null, options = {}) {
  const elements = new Map();
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this.attributes = {}; this.handlers = {}; this.textContent = ''; }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    get classList() { return { toggle: () => {}, add: () => {}, remove: () => {} }; }
    getBoundingClientRect() { const top = this.parent ? this.parent.children.indexOf(this) * 120 : 0; return { top, height: 100, bottom: top + 100, left: 0, right: 600 }; }
    setPointerCapture() {}
    releasePointerCapture() {}
    contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
    append(...items) { for (const item of items) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = this; this.children.push(item); } }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); elements.delete(this.id); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(event, fn) { this.handlers[event] = fn; }
    closest() { return this.parent; }
    querySelector(selector) { return this.children.find((c) => selector.startsWith('.') ? (c.className || '').split(' ').includes(selector.slice(1)) : c.tag === selector) || this.children.map((c) => c.querySelector(selector)).find(Boolean); }
    focus() { this.handlers.focus?.(); }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"/g)) { const e = new Element(match[1]); e.id = match[2]; }
  for (const id of ['start', 'end']) {
    const field = new Element(); field.className = 'location-field'; const label = new Element('label'); label.lastChild = { textContent: '' };
    field.append(label, elements.get(id), elements.get(id + '-options'));
  }
  elements.get('end-mode').value = 'fixed'; elements.get('objective').value = 'time'; elements.get('policy').value = '0';
  const mode = new Element('input'); mode.value = 'driving';
  const doc = {
    documentElement: { dataset: { theme: 'light' } }, getElementById: (id) => elements.get(id), createElement: (tag) => new Element(tag), addEventListener: () => {},
    querySelector: (selector) => selector.includes('mode') ? mode : selector.includes('label') ? elements.get('end').parent.children[0] : new Element(),
    querySelectorAll: () => [mode]
  };
  doc.head = { append: (script) => script.onload() };
  const pending = [];
  let clears = 0;
  let reloads = 0;
  const storage = new Map();
  if (options.savedConfig !== undefined) storage.set('xingtu-config', typeof options.savedConfig === 'string' ? options.savedConfig : JSON.stringify(options.savedConfig));
  const context = vm.createContext({ document: doc, window: { NAV_CONFIG: options.navConfig || {}, RouteOptimizer: require('../route-optimizer.js'), addEventListener() {} }, sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, localStorage: { getItem: () => savedLanguage }, location: { reload() { reloads++; } }, URLSearchParams, navigator: { clipboard: { writeText: async () => {} } }, setTimeout, clearTimeout, requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, AMap: { Map: class { on() {} addControl() {} }, InfoWindow: class {}, Pixel: class {}, ToolBar: class {}, Scale: class {}, Driving: class { clear() { clears++; } search(...args) { pending.push(args.at(-1)); } } } });
  context.window.AMap = context.AMap;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../i18n.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  return { elements, pending, context, storage, reloads: () => reloads, run: (code) => vm.runInContext(code, context), clears: () => clears };
}
const event = { preventDefault() {} };
test('language preference restores and switching preserves addresses, order, theme and map', () => {
  const f = fixture('en');
  assert.equal(f.elements.get('language-toggle').textContent, '中文');
  assert.match(f.elements.get('status').textContent, /Connect the map/);
  const saved = [];
  f.context.localStorage.setItem = (key, value) => saved.push([key, value]);
  f.elements.get('batch-addresses').value = '北京南站\n天坛公园\n颐和园\n北京站';
  f.elements.get('batch-form').onsubmit(event);
  f.run("selected['stop-1'] = { name: '天坛公园', location: '116,39' }; map = { setMapStyle() { throw new Error('Language must not reload the map'); } }");
  const version = f.run('routeVersion');
  f.elements.get('language-toggle').onclick();
  assert.equal(f.context.document.documentElement.lang, 'zh-CN');
  assert.equal(f.elements.get('start').value, '北京南站');
  assert.equal(f.run("selected['stop-1'].location"), '116,39');
  assert.deepEqual(Array.from(f.run('stops')), ['stop-1', 'stop-2']);
  assert.equal(f.run('routeVersion'), version);
  assert.equal(f.context.document.documentElement.dataset.theme, 'light');
  assert.deepEqual(saved, [['xingtu-language', 'zh']]);
  f.elements.get('batch-addresses').value = '仅一个地址'; f.elements.get('batch-form').onsubmit(event);
  f.elements.get('language-toggle').onclick();
  assert.match(f.elements.get('batch-error').textContent, /Enter 2–8 addresses/);
  assert.match(f.elements.get('stop-1-field').querySelector('.stop-drag').attributes['aria-label'], /Drag stop 1/);
});

test('switching during a query preserves it and completed itinerary can switch both ways', async () => {
  const f = fixture();
  f.elements.get('batch-addresses').value = '起点\n中途\n终点'; f.elements.get('batch-form').onsubmit(event);
  f.run("loadedConfig = true; map = {}; addressIds().forEach((id, i) => selected[id] = {name: '地点' + i, address: '详细地址' + i, location: String(i)})");
  const task = f.elements.get('route-form').onsubmit(event);
  const version = f.run('routeVersion');
  f.elements.get('language-toggle').onclick();
  assert.equal(f.run('routeVersion'), version);
  assert.match(f.elements.get('progress-label').textContent, /Comparing road routes 1\/2/);
  for (let i = 0; i < 3; i++) {
    assert.equal(f.pending.length, 1);
    f.pending.shift()('complete', { routes: [{ time: 3720, distance: 12345 }] });
    if (i < 2) await new Promise(resolve => setTimeout(resolve, 270));
  }
  await task;
  assert.equal(f.elements.get('summary').hidden, false);
  assert.equal(f.elements.get('duration').textContent, '1 hr 2 min');
  assert.equal(f.elements.get('distance').textContent, '12.3 km');
  assert.match(f.run('copiedItinerary'), /Xingtu · Recommended itinerary/);
  assert.match(f.run('copiedItinerary'), /地点0 \(详细地址0\)/);
  assert.match(f.elements.get('order-list').children[0].textContent, /Start · 地点0/);
  f.elements.get('language-toggle').onclick();
  assert.equal(f.elements.get('summary').hidden, false);
  assert.equal(f.elements.get('duration').textContent, '1小时2分钟');
  assert.match(f.run('copiedItinerary'), /行途 · 推荐行程/);
  assert.equal(f.pending.length, 0);
  assert.equal(f.clears(), 0);
});
test('theme paints immediately and rapid toggles request only the final map style', async () => {
  const f = fixture(); const updates = [];
  f.context.recordStyle = (style) => updates.push(style);
  f.run("map = { setMapStyle: recordStyle }; appliedMapStyle = 'amap://styles/normal'");
  const toggle = f.elements.get('theme-toggle').onclick;
  toggle(); toggle(); toggle();
  assert.equal(f.context.document.documentElement.dataset.theme, 'dark');
  assert.equal(f.elements.get('theme-toggle').attributes['aria-pressed'], 'true');
  assert.deepEqual(updates, []);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(updates, ['amap://styles/dark']);
  toggle(); toggle();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(updates, ['amap://styles/dark']);
  f.run('saveThemePreference()');
});
test('theme preferences keep the latest choice and flush before leaving the page', () => {
  const f = fixture(); const saved = [];
  f.context.localStorage.setItem = (key, value) => saved.push([key, value]);
  f.elements.get('theme-toggle').onclick(); f.elements.get('theme-toggle').onclick();
  assert.deepEqual(saved, []);
  f.run('saveThemePreference()');
  assert.deepEqual(saved, [['xingtu-theme', 'light']]);
});
function drag(f, source, target, before = true) {
  const handle = f.elements.get(source + '-field').querySelector('.stop-drag');
  const sourceRect = f.elements.get(source + '-field').getBoundingClientRect();
  const targetRect = f.elements.get(target + '-field').getBoundingClientRect();
  const pointer = { ...event, pointerId: 1, button: 0, clientX: 100, clientY: sourceRect.top + 20 };
  handle.handlers.pointerdown(pointer);
  const destination = { ...pointer, clientY: targetRect.top + (before ? 10 : 90) };
  handle.handlers.pointermove(destination); handle.handlers.pointerup(destination);
}

test('batch validation leaves existing addresses intact; import requires confirmation', () => {
  const f = fixture(); f.elements.get('start').value = '原起点';
  f.elements.get('batch-addresses').value = Array.from({ length: 9 }, (_, i) => '地址' + i).join('\n');
  f.elements.get('batch-form').onsubmit(event);
  assert.equal(f.elements.get('start').value, '原起点');
  assert.match(f.elements.get('batch-error').textContent, /2–8/);
  f.elements.get('batch-addresses').value = '起点\n\n甲\n乙\n终点'; f.elements.get('batch-form').onsubmit(event);
  assert.equal(f.elements.get('address-count').textContent, '0/4 已确认');
  assert.deepEqual(Array.from(f.run('addressIds().map(id => selected[id])')), [null, null, null, null]);
});

test('dropping a confirmed stop preserves its coordinate and renumbers the fields', () => {
  const f = fixture(); f.elements.get('batch-addresses').value = '起点\n甲\n乙\n终点'; f.elements.get('batch-form').onsubmit(event);
  f.run("selected['stop-2'] = { name: '乙', location: '120,30' }; updateAddressState()");
  drag(f, 'stop-2', 'stop-1');
  assert.deepEqual(Array.from(f.run('addressIds()')), ['start', 'stop-2', 'stop-1', 'end']);
  assert.equal(f.run("selected[addressIds()[1]].location"), '120,30');
  assert.equal(f.elements.get('stop-2-field').querySelector('label').textContent, '途经地址 1');
  assert.equal(f.elements.get('stop-2-field').querySelector('.stop-drag').disabled, false);
  assert.equal(f.run('selected.start'), null);
  assert.equal(f.run('selected.end'), null);
});

test('drag cancellation preserves the order; dropping below another stop inserts after it', () => {
  const f = fixture(); f.elements.get('batch-addresses').value = '起点\n甲\n乙\n丙\n终点'; f.elements.get('batch-form').onsubmit(event);
  const handle = f.elements.get('stop-1-field').querySelector('.stop-drag');
  handle.handlers.pointerdown({ ...event, button: 0, pointerId: 1, clientX: 100, clientY: 20 }); handle.handlers.pointercancel();
  assert.deepEqual(Array.from(f.run('stops')), ['stop-1', 'stop-2', 'stop-3']);
  drag(f, 'stop-1', 'stop-3', false);
  assert.deepEqual(Array.from(f.run('addressIds()')), ['start', 'stop-2', 'stop-3', 'stop-1', 'end']);
});

test('the drag handle supports keyboard reordering and ignores pointer moves without a drag', () => {
  const f = fixture(); f.elements.get('batch-addresses').value = '起点\n甲\n乙\n终点'; f.elements.get('batch-form').onsubmit(event);
  f.elements.get('stop-1-field').querySelector('.stop-drag').handlers.pointermove({ pointerId: 1, clientX: 100, clientY: 210 });
  assert.deepEqual(Array.from(f.run('stops')), ['stop-1', 'stop-2']);
  f.elements.get('stop-1-field').querySelector('.stop-drag').handlers.keydown({ ...event, key: 'ArrowDown' });
  assert.deepEqual(Array.from(f.run('stops')), ['stop-2', 'stop-1']);
});

test('cancelling an outstanding query discards its result and starts no further queries', async () => {
  const f = fixture(); f.elements.get('batch-addresses').value = '起点\n甲\n终点'; f.elements.get('batch-form').onsubmit(event);
  f.run("loadedConfig = true; map = {}; addressIds().forEach((id, i) => selected[id] = {name: id, location: String(i)})");
  const task = f.elements.get('route-form').onsubmit(event);
  assert.equal(f.pending.length, 1); assert.equal(f.elements.get('planning-progress').hidden, false);
  f.elements.get('cancel-plan').onclick();
  f.pending.shift()('complete', { routes: [{ time: 60, distance: 100 }] });
  await task;
  assert.equal(f.pending.length, 0); assert.equal(f.elements.get('summary').hidden, true);
  assert.equal(f.elements.get('plan').disabled, false); assert.equal(f.elements.get('planning-progress').hidden, true);
  assert.match(f.elements.get('status').textContent, /计算已取消/);
});

test('a completed plan can be copied and applied without losing confirmed locations', async () => {
  const f = fixture(); f.elements.get('batch-addresses').value = '起点\n甲\n终点'; f.elements.get('batch-form').onsubmit(event);
  f.run("loadedConfig = true; map = {}; addressIds().forEach((id, i) => selected[id] = {name: '地点' + i, address: '详细地址' + i, location: String(i)})");
  const task = f.elements.get('route-form').onsubmit(event);
  for (let i = 0; i < 3; i++) {
    assert.equal(f.pending.length, 1);
    f.pending.shift()('complete', { routes: [{ time: 120, distance: 1000 }] });
    if (i < 2) await new Promise((resolve) => setTimeout(resolve, 270));
  }
  await task;
  assert.equal(f.elements.get('visit-order').hidden, false);
  assert.equal(f.elements.get('order-list').children.length, 3);
  let copied = '';
  f.context.navigator.clipboard.writeText = async (value) => { copied = value; };
  await f.elements.get('copy-order').onclick();
  assert.match(copied, /地点0（详细地址0）/);
  f.elements.get('apply-order').onclick();
  assert.equal(f.elements.get('address-count').textContent, '3/3 已确认');
  assert.equal(f.run('selected.end.location'), '2');
  assert.equal(f.elements.get('summary').hidden, true);
});

function mapPlacesFixture() {
  const f = fixture();
  const details = [];
  const map = { handlers: {}, on(name, callback) { this.handlers[name] = callback; } };
  let popup;
  f.context.AMap.Pixel = class {};
  f.context.AMap.InfoWindow = class {
    constructor() { popup = this; }
    setContent(card) { this.card = card; }
    open() { this.opened = true; }
    close() { this.opened = false; }
  };
  f.context.AMap.PlaceSearch = class { getDetails(id, callback) { details.push({ id, callback }); } };
  f.context.testMap = map;
  f.run('map = testMap; bindMapPlaces()');
  const click = (id = 'poi-a') => map.handlers.hotspotclick({ id, name: '地图图标', lnglat: '116,39' });
  const resolve = (name = '天坛公园', location = '116,39', id = 'poi-a') => details.shift().callback('complete', { poiList: { pois: [{ id, name, address: '北京市东城区', location }] } });
  const button = (kind) => popup.card.querySelector('.' + kind);
  return { ...f, details, popup, click, resolve, button };
}

test('a map icon opens confirmation; only confirming appends a confirmed stop and clears the route', () => {
  const f = mapPlacesFixture();
  f.run("selected.start = { name: '起点', location: '115,39' }; selected.end = { name: '终点', location: '117,39' }; planner = new AMap.Driving()");
  const version = f.run('routeVersion');
  f.click();
  assert.equal(f.popup.opened, true);
  assert.equal(f.button('primary').disabled, true);
  f.resolve();
  assert.match(f.popup.card.querySelector('.map-place-message').textContent, /添加为途经点/);
  assert.equal(f.run('stops.length'), 0);
  assert.equal(f.run('routeVersion'), version);
  f.button('primary').onclick();
  assert.deepEqual(Array.from(f.run('addressIds()')), ['start', 'stop-1', 'end']);
  assert.equal(f.elements.get('stop-1').value, '天坛公园');
  assert.equal(f.run("selected['stop-1'].location"), '116,39');
  assert.equal(f.run('selected.start.location'), '115,39');
  assert.equal(f.run('selected.end.location'), '117,39');
  assert.equal(f.elements.get('address-count').textContent, '3/3 已确认');
  assert.equal(f.popup.opened, false);
  assert.equal(f.clears(), 1);
});

test('cancel, Escape and callbacks from older icons cannot add a stop or replace the latest card', () => {
  const f = mapPlacesFixture();
  f.click('old'); const old = f.details.shift();
  f.click('latest');
  old.callback('complete', { poiList: { pois: [{ name: '旧地点', location: '120,30' }] } });
  assert.equal(f.button('primary').disabled, true);
  f.resolve('新地点', '118,39', 'latest');
  assert.equal(f.popup.card.querySelector('strong').textContent, '新地点');
  const staleConfirm = f.button('primary').onclick;
  f.button('secondary').onclick(); staleConfirm();
  assert.equal(f.run('stops.length'), 0);
  f.click(); f.button('secondary').onclick(); f.resolve();
  assert.equal(f.popup.opened, false);
  assert.equal(f.run('mapPlaceCandidate'), null);
  f.click(); f.resolve(); f.popup.card.handlers.keydown({ key: 'Escape' });
  assert.equal(f.popup.opened, false);
  assert.equal(f.run('stops.length'), 0);
});

test('repeat confirmation, matching POI IDs and matching coordinates cannot duplicate a stop', () => {
  const f = mapPlacesFixture();
  f.click(); f.resolve(); const confirm = f.button('primary').onclick;
  confirm(); confirm(); assert.equal(f.run('stops.length'), 1);
  f.click(); f.resolve('同一地点', '116.1,39', 'poi-a');
  assert.equal(f.button('primary').disabled, true);
  assert.match(f.popup.card.querySelector('.map-place-message').textContent, /已在途经点/);
  f.button('primary').onclick(); assert.equal(f.run('stops.length'), 1);
  f.click('poi-b'); f.resolve('同坐标地点', '116,39', 'poi-b');
  assert.equal(f.button('primary').disabled, true);
  f.button('secondary').onclick();
});

test('confirmation rechecks the stop limit and a removed stop can be added again', () => {
  const f = mapPlacesFixture();
  f.run('for (let i = 0; i < 5; i++) addStop(false)');
  f.click(); f.resolve(); assert.equal(f.button('primary').disabled, false);
  f.run('addStop(false)'); f.button('primary').onclick();
  assert.equal(f.run('stops.length'), 6);
  assert.match(f.popup.card.querySelector('.map-place-message').textContent, /最多添加 6/);
  assert.equal(f.button('primary').disabled, true);
  f.elements.get('stop-1-field').querySelector('.remove-stop').onclick();
  f.click(); f.resolve(); f.button('primary').onclick();
  assert.equal(f.run('stops.length'), 6);
  assert.equal(f.run("selected['stop-7'].id"), 'poi-a');
});

test('failed, incomplete and timed out details keep addition disabled; retry can succeed', () => {
  const f = mapPlacesFixture();
  f.click(); f.details.shift().callback('error');
  assert.equal(f.button('primary').disabled, true);
  assert.match(f.popup.card.querySelector('.map-place-message').textContent, /读取失败/);
  f.button('primary').onclick(); assert.equal(f.run('stops.length'), 0);
  f.click(); f.details.shift().callback('complete', { poiList: { pois: [{ name: '没有坐标' }] } });
  assert.equal(f.button('primary').disabled, true);
  let timeout;
  f.context.setTimeout = (callback) => { timeout = callback; return 0; };
  f.click(); timeout(); f.resolve();
  assert.equal(f.button('primary').disabled, true);
  f.click(); f.resolve(); f.button('primary').onclick();
  assert.equal(f.run('stops.length'), 1);
});

test('place markup remains literal text and switching language updates the confirmation card', () => {
  const f = mapPlacesFixture();
  f.click(); f.resolve('<img src=x onerror=alert(1)>');
  assert.equal(f.popup.card.querySelector('strong').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(f.popup.card.querySelector('img'), undefined);
  f.elements.get('language-toggle').onclick();
  assert.equal(f.button('primary').textContent, '+ Confirm addition');
  assert.equal(f.button('secondary').textContent, 'Cancel');
  f.button('primary').onclick();
  assert.equal(f.elements.get('stop-1').value, '<img src=x onerror=alert(1)>');
});

test('adding a confirmed map stop during a route query discards the old result', async () => {
  const f = mapPlacesFixture();
  f.run("loadedConfig = true; selected.start = { name: '起点', location: '115,39' }; selected.end = { name: '终点', location: '117,39' }");
  const task = f.elements.get('route-form').onsubmit(event);
  f.click(); f.resolve(); f.button('primary').onclick();
  f.pending.shift()('complete', { routes: [{ time: 60, distance: 100 }] });
  await task;
  assert.equal(f.elements.get('summary').hidden, true);
  assert.equal(f.run('stops.length'), 1);
  assert.match(f.elements.get('status').textContent, /已改变，请重新规划/);
});

const hostedConfig = { key: 'site-key', managed: true, serviceHost: 'https://route.example.com/_AMapService', defaultCity: '北京' };

test('hosted maps keep settings available and do not prefill the default site proxy', async () => {
  const f = fixture(null, { navConfig: hostedConfig });
  await Promise.resolve();
  assert.equal(f.elements.get('settings').hidden, false);
  assert.equal(f.run('config.managed'), true);
  f.elements.get('settings').onclick();
  assert.equal(f.elements.get('config-dialog').open, true);
  assert.equal(f.elements.get('api-key').value, '');
  assert.equal(f.elements.get('security-code').value, '');
  assert.equal(f.elements.get('service-host').value, '');
});

test('personal key takes priority after reload without inheriting the hosted proxy', async () => {
  const f = fixture(null, { navConfig: hostedConfig });
  f.elements.get('settings').onclick();
  f.elements.get('api-key').value = ' personal-key ';
  f.elements.get('security-code').value = ' personal-security ';
  f.elements.get('config-form').onsubmit(event);
  const saved = JSON.parse(f.storage.get('xingtu-config'));
  assert.equal(saved.key, 'personal-key');
  assert.equal(saved.securityJsCode, 'personal-security');
  assert.equal(saved.serviceHost, '');
  assert.equal(saved.managed, false);
  assert.equal(f.reloads(), 1);
  const restored = fixture(null, { navConfig: hostedConfig, savedConfig: saved });
  await Promise.resolve();
  assert.equal(restored.run('config.key'), 'personal-key');
  assert.equal(restored.run('config.serviceHost'), '');
  assert.equal(restored.context.window._AMapSecurityConfig.securityJsCode, 'personal-security');
  restored.elements.get('settings').onclick();
  assert.equal(restored.elements.get('api-key').value, 'personal-key');
});

test('personal proxy is restored and invalid stored settings retain the hosted defaults', () => {
  const f = fixture(null, { navConfig: hostedConfig, savedConfig: { key: 'personal-key', serviceHost: 'https://personal.example.com/_AMapService' } });
  assert.equal(f.run('config.managed'), false);
  assert.equal(f.run('config.securityJsCode'), '');
  assert.equal(f.run('config.serviceHost'), 'https://personal.example.com/_AMapService');
  for (const savedConfig of ['broken JSON', 'null', { key: 'partial-key' }, { key: 42, securityJsCode: 'security' }]) {
    const invalid = fixture(null, { navConfig: hostedConfig, savedConfig });
    assert.equal(invalid.run('config.managed'), true);
    assert.equal(invalid.run('config.key'), 'site-key');
  }
});

test('invalid or blocked personal settings do not reload or replace the active configuration', () => {
  const f = fixture(null, { navConfig: hostedConfig });
  f.elements.get('settings').onclick();
  f.elements.get('config-form').onsubmit(event);
  assert.match(f.elements.get('config-error').textContent, /填写高德 JS API Key/);
  f.elements.get('api-key').value = 'personal-key';
  f.elements.get('config-form').onsubmit(event);
  assert.match(f.elements.get('config-error').textContent, /安全密钥或安全代理/);
  f.elements.get('security-code').value = 'personal-security';
  f.context.sessionStorage.setItem = () => { throw new Error('Storage disabled'); };
  f.elements.get('config-form').onsubmit(event);
  assert.match(f.elements.get('config-error').textContent, /禁止会话存储/);
  assert.equal(f.reloads(), 0);
  assert.equal(f.storage.size, 0);
  assert.equal(f.run('config.key'), 'site-key');
});
