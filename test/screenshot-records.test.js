import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';
import {screenshotRecordsSchema,recordIds,recordHandle,addScreenshotRecords,listScreenshotRecords,toggleScreenshotRecord,ScreenshotWatch} from '../lib/screenshot-records.js';
import {setupScreenshotRecords} from '../public/screenshot-records-panel.js';
import vm from 'node:vm';
import {entryDetection} from '../lib/early-entry-comment.js';

test('ID parsing deduplicates handles and rejects display names and injection',()=>{
  assert.deepEqual(recordIds('@Test.ID\ntest.id, new_user'),['test.id','new_user']);
  for(const value of ['',"x' OR TRUE --",'表示名','https://evil.test','unknown'])assert.throws(()=>recordHandle(value));
});

test('PostgreSQL records reserve unknown IDs without fabricating listeners or visits, and persist switches/bindings',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(screenshotRecordsSchema+`
    CREATE TABLE listeners(user_id text PRIMARY KEY,latest_unique_id text,latest_nickname text);
    CREATE TABLE listener_aliases(user_id text,unique_id text);
    CREATE TABLE listener_stream_stats(user_id text,stream_username text,visit_count int,comment_count int,gift_count int,like_count int,follow_count int,share_count int);
    INSERT INTO listeners VALUES ('old','existing','Old'),('quiet','profile_only','Quiet'),('amb1','newname1','A'),('amb2','newname2','B');
    INSERT INTO listener_aliases VALUES ('amb1','reused'),('amb2','reused'),('old','old_alias');
    INSERT INTO listener_stream_stats VALUES ('old','host',1,0,0,0,0,0);
  `);
  const store={ready:true,pool:db};
  await addScreenshotRecords(store,'host',{ids:'@existing @brand_new @profile_only @old_alias @reused',source:'test screenshot'});
  let records=await listScreenshotRecords(store,'host');
  assert.equal(records.length,5);
  const byId=new Map(records.map(r=>[r.tiktok_id,r]));
  assert.equal(byId.get('existing').history,'found');assert.equal(byId.get('existing').enabled,false);
  assert.equal(byId.get('old_alias').user_id,'old');assert.equal(byId.get('old_alias').history,'found');
  assert.equal(byId.get('brand_new').history,'none');assert.equal(byId.get('brand_new').enabled,true);
  assert.equal(byId.get('profile_only').history,'none');
  assert.equal(byId.get('reused').history,'ambiguous');assert.equal(byId.get('reused').enabled,false);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM listeners')).rows[0].n,4);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM listener_stream_stats')).rows[0].n,1);
  await toggleScreenshotRecord(store,'host',{id:'existing',enabled:true});
  await addScreenshotRecords(store,'host',{ids:'existing',source:'another screenshot'});
  assert.equal((await listScreenshotRecords(store,'host')).find(r=>r.tiktok_id==='existing').enabled,true,'reimport must preserve notification setting');
  const watch=new ScreenshotWatch();await watch.refresh(store);
  const now=Date.now(),person={userId:'stable123',uniqueId:'brand_new',nickname:'New'};
  assert.ok(watch.accept('host','live1',person,now,now));
  assert.equal(watch.accept('host','live1',person,now,now),null);
  assert.equal(watch.accept('other','live1',person,now,now),null);
  assert.equal(watch.accept('host','live2',person,now-31000,now),null);
  await watch.refresh(store);
  const restart=new ScreenshotWatch();await restart.refresh(store);
  assert.ok(restart.match('host',{...person,uniqueId:'changed_handle'}));
  assert.equal(restart.match('host',{userId:'imposter',uniqueId:'brand_new'}),null);
  await toggleScreenshotRecord(store,'host',{id:'brand_new',enabled:false});await restart.refresh(store);
  assert.equal(restart.match('host',person),null);
  await assert.rejects(()=>listScreenshotRecords({ready:false},'host'),e=>e.status===503);
});

test('panel renders records safely, imports multiple IDs, and restores toggles after errors',async t=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html);t.after(()=>dom.window.close());
  const previous=globalThis.document;globalThis.document=dom.window.document;t.after(()=>{globalThis.document=previous;});
  const root=document.getElementById('screenshotRecordsPanel');
  const items=[{tiktok_id:'test_id',nickname:'<img onerror=bad>',history:'none',source:'capture',enabled:true}];
  let fail=false;const requests=[];
  const panel=setupScreenshotRecords({root,getUsername:()=> 'host',storage:{getItem:()=> 'fixture-key',setItem(){}},fetcher:async(url,options)=>{
    requests.push({url,options});return {ok:!fail,status:fail?503:200,json:async()=>fail?{error:'照合未完了'}:{items}};
  }});
  panel.setScope();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(root.querySelectorAll('li').length,1);assert.equal(root.querySelector('img'),null);
  assert.match(root.textContent,/履歴なし/);
  const toggle=root.querySelector('input[type=checkbox]');fail=true;toggle.checked=false;toggle.dispatchEvent(new dom.window.Event('change'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(root.querySelector('input[type=checkbox]').checked,true);
  assert.match(root.textContent,/照合未完了/);fail=false;
  root.querySelector('#screenshotIds').value='@new_id\n@next_id';
  root.querySelector('#screenshotAddForm').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.at(-1).options.method,'POST');assert.equal(JSON.parse(requests.at(-1).options.body).ids,'@new_id\n@next_id');
});

test('actual arrival processing emits a separate screenshot alert once and keeps legacy notices independent',async()=>{
  const source=await readFile(new URL('../server.js',import.meta.url),'utf8');
  const method=source.slice(source.indexOf('  markSeen(person,'),source.indexOf('  markHeartMe(person,'));
  const watch=new ScreenshotWatch();watch.replace([{stream_username:'host',tiktok_id:'recorded',user_id:'',enabled:true}]);
  const emitted=[];
  const session=vm.runInNewContext(`({id:'live',username:'host',recordingEnabled:true,userStats:new Map(),pendingVisitChecks:new Map(),viewerStats:{knownJoins:0},
    currentEventSource(){return 'live'},getUserStat(id,name,at){return this.userStats.get(id)||{userId:id,nickname:name,lastSeenAt:at}},
    recordVisit(){},broadcastPresence(){},enqueueVisitCheck(){},broadcast(type,payload){emitted.push({type,payload})},${method}})`,
    {screenshotWatch:watch,entryDetection,isAnonymousListenerIdentity:p=>!p.userId,attentionAlerts:{accept:()=>null},welcomeAlerts:{accept:()=>null},emitted});
  const now=Date.now(),person={userId:'known-user',uniqueId:'recorded',nickname:'Recorded'};
  session.markSeen(person,now,'member',{entryEvent:true});session.markSeen(person,now,'comment');
  assert.deepEqual(emitted.map(e=>e.type),['screenshot_alert']);assert.equal(emitted[0].payload.alert.kind,'screenshot');
  assert.equal(session.viewerStats.knownJoins,1);
});
