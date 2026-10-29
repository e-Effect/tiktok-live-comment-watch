import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {isFirstVisitClaim} from '../lib/first-visit-claim.js';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const method=source.slice(source.indexOf('  async checkFirstVisitClaim(comment)'),source.indexOf('  async checkSuperLurker(event)'));
for(const [visits,interaction,known,expected] of [[0,false,true,false],[1,false,true,false],[2,false,true,false],[3,false,true,true],[0,true,true,true],[1,true,true,true],[5,true,false,false]]){
 test(`first-visit eligibility: visits=${visits}, interaction=${interaction}, known=${known}`,async()=>{
   const emitted=[];
   const session=vm.runInNewContext(`({recordingEnabled:true,id:'s',roomId:'current',username:'host',firstVisitClaimPendingIds:new Set(),firstVisitClaimAlertedIds:new Set(),emitNormalized:e=>emitted.push(e),broadcast(){},${method}})`,{
     emitted,isFirstVisitClaim,delay:async()=>{},randomUUID:()=> 'id',eventStore:{priorListenerHistory:async params=>{
       assert.equal(params.roomId,'current');return {known,priorVisitCount:visits,hasPriorInteraction:interaction,lastPriorVisitAt:123};
     }}
   });
   const comment={userId:'u',text:'初見です',source:'live',at:Date.now()};
   assert.equal(await session.checkFirstVisitClaim(comment),expected);
   assert.equal(emitted.length,expected?1:0);
   if(expected){await session.checkFirstVisitClaim(comment);assert.equal(emitted.length,1);}
 });
}

function retrySession(read,wait=async()=>{}) {
  const emitted=[];
  const session=vm.runInNewContext(`({recordingEnabled:true,id:'s',roomId:'current',username:'host',firstVisitClaimPendingIds:new Set(),firstVisitClaimAlertedIds:new Set(),emitNormalized:e=>emitted.push(e),broadcast(){},${method}})`,{
    emitted,isFirstVisitClaim,delay:wait,randomUUID:()=> 'id',eventStore:{priorListenerHistory:read}
  });
  return {session,emitted};
}

test('unknown history is retried and produces one alert after recovery',async()=>{
  let calls=0;
  const {session,emitted}=retrySession(async()=>++calls===1?{known:false}:{known:true,hasPriorInteraction:true,priorVisitCount:4});
  const comment={userId:'u',text:'初見です',source:'live',at:Date.now()};
  assert.equal(await session.checkFirstVisitClaim(comment),true);
  assert.equal(calls,2);assert.equal(emitted.length,1);
  await session.checkFirstVisitClaim(comment);assert.equal(calls,2);
  assert.equal(session.firstVisitClaimPendingIds.size,0);
});

test('persistent unknown history is bounded and never creates a false alert',async()=>{
  let calls=0;
  const {session,emitted}=retrySession(async()=>{calls++;return {known:false};});
  assert.equal(await session.checkFirstVisitClaim({userId:'u',text:'初見です',source:'live'}),false);
  assert.equal(calls,3);assert.equal(emitted.length,0);
  assert.equal(session.firstVisitClaimAlertedIds.size,0);assert.equal(session.firstVisitClaimPendingIds.size,0);
});

test('duplicate comments while lookup is pending share the same alert attempt',async()=>{
  let finish,calls=0;
  const {session,emitted}=retrySession(()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const comment={userId:'u',text:'初見です',source:'live'};
  const pending=session.checkFirstVisitClaim(comment);
  assert.equal(await session.checkFirstVisitClaim(comment),false);
  finish({known:true,hasPriorInteraction:true,priorVisitCount:5});
  assert.equal(await pending,true);assert.equal(calls,1);assert.equal(emitted.length,1);
});

test('stopping a session during lookup prevents a late popup',async()=>{
  let finish;
  const {session,emitted}=retrySession(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=session.checkFirstVisitClaim({userId:'u',text:'初見です',source:'live'});
  session.recordingEnabled=false;
  finish({known:true,hasPriorInteraction:true,priorVisitCount:5});
  assert.equal(await pending,false);assert.equal(emitted.length,0);
  assert.equal(session.firstVisitClaimPendingIds.size,0);
});
