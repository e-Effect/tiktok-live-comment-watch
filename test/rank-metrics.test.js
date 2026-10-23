import test from 'node:test';
import assert from 'node:assert/strict';
import {readRankMetrics} from '../lib/rank-metrics.js';
test('rank reads are sequential, ten users maximum, with one fixed 90-day window', async () => {
  const batches=[], windows=[];
  let active=0;
  const pool={async query(sql,args){
    assert.equal(active,0);active++;
    try {
      await Promise.resolve();
      if(sql.includes('listener_stream_stats')) return {rows:Array.from({length:21},(_,i)=>({user_id:String(i+1),coins:100,comments:10}))};
      assert.ok(args[0].length<=10);
      if(sql.includes('FROM live_events')) {
        batches.push(args[0]);windows.push([args[2].getTime(),args[3].getTime()]);
        assert.match(sql,/NULLIF\(item_count,0\)>10/);
        return {rows:args[0].map(user_id=>({user_id,recent_comments:user_id==='1'?9:10,recent_coins:100}))};
      }
      assert.ok(!args[0].includes('1'));
      if(sql.includes('viewer_visits')) return {rows:args[0].map(user_id=>({user_id,recent_visits:2}))};
      return {rows:args[0].map(user_id=>({user_id,search_text:user_id}))};
    } finally {active--;}
  }};
  const result=await readRankMetrics(pool,'host',{pause:async()=>{}});
  assert.deepEqual(batches.map(b=>b.length),[10,10,1]);
  assert.equal(result.length,20);assert.equal(result[0].recent_visits,2);
  for(const w of windows){assert.deepEqual(w,windows[0]);assert.equal(w[1]-w[0],90*86400000);}
});

test('candidate keyset pages include cross-stream totals and skip sparse matches without HAVING',async()=>{
 const pages=[], updates=[];
 const pool={async query(sql,args){
  if(sql.includes('listener_stream_stats')) {
   assert.doesNotMatch(sql,/HAVING/);assert.match(sql,/SUM\(gift_coins\)/);
   pages.push(args[0]);
   return {rows:args[0]?[]:Array.from({length:500},(_,i)=>({user_id:String(i).padStart(4,'0'),coins:99,comments:10}))};
  }
  throw Error('ineligible users must not query events');
 }};
 assert.deepEqual(await readRankMetrics(pool,'',{pause:async()=>{},onProgress:u=>updates.push(u)}),[]);
 assert.deepEqual(pages,['','0499']);assert.equal(updates.at(-1).scanned,500);
});

test('timeout splits IDs and time ranges, sums both halves without overlap',async()=>{
 const windows=[], progress=[];
 const pool={async query(sql,args){
  if(sql.includes('listener_stream_stats')) return {rows:['a','b'].map(user_id=>({user_id,coins:100,comments:10}))};
  if(sql.includes('FROM live_events')) {
   assert.match(sql,/event_at >= \$3 AND event_at < \$4/);
   if(args[0].length>1 || args[3]-args[2]>45*86400000) throw Object.assign(Error('timeout'),{code:'57014'});
   windows.push([args[0][0],+args[2],+args[3]]);
   return {rows:[{user_id:args[0][0],recent_comments:'5',recent_coins:'50',recent_likes:'7'}]};
  }
  if(sql.includes('viewer_visits')) return {rows:args[0].map(user_id=>({user_id,recent_visits:2}))};
  return {rows:args[0].map(user_id=>({user_id,search_text:user_id}))};
 }};
 const rows=await readRankMetrics(pool,'host',{pause:async()=>{},onProgress:u=>progress.push(u)});
 assert.equal(rows.length,2);assert.equal(rows[0].recent_comments,10);assert.equal(rows[0].recent_likes,14);
 assert.equal(windows[0][2],windows[1][1]);assert.equal(windows[2][2],windows[3][1]);
 assert.equal(progress.at(-1).processed,2);
});

test('candidate timeouts reduce page size; failed queries expose a stage, not a partial result',async()=>{
 const sizes=[];
 const pool={async query(sql,args){sizes.push(args[2]);throw Object.assign(Error('private query'),{code:'57014'});}};
 await assert.rejects(readRankMetrics(pool,'',{pause:async()=>{}}),e=>e.rankStage==='candidates');
 assert.deepEqual(sizes,[500,250,125,62,31,15,10]);
});
