import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { EventStore } from "./lib/event-store.js";
import { avatarUrlFromUser } from "./lib/avatar-url.js";
import {
  heartMeLevelFromEvent,
  heartMeStateFromUser,
  isHeartMeGift,
  nextHeartMeStatusForGift
} from "./lib/heart-me.js";
import { LiveCueForwarder } from "./lib/livecue-forwarder.js";
import { liveProviderInfo, loadLiveProvider } from "./lib/live-provider.js";

if (!globalThis.process) {
  globalThis.process = { env: {} };
}

const PORT = Number(globalThis.__TIKTOK_LIVE_PORT__ || globalThis.process?.env?.PORT || 3030);
const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const sessions = new Map();
const SESSION_TTL_MS = Number(globalThis.process?.env?.SESSION_TTL_MS || 1000 * 60 * 60 * 24);
let connectionPauseUntil = 0;
const TIKTOOLS_SESSION_COOKIE = String(globalThis.process?.env?.TIKTOOLS_SESSION_COOKIE || "").trim();
const LISTENER_ADMIN_KEY = String(globalThis.process?.env?.LISTENER_ADMIN_KEY || "").trim();
const providerInfo = liveProviderInfo(globalThis.process?.env || {});
const eventStore = new EventStore({
  connectionString: globalThis.process?.env?.DATABASE_URL || "",
  ssl: String(globalThis.process?.env?.DATABASE_SSL || "").toLowerCase() === "false" ? false : undefined
});
const liveCue = new LiveCueForwarder({
  endpoint: globalThis.process?.env?.LIVECUE_ENDPOINT || "",
  channelId: globalThis.process?.env?.LIVECUE_CHANNEL_ID || "",
  token: globalThis.process?.env?.LIVECUE_ADMIN_TOKEN || ""
});

const TIKTOOLS_REGION_SLUGS = {
  Japan: { slug: "japan", code: "JP", label: "Japan" },
  JP: { slug: "japan", code: "JP", label: "Japan" },
  US: { slug: "north-america", code: "US+", label: "North America" },
  KR: { slug: "south-korea", code: "KR", label: "South Korea" },
  TW: { slug: "broader-china", code: "BC", label: "Broader China" },
  Other: { slug: "japan", code: "JP", label: "Japan" }
};

const TIKTOOLS_CLASS_TYPES = {
  A1: 2000,
  A2: 1900,
  B5: 1100,
  C1: 1000,
  C2: 900,
  D1: 500,
  D2: 400,
  D3: 300
};

const DISCOVERY_TARGET_LEAGUES = ["B5", "C1", "C2", "D1", "D2", "D3"];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

class LiveSession extends EventEmitter {
  constructor(username, options = {}) {
    super();
    this.id = options.id || randomUUID();
    this.username = username;
    this.provider = providerInfo.id;
    this.mode = "connecting";
    this.status = "connecting";
    this.startedAt = options.startedAt ? new Date(options.startedAt).getTime() : Date.now();
    this.stoppedAt = null;
    this.commentCount = 0;
    this.initialCommentCount = 0;
    this.giftCount = 0;
    this.initialGiftCount = 0;
    this.giftDiamondTotal = 0;
    this.shareCount = 0;
    this.comments = [];
    this.gifts = [];
    this.shares = [];
    this.userStats = new Map();
    this.displayNameIndex = new Map();
    this.giftStats = new Map();
    this.heartMeGiftIds = new Set();
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
    this.roomId = String(options.roomId || "");
    this.connectedAt = null;
    this.lastEventAt = null;
    this.connection = null;
    this.lastAccessAt = Date.now();
    this.initialDataUntil = 0;
    this.isConnectingWithInitialData = false;
  }

  async start() {
    const connector = await loadLiveProvider().catch(() => null);
    if (!connector) {
      this.fail("LIVE接続モジュールを読み込めないため、接続を開始できません。");
      return;
    }

    try {
      this.provider = connector.id;
      this.mode = "live";
      this.status = "connecting";
      this.broadcast("status", this.snapshot(`${connector.label}でTikTok LIVEへ接続中です。`));
      const state = await this.connectLiveWithRetries(connector);
      this.roomId = String(state?.roomId || this.connection?.roomId || this.roomId || "");
      this.displayName = displayNameFromRoomInfo(state?.roomInfo || this.connection?.roomInfo, this.username);
      this.status = "live";
      this.connectedAt = Date.now();
      this.lastEventAt = this.connectedAt;
      this.persistSession();
      this.broadcast("status", this.snapshot(`LIVE接続を開始しました。RoomId: ${this.roomId || "取得済み"}`));
    } catch (error) {
      this.fail(`実接続失敗: ${diagnoseConnectError(error)}`, isRateLimitError(error) ? "rate_limited" : "");
    }
  }

