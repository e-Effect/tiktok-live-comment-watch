import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {JSDOM} from 'jsdom';

const html = await readFile(new URL('../public/listener-manager.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/listener-manager.js', import.meta.url), 'utf8');
const reply = data => ({ok:true, json:async()=>data});
const detail = id => ({listener:{userId:id,uniqueId:'handle_'+id,nickname:'Person '+id,notes:'Notes of '+id},stats:[]});
const isDetailA = path => new URL(path,'https://ledger.test').pathname === '/api/listeners/A';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function fixture(t, handler) {
  const dom = new JSDOM(html,{url:'https://ledger.test/listener-manager.html',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const w = dom.window;
  w.setupRankingStatus = () => ({refresh(){},cancel(){}});
  w.setupListenerCount = () => ({start(){},cancel(){}});
  w.setupScreenshotRecords = () => ({setScope(){},cancel(){}});
  w.formatObservedWatchTime = () => '-';
  const writes=[];
  w.fetch = async (path,options={}) => {
    if (options.method && options.method !== 'GET') {
      writes.push({path,method:options.method,body:JSON.parse(options.body)});
      return {ok:false};
    }
    const response = handler?.(path,options);
    if (response) return response;
    const url = new URL(path,'https://ledger.test');
    const match = url.pathname.match(/^\/api\/listeners\/([AB])(?:\/(.*))?$/);
    if (match) return reply(match[2] ? {items:[],total:0} : detail(match[1]));
    throw new Error('Unexpected fixture request: '+path);
  };
  w.eval(source.replace(/^import .*;\r?\n/gm,'')+'\nglobalThis.audit={state,el,openDetail,closeDetail,saveDetail,loadMoreHistory,refreshListeners,markSearchPending,logout};');
  const api=w.audit;api.state.key='fixture-only-not-a-real-key';api.el.app.hidden=false;
  return {...api,w,writes};
}

test('late detail cannot replace a newer person or save their fields to another ID', async t => {
  const delayed=deferred();
  const f=fixture(t,path=>isDetailA(path)?delayed.promise:null);
  const first=f.openDetail('A');f.closeDetail();
  await f.openDetail('B');
  const formB=f.w.document.getElementById('detailForm');
  delayed.resolve(reply(detail('A')));await first;
  assert.equal(f.state.detailData.listener.userId,'B');
  assert.equal(f.el.detailContent.querySelector('h2').textContent,'Person B');
  await f.saveDetail({preventDefault(){},currentTarget:formB});
  assert.equal(f.writes.length,1);
  assert.equal(f.writes[0].path,'/api/listeners/B');
  assert.equal(f.writes[0].body.notes,'Notes of B');
});

test('a closed or mismatched detail form cannot save', async t => {
  const f=fixture(t);
  await f.openDetail('A');const oldForm=f.w.document.getElementById('detailForm');
  f.closeDetail();await f.openDetail('B');
  await f.saveDetail({preventDefault(){},currentTarget:oldForm});
  const form=f.w.document.getElementById('detailForm');form.dataset.userId='A';
  await f.saveDetail({preventDefault(){},currentTarget:form});
  f.closeDetail();await f.saveDetail({preventDefault(){},currentTarget:form});
  assert.equal(f.writes.length,0);
});

test('late detail errors and mismatched API identities cannot expose an editable wrong profile', async t => {
  const delayed=deferred();
  const f=fixture(t,path=>isDetailA(path)?delayed.promise:null);
  const first=f.openDetail('A');f.closeDetail();await f.openDetail('B');
  delayed.reject(new Error('stale failure'));await first;
  assert.equal(f.el.detailContent.querySelector('h2').textContent,'Person B');
  f.closeDetail();
  const other=fixture(t,path=>isDetailA(path)?reply(detail('B')):null);
  await other.openDetail('A');
  assert.match(other.el.detailContent.textContent,/一致しません/);
  assert.equal(other.w.document.getElementById('detailForm'),null);
});

test('late history pages cannot append one person comments to another profile', async t => {
  const delayed=deferred();
  const f=fixture(t,path=>{
    const url=new URL(path,'https://ledger.test');
    if(url.pathname==='/api/listeners/A/history' && url.searchParams.get('kind')==='comments') {
      return url.searchParams.get('offset')==='0'
        ? reply({items:[{text:'A first'}],total:2}) : delayed.promise;
    }
  });
  await f.openDetail('A');const more=f.loadMoreHistory('comments');
  f.closeDetail();await f.openDetail('B');
  delayed.resolve(reply({items:[{text:'A stale'}],total:2}));await more;
  assert.equal(f.state.detailData.listener.userId,'B');
  assert.doesNotMatch(f.el.detailContent.textContent,/A stale/);
});

test('stale search bodies cannot overwrite a newer search even if fetch ignores abort', async t => {
  const delayed=deferred();
  const f=fixture(t,path=>{
    const query=new URL(path,'https://ledger.test').searchParams.get('search');
    if(query==='old')return {ok:true,json:()=>delayed.promise};
    if(query==='new')return reply({items:[{...detail('B').listener}],total:1});
  });
  f.el.search.value='old';const first=f.refreshListeners();
  await Promise.resolve();
  f.el.search.value='new';f.markSearchPending();await f.refreshListeners();
  delayed.resolve({items:[{...detail('A').listener}],total:1});await first;
  assert.equal(f.state.items[0].userId,'B');
  assert.equal(f.state.lastListenerSearch,'new');
  assert.match(f.el.listenerRows.textContent,/Person B/);
  assert.doesNotMatch(f.el.listenerRows.textContent,/Person A/);
});

test('late search errors do not overwrite a newer result', async t => {
  const delayed=deferred();
  const f=fixture(t,path=>new URL(path,'https://ledger.test').searchParams.get('search')==='old'
    ? delayed.promise : reply({items:[],total:0}));
  f.el.search.value='old';const first=f.refreshListeners();
  f.el.search.value='new';await f.refreshListeners();
  const status=f.el.resultCount.textContent;
  delayed.reject(new Error('stale failure'));await first;
  assert.equal(f.el.resultCount.textContent,status);
  assert.doesNotMatch(f.el.connectionStatus.textContent,/stale failure/);
});

test('logout invalidates pending detail and search responses', async t => {
  const search=deferred(), profile=deferred();
  const f=fixture(t,path=>path.startsWith('/api/listeners?')?search.promise
    :isDetailA(path)?profile.promise:null);
  const searching=f.refreshListeners();const opening=f.openDetail('A');f.logout();
  search.resolve(reply({items:[detail('A').listener],total:1}));profile.resolve(reply(detail('A')));
  await Promise.all([searching,opening]);
  assert.equal(f.state.items.length,0);assert.equal(f.state.detailData,null);
  assert.equal(f.el.app.hidden,true);assert.equal(f.el.detailPanel.classList.contains('open'),false);
});
