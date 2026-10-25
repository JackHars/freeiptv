// Movie/episode provider integration. Ported from Red Hermes' 2026-10-25 work.
import { createHash, createDecipheriv } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { decryptGCM, decryptVidSrc, vidsrcKey } from './provider-crypto.mjs';
import { highestQualityPlaylist } from './hls-quality.mjs';

export const PROVIDERS = Object.freeze(['cinejoy', 'atlantic', 'tvids', 'zstream', 'vidrift', 'vidsrc']);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const headersFor = site => ({ 'user-agent': UA, origin: new URL(site).origin, referer: site.endsWith('/') ? site : site + '/' });
export function mediaHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])
    .filter(([k, v]) => ['user-agent', 'referer', 'origin'].includes(k) && !/[\r\n]/.test(v)));
}
export function httpURL(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid media URL');
  return url.href;
}
export function variantsOf(text, base) {
  const variants = [];
  let attrs;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) attrs = line;
    else if (attrs && line && !line.startsWith('#')) {
      const res = attrs.match(/RESOLUTION=(\d+)x(\d+)/), bw = attrs.match(/(?:[:,])BANDWIDTH=(\d+)/);
      variants.push({ media: httpURL(line, base), width: +(res?.[1] || 0), resolution: res ? `${res[1]}x${res[2]}` : '?', bandwidth: +(bw?.[1] || 0) });
      attrs = null;
    }
  }
  return variants.sort((a, b) => b.width - a.width || b.bandwidth - a.bandwidth);
}
export function isVideo(bytes) {
  if (bytes.length >= 377 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47) return true;
  return bytes.length >= 12 && /^(ftyp|styp|moof|moov)$/.test(bytes.subarray(4, 8).toString());
}
function failure(message, status = 502) { return Object.assign(new Error(message), { status, msg: message }); }

