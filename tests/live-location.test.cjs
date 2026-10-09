const test = require('node:test');
const assert = require('node:assert/strict');
const { create, headingFromEvent } = require('../live-location.js');

function target() {
  const handlers = new Map();
  return { handlers, addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); }, removeEventListener(name, fn) { handlers.get(name)?.delete(fn); }, dispatch(name, event = {}) { for (const fn of handlers.get(name) || []) fn({ type: name, ...event }); }, count(name) { return handlers.get(name)?.size || 0; } };
}
function fixture({ secure = true, geo = true, sensors = true, permission, deferred = false, conversionDelay = 0 } = {}) {
  let time = 100000, nextId = 0;
  const timers = new Map(), calls = [], cleared = [], converted = [], states = [], positions = [], headings = [], centers = [];
  const environment = { ...target(), isSecureContext: secure, document: { ...target(), hidden: false }, navigator: {}, screen: { orientation: { ...target(), angle: 0 } },
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: time + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: time + delay, interval: delay }); return id; }, clearInterval(id) { timers.delete(id); } };
  if (sensors) environment.DeviceOrientationEvent = permission ? { requestPermission: permission } : {};
  if (geo) environment.navigator.geolocation = { watchPosition(success, failure, options) { calls.push({ success, failure, options }); return calls.length; }, clearWatch(id) { cleared.push(id); } };
  let clears = 0, inFlight = 0, maximumInFlight = 0;
  const controller = create({ environment, now: () => time, convertPosition(coords, done) {
    inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight);
    let finished = false;
    const complete = (...args) => { if (!finished) { finished = true; inFlight--; } done(...args); };
    converted.push({ coords, done: complete });
    if (!deferred) {
      const success = () => complete(null, [coords[0] + 0.006, coords[1] + 0.001]);
      if (conversionDelay) environment.setTimeout(success, conversionDelay); else success();
    }
  }, onState: (s) => states.push(s), onPosition: (p) => positions.push(p), onHeading: (h) => headings.push(h), onClear: () => clears++, onRecenter: (p) => centers.push(p) });
  return { controller, environment, calls, cleared, converted, states, positions, headings, centers, timers, maxInFlight: () => maximumInFlight, clears: () => clears, state: () => states.at(-1),
    position(options = {}, call = calls.at(-1)) { call.success({ coords: { latitude: 39.9, longitude: 116.4, accuracy: 12, ...options.coords }, timestamp: options.timestamp ?? time }); },
    advance(ms) { const end = time + ms; while (true) { const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [id, timer] = next; time = timer.at; if (timer.interval) timer.at += timer.interval; else timers.delete(id); timer.fn(); } time = end; },
    hidden(value) { environment.document.hidden = value; environment.document.dispatch('visibilitychange'); }, orientation(value) { environment.dispatch('deviceorientation', value); } };
}

