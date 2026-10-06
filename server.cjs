// Zero-dependency local static server. Only serves the listed public files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/config.js': ['config.js', 'text/javascript'] };
const server = http.createServer((req, res) => {
  const entry = files[new URL(req.url, 'http://localhost').pathname];
  if (!entry) { res.writeHead(404); res.end('Not found'); return; }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  fs.readFile(path.join(__dirname, entry[0]), (error, data) => {
    if (error) { res.writeHead(500); res.end('Cannot read file'); return; }
    res.writeHead(200, { 'Content-Type': entry[1] + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});
files['/route-optimizer.js'] = ['route-optimizer.js', 'text/javascript'];
server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? 'Port 8080 is busy. Set PORT to another port.' : error.message); process.exitCode = 1; });
server.listen(Number(process.env.PORT || 8080), '127.0.0.1', () => console.log('行途已启动：http://localhost:' + server.address().port + '\n按 Ctrl+C 停止服务。'));
