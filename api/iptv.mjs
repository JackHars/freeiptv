import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { getCatalogData, resolveStream, fetchUpstream } from './platform.mjs';
import { collectCatalog, catalogPageLimit, MAX_CATALOG_PAGES } from './catalog.mjs';
import { createTitleIndex } from './title-index.mjs';
import { createSubtitleService, attachSubtitles, subtitlePlaylist, subtitleSegment } from './subtitles.mjs';
import { highestQualityPlaylist } from './hls-quality.mjs';
import { createSportsProvider } from './sports.mjs';

const dataDirectory = new URL('../data/', import.meta.url);
const titleIndex = createTitleIndex({ directory: fileURLToPath(dataDirectory) });
const subtitles = createSubtitleService({ fetchResource: fetchUpstream });
const DAY = 86400000;
const image = (path, size = 'w500') => path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
const text = value => String(value ?? '').replace(/[\r\n\x00-\x1f]/g, ' ').trim();
const attr = value => text(value).replace(/"/g, "'");
const timestamp = () => String(Math.floor(Date.now() / 1000));
const duration = seconds => new Date(Math.max(0, seconds) * 1000).toISOString().slice(11, 19);
const idNumber = value => { if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, 'A positive numeric ID is required.'); return Number(value); };
const equal = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); };
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

let settings;
let catalog = { movies: [], series: [], updatedAt: null, errors: [] };
let episodeIndex = {};
let options = { catalogPages: MAX_CATALOG_PAGES, refreshHours: 12 };
let initialization;
let sports;
let sportsTimer;
let refreshPromise;
let refreshProgress;
let writeQueue = Promise.resolve();
const seriesCache = new Map();

async function readJSON(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, dataDirectory), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function saveJSON(name, value) {
  const serialized = JSON.stringify(value, null, 2);
  const operation = writeQueue.then(async () => {
    const target = new URL(name, dataDirectory), temp = new URL(`${name}.tmp`, dataDirectory);
    await writeFile(temp, serialized, { mode: 0o600 });
    await rename(temp, target);
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export function initializeIPTV(config = {}) {
  if (initialization) return initialization;
  initialization = (async () => {
    options = { catalogPages: catalogPageLimit(config.catalogPages), refreshHours: Math.max(1, Number(config.refreshHours) || 12) };
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    settings = await readJSON('iptv.json', null);
    if (!settings) {
      settings = { username: 'cinejoy', password: randomBytes(9).toString('base64url'), secret: randomBytes(32).toString('hex'), createdAt: timestamp(), pinned: [] };
      await saveJSON('iptv.json', settings);
    }
    if (!settings.username || !settings.password || !settings.secret) throw new Error('IPTV account configuration is incomplete.');
    settings.pinned ||= [];
    catalog = await readJSON('catalog.json', catalog);
    episodeIndex = await readJSON('episodes.json', {});
    await titleIndex.initialize();
    sports = createSportsProvider({ directory: config.sportsDirectory || fileURLToPath(dataDirectory), source: config.sportsSource });
    await sports.initialize();
  })();
  return initialization;
}

export async function setIPTVCredentials(username, password) {
  await initializeIPTV();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) throw new Error('Username must be 3–32 letters, numbers, underscores, or hyphens.');
  if (!/^[\x21-\x7e]{8,128}$/.test(password)) throw new Error('Password must be 8–128 printable characters without spaces.');
  await saveJSON('iptv.json', { ...settings, username, password });
  settings = { ...settings, username, password };
}

async function pool(items, operation, concurrency = 4) {
  const result = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await operation(items[index], index); }
  }));
  return result;
}

