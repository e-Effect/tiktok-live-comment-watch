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
            lastVisitAt: new Date("2026-07-28T00:00:00Z"),
            previousVisitAt: new Date("2026-07-20T00:00:00Z")
          }]
        };
      }
      if (sql.includes("AS \"pastCount\"") && sql.includes("is_heart_me")) {
        return {
          rows: [{
            pastCount: "2",
            lastAt: new Date("2026-07-20T00:00:00Z")
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
  assert.equal(summary.previousVisitAt, Date.parse("2026-07-20T00:00:00Z"));
  assert.equal(summary.heartMeHistoryKnown, true);
  assert.equal(summary.pastHeartMeGiftCount, 2);
  assert.equal(summary.lastPastHeartMeAt, Date.parse("2026-07-20T00:00:00Z"));
  assert.match(calls[0].sql, /ON CONFLICT \(session_id, user_id\)/);
  assert.match(calls[1].sql, /FILTER/);
  assert.match(calls[1].sql, /COALESCE\(NULLIF\(s\.room_id, ''\), v\.session_id::text\)/);
  assert.deepEqual(calls[1].values, ["streamer", "viewer-id", "session-id"]);
  assert.match(calls[2].sql, /is_heart_me = TRUE/);
  assert.deepEqual(calls[2].values, ["streamer", "viewer-id", "session-id"]);
  assert.match(calls[3].sql, /latest_unique_id/);
  assert.match(calls[3].sql, /avatar_url/);
  assert.equal(calls[3].values[1], "");
  assert.equal(calls[3].values[3], "");
});

test("stores and reads Heart Me gift history from past live rooms", async () => {
  const store = new EventStore();
  const calls = [];
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO live_events")) return { rows: [] };
      return {
        rows: [{
          pastCount: "7",
          lastAt: new Date("2026-08-01T12:00:00Z")
        }]
      };
    }
  };

  const stored = await store.recordEvent({ id: "session-id", username: "streamer" }, {
    id: "gift-event",
    type: "gift",
    at: Date.parse("2026-08-09T12:00:00Z"),
    userId: "viewer-id",
    giftName: "ハートミー",
    repeatCount: 1,
    isHeartMe: true
  });
  assert.equal(stored, true);
  assert.match(calls[0].sql, /source, is_heart_me, payload/);
  assert.equal(calls[0].values[15], true);

  const history = await store.heartMeHistory({
    sessionId: "session-id",
    roomId: "room-id",
    username: "streamer",
    userId: "viewer-id"
  });
  assert.deepEqual(history, {
    known: true,
    pastCount: 7,
    lastAt: Date.parse("2026-08-01T12:00:00Z")
  });
  assert.match(calls[1].sql, /COALESCE\(NULLIF\(s.room_id, ''\), e.session_id::text\) <> \$3/);
  assert.deepEqual(calls[1].values, ["streamer", "viewer-id", "room-id"]);
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

test("stores a profile icon resolved for an existing listener", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.match(sql, /avatar_url = \$4/);
      assert.deepEqual(values, ["listener-id", "listener", "Listener", "https://cdn.example/avatar.jpg"]);
      return { rows: [{ user_id: "listener-id", avatar_url: values[3] }] };
    }
  };

  const updated = await store.updateListenerAvatar("listener-id", {
    uniqueId: "listener",
    nickname: "Listener",
    avatarUrl: "https://cdn.example/avatar.jpg"
  });

  assert.equal(updated.avatarUrl, "https://cdn.example/avatar.jpg");
});

test("matches an imported avatar by numeric id or exact TikTok id", async () => {
  const store = new EventStore();
  const calls = [];
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      assert.match(sql, /LOWER\(latest_unique_id\) = LOWER\(\$2\)/);
      return { rows: [{ userId: values[0] || `username:${values[1]}` }] };
    }
  };

  assert.equal(await store.listenerIdForIdentity({ userId: "123", uniqueId: "viewer" }), "123");
  assert.equal(await store.listenerIdForIdentity({ uniqueId: "viewer" }), "username:viewer");
  assert.deepEqual(calls[1].values, ["", "viewer"]);
});

test("stores avatar image bytes without replacing an existing cache", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.match(sql, /avatar_data = \$2/);
      assert.match(sql, /avatar_data IS NULL/);
      assert.equal(values[0], "listener-id");
      assert.ok(Buffer.isBuffer(values[1]));
      assert.equal(values[2], "image/webp");
      return { rows: [{ user_id: "listener-id" }] };
    }
  };

  assert.equal(await store.storeListenerAvatarData("listener-id", {
    data: Buffer.from([1, 2, 3]),
    mime: "image/webp"
  }), true);
});

test("preserves cached avatar bytes when a placeholder listener is merged", async () => {
  const store = new EventStore();
  const queries = [];
  store.ready = true;
  store.pool = {
    async connect() {
      return {
        async query(sql) {
          queries.push(sql);
          return { rows: [] };
        },
        release() {}
      };
    }
  };

  assert.equal(await store.mergeListenerRecords("username:viewer", "123456"), true);
  assert.match(queries[1], /avatar_data, avatar_mime/);
  assert.match(queries[1], /avatar_data = COALESCE\(listeners\.avatar_data, EXCLUDED\.avatar_data\)/);
});
