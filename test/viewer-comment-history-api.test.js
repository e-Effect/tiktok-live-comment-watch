import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('  const listenerHistoryMatch =');
const end=source.indexOf('  const listenerMatch =',start);
assert.ok(start>=0 && end>start);

function fixture({authorized=true,visitsFail=false}={}) {
 const calls=[],responses=[];
 const handler=vm.runInNewContext(`(async (request,response,url)=>{${source.slice(start,end)}})`,{
  requireListenerAdmin:()=>authorized,
  normalizeTikTokUsername:value=>value,
  shortError:error=>error.message,
  sendJson:(_response,status,body)=>responses.push({status,body}),
  eventStore:{
   async listenerHistory(id,options) {
    calls.push({id,...options});
    return {items:Array.from({length:options.limit},(_,i)=>({at:100-i,text:`comment ${i+1}`})),total:40};
   },
   async recentListenerVisits(id,username) {
    calls.push({visits:true,id,username});
    if(visitsFail)throw Error('fixture visits unavailable');
    return [{firstSeenAt:'2026-11-14T00:00:00Z',observedStayMs:120000}];
   }
  }
 });
 return {calls,responses,request:query=>handler({method:'GET'},{},new URL('https://example.test/api/listeners/user%2Fone/history?'+query))};
}

test('viewer history API returns thirty comments plus recent visits and keeps its bounded query',async()=>{
 const f=fixture();
 await f.request('username=host&kind=comments&includeVisits=1&limit=500&offset=100');
 assert.deepEqual(f.calls[0],{id:'user/one',username:'host',kind:'comments',limit:30,offset:0});
 assert.equal(f.responses[0].status,200);
 assert.equal(f.responses[0].body.items.length,30);
 assert.equal(f.responses[0].body.items[29].text,'comment 30');
 assert.equal(f.responses[0].body.recentVisits[0].observedStayMs,120000);
});

test('viewer history API keeps thirty comments when optional visits fail',async()=>{
 const f=fixture({visitsFail:true});
 await f.request('username=host&kind=comments&includeVisits=1&limit=30');
 assert.equal(f.responses[0].status,200);
 assert.equal(f.responses[0].body.items.length,30);
 assert.equal(f.responses[0].body.recentVisits,null);
});

test('viewer history API still requires management authorization before any query',async()=>{
 const f=fixture({authorized:false});
 await f.request('kind=comments&includeVisits=1&limit=30');
 assert.equal(f.calls.length,0);
 assert.equal(f.responses.length,0);
});

test('ledger pagination and visit-history limits are unchanged',async()=>{
 for(const kind of ['comments','visits']) {
  const f=fixture();
  await f.request(`username=host&kind=${kind}&limit=200&offset=400`);
  assert.deepEqual(f.calls[0],{id:'user/one',username:'host',kind,limit:200,offset:400});
  assert.equal(f.calls.length,1);
  assert.equal(f.responses[0].body.items.length,200);
 }
});
