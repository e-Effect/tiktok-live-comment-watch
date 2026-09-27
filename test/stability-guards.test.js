import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {GiftExclusionCache,isExcludedPerformanceGift} from '../lib/gift-exclusion.js';
import {checkSmartphoneRoute} from '../lib/smartphone-check.js';
test('Daisuki enters durable pending queue before emit returns',()=>{
 const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const method=name=>source.slice(source.indexOf(`  ${name}(`),source.indexOf('\n  }',source.indexOf(`  ${name}(`))+4);
 const cache=new GiftExclusionCache();cache.replace(['u']);const queue=[];
 const session=vm.runInNewContext(`({recordingEnabled:true,queueDatabaseEvent:e=>queue.push(e),checkSuperLurker:async()=>{},flushPendingDatabaseEvents:async()=>{},${method('checkGiftExclusion')},${method('emitNormalized')}})`,{
  queue,giftExclusions:cache,isExcludedPerformanceGift,isAnonymousListenerIdentity:()=>false,publishRealtimeIntegrationEvent:()=>{},liveCue:{publish:()=>{}},queueMicrotask:()=>{}
 });
 session.emitNormalized({id:'g',type:'gift',giftId:'14007',userId:'u'});
 assert.equal(queue.length,2);assert.equal(queue[0].payload.slotExcluded,true);
 cache.update('u',false);session.emitNormalized({id:'g2',type:'gift',giftId:'14007',userId:'u'});
 assert.equal(queue.length,3);assert.equal(queue[2].payload.slotExcluded,false);
});
test('diagnosis checks service JSON with bounded fetch and shares repeat checks',async()=>{
 let calls=0;const fetcher=async(_url,options)=>{calls++;assert.ok(options.signal);return Response.json({gifts:[],alerts:[]});};
 assert.equal((await checkSmartphoneRoute(fetcher,100000)).reachable,true);
 await checkSmartphoneRoute(fetcher,100001);assert.equal(calls,1);
 assert.equal((await checkSmartphoneRoute(async()=>{throw Error('offline');},120000)).reachable,false);
});
