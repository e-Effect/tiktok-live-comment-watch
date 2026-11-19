import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/live-ai-assist.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const pref = 'tiktok-live-ai-quality-v1';
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
  assert.match(reopened.doc.querySelector('#aiAssistStatus').textContent, /賢さ優先/);
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
  assert.match(fx.doc.querySelector('#aiAssistStatus').textContent, /賢さ優先/);
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
