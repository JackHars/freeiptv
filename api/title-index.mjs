import { mkdir, rename, rm, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { setImmediate as yieldIO } from 'node:timers/promises';

const DAY = 86400000;
const exportURL = (kind, date) => `https://files.tmdb.org/p/exports/${kind}_ids_${date.slice(5, 7)}_${date.slice(8, 10)}_${date.slice(0, 4)}.json.gz`;

// Bulk exports contain original titles and IDs, not playback availability or
// full metadata. Keep them in a separate searchable database from the IPTV list.
export function createTitleIndex({ directory, fetcher = fetch, now = () => new Date(), onProgress = () => {} }) {
  const target = join(directory, 'titles.sqlite');
  let db, metadata = null, initialization, running, progress = null, error = null, lastAttempt = 0;
  const status = () => ({ ...(metadata || { movies: 0, series: 0 }), refreshing: Boolean(running), progress, error });
  function open() {
    const connection = new DatabaseSync(target, { readOnly: true });
    try { metadata = JSON.parse(connection.prepare('SELECT value FROM metadata WHERE key = ?').get('snapshot').value); }
    catch (error) { connection.close(); throw error; }
    const old = db; db = connection; old?.close();
  }
  function initialize() {
    return initialization ||= (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await stat(target); open(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
  }
  function search(query, type = 'all') {
    const terms = String(query || '').match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) || [];
    if (!db || !terms.length || terms.join('').length < 2) return [];
    const expression = terms.map(term => `"${term}"*`).join(' AND ');
    const filter = ['movie', 'tv'].includes(type) ? ' AND type = ?' : '';
    const params = filter ? [expression, type] : [expression];
    return db.prepare(`SELECT title, type, CAST(tmdb AS INTEGER) AS tmdb, CAST(popularity AS REAL) AS popularity FROM titles WHERE titles MATCH ?${filter} ORDER BY CAST(popularity AS REAL) DESC LIMIT 30`).all(...params);
  }
  async function latestDate() {
    const date = now();
    // TMDB finishes its daily export at 08:00 UTC. Fall back if publication is late.
    const first = date.getUTCHours() < 8 ? 1 : 0;
    for (let offset = first; offset < first + 3; offset++) {
      const candidate = new Date(date.getTime() - offset * DAY).toISOString().slice(0, 10);
      let exists = true;
      for (const kind of ['movie', 'tv_series']) {
        const response = await fetcher(exportURL(kind, candidate), { method: 'HEAD', signal: AbortSignal.timeout(15000) });
        await response.body?.cancel();
        if (!response.ok) {
          if (response.status !== 404) throw new Error(`Title export returned HTTP ${response.status}.`);
          exists = false; break;
        }
      }
      if (exists) return candidate;
    }
    throw new Error('No recent TMDB title export is available.');
  }
  function refresh() {
    if (running) return running;
    lastAttempt = now().getTime();
    running = (async () => {
      await initialize();
      const date = await latestDate();
      if (metadata?.exportDate === date) return status();
      const temp = join(directory, 'titles-next.sqlite');
      let writer;
      error = null;
      progress = { movies: 0, series: 0, exportDate: date };
      try {
        await rm(temp, { force: true });
        writer = new DatabaseSync(temp);
        await chmod(temp, 0o600);
        writer.exec('PRAGMA journal_mode = DELETE; CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT); CREATE VIRTUAL TABLE titles USING fts5(title, type UNINDEXED, tmdb UNINDEXED, popularity UNINDEXED, tokenize="unicode61 remove_diacritics 2");');
        const insert = writer.prepare('INSERT INTO titles(title,type,tmdb,popularity) VALUES (?,?,?,?)');
        for (const [kind, type, key] of [['movie', 'movie', 'movies'], ['tv_series', 'tv', 'series']]) {
          const response = await fetcher(exportURL(kind, date), { signal: AbortSignal.timeout(300000) });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`Title export returned HTTP ${response.status}.`); }
          writer.exec('BEGIN');
          let batch = 0;
          async function line(value) {
            if (!value.trim()) return;
            const item = JSON.parse(value);
            const title = item.original_title || item.original_name;
            if (item.adult || !title || !Number.isSafeInteger(item.id) || item.id <= 0) return;
            insert.run(title, type, item.id, Number(item.popularity) || 0);
            progress[key]++; batch++;
            if (batch >= 2000) {
              writer.exec('COMMIT; BEGIN'); batch = 0;
              onProgress({ ...progress }); await yieldIO();
            }
          }
          await pipeline(Readable.fromWeb(response.body), createGunzip(), async chunks => {
            const decoder = new TextDecoder(); let pending = '';
            for await (const chunk of chunks) {
              pending += decoder.decode(chunk, { stream: true });
              let end;
              while ((end = pending.indexOf('\n')) !== -1) {
                await line(pending.slice(0, end)); pending = pending.slice(end + 1);
              }
            }
            pending += decoder.decode(); await line(pending);
          });
          writer.exec('COMMIT');
          if (!progress[key]) throw new Error(`The ${key} title export is empty.`);
        }
        const snapshot = { ...progress, updatedAt: now().toISOString() };
        writer.prepare('INSERT INTO metadata VALUES (?,?)').run('snapshot', JSON.stringify(snapshot));
        writer.exec("INSERT INTO titles(titles) VALUES ('optimize')");
        writer.close(); writer = null;
        await rename(temp, target);
        open();
        return metadata;
      } finally {
        writer?.close();
        await rm(temp, { force: true });
      }
    })().catch(cause => { error = cause.message; throw cause; }).finally(() => { running = null; progress = null; });
    return running;
  }
  function warm() {
    const age = metadata?.updatedAt ? now().getTime() - Date.parse(metadata.updatedAt) : Infinity;
    if (age > DAY && now().getTime() - lastAttempt > 300000) refresh().catch(cause => console.warn('Title index:', cause.message));
  }
  return { initialize, refresh, warm, search, status, close: () => { db?.close(); db = null; } };
}
