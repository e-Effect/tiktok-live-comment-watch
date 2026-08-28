import assert from "node:assert/strict";
import test from "node:test";
import { classifyLurker, LURKER_RULES } from "../lib/lurker-classification.js";

test("frequent listeners with extremely little commenting and gifting are classified as lurkers", () => {
  assert.deepEqual(LURKER_RULES, { minVisits:5, maxCommentsPerVisit:0.5, maxCoinsPerVisit:10 });
  assert.equal(classifyLurker({ visits:5, comments:2, coins:20 }).isLurker, true);
  assert.equal(classifyLurker({ visits:20, comments:0, coins:0 }).isLurker, true);
});

test("new or meaningfully engaged listeners are not classified as lurkers", () => {
  assert.equal(classifyLurker({ visits:4, comments:0, coins:0 }).isLurker, false);
  assert.equal(classifyLurker({ visits:5, comments:3, coins:0 }).isLurker, false);
  assert.equal(classifyLurker({ visits:5, comments:0, coins:50 }).isLurker, false);
});

test("lurker classification exposes understandable per-visit ratios", () => {
  const result = classifyLurker({ visits:6, comments:2, coins:12 });
  assert.equal(result.commentsPerVisit, 0.33);
  assert.equal(result.allCoinsPerVisit, 2);
  assert.ok(result.lurkerScore > 0);
});
