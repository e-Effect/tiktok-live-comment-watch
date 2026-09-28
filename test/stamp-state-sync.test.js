import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore} from '../lib/event-store.js';

test('superfan revision refresh is read-only and preserves stamps', async () => {
  const store = new EventStore();
  store.ready = true;
  const state = {users:[{id:'card',stamps:[{id:'existing'}]}]};
  let updates = 0;
  store.superFanRevision = async () => 'new';
  store.enrichStampState = async (value, options) => { assert.equal(options.readOnly,true); return {state:value}; };
  store.pool = {query:async (sql,args) => {
    if (sql.includes('UPDATE shared_app_states')) {
      updates++;
      assert.match(sql, /WHERE state_key = \$1/);
      assert.equal(args[0], 'stamp-card');
      assert.deepEqual(JSON.parse(args[1]), state);
      assert.equal(args[2], 'new');
      return {rows:[]};
    }
    return {rows:[{state,revision:5,sourceRevision:4,superFanRevision:'old'}]};
  }};
  const result = await store.sharedStampState();
  assert.equal(updates, 0);
  assert.deepEqual(result.state, state);
  assert.equal(result.revision, 5);
  assert.equal(result.superFanRevision, 'new');
});

const card = (id, stamps = []) => ({id, tiktokUserId:id.repeat(6), name:'user', createdAt:1700000000000, stamps});
function importFixture() {
  const store = new EventStore();
  const writes = [];
  store.pool = {query:async (sql,args) => {
    if (/^\s*(INSERT|UPDATE)/.test(sql)) { writes.push({sql, data:JSON.parse(args[0])}); return {rows:[],rowCount:1}; }
    return {rows:['123','456'].map(id=>({userId:id.repeat(6),isSuperFan:true}))};
  }};
  return {store,writes};
}
test('unchanged snapshot does not write listener or stamp rows', async () => {
  const {store,writes}=importFixture();
  const state={users:[card('123',[{id:'old'}])]};
  const result=await store.enrichStampState(state,{previousState:state});
  assert.equal(writes.length,0);
  assert.equal(result.state.users[0].isSuperFan,true);
  assert.deepEqual(result.state.users[0].stamps,state.users[0].stamps);
});
test('only changed profile and new stamps are imported, full snapshot is retained',async()=>{
  const {store,writes}=importFixture();
  const previousState={users:[card('123',[{id:'old'}]),card('456')]};
  const state=structuredClone(previousState);
  state.users[0].name='changed'; state.users[0].stamps.push({id:'new'});
  const result=await store.enrichStampState(state,{previousState});
  assert.deepEqual(writes.find(w=>w.sql.includes('INSERT INTO listeners')).data.map(u=>u.user_id),['123'.repeat(6)]);
  const stamps=writes.find(w=>w.sql.includes('INSERT INTO listener_stamps')).data;
  assert.equal(stamps.length,1);
  assert.equal(result.state.users.length,2);
  assert.equal(result.state.users[0].stamps.length,2);
});
test('read-only enrichment never writes, including a new card',async()=>{
  const {store,writes}=importFixture();
  await store.enrichStampState({users:[card('123',[{id:'new'}])]},{readOnly:true});
  assert.equal(writes.length,0);
});
test('manual removal stays removed in snapshot without deleting ledger history',async()=>{
  const {store,writes}=importFixture();
  const result=await store.enrichStampState({users:[card('123')]},{previousState:{users:[card('123',[{id:'old'}])]}});
  assert.equal(result.state.users[0].stamps.length,0);
  assert.equal(writes.length,0);
});
test('imports serialize and recover after failure',async()=>{
  const store=new EventStore(); let active=0,max=0;
  store.importSharedStampState=async(value)=>{
    active++;max=Math.max(active,max);
    await new Promise(resolve=>setTimeout(resolve,5));active--;
    if(value===1)throw new Error('temporary');return value;
  };
  const results=await Promise.allSettled([1,2,3].map(v=>store.updateSharedStampState(v)));
  assert.equal(max,1);assert.equal(results[0].status,'rejected');assert.equal(results[2].value,3);
});
test('same revision retry is acknowledged without reimport, older one rejected',async()=>{
  const store=new EventStore();store.ready=true;
  store.pool={query:async()=>({rows:[{revision:8,sourceRevision:7}]})};
  store.enrichStampState=()=>{throw new Error('must not import');};
  assert.equal((await store.updateSharedStampState({},{sourceRevision:7})).unchanged,true);
  assert.equal((await store.updateSharedStampState({},{sourceRevision:6})).stale,true);
});
