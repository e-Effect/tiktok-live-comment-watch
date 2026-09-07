import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {EventStore} from '../lib/event-store.js';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const methods=source.slice(source.indexOf('  enqueueVisitCheck('),source.indexOf('  async runVisitCheck('));
test('a burst is bounded to 25, entry-only users do not starve and failures stay pending',async()=>{
  let fail=true;const batches=[];
  const pending=new Map(Array.from({length:100},(_,i)=>[String(i),{running:false,visit:{userId:String(i)}}]));
  const session=vm.runInNewContext(`new (class {constructor(){this.pendingVisitChecks=pending;this.visitCheckQueues={critical:[],background:[]};this.visitCheckQueuedIds=new Set();this.visitCheckWorkerPromise=null;}
    async runVisitCheck(id){this.pendingVisitChecks.delete(id)} ${methods}})()`,{pending,eventStore:{recordVisitBatch:async(_,visits)=>{
      batches.push(visits.map(v=>v.userId));return fail?new Map():new Map(visits.map(v=>[v.userId,{visitHistoryKnown:true}]));
    }}});
  for(const id of pending.keys())session.enqueueVisitCheck(id,Number(id)%2===0);
  await session.visitCheckWorkerPromise;assert.equal(pending.size,100);
  assert.ok(batches.every(b=>b.length<=25));assert.ok([...pending.values()].every(v=>!v.running));
  fail=false;
  for(const id of pending.keys())session.enqueueVisitCheck(id,Number(id)%2===0);
  await session.visitCheckWorkerPromise;assert.equal(pending.size,0);
  assert.ok(batches.some(b=>b.length===25&&b.some(id=>Number(id)%2===1)));
});
test('visit batch uses its dedicated pool; failed judgment never reports first-time',async()=>{
 const store=new EventStore();store.ready=true;
 store.pool={query:()=>{throw new Error('general pool must not be used')}};
 store.visitPool={query:async()=>{throw Object.assign(new Error('statement timeout'),{code:'57014'})}};
 const result=await store.recordVisitBatch({id:'s',username:'host'},[{userId:'u',at:1}]);
 assert.equal(result.size,0);assert.equal(store.visitBatchStats.failures,1);
});
test('a timed-out event write stays unsuccessful for durable-inbox retry',async()=>{
 const store=new EventStore();store.ready=true;
 store.pool={query:()=>{throw new Error('must use writer')}};
 store.writePool={query:async()=>{throw Object.assign(new Error('statement timeout'),{code:'57014'})}};
 assert.equal(await store.recordEvent({id:'s',username:'host'},{id:'e',type:'comment',userId:'123456',text:'hello'}),false);
 assert.equal(store.eventWriteStats.lastFailurePhase,'write');
});
