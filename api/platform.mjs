// Cinejoy API, extracted from /workspace/platform/platform.mjs.
// Embedded by ../server.mjs; owns no listener or Docker connection.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://api.wing.st';
const RW = new TextEncoder();
const BW = new TextDecoder();
const LUMEN_TAG = 'lumen-gate-v2';
const G = 32, EPH = 65, OFF = G + 1 + EPH;

const TMDB_KEY = '8476a7ab80ad76f0936744df0430e67c';   // cinejoy's own frontend key
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p/';
const HDRS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'referer': 'https://cinejoy.pk/',
  'origin': 'https://cinejoy.pk',
};
const SERVER_ORDER = ['Nebula', 'Lisbon', 'Solara', 'Athens'];
const RESOLVE_TTL = 300 * 1000;
const TMDB_TTL = 120 * 1000;
const SERVERS_TTL = 60 * 1000;

// ---------------------------------------------------------------- lumen-gate

let wasmExports = null;
async function loadWasm() {
  if (wasmExports) return wasmExports;
  const cands = [
    path.join(__dir, 'crush.wasm'),
  ];
  let buf = null;
  for (const p of cands) {
    if (fs.existsSync(p)) { buf = fs.readFileSync(p); break; }
  }
  if (!buf) {
    const r = await fetch(BASE + '/crush.wasm', { headers: HDRS });
    if (!r.ok) throw new Error('WASM download HTTP ' + r.status);
    buf = Buffer.from(await r.arrayBuffer());
    try { fs.writeFileSync(cands[0], buf); } catch { /* keep in memory */ }
  }
  const { instance } = await WebAssembly.instantiate(new Uint8Array(buf), {});
  const ex = instance.exports;
  if (typeof ex.seal_request !== 'function' || typeof ex.alloc !== 'function')
    throw new Error('WASM ABI mismatch: missing seal_request/alloc exports');
  wasmExports = ex;
  wasmReady = true;
  return ex;
}

async function seal(reqPath, payload) {
  const a = await loadWasm();
  const C = RW.encode(JSON.stringify({ path: reqPath, payload: payload ?? null }));
  const nonce = new Uint8Array(44);
  crypto.getRandomValues(nonce);
  const cap = C.length + 512;
  const t = a.alloc(C.length), m = a.alloc(nonce.length), n = a.alloc(cap);
  const f = new Uint8Array(a.memory.buffer);
  f.set(C, t); f.set(nonce, m);
  const S = a.seal_request(t, C.length, m, nonce.length, n, cap);
  if (S < 0 || S > cap) throw new Error('seal failed: ' + S);
  const P = new Uint8Array(a.memory.buffer).slice(n, n + S);
  return {
    responseKey: P.slice(0, G),
    keyId: P[G],
    ephemeralPublic: P.slice(G + 1, OFF),
    body: P.slice(OFF),
  };
}

async function lumenGet(reqPath, params) {
  const qs = new URLSearchParams(params).toString();
  const full = reqPath + (qs ? '?' + qs : '');
  const out = await seal(full, null);
  const r = await fetch(BASE + '/g', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: out.body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`lumen-gate HTTP ${r.status}`);
  const respBytes = new Uint8Array(await r.arrayBuffer());
  if (respBytes.length < 12 + 16) throw new Error('response too short: ' + respBytes.length);
  const key = await crypto.subtle.importKey('raw', out.responseKey, 'AES-GCM', false, ['decrypt']);
  const iv = respBytes.subarray(0, 12);
  const ct = respBytes.subarray(12);
  const tag = RW.encode(LUMEN_TAG);
  const aad = new Uint8Array(tag.length + 3 + out.ephemeralPublic.length);
  aad.set(tag); aad.set([0, 2, out.keyId], tag.length);
  aad.set(out.ephemeralPublic, tag.length + 3);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct);
  const parsed = JSON.parse(BW.decode(plain));
  return { status: parsed.status, data: parsed.data };
}

// ---------------------------------------------------------------- helpers

class TtlCache {
  constructor(ttl, maxsize = 1024) { this.ttl = ttl; this.maxsize = maxsize; this.d = new Map(); }
  get(key) {
    const v = this.d.get(key);
    if (!v) return null;
    if (Date.now() - v.ts > this.ttl) { this.d.delete(key); return null; }
    return v.val;
  }
  set(key, val) {
    this.d.set(key, { ts: Date.now(), val });
    if (this.d.size > this.maxsize) {
      const oldest = [...this.d.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) this.d.delete(oldest[0]);
    }
  }
}
const tmdb_cache = new TtlCache(TMDB_TTL);
const resolve_cache = new TtlCache(RESOLVE_TTL);
const servers_cache = new TtlCache(SERVERS_TTL);

