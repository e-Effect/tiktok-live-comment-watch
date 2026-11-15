import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {EventStore} from '../lib/event-store.js';
import {LURKER_RULES} from '../lib/lurker-classification.js';

const source = await readFile(new URL('../lib/event-store.js', import.meta.url), 'utf8');

// The pre-fast-path SQL is an independent reference for every returned field.
function legacySql(direction) {
  const order = String(direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `WITH totals AS (
    SELECT s.user_id,
      SUM(visit_count)::bigint AS visits, SUM(comment_count)::bigint AS comments,
      SUM(gift_count)::bigint AS gifts, SUM(gift_coins)::bigint AS coins,
      SUM(share_count)::bigint AS shares, SUM(like_count)::bigint AS likes,
      SUM(follow_count)::bigint AS follows,
      MIN(s.first_seen_at) AS stats_first_seen_at, MAX(s.last_seen_at) AS stats_last_seen_at,
      MAX(s.last_comment_at) AS last_comment_at, MAX(s.last_gift_at) AS last_gift_at
    FROM listener_stream_stats s
    WHERE ($1 = '' OR LOWER(s.stream_username) = LOWER($1))
      AND LOWER(s.user_id) <> 'unknown' AND $2::text = ''
    GROUP BY s.user_id
  ), classified AS (
    SELECT t.*,
      (t.visits >= ${LURKER_RULES.minVisits}
        AND t.comments::numeric / GREATEST(t.visits, 1) < ${LURKER_RULES.maxCommentsPerVisit}
        AND t.coins::numeric / GREATEST(t.visits, 1) < ${LURKER_RULES.maxCoinsPerVisit}) AS is_lurker,
      ROUND(t.comments::numeric / GREATEST(t.visits, 1), 2) AS comments_per_visit,
      ROUND(t.coins::numeric / GREATEST(t.visits, 1), 2) AS all_coins_per_visit,
      ROUND(t.visits::numeric / (1 + t.comments + t.coins::numeric / 10), 2) AS lurker_score
    FROM totals t
  ), filtered AS (
    SELECT c.* FROM classified c WHERE TRUE AND TRUE AND TRUE
  ), page AS MATERIALIZED (
    SELECT * FROM filtered
    ORDER BY coins ${order} NULLS LAST, stats_last_seen_at DESC, user_id
    LIMIT $3 OFFSET $4
  )
  SELECT p.*, l.latest_unique_id, l.latest_nickname, l.avatar_url,
    (l.avatar_data IS NOT NULL) AS avatar_cached,
    l.first_seen_at, l.last_seen_at, l.is_super_fan, l.needs_attention,
    l.good_impression, l.gift_excluded, l.welcome_notice, l.stamp_message_enabled, l.stamp_message,
    l.is_super_lurker, l.is_blocked, l.notes, l.tags,
    l.host_follow_status, l.host_follow_status_updated_at,
    l.profile_follower_count, l.profile_following_count, l.profile_counts_updated_at,
    l.manually_updated_at, l.created_at, l.updated_at
  FROM page p JOIN listeners l ON l.user_id = p.user_id
  ORDER BY p.coins ${order} NULLS LAST, p.stats_last_seen_at DESC, p.user_id`;
}

function storeWithPool(pool) {
  const store = new EventStore();
  store.ready = true;
  store.pool = pool;
  store.listenerPageCount = () => {throw Error('Page must not count');};
  store.listenerContributionRankings = () => {throw Error('Page must not launch rank work');};
  return store;
}

async function capture(options) {
  const queries = [];
  await storeWithPool({async query(sql,args) {queries.push({sql,args}); return {rows:[]};}}).listeners(options);
  assert.equal(queries.length, 1);
  return queries[0];
}

async function database(t, size = 87) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS listeners ('),
    source.indexOf('CREATE TABLE IF NOT EXISTS listener_aliases (')));
  await db.exec(source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS listener_stream_stats ('),
    source.indexOf('CREATE TABLE IF NOT EXISTS listener_stamps (')));
  await db.query(`INSERT INTO listeners(user_id,latest_unique_id,latest_nickname,avatar_url,avatar_data,
    first_seen_at,last_seen_at,is_super_fan,is_blocked,needs_attention,good_impression,gift_excluded,
    welcome_notice,stamp_message_enabled,stamp_message,is_super_lurker,notes,tags,
    host_follow_status,host_follow_status_updated_at,profile_follower_count,profile_following_count,
    profile_counts_updated_at,manually_updated_at,created_at,updated_at)
    SELECT lpad(n::text,8,'0'),'handle_'||n,'Person '||n,'https://fixture.invalid/'||n,
      CASE WHEN n%2=0 THEN decode('ff','hex') END,
      '2026-01-01'::timestamptz+n*interval '1 hour',
      '2026-10-01'::timestamptz+(n%11)*interval '1 day',
      n%2=0,n%3=0,n%4=0,n%5=0,n%6=0,n%7=0,n%8=0,'Message '||n,n%9=0,
      'Notes '||n,jsonb_build_array('tag'||n),
      CASE WHEN n%2=0 THEN 'following' ELSE 'unknown' END,
      '2026-09-01',n*11,n*3,'2026-09-02','2026-09-03','2026-01-01','2026-10-01'
    FROM generate_series(1,$1::int) n`,[size]);
  await db.exec(`
    INSERT INTO listeners(user_id,first_seen_at,last_seen_at)
      VALUES ('unknown','2026-01-01','2030-01-01'),('UNKNOWN','2026-01-01','2030-01-01');
    INSERT INTO listener_stream_stats(stream_username,user_id,visit_count,comment_count,gift_count,
      gift_coins,share_count,like_count,follow_count,first_seen_at,last_seen_at,last_comment_at,last_gift_at)
    SELECT h,user_id,n%11,n%7,n%3,(n%20)*CASE WHEN h='HOST' THEN 2 ELSE 1 END,
      n%5,n%13,n%2,first_seen_at+CASE WHEN h='HOST' THEN interval '1 hour' ELSE interval '0' END,
      last_seen_at+CASE WHEN h='HOST' THEN interval '1 hour' ELSE interval '0' END,
      CASE WHEN n%7>0 THEN last_seen_at END,CASE WHEN n%3>0 THEN last_seen_at END
    FROM listeners CROSS JOIN (VALUES ('host'),('HOST'),('other'),('sparse')) hosts(h)
      CROSS JOIN LATERAL (SELECT CASE WHEN LOWER(user_id)='unknown' THEN 999 ELSE user_id::int END n) x
    WHERE n NOT IN (84,85) AND (n<>83 OR h='other')
      AND (h<>'sparse' OR n%10=0) AND (n<>86 OR h='host') AND (n<>87 OR h='HOST');
    CREATE INDEX listener_stats_lower_stream_user_idx
      ON listener_stream_stats(LOWER(stream_username),user_id);
    ANALYZE listeners;
    ANALYZE listener_stream_stats;
  `);
  return db;
}

