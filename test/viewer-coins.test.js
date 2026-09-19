import test from 'node:test';
import assert from 'node:assert/strict';
import {ViewerCoins} from '../lib/viewer-coins.js';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
test('display reads batch ten users, include all coins and reuse cached totals',async()=>{
 let calls=0,notified=[];
 const coins=new ViewerCoins({ready:true,pool:{async query(sql,args){
  calls++;assert.match(sql,/INTERVAL '30 days'/);assert.match(sql,/SUM\(diamonds\)/);assert.doesNotMatch(sql,/item_count/);assert.equal(args[0].length,10);assert.equal(args[1],'host');
  return {rows:[{user_id:'0',coins:'101'}]};
 }}},'host',ids=>notified=ids);
 for(let i=0;i<10;i++)assert.equal(coins.get(String(i)),null);
 clearTimeout(coins.timer);coins.timer=null;await coins.flush();
 for(let i=0;i<1000;i++)assert.equal(coins.get('0'),101);
 assert.equal(coins.get('1'),0);assert.equal(calls,1);assert.equal(notified.length,10);coins.close();
});
test('failed query remains unknown and backs off',async()=>{
 let calls=0;const coins=new ViewerCoins({ready:true,pool:{async query(){calls++;throw Error('offline');}}},'host');
 coins.get('a');clearTimeout(coins.timer);coins.timer=null;await coins.flush();
 for(let i=0;i<100;i++)assert.equal(coins.get('a'),null);
 assert.equal(calls,1);assert.equal(coins.pending.size,0);coins.close();
});
test('coins appear after name and badge, zero is distinct from unknown',()=>{
 const src=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const fn=src.slice(src.indexOf('function renderDecoratedName('),src.indexOf('function renderEventAvatar('));
 const ctx={escapeHtml:String,heartMeMark:()=>'',todayFollowMark:()=>'',formatNumber:n=>n.toLocaleString('en-US')};vm.createContext(ctx);vm.runInContext(fn,ctx);
 assert.match(ctx.renderDecoratedName({nickname:'名前',coins30d:1234}),/名前.*30日：1,234コイン/);
 assert.match(ctx.renderDecoratedName({nickname:'名前',coins30d:0}),/30日：0コイン/);
 assert.equal(ctx.renderDecoratedName({nickname:'名前',coins30d:null}),'名前');
});
