const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM adapter exercises the app's actual handlers without calling AMap.
function fixture(savedLanguage = null, settings = {}) {
  const { navConfig = {}, savedConfig = null, initialPanel = 'custom', localValues = new Map() } = typeof settings === 'string' ? { initialPanel: settings } : settings;
  const elements = new Map();
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this.attributes = {}; this.handlers = {}; this.textContent = ''; this.style = {}; }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    get classList() { return { toggle: () => {}, add: () => {}, remove: () => {} }; }
    getBoundingClientRect() { const top = this.parent ? this.parent.children.indexOf(this) * 120 : 0; return { top, height: 100, bottom: top + 100, left: 0, right: 600 }; }
    setPointerCapture() {}
    releasePointerCapture() {}
    contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
    append(...items) { for (const item of items) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = this; this.children.push(item); } }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); const unregister = (element) => { elements.delete(element.id); element.children.forEach(unregister); }; unregister(this); this.parent = null; }
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
  for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)/g)) {
    const e = new Element(match[1]); e.id = match[3];
    e.hidden = /\bhidden(?:\s|$|=)/.test(match[2]); e.disabled = /\bdisabled(?:\s|$|=)/.test(match[2]);
  }
  for (const id of ['start', 'end']) {
    const field = new Element(); field.className = 'location-field'; const label = new Element('label'); label.lastChild = { textContent: '' };
    field.append(label, elements.get(id), elements.get(id + '-options'));
  }
  elements.get('end-mode').value = 'fixed'; elements.get('objective').value = 'time'; elements.get('tour-objective').value = 'time'; elements.get('current-policy').value = '0'; elements.get('policy').value = '0';
  const mode = new Element('input'); mode.value = 'driving';
  const currentRadio = new Element('input'); currentRadio.value = 'driving';
  const doc = {
    documentElement: { dataset: { theme: 'light' } }, getElementById: (id) => elements.get(id), createElement: (tag) => new Element(tag), handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; },
    querySelector: (selector) => {
      if (selector.includes('mode')) {
        const radio = selector.includes('current-mode') ? currentRadio : mode, value = selector.match(/\[value="([^"]+)"\]/)?.[1];
        if (value) return { set checked(checked) { if (checked) radio.value = value; } };
        return radio;
      }
      return selector.includes('label') ? elements.get(selector.includes('start') ? 'start' : 'end').parent.children[0] : new Element();
    },
    querySelectorAll: selector => selector.includes('current-mode') ? [currentRadio] : [mode]
  };
  const pending = [], placePending = [], searches = [], geolocationPending = [], locationUpdates = [];
  const scripts = [], storageWrites = [];
  const pageHandlers = {};
  const sessionValues = new Map();
  if (savedConfig !== null) sessionValues.set('xingtu-config', typeof savedConfig === 'string' ? savedConfig : JSON.stringify(savedConfig));
  let reloads = 0;
  doc.head = { append(script) { scripts.push(script); script.onload(); } };
  let clears = 0;
  const routeService = (type) => class {
    constructor(options) { this.options = options; }
    clear() { clears++; }
    search(...args) { searches.push({ type, options: this.options, args: args.slice(0, -1) }); pending.push(args.at(-1)); }
  };
  const context = vm.createContext({ document: doc, window: { NAV_CONFIG: { ...navConfig }, RouteOptimizer: require('../route-optimizer.js'), addEventListener(name, callback) { (pageHandlers[name] ||= []).push(callback); }, confirm: () => true }, sessionStorage: { getItem: (key) => sessionValues.get(key) ?? null, setItem(key, value) { sessionValues.set(key, value); storageWrites.push({ key, value }); } }, location: { reload() { reloads++; } }, localStorage: { getItem: key => localValues.get(key) ?? (key === 'xingtu-language' ? savedLanguage : null), setItem(key, value) { localValues.set(key, value); storageWrites.push({ key, value }); }, removeItem(key) { localValues.delete(key); } }, navigator: { clipboard: { writeText: async () => {} } }, URLSearchParams, setTimeout, clearTimeout, requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, AMap: { Driving: routeService('driving'), Transfer: routeService('transfer'), Walking: routeService('walking'), Riding: routeService('riding'), Geolocation: class { getCurrentPosition(callback) { geolocationPending.push(callback); } }, PlaceSearch: class { search(keyword, callback) { placePending.push({ keyword, callback }); } }, Map: class { constructor() { this.handlers = {}; } on(name, callback) { this.handlers[name] = callback; } addControl() {} setZoomAndCenter(...args) { locationUpdates.push(args); } setMapStyle() {} }, ToolBar: class {}, Scale: class {}, Pixel: class {}, InfoWindow: class { setContent(card) { this.card = card; } open() {} close() {} } } });
  context.window.AMap = context.AMap;
  context.recordLocation = (...args) => locationUpdates.push(args);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../i18n.js'), 'utf8'), context);
  context.window.LiveLocation = require('../live-location.js');
  context.window.LOCATION_TEST_ENV = { document: doc, isSecureContext: true, navigator: { geolocation: { watchPosition(success, failure) { geolocationPending.push((status, result) => { const coords = String(result?.position || '').split(',').map(Number); if (status === 'complete' && coords.length === 2 && coords.every(Number.isFinite)) success({ coords: { longitude: coords[0], latitude: coords[1], accuracy: result.accuracy ?? 12 }, timestamp: Date.now() }); else failure({ code: (result?.info || result?.message) === 'PERMISSION_DENIED' ? 1 : 2 }); }); return geolocationPending.length; }, clearWatch() {} } }, setTimeout, clearTimeout, setInterval(fn, delay) { const timer = setInterval(fn, delay); timer.unref(); return timer; }, clearInterval, addEventListener() {}, removeEventListener() {} };
  context.AMap.convertFrom = (coords, type, done) => done('complete', { locations: [coords] });
  context.AMap.Marker = class { setPosition() {} setMap() {} };
  context.AMap.Circle = class { setCenter() {} setRadius() {} setOptions() {} setMap() {} };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  if (!vm.runInContext('liveLocation', context)) vm.runInContext('initializeLiveLocation()', context);
  if (initialPanel === 'custom' && !localValues.has('xingtu-usage')) vm.runInContext("switchRoutePanel('custom', false); status(() => t('配置地图后，即可开始规划。'))", context);
  return { elements, pending, placePending, searches, geolocationPending, locationUpdates, scripts, storageWrites, sessionValues, localValues, pageHandlers, reloads: () => reloads, mode, modes: { custom: mode, current: currentRadio }, context, run: (code) => vm.runInContext(code, context), clears: () => clears };
}
const event = { preventDefault() {} };
test('usage survives leaving and reopening with confirmed coordinates, stop order and both panels', () => {
  const f = fixture();
  f.elements.get('batch-addresses').value = '起点\n甲\n乙\n终点'; f.elements.get('batch-form').onsubmit(event);
  f.run("addressIds().forEach((id, i) => { selected[id] = {name: $(id).value, address: '地址' + i, location: { getLng() { return 116 + i / 100; }, getLat() { return 39; } }}; }); moveStop('stop-2', 0)");
  f.elements.get('city').value = '上海'; f.elements.get('tour-places').value = '甲\n乙';
  f.elements.get('end-mode').value = 'free'; f.elements.get('objective').value = 'distance';
  f.elements.get('current-destination').value = '目的地';
  f.run("currentDestination = { name: '目的地', location: [121, 31] }; currentCityManual = true");
  f.elements.get('current-city').value = '上海';
  f.modes.current.value = 'transfer'; f.modes.custom.value = 'walking';
  f.run("switchRoutePanel('current', false)");
  f.pageHandlers.pagehide.forEach(callback => callback());
  assert.equal(f.localValues.has('xingtu-usage'), true);
  const reopened = fixture(null, { localValues: f.localValues, initialPanel: 'current' });
  assert.equal(reopened.run('activeRoutePanel'), 'current');
  assert.equal(reopened.elements.get('city').value, '上海');
  assert.deepEqual(Array.from(reopened.run('addressIds().map(id => $(id).value)')), ['起点', '乙', '甲', '终点']);
  assert.deepEqual(Array.from(reopened.run('selected[stops[0]].location')), [116.02, 39]);
  assert.equal(reopened.elements.get('address-count').textContent, '4/4 已确认');
  assert.equal(reopened.elements.get('tour-places').value, '甲\n乙');
  assert.equal(reopened.elements.get('end-mode').value, 'free');
  assert.equal(reopened.elements.get('objective').value, 'distance');
  assert.equal(reopened.modes.current.value, 'transfer');
  assert.equal(reopened.modes.custom.value, 'walking');
  assert.equal(reopened.run('currentDestination.name'), '目的地');
  assert.equal(reopened.run('livePosition'), null);
  assert.equal(reopened.elements.get('current-plan').disabled, true);
});
test('a completed route restores its summary, road geometry and itinerary without another query', async () => {
  const f = fixture(); f.elements.get('batch-addresses').value = '起点\n中间\n终点'; f.elements.get('batch-form').onsubmit(event);
  f.run("loadedConfig = true; map = {}; addressIds().forEach((id, i) => selected[id] = {name: $(id).value, location: [116 + i / 100, 39]})");
  const task = f.elements.get('route-form').onsubmit(event);
  for (let i = 0; i < 3; i++) {
    f.pending.shift()('complete', { routes: [{time: 120, distance: 1000, steps: [{ instruction: '沿道路前行', path: [[116, 39], [116.02, 39]] }]}] });
    if (i < 2) await new Promise(resolve => setTimeout(resolve, 270));
  }
  await task; f.pageHandlers.pagehide.forEach(callback => callback());
  const reopened = fixture(null, { localValues: f.localValues });
  assert.equal(reopened.elements.get('summary').hidden, false);
  assert.equal(reopened.elements.get('duration').textContent, '2分钟');
  assert.equal(reopened.elements.get('order-list').children.length, 3);
  assert.equal(reopened.elements.get('saved-route-note').hidden, false);
  assert.equal(reopened.run('lastRoute.paths[0].length'), 2);
  assert.equal(reopened.elements.get('route-panel').children[0].children[0].textContent, '沿道路前行');
  assert.equal(reopened.pending.length, 0);
  reopened.elements.get('language-toggle').onclick();
  assert.equal(reopened.elements.get('duration').textContent, '2 min');
  assert.match(reopened.run('copiedItinerary'), /Recommended itinerary/);
});
test('manual clear cancels pending saves and keeps configuration, language and theme', () => {
  const f = fixture(); f.elements.get('start').value = '未确认地址'; f.elements.get('start').handlers.input();
  f.localValues.set('xingtu-config', 'personal settings'); f.localValues.set('xingtu-theme', 'dark'); f.localValues.set('xingtu-language', 'en');
  f.run('saveUsage()'); const saved = f.localValues.get('xingtu-usage');
  f.context.window.confirm = () => false; f.elements.get('clear-memory').onclick();
  assert.equal(f.localValues.get('xingtu-usage'), saved);
  f.context.window.confirm = () => true; f.elements.get('clear-memory').onclick();
  f.pageHandlers.pagehide.forEach(callback => callback());
  assert.equal(f.localValues.has('xingtu-usage'), false);
  assert.equal(f.elements.get('start').value, '');
  assert.equal(f.run('selected.start'), null);
  assert.equal(f.localValues.get('xingtu-config'), 'personal settings');
  assert.equal(f.localValues.get('xingtu-theme'), 'dark');
  assert.equal(f.localValues.get('xingtu-language'), 'en');
  f.elements.get('start').value = '新地址'; f.elements.get('start').handlers.input(); f.run('saveUsage()');
  assert.equal(JSON.parse(f.localValues.get('xingtu-usage')).addresses[0].text, '新地址');
});
test('restores map view and labels a saved GPS start as a previous location', () => {
  const f = fixture();
  f.run("selected.start = { name: '我的位置', currentLocation: true, location: [121, 31] }; $('start').value = '我的位置'; map = { getCenter() { return {getLng() {return 121;}, getLat() {return 31;}}; }, getZoom() {return 16;} }; rememberUsage(); saveUsage()");
  const reopened = fixture(null, {localValues: f.localValues});
  assert.equal(reopened.run('savedMapView.zoom'), 16);
  assert.deepEqual(Array.from(reopened.run('savedMapView.center')), [121, 31]);
  assert.equal(reopened.elements.get('start').value, '上次定位位置');
  assert.equal(reopened.run('livePosition'), null);
});
test('corrupt storage is reported and retained until the user clears it', () => {
  for (const saved of ['{broken', JSON.stringify({version: 1, addresses: []}), JSON.stringify({version: 2})]) {
    const localValues = new Map([['xingtu-usage', saved]]);
    const f = fixture(null, {localValues, initialPanel: 'current'});
    assert.equal(f.elements.get('start').value, '');
    assert.match(f.elements.get('memory-status').textContent, /无法恢复/);
    assert.equal(localValues.get('xingtu-usage'), saved);
  }
});
test('unavailable storage leaves the form usable and reports that data could not be saved or cleared', () => {
  const f = fixture(); f.elements.get('start').value = '保留在页面上的地址';
  f.context.localStorage.setItem = () => { throw new Error('quota exceeded'); };
  f.run('rememberUsage(); saveUsage()');
  assert.match(f.elements.get('memory-status').textContent, /无法保存/);
  f.context.localStorage.removeItem = () => { throw new Error('storage denied'); };
  f.elements.get('clear-memory').onclick();
  assert.equal(f.elements.get('start').value, '保留在页面上的地址');
  assert.match(f.elements.get('memory-status').textContent, /无法清除/);
});
function searchFixture(panel) {
  const f = liveFixture(panel), queries = [], timers = new Map();
  f.elements.get((panel === 'current' ? 'current-destination' : 'start') + '-options').hidden = true;
  let nextTimer = 0;
  f.context.setTimeout = fn => { timers.set(++nextTimer, fn); return nextTimer; };
  f.context.clearTimeout = id => timers.delete(id);
  f.context.AMap.PlaceSearch = class { constructor(options) { this.options = options; } search(keyword, callback) { queries.push({ keyword, callback, city: this.options.city }); } };
  return { ...f, queries, timers, flush() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    complete(index = queries.length - 1, name = '天坛公园') { queries[index].callback('complete', { poiList: { pois: [{ name, location: '116.41,39.88' }] } }); },
    dismiss() { f.context.document.handlers.click({ target: { closest: () => null } }); } };
}
for (const panel of ['current', 'custom']) {
  const id = panel === 'current' ? 'current-destination' : 'start';
  test(panel + ' planning and focus share a search and cancel a pending debounce', async () => {
    const f = searchFixture(panel); f.emitPosition();
    f.elements.get(id).value = '天坛'; f.elements.get(id).handlers.input();
    await f.elements.get(panel === 'current' ? 'current-route-form' : 'route-form').onsubmit(event);
    f.flush();
    assert.equal(f.queries.length, 1);
    f.complete(); assert.equal(f.elements.get(id + '-options').hidden, false);
    f.elements.get(id).focus(); assert.equal(f.queries.length, 1);
    f.elements.get(id + '-options').children[0].onclick(); f.flush();
    assert.equal(f.queries.length, 1); assert.equal(f.elements.get(id + '-options').hidden, true);
  });
  test(panel + ' selecting a candidate before the debounce expires never reopens it', () => {
    const f = searchFixture(panel);
    f.elements.get(id).value = '天坛'; f.elements.get(id).handlers.input(); f.elements.get(id).focus();
    f.complete(); f.elements.get(id + '-options').children[0].onclick(); f.flush();
    assert.equal(f.queries.length, 1); assert.equal(f.elements.get(id + '-options').hidden, true);
  });
  test(panel + ' dismissing candidates rejects late callbacks and permits a fresh search', () => {
    const f = searchFixture(panel);
    f.elements.get(id).value = '天坛'; f.elements.get(id).focus(); f.dismiss(); f.complete();
    assert.equal(f.elements.get(id + '-options').hidden, true);
    f.elements.get(id).focus(); assert.equal(f.queries.length, 2); f.complete();
    const oldButton = f.elements.get(id + '-options').children[0]; f.dismiss(); oldButton.onclick();
    assert.equal(f.run(panel === 'current' ? 'currentDestination' : 'selected.start'), null);
  });
  test(panel + ' failed searches can retry the same keyword and ignore duplicate callbacks', () => {
    const f = searchFixture(panel);
    f.elements.get(id).value = '天坛'; f.elements.get(id).focus();
    f.queries[0].callback('error', {}); f.complete(0);
    assert.equal(f.elements.get(id + '-options').hidden, true);
    f.elements.get(id).focus(); assert.equal(f.queries.length, 2); f.complete();
    assert.equal(f.elements.get(id + '-options').hidden, false);
  });
  test(panel + ' an unanswered search permits manual retry after eight seconds', () => {
    const f = searchFixture(panel); let time = Date.now();
    f.context.Date = class extends Date { static now() { return time; } };
    f.elements.get(id).value = '天坛'; f.elements.get(id).focus();
    time += 7999; f.elements.get(id).focus(); assert.equal(f.queries.length, 1);
    time++; f.elements.get(id).focus(); assert.equal(f.queries.length, 2);
    f.complete(0); assert.equal(f.elements.get(id + '-options').hidden, true);
    f.complete(1); assert.equal(f.elements.get(id + '-options').hidden, false);
  });
}
test('custom panel switching cancels debounced searches and rejects old candidates', () => {
  const f = searchFixture('custom');
  f.elements.get('start').value = '天坛'; f.elements.get('start').focus(); f.complete();
  const oldButton = f.elements.get('start-options').children[0];
  f.elements.get('end').value = '北京站'; f.elements.get('end').handlers.input();
  f.run("switchRoutePanel('current', false); switchRoutePanel('custom', false)"); f.flush();
  assert.equal(f.queries.length, 1); oldButton.onclick(); assert.equal(f.run('selected.start'), null);
  f.elements.get('start').focus(); assert.equal(f.queries.length, 2);
});
test('removing a stop cancels its debounced search and rejects pending results', () => {
  const f = searchFixture('custom'); f.run('addStop()');
  const input = f.elements.get('stop-1'); input.value = '天坛'; input.handlers.input(); input.focus();
  input.parent.querySelector('.remove-stop').onclick(); f.flush(); f.complete();
  assert.equal(f.queries.length, 1); assert.equal(f.elements.has('stop-1-field'), false);
  assert.equal(f.run('selected["stop-1"]'), undefined);
});
test('changing the custom search city invalidates pending results for the same keyword', () => {
  const f = searchFixture('custom');
  f.elements.get('start').value = '火车站'; f.elements.get('city').value = '北京'; f.elements.get('start').focus();
  f.elements.get('city').value = '上海'; f.elements.get('city').handlers.input(); f.elements.get('start').focus();
  f.complete(0, '北京旧结果'); assert.equal(f.elements.get('start-options').hidden, true);
  f.complete(1, '上海结果'); assert.equal(f.elements.get('start-options').children[0].textContent, '上海结果');
  assert.deepEqual(f.queries.map(q => q.city), ['北京', '上海']);
});
test('unchanged GPS precision avoids repeated status text and opacity writes while remaining fresh', () => {
  const f = liveFixture('current'); f.emitPosition();
  const status = f.elements.get('live-position-status'); let text = status.textContent, writes = 0, opacityWrites = 0;
  Object.defineProperty(status, 'textContent', { get: () => text, set(value) { writes++; text = value; } });
  const circle = f.circles[0], setOptions = circle.setOptions.bind(circle);
  circle.setOptions = options => { opacityWrites++; setOptions(options); };
  for (let i = 0; i < 100; i++) f.emitPosition();
  assert.equal(writes, 0); assert.equal(opacityWrites, 0); assert.equal(f.elements.get('current-plan').disabled, false);
  f.emitPosition([116.5, 40], 250); assert.equal(writes, 1); assert.match(text, /当前精度较低/);
  Object.assign(f.state, { positionState: 'stale' }); f.options().onState(f.state);
  assert.equal(opacityWrites, 1); assert.equal(f.elements.get('current-plan').disabled, true);
  f.emitPosition(); assert.equal(opacityWrites, 2); assert.equal(f.elements.get('current-plan').disabled, false);
  f.elements.get('language-toggle').onclick(); assert.match(text, /Accuracy/);
});

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
  assert.match(f.run('copiedItinerary'), /manmanhang · Recommended itinerary/);
  assert.match(f.run('copiedItinerary'), /地点0 \(详细地址0\)/);
  assert.match(f.elements.get('order-list').children[0].textContent, /Start · 地点0/);
  f.elements.get('language-toggle').onclick();
  assert.equal(f.elements.get('summary').hidden, false);
  assert.equal(f.elements.get('duration').textContent, '1小时2分钟');
  assert.match(f.run('copiedItinerary'), /manmanhang · 推荐行程/);
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

