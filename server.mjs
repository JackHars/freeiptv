import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from './api/platform.mjs';
import { handleIPTV } from './api/iptv.mjs';

const routes = new Set(['api', 'health', 'servers', 'search', 'browse', 'title', 'episodes', 'images', 'resolve', 'master', 'watch', 'proxy']);

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
      if (await handleIPTV(req, res)) return;
      const request = new URL(req.url, 'http://local');
      if (routes.has(request.pathname.slice(1))) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range' });
          return res.end();
        }
        return await handleApiRequest(req, res);
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: error.message });
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
