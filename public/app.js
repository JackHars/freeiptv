const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { base: '', connected: false, view: 'browse', type: 'movie', board: 'trending', query: '', page: 1, pages: 1, items: [], history: [], servers: [], connectionToken: 0, catalogToken: 0, detailToken: 0, playToken: 0, playback: null, hls: null, retryCount: 0, pending: new Set() };
const sourceNames = ['Nebula', 'Lisbon', 'Solara', 'Athens'];
const endpoints = {
  health: { description: 'Liveness, request signer readiness, and engine status.', fields: [] },
  servers: { description: 'Upstream source status and 4K availability.', fields: [] },
  api: { description: 'The API index returned by your platform.', fields: [] },
  search: { description: 'Search movies and TV series by title.', fields: [['q','Search query','text','',true],['page','Page','number','1']] },
  browse: { description: 'Browse a catalog board. On the air is TV only; now playing is movies only.', fields: [['board','Board',['trending','popular','top_rated','on_the_air','now_playing'],'trending'],['type','Type',['movie','tv'],'movie'],['page','Page','number','1']] },
  title: { description: 'Title metadata, cast, and TV seasons.', fields: [['tmdb','TMDB ID','number','603',true],['type','Type',['movie','tv'],'movie']] },
  episodes: { description: 'Episodes for one TV season.', fields: [['tmdb','TMDB ID','number','1396',true],['season','Season','number','1']] },
  images: { description: 'Poster and backdrop image URLs.', fields: [['tmdb','TMDB ID','number','603',true],['type','Type',['movie','tv'],'movie']] },
  resolve: { description: 'Resolve a playable stream. TV requires both season and episode. Supports GET and POST.', fields: [['tmdb','TMDB ID','number','603',true],['kind','Kind',['movie','series'],'movie'],['s','Season','number',''],['e','Episode','number',''],['server','Source',['',...sourceNames],''],['fresh','Bypass cache',['','1'],'']] },
  master: { description: 'Adaptive HLS master playlist with proxied variants.', fields: [['tmdb','TMDB ID','number','603',true],['kind','Kind',['movie','series'],'movie'],['s','Season','number',''],['e','Episode','number','']] },
  watch: { description: 'A single proxied variant for external players.', fields: [['tmdb','TMDB ID','number','603',true],['kind','Kind',['movie','series'],'movie'],['s','Season','number',''],['e','Episode','number',''],['v','Quality',['best','1080p','720p','480p','360p'],'best']] },
  proxy: { description: 'Inspect a proxied HLS playlist or media resource.', fields: [['u','Upstream URL','url','',true]] },
};

function localURL(route, params = {}, base = state.base) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== '' && value !== null && value !== undefined) query.set(key, value);
  if (base === location.origin) return `/${route}${query.size ? `?${query}` : ''}`;
  query.set('__base', base);
  return `/relay/${route}?${query}`;
}
function displayURL(route, params = {}, base = state.base) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value !== null && value !== undefined));
  return `${base}/${route}${query.size ? `?${query}` : ''}`;
}
function imageURL(value, size = 'w500') {
  if (typeof value !== 'string' || !value) return '';
  if (value.startsWith('/') && !value.startsWith('//')) return `https://image.tmdb.org/t/p/${size}${value}`;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 3500); }
function openDialog(id) { const dialog = $(`#${id}`); if (!dialog.open) dialog.showModal(); }
async function copy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const element = document.createElement('textarea'); element.value = text; element.style.cssText = 'position:fixed;opacity:0';
      (document.querySelector('dialog[open]') || document.body).append(element); element.select();
      const ok = document.execCommand('copy'); element.remove(); if (!ok) throw new Error('Copy failed');
    }
    toast('Copied to clipboard');
  } catch { toast('Copy unavailable. Select the text and copy it manually.'); }
}

