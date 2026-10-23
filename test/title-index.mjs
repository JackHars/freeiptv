import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createTitleIndex } from '../api/title-index.mjs';

test('bulk title cache is searchable offline, persists, filters adult entries, and survives failed updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cinejoy-title-test-'));
  let today = new Date('2026-10-22T12:00:00Z'), fail = false, index;
  const fetcher = async (url, options = {}) => {
    if (options.method === 'HEAD') return new Response(null, { status: 200 });
    if (fail && url.includes('tv_series')) return new Response('failure', { status: 503 });
    const rows = url.includes('tv_series')
      ? [{ id: 603, original_name: 'Matrix TV', popularity: 2 }]
      : [{ id: 603, original_title: 'The Matrix', popularity: 20 }, { id: 604, original_title: 'Amélie', popularity: 10 }, { id: 605, original_title: '映画', popularity: 5 }, { id: 606, original_title: 'Hidden adult title', adult: true }];
    return new Response(gzipSync(rows.map(row => JSON.stringify(row)).join('\n')));
  };
  try {
    index = createTitleIndex({ directory, fetcher, now: () => today });
    await index.initialize();
    assert.deepEqual(index.search('Matrix'), []);
    await index.refresh();
    assert.equal(index.status().movies, 3);
    assert.equal(index.status().series, 1);
    assert.equal(index.search('Matrix').length, 2);
    assert.equal(index.search('Matrix', 'movie')[0].tmdb, 603);
    assert.equal(index.search('amelie')[0].title, 'Amélie');
    assert.equal(index.search('映画')[0].title, '映画');
    assert.deepEqual(index.search('adult'), []);
    assert.deepEqual(index.search('" OR *'), []);
    index.close();
    index = createTitleIndex({ directory, fetcher, now: () => today });
    await index.initialize();
    assert.equal(index.search('Matrix', 'tv')[0].type, 'tv');
    today = new Date('2026-10-23T12:00:00Z'); fail = true;
    await assert.rejects(index.refresh(), /HTTP 503/);
    assert.equal(index.status().exportDate, '2026-10-22');
    assert.equal(index.search('Matrix', 'movie')[0].title, 'The Matrix');
    assert.equal(index.status().refreshing, false);
  } finally { index?.close(); await rm(directory, { recursive: true, force: true }); }
});
