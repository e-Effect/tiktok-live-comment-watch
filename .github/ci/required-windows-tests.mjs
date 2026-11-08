import assert from 'node:assert/strict';
import {resolve} from 'node:path';

export const requiredTests = [
  'Windows config distinguishes missing, read errors, malformed JSON, types and explicit disable; repairs recover',
  'Windows diagnostics and idle delivery close stay intervals on every stop; ordinary queued events still deliver',
];

export function verifyRequiredTests(events, platform = process.platform) {
  assert.equal(platform, 'win32', 'Required tests must run on Windows');
  const expectedFile = resolve('test/room-user-config.test.js');
  for (const name of requiredTests) {
    const results = events.filter(({data}) => data.name === name &&
      data.file && resolve(data.file) === expectedFile && data.nesting === 0);
    assert.equal(results.length, 1, `Required test missing or duplicated: ${name}`);
    const result = results[0];
    assert.equal(result.type, 'test:pass', `Required test failed: ${name}`);
    for (const flag of ['skip', 'todo']) {
      assert.ok(result.data[flag] === undefined || result.data[flag] === false,
        `Required test skipped or TODO: ${name}`);
    }
  }
}

// Node's test runner still controls the exit status of the entire test suite.
// Throwing here additionally fails runs that never execute a required test.
export default async function* requiredWindowsReporter(source) {
  const results = [];
  for await (const event of source) {
    if ((event.type === 'test:pass' || event.type === 'test:fail') &&
        requiredTests.includes(event.data.name)) {
      results.push(event);
    }
  }
  verifyRequiredTests(results);
  for (const {data} of results) yield `Required Windows test PASS (not skipped): ${data.name}\n`;
  yield 'Verified both required tests from test/room-user-config.test.js in this npm test run.\n';
}
