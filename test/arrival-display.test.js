import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { AttentionAlerts } from '../lib/attention-alerts.js';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const method = server.slice(server.indexOf('  markSeen(person,'), server.indexOf('  markHeartMe(person,'));

test('arrivals publish before history resolves; reentries publish without another lookup', () => {
  const notices = [], checks = [];
  const session = vm.runInNewContext(`({
    recordingEnabled:true,userStats:new Map(),pendingVisitChecks:new Map(),viewerStats:{knownJoins:0},
    getUserStat(id,name,at){return this.userStats.get(id)||{userId:id,nickname:name,lastSeenAt:at}},
    recordVisit(user){checks.push(user.userId)},enqueueVisitCheck(){},
    broadcastPresence(users){notices.push({...users[0]})},${method}
  })`, { notices, checks, attentionAlerts: new AttentionAlerts(), isAnonymousListenerIdentity: p => !p.userId });
  const person = {userId:'one',nickname:'One'};
  session.markSeen(person,1000,'member',{entryEvent:true});
  assert.equal(notices.length,1);
  assert.equal(notices[0].visitHistoryKnown,false);
  assert.equal(notices[0].visitHistoryStatus,'checking');
  session.markSeen(person,5000,'member',{entryEvent:true});
  assert.equal(notices.length,2);
  assert.equal(notices[1].lastJoinAt,5000);
  assert.equal(checks.length,1);
  session.markSeen(person,2000,'member',{entryEvent:true});
  assert.equal(notices.at(-1).lastJoinAt,5000);
  session.markSeen(person,6000,'like');
  assert.equal(notices.length,3);
  session.markSeen({},7000,'member',{entryEvent:true});
  assert.equal(notices.length,3);
});

test('reentry moves into the visible 200 users on both snapshot and live update', () => {
  const users=Array.from({length:201},(_,i)=>({userId:String(i),hasJoined:true,firstJoinAt:i+1,lastJoinAt:i+1,lastSeenAt:i+1}));
  users[0].lastJoinAt=5000;
  for (const source of [server,app]) {
    const start=source.indexOf('.filter((user) => user.hasJoined)');
    const end=source.indexOf('.slice(0, 200)',start)+'.slice(0, 200)'.length;
    const visible=vm.runInNewContext('users'+source.slice(start,end),{users});
    assert.equal(visible.length,200);
    assert.equal(visible[0].userId,'0');
  }
});
