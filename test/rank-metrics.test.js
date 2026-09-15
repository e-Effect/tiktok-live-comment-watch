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
      if(sql.includes('listener_stream_stats')) return {rows:Array.from({length:21},(_,i)=>({user_id:String(i+1)}))};
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
  const result=await readRankMetrics(pool,'host');
  assert.deepEqual(batches.map(b=>b.length),[10,10,1]);
  assert.equal(result.length,20);assert.equal(result[0].recent_visits,2);
  for(const w of windows){assert.deepEqual(w,windows[0]);assert.equal(w[1]-w[0],90*86400000);}
});