async function api(route, params = {}, options = {}) {
  const controller = new AbortController();
  state.pending.add(controller);
  const timer = setTimeout(() => controller.abort(), 95000);
  const started = performance.now();
  const method = options.method || 'GET';
  const base = options.base || state.base;
  const entry = { method, path: `/${route}`, url: displayURL(route, method === 'GET' ? params : {}, base), request: options.body, status: 0, data: null, duration: 0 };
  try {
    const response = await fetch(localURL(route, method === 'GET' ? params : {}, base), { method, headers: options.body ? { 'Content-Type': 'application/json' } : undefined, body: options.body ? JSON.stringify(options.body) : undefined, signal: controller.signal });
    entry.status = response.status;
    const type = response.headers.get('content-type') || '';
    if (!/json|text|mpegurl|xml/i.test(type)) {
      await response.body?.cancel();
      entry.data = { content_type: type, status: response.status, note: 'Binary media response received. Use the player or copy the stream link to play it.' };
    } else {
      const reader = response.body.getReader(); const chunks = []; let size = 0; let truncated = false;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 524288) { truncated = true; await reader.cancel(); break; } chunks.push(value); }
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const raw = new TextDecoder().decode(bytes);
      try { entry.data = JSON.parse(raw); } catch { entry.data = raw + (truncated ? '\n[Preview truncated at 512 KB]' : ''); }
    }
    if (!response.ok) throw new Error(entry.data?.error || `HTTP ${response.status}: ${String(entry.data).slice(0,200)}`);
    return entry.data;
  } catch (error) {
    if (!entry.data) entry.data = { error: error.name === 'AbortError' ? 'Request canceled or timed out.' : error.message };
    const failure = new Error(entry.data?.error || error.message); failure.status = entry.status; throw failure;
  } finally {
    clearTimeout(timer); state.pending.delete(controller); entry.duration = Math.round(performance.now() - started);
    state.history.unshift(entry); state.history = state.history.slice(0,40); $('#history-count').textContent = state.history.length;
    if ($('#history-dialog').open) renderHistory();
  }
}

function connectionStatus(connected, text) {
  state.connected = connected; $('#connection-dot').className = connected ? 'online' : 'offline'; $('#connection-label').textContent = text || (connected ? 'API connected' : 'API offline');
  $('#connection-pill').title = state.base;
}
function openConnection() { $('#api-base').value = state.base; $('#connection-feedback').replaceChildren(); openDialog('connection-dialog'); }
function emptyCatalog(title, message, error = '') {
  $('#catalog-grid').replaceChildren(); $('#pagination').hidden = true; $('#result-count').textContent = '';
  $('#catalog-message').innerHTML = `<div class="empty-state"><div class="empty-symbol">${state.connected ? '⌕' : '⌁'}</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(message)}</p>${error ? `<p class="error-detail">${escapeHTML(error)}</p>` : ''}<button class="button subtle" id="empty-action">${state.connected ? 'Try again' : 'Connection settings'} <span>↗</span></button></div>`;
  $('#empty-action').onclick = state.connected ? () => loadCatalog() : openConnection;
}
function resetHero() {
  $('#hero').classList.remove('has-image'); $('#hero-art').style.backgroundImage = ''; $('#hero-title').innerHTML = 'Good stories.<br>Great company.';
  $('#hero-description').textContent = 'Connect your home server and make yourself comfortable. Your next favorite is waiting.';
  $('#hero-meta').replaceChildren(); $('#hero-tag').textContent = 'YOUR PERSONAL PICTURE HOUSE'; $('#hero-signature').hidden = false;
  $('#hero-action').innerHTML = 'Connect your server <span>↗</span>'; $('#hero-action').onclick = openConnection;
}
async function connect(base, interactive = false) {
  const token = ++state.connectionToken;
  ++state.catalogToken; ++state.detailToken;
  for (const controller of state.pending) controller.abort();
  stopPlayback();
  for (const id of ['detail-dialog','player-dialog']) $(`#${id}`).close();
  state.base = base; state.items = []; state.page = 1; state.servers = []; resetHero();
  connectionStatus(false, 'Connecting'); $('#connect-button').disabled = true; $('#connect-button').textContent = 'Connecting…';
  try { localStorage.setItem('cinejoy-api', base); } catch {}
  updateRequestPreview();
  try {
    const health = await api('health');
    if (token !== state.connectionToken) return;
    if (!health || typeof health !== 'object' || health.ok !== true) throw new Error('This address did not return the documented Cinejoy /health response.');
    connectionStatus(true, health.wasm === false ? 'Engine not ready' : 'API connected');
    if (interactive) $('#connection-dialog').close();
    await Promise.allSettled([loadCatalog(), loadServers()]);
    if (health.wasm === false) toast('API connected. The playback signer is not ready yet.');
  } catch (error) {
    if (token !== state.connectionToken) return;
    connectionStatus(false); resetHero();
    emptyCatalog('Your cinema is ready. Connect the API.', 'Cinejoy is not responding at the saved address. Start your platform server, then reconnect.', error.message);
    $('#servers-list').innerHTML = '<p class="muted">Your API is offline. Connect it to check source availability.</p>';
    if (interactive) $('#connection-feedback').innerHTML = `<div class="feedback">Address saved. ${escapeHTML(error.message)}</div>`;
  } finally { if (token === state.connectionToken) { $('#connect-button').disabled = false; $('#connect-button').innerHTML = 'Save & connect <span>↗</span>'; } }
}

