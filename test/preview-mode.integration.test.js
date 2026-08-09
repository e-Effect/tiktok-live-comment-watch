import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const port = 39000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const collectorKey = "collector-test-key";
const adminKey = "0131";

test("preview events stay out of the recorded session and normal routing resumes after stop", async (t) => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      LIVE_SOURCE: "collector",
      COLLECTOR_INGEST_KEY: collectorKey,
      LISTENER_ADMIN_KEY: adminKey,
      DATABASE_URL: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill());
  await waitForServer(child);

  const normal = await postJson("/api/session", { username: "my_account" });
  const preview = await postJson("/api/session", { username: "other_live", preview: true }, adminKey);
  assert.equal(preview.preview, true);

  const demo = await postJson(`/api/session/${preview.id}/demo`, {}, adminKey);
  assert.equal(demo.preview, true);
  assert.equal(demo.commentCount, 1);
  assert.equal(demo.giftCount, 3);

  const routedPreview = await postCollector("my_account", "preview-comment");
  assert.equal(routedPreview.preview, true);
  assert.equal((await getJson(`/api/session/${preview.id}/snapshot`)).commentCount, 2);
  assert.equal((await getJson(`/api/session/${normal.id}/snapshot`)).commentCount, 0);

  await postJson(`/api/session/${preview.id}/stop`, {});
  const routedNormal = await postCollector("my_account", "normal-comment");
  assert.equal(routedNormal.preview, false);
  assert.equal((await getJson(`/api/session/${normal.id}/snapshot`)).commentCount, 1);
});

async function waitForServer(child) {
  let output = "";
  const collect = (chunk) => { output += chunk.toString(); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
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

async function postCollector(streamUsername, messageId) {
  const response = await fetch(`${baseUrl}/api/collector/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${collectorKey}`
    },
    body: JSON.stringify({
      streamUsername,
      events: [{
        event: "chat",
        data: {
          msgId: messageId,
          comment: messageId,
          user: { id: `user-${messageId}`, uniqueId: `viewer_${messageId}`, nickname: "viewer" }
        }
      }]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 202, JSON.stringify(body));
  return body;
}

async function postJson(path, body, key = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const payload = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}
