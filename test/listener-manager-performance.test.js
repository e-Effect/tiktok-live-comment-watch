import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const eventStoreSource = await readFile(new URL("../lib/event-store.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../public/listener-manager.js", import.meta.url), "utf8");
const htmlSource = await readFile(new URL("../public/listener-manager.html", import.meta.url), "utf8");

test("default listener pages aggregate only the selected hundred listeners", () => {
  assert.match(eventStoreSource, /fastSortColumns/);
  assert.match(eventStoreSource, /page AS MATERIALIZED/);
  assert.match(eventStoreSource, /JOIN page p ON p\.user_id = s\.user_id/);
  assert.match(clientSource, /listenerPageSize: 100/);
  assert.match(clientSource, /offset:String\(state\.listenerPage \* state\.listenerPageSize\)/);
  assert.match(htmlSource, /id="listenerPrev"/);
  assert.match(htmlSource, /id="listenerNext"/);
});

test("listener summary uses a short cache with an explicit fresh option", () => {
  assert.match(serverSource, /LISTENER_SUMMARY_CACHE_MS = 30000/);
  assert.match(serverSource, /url\.searchParams\.get\("fresh"\) === "1"/);
  assert.match(clientSource, /refreshSummary\(\{fresh:true\}\)/);
});

test("realtime ledger polling requests deltas and pauses in hidden tabs", () => {
  assert.match(clientSource, /if \(document\.hidden \|\| state\.realtimeInFlight\) return/);
  assert.match(clientSource, /extra\.since = String/);
  assert.match(clientSource, /state\.realtimeCursor/);
  assert.match(clientSource, /visibilitychange/);
});

test("restored listener searches rerun and normalize full-width IDs", () => {
  const match = clientSource.match(/function normalizeListenerSearch\(value\) \{([\s\S]*?)\n\}/);
  assert.ok(match, "search normalizer should exist");
  const normalizeSearch = new Function("value", match[1]);

  assert.equal(normalizeSearch("＠ｕｓｅｒ"), "user");
  assert.match(clientSource, /refreshRestoredSearch/);
  assert.match(clientSource, /window\.addEventListener\("pageshow", scheduleRestoredSearchChecks\)/);
  assert.match(clientSource, /\[50, 250, 750, 1500, 3000\]/);
  assert.match(clientSource, /search === state\.pendingListenerSearch/);
  assert.match(clientSource, /を検索中…/);
  assert.match(serverSource, /normalizeListenerSearch\(url\.searchParams\.get\("search"\)/);
  assert.match(htmlSource, />全データを再読み込み</);
});

test("listener rows show a clear follow state while profile totals stay in details", () => {
  assert.match(htmlSource, /<th>あなたをフォロー<\/th>/);
  assert.match(clientSource, /フォロー中/);
  assert.match(clientSource, /未フォロー/);
  assert.match(clientSource, /未確認/);
  assert.match(clientSource, /TikTokプロフィール/);
  assert.match(clientSource, /本人のフォロー数/);
  assert.match(clientSource, /本人のフォロワー数/);
  assert.match(clientSource, /未確認は未フォローという意味ではありません/);
  assert.match(clientSource, /TikTokプロフィールを開く/);
  assert.match(clientSource, /https:\/\/www\.tiktok\.com\/@/);
  assert.match(clientSource, /rel="noopener noreferrer"/);
});

test("listener manager shows relative lifetime and recent contribution ranks", () => {
  assert.match(htmlSource, /value="contribution">総合ランク順/);
  assert.match(htmlSource, /value="recent_contribution">直近30日ランク順/);
  assert.match(htmlSource, /<th>ランク<\/th>/);
  assert.match(htmlSource, /<th>全コイン<\/th>/);
  assert.match(clientSource, /function contributionCell/);
  assert.match(clientSource, /contributionRank/);
  assert.match(clientSource, /recentContributionRank/);
  assert.match(clientSource, /Number\(score\) < 0/);
  assert.match(clientSource, /ランキング対象コイン/);
  assert.match(clientSource, /1来訪あたり対象コイン/);
  assert.match(clientSource, /query\.set\("fresh","1"\)/);
  assert.match(serverSource, /listenerContributionPage/);
});

test("listener manager can manage automatically classified lurkers", () => {
  assert.match(htmlSource, /id="classificationFilter"/);
  assert.match(htmlSource, /value="lurker">潜り人のみ/);
  assert.match(htmlSource, /value="lurker">潜り傾向が強い順/);
  assert.match(clientSource, /lurker-badge/);
  assert.match(clientSource, /来訪5回以上/);
  assert.match(eventStoreSource, /listenerLurkerIds/);
  assert.match(eventStoreSource, /lurkers/);
});

test("listener manager exposes a manual super lurker flag", () => {
  assert.match(clientSource, /class="super-lurker-toggle"/);
  assert.match(clientSource, /isSuperLurker:Boolean\(input\.checked\)/);
  assert.match(clientSource, /スーパー潜り人（配信中に来たらスマホへ大きく表示）/);
  assert.match(serverSource, /type: "super_lurker_alert"/);
  assert.match(serverSource, /this\.superLurkerAlertedIds\.add/);
});