  async connectLiveWithRetries(connector) {
    let lastError = null;
    const attempts = connector.id === "tiktools" ? [
      { processInitialData: false, fetchRoomInfoOnConnect: false }
    ] : [
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
    const handleShare = (data) => {
      const share = parseShareEvent(data);
      share.source = this.currentEventSource();
      this.markSeen({ userId: share.userId, uniqueId: share.uniqueId, nickname: share.nickname, avatarUrl: share.avatarUrl, signals: share.signals }, share.at, "share");
      this.addShare(share);
    };

    connection.on(events.CHAT || "chat", (data) => {
      const person = personFromEvent(data);
      const at = eventTime(data);
      this.markSeen(person, at, "comment");
      this.addComment({
        id: data.msgId || randomUUID(),
        userId: person.userId,
        nickname: person.nickname,
        uniqueId: person.uniqueId,
        avatarUrl: person.avatarUrl,
        text: data.comment || "",
        at,
        source: this.currentEventSource(),
        signals: person.signals
      });
    });

    connection.on(events.GIFT || "gift", (data) => {
      const giftType = Number(data.giftType ?? data.giftDetails?.giftType ?? data.extendedGiftInfo?.giftType ?? 0);
      if (giftType === 1 && data.repeatEnd === false) return;
      const gift = parseGiftEvent(data, this.heartMeGiftIds);
      gift.source = this.currentEventSource();
      const previousUser = this.userStats.get(gift.userId);
      gift.previousHeartMeStatus = previousUser?.heartMeStatus || null;
      if (gift.isHeartMe && gift.giftId) this.heartMeGiftIds.add(String(gift.giftId));
      this.markSeen({ userId: gift.userId, uniqueId: gift.uniqueId, nickname: gift.nickname, avatarUrl: gift.avatarUrl, signals: gift.signals }, gift.at, "gift");
      this.addGift(gift);
    });

    connection.on(events.MEMBER || "member", (data) => {
      const person = personFromEvent(data);
      const at = eventTime(data);
      this.markSeen(person, at, "member", { entryEvent: true });
      this.emitNormalized({
        id: data.msgId || randomUUID(),
        type: "join",
        ...person,
        at,
        source: this.currentEventSource()
      });
    });

    connection.on(events.FOLLOW || "follow", (data) => {
      const person = personFromEvent(data);
      const at = eventTime(data);
      this.markSeen(person, at, "follow");
      this.markFollowedToday(person, at);
      this.emitNormalized({
        id: data.msgId || randomUUID(),
        type: "follow",
        ...person,
        at,
        source: this.currentEventSource()
      });
    });

    connection.on(events.SHARE || "share", handleShare);

    connection.on(events.SOCIAL || "social", (data) => {
      if (isShareEvent(data)) {
        handleShare(data);
      }
      if (isFollowEvent(data)) {
        const person = personFromEvent(data);
        const at = eventTime(data);
        this.markSeen(person, at, "follow");
        this.markFollowedToday(person, at);
        this.emitNormalized({
          id: data.msgId || randomUUID(),
          type: "follow",
          ...person,
          at,
          source: this.currentEventSource()
        });
      }
    });

    connection.on(events.LIKE || "like", (data) => {
      const person = personFromEvent(data);
      const at = eventTime(data);
      this.markSeen(person, at, "like");
      this.emitNormalized({
        id: data.msgId || randomUUID(),
        type: "like",
        ...person,
        likeCount: Number(data.likeCount || 0),
        totalLikes: Number(data.totalLikes || 0),
        at,
        source: this.currentEventSource()
      });
    });

    connection.on(events.SUBSCRIBE || "subscribe", (data) => {
      const person = personFromEvent(data);
      const at = eventTime(data);
      this.markSeen(person, at, "subscribe");
      this.emitNormalized({
        id: data.msgId || randomUUID(),
        type: "subscribe",
        ...person,
        subMonth: Number(data.subMonth || 0),
        at,
        source: this.currentEventSource()
      });
    });

    connection.on(events.SUPER_FAN || "superFan", (data) => {
      const person = personFromEvent(data);
      const at = eventTime(data);
      this.markSeen(person, at, "heart_me");
      this.markHeartMe(person, at, {
        status: "new_today",
        level: heartMeLevelFromEvent(data),
        source: "super_fan_event"
      });
    });

    connection.on(events.SUPER_FAN_JOIN || "superFanJoin", (data) => {
      const person = personFromEvent(data);
      const at = eventTime(data);
      this.markSeen(person, at, "super_fan_join", { entryEvent: true });
      this.markHeartMe(person, at, {
        status: "active",
        level: heartMeLevelFromEvent(data),
        source: "super_fan_join"
      });
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
        this.persistSession();
        const message = this.provider === "tiktools"
          ? "接続が切れました。サーバー側で自動再接続しています。"
          : "接続が切れました。";
        this.broadcast("status", this.snapshot(message));
      }
    });

    connection.on(events.CONNECTED || "connected", () => {
      if (this.stoppedAt) return;
      this.status = "live";
      this.connectedAt ||= Date.now();
      this.persistSession();
      this.broadcast("status", this.snapshot("TikTok LIVEへ接続しています。"));
    });

    connection.on(events.ERROR || "error", (error) => {
      this.broadcast("status", this.snapshot(`接続エラー: ${diagnoseConnectError(error)}`));
    });
  }

  markSeen(person, at, presenceSource = "event", { entryEvent = false } = {}) {
    this.lastEventAt = Math.max(this.lastEventAt || 0, at);
    const user = this.getUserStat(person.userId, person.nickname, at, person.signals);
    if (person.uniqueId) user.uniqueId = person.uniqueId;
    if (person.avatarUrl) user.avatarUrl = person.avatarUrl;
    if (!user.hasJoined) {
      user.hasJoined = true;
      user.firstJoinAt = at;
      user.lastJoinAt = at;
      user.visitCount = Math.max(1, Number(user.visitCount || 0));
      user.visitSource = presenceSource;
      user.entryEventCount = entryEvent ? 1 : Number(user.entryEventCount || 0);
      this.viewerStats.knownJoins += 1;
      this.recordVisit(user, at, presenceSource);
    } else if (entryEvent) {
      user.lastJoinAt = at;
      user.entryEventCount = Number(user.entryEventCount || 0) + 1;
    }
    user.lastSeenAt = Math.max(user.lastSeenAt, at);
    this.userStats.set(user.userId, user);
  }

