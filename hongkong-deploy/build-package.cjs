const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const source = path.resolve(process.argv[2]);
const root = __dirname;
const stage = path.join(root, 'stage');
const output = path.join(root, 'out');
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(output, { recursive: true });
const names = ['index.html', 'styles.css', 'app.js', 'i18n.js', 'live-location.js', 'route-optimizer.js', 'worker.mjs', 'build-site.cjs'];
const hashes = {};
for (const name of names) {
  const bytes = fs.readFileSync(path.join(source, name));
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(stage, name), bytes);
}
fs.writeFileSync(path.join(stage, 'config.js'), 'window.NAV_CONFIG = {};\n');
const build = spawnSync(process.execPath, ['build-site.cjs'], { cwd: stage, encoding: 'utf8' });
if (build.status !== 0) throw new Error(build.stderr || 'Website build failed');
fs.copyFileSync(path.join(stage, 'dist/server/site-assets.mjs'), path.join(output, 'site-assets.mjs'));
fs.copyFileSync(path.join(stage, 'dist/server/index.js'), path.join(output, 'worker.mjs'));
const packageFiles = ['server.mjs', 'worker.mjs', 'site-assets.mjs', 'install.sh', 'way1024.nginx', 'way1024.service'];
for (const name of ['server.mjs', 'install.sh', 'way1024.nginx', 'way1024.service']) {
  fs.copyFileSync(path.join(root, name), path.join(output, name));
}
const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(root, 'out/source-manifest.json'), JSON.stringify({ version, hashes }, null, 2) + '\n');
const archive = spawnSync('tar', ['-czf', path.join(root, 'way1024-hk.tar.gz'), '-C', output, ...packageFiles], { encoding: 'utf8' });
if (archive.status !== 0) throw new Error(archive.stderr || 'Archive failed');
console.log(`Website ${version}: deployment package ready, ${packageFiles.length} files, no credentials included.`);
