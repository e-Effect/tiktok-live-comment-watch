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
  assert.equal(middle.contributionRank, "D");
  assert.equal(rankings.lifetimeOrder[0], "user-100");
  assert.equal(rankings.recentOrder[0], "user-100");
});

test("listeners with no gifts and no comments stay D regardless of repeat visits", () => {
  const rankings = buildContributionRankings([
    { user_id:"first", visits:1, comments:0, coins:0 },
    { user_id:"repeat", visits:2, comments:0, coins:0, stats_last_seen_at:2 },
    { user_id:"silent-regular", visits:15, comments:0, coins:0, stats_last_seen_at:4 },
    { user_id:"gifter", visits:0, comments:0, coins:50, stats_last_seen_at:3 }
  ]);

  assert.equal(rankings.byUserId.get("first").contributionRank, "集計不足");
  assert.equal(rankings.byUserId.get("first").contributionPosition, null);
  assert.equal(rankings.byUserId.get("repeat").contributionRank, "D");
  assert.equal(rankings.byUserId.get("repeat").contributionPosition, null);
  assert.equal(rankings.byUserId.get("silent-regular").contributionRank, "D");
  assert.equal(rankings.byUserId.get("silent-regular").contributionScore, -26);
  assert.ok(rankings.lifetimeOrder.indexOf("silent-regular") > rankings.lifetimeOrder.indexOf("repeat"));
  assert.ok(rankings.byUserId.get("gifter").contributionPosition > 0);
});

test("a one-coin gift starts near the bottom of gift-giver percentiles instead of above all zeroes", () => {
  const rankings = buildContributionRankings([
    { user_id:"one", visits:2, comments:0, coins:1, stats_last_seen_at:1 },
    { user_id:"hundred", visits:2, comments:0, coins:100, stats_last_seen_at:2 },
    { user_id:"thousand", visits:2, comments:0, coins:1000, stats_last_seen_at:3 },
    ...Array.from({length:20},(_,index)=>({user_id:`silent-${index}`,visits:10,comments:0,coins:0,stats_last_seen_at:index+4}))
  ]);
  assert.ok(rankings.byUserId.get("one").contributionScore < rankings.byUserId.get("hundred").contributionScore);
  assert.equal(rankings.byUserId.get("silent-19").contributionRank, "D");
  assert.equal(rankings.byUserId.get("silent-19").contributionPosition, null);
});

test("rank tier boundaries use the listener population instead of fixed coin totals", () => {
  assert.equal(contributionTier(1, 1000), "S");
  assert.equal(contributionTier(5, 1000), "S");
  assert.equal(contributionTier(6, 1000), "A");
  assert.equal(contributionTier(20, 1000), "A");
  assert.equal(contributionTier(60, 1000), "B");
  assert.equal(contributionTier(100, 1000), "C");
  assert.equal(contributionTier(101, 1000), "D");
});
