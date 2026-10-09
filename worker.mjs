// Sites / Cloudflare Workers entry point. Assets are embedded during build.
import { assets } from './site-assets.mjs';

const permittedPaths = new Set([
  '/v3/place/text', '/v3/place/detail', '/v3/place/around', '/v3/assistant/inputtips',
  '/v3/direction/driving', '/v3/direction/walking', '/v3/direction/transit/integrated',
  '/v3/geocode/geo', '/v3/geocode/regeo', '/v3/ip', '/v3/config/district', '/v3/assistant/coordinate/convert',
  '/v4/direction/bicycling', '/v4/geolocation/ip', '/v5/direction/driving',
  '/v5/direction/walking', '/v5/direction/bicycling', '/v5/direction/transit/integrated',
]);
const responseHeaders = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/site-config.js') {
      const ready = Boolean(env.AMAP_JS_KEY && env.AMAP_SECURITY_CODE);
      const config = ready ? { key: env.AMAP_JS_KEY, serviceHost: url.origin + '/_AMapService', managed: true } : {};
      return new Response('Object.assign(window.NAV_CONFIG, ' + JSON.stringify(config) + ');', { headers: { ...responseHeaders, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (url.pathname.startsWith('/_AMapService/')) {
      if (!env.AMAP_JS_KEY || !env.AMAP_SECURITY_CODE) return new Response('Map service not configured', { status: 503 });
      const origin = request.headers.get('Origin');
      const referer = request.headers.get('Referer');
      let refererOrigin;
      try { refererOrigin = referer ? new URL(referer).origin : null; } catch { refererOrigin = null; }
      if ((origin && origin !== url.origin) || (!origin && refererOrigin !== url.origin)) return new Response('Forbidden', { status: 403 });
      const upstreamPath = url.pathname.slice('/_AMapService'.length);
      const style = upstreamPath === '/v4/map/styles';
      if (!style && !permittedPaths.has(upstreamPath)) return new Response('Not found', { status: 404 });
      const upstream = new URL(upstreamPath, style ? 'https://webapi.amap.com' : 'https://restapi.amap.com');
      upstream.search = url.search;
      upstream.searchParams.set('key', env.AMAP_JS_KEY);
      upstream.searchParams.set('jscode', env.AMAP_SECURITY_CODE);
      try {
        const result = await fetch(upstream, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
        if (result.status >= 300 && result.status < 400) {
          await result.body?.cancel();
          throw new Error('Map service redirected');
        }
        // The SDK loads JSONP as a script. AMap can label it application/json,
        // which browsers correctly block when this proxy sends nosniff.
        const callback = url.searchParams.get('callback');
        const contentType = callback && /^[\w$.]+$/.test(callback) ? 'text/javascript; charset=utf-8' : result.headers.get('Content-Type') || 'application/json';
        return new Response(request.method === 'HEAD' ? null : result.body, { status: result.status, headers: { ...responseHeaders, 'Content-Type': contentType, 'Cache-Control': 'no-store' } });
      } catch (error) {
        let message = String(error?.message || error);
        // Keep credentials and requested coordinates out of diagnostic messages.
        for (const value of [upstream.href, ...upstream.searchParams.values()]) {
          if (value) message = message.split(value).join('[redacted]').split(encodeURIComponent(value)).join('[redacted]');
        }
        console.error('AMap proxy failed', { path: upstreamPath, message: message.slice(0, 300), timeoutAvailable: typeof AbortSignal.timeout === 'function' });
        return new Response('Map service temporarily unavailable', { status: 502 });
      }
    }
    const asset = assets[url.pathname === '/' ? '/index.html' : url.pathname];
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : asset.content, { headers: { ...responseHeaders, 'Content-Type': asset.type, 'Cache-Control': 'no-cache' } });
  },
};
