import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {EventStore} from '../lib/event-store.js';

// Stats CTE captured from 8e132f2 before the lateral change. Keep the same
// profile-page prefix and final ordering so only the aggregation strategy varies.
function legacyQuery(sql) {
  const pageEnd=sql.indexOf(')\n        SELECT p.*, t.*, p.user_id');
  const orderAt=sql.lastIndexOf('ORDER BY p.');
  assert.ok(pageEnd>0 && orderAt>pageEnd);
  return sql.slice(0,pageEnd)+`), totals AS (
    SELECT s.user_id,
      SUM(visit_count)::bigint AS visits, SUM(comment_count)::bigint AS comments,
      SUM(gift_count)::bigint AS gifts, SUM(gift_coins)::bigint AS coins,
      SUM(share_count)::bigint AS shares, SUM(like_count)::bigint AS likes,
      SUM(follow_count)::bigint AS follows,
      MIN(s.first_seen_at) AS stats_first_seen_at, MAX(s.last_seen_at) AS stats_last_seen_at,
      MAX(s.last_comment_at) AS last_comment_at, MAX(s.last_gift_at) AS last_gift_at
    FROM listener_stream_stats s JOIN page p ON p.user_id=s.user_id GROUP BY s.user_id
  ) SELECT p.*, t.*, p.user_id FROM page p LEFT JOIN totals t ON t.user_id=p.user_id
  `+sql.slice(orderAt);
}

test('global lateral pages preserve every legacy raw and serialized field',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const source=await readFile(new URL('../lib/event-store.js',import.meta.url),'utf8');
  await db.exec(source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS listeners ('),source.indexOf('CREATE TABLE IF NOT EXISTS listener_aliases (')));
  await db.exec(source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS listener_stream_stats ('),source.indexOf('CREATE TABLE IF NOT EXISTS listener_stamps (')));
  await db.exec(`
    INSERT INTO listeners(user_id,latest_unique_id,latest_nickname,notes,tags,avatar_data,
      first_seen_at,last_seen_at,is_blocked,is_super_fan,needs_attention,good_impression,
      gift_excluded,welcome_notice,stamp_message_enabled,stamp_message,is_super_lurker,
      host_follow_status,host_follow_status_updated_at,profile_follower_count,
      profile_following_count,profile_counts_updated_at,manually_updated_at)
    SELECT lpad(n::text,3,'0'),'handle_'||n,'Name '||(n%5),
      CASE WHEN n%2=0 THEN '100% ABC' ELSE 'plain' END,jsonb_build_array('tag'||n),
      CASE WHEN n%2=0 THEN decode('ff','hex') END,
      '2026-01-01'::timestamptz+n*interval '1 hour','2026-10-01'::timestamptz+(n%4)*interval '1 hour',
      n%2=0,n%3=0,n%4=0,n%5=0,n%6=0,n%7=0,n%8=0,'Message '||n,n%9=0,
      'following','2026-09-01',n*3,n*2,'2026-09-02','2026-09-03'
    FROM generate_series(1,41) n;
    INSERT INTO listeners(user_id,first_seen_at,last_seen_at) VALUES ('unknown','2026-01-01','2030-01-01');
    INSERT INTO listener_stream_stats(stream_username,user_id,visit_count,comment_count,gift_count,gift_coins,
      share_count,like_count,follow_count,first_seen_at,last_seen_at,last_comment_at,last_gift_at)
    SELECT h,user_id,3,n%7,n%3,n*CASE WHEN h='HOST' THEN 2 ELSE 1 END,n%5,n%11,n%2,
      first_seen_at,last_seen_at+CASE WHEN h='HOST' THEN interval '1 minute' ELSE interval '0' END,
      CASE WHEN n%7>0 THEN last_seen_at END,CASE WHEN n%3>0 THEN last_seen_at END
    FROM listeners CROSS JOIN (VALUES ('host'),('HOST'),('other')) hosts(h)
      CROSS JOIN LATERAL (SELECT CASE WHEN user_id='unknown' THEN 1 ELSE user_id::int END n) x
    WHERE user_id<>'041';
  `);
  let comparisons=0;
  for(const sort of ['last_seen','first_seen','name']) for(const direction of ['asc','desc'])
    for(const search of ['','handle_','100%','ABC','missing']) for(const offset of [0,7,35,100]) {
      const options={sort,direction,search,offset,limit:7};
      let actualRows,legacyRows,calls=0;
      const actual=new EventStore();actual.ready=true;
      actual.listenerPageCount=()=>assert.fail('no count before page');
      actual.listenerContributionRankings=()=>assert.fail('no rank scan');
      actual.pool={async query(sql,args){calls++;assert.match(sql,/LEFT JOIN LATERAL/);
        const result=await db.query(sql,args);actualRows=result.rows;return result;}};
      const legacy=new EventStore();legacy.ready=true;
      legacy.pool={async query(sql,args){const result=await db.query(legacyQuery(sql),args);legacyRows=result.rows;return result;}};
      assert.deepEqual(await actual.listeners(options),await legacy.listeners(options),JSON.stringify(options));
      assert.deepEqual(actualRows,legacyRows,JSON.stringify(options)+' raw fields');
      assert.equal(calls,1);comparisons++;
    }
  const store=new EventStore();store.ready=true;store.pool=db;
  const profile=(await store.listeners({limit:100})).items.find(row=>row.userId==='041');
  assert.ok(profile);assert.equal(profile.visits,0);assert.equal(profile.stats_last_seen_at,null);
  t.diagnostic(comparisons+' full legacy comparisons, including profile-only and mixed-case stats');
});