test('scoped coins fast path is gated and applies pagination exactly once', async () => {
  for (const direction of ['asc','desc']) {
    const {sql,args} = await capture({username:'hOsT',sort:'coins',direction,limit:20,offset:40});
    assert.match(sql,/order_totals AS/);
    assert.match(sql,/page_ids AS MATERIALIZED/);
    assert.match(sql,/JOIN page_ids selected ON selected.user_id = s.user_id/);
    assert.equal((sql.match(/\bLIMIT\b/g)||[]).length,1);
    assert.equal((sql.match(/\bOFFSET\b/g)||[]).length,1);
    assert.deepEqual(args,['hOsT','',21,40]);
    assert.doesNotMatch(sql,/COUNT\s*\(|\bOVER\s*\(/i);
  }
  const fallbacks = [
    {username:''},{username:'  '},{sort:'visits'},{search:'Person'},
    {classification:'lurker'},{classification:'non_lurker'},
    {blocked:'blocked'},{blocked:'unblocked'},{screenshot:'yes'},
    ...['attention','welcome','giftExperience','commentExperience'].flatMap(key=>
      ['yes','no'].map(value=>({[key]:value}))),
  ];
  for (const overrides of fallbacks) {
    const query = await capture({username:'host',sort:'coins',...overrides});
    assert.doesNotMatch(query.sql,/order_totals AS|page_ids AS/,JSON.stringify(overrides));
  }
});

test('actual scoped coins pages match every legacy serialized field across scopes and pages', async t => {
  const db = await database(t);
  let comparisons = 0;
  for (const username of ['host','HOST','hOsT','other','sparse','missing']) {
    for (const direction of ['asc','desc']) {
      const count = Number((await db.query(`SELECT COUNT(DISTINCT user_id) AS total
        FROM listener_stream_stats WHERE LOWER(stream_username)=LOWER($1)
          AND LOWER(user_id)<>'unknown'`,[username])).rows[0].total);
      const seen = [];
      for (const offset of [...Array.from({length:Math.ceil(count/7)+1},(_,i)=>i*7),count+100]) {
        const options = {username,sort:'coins',direction,limit:7,offset};
        let actualRows, expectedRows;
        const store = storeWithPool({async query(sql,args) {
          const result = await db.query(sql,args); actualRows=result.rows; return result;
        }});
        const reference = storeWithPool({async query(_sql,args) {
          const result = await db.query(legacySql(direction),args); expectedRows=result.rows; return result;
        }});
        const actual = await store.listeners(options);
        const expected = await reference.listeners(options);
        assert.deepEqual(actualRows,expectedRows,JSON.stringify(options)+' raw rows');
        assert.deepEqual(actual,expected,JSON.stringify(options)+' serialized page');
        assert.equal(actual.hasMore,count>offset+7);
        assert.ok(actual.items.every(row=>!['unknown','UNKNOWN','00000084','00000085'].includes(row.userId)));
        if (offset<count) seen.push(...actual.items.map(row=>row.userId));
        comparisons++;
      }
      assert.equal(seen.length,count);
      assert.equal(new Set(seen).size,count,'No duplicates or missing pages');
    }
  }
  const store=storeWithPool(db);
  const page=await store.listeners({username:'hOsT',sort:'coins',limit:250});
  assert.equal(page.items.find(row=>row.userId==='00000019').coins,57,'Sum host and HOST, not one row');
  assert.ok(page.items.some(row=>row.userId==='00000087'),'Uppercase-only participation survives');
  assert.ok(!page.items.some(row=>row.userId==='00000083'),'Other-scope-only profile stays excluded');
  for (const options of [{limit:1},{limit:100},{limit:250,offset:7},{limit:999,offset:7},
    {limit:7,offset:7,search:'   '},{limit:7,offset:7,direction:'invalid'}]) {
    const request={username:'hOsT',sort:'coins',...options};
    const reference=storeWithPool({query:(_sql,args)=>db.query(legacySql(request.direction),args)});
    assert.deepEqual(await store.listeners(request),await reference.listeners(request),JSON.stringify(options));
  }
  t.diagnostic('Full raw-row and serialized-page legacy comparisons: '+comparisons);
});

function planNodes(plan) {
  return [plan,...(plan.Plans||[]).flatMap(planNodes)];
}

const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];

test('isolated actual-SQL benchmark reports scoped coins plans, including slower cases',
  {skip:process.env.LEDGER_SCOPED_BENCHMARK!=='1'}, async t => {
    const db=await database(t,12000);
    const explain=async query=>(await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+query.sql,query.args)).rows[0]['QUERY PLAN'][0];
    for (const options of [{username:'hOsT',offset:0},{username:'other',offset:0},
      {username:'sparse',offset:0},{username:'missing',offset:0},{username:'hOsT',offset:6000}]) {
      const actual=await capture({...options,sort:'coins',direction:'desc',limit:20});
      const legacy={sql:legacySql('desc'),args:actual.args};
      await explain(legacy);await explain(actual);
      const oldTimes=[],newTimes=[];
      let oldPlan,newPlan;
      for(let i=0;i<5;i++) {
        if(i%2===0){oldPlan=await explain(legacy);newPlan=await explain(actual);}
        else{newPlan=await explain(actual);oldPlan=await explain(legacy);}
        oldTimes.push(oldPlan['Execution Time']);newTimes.push(newPlan['Execution Time']);
      }
      t.diagnostic(JSON.stringify({scope:options.username,offset:options.offset,
        legacyMedianMs:median(oldTimes),actualMedianMs:median(newTimes),
        changePercent:Math.round((median(newTimes)/median(oldTimes)-1)*100),
        legacySamples:oldTimes,actualSamples:newTimes}));
      if(options.username==='hOsT' && !options.offset) {
        const summarize=plan=>planNodes(plan.Plan).map(n=>Object.fromEntries([
          'Node Type','Subplan Name','CTE Name','Relation Name','Index Name',
          'Plan Width','Actual Rows','Actual Loops','Peak Memory Usage'
        ].filter(key=>key in n).map(key=>[key,n[key]])));
        t.diagnostic('LEGACY ACTUAL PLAN '+JSON.stringify(summarize(oldPlan)));
        t.diagnostic('FAST PATH ACTUAL PLAN '+JSON.stringify(summarize(newPlan)));
        const ids=planNodes(newPlan.Plan).find(n=>n['Subplan Name']==='CTE page_ids');
        assert.equal(ids['Actual Rows'],21);
        const metrics=planNodes(newPlan.Plan).find(n=>n['Subplan Name']==='CTE page');
        assert.equal(metrics['Actual Rows'],21);
      }
    }
  });
