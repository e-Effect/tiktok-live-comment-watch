import assert from "node:assert/strict";
import test from "node:test";
import { toLiveCueEvent } from "../lib/livecue-forwarder.js";

test("maps a normalized gift to the existing LiveCue event API", () => {
  assert.deepEqual(toLiveCueEvent({
    type: "gift",
    nickname: "リスナー",
    giftName: "Rose",
    repeatCount: 25,
    diamondCount: 1,
    totalDiamonds: 25
  }, "channel", "token"), {
    channelId: "channel",
    token: "token",
    type: "gift",
    username: "リスナー",
    giftName: "Rose",
    repeatCount: 25,
    coins: 1,
    comment: "",
    likeCount: 0,
    totalLikes: 0,
    subMonth: 0
  });
});
test("ignores unsupported internal events", () => {
  assert.equal(toLiveCueEvent({ type: "roomUser" }, "channel", "token"), null);
});

