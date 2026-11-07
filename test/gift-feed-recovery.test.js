import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {EventStore} from '../lib/event-store.js';

test('gift-only recovery filters before LIMIT despite a busy comment feed',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`CREATE TABLE live_events(event_key text,event_type text,event_at timestamptz,
      user_id text,unique_id text,nickname text,avatar_url text,comment_text text,gift_id text,
      gift_name text,item_count int,diamonds int,payload jsonb DEFAULT '{}',stream_username text);
      INSERT INTO live_events(event_key,event_type,event_at,user_id,unique_id,gift_id,gift_name,item_count,diamonds)
      VALUES('missed-gift','gift',NOW()-INTERVAL '1 minute','12345','listener','7934','Heart Me',1,1);
      INSERT INTO live_events(event_key,event_type,event_at,user_id)
      SELECT 'comment-'||i,'comment',NOW(),'other' FROM generate_series(1,300) i;`);
    const store=new EventStore();store.ready=true;
    store.pool={query:(sql,params)=>db.query(sql,params)};
    const ordinary=await store.recentListenerEvents({limit:100});
    assert.equal(ordinary.length,100);assert.ok(ordinary.every(e=>e.type==='comment'));
    const gifts=await store.recentListenerEvents({limit:100,eventType:'gift'});
    assert.equal(gifts.length,1);assert.equal(gifts[0].id,'missed-gift');
    const invalid=await store.recentListenerEvents({limit:100,eventType:"gift' OR 1=1"});
    assert.equal(invalid.length,100);assert.ok(invalid.every(e=>e.type==='comment'));
  }finally{await db.close();}
});
