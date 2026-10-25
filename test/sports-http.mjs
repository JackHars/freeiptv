import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('sports Xtream import, EPG, live M3U, auth and live HLS proxy preserve quality/headers/ranges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cinejoy-sports-http-'));
  process.env.FREEIPTV_DATA_DIR = directory;
  const { initializeIPTV } = await import('../api/iptv.mjs');
  const { createServer } = await import('../server.mjs');
  const { settingsStore } = await import('../api/settings.mjs');
  const referer = 'https://player.test/embed', origin = 'https://player.test';
  const upstream = http.createServer((req, res) => {
    if (req.headers.referer !== referer || req.headers.origin !== origin) { res.writeHead(403); return res.end('Missing player headers'); }
    if (req.url === '/master.m3u8') return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1920x1080\nhigh.m3u8\n');
    if (req.url === '/high.m3u8') return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:6,\nvideo.ts\n');
    if (req.url === '/key') return res.end(Buffer.alloc(16, 42));
    if (req.url === '/video.ts') { const body = Buffer.alloc(188 * 2, 0x47); if (req.headers.range) { res.writeHead(206, { 'Content-Range': 'bytes 0-31/376' }); return res.end(body.subarray(0, 32)); } res.setHeader('Content-Length', body.length); return res.end(req.method === 'HEAD' ? undefined : body); }
    res.writeHead(404); res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const remote = `http://127.0.0.1:${upstream.address().port}`;
  const now = Math.floor(Date.now() / 1000);
  const event = { host: 'sports.test', sport: 'nba', slug: 'nba/2026-10-22/test-match', title: 'Test Match & Teams', starts_at: now - 60, ends_at: now + 3600, has_payload: true, stream_url: remote + '/master.m3u8', pageURL: referer };
  const source = { async list(sport) { return { events: sport === 'nba' ? [event, { ...event, slug: 'nba/2026-10-22/upcoming-match', title: 'Upcoming Match', has_payload: false, stream_url: null, starts_at: now + 1800 }] : [], errors: [] }; }, async resolve(e) { return e; }, async hls(e) { return { url: e.stream_url, headers: { referer, origin } }; } };
  let server;
  const requests = [];
  try {
    await initializeIPTV({ sportsDirectory: directory, sportsSource: source });
    await settingsStore.setTMDBCredential('fixture-tmdb-credential');
    const settings = settingsStore.get();
    server = createServer({ onRequest: event => requests.push(event) }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/iptv', '/docs', '/iptv/setup']) {
      assert.equal((await fetch(base + path)).status, 404, `${path} should not expose legacy UI`);
    }
    const auth = new URLSearchParams({ username: settings.username, password: settings.password });
    async function api(action, extra = {}, post = false) {
      const params = new URLSearchParams({ ...Object.fromEntries(auth), action, ...extra });
      const r = await fetch(base + '/player_api.php' + (post ? '' : '?' + params), post ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params } : {});
      assert.equal(r.status, 200); return r.json();
    }
    const categories = await api('get_live_categories'), rows = await api('get_live_streams');
    assert.equal(rows.length, 2); assert.equal(categories.length, 1); assert.equal(rows[0].category_id, categories[0].category_id);
    assert.deepEqual(await api('get_live_streams', {}, true), rows);
    assert.deepEqual(await api('get_live_streams', { category_id: 'missing' }), []);
    const guide = await api('get_short_epg', { stream_id: rows[0].stream_id }); assert.equal(guide.epg_listings[0].channel_id, rows[0].epg_channel_id);
    const xml = await fetch(base + '/xmltv.php?' + auth).then(r => r.text()); assert.match(xml, /Test Match &amp; Teams/); assert.match(xml, /<programme /);
    const playlist = await fetch(base + '/get.php?' + auth + '&content=live&output=m3u8').then(r => r.text()); assert.ok(playlist.includes(rows[0].direct_source)); assert.ok(playlist.includes('tvg-id="' + rows[0].epg_channel_id + '"')); assert.ok(!playlist.includes('/movie/'));
    let r = await fetch(rows[0].direct_source); assert.equal(r.status, 200); const master = await r.text(); assert.equal(master.match(/#EXT-X-STREAM-INF:/g).length, 1); assert.match(master, /1920x1080/);
    const variant = master.split('\n').find(l => l.startsWith('http')); const media = await fetch(variant).then(r => r.text()); assert.match(media, /MEDIA-SEQUENCE:10/); assert.doesNotMatch(media, /ENDLIST/);
    const keyURL = media.match(/URI="([^"]+)"/)[1]; r = await fetch(keyURL); assert.equal(r.status, 200); assert.equal((await r.arrayBuffer()).byteLength, 16);
    const segment = media.split('\n').find(l => l.startsWith('http')); r = await fetch(segment, { headers: { Range: 'bytes=0-31' } }); assert.equal(r.status, 206); assert.equal((await r.arrayBuffer()).byteLength, 32);
    assert.equal((await fetch(segment, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(rows[0].direct_source.replace(encodeURIComponent(settings.password), 'wrong'))).status, 401);
    r = await fetch(rows[1].direct_source); assert.equal(r.status, 503); assert.equal(r.headers.get('retry-after'), '30'); assert.match((await r.json()).error, /not started/);
    assert.equal((await fetch(rows[0].direct_source.replace('.m3u8', '.ts'))).status, 415);
    assert.ok(requests.some(request => request.target === '/player_api.php?action=get_live_streams' && request.status === 200));
    assert.ok(requests.some(request => request.target.startsWith('/live/[login]/')));
    assert.ok(requests.every(request => !request.target.includes(settings.password)));
  } finally {
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
