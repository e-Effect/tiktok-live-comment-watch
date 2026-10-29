import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {EventStore} from '../lib/event-store.js';

test('bounded PostgreSQL history probes retain exact visits, interactions, aliases and current-LIVE exclusions',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE listeners(user_id TEXT PRIMARY KEY,latest_unique_id TEXT);
    CREATE TABLE listener_aliases(user_id TEXT,unique_id TEXT);
    CREATE TABLE live_sessions(id TEXT PRIMARY KEY,room_id TEXT);
    CREATE TABLE viewer_visits(session_id TEXT,stream_username TEXT,user_id TEXT,last_seen_at TIMESTAMPTZ);
    CREATE TABLE live_events(session_id TEXT,stream_username TEXT,user_id TEXT,event_at TIMESTAMPTZ,event_type TEXT);
    CREATE INDEX ON live_events(user_id,event_type,event_at DESC);
    INSERT INTO listeners VALUES ('regular','viewer'),('quiet','quiet'),('new','new'),('legacy','other');
    INSERT INTO listener_aliases VALUES ('legacy','old_viewer');
    INSERT INTO live_sessions VALUES ('current','room-now'),('reconnected','room-now'),('old1','room-old'),('old2','room-old'),('older','room-older');
    INSERT INTO viewer_visits VALUES
      ('current','host','regular','2026-10-30'),('old1','host','regular','2026-10-28'),('old2','host','regular','2026-10-29'),
      ('older','host','regular','2026-10-27'),('old1','other-host','new','2026-10-29'),('old1','host','quiet','2026-10-28');
    INSERT INTO live_events VALUES
      ('current','host','new','2026-10-30','comment'),('reconnected','host','new','2026-10-30','gift'),
      ('old1','other-host','new','2026-10-29','comment'),('old1','host','quiet','2026-10-29','follow'),
      ('old1','host','legacy','2026-10-29','like');
    INSERT INTO live_events SELECT 'old1','host','regular',TIMESTAMPTZ '2026-10-28'+g*INTERVAL '1 second','like'
      FROM generate_series(1,20000) g;
    ANALYZE;
  `);
  const store=new EventStore();store.ready=true;
  const queries=[];
  store.pool={query:async(sql,params)=>{queries.push({sql,params});return db.query(sql,params);}};
  const scope={sessionId:'current',roomId:'room-now',username:'HOST'};
  const regular=await store.priorListenerHistory({...scope,userId:'regular',uniqueId:'viewer'});
  assert.equal(regular.known,true);assert.equal(regular.priorVisitCount,2);assert.equal(regular.hasPriorInteraction,true);
  assert.equal(regular.lastPriorVisitAt,Date.parse('2026-10-29T00:00:00Z'));
  const newUser=await store.priorListenerHistory({...scope,userId:'new'});
  assert.equal(newUser.priorVisitCount,0);assert.equal(newUser.hasPriorInteraction,false);assert.equal(newUser.lastPriorVisitAt,null);
  const quiet=await store.priorListenerHistory({...scope,userId:'quiet'});
  assert.equal(quiet.priorVisitCount,1);assert.equal(quiet.hasPriorInteraction,false);
  const alias=await store.priorListenerHistory({...scope,userId:'absent',uniqueId:'@OLD_VIEWER'});
  assert.equal(alias.hasPriorInteraction,true);assert.equal(alias.priorVisitCount,0);
  await db.exec(`INSERT INTO live_sessions VALUES ('blank','');INSERT INTO live_events VALUES ('blank','host','new','2026-10-30','comment');`);
  const blank=await store.priorListenerHistory({sessionId:'blank',roomId:'',username:'host',userId:'new'});
  assert.equal(blank.hasPriorInteraction,true,'events in the other LIVE still count when room IDs are absent');
  assert.equal(store.firstVisitHistoryStats.failures,0);assert.equal(store.firstVisitHistoryStats.checks,5);
  const {sql,params}=queries[0];
  const plan=await db.query('EXPLAIN (FORMAT JSON) '+sql,params);
  assert.match(JSON.stringify(plan.rows),/Limit/);
  assert.match(sql,/ORDER BY e.event_at DESC LIMIT 1/);
});

test('failed history lookup remains unknown and is visible in metadata diagnostics',async()=>{
  const store=new EventStore();store.ready=true;
  store.pool={query:async()=>{throw Object.assign(Error('canceling statement due to statement timeout'),{code:'57014'});}};
  const history=await store.priorListenerHistory({sessionId:'current',username:'host',userId:'regular'});
  assert.equal(history.known,false);assert.equal(store.firstVisitHistoryStats.failures,1);
  assert.equal(store.firstVisitHistoryStats.unknown,1);
  assert.deepEqual(Object.keys(store.firstVisitHistoryStats).sort(),['checks','failures','lastMs','maxMs','unknown']);
});
