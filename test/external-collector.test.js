import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCollectorEvent, shouldRotateCollectorSession } from "../lib/external-collector.js";

test("normalizes TikFinity chat envelopes", () => {
  const event = normalizeCollectorEvent({
    event: "chat",
    data: { msgId: "123", comment: "hello", user: { uniqueId: "viewer" } }
  });
  assert.equal(event.type, "chat");
  assert.equal(event.data.comment, "hello");
  assert.equal(event.key, "chat:123");
});

test("maps common TikFinity aliases", () => {
  assert.equal(normalizeCollectorEvent({ eventType: "comment", comment: "x" }).type, "chat");
  assert.equal(normalizeCollectorEvent({ type: "join", userId: "1" }).type, "member");
  assert.equal(normalizeCollectorEvent({ event: "roomUserSeq", data: {} }).type, "roomUser");
});

test("keeps pending and completed gift streak events distinct", () => {
  const pending = normalizeCollectorEvent({ event: "gift", data: { msgId: "g1", repeatCount: 2, repeatEnd: false } });
  const completed = normalizeCollectorEvent({ event: "gift", data: { msgId: "g1", repeatCount: 3, repeatEnd: true } });
  assert.notEqual(pending.key, completed.key);
});

test("creates stable retry keys for member and like events without message ids", () => {
  const member = { event: "member", data: { createTime: 1_786_400_000, user: { userId: "123", uniqueId: "viewer" } } };
  const like = { event: "like", data: { createTime: 1_786_400_001, likeCount: 8, user: { userId: "123" } } };
  assert.equal(normalizeCollectorEvent(member).key, normalizeCollectorEvent(member).key);
  assert.equal(normalizeCollectorEvent(like).key, normalizeCollectorEvent(like).key);
  assert.match(normalizeCollectorEvent(member).key, /^member:fallback:/);
  assert.match(normalizeCollectorEvent(like).key, /^like:fallback:/);
});

test("turns terminal control and room events into streamEnd", () => {
  assert.equal(normalizeCollectorEvent({ event: "control", data: { action: 3 } }).type, "streamEnd");
  assert.equal(normalizeCollectorEvent({ event: "room", data: { status: 4 } }).type, "streamEnd");
});

test("drops unknown and malformed events", () => {
  assert.equal(normalizeCollectorEvent(null), null);
  assert.equal(normalizeCollectorEvent({ event: "giftPanelUpdate", data: {} }), null);
});

test("extracts room id and event time for live-session boundaries", () => {
  const event = normalizeCollectorEvent({ event: "chat", data: { msgId: "1", roomId: "room-2", createTime: 1_786_400_000 } });
  assert.equal(event.roomId, "room-2");
  assert.equal(event.at, 1_786_400_000_000);
});

test("rotates collector sessions only for a new room or a long event gap", () => {
  const hour = 60 * 60 * 1000;
  assert.equal(shouldRotateCollectorSession({ currentRoomId: "1", incomingRoomId: "1", lastEventAt: 10 * hour, eventAt: 11 * hour }), false);
  assert.equal(shouldRotateCollectorSession({ currentRoomId: "1", incomingRoomId: "2", lastEventAt: 10 * hour, eventAt: 11 * hour }), true);
  assert.equal(shouldRotateCollectorSession({ currentRoomId: "1", incomingRoomId: "", lastEventAt: 10 * hour, eventAt: 13 * hour }), true);
});