async function tmdb_get(pth, extra = {}) {
  const params = { api_key: TMDB_KEY, language: 'en-US', ...extra };
  const key = pth + '?' + new URLSearchParams(params).toString();
  const hit = tmdb_cache.get(key);
  if (hit) return hit;
  const r = await fetch(TMDB_BASE + pth + '?' + new URLSearchParams(params), {
    headers: { 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`TMDB HTTP ${r.status} for ${pth}`);
  const data = await r.json();
  tmdb_cache.set(key, data);
  return data;
}

const mapItem = (x, kind) => ({
  id: x.id,
  kind: x.media_type || kind,
  title: x.name || x.title || 'Untitled',
  year: (x.first_air_date || x.release_date || '').slice(0, 4),
  poster: x.poster_path || null,
  backdrop: x.backdrop_path || null,
  vote: x.vote_average ?? null,
  overview: (x.overview || '').slice(0, 200),
});

const fetchUpstream = (u, timeoutMs = 90_000, options = {}) =>
  fetch(u, { ...options, headers: { ...HDRS, ...options.headers }, signal: options.signal || AbortSignal.timeout(timeoutMs) });

const absUrl = (rel, base) =>
  (rel.startsWith('http') ? new URL(rel) : new URL(rel, base)).href;

function rewritePlaylist(text, baseUrl, prefix = '/proxy') {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { out.push(''); continue; }
    if (line.startsWith('#')) {
      out.push(line.replace(/URI="([^"]+)"/g, (_, u) =>
        'URI="' + prefix + '?u=' + encodeURIComponent(absUrl(u, baseUrl)) + '"'));
    } else {
      out.push(prefix + '?u=' + encodeURIComponent(absUrl(line, baseUrl)));
    }
  }
  return out.join('\n') + '\n';
}

function parseVariants(master, baseUrl) {
  const out = [];
  for (const m of master.matchAll(/#EXT-X-STREAM-INF:([^\n]+)\n(\S+)/g)) {
    const [, attrs, uri] = m;
    const res = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
    const bw = attrs.match(/BANDWIDTH=(\d+)/);
    out.push({
      resolution: res ? `${res[1]}x${res[2]}` : '?',
      width: res ? +res[1] : 0,
      bandwidth: bw ? +bw[1] : 0,
      media: absUrl(uri, baseUrl),
    });
  }
  out.sort((a, b) => (b.width - a.width) || (b.bandwidth - a.bandwidth));
  return out;
}

function pickVariant(variants, v) {
  const good = variants.filter((x) => x.media);
  if (!good.length) return null;
  if (v === 'best' || v === '') return good[0].media;
  const t = v.replace(/p$/, '');
  if (!/^\d+$/.test(t)) return good[0].media;
  const target = +t;
  const exact = good.filter((x) => x.width === target);
  if (exact.length) return exact.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a)).media;
  const lower = good.filter((x) => x.width > 0 && x.width <= target);
  if (lower.length) return lower.reduce((a, b) => (b.width > a.width ? b : a)).media;
  return good[0].media;
}

