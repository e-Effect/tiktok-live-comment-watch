import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import vm from 'node:vm';

test('authenticated ledger displays the shared 27 records and saves switches through the same API',async t=>{
  const html=await readFile(new URL('../public/listener-manager.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://ledger.test/listener-manager.html',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  dom.window.localStorage.setItem('tiktok-listener-admin-key','fixture-only');
  const items=Array.from({length:27},(_,i)=>({tiktok_id:'fixture_user_'+i,history:i<8?'found':'none',source:'photo '+(i%3+1),enabled:i>=8}));
  const calls=[];
  dom.window.fetch=async(url,options={})=>{
    calls.push({url,options});
    let data={};
    if(url.startsWith('/api/screenshot-records?')) {
      if(options.method==='PATCH'){const body=JSON.parse(options.body);items.find(r=>r.tiktok_id===body.id).enabled=body.enabled;}
      data={items:structuredClone(items)};
    }else if(url.startsWith('/api/listeners/ranking'))data={state:'idle',generatedAt:0};
    else if(url.startsWith('/api/listeners?'))data={items:[],total:0};
    return {ok:true,json:async()=>data};
  };
  const files=['ranking-status.js','listener-count-status.js','screenshot-records-panel.js','listener-manager.js'];
  const script=(await Promise.all(files.map(file=>readFile(new URL('../public/'+file,import.meta.url),'utf8'))))
    .map(source=>source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')).join('\n');
  vm.runInContext(script,dom.getInternalVMContext());
  await new Promise(resolve=>setTimeout(resolve,30));
  const doc=dom.window.document;
  assert.equal(doc.querySelector('#app').hidden,false);
  assert.equal(doc.querySelectorAll('#screenshotRecordsList li').length,27);
  assert.match(doc.querySelector('#screenshotStatus').textContent,/27件.*19件/);
  assert.equal(doc.querySelector('a[href="#screenshotRecordsPanel"]').textContent,'スクショ記録ID');
  const scopeCall=calls.find(r=>r.url.startsWith('/api/screenshot-records?'));
  assert.match(scopeCall.url,/username=mentalist_k/);
  const toggle=doc.querySelector('input[aria-label="@fixture_user_8の来訪を強調"]');
  toggle.checked=false;toggle.dispatchEvent(new dom.window.Event('change'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(items[8].enabled,false);
  assert.match(doc.querySelector('#screenshotStatus').textContent,/18件/);
  doc.querySelector('#screenshotSearch').value='fixture_user_26';
  doc.querySelector('#screenshotSearch').dispatchEvent(new dom.window.Event('input'));
  assert.equal(doc.querySelectorAll('#screenshotRecordsList li').length,1);
  doc.querySelector('#logout').click();
  assert.equal(dom.window.localStorage.getItem('tiktok-listener-admin-key'),null);
  assert.equal(doc.querySelectorAll('#screenshotRecordsList li').length,0);
});