  markHeartMe(person, at, { status, level = 0, source = "" } = {}) {
    const user = this.getUserStat(person.userId, person.nickname, at, person.signals);
    const resolvedStatus = status === "new_today"
      ? nextHeartMeStatusForGift(user.heartMeStatus)
      : status;
    user.heartMeStatus = resolvedStatus || user.heartMeStatus;
    if (status === "new_today") {
      user.heartMeToday = true;
      user.lastHeartMeAt = at;
    }
    user.heartMeStatusSource = source || user.heartMeStatusSource;
    user.heartMeStatusAt = at;
    user.heartMeLevel = Math.max(Number(user.heartMeLevel || 0), Number(level || 0));
    this.userStats.set(user.userId, user);
    this.emitNormalized({
      id: randomUUID(),
      type: resolvedStatus === "active" ? "heart_me_active" : "heart_me",
      userId: user.userId,
      uniqueId: person.uniqueId || user.uniqueId || "",
      nickname: user.nickname,
      avatarUrl: person.avatarUrl || user.avatarUrl || "",
      at,
      source: this.currentEventSource()
    });
    this.broadcast("status", this.snapshot());
  }

  recordVisit(user, at, source) {
    eventStore.recordVisit(this, {
      userId: user.userId,
      uniqueId: user.uniqueId || "",
      nickname: user.nickname,
      avatarUrl: user.avatarUrl || "",
      at,
      source
    }).then((summary) => {
      if (!summary) return;
      const current = this.userStats.get(user.userId);
      if (!current) return;
      current.visitCount = Math.max(1, Number(summary.visitCount || current.visitCount || 1));
      current.firstVisitAt = summary.firstVisitAt || current.firstVisitAt || at;
      current.lastVisitAt = summary.lastVisitAt || current.lastVisitAt || at;
      this.userStats.set(current.userId, current);
      this.broadcast("status", this.snapshot());
    }).catch(() => {});
  }

  markFollowedToday(person, at) {
    this.lastEventAt = Math.max(this.lastEventAt || 0, at);
    const user = this.getUserStat(person.userId, person.nickname, at, person.signals);
    user.followedToday = true;
    user.followedAt = at;
    user.isFollowingHost = true;
    user.followStatus = "following";
    user.followStatusSource = "follow_event";
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

    const current = this.getUserStat(comment.userId, comment.nickname, comment.at, comment.signals);
    current.comments += 1;
    current.lastSeenAt = comment.at;
    this.userStats.set(current.userId, current);
    this.emitNormalized({ ...comment, type: "comment" });
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

    const user = this.getUserStat(gift.userId, gift.nickname, gift.at, gift.signals);
    user.gifts += repeatCount;
    user.diamonds += totalDiamonds;
    user.lastSeenAt = gift.at;
    if (normalizedGift.isHeartMe) {
      user.heartMeGiftCount = Number(user.heartMeGiftCount || 0) + repeatCount;
      user.heartMeToday = true;
      user.lastHeartMeAt = gift.at;
      user.heartMeStatus = nextHeartMeStatusForGift(gift.previousHeartMeStatus);
      user.heartMeStatusSource = gift.previousHeartMeStatus === "none"
        ? "heart_me_gift_new"
        : gift.previousHeartMeStatus === "active" || gift.previousHeartMeStatus === "inactive"
          ? "heart_me_gift_returning"
          : "heart_me_gift_today_unconfirmed";
      user.heartMeStatusAt = gift.at;
      user.heartMeLevel = Math.max(1, Number(user.heartMeLevel || 0));
    }
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

    this.emitNormalized({ ...normalizedGift, type: "gift" });
    this.broadcast("gift", { gift: normalizedGift, snapshot: this.snapshot() });
  }

  addShare(share) {
    this.lastEventAt = Math.max(this.lastEventAt || 0, share.at);
    this.shareCount += 1;
    this.shares.unshift(share);
    this.shares = this.shares.slice(0, 200);

    const user = this.getUserStat(share.userId, share.nickname, share.at, share.signals);
    user.shares = Number(user.shares || 0) + 1;
    user.lastSeenAt = share.at;
    this.userStats.set(user.userId, user);
    this.emitNormalized({ ...share, type: "share" });
    this.broadcast("share", { share, snapshot: this.snapshot() });
  }

  emitNormalized(event) {
    eventStore.recordEvent(this, event).catch(() => {});
    liveCue.publish(event);
  }

  persistSession(options) {
    eventStore.saveSession(this, options).catch(() => {});
  }

