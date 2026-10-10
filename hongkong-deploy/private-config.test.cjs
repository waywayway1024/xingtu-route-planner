const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingtu-private-config-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.copyFileSync(path.join(__dirname, 'prepare-private.cjs'), path.join(root, 'prepare-private.cjs'));
  fs.mkdirSync(path.join(root, 'out'));
  for (const name of ['site-assets.mjs', 'worker.mjs', 'server.mjs']) {
    fs.writeFileSync(path.join(root, 'out', name), '// public file\n');
  }
  return { root, run(config) {
    const input = path.join(root, 'amap.private.json');
    fs.writeFileSync(input, JSON.stringify(config));
    return spawnSync(process.execPath, [path.join(root, 'prepare-private.cjs'), input], { encoding: 'utf8' });
  } };
}

test('download template has no credentials and private config rejects missing or empty values', t => {
  const { root, run } = setup(t);
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, 'amap.example.json'), 'utf8'));
  assert.deepEqual(template, { AMAP_JS_KEY: '', AMAP_SECURITY_CODE: '' });
  for (const config of [template, { AMAP_JS_KEY: 'own-key' }, { AMAP_JS_KEY: 'own-key', AMAP_SECURITY_CODE: '' }, { AMAP_JS_KEY: '', AMAP_SECURITY_CODE: 'own-code' }]) {
    assert.notEqual(run(config).status, 0);
    assert.equal(fs.existsSync(path.join(root, 'amap.private.env')), false);
  }
});

test('own credentials are written separately and an existing private file is never overwritten', t => {
  const { root, run } = setup(t);
  const config = { AMAP_JS_KEY: 'own-key', AMAP_SECURITY_CODE: 'own-code' };
  assert.equal(run(config).status, 0);
  const envPath = path.join(root, 'amap.private.env');
  const expected = 'AMAP_JS_KEY="own-key"\nAMAP_SECURITY_CODE="own-code"\n';
  assert.equal(fs.readFileSync(envPath, 'utf8'), expected);
  assert.notEqual(run({ AMAP_JS_KEY: 'other-key', AMAP_SECURITY_CODE: 'other-code' }).status, 0);
  assert.equal(fs.readFileSync(envPath, 'utf8'), expected);
  for (const name of ['site-assets.mjs', 'worker.mjs', 'server.mjs']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'out', name), 'utf8'), /own-key|own-code/);
  }
});

test('private config refuses either credential embedded in public deployment files', t => {
  const { root, run } = setup(t);
  for (const value of ['own-key', 'own-code']) {
    fs.writeFileSync(path.join(root, 'out', 'site-assets.mjs'), value);
    assert.notEqual(run({ AMAP_JS_KEY: 'own-key', AMAP_SECURITY_CODE: 'own-code' }).status, 0);
    assert.equal(fs.existsSync(path.join(root, 'amap.private.env')), false);
  }
});
