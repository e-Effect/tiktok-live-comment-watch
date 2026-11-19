import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROFILES, isAiMode, LiveAiAssist } from '../lib/live-ai-assist.js';

const sample = (text, extra = {}) => ({ id: text, text, at: Date.now(), ...extra });
const answer = { index: 0, kind: 'word', title: '用語', reading: 'ようご', answer: '説明', detail: '', confidence: 'candidate' };
const reply = () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ items: [answer] }) }] }] }) });

test('all five profiles send their actual model, effort and output budget; fast retains previous behavior', async t => {
  const requests = [];
  let now = Date.now();
  const ai = new LiveAiAssist({ now: () => now, apiKey: 'fixture', fetchImpl: async (_, options) => { requests.push(JSON.parse(options.body)); return reply(); } });
  t.after(() => ai.dispose());
  assert.equal(ai.snapshot('s').mode, 'fast');
  for (const [mode, profile] of Object.entries(AI_PROFILES)) {
    now += 72000;
    const state = ai.configure('s', true, mode);
    assert.equal(state.model, profile.model);
    assert.equal(state.modeLabel, profile.label);
    ai.submit('s', sample(`専門用語 ${mode}`, {at: now}));
    await ai.run();
    const request = requests.at(-1);
    assert.equal(request.model, profile.model);
    assert.equal(request.reasoning.effort, profile.effort);
    assert.equal(request.max_output_tokens, profile.maxOutputTokens);
    assert.equal(ai.snapshot('s').items[0].mode, mode);
  }
  assert.equal(requests[0].max_output_tokens, 1800);
  assert.equal(requests[0].reasoning.effort, 'none');
  assert.equal(ai.snapshot('s').items.length, 5, 'switching quality preserves existing supplements');
});

test('invalid or arbitrary model choices cannot change server configuration', t => {
  const ai = new LiveAiAssist({ apiKey: 'fixture' });
  t.after(() => ai.dispose());
  ai.configure('s', true, 'smart');
  for (const mode of [null, 1, false, {}, [], 'constructor', '__proto__', 'gpt-6.2-astra']) {
    assert.equal(isAiMode(mode), false);
    assert.throws(() => ai.configure('s', false, mode), /invalid-ai-mode/);
    assert.equal(ai.snapshot('s').mode, 'smart');
    assert.equal(ai.snapshot('s').enabled, true);
  }
  ai.configure('s', false);
  assert.equal(ai.snapshot('s').mode, 'smart', 'older clients and lease expiry preserve quality');
});

test('queued comments from different modes never share the wrong model request', async t => {
  const bodies = [];
  const ai = new LiveAiAssist({ apiKey: 'fixture', fetchImpl: async (_, options) => { bodies.push(JSON.parse(options.body)); return reply(); } });
  t.after(() => ai.dispose());
  ai.configure('fast-session', true, 'fast');
  ai.configure('smart-session', true, 'smart');
  ai.submit('fast-session', sample('軽量用語'));
  ai.submit('smart-session', sample('高度用語'));
  await ai.run();
  assert.equal(ai.queue.length, 1);
  assert.equal(JSON.parse(bodies[0].input).length, 1);
  assert.equal(bodies[0].model, AI_PROFILES.fast.model);
  await ai.run();
  assert.equal(bodies[1].model, AI_PROFILES.smart.model);
  assert.equal(ai.snapshot('smart-session').items[0].mode, 'smart');
});

test('mode change drops stale queued work and prevents old in-flight answers without changing the original feed', async t => {
  let finish;
  const ai = new LiveAiAssist({ apiKey: 'fixture', fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => ai.dispose());
  ai.configure('s', true, 'fast');
  ai.submit('s', sample('切替前の質問'));
  const running = ai.run();
  await new Promise(resolve => setImmediate(resolve));
  ai.configure('s', true, 'smart');
  finish(reply());
  await running;
  assert.equal(ai.snapshot('s').items.length, 0);
  assert.equal(ai.snapshot('s').mode, 'smart');
  const revision = ai.state('s').revision;
  ai.configure('s', true, 'smart');
  assert.equal(ai.state('s').revision, revision, 'reconnect with the same mode does not cancel work');
});

test('pi calculation is equally exact and free of API requests in every mode', t => {
  const ai = new LiveAiAssist({ apiKey: 'fixture', fetchImpl: () => { throw new Error('no network'); } });
  t.after(() => ai.dispose());
  for (const mode of Object.keys(AI_PROFILES)) {
    ai.configure(mode, true, mode);
    ai.submit(mode, sample('円周率の10桁目は？'));
    const item = ai.snapshot(mode).items[0];
    assert.equal(item.confidence, 'verified');
    assert.equal(item.mode, null, 'deterministic results are not attributed to a model');
    assert.match(item.answer, /「5」/);
  }
  assert.equal(ai.calls.length, 0);
});
