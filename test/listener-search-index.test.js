import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore} from '../lib/event-store.js';

const indexName = 'listeners_search_nfkc_trgm_idx';
const coverName = 'listener_stats_scope_coins_cover_idx';

function fixture({valid, coverValid, busy = false, failCreate, failCoverCreate, beforeCreate, beforeCoverCreate, onQuery} = {}) {
  const state = {valid, coverValid, busy, failCreate, failCoverCreate, owner:null, calls:[], clients:[]};
  const pool = {
    query() {assert.fail('index maintenance must use its checked-out client');},
    async connect() {
      const client = {
        released:false,
        async query(config) {
          assert.equal(typeof config,'object','maintenance must override the pool driver timeout per query');
          const {text:sql,values:args,query_timeout}=config;
          assert.ok(query_timeout>1000 && query_timeout<=601000);
          state.calls.push({sql,args,client,query_timeout});
          onQuery?.(sql,args,config);
          if (/^SET |^SELECT set_config/.test(sql)) return {rows:[]};
          if (sql === 'SELECT pg_backend_pid() AS pid') return {rows:[{pid:7000+state.clients.length}]};
          if (sql.includes('SELECT indisvalid')) {
            const cover=args[0]===coverName;
            assert.deepEqual(args,[cover?coverName:indexName]);
            assert.ok(sql.includes(`indrelid = '${cover?'listener_stream_stats':'listeners'}'::regclass`));
            const valid=cover?state.coverValid:state.valid;
            return {rows:valid === undefined ? [] : [{indisvalid:valid}]};
          }
          if (sql.includes('pg_try_advisory_lock')) {
            assert.deepEqual(args,[indexName]);
            if (state.busy || state.owner) return {rows:[{acquired:false}]};
            state.owner = client;
            return {rows:[{acquired:true}]};
          }
          if (sql.startsWith('DROP INDEX')) {
            const cover=sql.includes(coverName), key=cover?'coverValid':'valid';
            assert.equal(state.owner,client);
            assert.equal(sql,`DROP INDEX CONCURRENTLY IF EXISTS ${cover?coverName:indexName}`);
            assert.equal(state[key],false,'only an existing invalid new index can be dropped');
            state[key] = undefined;
            return {rows:[]};
          }
          if (sql.startsWith('CREATE INDEX')) {
            const cover=sql.includes(coverName), key=cover?'coverValid':'valid';
            assert.equal(state.owner,client);
            assert.match(sql,new RegExp(`^CREATE INDEX CONCURRENTLY IF NOT EXISTS ${cover?coverName:indexName}`));
            state[key] = false;
            await (cover?beforeCoverCreate:beforeCreate)?.();
            const error=cover?state.failCoverCreate:state.failCreate;
            if (error) throw Object.assign(new Error('synthetic failure'),{code:error});
            state[key] = true;
            return {rows:[]};
          }
          assert.fail(`unexpected SQL: ${sql}`);
        },
        release(destroy) {
          assert.equal(destroy,true,'discard maintenance session settings and advisory locks');
          assert.equal(client.released,false);
          client.released = true;
          if (state.owner === client) state.owner = null;
        }
      };
      state.clients.push(client);
      return client;
    }
  };
  const store = new EventStore(); store.pool = pool; store.ready = true;
  return {store,state,pool};
}

function assertReleased(state) {
  assert.ok(state.clients.every(client=>client.released));
  assert.equal(state.owner,null);
  assert.ok(!state.calls.some(({sql})=>/BEGIN|UPDATE |INSERT |DELETE |ALTER TABLE|listeners_search_trgm_idx/.test(sql)));
}

test('valid normalized index is metadata-only and health never polls the database', async () => {
  const {store,state}=fixture({valid:true});
  assert.equal(await store.initializeListenerSearchIndex(),true);
  const before=state.calls.length;
  const status=store.status();
  assert.equal(status.listenerSearchIndexReady,true);
  assert.equal(status.listenerSearchIndexError,'');
  assert.equal(status.listenerSearchIndexPending,false);
  assert.equal(status.listenerSearchIndexBudgetMs,600000);
  assert.equal(state.calls.length,before);
  assert.ok(!state.calls.some(({sql})=>/CREATE|DROP|pg_try_advisory_lock/.test(sql)));
  assertReleased(state);
});

