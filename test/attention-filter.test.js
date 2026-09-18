import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore} from '../lib/event-store.js';
test('attention search filters before aggregation and pagination and combines conditions',async()=>{
 for(const [attention,expected] of [['yes','TRUE'],['no','FALSE']]) {
  const store=new EventStore();store.ready=true;
  store.pool={async query(sql,args){
   assert.ok(sql.indexOf(`l.needs_attention = ${expected}`)<sql.indexOf('), totals AS'));
   assert.match(sql,/l.is_blocked = FALSE/);
   assert.match(sql,/ORDER BY visits DESC/);
   assert.equal(args[1],'abc');assert.equal(args[3],100);
   return {rows:[{user_id:'one',needs_attention:attention==='yes',full_count:101}]};
  }};
  const result=await store.listeners({attention,blocked:'unblocked',sort:'visits',search:'abc',offset:100});
  assert.equal(result.total,101);assert.equal(result.items[0].needsAttention,attention==='yes');
 }
});
test('attention filter applies to rank order before total and pagination without reranking',async()=>{
 const store=new EventStore();store.ready=true;
 store.listenerContributionRankings=async()=>({byUserId:new Map([['a',{contributionRank:'S'}],['b',{contributionRank:'A'}],['c',{contributionRank:'D'}]]),lifetimeOrder:['a','b','c'],generatedAt:1});
 store.attentionListenerIds=async()=>['a','c'];
 store.listenerRowsByIds=async ids=>ids.map(userId=>({userId}));
 const checked=await store.listenerContributionPage({attention:'yes',limit:1,offset:1});
 assert.equal(checked.total,2);assert.equal(checked.items[0].userId,'c');assert.equal(checked.items[0].contributionRank,'D');
 const unchecked=await store.listenerContributionPage({attention:'no'});
 assert.equal(unchecked.total,1);assert.equal(unchecked.items[0].userId,'b');
});
