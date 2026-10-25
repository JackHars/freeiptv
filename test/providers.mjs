import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createDecipheriv } from 'node:crypto';
import { createProviderResolver, createProviderContext, PROVIDERS } from '../api/providers.mjs';
import { decryptGCM, decryptVidSrc, vidsrcKey } from '../api/provider-crypto.mjs';

const ts = Buffer.alloc(188 * 4); ts[0] = ts[188] = ts[376] = ts[564] = 0x47;
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=20,RESOLUTION=1920x1080\nleaf.m3u8\n';
const leaf = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n';
const b = (...args) => Buffer.concat(args.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x)));
const leb = n => { const out = []; do { let v = n & 127; n >>>= 7; if (n) v |= 128; out.push(v); } while (n); return Buffer.from(out); };
function wasmFixture() {
  const a = Buffer.alloc(32, 11), z = Buffer.alloc(32, 92);
  const body = b([0, 0x41, 0, 0x28, 2, 0, 0x41, 0x80, 6, 0x28, 2, 0, 0x73, 0x21, 6, 0x0b]);
  const code = b([3], [2, 0, 0x0b], [2, 0, 0x0b], leb(body.length), body);
  const data = b([2, 0, 0x41, 0, 0x0b, 32], a, [0, 0x41, 0x80, 6, 0x0b, 32], z);
  return { wasm: b([0, 97, 115, 109, 1, 0, 0, 0, 10], leb(code.length), code, [11], leb(data.length), data), key: Buffer.alloc(32, 11 ^ 92) };
}
function gcm(key, plain) {
  const iv = Buffer.alloc(12, 7), cipher = createCipheriv('aes-256-gcm', key, iv);
  return b(iv, cipher.update(plain), cipher.final(), cipher.getAuthTag());
}

test('native crypto matches published vectors and extracts relocated WASM tables', () => {
  const gcmVector = Buffer.from('000000000000000000000000cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919', 'hex');
  assert.deepEqual(decryptGCM(Buffer.alloc(32), gcmVector), Buffer.alloc(16));
  gcmVector[gcmVector.length - 1] ^= 1;
  assert.throws(() => decryptGCM(Buffer.alloc(32), gcmVector));
  const cipher = createDecipheriv('chacha20', Buffer.alloc(32), Buffer.alloc(16));
  assert.equal(cipher.update(Buffer.alloc(64)).toString('hex'), '76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7da41597c5157488d7724e03fb8d84a376a43b8f41518a11cc387b669b2ee6586');
  const fixture = wasmFixture(); assert.deepEqual(vidsrcKey(fixture.wasm), fixture.key);
  for (const size of [0, 8, 12, fixture.wasm.length - 1]) assert.throws(() => vidsrcKey(fixture.wasm.subarray(0, size)));
  const nonce = Buffer.alloc(12, 1); nonce[0] = 0xea;
  const plain = Buffer.from('https://cdn.test/movie.m3u8\n');
  const encrypt = createCipheriv('chacha20', fixture.key, b(Buffer.alloc(4), nonce));
  assert.deepEqual(decryptVidSrc(b(nonce, encrypt.update(plain)), fixture.key), plain);
});

