import assert from "node:assert/strict";
import test from "node:test";
import { confirmedRankedWatchSeconds, updateRankedPresence } from "../lib/ranked-watch.js";

test("ranked watch time adds separate visits within the same live", () => {
  const user = {};
  updateRankedPresence(user, true, 1_000);
  updateRankedPresence(user, true, 11_000);
  updateRankedPresence(user, false, 21_000);
  assert.equal(confirmedRankedWatchSeconds(user, 31_000), 20);
  assert.equal(user.rankedVisitCount, 1);

  updateRankedPresence(user, true, 41_000);
  updateRankedPresence(user, true, 46_000);
  assert.equal(confirmedRankedWatchSeconds(user, 51_000), 30);
  assert.equal(user.rankedVisitCount, 2);
});
