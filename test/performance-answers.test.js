import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {answerSchema,scanAnswers,extractAnswer,importReviewed,listAnswers} from '../lib/performance-answers.js';

test('only selected source comments are retained in their original order',async()=>{
  const send=async()=>({ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:'{"indexes":[2,1,1]}'}]}]})});
  assert.deepEqual(await extractAnswer(['男性のタイプでお願いします','年上','ケチは苦手'],'test',send),{index:1,summary:'年上 ／ ケチは苦手'});
  assert.equal(await extractAnswer(['配信者さんの手が綺麗ですね'],'test',()=>assert.fail()),null);
});

test('background extraction stores a dated answer once and reviewed answers overwrite only their own event',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(answerSchema);
  await db.exec(`CREATE TABLE live_sessions(id text,room_id text);
    CREATE TABLE live_events(event_key text,user_id text,stream_username text,event_at timestamptz,comment_text text,session_id text,event_type text default 'comment',source text default 'live',comment_body_pruned boolean default false);
    INSERT INTO live_sessions VALUES('s','room');`);
  const now=Date.now(),at=new Date(now-16*60000),start=new Date(now-17*60000);
  await db.query("INSERT INTO performance_answer_cursor VALUES('mentalist_k',$1)",[start]);
  await db.query("INSERT INTO live_events(event_key,user_id,stream_username,event_at,comment_text,session_id) VALUES('e','A','mentalist_k',$1,'年上で優しい人','s')",[at]);
  let calls=0;
  const extract=async()=>{calls++;return {index:0,summary:'年上で優しい人'};};
  await scanAnswers(db,'test',extract,now);
  assert.equal(calls,1);
  const [first]=await listAnswers(db,'mentalist_k','A');
  assert.equal(+new Date(first.at),+at);
  assert.equal(await importReviewed(db,'e','B','違う人'),0);
  assert.equal(await importReviewed(db,'e','A','確認済みの回答'),1);
  await db.query("UPDATE performance_answer_cursor SET through_at=$1",[start]);
  await scanAnswers(db,'test',extract,now);
  assert.equal(calls,1);
  assert.deepEqual((await listAnswers(db,'mentalist_k','A')).map(x=>x.summary),['確認済みの回答']);
  assert.deepEqual(await listAnswers(db,'other','A'),[]);
});
