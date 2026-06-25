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
const SESSION_TTL_MS = Number(globalThis.process?.env?.SESSION_TTL_MS || 1000 * 60 * 60 * 24);
let connectionPauseUntil = 0;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

class LiveSession extends EventEmitter {
  constructor(username) {
    super();
    this.id = randomUUID();
    this.username = username;
    this.mode = "connecting";
    this.status = "connecting";
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.commentCount = 0;
    this.initialCommentCount = 0;
    this.giftCount = 0;
    this.initialGiftCount = 0;
    this.giftDiamondTotal = 0;
    this.comments = [];
    this.gifts = [];
    this.userStats = new Map();
    this.displayNameIndex = new Map();
    this.giftStats = new Map();
    this.viewerStats = {
      current: 0,
      peak: 0,
      knownJoins: 0,
      estimatedWatchSeconds: 0,
      currentRanked: 0,
      rankUpdatedAt: null
    };
    this.currentViewerIds = new Set();
    this.currentViewerRankUpdatedAt = null;
    this.notice = "";
    this.errorCode = "";
    this.displayName = username;
    this.connectedAt = null;
    this.lastEventAt = null;
    this.connection = null;
    this.lastAccessAt = Date.now();
    this.initialDataUntil = 0;
    this.isConnectingWithInitialData = false;
  }

  async start() {
    const connector = await loadTikTokConnector();
    if (!connector) {
      this.fail("tiktok-live-connector が未導入のため、実接続を開始できません。");
      return;
    }

    try {
      this.mode = "live";
      this.status = "connecting";
      this.broadcast("status", this.snapshot("TikTok LIVEへ接続中です。"));
      const state = await this.connectLiveWithRetries(connector);
      this.displayName = displayNameFromRoomInfo(state?.roomInfo || this.connection?.roomInfo, this.username);
      this.status = "live";
      this.connectedAt = Date.now();
      this.lastEventAt = this.connectedAt;
      this.broadcast("status", this.snapshot(`LIVE接続を開始しました。RoomId: ${state?.roomId || this.connection.roomId || "取得済み"}`));
    } catch (error) {
      this.fail(`実接続失敗: ${diagnoseConnectError(error)}`, isRateLimitError(error) ? "rate_limited" : "");
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
        enableExtendedGiftInfo: true,
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
      this.isConnectingWithInitialData = Boolean(attempts[index].processInitialData);
      this.initialDataUntil = this.isConnectingWithInitialData ? Date.now() + 15000 : 0;
      this.broadcast("status", this.snapshot(`TikTok LIVEへ接続中です。試行 ${index + 1}/${attempts.length}`));

      try {
        const state = await connection.connect();
        if (this.isConnectingWithInitialData) {
          this.initialDataUntil = Date.now() + 3000;
          setTimeout(() => {
            this.isConnectingWithInitialData = false;
            this.initialDataUntil = 0;
          }, 3000).unref?.();
        }
        return state;
      } catch (error) {
        this.isConnectingWithInitialData = false;
        this.initialDataUntil = 0;
        lastError = error;
        await Promise.resolve(connection.disconnect?.()).catch(() => {});
        if (isRateLimitError(error)) {
          break;
        }
        if (index < attempts.length - 1) {
          await delay(1200 + index * 1000);
        }
      }
    }

    throw lastError;
  }

