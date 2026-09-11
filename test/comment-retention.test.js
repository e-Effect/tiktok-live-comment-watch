import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../lib/event-store.js';

test('comment retention seeds existing heavy users and prunes only bodies in bounded batches', async () => {
  const store = new EventStore(); store.ready = true;
  const calls = [];
  store.pool = { query: async (sql,args) => {
    assert.match(sql,/SUM\(comment_count\)/); assert.deepEqual(args,[1500]);
    return {rows:[{user_id:'a'},{user_id:'b'},{user_id:'c'}]};
  }};
  store.writePool = {query:async(sql,args)=> { calls.push({sql,args}); return {rowCount:args[0]==='a'?250:1}; }};
  await store.maintainCommentRetention();
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0].args,['a',1500,250]);
  assert.match(calls[0].sql,/event_type = 'comment' AND NOT comment_body_pruned/);
  assert.match(calls[0].sql,/ORDER BY event_at DESC, event_key DESC/);
  assert.match(calls[0].sql,/comment_text = '', payload = '\{\}'::jsonb/);
  assert.doesNotMatch(calls[0].sql,/DELETE|INTERVAL|SET.*event_at|SET.*user_id/);
  assert.deepEqual([...store.commentRetentionQueue],['c','a']);
  assert.equal(store.commentRetention.prunedBodies,251);
});

test('failed pruning leaves user queued and does not mark database unavailable',async()=>{
  const store=new EventStore();store.ready=true;store.commentRetentionSeedAt=Date.now();
  store.commentRetentionQueue.add('a');
  store.pool={query:async()=>{throw new Error('timeout')}};
  await store.maintainCommentRetention();
  assert.equal(store.ready,true);assert.ok(store.commentRetentionQueue.has('a'));
  assert.equal(store.commentRetention.prunedBodies,0);
  assert.match(store.commentRetention.lastError,/timeout/);
});

test('readable comment history excludes pruned bodies but does not apply time expiration',async()=>{
  const store=new EventStore();store.ready=true;
  store.pool={query:async(sql,args)=>{
    assert.match(sql,/AND NOT comment_body_pruned/);assert.doesNotMatch(sql,/INTERVAL/);
    assert.deepEqual(args,['a','',1,0]);return {rows:[{fullCount:1500,text:'kept'}]};
  }};
  assert.equal((await store.listenerHistory('a',{limit:1})).total,1500);
});
