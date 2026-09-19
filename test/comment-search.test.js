import test from 'node:test';
import assert from 'node:assert/strict';
import {searchComments} from '../lib/comment-search.js';
test('literal substring matching, normalization, and bounded query',async()=>{
 const pool={async query(sql,args){assert.match(sql,/LIMIT 2000/);assert.match(sql,/NOT comment_body_pruned/);assert.doesNotMatch(sql,/COUNT\(\*\)/);assert.equal(args[0],'host');return {rows:[{id:'a',at:'2026-09-19 00:00:00+00',userId:'u',nickname:'A',text:'ＡＢＣお願いします'},{id:'b',at:'2026-09-18 00:00:00+00',text:'50%です'}]};}};
 assert.equal((await searchComments(pool,{search:'abc',username:'host'})).items.length,1);
 const percent=await searchComments(pool,{search:'%',username:'host'});assert.equal(percent.items.length,1);assert.equal(percent.complete,true);
});
test('fifty-result cursor stops at last returned match without skipping later rows',async()=>{
 const rows=Array.from({length:60},(_,i)=>({id:String(i),at:'2026-09-19 00:00:00+00',text:'お願いします'}));
 const first=await searchComments({query:async()=>({rows})},{search:'お願いします'});
 assert.equal(first.items.length,50);assert.equal(first.complete,false);assert.equal(first.scanned,50);
 const cursor=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());assert.equal(cursor.id,'49');
 await searchComments({async query(sql,args){assert.equal(args[2],'49');return {rows:[]};}},{search:'お願いします',cursor:first.nextCursor});
 await assert.rejects(()=>searchComments({}, {search:'違う',cursor:first.nextCursor}));
});
test('empty bounded batch with more history is not reported as a completed search',async()=>{
 const rows=Array.from({length:2000},(_,i)=>({id:String(i),at:'2026-09-19 00:00:00+00',text:'なし'}));
 const result=await searchComments({query:async()=>({rows})},{search:'お願いします'});
 assert.equal(result.items.length,0);assert.equal(result.complete,false);assert.ok(result.nextCursor);
 await assert.rejects(()=>searchComments({}, {search:''}));
});
