import test from 'node:test';
import assert from 'node:assert/strict';
import {buildContributionRankings,contributionTier,noContributionRank,RANK_POLICY} from '../lib/contribution-rank-v2.js';
test('90 day thresholds are inclusive and both required',()=>{
 const r=buildContributionRankings([
  {user_id:'edge',recent_comments:10,recent_coins:100},
  {user_id:'nine',recent_comments:9,recent_coins:9999},
  {user_id:'99coins',recent_comments:999,recent_coins:99},
  {user_id:'old',comments:9999,coins:9999,recent_comments:0,recent_coins:0},
  {user_id:'manager',recent_comments:142,recent_coins:0,recent_visits:43}
 ]);
 assert.deepEqual(r.lifetimeOrder,['edge']);assert.equal(r.byUserId.get('edge').contributionTotal,1);
 for(const id of ['nine','99coins','old','manager'])assert.equal(r.byUserId.get(id).contributionRank,'ランクなし');
 assert.equal(noContributionRank(false).contributionRank,'未計算');
});
test('volume score is linear, no unconfirmed penalties or superfan bonus',()=>{
 const r=buildContributionRankings([{user_id:'large',coins:1000,comments:100,likes:100,visits:10},{user_id:'small',coins:100,comments:10,likes:10,visits:1,is_super_fan:true}]);
 assert.equal(r.byUserId.get('large').contributionScore,100);
 assert.equal(r.byUserId.get('small').contributionScore,9.1);
 assert.deepEqual(r.byUserId.get('large').contributionParts,{gift:60,comment:20,like:5,visit:5,participation:10});
 assert.equal(r.byUserId.get('small').contributionParts.gift,6);
 assert.equal(r.byUserId.get('large').rankPolicy,RANK_POLICY);
 assert.equal(RANK_POLICY,'90d-comments10-coins100-gift60-v3');
});

test('gift sixty weights preserve linear normalization and all five component caps',()=>{
 const r=buildContributionRankings([
  {user_id:'donor',recent_coins:1000,recent_comments:10,recent_likes:0,recent_visits:1},
  {user_id:'commenter',recent_coins:100,recent_comments:1000,recent_likes:0,recent_visits:1},
 ]);
 assert.equal(r.byUserId.get('donor').contributionScore,70.2);
 assert.equal(r.byUserId.get('commenter').contributionScore,34.5);
 assert.deepEqual(r.recentOrder,['donor','commenter']);
 const caps={gift:60,comment:20,like:5,visit:5,participation:10};
 for(const row of r.byUserId.values())for(const [key,value]of Object.entries(row.contributionParts)){
  assert.ok(value>=0 && value<=caps[key]);
 }
 assert.equal(noContributionRank(true).rankPolicy,RANK_POLICY);
});
test('rank population excludes all ineligible users and tie order is deterministic',()=>{
 const rows=[{user_id:'b',comments:10,coins:100},{user_id:'a',comments:10,coins:100},...Array.from({length:1000},(_,i)=>({user_id:`no${i}`,comments:9,coins:100}))];
 const r=buildContributionRankings(rows);assert.deepEqual(r.lifetimeOrder,['a','b']);assert.equal(r.byUserId.get('a').contributionTotal,2);
 assert.equal(contributionTier(5,1000),'S');assert.equal(contributionTier(6,1000),'A');assert.equal(contributionTier(101,1000),'D');
});
