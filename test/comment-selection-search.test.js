import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentUpdateGate, searchUrl } from '../public/comment-selection-search.js';

test('search preserves selected Japanese text and safely encodes URL punctuation', () => {
  const text = '京都 & お店 #1 + "おすすめ"';
  const url = new URL(searchUrl(`  ${text}  `));
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), text);
  assert.equal(url.hash, '');
});

test('incoming updates do not replace selection; release renders only the newest snapshot', () => {
  let selected = false;
  const renders = [];
  const gate = createCommentUpdateGate(() => selected);
  gate.update(() => renders.push('initial'));
  selected = true;
  gate.update(() => renders.push('older'));
  gate.update(() => renders.push('latest'));
  gate.flush();
  assert.deepEqual(renders, ['initial']);
  selected = false;
  gate.flush();
  gate.flush();
  assert.deepEqual(renders, ['initial', 'latest']);
});

test('switching streams discards an old paused render', () => {
  let selected = true;
  const renders = [];
  const gate = createCommentUpdateGate(() => selected);
  gate.update(() => renders.push('old-stream'));
  gate.discard();
  selected = false;
  gate.update(() => renders.push('new-stream'));
  assert.deepEqual(renders, ['new-stream']);
});
