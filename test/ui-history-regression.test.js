import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("visitor history shows visit count and previous visit date without legacy wording", () => {
  assert.doesNotMatch(clientSource, /再訪・累計/);
  assert.match(clientSource, /`\$\{formatNumber\(visits\)\}回目\$\{previousVisit \? `・\$\{previousVisit\}` : ""\}`/);
});

test("only confirmed first visits receive the yellow first-time style", () => {
  assert.match(clientSource, /comment\.visitHistoryKnown\s*&&\s*Number\(comment\.visitCount \|\| 0\) === 1/);
  assert.match(clientSource, /historyKnown\s*&&\s*visits === 1 \? "first-visit-row"/);
  assert.match(clientSource, /履歴確認中/);
  assert.match(clientSource, /履歴未確認/);
  assert.match(clientSource, /refreshEventDisplayState\(snapshot\.comments, cache\)/);
});

test("Heart Me colors are based on saved cross-live history", () => {
  assert.match(clientSource, /membershipStatus === "inactive"/);
  assert.match(clientSource, /historyStatus === "first_ever"/);
  assert.match(clientSource, /historyStatus === "returning"/);
  assert.match(clientSource, /全期間で初めてハートミー送信/);
  assert.match(clientSource, /過去の配信でもハートミー送信記録あり/);
  assert.doesNotMatch(clientSource, /この配信で初めてハートミー送信/);
});