async function settleRoads(f, task, cost = () => 60) {
  while (f.run('busy')) {
    assert.equal(f.pending.length, 1);
    const search = f.searches.at(-1);
    f.pending.shift()('complete', { routes: [{ time: cost(...search.args), distance: cost(...search.args) * 10 }] });
    await new Promise((resolve) => setTimeout(resolve, 270));
  }
  await task;
}

test('auto tour validates input and mode before replacing addresses', async () => {
  const f = fixture(); f.elements.get('start').value = '原起点';
  for (const value of ['一个地点', Array.from({ length: 9 }, (_, i) => '地点' + i).join('\n')]) {
    f.elements.get('tour-places').value = value;
    await f.elements.get('plan-tour').onclick();
    assert.equal(f.elements.get('start').value, '原起点');
    assert.match(f.elements.get('status').textContent, /2–8/);
  }
  f.run('loadedConfig = true'); f.mode.value = 'walking';
  f.elements.get('tour-places').value = '甲\n乙';
  await f.elements.get('plan-tour').onclick();
  assert.equal(f.placePending.length, 0);
  assert.match(f.elements.get('status').textContent, /驾车/);
});

test('unique exact places automatically choose both endpoints and produce a full route', async () => {
  const f = fixture(); f.run('loadedConfig = true; map = {}');
  f.elements.get('tour-places').value = '甲\n\n乙\n丙';
  const task = f.elements.get('plan-tour').onclick();
  for (let i = 0; i < 3; i++) {
    assert.equal(f.placePending.length, 1);
    const { keyword, callback } = f.placePending.shift();
    callback('complete', { poiList: { count: 12, pois: [{ name: keyword, address: '地址' + i, location: String(i) }, {name: keyword + '-东门', location: '门' + i}] } });
    await new Promise((resolve) => setTimeout(resolve, 270));
  }
  const matrix = [[0, 50, 1], [1, 0, 50], [50, 50, 0]];
  await settleRoads(f, task, (from, to) => matrix[Number(from)][Number(to)]);
  assert.equal(f.searches.length, 7);
  assert.deepEqual(f.searches.slice(0, 6).map(({ args }) => args.join('>')), ['0>1', '0>2', '1>0', '1>2', '2>0', '2>1']);
  const final = f.searches.at(-1);
  assert.equal(final.args[0], '1'); assert.equal(final.args[1], '2');
  assert.deepEqual(Array.from(final.args[2].waypoints), ['0']);
  assert.equal(f.elements.get('address-count').textContent, '3/3 已确认');
  assert.match(f.elements.get('order-list').children[0].textContent, /起点 · 乙/);
  assert.equal(f.elements.get('address-details').open, false);
  assert.equal(f.elements.get('plan-tour').disabled, false);
  f.elements.get('language-toggle').onclick();
  assert.match(f.elements.get('order-list').children[0].textContent, /Start · 乙/);
  assert.match(f.elements.get('start').parent.children[0].lastChild.textContent, /start chosen automatically/);
});

