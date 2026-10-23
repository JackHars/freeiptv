const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let details;
let poll;
async function request(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 3000); }
async function load() {
  try {
    details = await request('/iptv/setup');
    for (const key of ['server', 'username', 'password', 'playlist', 'epg']) $(`#${key}`).value = details[key];
    $('#download-playlist').href = details.playlist;
    $('#sports-playlist').value = details.sportsPlaylist;
    const sports = details.sports;
    $('#sports-count').textContent = (sports?.events || 0).toLocaleString();
    $('#sports-feed-count').textContent = (sports?.withPlayer || 0).toLocaleString();
    $('#sports-state').textContent = sports?.refreshing ? 'UPDATING' : sports?.withPlayer ? 'EVENTS AVAILABLE' : sports?.updatedAt ? 'AWAITING FEEDS' : 'LOADING';
    $('#refresh-sports').disabled = Boolean(sports?.refreshing);
    $('#sports-status').textContent = !sports?.updatedAt ? 'Loading the sports schedule…' : `${sports.inProgress} events are within their scheduled broadcast window. ${sports.withPlayer ? `${sports.withPlayer} have a published player link.` : 'The upstream source has not published broadcast links for the listed events yet.'}${sports.errors?.length ? ` ${sports.errors.length} source requests failed; saved events remain available until expiry.` : ''}`;
    $('#movie-count').textContent = details.movies.toLocaleString(); $('#series-count').textContent = details.series.toLocaleString();
    $('#catalog-state').textContent = details.refreshing ? 'UPDATING' : details.updatedAt ? 'READY' : 'NOT LOADED';
    $('#catalog-description').textContent = `Up to ${details.catalogPages.toLocaleString()} discovery pages each for movies and series, plus trending and top rated lists. Date ranges expand discovery beyond a single list. Previously cached titles and your pins are retained. ${details.updatedAt ? `Updated ${new Date(details.updatedAt).toLocaleString()}.` : 'Building the first catalog…'}`;
    $('#refresh-catalog').disabled = details.refreshing;
    if (details.refreshing && details.progress) $('#refresh-result').textContent = `Importing ${details.progress.completed.toLocaleString()} / ${details.progress.total.toLocaleString()} pages and pinned titles · ${details.progress.movies.toLocaleString()} movies and ${details.progress.series.toLocaleString()} series found. Your existing catalog stays available until the update finishes.`;
    else if (details.errors?.length) $('#refresh-result').textContent = `${details.errors.length} catalog request(s) failed. Available titles are still listed.`;
    else if (!details.refreshing) $('#refresh-result').textContent = '';
    $('#pinned-list').innerHTML = details.pinned.map(pin => `<div class="pinned-title">${escapeHTML(pin.title)}<span>${pin.type === 'tv' ? 'Series' : 'Movie'} · ${pin.id}</span></div>`).join('');
    const index = details.titleIndex;
    $('#title-cache-description').textContent = index?.updatedAt
      ? `${index.movies.toLocaleString()} movie titles and ${index.series.toLocaleString()} series titles cached locally. Export date: ${index.exportDate}.${index.refreshing ? ' Updating the title cache…' : ''}${index.error ? ' The last update failed; the saved cache is still available.' : ''}`
      : index?.refreshing ? `Building the searchable title cache… ${((index.progress?.movies || 0) + (index.progress?.series || 0)).toLocaleString()} titles imported.` : index?.error || 'The title cache is being prepared.';
    $('#search-titles').disabled = !index?.updatedAt;
    clearTimeout(poll); poll = setTimeout(load, details.refreshing || !details.updatedAt || index?.refreshing || sports?.refreshing ? 3000 : 60000);
  } catch (error) { $('#account-result').textContent = error.message; }
}
document.querySelectorAll('[data-copy]').forEach(button => button.onclick = async () => {
  const input = $(`#${button.dataset.copy}`);
  try { if (navigator.clipboard && isSecureContext) await navigator.clipboard.writeText(input.value); else { input.select(); if (!document.execCommand('copy')) throw new Error(); } toast('Copied to clipboard'); }
  catch { input.select(); toast('Select the text and copy it manually.'); }
});
$('#test-account').onclick = async () => {
  if (!details) return;
  $('#test-account').disabled = true;
  try {
    const query = new URLSearchParams({ username: details.username, password: details.password });
    const result = await request(`/player_api.php?${query}`);
    if (result.user_info?.auth !== 1) throw new Error('Login failed.');
    $('#account-result').textContent = `Account active. Server is ready for HLS playback.`;
  } catch (error) { $('#account-result').textContent = error.message; }
  finally { $('#test-account').disabled = false; }
};
$('#refresh-sports').onclick = async () => {
  $('#refresh-sports').disabled = true;
  try { await request('/iptv/sports/refresh', {}); await load(); }
  catch (error) { $('#sports-status').textContent = error.message; $('#refresh-sports').disabled = false; }
};
$('#refresh-catalog').onclick = async () => {
  $('#refresh-catalog').disabled = true; $('#refresh-result').textContent = 'Updating catalog…';
  try { await request('/iptv/refresh', {}); await load(); } catch (error) { $('#refresh-result').textContent = error.message; $('#refresh-catalog').disabled = false; }
};
$('#add-form').onsubmit = async event => {
  event.preventDefault(); $('#add-title').disabled = true; $('#add-result').textContent = 'Adding title…';
  try { const result = await request('/iptv/library', { type: $('#add-type').value, tmdb: Number($('#add-id').value) }); $('#add-result').textContent = `${result.title} is pinned. Refresh the playlist in your IPTV app to see it.`; await load(); }
  catch (error) { $('#add-result').textContent = error.message; }
  finally { $('#add-title').disabled = false; }
};
$('#title-search-form').onsubmit = async event => {
  event.preventDefault(); $('#title-search-status').textContent = 'Searching the local cache…';
  try {
    const query = new URLSearchParams({ q: $('#title-query').value.trim(), type: $('#title-type').value });
    const result = await request(`/iptv/titles?${query}`);
    $('#title-results').innerHTML = result.items.map(item => `<div class="cached-title"><div><strong>${escapeHTML(item.title)}</strong><span>${item.type === 'movie' ? 'Movie' : 'Series'} · ${item.tmdb}</span></div><button class="button subtle small" data-pin-type="${item.type}" data-pin-id="${item.tmdb}">Add to IPTV</button></div>`).join('');
    $('#title-search-status').textContent = result.items.length ? `${result.items.length} matching titles. Search uses the local cache.` : 'No matching original titles found. Try a shorter title or the cinema search.';
  } catch (error) { $('#title-search-status').textContent = error.message; }
};
$('#title-results').onclick = async event => {
  const button = event.target.closest('button[data-pin-id]');
  if (!button) return;
  button.disabled = true; button.textContent = 'Adding…';
  try {
    const result = await request('/iptv/library', { type: button.dataset.pinType, tmdb: Number(button.dataset.pinId) });
    button.textContent = 'Added';
    $('#title-search-status').textContent = `${result.title} is pinned. Refresh your playlist in UHF to see it.`;
    await load();
  } catch (error) { button.disabled = false; button.textContent = 'Add to IPTV'; $('#title-search-status').textContent = error.message; }
};
load();
