const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { cityForAddress } = require('../metro.js');
const settle = () => new Promise(resolve => setImmediate(resolve));
const cities = { 1100: { name: '北京市' }, 4401: { name: '广州市' } };

function fixture({ address = { city: [], province: '北京市' }, position = true, deferred = false, saved = null, offline = false, storageFailure = false, unavailableStation = false, renamedStation = false } = {}) {
  const elements = new Map(), storage = new Map(), timers = new Map(), geocodes = [], views = [], routeRequests = [];
  if (saved) storage.set('xingtu-metro', JSON.stringify(saved));
  class Element {
    constructor() { this.children = []; this.value = ''; this.hidden = false; this.open = false; this.handlers = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    removeEventListener(name) { delete this.handlers[name]; }
    showModal() { this.open = true; }
    close() { this.open = false; this.handlers.close?.(); }
    remove() {}
    blur() {}
    getAttribute() { return null; }
  }
  const document = { readyState: 'complete', getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement() { return new Element(); }, querySelector() { return null; }, documentElement: new Element(), head: new Element() };
  const points = { a: { id: 'a', poiid: 'pa', name: '甲站', lnglat: '116,39', status: '1', referlines: [{ name: '1号线' }] }, b: { id: 'b', poiid: 'pb', name: '乙站', lnglat: '116.1,39.1', status: '1', referlines: [] }, closed: { id: 'closed', name: '未开通站', status: '0' } };
  if (unavailableStation) points.b.status = '0';
  if (renamedStation) { points.b.name = '乙站新名'; points.b.poiid = 'pb-new'; }
  const window = { crypto: { randomUUID: () => 'test-route-' + routeRequests.length }, I18n: { t: text => text, onChange() {} }, AMap: { Geocoder: class { getAddress(location, callback) { geocodes.push({ location, callback }); if (!deferred) callback('complete', { regeocode: { addressComponent: address } }); } } }, subway(id, options) {
    const handlers = {}, calls = [];
    const view = { options, handlers, calls, event: { on(name, callback) { handlers[name] = callback; } }, getStationInfo(id) { return points[id] || {}; }, getLineList(callback) { callback([{ id: 'line', name: '1号线' }]); }, getNearStation() { return 'a'; }, getStCenter(id) { return id; }, stationSearch(keyword, callback) { callback({ keyword, stationList: [points.a] }); } };
    for (const method of ['setAdcode', 'clearRoute', 'clearOverlays', 'stopAnimation', 'setCenter', 'clearMarker', 'setStart', 'setEnd', 'showLine', 'setFitView', 'clearLine', 'scale', 'route']) view[method] = (...args) => calls.push({ method, args });
    view.emit = (name, info) => handlers[name]?.({}, info);
    view.routeWithData = args => { calls.push({ method: 'routeWithData', args: [args] }); view.emit('subway.routeComplete', { status: 1, data: args.routedata }); };
    views.push(view); return view;
  } };
  document.getElementById('metro-frame').contentWindow = window;
  document.getElementById('metro-frame').contentDocument = document;
  window.document = document;
  let requests = 0, nextTimer = 0, locationRequests = 0;
  const context = { window, document, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => { if (storageFailure) throw new Error('quota'); storage.set(key, value); }, removeItem: key => storage.delete(key) }, Date, AbortController, URLSearchParams,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    async fetch(url, options = {}) {
      if (String(url).includes('/subway/service/navigation/busExt?')) return new Promise((resolve, reject) => {
        // Deliberately allow an aborted response to arrive, exercising the request guard too.
        routeRequests.push({ url, signal: options.signal, reject, resolve(data) { resolve({ ok: true, json: async () => data }); } });
      });
      requests++; if (offline) throw new Error('offline'); return { ok: true, json: async () => ({ citylist: Object.entries(cities).map(([adcode, city]) => ({ adcode, cityname: city.name })) }) };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../metro.js'), 'utf8'), context);
  const options = { getConfig: () => ({ key: 'test' }), getPosition: () => position ? { location: [116, 39], timestamp: Date.now() } : null, requestLocation() { locationRequests++; } };
  const controller = window.Metro.create(options);
  return { elements, storage, timers, geocodes, views, routeRequests, controller, get requests() { return requests; }, get locationRequests() { return locationRequests; },
    async completeRoute(data, index = routeRequests.length - 1) { routeRequests[index].resolve({ count: '1', ...data }); await settle(); },
    $(id) { return document.getElementById(id); }, async open() { await controller.open(); views.at(-1)?.emit('subway.complete'); },
    choose(id, which) { views.at(-1).emit('station.touch', { id }); document.getElementById('metro-set-' + which).onclick(); }
  };
}

test('city comes from the GPS reverse geocode, including municipalities; unknown cities never fall back', () => {
  assert.equal(cityForAddress(cities, { city: [], province: '北京市' }), '1100');
  assert.equal(cityForAddress(cities, { city: '广州市', province: '广东省' }), '4401');
  assert.equal(cityForAddress(cities, { city: '无地铁市' }), null);
});

test('located city loads the complete official map and a line selector', async () => {
  const f = fixture({ address: { city: '广州市' } }); await f.open();
  assert.equal(f.views[0].options.adcode, 4401);
  assert.equal(f.$('metro-city').value, '4401');
  assert.equal(f.$('metro-line').children.length, 2);
  assert.match(f.$('metro-status').textContent, /全部地铁线路/);
});

test('no GPS permits manual city selection; unsupported cities do not display a different network', async () => {
  const f = fixture({ position: false }); await f.open();
  assert.equal(f.views.length, 0); assert.equal(f.locationRequests, 1);
  f.$('metro-city').value = '1100'; f.$('metro-city').onchange(); f.views[0].emit('subway.complete');
  assert.equal(f.views[0].options.adcode, 1100);
  const unsupported = fixture({ address: { city: '无地铁市' } }); await unsupported.open();
  assert.equal(unsupported.views.length, 0); assert.match(unsupported.$('metro-status').textContent, /暂无高德地铁数据/);
});

test('manual city and closing the window invalidate a late geocoder response', async () => {
  const f = fixture({ deferred: true }); const task = f.controller.open(); await settle();
  f.$('metro-city').value = '4401'; f.$('metro-city').onchange(); f.views[0].emit('subway.complete');
  f.geocodes[0].callback('complete', { regeocode: { addressComponent: { province: '北京市' } } }); await task;
  assert.equal(f.$('metro-city').value, '4401');
  f.$('metro-locate').onclick(); const call = f.geocodes.at(-1); f.$('metro-close').onclick();
  call.callback('complete', { regeocode: { addressComponent: { province: '北京市' } } }); await settle();
  assert.equal(f.$('metro-dialog').open, false); assert.equal(f.$('metro-city').value, '4401');
});

test('station clicks set distinct endpoints and route planning accepts only metro segments', async () => {
  const f = fixture(); await f.open();
  f.choose('a', 'start'); f.choose('a', 'end');
  assert.equal(f.$('metro-end').value, ''); assert.match(f.$('metro-status').textContent, /不能是同一个/);
  f.choose('b', 'end'); f.$('metro-plan').onclick();
  assert.equal(f.routeRequests.length, 1);
  f.$('metro-plan').onclick(); assert.equal(f.routeRequests.length, 1);
  const params = new URL(f.routeRequests[0].url).searchParams;
  assert.equal(params.get('poiid1'), 'pa'); assert.equal(params.get('poiid2'), 'pb');
  assert.equal(params.get('x1'), '116'); assert.equal(params.get('y2'), '39.1');
  await f.completeRoute({ buslist: [{ spoi: { id: 'pa' }, epoi: { id: 'pb' }, expense: '3', expensetime: '900', segmentlist: [{ bustype: '2', startname: '甲站', endname: '乙站', busname: '地铁1号线' }] }] });
  assert.equal(f.$('metro-result').hidden, false);
  assert.equal(f.$('metro-result').children[0].textContent, '15分钟 · 3 元');
  assert.match(f.$('metro-result').children[1].textContent, /甲站 → 乙站/);
});

test('closed stations, a stale route callback and a hung route never create a successful itinerary', async () => {
  const f = fixture(); await f.open(); f.choose('closed', 'start'); assert.equal(f.$('metro-start').value, '');
  f.choose('a', 'start'); f.choose('b', 'end'); f.$('metro-plan').onclick();
  await f.completeRoute({ buslist: [{ spoi: { id: 'wrong' }, epoi: { id: 'pb' } }] });
  assert.equal(f.$('metro-result').hidden, true);
  f.$('metro-plan').onclick();
  [...f.timers.values()].find(timer => timer.delay === 15000).fn();
  assert.equal(f.$('metro-plan').disabled, false); assert.match(f.$('metro-status').textContent, /未找到/);
});

test('official stationSearch response opens station actions and sets the start', async () => {
  const f = fixture(); await f.open(); f.$('metro-search').value = '甲'; f.$('metro-search').handlers.input();
  assert.equal(f.$('metro-search-results').children.length, 1);
  f.$('metro-search-results').children[0].onclick(); f.$('metro-set-start').onclick();
  assert.equal(f.$('metro-start').value, '甲站');
});

test('closing and reopening preserves selected stations; clear usage removes metro storage', async () => {
  const f = fixture(); await f.open(); f.choose('a', 'start'); f.choose('b', 'end');
  f.$('metro-close').onclick(); await f.open();
  assert.equal(f.$('metro-start').value, '甲站'); assert.equal(f.$('metro-end').value, '乙站');
  assert.equal(f.views.length, 1); assert.equal(f.requests, 1);
  const saved = JSON.parse(f.storage.get('xingtu-metro'));
  const reopened = fixture({ saved: { ...saved, manualCity: true } }); await reopened.open();
  assert.equal(reopened.$('metro-start').value, '甲站');
  reopened.controller.clear(); assert.equal(reopened.storage.has('xingtu-metro'), false);
});

test('network failure leaves a closable window and city loading timeout allows retry', async () => {
  const offline = fixture({ offline: true }); await offline.open();
  assert.match(offline.$('metro-status').textContent, /加载失败/);
  offline.$('metro-close').onclick(); assert.equal(offline.$('metro-dialog').open, false);
  const f = fixture(); await f.controller.open();
  [...f.timers.values()].find(timer => timer.delay === 20000).fn();
  assert.equal(f.$('metro-city').disabled, false); assert.equal(f.$('metro-plan').disabled, true);
});

test('clearing usage before a map loads cannot resurrect previously saved endpoints', async () => {
  const f = fixture({ saved: { city: '1100', start: 'a', end: 'b', manualCity: true } });
  f.controller.clear(); await f.open();
  assert.equal(f.$('metro-start').value, ''); assert.equal(f.$('metro-end').value, '');
});

test('failed phone location gives manual city recovery inside the metro window', async () => {
  const f = fixture({ position: false }); await f.open();
  f.controller.onLocationState({ positionState: 'error' });
  assert.match(f.$('metro-status').textContent, /允许位置权限或手动选择/);
  assert.equal(f.$('metro-city').disabled, false);
});

test('SDK timeout disables unavailable city controls and reopening retries successfully', async () => {
  const f = fixture(), target = f.$('metro-frame').contentWindow, subway = target.subway;
  delete target.subway;
  const task = f.controller.open(); await settle();
  [...f.timers.values()].find(timer => timer.delay === 20000).fn(); await task;
  assert.match(f.$('metro-status').textContent, /加载失败/);
  assert.equal(f.$('metro-city').disabled, true); assert.equal(f.$('metro-locate').disabled, true);
  f.$('metro-close').onclick(); target.subway = subway; await f.open();
  assert.equal(f.$('metro-city').disabled, false); assert.equal(f.views.length, 1);
});

test('a stalled embedded map page times out and remains closable', async () => {
  const f = fixture(); f.$('metro-frame').contentDocument.readyState = 'loading';
  const task = f.controller.open(); await settle();
  [...f.timers.values()].find(timer => timer.delay === 20000).fn(); await task;
  assert.match(f.$('metro-status').textContent, /加载失败/);
  assert.equal(f.views.length, 0);
  f.$('metro-close').onclick(); assert.equal(f.$('metro-dialog').open, false);
});

test('an initial blank iframe marked complete waits for the real metro canvas', async () => {
  const f = fixture({ position: false }), frame = f.$('metro-frame'), loadedDocument = frame.contentDocument;
  frame.contentDocument = { readyState: 'complete', getElementById() { return null; } };
  const task = f.controller.open(); await settle();
  assert.equal(typeof frame.handlers.load, 'function');
  frame.handlers.load(); await settle();
  assert.equal(f.locationRequests, 0);
  frame.contentDocument = loadedDocument; frame.handlers.load(); await task;
  assert.equal(f.$('metro-city').disabled, false);
  f.$('metro-city').value = '1100'; f.$('metro-city').onchange();
  assert.equal(f.views.length, 1);
});

test('the metro SDK reloads when navigation removes a previously loaded SDK', async () => {
  const f = fixture({ position: false }), target = f.$('metro-frame').contentWindow, subway = target.subway;
  let injections = 0;
  target.document.head.append = () => { injections++; target.subway = subway; target.manmanhangMetroReady(); };
  delete target.subway; await f.controller.open();
  assert.equal(injections, 1);
  f.$('metro-close').onclick(); delete target.subway;
  await f.controller.open();
  assert.equal(injections, 2);
  assert.equal(f.$('metro-city').disabled, false);
});

test('a metro window closed while its iframe loads does not start an SDK request', async () => {
  const f = fixture(), frame = f.$('metro-frame'), loadedDocument = frame.contentDocument;
  let injections = 0;
  delete frame.contentWindow.subway; frame.contentWindow.document.head.append = () => { injections++; };
  frame.contentDocument = { readyState: 'complete', getElementById() { return null; } };
  const task = f.controller.open(); await settle();
  assert.equal(typeof frame.handlers.load, 'function');
  f.$('metro-close').onclick(); frame.contentDocument = loadedDocument; frame.handlers.load(); await task;
  assert.equal(injections, 0);
  assert.equal(f.views.length, 0);
});

const plannedData = { count: '1', buslist: [{ spoi: { id: 'pa' }, epoi: { id: 'pb' }, expense: '3', expensetime: '900', segmentlist: [
  { bustype: '2', startname: '甲站', endname: '换乘站', busname: '地铁1号线' },
  { bustype: '2', startname: '换乘站', endname: '乙站', busname: '地铁2号线' }
] }] };
async function savedJourney() {
  const f = fixture(); await f.open(); f.choose('a', 'start'); f.choose('b', 'end'); f.$('metro-plan').onclick();
  await f.completeRoute(plannedData);
  return JSON.parse(f.storage.get('xingtu-metro'));
}

test('a fresh process restores the complete itinerary and highlighted path without a new route request or GPS', async () => {
  const saved = await savedJourney(), restarted = fixture({ saved, position: false });
  assert.equal(restarted.$('metro-start').value, '甲站');
  assert.equal(restarted.$('metro-result').hidden, false);
  await restarted.open();
  assert.equal(restarted.$('metro-end').value, '乙站');
  assert.equal(restarted.$('metro-result').children[0].textContent, '15分钟 · 3 元');
  assert.equal(restarted.$('metro-result').children.length, 3);
  const calls = restarted.views[0].calls;
  assert.equal(calls.filter(call => call.method === 'route').length, 0);
  assert.equal(calls.filter(call => call.method === 'routeWithData').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.method === 'routeWithData').args[0].routedata)), plannedData);
  assert.equal(restarted.locationRequests, 0);
});

