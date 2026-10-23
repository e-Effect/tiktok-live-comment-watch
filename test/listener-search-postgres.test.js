import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {EventStore} from '../lib/event-store.js';
import {classifyLurker} from '../lib/lurker-classification.js';

test('PostgreSQL list/count agree across scope, filters, orders and page boundaries', async t => {
  const db = new PGlite(); t.after(() => db.close());
  const source = await readFile(new URL('../lib/event-store.js', import.meta.url), 'utf8');
  await db.exec(source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS listeners ('), source.indexOf('CREATE INDEX IF NOT EXISTS listeners_last_seen_idx')));
  await db.exec(source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS listener_stream_stats ('), source.indexOf('CREATE TABLE IF NOT EXISTS listener_stamps (')));
  await db.exec(`
    INSERT INTO listeners(user_id,latest_unique_id,latest_nickname,notes,first_seen_at,last_seen_at,is_blocked,needs_attention,welcome_notice)
    SELECT lpad(n::text,3,'0'),'id'||n,'Name '||lpad((n%9)::text,2,'0'),CASE WHEN n%2=0 THEN 'memo' ELSE '' END,
      '2026-01-01'::timestamptz+n*interval '1 day','2026-10-01'::timestamptz+(n%4)*interval '1 day',n%4=0,n%3=0,n%5=0
    FROM generate_series(1,40) n;
    INSERT INTO listeners(user_id,first_seen_at,last_seen_at) VALUES ('unknown','2026-01-01','2026-10-01');
    INSERT INTO listener_stream_stats(stream_username,user_id,visit_count,comment_count,gift_count,gift_coins,share_count,first_seen_at,last_seen_at)
    SELECT host,user_id,8+n%5,n%7,CASE WHEN n%3=0 THEN 2 ELSE 0 END,CASE WHEN n%3=0 THEN n*11 ELSE 0 END,n%4,
      first_seen_at+interval '1 hour',last_seen_at-interval '1 hour'
    FROM listeners CROSS JOIN (VALUES ('host'),('HOST'),('other')) h(host) CROSS JOIN LATERAL (SELECT CASE WHEN user_id='unknown' THEN 1 ELSE user_id::int END n) x
    WHERE user_id <> '040';
  `);
  const profiles = (await db.query('SELECT * FROM listeners')).rows;
  const stats = (await db.query('SELECT * FROM listener_stream_stats')).rows;
  let queries = [];
  const store = new EventStore(); store.ready = true;
  store.pool = {query(sql,args) {queries.push(sql); return db.query(sql,args);}};
  const filters = [{},{search:'memo'},{search:"' OR TRUE --"},{blocked:'blocked'},{blocked:'unblocked',attention:'yes'},
    {welcome:'yes'},{giftExperience:'yes',commentExperience:'no'},{giftExperience:'no',commentExperience:'yes'},
    {classification:'lurker'},{classification:'non_lurker'}];
  const sorts = ['last_seen','first_seen','name','visits','comments','gifts','coins','shares','lurker'];
  for (const username of ['', 'hOsT', 'other', 'missing']) for (const sort of sorts) for (const filter of filters) {
    const options = {username,sort,...filter,direction:['first_seen','name'].includes(sort)?'asc':'desc'};
    const fast = !username && !filter.classification && !filter.blocked && !filter.attention && !filter.welcome && !filter.giftExperience && !filter.commentExperience && ['last_seen','first_seen','name'].includes(sort);
    let expected = profiles.filter(p => p.user_id !== 'unknown').flatMap(p => {
      const rows = stats.filter(s => s.user_id === p.user_id && (!username || s.stream_username.toLowerCase() === username.toLowerCase()));
      if (!fast && !rows.length) return [];
      if (filter.search && ![p.user_id,p.latest_unique_id,p.latest_nickname,p.notes].join(' ').toLowerCase().includes(filter.search.toLowerCase())) return [];
      if (filter.blocked && p.is_blocked !== (filter.blocked === 'blocked')) return [];
      if (filter.attention && p.needs_attention !== (filter.attention === 'yes')) return [];
      if (filter.welcome && p.welcome_notice !== (filter.welcome === 'yes')) return [];
      const sum = key => rows.reduce((n,s) => n+Number(s[key]),0);
      const r = {userId:p.user_id,visits:sum('visit_count'),comments:sum('comment_count'),gifts:sum('gift_count'),coins:sum('gift_coins'),shares:sum('share_count')};
      const lurker = classifyLurker(r).isLurker;
      if (filter.classification && lurker !== (filter.classification === 'lurker')) return [];
      if (filter.giftExperience && (r.gifts>0) !== (filter.giftExperience === 'yes')) return [];
      if (filter.commentExperience && (r.comments>0) !== (filter.commentExperience === 'yes')) return [];
      r.name = p.latest_nickname.toLowerCase();
      r.last_seen = fast ? +p.last_seen_at : Math.max(...rows.map(s=>+s.last_seen_at));
      r.first_seen = fast ? +p.first_seen_at : Math.min(...rows.map(s=>+s.first_seen_at));
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
    let count = store.listenerPageCount(options);
    if (count.pending) {await store.activeListenerPageCount; count = store.listenerPageCount(options);}
    assert.equal(count.error,undefined,JSON.stringify(options));
    assert.equal(count.total,expected.length,JSON.stringify(options));
  }
});
