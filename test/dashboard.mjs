import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDashboard } from '../api/dashboard.mjs';
import { requestLabel } from '../server.mjs';

test('request labels omit logins, media tokens, and sensitive query values', () => {
  assert.equal(requestLabel('/player_api.php?username=alice&password=secret&action=get_vod_streams'), '/player_api.php?action=get_vod_streams');
  assert.equal(requestLabel('/movie/alice/secret/123.m3u8'), '/movie/[login]/123.m3u8');
  assert.equal(requestLabel('/iptv/media/signed-token/segment.ts'), '/iptv/media/[signed]/segment.ts');
  assert.equal(requestLabel('/get.php?username=alice&password=secret'), '/get.php');
});

test('connection box stays above the scrolling request history', () => {
  const details = {
    server: 'http://127.0.0.1:8091', username: 'alice', password: 'secret123',
    playlist: 'http://127.0.0.1:8091/get.php?username=alice&password=secret123&type=m3u_plus&output=m3u8',
    epg: 'http://127.0.0.1:8091/xmltv.php?username=alice&password=secret123',
    sportsPlaylist: 'http://127.0.0.1:8091/get.php?username=alice&password=secret123&type=m3u_plus&output=m3u8&content=live',
  };
  const screen = renderDashboard(details, Array.from({ length: 30 }, (_, n) => `request ${n}`), 100, 24);
  const lines = screen.split('\n');
  assert.match(lines[0], /^┌/);
  assert.ok(lines.findIndex(line => line.includes('Username:')) < lines.findIndex(line => line.includes('Incoming requests')));
  assert.ok(lines.findIndex(line => line.includes('Incoming requests')) < lines.findIndex(line => line.includes('request 29')));
  assert.ok(!screen.includes('request 0'));
  assert.ok(lines.length <= 24);
});
