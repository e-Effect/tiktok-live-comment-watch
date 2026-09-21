import test from 'node:test';
import assert from 'node:assert/strict';
import {historyUrl,setupCommentHistory} from '../public/viewer-comment-history.js';
test('history URL requests only ten comments scoped to streamer',()=>{
 const u=new URL(historyUrl('id/one','host'),'https://example.com');
 assert.equal(u.pathname,'/api/listeners/id%2Fone/history');assert.equal(u.searchParams.get('limit'),'10');assert.equal(u.searchParams.get('username'),'host');
});
test('no background fetch, click loads authenticated history safely, capped at ten',async()=>{
 const previous={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage,fetch:globalThis.fetch};
 function node(){return {handlers:{},children:[],value:'',open:false,dataset:{},addEventListener(k,fn){this.handlers[k]=fn;},replaceChildren(){this.children=[];},append(...v){this.children.push(...v);},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},focus(){}};}
 const nodes=new Map(),list=node();let calls=0;
 try {
 globalThis.document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
 globalThis.window={getSelection:()=>({toString:()=>''})};globalThis.localStorage={getItem:()=> 'test-key',setItem(){}};
 globalThis.fetch=async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer test-key');assert.match(url,/limit=10/);return {ok:true,json:async()=>({items:Array.from({length:12},()=>({at:'2026-09-21T00:00:00Z',text:'<img onerror=bad>'}))})};};
 setupCommentHistory(list,()=>({username:'host'}));assert.equal(calls,0);
 list.handlers.click({target:{closest:()=>({dataset:{userId:'user',userName:'名前'}})}});
 await new Promise(r=>setImmediate(r));
 assert.equal(calls,1);assert.equal(nodes.get('viewerCommentHistoryItems').children.length,10);
 assert.equal(nodes.get('viewerCommentHistoryItems').children[0].children[1].textContent,'<img onerror=bad>');
 assert.match(nodes.get('viewerCommentHistoryTitle').textContent,/名前/);
 nodes.get('viewerCommentHistoryClose').handlers.click();assert.equal(nodes.get('viewerCommentHistory').open,false);
 } finally {Object.assign(globalThis,previous);}
});
