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

test("visit history counts distinct live room ids instead of re-entries", async () => {
  const store = new EventStore();
  const calls = [];
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("COUNT(DISTINCT")) {
        return {
          rows: [{
            visitCount: "3",
            firstVisitAt: new Date("2026-07-01T00:00:00Z"),
            lastVisitAt: new Date("2026-07-28T00:00:00Z")
          }]
        };
      }
      return { rows: [] };
    }
  };

  const summary = await store.recordVisit({
    id: "session-id",
    username: "streamer"
  }, {
    userId: "viewer-id",
    nickname: "Viewer",
    at: Date.parse("2026-07-28T00:00:00Z"),
    source: "member"
  });

  assert.equal(summary.visitCount, 3);
  assert.match(calls[0].sql, /ON CONFLICT \(session_id, user_id\)/);
  assert.match(calls[1].sql, /COALESCE\(NULLIF\(s\.room_id, ''\), v\.session_id::text\)/);
  assert.deepEqual(calls[1].values, ["streamer", "viewer-id"]);
  assert.match(calls[2].sql, /latest_unique_id/);
  assert.match(calls[2].sql, /avatar_url/);
  assert.equal(calls[2].values[1], "");
  assert.equal(calls[2].values[3], "");
});

test("clears only unedited Count Pocket super-fan imports", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.match(sql, /manually_updated_at IS NULL/);
      assert.match(sql, /tags @> \$2::jsonb/);
      assert.deepEqual(values, ["count-pocket", JSON.stringify(["スタンプカード"])]);
      return { rowCount: 482, rows: [] };
    }
  };

  assert.deepEqual(await store.clearImportedSuperFans(), { updated: 482 });
});

test("does not import Count Pocket users as super fans", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.match(sql, /INSERT INTO listeners/);
      assert.equal(values[6], false);
      return { rows: [] };
    }
  };

  const result = await store.importListeners([{
    userId: "username:listener",
    uniqueId: "listener",
    nickname: "Listener",
    isSuperFan: true,
    tags: ["スタンプカード"]
  }], { source: "count-pocket" });

  assert.deepEqual(result, { imported: 1, importedStamps: 0 });
});
