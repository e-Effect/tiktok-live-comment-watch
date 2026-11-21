import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {EventStore} from '../lib/event-store.js';
import {classifyLurker} from '../lib/lurker-classification.js';
import {screenshotRecordsSchema} from '../lib/screenshot-records.js';

async function searchDatabase(t, options) {
  const db = new PGlite(options); t.after(() => db.close());
  const source = await readFile(new URL('../lib/event-store.js', import.meta.url), 'utf8');
  await db.exec(source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS listeners ('), source.indexOf('CREATE INDEX IF NOT EXISTS listeners_last_seen_idx')));
  await db.exec(source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS listener_stream_stats ('), source.indexOf('CREATE TABLE IF NOT EXISTS listener_stamps (')));
  return db;
}

async function pageCount(store, options) {
  let count = store.listenerPageCount(options);
  if (count.pending) {await store.activeListenerPageCount; count = store.listenerPageCount(options);}
  assert.equal(count.error, undefined, JSON.stringify(options));
  return count.total;
}

const sorts = ['last_seen','first_seen','name','visits','comments','gifts','coins','shares','lurker'];

test('follower ceiling includes zero and the boundary, never unknown counts', async t => {
  const db = await searchDatabase(t);
  await db.exec(`INSERT INTO listeners(user_id,first_seen_at,last_seen_at,profile_follower_count)
    VALUES ('zero',now(),now(),0),('ten',now(),now(),10),('eleven',now(),now(),11),('missing',now(),now(),NULL)`);
  await db.exec("UPDATE listeners SET profile_following_count = CASE user_id WHEN 'eleven' THEN 0 WHEN 'missing' THEN 10 WHEN 'ten' THEN 11 END");
  const store = new EventStore(); store.ready = true; store.pool = db;
  const search = 'フォロー数が10人以下';
  assert.deepEqual((await store.listeners({search})).items.map(x=>x.userId).sort(),['eleven','missing']);
  assert.equal(await pageCount(store,{search}),2);
  assert.deepEqual((await store.listenerExportRows({search})).map(x=>x.userId).sort(),['eleven','missing']);
  for (const search of ['フォロワー数が10人以下','フォロワー１０人以下']) {
    assert.deepEqual((await store.listeners({search})).items.map(x=>x.userId).sort(),['ten','zero']);
    assert.equal(await pageCount(store,{search}),2);
    assert.equal((await store.listenerExportRows({search})).length,2);
  }
  assert.deepEqual((await store.listeners({search:'フォロワー0人以下'})).items.map(x=>x.userId),['zero']);
});

test('PostgreSQL list/count agree across scope, filters, orders and page boundaries', async t => {
  const db = await searchDatabase(t);
  await db.exec(`
    INSERT INTO listeners(user_id,latest_unique_id,latest_nickname,notes,first_seen_at,last_seen_at,is_blocked,needs_attention,welcome_notice)
    SELECT lpad(n::text,3,'0'),'id'||n,'Name '||lpad((n%9)::text,2,'0'),CASE WHEN n%2=0 THEN 'memo' ELSE '' END,
      '2026-01-01'::timestamptz+n*interval '1 day','2026-10-01'::timestamptz+(n%4)*interval '1 day',n%4=0,n%3=0,n%5=0
    FROM generate_series(1,42) n;
    INSERT INTO listeners(user_id,first_seen_at,last_seen_at) VALUES ('unknown','2026-01-01','2026-10-01');
    INSERT INTO listener_stream_stats(stream_username,user_id,visit_count,comment_count,gift_count,gift_coins,share_count,first_seen_at,last_seen_at)
    SELECT host,user_id,8+n%5,n%7,CASE WHEN n%3=0 THEN 2 ELSE 0 END,CASE WHEN n%3=0 THEN n*11 ELSE 0 END,n%4,
      first_seen_at+interval '1 hour',last_seen_at-interval '1 hour'
    FROM listeners CROSS JOIN (VALUES ('host'),('HOST'),('other')) h(host) CROSS JOIN LATERAL (SELECT CASE WHEN user_id='unknown' THEN 1 ELSE user_id::int END n) x
    WHERE user_id NOT IN ('040','042') AND (user_id <> '039' OR host = 'other');
  `);
  const profiles = (await db.query('SELECT * FROM listeners')).rows;
  const stats = (await db.query('SELECT * FROM listener_stream_stats')).rows;
  let queries = [];
  const store = new EventStore(); store.ready = true;
  store.pool = {query(sql,args) {queries.push(sql); return db.query(sql,args);}};
  const filters = [{},{search:'memo'},{search:"' OR TRUE --"},{blocked:'blocked'},{blocked:'unblocked'},
    {blocked:'unblocked',attention:'yes'}, {attention:'yes'}, {attention:'no'}, {welcome:'yes'}, {welcome:'no'},
    {classification:'lurker'},{classification:'non_lurker'},
    ...['all','yes','no'].flatMap(giftExperience => ['all','yes','no'].map(commentExperience => ({giftExperience,commentExperience})))];
  for (const username of ['', 'hOsT', 'other', 'missing']) for (const sort of sorts) for (const filter of filters) for (const direction of ['asc','desc']) {
    const options = {username,sort,...filter,direction};
    const fast = !username && !filter.classification && !filter.blocked && !filter.attention && !filter.welcome && ![filter.giftExperience,filter.commentExperience].some(value=>['yes','no'].includes(value)) && ['last_seen','first_seen','name'].includes(sort);
    let expected = profiles.filter(p => p.user_id !== 'unknown').flatMap(p => {
      const rows = stats.filter(s => s.user_id === p.user_id && (!username || s.stream_username.toLowerCase() === username.toLowerCase()));
      if (username && !rows.length) return [];
      if (filter.search && ![p.user_id,p.latest_unique_id,p.latest_nickname,p.notes].join(' ').normalize('NFKC').toLowerCase().includes(filter.search.normalize('NFKC').toLowerCase())) return [];
      if (filter.blocked && p.is_blocked !== (filter.blocked === 'blocked')) return [];
      if (filter.attention && p.needs_attention !== (filter.attention === 'yes')) return [];
      if (filter.welcome && p.welcome_notice !== (filter.welcome === 'yes')) return [];
      const sum = key => rows.reduce((n,s) => n+Number(s[key]),0);
      const r = {userId:p.user_id,visits:sum('visit_count'),comments:sum('comment_count'),gifts:sum('gift_count'),coins:sum('gift_coins'),shares:sum('share_count')};
      const lurker = classifyLurker(r).isLurker;
      if (filter.classification && lurker !== (filter.classification === 'lurker')) return [];
      if (['yes','no'].includes(filter.giftExperience) && (r.gifts>0) !== (filter.giftExperience === 'yes')) return [];
      if (['yes','no'].includes(filter.commentExperience) && (r.comments>0) !== (filter.commentExperience === 'yes')) return [];
      r.name = p.latest_nickname.toLowerCase();
      r.last_seen = fast || !rows.length ? +p.last_seen_at : Math.max(...rows.map(s=>+s.last_seen_at));
      r.first_seen = fast || !rows.length ? +p.first_seen_at : Math.min(...rows.map(s=>+s.first_seen_at));
      r.lurker = Math.round(r.visits/(1+r.comments+r.coins/10)*100)/100;
      return [r];
    });
    expected.sort((a,b) => ((a[sort]>b[sort]?1:a[sort]<b[sort]?-1:0)*(options.direction==='asc'?1:-1)) || b.last_seen-a.last_seen || a.userId.localeCompare(b.userId));
    for (const offset of [0,7,70]) {
      queries = [];
      const actual = await store.listeners({...options,offset,limit:7});
      assert.equal(queries.length,1,'one page query; no detached count before display');
      assert.doesNotMatch(queries[0],/COUNT\(\*\) OVER/);
      assert.deepEqual(actual.items.map(r=>r.userId),expected.slice(offset,offset+7).map(r=>r.userId),JSON.stringify({...options,offset}));
      for (const item of actual.items) {
        const original=expected.find(r=>r.userId===item.userId);
        for (const key of ['visits','comments','gifts','coins','shares']) assert.equal(item[key],original[key]);
      }
      assert.equal(actual.hasMore,expected.length>offset+7);
    }
    assert.equal(await pageCount(store,options),expected.length,JSON.stringify(options));
  }
  await db.exec(screenshotRecordsSchema+`
    CREATE TABLE listener_aliases(user_id text,unique_id text);
    INSERT INTO listener_aliases VALUES ('002','old_handle');
    INSERT INTO screenshot_listener_records(stream_username,tiktok_id,user_id,enabled) VALUES
      ('host','id1','001',FALSE),('host','old_handle','',FALSE),('host','changed_handle','004',TRUE),
      ('host','not_yet_seen','',TRUE),('host','id40','040',TRUE),('different','id3','003',TRUE);
  `);
  const first=await store.listeners({username:'hOsT',screenshot:'yes',sort:'coins',limit:2});
  const second=await store.listeners({username:'hOsT',screenshot:'yes',sort:'coins',limit:2,offset:2});
  assert.equal(first.hasMore,true);assert.equal(second.hasMore,false);
  assert.deepEqual([...first.items,...second.items].map(r=>r.userId).sort(),['001','002','004']);
  assert.equal(store.listenerPageCount({username:'host',screenshot:'yes',sort:'coins'}).pending,true);
  await store.activeListenerPageCount;
  assert.equal(store.listenerPageCount({username:'host',screenshot:'yes',sort:'coins'}).total,3);
  assert.equal((await store.listeners({username:'missing',screenshot:'yes'})).items.length,0);
  for (const sort of sorts) for (const direction of ['asc','desc']) for (const filter of [{},{giftExperience:'no'},{commentExperience:'no'},{classification:'non_lurker'},{blocked:'blocked'},{welcome:'yes'}]) {
    const options={screenshot:'yes',sort,direction,...filter};
    const result=await store.listeners({...options,limit:100});
    // Screenshot reservations deliberately require participation history.
    assert.ok(!result.items.some(row=>row.userId==='040'),JSON.stringify(options));
    if (!Object.keys(filter).length) assert.deepEqual(result.items.map(row=>row.userId).sort(),['001','002','003','004']);
    assert.equal(await pageCount(store,options),result.items.length,JSON.stringify(options));
  }
  store.listenerContributionRankings=async()=>({lifetimeOrder:['004','003','002','001'],recentOrder:[],generatedAt:1,byUserId:new Map()});
  const ranked=await store.listenerContributionPage({username:'host',screenshot:'yes'});
  assert.deepEqual(ranked.items.map(r=>r.userId),['004','002','001']);assert.equal(ranked.total,3);
});

test('PostgreSQL literal NFKC search agrees in global/scoped pages, counts and export', async t => {
  const db = await searchDatabase(t);
  assert.equal((await db.query("SELECT normalize('\uFF21\uFF22\uFF23\uFF3F\uFF05', NFKC) AS value")).rows[0].value,'ABC_%');
  const fixtures = [
    ['id_001','alpha_beta','Support100%','path\\folder'],
    ['idX001','alphaxbeta','Support100point','pathfolder'],
    ['wide','\uFF41\uFF4C\uFF50\uFF48\uFF41\uFF3F\uFF42\uFF45\uFF54\uFF41','\uFF21\uFF22\uFF23','literal!_%\\mix'],
    ['plain','plain','ABC','literal!xpointmix'],
    ['profile','profile','\uFF21\uFF22\uFF23','Support100%'],
    ['other','other_id','Other','path\\folder'],
    ['sql','safe','SQL',"' OR TRUE --"],
    ['unknown','alpha_beta','ABC','Support100%'],
  ];
  for (const fields of fixtures) {
    await db.query(`INSERT INTO listeners(user_id,latest_unique_id,latest_nickname,notes,first_seen_at,last_seen_at)
      VALUES ($1,$2,$3,$4,'2026-01-01','2026-10-01')`,fields);
    if (fields[0] !== 'profile') await db.query(`INSERT INTO listener_stream_stats(stream_username,user_id,visit_count,first_seen_at,last_seen_at)
      VALUES ($1,$2,2,'2026-01-01','2026-10-01')`,[fields[0]==='other'?'other':'host',fields[0]]);
  }
  const queries=[];
  const store=new EventStore();store.ready=true;
  store.pool={query(sql,args){queries.push({sql,args});return db.query(sql,args);}};
  const searches=['','_','%','\\','!','alpha_beta','Support100%','path\\folder','literal!_%\\mix','ABC',
    '\uFF21\uFF22\uFF23','\uFF41\uFF4C\uFF50\uFF48\uFF41\uFF3F\uFF42\uFF45\uFF54\uFF41','\uFF05','\uFF3F',
    "' OR TRUE --","'; DROP TABLE listeners; --",'*'];
  for (const search of searches) for (const username of ['', 'hOsT','other','missing']) {
    const expected=fixtures.filter(row=>row[0]!=='unknown'
      && (!username || row[0]!=='profile' && (row[0]==='other'?'other':'host')===username.toLowerCase())
      && row.join(' ').normalize('NFKC').toLowerCase().includes(search.normalize('NFKC').trim().toLowerCase())).map(row=>row[0]).sort();
    for (const sort of sorts) {
      const options={username,search,sort};
      const all=await store.listeners({...options,limit:100});
      assert.deepEqual(all.items.map(row=>row.userId).sort(),expected,JSON.stringify(options));
      assert.equal(await pageCount(store,options),expected.length,JSON.stringify(options));
      const paged=[];
      for (let offset=0;offset<=expected.length;offset+=2) {
        const before=queries.length;
        const page=await store.listeners({...options,limit:2,offset});
        assert.equal(queries.length,before+1,'page never triggers full count');
        assert.doesNotMatch(queries.at(-1).sql,/COUNT\(\*\) OVER/);
        assert.equal(page.hasMore,expected.length>offset+2);
        paged.push(...page.items.map(row=>row.userId));
      }
      assert.deepEqual(paged,all.items.map(row=>row.userId),JSON.stringify(options));
    }
    const exported=await store.listenerExportRows({username,search});
    assert.deepEqual(exported.map(row=>row.userId).sort(),expected,JSON.stringify({username,search}));
    for (const row of exported.filter(row=>row.userId==='profile')) {
      for (const key of ['visits','comments','gifts','coins','shares']) assert.equal(row[key],0);
    }
    if (!username) assert.equal((await store.listenerCount({search})).total,expected.length,search);
  }
  const malicious="'; DROP TABLE listeners; --";
  const calls=queries.filter(call=>call.args.includes(malicious));
  assert.ok(calls.length>0);
  for (const {sql} of calls) assert.ok(!sql.includes(malicious),'input remains a bound parameter');
  await store.listeners({username:"host' OR TRUE --",sort:'coins',direction:'ASC; DROP TABLE listeners; --'});
  assert.ok(!queries.at(-1).sql.includes("host' OR TRUE --"));
  assert.ok(!queries.at(-1).sql.includes('DROP TABLE'));
  await store.listeners({sort:'coins; DROP TABLE listeners; --'});
  assert.ok(!queries.at(-1).sql.includes('DROP TABLE'),'sort remains whitelisted');
  assert.equal((await db.query('SELECT COUNT(*)::int AS total FROM listeners')).rows[0].total,fixtures.length);
});

test('default recent page uses the existing DESC index and preserves page-first results', async t => {
  const db=await searchDatabase(t);
  await db.exec(`
    CREATE INDEX listeners_last_seen_idx ON listeners(last_seen_at DESC);
    INSERT INTO listeners(user_id,first_seen_at,last_seen_at)
    SELECT lpad(n::text,6,'0'),'2026-01-01'::timestamptz,
      '2026-10-01'::timestamptz+(n%101)*interval '1 second'
    FROM generate_series(1,12000) n;
    INSERT INTO listener_stream_stats(stream_username,user_id,visit_count,first_seen_at,last_seen_at)
    SELECT host,user_id,1,first_seen_at,last_seen_at FROM listeners
      CROSS JOIN (VALUES ('host'),('other'),('third')) s(host);
    ANALYZE listeners;
    ANALYZE listener_stream_stats;
  `);
  const store=new EventStore();store.ready=true;
  let captured, calls=0;
  store.pool={query(sql,args){calls++;captured={sql,args};return db.query(sql,args);}};
  for (const offset of [0,20]) {
    const result=await store.listeners({limit:20,offset});
    assert.equal(calls,offset===0?1:2,'exactly one page query without a full count');
    const {sql,args}=captured;
    assert.match(sql,/ORDER BY last_seen_at DESC, last_seen_at DESC, user_id/);
    assert.match(sql,/ORDER BY p\.last_seen_at DESC, p\.last_seen_at DESC, p\.user_id/);
    assert.match(sql,/FROM page p LEFT JOIN LATERAL/);
    assert.match(sql,/WHERE s\.user_id = p\.user_id/);
    assert.doesNotMatch(sql,/NULLS LAST|COUNT\(\*\) OVER/);
    const oldSql=sql.replace('ORDER BY last_seen_at DESC,','ORDER BY last_seen_at DESC NULLS LAST,')
      .replace('ORDER BY p.last_seen_at DESC,','ORDER BY p.last_seen_at DESC NULLS LAST,');
    const previous=(await db.query(oldSql,args)).rows;
    assert.deepEqual(result.items.map(row=>row.userId),previous.slice(0,20).map(row=>row.user_id));
    assert.ok(result.items.every(row=>row.visits===3));
    assert.equal(result.hasMore,true);
    if (!offset) {
      const explained=(await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,args)).rows[0]['QUERY PLAN'][0].Plan;
      const nodes=[];
      const visit=plan=>{nodes.push(plan);for (const child of plan.Plans || []) visit(child);};
      visit(explained);
      assert.ok(nodes.some(node=>node['Index Name']==='listeners_last_seen_idx'),JSON.stringify(explained));
      assert.ok(nodes.some(node=>node['Node Type']==='Incremental Sort'),JSON.stringify(explained));
      assert.ok(!nodes.some(node=>node['Node Type']==='Seq Scan' && node['Relation Name']==='listeners'));
      const statsProbe=nodes.find(node=>node['Index Name']==='listener_stream_stats_user_idx');
      assert.ok(statsProbe,JSON.stringify(explained));
      assert.equal(statsProbe['Actual Loops'],21,'one indexed stats lookup per selected profile');
      assert.equal(statsProbe['Actual Rows'],3);
      assert.ok(!nodes.some(node=>node['Node Type']==='Seq Scan' && node['Relation Name']==='listener_stream_stats'));
      t.diagnostic('12,000 profiles / 36,000 stats: page-first DESC index + 21 lateral user-index stats probes; no full stats scan');
    }
  }
  for (const options of [{sort:'last_seen',direction:'asc'},{sort:'first_seen'},{sort:'name'}]) {
    await store.listeners({...options,limit:1});
    assert.match(captured.sql,/NULLS LAST/,'other fast orders keep their original null ordering');
  }
});

test('normalized trigram index builds concurrently and serves literal global/scoped page, count and export searches', async t => {
  const db=await searchDatabase(t,{extensions:{pg_trgm}});
  await db.exec(`
    CREATE EXTENSION pg_trgm;
    CREATE INDEX listeners_search_trgm_idx ON listeners USING GIN (
      (LOWER(user_id || ' ' || latest_unique_id || ' ' || latest_nickname || ' ' || notes)) gin_trgm_ops
    );
    INSERT INTO listeners(user_id,latest_nickname,first_seen_at,last_seen_at)
    SELECT lpad(n::text,6,'0'),CASE WHEN n=6777 THEN '\uFF33\uFF55\uFF50\uFF50\uFF4F\uFF52\uFF54\uFF11\uFF10\uFF10\uFF05'
      WHEN n=6778 THEN 'Support100point' WHEN n%100=0 THEN 'Green'
      ELSE 'Person '||n END,'2026-01-01','2026-10-01'
    FROM generate_series(1,12000) n;
    INSERT INTO listener_stream_stats(stream_username,user_id,visit_count,first_seen_at,last_seen_at)
    SELECT host,user_id,1,first_seen_at,last_seen_at FROM listeners
      CROSS JOIN (VALUES ('host'),('other'),('third')) s(host);
    ANALYZE listeners;
    ANALYZE listener_stream_stats;
  `);
  const oldIndex=(await db.query("SELECT to_regclass('listeners_search_trgm_idx')::oid AS oid")).rows[0].oid;
  const store=new EventStore();store.ready=true;
  const calls=[];
  store.pool={
    query(sql,args){calls.push({sql,args});return db.query(sql,args);},
    async connect(){return {query:({text,values})=>db.query(text,values),release(destroy){assert.equal(destroy,true);}};}
  };
  assert.equal(await store.initializeListenerSearchIndex(),true);
  assert.equal(store.status().listenerSearchIndexReady,true);
  assert.equal((await db.query("SELECT to_regclass('listeners_search_trgm_idx')::oid AS oid")).rows[0].oid,oldIndex);
  await db.exec('ANALYZE listeners');
  const page = await store.listeners({search:'ree',limit:100});
  const rest = await store.listeners({search:'ree',limit:100,offset:100});
  assert.equal(page.hasMore,true);
  assert.equal(rest.hasMore,false);
  assert.deepEqual([...page.items,...rest.items].map(row=>row.userId),
    Array.from({length:120},(_,i)=>String(100*(i+1)).padStart(6,'0')));
  assert.match(calls.at(-1).sql,/matches AS MATERIALIZED/);
  for (const username of ['', 'host']) {
    for (const sort of ['last_seen','coins']) {
      const options={username,sort,search:'Support100%'};
      const result=await store.listeners(options);
      assert.deepEqual(result.items.map(row=>row.userId),['006777']);
      assert.equal(await pageCount(store,options),1);
    }
    const exported=await store.listenerExportRows({username,search:'Support100%'});
    assert.deepEqual(exported.map(row=>row.userId),['006777']);
  }
  for (const {sql,args} of calls) {
    const plan=(await db.query(`EXPLAIN (FORMAT JSON) ${sql}`,args)).rows[0]['QUERY PLAN'][0].Plan;
    const nodes=[];
    const visit=node=>{nodes.push(node);for (const child of node.Plans || []) visit(child);};
    visit(plan);
    assert.ok(nodes.some(node=>node['Index Name']==='listeners_search_nfkc_trgm_idx'),JSON.stringify(plan));
  }
  t.diagnostic('Actual concurrent normalized index build succeeded; all searched page/count/export plans use its trigram index; old index retained');
});

test('export retains profile timestamps for profile-only and stats-backed listeners without changing scoped stats dates', async t => {
  const db=await searchDatabase(t);
  await db.exec(`
    INSERT INTO listeners(user_id,first_seen_at,last_seen_at) VALUES
      ('profile','2026-01-02T00:00:00Z','2026-10-02T00:00:00Z'),('stats','2026-01-01T00:00:00Z','2026-11-01T00:00:00Z');
    INSERT INTO listener_stream_stats(stream_username,user_id,visit_count,first_seen_at,last_seen_at) VALUES
      ('host','stats',1,'2026-02-01T00:00:00Z','2026-09-01T00:00:00Z'),('other','stats',1,'2026-03-01T00:00:00Z','2026-10-01T00:00:00Z');
  `);
  const store=new EventStore();store.ready=true;store.pool=db;
  const global=await store.listenerExportRows();
  assert.equal(global.length,2);
  const profile=global.find(row=>row.userId==='profile');
  assert.equal(profile.firstSeenAt,Date.parse('2026-01-02T00:00:00Z'));
  assert.equal(profile.lastSeenAt,Date.parse('2026-10-02T00:00:00Z'));
  assert.equal(profile.stats_first_seen_at,null);
  assert.equal(profile.stats_last_seen_at,null);
  assert.equal(profile.visits,0);
  for (const username of ['', 'host','other']) {
    const rows=username ? await store.listenerExportRows({username}) : global;
    if (username) assert.deepEqual(rows.map(row=>row.userId),['stats']);
    const stats=rows.find(row=>row.userId==='stats');
    assert.equal(stats.firstSeenAt,Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(stats.lastSeenAt,Date.parse('2026-11-01T00:00:00Z'));
    assert.equal(stats.stats_first_seen_at,Date.parse(username==='other'?'2026-03-01T00:00:00Z':'2026-02-01T00:00:00Z'));
    assert.equal(stats.stats_last_seen_at,Date.parse(username==='host'?'2026-09-01T00:00:00Z':'2026-10-01T00:00:00Z'));
    assert.equal(stats.visits,username?1:2);
  }
});
