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

test("event stream keepalives recover a silently stalled display without polling", () => {
  assert.match(serverSource, /send\(\{\s*type:\s*"heartbeat",\s*payload:\s*\{\s*at:\s*Date\.now\(\)\s*\}\s*\}\)/);
  assert.match(serverSource, /clearInterval\(keepAliveTimer\)/);
  assert.match(clientSource, /addEventListener\("heartbeat",\s*\(\)\s*=>\s*markEventStreamActivity\(sessionId\)\)/);
  assert.match(clientSource, /function checkEventStreamHealth\(\)[\s\S]*?Date\.now\(\)\s*-\s*45000[\s\S]*?scheduleReconnect\(\)/);
  const watchdog = clientSource.match(/function checkEventStreamHealth\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(watchdog, /fetch\s*\(/);
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
  assert.match(serverSource, /durable:\s*incoming\.length === 0 \|\| eventStore\.status\(\)\.ready/);
  assert.match(collectorSource, /\$delivery\.durable -ne \$true/);
  assert.match(collectorSource, /if \(-not \(Flush-PendingEvents -Config \$config\)\) \{ break \}/);
  assert.match(collectorSource, /\$pending\.Count -ge 5000/);
  assert.match(collectorSource, /while \(\$pending\.Count -gt 0\)/);
});
