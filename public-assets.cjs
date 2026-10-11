const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const files = { 'index.html': 'text/html', 'styles.css': 'text/css', 'app.js': 'text/javascript', 'i18n.js': 'text/javascript', 'live-location.js': 'text/javascript', 'route-optimizer.js': 'text/javascript', 'config.js': 'text/javascript', 'pwa.js': 'text/javascript', 'manifest.webmanifest': 'application/manifest+json', 'icon-192.png': 'image/png', 'icon-512.png': 'image/png' };

function createAssets(hosted = false) {
  const assets = {};
  for (const [name, type] of Object.entries(files)) {
    const binary = type === 'image/png';
    let content = fs.readFileSync(path.join(__dirname, name), binary ? 'base64' : 'utf8');
    if (hosted && name === 'index.html') content = content.replace('<script src="config.js" defer></script>', '<script src="config.js" defer></script>\n  <script src="/site-config.js" defer></script>');
    if (hosted && name === 'config.js') content = "window.NAV_CONFIG = { key: '', securityJsCode: '', serviceHost: '', defaultCity: '北京', center: [116.397428, 39.90923] };\n";
    assets['/' + name] = { content, type: binary ? type : type + '; charset=utf-8', ...(binary ? { binary: true } : {}) };
  }
  // The version follows shipped UI files, so publishing an edit needs no manual version bump.
  const version = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 16);
  assets['/index.html'].content = assets['/index.html'].content.replace('__APP_VERSION__', version);
  assets['/app-version.json'] = { content: JSON.stringify({ version }), type: 'application/json; charset=utf-8' };
  return assets;
}

module.exports = { files, createAssets };