function setView(view) {
  state.view = view;
  $$('.nav-button[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('#library-view').hidden = view === 'lab'; $('#lab-view').hidden = view !== 'lab';
  $('#current-view').textContent = ({ browse: 'Discover', movies: 'Movies', tv: 'TV series', lab: 'API explorer' })[view];
  if (view === 'lab') return;
  state.query = ''; $('#search').value = ''; state.page = 1;
  if (view === 'movies' || view === 'tv') state.type = view === 'tv' ? 'tv' : 'movie';
  $('#catalog-type').value = state.type;
  normalizeBoard(); updateLibraryHeading(); loadCatalog();
}
function normalizeBoard() {
  const airing = state.type === 'tv' ? 'on_the_air' : 'now_playing';
  $('#airing-tab').dataset.board = airing; $('#airing-tab').textContent = state.type === 'tv' ? 'On the air' : 'Now playing';
  if (['on_the_air','now_playing'].includes(state.board)) state.board = airing;
  $$('.board-tab').forEach(button => button.classList.toggle('active', !state.query && button.dataset.board === state.board));
}
function updateLibraryHeading() {
  $('#library-heading').textContent = state.query ? 'Find your next favorite.' : ({ browse: 'Your next watch.', movies: 'Movie night starts here.', tv: 'One more episode.' })[state.view] || 'Your next watch.';
  $('#library-subtitle').textContent = state.query ? `Searching movies and TV for “${state.query}”.` : 'A little discovery. A great night in.';
  $('#hero').hidden = Boolean(state.query);
  $('#catalog-title').textContent = state.query ? `Results for “${state.query}”` : `${({ trending: 'Trending', popular: 'Popular', top_rated: 'Top rated', now_playing: 'Now playing ·', on_the_air: 'On the air ·' })[state.board]} ${state.type === 'movie' ? 'movies' : 'series'}`;
}
async function loadCatalog() {
  const token = ++state.catalogToken; updateLibraryHeading(); normalizeBoard();
  if (!state.connected) { emptyCatalog('Your cinema is ready. Connect the API.', `The saved API address is ${state.base || 'http://127.0.0.1:8090'}. Start your platform server and connect to load your catalog.`); return; }
  $('#catalog-message').replaceChildren(); $('#pagination').hidden = true; $('#result-count').textContent = 'Loading…';
  $('#catalog-grid').innerHTML = Array.from({ length: 5 }, () => '<div class="skeleton" aria-hidden="true"></div>').join('');
  try {
    const data = await api(state.query ? 'search' : 'browse', state.query ? { q: state.query, page: state.page } : { board: state.board, type: state.type, page: state.page });
    if (token !== state.catalogToken) return;
    if (!Array.isArray(data?.items)) throw new Error('Expected a catalog response with an items array.');
    state.items = data.items; state.pages = Math.max(1, Number(data.pages) || 1);
    if (!data.items.length) { emptyCatalog('No titles found.', 'Try another search or catalog board.'); return; }
    $('#result-count').textContent = Number.isFinite(Number(data.total)) ? `${Number(data.total).toLocaleString()} titles` : `${data.items.length} titles on this page`;
    $('#catalog-grid').innerHTML = data.items.map((item, index) => {
      const poster = imageURL(item.poster); const rating = Number(item.vote);
      return `<button class="movie-card" data-index="${index}" aria-label="View ${escapeHTML(item.title)}"><div class="poster">${poster ? `<img loading="lazy" src="${escapeHTML(poster)}" alt="" referrerpolicy="no-referrer">` : `<div class="poster-placeholder"><b>▶</b>${escapeHTML(item.title)}</div>`}${rating > 0 ? `<span class="poster-rating"><span>★</span> ${rating.toFixed(1)}</span>` : ''}<div class="poster-play"><span>▶</span></div></div><h3>${escapeHTML(item.title || 'Untitled')}</h3><div class="card-meta"><span>${escapeHTML(item.year || 'Year unavailable')}</span><span>${item.kind === 'tv' || item.kind === 'series' ? 'Series' : 'Movie'}</span></div></button>`;
    }).join('');
    $$('.movie-card').forEach(button => button.onclick = () => openTitle(state.items[Number(button.dataset.index)]));
    $$('.poster img').forEach(img => img.onerror = () => { img.parentNode.insertAdjacentHTML('afterbegin', '<div class="poster-placeholder"><b>▶</b>Poster unavailable</div>'); img.remove(); });
    $('#pagination').hidden = state.pages <= 1; $('#page-label').textContent = `Page ${state.page} of ${state.pages.toLocaleString()}`;
    $('#previous-page').disabled = state.page <= 1; $('#next-page').disabled = state.page >= state.pages;
    if (!state.query) renderHero(data.items.find(item => item.backdrop) || data.items[0]);
  } catch (error) { if (token === state.catalogToken) emptyCatalog('Couldn’t load the catalog.', 'Your API returned an error. You can inspect the request or try again.', error.message); }
}
function renderHero(item) {
  const backdrop = imageURL(item.backdrop, 'w1280'); $('#hero-art').style.backgroundImage = backdrop ? `url(${JSON.stringify(backdrop)})` : '';
  $('#hero').classList.toggle('has-image', Boolean(backdrop)); $('#hero-signature').hidden = Boolean(backdrop);
  $('#hero-title').textContent = item.title || 'Discover something new'; $('#hero-description').textContent = item.overview || 'Explore this title and find your next great watch.';
  $('#hero-tag').textContent = state.board === 'trending' ? 'IN THE SPOTLIGHT' : 'FROM YOUR CATALOG';
  $('#hero-meta').textContent = [item.year, item.kind === 'tv' ? 'TV series' : 'Movie', Number(item.vote) > 0 ? `★ ${Number(item.vote).toFixed(1)}` : ''].filter(Boolean).join('   ·   ');
  $('#hero-action').innerHTML = 'Explore title <span>↗</span>'; $('#hero-action').onclick = () => openTitle(item);
}

async function loadServers() {
  const token = state.connectionToken;
  $('#refresh-servers').disabled = true;
  try {
    const data = await api('servers');
    if (token !== state.connectionToken) return;
    if (!Array.isArray(data?.servers)) throw new Error('Expected a servers array.');
    state.servers = data.servers;
    $('#servers-list').innerHTML = data.servers.map(server => `<div class="server-card"><h3>${escapeHTML(server.name)} ${server['4k'] ? '<span class="tag">4K</span>' : ''}</h3><p class="${server.status === 'ok' ? 'server-ok' : ''}">● ${escapeHTML(server.status || 'Unknown')}</p></div>`).join('') || '<p class="muted">No source servers returned.</p>';
  } catch (error) { if (token === state.connectionToken) $('#servers-list').innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`; }
  finally { if (token === state.connectionToken) $('#refresh-servers').disabled = false; }
}
function sourceOptions() { return '<option value="">Automatic failover</option>' + (state.servers.length ? state.servers.map(s => s.name) : sourceNames).map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join(''); }
async function openTitle(item) {
  const token = ++state.detailToken; const tmdb = item.tmdb || item.id; const kind = item.kind === 'tv' || item.kind === 'series' ? 'tv' : 'movie';
  openDialog('detail-dialog'); $('#detail-content').innerHTML = '<p class="muted">Loading title…</p>'; $('#detail-backdrop').style.backgroundImage = '';
  try {
    const data = await api('title', { tmdb, type: kind }); if (token !== state.detailToken) return;
    if (!data || typeof data !== 'object' || !data.title) throw new Error('Expected title metadata.');
    const title = { ...item, ...data, tmdb, kind }; const backdrop = imageURL(title.backdrop, 'w1280');
    $('#detail-backdrop').style.backgroundImage = backdrop ? `url(${JSON.stringify(backdrop)})` : '';
    $('#detail-content').innerHTML = `<span class="tag">${kind === 'tv' ? 'TV SERIES' : 'MOVIE'} · TMDB ${escapeHTML(tmdb)}</span><h2 class="detail-title">${escapeHTML(title.title)}</h2><div class="detail-meta"><span>${escapeHTML(title.year || '')}</span>${Number(title.vote) > 0 ? `<span>★ ${Number(title.vote).toFixed(1)}</span>` : ''}<span>${escapeHTML(title.status || '')}</span></div><p class="detail-overview">${escapeHTML(title.overview || 'No synopsis available.')}</p>${title.cast?.length ? `<p class="cast">Starring ${escapeHTML(title.cast.slice(0,6).map(actor => actor.name).join(', '))}</p>` : ''}<div class="play-row"><label>Playback source<select id="title-source">${sourceOptions()}</select></label>${kind === 'movie' ? '<button class="button primary" id="play-movie">▶ Play movie</button>' : ''}<button class="button subtle" id="inspect-title">Inspect response</button><button class="button subtle" id="add-to-iptv">Add to IPTV +</button></div>${kind === 'tv' ? '<label class="season-picker">Season<select id="season-select"></select></label><div class="episode-list" id="episode-list"></div>' : ''}`;
    $('#inspect-title').onclick = showHistory;
    $('#add-to-iptv').onclick = async () => {
      const button = $('#add-to-iptv'); button.disabled = true;
      try {
        const response = await fetch('/iptv/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tmdb, type: kind }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not add title.');
        button.textContent = 'Added to IPTV'; toast(`${title.title} added. Refresh your IPTV app’s catalog.`);
      } catch (error) { toast(error.message); button.disabled = false; }
    };
    if (kind === 'movie') $('#play-movie').onclick = () => playTitle(title, null, null, $('#title-source').value);
    else {
      const seasons = Array.isArray(title.seasons) && title.seasons.length ? title.seasons : [{ season: 1, name: 'Season 1' }];
      $('#season-select').innerHTML = seasons.map(season => `<option value="${escapeHTML(season.season)}">${escapeHTML(season.name || `Season ${season.season}`)}</option>`).join('');
      $('#season-select').onchange = () => loadEpisodes(title, Number($('#season-select').value), token);
      loadEpisodes(title, Number($('#season-select').value), token);
    }
    api('images', { tmdb, type: kind }).then(images => { if (token !== state.detailToken) return; const url = imageURL(images.backdrop || images.backdrops?.[0], 'w1280'); if (url) $('#detail-backdrop').style.backgroundImage = `url(${JSON.stringify(url)})`; }).catch(() => {});
  } catch (error) { if (token === state.detailToken) $('#detail-content').innerHTML = `<h2 class="detail-title">Couldn’t load this title.</h2><p class="detail-overview">${escapeHTML(error.message)}</p>`; }
}
async function loadEpisodes(title, season, token) {
  const target = $('#episode-list'); target.textContent = 'Loading episodes…';
  try {
    const data = await api('episodes', { tmdb: title.tmdb, season });
    if (token !== state.detailToken || !$('#season-select') || Number($('#season-select').value) !== season) return;
    if (!Array.isArray(data?.episodes)) throw new Error('Expected an episodes array.');
    target.innerHTML = data.episodes.map((episode, index) => `<button class="episode-row" data-episode-index="${index}"><span class="episode-number">${String(episode.episode).padStart(2,'0')}</span><div><h3>${escapeHTML(episode.name || `Episode ${episode.episode}`)}</h3><p>${escapeHTML(episode.overview || episode.air_date || 'No synopsis available.')}</p></div><span class="play-icon">▶</span></button>`).join('') || '<p class="muted">No episodes returned for this season.</p>';
    $$('.episode-row').forEach(button => button.onclick = () => playTitle(title, season, data.episodes[Number(button.dataset.episodeIndex)].episode, $('#title-source').value));
  } catch (error) { if (token === state.detailToken && $('#season-select') && Number($('#season-select').value) === season) target.textContent = error.message; }
}

function stopPlayback() {
  ++state.playToken; state.hls?.destroy(); state.hls = null;
  const video = $('#video'); video.onerror = null; video.onloadedmetadata = null; video.pause(); video.removeAttribute('src'); video.load();
}
function playTitle(title, season, episode, server) {
  state.playback = { title, season, episode, server, base: state.base }; state.retryCount = 0;
  $('#player-title').textContent = `${title.title}${season !== null ? ` · S${season} E${episode}` : ''}`;
  $('#detail-dialog').close(); openDialog('player-dialog'); startPlayback(false, 0);
}
function playbackParams() {
  const p = state.playback; return { tmdb: p.title.tmdb || p.title.id, kind: p.title.kind === 'tv' || p.title.kind === 'series' ? 'series' : 'movie', s: p.season, e: p.episode, server: p.server };
}
async function startPlayback(fresh = false, resume = 0) {
  if (!state.playback) return;
  stopPlayback(); const token = state.playToken; const video = $('#video'); const params = playbackParams();
  $('#player-status').textContent = fresh ? 'Refreshing stream…' : 'Resolving stream…'; $('#resolve-details').textContent = '';
  $('#quality').innerHTML = '<option value="-1">Auto</option>'; $('#quality').disabled = true; $('#retry-playback').disabled = true;
  const recover = async (message) => {
    if (token !== state.playToken) return;
    if (state.retryCount < 1) { state.retryCount++; await startPlayback(true, video.currentTime || resume); }
    else { $('#player-status').textContent = `${message} Try “Resolve again” or another source.`; $('#retry-playback').disabled = false; }
  };
  try {
    const data = await api('resolve', { ...params, fresh: fresh ? '1' : '' }, { base: state.playback.base });
    if (token !== state.playToken) return;
    $('#resolve-details').textContent = JSON.stringify(data, null, 2);
    if (!data?.master && !data?.master_proxied && !data?.variants?.length) throw new Error('No playable stream returned by /resolve.');
    $('#player-status').textContent = `${data.server || 'Source resolved'} · ${data.cached ? 'cached' : 'fresh'} · loading video`;
    const src = localURL('master', params, state.playback.base);
    video.onloadedmetadata = () => { if (token !== state.playToken) return; if (resume > 0) video.currentTime = resume; video.play().catch(() => { if (token === state.playToken) $('#player-status').textContent = 'Stream ready. Press play to start.'; }); };
    if (window.Hls?.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30 }); state.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token !== state.playToken) return;
        $('#quality').innerHTML = '<option value="-1">Auto</option>' + hls.levels.map((level,index) => `<option value="${index}">${level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)} kbps`}</option>`).join('');
        $('#quality').disabled = false; $('#player-status').textContent = `${data.server || 'Stream'} · ready`;
      });
      let mediaRecovery = false;
      hls.on(Hls.Events.ERROR, (_, error) => {
        if (token !== state.playToken || !error.fatal) return;
        if (error.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovery) { mediaRecovery = true; hls.recoverMediaError(); }
        else { hls.stopLoad(); recover(`Playback error: ${error.details}.`); }
      });
      hls.loadSource(src); hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src; video.onerror = () => recover('The browser could not play this stream.');
    } else throw new Error('HLS is not supported in this browser. Copy the VLC link to play externally.');
  } catch (error) { if (token === state.playToken) { $('#player-status').textContent = error.message; $('#resolve-details').textContent = JSON.stringify({ error: error.message }, null, 2); } }
  finally { if (token === state.playToken) $('#retry-playback').disabled = false; }
}

