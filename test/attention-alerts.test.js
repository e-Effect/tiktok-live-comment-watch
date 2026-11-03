import test from 'node:test';
import assert from 'node:assert/strict';
import { AttentionAlerts } from '../lib/attention-alerts.js';
test('attention lasts ten seconds initially and five seconds on subsequent displays', () => {
  const alerts = new AttentionAlerts();
  alerts.replace(['outside-page']);
  const user = {userId:'outside-page', nickname:'同じ名前'};
  assert.equal(alerts.accept('a', {...user,userId:'other'},100000,100000),null);
  assert.equal(alerts.accept('a',user,60000,100000),null);
  assert.equal(alerts.accept('a',user,100000,100000).expiresAt,110000);
  assert.equal(alerts.accept('a',user,101000,101000),null);
  assert.equal(alerts.active('a',109999).length,1);
  assert.equal(alerts.active('b',110000).length,0);
  assert.equal(alerts.active('a',110000).length,0);
  assert.equal(alerts.accept('a',user,110001,110001).expiresAt,115001);
  assert.equal(alerts.accept('a',user,115001,115001).expiresAt,120001);
  alerts.update(user.userId,false);
  assert.equal(alerts.accept('a',user,140000,140000),null);
  assert.equal(alerts.active('a',140000).length,0);
});

test('same broadcast keeps repeat timing after reconnection, another broadcast resets it per person',()=>{
  const alerts=new AttentionAlerts();
  alerts.replace(['one','two']);
  const one={userId:'one'},two={userId:'two'};
  assert.equal(alerts.accept('a',one,100000,100000,'room:A').expiresAt,110000);
  assert.equal(alerts.accept('reconnected',one,105000,105000,'room:A'),null);
  assert.equal(alerts.accept('reconnected',one,110001,110001,'room:A').expiresAt,115001);
  assert.equal(alerts.accept('reconnected',two,110001,110001,'room:A').expiresAt,120001);
  assert.equal(alerts.accept('b',one,111000,111000,'room:B').expiresAt,121000);
});
