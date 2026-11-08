import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";

const adminKey = "gift-recovery-admin-test-only";
const collectorKey = "gift-recovery-collector-test-only";
const epoch = Date.parse("2026-11-08T00:00:00Z");

test("gift recovery traverses the HTTP API, authentication and real SQL", { timeout: 30000 }, async (t) => {
  const server = await startServer(t, adminKey);
  const before = await server.audit();

  await t.test("recovers an older gift behind 300 newer comments", async () => {
    const ordinary = await server.get({ username: "busy_host" });
    assert.equal(ordinary.items.length, 100);
    assert.ok(ordinary.items.every(item => item.type === "comment"));
    assert.equal(ordinary.items[0].id, "comment-300");
    assert.equal(ordinary.items.at(-1).id, "comment-201");

    const recovered = await server.get({ username: "busy_host", eventType: "gift" });
    assert.deepEqual(recovered.items.map(item => item.id), ["missed-gift"]);
    const gift = recovered.items[0];
    assert.equal(gift.type, "gift");
    assert.equal(gift.at, epoch + 1000);
    assert.equal(gift.streamUsername, "busy_host");
    assert.equal(gift.userId, "12345");
    assert.equal(gift.uniqueId, "listener");
    assert.equal(gift.nickname, "テスト視聴者");
    assert.equal(gift.giftId, "7934");
    assert.equal(gift.giftName, "Heart Me");
    assert.equal(gift.count, 2);
    assert.equal(gift.coins, 10);
    assert.equal(gift.giftImageUrl, "/test-gift.png");
    assert.equal(gift.slotExcluded, true);
    assert.deepEqual(await server.get({ username: "busy_host" }), ordinary,
      "gift recovery must not change the ordinary feed");
  });

  await t.test("keeps mixed history, ordering and existing exclusions", async () => {
    const history = await server.get({ username: "filter_host" });
    assert.deepEqual(history.items.map(item => item.id),
      ["filter-comment", "filter-gift-3", "filter-gift-2", "filter-gift-1"]);
    assert.deepEqual(history.items.map(item => item.type), ["comment", "gift", "gift", "gift"]);
    const all = await server.get({ limit: 1000 });
    assert.equal(all.items.length, 250);
    assert.ok(all.items.every(item => item.type === "comment"));
    const gifts = await server.get({ eventType: "gift", limit: 1000 });
    assert.equal(gifts.items.length, 250);
    assert.ok(gifts.items.every(item => item.type === "gift"));
    assert.equal(gifts.items[0].id, "other-gift", "omitting username includes other streams");
  });

  await t.test("combines normalized stream, exclusive since and limit before returning gifts", async () => {
    for (const username of ["@FILTER_HOST", "https://www.tiktok.com/@FILTER_HOST/live"]) {
      const result = await server.get({ username, eventType: "gift", since: epoch + 1000, limit: 1 });
      assert.deepEqual(result.items.map(item => item.id), ["filter-gift-3"]);
    }
    const since = await server.get({ username: "filter_host", eventType: "gift", since: epoch + 2000 });
    assert.deepEqual(since.items.map(item => item.id), ["filter-gift-3"], "since is strictly exclusive");
    assert.deepEqual((await server.get({ username: "filter_host", eventType: "gift", since: epoch + 3000 })).items, []);
    assert.deepEqual((await server.get({ username: "missing_host", eventType: "gift" })).items, []);
    const ordinary = await server.get({ username: "filter_host", since: epoch + 2000, limit: 2 });
    assert.deepEqual(ordinary.items.map(item => item.id), ["filter-comment", "filter-gift-3"]);
  });

  await t.test("applies default, minimum and maximum limits to the filtered result", async () => {
    for (const [limit, expected] of [[undefined, 100], [0, 100], [-1, 1], [2, 2], [250, 250], [1000, 250]]) {
      const params = { username: "bulk_host", eventType: "gift" };
      if (limit !== undefined) params.limit = limit;
      const result = await server.get(params);
      assert.equal(result.items.length, expected, `limit=${limit}`);
      assert.equal(result.items[0].id, "bulk-gift-260");
      assert.equal(result.items.at(-1).id, `bulk-gift-${261 - expected}`);
    }
  });

  await t.test("ignores unsupported event types and binds search values safely", async () => {
    const ordinary = await server.get({ username: "filter_host" });
    for (const eventType of ["", "comment", "Gift", "gift' OR 1=1 --"]) {
      assert.deepEqual(await server.get({ username: "filter_host", eventType }), ordinary);
    }
    assert.deepEqual((await server.get({ username: "filter_host' OR 1=1 --", eventType: "gift" })).items, []);
    assert.deepEqual(await server.get({ username: "filter_host", eventType: "gift", since: -1 }),
      await server.get({ username: "filter_host", eventType: "gift" }));
  });

  await t.test("rejects missing, wrong and collector credentials before querying the database", async () => {
    for (const params of [{ username: "busy_host" }, { username: "busy_host", eventType: "gift" }]) {
      for (const key of ["", "wrong", collectorKey]) {
        const audit = await server.audit();
        const response = await server.request(params, key);
        assert.equal(response.status, 401);
        const body = await response.json();
        assert.equal(typeof body.error, "string");
        assert.equal(body.items, undefined);
        assert.equal((await server.audit()).queryCount, audit.queryCount);
      }
      assert.equal((await server.request(params)).status, 200);
    }
  });

  const after = await server.audit();
  assert.deepEqual(after.rows, before.rows, "HTTP reads must not mutate stored comments or gifts");
});

test("history API remains unavailable when the admin key is not configured", { timeout: 30000 }, async (t) => {
  const server = await startServer(t, "");
  const before = await server.audit();
  for (const eventType of ["", "gift"]) {
    const response = await server.request({ eventType });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
    assert.equal(body.items, undefined);
  }
  const after = await server.audit();
  assert.equal(after.queryCount, before.queryCount);
  assert.deepEqual(after.rows, before.rows);
});

async function startServer(t, key) {
  const child = fork(new URL("./fixtures/gift-recovery-server.mjs", import.meta.url), [], {
    // Do not inherit DATABASE_URL, API credentials, NODE_OPTIONS or live settings.
    env: {
      PATH: process.env.PATH,
      PORT: "3030",
      DATABASE_URL: "",
      LISTENER_ADMIN_KEY: key,
      LIVE_SOURCE: "collector",
      COLLECTOR_INGEST_KEY: collectorKey,
      DATABASE_RETRY_MS: "3600000"
    },
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  const collect = chunk => { output = (output + chunk).slice(-8000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  });

  function message(type, send) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}: ${output}`)), 15000);
      const onMessage = value => { if (value.type === type) finish(null, value); };
      const onExit = (code, signal) => finish(new Error(`Fixture exited (${code ?? signal}): ${output}`));
      const onError = error => finish(error);
      function finish(error, value) {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onError);
        if (error) reject(error); else resolve(value);
      }
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onError);
      send?.();
    });
  }

  const { port } = await message("ready");
  const base = `http://127.0.0.1:${port}`;
  const request = (params = {}, auth = adminKey) => fetch(`${base}/api/listeners/events?${new URLSearchParams(params)}`, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
    signal: AbortSignal.timeout(5000)
  });
  return {
    request,
    audit: () => message("audit", () => child.send({ type: "audit" })),
    async get(params) {
      const response = await request(params);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /application\/json/);
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ["items"]);
      assert.ok(Array.isArray(body.items));
      return body;
    }
  };
}
