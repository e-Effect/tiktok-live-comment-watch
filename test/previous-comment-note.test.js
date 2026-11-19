import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createPreviousNoteService} from '../lib/previous-comment-note.js';

test('summarizes only this listener in the previous room, skips reconnects and reuses the result',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE live_sessions(id uuid,stream_username text,room_id text,started_at timestamptz);
    CREATE TABLE live_events(event_key serial,session_id uuid,user_id text,stream_username text,event_type text default 'comment',
      source text default 'live',payload jsonb default '{}',event_at timestamptz,comment_text text,comment_body_pruned boolean default false);`);
  const ids=[1,2,3].map(n=>'00000000-0000-4000-8000-00000000000'+n);
  for(let i=0;i<3;i++)await db.query('insert into live_sessions values($1,$2,$3,$4)',[ids[i],'host',i?'current':'old','2026-11-'+(10+i)]);
  for(const [idx,user,text] of [[0,'A','シャッフルは難しい？'],[0,'B','unrelated'],[1,'A','reconnect'],[2,'A','now']]){
    await db.query('insert into live_events(session_id,user_id,stream_username,event_at,comment_text) values($1,$2,$3,$4,$5)',
      [ids[idx],user,'host','2026-11-'+(10+idx)+'T12:00Z',text]);
  }
  let count=0;
  const summarize=createPreviousNoteService({fetchImpl:async(_,opts)=>{
    count++;assert.deepEqual(JSON.parse(JSON.parse(opts.body).input),['シャッフルは難しい?']);
    return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:'シャッフルの難しさについて質問していました。'}]}]})};
  }});
  const options={pool:db,sessionId:ids[2],userId:'A',apiKey:'fixture'};
  const first=await summarize(options);
  assert.match(first.note,/シャッフル/);
  assert.deepEqual(await summarize(options),first);
  assert.equal((await summarize({...options,userId:'missing'})).at,null);
  await db.query('update live_events set comment_body_pruned=true where session_id=$1',[ids[0]]);
  const pruned=await summarize(options);assert.ok(pruned.at);assert.equal(pruned.note,null);
  assert.equal(count,1);
});
