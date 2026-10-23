import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readRankMetrics} from '../lib/rank-metrics.js';

test('PostgreSQL keyset aggregation preserves all-stream eligibility and gift rules',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`
  CREATE TABLE listener_stream_stats(stream_username text,user_id text,gift_coins bigint,comment_count bigint,PRIMARY KEY(stream_username,user_id));
  CREATE INDEX ON listener_stream_stats(user_id);
  CREATE TABLE live_events(user_id text,stream_username text,event_type text,event_at timestamptz,item_count int,diamonds bigint);
  CREATE INDEX ON live_events(user_id,event_type,event_at);
  CREATE TABLE live_sessions(id text,room_id text);
  CREATE TABLE viewer_visits(user_id text,stream_username text,session_id text,first_seen_at timestamptz,last_seen_at timestamptz);
  CREATE TABLE listeners(user_id text,latest_unique_id text,latest_nickname text,notes text);
  INSERT INTO listener_stream_stats SELECT 'host',lpad(n::text,5,'0'),0,0 FROM generate_series(1,1100) n;
  INSERT INTO listener_stream_stats VALUES ('host','a',50,5),('other','a',50,5),('host','b',100,10);
  INSERT INTO live_events SELECT 'a',CASE WHEN n<=5 THEN 'host' ELSE 'other' END,'comment','2026-10-22',1,0 FROM generate_series(1,10) n;
  INSERT INTO live_events SELECT 'b','host','comment','2026-10-22',1,0 FROM generate_series(1,10) n;
  INSERT INTO live_events VALUES ('a','host','gift','2026-10-22',2,100),('a','host','like','2026-10-22',77,0),('b','host','gift','2026-10-22',10,100);
  INSERT INTO live_sessions VALUES ('s1','room'),('s2','room');
  INSERT INTO viewer_visits VALUES ('a','host','s1','2026-10-22','2026-10-22'),('a','host','s2','2026-10-22','2026-10-22');
  INSERT INTO listeners VALUES ('a','id_a','Name A',''),('b','id_b','Name B','');
 `);
 const progress=[];
 const all=await readRankMetrics(db,'',{now:new Date('2026-10-23T00:00:00Z'),pause:async()=>{},onProgress:u=>progress.push(u)});
 assert.equal(all.length,1);assert.equal(all[0].user_id,'a');assert.equal(Number(all[0].recent_comments),10);
 assert.equal(Number(all[0].recent_coins),100);assert.equal(Number(all[0].recent_likes),77);assert.equal(Number(all[0].recent_visits),1);
 assert.ok(progress.some(p=>p.scanned===1102));
 const host=await readRankMetrics(db,'host',{now:new Date('2026-10-23T00:00:00Z'),pause:async()=>{}});
 assert.equal(host.length,0);
});
