import test from 'node:test';
import assert from 'node:assert/strict';
import {historyUrl,setupCommentHistory,tiktokProfileUrl} from '../public/viewer-comment-history.js';
test('history URL requests only twenty comments scoped to streamer',()=>{
 const u=new URL(historyUrl('id/one','host'),'https://example.com');
 assert.equal(u.pathname,'/api/listeners/id%2Fone/history');assert.equal(u.searchParams.get('limit'),'20');assert.equal(u.searchParams.get('username'),'host');
});
test('no background fetch, click loads authenticated history safely, capped at twenty',async()=>{
 const previous={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage,fetch:globalThis.fetch};
 function node(){return {handlers:{},children:[],value:'',open:false,dataset:{},removeAttribute(k){delete this[k];},addEventListener(k,fn){this.handlers[k]=fn;},replaceChildren(){this.children=[];},append(...v){this.children.push(...v);},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},focus(){}};}
 const nodes=new Map(),list=node();let calls=0;
 try {
 globalThis.document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
 globalThis.window={getSelection:()=>({toString:()=>''})};globalThis.localStorage={getItem:()=> 'test-key',setItem(){}};
 globalThis.fetch=async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer test-key');assert.match(url,/limit=20/);return {ok:true,json:async()=>({items:Array.from({length:22},()=>({at:'2026-09-21T00:00:00Z',text:'<img onerror=bad>'}))})};};
 setupCommentHistory(list,()=>({username:'host'}));assert.equal(calls,0);
 list.handlers.click({target:{closest:selector=>selector.startsWith('[data-')?{dataset:{userId:'user',userName:'名前',uniqueId:'test.viewer'}}:null}});
 await new Promise(r=>setImmediate(r));
 assert.equal(calls,1);assert.equal(nodes.get('viewerCommentHistoryItems').children.length,20);
 assert.equal(nodes.get('viewerCommentHistoryItems').children[0].children[1].textContent,'<img onerror=bad>');
 assert.match(nodes.get('viewerCommentHistoryTitle').textContent,/名前/);
 assert.equal(nodes.get('viewerCommentHistoryProfile').href,'https://www.tiktok.com/@test.viewer');
 nodes.get('viewerCommentHistoryClose').handlers.click();assert.equal(nodes.get('viewerCommentHistory').open,false);
 } finally {Object.assign(globalThis,previous);}
});

test('profile links use handles only and cannot become arbitrary URLs',()=>{
 assert.equal(tiktokProfileUrl(' @a.b_123 '),'https://www.tiktok.com/@a.b_123');
 for(const value of ['', 'unknown', 'javascript:alert(1)', 'https://other.test', '../other', 'a/b', 'a" onclick="bad', '表示名']) assert.equal(tiktokProfileUrl(value),'');
});

function harness(t,fetcher) {
 const previous={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage,fetch:globalThis.fetch};
 const node=()=>({handlers:{},children:[],value:'',open:false,dataset:{},removeAttribute(k){delete this[k];},addEventListener(k,fn){this.handlers[k]=fn;},replaceChildren(){this.children=[];},append(...v){this.children.push(...v);},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},focus(){}});
 const nodes=new Map(),roots=[node(),node(),node(),node()];let selection='',preview=false;
 globalThis.document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
 globalThis.window={getSelection:()=>({toString:()=>selection})};globalThis.localStorage={getItem:()=> 'test-key',setItem(){}};globalThis.fetch=fetcher;
 t.after(()=>Object.assign(globalThis,previous));
 setupCommentHistory(roots,()=>({username:'host',preview}));
 const row=(userId,uniqueId='')=>({dataset:{userId,userName:userId,uniqueId},closest(selector){return selector.startsWith('[data-')?this:null;}});
 return {nodes,roots,row,select:v=>selection=v,preview:v=>preview=v};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('all four lists open history by click or keyboard, but selection and nested controls do not',async t=>{
 const calls=[];const h=harness(t,async(url)=>{calls.push(url);return {ok:true,json:async()=>({items:[]})};});
 for(const [i,root] of h.roots.entries()){
  root.handlers.click({target:h.row('user'+i,'known')});await tick();
  assert.match(calls.at(-1),new RegExp('/user'+i+'/history'));
 }
 assert.equal(calls.length,4);
 h.select('選択した文字');h.roots[0].handlers.click({target:h.row('skip','known')});h.select('');
 h.roots[0].handlers.click({target:{closest:()=>({tagName:'A'})}});
 assert.equal(calls.length,4);
 let prevented=0;
 for(const key of ['Enter',' ']){h.roots[1].handlers.keydown({key,target:h.row('key','known'),preventDefault(){prevented++;}});await tick();}
 assert.equal(prevented,2);assert.equal(calls.length,6);
 h.roots[1].handlers.keydown({key:' ',repeat:true,target:h.row('key','known')});
 assert.equal(calls.length,6);
});
test('missing handle resolves from saved profile without blocking comment history',async t=>{
 const h=harness(t,async(url,options)=>{
  assert.equal(options.headers.Authorization,'Bearer test-key');
  return {ok:true,json:async()=>url.includes('/history?')?{items:[{at:1,text:'履歴'}]}:{listener:{uniqueId:'saved.handle'}}};
 });
 h.roots[2].handlers.click({target:h.row('123456')});await tick();
 assert.equal(h.nodes.get('viewerCommentHistoryProfile').href,'https://www.tiktok.com/@saved.handle');
 assert.equal(h.nodes.get('viewerCommentHistoryItems').children.length,1);
});
test('late profile responses cannot replace a different listener, and preview makes no requests',async t=>{
 let finish,calls=0;
 const h=harness(t,async url=>{
  calls++;
  if(!url.includes('/history?'))return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({listener:{uniqueId:'old.handle'}})});});
  return {ok:true,json:async()=>({items:[]})};
 });
 h.roots[0].handlers.click({target:h.row('old')});await tick();
 h.roots[1].handlers.click({target:h.row('new','new.handle')});finish();await tick();
 assert.equal(h.nodes.get('viewerCommentHistoryProfile').href,'https://www.tiktok.com/@new.handle');
 const previousCalls=calls;h.preview(true);h.roots[2].handlers.click({target:h.row('demo','fake.handle')});await tick();
 assert.equal(calls,previousCalls);assert.equal(h.nodes.get('viewerCommentHistoryProfile').hidden,true);
 assert.equal(h.nodes.get('viewerCommentHistoryProfile').href,undefined);
});
test('unknown profile is never guessed from a numeric user ID and does not hide comments',async t=>{
 const h=harness(t,async url=>({ok:url.includes('/history?'),json:async()=>({items:[]})}));
 h.roots[2].handlers.click({target:h.row('987654321')});await tick();
 assert.equal(h.nodes.get('viewerCommentHistoryProfile').hidden,true);
 assert.equal(h.nodes.get('viewerCommentHistoryProfile').href,undefined);
 assert.match(h.nodes.get('viewerCommentHistoryStatus').textContent,/まだありません/);
});
