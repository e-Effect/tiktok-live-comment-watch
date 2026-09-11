import test from 'node:test';
import assert from 'node:assert/strict';
import { AttentionAlerts } from '../lib/attention-alerts.js';
test('attention uses IDs across pages, excludes old events, lasts 30 seconds and isolates sessions', () => {
  const alerts = new AttentionAlerts();
  alerts.replace(['outside-page']);
  const user = {userId:'outside-page', nickname:'同じ名前'};
  assert.equal(alerts.accept('a', {...user,userId:'other'},100000,100000),null);
  assert.equal(alerts.accept('a',user,60000,100000),null);
  assert.equal(alerts.accept('a',user,100000,100000).expiresAt,130000);
  assert.equal(alerts.accept('a',user,101000,101000),null);
  assert.equal(alerts.active('a',110000).length,1);
  assert.equal(alerts.active('b',110000).length,0);
  assert.equal(alerts.active('a',130000).length,0);
  assert.ok(alerts.accept('a',user,130001,130001));
  alerts.update(user.userId,false);
  assert.equal(alerts.accept('a',user,140000,140000),null);
  assert.equal(alerts.active('a',140000).length,0);
});
