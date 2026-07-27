import assert from "node:assert/strict";
import test from "node:test";
import { EventStore } from "../lib/event-store.js";

test("gift ranking converts database totals to numbers", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.match(sql, /SUM\(item_count\)/);
      assert.deepEqual(values, ["session-id", "5655"]);
      return {
        rows: [{
          userId: "listener",
          nickname: "Listener",
          count: "12",
          diamonds: "12",
          lastGiftAt: new Date("2026-07-28T00:00:00Z")
        }]
      };
    }
  };

  const rows = await store.giftRanking({
    sessionId: "session-id",
    giftId: "5655",
    range: "session"
  });

  assert.equal(rows[0].count, 12);
  assert.equal(rows[0].diamonds, 12);
  assert.equal(typeof rows[0].lastGiftAt, "number");
});
