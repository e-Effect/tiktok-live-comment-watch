import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore} from '../lib/event-store.js';
test('message and manual eligibility persist independently of super fan flag',async()=>{
 const store=new EventStore();store.ready=true;
 store.pool={query:async(sql,args)=>{
  assert.match(sql,/stamp_message_enabled = COALESCE\(\$11/);
  assert.equal(args[1],null);assert.equal(args[10],true);assert.equal(args[11],'こんにちは');
  return {rows:[{user_id:'12345',stamp_message_enabled:true,stamp_message:'こんにちは'}]};
 }};
 const item=await store.updateListener('12345',{stampMessageEnabled:true,stampMessage:' こんにちは '});
 assert.equal(item.stampMessageEnabled,true);assert.equal(item.stampMessage,'こんにちは');
});
test('eligible config batches and caches queries; uses actual host and Japan dates',async()=>{
 const store=new EventStore();store.ready=true;let calls=0;
 store.pool={query:async sql=>{calls++;
  if(sql.includes('FROM listeners')){assert.match(sql,/is_super_fan = TRUE OR stamp_message_enabled = TRUE/);return {rows:[{userId:'1',message:''}]};}
  assert.match(sql,/mentalist_k/);assert.match(sql,/Asia\/Tokyo/);assert.match(sql,/connected_at IS NOT NULL/);
  return {rows:[{day:'2026-09-29'}]};
 }};
 const first=await store.stampMessageConfig();assert.deepEqual(first.broadcastDays,['2026-09-29']);
 await store.stampMessageConfig();assert.equal(calls,2);
});