  getUserStat(rawUserId, rawNickname, at, signals = null) {
    const nickname = cleanDisplayName(rawNickname || rawUserId || "unknown");
    const displayKey = displayNameKey(nickname);
    const suppliedId = cleanUserId(rawUserId || "");
    const hasStableId = suppliedId && suppliedId !== "unknown" && suppliedId !== cleanUserId(nickname);
    const existingId = hasStableId ? "" : this.displayNameIndex.get(displayKey);
    const userId = suppliedId || existingId || cleanUserId(nickname);
    this.displayNameIndex.set(displayKey, userId);

    const current = this.userStats.get(userId) || {
      userId,
      nickname,
      comments: 0,
      gifts: 0,
      shares: 0,
      diamonds: 0,
      firstSeenAt: at,
      lastSeenAt: at,
      hasJoined: false,
      firstJoinAt: null,
      lastJoinAt: null,
      entryEventCount: 0,
      visitCount: 0,
      visitSource: "",
      firstVisitAt: null,
      lastVisitAt: null,
      watchSeconds: 0,
      followedToday: false,
      followedAt: null,
      isFollowingHost: null,
      followStatus: "unknown",
      followStatusRaw: null,
      followStatusSource: "",
      heartMeStatus: "unknown",
      heartMeStatusRaw: null,
      heartMeStatusSource: "",
      heartMeStatusAt: null,
      heartMeLevel: 0,
      heartMeToday: false,
      heartMeGiftCount: 0,
      lastHeartMeAt: null,
      isCurrentlyRanked: false,
      currentViewerRank: null,
      currentViewerRankedAt: null
    };
    current.nickname = nickname || current.nickname;
    current.firstSeenAt = Math.min(current.firstSeenAt, at);
    current.lastSeenAt = Math.max(current.lastSeenAt, at);
    applyUserSignals(current, signals, at);
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
      this.markSeen(person, at, "viewer_ranking");
      const user = this.getUserStat(person.userId, person.nickname, at, person.signals);
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
    const visitors = [...users]
      .filter((user) => user.hasJoined)
      .sort((a, b) => b.firstJoinAt - a.firstJoinAt || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 200);
    const topGifts = [...this.giftStats.values()]
      .sort((a, b) => b.diamonds - a.diamonds || b.count - a.count || b.lastGiftAt - a.lastGiftAt)
      .slice(0, 30);
    const followedTodayCount = users.filter((user) => user.followedToday).length;
    const heartMeStats = summarizeHeartMe(users);
    const followStats = summarizeFollowStatus(users);

    return {
      id: this.id,
      username: this.username,
      displayName: this.displayName,
      roomId: this.roomId,
      provider: this.provider,
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
      shareCount: this.shareCount,
      comments: this.comments.map((comment) => this.decorateUserEvent(comment)),
      gifts: this.gifts.map((gift) => this.decorateUserEvent(gift)),
      shares: this.shares.map((share) => this.decorateUserEvent(share)),
      topUsers,
      topGifters,
      topWatchers,
      silentLongWatchers,
      currentViewerRanking,
      visitors,
      topGifts,
      followedTodayCount,
      heartMeStats,
      followStats,
      viewerStats: this.viewerStats
    };
  }

