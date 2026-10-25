import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

test('TMDB requires an owned credential, validates changes, supports both auth methods and never returns the saved secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freeiptv-tmdb-'));
  process.env.FREEIPTV_DATA_DIR = directory;
  const { settingsStore, createSettingsStore } = await import('../api/settings.mjs');
  const { saveTMDBCredential, tmdbConfigured, normalizeTMDBCredential } = await import('../api/tmdb.mjs');
  const { getCatalogData } = await import('../api/platform.mjs');
  const original = globalThis.fetch, seen = [];
  let reject = false;
  try {
    await settingsStore.initialize();
    assert.equal(tmdbConfigured(), false);
    globalThis.fetch = async (url, options) => {
      seen.push({ url: new URL(url), headers: options.headers });
      if (reject) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify(new URL(url).pathname.endsWith('/configuration') ? { images: { secure_base_url: 'https://image.tmdb.org/t/p/' } } : { id: 550, title: 'Fixture' }));
    };
    await assert.rejects(getCatalogData('/movie/550'), { status: 428, code: 'TMDB_SETUP_REQUIRED' });
    assert.equal(seen.length, 0, 'no fallback key or anonymous request');
    const v3 = 'a'.repeat(32), bearer = 'fixture.header.signature';
    await saveTMDBCredential(v3);
    assert.equal(seen.at(-1).url.searchParams.get('api_key'), v3);
    assert.equal(seen.at(-1).headers.authorization, undefined);
    await getCatalogData('/movie/550'); const cached = seen.length;
    await getCatalogData('/movie/550'); assert.equal(seen.length, cached);
    await saveTMDBCredential('Bearer ' + bearer);
    assert.equal(seen.at(-1).headers.authorization, 'Bearer ' + bearer);
    assert.equal(seen.at(-1).url.searchParams.has('api_key'), false);
    await getCatalogData('/movie/550'); assert.equal(seen.length, cached + 2, 'new credential cannot reuse the old metadata cache');
    assert.ok(!JSON.stringify(settingsStore.publicConfig()).includes(bearer));
    assert.deepEqual(settingsStore.publicConfig().metadata, { configured: true });
    const restored = createSettingsStore(directory); await restored.initialize();
    assert.equal(restored.config().metadata.tmdbCredential, bearer);
    reject = true;
    await assert.rejects(saveTMDBCredential('invalid.fixture.token'), { status: 400 });
    assert.equal(settingsStore.config().metadata.tmdbCredential, bearer, 'failed validation preserves the existing credential');
    globalThis.fetch = async () => { throw Error('network failure containing ' + bearer); };
    await assert.rejects(saveTMDBCredential('new.fixture.token'), error => error.status === 503 && !error.message.includes(bearer));
    assert.equal(settingsStore.config().metadata.tmdbCredential, bearer);
    for (const input of ['', null, 'has spaces in the token', 'a\r\nb']) assert.throws(() => normalizeTMDBCredential(input), { status: 400 });
    await settingsStore.configure({server:{name:'My server'}});
    assert.equal(settingsStore.config().metadata.tmdbCredential, bearer);
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});

test('an existing installation without TMDB exits before starting or warming the server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freeiptv-setup-required-'));
  try {
    const { createSettingsStore } = await import('../api/settings.mjs');
    await createSettingsStore(directory).initialize();
    const child = spawn(process.execPath, [fileURLToPath(new URL('../start.mjs', import.meta.url))], { env: { ...process.env, FREEIPTV_DATA_DIR: directory, PORT: '0' }, stdio: ['ignore','pipe','pipe'] });
    const timeout = setTimeout(() => child.kill(), 10000);
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const code = await new Promise(resolve => child.once('close', resolve)); clearTimeout(timeout);
    assert.equal(code, 1); assert.match(output, /TMDB setup is required/); assert.doesNotMatch(output, /IPTV server:/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
