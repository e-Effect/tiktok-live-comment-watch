import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore} from '../lib/event-store.js';
import {setupListenerCount} from '../public/listener-count-status.js';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('counts run serially, share filters across sorts, and invalidate after profile edits',async () => {
  const store=new EventStore(); store.ready=true;
  let resolve, calls=0;
  store.pool={query(){calls++;return new Promise(r=>{resolve=r;});}};
  assert.equal(store.listenerPageCount({sort:'coins'}).pending,true);
  store.listenerPageCount({sort:'comments'});
  store.listenerPageCount({username:'host'});
  assert.equal(calls,1);
  resolve({rows:[{total:'42'}]}); await flush();
  assert.equal(store.listenerPageCount({sort:'comments'}).total,42);
  store.invalidateListenerPageCounts();
  store.listenerPageCount({sort:'coins'});
  assert.equal(calls,2);
  store.invalidateListenerPageCounts();
  resolve({rows:[{total:'43'}]}); await flush();
  assert.equal(store.listenerPageCounts.size,0,'late count must not undo invalidation');
});

test('count failure is not zero matches and is not retried on every poll',async () => {
  const store=new EventStore(); store.ready=true;let calls=0;
  store.pool={async query(){calls++;throw new Error('timeout');}};
  store.listenerPageCount({});await flush();
  assert.deepEqual(store.listenerPageCount({}),{total:null,pending:false,error:true});
  assert.equal(calls,1);
});

test('count polling updates only counts and cancels stale filter results',async () => {
  const requests=[], results=[], scheduled=[];
  const api=(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}));
  const counter=setupListenerCount({api,schedule:fn=>scheduled.push(fn),unschedule:()=>{}});
  counter.start('sort=coins',r=>results.push(r));
  requests[0].resolve({ok:true,json:async()=>({pending:true})});await flush();
  assert.equal(scheduled.length,1);
  counter.start('sort=comments',r=>results.push(r));
  await scheduled[0]();
  assert.equal(requests.length,2,'cancelled timer cannot request another count');
  requests[1].resolve({ok:true,json:async()=>({pending:false,total:25})});await flush();
  assert.deepEqual(results,[{pending:false,total:25}]);
  assert.ok(requests.every(r=>r.url.startsWith('/api/listeners/count?')));
  assert.equal(requests[0].options.signal.aborted,true);
  counter.cancel();
});