  decorateUserEvent(event) {
    const user = this.userStats.get(event.userId);
    return user ? { ...event, ...userDisplayState(user) } : event;
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

  currentGiftCatalog() {
    const catalog = new Map();
    for (const gift of this.giftStats.values()) {
      const key = String(gift.giftId || gift.giftName || "gift");
      const current = catalog.get(key) || {
        giftId: String(gift.giftId || ""),
        giftName: gift.giftName || "ギフト",
        count: 0,
        lastGiftAt: 0
      };
      current.count += Number(gift.count || 0);
      current.lastGiftAt = Math.max(current.lastGiftAt, Number(gift.lastGiftAt || 0));
      catalog.set(key, current);
    }
    return [...catalog.values()]
      .sort((a, b) => b.lastGiftAt - a.lastGiftAt || b.count - a.count);
  }

  currentGiftRanking({ giftId = "", giftName = "" } = {}) {
    const ranking = new Map();
    for (const gift of this.giftStats.values()) {
      if (giftId && String(gift.giftId || "") !== String(giftId)) continue;
      if (!giftId && giftName && gift.giftName !== giftName) continue;
      const current = ranking.get(gift.userId) || {
        userId: gift.userId,
        nickname: gift.nickname,
        count: 0,
        diamonds: 0,
        lastGiftAt: 0
      };
      current.nickname = gift.nickname || current.nickname;
      current.count += Number(gift.count || 0);
      current.diamonds += Number(gift.diamonds || 0);
      current.lastGiftAt = Math.max(current.lastGiftAt, Number(gift.lastGiftAt || 0));
      ranking.set(gift.userId, current);
    }
    return [...ranking.values()]
      .sort((a, b) => b.count - a.count || b.diamonds - a.diamonds || b.lastGiftAt - a.lastGiftAt);
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
    this.persistSession({ autoResume: false });
    this.broadcast("status", this.snapshot(message));
  }

  stop(message = "停止しました。") {
    if (this.stoppedAt) return;
    this.stoppedAt = Date.now();
    this.status = this.status === "ended" ? "ended" : "stopped";
    if (this.connection?.disconnect) {
      Promise.resolve(this.connection.disconnect()).catch(() => {});
    }
    this.persistSession({ autoResume: false });
    this.broadcast("status", this.snapshot(message));
  }

  toCsv() {
    const rows = [["type", "source", "time", "user_id", "nickname", "text_or_gift", "count", "diamonds", "watch_seconds", "followed_today", "follows_host", "heart_me_status", "heart_me_level"]];
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
        user?.followedToday ? "yes" : "",
        user?.isFollowingHost === null ? "" : user?.isFollowingHost ? "yes" : "no",
        user?.heartMeStatus || "",
        user?.heartMeLevel || ""
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
        user?.followedToday ? "yes" : "",
        user?.isFollowingHost === null ? "" : user?.isFollowingHost ? "yes" : "no",
        user?.heartMeStatus || "",
        user?.heartMeLevel || ""
      ]);
    }
    for (const share of [...this.shares].reverse()) {
      const user = this.userStats.get(share.userId);
      rows.push([
        "share",
        share.source || "live",
        new Date(share.at).toISOString(),
        share.userId,
        share.nickname,
        share.label || "share",
        1,
        "",
        user?.watchSeconds || "",
        user?.followedToday ? "yes" : "",
        user?.isFollowingHost === null ? "" : user?.isFollowingHost ? "yes" : "no",
        user?.heartMeStatus || "",
        user?.heartMeLevel || ""
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
    rawUser.id,
    rawUser.userId,
    rawUser.uniqueId,
    entry.userId,
    entry.uniqueId,
    nickname
  );
  if (!userId || cleanDisplayName(userId) === "unknown") return null;
  return {
    userId: cleanUserId(userId),
    nickname: cleanDisplayName(nickname || userId),
    signals: userSignalsFromRawUser(rawUser)
  };
}

function rankedViewerPosition(entry, index) {
  const rank = Number(entry.rank || entry.rankIndex || entry.position || 0);
  return Number.isFinite(rank) && rank > 0 ? rank : index + 1;
}

function firstText(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim());
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function applyUserSignals(user, signals, at) {
  if (!signals) return;
  const heartMe = signals.heartMe;
  if (heartMe?.status) {
    const currentStatus = user.heartMeStatus || "unknown";
    const keepNewToday = user.heartMeToday || currentStatus === "new_today";
    const keepKnownState = heartMe.status === "none" && !["unknown", "none"].includes(currentStatus);
    if (!keepNewToday && !keepKnownState) {
      user.heartMeStatus = heartMe.status;
    }
    user.heartMeStatusRaw = heartMe.rawStatus ?? user.heartMeStatusRaw;
    user.heartMeStatusSource = heartMe.source || user.heartMeStatusSource;
    user.heartMeStatusAt = at;
    if (Number.isFinite(heartMe.level)) {
      user.heartMeLevel = heartMe.level;
    }
  }

  const follow = signals.follow;
  if (follow?.status) {
    user.followStatus = follow.status;
    user.followStatusRaw = follow.rawStatus ?? user.followStatusRaw;
    user.followStatusSource = follow.source || user.followStatusSource;
    user.isFollowingHost = follow.isFollowingHost;
  }
}

function userSignalsFromRawUser(rawUser) {
  return {
    heartMe: heartMeStateFromUser(rawUser),
    follow: followStateFromUser(rawUser)
  };
}

function followStateFromUser(rawUser) {
  if (!rawUser || typeof rawUser !== "object") return null;
  const rawStatus = firstDefined(rawUser.followInfo?.followStatus, rawUser.followRole);
  if (rawStatus === undefined) return null;
  const statusNumber = Number(rawStatus);
  if (!Number.isFinite(statusNumber)) return { status: "unknown", rawStatus, isFollowingHost: null, source: "follow_info" };
  return {
    status: statusNumber > 0 ? "following" : "not_following",
    rawStatus,
    isFollowingHost: statusNumber > 0,
    source: "follow_info"
  };
}

function userDisplayState(user) {
  return {
    followedToday: Boolean(user.followedToday),
    isFollowingHost: user.isFollowingHost,
    followStatus: user.followStatus,
    followStatusRaw: user.followStatusRaw,
    heartMeStatus: user.heartMeStatus,
    heartMeStatusSource: user.heartMeStatusSource,
    heartMeLevel: user.heartMeLevel,
    heartMeToday: Boolean(user.heartMeToday),
    heartMeGiftCount: Number(user.heartMeGiftCount || 0),
    lastHeartMeAt: user.lastHeartMeAt,
    visitCount: Number(user.visitCount || 0),
    firstVisitAt: user.firstVisitAt,
    lastVisitAt: user.lastVisitAt
  };
}

function summarizeHeartMe(users) {
  return users.reduce((summary, user) => {
    const key = user.heartMeStatus || "unknown";
    summary[key] = Number(summary[key] || 0) + 1;
    return summary;
  }, { active: 0, new_today: 0, inactive: 0, none: 0, unknown: 0 });
}

function summarizeFollowStatus(users) {
  return users.reduce((summary, user) => {
    if (user.isFollowingHost === true) summary.following += 1;
    else if (user.isFollowingHost === false) summary.notFollowing += 1;
    else summary.unknown += 1;
    if (user.followedToday) summary.followedToday += 1;
    return summary;
  }, { following: 0, notFollowing: 0, unknown: 0, followedToday: 0 });
}

function personFromEvent(data) {
  const rawUser = data.user || data.userInfo || data.viewer || data.author || data.data?.user || data;
  const nickname = data.nickname || rawUser?.nickname || rawUser?.uniqueId || data.uniqueId || "unknown";
  const userId = rawUser?.id || rawUser?.userId || rawUser?.uniqueId || data.uniqueId || nickname;
  return {
    userId: cleanUserId(userId),
    uniqueId: cleanDisplayName(rawUser?.uniqueId || data.uniqueId || "").replace(/^unknown$/, ""),
    nickname: cleanDisplayName(nickname),
    avatarUrl: avatarUrlFromUser(rawUser),
    signals: userSignalsFromRawUser(rawUser)
  };
}

function parseGiftEvent(data, knownHeartMeGiftIds = []) {
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
    uniqueId: person.uniqueId,
    nickname: person.nickname,
    avatarUrl: person.avatarUrl,
    giftId: String(data.giftId || extended.id || ""),
    giftName: data.giftName || extended.name || data.giftId || "ギフト",
    repeatCount: Number(data.repeatCount || data.repeat_count || 1),
    diamondCount,
    isHeartMe: isHeartMeGift(data, extended, knownHeartMeGiftIds),
    signals: person.signals,
    at: eventTime(data)
  };
}

function parseShareEvent(data) {
  const person = personFromEvent(data);
  return {
    id: data.msgId || randomUUID(),
    userId: person.userId,
    uniqueId: person.uniqueId,
    nickname: person.nickname,
    avatarUrl: person.avatarUrl,
    label: shareEventLabel(data),
    signals: person.signals,
    at: Date.now()
  };
}

