import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitles, subtitlePlaylist, subtitleSegment, chooseTracks, attachSubtitles, initialTimestamp, createSubtitleService } from '../api/subtitles.mjs';
const sample = '\uFEFF1\r\n00:00:59,500 --> 00:01:01,250\r\n{\\an8}<font color="red"><i>A test caption.</i></font>\r\n\r\n2\r\n00:01:20,000 --> 00:01:22,000\r\nAnother caption.\r\n';

test('SRT conversion preserves Unicode, formatting and cues across segment boundaries', () => {
  const cues = parseSubtitles(sample);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].body, '<i>A test caption.</i>');
  for (const index of [0, 1]) {
    const segment = subtitleSegment(cues, index, 121, 126000);
    assert.match(segment, /^WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000\n\n/);
    assert.match(segment, /00:00:59.500 --> 00:01:01.250/);
  }
  assert.doesNotMatch(subtitleSegment(cues, 0, 121), /Another caption/);
  assert.equal(parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000 align:start\nCafé 日本語\n')[0].settings, 'align:start');
  assert.throws(() => parseSubtitles('<html>An error</html>'), /HTML/);
  assert.throws(() => parseSubtitles('Error'), /No supported/);
});

test('subtitle VOD playlists cover the full video and support seeking', () => {
  const playlist = subtitlePlaylist(125.25);
  assert.match(playlist, /#EXT-X-TARGETDURATION:60/);
  assert.deepEqual([...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(m => Number(m[1])), [60, 60, 5.25]);
  assert.match(playlist, /segment-2.vtt\n#EXT-X-ENDLIST\n$/);
  assert.match(subtitlePlaylist(8.1), /#EXT-X-TARGETDURATION:9/);
  assert.throws(() => subtitleSegment([], 3, 125.25), { status: 404 });
  assert.throws(() => subtitleSegment([], -1, 125.25), { status: 404 });
  assert.throws(() => subtitlePlaylist(NaN));
});

test('language selection retains English alternatives and avoids split releases first', () => {
  const rows = [
    ...['Film.CD1.srt', 'Film.srt', 'Film.2.srt', 'Film.3.srt'].map((display, i) => ({ display, type: 'srt', language: 'en', url: `https://test/${i}` })),
    { language: 'fr', type: 'vtt', url: 'https://test/fr' }, { language: 'fr', type: 'vtt', url: 'https://test/fr2' },
    { language: 'en', type: 'srt', url: 'javascript:bad' }, { language: 'en', type: 'ass', url: 'https://test/ass' },
  ];
  const tracks = chooseTracks(rows);
  assert.equal(tracks.length, 4); assert.equal(tracks[0].url, 'https://test/1');
  assert.deepEqual(tracks.map(t => t.name), ['English', 'English (2)', 'English (3)', 'French']);
});

test('every quality references subtitles while audio and existing native captions survive', () => {
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Stereo",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2000,AUDIO="audio"\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow.m3u8\n';
  const result = attachSubtitles(master, [{ name: 'English', language: 'en' }, { name: 'English (2)', language: 'en' }], t => `http://local/${encodeURIComponent(t.name)}.m3u8`);
  assert.equal(result.match(/SUBTITLES="cinejoy-subs"/g).length, 2);
  assert.match(result, /NAME="English",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=NO/);
  assert.match(result, /NAME="English \(2\)",LANGUAGE="en",AUTOSELECT=NO/);
  assert.match(result, /AUDIO="audio",SUBTITLES/);
  assert.match(result, /URI="audio.m3u8"/);
  const native = master.replace('#EXTM3U', '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="Native"');
  assert.equal(attachSubtitles(native, [{}], () => ''), native);
  assert.equal(attachSubtitles(master, [], () => ''), master);
});

function box(type, ...data) { const payload = Buffer.concat(data), header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4); return Buffer.concat([header, payload]); }
test('WebVTT mapping reads nonzero TS presentation and fMP4 decode clocks', () => {
  const ts = Buffer.alloc(188, 0xff), pts = 900000;
  ts.set([0x47, 0x40, 0, 0x10, 0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]);
  ts.set([0x21 | (Math.floor(pts / 1073741824) << 1), Math.floor(pts / 4194304) & 255, ((Math.floor(pts / 32768) & 127) << 1) | 1, Math.floor(pts / 128) & 255, ((pts & 127) << 1) | 1], 13);
  assert.equal(initialTimestamp(ts), pts);
  const tkhd = Buffer.alloc(24), mdhd = Buffer.alloc(24), tfhd = Buffer.alloc(8), tfdt = Buffer.alloc(12);
  tkhd.writeUInt32BE(1, 12); mdhd.writeUInt32BE(48000, 12); tfhd.writeUInt32BE(1, 4); tfdt[0] = 1; tfdt.writeBigUInt64BE(96000n, 4);
  const init = box('moov', box('trak', box('tkhd', tkhd), box('mdia', box('mdhd', mdhd))));
  const segment = box('moof', box('traf', box('tfhd', tfhd), box('tfdt', tfdt)));
  assert.equal(initialTimestamp(segment, init), 180000);
});

test('movie/episode lookup, concurrent cache, retry, body limits and non-VOD fallback', async () => {
  const calls = []; let fail = true;
  const service = createSubtitleService({ fetchResource: async url => {
    calls.push(url);
    if (url.includes('/subtitles?')) return Response.json({ subtitles: [{ language: 'en', type: 'srt', url: 'https://test/caption' }] });
    if (url.endsWith('/caption')) return new Response(sample);
    if (url.endsWith('/retry') && fail) { fail = false; return new Response('Error', { status: 503 }); }
    if (url.endsWith('/huge')) return new Response('x'.repeat(4 * 1024 * 1024 + 1));
    return new Response(sample);
  } });
  await Promise.all([service.tracks({ kind: 'series', tmdb: 1396, season: 2, episode: 4 }), service.tracks({ kind: 'series', tmdb: 1396, season: 2, episode: 4 })]);
  assert.equal(calls.length, 1); assert.match(calls[0], /type=tv&tmdb=1396&season=2&episode=4/);
  await service.tracks({ kind: 'movie', tmdb: 603 }); assert.match(calls[1], /type=movie&tmdb=603$/);
  const [a, b] = await Promise.all([service.cues('https://test/caption'), service.cues('https://test/caption')]); assert.equal(a, b);
  await assert.rejects(service.cues('https://test/retry'), /503/); assert.equal((await service.cues('https://test/retry')).length, 2);
  await assert.rejects(service.cues('https://test/huge'), /too large/);
  await assert.rejects(service.timeline('#EXTM3U\n#EXTINF:6,\nsegment.ts\n', 'https://test/live'), /complete VOD/);
});
