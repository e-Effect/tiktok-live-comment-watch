import assert from "node:assert/strict";
import test from "node:test";
import { buildContributionRankings, contributionTier } from "../lib/contribution-rank.js";

test("contribution ranks are relative and reward gifts, visits, comments, recency, and a small like bonus", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    user_id: `user-${index + 1}`,
    search_text: `user-${index + 1}`,
    visits: index + 2,
    comments: (index + 1) * 3,
    coins: (index + 1) * 10,
    likes: (index + 1) * 20,
    stats_last_seen_at: index + 1,
    recent_visits: index % 4,
    recent_comments: index,
    recent_coins: index * 2,
    recent_likes: index * 5,
    recent_last_seen_at: index + 1
  }));
  const rankings = buildContributionRankings(rows);
  const top = rankings.byUserId.get("user-100");
  const middle = rankings.byUserId.get("user-51");

  assert.equal(top.contributionRank, "S");
  assert.equal(top.contributionPosition, 1);
  assert.equal(top.contributionScore, 105);
  assert.equal(middle.contributionRank, "C");
  assert.equal(rankings.lifetimeOrder[0], "user-100");
  assert.equal(rankings.recentOrder[0], "user-100");
});

test("one silent first visit stays unranked while repeat visitors remain eligible", () => {
  const rankings = buildContributionRankings([
    { user_id:"first", visits:1, comments:0, coins:0 },
    { user_id:"repeat", visits:2, comments:0, coins:0, stats_last_seen_at:2 },
    { user_id:"gifter", visits:0, comments:0, coins:50, stats_last_seen_at:3 }
  ]);

  assert.equal(rankings.byUserId.get("first").contributionRank, "集計不足");
  assert.equal(rankings.byUserId.get("first").contributionPosition, null);
  assert.ok(rankings.byUserId.get("repeat").contributionPosition > 0);
  assert.ok(rankings.byUserId.get("gifter").contributionPosition > 0);
});

test("rank tier boundaries use the listener population instead of fixed coin totals", () => {
  assert.equal(contributionTier(3, 100), "S");
  assert.equal(contributionTier(4, 100), "A");
  assert.equal(contributionTier(10, 100), "A");
  assert.equal(contributionTier(25, 100), "B");
  assert.equal(contributionTier(50, 100), "C");
  assert.equal(contributionTier(51, 100), "D");
});
