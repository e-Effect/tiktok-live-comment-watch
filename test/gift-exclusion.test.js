import test from 'node:test';
import assert from 'node:assert/strict';
import { createGiftExclusionAlert } from '../lib/gift-exclusion.js';
import { EventStore } from '../lib/event-store.js';

test('only excluded listener sending Daisuki triggers alert, no other gift lookup', async () => {
  let lookups = 0;
  const lookup = async id => { lookups++; return id === '123'; };
  const gift = { id:'event-1', userId:'123', nickname:'テスト', giftId:'14007', giftName:'だいすき', source:'live' };
  for (const other of [{giftId:'7934'}, {source:'initial'}, {userId:''}]) {
    assert.equal(await createGiftExclusionAlert({...gift,...other}, lookup), null);
  }
  assert.equal(lookups, 0);
  assert.equal(await createGiftExclusionAlert({...gift,userId:'456'},lookup),null);
  const alert = await createGiftExclusionAlert(gift,lookup);
  assert.equal(alert.text,'パフォーマンス対象外です。');
  assert.equal(alert.nickname,'テスト');
  assert.equal(alert.type,'gift_excluded_alert');
  assert.equal((await createGiftExclusionAlert(gift,lookup)).id,alert.id);
});

test('gift exclusion persists independently; omitted fields stay unchanged',async()=>{
  const store=new EventStore(); store.ready=true;
  for(const value of [true,false]) {
    store.pool={query:async(sql,args)=>{
      assert.match(sql,/gift_excluded = COALESCE\(\$9::boolean, gift_excluded\)/);
      assert.deepEqual(args,['123',null,null,null,null,null,null,null,value]);
      return {rows:[{user_id:'123',gift_excluded:value}]};
    }};
    assert.equal((await store.updateListener('123',{giftExcluded:value})).giftExcluded,value);
  }
});
