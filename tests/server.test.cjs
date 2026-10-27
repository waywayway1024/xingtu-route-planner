const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');

test('an invalid request URL returns 400 and the local server keeps serving pages', { timeout: 7000 }, async t => {
  const child = spawn(process.execPath, [path.join(__dirname, '../server.cjs')], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const [output] = await once(child.stdout, 'data');
  const port = String(output).match(/localhost:(\d+)/)?.[1];
  assert.ok(port, errors);
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(data)); socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 400 /, errors);
  assert.equal((await fetch('http://127.0.0.1:' + port)).status, 200);
  assert.equal(child.exitCode, null);
});
