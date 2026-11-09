import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {formatObservedWatchTime} from '../public/listener-history-format.js';

test('ranked observation durations show approximate minutes and seconds, including numeric SQL strings',()=>{
  for(const [duration,label]of [[5000,'5秒'],[125000,'2分5秒'],['765000','12分45秒'],[3600000,'1時間'],[3661000,'1時間1分1秒']]){
    assert.equal(formatObservedWatchTime(duration),'推定視聴 約'+label);
  }
});
test('absent or invalid observation is unmeasured rather than zero minutes or an invented duration',()=>{
  for(const value of [null,undefined,0,'0','',-100,NaN,Infinity,'invalid'])assert.equal(formatObservedWatchTime(value),'視聴時間 未計測');
});
test('ledger keeps broadcast identity and entry evidence with an explicit watch duration or unmeasured state',()=>{
  const source=readFileSync(new URL('../public/listener-manager.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function visitBroadcastRows('),source.indexOf('function listenerHistoryUrl('));
  const context=vm.createContext({formatObservedWatchTime,formatHistoryDate:String,
    escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')});
  vm.runInContext(code,context);
  const html=context.visitBroadcastRows({broadcasts:[
    {streamUsername:'host',roomId:'live-one',enteredAt:'2026-11-09T16:00:00Z',observedStayMs:765000,sources:['member']},
    {streamUsername:'<unsafe>',roomId:'live-two',firstSeenAt:'2026-11-10T00:00:00Z',observedStayMs:null,sources:['roomUser']},
  ]});
  assert.match(html,/live-one.*入室通知/);assert.match(html,/推定視聴 約12分45秒/);
  assert.match(html,/live-two.*初回検知/);assert.match(html,/視聴時間 未計測/);
  assert.match(html,/is-unmeasured/);assert.ok(!html.includes('<unsafe>'));assert.ok(!html.includes('0分'));
});