export async function refreshCatalog() {
  await initializeIPTV();
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const next = await collectCatalog({
      fetchPage: getCatalogData, pages: options.catalogPages, previous: catalog, pins: [...settings.pinned],
      onProgress: progress => { refreshProgress = progress; },
    });
    // A title may have been pinned while the background import was running.
    for (const pin of settings.pinned) {
      const key = pin.type === 'movie' ? 'movies' : 'series';
      if (!next[key].some(item => item.id === pin.id)) {
        const item = catalog[key].find(item => item.id === pin.id);
        if (item) next[key].push(item);
      }
    }
    catalog = next;
    await saveJSON('catalog.json', catalog);
    console.info(`IPTV catalog updated: ${catalog.movies.length} movies, ${catalog.series.length} series, ${catalog.errors.length} errors.`);
    return catalog;
  })().finally(() => { refreshPromise = null; refreshProgress = null; });
  return refreshPromise;
}
async function ensureCatalog() {
  if (!catalog.updatedAt) await refreshCatalog();
  else if (catalog.catalogPages !== options.catalogPages || Date.now() - Date.parse(catalog.updatedAt) > options.refreshHours * 3600000) refreshCatalog().catch(error => console.warn('IPTV catalog refresh:', error.message));
  return catalog;
}
export function warmIPTV() {
  titleIndex.warm(); ensureCatalog().catch(error => console.warn('IPTV catalog:', error.message));
  const warmSports = () => sports.ensure().catch(error => console.warn('IPTV sports:', error.message));
  warmSports();
  sportsTimer ||= setInterval(() => sports.refresh().catch(error => console.warn('IPTV sports:', error.message)), 60000).unref();
}

function origin(req) {
  const host = req.headers.host;
  if (!host || /[\s/\\@?#]/.test(host)) throw new HttpError(400, 'Invalid Host header.');
  return new URL(`http://${host}`).origin;
}
function credentials() { return new URLSearchParams({ username: settings.username, password: settings.password }); }
function streamURL(base, kind, id) {
  return `${base}/${kind}/${encodeURIComponent(settings.username)}/${encodeURIComponent(settings.password)}/${id}.m3u8`;
}
function authorized(username, password) { return equal(username, settings.username) && equal(password, settings.password); }
function requireAuth(params) { if (!authorized(params.get('username'), params.get('password'))) throw new HttpError(401, 'Invalid IPTV username or password.'); }
function reply(req, res, status, value, type = 'application/json; charset=utf-8') {
  if (res.destroyed) return;
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(req.method === 'HEAD' ? undefined : body);
}
async function requestBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) throw new HttpError(413, 'Request body is too large.'); }
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { return JSON.parse(body || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  }
  return Object.fromEntries(new URLSearchParams(body));
}
function manageOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin(req))) throw new HttpError(403, 'Open the IPTV settings from this server.');
}

function genreId(item) { return String(item.genre_ids?.[0] || item.genres?.[0]?.id || 0); }
async function categories(type) {
  await ensureCatalog();
  const list = type === 'movie' ? catalog.movies : catalog.series;
  const present = new Set(list.map(genreId));
  const data = await getCatalogData(`/genre/${type}/list`);
  const result = (data.genres || []).filter(genre => present.has(String(genre.id))).map(genre => ({ category_id: String(genre.id), category_name: genre.name, parent_id: 0 }));
  if (present.has('0')) result.push({ category_id: '0', category_name: 'Other', parent_id: 0 });
  return result;
}
function movieRow(item, index, base) {
  // Xtream's VOD contract uses a numeric rating and ceil(rating / 2).
  // Copying the series rating string here breaks strict movie JSON decoders.
  const rating = Number(Number(item.vote_average || 0).toFixed(1));
  return {
    num: index + 1, name: item.title || item.name, stream_type: 'movie', stream_id: item.id,
    stream_icon: image(item.poster_path), rating, rating_5based: Math.ceil(rating / 2),
    added: settings.createdAt, category_id: genreId(item), container_extension: 'm3u8',
    custom_sid: '', direct_source: streamURL(base, 'movie', item.id),
    tmdb: String(item.id), year: (item.release_date || '').slice(0, 4),
  };
}
function seriesRow(item, index) {
  return { num: index + 1, name: item.name, series_id: item.id, cover: image(item.poster_path), plot: item.overview || '', cast: '', director: '', genre: (item.genres || []).map(g => g.name).join(', '), releaseDate: item.first_air_date || '', release_date: item.first_air_date || '', last_modified: settings.createdAt, rating: String(Number(item.vote_average || 0).toFixed(1)), rating_5based: Number(item.vote_average || 0) / 2, backdrop_path: item.backdrop_path ? [image(item.backdrop_path, 'w1280')] : [], youtube_trailer: '', episode_run_time: String(item.episode_run_time?.[0] || 0), category_id: genreId(item) };
}
function detailFields(item) {
  return { movie_image: image(item.poster_path), cover_big: image(item.poster_path, 'original'), backdrop_path: item.backdrop_path ? [image(item.backdrop_path, 'w1280')] : [], tmdb_id: item.id, name: item.title || item.name, plot: item.overview || '', cast: (item.credits?.cast || []).slice(0, 12).map(c => c.name).join(', '), director: (item.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name).join(', '), genre: (item.genres || []).map(g => g.name).join(', '), rating: Number(item.vote_average || 0), releasedate: item.release_date || item.first_air_date || '', duration_secs: (item.runtime || 0) * 60, duration: duration((item.runtime || 0) * 60), youtube_trailer: '' };
}

