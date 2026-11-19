import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('live AI endpoint requires admin, only follows opt-in fresh comments and leaves normal event flow untouched', async t => {
  const base = `http://127.0.0.1:${41100 + process.pid % 500}`;
  const admin = { Authorization: 'Bearer ai-admin-fixture' };
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: base.split(':').at(-1), LIVE_SOURCE: 'collector', COLLECTOR_INGEST_KEY: 'ai-collector-fixture', LISTENER_ADMIN_KEY: 'ai-admin-fixture', OPENAI_API_KEY: 'not-a-real-key', DATABASE_URL: '', LIVECUE_ENDPOINT: '' }, stdio: 'pipe' });
  t.after(() => child.kill());
  let started = false;
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(base + '/api/health')).ok) { started = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  assert.ok(started, 'test server starts');
  async function post(path, body, headers = admin) {
    return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  }
  const session = await (await post('/api/session', { username: 'ai_test_host' })).json();
  const path = `/api/session/${session.id}/ai-assist`;
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await post(path, { enabled: true }, {})).status, 401);
  assert.equal((await post(path, { enabled: 'true' })).status, 400);
  assert.equal((await (await fetch(base + path, { headers: admin })).json()).enabled, false);
  assert.equal((await post(path, { enabled: true })).status, 200);
  assert.equal((await (await post(path, { enabled: true, mode: 'smart' })).json()).mode, 'smart');
  for (const mode of ['invalid', '__proto__', 'gpt-6.2-astra', null, 1]) {
    assert.equal((await post(path, { enabled: false, mode })).status, 400);
  }
  const unchangedSettings = await (await fetch(base + path, { headers: admin })).json();
  assert.equal(unchangedSettings.enabled, true);
  assert.equal(unchangedSettings.mode, 'smart');
  const ingest = await post('/api/collector/events', { streamUsername: 'ai_test_host', events: [
    { event: 'chat', data: { msgId: 'pi-unique-fixture', comment: '円周率の10桁目は？', user: { id: 'pi-viewer', uniqueId: 'pi_viewer', nickname: 'viewer' } } }
  ] }, { Authorization: 'Bearer ai-collector-fixture' });
  assert.equal(ingest.status, 202);
  const feed = await (await fetch(base + path, { headers: admin })).json();
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].confidence, 'verified');
  assert.equal(feed.mode, 'smart');
  assert.equal(feed.model, 'gpt-6.2-sol');
  const unchanged = await (await fetch(base + path + `?version=${feed.version}`, { headers: admin })).json();
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.items, undefined, 'idle polls do not retransmit the full AI feed');
  const snapshot = await (await fetch(base + `/api/session/${session.id}/snapshot`)).json();
  assert.equal(snapshot.commentCount, 1);
  assert.equal(snapshot.comments[0].text, '円周率の10桁目は？');
  assert.equal(snapshot.aiAssist, undefined, 'private AI state does not leak into public snapshots');
  await post(`/api/session/${session.id}/stop`, {});
  assert.equal((await post(path, { enabled: true })).status, 409);
  assert.equal((await (await fetch(base + path, { headers: admin })).json()).enabled, false);
});