test('automatic location in a different city does not overwrite the saved journey', async () => {
  const saved = await savedJourney(), restarted = fixture({ saved, address: { city: '广州市' } });
  await restarted.open();
  assert.equal(restarted.views[0].options.adcode, 1100);
  assert.equal(restarted.$('metro-city').value, '1100');
  assert.equal(restarted.$('metro-result').hidden, false);
  assert.equal(JSON.parse(restarted.storage.get('xingtu-metro')).city, '1100');
  assert.equal(restarted.geocodes.length, 0);
});

test('network failure keeps cached names, transfers and storage available', async () => {
  const saved = await savedJourney(), restarted = fixture({ saved, offline: true, position: false });
  await restarted.open();
  assert.equal(restarted.$('metro-start').value, '甲站');
  assert.equal(restarted.$('metro-end').value, '乙站');
  assert.equal(restarted.$('metro-result').hidden, false);
  assert.match(restarted.$('metro-result').children[2].textContent, /换乘站 → 乙站/);
  assert.deepEqual(JSON.parse(restarted.storage.get('xingtu-metro')), saved);
});

test('legacy saved station ids restore without GPS and do not imply a planned route', async () => {
  const restarted = fixture({ saved: { city: '1100', start: 'a', end: 'b', manualCity: false }, position: false });
  await restarted.open();
  assert.equal(restarted.$('metro-start').value, '甲站');
  assert.equal(restarted.$('metro-result').hidden, true);
  assert.equal(restarted.views[0].calls.filter(call => call.method === 'route').length, 0);
});