test('missing normalized index builds concurrently with bounded session timeouts and an identical search expression', async () => {
  const {store,state,pool}=fixture();
  assert.equal(await store.initializeListenerSearchIndex(),true);
  assert.ok(state.calls.some(({sql})=>sql === "SET lock_timeout = '30s'"));
  assert.ok(state.calls.some(({sql})=>sql === "SET statement_timeout = '600s'"));
  for (const {args} of state.calls.filter(({sql})=>sql.startsWith('SELECT set_config'))) {
    assert.match(args[0],/^\d+ms$/);
    assert.ok(parseInt(args[0])>0 && parseInt(args[0])<=600000);
  }
  const ddl=state.calls.find(({sql})=>sql.startsWith('CREATE INDEX')).sql;
  const expression="LOWER(normalize(user_id || ' ' || latest_unique_id || ' ' || latest_nickname || ' ' || notes, NFKC))";
  assert.ok(ddl.includes(`((${expression}) gin_trgm_ops)`));
  let page;
  pool.query=async sql=>{page=sql;return {rows:[]};};
  await store.listeners({search:'abc'});
  assert.ok(page.includes(expression.replace(/\b(user_id|latest_unique_id|latest_nickname|notes)\b/g,'l.$1')));
  assertReleased(state);
});

test('invalid new index is removed concurrently and rebuilt without touching the old index', async () => {
  const {store,state}=fixture({valid:false});
  assert.equal(await store.initializeListenerSearchIndex(),true);
  const statements=state.calls.map(call=>call.sql);
  assert.equal(statements.filter(sql=>sql.startsWith('DROP INDEX')).length,1);
  assert.ok(statements.findIndex(sql=>sql.startsWith('DROP INDEX'))<statements.findIndex(sql=>sql.startsWith('CREATE INDEX')));
  assertReleased(state);
});

test('failed build stays nonfatal, leaves invalid cleanup for the next explicit attempt, and exposes only an error code', async () => {
  const {store,state}=fixture({failCreate:'57014'});
  assert.equal(await store.initializeListenerSearchIndex(),false);
  assert.equal(store.ready,true);
  assert.equal(store.lastError,'');
  assert.equal(store.status().listenerSearchIndexReady,false);
  assert.equal(store.status().listenerSearchIndexError,'57014');
  assert.equal(store.status().listenerSearchIndexPending,false);
  assert.ok(!state.calls.some(({sql})=>sql.startsWith('DROP INDEX')));
  assertReleased(state);
  state.failCreate = null;
  assert.equal(await store.initializeListenerSearchIndex(),true);
  assert.equal(store.status().listenerSearchIndexError,'');
  assert.equal(state.clients.length,2);
  assert.equal(state.calls.filter(({sql})=>sql.startsWith('DROP INDEX')).length,1);
  assertReleased(state);
});

test('busy advisory lock never waits, drops or builds and can retry explicitly', async () => {
  const {store,state}=fixture({valid:false,busy:true});
  assert.equal(await store.initializeListenerSearchIndex(),false);
  assert.equal(store.status().listenerSearchIndexError,'BUILD_BUSY');
  assert.ok(!state.calls.some(({sql})=>/^(CREATE|DROP)/.test(sql)));
  assertReleased(state);
  state.busy=false;
  assert.equal(await store.initializeListenerSearchIndex(),true);
  assertReleased(state);
});

test('same-store attempts deduplicate and a second store cannot build concurrently', async () => {
  let unblock,started;
  const building=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{unblock=resolve;});
  const {store,state,pool}=fixture({beforeCreate:async()=>{started();await gate;}});
  const first=store.initializeListenerSearchIndex();
  assert.equal(store.initializeListenerSearchIndex(),first);
  await building;
  assert.equal(store.status().listenerSearchIndexPending,true);
  assert.equal(await store.ensureReady(),true,'pending maintenance must not block application readiness');
  const other=new EventStore();other.pool=pool;other.ready=true;
  assert.equal(await other.initializeListenerSearchIndex(),false);
  assert.equal(other.status().listenerSearchIndexError,'BUILD_BUSY');
  unblock();
  assert.equal(await first,true);
  assert.equal(state.calls.filter(({sql})=>sql.startsWith('CREATE INDEX')).length,1);
  assert.equal(state.clients.length,2);
  assertReleased(state);
  assert.equal(await other.initializeListenerSearchIndex(),true);
  assert.equal(state.calls.filter(({sql})=>sql.startsWith('CREATE INDEX')).length,1);
  assertReleased(state);
});