function renderEndpoint() {
  const name = $('#endpoint').value; const definition = endpoints[name]; $('#endpoint-description').textContent = definition.description;
  $('#request-fields').innerHTML = definition.fields.map(([key,label,type,value,required]) => `<label>${escapeHTML(label)}${required ? ' *' : ''}${Array.isArray(type) ? `<select name="${key}">${type.map(option => `<option value="${option}" ${option === value ? 'selected' : ''}>${option || 'Automatic / default'}</option>`).join('')}</select>` : `<input name="${key}" type="${type}" value="${escapeHTML(value)}" ${type === 'number' ? `min="${key === 's' || key === 'season' ? 0 : 1}" step="1"` : ''} ${required ? 'required' : ''}>`}</label>`).join('');
  $('#method-label').hidden = name !== 'resolve'; $('#request-method').value = 'GET'; $('#post-label').hidden = true; $('#request-fields').hidden = false;
  updateRequestPreview();
}
function formParams() { return Object.fromEntries([...$('#request-fields').querySelectorAll('input,select')].map(element => [element.name, element.value])); }
function updateRequestPreview() {
  if (!$('#endpoint').value) return;
  const post = $('#endpoint').value === 'resolve' && $('#request-method').value === 'POST';
  $('#request-preview').textContent = `${post ? 'POST' : 'GET'} ${displayURL($('#endpoint').value, post ? {} : formParams())}`;
}
function renderHistory() {
  $('#request-history').innerHTML = state.history.map(entry => `<details class="history-entry"><summary><span class="${entry.status >= 200 && entry.status < 300 ? 'success' : 'failure'}">${entry.status || 'ERR'}</span><span class="request-name">${escapeHTML(entry.method)} ${escapeHTML(entry.url.replace(state.base,''))}</span><span class="duration">${entry.duration} ms</span></summary><pre>${escapeHTML(entry.request ? `Request body:\n${JSON.stringify(entry.request,null,2)}\n\nResponse:\n` : '')}${escapeHTML(typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data,null,2))}</pre></details>`).join('') || '<div class="empty-state"><p>No requests yet. Connect your API or use the request builder.</p></div>';
}
function showHistory() { renderHistory(); openDialog('history-dialog'); }