test('a failed replanning request keeps the last successful route', async () => {
  const saved = await savedJourney(), f = fixture({ saved }); await f.open();
  f.$('metro-plan').onclick();
  [...f.timers.values()].find(timer => timer.delay === 15000).fn();
  assert.equal(f.$('metro-result').hidden, false);
  assert.deepEqual(JSON.parse(f.storage.get('xingtu-metro')).route, plannedData);
});

test('clear usage invalidates an in-flight route and no saved journey returns on restart', async () => {
  const f = fixture({ saved: await savedJourney() }); await f.open(); f.$('metro-plan').onclick();
  f.controller.clear();
  await f.completeRoute(plannedData);
  assert.equal(f.$('metro-result').hidden, true);
  assert.equal(f.storage.has('xingtu-metro'), false);
  const restarted = fixture({ saved: f.storage.get('xingtu-metro') }); await restarted.open();
  assert.equal(restarted.$('metro-start').value, '');
  assert.equal(restarted.$('metro-end').value, '');
  assert.equal(restarted.$('metro-result').hidden, true);
});

test('clear selection removes the route and endpoints from saved state', async () => {
  const f = fixture({ saved: await savedJourney() }); await f.open(); f.$('metro-reset').onclick();
  const saved = JSON.parse(f.storage.get('xingtu-metro'));
  assert.equal(saved.start, null); assert.equal(saved.end, null); assert.equal(saved.route, null);
  const restarted = fixture({ saved }); await restarted.open();
  assert.equal(restarted.$('metro-result').hidden, true);
});