test('requires secure context and browser geolocation without using IP fallback', () => {
  const insecure = fixture({ secure: false }); insecure.controller.start(); assert.equal(insecure.state().positionError, 'insecure'); assert.equal(insecure.calls.length, 0);
  const unsupported = fixture({ geo: false }); unsupported.controller.start(); assert.equal(unsupported.state().positionError, 'unsupported');
});
test('one continuous watch uses fresh high-accuracy samples and converted coordinates', () => {
  const f = fixture(); f.controller.start(); f.controller.start(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].options, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  f.position(); assert.deepEqual(f.positions[0].location, [116.406, 39.900999999999996]); assert.equal(f.state().positionState, 'active');
  f.advance(1000); f.position({ coords: { longitude: 116.5, accuracy: 250 } }); assert.equal(f.positions.length, 2); assert.equal(f.state().position.accuracy, 250);
});
test('recenter is explicit and only works with a fresh position', () => {
  const f = fixture(); f.controller.start(); f.controller.recenter(); assert.equal(f.centers.length, 0);
  f.position(); f.controller.recenter(); assert.equal(f.centers.length, 1); f.advance(31000); f.controller.recenter(); assert.equal(f.centers.length, 1); assert.equal(f.state().positionState, 'stale');
});
test('stationary position samples refresh precision and freshness without new conversions', () => {
  const f = fixture(); f.controller.start(); f.position(); f.advance(29000); f.position({ coords: { accuracy: 20 } }); f.advance(2000);
  assert.equal(f.converted.length, 1); assert.equal(f.state().positionState, 'active'); assert.equal(f.state().position.accuracy, 20);
});
test('permission denial stops all tracking and remains an actionable error', async () => {
  const f = fixture(); f.controller.start(); await f.controller.enableDirection(); f.calls[0].failure({ code: 1 });
  assert.equal(f.state().enabled, false); assert.equal(f.state().positionError, 'denied'); assert.equal(f.environment.count('deviceorientation'), 0); assert.deepEqual(f.cleared, [1]); assert.equal(f.timers.size, 0);
});
test('temporary timeout recovers on the next position', () => {
  const f = fixture(); f.controller.start(); f.calls[0].failure({ code: 3 }); assert.equal(f.state().positionError, 'timeout'); assert.equal(f.state().enabled, true); f.position(); assert.equal(f.state().positionState, 'active');
});
test('invalid coordinates or accuracy never render on the map', () => {
  for (const coords of [{ longitude: NaN }, { latitude: 91 }, { longitude: 181 }, { accuracy: -1 }, { accuracy: null }]) {
    const f = fixture(); f.controller.start(); f.position({ coords }); assert.equal(f.positions.length, 0); assert.equal(f.state().positionError, 'unavailable');
  }
});
test('cached and out-of-order positions do not overwrite a newer sample', () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position({ timestamp: 60000 }); assert.equal(f.converted.length, 0);
  f.position({ timestamp: 100000 }); f.position({ timestamp: 99000 }); assert.equal(f.converted.length, 1);
});
test('serialized conversions and duplicate callbacks cannot overwrite a newer position', () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position(); f.advance(1000); f.position({ coords: { longitude: 117 } });
  assert.equal(f.converted.length, 1);
  f.converted[0].done(null, [116, 39]); f.converted[1].done(null, [117, 40]);
  f.converted[0].done(null, [115, 38]); assert.deepEqual(f.positions.map((p) => p.location), [[116, 39], [117, 40]]);
});
test('failed or hung coordinate conversion is shown and can recover', () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position(); f.converted[0].done(new Error('network')); assert.equal(f.state().positionError, 'conversion');
  f.advance(1000); f.advance(8001); assert.equal(f.state().positionError, 'conversion'); f.converted[1].done(null, [1, 2]); assert.equal(f.positions.length, 0);
  f.advance(2000); f.converted[2].done(null, [116, 39]); assert.equal(f.state().positionState, 'active');
});

test('frequent GPS updates still render under slower conversion without overlapping requests', () => {
  const f = fixture({ conversionDelay: 1500 }); f.controller.start();
  for (let i = 0; i < 20; i++) { f.position({ coords: { longitude: 116.4 + i / 100000 } }); f.advance(1000); }
  assert.ok(f.positions.length >= 10);
  assert.equal(f.maxInFlight(), 1);
  assert.ok(f.converted.length < 20);
  f.advance(3000);
  assert.equal(f.state().positionState, 'active');
  assert.equal(f.state().position.timestamp, 119000);
});

test('the conversion queue retains only the newest GPS sample', () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position();
  f.advance(1000); f.position({ coords: { longitude: 117 } });
  f.advance(1000); f.position({ coords: { longitude: 118, accuracy: 20 } });
  assert.equal(f.converted.length, 1);
  f.converted[0].done(null, [116, 39]);
  assert.deepEqual(f.converted[1].coords, [118, 39.9]);
  f.converted[1].done(null, [118, 40]);
  assert.equal(f.state().position.accuracy, 20);
  assert.equal(f.state().position.timestamp, 102000);
});

test('queued stationary samples reuse the completed conversion and refresh freshness', () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position(); f.advance(1000); f.position({ coords: { accuracy: 20 } });
  f.converted[0].done(null, [116, 39]);
  assert.equal(f.converted.length, 1);
  assert.equal(f.state().position.timestamp, 101000);
  assert.equal(f.state().position.accuracy, 20);
});

