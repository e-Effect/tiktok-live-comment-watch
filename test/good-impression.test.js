import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore} from '../lib/event-store.js';
test('good impression independently saves true and false and preserves other flags',async()=>{
  const store=new EventStore();store.ready=true;
  for(const value of [true,false]) {
    store.pool={async query(sql,args){
      assert.match(sql,/good_impression = COALESCE\(\$8::boolean, good_impression\)/);
      assert.deepEqual(args,['user',null,null,null,null,null,null,value]);
      return {rows:[{user_id:'user',good_impression:value,is_super_fan:true,needs_attention:true}]};
    }};
    const result=await store.updateListener('user',{goodImpression:value});
    assert.equal(result.goodImpression,value);assert.equal(result.isSuperFan,true);assert.equal(result.needsAttention,true);
  }
});
test('nonboolean values do not silently change good impression',async()=>{
  const store=new EventStore();store.ready=true;
  store.pool={async query(sql,args){assert.equal(args[7],null);return {rows:[{user_id:'user',good_impression:true}]};}};
  assert.equal((await store.updateListener('user',{goodImpression:'false'})).goodImpression,true);
});
