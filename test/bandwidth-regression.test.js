import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EventStore } from "../lib/event-store.js";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const collectorSource = await readFile(new URL("../collector/windows/TikFinityCollector.ps1", import.meta.url), "utf8");

test("realtime events send deltas instead of repeating the complete snapshot", () => {
  assert.doesNotMatch(serverSource, /snapshot:\s*this\.snapshot\(\)/);
  assert.match(serverSource, /this\.broadcast\("comment",\s*\{[\s\S]*?summary:\s*this\.summary\(\)/);
  assert.match(serverSource, /this\.broadcast\("gift",\s*\{[\s\S]*?summary:\s*this\.summary\(\)/);
  assert.match(serverSource, /this\.broadcast\("share",\s*\{[\s\S]*?summary:\s*this\.summary\(\)/);
});

test("browser reconciles full state once per minute and consumes delta events", () => {
  assert.match(clientSource, /snapshotFetchTick\s*%\s*60/);
  assert.match(clientSource, /addEventListener\("snapshot"/);
  assert.match(clientSource, /applyRealtimePayload\(sessionId,\s*"comment"/);
  assert.match(clientSource, /applyRealtimePayload\(sessionId,\s*"gift"/);
  assert.match(clientSource, /applyRealtimePayload\(sessionId,\s*"share"/);
});

test("realtime rendering prioritizes comments and gifts while batching noisy presence updates", () => {
  assert.match(clientSource, /function scheduleRealtimeRender\(sessionId, type = "status"\)/);
  assert.match(clientSource, /const urgent = \["comment", "gift", "share"\]\.includes\(type\)/);
  assert.match(clientSource, /const delayMs = urgent \? 60 : 400/);
  assert.match(clientSource, /renderSelectedSession\(\{ dirtyTypes: pending\.types \}\)/);
  assert.match(clientSource, /function scheduleRealtimeListRebuild\(sessionId\)/);
  assert.match(clientSource, /Math\.max\(0, 1000 - \(Date\.now\(\) - lastRebuildAt\)\)/);
  const realtimePayload = clientSource.match(/function applyRealtimePayload\(sessionId, type, payload\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(realtimePayload, /rebuildRealtimeLists\(/);
});

test("server limits super lurker checks to entry events and coalesces presence updates", () => {
  assert.match(serverSource, /const SUPER_LURKER_ALERT_TYPES = new Set\(\["join"\]\)/);
  assert.match(serverSource, /PRESENCE_BROADCAST_INTERVAL_MS/);
  assert.match(serverSource, /this\.presenceBroadcastTimer = setTimeout\(\(\) => this\.flushPresenceBroadcast\(\), waitMs\)/);
  assert.match(serverSource, /SECONDARY_SUMMARY_INTERVAL_MS/);
});

test("pipeline diagnostics retain bounded latency percentiles", () => {
  assert.match(serverSource, /if \(samples\.length > 300\) samples\.splice/);
  assert.match(serverSource, /pipelineLatencyByType: this\.pipelineLatencySnapshot\(\)/);
  assert.match(serverSource, /p95: Math\.round\(values\[percentileIndex\]\)/);
  assert.match(clientSource, /直近最大300件の95%値/);
});

test("event stream keepalives recover a silently stalled display without polling", () => {
  assert.match(serverSource, /send\(\{\s*type:\s*"heartbeat",\s*payload:\s*\{\s*at:\s*Date\.now\(\)\s*\}\s*\}\)/);
  assert.match(serverSource, /clearInterval\(keepAliveTimer\)/);
  assert.match(clientSource, /addEventListener\("heartbeat",\s*\(\)\s*=>\s*markEventStreamActivity\(sessionId\)\)/);
  assert.match(clientSource, /function checkEventStreamHealth\(\)[\s\S]*?Date\.now\(\)\s*-\s*45000[\s\S]*?scheduleReconnect\(\)/);
  const watchdog = clientSource.match(/function checkEventStreamHealth\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(watchdog, /fetch\s*\(/);
});

test("event stream subscribes before its initial snapshot so comments cannot fall into a connect gap", () => {
  const streamRoute = serverSource.match(/if \(request\.method === "GET" && action === "events"\) \{[\s\S]*?\n\s*return;\n\s*\}/)?.[0] || "";
  assert.ok(streamRoute.indexOf('session.on("event", send)') < streamRoute.indexOf('type: "snapshot"'));
});

test("busy comment streams throttle expensive secondary panels without delaying the comment list", () => {
  assert.match(clientSource, /const lastHeavyRealtimeRenderAt = new Map\(\)/);
  assert.match(clientSource, /now - lastHeavyAt >= 1000/);
  assert.match(clientSource, /if \(dirty\("comment", "status"\)\) renderComments/);
  assert.doesNotMatch(clientSource, /if \(dirty\("comment", "presence", "status"\)\) renderComments/);
  assert.match(clientSource, /function refreshVisibleCommentRows\(comments, changedUserIds\)/);
  assert.match(clientSource, /data-user-id=/);
  assert.match(clientSource, /if \(heavyDue && dirty\("comment", "gift", "presence", "status", "lists"\)\)/);
});

test("presence-only updates avoid rebuilding session cards", () => {
  const realtimeRender = clientSource.match(/function scheduleRealtimeRender\(sessionId, type = "status"\) \{[\s\S]*?\n\}/)?.[0] || "";
  const listRebuild = clientSource.match(/function scheduleRealtimeListRebuild\(sessionId\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(realtimeRender, /\["comment", "gift", "share", "status"\]\.includes\(dirtyType\)/);
  assert.doesNotMatch(listRebuild, /renderSessionCards\(\)/);
});

test("listener identity lookup is cached for repeated events", async () => {
  let queries = 0;
  const store = new EventStore();
  store.ready = true;
  store.pool = { query: async () => { queries += 1; return { rows: [] }; } };
  assert.equal(await store.resolveListenerId("123456789", "ExampleUser"), "123456789");
  assert.equal(await store.resolveListenerId("123456789", "exampleuser"), "123456789");
  assert.equal(queries, 1);
});

test("the one-second clock updates live counters without rebuilding every panel", () => {
  const clock = clientSource.match(/function startSnapshotClock\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(clock, /renderSelectedSessionClock\(\)/);
  assert.doesNotMatch(clock, /renderSelectedSession\(\)|renderSessionCards\(\)/);
  const clockRender = clientSource.match(/function renderSelectedSessionClock\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(clockRender, /renderMetrics\(snapshot\)/);
  assert.doesNotMatch(clockRender, /renderReport|renderWatchers|rebuildRealtimeWatchLists/);
});

test("unreliable viewer-presence panels and counters are removed", () => {
  assert.doesNotMatch(indexSource, /確認済み滞在|滞在中コメ無|現在視聴|推定滞在/);
  assert.doesNotMatch(clientSource, /currentViewers|watchTime|silentLongWatchers|currentViewerRanking|renderWatchers/);
  assert.doesNotMatch(serverSource, /scheduleRoomUserUpdate|updateCurrentViewerRank|estimatedWatchSeconds|confirmedWatchSeconds/);
});

test("unused discovery and gift ranking features are removed while gift history remains", () => {
  assert.doesNotMatch(indexSource, /候補発掘|ギフト別ランキング|ギフトランキング/);
  assert.match(indexSource, /data-panel="giftHistory"/);
  assert.doesNotMatch(clientSource, /setupCandidateTools|refreshTargetGiftRanking|renderGifters|topGifters/);
  assert.doesNotMatch(serverSource, /\/api\/candidates\/discover|action === "gift-ranking"|currentGiftRanking|currentTopGifts/);
});

test("large JSON and event streams enable gzip compression", () => {
  assert.match(serverSource, /gzipSync\(json/);
  assert.match(serverSource, /createGzip\(\{\s*flush:\s*zlibConstants\.Z_SYNC_FLUSH\s*\}\)/);
  assert.match(serverSource, /"Content-Encoding":\s*"gzip"/);
});

test("database outages reconnect and queue realtime events without full snapshots", () => {
  assert.match(serverSource, /DATABASE_RETRY_MS/);
  assert.match(serverSource, /eventStore\.ensureReady\(\)/);
  assert.match(serverSource, /queueDatabaseEvent\(event\)/);
  assert.match(serverSource, /flushPendingDatabaseEvents\(\)/);
  assert.doesNotMatch(serverSource, /pendingDatabaseEvents\.length > 10000\) this\.pendingDatabaseEvents\.shift/);
  assert.match(serverSource, /const durable = incoming\.length === 0 \|\| await session\.awaitCollectorDurability\(\)/);
  assert.match(serverSource, /async awaitCollectorDurability\(\)[\s\S]*?flushPendingDatabaseEvents\(\)/);
  const durability = serverSource.match(/async awaitCollectorDurability\(\) \{[\s\S]*?\n\s*\}/)?.[0] || "";
  assert.doesNotMatch(durability, /retryPendingVisits/);
  assert.doesNotMatch(durability, /await Promise\.allSettled/);
  assert.match(durability, /await this\.flushPendingDatabaseEvents\(\)/);
  assert.match(durability, /eventStore\.status\(\)\.ready && this\.pendingDatabaseEvents\.length === 0/);
  assert.match(serverSource, /this\.persistenceQueues = \{ critical: \[\], background: \[\] \}/);
  assert.match(serverSource, /CRITICAL_PERSISTENCE_TYPES\.has\(event\?\.type\)/);
  assert.match(serverSource, /this\.persistenceQueues\.critical\.shift\(\) \|\| this\.persistenceQueues\.background\.shift\(\)/);
  assert.match(serverSource, /eventStore\.recordEvent\(this, event\)/);
  assert.match(collectorSource, /\$delivery\.durable -ne \$true/);
  assert.match(collectorSource, /function Start-CollectorDelivery/);
  assert.match(collectorSource, /function Complete-CollectorDelivery/);
  assert.match(collectorSource, /function Invoke-CollectorDeliveryPump/);
  assert.match(collectorSource, /collector-pending\.jsonl/);
  assert.match(collectorSource, /function Load-PendingEvents/);
  assert.match(collectorSource, /function Save-PendingEvents/);
  assert.match(collectorSource, /function Add-PendingEvent/);
  assert.match(collectorSource, /\$receiveTask\.Wait\(50\)/);
  assert.doesNotMatch(collectorSource, /\$pending\.Count -ge 5000/);
});

test("gifts and mobile slot events bypass database persistence latency", () => {
  assert.match(serverSource, /publishRealtimeIntegrationEvent\(this, event\)/);
  assert.match(serverSource, /\/api\/integrations\/live-ticket/);
  assert.match(serverSource, /\/api\/integrations\/live-events/);
  assert.match(serverSource, /event: live_event/);
  const giftHandler = serverSource.match(/connection\.on\(events\.GIFT[\s\S]*?\n\s*\}\);/)?.[0] || "";
  assert.match(giftHandler, /this\.addGift\(gift\)/);
  assert.doesNotMatch(giftHandler, /await this\.heartMeHistoryFor/);
  assert.match(collectorSource, /collectorReceivedAt/);
  assert.match(collectorSource, /collectorQueuedAt/);
});

test("collector keeps reading TikFinity while Render delivery is slow or unavailable", () => {
  assert.match(collectorSource, /\$script:deliveryTask = \$http\.SendAsync\(\$request\)/);
  assert.match(collectorSource, /if \(\$null -eq \$script:deliveryTask -or -not \$script:deliveryTask\.IsCompleted\) \{ return \$false \}/);
  assert.match(collectorSource, /Render is unavailable; buffering \$\(\$script:pending\.Count\) events locally/);
  assert.match(collectorSource, /Only a TikFinity\/WebSocket failure reaches this outer handler/);
  assert.doesNotMatch(collectorSource, /\$http\.SendAsync\(\$request\)\.GetAwaiter\(\)\.GetResult\(\)/);
});

test("collector persists each event before background delivery and throttles status disk writes", () => {
  const receiveBranch = collectorSource.match(/if \(\$allowedEvents -contains[\s\S]*?else \{/i)?.[0] || "";
  assert.ok(receiveBranch.indexOf("Add-PendingEvent -Raw $raw") < receiveBranch.indexOf("Invoke-CollectorDeliveryPump -Config $config"));
  assert.match(collectorSource, /\$nowValue - \$script:lastStatusWriteAt\)\.TotalMilliseconds -lt 1000/);
  assert.match(collectorSource, /Write-CollectorStatus -State 'receiving'[\s\S]*?-PendingCount \$pending\.Count/);
  assert.match(collectorSource, /\[IO\.File\]::WriteAllLines\(\$tempPath, \$lines, \[Text\.Encoding\]::UTF8\)/);
  assert.match(collectorSource, /function Save-PendingEventsIfDue/);
  assert.match(collectorSource, /\$script:pendingFileDirty = \$true/);
  assert.match(collectorSource, /TotalMilliseconds -lt 1000/);
  assert.match(collectorSource, /TotalSeconds -ge 10/);
  assert.match(collectorSource, /\$localOnlyEvents = @\('roomuser', 'roomuserseq'\)/);
  assert.match(collectorSource, /do not use disk\/network/);
  const deliveryCompletion = collectorSource.match(/function Complete-CollectorDelivery \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(deliveryCompletion, /Save-PendingEvents\s*\}/);
});

test("listener admin authentication rate limits repeated failures", () => {
  assert.match(serverSource, /const listenerAuthAttempts = new Map\(\)/);
  assert.match(serverSource, /current\.count >= 20/);
  assert.match(serverSource, /sendJson\(response, 429/);
  assert.match(serverSource, /listenerAuthAttempts\.delete\(listenerAuthClientKey\(request\)\)/);
});

test("the viewer exposes one combined preflight system check", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="systemCheckBtn"[^>]*>配信前総合診断/);
  assert.match(clientSource, /function runSystemCheck\(\)/);
  assert.match(clientSource, /count-pocket\.a-line\.workers\.dev\/api\/live-feed/);
  assert.match(clientSource, /sharedReceiptPendingCount/);
  assert.match(serverSource, /pendingReceiptEvents:\s*Math\.max/);
  assert.match(serverSource, /printerVerified:\s*receipt\.printerVerified === true/);
});