function shareEventLabel(data) {
  return firstText(
    data.label,
    data.displayType,
    data.common?.displayText?.displayType,
    data.common?.displayText?.defaultPattern,
    data.common?.displayText?.key,
    "シェア"
  );
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
    data.common?.displayText?.displayType,
    data.common?.displayText?.defaultPattern,
    data.common?.displayText?.key,
    data.common?.method
  ].filter(Boolean).join(" ").toLowerCase();
  return /follow|フォロー/.test(text);
}

function isShareEvent(data) {
  const text = [
    data.displayType,
    data.label,
    data.type,
    data.action,
    data.event,
    data.socialType,
    data.socialAction,
    data.common?.displayText?.displayType,
    data.common?.displayText?.defaultPattern,
    data.common?.displayText?.key,
    data.common?.method
  ].filter(Boolean).join(" ").toLowerCase();
  return /share|シェア|共有/.test(text);
}

function eventTime(data) {
  const value = Number(data?.timestamp || data?.createTime || data?.create_time || 0);
  if (!value) return Date.now();
  return value < 100000000000 ? value * 1000 : value;
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

function isAuthorizedListenerRequest(request) {
  if (!LISTENER_ADMIN_KEY) return false;
  const authorization = String(request.headers.authorization || "");
  const supplied = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(LISTENER_ADMIN_KEY);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function requireListenerAdmin(request, response) {
  if (!LISTENER_ADMIN_KEY) {
    sendJson(response, 503, { error: "リスナー管理キーがまだ設定されていません" });
    return false;
  }
  if (!isAuthorizedListenerRequest(request)) {
    sendJson(response, 401, { error: "管理キーを確認してください" });
    return false;
  }
  return true;
}

async function discoverCreatorCandidates(params) {
  const regionSetting = TIKTOOLS_REGION_SLUGS[params.get("region") || "Japan"] || TIKTOOLS_REGION_SLUGS.Japan;
  const leagueFilter = String(params.get("league") || "target");
  const liveOnly = params.get("liveOnly") === "1";
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") || 50)));
  const warnings = [];
  const candidates = [];

  if (leagueFilter !== "top100") {
    if (TIKTOOLS_SESSION_COOKIE) {
      try {
        candidates.push(...await fetchTikToolsLeagueCandidates(regionSetting, leagueFilter));
      } catch (error) {
        warnings.push(`リーグ別取得に失敗しました: ${shortError(error)}`);
      }
    } else {
      warnings.push("リーグ別一覧にはTikToolのAPI用セッションが必要です。公開ランキングから見える範囲だけ取得します。");
    }
  }

  if (!candidates.length || leagueFilter === "top100") {
    try {
      candidates.push(...await fetchTikToolsCountryCandidates(regionSetting));
    } catch (error) {
      warnings.push(`地域ランキングAPIに接続できませんでした: ${shortError(error)}`);
    }
  }

  if (!candidates.length) {
    try {
      candidates.push(...await scrapeTikToolsRankingPage(regionSetting));
    } catch (error) {
      warnings.push(`公開ランキングページの読み取りに失敗しました: ${shortError(error)}`);
    }
  }

  const unique = dedupeCandidates(candidates)
    .filter((candidate) => !liveOnly || candidate.liveNow)
    .slice(0, limit);

  if (!unique.length) {
    warnings.push("公開ランキングはログインなしだと候補IDがマスクされていました。TikToolのAPI用セッションを設定すると一覧取得できます。");
  }

  return {
    ok: unique.length > 0,
    source: TIKTOOLS_SESSION_COOKIE ? "tiktools-api" : "tiktools-public",
    region: regionSetting.label,
    candidates: unique,
    warnings,
    discoveredAt: Date.now()
  };
}

async function fetchTikToolsLeagueCandidates(regionSetting, leagueFilter) {
  const labels = leagueLabelsForFilter(leagueFilter);
  const results = [];
  for (const label of labels) {
    const classType = TIKTOOLS_CLASS_TYPES[label];
    if (!classType) continue;
    const url = `https://tik.tools/api/leaderboards/league/${encodeURIComponent(regionSetting.code)}/${classType}`;
    const body = await fetchTikToolsJson(url);
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    for (const entry of entries) {
      results.push(candidateFromTikToolsEntry(entry, regionSetting.label, label, "tiktools-league"));
    }
  }
  return results.filter(Boolean);
}

function leagueLabelsForFilter(filter) {
  const normalized = String(filter || "").toUpperCase();
  if (normalized === "TARGET" || normalized === "LOWER-B") return DISCOVERY_TARGET_LEAGUES;
  if (normalized === "C") return ["C1", "C2"];
  if (normalized === "D") return ["D1", "D2", "D3"];
  if (normalized === "B") return ["B5"];
  if (TIKTOOLS_CLASS_TYPES[normalized]) return [normalized];
  return DISCOVERY_TARGET_LEAGUES;
}

async function fetchTikToolsCountryCandidates(regionSetting) {
  const body = await fetchTikToolsJson(`https://tik.tools/api/leaderboards/country/${regionSetting.slug}`);
  const entries = Array.isArray(body) ? body : body?.current?.channels;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => candidateFromTikToolsEntry(entry, regionSetting.label, "", "tiktools-country"))
    .filter(Boolean);
}

async function fetchTikToolsJson(url) {
  const headers = { Accept: "application/json" };
  if (TIKTOOLS_SESSION_COOKIE) headers.Cookie = TIKTOOLS_SESSION_COOKIE;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout?.(12000) });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("JSONとして読めませんでした。");
  }
}

