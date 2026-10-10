const fs = require('node:fs');
const path = require('node:path');
const secrets = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const name of ['AMAP_JS_KEY', 'AMAP_SECURITY_CODE']) {
  if (typeof secrets[name] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(secrets[name])) {
    throw new Error(`Invalid value for ${name}`);
  }
}
const publicFiles = ['site-assets.mjs', 'worker.mjs', 'server.mjs'];
for (const file of publicFiles) {
  const content = fs.readFileSync(path.join(__dirname, 'out', file), 'utf8');
  if (['AMAP_JS_KEY', 'AMAP_SECURITY_CODE'].some(name => content.includes(secrets[name]))) {
    throw new Error('Map credentials found in deployment files');
  }
}
const content = ['AMAP_JS_KEY', 'AMAP_SECURITY_CODE'].map(name => `${name}=${JSON.stringify(secrets[name])}`).join('\n') + '\n';
fs.writeFileSync(path.join(__dirname, 'amap.private.env'), content, { mode: 0o600, flag: 'wx' });
console.log('Private server configuration prepared separately; public files contain no credentials.');
