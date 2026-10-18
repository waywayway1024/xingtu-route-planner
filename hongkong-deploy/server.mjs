import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
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
      const textAsset = result.status === 200 && !url.pathname.startsWith('/_AMapService/') && url.pathname !== '/site-config.js' && /^text\/(html|css|javascript)\b/.test(result.headers.get('Content-Type') || '');
      if (textAsset) result.headers.append('Vary', 'Accept-Encoding');
      const gzip = textAsset && (request.headers['accept-encoding'] || '').split(',').some(value => {
        const [encoding, quality = '1'] = value.trim().toLowerCase().split(/\s*;\s*q=/);
        return encoding === 'gzip' && Number(quality) > 0 && Number(quality) <= 1;
      });
      if (gzip) { result.headers.set('Content-Encoding', 'gzip'); result.headers.delete('Content-Length'); }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (request.method === 'HEAD' || !result.body) {
        await result.body?.cancel();
        response.end();
      } else {
        const body = Readable.fromWeb(result.body);
        if (gzip) await pipeline(body, createGzip(), response);
        else await pipeline(body, response);
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