async function seriesDetails(seriesId, base) {
  const id = idNumber(seriesId);
  let cached = seriesCache.get(id);
  if (!cached || Date.now() - cached.at > 3600000) {
    const item = await getCatalogData(`/tv/${id}`, { append_to_response: 'credits' });
    const seasons = await pool(item.seasons || [], async season => {
      const data = await getCatalogData(`/tv/${id}/season/${season.season_number}`);
      return { meta: season, episodes: data.episodes || [] };
    });
    for (const season of seasons) for (const episode of season.episodes) {
      episodeIndex[String(episode.id)] = { tmdb: id, season: episode.season_number, episode: episode.episode_number };
    }
    await saveJSON('episodes.json', episodeIndex);
    cached = { at: Date.now(), item, seasons };
    seriesCache.set(id, cached);
    if (seriesCache.size > 100) seriesCache.delete(seriesCache.keys().next().value);
  }
  const { item, seasons } = cached;
  const episodes = {};
  for (const season of seasons) episodes[String(season.meta.season_number)] = season.episodes.map(e => ({
    id: String(e.id), episode_num: e.episode_number, title: e.name || `Episode ${e.episode_number}`, container_extension: 'm3u8', season: e.season_number, added: settings.createdAt, custom_sid: '', direct_source: streamURL(base, 'series', e.id),
    info: { tmdb_id: e.id, movie_image: image(e.still_path || item.poster_path), plot: e.overview || '', releasedate: e.air_date || '', rating: Number(e.vote_average || 0), duration_secs: (e.runtime || item.episode_run_time?.[0] || 0) * 60, duration: duration((e.runtime || item.episode_run_time?.[0] || 0) * 60) },
  }));
  const info = { ...seriesRow(item, 0), ...detailFields(item), cover: image(item.poster_path) };
  return { info, seasons: seasons.map(({ meta }) => ({ ...meta, cover: image(meta.poster_path || item.poster_path), cover_big: image(meta.poster_path || item.poster_path, 'original') })), episodes };
}

function mediaToken(upstream, extra = {}) {
  const url = new URL(upstream);
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(502, 'Unsupported media URL.');
  const data = Buffer.from(JSON.stringify({ ...extra, u: url.href, exp: Date.now() + DAY })).toString('base64url');
  const signature = createHmac('sha256', settings.secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}
function assetURL(base, upstream, hint = 'segment', headers) {
  const url = new URL(upstream);
  const extension = url.pathname.match(/\.(ts|m4s|mp4|aac|mp3|vtt)$/i)?.[1]?.toLowerCase();
  // Some video hosts disguise TS segments as .jpg. Native players use the
  // extension to admit HLS resources, so expose media-specific local names.
  const suffix = hint === 'playlist' || /\.m3u8$/i.test(url.pathname) ? 'playlist.m3u8'
    : hint === 'key' ? 'key.bin' : hint === 'map' ? 'init.mp4' : `segment.${extension || 'ts'}`;
  return `${base}/iptv/media/${mediaToken(upstream, headers ? { headers } : {})}/${suffix}`;
}
function assetTarget(token) {
  const [data, signature, extra] = token.split('.');
  if (!data || !signature || extra || !equal(signature, createHmac('sha256', settings.secret).update(data).digest('base64url'))) throw new HttpError(403, 'Invalid media link.');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(data, 'base64url')); } catch { throw new HttpError(403, 'Invalid media link.'); }
  if (!Number.isFinite(decoded.exp) || decoded.exp < Date.now()) throw new HttpError(403, 'Media link expired. Reopen the title in your player.');
  if (!/^https?:\/\//.test(decoded.u)) throw new HttpError(403, 'Invalid media URL.');
  return decoded;
}
function rewriteHLS(playlist, upstream, base, headers) {
  const master = /#EXT-X-STREAM-INF:/.test(playlist);
  const rewrite = (uri, hint) => /^(data:|skd:)/i.test(uri) ? uri : assetURL(base, new URL(uri, upstream).href, hint, headers);
  return playlist.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      const hint = /^#EXT-X-(?:SESSION-)?KEY:/.test(line) ? 'key' : line.startsWith('#EXT-X-MAP:') ? 'map' : 'playlist';
      return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri, hint)}"`);
    }
    return rewrite(line.trim(), master ? 'playlist' : 'segment');
  }).join('\n');
}

