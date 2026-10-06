const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM adapter exercises the app's actual handlers without calling AMap.
function fixture() {
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
  const pending = [];
  let clears = 0;
  const context = vm.createContext({ document: doc, window: { NAV_CONFIG: {}, RouteOptimizer: require('../route-optimizer.js'), addEventListener() {} }, sessionStorage: { getItem: () => null }, localStorage: {}, navigator: { clipboard: { writeText: async () => {} } }, setTimeout, clearTimeout, requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, AMap: { Driving: class { clear() { clears++; } search(...args) { pending.push(args.at(-1)); } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  return { elements, pending, context, run: (code) => vm.runInContext(code, context), clears: () => clears };
}
const event = { preventDefault() {} };
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
