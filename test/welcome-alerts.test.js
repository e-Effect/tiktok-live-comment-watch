import test from 'node:test';
import assert from 'node:assert/strict';
import {WelcomeAlerts} from '../lib/welcome-alerts.js';
import {EventStore} from '../lib/event-store.js';

test('welcome notice is once per session, survives refresh through active snapshot',()=>{
 const alerts=new WelcomeAlerts();alerts.replace(['u']);
 const person={userId:'u',nickname:'テスト',avatarUrl:'https://example.com/avatar.png'};
 assert.equal(alerts.accept('s',{userId:'other'},1000,1000),null);
 const first=alerts.accept('s',person,1000,1000);
 assert.equal(first.kind,'welcome');assert.equal(first.avatarUrl,person.avatarUrl);
 assert.equal(first.expiresAt,31000);assert.equal(alerts.active('s',2000).length,1);
 assert.equal(alerts.accept('s',person,2000,2000),null);
 assert.equal(alerts.active('s',32000).length,0);
 assert.equal(alerts.accept('s',person,40000,40000),null);
 assert.ok(alerts.accept('next-session',person,40000,40000));
 alerts.update('u',false);assert.equal(alerts.accept('another-session',person,41000,41000),null);
});
test('old events do not trigger arrival notification',()=>{
 const alerts=new WelcomeAlerts();alerts.replace(['u']);
 assert.equal(alerts.accept('s',{userId:'u'},1000,40000),null);
 assert.ok(alerts.accept('s',{userId:'u'},40000,40000));
});
test('welcome checkbox is independently persisted and normalized',async()=>{
 const store=new EventStore();store.ready=true;
 for(const enabled of [true,false]) {
  store.pool={query:async(sql,args)=>{
   assert.match(sql,/welcome_notice = COALESCE\(\$10::boolean, welcome_notice\)/);
   assert.deepEqual(args,['u',null,null,null,null,null,null,null,null,enabled]);
   return {rows:[{user_id:'u',welcome_notice:enabled}]};
  }};
  assert.equal((await store.updateListener('u',{welcomeNotice:enabled})).welcomeNotice,enabled);
 }
});