test('total maintenance budget expires before another DDL attempt', async t => {
  let now=1000;
  t.mock.method(Date,'now',()=>now);
  const {store,state}=fixture({onQuery(sql){if (sql.includes('SELECT indisvalid')) now=601001;}});
  assert.equal(await store.initializeListenerSearchIndex(),false);
  assert.equal(store.status().listenerSearchIndexError,'57014');
  assert.ok(!state.calls.some(({sql})=>/pg_try_advisory_lock|CREATE|DROP/.test(sql)));
  assertReleased(state);
});

test('maintenance exceeding the general 35s timeout retains a bounded per-query override', async t => {
  let now=1000;
  t.mock.method(Date,'now',()=>now);
  const {store,state}=fixture({onQuery(sql,args,config){
    if (sql.startsWith('CREATE INDEX')) {
      assert.equal(config.query_timeout,601000);
      now+=40000;
    }
  }});
  assert.equal(await store.initializeListenerSearchIndex(),true);
  const last=state.calls.at(-1);
  assert.ok(last.sql.includes('SELECT indisvalid'));
  assert.equal(last.query_timeout,561000,'driver timeout tracks remaining budget, not the general pool 35s');
  assert.ok(state.calls.some(({args,sql})=>sql.startsWith('SELECT set_config') && args[0]==='560000ms'));
  assertReleased(state);
});

test('startup schedules optional index maintenance only after readiness without awaiting it', () => {
  const initialize=EventStore.prototype.initialize.toString();
  assert.match(initialize,/this\.schemaReady = true;\s*this\.ready = true;\s*this\.lastError = "";[\s\S]*?void this\.startListenerSearchIndexMaintenance\(pool\)\.catch\(\(\) => \{\}\);\s*return true;/);
  assert.doesNotMatch(initialize,/await this\.(?:initializeListenerSearchIndex|startListenerSearchIndexMaintenance)/);
});

test('connection and unsupported-index failures do not make the application unavailable', async () => {
  const {store,state,pool}=fixture({failCreate:'42704'});
  assert.equal(await store.initializeListenerSearchIndex(),false);
  assert.equal(store.status().listenerSearchIndexError,'42704');
  assert.equal(store.ready,true);
  assertReleased(state);
  pool.connect=async()=>{throw Object.assign(new Error('private connection details'),{code:'ECONNREFUSED'});};
  assert.equal(await store.initializeListenerSearchIndex(),false);
  assert.equal(store.status().listenerSearchIndexError,'ECONNREFUSED');
  assert.equal(store.status().listenerSearchIndexPending,false);
  assert.equal(store.ready,true);
  assert.equal(store.lastError,'');
});

