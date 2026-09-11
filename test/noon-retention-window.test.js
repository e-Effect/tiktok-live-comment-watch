import test from 'node:test';
import assert from 'node:assert/strict';
import { NoonRetentionWindow } from '../lib/noon-retention-window.js';
const at = value => Date.parse(`2026-09-12T${value}Z`);
test('starts at noon JST, ends by 12:15 and never catches up',()=>{
  const w=new NoonRetentionWindow();
  assert.equal(w.allow(at('02:59:59')),false);
  assert.equal(w.allow(at('03:00:15')),true);
  assert.equal(w.allow(at('03:14:59')),true);
  assert.equal(w.allow(at('03:15:00')),false);
  assert.equal(w.allow(at('12:00:00')),false);
  assert.equal(new NoonRetentionWindow().allow(at('03:01:00')),false);
  assert.equal(w.allow(Date.parse('2026-09-13T03:00:00Z')),true);
});
test('completion or live activity stops the run without resuming later',()=>{
  const w=new NoonRetentionWindow();
  assert.equal(w.allow(at('03:00:00')),true);w.finish();
  assert.equal(w.allow(at('03:00:30')),false);
  const active=new NoonRetentionWindow();active.allow(at('03:00:00'));
  assert.equal(active.allow(at('03:01:00'),true),false);
  assert.equal(active.allow(at('03:02:00')),false);
});
