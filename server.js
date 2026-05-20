import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

if (!globalThis.process) {
  globalThis.process = { env: {} };
}

const PORT = Number(globalThis.__TIKTOK_LIVE_PORT__ || globalThis.process?.env?.PORT || 3030);
const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const sessions = new Map();
const SESSION_TTL_MS = Number(globalThis.process?.env?.SESSION_TTL_MS || 1000 * 60 * 60 * 6);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

class LiveSession extends EventEmitter {
  constructor(username, requestedMode) {
    super();
    this.id = randomUUID();
    this.username = username;
    this.requestedMode = requestedMode;
    this.mode = "connecting";
    this.status = "connecting";
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.commentCount = 0;
    this.comments = [];
    this.userStats = new Map();
    this.viewerStats = {
      current: 0,
      peak: 0,
      knownJoins: 0,
      estimatedWatchSeconds: 0
    };
    this.notice = "";
    this.joinedAt = new Map();
    this.connection = null;
    this.demoTimer = null;
  }

  async start() {
    if (this.requestedMode === "demo") {
      this.startDemo("デモモードで開始しました。");
      return;
    }

    const connector = await loadTikTokConnector();
    if (!connector) {
      this.startDemo("tiktok-live-connector が未導入のため、デモモードで開始しました。");
      return;
    }

    try {
      this.mode = "live";
      this.status = "connecting";
      this.broadcast("status", this.snapshot("TikTok LIVEへ接続中です。"));
      const state = await this.connectLiveWithRetries(connector);
      this.status = "live";
      this.broadcast("status", this.snapshot(`LIVE接続を開始しました。roomId: ${state?.roomId || this.connection.roomId || "取得済み"}`));
    } catch (error) {
      this.mode = "demo";
      this.status = "demo";
      this.startDemo(`実接続失敗: ${diagnoseConnectError(error)} デモモードへ切り替えました。`);
    }
  }

  async connectLiveWithRetries(connector) {
    let lastError = null;
    const attempts = [
      { processInitialData: true, fetchRoomInfoOnConnect: true },
      { processInitialData: false, fetchRoomInfoOnConnect: true },
      { processInitialData: false, fetchRoomInfoOnConnect: false }
    ];

    for (let index = 0; index < attempts.length; index += 1) {
      const options = {
        ...attempts[index],
        enableExtendedGiftInfo: false,
        enableRequestPolling: true,
        requestPollingIntervalMs: 1000,
        connectWithUniqueId: false,
        logFetchFallbackErrors: true,
        webClientOptions: { timeout: 15000 },
        websocketOptions: { timeout: 15000 },
        wsClientOptions: { timeout: 15000 }
      };

      const connection = new connector.Connection(this.username, options);
      this.attachLiveHandlers(connection, connector.events);
      this.connection = connection;
      this.broadcast("status", this.snapshot(`TikTok LIVEへ接続中です。試行 ${index + 1}/${attempts.length}`));

      try {
        return await connection.connect();
      } catch (error) {
        lastError = error;
        await Promise.resolve(connection.disconnect?.()).catch(() => {});
        if (index < attempts.length - 1) {
          await delay(1200 + index * 1000);
        }
      }
    }

    throw lastError;
  }

  attachLiveHandlers(connection, events = {}) {
    connection.on(events.CHAT || "chat", (data) => {
      const nickname = data.nickname || data.user?.nickname || data.user?.uniqueId || data.uniqueId || "unknown";
      const uniqueId = data.user?.uniqueId || data.uniqueId || nickname;
      this.addComment({
        id: data.msgId || randomUUID(),
        userId: uniqueId,
        nickname,
        text: data.comment || "",
        at: Date.now()
      });
    });

    connection.on(events.MEMBER || "member", (data) => {
      const userId = data.user?.uniqueId || data.uniqueId || data.nickname || randomUUID();
      this.markJoin(userId);
    });

    connection.on(events.ROOM_USER || "roomUser", (data) => {
      const current = Number(data.viewerCount || data.userCount || 0);
      if (current > 0) {
        this.viewerStats.current = current;
        this.viewerStats.peak = Math.max(this.viewerStats.peak, current);
        this.broadcast("status", this.snapshot());
      }
    });

    connection.on(events.STREAM_END || "streamEnd", () => {
      this.status = "ended";
      this.stop("LIVEが終了しました。");
    });

    connection.on(events.DISCONNECTED || "disconnected", () => {
      if (!this.stoppedAt) {
        this.status = "disconnected";
        this.broadcast("status", this.snapshot("接続が切れました。"));
      }
    });

    connection.on(events.ERROR || "error", (error) => {
      this.broadcast("status", this.snapshot(`接続エラー: ${diagnoseConnectError(error)}`));
    });
  }

