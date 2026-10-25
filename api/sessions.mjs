import { randomBytes } from 'node:crypto';
import { settingsStore, activeUser, problem } from './settings.mjs';

const sessions = new Map();
const attempts = new Map();
const ttl = 12 * 3600000;
export function requestOrigin(req) {
  const host = req.headers.host;
  if (!host || /[\s/\\@?#]/.test(host)) throw problem(400, 'Invalid Host header.');
  return new URL(`http://${host}`).origin;
}
export function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== requestOrigin(req))) throw problem(403, 'Open this page from the FreeIPTV server.');
}
export function sessionUser(req) {
  const token = /(?:^|;\s*)freeiptv_session=([a-zA-Z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
  const entry = sessions.get(token);
  if (!entry) return null;
  const user = settingsStore.user(entry.id);
  if (entry.expires < Date.now() || !activeUser(user) || user.version !== entry.version) { sessions.delete(token); return null; }
  return user;
}
export function requireSession(req, admin = false) {
  const user = sessionUser(req);
  if (!user) throw problem(401, 'Sign in to continue.');
  if (admin && user.role !== 'admin') throw problem(403, 'Administrator access required.');
  return user;
}
export function issueSession(res, user) {
  for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
  while (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { id: user.id, version: user.version, expires: Date.now() + ttl });
  res.setHeader('Set-Cookie', `freeiptv_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl/1000}`);
}
export function signOut(req, res) {
  const token = /(?:^|;\s*)freeiptv_session=([a-zA-Z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
  sessions.delete(token); res.setHeader('Set-Cookie', 'freeiptv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}
export function login(req, res, username, password) {
  const key = req.socket.remoteAddress || 'local'; const now = Date.now();
  let entry = attempts.get(key);
  if (!entry || entry.expires < now) entry = { count: 0, expires: now + 60000 };
  if (entry.count >= 15) throw problem(429, 'Too many attempts. Try again in a minute.');
  const user = settingsStore.authenticate(username, password);
  if (!user) { entry.count++; attempts.set(key, entry); if (attempts.size > 1000) attempts.delete(attempts.keys().next().value); throw problem(401, 'The username or password is incorrect, or the account is inactive.'); }
  attempts.delete(key); issueSession(res, user); return user;
}
