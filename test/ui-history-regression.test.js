import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("visitor history shows visit count and previous visit date without legacy wording", () => {
  assert.doesNotMatch(clientSource, /再訪・累計/);
  assert.match(clientSource, /`\$\{formatNumber\(visits\)\}回目\$\{previousVisit \? `（\$\{previousVisit\}）` : ""\}`/);
  assert.match(clientSource, /previousAt \? `（\$\{formatVisitDate\(previousAt\)\}）` : ""/);
  assert.doesNotMatch(clientSource, /前回 \$\{formatVisitDate/);
});

test("visitor rows omit source badges and decorated names omit follow-status F marks", () => {
  assert.doesNotMatch(clientSource, /visit-badge/);
  assert.doesNotMatch(clientSource, /function visitSourceLabel/);
  assert.doesNotMatch(clientSource, /function followStatusMark/);
  assert.doesNotMatch(clientSource, /follow-status-mark/);
  assert.match(clientSource, /return `\$\{heartMeMark\(user\)\}\$\{todayFollowMark\(user\)\}\$\{name\}`/);
});

test("only confirmed first visits receive the yellow first-time style", () => {
  assert.match(clientSource, /comment\.visitHistoryKnown\s*&&\s*Number\(comment\.visitCount \|\| 0\) === 1/);
  assert.match(clientSource, /historyKnown\s*&&\s*visits === 1 \? "first-visit-row"/);
  assert.match(clientSource, /gift-card \$\{commentVisitClass\(gift\)\}/);
  assert.match(clientSource, /share-card \$\{commentVisitClass\(share\)\}/);
  assert.match(clientSource, /履歴確認中/);
  assert.match(clientSource, /履歴未確認/);
  assert.match(clientSource, /refreshEventDisplayState\(snapshot\.comments, cache\)/);
});

test("comment, gift, share, and visitor history render compact listener avatars", () => {
  assert.match(clientSource, /function renderEventAvatar\(user\)/);
  assert.match(clientSource, /loading="lazy"/);
  assert.match(clientSource, /referrerpolicy="no-referrer"/);
  assert.equal((clientSource.match(/\$\{renderEventAvatar\(/g) || []).length, 4);
  assert.match(clientSource, /avatarUrl: event\.avatarUrl \|\| user\.avatarUrl \|\| ""/);
});

test("Heart Me colors are based on saved cross-live history", () => {
  assert.match(clientSource, /membershipStatus === "inactive"/);
  assert.match(clientSource, /historyStatus === "first_ever"/);
  assert.match(clientSource, /historyStatus === "returning"/);
  assert.match(clientSource, /全期間で初めてハートミー送信/);
  assert.match(clientSource, /過去の配信でもハートミー送信記録あり/);
  assert.doesNotMatch(clientSource, /この配信で初めてハートミー送信/);
});
