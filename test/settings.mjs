import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, defaultConfig, activeUser, publicUser } from '../api/settings.mjs';

test('migrates the legacy owner, persists users and settings, validates permissions and serializes writes', async()=>{
 const directory=await mkdtemp(join(tmpdir(),'freeiptv-settings-'));
 try{
 const old={username:'owner',password:'password123',secret:'a'.repeat(64),createdAt:'1234',pinned:[{id:1,type:'movie'}]};
 await writeFile(join(directory,'iptv.json'),JSON.stringify(old));
 const store=createSettingsStore(directory);await store.initialize({port:9000,iptv:{catalogPages:5}});
 const owner=store.user(store.get().ownerId);assert.equal(owner.role,'admin');assert.equal(store.config().server.port,9000);assert.equal(store.config().catalog.pages,5);assert.deepEqual(JSON.parse(await readFile(join(directory,'iptv.pre-users.json'))),old);
 const [alice,bob]=await Promise.all(['alice','bob'].map(username=>store.upsertUser({username,password:'password123'},owner)));
 assert.equal(store.get().users.length,3);assert.equal(store.authenticate('alice','password123').id,alice.id);assert.equal(store.authenticate('alice','wrong'),undefined);assert.ok(!('password' in publicUser(alice)));
 await assert.rejects(store.upsertUser({username:'ALICE',password:'password123'},owner),{status:409});
 await assert.rejects(store.upsertUser({username:'evil',password:'password123',role:'admin'},alice),{status:403});
 await assert.rejects(store.upsertUser({role:'admin'},alice,alice.id),{status:403});
 await assert.rejects(store.removeUser(owner.id,owner),{status:400});await assert.rejects(store.upsertUser({enabled:false},owner,owner.id),{status:400});
 const changed=await store.upsertUser({password:'newpassword'},owner,alice.id);assert.ok(changed.version>alice.version);assert.equal(store.authenticate('alice','password123'),undefined);
 await store.upsertUser({enabled:false},owner,alice.id);assert.equal(store.authenticate('alice','newpassword'),undefined);
 await store.upsertUser({expiresAt:'2020-01-01T00:00:00Z'},owner,bob.id);assert.ok(!activeUser(store.user(bob.id)));
 await assert.rejects(store.configure({playback:{enabled:[]}}),{status:400});await assert.rejects(store.configure({playback:{order:['cinejoy']}}),{status:400});await assert.rejects(store.configure({server:{publicUrl:'javascript:alert(1)'}}),{status:400});
 await store.configure({playback:{order:[...defaultConfig().playback.order].reverse(),enabled:['atlantic'],cacheSeconds:0},server:{name:'Living room'}});
 await store.upsertUser({username:'newowner',password:'newpassword'},owner,owner.id);
 const saved=JSON.parse(await readFile(join(directory,'iptv.json')));assert.equal(saved.username,'newowner');assert.equal(saved.password,'newpassword');assert.equal(saved.config.server.name,'Living room');assert.equal(saved.users.length,3);
 const reloaded=createSettingsStore(directory);await reloaded.initialize();assert.deepEqual(reloaded.config(),saved.config);assert.equal(reloaded.authenticate('newowner','newpassword').role,'admin');
 }finally{await rm(directory,{recursive:true,force:true});}
});