test('ambiguity needs a choice and resuming keeps already confirmed places', async () => {
  const f = fixture(); f.run('loadedConfig = true; map = {setZoomAndCenter() {}}');
  f.elements.get('tour-places').value = '公园\n车站';
  const task = f.elements.get('plan-tour').onclick();
  f.placePending.shift().callback('complete', { poiList: { count: 2, pois: [{ name: '公园', location: '0' }, { name: '公园', location: '2' }] } });
  await new Promise((resolve) => setTimeout(resolve, 270));
  f.placePending.shift().callback('complete', { poiList: { count: 1, pois: [{ name: '车站', location: '1' }] } });
  await task;
  assert.equal(f.pending.length, 0);
  assert.equal(f.run('selected.start'), null);
  assert.equal(f.run('selected.end.name'), '车站');
  assert.equal(f.elements.get('address-details').open, true);
  assert.match(f.elements.get('status').textContent, /多个匹配/);
  f.elements.get('start-options').children[0].onclick();
  const resume = f.elements.get('plan-tour').onclick();
  await settleRoads(f, resume, (from) => from === '1' ? 2 : 20);
  assert.equal(f.placePending.length, 0);
  assert.equal(f.searches.length, 3);
  assert.equal(f.searches.at(-1).args[0], '1');
  assert.equal(f.searches.at(-1).args[1], '0');
  assert.equal(f.searches.at(-1).args.length, 2);
});

test('inexact and missing results are not silently accepted', async () => {
  const f = fixture(); f.run('loadedConfig = true; map = {}');
  f.elements.get('tour-places').value = '公园\n不存在';
  const task = f.elements.get('plan-tour').onclick();
  f.placePending.shift().callback('complete', { poiList: { count: 1, pois: [{ name: '公园停车场', location: '0' }] } });
  await new Promise((resolve) => setTimeout(resolve, 270));
  f.placePending.shift().callback('no_data', {});
  await task;
  assert.equal(f.run('selected.start'), null); assert.equal(f.run('selected.end'), null);
  assert.equal(f.pending.length, 0);
  assert.equal(f.elements.get('start-options').children[0].textContent, '公园停车场');
});

test('cancel or edit during place search discards late results', async () => {
  for (const cancel of [true, false]) {
    const f = fixture(); f.run('loadedConfig = true; map = {}');
    f.elements.get('tour-places').value = '甲\n乙';
    const task = f.elements.get('plan-tour').onclick();
    const pending = f.placePending.shift();
    if (cancel) f.elements.get('cancel-plan').onclick();
    else { f.elements.get('tour-places').value = '新甲\n新乙'; f.elements.get('tour-places').handlers.input(); }
    pending.callback('complete', { poiList: { count: 1, pois: [{ name: pending.keyword, location: '0' }] } });
    await task;
    assert.equal(f.run('selected.start'), null);
    assert.equal(f.pending.length, 0); assert.equal(f.placePending.length, 0);
    assert.equal(f.elements.get('plan-tour').disabled, false);
    assert.match(f.elements.get('status').textContent, cancel ? /计算已取消/ : /已改变/);
  }
});

test('changing a preference during road comparison discards the old tour', async () => {
  const f = fixture();
  f.elements.get('batch-addresses').value = '甲\n乙'; f.elements.get('batch-form').onsubmit(event);
  f.elements.get('end-mode').value = 'auto';
  f.run("loadedConfig = true; map = {}; addressIds().forEach((id, i) => selected[id] = {name: id, location: String(i)})");
  const task = f.elements.get('route-form').onsubmit(event);
  f.elements.get('tour-objective').value = 'distance'; f.elements.get('tour-objective').onchange();
  f.pending.shift()('complete', { routes: [{ time: 60, distance: 100 }] });
  await task;
  assert.equal(f.pending.length, 0); assert.equal(f.elements.get('summary').hidden, true);
  assert.equal(f.elements.get('objective').value, 'distance');
  assert.match(f.elements.get('status').textContent, /已改变/);
});

test('distance preference selects the correct road policy and cost', async () => {
  const f = fixture();
  f.elements.get('batch-addresses').value = '甲\n乙'; f.elements.get('batch-form').onsubmit(event);
  f.elements.get('end-mode').value = 'auto'; f.elements.get('objective').value = 'distance';
  f.run("loadedConfig = true; map = {}; addressIds().forEach((id, i) => selected[id] = {name: id, location: String(i)})");
  const task = f.elements.get('route-form').onsubmit(event);
  f.pending.shift()('complete', { routes: [{ time: 1, distance: 100 }] });
  await new Promise((resolve) => setTimeout(resolve, 270));
  f.pending.shift()('complete', { routes: [{ time: 20, distance: 10 }] });
  await new Promise((resolve) => setTimeout(resolve, 270));
  assert.equal(f.searches.at(-1).args[0], '1');
  f.pending.shift()('complete', { routes: [{ time: 20, distance: 10 }] });
  await task;
  assert.ok(f.searches.every(({ options }) => options.policy === 2));
});

test('place search service error releases the buttons without starting road queries', async () => {
  const f = fixture(); f.run('loadedConfig = true; map = {}'); f.elements.get('tour-places').value = '甲\n乙';
  const task = f.elements.get('plan-tour').onclick();
  f.placePending.shift().callback('error', {});
  await task;
  assert.match(f.elements.get('status').textContent, /地点查询失败/);
  assert.equal(f.elements.get('plan-tour').disabled, false);
  assert.equal(f.run('tourInputSnapshot'), null);
  assert.equal(f.pending.length, 0);
});

function confirmedPair(travelMode = 'driving') {
  const f = fixture();
  f.mode.value = travelMode;
  f.elements.get('start').value = '北京站'; f.elements.get('end').value = '天津站';
  f.run("loadedConfig = true; map = {setZoomAndCenter: recordLocation}; selected.start = {name: '北京站', location: '116.427,39.902', cityname: '北京市'}; selected.end = {name: '天津站', location: '117.211,39.136', cityname: '天津市'}; updateAddressState()");
  return f;
}

for (const travelMode of ['driving', 'transfer', 'walking', 'riding']) {
  test('legacy two-point ' + travelMode + ' dispatches the selected service and shows its result', async () => {
    const f = confirmedPair(travelMode);
    const task = f.elements.get('route-form').onsubmit(event);
    assert.equal(f.searches.length, 1);
    assert.equal(f.searches[0].type, travelMode);
    assert.deepEqual(Array.from(f.searches[0].args), ['116.427,39.902', '117.211,39.136']);
    assert.equal(f.searches[0].options.panel, 'route-panel');
    const result = [{ time: 600, distance: 2500 }, { time: 900, distance: 3000 }];
    f.pending.shift()('complete', travelMode === 'transfer' ? { plans: result } : { routes: result });
    await task;
    assert.equal(f.elements.get('summary').hidden, false);
    assert.equal(f.elements.get('duration').textContent, '10分钟');
    assert.equal(f.elements.get('distance').textContent, '2.5 公里');
    assert.equal(f.elements.get('route-caption').textContent, '北京站 → 天津站');
    assert.equal(f.elements.get('visit-order').hidden, true);
    assert.equal(f.elements.get('plan').disabled, false);
    assert.equal(f.elements.get('planning-progress').hidden, true);
    assert.match(f.elements.get('status').textContent, /找到 2 个方案/);
  });
}

