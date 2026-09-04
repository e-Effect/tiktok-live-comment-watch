import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const port = 41000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const collectorKey = "burst-test-key";

test("a room-user burst does not hold the live comment stream", async (t) => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      LIVE_SOURCE: "collector",
      COLLECTOR_INGEST_KEY: collectorKey,
      DATABASE_URL: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill());
  await waitForServer(child);

  const session = await postJson("/api/session", { username: "burst_account" });
  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/api/session/${session.id}/events`, { signal: controller.signal });
  const eventsPromise = collectEvents(stream, controller, 1400);

  const events = Array.from({ length: 120 }, (_, index) => ({
    event: "roomUser",
    collectorEventId: `room-${index}`,
    collectorReceivedAt: Date.now(),
    data: { viewerCount: 50 + (index % 3) }
  }));
  events.splice(60, 0, {
    event: "chat",
    collectorEventId: "priority-comment",
    collectorReceivedAt: Date.now(),
    data: {
      msgId: "priority-comment",
      comment: "priority-comment",
      user: { id: "priority-user", uniqueId: "priority_user", nickname: "priority user" }
    }
  });
  await postCollector(events);

  const received = await eventsPromise;
  const commentIndex = received.findIndex((item) => item.type === "comment");
  const firstPresenceIndex = received.findIndex((item) => item.type === "presence");
  assert.ok(commentIndex >= 0, JSON.stringify(received));
  assert.ok(firstPresenceIndex < 0 || commentIndex < firstPresenceIndex, JSON.stringify(received));
  assert.ok(received.filter((item) => item.type === "presence").length <= 2, JSON.stringify(received));
});

async function waitForServer(child) {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${output}`);
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function postCollector(events) {
  const response = await fetch(`${baseUrl}/api/collector/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${collectorKey}`
    },
    body: JSON.stringify({ streamUsername: "burst_account", events })
  });
  if (response.status !== 202) assert.fail(await response.text());
}

async function collectEvents(response, controller, durationMs) {
  assert.ok(response.ok);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const items = [];
  let buffer = "";
  const timer = setTimeout(() => controller.abort(), durationMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let splitAt = buffer.indexOf("\n\n");
      while (splitAt >= 0) {
        const block = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const type = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
        if (type) items.push({ type });
        splitAt = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
  }
  return items;
}
