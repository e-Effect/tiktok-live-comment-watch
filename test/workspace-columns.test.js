import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('workspace dividers persist widths, skip hidden panels and reset independently of ledger data', async t => {
  const read = file => readFileSync(new URL('../public/'+file, import.meta.url),'utf8');
  const dom = new JSDOM(read('index.html'), {url:'https://example.test', runScripts:'outside-only'});
  t.after(() => dom.window.close());
  const {document, localStorage, KeyboardEvent, Event} = dom.window;
  const ids = ['visitors','comments','aiAssist','giftHistory'];
  const panels = ids.map(id => document.querySelector(`[data-panel="${id}"]`));
  panels.forEach((p,i) => { p.getBoundingClientRect = () => ({width:[210,360,260,170][i]}); });
  dom.window.eval(read('workspace-columns.js'));
  const handle = panels[0].querySelector('[role=separator]');
  handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'}));
  const saved = () => JSON.parse(localStorage.getItem('tiktok-live-column-widths-v1'));
  assert.deepEqual(saved().map(n => Math.round(n*10)),[226,344,260,170]);
  handle.dispatchEvent(new Event('dblclick'));
  assert.deepEqual(saved(),[21,36,26,17]);
  panels[1].hidden = true;
  await Promise.resolve();
  assert.match(handle.getAttribute('aria-label'),/入室履歴とAI補足/);
  assert.match(document.querySelector('.grid').style.getPropertyValue('--live-columns'),/ 0px /);
});
