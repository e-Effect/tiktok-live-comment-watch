import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import reporter, {requiredTests, verifyRequiredTests} from '../.github/ci/required-windows-tests.mjs';

function passingResults() {
  return requiredTests.map(name => ({type: 'test:pass', data: {
    name, file: resolve('test/room-user-config.test.js'), nesting: 0,
  }}));
}

test('Windows CI guard accepts exactly both successful required tests', () => {
  assert.doesNotThrow(() => verifyRequiredTests(passingResults(), 'win32'));
});

test('Windows CI guard rejects each missing, skipped, TODO, failed or duplicate required test', () => {
  for (const index of [0, 1]) {
    for (const change of ['missing', 'skip', 'todo', 'empty-skip', 'empty-todo', 'failed', 'duplicate', 'wrong-file', 'nested']) {
      const events = passingResults();
      if (change === 'missing') events.splice(index, 1);
      if (change === 'skip' || change === 'todo') events[index].data[change] = 'fixture reason';
      if (change.startsWith('empty-')) events[index].data[change.slice(6)] = '';
      if (change === 'failed') events[index].type = 'test:fail';
      if (change === 'duplicate') events.push(structuredClone(events[index]));
      if (change === 'wrong-file') events[index].data.file = resolve('test/other.test.js');
      if (change === 'nested') events[index].data.nesting = 1;
      assert.throws(() => verifyRequiredTests(events, 'win32'), undefined, `${index}: ${change}`);
    }
  }
  assert.throws(() => verifyRequiredTests([], 'win32'));
  assert.throws(() => verifyRequiredTests(passingResults(), 'linux'));
});

test('Windows CI reporter rejects an empty test stream', async () => {
  await assert.rejects(async () => {
    for await (const _ of reporter((async function* () {})())) {}
  });
});