  startDemo(message) {
    this.mode = "demo";
    this.status = "demo";
    this.notice = message;
    this.broadcast("status", this.snapshot(message));

    const names = [
      ["mika_live", "盛り上がってきた"],
      ["sora88", "今の説明わかりやすい"],
      ["yuto", "初見です"],
      ["nana", "もう一回見たい"],
      ["kei_stream", "コメント拾ってくれてありがとう"],
      ["riko", "この時間帯いいですね"]
    ];

    this.demoTimer = setInterval(() => {
      const sample = names[Math.floor(Math.random() * names.length)];
      const userId = sample[0];
      if (Math.random() > 0.55) this.markJoin(userId);
      this.viewerStats.current = 12 + Math.floor(Math.random() * 18);
      this.viewerStats.peak = Math.max(this.viewerStats.peak, this.viewerStats.current);
      this.addComment({
        id: randomUUID(),
        userId,
        nickname: sample[0],
        text: sample[1],
        at: Date.now()
      });
    }, 1600);
  }

  markJoin(userId) {
    if (!this.joinedAt.has(userId)) {
      this.joinedAt.set(userId, Date.now());
      this.viewerStats.knownJoins += 1;
    }
  }

  addComment(comment) {
    this.commentCount += 1;
    this.comments.unshift(comment);
    this.comments = this.comments.slice(0, 200);

    const current = this.userStats.get(comment.userId) || {
      userId: comment.userId,
      nickname: comment.nickname,
      comments: 0,
      firstSeenAt: comment.at,
      lastSeenAt: comment.at
    };
    current.nickname = comment.nickname || current.nickname;
    current.comments += 1;
    current.lastSeenAt = comment.at;
    this.userStats.set(comment.userId, current);
    this.broadcast("comment", { comment, snapshot: this.snapshot() });
  }

  snapshot(message = "") {
    if (message) this.notice = message;
    this.updateEstimatedWatch();
    const topUsers = [...this.userStats.values()]
      .sort((a, b) => b.comments - a.comments || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 30);

    return {
      id: this.id,
      username: this.username,
      mode: this.mode,
      status: this.status,
      message: message || this.notice,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      elapsedSeconds: Math.floor(((this.stoppedAt || Date.now()) - this.startedAt) / 1000),
      commentCount: this.commentCount,
      comments: this.comments,
      topUsers,
      viewerStats: this.viewerStats
    };
  }

  updateEstimatedWatch() {
    if (this.joinedAt.size === 0) return;
    const now = this.stoppedAt || Date.now();
    this.viewerStats.estimatedWatchSeconds = [...this.joinedAt.values()]
      .reduce((total, joined) => total + Math.max(0, now - joined) / 1000, 0);
  }

  broadcast(type, payload) {
    this.emit("event", { type, payload });
  }

  stop(message = "停止しました。") {
    if (this.stoppedAt) return;
    this.stoppedAt = Date.now();
    this.status = this.status === "ended" ? "ended" : "stopped";
    if (this.demoTimer) clearInterval(this.demoTimer);
    if (this.connection?.disconnect) {
      Promise.resolve(this.connection.disconnect()).catch(() => {});
    }
    this.broadcast("status", this.snapshot(message));
  }

  toCsv() {
    const rows = [["time", "user_id", "nickname", "comment"]];
    for (const comment of [...this.comments].reverse()) {
      rows.push([
        new Date(comment.at).toISOString(),
        comment.userId,
        comment.nickname,
        comment.text
      ]);
    }
    return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  }
}