function mockProvider(provider, kind, { brokenAthena = false, bait = false } = {}) {
  const calls = [], fixture = wasmFixture();
  const json = value => new Response(JSON.stringify(value));
  const fetchResource = async (value, options = {}) => {
    const url = new URL(value); calls.push({ url, options });
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.hostname === 'zcdn.bluevelvet.space') {
      assert.equal(url.searchParams.get('type'), kind === 'series' ? 'tv' : 'movie');
      if (kind === 'series') { assert.equal(url.searchParams.get('season'), '1'); assert.equal(url.searchParams.get('episode'), '2'); }
      return json({ ready: true, url: brokenAthena ? 'https://cdn.test/bait' : 'https://cdn.test/master' });
    }
    if (url.hostname === 'cdn.hls.lol') return json({ found: false });
    if (url.hostname === 'stream.hls.lol') return json({ sources: { Moscow: { url: 'ms_' + gcm(Buffer.from('55060a042823f51a94c296894a58a0db15f3baef807155140983083fa799ef47', 'hex'), Buffer.from('https://cdn.test/master')).toString('hex') } } });
    if (url.hostname === 'play.xpass.top') {
      const expected = kind === 'movie' ? '/e/movie/550' : '/e/tv/550/1/2';
      if (url.pathname.startsWith('/e/')) { assert.equal(url.pathname, expected); return new Response('<script>var dataUrl="/data/movie/550?token=abc";</script>'); }
      if (url.pathname.startsWith('/data/')) {
        const key = createHash('sha256').update('spv3-data-response|spv3-build-1787821613-50e5fc97c9dce367|/data/movie/550|abc').digest();
        const entries = [{ name: 'bait', url: '/one' }, { name: 'video', url: '/two' }];
        return new Response(gcm(key, Buffer.from(JSON.stringify(entries))).toString('base64url'));
      }
      return json({ playlist: [{ sources: [{ file: url.pathname === '/one' ? 'https://cdn.test/bait-master' : 'https://cdn.test/master' }] }] });
    }
    if (url.hostname === 'api.zstream.mov') {
      assert.equal(body.tmdb_id, '550'); assert.equal(body.type, kind === 'movie' ? 'movie' : 'show');
      assert.equal(body.season, kind === 'movie' ? null : 1);
      return json({ streams: [{ type: 'file', qualities: {} }, { type: 'hls', id: 'lumen', playlist: 'https://cdn.test/master', headers: { Referer: 'https://required.test/', Origin: 'https://required.test' } }] });
    }
    if (url.hostname === '7movies.ac') {
      assert.equal(body.type, kind === 'movie' ? 'movie' : 'tv'); assert.equal(body.episode, kind === 'movie' ? null : 2);
      return json({ token: 'abc+/' });
    }
    if (url.hostname === 'embed.vidrift.net') {
      assert.equal(options.headers['x-embed-parent'], 'https://7movies.ac');
      assert.equal(url.searchParams.get('token'), 'abc+/');
      assert.equal(url.pathname, kind === 'movie' ? '/api/boot/movie/550' : '/api/boot/tv/550/1/2');
      return json({ meta: { bigbangUrl: 'https://cdn.test/master' } });
    }
    if (url.hostname === 'vidsrc.sh') {
      assert.equal(url.searchParams.get('type'), kind === 'movie' ? 'movie' : 'tv');
      if (kind === 'series') { assert.equal(url.searchParams.get('season'), '1'); assert.equal(url.searchParams.get('episode'), '2'); }
      return json({ src: 'https://edge.test/gate' });
    }
    if (url.hostname === 'edge.test') {
      if (url.pathname === '/gate') return new Response('window.CFG = {"playerUrl":"https://edge.test/player"};');
      if (url.pathname === '/player') return new Response('window.CONFIG = ' + JSON.stringify({ [kind === 'series' ? 'streamBase' : 'api']: 'https://edge.test/api?type=' + (kind === 'series' ? 'tv' : 'movie'), apiToken: 'raw+token', nested: { message: 'a brace } inside a string' } }));
      if (url.pathname === '/api') {
        assert.ok(value.endsWith('api_token=raw%2Btoken'));
        if (kind === 'series') { assert.equal(url.searchParams.get('season'), '1'); assert.equal(url.searchParams.get('episode'), '2'); assert.ok(url.searchParams.has('stream_urls')); }
        const nonce = Buffer.alloc(12); nonce[0] = 0xea;
        const enc = createCipheriv('chacha20', fixture.key, b(Buffer.alloc(4), nonce));
        return json({ data: { stream_urls: b(nonce, enc.update('https://cdn.test/master?other=1')).toString('base64') }, vs: { wasm_url: 'https://edge.test/code.wasm' } });
      }
      return new Response(fixture.wasm);
    }
    if (url.hostname === 'cdn.test') {
      if (url.pathname === '/generate.php') return new Response('"host+token"');
      if (provider === 'zstream') assert.equal(options.headers.referer, 'https://required.test/');
      if (provider === 'tvids') assert.equal(options.headers.origin, 'https://play.xpass.top');
      if (provider === 'vidsrc' && url.pathname === '/master') { assert.equal(url.searchParams.get('token'), 'host+token'); assert.equal(url.searchParams.get('other'), '1'); }
      if (url.pathname === '/bait') return new Response('<html>Error</html>');
      if (url.pathname === '/master') return new Response(master);
      if (url.pathname === '/bait-master') return new Response('#EXTM3U\n#EXTINF:6,\nbait.png\n');
      if (url.pathname === '/leaf.m3u8') return new Response(leaf);
      if (url.pathname === '/low.m3u8') throw new Error('Wrong rendition selected');
      return new Response(url.pathname === '/bait.png' || bait ? Buffer.from('89504e470d0a1a0a', 'hex') : ts);
    }
    throw new Error('Unexpected URL ' + url.origin + url.pathname);
  };
  return { fetchResource, calls };
}