for (const policy of [0, 1, 2, 4]) {
  test('legacy two-point driving retains policy ' + policy, async () => {
    const f = confirmedPair(); f.elements.get('policy').value = String(policy);
    const task = f.elements.get('route-form').onsubmit(event);
    assert.equal(f.searches.length, 1);
    assert.equal(f.searches[0].options.policy, policy);
    f.pending.shift()('complete', { routes: [{ time: 60, distance: 1000 }] });
    await task;
    assert.equal(f.elements.get('summary').hidden, false);
  });
}

test('bus routing requires a city and passes separate origin and destination cities', async () => {
  const f = confirmedPair('transfer'); f.elements.get('city').value = '  ';
  await f.elements.get('route-form').onsubmit(event);
  assert.equal(f.pending.length, 0);
  assert.match(f.elements.get('status').textContent, /公交规划需要填写所在城市/);
  f.elements.get('city').value = ' 北京 ';
  const task = f.elements.get('route-form').onsubmit(event);
  assert.equal(f.searches[0].options.city, '北京');
  assert.equal(f.searches[0].options.cityd, '天津市');
  f.pending.shift()('complete', { plans: [{ time: 1200, distance: 5000 }] }); await task;
  f.run('delete selected.end.cityname');
  const fallback = f.elements.get('route-form').onsubmit(event);
  assert.equal(f.searches[1].options.cityd, '北京');
  f.pending.shift()('complete', { plans: [{ time: 1200, distance: 5000 }] }); await fallback;
});

test('swapping endpoints preserves confirmed coordinates and invalidates a previous route', async () => {
  const f = confirmedPair();
  const task = f.elements.get('route-form').onsubmit(event);
  f.pending.shift()('complete', { routes: [{ time: 60, distance: 100 }] }); await task;
  f.elements.get('swap').onclick();
  assert.equal(f.elements.get('start').value, '天津站');
  assert.equal(f.elements.get('end').value, '北京站');
  assert.equal(f.elements.get('address-count').textContent, '2/2 已确认');
  assert.equal(f.elements.get('summary').hidden, true);
  const swapped = f.elements.get('route-form').onsubmit(event);
  assert.deepEqual(Array.from(f.searches.at(-1).args), ['117.211,39.136', '116.427,39.902']);
  f.pending.shift()('complete', { routes: [{ time: 120, distance: 200 }] }); await swapped;
  assert.equal(f.elements.get('route-caption').textContent, '天津站 → 北京站');
});

test('successful geolocation confirms the start and moves the map to the returned coordinate', () => {
  const f = confirmedPair();
  f.elements.get('locate').onclick();
  assert.equal(f.elements.get('locate').disabled, true);
  f.geolocationPending.shift()('complete', { position: '116.400,39.900' });
  assert.equal(f.elements.get('locate').disabled, false);
  assert.equal(f.elements.get('start').value, '我的位置');
  assert.deepEqual(Array.from(f.run('selected.start.location')), [116.4, 39.9]);
  assert.equal(f.elements.get('address-count').textContent, '2/2 已确认');
  assert.deepEqual(f.locationUpdates.map(([zoom, position]) => [zoom, Array.from(position)]), [[16, [116.4, 39.9]], [15, [116.4, 39.9]]]);
  assert.match(f.elements.get('status').textContent, /已将你的位置设为起点/);
  f.elements.get('language-toggle').onclick();
  assert.equal(f.elements.get('start').value, 'My location');
});

test('denied or incomplete geolocation keeps the previous confirmed start and enables retry', () => {
  for (const result of [{ state: 'error', data: { message: 'PERMISSION_DENIED' } }, { state: 'complete', data: {} }]) {
    const f = confirmedPair(); f.elements.get('locate').onclick();
    f.geolocationPending.shift()(result.state, result.data);
    assert.equal(f.elements.get('locate').disabled, false);
    assert.equal(f.elements.get('start').value, '北京站');
    assert.equal(f.run('selected.start.location'), '116.427,39.902');
    assert.equal(f.locationUpdates.length, 0);
    assert.match(f.elements.get('status').textContent, /定位权限被拒绝|暂时无法获取位置/);
  }
});

test('late geolocation cannot replace endpoints that were swapped while it was pending', () => {
  const f = confirmedPair(); f.elements.get('locate').onclick();
  f.elements.get('swap').onclick();
  f.geolocationPending.shift()('complete', { position: '过期位置' });
  assert.equal(f.elements.get('locate').disabled, false);
  assert.equal(f.elements.get('start').value, '天津站');
  assert.equal(f.run('selected.start.location'), '117.211,39.136');
  assert.equal(f.locationUpdates.length, 0);
});

test('editing an address invalidates confirmation and rejects an older search even after restoring its text', async () => {
  const f = confirmedPair(); const start = f.elements.get('start');
  start.value = '甲'; start.handlers.input();
  await new Promise((resolve) => setTimeout(resolve, 430));
  assert.equal(f.placePending.length, 1);
  const old = f.placePending.shift();
  start.value = '乙'; start.handlers.input();
  start.value = '甲'; start.handlers.input();
  assert.equal(f.run('selected.start'), null);
  assert.equal(f.elements.get('address-count').textContent, '1/2 已确认');
  old.callback('complete', { poiList: { pois: [{ name: '甲旧结果', location: '过期坐标' }] } });
  assert.equal(f.elements.get('start-options').hidden, true);
  await new Promise((resolve) => setTimeout(resolve, 430));
  const current = f.placePending.shift();
  assert.equal(current.keyword, '甲');
  current.callback('complete', { poiList: { pois: [{ name: '甲新结果', location: '新坐标' }] } });
  assert.equal(f.elements.get('start-options').hidden, false);
  f.elements.get('start-options').children[0].onclick();
  assert.equal(start.value, '甲新结果');
  assert.equal(f.run('selected.start.location'), '新坐标');
  assert.equal(f.elements.get('address-count').textContent, '2/2 已确认');
});

test('adding and removing stops enforces eight locations and drops deleted search callbacks', () => {
  const f = confirmedPair();
  for (let i = 0; i < 7; i++) f.elements.get('add-stop').onclick();
  assert.equal(f.run('addressIds().length'), 8);
  assert.equal(f.elements.get('add-stop').disabled, true);
  assert.equal(f.elements.get('address-count').textContent, '2/8 已确认');
  const removedId = f.run('stops[0]');
  f.elements.get(removedId).value = '待删除地点'; f.elements.get(removedId).focus();
  const stale = f.placePending.shift();
  f.elements.get(removedId + '-field').querySelector('.remove-stop').onclick();
  stale.callback('complete', { poiList: { pois: [{ name: '待删除地点', location: '0' }] } });
  assert.equal(f.elements.has(removedId), false);
  assert.equal(f.run('addressIds().length'), 7);
  assert.equal(f.elements.get('add-stop').disabled, false);
  assert.equal(f.run('Object.hasOwn(selected, ' + JSON.stringify(removedId) + ')'), false);
  f.elements.get('add-stop').onclick();
  assert.equal(f.run('addressIds().length'), 8);
  assert.equal(f.elements.get('address-count').textContent, '2/8 已确认');
  assert.equal(f.elements.get('stop-2-field').querySelector('label').textContent, '途经地址 1');
});

for (const endMode of ['fixed', 'free', 'auto']) {
  test('endpoint mode ' + endMode + ' queries usable directions and keeps its endpoint constraints', async () => {
    const f = fixture(); f.elements.get('batch-addresses').value = '甲\n乙\n丙'; f.elements.get('batch-form').onsubmit(event);
    f.elements.get('end-mode').value = endMode;
    f.run("loadedConfig = true; map = {}; addressIds().forEach((id, i) => selected[id] = {name: ['甲', '乙', '丙'][i], location: String(i)})");
    const task = f.elements.get('route-form').onsubmit(event);
    const matrix = [[0, 20, 1], [5, 0, 20], [50, 1, 0]];
    await settleRoads(f, task, (from, to) => matrix[Number(from)][Number(to)]);
    const pairs = f.searches.slice(0, -1).map(({ args }) => args.join('>'));
    const expected = endMode === 'fixed' ? ['0>1', '1>2'] : endMode === 'free' ? ['0>1', '0>2', '1>2', '2>1'] : ['0>1', '0>2', '1>0', '1>2', '2>0', '2>1'];
    assert.deepEqual(pairs, expected);
    const final = f.searches.at(-1);
    assert.equal(final.args[0], '0');
    assert.equal(final.args[1], endMode === 'fixed' ? '2' : '1');
    assert.deepEqual(Array.from(final.args[2].waypoints), [endMode === 'fixed' ? '1' : '2']);
    assert.equal(f.elements.get('order-list').children.length, 3);
    assert.equal(f.elements.get('summary').hidden, false);
  });
}

test('clipboard rejection reports how to copy manually and preserves the completed tour', async () => {
  const f = confirmedPair(); f.elements.get('end-mode').value = 'auto';
  const task = f.elements.get('route-form').onsubmit(event); await settleRoads(f, task);
  f.context.navigator.clipboard.writeText = async () => { throw new Error('NotAllowedError'); };
  await f.elements.get('copy-order').onclick();
  assert.match(f.elements.get('status').textContent, /浏览器未允许复制/);
  assert.equal(f.elements.get('summary').hidden, false);
  assert.equal(f.elements.get('visit-order').hidden, false);
  let copied = '';
  f.context.navigator.clipboard.writeText = async (value) => { copied = value; };
  await f.elements.get('copy-order').onclick();
  assert.match(copied, /北京站/);
  assert.match(copied, /天津站/);
});

