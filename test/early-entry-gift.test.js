import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {withinEntryWindow} from '../lib/early-entry-comment.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const ctx={};vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function commentVisitClass('),source.indexOf('function commentVisitMeta(')),ctx);
vm.runInContext(source.slice(source.indexOf('function refreshEventDisplayState('),source.indexOf('function refreshVisibleCommentRows(')),ctx);
test('all gifts qualify on timing, inclusive five seconds, but no entry or replay does not',()=>{
 const entry={at:10000,eventAt:10000,clock:'collector'};
 for(const diamondCount of [0,1,10,10000])assert.equal(withinEntryWindow(entry,{at:15000,collectorReceivedAt:15000,diamondCount}),true);
 assert.equal(withinEntryWindow(entry,{at:15001,collectorReceivedAt:15001}),false);
 assert.equal(withinEntryWindow(undefined,{at:11000,collectorReceivedAt:11000}),false);
 assert.equal(withinEntryWindow(entry,{at:9000,collectorReceivedAt:9000}),false);
 assert.equal(withinEntryWindow(entry,{at:11000,collectorReceivedAt:11000,source:'initial'}),false);
});
test('gift waits for confirmed first record and can be corrected to returning',()=>{
 const gift={userId:'one',earlyEntryGiftCandidate:true,visitHistoryKnown:false};
 assert.equal(ctx.commentVisitClass(gift),'');
 const first=ctx.refreshEventDisplayState([gift],new Map([['one',{visitHistoryKnown:true,visitCount:1}]]))[0];
 assert.equal(first.earlyEntryGiftCandidate,true);
 assert.equal(ctx.commentVisitClass(first),'early-entry-comment');
 const corrected=ctx.refreshEventDisplayState([first],new Map([['one',{visitHistoryKnown:true,visitCount:2}]]))[0];
 assert.equal(ctx.commentVisitClass(corrected),'');
 assert.equal(ctx.commentVisitClass({visitHistoryKnown:true,visitCount:1,earlyEntryGiftCandidate:false}),'first-visit-comment');
 // Existing comment rule is unchanged and is not restricted to first-time users.
 assert.equal(ctx.commentVisitClass({earlyEntryHighlight:true,visitHistoryKnown:true,visitCount:2}),'early-entry-comment');
});
