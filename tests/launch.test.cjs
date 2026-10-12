const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const source = html.match(/<script id="launch-script">([\s\S]*?)<\/script>/)[1];

function launch(width = 390, height = 844) {
  const events = {}, timers = new Map();
  const screen = { isConnected: true, remove() { this.isConnected = false; }, addEventListener(type, fn) { events[type] = fn; } };
  const logo = { getBoundingClientRect: () => ({ width: 109.2 }), style: { setProperty(name, value) { this[name] = value; } } };
  const main = { tagName: 'MAIN', inert: false }, alreadyBlocked = { tagName: 'SECTION', inert: true };
  const body = { children: [screen, main, alreadyBlocked], setAttribute() { this.busy = true; }, removeAttribute() { this.busy = false; } };
  const classes = new Set();
  const document = { body, documentElement: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } }, getElementById: id => id === 'launch-screen' ? screen : logo, addEventListener(type, fn) { events[type] = fn; } };
  vm.runInNewContext(source, { document, innerWidth: width, innerHeight: height, setTimeout(fn, delay) { timers.set(delay, fn); return delay; }, clearTimeout(delay) { timers.delete(delay); } });
  return { screen, logo, main, alreadyBlocked, body, events, timers, classes };
}

test('launch blocks interaction only until the white layer finishes fading', () => {
  const page = launch();
  page.events.DOMContentLoaded();
  assert.equal(page.main.inert, true);
  assert.equal(page.classes.has('launch-active'), true);
  page.events.animationend({ target: page.screen, animationName: 'launch-white' });
  assert.equal(page.screen.isConnected, true);
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
