import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBirthdayComment,validBirthday,birthdayLabel} from '../lib/birthday.js';
import {EventStore} from '../lib/event-store.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('birthday parser accepts explicit self declarations and leap day',()=>{
  for(const value of ['8月12日が誕生日','私の誕生日は８月１２日です！','僕の8月12日が誕生日だよ']) assert.equal(parseBirthdayComment(value),'08-12');
  assert.equal(parseBirthdayComment('誕生日は2月29日'),'02-29');
  assert.equal(birthdayLabel('08-12'),'8月12日');
});
test('birthday parser rejects third parties, ambiguous dates and invalid days',()=>{
  for(const value of ['友達の誕生日は8月12日','8月12日','誕生日は4月31日','誕生日は0月1日','誕生日は13月1日','8月12日が誕生日ではありません','8月12日が誕生日？']) assert.equal(parseBirthdayComment(value),null);
  assert.equal(validBirthday('01-00'),false);
});
test('birthday writes are atomic and manual approval is explicit',async()=>{
  const store=new EventStore();store.ready=true;
  const queries=[];store.pool={query:async(sql,args)=>{queries.push({sql,args});return {rows:[{birthday:'08-12',pendingBirthday:'08-13'}]};}};
  await store.registerBirthday('user-id','08-13');
  assert.deepEqual(queries[0].args,['user-id','08-13',false]);
  assert.match(queries[0].sql,/ELSE listener_birthdays.birthday END/);
  await store.registerBirthday('user-id','08-13',true);
  assert.equal(queries[1].args[2],true);
});
test('comment registration only notifies after a successful save and deduplicates',async()=>{
  const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const method=source.slice(source.indexOf('  async checkBirthday(comment)'),source.indexOf('  async checkFirstVisitClaim(comment)'));
  let writes=0;const notifications=[];
  const session=vm.runInNewContext(`({recordingEnabled:true,emitNormalized:event=>notifications.push(event),${method}})`,{
    parseBirthdayComment,birthdayLabel,notifications,randomUUID:()=>String(Math.random()),isAnonymousListenerIdentity:()=>false,
    eventStore:{registerBirthday:async()=>{writes++;return {birthday:'08-12'};}}
  });
  const comment={userId:'stable-id',nickname:'Example',text:'8月12日が誕生日',source:'live'};
  await session.checkBirthday(comment);await session.checkBirthday(comment);
  assert.equal(writes,1);assert.equal(notifications.length,1);
  assert.equal(notifications[0].type,'birthday_alert');
  assert.match(notifications[0].text,/8月12日/);
  session.recordingEnabled=false;await session.checkBirthday({...comment,text:'8月13日が誕生日'});
  assert.equal(writes,1);
});
