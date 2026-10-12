const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const source = html.match(/<script id="launch-script">([\s\S]*?)<\/script>/)[1];

function launch(width = 390, height = 844) {
  const events = {}, timers = new Map(), frames = new Map();
  const screen = { isConnected: true, remove() { this.isConnected = false; }, addEventListener(type, fn) { events[type] = fn; } };
  const logo = { getBoundingClientRect: () => ({ width: 109.2 }), style: { setProperty(name, value) { this[name] = value; } } };
  const main = { tagName: 'MAIN', inert: false }, alreadyBlocked = { tagName: 'SECTION', inert: true };
  const body = { children: [screen, main, alreadyBlocked], setAttribute() { this.busy = true; }, removeAttribute() { this.busy = false; } };
  const classes = new Set();
  const chrome = {content:'#17231f'};
  const appStyle = {media:'all'};
  const document = { body, hidden:false, documentElement: { dataset:{theme:'light'}, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } }, querySelector: () => chrome, getElementById: id => id === 'launch-screen' ? screen : id === 'app-style' ? appStyle : logo, addEventListener(type, fn) { events[type] = fn; }, removeEventListener(type) { delete events[type]; } };
  vm.runInNewContext(source, { document, innerWidth: width, innerHeight: height, requestAnimationFrame(fn) { const id=Symbol(); frames.set(id,fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); }, setTimeout(fn, delay) { timers.set(delay, fn); return delay; }, clearTimeout(delay) { timers.delete(delay); } });
  function frame() { const [id,fn] = frames.entries().next().value; frames.delete(id); fn(); }
  return { screen, logo, main, alreadyBlocked, body, events, timers, classes, document, chrome, frames, frame, appStyle };
}

test('launch blocks interaction only until the white layer finishes fading', () => {
  const page = launch();
  page.events.DOMContentLoaded();
  assert.equal(page.main.inert, true);
  assert.equal(page.classes.has('launch-active'), true);
  page.events.animationend({ target: page.screen, animationName: 'launch-white' });
  assert.equal(page.screen.isConnected, true);
  assert.equal(page.classes.has('launch-first-frame'),false);
  assert.equal(page.chrome.content,'#f5f7f6');
  page.events.animationend({ target: page.screen, animationName: 'launch-fade' });
  assert.equal(page.screen.isConnected, false);
  assert.equal(page.main.inert, false);
  assert.equal(page.alreadyBlocked.inert, true);
  assert.equal(page.body.busy, false);
  assert.equal(page.classes.has('launch-active'), false);
  assert.equal(page.timers.size, 0);
});

test('interrupted animation cannot trap users or re-block late page content', () => {
  const page = launch();
  page.timers.values().next().value();
  page.events.DOMContentLoaded();
  assert.equal(page.screen.isConnected, false);
  assert.equal(page.main.inert, false);
});

test('M zoom covers phone, landscape and desktop viewports before the white fade', () => {
  for (const [width, height] of [[390, 844], [844, 390], [1920, 1080]]) {
    const page = launch(width, height);
    assert.ok(page.logo.style['--launch-scale'] * 109.2 * .04 >= Math.hypot(width, height));
  }
  assert.match(html, /prefers-reduced-motion:reduce/);
});

test('exit protection waits until the zoom, white hold and fade have finished', () => {
  const page = launch();
  const [, duration, delay] = html.match(/launch-fade (\d+)ms (\d+)ms forwards/);
  assert.ok([...page.timers.keys()][0] > Number(duration) + Number(delay));
});

test('slow resource loading preserves the initial M until two visible frames after DOM readiness', () => {
  const page=launch();
  assert.equal(page.classes.has('launch-playing'), false);
  assert.ok([...page.timers.keys()][0] >= 10000);
  page.events.DOMContentLoaded();
  assert.equal(page.frames.size,1);
  page.frame();
  assert.equal(page.classes.has('launch-playing'), false);
  page.frame();
  assert.equal(page.classes.has('launch-playing'), true);
  assert.deepEqual([...page.timers.keys()],[2900]);
});

test('a hidden PWA cannot consume its launch animation before it becomes visible', () => {
  const page=launch();
  page.document.hidden=true;
  page.events.DOMContentLoaded();
  assert.equal(page.frames.size,0);
  page.document.hidden=false;
  page.events.visibilitychange();
  page.frame(); page.frame();
  assert.equal(page.classes.has('launch-playing'), true);
});

test('cleanup restores chrome to the current header theme and cancels pending paint work', () => {
  const page=launch();
  page.events.DOMContentLoaded();
  page.document.documentElement.dataset.theme='dark';
  page.timers.values().next().value();
  assert.equal(page.frames.size,0);
  assert.equal(page.chrome.content,'#15231e');
});

test('late main CSS holds M even when the remaining page scripts are ready', () => {
  const page=launch();
  page.appStyle.media='print';
  page.events.DOMContentLoaded();
  assert.equal(page.frames.size,0);
  page.appStyle.media='all';
  page.events['app-style-ready']();
  page.frame(); page.frame();
  assert.equal(page.classes.has('launch-playing'),true);
});

test('background loading pauses the pre-paint exit deadline until the app returns', () => {
  const page=launch();
  page.document.hidden=true;
  page.events.visibilitychange();
  assert.equal(page.timers.size,0);
  page.document.hidden=false;
  page.events.visibilitychange();
  assert.deepEqual([...page.timers.keys()],[10000]);
});
