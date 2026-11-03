import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectorLiveRoomLookup, verifiedLiveRoom } from '../lib/collector-live-room.js';

const roomId = '7000000000000000001';
const info = { user: { uniqueId: 'Host', roomId }, liveRoom: { status: 2 } };

test('only the requested host, active status and lossless numeric room ID are accepted', () => {
  assert.equal(verifiedLiveRoom(info, 'host'), roomId);
  assert.equal(verifiedLiveRoom(info, 'other'), '');
  assert.equal(verifiedLiveRoom({ ...info, liveRoom: { status: 4 } }, 'host'), '');
  assert.equal(verifiedLiveRoom({ ...info, user: { ...info.user, roomId: Number(roomId) } }, 'host'), '');
});

test('concurrent requests share lookup; a failed source is tolerated but conflicting rooms are rejected', async () => {
  let htmlCalls = 0;
  let apiResult;
  const lookup = createCollectorLiveRoomLookup(async () => ({
    TikTokLiveConnection: class {},
    async fetchRoomInfoFromHtmlRoute() { htmlCalls++; return info; },
    async fetchRoomInfoFromApiLiveRoute() {
      if (!apiResult) throw new Error('Unavailable');
      return { data: apiResult };
    }
  }), () => 100);
  const first = lookup('host');
  assert.equal(first, lookup('host'));
  assert.deepEqual(await first, { roomId, checkedAt: 100, validForMs: 22000 });
  assert.equal(htmlCalls, 1);
  apiResult = { ...info, user: { ...info.user, roomId: '7000000000000000002' } };
  assert.deepEqual(await lookup('host'), { roomId: '', checkedAt: 100, validForMs: 0 });
});