export function createProviderContext({ signal, fetchResource = (...args) => fetch(...args) }) {
  async function read(url, headers = {}, options = {}) {
    signal?.throwIfAborted();
    const limit = options.limit || 4 * 1024 * 1024;
    for (let attempt = 0; ; attempt++) {
      const response = await fetchResource(httpURL(url), {
        method: options.body ? 'POST' : 'GET',
        headers: { 'user-agent': UA, ...headers, ...(options.body ? { 'content-type': 'application/json' } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(options.timeout || 12000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (attempt < 1 && (response.status === 429 || response.status >= 500)) {
          await delay(response.status === 429 ? 1500 : 300, undefined, { signal }); continue;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      const reader = response.body?.getReader(), chunks = []; let length = 0;
      if (!reader) throw new Error('Empty response');
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          if (options.peek) {
            const chunk = value.subarray(0, limit - length); chunks.push(chunk); length += chunk.length;
            if (length === limit) break;
          } else {
            length += value.length; if (length > limit) throw new Error('Provider response too large');
            chunks.push(value);
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      return { bytes: Buffer.concat(chunks), url: response.url || url };
    }
  }
  const text = async (...args) => (await read(...args)).bytes.toString('utf8');
  const json = async (...args) => JSON.parse(await text(...args));
  async function accept(url, headers, source) {
    headers = mediaHeaders(headers);
    const root = await read(url, headers);
    let playlist = root.bytes.toString('utf8'), base = root.url;
    if (!playlist.trimStart().startsWith('#EXTM3U')) throw new Error('Source did not return HLS');
    const variants = variantsOf(playlist, base);
    // Validate the same highest rendition that the IPTV relay will expose.
    for (let depth = 0; /#EXT-X-STREAM-INF:/.test(playlist); depth++) {
      if (depth >= 3) throw new Error('Too many nested HLS masters');
      const best = variantsOf(highestQualityPlaylist(playlist), base)[0];
      if (!best) throw new Error('HLS master has no variant');
      const next = await read(best.media, headers);
      base = next.url; playlist = next.bytes.toString('utf8');
      if (!playlist.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS variant');
    }
    const lines = playlist.split(/\r?\n/).map(l => l.trim());
    const segmentIndex = lines.findIndex(l => l && !l.startsWith('#'));
    if (segmentIndex < 0 || !playlist.includes('#EXTINF:')) throw new Error('HLS has no media segments');
    let bytes = (await read(httpURL(lines[segmentIndex], base), headers, { peek: true, limit: 4096 })).bytes;
    const keyLine = lines.slice(0, segmentIndex).filter(l => l.startsWith('#EXT-X-KEY:')).at(-1);
    if (keyLine && !/METHOD=NONE(?:,|$)/.test(keyLine)) {
      if (!/METHOD=AES-128(?:,|$)/.test(keyLine)) throw new Error('Unsupported HLS encryption');
      const uri = keyLine.match(/URI="([^"]+)"/)?.[1];
      if (!uri) throw new Error('Missing HLS key');
      const key = (await read(httpURL(uri, base), headers, { limit: 16 })).bytes;
      const iv = Buffer.alloc(16), explicit = keyLine.match(/IV=0x([a-f\d]+)/i)?.[1];
      if (explicit) {
        if (explicit.length > 32) throw new Error('Invalid HLS IV');
        Buffer.from(explicit.padStart(32, '0'), 'hex').copy(iv);
      } else iv.writeBigUInt64BE(BigInt(playlist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] || 0), 8);
      const cipher = createDecipheriv('aes-128-cbc', key, iv); cipher.setAutoPadding(false);
      bytes = cipher.update(bytes.subarray(0, bytes.length - bytes.length % 16));
    }
    if (!isVideo(bytes)) throw new Error('HLS segment is not video (empty, HTML, or image bait)');
    return { master: root.url, headers, server: source, variants, streams: [{ type: 'hls', id: source, playlist: root.url, headers }] };
  }
  return { read, text, json, accept, signal };
}

async function atlantic(input, ctx) {
  const h = headersFor('https://atlantic.st'), tv = input.kind === 'series';
  const query = new URLSearchParams({ tmdb: input.tmdb, type: tv ? 'tv' : 'movie' });
  if (tv) { query.set('season', input.season); query.set('episode', input.episode); }
  const moscowQuery = new URLSearchParams({ tmdbId: input.tmdb, type: tv ? 'tv' : 'movie' });
  if (tv) { moscowQuery.set('seasonId', input.season); moscowQuery.set('episodeId', input.episode); }
  const sources = [
    ['athena', async () => { const d = await ctx.json(`https://zcdn.bluevelvet.space/cdn?${query}`, h); return d.ready && d.url; }],
    ['aphrodite', async () => { const p = tv ? `tv/${input.tmdb}/${input.season}/${input.episode}` : `movie/${input.tmdb}`; const d = await ctx.json(`https://cdn.hls.lol/content/${p}`, h); return d.found && d.url; }],
    ['moscow', async () => {
      const d = await ctx.json(`https://stream.hls.lol/moscow?${moscowQuery}`, h), raw = d.sources?.Moscow?.url;
      if (typeof raw !== 'string' || !/^ms_(?:[a-f\d]{2})+$/i.test(raw)) throw new Error('Invalid Moscow payload');
      return decryptGCM(Buffer.from('55060a042823f51a94c296894a58a0db15f3baef807155140983083fa799ef47', 'hex'), Buffer.from(raw.slice(3), 'hex')).toString();
    }],
  ];
  const errors = {};
  for (const [source, get] of sources) {
    ctx.signal.throwIfAborted();
    try { const url = await get(); if (!url) throw new Error('No source'); return { ...await ctx.accept(url, h, source), server_errors: errors }; }
    catch (e) { errors[source] = e.message; }
  }
  throw new Error(Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; '));
}

async function tvids(input, ctx) {
  const base = 'https://play.xpass.top', h = headersFor(base);
  const page = `${base}/e/${input.kind === 'movie' ? `movie/${input.tmdb}` : `tv/${input.tmdb}/${input.season}/${input.episode}`}`;
  const html = await ctx.text(page, h), raw = html.match(/dataUrl\s*=\s*["']([^"']+)["']/)?.[1];
  if (!raw) throw new Error('Tvids embed has no data URL');
  const dataURL = new URL(raw.replaceAll('&amp;', '&'), base), token = dataURL.searchParams.get('token');
  if (!token) throw new Error('Tvids data URL has no token');
  const key = createHash('sha256').update(`spv3-data-response|spv3-build-1787821613-50e5fc97c9dce367|${dataURL.pathname}|${token}`).digest();
  const backups = JSON.parse(decryptGCM(key, Buffer.from((await ctx.text(dataURL.href, { ...h, referer: page })).trim(), 'base64url')).toString());
  if (!Array.isArray(backups)) throw new Error('Invalid Tvids backup list');
  const errors = {}, seen = new Set();
  for (const backup of backups.slice(0, 14)) {
    ctx.signal.throwIfAborted();
    if (!backup.url) continue;
    const name = String(backup.name || backup.id || 'backup');
    try {
      const data = await ctx.json(httpURL(backup.url, base), { ...h, referer: page });
      const item = (Array.isArray(data) ? data : data.playlist)?.[0];
      for (const source of [...(item?.sources || []), ...(item?.file ? [item] : [])]) {
        if (!source.file || seen.has(source.file) || source.file.includes('/video/error')) continue;
        seen.add(source.file);
        try { return { ...await ctx.accept(httpURL(source.file, base), { ...h, referer: base + '/e/' }, name), server_errors: errors }; }
        catch (e) { errors[name] = e.message; }
      }
    } catch (e) { errors[name] = e.message; }
  }
  throw new Error('No playable Tvids backup: ' + Object.values(errors).slice(-3).join('; '));
}

async function zstream(input, ctx) {
  const h = headersFor('https://cinecat.eu');
  const data = await ctx.json('https://api.zstream.mov/v1/scrape', h, { body: {
    tmdb_id: String(input.tmdb), type: input.kind === 'movie' ? 'movie' : 'show', season: input.season, episode: input.episode, lang: 'en', country: 'US',
  }, timeout: 25000 });
  const candidates = (data.streams || []).filter(s => s.type === 'hls' && s.playlist).sort((a, b) => Number(!!a.proxied) - Number(!!b.proxied));
  let error = 'No HLS sources';
  for (const s of candidates.slice(0, 12)) {
    ctx.signal.throwIfAborted();
    try { return await ctx.accept(s.playlist, { ...h, ...mediaHeaders(s.headers) }, String(s.id || 'zstream')); }
    catch (e) { error = e.message; }
  }
  throw new Error(error);
}

async function vidrift(input, ctx) {
  const type = input.kind === 'movie' ? 'movie' : 'tv';
  const path = type === 'movie' ? `movie/${input.tmdb}` : `tv/${input.tmdb}/${input.season}/${input.episode}`;
  let error = 'No Vidrift sources';
  for (const domain of ['7movies.ac', '7movies.ws', 'anicine.sbs', 'cinemove.cc', 'cinevibe.cc', 'freekz.to', 'streamgoblin.cc', 'thugtv.online']) {
    ctx.signal.throwIfAborted();
    try {
      const site = `https://${domain}`, h = headersFor(site);
      const data = await ctx.json(site + '/api/playback-token', h, { body: { tmdbId: input.tmdb, type, season: input.season, episode: input.episode } });
      if (!data.token) throw new Error('No playback token');
      const boot = await ctx.json(`https://embed.vidrift.net/api/boot/${path}?source=0&provider=selfhost&shell=1&token=${encodeURIComponent(data.token)}`, { ...h, 'x-embed-parent': site });
      for (const [source, url] of [['bigbang', boot.meta?.bigbangUrl], ['vexon', boot.meta?.vexonUrl]]) {
        if (!url) continue;
        try { return await ctx.accept(url, h, `${domain}/${source}`); } catch (e) { error = e.message; }
      }
    } catch (e) { error = e.message; }
  }
  throw new Error(error);
}

function objectInPage(html, name) {
  const match = new RegExp(`window\\.${name}\\s*=\\s*\\{`).exec(html);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
async function vidsrc(input, ctx, getCatalogData) {
  const type = input.kind === 'movie' ? 'movie' : 'tv';
  const ids = await getCatalogData(`/${type}/${input.tmdb}/external_ids`, {}, ctx.signal);
  if (!/^tt\d+$/.test(ids.imdb_id || '')) throw new Error('No IMDb ID');
  const h = headersFor('https://vidsrc.sh'), ref = `https://vidsrc.sh/embed/${ids.imdb_id}`;
  const query = new URLSearchParams({ type, id: ids.imdb_id });
  if (type === 'tv') { query.set('season', input.season); query.set('episode', input.episode); }
  const entry = await ctx.json(`https://vidsrc.sh/vs_src.php?${query}`, { ...h, referer: ref });
  const gate = await ctx.read(entry.src, { ...h, referer: ref }), gateHTML = gate.bytes.toString();
  let config = objectInPage(gateHTML, 'CFG') || objectInPage(gateHTML, 'CONFIG');
  if (!config) { try { config = JSON.parse(gateHTML); } catch { /* alternate gate is HTML */ } }
  if (!config?.playerUrl) throw new Error('VidSrc gate has no player URL');
  const playerURL = httpURL(config.playerUrl, gate.url);
  const player = await ctx.text(playerURL, { ...h, referer: gate.url });
  const playerConfig = objectInPage(player, 'CONFIG') || {
    api: player.match(/"api"\s*:\s*"([^"\r\n]+)"/)?.[1],
    apiToken: player.match(/"apiToken"\s*:\s*"([^"\r\n]+)"/)?.[1],
  };
  let api = playerConfig?.api;
  if (type === 'tv' && playerConfig?.streamBase) {
    api = `${playerConfig.streamBase}&season=${input.season}&episode=${input.episode}&stream_urls`;
  }
  if (!api || !playerConfig.apiToken) throw new Error('VidSrc player config changed');
  const apiURL = httpURL(api, playerURL), playbackHeaders = headersFor(new URL(playerURL).origin);
  const response = await ctx.json(`${apiURL}${apiURL.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(playerConfig.apiToken)}`, playbackHeaders);
  let urls = response.data?.stream_urls;
  if (!Array.isArray(urls)) {
    const wasm = (await ctx.read(response.vs?.wasm_url, playbackHeaders)).bytes;
    urls = decryptVidSrc(Buffer.from(urls || '', 'base64'), vidsrcKey(wasm)).toString().split(/\r?\n/).filter(Boolean);
  }
  const tokens = new Map();
  let error = 'VidSrc returned no URLs';
  for (const raw of urls.slice(0, 6)) {
    ctx.signal.throwIfAborted();
    try {
      const url = new URL(httpURL(raw.trim()));
      if (!tokens.has(url.origin)) {
        let token = '';
        try {
          const value = (await ctx.text(url.origin + '/generate.php', playbackHeaders)).trim();
          try { const data = JSON.parse(value); token = typeof data === 'string' ? data : data.token || data.data || data.string || data.result; }
          catch { token = value; }
        } catch { /* Media-host tokens are optional on some sources. */ }
        tokens.set(url.origin, typeof token === 'string' ? token : '');
      }
      const token = tokens.get(url.origin);
      let target = url.href;
      if (token) {
        if (target.includes('__TOKEN__')) target = target.replaceAll('__TOKEN__', encodeURIComponent(token));
        else { url.searchParams.set('token', token); target = url.href; }
      }
      return await ctx.accept(target, playbackHeaders, 'vidsrc');
    } catch (e) { error = e.message; }
  }
  throw new Error(error);
}

export function createProviderResolver({ cinejoy, getCatalogData, fetchResource, getPolicy, providerTimeoutMs = 30000, totalTimeoutMs = 180000, cacheTtlMs = 300000 }) {
  const cache = new Map();
  const adapters = { cinejoy, atlantic, tvids, zstream, vidrift, vidsrc: (input, ctx) => vidsrc(input, ctx, getCatalogData) };
  return async function resolve(input) {
    input = { season: null, episode: null, ...input, kind: input.kind === 'tv' ? 'series' : input.kind };
    input.signal?.throwIfAborted();
    const policy = getPolicy?.();
    const timeout = policy ? policy.providerTimeout * 1000 : providerTimeoutMs;
    const total = policy ? policy.totalTimeout * 1000 : totalTimeoutMs;
    const ttl = policy ? policy.cacheSeconds * 1000 : cacheTtlMs;
    const available = policy ? policy.order.filter(p => policy.enabled.includes(p)) : PROVIDERS;
    if (!/^[1-9]\d*$/.test(String(input.tmdb)) || !Number.isSafeInteger(Number(input.tmdb))) throw failure('tmdb must be a positive integer', 400);
    input.tmdb = Number(input.tmdb);
    if (!['movie', 'series'].includes(input.kind)) throw failure('kind must be movie or series', 400);
    if (input.kind === 'series') {
      for (const key of ['season', 'episode']) {
        if (!/^\d+$/.test(String(input[key])) || !Number.isSafeInteger(Number(input[key])) || Number(input[key]) < (key === 'episode' ? 1 : 0)) throw failure(`series requires valid ${key}`, 400);
        input[key] = Number(input[key]);
      }
    } else { input.season = null; input.episode = null; }
    if (input.provider && !PROVIDERS.includes(input.provider)) throw failure('Unknown provider', 400);
    if (input.provider && !available.includes(input.provider)) throw failure('This provider is disabled', 400);
    if (input.server && !available.includes('cinejoy')) throw failure('Cinejoy is disabled', 400);
    if (input.server && input.provider && input.provider !== 'cinejoy') throw failure('server is only supported for cinejoy', 400);
    const order = (input.provider ? [input.provider] : input.server ? ['cinejoy'] : available).filter(p => !input.exclude?.includes(p));
    const key = JSON.stringify([input.tmdb, input.kind, input.season, input.episode, order, input.server || null, policy || null]);
    // A selected provider that failed at playback must not be reused from cache.
    for (const [entryKey, entry] of cache) {
      if (entry.value.tmdb === input.tmdb && entry.value.kind === input.kind && input.exclude?.includes(entry.value.provider)) cache.delete(entryKey);
    }
    const hit = cache.get(key);
    if (!input.fresh && hit && hit.expires > Date.now()) return { ...hit.value, cached: true };
    const overall = AbortSignal.any([AbortSignal.timeout(total), ...(input.signal ? [input.signal] : [])]);
    const tried = [], errors = {};
    for (const provider of order) {
      if (overall.aborted) break;
      tried.push(provider);
      const signal = AbortSignal.any([overall, AbortSignal.timeout(input.provider && !policy ? Math.max(timeout, 75000) : timeout)]);
      const ctx = createProviderContext({ signal, fetchResource });
      try {
        const result = await adapters[provider](input, ctx);
        signal.throwIfAborted();
        if (!result?.master) throw new Error('No playable HLS source');
        const out = { ...result, provider, provider_order: [...tried], provider_errors: { ...errors }, tmdb: input.tmdb, kind: input.kind, season: input.season, episode: input.episode, cached: false };
        cache.set(key, { expires: Date.now() + ttl, value: out });
        while (cache.size > 256) cache.delete(cache.keys().next().value);
        return out;
      } catch (e) { errors[provider] = signal.aborted ? 'Provider timed out or request cancelled' : e.message; }
    }
    const error = overall.aborted ? failure('Playback resolution timed out or was cancelled', 504) : failure('No provider returned playable HLS');
    error.provider_errors = errors; error.provider_order = tried; throw error;
  };
}