async function scrapeTikToolsRankingPage(regionSetting) {
  const response = await fetch(`https://tik.tools/ranking/${regionSetting.slug}`, {
    headers: { Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout?.(12000)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const html = await response.text();
  const text = decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\n{2,}/g, "\n");
  const candidates = [];
  const usernamePattern = /@([A-Za-z0-9_.]{2,32})/g;
  let match;
  while ((match = usernamePattern.exec(text)) && candidates.length < 40) {
    const username = match[1];
    if (!isDiscoveryUsername(username)) continue;
    const before = text.slice(Math.max(0, match.index - 160), match.index).split("\n").map((part) => part.trim()).filter(Boolean);
    const after = text.slice(match.index, match.index + 180);
    const nickname = before.reverse().find((part) => !/^#?\d+$/.test(part) && !/^Image:/i.test(part) && !/^login$/i.test(part)) || username;
    const scoreText = after.match(/(\d+(?:\.\d+)?)\s*([kKmM万]?)/)?.[0] || "";
    candidates.push({
      username,
      displayName: nickname.replace(/^Image:\s*/i, ""),
      region: regionSetting.label,
      league: "",
      diamondsPerDay: parseCompactNumber(scoreText),
      liveNow: /●\s*LIVE|LIVE/.test(after),
      status: "queued",
      source: "tiktools-public-page",
      profileMemo: "TikTool公開ランキングページから取得"
    });
  }
  return candidates.filter((candidate) => isValidUsername(candidate.username));
}

function candidateFromTikToolsEntry(entry, region, league, source) {
  const username = normalizeTikTokUsername(entry?.uniqueId || entry?.username || "");
  if (!isDiscoveryUsername(username) || entry?.masked || entry?.locked) return null;
  return {
    username,
    displayName: cleanDiscoveryText(entry?.nickname || entry?.displayName || username),
    region,
    league,
    diamondsPerDay: Math.max(0, Math.round(Number(entry?.score || entry?.diamonds || 0))),
    liveNow: Boolean(entry?.isLive || entry?.live),
    status: "queued",
    source,
    profileMemo: `${source} #${entry?.rank || "-"}`
  };
}

function isDiscoveryUsername(username) {
  const normalized = normalizeTikTokUsername(username).toLowerCase();
  if (!isValidUsername(normalized)) return false;
  if (/^\d+$/.test(normalized)) return false;
  return !["someone", "media", "keyframes", "font-face", "import"].includes(normalized);
}

function dedupeCandidates(candidates) {
  const seen = new Map();
  for (const candidate of candidates) {
    if (!candidate?.username || !isValidUsername(candidate.username)) continue;
    const key = candidate.username.toLowerCase();
    const existing = seen.get(key);
    if (!existing || Number(candidate.diamondsPerDay || 0) > Number(existing.diamondsPerDay || 0)) {
      seen.set(key, candidate);
    }
  }
  return [...seen.values()].sort((a, b) => Number(b.diamondsPerDay || 0) - Number(a.diamondsPerDay || 0));
}

function cleanDiscoveryText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'");
}

function parseCompactNumber(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*([kKmM万]?)/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  if (/m/i.test(match[2])) return Math.round(amount * 1000000);
  if (/k/i.test(match[2])) return Math.round(amount * 1000);
  if (match[2] === "万") return Math.round(amount * 10000);
  return Math.round(amount);
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
      await eventStore.saveSession(session);
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
      uptimeSeconds: Math.floor(getUptimeSeconds()),
      provider: providerInfo,
      database: eventStore.status(),
      listenerManagement: {
        configured: Boolean(LISTENER_ADMIN_KEY),
        ready: Boolean(LISTENER_ADMIN_KEY && eventStore.status().ready)
      },
      liveCue: liveCue.status()
    });
    return;
  }

  if (url.pathname === "/api/listeners/auth") {
    if (!requireListenerAdmin(request, response)) return;
    sendJson(response, 200, { ok: true, database: eventStore.status() });
    return;
  }

  if (url.pathname === "/api/listeners/summary") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      sendJson(response, 200, await eventStore.listenerSummary({
        username: normalizeTikTokUsername(url.searchParams.get("username") || "")
      }));
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners/events") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      sendJson(response, 200, {
        items: await eventStore.recentListenerEvents({
          username: normalizeTikTokUsername(url.searchParams.get("username") || ""),
          since: Number(url.searchParams.get("since") || 0),
          limit: Number(url.searchParams.get("limit") || 100)
        })
      });
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners/avatars/backfill" && request.method === "POST") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const body = await readBody(request);
      sendJson(response, 200, await backfillListenerAvatars({
        limit: Number(body.limit || 10),
        offset: Number(body.offset || 0)
      }));
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners/import" && request.method === "POST") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const body = await readBody(request);
      sendJson(response, 200, await eventStore.importListeners(body.items, {
        username: normalizeTikTokUsername(body.username || ""),
        source: String(body.source || "import")
      }));
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners/maintenance/clear-imported-super-fans" && request.method === "POST") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      sendJson(response, 200, await eventStore.clearImportedSuperFans());
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners" && request.method === "GET") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      sendJson(response, 200, await eventStore.listeners({
        username: normalizeTikTokUsername(url.searchParams.get("username") || ""),
        search: url.searchParams.get("search") || "",
        sort: url.searchParams.get("sort") || "last_seen",
        direction: url.searchParams.get("direction") || "desc",
        limit: Number(url.searchParams.get("limit") || 100),
        offset: Number(url.searchParams.get("offset") || 0)
      }));
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  const listenerMatch = url.pathname.match(/^\/api\/listeners\/([^/]+)$/);
  if (listenerMatch) {
    if (!requireListenerAdmin(request, response)) return;
    const userId = decodeURIComponent(listenerMatch[1]);
    try {
      if (request.method === "GET") {
        const detail = await eventStore.listenerDetail(userId, {
          username: normalizeTikTokUsername(url.searchParams.get("username") || "")
        });
        sendJson(response, detail ? 200 : 404, detail || { error: "リスナーが見つかりません" });
        return;
      }
      if (request.method === "PATCH") {
        const updated = await eventStore.updateListener(userId, await readBody(request));
        sendJson(response, updated ? 200 : 404, updated || { error: "リスナーが見つかりません" });
        return;
      }
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
      return;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/candidates/discover") {
    try {
      sendJson(response, 200, await discoverCreatorCandidates(url.searchParams));
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        candidates: [],
        warnings: [shortError(error)]
      });
    }
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

    if (request.method === "GET" && action === "gift-ranking") {
      const giftId = String(url.searchParams.get("giftId") || "");
      const giftName = String(url.searchParams.get("giftName") || "");
      const requestedRange = String(url.searchParams.get("range") || "session");
      const range = ["session", "today", "7d", "30d", "all"].includes(requestedRange)
        ? requestedRange
        : "session";
      try {
        const persistent = eventStore.status().ready;
        const ranking = persistent
          ? await eventStore.giftRanking({
              sessionId: session.id,
              username: session.username,
              giftId,
              giftName,
              range
            })
          : session.currentGiftRanking({ giftId, giftName });
        const catalog = persistent
          ? await eventStore.giftCatalog(range === "session"
              ? { sessionId: session.id }
              : { username: session.username })
          : session.currentGiftCatalog();
        sendJson(response, 200, {
          persistent,
          effectiveRange: persistent ? range : "session",
          ranking,
          catalog
        });
      } catch (error) {
        sendJson(response, 500, { error: shortError(error) });
      }
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

await eventStore.init();

server.listen(PORT, () => {
  console.log(`TikTok LIVE app: http://localhost:${PORT}`);
});

if (providerInfo.paidApiReady && eventStore.status().ready) {
  restorePersistentSessions().catch((error) => {
    console.error(`Session restore failed: ${shortError(error)}`);
  });
}

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

async function restorePersistentSessions() {
  const saved = await eventStore.restorableSessions(
    Number(globalThis.process?.env?.SESSION_RESTORE_MAX_AGE_HOURS || 12)
  );
  const restoredUsernames = new Set();
  for (const item of saved) {
    const username = normalizeTikTokUsername(item.username);
    if (!isValidUsername(username) || restoredUsernames.has(username.toLowerCase())) continue;
    restoredUsernames.add(username.toLowerCase());
    const session = new LiveSession(username, {
      id: item.id,
      startedAt: item.startedAt,
      roomId: item.roomId
    });
    sessions.set(session.id, session);
    session.start();
  }
}

async function backfillListenerAvatars({ limit = 10, offset = 0 } = {}) {
  const apiKey = String(globalThis.process?.env?.TIKTOOLS_API_KEY || "").trim();
  if (!apiKey) throw new Error("Tik.tools APIキーが設定されていません");
  const candidates = await eventStore.listenersMissingAvatars({ limit, offset });
  if (!candidates.length) return { requested: 0, updated: 0, failed: 0, items: [] };
  const profiles = await fetchTikToolsProfilesByUserIds(candidates.map((candidate) => candidate.userId), apiKey);
  const items = [];
  for (const candidate of candidates) {
    try {
      const profile = profiles.get(String(candidate.userId));
      if (!profile) throw new Error("Tik.toolsからユーザー情報が返りませんでした");
      const avatarUrl = avatarUrlFromUser(profile);
      if (!avatarUrl) throw new Error("プロフィール画像が見つかりません");
      const updated = await eventStore.updateListenerAvatar(candidate.userId, {
        uniqueId: profile.uniqueId || profile.username || candidate.uniqueId,
        nickname: profile.nickname || candidate.nickname,
        avatarUrl
      });
      items.push({ userId: candidate.userId, uniqueId: candidate.uniqueId, ok: Boolean(updated) });
    } catch (error) {
      items.push({ userId: candidate.userId, uniqueId: candidate.uniqueId, ok: false, error: shortError(error) });
    }
  }
  return {
    requested: candidates.length,
    updated: items.filter((item) => item.ok).length,
    failed: items.filter((item) => !item.ok).length,
    items
  };
}

async function fetchTikToolsProfilesByUserIds(userIds, apiKey) {
  const url = new URL("https://api.tik.tools/webcast/resolve_user_ids");
  url.searchParams.set("apiKey", apiKey);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({ user_ids: userIds.map(String) })
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Tik.toolsユーザー変換APIが利用できません（HTTP ${response.status}）`);
  }
  if (!response.ok || (payload.status_code != null && payload.status_code !== 0)) {
    throw new Error(payload.error || payload.message || `Tik.toolsユーザー変換失敗（HTTP ${response.status}）`);
  }
  const data = payload.data?.users || payload.data || payload.users || {};
  const profiles = new Map();
  if (Array.isArray(data)) {
    for (const profile of data) {
      const userId = String(profile?.userId || profile?.user_id || profile?.id || "");
      if (userId) profiles.set(userId, profile);
    }
  } else {
    for (const [userId, profile] of Object.entries(data)) {
      if (profile && typeof profile === "object") profiles.set(String(userId), profile);
    }
  }
  return profiles;
}

export { server };