test('clear selection also cancels a pending request and ignores its late result', async () => {
  const f = fixture({ saved: await savedJourney() }); await f.open(); f.$('metro-plan').onclick();
  f.$('metro-reset').onclick();
  await f.completeRoute(plannedData);
  const saved = JSON.parse(f.storage.get('xingtu-metro'));
  assert.equal(saved.start, null); assert.equal(saved.end, null); assert.equal(saved.route, null);
  assert.equal(f.$('metro-result').hidden, true);
});

test('unavailable saved stations retain the last itinerary instead of erasing it', async () => {
  const saved = await savedJourney(), f = fixture({ saved, unavailableStation: true }); await f.open();
  assert.equal(f.$('metro-end').value, '乙站');
  assert.equal(f.$('metro-result').hidden, false);
  assert.deepEqual(JSON.parse(f.storage.get('xingtu-metro')).route, plannedData);
  assert.equal(f.$('metro-plan').disabled, true);
});

test('provider station metadata changes cannot invalidate the saved itinerary on the following restart', async () => {
  const saved = await savedJourney(), f = fixture({ saved, renamedStation: true }); await f.open();
  assert.equal(f.$('metro-end').value, '乙站');
  const restarted = fixture({ saved: JSON.parse(f.storage.get('xingtu-metro')), renamedStation: true }); await restarted.open();
  assert.equal(restarted.$('metro-result').hidden, false);
  assert.deepEqual(JSON.parse(restarted.storage.get('xingtu-metro')).route, plannedData);
  restarted.$('metro-plan').onclick();
  const updated = { ...plannedData, buslist: [{ ...plannedData.buslist[0], epoi: { id: 'pb-new' } }] };
  await restarted.completeRoute(updated);
  const updatedSaved = JSON.parse(restarted.storage.get('xingtu-metro'));
  assert.equal(updatedSaved.end.poiid, 'pb-new');
  assert.equal(updatedSaved.end.name, '乙站新名');
  assert.deepEqual(updatedSaved.route, updated);
});

