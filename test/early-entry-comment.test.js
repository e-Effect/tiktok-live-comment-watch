import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {entryDetection,earlyEntryComment,matchesEarlyEntryText} from '../lib/early-entry-comment.js';
test('requested phrases and punctuation variants match without negative or quoted claims',()=>{
 for(const text of ['初見です','初見！','はじめまして。','初めまして😊','やりたいです','お願いします！','おねがいします','やってください','私もやりたいです','初見ですお願いします']) assert.equal(matchesEarlyEntryText(text),true,text);
 for(const text of ['初見ではありません','初見詐欺です','お願いしますって言った','やりたくないです','こんにちは','すごい']) assert.equal(matchesEarlyEntryText(text),false,text);
});
test('only a real entry and inclusive 0 to 5 seconds qualify',()=>{
 const entry={at:10000,eventAt:10000,clock:'collector'};
 const comment={at:15000,collectorReceivedAt:15000,text:'お願いします',source:'live'};
 assert.equal(earlyEntryComment(entry,comment),true);
 assert.equal(earlyEntryComment(entry,{...comment,at:10000,collectorReceivedAt:10000}),true);
 assert.equal(earlyEntryComment(entry,{...comment,at:15001,collectorReceivedAt:15001}),false);
 assert.equal(earlyEntryComment(entry,{...comment,at:9999,collectorReceivedAt:9999}),false);
 assert.equal(earlyEntryComment(undefined,comment),false);
 assert.equal(earlyEntryComment({...entry,initial:true},comment),false);
 assert.equal(earlyEntryComment(entry,{...comment,source:'initial'}),false);
 assert.equal(earlyEntryComment(entry,{...comment,text:'すごい'}),false);
});
test('mismatched clocks and delayed batches cannot create false five-second windows',()=>{
 assert.deepEqual(entryDetection({collectorReceivedAt:123}),{at:123,clock:'collector'});
 assert.equal(earlyEntryComment({at:10000,eventAt:10000,clock:'collector'},{at:11000,text:'初見です'},11000),false);
 assert.equal(earlyEntryComment({at:10000,eventAt:1000,clock:'server'},{at:9000,text:'初見です'},11000),false);
});
test('pink applies to matching comment only and overrides first-visit yellow',()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('function commentVisitClass('),source.indexOf('function commentVisitMeta('));
 const ctx={};vm.createContext(ctx);vm.runInContext(fn,ctx);
 assert.equal(ctx.commentVisitClass({earlyEntryHighlight:true,visitHistoryKnown:true,visitCount:1}),'early-entry-comment');
 assert.equal(ctx.commentVisitClass({visitHistoryKnown:true,visitCount:1}),'first-visit-comment');
 assert.equal(ctx.commentVisitClass({visitHistoryKnown:true,visitCount:2}),'');
});