function retryClock(t) {
  const timers=[];
  t.mock.method(globalThis,'setTimeout',(callback,ms)=>{
    const timer={callback,ms,unrefCalled:false,cancelled:false,unref(){this.unrefCalled=true;}};
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis,'clearTimeout',timer=>{if(timer) timer.cancelled=true;});
  return timers;
}

test('index stages identify checking, invalid cleanup, build, verification and readiness', async () => {
  const stages=[];
  const {store,state}=fixture({valid:false,onQuery(sql){
    if (/SELECT indisvalid|^DROP INDEX|^CREATE INDEX/.test(sql)) stages.push(store.status().listenerSearchIndexStage);
  }});
  assert.equal(await store.initializeListenerSearchIndex(),true);
  assert.deepEqual(stages,['checking','checking','dropping-invalid','building','verifying']);
  assert.equal(store.status().listenerSearchIndexStage,'ready');
  assert.equal(store.status().listenerSearchIndexFailedStage,'');
  assertReleased(state);
});

test('lock timeout reports dropping-invalid as the failed stage without building', async () => {
  const {store,state}=fixture({valid:false,onQuery(sql){
    if (sql.startsWith('DROP INDEX')) throw Object.assign(new Error('lock timeout'),{code:'55P03'});
  }});
  assert.equal(await store.initializeListenerSearchIndex(),false);
  assert.equal(store.status().listenerSearchIndexStage,'failed');
  assert.equal(store.status().listenerSearchIndexFailedStage,'dropping-invalid');
  assert.equal(store.status().listenerSearchIndexError,'55P03');
  assert.ok(!state.calls.some(({sql})=>sql.startsWith('CREATE INDEX')));
  assertReleased(state);
});

for (const reason of ['55P03','BUILD_BUSY']) test(`startup retries ${reason} once after an unref'd 15s delay`, async t => {
  const timers=retryClock(t);
  const {store,state}=fixture({failCreate:reason==='55P03'?'55P03':undefined,busy:reason==='BUILD_BUSY'});
  assert.equal(await store.startListenerSearchIndexMaintenance(),false);
  assert.equal(store.status().listenerSearchIndexFailedStage,reason==='55P03'?'building':'checking');
  assert.equal(store.status().listenerSearchIndexRetryPending,true);
  assert.equal(timers.length,1);
  assert.equal(timers[0].ms,15000);
  assert.equal(timers[0].unrefCalled,true);
  state.busy=false;state.failCreate=null;
  timers[0].callback();
  assert.equal(await store.listenerSearchIndexPromise,true);
  await store.scopedCoinsIndexPromise;
  assert.equal(store.status().listenerSearchIndexStage,'ready');
  assert.equal(store.status().listenerSearchIndexFailedStage,'');
  assert.equal(store.status().listenerSearchIndexRetryPending,false);
  assert.equal(timers.length,1);
  assert.equal(state.clients.length,3);
  assertReleased(state);
});

test('a failed startup retry cannot schedule another retry or restart the startup job', async t => {
  const timers=retryClock(t);
  const {store,state}=fixture({failCreate:'55P03'});
  assert.equal(await store.startListenerSearchIndexMaintenance(),false);
  timers[0].callback();
  assert.equal(await store.listenerSearchIndexPromise,false);
  assert.equal(await store.startListenerSearchIndexMaintenance(),false);
  assert.equal(timers.length,1);
  assert.equal(state.clients.length,2);
  assert.equal(store.status().listenerSearchIndexRetryPending,false);
  assert.equal(store.status().listenerSearchIndexError,'55P03');
  assertReleased(state);
});

test('startup does not retry timeouts or unsupported-index errors', async t => {
  const timers=retryClock(t);
  for (const code of ['57014','42704']) {
    const {store,state}=fixture({failCreate:code});
    assert.equal(await store.startListenerSearchIndexMaintenance(),false);
    assert.equal(store.status().listenerSearchIndexFailedStage,'building');
    assert.equal(store.status().listenerSearchIndexRetryPending,false);
    assertReleased(state);
  }
  assert.equal(timers.length,0);
});

test('startup retry skips a replaced pool, unavailable app or already-ready index', async t => {
  const timers=retryClock(t);
  for (const condition of ['pool','unavailable','index']) {
    const {store,state}=fixture({busy:true});
    assert.equal(await store.startListenerSearchIndexMaintenance(),false);
    if(condition==='pool') store.pool={};
    if(condition==='unavailable') store.ready=false;
    if(condition==='index') store.listenerSearchIndexReady=true;
    timers.at(-1).callback();
    assert.equal(state.clients.length,1);
    assert.equal(store.status().listenerSearchIndexRetryPending,false);
    assertReleased(state);
  }
});

test('close cancels the unref startup retry before closing its pool', async t => {
  const timers=retryClock(t);
  const {store,state,pool}=fixture({busy:true});
  pool.end=async()=>{};
  assert.equal(await store.startListenerSearchIndexMaintenance(),false);
  await store.close();
  assert.equal(timers[0].cancelled,true);
  assert.equal(store.status().listenerSearchIndexRetryPending,false);
  timers[0].callback();
  assert.equal(state.clients.length,1);
  assertReleased(state);
});

test('explicit progress reads only the captured maintenance backend and exposes sanitized counters/waits', async () => {
  let unblock,started;
  const building=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{unblock=resolve;});
  const {store,state,pool}=fixture({beforeCreate:async()=>{started();await gate;}});
  const attempt=store.initializeListenerSearchIndex();
  await building;
  assert.equal(store.listenerSearchIndexBackendPid,7001);
  let reads=0;
  pool.query=async config=>{
    reads++;
    assert.equal(config.query_timeout,5000);
    assert.deepEqual(config.values,[7001]);
    assert.match(config.text,/WHERE a\.pid = \$1/);
    assert.doesNotMatch(config.text,/a\.query\b|SELECT \*|INSERT|UPDATE|DELETE|set_config/i);
    return {rows:[{phase:'waiting for old snapshots',blocks_done:'12',blocks_total:'40',tuples_done:'3',tuples_total:'9',
      wait_event_type:'Lock',wait_event:'virtualxid',pid:7001,query:'PRIVATE SQL',args:['SECRET'],client_addr:'PRIVATE'}]};
  };
  store.status();store.status();
  assert.equal(reads,0,'health must never poll progress');
  assert.deepEqual(await store.listenerSearchIndexProgress('ignored arbitrary argument'),{
    phase:'waiting for old snapshots',blocksDoneTotal:{done:12,total:40},tuplesDoneTotal:{done:3,total:9},
    waitEventType:'Lock',waitEvent:'virtualxid',indexStage:'building',indexTarget:'search'
  });
  pool.query=async()=>({rows:[{phase:{secret:true},blocks_done:-1,blocks_total:Infinity,tuples_done:'NaN',tuples_total:'4',wait_event:123}]});
  assert.deepEqual(await store.listenerSearchIndexProgress(),{
    phase:'',blocksDoneTotal:{done:0,total:0},tuplesDoneTotal:{done:0,total:4},waitEventType:'',waitEvent:'',indexStage:'building',indexTarget:'search'
  });
  pool.query=async()=>{throw new Error('PRIVATE SQL and connection details');};
  const failed=await store.listenerSearchIndexProgress();
  assert.equal(JSON.stringify(failed).includes('PRIVATE'),false);
  unblock();assert.equal(await attempt,true);
  assert.equal(store.listenerSearchIndexBackendPid,null);
  assert.equal(store.listenerSearchIndexBackendPool,null);
  pool.query=()=>assert.fail('completed maintenance must not query progress');
  assert.equal((await store.listenerSearchIndexProgress()).indexStage,'ready');
  assertReleased(state);
});

