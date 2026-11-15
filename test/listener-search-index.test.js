import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore} from '../lib/event-store.js';

const indexName = 'listeners_search_nfkc_trgm_idx';

function fixture({valid, busy = false, failCreate, beforeCreate, onQuery} = {}) {
  const state = {valid, busy, failCreate, owner:null, calls:[], clients:[]};
  const pool = {
    query() {assert.fail('index maintenance must use its checked-out client');},
    async connect() {
      const client = {
        released:false,
        async query(sql, args) {
          state.calls.push({sql,args,client});
          onQuery?.(sql,args);
          if (/^SET |^SELECT set_config/.test(sql)) return {rows:[]};
          if (sql.includes('SELECT indisvalid')) {
            assert.deepEqual(args,[indexName]);
            assert.match(sql,/indrelid = 'listeners'::regclass/);
            return {rows:state.valid === undefined ? [] : [{indisvalid:state.valid}]};
          }
          if (sql.includes('pg_try_advisory_lock')) {
            assert.deepEqual(args,[indexName]);
            if (state.busy || state.owner) return {rows:[{acquired:false}]};
            state.owner = client;
            return {rows:[{acquired:true}]};
          }
          if (sql.startsWith('DROP INDEX')) {
            assert.equal(state.owner,client);
            assert.equal(sql,`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`);
            assert.equal(state.valid,false,'only an existing invalid new index can be dropped');
            state.valid = undefined;
            return {rows:[]};
          }
          if (sql.startsWith('CREATE INDEX')) {
            assert.equal(state.owner,client);
            assert.match(sql,new RegExp(`^CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName}`));
            state.valid = false;
            await beforeCreate?.();
            if (state.failCreate) throw Object.assign(new Error('synthetic failure'),{code:state.failCreate});
            state.valid = true;
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
  assert.equal(state.calls.length,before);
  assert.ok(!state.calls.some(({sql})=>/CREATE|DROP|pg_try_advisory_lock/.test(sql)));
  assertReleased(state);
});

test('missing normalized index builds concurrently with bounded session timeouts and an identical search expression', async () => {
  const {store,state,pool}=fixture();
  assert.equal(await store.initializeListenerSearchIndex(),true);
  assert.ok(state.calls.some(({sql})=>sql === "SET lock_timeout = '1s'"));
  assert.ok(state.calls.some(({sql})=>sql === "SET statement_timeout = '20s'"));
  for (const {args} of state.calls.filter(({sql})=>sql.startsWith('SELECT set_config'))) {
    assert.match(args[0],/^\d+ms$/);
    assert.ok(parseInt(args[0])>0 && parseInt(args[0])<=20000);
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
  const {store,state}=fixture({onQuery(sql){if (sql.includes('SELECT indisvalid')) now=21001;}});
  assert.equal(await store.initializeListenerSearchIndex(),false);
  assert.equal(store.status().listenerSearchIndexError,'57014');
  assert.ok(!state.calls.some(({sql})=>/pg_try_advisory_lock|CREATE|DROP/.test(sql)));
  assertReleased(state);
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
