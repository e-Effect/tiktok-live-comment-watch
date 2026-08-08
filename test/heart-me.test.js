import assert from "node:assert/strict";
import test from "node:test";
import {
  heartMeStateFromUser,
  isHeartMeGift,
  nextHeartMeStatusForGift
} from "../lib/heart-me.js";

test("detects localized Heart Me gifts and remembers a known gift id", () => {
  assert.equal(isHeartMeGift({ giftName: "ハートミー", giftId: 123 }), true);
  assert.equal(isHeartMeGift({ giftName: "Heart Me" }), true);
  assert.equal(isHeartMeGift({ giftName: "Community Heart", giftId: 123 }, {}, ["123"]), true);
  assert.equal(isHeartMeGift({ giftName: "Rose", giftId: 5655 }), false);
});

test("accepts a Set of remembered Heart Me gift ids", () => {
  assert.equal(isHeartMeGift({ giftId: "heart-1" }, {}, new Set(["heart-1"])), true);
});

test("detects an active fan from Tik.tools badge text", () => {
  assert.deepEqual(heartMeStateFromUser({
    badges: ["Super Fan Lv.7"]
  }), {
    status: "active",
    rawStatus: "Super Fan Lv.7",
    level: 7,
    source: "fan_badge_text"
  });
});

test("does not turn an existing member green when they send Heart Me", () => {
  assert.equal(nextHeartMeStatusForGift("active"), "active");
  assert.equal(nextHeartMeStatusForGift("inactive"), "active");
  assert.equal(nextHeartMeStatusForGift("none"), "new_today");
  assert.equal(nextHeartMeStatusForGift("unknown"), "new_today");
});
