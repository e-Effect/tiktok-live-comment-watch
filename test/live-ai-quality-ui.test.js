import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/live-ai-assist.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const pref = 'tiktok-live-ai-quality-v2';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, fetchImpl, mode) {
  const dom = new JSDOM(html, { url: 'https://viewer.test/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.fetch = fetchImpl;
  dom.window.localStorage.setItem('tiktok-listener-admin-key', 'fixture-admin');
  if (mode) dom.window.localStorage.setItem(pref, mode);
  vm.runInContext(source + '\nglobalThis.qualityUi=setupLiveAiAssist({root:document.querySelector(\'[data-panel="aiAssist"]\')});', dom.getInternalVMContext());
  return { dom, ui: dom.window.qualityUi, doc: dom.window.document, storage: dom.window.localStorage };
}
function choose({ dom, doc }, mode) {
  const radio = doc.querySelector(`[name="aiQuality"][value="${mode}"]`);
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}
const reply = (mode = 'fast') => ({ ok: true, status: 200, json: async () => ({ configured: true, enabled: true, mode, version: 1, items: [], dailyCalls: 0, dailyLimit: 600 }) });

test('ready signal coalesces during initial configuration and immediately fetches privately', async t => {
  const calls = [], jobs = new Map();
  const fx = fixture(t, (url, opts) => new Promise(resolve => calls.push({url, opts, resolve})));
  Object.defineProperty(fx.doc, 'hidden', {value:false});
  let seq = 0;
  fx.dom.window.setTimeout = (fn, delay) => { jobs.set(++seq,{fn,delay}); return seq; };
  fx.dom.window.clearTimeout = id => jobs.delete(id);
  fx.ui.setSession({id:'s',status:'connected'});
  fx.ui.notifyReady('s'); fx.ui.notifyReady('s');
  assert.equal(calls.length,1);
  calls[0].resolve(reply()); await tick();
  assert.deepEqual([...jobs.values()].map(j=>j.delay),[0]);
  const [id,job] = [...jobs][0];jobs.delete(id);job.fn();
  assert.equal(calls[1].opts.method,'GET');
  assert.equal(calls[1].opts.headers.Authorization,'Bearer fixture-admin');
  assert.match(calls[1].url,/version=1/);
  calls[1].resolve(reply()); await tick();
  fx.ui.notifyReady('unrelated');
  assert.deepEqual([...jobs.values()].map(j=>j.delay),[2500]);
});

test('all five radio buttons apply the requested profile and persist it', async t => {
  const posted = [];
  const fx = fixture(t, async (_, options) => {
    const { mode } = JSON.parse(options.body);
    posted.push(mode);
    return reply(mode);
  });
  const modes = ['fast', 'light', 'thoughtful', 'balanced', 'smart'];
  assert.deepEqual([...fx.doc.querySelectorAll('[name="aiQuality"]')].map(r => r.value), modes);
  fx.ui.setSession({ id: 's', status: 'connected' });
  await tick();
  for (const mode of modes.slice(1)) {
    choose(fx, mode);
    await tick();
    assert.equal(fx.storage.getItem(pref), mode);
  }
  assert.deepEqual(posted, modes);
});

test('settings keeps the selected mode without an active stream and applies it after reopening', async t => {
  let requests = 0;
  const first = fixture(t, async () => { requests++; return reply(); });
  assert.equal(first.doc.querySelector('[name="aiQuality"]:checked').value, 'fast');
  choose(first, 'smart');
  await tick();
  assert.equal(first.storage.getItem(pref), 'smart');
  assert.equal(requests, 0, 'saving an inactive preference makes no paid request');
  let body;
  const reopened = fixture(t, async (_, options) => { body = JSON.parse(options.body); return reply(body.mode); }, first.storage.getItem(pref));
  reopened.ui.setSession({ id: 's', status: 'connected' });
  await tick();
  assert.equal(body.mode, 'smart');
  assert.equal(reopened.doc.querySelector('[name="aiQuality"]:checked').value, 'smart');
  assert.match(reopened.doc.querySelector('#aiAssistStatus').textContent, /Terra熟考/);
});

test('an older mode response cannot overwrite a newer choice', async t => {
  const finish = [];
  const fx = fixture(t, () => new Promise(resolve => finish.push(resolve)));
  fx.ui.setSession({ id: 's', status: 'connected' });
  choose(fx, 'smart');
  assert.equal(finish.length, 2);
  finish[1](reply('smart'));
  await tick();
  finish[0](reply('fast'));
  await tick();
  assert.equal(fx.storage.getItem(pref), 'smart');
  assert.equal(fx.doc.querySelector('[name="aiQuality"]:checked').value, 'smart');
  assert.match(fx.doc.querySelector('#aiAssistStatus').textContent, /Terra熟考/);
});

test('ended-stream metadata does not erase the quality preference for the next stream', async t => {
  const fx = fixture(t, async () => reply('fast'), 'balanced');
  fx.ui.setSession({ id: 'old', status: 'ended', stoppedAt: Date.now() });
  await tick();
  assert.equal(fx.storage.getItem(pref), 'balanced');
  assert.equal(fx.doc.querySelector('[name="aiQuality"]:checked').value, 'balanced');
  assert.equal(fx.doc.querySelector('#aiQualityStatus').textContent, '次の配信に適用');
});

test('unknown saved values safely default to fast and authentication failure does not claim applied', async t => {
  const fx = fixture(t, async () => ({ ok: false, status: 401 }), '__proto__');
  assert.equal(fx.doc.querySelector('[name="aiQuality"]:checked').value, 'fast');
  fx.ui.setSession({ id: 's', status: 'connected' });
  await tick();
  assert.equal(fx.doc.querySelector('#aiQualityStatus').textContent, '管理キーで接続');
});

test('fresh server state restores saved quality but an explicit OFF is not undone', async t => {
  const requests = [];
  let next = null;
  const fx = fixture(t, async (url, options) => {
    requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (next) { const result = next; next = null; return result; }
    return reply('smart');
  }, 'smart');
  const polls = [];
  const originalTimeout = fx.dom.window.setTimeout.bind(fx.dom.window);
  fx.dom.window.setTimeout = (callback, delay, ...args) => [2500, 15000].includes(delay) ? (polls.push(callback), 987654) : originalTimeout(callback, delay, ...args);
  fx.ui.setSession({ id: 's', status: 'connected' });
  await tick();
  next = { ok: true, status: 200, json: async () => ({ configured: true, enabled: false, mode: 'fast', version: 0, items: [], dailyCalls: 0, dailyLimit: 600 }) };
  await polls.shift()();
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).body.mode, 'smart');
  assert.equal(fx.storage.getItem(pref), 'smart');
  const priorPosts = requests.filter(row => row.method === 'POST').length;
  next = { ok: true, status: 200, json: async () => ({ configured: true, enabled: false, mode: 'smart', version: 2, items: [], dailyCalls: 0, dailyLimit: 600 }) };
  await polls.shift()();
  assert.equal(requests.filter(row => row.method === 'POST').length, priorPosts);
  assert.match(fx.doc.querySelector('#aiAssistStatus').textContent, /停止中/);
});