test('a transient conversion error retries without requiring a new GPS callback', () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position(); f.converted[0].done(new Error('network'));
  f.advance(999); assert.equal(f.converted.length, 1);
  f.advance(1); f.converted[1].done(null, [116, 39]);
  assert.equal(f.state().positionState, 'active'); assert.equal(f.calls.length, 1);
});

test('conversion retries are bounded and later GPS samples can recover', () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position(); f.converted[0].done(new Error('network'));
  f.advance(1000); f.converted[1].done(new Error('network'));
  f.advance(2000); f.converted[2].done(new Error('network'));
  f.advance(26000); assert.equal(f.converted.length, 3); assert.equal(f.state().positionState, 'error');
  f.position(); f.converted[3].done(null, [116, 39]); assert.equal(f.state().positionState, 'active');
});

test('GPS samples during retry backoff replace the retry sample without bypassing the delay', () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position(); f.converted[0].done(new Error('network'));
  f.advance(500); f.position({ coords: { longitude: 117 } }); assert.equal(f.converted.length, 1);
  f.advance(500); assert.deepEqual(f.converted[1].coords, [117, 39.9]);
});

test('automatic retries never convert an expired GPS sample', () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position({ timestamp: 70001 }); f.converted[0].done(new Error('network'));
  f.advance(1000); assert.equal(f.converted.length, 1); assert.equal(f.positions.length, 0);
});

test('manual retry restarts only the GPS watch and ignores old callbacks', async () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position(); f.converted[0].done(new Error('network'));
  await f.controller.enableDirection(); const old = f.calls[0]; f.controller.start();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.cleared, [1]); assert.equal(f.environment.count('deviceorientation'), 1);
  f.position({}, old); assert.equal(f.converted.length, 1);
  f.position(); f.converted[1].done(null, [116, 39]); f.advance(3000);
  assert.equal(f.converted.length, 2); assert.equal(f.state().positionState, 'active');
});

test('manual refresh of a stale position starts one fresh watch', () => {
  const f = fixture(); f.controller.start(); f.position(); f.advance(31000); f.controller.start(); f.controller.start();
  assert.equal(f.calls.length, 2); assert.equal(f.state().positionState, 'waiting');
  f.position(); assert.equal(f.state().positionState, 'active');
});