test('repeated route submissions start only one request and both planning buttons recover', async () => {
  const f = confirmedPair(); f.elements.get('tour-places').value = '甲\n乙';
  const task = f.elements.get('route-form').onsubmit(event);
  await f.elements.get('route-form').onsubmit(event);
  await f.elements.get('plan-tour').onclick();
  assert.equal(f.searches.length, 1);
  assert.equal(f.placePending.length, 0);
  assert.equal(f.elements.get('plan').disabled, true);
  assert.equal(f.elements.get('plan-tour').disabled, true);
  f.pending.shift()('complete', { routes: [{ time: 60, distance: 1000 }] }); await task;
  assert.equal(f.elements.get('plan').disabled, false);
  assert.equal(f.elements.get('plan-tour').disabled, false);
  assert.equal(f.elements.get('summary').hidden, false);
});

test('repeated auto-tour submissions start only one place lookup while identification is pending', async () => {
  const f = confirmedPair(); f.elements.get('tour-places').value = '甲\n乙';
  const task = f.elements.get('plan-tour').onclick();
  await f.elements.get('plan-tour').onclick();
  await f.elements.get('route-form').onsubmit(event);
  assert.equal(f.placePending.length, 1);
  assert.equal(f.searches.length, 0);
  f.elements.get('cancel-plan').onclick();
  f.placePending.shift().callback('complete', { poiList: { count: 1, pois: [{ name: '甲', location: '0' }] } });
  await task;
  assert.equal(f.placePending.length, 0);
  assert.equal(f.searches.length, 0);
  assert.equal(f.elements.get('plan').disabled, false);
  assert.equal(f.elements.get('plan-tour').disabled, false);
});

