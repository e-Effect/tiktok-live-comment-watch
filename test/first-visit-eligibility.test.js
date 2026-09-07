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
     emitted,isFirstVisitClaim,randomUUID:()=> 'id',eventStore:{priorListenerHistory:async params=>{
       assert.equal(params.roomId,'current');return {known,priorVisitCount:visits,hasPriorInteraction:interaction,lastPriorVisitAt:123};
     }}
   });
   const comment={userId:'u',text:'初見です',source:'live',at:Date.now()};
   assert.equal(await session.checkFirstVisitClaim(comment),expected);
   assert.equal(emitted.length,expected?1:0);
   if(expected){await session.checkFirstVisitClaim(comment);assert.equal(emitted.length,1);}
 });
}
