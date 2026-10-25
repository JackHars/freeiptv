import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Network fixtures exercise the real HTTP routes, resolver, signed relay and player headers.
test('movie playback and legacy API relay keep provider headers on nested HLS, audio, keys, maps and byte ranges', async () => {
  const fetchOriginal = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'freeiptv-providers-'));
  process.env.FREEIPTV_DATA_DIR = directory;
  const { initializeIPTV } = await import('../api/iptv.mjs');
  const { createServer } = await import('../server.mjs');
  const { settingsStore } = await import('../api/settings.mjs');
  const required = { origin: 'https://provider.test', referer: 'https://provider.test/player' };
  const observed = [];
  let unstableReads = 0, cinejoyRequests = 0;
  const video = Buffer.alloc(188 * 4, 0x47);
  const upstream = http.createServer((req, res) => {
    observed.push(req.url);
    const correct = req.headers.origin === required.origin && req.headers.referer === required.referer;
    const vidrift = req.headers.origin === 'https://7movies.ac' && req.headers.referer === 'https://7movies.ac/';
    if (!correct && !vidrift) { res.writeHead(403); return res.end('missing provider headers'); }
    if (req.url === '/hls/unstable') {
      if (++unstableReads > 1) { res.writeHead(502); return res.end('Source expired after validation'); }
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=20,RESOLUTION=1920x1080\nleaf\n');
    }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/hls/master' }); return res.end(); }
    if (req.url === '/hls/master') return res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="audio"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="subs"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"\n#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=640x360,AUDIO="a",SUBTITLES="s"\nlow\n#EXT-X-STREAM-INF:BANDWIDTH=20,RESOLUTION=1920x1080,AUDIO="a",SUBTITLES="s"\nleaf\n');
    if (req.url === '/hls/leaf' || req.url === '/hls/low' || req.url === '/hls/audio') return res.end('#EXTM3U\n#EXT-X-MAP:URI="init"\n#EXTINF:6,\nseg\n#EXT-X-ENDLIST\n');
    if (req.url === '/hls/subs') return res.end('#EXTM3U\n#EXTINF:6,\nsubtitle.vtt\n#EXT-X-ENDLIST\n');
    if (req.url === '/hls/subtitle.vtt') return res.end('WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n');
    if (req.url === '/hls/key') return res.end(Buffer.alloc(16, 7));
    if (req.url === '/hls/init') return res.end(Buffer.from('000000186674797069736f36', 'hex'));
    if (req.url === '/hls/seg') {
      if (req.headers.range) { res.writeHead(206, { 'Content-Range': 'bytes 0-31/752' }); return res.end(video.subarray(0, 32)); }
      return res.end(req.method === 'HEAD' ? undefined : video);
    }
    res.writeHead(404); res.end('Unexpected fixture path');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const remote = `http://127.0.0.1:${upstream.address().port}`;
  let server, apiCookie;
  try {
    globalThis.fetch = async (url, options) => {
      const u = new URL(url);
      if (u.hostname === '127.0.0.1') return fetchOriginal(url, apiCookie && u.port === String(server?.address()?.port) ? {...options,headers:{...options?.headers,cookie:apiCookie}} : options);
      if (u.hostname === 'api.zstream.mov') {
        const body = JSON.parse(options.body);
        return new Response(JSON.stringify({ streams: [{ type: 'hls', id: 'fixture', playlist: remote + (body.tmdb_id === '551' ? '/hls/unstable' : '/redirect'), headers: required }] }));
      }
      if (u.hostname === 'api.wing.st') { cinejoyRequests++; return new Response('unavailable', { status: 404 }); }
      if (u.hostname === '7movies.ac') return new Response('{"token":"fixture"}');
      if (u.hostname === 'embed.vidrift.net') return new Response(JSON.stringify({ meta: { bigbangUrl: remote + '/hls/master' } }));
      if (u.hostname === 'subs.wing.st') return new Response('{"subtitles":[]}');
      // Let the real dispatcher move past the unavailable providers before Zstream.
      return new Response('Unavailable fixture provider', { status: 404 });
    };
    await initializeIPTV({ sportsDirectory: directory });
    await settingsStore.setTMDBCredential('fixture-tmdb-credential');
    const login = settingsStore.get();
    server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const signedIn = await fetchOriginal(base + '/ui/login', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:login.username,password:login.password})});
    apiCookie = signedIn.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/providers').then(r => r.json())).providers.length, 6);
    for (const path of ['/resolve?tmdb=550&provider=missing', '/resolve?tmdb=550&kind=series']) assert.equal((await fetch(base + path)).status, 400);
    const r = await fetch(base + `/movie/${encodeURIComponent(login.username)}/${encodeURIComponent(login.password)}/550.m3u8`);
    assert.equal(r.status, 200); const master = await r.text();
    assert.match(master, /1920x1080/); assert.doesNotMatch(master, /640x360/);
    const mediaURL = master.split('\n').find(l => l.startsWith('http'));
    const media = await fetch(mediaURL).then(r => r.text());
    const initURL = media.match(/URI="([^"]+)"/)[1]; assert.equal((await fetch(initURL)).status, 200);
    const segmentURL = media.split('\n').find(l => l.startsWith('http'));
    const segment = await fetch(segmentURL, { headers: { Range: 'bytes=0-31' } }); assert.equal(segment.status, 206); assert.equal((await segment.arrayBuffer()).byteLength, 32);
    assert.equal((await fetch(segmentURL, { method: 'HEAD' })).status, 200);
    for (const [, uri] of master.matchAll(/URI="([^"]+)"/g)) assert.equal((await fetch(uri)).status, 200);
    const resolved = await fetch(base + '/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tmdb: 550, kind: 'movie', provider: 'zstream' }) }).then(r => r.json());
    assert.equal(resolved.provider, 'zstream'); assert.deepEqual(resolved.headers, { 'user-agent': resolved.headers['user-agent'], ...required });
    for (const path of [resolved.master_proxied, '/master?tmdb=550&provider=zstream', '/watch?tmdb=550&provider=zstream']) {
      const response = await fetch(base + path); assert.equal(response.status, 200);
      const playlist = await response.text(); const nested = playlist.split('\n').find(l => l.startsWith('/proxy?'));
      assert.ok(nested); assert.equal((await fetch(base + nested)).status, 200);
    }
    assert.ok(observed.includes('/hls/seg')); assert.ok(observed.includes('/hls/key')); assert.ok(observed.includes('/hls/audio'));
    const beforeRetry = cinejoyRequests;
    const retry = await fetch(base + `/movie/${encodeURIComponent(login.username)}/${encodeURIComponent(login.password)}/551.m3u8`);
    assert.equal(retry.status, 200); assert.match(await retry.text(), /1920x1080/);
    assert.equal(unstableReads, 2, 'failed source should not be selected twice');
    assert.equal(cinejoyRequests - beforeRetry, 8, 'fresh fallback retries the earlier unavailable Cinejoy mirrors');
  } finally {
    globalThis.fetch = fetchOriginal;
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