for (const provider of PROVIDERS.slice(1)) for (const kind of ['movie', 'series']) {
  test(`${provider} ${kind}: resolves and verifies HLS with provider headers`, async () => {
    const mock = mockProvider(provider, kind);
    const resolver = createProviderResolver({ ...mock, getCatalogData: async path => { assert.match(path, /\/550\/external_ids$/); return { imdb_id: 'tt0137523' }; } });
    const out = await resolver({ tmdb: 550, kind, season: 1, episode: 2, provider });
    assert.equal(out.provider, provider); assert.match(out.master, /^https:\/\/cdn.test\/master/);
    assert.equal(out.variants[0].width, 1920);
    assert.ok(mock.calls.some(c => c.url.pathname === '/seg.ts'));
    if (provider === 'tvids') assert.ok(mock.calls.some(c => c.url.pathname === '/bait.png'));
    const count = mock.calls.length;
    assert.equal((await resolver({ tmdb: 550, kind, season: 1, episode: 2, provider })).cached, true);
    assert.equal(mock.calls.length, count);
    assert.equal((await resolver({ tmdb: 550, kind, season: 1, episode: 2, provider, fresh: true })).cached, false);
    assert.ok(mock.calls.length > count);
  });
}

test('automatic fallback rejects unusable masters and selects Moscow after failed Atlantic mirrors', async () => {
  const resolver = createProviderResolver({ ...mockProvider('atlantic', 'movie', { brokenAthena: true }), cinejoy: async () => { throw new Error('Cinejoy unavailable'); } });
  const out = await resolver({ tmdb: 550, kind: 'movie' });
  assert.equal(out.provider, 'atlantic'); assert.equal(out.server, 'moscow');
  assert.deepEqual(out.provider_order, ['cinejoy', 'atlantic']);
  assert.match(out.provider_errors.cinejoy, /unavailable/);
});

test('bad input makes no network calls; pinning and exclusions are respected', async () => {
  const mock = mockProvider('atlantic', 'movie');
  const resolver = createProviderResolver({ ...mock, cinejoy: async () => { throw new Error('failed'); } });
  for (const input of [{ tmdb: 0 }, { kind: 'other' }, { kind: 'series' }, { provider: 'missing' }, { provider: 'atlantic', server: 'Nebula' }]) {
    await assert.rejects(resolver({ tmdb: 550, kind: 'movie', ...input }), { status: 400 });
  }
  assert.equal(mock.calls.length, 0);
  await assert.rejects(resolver({ tmdb: 550, kind: 'movie', provider: 'cinejoy' }), e => e.provider_order.join() === 'cinejoy');
  const out = await resolver({ tmdb: 550, kind: 'movie', exclude: ['cinejoy'] });
  assert.deepEqual(out.provider_order, ['atlantic']);
});

test('source requests are aborted at the provider deadline and failures are not cached', async () => {
  let calls = 0;
  const fetchResource = (url, { signal }) => new Promise((resolve, reject) => {
    calls++;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const resolver = createProviderResolver({ fetchResource, providerTimeoutMs: 20, totalTimeoutMs: 200 });
  // A live timer keeps the test alive while AbortSignal's unref'ed timer fires.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(resolver({ tmdb: 550, kind: 'movie', exclude: PROVIDERS.filter(p => p !== 'atlantic') }), { status: 502 });
    assert.equal(calls, 2);
  } finally { clearTimeout(keepAlive); }
});

test('HLS validation rejects PNG bait and validates AES-128 encrypted segments', async () => {
  const key = Buffer.alloc(16, 3), iv = Buffer.alloc(16); iv.writeBigUInt64BE(19n, 8);
  const cipher = createCipheriv('aes-128-cbc', key, iv), encrypted = b(cipher.update(ts), cipher.final());
  const ctx = createProviderContext({ signal: AbortSignal.timeout(1000), fetchResource: async url => {
    if (url.endsWith('/master')) return new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:19\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:6,\nseg\n');
    return new Response(url.endsWith('/key') ? key : encrypted);
  } });
  assert.equal((await ctx.accept('https://test/master', {}, 'encrypted')).server, 'encrypted');
  const bad = createProviderContext({ signal: AbortSignal.timeout(1000), fetchResource: mockProvider('atlantic', 'movie', { bait: true }).fetchResource });
  await assert.rejects(bad.accept('https://cdn.test/master', {}, 'bad'), /not video/);
});
