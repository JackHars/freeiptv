import { setTimeout as delay } from 'node:timers/promises';

export const UPSTREAM_PAGE_LIMIT = 500;
export const MAX_CATALOG_PAGES = 2000;
export const catalogPageLimit = value => Math.min(MAX_CATALOG_PAGES, Math.max(1, Math.floor(Number(value) || MAX_CATALOG_PAGES)));

async function pool(items, operation) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; await operation(items[index]); }
  }));
}

// Read each list's pagination metadata before fetching the remaining pages.
// Pace requests below the upstream limit, retry temporary failures, and publish
// a new snapshot only after collection finishes so players can keep importing.
export async function collectCatalog({ fetchPage, pages = MAX_CATALOG_PAGES, previous = {}, pins = [], onProgress = () => {}, requestIntervalMs = 1000, retryDelayMs = 1000, today = new Date().toISOString().slice(0, 10) }) {
  const limit = catalogPageLimit(pages);
  // Accumulate discovered titles across imports, including the existing cache.
  const maps = { movie: new Map((previous.movies || []).map(item => [item.id, item])), tv: new Map((previous.series || []).map(item => [item.id, item])) };
  const errors = [], failedTypes = new Set(), tasks = [];
  let nextRequest = 0;
  const progress = { completed: 0, total: 4 + Math.max(0, limit - UPSTREAM_PAGE_LIMIT) * 2, movies: 0, series: 0 };
  function report() { onProgress({ ...progress, movies: maps.movie.size, series: maps.tv.size }); }
  async function request(route, params) {
    for (let attempt = 0; ; attempt++) {
      const slot = Math.max(Date.now(), nextRequest);
      nextRequest = slot + requestIntervalMs;
      if (slot > Date.now()) await delay(slot - Date.now());
      try { return await fetchPage(route, params); }
      catch (error) {
        if (attempt >= 2 || /HTTP (?:400|401|403|404|422)\b/.test(error.message)) throw error;
        await delay(Math.max(retryDelayMs * 2 ** attempt, Math.min(60000, error.retryAfterMs || 0)));
      }
    }
  }
  function add(type, items) {
    for (const item of items) {
      const release = item.release_date || item.first_air_date;
      // Discovery cards omit some fields. Preserve richer list metadata already found.
      if (!item.adult && release && release <= today) {
        const prior = maps[type].get(item.id);
        maps[type].set(item.id, { ...prior, ...item, overview: item.overview || prior?.overview || '', genre_ids: item.genre_ids?.length ? item.genre_ids : prior?.genre_ids || [] });
      }
    }
  }
  async function load({ type, board, page }, first = false) {
    const route = board === 'trending' ? `/trending/${type}/day` : `/${type}/${board}`;
    try {
      const data = await request(route, { page });
      if (!Array.isArray(data.results)) throw new Error('Invalid catalog page.');
      add(type, data.results);
      if (first) {
        const last = Math.min(limit, UPSTREAM_PAGE_LIMIT, Math.max(1, Math.floor(Number(data.total_pages) || 1)));
        for (let page = 2; page <= last; page++) tasks.push({ type, board, page });
        progress.total += last - 1;
      }
    } catch (error) {
      failedTypes.add(type);
      errors.push(`${type}/${board}/${page}: ${error.message}`);
    } finally { progress.completed++; report(); }
  }
  const lists = ['movie', 'tv'].flatMap(type => ['popular', 'top_rated'].map(board => ({ type, board, page: 1 })));
  report();
  await pool(lists, task => load(task, true));
  // Interleave lists so progress includes both movies and series throughout.
  tasks.sort((a, b) => a.page - b.page);
  await pool(tasks, task => load(task));
  // Page 501 is invalid upstream. Spend the extra discovery budget on
  // non-overlapping release years, supported by the upstream discovery endpoint.
  if (limit > UPSTREAM_PAGE_LIMIT) {
    const remaining = { movie: limit - UPSTREAM_PAGE_LIMIT, tv: limit - UPSTREAM_PAGE_LIMIT };
    const windows = [];
    for (let year = Number(today.slice(0, 4)); year >= 1900; year--) {
      for (const type of ['movie', 'tv']) windows.push({ type, from: `${year}-01-01`, to: year === Number(today.slice(0, 4)) ? today : `${year}-12-31`, page: 1 });
    }
    let queue = windows;
    while (queue.length && (remaining.movie || remaining.tv)) {
      const next = [];
      await pool(queue, async window => {
        const { type, from, to, page } = window;
        if (!remaining[type]) return;
        remaining[type]--;
        const key = type === 'movie' ? 'primary_release_date' : 'first_air_date';
        try {
          const data = await request(`/discover/${type}`, { page, sort_by: 'popularity.desc', include_adult: false, [key + '.gte']: from, [key + '.lte']: to });
          if (!Array.isArray(data.results)) throw new Error('Invalid discovery page.');
          add(type, data.results);
          const last = Math.max(1, Math.floor(Number(data.total_pages) || 1));
          if (page < Math.min(last, UPSTREAM_PAGE_LIMIT)) next.push({ ...window, page: page + 1 });
        } catch (error) {
          failedTypes.add(type);
          errors.push(`${type}/discover/${from}/${to}/${page}: ${error.message}`);
        } finally { progress.completed++; report(); }
      });
      // Stable ordering gives every date window a turn before its next page.
      queue = next.sort((a, b) => b.to.localeCompare(a.to) || a.type.localeCompare(b.type));
    }
    progress.total -= remaining.movie + remaining.tv;
    report();
  }
  for (const type of ['movie', 'tv']) {
    if (failedTypes.has(type) || !maps[type].size) {
      for (const item of previous[type === 'movie' ? 'movies' : 'series'] || []) if (!maps[type].has(item.id)) maps[type].set(item.id, item);
    }
  }
  progress.total += pins.length;
  report();
  await pool(pins, async pin => {
    try { maps[pin.type].set(pin.id, await request(`/${pin.type}/${pin.id}`, {})); }
    catch (error) {
      errors.push(`Pinned ${pin.type}/${pin.id}: ${error.message}`);
      const cached = (previous[pin.type === 'movie' ? 'movies' : 'series'] || []).find(item => item.id === pin.id);
      if (cached && !maps[pin.type].has(pin.id)) maps[pin.type].set(pin.id, cached);
    } finally { progress.completed++; report(); }
  });
  if (!maps.movie.size && !maps.tv.size) throw new Error(errors[0] || 'No catalog titles returned.');
  return { movies: [...maps.movie.values()], series: [...maps.tv.values()], updatedAt: new Date().toISOString(), catalogPages: limit, errors };
}
