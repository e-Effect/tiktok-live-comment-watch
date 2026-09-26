import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore} from '../lib/event-store.js';

test('welcome filter applies before pagination for both normal and visits sort',async()=>{
 for(const sort of ['last_seen','visits']) for(const welcome of ['yes','no']) {
  const store=new EventStore();store.ready=true;
  store.pool={query:async(sql)=>{
   assert.ok(sql.includes(`l.welcome_notice = ${welcome==='yes'?'TRUE':'FALSE'}`));
   return {rows:[]};
  }};
  assert.deepEqual(await store.listeners({sort,welcome}),{items:[],total:0});
 }
});
test('rank sort filters welcome flags before pagination, independently of attention',async()=>{
 const store=new EventStore();store.ready=true;
 store.listenerContributionRankings=async()=>({lifetimeOrder:['a','b'],recentOrder:['a','b'],byUserId:new Map(),generatedAt:1});
 store.welcomeListenerIds=async()=>['a'];
 store.attentionListenerIds=async()=>['b'];
 store.listenerRowsByIds=async ids=>{store.selected=ids;return [];};
 assert.equal((await store.listenerContributionPage({welcome:'yes'})).total,1);assert.deepEqual(store.selected,['a']);
 assert.equal((await store.listenerContributionPage({welcome:'no'})).total,1);assert.deepEqual(store.selected,['b']);
 assert.equal((await store.listenerContributionPage({welcome:'yes',attention:'yes'})).total,0);
 assert.equal((await store.listenerContributionPage({welcome:'all'})).total,2);
});