async function serveMedia(req, res, upstream, base, decorate, upstreamHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  res.once('close', () => controller.abort());
  let reader;
  try {
    const headers = { ...upstreamHeaders };
    for (const name of ['range', 'if-range']) if (req.headers[name]) headers[name] = req.headers[name];
    const response = await fetchUpstream(upstream, 120000, { method: req.method === 'HEAD' && !decorate ? 'HEAD' : 'GET', headers, signal: controller.signal });
    if (response.status === 416) {
      await response.body?.cancel();
      res.writeHead(416, { 'Content-Range': response.headers.get('content-range') || 'bytes */0' }); return res.end();
    }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, `Video host returned HTTP ${response.status}.`); }
    const type = response.headers.get('content-type') || 'application/octet-stream';
    if (type.includes('text/html')) { await response.body?.cancel(); throw new HttpError(502, 'The video host returned an error page.'); }
    if (req.method === 'HEAD' && !decorate) {
      const result = { 'Content-Type': /mpegurl/i.test(type) || /\.m3u8(?:\?|$)/i.test(upstream) ? 'application/vnd.apple.mpegurl' : type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
      res.writeHead(response.status, result); return res.end();
    }
    reader = response.body.getReader();
    const first = await reader.read();
    const prefix = first.value ? new TextDecoder().decode(first.value.subarray(0, 128)).trimStart() : '';
    const isPlaylist = prefix.startsWith('#EXTM3U') || /mpegurl/i.test(type);
    if (isPlaylist) {
      const chunks = first.done ? [] : [first.value]; let length = first.value?.length || 0;
      while (!first.done) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.length; if (length > 4 * 1024 * 1024) throw new HttpError(502, 'Upstream playlist is too large.');
        chunks.push(next.value);
      }
      // Apply to root and nested IPTV masters so automatic bitrate switching
      // cannot silently select a lower rendition. Media playlists are unchanged.
      const original = highestQualityPlaylist(Buffer.concat(chunks).toString('utf8'));
      const sourceURL = response.url || upstream;
      let playlist = rewriteHLS(original, sourceURL, base, upstreamHeaders);
      if (decorate) playlist = await decorate(playlist, original, sourceURL);
      return reply(req, res, 200, playlist, 'application/vnd.apple.mpegurl');
    }
    const mediaType = first.value?.[0] === 0x47 ? 'video/mp2t'
      : first.value && /^(ftyp|styp|moof|moov)$/.test(Buffer.from(first.value.subarray(4, 8)).toString()) ? 'video/mp4' : type;
    const responseHeaders = { 'Content-Type': mediaType, 'Cache-Control': 'private, max-age=60', 'Access-Control-Allow-Origin': '*' };
    for (const key of ['content-range', 'accept-ranges', 'etag', 'last-modified']) if (response.headers.has(key)) responseHeaders[key] = response.headers.get(key);
    if (!response.headers.has('content-encoding') && response.headers.has('content-length')) responseHeaders['Content-Length'] = response.headers.get('content-length');
    res.writeHead(response.status, responseHeaders);
    await pipeline(Readable.from((async function* () {
      if (!first.done) yield first.value;
      while (true) { const next = await reader.read(); if (next.done) break; yield next.value; }
    })()), res);
  } finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); }
}

