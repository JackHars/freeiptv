import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from './api/platform.mjs';
import { handleIPTV } from './api/iptv.mjs';

const root = new URL('./public/', import.meta.url);
const routes = new Set(['api', 'docs', 'health', 'servers', 'search', 'browse', 'title', 'episodes', 'images', 'resolve', 'master', 'watch', 'proxy']);
const retiredBridgeBases = new Set(['http://127.0.0.1:18090', 'http://localhost:18090']);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/iptv', ['iptv.html', 'text/html; charset=utf-8']],
  ['/iptv/', ['iptv.html', 'text/html; charset=utf-8']],
  ['/iptv.js', ['iptv.js', 'text/javascript; charset=utf-8']],
  ['/vendor/hls.min.js', ['../node_modules/hls.js/dist/hls.min.js', 'text/javascript; charset=utf-8']],
]);

export function normalizeBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Enter an HTTP or HTTPS API address without credentials, query parameters, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function relayUrl(route, params, base) {
  const query = new URLSearchParams(params);
  query.set('__base', base);
  return `/relay/${route}?${query}`;
}

export function rewritePlaylist(text, source, base) {
  const prefix = new URL(`${base}/`);
  const rewrite = (uri) => {
    if (!uri || /^(data:|skd:)/i.test(uri)) return uri;
    const absolute = new URL(uri, source);
    const relativePath = absolute.pathname.startsWith(prefix.pathname) ? absolute.pathname.slice(prefix.pathname.length) : '';
    if (absolute.origin === prefix.origin && routes.has(relativePath)) {
      return relayUrl(relativePath, absolute.searchParams, base);
    }
    return relayUrl('proxy', { u: absolute.href }, base);
  };
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`);
    return rewrite(line.trim());
  }).join('\n');
}

function json(res, status, data) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const request = new URL(req.url, 'http://cinejoy.local');
      if (await handleIPTV(req, res)) return;
      if (request.pathname === '/config' && req.method === 'GET') return json(res, 200, { mode: 'embedded', base: '/' });
      if (routes.has(request.pathname.slice(1))) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range' });
          return res.end();
        }
        return await handleApiRequest(req, res);
      }
      if (request.pathname.startsWith('/relay/')) {
        const route = request.pathname.slice(7);
        if (!routes.has(route)) return json(res, 404, { error: 'Unknown API endpoint.' });
        if (req.method !== 'GET' && !(req.method === 'POST' && route === 'resolve')) return json(res, 405, { error: 'Method not allowed.' });
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-origin relay requests are not allowed.' });
        let base;
        const requestedBase = request.searchParams.get('__base');
        try { base = requestedBase ? normalizeBase(requestedBase) : null; }
        catch (err) { return json(res, 400, { error: err.message }); }
        request.searchParams.delete('__base');
        // Keep already-open tabs working after retiring the old Docker bridge.
        if (!base || retiredBridgeBases.has(base) || new URL(base).host === req.headers.host) {
          req.url = `/${route}${request.searchParams.size ? `?${request.searchParams}` : ''}`;
          return await handleApiRequest(req, res);
        }
        const upstream = new URL(`${base}/${route}`);
        upstream.search = request.searchParams.toString();
        const headers = { Accept: req.headers.accept || '*/*' };
        if (req.headers.range) headers.Range = req.headers.range;
        let body;
        if (req.method === 'POST') {
          const chunks = [];
          let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > 16384) return json(res, 413, { error: 'Request body exceeds 16 KB.' });
            chunks.push(chunk);
          }
          body = Buffer.concat(chunks);
          try { JSON.parse(body); } catch { return json(res, 400, { error: 'Body must be valid JSON.' }); }
          headers['Content-Type'] = 'application/json';
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90000);
        res.on('close', () => controller.abort());
        try {
          const response = await fetch(upstream, { method: req.method, headers, body, signal: controller.signal });
          const contentType = response.headers.get('content-type') || 'application/octet-stream';
          const playlist = response.ok && (/mpegurl/i.test(contentType) || ['master', 'watch'].includes(route) || (route === 'proxy' && /\.m3u8(?:\?|$)/i.test(upstream.searchParams.get('u') || '')));
          const outHeaders = { 'Content-Type': playlist ? 'application/vnd.apple.mpegurl' : contentType, 'Cache-Control': 'no-store' };
          for (const key of ['content-range', 'accept-ranges']) if (response.headers.has(key)) outHeaders[key] = response.headers.get(key);
          if (playlist) {
            const content = rewritePlaylist(await response.text(), response.url, base);
            res.writeHead(response.status, outHeaders);
            res.end(content);
          } else {
            res.writeHead(response.status, outHeaders);
            if (response.body) await pipeline(Readable.fromWeb(response.body), res);
            else res.end();
          }
        } catch (err) {
          if (!res.headersSent) json(res, 502, { error: `Cannot reach ${base}. ${err.name === 'AbortError' ? 'Request timed out.' : (err.cause?.message || err.message)} Check that Cinejoy is running and the API address is correct.` });
          else res.destroy();
        } finally { clearTimeout(timer); }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
      const asset = assets.get(request.pathname);
      if (!asset) return json(res, 404, { error: 'Not found.' });
      const data = await readFile(new URL(asset[0], root));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.destroy();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  import('./start.mjs').catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