test('progress skips unavailable or stale pools and discards a result after the maintenance attempt finishes', async () => {
  const {store,pool}=fixture();
  await store.listenerSearchIndexProgress();
  store.listenerSearchIndexBackendPid=7001;
  store.listenerSearchIndexBackendPool=pool;
  store.listenerSearchIndexPromise=Promise.resolve(false);
  store.ready=false;
  await store.listenerSearchIndexProgress();
  store.ready=true;
  store.listenerSearchIndexBackendPool={};
  await store.listenerSearchIndexProgress();
  store.listenerSearchIndexBackendPool=pool;
  pool.query=async()=>{
    store.listenerSearchIndexBackendPid=null;
    return {rows:[{phase:'stale',wait_event:'PRIVATE'}]};
  };
  const result=await store.listenerSearchIndexProgress();
  assert.equal(result.phase,'');assert.equal(result.waitEvent,'');
});

test('failed maintenance clears its private backend identity', async () => {
  const {store,state}=fixture({failCreate:'57014'});
  assert.equal(await store.initializeListenerSearchIndex(),false);
  assert.equal(store.listenerSearchIndexBackendPid,null);
  assert.equal(store.listenerSearchIndexBackendPool,null);
  assert.ok(!Object.keys(store.status()).some(key=>/pid|backendpool/i.test(key)));
  assertReleased(state);
});

test('startup builds GIN then covering index sequentially and deduplicates queued cover attempts', async () => {
  let unblock,started;
  const gate=new Promise(resolve=>{unblock=resolve;});
  const building=new Promise(resolve=>{started=resolve;});
  const {store,state}=fixture({beforeCreate:async()=>{started();await gate;},beforeCoverCreate:async()=>{
    assert.equal(store.listenerSearchIndexReady,true);
    assert.equal(store.listenerSearchIndexPromise,null);
    assert.equal(state.clients[0].released,true,'GIN client released before cover build');
  }});
  const startup=store.startListenerSearchIndexMaintenance();
  await building;
  const queued=store.initializeScopedCoinsIndex();
  assert.equal(store.scopedCoinsIndexPromise,null);
  assert.equal(state.clients.length,1);
  unblock();
  assert.equal(await startup,true);
  assert.equal(await queued,true);
  await store.scopedCoinsIndexPromise;
  assert.equal(store.status().listenerSearchIndexReady,true);
  assert.equal(store.status().scopedCoinsIndexReady,true);
  assert.equal(store.status().scopedCoinsIndexError,'');
  assert.equal(state.clients.length,2);
  assert.equal(state.calls.filter(({sql})=>sql.startsWith('CREATE INDEX')).length,2);
  const cover=state.calls.find(({sql})=>sql.startsWith('CREATE INDEX') && sql.includes(coverName));
  assert.ok(cover.sql.includes('INCLUDE (stream_username, gift_coins, last_seen_at)'));
  assertReleased(state);
});

