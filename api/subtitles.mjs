// Cinejoy publishes sidecar subtitles separately from its video resolver.
// Package them as HLS WebVTT renditions for native IPTV players (RFC 8216).
const SEGMENT_SECONDS = 60;
const MAX_BYTES = 4 * 1024 * 1024;
const names = new Intl.DisplayNames(['en'], { type: 'language' });
const clean = value => String(value || '').replace(/["\r\n\x00-\x1f]/g, '').trim();
const seconds = value => value.replace(',', '.').split(':').reduce((a, b) => a * 60 + Number(b), 0);
const stamp = value => {
  const ms = Math.round(value * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

export function parseSubtitles(input) {
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^\s*<(?:!doctype|html)/i.test(source)) throw new Error('Subtitle host returned HTML.');
  const cues = [];
  for (const block of source.split(/\n[ \t]*\n/)) {
    const lines = block.trim().split('\n');
    const index = lines.findIndex(line => /-->/.test(line));
    if (index < 0 || /^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
    const match = lines[index].match(/^\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})(.*)$/);
    if (!match) continue;
    const start = seconds(match[1]), end = seconds(match[2]);
    // Keep WebVTT cue settings, but remove SRT-only positioning and SSA tags.
    const settings = match[3].trim().split(/\s+/).filter(s => /^(?:vertical|line|position|size|align):/.test(s)).join(' ');
    const body = lines.slice(index + 1).join('\n').replace(/\{\\[^}]*\}/g, '').replace(/<\/?font\b[^>]*>/gi, '').trim();
    if (end > start && body) cues.push({ start, end, settings, body });
  }
  if (!cues.length) throw new Error('No supported subtitle cues were returned.');
  return cues.sort((a, b) => a.start - b.start);
}

export function subtitlePlaylist(duration) {
  if (!(duration > 0 && duration < 172800)) throw new Error('Invalid subtitle duration.');
  const rows = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(Math.min(SEGMENT_SECONDS, duration))}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let start = 0, i = 0; start < duration; start += SEGMENT_SECONDS, i++) rows.push(`#EXTINF:${Math.min(SEGMENT_SECONDS, duration - start).toFixed(6)},`, `segment-${i}.vtt`);
  return rows.concat('#EXT-X-ENDLIST', '').join('\n');
}

export function subtitleSegment(cues, index, duration, pts = 0) {
  const start = index * SEGMENT_SECONDS, end = Math.min(duration, start + SEGMENT_SECONDS);
  if (!Number.isSafeInteger(index) || index < 0 || start >= duration) throw Object.assign(new Error('Subtitle segment not found.'), { status: 404 });
  const rows = ['WEBVTT', `X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${pts}`, ''];
  for (const cue of cues) if (cue.start < end && cue.end > start) rows.push(`${stamp(cue.start)} --> ${stamp(cue.end)}${cue.settings ? ' ' + cue.settings : ''}`, cue.body, '');
  return rows.join('\n') + '\n';
}

export function chooseTracks(rows) {
  const groups = new Map(), seen = new Set();
  // Retain provider order, preferring full-length tracks over split CDs/forced-only files.
  const ordered = [...rows].sort((a, b) => Number(/(?:\bCD[12]\b|forced)/i.test(a.display || '')) - Number(/(?:\bCD[12]\b|forced)/i.test(b.display || '')));
  for (const row of ordered) {
    if (!/^https?:\/\//i.test(row.url || '') || seen.has(row.url) || !['srt', 'vtt', 'webvtt'].includes((row.type || '').toLowerCase())) continue;
    let language = clean(row.language).replace('_', '-').toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language)) language = 'und';
    const group = groups.get(language) || [];
    if (group.length >= (language === 'en' ? 3 : 1)) continue;
    let name; try { name = names.of(language); } catch { name = language; }
    group.push({ url: row.url, language, name: `${name}${group.length ? ` (${group.length + 1})` : ''}` });
    groups.set(language, group); seen.add(row.url);
  }
  return [...groups].sort(([a], [b]) => a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)).flatMap(([, group]) => group);
}

