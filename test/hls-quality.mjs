import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highestQualityPlaylist } from '../api/hls-quality.mjs';
import { attachSubtitles, createSubtitleService } from '../api/subtitles.mjs';

const variant = (attrs, uri) => `#EXT-X-STREAM-INF:${attrs}\n${uri}\n`;
const master = (...variants) => '#EXTM3U\n#EXT-X-VERSION:7\n' + variants.join('');
const uris = playlist => playlist.split('\n').filter(line => line && !line.startsWith('#'));

test('selects highest resolution regardless of order, even over a higher-bitrate smaller video', () => {
  const playlist = master(variant('BANDWIDTH=9000000,RESOLUTION=1920x1080', '1080.m3u8'), variant('BANDWIDTH=3000000,RESOLUTION=1280x720', '720.m3u8'), variant('BANDWIDTH=8000000,RESOLUTION=3840x2160', '4k.m3u8'));
  assert.deepEqual(uris(highestQualityPlaylist(playlist)), ['4k.m3u8']);
  assert.deepEqual(uris(highestQualityPlaylist(master(variant('BANDWIDTH=1000,RESOLUTION=7680x4320', '8k.m3u8'), playlist.slice(playlist.indexOf('#EXT-X-STREAM-INF:'))))), ['8k.m3u8']);
});

test('breaks resolution ties by bitrate, then frame rate; preserves quoted codec lists', () => {
  const codec = 'CODECS="avc1.640028,mp4a.40.2"';
  const playlist = master(variant(`BANDWIDTH=5000000,RESOLUTION=1920x1080,${codec}`, 'low.m3u8'), variant(`BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=24,${codec}`, 'high.m3u8'), variant(`BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60,${codec}`, 'high60.m3u8'));
  const result = highestQualityPlaylist(playlist);
  assert.deepEqual(uris(result), ['high60.m3u8']); assert.ok(result.includes(codec));
});

test('falls back to bandwidth when resolutions are absent, excluding audio-only variants', () => {
  const playlist = master(variant('BANDWIDTH=9000000,CODECS="mp4a.40.2"', 'audio.m3u8'), variant('BANDWIDTH=1000000,CODECS="avc1.640028,mp4a.40.2"', 'low.m3u8'), variant('BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2"', 'high.m3u8'));
  assert.deepEqual(uris(highestQualityPlaylist(playlist)), ['high.m3u8']);
});

test('retains alternate audio, subtitles, session keys, codec attributes and trick-play declarations', () => {
  const declarations = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="en.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French",URI="fr.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subs.m3u8"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=10000,URI="iframes.m3u8"\n';
  const high = variant('BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="audio",SUBTITLES="subs",CLOSED-CAPTIONS=NONE', '1080.m3u8');
  const playlist = master(declarations, variant('BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="audio",SUBTITLES="subs"', '720.m3u8'), high);
  assert.equal(highestQualityPlaylist(playlist), master(declarations, high));
});

test('preserves media playlists, stable ties and comments; handles CRLF', () => {
  const media = '#EXTM3U\r\n#EXTINF:6,\r\nsegment.ts\r\n#EXT-X-ENDLIST\r\n';
  assert.equal(highestQualityPlaylist(media), media);
  const one = master(variant('BANDWIDTH=5000000,RESOLUTION=1920x1080', 'one.m3u8'));
  assert.equal(highestQualityPlaylist(one), one);
  const tied = master(variant('BANDWIDTH=5000000,RESOLUTION=1920x1080', '# comment\nfirst.m3u8'), variant('BANDWIDTH=5000000,RESOLUTION=1920x1080', 'second.m3u8')).replaceAll('\n', '\r\n');
  assert.deepEqual(uris(highestQualityPlaylist(tied)), ['first.m3u8']);
  assert.match(highestQualityPlaylist(tied), /# comment/);
});

test('added subtitles use the selected highest-quality video timeline, not the first lower variant', async () => {
  const calls = [];
  const service = createSubtitleService({ fetchResource: async url => {
    calls.push(url);
    return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:123.5,\nsegment.ts\n#EXT-X-ENDLIST\n');
  } });
  const best = highestQualityPlaylist(master(variant('BANDWIDTH=1000000,RESOLUTION=1280x720', 'low.m3u8'), variant('BANDWIDTH=5000000,RESOLUTION=1920x1080', 'high.m3u8')));
  assert.equal((await service.timeline(best, 'https://video.test/master.m3u8')).duration, 123.5);
  assert.deepEqual(calls, ['https://video.test/high.m3u8']);
  const withSubs = attachSubtitles(best, [{ name: 'English', language: 'en' }], () => 'http://local/subs.m3u8');
  assert.match(withSubs, /SUBTITLES="cinejoy-subs"/);
  assert.deepEqual(uris(withSubs), ['high.m3u8']);
});