async function completeAutoTour(f, names = ['甲', '乙']) {
  f.elements.get('tour-places').value = names.join('\n');
  const task = f.elements.get('plan-tour').onclick();
  for (let i = 0; i < names.length; i++) {
    assert.equal(f.placePending.length, 1);
    const { keyword, callback } = f.placePending.shift();
    callback('complete', { poiList: { count: 1, pois: [{ name: keyword, location: String(i) }] } });
    if (i < names.length - 1) await new Promise((resolve) => setTimeout(resolve, 270));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await settleRoads(f, task);
}

test('resubmitting the auto input after manually editing and confirming a point reloads the original input', async () => {
  const f = confirmedPair(); await completeAutoTour(f);
  const end = f.elements.get('end'); end.value = '丙'; end.handlers.input();
  await new Promise((resolve) => setTimeout(resolve, 430));
  f.placePending.shift().callback('complete', { poiList: { pois: [{ name: '丙', location: '新地点' }] } });
  f.elements.get('end-options').children[0].onclick();
  assert.equal(f.elements.get('address-count').textContent, '2/2 已确认');
  assert.equal(end.value, '丙');
  const previousQueries = f.searches.length;
  const retry = f.elements.get('plan-tour').onclick();
  const lookupCount = f.placePending.length;
  if (lookupCount) {
    assert.equal(f.placePending[0].keyword, '甲');
    assert.equal(f.elements.get('start').value, '甲');
    assert.equal(end.value, '乙');
    assert.equal(f.elements.get('address-count').textContent, '0/2 已确认');
    f.elements.get('cancel-plan').onclick();
    f.placePending.shift().callback('complete', { poiList: { count: 1, pois: [{ name: '甲', location: '0' }] } });
  } else await settleRoads(f, retry);
  await retry;
  assert.equal(lookupCount, 1, 'The original textarea must be resolved again instead of routing the manually changed point');
  assert.equal(f.searches.length, previousQueries);
});

for (const action of ['add', 'remove']) {
  test('resubmitting the auto input after stop ' + action + ' restores the original number of locations', async () => {
    const f = confirmedPair(); const names = action === 'add' ? ['甲', '乙'] : ['甲', '乙', '丙'];
    await completeAutoTour(f, names);
    if (action === 'add') f.elements.get('add-stop').onclick();
    else f.elements.get(f.run('stops[0]') + '-field').querySelector('.remove-stop').onclick();
    const retry = f.elements.get('plan-tour').onclick();
    const lookupCount = f.placePending.length;
    if (lookupCount) {
      assert.equal(f.run('addressIds().length'), names.length);
      assert.equal(f.elements.get('address-count').textContent, '0/' + names.length + ' 已确认');
      f.elements.get('cancel-plan').onclick();
      f.placePending.shift().callback('complete', { poiList: { count: 1, pois: [{ name: '甲', location: '0' }] } });
    } else if (f.pending.length) await settleRoads(f, retry);
    await retry;
    assert.equal(lookupCount, 1, 'Changing the manual point list must cause the original auto input to be reimported');
  });
}

for (const travelMode of ['transfer', 'walking', 'riding']) {
  test('switching a completed two-point auto tour to ' + travelMode + ' enables the legacy two-point route', async () => {
    const f = confirmedPair(); await completeAutoTour(f);
    f.mode.value = travelMode; f.mode.handlers.change();
    assert.equal(f.elements.get('end-mode').value, 'fixed');
    assert.equal(f.elements.get('swap').hidden, false);
    assert.equal(f.elements.get('locate').hidden, false);
    const previousQueries = f.searches.length;
    const task = f.elements.get('route-form').onsubmit(event);
    assert.equal(f.searches.length, previousQueries + 1);
    assert.equal(f.searches.at(-1).type, travelMode);
    f.pending.shift()('complete', travelMode === 'transfer' ? { plans: [{ time: 60, distance: 100 }] } : { routes: [{ time: 60, distance: 100 }] });
    await task;
    assert.equal(f.elements.get('summary').hidden, false);
  });
}

test('switching a three-point auto tour to walking keeps its constraints and explains the unsupported mode', async () => {
  const f = confirmedPair(); f.elements.get('add-stop').onclick();
  f.run("selected['stop-1'] = {name: '中途地点', location: '118,39'}");
  f.elements.get('end-mode').value = 'auto'; f.mode.value = 'walking'; f.mode.handlers.change();
  assert.equal(f.elements.get('end-mode').value, 'auto');
  await f.elements.get('route-form').onsubmit(event);
  assert.equal(f.searches.length, 0);
  assert.match(f.elements.get('status').textContent, /多地址自动排序目前支持驾车/);
});

for (const endpointMode of ['fixed', 'auto']) {
  test('a ' + endpointMode + ' route with only duplicate coordinates fails before querying the map', async () => {
    const f = confirmedPair(); f.elements.get('end-mode').value = endpointMode;
    if (endpointMode === 'auto') f.elements.get('add-stop').onclick();
    f.run("addressIds().forEach((id) => selected[id] = {name: id, location: '116,39'})");
    const task = f.elements.get('route-form').onsubmit(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startedRequests = f.searches.length;
    if (f.pending.length) f.pending.shift()('no_data', {});
    await task;
    assert.equal(startedRequests, 0);
    assert.match(f.elements.get('status').textContent, /请至少选择两个不同位置的地点/);
    assert.equal(f.elements.get('summary').hidden, true);
    assert.equal(f.elements.get('plan').disabled, false);
  });
}
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

test('confirming a map stop in automatic endpoint mode opens manual fields and includes the new point in the textarea route', async () => {
  const f = mapPlacesFixture(); f.elements.get('tour-places').value = '甲\n乙';
  f.elements.get('start').value = '甲'; f.elements.get('end').value = '乙';
  f.elements.get('end-mode').value = 'auto'; f.elements.get('address-details').open = false;
  f.run("loadedConfig = true; selected.start = {name: '甲', location: '115,39'}; selected.end = {name: '乙', location: '117,39'}; tourInputSnapshot = $('tour-places').value; updateMultiOptions()");
  f.click(); f.resolve(); f.button('primary').onclick();
  assert.equal(f.elements.get('end-mode').value, 'auto');
  assert.equal(f.elements.get('address-details').open, true);
  assert.equal(f.elements.get('address-count').textContent, '3/3 已确认');
  assert.equal(f.elements.get('stop-1-field').querySelector('label').textContent, '地点 2');
  assert.equal(f.elements.get('tour-places').value, '甲\n天坛公园\n乙');
  assert.equal(f.run('tourInputSnapshot'), f.elements.get('tour-places').value);
  assert.equal(f.popup.opened, false);
  const task = f.elements.get('plan-tour').onclick(); await settleRoads(f, task);
  assert.equal(f.searches.length, 7);
  assert.equal(f.elements.get('order-list').children.length, 3);
  assert.match(f.elements.get('route-caption').textContent, /天坛公园/);
  assert.equal(f.elements.get('summary').hidden, false);
});

test('automatic endpoint mode rejects map points matching either endpoint by POI ID or coordinate', () => {
  const matches = [
    { id: 'start-poi', location: '120,40' }, { id: 'end-poi', location: '120,40' },
    { id: 'another-poi', location: '115,39' }, { id: 'another-poi', location: '117,39' }
  ];
  for (const match of matches) {
    const f = mapPlacesFixture(); f.elements.get('end-mode').value = 'auto';
    f.run("selected.start = {id: 'start-poi', name: '甲', location: '115,39'}; selected.end = {id: 'end-poi', name: '乙', location: '117,39'}; updateMultiOptions()");
    f.click(match.id); f.resolve('已有地点', match.location, match.id);
    assert.equal(f.button('primary').disabled, true);
    assert.match(f.popup.card.querySelector('.map-place-message').textContent, /已在地点列表中/);
    f.button('primary').onclick();
    assert.equal(f.run('stops.length'), 0);
    assert.equal(f.elements.get('address-count').textContent, '2/2 已确认');
    f.button('secondary').onclick();
  }
});

test('confirming a map point preserves newly edited automatic-input text', () => {
  const f = mapPlacesFixture(); f.elements.get('tour-places').value = '甲\n乙';
  f.elements.get('start').value = '甲'; f.elements.get('end').value = '乙'; f.elements.get('end-mode').value = 'auto';
  f.run("selected.start = {name: '甲', location: '115,39'}; selected.end = {name: '乙', location: '117,39'}; tourInputSnapshot = $('tour-places').value; updateMultiOptions()");
  f.click(); f.resolve();
  const newInput = '新甲\n新乙\n新丙';
  f.elements.get('tour-places').value = newInput; f.elements.get('tour-places').handlers.input();
  f.button('primary').onclick();
  assert.equal(f.elements.get('tour-places').value, newInput);
  assert.equal(f.run('tourInputSnapshot'), null);
  assert.equal(f.elements.get('address-details').open, true);
  assert.equal(f.elements.get('address-count').textContent, '3/3 已确认');
  assert.equal(f.run("selected['stop-1'].name"), '天坛公园');
  assert.equal(f.popup.opened, false);
});

const dummyManagedMap = {
  managed: true, key: 'dummy-shared-key', serviceHost: 'https://shared.example/_AMapService', defaultCity: '北京'
};
const mapReady = () => new Promise((resolve) => setTimeout(resolve, 0));

test('opening a configured page automatically starts one location watch after map load', async () => {
  const f = fixture(null, { navConfig: dummyManagedMap, initialPanel: 'current' });
  assert.equal(f.geolocationPending.length, 0);
  await mapReady();
  assert.equal(f.geolocationPending.length, 1);
  assert.match(f.elements.get('live-position-status').textContent, /正在获取位置/);
  assert.equal(f.elements.get('live-direction').attributes['aria-pressed'], 'false');
  f.elements.get('current-locate').onclick();
  assert.equal(f.geolocationPending.length, 1);
  f.geolocationPending[0]('complete', { position: '116.4,39.9' });
  assert.equal(f.elements.get('current-plan').disabled, false);
  assert.equal(f.elements.get('start').value, '');
  assert.deepEqual(f.locationUpdates.map(([zoom, position]) => [zoom, Array.from(position)]), [[16, [116.4, 39.9]]]);
  f.elements.get('live-toggle').onclick();
  assert.equal(f.run('liveState.enabled'), false);
});

test('automatic location denial leaves saved fields usable and supports a manual retry', async () => {
  const f = fixture(null, { navConfig: dummyManagedMap, initialPanel: 'current' });
  await mapReady();
  f.elements.get('current-destination').value = '保留目的地';
  f.geolocationPending[0]('error', { info: 'PERMISSION_DENIED' });
  assert.match(f.elements.get('live-position-status').textContent, /定位权限被拒绝/);
  assert.equal(f.elements.get('current-destination').value, '保留目的地');
  assert.equal(f.elements.get('current-plan').disabled, true);
  assert.equal(f.geolocationPending.length, 1);
  f.elements.get('current-locate').onclick();
  assert.equal(f.geolocationPending.length, 2);
  f.geolocationPending[1]('complete', { position: '116.4,39.9' });
  assert.equal(f.elements.get('current-plan').disabled, false);
});

test('automatic location preserves a restored viewport, custom start and current destination', async () => {
  const previous = fixture();
  previous.elements.get('start').value = '原出发地点';
  previous.elements.get('current-destination').value = '原目的地';
  previous.run("selected.start = {name: '原出发地点', location: [121, 31]}; currentDestination = {name: '原目的地', location: [121.1, 31.1]}; map = {getCenter() {return [121, 31];}, getZoom() {return 14;}}; rememberUsage(); saveUsage()");
  const reopened = fixture(null, { navConfig: dummyManagedMap, localValues: previous.localValues });
  await mapReady();
  assert.equal(reopened.geolocationPending.length, 1);
  reopened.geolocationPending[0]('complete', { position: '116.4,39.9' });
  assert.equal(reopened.elements.get('start').value, '原出发地点');
  assert.equal(reopened.elements.get('current-destination').value, '原目的地');
  assert.deepEqual(Array.from(reopened.run('selected.start.location')), [121, 31]);
  assert.equal(reopened.locationUpdates.length, 0);
  assert.equal(reopened.pending.length, 0);
  assert.equal(reopened.run('livePosition.location[0]'), 116.4);
});

test('no map configuration or insecure context leaves automatic location inactive', async () => {
  const unconfigured = fixture();
  const insecure = fixture(null, { navConfig: dummyManagedMap });
  insecure.context.window.LOCATION_TEST_ENV.isSecureContext = false;
  await mapReady();
  assert.equal(unconfigured.geolocationPending.length, 0);
  assert.equal(insecure.geolocationPending.length, 0);
  assert.match(insecure.elements.get('live-position-status').textContent, /HTTPS/);
});

test('managed map keeps personal settings available without prefilling shared credentials', async () => {
  const f = fixture(null, { navConfig: dummyManagedMap }); await mapReady();
  assert.equal(f.elements.get('settings').hidden, false);
  assert.equal(f.run('loadedConfig'), true);
  f.elements.get('settings').onclick();
  assert.equal(f.elements.get('config-dialog').open, true);
  assert.equal(f.elements.get('api-key').value, '');
  assert.equal(f.elements.get('security-code').value, '');
  assert.equal(f.elements.get('service-host').value, '');
  assert.equal(f.storageWrites.length, 0);
  assert.equal(f.reloads(), 0);
});

test('personal security-code settings save, reload and restore without inheriting the shared proxy', async () => {
  const f = fixture(null, { navConfig: dummyManagedMap }); await mapReady();
  f.elements.get('settings').onclick();
  f.elements.get('api-key').value = ' dummy-personal-key ';
  f.elements.get('security-code').value = ' dummy-personal-code ';
  f.elements.get('config-form').onsubmit(event);
  assert.equal(f.storageWrites.length, 1);
  assert.equal(f.storageWrites[0].key, 'xingtu-config');
  const saved = JSON.parse(f.storageWrites[0].value);
  assert.equal(saved.key, 'dummy-personal-key');
  assert.equal(saved.securityJsCode, 'dummy-personal-code');
  assert.equal(saved.serviceHost, '');
  assert.equal(saved.managed, false);
  assert.equal(f.reloads(), 1);
  const restored = fixture(null, { navConfig: dummyManagedMap, savedConfig: f.sessionValues.get('xingtu-config') }); await mapReady();
  restored.elements.get('settings').onclick();
  assert.equal(restored.elements.get('api-key').value, 'dummy-personal-key');
  assert.equal(restored.elements.get('security-code').value, 'dummy-personal-code');
  assert.equal(restored.elements.get('service-host').value, '');
  assert.equal(restored.run('config.managed'), false);
  assert.equal(restored.context.window._AMapSecurityConfig.securityJsCode, 'dummy-personal-code');
  assert.equal(restored.context.window._AMapSecurityConfig.serviceHost, undefined);
  assert.equal(new URL(restored.scripts[0].src).searchParams.get('key'), 'dummy-personal-key');
  assert.equal(restored.run('loadedConfig'), true);
});

test('personal proxy restores while malformed or incomplete session settings fall back to the managed map', async () => {
  const shared = { ...dummyManagedMap, securityJsCode: 'dummy-shared-code' };
  const personal = fixture(null, { navConfig: shared, savedConfig: { key: ' dummy-proxy-key ', serviceHost: ' https://personal.example/_AMapService ' } }); await mapReady();
  personal.elements.get('settings').onclick();
  assert.equal(personal.elements.get('api-key').value, 'dummy-proxy-key');
  assert.equal(personal.elements.get('security-code').value, '');
  assert.equal(personal.elements.get('service-host').value, 'https://personal.example/_AMapService');
  assert.equal(personal.run('config.managed'), false);
  assert.equal(personal.context.window._AMapSecurityConfig.serviceHost, 'https://personal.example/_AMapService');
  assert.equal(personal.context.window._AMapSecurityConfig.securityJsCode, undefined);
  for (const savedConfig of ['{broken', 'null', {}, { key: 'incomplete-key' }, { key: ' ', securityJsCode: 'code' }, { securityJsCode: 'code' }, { key: 42, serviceHost: 'https://invalid.example' }, { key: 'key', securityJsCode: {}, serviceHost: null }]) {
    const fallback = fixture(null, { navConfig: shared, savedConfig }); await mapReady();
    assert.equal(new URL(fallback.scripts[0].src).searchParams.get('key'), 'dummy-shared-key');
    assert.equal(fallback.context.window._AMapSecurityConfig.serviceHost, 'https://shared.example/_AMapService');
    assert.equal(fallback.run('config.managed'), true);
    assert.equal(fallback.run('loadedConfig'), true);
    fallback.elements.get('settings').onclick();
    assert.equal(fallback.elements.get('api-key').value, '');
    assert.equal(fallback.elements.get('security-code').value, '');
    assert.equal(fallback.elements.get('service-host').value, '');
    assert.equal(fallback.storageWrites.length, 0);
    assert.equal(fallback.reloads(), 0);
  }
});

test('missing personal credentials or blocked session storage cannot save settings or reload', async () => {
  const f = fixture(null, { navConfig: dummyManagedMap }); await mapReady();
  f.elements.get('settings').onclick();
  f.elements.get('api-key').value = ' ';
  f.elements.get('security-code').value = 'dummy-code';
  f.elements.get('config-form').onsubmit(event);
  assert.match(f.elements.get('config-error').textContent, /请填写高德 JS API Key/);
  assert.equal(f.storageWrites.length, 0); assert.equal(f.reloads(), 0);
  f.elements.get('api-key').value = 'dummy-key';
  f.elements.get('security-code').value = ' ';
  f.elements.get('service-host').value = ' ';
  f.elements.get('config-form').onsubmit(event);
  assert.match(f.elements.get('config-error').textContent, /安全密钥或安全代理地址/);
  assert.equal(f.storageWrites.length, 0); assert.equal(f.reloads(), 0);
  f.elements.get('security-code').value = 'dummy-code';
  f.context.sessionStorage.setItem = () => { throw new Error('Storage access denied'); };
  f.elements.get('config-form').onsubmit(event);
  assert.match(f.elements.get('config-error').textContent, /浏览器禁止会话存储/);
  assert.equal(f.storageWrites.length, 0); assert.equal(f.reloads(), 0);
  assert.equal(f.elements.get('config-dialog').open, true);
});

function liveFixture(initialPanel = 'custom') {
  const f = fixture(null, initialPanel), markers = [], circles = [], centers = [];
  let options, starts = 0, stops = 0;
  const state = { enabled: false, watching: false, positionState: 'idle', positionError: '', directionState: 'off', directionEnabled: false, heading: null, position: null };
  f.context.window.LiveLocation = { create(next) { options = next; options.onState(state); return { start() { starts++; if (state.enabled) return; Object.assign(state, { enabled: true, watching: true, positionState: 'waiting' }); options.onState(state); }, stop() { stops++; options.onClear(); Object.assign(state, { enabled: false, watching: false, positionState: 'idle', position: null, heading: null, directionEnabled: false, directionState: 'off' }); options.onState(state); }, recenter() { options.onRecenter(state.position); }, enableDirection() {} }; } };
  f.context.AMap.PlaceSearch = class { search() {} };
  f.context.AMap.Marker = class { constructor(opts) { this.options = opts; markers.push(this); } setPosition(position) { this.options.position = position; } setMap(map) { this.options.map = map; } };
  f.context.AMap.Circle = class { constructor(opts) { this.options = opts; circles.push(this); } setCenter(center) { this.options.center = center; } setRadius(radius) { this.options.radius = radius; } setMap(map) { this.options.map = map; } setOptions(opts) { Object.assign(this.options, opts); } };
  f.context.previewCenters = centers;
  f.run('loadedConfig = true; map = { setZoomAndCenter(zoom, location) { previewCenters.push({ zoom, location }); }, setMapStyle() {} }; initializeLiveLocation()');
  return { ...f, markers, circles, centers, state, starts: () => starts, stops: () => stops, options: () => options,
    emitPosition(location = [116.4, 39.9], accuracy = 12) { const position = { location, accuracy, timestamp: Date.now() }; options.onPosition(position); Object.assign(state, { enabled: true, watching: true, positionState: 'active', position }); options.onState(state); } };
}
test('live map updates preserve route, addresses and viewport after the first location', () => {
  const f = liveFixture(); f.run("selected.start = {name:'旧起点',location:'old'}; planner = new AMap.Driving(); recommendedPoints = ['keep']; routeVersion = 7"); f.elements.get('summary').hidden = false;
  f.emitPosition(); f.emitPosition([116.5, 40], 250);
  assert.equal(f.markers.length, 1); assert.deepEqual(f.markers[0].options.position, [116.5, 40]); assert.equal(f.circles[0].options.radius, 250); assert.equal(f.centers.length, 1);
  assert.equal(f.run('selected.start.location'), 'old'); assert.equal(f.run('routeVersion'), 7); assert.equal(f.clears(), 0); assert.equal(f.elements.get('summary').hidden, false); assert.match(f.elements.get('live-position-status').textContent, /当前精度较低/);
  f.elements.get('live-recenter').onclick(); assert.equal(f.centers.length, 2);
});
test('use as start snapshots the current location without automatically moving the planned start', () => {
  const f = liveFixture(); f.emitPosition([116.4, 39.9]); f.elements.get('locate').onclick();
  assert.deepEqual(f.run('selected.start.location'), [116.4, 39.9]); assert.equal(f.elements.get('start').value, '我的位置'); const version = f.run('routeVersion');
  f.emitPosition([116.5, 40]); assert.deepEqual(f.run('selected.start.location'), [116.4, 39.9]); assert.equal(f.run('routeVersion'), version);
});
test('a delayed location cannot overwrite a manually changed start', () => {
  const f = liveFixture(); f.elements.get('locate').onclick(); assert.equal(f.starts(), 1); assert.equal(f.elements.get('locate').disabled, true);
  f.run("versions.start++; selected.start = {name:'手动选择', location:'manual'}"); f.emitPosition(); assert.equal(f.run('selected.start.location'), 'manual'); assert.equal(f.elements.get('locate').disabled, false);
});
test('a heading received before GPS appears on the first marker and stop removes both overlays', () => {
  const f = liveFixture(); Object.assign(f.state, { directionState: 'active', directionEnabled: true, heading: 90 }); f.emitPosition();
  const arrow = f.markers[0].options.content.querySelector('.live-arrow'); assert.equal(arrow.hidden, false); assert.equal(arrow.style.transform, 'rotate(90deg)');
  f.elements.get('live-toggle').onclick(); assert.equal(f.markers[0].options.map, null); assert.equal(f.circles[0].options.map, null); assert.equal(f.elements.get('live-recenter').disabled, true); assert.equal(f.elements.get('live-direction').disabled, true);
});
test('location errors release the pending start and stale positions disable recenter', () => {
  const f = liveFixture(); f.elements.get('locate').onclick(); Object.assign(f.state, { positionState: 'error', positionError: 'denied' }); f.options().onState(f.state);
  assert.equal(f.elements.get('locate').disabled, false); assert.match(f.elements.get('status').textContent, /定位权限被拒绝/);
  f.emitPosition(); Object.assign(f.state, { positionState: 'stale' }); f.options().onState(f.state); assert.equal(f.elements.get('live-recenter').disabled, true); assert.equal(f.circles[0].options.fillOpacity, 0.04);
});
test('language switching preserves live location and direction while translating new controls', () => {
  const f = liveFixture(); Object.assign(f.state, { directionState: 'active', directionEnabled: true, heading: 90 }); f.emitPosition();
  f.context.window.I18n.setLanguage('en'); assert.equal(f.elements.get('live-toggle').textContent, 'Stop location'); assert.match(f.elements.get('live-position-status').textContent, /Accuracy about 12/); assert.match(f.elements.get('live-direction-status').textContent, /Heading enabled/); assert.equal(f.markers.length, 1); assert.equal(f.stops(), 0);
});

function confirmCurrentDestination(f) {
  f.run("currentDestination = { name: '天坛公园', location: '116.41,39.88', cityname: '北京市' }; $('current-destination').value = currentDestination.name; syncCurrentForm()");
}
function completeRoute(f) { f.pending.shift()('complete', { routes: [{ time: 600, distance: 1500 }] }); }
function mockGeocoder(f) {
  const pending = [];
  f.context.AMap.Geocoder = class { getAddress(location, callback) { pending.push({ location, callback }); } };
  f.context.AMap.Transfer = f.context.AMap.Driving;
  return pending;
}
test('switching panels cancels pending tour identification immediately and ignores late places', async () => {
  const f = liveFixture('custom'); f.emitPosition(); confirmCurrentDestination(f);
  f.context.AMap.PlaceSearch = class { search(keyword, callback) { f.placePending.push({ keyword, callback }); } };
  f.elements.get('tour-places').value = '甲\n乙';
  const task = f.elements.get('plan-tour').onclick();
  const late = f.placePending.shift();
  assert.equal(f.elements.get('current-plan').disabled, true);
  f.run("switchRoutePanel('current', false)");
  await task;
  assert.equal(f.run('busy'), false);
  assert.equal(f.elements.get('current-plan').disabled, false);
  assert.match(f.elements.get('status').textContent, /已切换面板/);
  late.callback('complete', { poiList: { pois: [{ name: '甲', location: 'old' }] } });
  assert.equal(f.run('selected.start'), null);
  assert.equal(f.searches.length, 0);
  await f.elements.get('plan-tour').onclick();
  assert.equal(f.placePending.length, 0);
  const route = f.elements.get('current-route-form').onsubmit(event); completeRoute(f); await route;
  assert.equal(f.elements.get('summary').hidden, false);
});
test('adding a map place from the current panel opens the custom panel and preserves the destination', () => {
  const f = mapPlacesFixture(); confirmCurrentDestination(f);
  f.run("switchRoutePanel('current', false)");
  f.click(); f.resolve(); f.button('primary').onclick();
  assert.equal(f.run('activeRoutePanel'), 'custom');
  assert.equal(f.elements.get('custom-route-panel').hidden, false);
  assert.equal(f.elements.get('address-details').open, true);
  assert.equal(f.elements.get('stop-1').value, '天坛公园');
  assert.equal(f.run('currentDestination.name'), '天坛公园');
});
test('switching panels closes map place cards and invalidates pending details and old confirmation', () => {
  const f = mapPlacesFixture(); f.click(); const late = f.details.shift();
  f.run("switchRoutePanel('current', false)");
  late.callback('complete', { poiList: { pois: [{ name: '旧地点', location: '116,39' }] } });
  assert.equal(f.run('mapPlaceCandidate'), null);
  assert.equal(f.popup.opened, false);
  f.click(); f.resolve(); const oldButton = f.button('primary');
  f.run("switchRoutePanel('custom', false)"); oldButton.onclick();
  assert.equal(f.run('stops.length'), 0);
});
test('current location is the default panel and no location request starts on page load', () => {
  const f = liveFixture('current');
  assert.equal(f.run('activeRoutePanel'), 'current');
  assert.equal(f.elements.get('current-route-panel').hidden, false);
  assert.equal(f.elements.get('custom-route-panel').hidden, true);
  assert.equal(f.elements.get('current-tab').attributes['aria-selected'], 'true');
  assert.equal(f.elements.get('current-plan').disabled, true);
  assert.equal(f.starts(), 0);
  f.elements.get('current-locate').onclick();
  assert.equal(f.starts(), 1);
});
test('switching panels preserves independent destinations, modes, policies and custom stops', () => {
  const f = liveFixture();
  f.elements.get('batch-addresses').value = '自定义起点\n中途地点\n自定义终点';
  f.elements.get('batch-form').onsubmit(event);
  f.run("selected.start = {name:'自定义起点', location:'old'}; selected['stop-1'] = {name:'中途地点',location:'stop'}; selected.end = {name:'自定义终点',location:'end'}");
  confirmCurrentDestination(f);
  f.modes.current.value = 'walking'; f.modes.custom.value = 'driving';
  f.elements.get('current-policy').value = '4'; f.elements.get('policy').value = '2';
  f.run("switchRoutePanel('current', false)"); f.emitPosition();
  assert.equal(f.elements.get('current-policy-field').hidden, true);
  f.run("switchRoutePanel('custom', false)");
  assert.equal(f.elements.get('start').value, '自定义起点');
  assert.equal(f.run('selected.start.location'), 'old');
  assert.equal(f.run("selected['stop-1'].location"), 'stop');
  assert.equal(f.run('currentDestination.name'), '天坛公园');
  assert.equal(f.run('currentMode()'), 'walking'); assert.equal(f.run('mode()'), 'driving');
  assert.equal(f.elements.get('current-policy').value, '4'); assert.equal(f.elements.get('policy').value, '2');
});
test('current route snapshots the newest fix and does not inherit custom stops or mutate custom start', async () => {
  const f = liveFixture('current'); confirmCurrentDestination(f);
  f.run("selected.start = {name:'自定义起点',location:'old'}; stops.push('hidden-stop'); selected['hidden-stop'] = {name:'自定义途经点',location:'stop'}");
  // Supply the hidden custom field so the normal clear-options path can visit it.
  f.elements.set('hidden-stop-options', { hidden: true });
  f.emitPosition([116.4, 39.9]); f.emitPosition([116.42, 39.92]);
  const task = f.elements.get('current-route-form').onsubmit(event);
  assert.deepEqual(f.searches[0].args[0], [116.42, 39.92]);
  assert.equal(f.searches[0].args.length, 2);
  f.emitPosition([116.43, 39.93]);
  assert.deepEqual(f.searches[0].args[0], [116.42, 39.92]);
  completeRoute(f); await task;
  assert.equal(f.elements.get('summary').hidden, false);
  assert.equal(f.elements.get('visit-order').hidden, true);
  assert.equal(f.run('selected.start.location'), 'old');
  const second = f.elements.get('current-route-form').onsubmit(event);
  assert.deepEqual(f.searches[1].args[0], [116.43, 39.93]); completeRoute(f); await second;
});
test('expired, denied and stopped locations prevent a current route query', async () => {
  const f = liveFixture('current'); confirmCurrentDestination(f); f.emitPosition();
  f.run('livePosition.timestamp = Date.now() - 31000; syncCurrentForm()');
  assert.equal(f.elements.get('current-plan').disabled, true);
  await f.elements.get('current-route-form').onsubmit(event);
  assert.match(f.elements.get('status').textContent, /有效的当前位置/);
  f.emitPosition(); Object.assign(f.state, { positionState: 'error', positionError: 'denied' }); f.options().onState(f.state);
  await f.elements.get('current-route-form').onsubmit(event);
  assert.equal(f.searches.length, 0);
  assert.match(f.elements.get('current-origin-status').textContent, /定位权限被拒绝/);
  f.emitPosition(); f.elements.get('live-toggle').onclick();
  assert.equal(f.elements.get('current-plan').disabled, true);
});
test('typing a destination is insufficient until a candidate is confirmed', async () => {
  const f = liveFixture('current'); f.emitPosition(); const searches = [];
  f.context.AMap.PlaceSearch = class { search(keyword, callback) { searches.push({ keyword, callback }); } };
  f.elements.get('current-destination').value = '天坛';
  await f.elements.get('current-route-form').onsubmit(event);
  assert.equal(f.pending.length, 0); assert.match(f.elements.get('status').textContent, /确认目的地/);
  searches.at(-1).callback('complete', { poiList: { pois: [{ name: '天坛公园', location: '116.41,39.88' }] } });
  f.elements.get('current-destination-options').children[0].onclick();
  assert.equal(f.run('currentDestination.name'), '天坛公园');
  const task = f.elements.get('current-route-form').onsubmit(event); completeRoute(f); await task;
  assert.equal(f.elements.get('summary').hidden, false);
});
test('destination searches ignore older keywords and callbacks after switching panels', () => {
  const f = liveFixture('current'), searches = [];
  f.context.AMap.PlaceSearch = class { search(keyword, callback) { searches.push({ keyword, callback }); } };
  f.elements.get('current-destination').value = '甲'; f.run('searchCurrentDestination()');
  f.elements.get('current-destination').value = '乙'; f.run('searchCurrentDestination()');
  searches[0].callback('complete', { poiList: { pois: [{ name: '旧结果', location: 'old' }] } });
  assert.equal(f.elements.get('current-destination-options').children.length, 0);
  searches[1].callback('complete', { poiList: { pois: [{ name: '乙地点', location: 'new' }] } });
  const oldButton = f.elements.get('current-destination-options').children[0];
  f.run("switchRoutePanel('custom', false); switchRoutePanel('current', false)");
  oldButton.onclick(); assert.equal(f.run('currentDestination'), null);
  searches[1].callback('complete', { poiList: { pois: [{ name: '迟到结果', location: 'late' }] } });
  assert.equal(f.elements.get('current-destination-options').hidden, true);
});
test('editing a confirmed destination invalidates it without changing custom end', () => {
  const f = liveFixture('current'); confirmCurrentDestination(f);
  f.run("selected.end = {name:'自定义终点',location:'end'}");
  f.elements.get('current-destination').value = '新的目的地'; f.elements.get('current-destination').handlers.input();
  f.run('clearTimeout(currentDestinationTimer)');
  assert.equal(f.run('currentDestination'), null);
  assert.equal(f.run('selected.end.location'), 'end');
  assert.equal(f.elements.get('current-destination').attributes['aria-invalid'], 'true');
});
test('switching cancels an outstanding route immediately and ignores its late result', async () => {
  const f = liveFixture('current'); f.emitPosition(); confirmCurrentDestination(f);
  const task = f.elements.get('current-route-form').onsubmit(event), callback = f.pending.shift();
  f.run("switchRoutePanel('custom', false)"); await task;
  assert.equal(f.run('busy'), false); assert.equal(f.elements.get('summary').hidden, true);
  assert.match(f.elements.get('status').textContent, /已切换面板/);
  callback('complete', { routes: [{ time: 60, distance: 100 }] });
  assert.equal(f.elements.get('summary').hidden, true);
  assert.equal(f.elements.get('planning-progress').hidden, true);
});
test('switching away from a pending custom GPS start prevents later coordinates from overwriting it', () => {
  const f = liveFixture(); f.run("selected.start = {name:'原起点',location:'keep'}");
  f.elements.get('locate').onclick(); assert.equal(f.elements.get('locate').disabled, true);
  f.run("switchRoutePanel('current', false)"); f.emitPosition();
  assert.equal(f.run('selected.start.location'), 'keep'); assert.equal(f.elements.get('locate').disabled, false);
});
test('current walking and riding use their own mode regardless of custom driving stops', async () => {
  const f = liveFixture('current'); f.emitPosition(); confirmCurrentDestination(f);
  f.context.AMap.Walking = f.context.AMap.Driving; f.context.AMap.Riding = f.context.AMap.Driving;
  for (const mode of ['walking', 'riding']) {
    f.modes.current.value = mode; f.modes.current.handlers.change();
    const task = f.elements.get('current-route-form').onsubmit(event); completeRoute(f); await task;
    assert.equal(f.elements.get('summary').hidden, false); assert.equal(f.searches.at(-1).options.policy, undefined);
  }
});
test('current driving applies only the current panel policy', async () => {
  const f = liveFixture('current'); f.emitPosition(); confirmCurrentDestination(f);
  f.elements.get('current-policy').value = '4'; f.elements.get('policy').value = '2';
  const task = f.elements.get('current-route-form').onsubmit(event);
  assert.equal(f.searches[0].options.policy, 4); completeRoute(f); await task;
});
test('current transit reverse-geocodes the snapshot city and never uses the custom default city', async () => {
  const f = liveFixture('current'); f.emitPosition([113.26, 23.13]); confirmCurrentDestination(f);
  f.modes.current.value = 'transfer'; f.elements.get('city').value = '北京';
  const geocodes = mockGeocoder(f), task = f.elements.get('current-route-form').onsubmit(event);
  assert.deepEqual(geocodes[0].location, [113.26, 23.13]);
  geocodes[0].callback('complete', { regeocode: { addressComponent: { city: '广州市', province: '广东省' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.searches[0].options.city, '广州市'); assert.equal(f.searches[0].options.cityd, '北京市');
  completeRoute(f); await task; assert.equal(f.elements.get('current-city').value, '广州市');
});
test('municipal transit city uses province when city is an empty array', async () => {
  const f = liveFixture('current'); f.emitPosition(); confirmCurrentDestination(f); f.modes.current.value = 'transfer';
  const geocodes = mockGeocoder(f), task = f.elements.get('current-route-form').onsubmit(event);
  geocodes[0].callback('complete', { regeocode: { addressComponent: { city: [], province: '北京市' } } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.searches[0].options.city, '北京市'); completeRoute(f); await task;
});
test('failed transit city lookup has manual recovery and does not silently fall back to Beijing', async () => {
  const f = liveFixture('current'); f.emitPosition(); confirmCurrentDestination(f); f.modes.current.value = 'transfer';
  const geocodes = mockGeocoder(f), task = f.elements.get('current-route-form').onsubmit(event);
  geocodes[0].callback('error', {}); await task;
  assert.equal(f.searches.length, 0); assert.match(f.elements.get('status').textContent, /手动填写公交出发城市/);
  f.elements.get('current-city').value = '深圳'; f.elements.get('current-city').handlers.input();
  const retry = f.elements.get('current-route-form').onsubmit(event); await Promise.resolve();
  assert.equal(geocodes.length, 1); assert.equal(f.searches[0].options.city, '深圳'); completeRoute(f); await retry;
});
test('switching during city detection cancels promptly and ignores late geocoding', async () => {
  const f = liveFixture('current'); f.emitPosition(); confirmCurrentDestination(f); f.modes.current.value = 'transfer';
  const geocodes = mockGeocoder(f), task = f.elements.get('current-route-form').onsubmit(event);
  f.run("switchRoutePanel('custom', false)"); await task;
  assert.equal(f.run('busy'), false);
  geocodes[0].callback('complete', { regeocode: { addressComponent: { city: '迟到城市' } } });
  assert.equal(f.searches.length, 0); assert.equal(f.elements.get('current-city').value, '');
  assert.match(f.elements.get('status').textContent, /已切换面板/);
});
test('keyboard panel switching and language changes preserve selections and location', () => {
  const f = liveFixture('current'); f.emitPosition(); confirmCurrentDestination(f);
  f.elements.get('current-tab').handlers.keydown({ ...event, key: 'End' });
  assert.equal(f.run('activeRoutePanel'), 'custom'); assert.equal(f.elements.get('custom-tab').attributes.tabindex, '0');
  f.elements.get('custom-tab').handlers.keydown({ ...event, key: 'Home' });
  assert.equal(f.run('activeRoutePanel'), 'current');
  f.context.window.I18n.setLanguage('en');
  assert.equal(f.run('currentDestination.name'), '天坛公园'); assert.equal(f.markers.length, 1);
  assert.match(f.elements.get('current-destination-state').textContent, /Confirmed/);
  assert.match(f.elements.get('current-origin-status').textContent, /Accuracy about 12/);
});