async function getServers() {
  const hit = servers_cache.get('servers');
  if (hit) return hit;
  const r = await fetch(BASE + '/servers', { headers: HDRS, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error('servers HTTP ' + r.status);
  const servers = (await r.json()).servers || [];
  servers_cache.set('servers', servers);
  return servers;
}

// ---------------------------------------------------------------- resolve

class ResolutionError extends Error {
  constructor(status, msg) { super(msg); this.status = status; this.msg = msg; }
}

async function resolve(tmdbId, kind, season = null, episode = null, server = null, fresh = false) {
  const key = [kind, tmdbId, season, episode, server || 'auto'].join('|');
  if (!fresh) {
    const hit = resolve_cache.get(key);
    if (hit) return { ...hit, cached: true };
  }
  if (!/^\d+$/.test(String(tmdbId))) throw new Error('tmdb must be numeric');
  const params = { tmdb: String(tmdbId) };
  if (kind === 'series') {
    if (season == null || episode == null) throw new Error('series requires s and e');
    params.season = String(season);
    params.episode = String(episode);
  }

  const order = server ? [server] : [...SERVER_ORDER];
  const errors = {};
  const tried = [];
  let data = null, used = null;
  for (const srv of order) {
    tried.push(srv);
    try {
      const out = await lumenGet(`/${srv}/${kind}`, params);
      if (out.status === 200) { data = out.data; used = srv; break; }
      throw new Error('lumen-gate error ' + out.status + ': ' +
        (typeof out.data === 'string' ? out.data : JSON.stringify(out.data)));
    } catch (e) {
      errors[srv] = e.message;
    }
  }
  if (data == null) {
    const detail = Object.entries(errors).map(([k, v]) =>
      `${k}: ${String(v).split('\n')[0]}`).join('; ');
    const markers = ['not carried', 'empty mirror', 'no playable stream', 'not found'];
    const unavailable = Object.keys(errors).filter((k) => markers.some((m) => errors[k].includes(m)));
    if (unavailable.length) {
      const missing = Object.keys(errors).filter((k) => !unavailable.includes(k));
      const note = missing.length ? ` (${missing.join(', ')} did not confirm)` : '';
      throw new ResolutionError(404, `title ${tmdbId} not carried${note}: ${detail}`);
    }
    throw new ResolutionError(502, `all servers failed: ${detail}`);
  }

  const streams = data.stream || [];
  const master = (streams.find((s) => s.type === 'hls' && s.playlist) || {}).playlist;
  if (!master) throw new ResolutionError(502, 'no hls stream in response: ' + JSON.stringify(data));

  let variants = [];
  try {
    const r = await fetchUpstream(master, 30_000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    variants = parseVariants(await r.text(), master);
  } catch (e) { variants = [{ error: String(e).slice(0, 200) }]; }

  const out = {
    tmdb: +tmdbId, kind,
    season: season == null ? null : +season,
    episode: episode == null ? null : +episode,
    server: used, tried, server_errors: errors,
    master,
    master_proxied: '/proxy?u=' + encodeURIComponent(master),
    streams: streams.map(({ playlist, ...rest }) => ({ ...rest, playlist: playlist || '' })),
    variants, cached: false,
  };
  resolve_cache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- http

const START = Date.now();
let wasmReady = false;

function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': b.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(b);
}
const sendErr = (res, code, msg) => sendJson(res, code, { error: msg });
const sendM3u8 = (res, text) => {
  const b = Buffer.from(text);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Content-Length': b.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(b);
};

function readBody(req, limit = 1 << 20) {
  return new Promise((ok, err) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { err(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', err);
  });
}

export async function handleApiRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const q = (name, dflt = '') => url.searchParams.get(name) ?? dflt;

  if (req.method === 'POST' && p === '/resolve') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const kind = String(body.kind || 'movie').toLowerCase();
      const out = await resolve(body.tmdb, kind,
        body.s ?? body.season ?? null, body.e ?? body.episode ?? null,
        body.server || null, !!body.fresh);
      return sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof ResolutionError) return sendErr(res, e.status, e.msg);
      if (e instanceof SyntaxError) return sendErr(res, 400, 'invalid JSON body');
      if (/numeric|required/.test(e.message)) return sendErr(res, 400, e.message);
      return sendErr(res, 500, e.constructor.name + ': ' + e.message);
    }
  }

  if (req.method !== 'GET') return sendErr(res, 405, 'method not allowed');

  try {
    if (p === '/api') return sendJson(res, 200, {
      name: 'Cinejoy Platform API', version: '1',
      endpoints: ['/servers', '/search', '/browse', '/title', '/episodes',
                  '/images', '/resolve', '/master', '/watch', '/proxy', '/health'],
    });

    if (p === '/health') return sendJson(res, 200, {
      ok: true, wasm: wasmReady,
      uptime_s: Math.floor((Date.now() - START) / 1000),
      cached_resolves: 'yes',
    });

    if (p === '/servers') return sendJson(res, 200, { servers: await getServers() });

    if (p === '/search') {
      const query = q('q') || q('query');
      if (!query.trim()) return sendErr(res, 400, 'q (search query) is required');
      const page = Math.max(1, +q('page', '1') || 1);
      const data = await tmdb_get('/search/multi', { query: query.trim(), page });
      const items = (data.results || [])
        .filter((x) => ['tv', 'movie'].includes(x.media_type))
        .map((x) => mapItem(x, x.media_type || 'movie'));
      return sendJson(res, 200, { items, page, pages: data.total_pages || 1, total: data.total_results || 0 });
    }

    if (p === '/browse') {
      const board = q('board', 'trending');
      const kind = ['tv', 'series'].includes(q('type', 'tv')) ? 'tv' : 'movie';
      const page = Math.max(1, +q('page', '1') || 1);
      const boards = {
        trending: `/trending/${kind}/day`,
        popular: `/${kind}/popular`,
        top_rated: `/${kind}/top_rated`,
        now_playing: '/movie/now_playing',
        on_the_air: '/tv/on_the_air',
      };
      const bp = boards[board];
      if (!bp) return sendErr(res, 400, `unknown board '${board}' (use: ${Object.keys(boards).join(', ')})`);
      const data = await tmdb_get(bp, { page });
      const items = (data.results || []).map((x) => mapItem(x, kind));
      return sendJson(res, 200, { items, page, pages: data.total_pages || 1, total: data.total_results || 0 });
    }

    if (p === '/title') {
      const tmdbId = q('tmdb');
      if (!/^\d+$/.test(tmdbId)) return sendErr(res, 400, 'tmdb must be numeric');
      const kind = ['tv', 'series'].includes(q('type', 'tv')) ? 'tv' : 'movie';
      const data = await tmdb_get(`/${kind}/${tmdbId}`,
        kind === 'tv' ? { 'append_to_response': 'credits' } : { 'append_to_response': 'credits' });
      const cast = ((data.credits || {}).cast || []).slice(0, 12)
        .map((c) => ({ name: c.name, character: c.character }));
      if (kind === 'tv') return sendJson(res, 200, {
        tmdb: +tmdbId, kind: 'tv',
        title: data.name, year: (data.first_air_date || '').slice(0, 4),
        overview: data.overview, vote: data.vote_average,
        status: data.status, adult: !!data.adult,
        poster: data.poster_path || null,
        cast,
        seasons: (data.seasons || []).map((s) => ({
          season: s.season_number, name: s.name || '',
          episodes: s.episode_count || 0 })),
      });
      return sendJson(res, 200, {
        tmdb: +tmdbId, kind: 'movie',
        title: data.title, year: (data.release_date || '').slice(0, 4),
        overview: data.overview, vote: data.vote_average,
        adult: !!data.adult, poster: data.poster_path || null, cast,
      });
    }

    if (p === '/episodes') {
      const tmdbId = q('tmdb');
      const sn = q('season') || q('s') || '1';
      if (!/^\d+$/.test(tmdbId) || !/^\d+$/.test(sn))
        return sendErr(res, 400, 'tmdb and season must be numeric');
      const data = await tmdb_get(`/tv/${tmdbId}/season/${sn}`);
      const eps = (data.episodes || []).map((e) => ({
        season: +sn, episode: e.episode_number, name: e.name,
        air_date: e.air_date, vote: e.vote_average ?? null,
        overview: (e.overview || '').slice(0, 300),
      }));
      return sendJson(res, 200, { tmdb: +tmdbId, season: +sn, episodes: eps });
    }

    if (p === '/images') {
      const tmdbId = q('tmdb');
      if (!/^\d+$/.test(tmdbId)) return sendErr(res, 400, 'tmdb must be numeric');
      const kind = ['tv', 'series'].includes(q('type', 'tv')) ? 'tv' : 'movie';
      const data = await tmdb_get(`/${kind}/${tmdbId}/images`);
      const backdrops = (data.backdrops || []).filter((b) => b.file_path);
      const posters = (data.posters || []).filter((b) => b.file_path);
      return sendJson(res, 200, {
        backdrops: backdrops.slice(0, 5).map((b) => IMG_BASE + 'original' + b.file_path),
        backdrop: backdrops.length ? IMG_BASE + 'w1280' + backdrops[0].file_path : null,
        poster: posters.length ? IMG_BASE + 'original' + posters[0].file_path : null,
      });
    }

    if (p === '/resolve') {
      const tmdbId = q('tmdb');
      if (!/^\d+$/.test(tmdbId)) return sendErr(res, 400, 'tmdb must be numeric');
      let kind = q('kind', 'movie').toLowerCase();
      if (!['movie', 'series', 'tv'].includes(kind))
        return sendErr(res, 400, 'kind must be movie or series');
      if (kind === 'tv') kind = 'series';
      const s = url.searchParams.get('s') ?? url.searchParams.get('season');
      const e = url.searchParams.get('e') ?? url.searchParams.get('episode');
      const out = await resolve(tmdbId, kind,
        s == null ? null : +s, e == null ? null : +e,
        url.searchParams.get('server'),
        ['1', 'true'].includes(q('fresh', '0')));
      return sendJson(res, 200, out);
    }

    if (p === '/master') {
      const tmdbId = q('tmdb');
      if (!/^\d+$/.test(tmdbId)) return sendErr(res, 400, 'tmdb must be numeric');
      let kind = q('kind', 'movie').toLowerCase();
      if (!['movie', 'series', 'tv'].includes(kind))
        return sendErr(res, 400, 'kind must be movie or series');
      if (kind === 'tv') kind = 'series';
      const s = url.searchParams.get('s') ?? url.searchParams.get('season');
      const e = url.searchParams.get('e') ?? url.searchParams.get('episode');
      const r = await resolve(tmdbId, kind,
        s == null ? null : +s, e == null ? null : +e,
        url.searchParams.get('server'));
      const good = (r.variants || []).filter((v) => v.media);
      if (!good.length)
        return sendErr(res, 502, 'no playable variant: ' +
          JSON.stringify(r.variants).slice(0, 300));
      let m3u = '#EXTM3U\n#EXT-X-VERSION:4\n';
      for (const v of good) {
        const label = v.width >= 3840 ? '4K' : (v.width || 0) + 'p';
        m3u += `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth || 1000000},RESOLUTION=${v.resolution !== '?' ? v.resolution : '1920x1080'},NAME="${label}"\n`;
        m3u += '/proxy?u=' + encodeURIComponent(v.media) + '\n';
      }
      return sendM3u8(res, m3u);
    }

    if (p === '/watch') {
      const tmdbId = q('tmdb');
      if (!/^\d+$/.test(tmdbId)) return sendErr(res, 400, 'tmdb must be numeric');
      let kind = q('kind', 'movie').toLowerCase();
      if (!['movie', 'series', 'tv'].includes(kind))
        return sendErr(res, 400, 'kind must be movie or series');
      if (kind === 'tv') kind = 'series';
      const s = url.searchParams.get('s') ?? url.searchParams.get('season');
      const e = url.searchParams.get('e') ?? url.searchParams.get('episode');
      const r = await resolve(tmdbId, kind,
        s == null ? null : +s, e == null ? null : +e,
        url.searchParams.get('server'));
      const v = q('v', 'best');
      const media = pickVariant(r.variants || [], v);
      if (!media) return sendErr(res, 502, 'no playable variant (asked for ' + v + ')');
      const r2 = await fetchUpstream(media, 30_000);
      if (!r2.ok) return sendErr(res, 502, 'variant fetch HTTP ' + r2.status);
      return sendM3u8(res, rewritePlaylist(await r2.text(), media));
    }

    if (p === '/proxy') {
      const u = q('u');
      if (!/^https?:\/\//.test(u)) return sendErr(res, 400, 'u must be an http(s) URL');
      const r = await fetchUpstream(u, 120_000);
      if (!r.ok) return sendErr(res, 502, 'upstream HTTP ' + r.status + ' for ' + u);
      const ctype = r.headers.get('content-type') || '';
      const data = Buffer.from(await r.arrayBuffer());
      const head = data.subarray(0, 64).toString('utf8').trimStart();
      if (head.startsWith('#EXTM3U') || ctype.includes('xml') || ctype.includes('text')) {
        const text = data.toString('utf8');
        if (text.trimStart().startsWith('#EXTM3U')) {
          return sendM3u8(res, rewritePlaylist(text, u));
        }
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(data);
    }

    return sendErr(res, 404, 'unknown route');
  } catch (e) {
    if (e instanceof ResolutionError) return sendErr(res, e.status, e.msg);
    if (/numeric|required|requires|must be/.test(e.message)) return sendErr(res, 400, e.message);
    console.error(`[error] ${req.method} ${p}:`, e);
    return sendErr(res, 500, e.constructor.name + ': ' + e.message);
  }
}

export async function initializeEngine() {
  await loadWasm();
  // Catalog and signer startup do not depend on source-list availability.
  getServers().catch(error => console.warn('Source-list warmup:', error.message));
}

// Shared by the IPTV adapter in the same process.
export { tmdb_get as getCatalogData, resolve as resolveStream, fetchUpstream };