test('mismatched or malformed cached routes are not displayed', async () => {
  const saved = await savedJourney();
  for (const route of [{ ...plannedData, buslist: [{ ...plannedData.buslist[0], epoi: { id: 'other' } }] }, { ...plannedData, buslist: [{ ...plannedData.buslist[0], segmentlist: [null] }] }]) {
    const f = fixture({ saved: { ...saved, route } }); await f.open();
    assert.equal(f.$('metro-result').hidden, true);
    assert.equal(f.views[0].calls.filter(call => call.method === 'routeWithData').length, 0);
  }
});

test('storage failure is visible after a route succeeds', async () => {
  const f = fixture({ storageFailure: true }); await f.open(); f.choose('a', 'start'); f.choose('b', 'end'); f.$('metro-plan').onclick();
  await f.completeRoute(plannedData);
  assert.equal(f.$('metro-result').hidden, false);
  assert.match(f.$('metro-status').textContent, /无法保存地铁/);
});

test('a timed-out response cannot complete a retry with identical endpoints', async () => {
  const f = fixture(); await f.open(); f.choose('a', 'start'); f.choose('b', 'end');
  const first = f.$('metro-plan').onclick();
  [...f.timers.values()].find(timer => timer.delay === 15000).fn();
  assert.equal(f.routeRequests[0].signal.aborted, true);
  const retry = f.$('metro-plan').onclick();
  await f.completeRoute(plannedData, 0);
  assert.equal(f.$('metro-result').hidden, true);
  assert.equal(f.$('metro-plan').disabled, true);
  const fresh = { ...plannedData, buslist: [{ ...plannedData.buslist[0], expensetime: '1200' }] };
  await f.completeRoute(fresh, 1); await Promise.all([first, retry]);
  assert.equal(f.$('metro-result').children[0].textContent, '20分钟 · 3 元');
  assert.deepEqual(JSON.parse(f.storage.get('xingtu-metro')).route, fresh);
});

