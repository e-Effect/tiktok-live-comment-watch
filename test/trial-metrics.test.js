import test from 'node:test';
import assert from 'node:assert/strict';
import {readTrialMetrics,trialOptions} from '../lib/trial-metrics.js';
test('trial export validates scope and fixed 90 day window',()=>{
 const at=Date.now(),o=trialOptions({ids:'123,456,123',username:'Host_name',at});
 assert.deepEqual(o.userIds,['123','456']);assert.equal(o.to-o.from,90*86400000);
 for(const ids of ['', 'bad', Array.from({length:11},(_,i)=>String(i)).join(',')]) assert.throws(()=>trialOptions({ids,username:'host',at}));
 assert.throws(()=>trialOptions({ids:'123',username:'',at}));
 assert.throws(()=>trialOptions({ids:'123',username:'host',at:'no'}));
});
test('trial export only reads bounded user data and excludes unit value <=10',async()=>{
 const calls=[];
 const rows=[[{user_id:'123',comments:'12',coins:'20',all_coins:'35',likes:'9'}],[{user_id:'123',visits:'2'}],[{user_id:'123',latest_nickname:'test',is_super_fan:true}]];
 const result=await readTrialMetrics({async query(sql,args){calls.push({sql,args});return {rows:rows.shift()};}},trialOptions({ids:'123',username:'host',at:Date.now()}));
 assert.equal(result.items[0].coins,20);assert.equal(result.items[0].allCoins,35);assert.equal(result.items[0].visits,2);
 assert.match(calls[0].sql,/diamonds::numeric\/item_count>10/);
 assert.match(calls[0].sql,/event_at >= \$3 AND event_at <= \$4/);
 for(const {sql,args} of calls){assert.match(sql,/ANY\(\$1::text\[\]\)/);assert.deepEqual(args[0],['123']);assert.doesNotMatch(sql,/\b(UPDATE|DELETE|INSERT)\b/);}
 assert.match(calls[1].sql,/COUNT\(DISTINCT COALESCE/);
});