test('stop, backgrounding and disposal cancel queued conversions and automatic retries', () => {
  for (const action of ['stop', 'hide', 'dispose']) for (const failed of [false, true]) {
    const f = fixture({ deferred: true }); f.controller.start(); f.position();
    if (failed) f.converted[0].done(new Error('network')); else { f.advance(1000); f.position({ coords: { longitude: 117 } }); }
    if (action === 'hide') f.hidden(true); else f.controller[action]();
    f.advance(10000); f.converted[0].done(null, [116, 39]);
    assert.equal(f.converted.length, 1); assert.equal(f.positions.length, 0); assert.equal(f.timers.size, 0);
  }
});
test('stop clears watch, overlays, timers, and ignores already queued callbacks', () => {
  const f = fixture({ deferred: true }); f.controller.start(); f.position(); const old = f.calls[0]; f.controller.stop();
  f.converted[0].done(null, [1, 2]); f.position({}, old); assert.equal(f.positions.length, 0); assert.equal(f.state().positionState, 'idle'); assert.equal(f.timers.size, 0); assert.equal(f.clears(), 1);
});
test('restart does not accept callbacks from an earlier watch', () => {
  const f = fixture(); f.controller.start(); const old = f.calls[0]; f.controller.stop(); f.controller.start(); f.position({}, old); assert.equal(f.positions.length, 0); f.position(); assert.equal(f.positions.length, 1);
});
test('hiding the page pauses GPS and direction; resuming registers one fresh watch', async () => {
  const f = fixture(); f.controller.start(); f.position(); await f.controller.enableDirection(); f.orientation({ webkitCompassHeading: 90 });
  f.hidden(true); assert.equal(f.state().positionState, 'paused'); assert.equal(f.state().heading, null); assert.equal(f.environment.count('deviceorientation'), 0); assert.equal(f.timers.size, 0);
  f.hidden(false); f.environment.dispatch('pageshow'); assert.equal(f.calls.length, 2); assert.equal(f.environment.count('deviceorientation'), 1); assert.equal(f.state().positionState, 'waiting');
});
test('pagehide/pageshow supports browser history cache and disposal removes lifecycle handlers', () => {
  const f = fixture(); f.controller.start(); f.environment.dispatch('pagehide'); assert.equal(f.state().watching, false); f.environment.dispatch('pageshow'); assert.equal(f.calls.length, 2);
  f.controller.dispose(); assert.equal(f.environment.document.count('visibilitychange'), 0); assert.equal(f.environment.count('pagehide'), 0); assert.equal(f.environment.count('pageshow'), 0);
});
test('direction permission is requested synchronously by the gesture and denial keeps GPS', async () => {
  let requested = 0; const f = fixture({ permission: (absolute) => { assert.equal(absolute, true); requested++; return Promise.resolve('denied'); } });
  f.controller.start(); const task = f.controller.enableDirection(); assert.equal(requested, 1); await task;
  assert.equal(f.state().directionState, 'denied'); assert.equal(f.state().watching, true); f.position(); assert.equal(f.state().positionState, 'active');
});
test('pending direction permission cannot add listeners after stop or backgrounding', async () => {
  for (const action of ['stop', 'hide']) {
    let resolve; const f = fixture({ permission: () => new Promise((r) => { resolve = r; }) }); f.controller.start(); const task = f.controller.enableDirection();
    if (action === 'stop') f.controller.stop(); else f.hidden(true); resolve('granted'); await task; assert.equal(f.environment.count('deviceorientation'), 0);
    if (action === 'hide') { f.hidden(false); assert.equal(f.environment.count('deviceorientation'), 0); }
  }
});
test('missing sensor support and a silent sensor produce explicit fallback states', async () => {
  const absent = fixture({ sensors: false }); absent.controller.start(); await absent.controller.enableDirection(); assert.equal(absent.state().directionState, 'unavailable'); assert.equal(absent.state().directionEnabled, false);
  const silent = fixture(); silent.controller.start(); await silent.controller.enableDirection(); silent.advance(6000); assert.equal(silent.state().directionState, 'unavailable'); assert.equal(silent.state().watching, true);
});
test('relative alpha and GPS travel heading never masquerade as compass direction', async () => {
  const f = fixture(); f.controller.start(); await f.controller.enableDirection(); f.position({ coords: { heading: 90, speed: 2 } }); f.orientation({ alpha: 270, beta: 0, gamma: 0, absolute: false }); assert.equal(f.state().directionState, 'waiting'); assert.equal(f.headings.length, 0);
});
test('iOS and absolute Android events give the cardinal directions', () => {
  for (const h of [0, 90, 180, 270]) {
    assert.equal(headingFromEvent({ webkitCompassHeading: h, webkitCompassAccuracy: 10 }), h);
    assert.ok(Math.abs(headingFromEvent({ alpha: (360 - h) % 360, beta: 0, gamma: 0, absolute: true }) - h) < 1e-9);
  }
  assert.equal(headingFromEvent({ alpha: 270, beta: 0, gamma: 0, type: 'deviceorientationabsolute' }), 90);
});
test('landscape compensation follows the displayed screen top, including 270 and legacy -90', () => {
  for (const angle of [90, 270, -90]) {
    const expected = (angle + 360) % 360;
    assert.equal(headingFromEvent({ webkitCompassHeading: 0 }, angle), expected);
    assert.equal(Math.round(headingFromEvent({ alpha: 0, beta: 0, gamma: 0, absolute: true }, angle)), expected);
  }
});
test('a vertical screen or unreliable compass hides the arrow', () => {
  assert.equal(headingFromEvent({ alpha: 90, beta: 90, gamma: 0, absolute: true }), null);
  assert.equal(headingFromEvent({ webkitCompassHeading: 10, webkitCompassAccuracy: 90 }), null);
  assert.equal(headingFromEvent({ webkitCompassHeading: 10, webkitCompassAccuracy: -1 }), null);
  assert.equal(headingFromEvent({ alpha: null, beta: 0, gamma: 0, absolute: true }), null);
});
test('heading smoothing crosses north by the shortest path and expired headings disappear', async () => {
  const f = fixture(); f.controller.start(); await f.controller.enableDirection(); f.orientation({ webkitCompassHeading: 359 }); f.orientation({ webkitCompassHeading: 1 });
  assert.ok(f.headings.at(-1) > 359 && f.headings.at(-1) < 361); f.advance(6000); assert.equal(f.state().directionState, 'stale'); assert.equal(f.headings.at(-1), null);
});
test('screen rotation recalculates heading without waiting for another sensor event', async () => {
  const f = fixture(); f.controller.start(); await f.controller.enableDirection(); f.orientation({ webkitCompassHeading: 0 });
  f.environment.screen.orientation.angle = 90; f.environment.screen.orientation.dispatch('change'); assert.equal(f.headings.at(-1), 90);
});

