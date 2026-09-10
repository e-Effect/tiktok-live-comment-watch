import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarWorkCache } from '../lib/avatar-work-cache.js';
test('avatar positive/negative TTLs avoid repeated DB work and allow retry', async () => {
  let time=0, calls=0;
  const run=createAvatarWorkCache({now:()=>time,successTtl:100,failureTtl:10});
  const yes=()=>{calls++;return true;};
  await run('u',yes);await run('u',yes);assert.equal(calls,1);
  time=101;await run('u',yes);assert.equal(calls,2);
  const no=()=>{calls++;throw Error('offline');};
  await run('v',no);await run('v',no);assert.equal(calls,3);
  time=112;await run('v',yes);assert.equal(calls,4);
});
test('avatar work caps concurrency, deduplicates inflight work and bounds cache',async()=>{
  const run=createAvatarWorkCache({maxConcurrent:2,maxEntries:2});
  let release;const gate=new Promise(r=>release=r);let calls=0;
  const work=async()=>{calls++;await gate;return true;};
  const a=run('a',work),b=run('b',work);
  await run('a',work);await run('c',work);assert.equal(calls,2);
  release();await Promise.all([a,b]);
  await run('c',()=>true);
  await run('a',()=>{calls++;return true;});assert.equal(calls,3);
});
