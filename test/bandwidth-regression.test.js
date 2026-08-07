import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

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

test("large JSON and event streams enable gzip compression", () => {
  assert.match(serverSource, /gzipSync\(json/);
  assert.match(serverSource, /createGzip\(\{\s*flush:\s*zlibConstants\.Z_SYNC_FLUSH\s*\}\)/);
  assert.match(serverSource, /"Content-Encoding":\s*"gzip"/);
});
