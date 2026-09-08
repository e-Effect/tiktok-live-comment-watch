import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {japanCalendarDay} from '../lib/birthday.js';
import {EventStore} from '../lib/event-store.js';
test('birthday calendar changes at midnight Japan time',()=>{
 assert.equal(japanCalendarDay(Date.parse('2026-09-08T14:59:59Z')),'2026-09-08');
 assert.equal(japanCalendarDay(Date.parse('2026-09-08T15:00:00Z')),'2026-09-09');
});
test('birthday celebration is only for live Heart Me and is claimed before notification',async()=>{
 const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const method=source.slice(source.indexOf('  async checkBirthdayCelebration('),source.indexOf('  async checkBirthday(comment)'));
 let claimed=false,calls=0;const notifications=[];
 const session=vm.runInNewContext(`({recordingEnabled:true,username:'host',emitNormalized:e=>notifications.push(e),${method}})`,{
   japanCalendarDay,isAnonymousListenerIdentity:()=>false,notifications,eventStore:{claimBirthdayCelebration:async()=>{calls++;if(claimed)return false;claimed=true;return true;}}
 });
 const gift={userId:'u',nickname:'Example',isHeartMe:true,at:Date.now(),source:'live'};
 await session.checkBirthdayCelebration({...gift,isHeartMe:false});
 await session.checkBirthdayCelebration({...gift,source:'initial'});
 await session.checkBirthdayCelebration({...gift,at:gift.at-86400000});assert.equal(calls,0);
 assert.equal(await session.checkBirthdayCelebration(gift),true);
 assert.equal(await session.checkBirthdayCelebration(gift),false);
 assert.equal(notifications.length,1);assert.equal(notifications[0].type,'birthday_celebration');
});
test('database claim compares registered birthday and uses daily unique constraint',async()=>{
 const store=new EventStore();store.ready=true;
 store.writePool={query:async(sql,args)=>{
   assert.match(sql,/birthday=to_char/);assert.match(sql,/ON CONFLICT.*DO NOTHING/);
   assert.deepEqual(args,['host','u','2026-09-09']);return {rows:[]};
 }};
 assert.equal(await store.claimBirthdayCelebration('host','u','2026-09-09'),false);
});
