import assert from "node:assert/strict";
import test from "node:test";
import { isSilentWatcher, silentWatcherPresenceMode } from "../lib/silent-watchers.js";

test("includes a ranked silent viewer after fifteen minutes", () => {
  const user = { isCurrentlyRanked: true, watchSeconds: 900, comments: 0 };
  assert.equal(isSilentWatcher(user), true);
  assert.equal(silentWatcherPresenceMode(user), "viewer_ranking");
});

test("falls back to an observed entry when viewer identities are unavailable", () => {
  const user = { entryEventCount: 1, watchSeconds: 1800, comments: 0 };
  assert.equal(isSilentWatcher(user), true);
  assert.equal(silentWatcherPresenceMode(user), "entry_estimate");
});

test("does not treat generic activity or commenters as silent entrants", () => {
  assert.equal(isSilentWatcher({ watchSeconds: 3600, comments: 0 }), false);
  assert.equal(isSilentWatcher({ entryEventCount: 1, watchSeconds: 3600, comments: 1 }), false);
});