export function attachSubtitles(playlist, tracks, makeURL) {
  if (!tracks.length || !/#EXT-X-STREAM-INF:/.test(playlist)) return playlist;
  // Preserve any native subtitle group. These are already proxied by the adapter.
  if (/#EXT-X-MEDIA:.*TYPE=SUBTITLES/.test(playlist)) return playlist;
  const declarations = tracks.map(track => `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="cinejoy-subs",NAME="${clean(track.name)}",LANGUAGE="${clean(track.language)}",AUTOSELECT=${/\(\d+\)$/.test(track.name) ? 'NO' : 'YES'},DEFAULT=NO,FORCED=NO,URI="${makeURL(track)}"`);
  return playlist.split(/\r?\n/).flatMap(line => line === '#EXTM3U' ? [line, ...declarations] : line.startsWith('#EXT-X-STREAM-INF:') ? [line.replace(/,SUBTITLES="[^"]*"/g, '') + ',SUBTITLES="cinejoy-subs"'] : [line]).join('\n');
}

async function limitedBody(response, limit = MAX_BYTES, prefixOnly = false) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Subtitle resource returned HTTP ${response.status}.`); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (size + value.length > limit) {
        if (!prefixOnly) throw new Error('Subtitle resource is too large.');
        chunks.push(value.subarray(0, limit - size)); break;
      }
      chunks.push(value); size += value.length;
      if (prefixOnly && size === limit) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

function boxes(buffer, start = 0, end = buffer.length) {
  const result = [];
  for (let offset = start; offset + 8 <= end;) {
    const size = buffer.readUInt32BE(offset);
    if (size < 8 || offset + size > end) break;
    result.push({ type: buffer.toString('ascii', offset + 4, offset + 8), start: offset + 8, end: offset + size });
    offset += size;
  }
  return result;
}

export function initialTimestamp(segment, init) {
  // TS presentation timestamps use the same 90 kHz clock as X-TIMESTAMP-MAP.
  if (segment[0] === 0x47) {
    let audio;
    for (let i = 0; i + 188 <= segment.length; i += 188) {
      if (segment[i] !== 0x47 || !(segment[i + 1] & 0x40)) continue;
      const flags = (segment[i + 3] >> 4) & 3;
      if (!(flags & 1)) continue;
      const at = i + 4 + (flags & 2 ? 1 + segment[i + 4] : 0);
      if (at + 14 > i + 188 || segment[at] || segment[at + 1] || segment[at + 2] !== 1 || !(segment[at + 7] & 0x80)) continue;
      const p = at + 9;
      const pts = ((segment[p] & 14) * 536870912) + segment[p + 1] * 4194304 + (segment[p + 2] & 254) * 16384 + segment[p + 3] * 128 + ((segment[p + 4] & 254) >> 1);
      if ((segment[at + 3] & 0xf0) === 0xe0) return pts;
      if ((segment[at + 3] & 0xe0) === 0xc0) audio ??= pts;
    }
    return audio ?? 0;
  }
  // fMP4: correlate each tfdt decode time with its track's mdhd timescale.
  const scales = new Map();
  const moov = init && boxes(init).find(box => box.type === 'moov');
  if (moov) for (const trak of boxes(init, moov.start, moov.end).filter(box => box.type === 'trak')) {
    const children = boxes(init, trak.start, trak.end), tkhd = children.find(box => box.type === 'tkhd'), mdia = children.find(box => box.type === 'mdia');
    const mdhd = mdia && boxes(init, mdia.start, mdia.end).find(box => box.type === 'mdhd');
    if (tkhd && mdhd) scales.set(init.readUInt32BE(tkhd.start + (init[tkhd.start] === 1 ? 20 : 12)), init.readUInt32BE(mdhd.start + (init[mdhd.start] === 1 ? 20 : 12)));
  }
  const moof = boxes(segment).find(box => box.type === 'moof'), times = [];
  if (moof) for (const traf of boxes(segment, moof.start, moof.end).filter(box => box.type === 'traf')) {
    const children = boxes(segment, traf.start, traf.end), tfhd = children.find(box => box.type === 'tfhd'), tfdt = children.find(box => box.type === 'tfdt');
    if (!tfhd || !tfdt) continue;
    const scale = scales.get(segment.readUInt32BE(tfhd.start + 4));
    if (scale) times.push(Number(segment[tfdt.start] === 1 ? segment.readBigUInt64BE(tfdt.start + 4) : segment.readUInt32BE(tfdt.start + 4)) / scale);
  }
  return times.length ? Math.round(Math.min(...times) * 90000) % 8589934592 : 0;
}

export function createSubtitleService({ fetchResource }) {
  const lookups = new Map(), files = new Map(), timelines = new Map();
  function cached(cache, key, ttl, max, operation) {
    const prior = cache.get(key);
    if (prior && prior.expires > Date.now()) return prior.promise;
    const entry = { expires: Date.now() + ttl, promise: Promise.resolve().then(operation) };
    cache.set(key, entry);
    while (cache.size > max) cache.delete(cache.keys().next().value);
    entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    return entry.promise;
  }
  async function read(url, limit = MAX_BYTES, prefix = false, headers = {}) {
    return limitedBody(await fetchResource(url, 12000, { headers: { ...headers, ...(prefix ? { Range: `bytes=0-${limit - 1}` } : {}) } }), limit, prefix);
  }
  return {
    tracks({ kind, tmdb, season, episode }) {
      const query = new URLSearchParams({ type: kind === 'movie' ? 'movie' : 'tv', tmdb: String(tmdb) });
      if (kind !== 'movie') { query.set('season', String(season)); query.set('episode', String(episode)); }
      return cached(lookups, query.toString(), 3600000, 200, async () => {
        const data = JSON.parse(await read(`https://subs.wing.st/subtitles?${query}`));
        return chooseTracks(Array.isArray(data.subtitles) ? data.subtitles : []);
      });
    },
    cues(url) {
      // At most eight 4 MiB source files, parsed on demand; no video cache.
      return cached(files, url, 3600000, 8, async () => parseSubtitles((await read(url)).toString('utf8')));
    },
    timeline(master, upstream, headers = {}) {
      return cached(timelines, JSON.stringify([upstream, headers]), 300000, 100, async () => {
        const isMaster = /#EXT-X-STREAM-INF:/.test(master);
        const variant = isMaster ? master.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#')) : null;
        const url = variant ? new URL(variant.trim(), upstream).href : upstream;
        const playlist = isMaster ? (await read(url, MAX_BYTES, false, headers)).toString('utf8') : master;
        if (!playlist.includes('#EXT-X-ENDLIST')) throw new Error('Sidecar subtitles require a complete VOD playlist.');
        if (/#EXT-X-DISCONTINUITY(?:\r?\n|$)/.test(playlist)) throw new Error('Sidecar timing across discontinuities is not supported.');
        const duration = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
        if (!(duration > 0 && duration < 172800)) throw new Error('Invalid video duration.');
        const first = playlist.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
        const initURL = playlist.match(/#EXT-X-MAP:.*URI="([^"]+)"/)?.[1];
        let pts = 0;
        if (first && !/#EXT-X-KEY:.*METHOD=(?!NONE)/.test(playlist)) {
          const [segment, init] = await Promise.all([read(new URL(first.trim(), url).href, 65536, true, headers), initURL ? read(new URL(initURL, url).href, 1024 * 1024, false, headers) : null]);
          pts = initialTimestamp(segment, init);
        }
        return { duration, pts };
      });
    },
  };
}
