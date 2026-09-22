import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore} from '../lib/event-store.js';

test('superfan revision refresh binds every SQL parameter and preserves stamps', async () => {
  const store = new EventStore();
  store.ready = true;
  const state = {users:[{id:'card',stamps:[{id:'existing'}]}]};
  let updates = 0;
  store.superFanRevision = async () => 'new';
  store.enrichStampState = async value => ({state:value});
  store.pool = {query:async (sql,args) => {
    if (sql.includes('UPDATE shared_app_states')) {
      updates++;
      assert.match(sql, /WHERE state_key = \$1/);
      assert.equal(args[0], 'stamp-card');
      assert.deepEqual(JSON.parse(args[1]), state);
      assert.equal(args[2], 'new');
      return {rows:[]};
    }
    return {rows:[{state,revision:5,sourceRevision:4,superFanRevision:'old'}]};
  }};
  const result = await store.sharedStampState();
  assert.equal(updates, 1);
  assert.deepEqual(result.state, state);
  assert.equal(result.revision, 5);
  assert.equal(result.superFanRevision, 'new');
});