  attachLiveHandlers(connection, events = {}) {
    connection.on(events.CHAT || "chat", (data) => {
      const person = personFromEvent(data);
      this.markSeen(person, Date.now());
      this.addComment({
        id: data.msgId || randomUUID(),
        userId: person.userId,
        nickname: person.nickname,
        text: data.comment || "",
        at: Date.now(),
        source: this.currentEventSource()
      });
    });

    connection.on(events.GIFT || "gift", (data) => {
      if (data.giftType === 1 && data.repeatEnd === false) return;
      const gift = parseGiftEvent(data);
      gift.source = this.currentEventSource();
      this.markSeen({ userId: gift.userId, nickname: gift.nickname }, gift.at);
      this.addGift(gift);
    });

    connection.on(events.MEMBER || "member", (data) => {
      this.markSeen(personFromEvent(data), Date.now());
    });

    connection.on(events.FOLLOW || "follow", (data) => {
      this.markFollowedToday(personFromEvent(data), Date.now());
    });

    connection.on(events.SOCIAL || "social", (data) => {
      if (isFollowEvent(data)) {
        this.markFollowedToday(personFromEvent(data), Date.now());
      }
    });

    connection.on(events.ROOM_USER || "roomUser", (data) => {
      const now = Date.now();
      const current = Number(data.viewerCount || data.userCount || 0);
      let shouldBroadcast = false;
      if (current > 0) {
        this.viewerStats.current = current;
        this.viewerStats.peak = Math.max(this.viewerStats.peak, current);
        shouldBroadcast = true;
      }
      const rankedCount = this.updateCurrentViewerRank(data, now);
      if (rankedCount !== null) {
        shouldBroadcast = true;
      }
      if (shouldBroadcast) {
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

  markSeen(person, at) {
    this.lastEventAt = Math.max(this.lastEventAt || 0, at);
    const user = this.getUserStat(person.userId, person.nickname, at);
    if (!user.hasJoined) {
      user.hasJoined = true;
      this.viewerStats.knownJoins += 1;
    }
    user.lastSeenAt = Math.max(user.lastSeenAt, at);
    this.userStats.set(user.userId, user);
  }

  markFollowedToday(person, at) {
    this.lastEventAt = Math.max(this.lastEventAt || 0, at);
    const user = this.getUserStat(person.userId, person.nickname, at);
    user.followedToday = true;
    user.followedAt = at;
    user.lastSeenAt = Math.max(user.lastSeenAt, at);
    this.userStats.set(user.userId, user);
    this.broadcast("status", this.snapshot());
  }

  addComment(comment) {
    this.lastEventAt = Math.max(this.lastEventAt || 0, comment.at);
    this.commentCount += 1;
    if (comment.source === "initial") this.initialCommentCount += 1;
    this.comments.unshift(comment);
    this.comments = this.comments.slice(0, 200);

    const current = this.getUserStat(comment.userId, comment.nickname, comment.at);
    current.comments += 1;
    current.lastSeenAt = comment.at;
    this.userStats.set(current.userId, current);
    this.broadcast("comment", { comment, snapshot: this.snapshot() });
  }

  addGift(gift) {
    this.lastEventAt = Math.max(this.lastEventAt || 0, gift.at);
    const repeatCount = Math.max(1, Number(gift.repeatCount || 1));
    const diamondCount = Math.max(0, Number(gift.diamondCount || 0));
    const totalDiamonds = repeatCount * diamondCount;
    const normalizedGift = {
      ...gift,
      repeatCount,
      diamondCount,
      totalDiamonds
    };

    this.giftCount += repeatCount;
    if (gift.source === "initial") this.initialGiftCount += repeatCount;
    this.giftDiamondTotal += totalDiamonds;
    this.gifts.unshift(normalizedGift);
    this.gifts = this.gifts.slice(0, 200);

    const user = this.getUserStat(gift.userId, gift.nickname, gift.at);
    user.gifts += repeatCount;
    user.diamonds += totalDiamonds;
    user.lastSeenAt = gift.at;
    this.userStats.set(user.userId, user);

    const giftKey = `${user.userId}:${gift.giftId || gift.giftName}`;
    const stat = this.giftStats.get(giftKey) || {
      userId: user.userId,
      nickname: user.nickname,
      giftId: gift.giftId,
      giftName: gift.giftName,
      count: 0,
      diamonds: 0,
      lastGiftAt: gift.at
    };
    stat.nickname = user.nickname || stat.nickname;
    stat.giftName = gift.giftName || stat.giftName;
    stat.count += repeatCount;
    stat.diamonds += totalDiamonds;
    stat.lastGiftAt = gift.at;
    this.giftStats.set(giftKey, stat);

    this.broadcast("gift", { gift: normalizedGift, snapshot: this.snapshot() });
  }

  getUserStat(rawUserId, rawNickname, at) {
    const nickname = cleanDisplayName(rawNickname || rawUserId || "unknown");
    const displayKey = displayNameKey(nickname);
    const existingId = this.displayNameIndex.get(displayKey);
    const userId = existingId || cleanUserId(rawUserId || nickname);
    this.displayNameIndex.set(displayKey, userId);

    const current = this.userStats.get(userId) || {
      userId,
      nickname,
      comments: 0,
      gifts: 0,
      diamonds: 0,
      firstSeenAt: at,
      lastSeenAt: at,
      hasJoined: false,
      watchSeconds: 0,
      followedToday: false,
      followedAt: null,
      isCurrentlyRanked: false,
      currentViewerRank: null,
      currentViewerRankedAt: null
    };
    current.nickname = nickname || current.nickname;
    current.firstSeenAt = Math.min(current.firstSeenAt, at);
    current.lastSeenAt = Math.max(current.lastSeenAt, at);
    return current;
  }

  updateCurrentViewerRank(data, at) {
    const { hasPayload, entries } = rankedViewerEntries(data);
    if (!hasPayload) return null;

    for (const user of this.userStats.values()) {
      user.isCurrentlyRanked = false;
      user.currentViewerRank = null;
    }
    this.currentViewerIds.clear();

    entries.forEach((entry, index) => {
      const person = personFromRankedViewer(entry);
      if (!person) return;
      const user = this.getUserStat(person.userId, person.nickname, at);
      if (!user.hasJoined) {
        user.hasJoined = true;
        this.viewerStats.knownJoins += 1;
      }
      user.lastSeenAt = Math.max(user.lastSeenAt, at);
      user.isCurrentlyRanked = true;
      user.currentViewerRank = rankedViewerPosition(entry, index);
      user.currentViewerRankedAt = at;
      this.currentViewerIds.add(user.userId);
      this.userStats.set(user.userId, user);
    });

    this.currentViewerRankUpdatedAt = at;
    this.viewerStats.currentRanked = this.currentViewerIds.size;
    this.viewerStats.rankUpdatedAt = at;
    return this.currentViewerIds.size;
  }

  snapshot(message = "") {
    this.touch();
    if (message) this.notice = message;
    this.updateEstimatedWatch();
    const users = [...this.userStats.values()];
    const topUsers = [...users]
      .sort((a, b) => b.comments - a.comments || b.gifts - a.gifts || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 30);
    const topGifters = [...users]
      .filter((user) => user.gifts > 0 || user.diamonds > 0)
      .sort((a, b) => b.diamonds - a.diamonds || b.gifts - a.gifts || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 30);
    const topWatchers = [...users]
      .filter((user) => user.watchSeconds > 0)
      .sort((a, b) => b.watchSeconds - a.watchSeconds || b.comments - a.comments || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 30);
    const silentLongWatchers = [...users]
      .filter((user) => user.isCurrentlyRanked && user.watchSeconds >= 15 * 60 && user.comments === 0)
      .sort((a, b) => b.watchSeconds - a.watchSeconds || a.currentViewerRank - b.currentViewerRank || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 100);
    const currentViewerRanking = [...users]
      .filter((user) => user.isCurrentlyRanked)
      .sort((a, b) => a.currentViewerRank - b.currentViewerRank || b.watchSeconds - a.watchSeconds || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 100);
    const topGifts = [...this.giftStats.values()]
      .sort((a, b) => b.diamonds - a.diamonds || b.count - a.count || b.lastGiftAt - a.lastGiftAt)
      .slice(0, 30);
    const followedTodayCount = users.filter((user) => user.followedToday).length;

    return {
      id: this.id,
      username: this.username,
      displayName: this.displayName,
      mode: this.mode,
      status: this.status,
      errorCode: this.errorCode,
      message: message || this.notice,
      startedAt: this.startedAt,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventAt,
      stoppedAt: this.stoppedAt,
      elapsedSeconds: Math.floor(((this.stoppedAt || Date.now()) - this.startedAt) / 1000),
      commentCount: this.commentCount,
      initialCommentCount: this.initialCommentCount,
      giftCount: this.giftCount,
      initialGiftCount: this.initialGiftCount,
      initialEventCount: this.initialCommentCount + this.initialGiftCount,
      giftDiamondTotal: this.giftDiamondTotal,
      comments: this.comments,
      gifts: this.gifts,
      topUsers,
      topGifters,
      topWatchers,
      silentLongWatchers,
      currentViewerRanking,
      topGifts,
      followedTodayCount,
      viewerStats: this.viewerStats
    };
  }

  updateEstimatedWatch() {
    const now = this.stoppedAt || Date.now();
    let total = 0;
    for (const user of this.userStats.values()) {
      user.watchSeconds = Math.floor(Math.max(0, now - user.firstSeenAt) / 1000);
      total += user.watchSeconds;
    }
    this.viewerStats.estimatedWatchSeconds = total;
  }

  broadcast(type, payload) {
    this.emit("event", { type, payload });
  }

  currentEventSource() {
    return this.isConnectingWithInitialData || Date.now() < this.initialDataUntil ? "initial" : "live";
  }

  touch() {
    this.lastAccessAt = Date.now();
  }

  fail(message, errorCode = "") {
    this.mode = "error";
    this.status = "stopped";
    this.errorCode = errorCode;
    if (errorCode === "rate_limited") {
      connectionPauseUntil = Math.max(connectionPauseUntil, nextConnectionWindow(Date.now()));
    }
    this.stoppedAt = Date.now();
    this.broadcast("status", this.snapshot(message));
  }

  stop(message = "停止しました。") {
    if (this.stoppedAt) return;
    this.stoppedAt = Date.now();
    this.status = this.status === "ended" ? "ended" : "stopped";
    if (this.connection?.disconnect) {
      Promise.resolve(this.connection.disconnect()).catch(() => {});
    }
    this.broadcast("status", this.snapshot(message));
  }

  toCsv() {
    const rows = [["type", "source", "time", "user_id", "nickname", "text_or_gift", "count", "diamonds", "watch_seconds", "followed_today"]];
    for (const comment of [...this.comments].reverse()) {
      const user = this.userStats.get(comment.userId);
      rows.push([
        "comment",
        comment.source || "live",
        new Date(comment.at).toISOString(),
        comment.userId,
        comment.nickname,
        comment.text,
        "",
        "",
        user?.watchSeconds || "",
        user?.followedToday ? "yes" : ""
      ]);
    }
    for (const gift of [...this.gifts].reverse()) {
      const user = this.userStats.get(gift.userId);
      rows.push([
        "gift",
        gift.source || "live",
        new Date(gift.at).toISOString(),
        gift.userId,
        gift.nickname,
        gift.giftName || gift.giftId,
        gift.repeatCount,
        gift.totalDiamonds,
        user?.watchSeconds || "",
        user?.followedToday ? "yes" : ""
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

async function fetchStreamerProfile(username) {
  const connector = await loadTikTokConnector();
  if (!connector) {
    throw new Error("tiktok-live-connector が未導入のため、名前を取得できません。");
  }

  const connection = new connector.Connection(username, {
    processInitialData: false,
    fetchRoomInfoOnConnect: false,
    enableExtendedGiftInfo: false,
    enableRequestPolling: false,
    connectWithUniqueId: false,
    logFetchFallbackErrors: true,
    webClientOptions: { timeout: 10000 },
    websocketOptions: { timeout: 10000 },
    wsClientOptions: { timeout: 10000 }
  });

  let roomInfo = null;
  const errors = [];
  try {
    if (typeof connection.webClient?.fetchRoomInfoFromHtml === "function") {
      try {
        roomInfo = await connection.webClient.fetchRoomInfoFromHtml({ uniqueId: username });
      } catch (error) {
        errors.push(error);
      }
    }
    if (!roomInfo && typeof connection.webClient?.fetchRoomInfoFromApiLive === "function") {
      try {
        roomInfo = await connection.webClient.fetchRoomInfoFromApiLive({ uniqueId: username });
      } catch (error) {
        errors.push(error);
      }
    }
    if (!roomInfo && typeof connection.fetchRoomInfo === "function") {
      try {
        roomInfo = await connection.fetchRoomInfo();
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    await Promise.resolve(connection.disconnect?.()).catch(() => {});
  }
  if (!roomInfo) {
    throw errors[0] || new Error("表示名を取得できませんでした。");
  }

  const displayName = displayNameFromRoomInfo(roomInfo, username);
  return {
    username,
    displayName,
    ok: displayNameKey(displayName) !== displayNameKey(username),
    fetchedAt: Date.now()
  };
}

function displayNameFromRoomInfo(roomInfo, fallback) {
  const candidates = [
    roomInfo?.user?.nickname,
    roomInfo?.owner?.nickname,
    roomInfo?.ownerUser?.nickname,
    roomInfo?.streamer?.nickname,
    roomInfo?.data?.user?.nickname,
    roomInfo?.data?.owner?.nickname,
    roomInfo?.data?.ownerUser?.nickname,
    roomInfo?.data?.streamer?.nickname,
    roomInfo?.data?.userInfo?.user?.nickname,
    roomInfo?.data?.userInfo?.nickname,
    roomInfo?.data?.liveRoomUserInfo?.user?.nickname,
    roomInfo?.data?.liveRoomUserInfo?.owner?.nickname,
    roomInfo?.liveRoomUserInfo?.user?.nickname,
    roomInfo?.liveRoomUserInfo?.owner?.nickname
  ];
  const direct = candidates.find((value) => isUsableDisplayName(value));
  if (direct) return cleanDisplayName(direct);

  const nested = findNestedDisplayName(roomInfo);
  return nested ? cleanDisplayName(nested) : cleanDisplayName(fallback);
}

function findNestedDisplayName(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return "";
  seen.add(value);
  if (isUsableDisplayName(value.nickname)) return value.nickname;
  for (const child of Object.values(value)) {
    const nested = findNestedDisplayName(child, depth + 1, seen);
    if (nested) return nested;
  }
  return "";
}

function rankedViewerEntries(data) {
  const candidates = [
    data?.topViewers,
    data?.ranksList,
    data?.rankList,
    data?.rankings,
    data?.seatsList,
    data?.users,
    data?.data?.topViewers,
    data?.data?.ranksList,
    data?.message?.topViewers,
    data?.message?.ranksList
  ];
  const entries = candidates.find((value) => Array.isArray(value));
  return {
    hasPayload: Boolean(entries),
    entries: entries || []
  };
}

function personFromRankedViewer(entry) {
  if (!entry || typeof entry !== "object") return null;
  const rawUser = entry.user || entry.userInfo || entry.viewer || entry.author || entry.data?.user || entry;
  const nickname = firstText(
    rawUser.nickname,
    rawUser.displayName,
    rawUser.uniqueId,
    entry.nickname,
    entry.uniqueId
  );
  const userId = firstText(
    rawUser.uniqueId,
    rawUser.userId,
    rawUser.id,
    entry.uniqueId,
    entry.userId,
    nickname
  );
  if (!userId || cleanDisplayName(userId) === "unknown") return null;
  return {
    userId: cleanUserId(userId),
    nickname: cleanDisplayName(nickname || userId)
  };
}

function rankedViewerPosition(entry, index) {
  const rank = Number(entry.rank || entry.rankIndex || entry.position || 0);
  return Number.isFinite(rank) && rank > 0 ? rank : index + 1;
}

function firstText(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim());
}

function personFromEvent(data) {
  const nickname = data.nickname || data.user?.nickname || data.user?.uniqueId || data.uniqueId || "unknown";
  const userId = data.user?.uniqueId || data.uniqueId || data.user?.userId || nickname;
  return {
    userId: cleanUserId(userId),
    nickname: cleanDisplayName(nickname)
  };
}

function parseGiftEvent(data) {
  const person = personFromEvent(data);
  const extended = data.extendedGiftInfo || data.giftDetails || data.gift || {};
  const diamondCount = Number(
    data.diamondCount ||
    data.diamond_count ||
    data.repeatDiamondCount ||
    extended.diamond_count ||
    extended.diamondCount ||
    extended.cost ||
    0
  );
  return {
    id: data.msgId || randomUUID(),
    userId: person.userId,
    nickname: person.nickname,
    giftId: String(data.giftId || extended.id || ""),
    giftName: data.giftName || extended.name || data.giftId || "ギフト",
    repeatCount: Number(data.repeatCount || data.repeat_count || 1),
    diamondCount,
    at: Date.now()
  };
}

function isFollowEvent(data) {
  const text = [
    data.displayType,
    data.label,
    data.type,
    data.action,
    data.event,
    data.socialType,
    data.socialAction,
    data.common?.displayText?.defaultPattern,
    data.common?.displayText?.key,
    data.common?.method
  ].filter(Boolean).join(" ").toLowerCase();
  return /follow|フォロー/.test(text);
}

function cleanDisplayName(value) {
  return String(value || "unknown").trim().replace(/^@/, "") || "unknown";
}

function isUsableDisplayName(value) {
  const text = String(value || "").trim();
  return Boolean(text && text !== "unknown" && !/^\d+$/.test(text));
}

function cleanUserId(value) {
  return cleanDisplayName(value).toLowerCase();
}

function displayNameKey(value) {
  return cleanDisplayName(value).toLowerCase();
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function shortError(error) {
  return String(error?.message || error || "不明なエラー").slice(0, 180);
}

function isRateLimitError(error) {
  const text = [
    error?.message,
    error?.info,
    error?.exception?.message,
    error?.cause?.message,
    typeof error === "string" ? error : ""
  ].filter(Boolean).join(" ");
  return /rate.?limit|too many connections|rate_limit_account_day/i.test(text);
}

function nextConnectionWindow(nowMs) {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 30).getTime();
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

  if (isRateLimitError(error) || /rate.?limit|too many connections|rate_limit_account_day/i.test(text)) {
    return `${shortError(text)} TikTok側の接続回数制限です。今日は新しい接続を増やさず、時間を空けてください。`;
  }
  if (/not live|offline|room.*not|user.*not|invalid/i.test(text)) {
    return `${shortError(text)} アカウント名またはLIVE状態の判定で失敗しています。`;
  }
  if (/captcha|verify|blocked|403|401|signature|sign/i.test(text)) {
    return `${shortError(text)} TikTok側の検証または制限で止まっています。`;
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(text)) {
    return `${shortError(text)} ネットワークまたは外部接続で止まっています。`;
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
      if (!isValidUsername(username)) {
        sendJson(response, 400, { error: "TikTok IDは2から32文字の英数字、_、.で入力してください。" });
        return;
      }
      if (connectionPauseUntil > Date.now()) {
        sendJson(response, 429, {
          error: `TikTok側の接続回数制限中です。${new Date(connectionPauseUntil).toLocaleTimeString("ja-JP")}頃まで新しい接続を止めています。`,
          errorCode: "rate_limited",
          retryAt: connectionPauseUntil
        });
        return;
      }
      const session = new LiveSession(username);
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

  const profileMatch = url.pathname.match(/^\/api\/profile\/([^/]+)$/);
  if (request.method === "GET" && profileMatch) {
    try {
      const username = normalizeTikTokUsername(decodeURIComponent(profileMatch[1]));
      if (!isValidUsername(username)) {
        sendJson(response, 400, { error: "TikTok IDは2から32文字の英数字、_、.で入力してください。" });
        return;
      }
      sendJson(response, 200, await fetchStreamerProfile(username));
    } catch (error) {
      sendJson(response, 502, {
        username: normalizeTikTokUsername(decodeURIComponent(profileMatch[1] || "")),
        displayName: normalizeTikTokUsername(decodeURIComponent(profileMatch[1] || "")),
        ok: false,
        error: diagnoseConnectError(error)
      });
    }
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
      session.touch();
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
      session.touch();
      sendJson(response, 200, session.snapshot());
      return;
    }

    if (request.method === "GET" && action === "export.csv") {
      session.touch();
      response.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${session.username}-live.csv"`
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
    if (session.stoppedAt && session.stoppedAt + SESSION_TTL_MS < now) {
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
