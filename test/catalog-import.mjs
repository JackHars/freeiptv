import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCatalog, catalogPageLimit } from '../api/catalog.mjs';

const movie = (id, extra = {}) => ({ id, title: `Movie ${id}`, release_date: '2000-01-01', adult: false, ...extra });
const tv = id => ({ id, name: `Series ${id}`, first_air_date: '2000-01-01' });
const fast = { requestIntervalMs: 0, retryDelayMs: 0, today: '2026-10-22' };

test('imports beyond the old five-page sample, respecting actual totals and the 500-page upstream ceiling', async () => {
  const requests = [], progress = [];
  const result = await collectCatalog({ ...fast, pages: 500, onProgress: value => progress.push(value), fetchPage: async (route, { page }) => {
    requests.push({ route, page });
    if (route === '/movie/popular') return { total_pages: 1001, results: [movie(page)] };
    if (route.includes('movie')) return { total_pages: 2, results: [movie(page)] };
    return { total_pages: 1, results: [tv(1)] };
  } });
  assert.equal(catalogPageLimit(5.5), 5);
  assert.equal(catalogPageLimit(), 2000);
  assert.equal(catalogPageLimit(9999), 2000);
  assert.equal(result.catalogPages, 500);
  assert.equal(Math.max(...requests.map(request => request.page)), 500);
  assert.equal(requests.filter(request => request.route === '/movie/top_rated').length, 2);
  assert.equal(requests.filter(request => request.route === '/tv/popular').length, 1);
  assert.equal(result.movies.length, 500);
  assert.equal(result.series.length, 1);
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
  assert.equal(progress.at(-1).movies, 500);
  assert.deepEqual(result.errors, []);
});

test('deduplicates lists, filters adult/unreleased titles, and retains explicitly pinned titles', async () => {
  const result = await collectCatalog({ ...fast, pins: [{ type: 'movie', id: 42 }], fetchPage: async route => {
    if (route === '/movie/42') return movie(42);
    return { total_pages: 1, results: route.includes('movie')
      ? [movie(1), movie(2, { adult: true }), movie(3, { release_date: '2099-01-01' }), movie(4, { release_date: '' })]
      : [tv(1)] };
  } });
  assert.deepEqual(result.movies.map(item => item.id).sort((a, b) => a - b), [1, 42]);
  assert.equal(result.series.length, 1);
});

test('retries transient failures and preserves cached titles when a list or pin fails', async () => {
  let retryCount = 0;
  const previous = { movies: [movie(99), movie(42)], series: [tv(99)] };
  const result = await collectCatalog({ ...fast, previous, pins: [{ type: 'movie', id: 42 }], fetchPage: async route => {
    if (route === '/movie/42' || route === '/movie/top_rated') throw new Error('TMDB HTTP 404');
    if (route === '/tv/popular' && retryCount++ === 0) throw new Error('TMDB HTTP 429');
    return { total_pages: 1, results: route.includes('movie') ? [movie(1)] : [tv(1)] };
  } });
  assert.equal(retryCount, 2);
  assert.deepEqual(new Set(result.movies.map(item => item.id)), new Set([1, 42, 99]));
  assert.deepEqual(new Set(result.series.map(item => item.id)), new Set([1, 99]));
  assert.equal(result.errors.length, 2);
});

test('uses date partitions for a 2,000-page budget without ever requesting page 501', async () => {
  const requests = [], progress = [];
  let id = 100;
  const result = await collectCatalog({ ...fast, pages: 2000, onProgress: p => progress.push(p), fetchPage: async (route, params) => {
    requests.push({ route, params });
    const isMovie = route.endsWith('movie') || route.includes('/movie/');
    if (!route.startsWith('/discover/')) return { total_pages: 1, results: isMovie ? [movie(1)] : [tv(1)] };
    const key = isMovie ? 'primary_release_date' : 'first_air_date';
    const days = (Date.parse(params[key + '.lte']) - Date.parse(params[key + '.gte'])) / 86400000;
    return { total_pages: days > 366 ? 1001 : 100, results: [isMovie ? movie(id++) : tv(id++)] };
  } });
  assert.equal(result.catalogPages, 2000);
  assert.ok(requests.every(({ params }) => params.page <= 500));
  assert.equal(requests.filter(({ route }) => route === '/discover/movie').length, 1500);
  assert.equal(requests.filter(({ route }) => route === '/discover/tv').length, 1500);
  assert.ok(result.movies.length > 1000 && result.series.length > 1000);
  assert.ok(requests.some(({ params }) => params['primary_release_date.gte'] > '2017-01-01'));
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
  assert.deepEqual(result.errors, []);
});
