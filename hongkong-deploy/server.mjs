import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import worker from './worker.mjs';

const hosts = new Set(['example.com', 'www.example.com', '127.0.0.1', 'localhost']);

export function createSiteServer(env) {
  return createServer(async (request, response) => {
    try {
      const scheme = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      if (!request.url.startsWith('/') || request.url.startsWith('//')) {
        response.writeHead(400).end('Invalid request');
        return;
      }
      const url = new URL(request.url, `${scheme}://${request.headers.host}`);
      if (!hosts.has(url.hostname)) {
        response.writeHead(400).end('Invalid host');
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const result = await worker.fetch(new Request(url, { method: request.method, headers }), env);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (request.method === 'HEAD' || !result.body) {
        await result.body?.cancel();
        response.end();
      } else {
        await pipeline(Readable.fromWeb(result.body), response);
      }
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(500).end('Server error');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Forwarded headers are trusted only behind Nginx on the same machine.
  createSiteServer(process.env).listen(8080, '127.0.0.1', () => {
    console.log('way1024 website listening on 127.0.0.1:8080');
  });
}