async function loadTikTokConnector() {
  try {
    const mod = await import("tiktok-live-connector");
    const Connection = mod.TikTokLiveConnection || mod.WebcastPushConnection || mod.default?.TikTokLiveConnection || mod.default?.WebcastPushConnection;
    return Connection ? { Connection, events: mod.WebcastEvent || {} } : null;
  } catch {
    return null;
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function shortError(error) {
  return String(error?.message || error || "不明なエラー").slice(0, 180);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function diagnoseConnectError(error) {
  const raw = [
    error?.message,
    error?.info,
    error?.exception?.message,
    error?.cause?.message,
    typeof error === "string" ? error : ""
  ].filter(Boolean).join(" / ");
  const text = raw || "不明なエラー";

  if (/not live|offline|room.*not|user.*not|invalid/i.test(text)) {
    return `${shortError(text)} アカウント名かLIVE状態の判定で失敗しています。`;
  }
  if (/captcha|verify|blocked|403|401|signature|sign/i.test(text)) {
    return `${shortError(text)} TikTok側の検証または署名処理で止まっています。`;
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(text)) {
    return `${shortError(text)} ネットワークまたは外部署名サービスへの接続で止まっています。`;
  }
  return shortError(text);
}

function isValidUsername(username) {
  return /^[A-Za-z0-9_.]{2,32}$/.test(username);
}

function normalizeTikTokUsername(value) {
  const raw = String(value || "").trim();
  const urlMatch = raw.match(/tiktok\.com\/@([A-Za-z0-9_.]+)/i);
  return (urlMatch?.[1] || raw).replace(/^@/, "").replace(/\/live\/?$/i, "").trim();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

async function serveStatic(response, urlPath) {
  const filePath = urlPath === "/" ? "/index.html" : urlPath;
  const normalized = normalize(join(PUBLIC_DIR, filePath));
  if (!normalized.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(normalized);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(normalized)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(data);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "POST" && url.pathname === "/api/session") {
    try {
      const body = await readBody(request);
      const username = normalizeTikTokUsername(body.username);
      const mode = body.mode === "demo" ? "demo" : "auto";
      if (!isValidUsername(username)) {
        sendJson(response, 400, { error: "TikTok IDは2から32文字の英数字、_、.で入力してください。" });
        return;
      }
      const session = new LiveSession(username, mode);
      sessions.set(session.id, session);
      sendJson(response, 201, { id: session.id });
      session.start();
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      sessions: sessions.size,
      uptimeSeconds: Math.floor(getUptimeSeconds())
    });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/([^/]+))?$/);
  if (sessionMatch) {
    const session = sessions.get(sessionMatch[1]);
    const action = sessionMatch[2] || "";
    if (!session) {
      sendJson(response, 404, { error: "セッションが見つかりません。" });
      return;
    }

    if (request.method === "GET" && action === "events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });
      const send = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      send({ type: "status", payload: session.snapshot() });
      session.on("event", send);
      request.on("close", () => session.off("event", send));
      return;
    }

    if (request.method === "GET" && action === "snapshot") {
      sendJson(response, 200, session.snapshot());
      return;
    }

    if (request.method === "GET" && action === "export.csv") {
      response.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${session.username}-comments.csv"`
      });
      response.end(session.toCsv());
      return;
    }

    if (request.method === "POST" && action === "stop") {
      session.stop();
      sendJson(response, 200, session.snapshot());
      return;
    }
  }

  if (request.method === "GET") {
    await serveStatic(response, url.pathname);
    return;
  }

  response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`TikTok LIVE app: http://localhost:${PORT}`);
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if ((session.stoppedAt || session.startedAt) + SESSION_TTL_MS < now) {
      session.stop("古い計測を自動停止しました。");
      sessions.delete(id);
    }
  }
}, 1000 * 60 * 10).unref?.();

function getUptimeSeconds() {
  if (typeof globalThis.process?.uptime === "function") {
    return globalThis.process.uptime();
  }
  return 0;
}