test('cover failure and invalid-cover cleanup cannot change valid GIN or application readiness', async () => {
  const {store,state}=fixture({valid:true,coverValid:false,failCoverCreate:'57014'});
  assert.equal(await store.initializeListenerSearchIndex(),true);
  assert.equal(await store.initializeScopedCoinsIndex(),false);
  assert.equal(store.ready,true);
  assert.equal(store.status().listenerSearchIndexReady,true);
  assert.equal(store.status().listenerSearchIndexError,'');
  assert.equal(store.status().listenerSearchIndexStage,'ready');
  assert.equal(store.status().scopedCoinsIndexReady,false);
  assert.equal(store.status().scopedCoinsIndexError,'57014');
  assert.equal(store.status().scopedCoinsIndexPending,false);
  assert.equal(store.status().scopedCoinsIndexFailedStage,'building');
  assert.deepEqual(state.calls.filter(({sql})=>sql.startsWith('DROP INDEX')).map(({sql})=>sql),[
    `DROP INDEX CONCURRENTLY IF EXISTS ${coverName}`
  ]);
  state.failCoverCreate=null;
  assert.equal(await store.initializeScopedCoinsIndex(),true);
  assert.equal(store.status().scopedCoinsIndexError,'');
  assert.equal(store.status().listenerSearchIndexReady,true);
  assertReleased(state);
});

test('a failed GIN build never starts the covering build', async () => {
  const {store,state}=fixture({failCreate:'57014'});
  assert.equal(await store.startListenerSearchIndexMaintenance(),false);
  assert.equal(await store.initializeScopedCoinsIndex(),false);
  assert.equal(state.clients.length,1);
  assert.ok(!state.calls.some(({sql,args})=>sql.includes(coverName)||args?.includes(coverName)));
  assert.equal(store.status().scopedCoinsIndexStage,'idle');
  assertReleased(state);
});

test('cover progress uses its own active promise and PID while GIN readiness remains true', async () => {
  let unblock,started;
  const gate=new Promise(resolve=>{unblock=resolve;});
  const building=new Promise(resolve=>{started=resolve;});
  const {store,state,pool}=fixture({valid:true,beforeCoverCreate:async()=>{started();await gate;}});
  assert.equal(await store.initializeListenerSearchIndex(),true);
  const cover=store.initializeScopedCoinsIndex();
  assert.equal(store.initializeScopedCoinsIndex(),cover);
  await building;
  assert.equal(store.listenerSearchIndexPromise,null);
  assert.equal(store.status().listenerSearchIndexReady,true);
  assert.equal(store.status().scopedCoinsIndexPending,true);
  pool.query=async config=>{
    assert.deepEqual(config.values,[7002]);
    assert.equal(config.query_timeout,5000);
    return {rows:[{phase:'building index',blocks_done:2,blocks_total:8,wait_event_type:'IO',wait_event:'DataFileRead'}]};
  };
  const progress=await store.listenerSearchIndexProgress();
  assert.equal(progress.indexTarget,'scoped-coins');
  assert.equal(progress.indexStage,'building');
  assert.deepEqual(progress.blocksDoneTotal,{done:2,total:8});
  const gin=store.initializeListenerSearchIndex();
  assert.equal(state.clients.length,2,'GIN recheck cannot overlap active cover maintenance');
  unblock();assert.equal(await cover,true);assert.equal(await gin,true);
  assert.equal(store.status().scopedCoinsIndexReady,true);
  assert.equal(store.listenerSearchIndexBackendPid,null);
  assertReleased(state);
});

test('valid covering index needs metadata only and never recreates existing indexes', async () => {
  const {store,state}=fixture({valid:true,coverValid:true});
  assert.equal(await store.initializeListenerSearchIndex(),true);
  assert.equal(await store.initializeScopedCoinsIndex(),true);
  assert.ok(!state.calls.some(({sql})=>/^(CREATE|DROP)/.test(sql)));
  assert.equal(store.status().listenerSearchIndexReady,true);
  assert.equal(store.status().scopedCoinsIndexReady,true);
  assertReleased(state);
});
