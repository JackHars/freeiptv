import { settingsStore, problem } from './settings.mjs';

const API = 'https://api.themoviedb.org/3';
export const tmdbConfigured = () => Boolean(settingsStore.config().metadata?.tmdbCredential);
export function requireTMDBCredential() {
  const credential = settingsStore.config().metadata?.tmdbCredential;
  if (!credential) throw problem(503, 'No TMDB fallback credential is configured. Add one in Settings → Metadata.');
  return credential;
}
export function normalizeTMDBCredential(value) {
  const credential = typeof value === 'string' ? value.trim().replace(/^Bearer\s+/i, '') : '';
  if (!/^[A-Za-z0-9._-]{16,4096}$/.test(credential)) throw problem(400, 'Enter your TMDB API key or API Read Access Token.');
  return credential;
}
export async function requestTMDB(path, extra = {}, { credential = requireTMDBCredential(), signal, validating = false } = {}) {
  const params = new URLSearchParams({ language: 'en-US', ...extra });
  params.delete('api_key');
  const headers = { accept: 'application/json', 'user-agent': 'FreeIPTV' };
  if (/^[a-f0-9]+$/i.test(credential)) params.set('api_key', credential);
  else headers.authorization = `Bearer ${credential}`;
  let response;
  try {
    response = await fetch(`${API}${path}?${params}`, { headers, signal: AbortSignal.any([AbortSignal.timeout(validating ? 15000 : 30000), ...(signal ? [signal] : [])]) });
  } catch {
    signal?.throwIfAborted();
    throw problem(503, 'Could not reach TMDB. Check your connection and try again.');
  }
  if ([401, 403].includes(response.status)) throw problem(validating ? 400 : 503, 'TMDB rejected this credential. Check your API key or Read Access Token in Settings → Metadata.');
  if (!response.ok) throw problem(503, `TMDB is unavailable (HTTP ${response.status}). Try again later.`);
  try { return await response.json(); }
  catch { throw problem(502, 'TMDB returned an unreadable response. Try again later.'); }
}
export async function validateTMDBCredential(value) {
  const credential = normalizeTMDBCredential(value);
  const data = await requestTMDB('/configuration', {}, { credential, validating: true });
  if (!data.images?.secure_base_url) throw problem(502, 'TMDB returned an unexpected response. The credential was not saved.');
  return credential;
}
export async function saveTMDBCredential(value) {
  const credential = await validateTMDBCredential(value);
  await settingsStore.setTMDBCredential(credential);
}
