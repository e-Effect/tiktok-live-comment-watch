import assert from "node:assert/strict";
import test from "node:test";
import { tiktokProfileFromUser } from "../lib/tiktok-profile.js";

test("extracts follower totals and host follow status from TikTok user data", () => {
  assert.deepEqual(tiktokProfileFromUser({
    followInfo: { followStatus: 1, followerCount: "4567", followingCount: 123 }
  }), {
    followStatus: "following",
    followStatusRaw: 1,
    followerCount: 4567,
    followingCount: 123
  });
});

test("keeps unavailable profile values distinct from zero", () => {
  assert.deepEqual(tiktokProfileFromUser({ follow_info: { follow_status: 0, follower_count: 0 } }), {
    followStatus: "not_following",
    followStatusRaw: 0,
    followerCount: 0,
    followingCount: null
  });
  assert.deepEqual(tiktokProfileFromUser({}), {
    followStatus: null,
    followStatusRaw: null,
    followerCount: null,
    followingCount: null
  });
});
