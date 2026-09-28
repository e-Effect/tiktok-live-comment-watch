import {createRequire} from 'node:module';import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const require=createRequire('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
try {
 const page=await browser.newPage({viewport:{width:1100,height:820}});
 let person={userId:'fixture',nickname:'確認用リスナー',uniqueId:'fixture',isSuperFan:false,stampMessageEnabled:false,stampMessage:''},saved;
 await page.addInitScript(()=>localStorage.setItem('tiktok-listener-admin-key','fixture-only'));
 await page.route('**/*',async route=>{
  const p=new URL(route.request().url()).pathname;
  if(p.startsWith('/api/')){
   if(route.request().method()==='PATCH'){saved=route.request().postDataJSON();person={...person,...saved};return route.fulfill({json:person});}
   if(p==='/api/listeners/fixture')return route.fulfill({json:{listener:person,stats:[],stamps:[],receiptPrints:[]}});
   if(p==='/api/listeners')return route.fulfill({json:{items:[person],total:1}});
   return route.fulfill({json:{items:[],total:0,ok:true}});
  }
  try {const f=p==='/'?'listener-manager.html':p.slice(1);return route.fulfill({body:await readFile(new URL('../public/'+f,import.meta.url)),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://ledger.test/');
 await page.locator('tr[data-user-id="fixture"] strong').first().click();
 await page.locator('#detailStampMessageEnabled').check();
 await page.locator('#detailStampMessage').fill('{連続回数}回連続！\n応援ありがとう！');
 await page.locator('#detailForm button[type="submit"]').click();
 await page.waitForFunction(()=>document.getElementById('detailSaveStatus')?.textContent==='保存しました');
 assert.equal(saved.stampMessageEnabled,true);assert.equal(saved.isSuperFan,false);assert.match(saved.stampMessage,/応援ありがとう/);
 console.log('PASS ledger select, custom text, save payload; no production writes');
} finally {await browser.close();}