$$('[data-close]').forEach(button => button.onclick = () => $(`#${button.dataset.close}`).close());
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('#player-dialog').addEventListener('close', stopPlayback);
$('#detail-dialog').addEventListener('close', () => ++state.detailToken);
$$('.nav-button[data-view]').forEach(button => button.onclick = () => setView(button.dataset.view));
$('#open-connection').onclick = $('#connection-pill').onclick = openConnection;
$('#hero-action').onclick = openConnection;
$('#connection-form').onsubmit = event => {
  event.preventDefault(); let base;
  try { const url = new URL($('#api-base').value.trim()); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Enter a plain HTTP or HTTPS base URL.'); base = url.href.replace(/\/+$/,''); }
  catch (error) { $('#connection-feedback').innerHTML = `<div class="feedback">${escapeHTML(error.message)}</div>`; return; }
  connect(base, true);
};
$('#refresh-library').onclick = () => state.connected ? loadCatalog() : connect(state.base);
$('#catalog-type').onchange = () => { state.type = $('#catalog-type').value; state.page = 1; state.query = ''; $('#search').value = ''; loadCatalog(); };
$$('.board-tab').forEach(button => button.onclick = () => { state.board = button.dataset.board; state.query = ''; $('#search').value = ''; state.page = 1; loadCatalog(); });
$('#search-form').onsubmit = event => { event.preventDefault(); const query = $('#search').value.trim(); if (state.view === 'lab') setView('browse'); state.query = query; $('#search').value = query; state.page = 1; loadCatalog(); };
$('#search').addEventListener('search', () => { if (!$('#search').value && state.query) { state.query = ''; state.page = 1; loadCatalog(); } });
$('#previous-page').onclick = () => { if (state.page > 1) { state.page--; loadCatalog(); } };
$('#next-page').onclick = () => { if (state.page < state.pages) { state.page++; loadCatalog(); } };
$('#refresh-servers').onclick = loadServers;
$('#show-history').onclick = $('#footer-history').onclick = showHistory;
$('#quality').onchange = () => { if (state.hls) state.hls.currentLevel = Number($('#quality').value); };
$('#retry-playback').onclick = () => { state.retryCount = 0; startPlayback(true, $('#video').currentTime || 0); };
$('#copy-stream').onclick = () => { if (state.playback) copy(new URL(localURL('watch', { ...playbackParams(), v: 'best' }, state.playback.base), location.origin).href); };
$('#endpoint').innerHTML = Object.keys(endpoints).map(name => `<option value="${name}">/${name}</option>`).join('');
$('#endpoint').onchange = renderEndpoint; $('#request-form').addEventListener('input', updateRequestPreview);
$('#request-method').onchange = () => { const post = $('#request-method').value === 'POST'; $('#post-label').hidden = !post; $('#request-fields').hidden = post; $$('#request-fields input').forEach(input => input.disabled = post); updateRequestPreview(); };
$('#request-form').onsubmit = async event => {
  event.preventDefault(); const route = $('#endpoint').value; const post = route === 'resolve' && $('#request-method').value === 'POST'; let body;
  if (post) { try { body = JSON.parse($('#post-body').value); } catch { $('#response-body').textContent = 'Invalid JSON. Check the request body and try again.'; $('#response-status').textContent = 'INVALID JSON'; return; } }
  $('#send-request').disabled = true; $('#send-request').textContent = 'Sending…'; $('#response-status').textContent = 'WAITING'; $('#response-status').classList.remove('error'); $('#response-body').textContent = 'Waiting for your API…';
  const start = performance.now();
  try { const data = await api(route, formParams(), post ? { method: 'POST', body } : {}); $('#response-body').textContent = typeof data === 'string' ? data : JSON.stringify(data,null,2); $('#response-status').textContent = `OK · ${Math.round(performance.now() - start)} ms`; }
  catch (error) { $('#response-body').textContent = error.message; $('#response-status').textContent = `${error.status || 'ERROR'} · ${Math.round(performance.now() - start)} ms`; $('#response-status').classList.add('error'); }
  finally { $('#send-request').disabled = false; $('#send-request').innerHTML = 'Send request <span>↗</span>'; }
};
$('#copy-response').onclick = () => copy($('#response-body').textContent);
$('#use-builtin-api').onclick = () => connect(location.origin, true);
document.addEventListener('keydown', event => { if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#search').focus(); } });
renderEndpoint();
(async () => {
  let base = location.origin;
  let embedded = true;
  try { const config = await fetch('/config').then(r => r.json()); embedded = config.mode === 'embedded'; base = embedded ? location.origin : config.base || base; } catch {}
  try {
    const saved = localStorage.getItem('cinejoy-api');
    // On the first standalone launch, retire saved Docker/bridge addresses.
    if (embedded && localStorage.getItem('cinejoy-api-mode') !== 'embedded-v1') localStorage.setItem('cinejoy-api-mode', 'embedded-v1');
    else if (saved) base = saved;
  } catch {}
  await connect(base);
})();
