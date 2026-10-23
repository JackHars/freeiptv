import assert from 'node:assert/strict';

// Exercise the real HTTP responses against the Xtream movie field contract.
// The reference server returns a numeric rating and an integer five-star score:
// https://github.com/gtaman92/XtreamCodesExtendAPI/blob/master/player_api.php
const base = process.env.UI_BASE || 'http://127.0.0.1:8091';
const setup = await fetch(`${base}/iptv/setup`).then(response => response.json());
async function api(action, params = {}, post = false) {
  const query = new URLSearchParams({ username: setup.username, password: setup.password, action, ...params });
  const response = await fetch(`${base}/player_api.php${post ? '' : `?${query}`}`, post
    ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: query }
    : {});
  assert.equal(response.status, 200, `HTTP error for ${action}`);
  return response.json();
}
function validateMovie(movie, categoryIDs) {
  assert.ok(Number.isSafeInteger(movie.stream_id) && movie.stream_id > 0);
  assert.equal(typeof movie.name, 'string');
  assert.ok(movie.name.length);
  assert.equal(movie.stream_type, 'movie');
  assert.equal(typeof movie.rating, 'number', `Movie ${movie.stream_id}: rating must be a JSON number`);
  assert.ok(Number.isFinite(movie.rating) && movie.rating >= 0 && movie.rating <= 10);
  assert.ok(Number.isInteger(movie.rating_5based), `Movie ${movie.stream_id}: five-star rating must be an integer`);
  assert.ok(movie.rating_5based >= 0 && movie.rating_5based <= 5);
  assert.equal(typeof movie.category_id, 'string');
  assert.ok(categoryIDs.has(movie.category_id), `Missing category for movie ${movie.stream_id}`);
  assert.equal(movie.container_extension, 'm3u8');
  const stream = new URL(movie.direct_source);
  assert.equal(stream.origin, new URL(base).origin);
  assert.ok(stream.pathname.endsWith(`/${movie.stream_id}.m3u8`));
}
const [movies, categories, series] = await Promise.all([
  api('get_vod_streams'), api('get_vod_categories'), api('get_series'),
]);
assert.equal(movies.length, setup.movies);
assert.ok(movies.length > 0);
assert.equal(new Set(movies.map(movie => movie.stream_id)).size, movies.length);
const categoryIDs = new Set(categories.map(category => category.category_id));
for (const movie of movies) validateMovie(movie, categoryIDs);
for (const category of categories) {
  const filtered = await api('get_vod_streams', { category_id: category.category_id });
  assert.deepEqual(filtered.map(movie => movie.stream_id), movies.filter(movie => movie.category_id === category.category_id).map(movie => movie.stream_id));
}
assert.deepEqual(await api('get_vod_streams', {}, true), movies);
assert.deepEqual(await api('get_vod_streams', { category_id: '999999999' }), []);
const details = await api('get_vod_info', { vod_id: movies[0].stream_id });
validateMovie(details.movie_data, categoryIDs);
assert.equal(details.movie_data.stream_id, movies[0].stream_id);
assert.equal(details.info.name, movies[0].name);
assert.equal(series.length, setup.series);
assert.ok(series.length > 0);
assert.equal((await api('')).user_info.auth, 1);
console.log(`Catalog contract passed: ${movies.length} movies, ${categories.length} movie categories, ${series.length} series; GET/POST imports and movie details.`);
