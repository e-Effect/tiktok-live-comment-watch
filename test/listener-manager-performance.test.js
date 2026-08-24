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
  assert.match(clientSource, /window\.addEventListener\("pageshow"/);
  assert.match(serverSource, /normalizeListenerSearch\(url\.searchParams\.get\("search"\)/);
  assert.match(htmlSource, />全データを再読み込み</);
});
