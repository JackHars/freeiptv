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
  const { requestTMDB } = await import('../api/tmdb.mjs');
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
    await assert.rejects(requestTMDB('/movie/550'), { status: 503 });
    assert.equal(seen.length, 0, 'no fallback key or anonymous request');
    const v3 = 'a'.repeat(32), bearer = 'fixture.header.signature';
    await saveTMDBCredential(v3);
    assert.equal(seen.at(-1).url.searchParams.get('api_key'), v3);
    assert.equal(seen.at(-1).headers.authorization, undefined);
    await requestTMDB('/movie/550'); const cached = seen.length;
    await saveTMDBCredential('Bearer ' + bearer);
    assert.equal(seen.at(-1).headers.authorization, 'Bearer ' + bearer);
    assert.equal(seen.at(-1).url.searchParams.has('api_key'), false);
    await requestTMDB('/movie/550'); assert.equal(seen.length, cached + 2);
    assert.ok(!JSON.stringify(settingsStore.publicConfig()).includes(bearer));
    assert.deepEqual(settingsStore.publicConfig().metadata, { configured: true, tmdbFallback: false });
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

test('an existing installation starts without a TMDB credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freeiptv-setup-required-'));
  try {
    const { createSettingsStore } = await import('../api/settings.mjs');
    await createSettingsStore(directory).initialize();
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=async()=>new Response("{}",{status:503});', fileURLToPath(new URL('../start.mjs', import.meta.url))], { env: { ...process.env, FREEIPTV_DATA_DIR: directory, PORT: '0' }, stdio: ['ignore','pipe','pipe'] });
    const timeout = setTimeout(() => child.kill(), 10000);
    let output = ''; child.stdout.on('data', chunk => { output += chunk; if (output.includes('IPTV server:')) child.kill('SIGTERM'); }); child.stderr.on('data', chunk => output += chunk);
    const code = await new Promise(resolve => child.once('close', resolve)); clearTimeout(timeout);
    assert.equal(code, 0); assert.match(output, /IPTV server:/); assert.doesNotMatch(output, /TMDB setup/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
