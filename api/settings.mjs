import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const providerNames = ['cinejoy', 'atlantic', 'tvids', 'zstream', 'vidrift', 'vidsrc'];
export const dataDirectory = process.env.FREEIPTV_DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
export const defaultConfig = () => ({
  server: { name: 'FreeIPTV', host: '0.0.0.0', port: 8091, publicUrl: '' },
  playback: { order: [...providerNames], enabled: [...providerNames], providerTimeout: 30, totalTimeout: 180, cacheSeconds: 300, quality: 'highest' },
  catalog: { pages: 2000, refreshHours: 12 },
  metadata: { tmdbCredential: '', tmdbFallback: false },
});
export const problem = (status, message) => Object.assign(new Error(message), { status });
export function equal(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); }
export function activeUser(user) { return user && user.enabled && (!user.expiresAt || Date.parse(user.expiresAt) > Date.now()); }
export function publicUser({ password, ...user }) { return user; }
export function validateLogin(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_-]{3,32}$/.test(username)) throw problem(400, 'Use 3–32 letters, numbers, underscores, or hyphens for the username.');
  if (typeof password !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(password)) throw problem(400, 'Use 8–128 printable characters without spaces for the password.');
}
function validateConfig(config) {
  const { server, playback, catalog, metadata } = config;
  const number = (value, min, max, label) => { if (!Number.isInteger(value) || value < min || value > max) throw problem(400, `${label} must be between ${min} and ${max}.`); };
  if (typeof server.name !== 'string' || !server.name.trim() || server.name.length > 64) throw problem(400, 'Server name must be 1–64 characters.');
  if (typeof server.host !== 'string' || !/^[a-zA-Z0-9.:[\]-]{1,253}$/.test(server.host)) throw problem(400, 'Enter a valid listen address.');
  number(server.port, 1, 65535, 'Port');
  if (typeof server.publicUrl !== 'string') throw problem(400, 'Invalid server URL.');
  if (server.publicUrl) {
    let u; try { u = new URL(server.publicUrl); } catch { throw problem(400, 'Use a complete http:// or https:// server URL.'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw problem(400, 'The server URL must contain only a protocol, hostname, and optional port.');
    server.publicUrl = u.origin;
  }
  if (!Array.isArray(playback.order) || playback.order.length !== providerNames.length || new Set(playback.order).size !== providerNames.length || playback.order.some(p => !providerNames.includes(p))) throw problem(400, 'Fallback order must include each provider once.');
  if (!Array.isArray(playback.enabled) || !playback.enabled.length || new Set(playback.enabled).size !== playback.enabled.length || playback.enabled.some(p => !providerNames.includes(p))) throw problem(400, 'Enable at least one valid provider.');
  number(playback.providerTimeout, 5, 90, 'Provider timeout'); number(playback.totalTimeout, 10, 360, 'Overall timeout');
  if (playback.totalTimeout < playback.providerTimeout) throw problem(400, 'Overall timeout must be at least the provider timeout.');
  number(playback.cacheSeconds, 0, 1800, 'Cache time');
  if (!['highest', 'adaptive'].includes(playback.quality)) throw problem(400, 'Invalid quality preference.');
  number(catalog.pages, 1, 2000, 'Catalog pages'); number(catalog.refreshHours, 1, 168, 'Refresh interval');
  if (typeof metadata.tmdbFallback !== 'boolean') throw problem(400, 'Invalid TMDB fallback setting.');
  if (metadata.tmdbFallback && !metadata.tmdbCredential) throw problem(400, 'Save a TMDB credential before enabling its fallback.');
}
export function createSettingsStore(directory) {
  const events = new EventEmitter(); let state, init, queue = Promise.resolve();
  const save = async next => {
    const owner = next.users.find(u => u.id === next.ownerId);
    if (!owner || !activeUser(owner) || owner.role !== 'admin') throw problem(400, 'The owner account must remain an active administrator.');
    Object.assign(next, { username: owner.username, password: owner.password });
    await writeFile(join(directory, 'iptv.json.tmp'), JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(join(directory, 'iptv.json.tmp'), join(directory, 'iptv.json'));
    state = next; events.emit('change');
  };
  const initialize = (legacy = {}) => init ||= (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { state = JSON.parse(await readFile(join(directory, 'iptv.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; state = { username: 'cinejoy', password: randomBytes(12).toString('base64url'), secret: randomBytes(32).toString('hex'), createdAt: String(Math.floor(Date.now()/1000)), pinned: [] }; }
    if (!state.username || !state.password || !state.secret) throw new Error('IPTV account configuration is incomplete.');
    if (!state.users) {
      try { await copyFile(join(directory, 'iptv.json'), join(directory, 'iptv.pre-users.json'), constants.COPYFILE_EXCL); } catch (e) { if (!['ENOENT','EEXIST'].includes(e.code)) throw e; }
      const id = randomUUID(); state.ownerId = id;
      state.users = [{ id, username: state.username, password: state.password, role: 'admin', enabled: true, expiresAt: null, version: 1, createdAt: state.createdAt }];
    }
    const defaults = defaultConfig();
    defaults.server = { ...defaults.server, ...Object.fromEntries(['host','port'].filter(k => legacy[k] !== undefined).map(k => [k, legacy[k]])) };
    if (legacy.iptv?.catalogPages) defaults.catalog.pages = legacy.iptv.catalogPages;
    if (legacy.iptv?.refreshHours) defaults.catalog.refreshHours = legacy.iptv.refreshHours;
    state.config ||= defaults; state.config.metadata = { ...defaults.metadata, ...state.config.metadata }; state.pinned ||= [];
    await save(state); return state;
  })();
  const mutate = operation => {
    const task = queue.then(async () => { await initialize(); const next = structuredClone(state); await operation(next); await save(next); return state; });
    queue = task.catch(() => {}); return task;
  };
  return {
    events, initialize, mutate,
    get: () => state,
    config: () => state?.config || defaultConfig(),
    publicConfig() {
      const config = structuredClone(state?.config || defaultConfig());
      config.metadata = { configured: Boolean(config.metadata.tmdbCredential), tmdbFallback: config.metadata.tmdbFallback };
      return config;
    },
    async setTMDBCredential(credential) {
      if (typeof credential !== 'string' || (credential && !/^[A-Za-z0-9._-]{16,4096}$/.test(credential))) throw problem(400, 'Invalid TMDB credential.');
      return mutate(next => { next.config.metadata.tmdbCredential = credential; if (!credential) next.config.metadata.tmdbFallback = false; });
    },
    user: id => state?.users.find(u => u.id === id),
    authenticate(username, password) { return state?.users.find(u => activeUser(u) && equal(u.username, username) && equal(u.password, password)); },
    async configure(config) {
      if ('metadata' in config && (!config.metadata || typeof config.metadata !== 'object' || Array.isArray(config.metadata) || Object.keys(config.metadata).some(key => key !== 'tmdbFallback'))) throw problem(400, 'Use Metadata settings to validate and save your TMDB credential.');
      return mutate(next => { const merged = structuredClone(next.config); for (const section of ['server','playback','catalog','metadata']) if (config[section]) merged[section] = { ...merged[section], ...config[section] }; validateConfig(merged); next.config = merged; });
    },
    async upsertUser(input, actor, id) {
      let result;
      await mutate(next => {
        const prior = id ? next.users.find(u => u.id === id) : null;
        if (id && !prior) throw problem(404, 'User not found.');
        if (!actor || (actor.role !== 'admin' && actor.id !== id)) throw problem(403, 'Administrator access required.');
        const username = input.username ?? prior?.username, password = input.password || prior?.password;
        validateLogin(username, password);
        if (next.users.some(u => u.id !== id && u.username.toLowerCase() === username.toLowerCase())) throw problem(409, 'That username is already in use.');
        const role = input.role ?? prior?.role ?? 'viewer';
        if (!['admin','viewer'].includes(role)) throw problem(400, 'Invalid user role.');
        const enabled = input.enabled ?? prior?.enabled ?? true;
        if (typeof enabled !== 'boolean') throw problem(400, 'Invalid account status.');
        const expiresAt = input.expiresAt !== undefined ? input.expiresAt : prior?.expiresAt ?? null;
        if (expiresAt !== null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) throw problem(400, 'Invalid expiry date.');
        if (actor.role !== 'admin' && (role !== prior.role || enabled !== prior.enabled || expiresAt !== prior.expiresAt)) throw problem(403, 'Only an administrator can change account permissions.');
        result = { id: prior?.id || randomUUID(), username, password, role, enabled, expiresAt, version: (prior?.version || 0) + 1, createdAt: prior?.createdAt || String(Math.floor(Date.now()/1000)) };
        if (result.id === next.ownerId && (role !== 'admin' || !enabled || expiresAt)) throw problem(400, 'The owner account cannot be disabled, expired, or demoted.');
        if (result.id === actor.id && (!enabled || role !== actor.role || (expiresAt && Date.parse(expiresAt) <= Date.now()))) throw problem(400, 'You cannot remove your own access.');
        if (prior) next.users[next.users.indexOf(prior)] = result; else next.users.push(result);
      });
      return result;
    },
    async removeUser(id, actor) {
      return mutate(next => { if (actor.role !== 'admin') throw problem(403, 'Administrator access required.'); if (id === next.ownerId || id === actor.id) throw problem(400, 'You cannot delete the owner or your own account.'); if (!next.users.some(u => u.id === id)) throw problem(404, 'User not found.'); next.users = next.users.filter(u => u.id !== id); });
    },
  };
}
export const settingsStore = createSettingsStore(dataDirectory);