test('a rejected old request cannot fail a newer retry', async () => {
  const f = fixture(); await f.open(); f.choose('a', 'start'); f.choose('b', 'end');
  const first = f.$('metro-plan').onclick();
  [...f.timers.values()].find(timer => timer.delay === 15000).fn();
  const retry = f.$('metro-plan').onclick();
  f.routeRequests[0].reject(new Error('aborted')); await first;
  assert.equal(f.$('metro-plan').disabled, true);
  await f.completeRoute(plannedData, 1); await retry;
  assert.equal(f.$('metro-result').hidden, false);
});

test('failed or invalid route responses keep the saved itinerary and allow retry', async () => {
  const saved = await savedJourney();
  for (const failure of ['network', { count: '0', buslist: [] }, { ...plannedData, buslist: [{ ...plannedData.buslist[0], segmentlist: [{ bustype: '1', startname: '甲站', endname: '乙站', busname: '公交车' }] }] }]) {
    const f = fixture({ saved }); await f.open();
    const task = f.$('metro-plan').onclick();
    if (failure === 'network') f.routeRequests[0].reject(new Error('offline'));
    else await f.completeRoute(failure);
    await task;
    assert.equal(f.$('metro-plan').disabled, false);
    assert.equal(f.$('metro-result').hidden, false);
    assert.deepEqual(JSON.parse(f.storage.get('xingtu-metro')).route, plannedData);
  }
});

test('an unsupported located city stays empty after late map completion and reopening', async () => {
  const address = { city: '广州市' }, f = fixture({ address }); await f.open();
  f.choose('a', 'start'); f.choose('b', 'end');
  address.city = '无地铁市'; f.$('metro-locate').onclick(); await settle();
  f.views[0].emit('subway.complete');
  assert.equal(f.$('metro-map').hidden, true);
  assert.equal(f.$('metro-plan').disabled, true);
  assert.equal(f.$('metro-start').value, '');
  assert.equal(JSON.parse(f.storage.get('xingtu-metro')).city, '');
  f.$('metro-close').onclick(); await f.open();
  assert.equal(f.$('metro-city').value, '');
  assert.equal(f.$('metro-map').hidden, true);
  assert.match(f.$('metro-status').textContent, /暂无高德地铁数据/);
  const restarted = fixture({ saved: JSON.parse(f.storage.get('xingtu-metro')), address }); await restarted.open();
  assert.equal(restarted.views.length, 0);
  f.$('metro-city').value = '1100'; f.$('metro-city').onchange(); f.views[0].emit('subway.complete');
  assert.equal(f.$('metro-map').hidden, false);
  assert.equal(f.$('metro-city').value, '1100');
});
