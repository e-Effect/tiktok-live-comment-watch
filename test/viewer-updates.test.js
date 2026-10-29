import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createSnapshotGuard,patchCommentRows} from '../public/viewer-updates.js';
import {createCommentUpdateGate} from '../public/comment-selection-search.js';
import {normalizeCollectorEvent} from '../lib/external-collector.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('replayed collector gifts have stable storage IDs without changing native message IDs', () => {
  const raw={event:'gift',collectorEventId:'durable-123',data:{giftId:'g',repeatCount:2,userId:'viewer'}};
  const a=normalizeCollectorEvent(raw),b=normalizeCollectorEvent(structuredClone(raw));
  assert.equal(a.data.msgId,b.data.msgId);
  assert.ok(a.data.msgId);
  assert.notEqual(a.data.msgId,normalizeCollectorEvent({...raw,collectorEventId:'durable-124'}).data.msgId);
  assert.equal(raw.data.msgId,undefined,'do not mutate the received packet');
  assert.equal(normalizeCollectorEvent({...raw,data:{...raw.data,msgId:'native-id'}}).data.msgId,'native-id');
});

test('a live update or a newer completed request invalidates an older snapshot', async () => {
  const guard=createSnapshotGuard();
  const oldRequest=guard.capture('session');
  await Promise.resolve();
  guard.changed('session');
  assert.equal(guard.isCurrent('session',oldRequest),false);
  assert.equal(guard.isCurrent('other',0),true);
  const newRequest=guard.capture('session');
  assert.equal(guard.isCurrent('session',newRequest),true);
  guard.changed('session');
  assert.equal(guard.isCurrent('session',newRequest),false);
});

test('new comments reuse existing DOM and preserve keyboard focus; changed badges update', t => {
  const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());
  const list=dom.window.document.querySelector('main');
  const render=c=>`<article class="comment" tabindex="0"><p>${c.text}</p><b>${c.rank||''}</b></article>`;
  const a={id:'a',text:'first'},b={id:'b',text:'second'},c={id:'c',text:'third'};
  patchCommentRows(list,[b,a],render,'empty');
  const oldA=list.children[1],oldB=list.children[0];oldA.focus();
  patchCommentRows(list,[c,b,a],render,'empty');
  assert.equal(list.children[1],oldB);assert.equal(list.children[2],oldA);
  assert.equal(dom.window.document.activeElement,oldA);
  patchCommentRows(list,[c,{...b,rank:'S'},a],render,'empty');
  assert.notEqual(list.children[1],oldB);assert.equal(list.children[1].querySelector('b').textContent,'S');
  assert.equal(list.children[2],oldA);
  patchCommentRows(list,[c,a],render,'empty');assert.equal(list.children.length,2);
  let paused=true;const gate=createCommentUpdateGate(()=>paused);
  gate.update(()=>patchCommentRows(list,[a],render,'empty'));assert.equal(list.children.length,2);
  paused=false;gate.flush();assert.equal(list.children[0],oldA);assert.equal(list.children.length,1);
  patchCommentRows(list,[],render,'empty');assert.equal(list.textContent,'empty');
  patchCommentRows(list,[a],render,'empty');assert.equal(list.children.length,1);assert.equal(list.textContent,'first');
});

test('the actual viewer boots and renders live comments with incremental updates', async t => {
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://viewer.test/',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  dom.window.fetch=async()=>({ok:true,json:async()=>({ok:true,sessions:0,provider:{},collector:{},database:{}})});
  const files=['viewer-comment-history.js','comment-selection-search.js','viewer-updates.js','screenshot-records-panel.js','app.js'];
  const sources=await Promise.all(files.map(file=>readFile(new URL('../public/'+file,import.meta.url),'utf8')));
  const script=sources.map(source=>source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')).join('\n');
  vm.runInContext(script+'\n globalThis.auditViewer={renderSnapshot,applyRealtimePayload,sessions};',dom.getInternalVMContext());
  const {renderSnapshot,applyRealtimePayload}=dom.window.auditViewer;
  const snapshot={id:'audit',username:'audit',status:'connected',startedAt:Date.now(),comments:[],gifts:[],shares:[],topUsers:[],visitors:[],viewerStats:{},heartMeStats:{},followStats:{}};
  renderSnapshot(snapshot);
  renderSnapshot({...snapshot,screenshotAlerts:[{kind:'screenshot',userId:'u',nickname:'Recorded',expiresAt:Date.now()+60000}]});
  assert.match(dom.window.document.querySelector('.screenshot-arrival-alert').textContent,/スクショ記録ID/);
  applyRealtimePayload('audit','comment',{comment:{id:'c1',userId:'u',nickname:'Listener',text:'<safe text>',at:Date.now(),screenshotRecorded:true},summary:{commentCount:1}});
  await new Promise(resolve=>setTimeout(resolve,100));
  const comment=dom.window.document.querySelector('article.comment');
  assert.ok(comment);assert.equal(comment.querySelector('.comment-text').textContent,'<safe text>');
  assert.equal(comment.querySelector('safe'),null);
  assert.ok(comment.querySelector('.screenshot-record-badge'));
});