async function serveTitle(req, res, kind, id, params, base) {
  let tmdb, season = null, episode = null;
  if (kind === 'movie') tmdb = idNumber(id);
  else {
    const entry = episodeIndex[String(idNumber(id))];
    if (!entry) throw new HttpError(404, 'Episode not indexed. Refresh this series in your IPTV app.');
    ({ tmdb, season, episode } = entry);
  }
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (res.destroyed) return;
    try {
      const stream = await resolveStream(tmdb, kind === 'movie' ? 'movie' : 'series', season, episode, null, attempt > 0 || params.get('fresh') === '1');
      if (!stream.master) throw new HttpError(502, 'No playable stream returned.');
      await serveMedia(req, res, stream.master, base, async (playlist, original, sourceURL) => {
        if (/#EXT-X-MEDIA:.*TYPE=SUBTITLES/.test(original)) return playlist;
        try {
          const tracks = await subtitles.tracks({ kind, tmdb, season, episode });
          if (!tracks.length) return playlist;
          const timing = await subtitles.timeline(original, sourceURL);
          // A direct media playlist needs a master before alternate renditions can be declared.
          if (!/#EXT-X-STREAM-INF:/.test(original)) playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\n${assetURL(base, sourceURL, 'playlist')}\n`;
          const result = attachSubtitles(playlist, tracks, track => `${base}/iptv/subtitles/${mediaToken(track.url, { sub: timing })}/playlist.m3u8`);
          console.info('IPTV subtitles', JSON.stringify({ kind, tmdb, season, episode, tracks: tracks.length }));
          return result;
        } catch (error) {
          // An unavailable subtitle provider must not prevent video playback.
          console.warn('IPTV subtitles unavailable', JSON.stringify({ kind, tmdb, season, episode, error: error.message }));
          return playlist;
        }
      });
      return;
    } catch (error) {
      lastError = error;
      if (res.headersSent || error.status === 404 || error.status === 400) throw error;
    }
  }
  throw lastError;
}

async function buildPlaylist(params, base) {
  if (params.get('output') && params.get('output') !== 'm3u8') throw new HttpError(400, 'Use output=m3u8 (HLS).');
  const rows = ['#EXTM3U'];
  const seriesId = params.get('series_id');
  if (!seriesId) {
    const liveRows = await sports.rows(id => streamURL(base, 'live', id));
    const liveCategories = new Map((await sports.categories()).map(c => [c.category_id, c.category_name]));
    for (const item of liveRows) {
      rows.push(`#EXTINF:-1 tvg-id="${attr(item.epg_channel_id)}" tvg-name="${attr(item.name)}" tvg-logo="${attr(item.stream_icon)}" group-title="${attr(liveCategories.get(item.category_id))}",${text(item.name)}`);
      rows.push(item.direct_source);
    }
  }
  if (params.get('content') === 'live') return rows.join('\n') + '\n';
  await ensureCatalog();
  if (!seriesId) for (const item of catalog.movies) {
    rows.push(`#EXTINF:-1 tvg-id="movie-${item.id}" tvg-name="${attr(item.title)}" tvg-logo="${attr(image(item.poster_path))}" group-title="Movies" vod="true",${text(item.title)}`);
    rows.push(streamURL(base, 'movie', item.id));
  }
  const series = seriesId ? [{ id: idNumber(seriesId), type: 'tv' }] : settings.pinned.filter(pin => pin.type === 'tv');
  for (const pin of series) {
    const details = await seriesDetails(pin.id, base);
    for (const season of Object.values(details.episodes)) for (const episode of season) {
      const title = `${details.info.name} S${String(episode.season).padStart(2, '0')}E${String(episode.episode_num).padStart(2, '0')} · ${episode.title}`;
      rows.push(`#EXTINF:-1 tvg-id="episode-${episode.id}" tvg-name="${attr(title)}" tvg-logo="${attr(details.info.cover)}" group-title="${attr(details.info.name)}" vod="true",${text(title)}`);
      rows.push(episode.direct_source);
    }
  }
  return rows.join('\n') + '\n';
}

async function playerAPI(params, base) {
  const action = params.get('action') || '';
  if (!action) {
    const server = new URL(base);
    return { user_info: { username: settings.username, password: settings.password, message: 'Cinejoy Movies, Series & Sports', auth: 1, status: 'Active', exp_date: null, is_trial: '0', active_cons: '0', created_at: settings.createdAt, max_connections: '0', allowed_output_formats: ['m3u8'] }, server_info: { url: server.hostname, port: server.port || (server.protocol === 'https:' ? '443' : '80'), https_port: '443', server_protocol: server.protocol.slice(0, -1), rtmp_port: '0', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, timestamp_now: Math.floor(Date.now() / 1000), time_now: new Date().toISOString().replace('T', ' ').slice(0, 19), process: true } };
  }
  if (action === 'get_live_categories') return sports.categories();
  if (action === 'get_live_streams') return sports.rows(id => streamURL(base, 'live', id), params.get('category_id'));
  if (['get_short_epg', 'get_simple_data_table', 'get_simple_date_table'].includes(action)) return sports.epg(params.get('stream_id'));
  if (action === 'get_vod_categories') return categories('movie');
  if (action === 'get_series_categories') return categories('tv');
  if (['get_vod_streams', 'get_series', 'get_series_latest'].includes(action)) {
    await ensureCatalog();
    let items = action === 'get_vod_streams' ? catalog.movies : catalog.series;
    const category = params.get('category_id');
    if (category && category !== 'all') items = items.filter(item => genreId(item) === category);
    if (action === 'get_series_latest') items = items.slice(0, 100);
    return items.map((item, i) => action === 'get_vod_streams' ? movieRow(item, i, base) : seriesRow(item, i));
  }
  if (action === 'get_vod_info') {
    const item = await getCatalogData(`/movie/${idNumber(params.get('vod_id'))}`, { append_to_response: 'credits' });
    return { info: detailFields(item), movie_data: movieRow(item, 0, base) };
  }
  if (action === 'get_series_info') return seriesDetails(params.get('series_id'), base);
  throw new HttpError(400, `Unsupported Xtream action: ${action}`);
}

export async function handleIPTV(req, res) {
  const url = new URL(req.url, 'http://local');
  const path = url.pathname;
  const relevant = ['/player_api.php', '/get.php', '/xmltv.php', '/iptv/setup', '/iptv/titles', '/iptv/refresh', '/iptv/library', '/iptv/sports/refresh'].includes(path) || path.startsWith('/iptv/media/') || path.startsWith('/iptv/subtitles/') || /^\/(movie|series|live)\//.test(path);
  if (!relevant) return false;
  // Keep import diagnostics without recording credential-bearing URLs or bodies.
  let resultCount;
  if (path === '/player_api.php') {
    const started = Date.now();
    res.once('finish', () => console.info('IPTV API', JSON.stringify({
      method: req.method, action: (url.searchParams.get('action') || 'login').replace(/[^a-z0-9_]/gi, '').slice(0, 48),
      category: (url.searchParams.get('category_id') || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24),
      status: res.statusCode, count: resultCount, ms: Date.now() - started,
      client: req.socket.remoteAddress,
      agent: text(req.headers['user-agent']).replaceAll(settings?.password || '\0', '[redacted]').slice(0, 160),
    })));
  }
  try {
    await initializeIPTV();
    if (req.method === 'OPTIONS') {
      if (path.startsWith('/iptv/') && !/^\/iptv\/(media|subtitles)\//.test(path)) manageOrigin(req);
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range' }); res.end(); return true;
    }
    const base = origin(req);
    const params = url.searchParams;
    if (req.method === 'POST' && path === '/player_api.php') for (const [key, value] of Object.entries(await requestBody(req))) params.set(key, value);
    if (path === '/iptv/setup' && req.method === 'GET') {
      manageOrigin(req);
      titleIndex.warm();
      sports.ensure().catch(error => console.warn('IPTV sports:', error.message));
      const query = credentials();
      reply(req, res, 200, { name: 'Cinejoy', server: base, username: settings.username, password: settings.password, format: 'HLS / m3u8', playlist: `${base}/get.php?${query}&type=m3u_plus&output=m3u8`, sportsPlaylist: `${base}/get.php?${query}&type=m3u_plus&output=m3u8&content=live`, epg: `${base}/xmltv.php?${query}`, sports: sports.status(), movies: catalog.movies.length, series: catalog.series.length, updatedAt: catalog.updatedAt, refreshing: Boolean(refreshPromise), progress: refreshProgress, errors: catalog.errors, catalogPages: options.catalogPages, titleIndex: titleIndex.status(), pinned: settings.pinned });
      return true;
    }
    if (path === '/iptv/titles' && req.method === 'GET') {
      manageOrigin(req);
      const query = (params.get('q') || '').trim();
      if (query.length < 2 || query.length > 200) throw new HttpError(400, 'Enter a title between 2 and 200 characters.');
      reply(req, res, 200, { items: titleIndex.search(query, params.get('type')), source: 'local', updatedAt: titleIndex.status().updatedAt || null });
      return true;
    }
    if (['/iptv/refresh', '/iptv/library', '/iptv/sports/refresh'].includes(path)) {
      manageOrigin(req);
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
      if (!(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Use application/json.');
      if (path === '/iptv/sports/refresh') { sports.refresh().catch(error => console.warn('IPTV sports:', error.message)); reply(req, res, 202, { refreshing: true }); return true; }
      if (path === '/iptv/refresh') { titleIndex.refresh().catch(error => console.warn('Title index:', error.message)); refreshCatalog().catch(error => console.warn('IPTV refresh:', error.message)); reply(req, res, 202, { refreshing: true }); return true; }
      const input = await requestBody(req);
      const type = input.type === 'tv' ? 'tv' : input.type === 'movie' ? 'movie' : null;
      if (!type) throw new HttpError(400, 'Type must be movie or tv.');
      const id = idNumber(input.tmdb);
      const item = await getCatalogData(`/${type}/${id}`);
      if (!settings.pinned.some(pin => pin.id === id && pin.type === type)) settings.pinned.push({ id, type, title: item.title || item.name });
      const key = type === 'movie' ? 'movies' : 'series';
      if (!catalog[key].some(existing => existing.id === id)) catalog[key].push(item);
      await saveJSON('iptv.json', settings); await saveJSON('catalog.json', catalog);
      reply(req, res, 200, { added: true, title: item.title || item.name }); return true;
    }
    if (!['GET', 'HEAD'].includes(req.method) && !(req.method === 'POST' && path === '/player_api.php')) throw new HttpError(405, 'Method not allowed.');
    const media = path.match(/^\/iptv\/media\/([^/]+)\/(?:asset|playlist\.m3u8|key\.bin|init\.mp4|segment\.(?:ts|m4s|mp4|aac|mp3|vtt))$/);
    if (media) {
      const target = assetTarget(media[1]);
      if (target.sub) throw new HttpError(403, 'Invalid media link type.');
      await serveMedia(req, res, target.u, base, undefined, target.headers); return true;
    }
    const subtitle = path.match(/^\/iptv\/subtitles\/([^/]+)\/(playlist\.m3u8|segment-(\d+)\.vtt)$/);
    if (subtitle) {
      const target = assetTarget(subtitle[1]), timing = target.sub;
      if (!timing || !(timing.duration > 0 && timing.duration < 172800) || !Number.isSafeInteger(timing.pts) || timing.pts < 0 || timing.pts >= 8589934592) throw new HttpError(403, 'Invalid subtitle link.');
      const cues = await subtitles.cues(target.u);
      if (subtitle[2] === 'playlist.m3u8') reply(req, res, 200, subtitlePlaylist(timing.duration), 'application/vnd.apple.mpegurl');
      else reply(req, res, 200, subtitleSegment(cues, Number(subtitle[3]), timing.duration, timing.pts), 'text/vtt; charset=utf-8');
      return true;
    }
    const stream = path.match(/^\/(movie|series|live)\/([^/]+)\/([^/]+)\/(\d+)\.([a-z0-9]+)$/i);
    if (stream) {
      if (!authorized(decodeURIComponent(stream[2]), decodeURIComponent(stream[3]))) throw new HttpError(401, 'Invalid IPTV username or password.');
      if (stream[5] !== 'm3u8') throw new HttpError(415, 'Select HLS / m3u8 as the stream format in your player.');
      if (stream[1] === 'live') {
        const live = await sports.resolve(idNumber(stream[4]));
        await serveMedia(req, res, live.url, base, undefined, live.headers); return true;
      }
      await serveTitle(req, res, stream[1], stream[4], params, base); return true;
    }
    requireAuth(params);
    if (path === '/player_api.php') {
      const result = await playerAPI(params, base);
      if (Array.isArray(result)) resultCount = result.length;
      reply(req, res, 200, result);
    }
    else if (path === '/get.php') reply(req, res, 200, await buildPlaylist(params, base), 'audio/x-mpegurl; charset=utf-8');
    else if (path === '/xmltv.php') reply(req, res, 200, await sports.xmltv(), 'application/xml; charset=utf-8');
    else throw new HttpError(404, 'IPTV route not found.');
  } catch (error) {
    if (res.headersSent) res.destroy();
    else { if (error.status === 503) res.setHeader('Retry-After', '30'); reply(req, res, error.status || 502, { error: error.message, ...(error.status === 401 ? { user_info: { auth: 0, status: 'Disabled' } } : {}) }); }
  }
  return true;
}
