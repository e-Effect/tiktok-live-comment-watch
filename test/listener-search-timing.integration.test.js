import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import test from 'node:test';

test('search timings stay authenticated, metadata-only and distinguish a cached page', async t => {
  const port=46000+(process.pid%1000), base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server.js'],{
    cwd:new URL('..',import.meta.url),stdio:'ignore',
    env:{...process.env,PORT:String(port),DATABASE_URL:'',LIVE_SOURCE:'collector',
      LISTENER_ADMIN_KEY:'timing-fixture-only',COLLECTOR_INGEST_KEY:'fixture-only'}
  });
  t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}});
  let ready=false;
  for(let i=0;i<60;i++){
    try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready);
  const path='/api/listeners?search=private-fixture-search&sort=last_seen';
  const denied=await fetch(base+path);assert.equal(denied.status,401);
  assert.equal(denied.headers.get('Server-Timing'),null);
  const options={headers:{Authorization:'Bearer timing-fixture-only'}};
  const first=await fetch(base+path,options);assert.equal(first.status,200);
  const body=await first.json();
  assert.deepEqual(Object.keys(body.searchTimings).sort(),['pageMs','savedRankMs']);
  for(const ms of Object.values(body.searchTimings))assert.ok(Number.isFinite(ms)&&ms>=0);
  assert.match(first.headers.get('Server-Timing'),/^ledger-page;dur=\d+, ledger-saved-ranks;dur=\d+$/);
  assert.doesNotMatch(JSON.stringify(body.searchTimings),/private|Bearer|fixture/);
  const cached=await fetch(base+path,options);
  assert.equal(cached.headers.get('Server-Timing'),'ledger-cache;desc="hit"');
  assert.deepEqual(await cached.json(),body);
  const fresh=await fetch(base+path+'&fresh=1',options);
  assert.match(fresh.headers.get('Server-Timing'),/^ledger-page;dur=/);
});
