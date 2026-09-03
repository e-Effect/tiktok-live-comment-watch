import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
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
  assert.match(clientSource, /if \(clockRenderTick % 5 === 0\)/);
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
  assert.match(clientSource, /if \(dirty\("comment", "presence", "status"\)\) renderComments/);
  assert.match(clientSource, /if \(heavyDue && dirty\("comment", "gift", "presence", "status"\)\)/);
});

test("the one-second clock updates live counters without rebuilding every panel", () => {
  const clock = clientSource.match(/function startSnapshotClock\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(clock, /renderSelectedSessionClock\(\)/);
  assert.doesNotMatch(clock, /renderSelectedSession\(\)|renderSessionCards\(\)/);
  assert.match(clientSource, /function renderSelectedSessionClock\(\) \{[\s\S]*?renderMetrics\(snapshot\)[\s\S]*?renderWatchers\(/);
  assert.match(clientSource, /function updateCachedWatchTimes\([\s\S]*?rebuildRealtimeWatchLists\(/);
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
  assert.match(serverSource, /pendingDatabaseEvents\.length > 10000/);
  assert.match(serverSource, /const durable = incoming\.length === 0 \|\| await session\.awaitCollectorDurability\(\)/);
  assert.match(serverSource, /async awaitCollectorDurability\(\)[\s\S]*?flushPendingDatabaseEvents\(\)/);
  const durability = serverSource.match(/async awaitCollectorDurability\(\) \{[\s\S]*?\n\s*\}/)?.[0] || "";
  assert.doesNotMatch(durability, /retryPendingVisits/);
  assert.doesNotMatch(durability, /await Promise\.allSettled/);
  assert.match(durability, /return eventStore\.status\(\)\.ready/);
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
