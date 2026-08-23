import assert from "node:assert/strict";
import test from "node:test";
import { EventStore, rangeStart } from "../lib/event-store.js";

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

test("today starts at midnight in Japan even when the server runs in UTC", () => {
  assert.equal(rangeStart("today", new Date("2026-08-11T00:30:00Z")).toISOString(), "2026-08-10T15:00:00.000Z");
  assert.equal(rangeStart("today", new Date("2026-08-10T14:00:00Z")).toISOString(), "2026-08-09T15:00:00.000Z");
});

test("listener export returns every matching row without the screen limit", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.doesNotMatch(sql, /LIMIT\s+250/i);
      assert.deepEqual(values, ["streamer", "viewer"]);
      return { rows: [{ user_id: "1", latest_unique_id: "viewer", latest_nickname: "Viewer", visits: "2" }] };
    }
  };
  const rows = await store.listenerExportRows({ username: "streamer", search: "viewer" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].visits, 2);
});

test("listener search narrows people before aggregating their stream totals", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.match(sql, /WITH matched_listeners AS MATERIALIZED/);
      assert.ok(sql.indexOf("FROM listeners l") < sql.indexOf("FROM listener_stream_stats s"));
      assert.match(sql, /JOIN matched_listeners m ON m\.user_id = s\.user_id/);
      assert.deepEqual(values, ["streamer", "viewer", 250, 0]);
      return { rows: [{ user_id:"1", latest_unique_id:"viewer", latest_nickname:"Viewer", visits:"2", full_count:"1" }] };
    }
  };
  const result = await store.listeners({ username:"streamer", search:"viewer", limit:250 });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].visits, 2);
});

test("listener comment history is paginated while remaining fully reachable", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.match(sql, /event_type = 'comment'/);
      assert.match(sql, /COUNT\(\*\) OVER\(\)/);
      assert.deepEqual(values, ["listener-1", "streamer", 200, 200]);
      return { rows: [{ id:"event-201", at:new Date("2026-08-22T12:00:00Z"), text:"続き", streamUsername:"streamer", fullCount:"401" }] };
    }
  };
  const result = await store.listenerHistory("listener-1", { username:"streamer", kind:"comments", limit:200, offset:200 });
  assert.equal(result.total, 401);
  assert.equal(result.items[0].text, "続き");
  assert.equal(typeof result.items[0].at, "number");
});

test("listener visit history groups every recorded day in Japan", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.match(sql, /Asia\/Tokyo/);
      assert.match(sql, /GROUP BY TO_CHAR/);
      assert.deepEqual(values, ["listener-1", "", 200, 0]);
      return { rows: [{ day:"2026-08-22", firstSeenAt:new Date("2026-08-22T10:00:00Z"), lastSeenAt:new Date("2026-08-22T12:00:00Z"), liveCount:"2", streamUsernames:["streamer"], fullCount:"12" }] };
    }
  };
  const result = await store.listenerHistory("listener-1", { kind:"visits" });
  assert.equal(result.total, 12);
  assert.equal(result.items[0].day, "2026-08-22");
  assert.equal(result.items[0].liveCount, 2);
});

test("listener attention flag is saved independently from super fan", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.match(sql, /needs_attention = COALESCE/);
      assert.deepEqual(values, ["listener-1", null, true, null, null]);
      return { rows: [{ user_id:"listener-1", needs_attention:true }] };
    }
  };
  const result = await store.updateListener("listener-1", { needsAttention:true });
  assert.equal(result.needsAttention, true);
  assert.equal(result.isSuperFan, false);
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
  assert.equal(summary.visitHistoryKnown, true);
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

test("does not label a visitor as first-time while the database is unavailable", async () => {
  const store = new EventStore();
  const summary = await store.recordVisit({ id: "session-id", username: "streamer" }, {
    userId: "viewer-id",
    at: Date.parse("2026-08-11T00:00:00Z")
  });

  assert.equal(summary.visitHistoryKnown, false);
  assert.equal(summary.visitCount, 0);
  assert.equal(summary.firstVisitAt, null);
  assert.equal(summary.lastVisitAt, null);
});

test("prior listener history excludes the current live and matches stable IDs plus aliases", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      assert.match(sql, /WITH identity_ids AS/);
      assert.match(sql, /viewer_visits/);
      assert.match(sql, /live_events/);
      assert.match(sql, /<> \$4/);
      assert.deepEqual(values, ["streamer", "700000000001", "viewer_name", "room-current"]);
      return {
        rows: [{
          priorVisitCount: "4",
          lastPriorVisitAt: new Date("2026-08-10T12:00:00Z"),
        }],
      };
    },
  };

  const history = await store.priorListenerHistory({
    sessionId: "session-current",
    roomId: "room-current",
    username: "streamer",
    userId: "700000000001",
    uniqueId: "@viewer_name",
  });

  assert.deepEqual(history, {
    known: true,
    priorVisitCount: 4,
    lastPriorVisitAt: Date.parse("2026-08-10T12:00:00Z"),
  });
});

test("prior listener history stays unconfirmed while the database is unavailable", async () => {
  const store = new EventStore();
  assert.deepEqual(await store.priorListenerHistory({
    sessionId: "session-current",
    username: "streamer",
    userId: "viewer-id",
  }), {
    known: false,
    priorVisitCount: 0,
    lastPriorVisitAt: null,
  });
});

test("shares one reconnect attempt and marks connection timeouts unavailable", async () => {
  const store = new EventStore({ connectionString: "postgres://example" });
  let attempts = 0;
  store.initialize = async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.ready = true;
    store.pool = {};
    return true;
  };

  assert.deepEqual(await Promise.all([store.ensureReady(), store.ensureReady()]), [true, true]);
  assert.equal(attempts, 1);
  store.rememberError(new Error("connect ETIMEDOUT 10.0.0.1:5432"));
  assert.equal(store.ready, false);
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

test("shared stamp polling returns a small unchanged response", async () => {
  const store = new EventStore();
  store.ready = true;
  store.pool = {
    async query(sql) {
      if (/FROM shared_app_states/.test(sql)) {
        return { rows: [{ state: { users: [{ id: "saved" }] }, revision: "27", sourceRevision: "26", superFanRevision: "3:1000", updatedAt: new Date(1000) }] };
      }
      if (/COUNT\(\*\) FILTER/.test(sql)) {
        return { rows: [{ count: "3", changed: "1000" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await store.sharedStampState({ revision: 27, superFanRevision: "3:1000" });

  assert.deepEqual(result, {
    unchanged: true,
    revision: 27,
    sourceRevision: 26,
    superFanRevision: "3:1000",
    updatedAt: 1000
  });
  assert.equal("state" in result, false);
});

test("receipt printing is idempotent by external event id", async () => {
  const store = new EventStore();
  const calls = [];
  store.ready = true;
  store.pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/SELECT user_id AS "userId"/.test(sql)) return { rows: [{ userId: "700000000000001" }] };
      if (/INSERT INTO listeners/.test(sql)) return { rows: [] };
      if (/INSERT INTO receipt_prints/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await store.recordReceiptPrint({
    userId: "700000000000001",
    uniqueId: "listener",
    eventId: "gift-event-1",
    giftName: "Rose",
    count: 1,
    coins: 1
  });

  assert.equal(result.recorded, false);
  assert.equal(result.duplicate, true);
  assert.match(calls.at(-1).sql, /ON CONFLICT \(external_event_id\)/);
  assert.equal(calls.at(-1).values.at(-1), "gift-event-1");
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
