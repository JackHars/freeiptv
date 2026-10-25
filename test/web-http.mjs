import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('web login, admin settings, multiple Xtream users, session revocation, signed links and CSRF protection',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'freeiptv-web-'));process.env.FREEIPTV_DATA_DIR=directory;
 const { settingsStore }=await import('../api/settings.mjs');const { createServer }=await import('../server.mjs');
 const { initializeIPTV, setIPTVCredentials }=await import('../api/iptv.mjs');
 const original=globalThis.fetch;let server;
 try{
  await settingsStore.initialize();const owner=settingsStore.user(settingsStore.get().ownerId);
  await settingsStore.upsertUser({username:'owner',password:'password123'},owner,owner.id);
  await initializeIPTV();const version=settingsStore.user(owner.id).version;await setIPTVCredentials('owner','password123');assert.equal(settingsStore.user(owner.id).version,version);server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  globalThis.fetch=async (url,options)=>{
   if(new URL(url).hostname==='127.0.0.1')return original(url,options);
   if(new URL(url).hostname==='api.zstream.mov')return new Response(JSON.stringify({streams:[{type:'hls',playlist:'https://fixture.test/master'}]}));
   if(url==='https://fixture.test/master')return new Response('#EXTM3U\n#EXTINF:6,\nseg.ts\n');
   if(url==='https://fixture.test/seg.ts')return new Response(Buffer.alloc(188*4,0x47));
   if(new URL(url).hostname==='api.themoviedb.org' && new URL(url).pathname==='/3/configuration'){if(options.headers.authorization==='Bearer invalid-fixture-credential')return new Response('{}',{status:401});return new Response(JSON.stringify({images:{secure_base_url:'https://image.tmdb.org/t/p/'}}));}
   if(String(url).includes('api.themoviedb.org'))return new Response(JSON.stringify({results:[],genres:[],id:550,title:'Fixture Movie'}));
   return new Response('not found',{status:404});
  };
  async function request(path,{cookie,method='GET',body,origin}={}){return fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...(origin?{origin}:{})},body:body?JSON.stringify(body):undefined});}
  const home=await request('/');assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await home.text(),/app.js/);
  assert.equal((await request('/vendor/hls.js')).status,200);assert.equal((await request('/ui/settings')).status,401);
  assert.equal((await request('/ui/login',{method:'POST',body:{username:'owner',password:'password123'},origin:'https://evil.test'})).status,403);
  let r=await request('/ui/login',{method:'POST',body:{username:'owner',password:'password123'},origin:base});assert.equal(r.status,200);const admin=r.headers.get('set-cookie').split(';')[0];assert.match(r.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await request('/ui/session',{cookie:admin}).then(r=>r.json())).setupRequired,true);
  assert.equal((await request('/resolve?tmdb=550',{cookie:admin})).status,428);
  assert.equal((await request('/player_api.php?username=owner&password=password123')).status,428);
  r=await request('/ui/browse',{cookie:admin});assert.equal(r.status,428);assert.equal((await r.json()).code,'TMDB_SETUP_REQUIRED');
  assert.equal((await request('/ui/tmdb',{method:'PUT',cookie:admin,body:{credential:'fixture-tmdb-credential'},origin:'https://evil.test'})).status,403);
  assert.equal((await request('/ui/tmdb',{method:'PUT',cookie:admin,body:{credential:'invalid-fixture-credential'}})).status,400);
  assert.equal((await request('/ui/tmdb',{method:'PUT',cookie:admin,body:{credential:'fixture-tmdb-credential'}})).status,200);
  r=await request('/ui/settings',{cookie:admin});const configText=await r.text();assert.ok(!configText.includes('fixture-tmdb-credential'));assert.equal(JSON.parse(configText).config.metadata.configured,true);
  assert.equal((await request('/ui/session',{cookie:admin}).then(r=>r.json())).setupRequired,false);
  assert.ok(!(await request('/ui/activity',{cookie:admin}).then(r=>r.text())).includes('fixture-tmdb-credential'));
  assert.equal((await request('/ui/settings',{method:'PUT',cookie:admin,body:{metadata:{tmdbCredential:'bypass-credential'}}})).status,400);
  r=await request('/ui/users',{method:'POST',cookie:admin,body:{username:'viewer',password:'viewerpass'}});assert.equal(r.status,201);const viewer=(await r.json()).user;assert.ok(!('password'in viewer));
  r=await request('/ui/login',{method:'POST',body:{username:'viewer',password:'viewerpass'}});const cookie=r.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/ui/settings',{cookie})).status,403);
  assert.equal((await request('/ui/tmdb',{method:'PUT',cookie,body:{credential:'fixture-tmdb-credential'}})).status,403);
  assert.equal((await request('/resolve?tmdb=550')).status,401);assert.equal((await request('/resolve?tmdb=550',{cookie})).status,403);assert.equal((await request('/proxy?u=https://fixture.test/master',{cookie})).status,403);assert.equal((await request('/ui/users',{cookie,method:'POST',body:{username:'other',password:'otherpass'}})).status,403);
  assert.equal((await request('/ui/connections?user='+owner.id,{cookie})).status,403);
  r=await request('/ui/connections',{cookie});const links=await r.json();assert.equal(links.username,'viewer');assert.ok(links.playlist.includes('username=viewer'));assert.ok(!links.playlist.includes('password=password123'));
  r=await request('/player_api.php?username=viewer&password=viewerpass');const account=await r.json();assert.equal(account.user_info.username,'viewer');assert.equal(account.user_info.password,'viewerpass');
  r=await request('/player_api.php?username=viewer&password=viewerpass&action=get_vod_info&vod_id=550');assert.match((await r.json()).movie_data.direct_source,/\/movie\/viewer\/viewerpass\/550/);
  r=await request('/ui/settings',{cookie:admin,method:'PUT',body:{playback:{enabled:['zstream'],quality:'adaptive',providerTimeout:10,totalTimeout:20}}});assert.equal(r.status,200);
  r=await request('/ui/play',{cookie,method:'POST',body:{type:'movie',id:550}});assert.equal(r.status,200);const play=await r.json();assert.equal(play.provider,'zstream');assert.equal((await fetch(play.url)).status,200);
  await request('/ui/settings',{cookie:admin,method:'PUT',body:{server:{publicUrl:'http://livingroom.local:8091'}}});
  const relay=await fetch(play.url);assert.equal(relay.status,200);const manifest=await relay.text();assert.ok(manifest.includes(base+'/iptv/media/'));assert.ok(!manifest.includes('livingroom.local'));
  r=await request('/ui/connections',{cookie});assert.equal((await r.json()).server,'http://livingroom.local:8091');
  assert.equal((await request('/iptv/refresh',{method:'POST',cookie,body:{}})).status,403);
  assert.equal((await request('/ui/settings',{method:'PUT',cookie:admin,body:{server:{name:'Hijacked'}},origin:'https://evil.test'})).status,403);
  assert.equal((await request('/ui/users/'+viewer.id,{method:'PUT',cookie:admin,body:{enabled:false}})).status,200);
  assert.equal((await request('/ui/connections',{cookie})).status,401);assert.equal((await fetch(play.url)).status,403);assert.equal((await request('/player_api.php?username=viewer&password=viewerpass')).status,401);
  r=await request('/ui/account',{method:'PUT',cookie:admin,body:{username:'owner2',currentPassword:'password123',password:'newpassword'}});assert.equal(r.status,200);const renewed=r.headers.get('set-cookie').split(';')[0];assert.equal((await request('/ui/settings',{cookie:admin})).status,401);assert.equal((await request('/ui/settings',{cookie:renewed})).status,200);
  assert.equal((await request('/ui/users/'+owner.id,{method:'DELETE',cookie:renewed})).status,400);
 }finally{globalThis.fetch=original;server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
