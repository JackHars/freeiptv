import { readFile } from 'node:fs/promises';
import { settingsStore, publicUser, problem } from './settings.mjs';
import { requireSession, sessionUser, requestOrigin, sameOrigin, login, signOut, issueSession } from './sessions.mjs';
import { initializeIPTV, browserPlay, browserSports, catalogStatus, refreshCatalog } from './iptv.mjs';
import { getCatalogData } from './platform.mjs';

const activity = [], started = Date.now();
export function recordActivity(event) { if (event.target === '/ui/activity') return; activity.push({ ...event, at: new Date().toISOString() }); if (activity.length > 200) activity.shift(); }
const json = (res, status, data) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw problem(415, 'Send JSON.');
  let text = ''; for await (const part of req) { text += part; if (Buffer.byteLength(text) > 32768) throw problem(413, 'Request too large.'); }
  try { const data = JSON.parse(text); if (!data || Array.isArray(data) || typeof data !== 'object') throw Error(); return data; } catch { throw problem(400, 'Invalid JSON.'); }
}
function connections(req, user) {
  const base = settingsStore.config().server.publicUrl || requestOrigin(req);
  const q = new URLSearchParams({ username: user.username, password: user.password });
  return { server: base, username: user.username, password: user.password, playlist: `${base}/get.php?${q}&type=m3u_plus&output=m3u8`, sports: `${base}/get.php?${q}&type=m3u_plus&output=m3u8&content=live`, guide: `${base}/xmltv.php?${q}`, format: 'HLS / m3u8' };
}
const files = new Map([
  ['/', ['../public/index.html','text/html; charset=utf-8']],
  ['/app.css', ['../public/app.css','text/css']], ['/app.js', ['../public/app.js','text/javascript']],
  ['/vendor/hls.js', ['../node_modules/hls.js/dist/hls.min.js','text/javascript']],
  ['/favicon.svg', ['../public/favicon.svg','image/svg+xml']],
  ['/brand.svg', ['../public/brand.svg','image/svg+xml']],
]);
export async function handleWeb(req, res) {
  const url = new URL(req.url, 'http://local'), path = url.pathname;
  if (files.has(path) && ['GET','HEAD'].includes(req.method)) {
    const [file, type] = files.get(path);
    try {
      const data = await readFile(new URL(file, import.meta.url));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; img-src 'self' https://image.tmdb.org data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'" });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { json(res, 500, { error: 'Web files are missing. Run npm ci and try again.' }); }
    return true;
  }
  if (!path.startsWith('/ui/')) return false;
  try {
    await initializeIPTV();
    if (req.method !== 'GET') sameOrigin(req);
    if (path === '/ui/login' && req.method === 'POST') { const data = await body(req); return json(res, 200, { user: publicUser(login(req, res, data.username, data.password)) }), true; }
    if (path === '/ui/logout' && req.method === 'POST') { signOut(req,res); return json(res,200,{ok:true}),true; }
    if (path === '/ui/session' && req.method === 'GET') { const user = sessionUser(req); return json(res,200,{ user: user ? publicUser(user) : null, name: settingsStore.config().server.name }),true; }
    const user = requireSession(req);
    if (path === '/ui/browse' && req.method === 'GET') {
      const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
      const query = (url.searchParams.get('q') || '').slice(0,200);
      const page = Math.min(100,Math.max(1,Number(url.searchParams.get('page'))||1));
      const board = ['popular','top_rated','now_playing','on_the_air'].includes(url.searchParams.get('board')) ? url.searchParams.get('board') : 'popular';
      const data = await getCatalogData(query ? '/search/multi' : `/${type}/${board}`, { page, ...(query ? { query } : {}) });
      json(res,200,{items:(data.results||[]).filter(i=>!i.adult && (query ? ['movie','tv'].includes(i.media_type):true)).map(i=>({...i,type:i.media_type||type})),page,pages:data.total_pages}); return true;
    }
    if (['/ui/title','/ui/episodes'].includes(path) && req.method === 'GET') {
      const id = url.searchParams.get('id'), type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie', season = url.searchParams.get('season') || '1';
      if (!/^[1-9]\d*$/.test(id||'') || !/^\d+$/.test(season)) throw problem(400,'Invalid title or season.');
      json(res,200,await getCatalogData(path === '/ui/episodes' ? `/tv/${id}/season/${season}` : `/${type}/${id}`, path === '/ui/title' ? {append_to_response:'credits'} : {})); return true;
    }
    if (path === '/ui/live' && req.method === 'GET') { json(res,200,{items:await browserSports()}); return true; }
    if (path === '/ui/play' && req.method === 'POST') { json(res,200,await browserPlay(req,res,user,await body(req))); return true; }
    if (path === '/ui/connections' && req.method === 'GET') {
      const target = url.searchParams.get('user') || user.id;
      if (target !== user.id && user.role !== 'admin') throw problem(403,'You can only view your own connection details.');
      const account = settingsStore.user(target); if (!account) throw problem(404,'User not found.');
      json(res,200,connections(req,account)); return true;
    }
    if (path === '/ui/account' && req.method === 'PUT') {
      const input = await body(req);
      if (!settingsStore.authenticate(user.username,input.currentPassword)) throw problem(403,'Your current password is incorrect.');
      const changed = await settingsStore.upsertUser({username:input.username,password:input.password},user,user.id);
      issueSession(res,changed); json(res,200,{user:publicUser(changed)}); return true;
    }
    requireSession(req,true);
    if (path === '/ui/settings' && req.method === 'GET') {
      json(res,200,{config:settingsStore.config(),users:settingsStore.get().users.map(publicUser),ownerId:settingsStore.get().ownerId,catalog:catalogStatus(),uptime:Math.floor((Date.now()-started)/1000),running:{host:process.env.HOST||req.socket.localAddress,port:req.socket.localPort}}); return true;
    }
    if (path === '/ui/settings' && req.method === 'PUT') { const state = await settingsStore.configure(await body(req)); json(res,200,{config:state.config}); return true; }
    if (path === '/ui/users' && req.method === 'POST') { const added = await settingsStore.upsertUser(await body(req),user); json(res,201,{user:publicUser(added)}); return true; }
    if (/^\/ui\/users\/[^/]+$/.test(path)) {
      const id = path.split('/').at(-1);
      if (req.method === 'PUT') { const changed=await settingsStore.upsertUser(await body(req),user,id); if(changed.id===user.id)issueSession(res,changed); json(res,200,{user:publicUser(changed)}); return true; }
      if (req.method === 'DELETE') { await settingsStore.removeUser(id,user); json(res,200,{ok:true}); return true; }
    }
    if (path === '/ui/refresh' && req.method === 'POST') { refreshCatalog().catch(e=>console.warn('Catalog refresh:',e.message)); json(res,202,{refreshing:true}); return true; }
    if (path === '/ui/activity' && req.method === 'GET') { json(res,200,{items:[...activity].reverse()}); return true; }
    throw problem(404,'Not found.');
  } catch(e) { json(res,e.status||502,{error:e.message}); }
  return true;
}
