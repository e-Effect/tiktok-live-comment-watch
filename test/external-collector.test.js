import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCollectorEvent } from "../lib/external-collector.js";

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

test("turns terminal control and room events into streamEnd", () => {
  assert.equal(normalizeCollectorEvent({ event: "control", data: { action: 3 } }).type, "streamEnd");
  assert.equal(normalizeCollectorEvent({ event: "room", data: { status: 4 } }).type, "streamEnd");
});

test("drops unknown and malformed events", () => {
  assert.equal(normalizeCollectorEvent(null), null);
  assert.equal(normalizeCollectorEvent({ event: "giftPanelUpdate", data: {} }), null);
});
