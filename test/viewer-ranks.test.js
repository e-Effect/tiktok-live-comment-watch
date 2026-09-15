import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {ViewerRanks} from '../lib/viewer-ranks.js';
test('viewer uses saved ranks without per-comment reads, and follows cache replacements',()=>{
 const store={ready:true,contributionRankCache:new Map([['host',{byUserId:new Map([['u',{contributionRank:'A'}],['n',{contributionRank:'ランクなし'}]])}]]),listenerContributionRankings(){throw Error('unexpected DB read');}};
 const ranks=new ViewerRanks(store,'Host');
 for(let i=0;i<1000;i++)assert.equal(ranks.rank('u'),'A');
 assert.equal(ranks.rank('n'),'');assert.equal(ranks.rank('missing'),'');
 store.contributionRankCache.set('host',{byUserId:new Map([['u',{contributionRank:'S'}]])});
 assert.equal(ranks.rank('u'),'S');assert.equal(new ViewerRanks({...store,ready:false},'other').rank('u'),'');
});
test('cold load is nonblocking, runs once, and explicitly disables aggregation',async()=>{
 let calls=0,done,notified=0;
 const store={ready:true,contributionRankCache:new Map(),listenerContributionRankings(options){calls++;assert.equal(options.waitForRefresh,false);return new Promise(r=>done=r);}};
 const ranks=new ViewerRanks(store,'host',()=>notified++);
 for(let i=0;i<1000;i++)assert.equal(ranks.rank('u'),'');
 assert.equal(calls,1);done();await new Promise(r=>setImmediate(r));
 assert.equal(notified,1);assert.equal(ranks.rank('u'),'');assert.equal(calls,1);
});
test('name badge renders only S-D and hides missing or invalid ranks',()=>{
 const src=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const fn=src.slice(src.indexOf('function renderDecoratedName('),src.indexOf('function renderEventAvatar('));
 const context={escapeHtml:s=>String(s).replaceAll('<','&lt;'),heartMeMark:()=>'',todayFollowMark:()=>''};
 vm.createContext(context);vm.runInContext(fn,context);
 for(const rank of ['S','A','B','C','D'])assert.match(context.renderDecoratedName({nickname:'名前',contributionRank:rank}),new RegExp(`名前<span.*>${rank}</span>`));
 for(const rank of [undefined,'','未計算','ランクなし','<img>'])assert.equal(context.renderDecoratedName({nickname:'名前',contributionRank:rank}),'名前');
});
