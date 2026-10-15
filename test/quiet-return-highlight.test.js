import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { PGlite } from "@electric-sql/pglite";
import { EventStore } from "../lib/event-store.js";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const ui = vm.createContext({});
vm.runInContext(app.slice(app.indexOf("function commentVisitClass("), app.indexOf("function renderUsers(")), ui);
vm.runInContext(app.slice(app.indexOf("function refreshEventDisplayState("), app.indexOf("function refreshVisibleCommentRows(")), ui);

test("yellow includes only first visits and confirmed quiet second visits, preserving pink", () => {
  for (const [known, count, quiet, expected] of [
    [true, 1, false, "first-visit-comment"],
    [true, 2, true, "first-visit-comment"],
    [true, 2, false, ""], [true, 2, undefined, ""],
    [true, 3, true, ""], [false, 2, true, ""],
  ]) {
    assert.equal(ui.commentVisitClass({ visitHistoryKnown: known, visitCount: count, quietReturnHighlight: quiet }), expected);
  }
  assert.equal(ui.commentVisitClass({ visitHistoryKnown: true, visitCount: 2, quietReturnHighlight: true, earlyEntryHighlight: true }), "early-entry-comment");
  assert.equal(ui.commentVisitClass({ visitHistoryKnown: true, visitCount: 2, quietReturnHighlight: true, earlyEntryGiftCandidate: true }), "first-visit-comment");
});

test("presence updates refresh already visible comments and remove stale yellow", () => {
  const event = { userId: "u", visitHistoryKnown: false };
  const refreshed = ui.refreshEventDisplayState([event], new Map([["u", { visitHistoryKnown: true, visitCount: 2, quietReturnHighlight: true }]]))[0];
  assert.equal(ui.commentVisitClass(refreshed), "first-visit-comment");
  const corrected = ui.refreshEventDisplayState([refreshed], new Map([["u", { visitHistoryKnown: true, visitCount: 2, quietReturnHighlight: false }]]))[0];
  assert.equal(ui.commentVisitClass(corrected), "");
});

test("server carries the flag through presence and clears it on unknown history", () => {
  const user = { userId: "u" };
  const ctx = { user, users: new Map([["u", user]]) };
  const methods = server.slice(server.indexOf("  applyVisitSummary("), server.indexOf("  async retryPendingVisits("));
  const session = vm.runInNewContext(`({userStats:users,pendingVisitChecks:new Map(),broadcastPresence(){},${methods}})`, ctx);
  const display = vm.runInNewContext(server.slice(server.indexOf("function userDisplayState("), server.indexOf("function summarizeHeartMe(")) + "; userDisplayState", {});
  session.applyVisitSummary("u", { at: 1 }, { visitHistoryKnown: true, visitCount: 2, quietReturnHighlight: true });
  assert.equal(display(user).quietReturnHighlight, true);
  session.applyVisitSummary("u", { at: 1 }, { visitHistoryKnown: false });
  assert.equal(display(user).quietReturnHighlight, false);
});

test("real SQL excludes current LIVE actions, deduplicates reconnects, and isolates streamers", async () => {
  const db = new PGlite();
  const store = new EventStore();
  store.ready = true;
  store.visitPool = db;
  store.pool = { query: async () => ({ rows: [] }) };
  store.heartMeHistory = async () => ({ known: true, pastCount: 0 });
  try {
    await db.exec(`
      CREATE TABLE live_sessions(id text PRIMARY KEY, room_id text);
      CREATE TABLE viewer_visits(session_id text, stream_username text, user_id text, nickname text,
        first_seen_at timestamptz, last_seen_at timestamptz, first_source text, PRIMARY KEY(session_id,user_id));
      CREATE TABLE live_events(session_id text, stream_username text, user_id text, event_type text);
      INSERT INTO live_sessions VALUES ('old','old-room'),('old-reconnect','old-room'),('older','older-room'),
        ('current','current-room'),('reconnect','current-room'),('other','other-room'),('no-room','');
    `);
    const people = ["first", "silent", "comment", "gift", "like", "twice", "current-actions", "other-host", "no-room"];
    for (const userId of people.filter(id => id !== "first")) {
      await db.query("INSERT INTO viewer_visits VALUES ($1,'host',$2,'',NOW(),NOW(),'member')", [userId === "no-room" ? "no-room" : "old", userId]);
    }
    await db.exec(`INSERT INTO viewer_visits VALUES
      ('old-reconnect','host','silent','',NOW(),NOW(),'member'),
      ('older','host','twice','',NOW(),NOW(),'member');`);
    for (const type of ["comment", "gift", "like"]) {
      await db.query("INSERT INTO live_events VALUES ('old','host',$1,$1)", [type]);
      await db.query("INSERT INTO live_events VALUES ('current','host','current-actions',$1),('reconnect','host','current-actions',$1),('other','another-host','other-host',$1)", [type]);
    }
    await db.exec("INSERT INTO live_events VALUES ('old','host','silent','share'),('old','host','silent','follow')");
    const session = { id: "current", roomId: "current-room", username: "HOST" };
    const visits = people.map(userId => ({ userId, nickname: userId, source: "member", at: Date.now() }));
    const result = await store.recordVisitBatch(session, visits);
    assert.equal(result.size, people.length);
    assert.equal(result.get("first").visitCount, 1);
    for (const userId of people) {
      assert.equal(result.get(userId).quietReturnHighlight, ["silent", "current-actions", "other-host", "no-room"].includes(userId), userId);
    }
    // Both the direct and batched routes must produce the same decision.
    for (const userId of ["silent", "like", "current-actions"]) {
      const direct = await store.recordVisit(session, visits.find(v => v.userId === userId));
      const batched = await store.recordVisit(session, visits.find(v => v.userId === userId), { precomputed: result.get(userId) });
      assert.equal(direct.quietReturnHighlight, result.get(userId).quietReturnHighlight);
      assert.equal(batched.quietReturnHighlight, direct.quietReturnHighlight);
    }
  } finally {
    await db.close();
  }
});

test("failed interaction lookups remain unknown, never a quiet return", async () => {
  const store = new EventStore();
  store.ready = true;
  store.visitPool = { query: async sql => {
    if (sql.includes("FROM live_events")) throw new Error("history unavailable");
    return { rows: sql.includes("COUNT(DISTINCT") ? [{ userId: "u", visitCount: 2 }] : [] };
  } };
  const session = { id: "s", username: "host" };
  assert.equal((await store.recordVisitBatch(session, [{ userId: "u", at: 1 }])).size, 0);
  const result = await store.recordVisit(session, { userId: "u", at: 1 });
  assert.equal(result.visitHistoryKnown, false);
  assert.equal(result.quietReturnHighlight, false);
});
