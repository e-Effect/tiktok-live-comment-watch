import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("reward API protects reads and writes and reports unavailable DB, not an empty list", async (t) => {
  const port = 43000 + (process.pid % 1000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: "",
      LISTENER_ADMIN_KEY: "reward-test-only",
      LIVE_SOURCE: "collector",
      COLLECTOR_INGEST_KEY: "test-only",
    },
    stdio: "ignore",
  });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try {
      if ((await fetch(base + "/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  for (const [path, method] of [
    ["/api/gift-rewards/streams", "GET"],
    ["/api/gift-rewards?day=2026-10-14&username=host", "GET"],
    ["/api/gift-rewards", "PATCH"],
  ]) {
    assert.equal((await fetch(base + path, { method })).status, 401);
    const authorized = await fetch(base + path, {
      method,
      headers: {
        Authorization: "Bearer reward-test-only",
        ...(method === "PATCH" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "PATCH"
        ? {
            body: JSON.stringify({
              day: "2026-10-14",
              username: "host",
              userId: "person",
              revision: 0,
              chipShipped: true,
            }),
          }
        : {}),
    });
    assert.equal(authorized.status, 503);
    assert.match((await authorized.json()).error, /データベース/);
  }
});
