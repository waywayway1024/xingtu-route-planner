const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const output = path.join(root, 'dist', 'server');
fs.mkdirSync(output, { recursive: true });
const files = { 'index.html': 'text/html', 'styles.css': 'text/css', 'app.js': 'text/javascript', 'i18n.js': 'text/javascript', 'route-optimizer.js': 'text/javascript', 'config.js': 'text/javascript' };
const assets = {};
for (const [name, type] of Object.entries(files)) {
  let content = fs.readFileSync(path.join(root, name), 'utf8');
  // Inject only into the hosted build; local testing keeps its existing configuration.
  if (name === 'index.html') content = content.replace('<script src="config.js" defer></script>', '<script src="config.js" defer></script>\n  <script src="/site-config.js" defer></script>');
  if (name === 'config.js') content = "window.NAV_CONFIG = { key: '', securityJsCode: '', serviceHost: '', defaultCity: '北京', center: [116.397428, 39.90923] };\n";
  assets['/' + name] = { content, type: type + '; charset=utf-8' };
}
fs.writeFileSync(path.join(output, 'site-assets.mjs'), 'export const assets = ' + JSON.stringify(assets) + ';\n');
fs.copyFileSync(path.join(root, 'worker.mjs'), path.join(output, 'index.js'));
console.log('Sites Worker build ready.');