test('screen rotation cannot revive stale compass data', async () => {
  const f = fixture(); f.controller.start(); await f.controller.enableDirection(); f.orientation({ webkitCompassHeading: 0 }); f.advance(6000);
  f.environment.screen.orientation.angle = 90; f.environment.screen.orientation.dispatch('change');
  assert.equal(f.state().directionState, 'stale'); assert.equal(f.headings.at(-1), null);
});

test('screen rotation does not extend the original compass sample lifetime', async () => {
  const f = fixture(); f.controller.start(); await f.controller.enableDirection(); f.orientation({ webkitCompassHeading: 0 }); f.advance(4000);
  f.environment.screen.orientation.angle = 90; f.environment.screen.orientation.dispatch('change'); assert.equal(f.headings.at(-1), 90);
  f.advance(2000); assert.equal(f.state().directionState, 'stale'); assert.equal(f.headings.at(-1), null);
});

test('relative orientation events cannot replace the absolute sample used for screen rotation', async () => {
  const f = fixture(); f.controller.start(); await f.controller.enableDirection();
  f.environment.dispatch('deviceorientationabsolute', { alpha: 270, beta: 0, gamma: 0 });
  f.orientation({ alpha: 0, beta: 0, gamma: 0, absolute: false });
  f.environment.screen.orientation.angle = 90; f.environment.screen.orientation.dispatch('change');
  assert.equal(Math.round(f.headings.at(-1)), 180);
});
test('repeated unreliable compass samples notify once and recover on a reliable sample', async () => {
  const f = fixture(); f.controller.start(); await f.controller.enableDirection();
  const states = f.states.length, headings = f.headings.length;
  for (let i = 0; i < 100; i++) f.orientation({ webkitCompassHeading: 90, webkitCompassAccuracy: 80 });
  assert.equal(f.states.length, states + 1); assert.equal(f.headings.length, headings + 1); assert.equal(f.state().directionState, 'posture');
  f.orientation({ webkitCompassHeading: 90, webkitCompassAccuracy: 10 });
  assert.equal(f.state().directionState, 'active'); assert.equal(f.headings.at(-1), 90);
  f.orientation({ webkitCompassHeading: 100, webkitCompassAccuracy: 10 });
  assert.equal(f.states.length, states + 2); assert.ok(f.headings.at(-1) > 90);
});

test('repeated rotation of expired compass data avoids duplicate state notifications', async () => {
  const f = fixture(); f.controller.start(); await f.controller.enableDirection(); f.orientation({ webkitCompassHeading: 0 }); f.advance(6000);
  const states = f.states.length, headings = f.headings.length;
  for (const angle of [90, 180, 270, 0]) { f.environment.screen.orientation.angle = angle; f.environment.screen.orientation.dispatch('change'); }
  assert.equal(f.states.length, states); assert.equal(f.headings.length, headings); assert.equal(f.state().directionState, 'stale');
});

test('direction can be stopped and reenabled without duplicating listeners', async () => {
  const f = fixture(); f.controller.start(); await f.controller.enableDirection(); await f.controller.enableDirection(); assert.equal(f.environment.count('deviceorientation'), 0);
  await f.controller.enableDirection(); assert.equal(f.environment.count('deviceorientation'), 1); assert.equal(f.state().watching, true);
});
