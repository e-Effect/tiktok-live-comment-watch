import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore} from '../lib/event-store.js';
import {rankingStatusText} from '../public/ranking-status.js';

test('refresh uses isolated pool and publishes only after successful save',async()=>{
 const store=new EventStore();store.ready=true;
 const old={generatedAt:1,byUserId:new Map()};store.contributionRankCache.set('*',old);
 let save, saving;
 const savingStarted=new Promise(resolve=>saving=resolve);
 store.pool={query(){throw Error('must not use live pool');}};
 store.rankPool={async query(sql){
  if(sql.includes('listener_stream_stats')) return {rows:[]};
  saving();await new Promise(resolve=>save=resolve);return {rows:[]};
 }};
 const run=store.refreshListenerContributionRankings('');
 await savingStarted;
 assert.equal(store.contributionRankCache.get('*'),old);
 assert.equal((await store.listenerRankingStatus()).state,'running');
 await assert.rejects(store.refreshListenerContributionRankings('other'),/Another/);
 save();await run;
 const status=await store.listenerRankingStatus();
 assert.equal(status.state,'succeeded');assert.ok(status.generatedAt>1);
});

test('failed refresh preserves saved rank and normal reads do not silently retry',async()=>{
 const store=new EventStore();store.ready=true;
 const old={generatedAt:1,byUserId:new Map()};store.contributionRankCache.set('*',old);
 let calls=0;
 store.rankPool={async query(){calls++;throw Object.assign(Error('private database text'),{code:'XX000'});}};
 await assert.rejects(store.refreshListenerContributionRankings(''));
 assert.equal(store.contributionRankCache.get('*'),old);
 const status=await store.listenerRankingStatus();
 assert.equal(status.state,'failed');assert.equal(status.stage,'candidates');assert.equal(status.errorCode,'XX000');
 assert.ok(!JSON.stringify(status).includes('private'));
 assert.equal(await store.listenerContributionRankings(),old);assert.equal(calls,1);
 assert.match(rankingStatusText(status),/再計算に失敗/);
 assert.match(rankingStatusText(status),/前回の結果は保持/);
});

test('status labels never describe running or failed jobs as completed',()=>{
 assert.match(rankingStatusText({state:'running',stage:'events',processed:10,total:20,generatedAt:1}),/10\/20人/);
 assert.match(rankingStatusText({state:'running',generatedAt:1}),/更新前/);
 assert.match(rankingStatusText({state:'failed',errorCode:'57014'}),/処理時間の上限/);
 assert.match(rankingStatusText({state:'succeeded',generatedAt:1}),/再計算完了/);
});
