// Zero-dependency local static server. Only serves the listed public files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { files: publicFiles, createAssets } = require('./public-assets.cjs');
const files = Object.fromEntries(Object.entries(publicFiles).map(([name, type]) => ['/' + name, [name, type]]));
files['/'] = files['/index.html'];
files['/app-version.json'] = ['app-version.json', 'application/json'];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const entry = files[pathname];
  if (!entry) { res.writeHead(404); res.end('Not found'); return; }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  if (['/', '/index.html', '/app-version.json'].includes(pathname)) {
    try {
      const asset = createAssets()[pathname === '/' ? '/index.html' : pathname];
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : asset.content);
    } catch { res.writeHead(500); res.end('Cannot read file'); }
    return;
  }
  fs.readFile(path.join(__dirname, entry[0]), (error, data) => {
    if (error) { res.writeHead(500); res.end('Cannot read file'); return; }
    res.writeHead(200, { 'Content-Type': entry[1] === 'image/png' ? entry[1] : entry[1] + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});
server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? 'Port 8080 is busy. Set PORT to another port.' : error.message); process.exitCode = 1; });
server.listen(Number(process.env.PORT || 8080), '127.0.0.1', () => console.log('manmanhang已启动：http://localhost:' + server.address().port + '\n按 Ctrl+C 停止服务。'));
