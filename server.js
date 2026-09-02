import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants as zlibConstants, createGzip, gzipSync } from "node:zlib";
import { EventStore } from "./lib/event-store.js";
import { avatarUrlFromUser } from "./lib/avatar-url.js";
import { giftImageUrlFromEvent } from "./lib/gift-image-url.js";
import { isSilentWatcher, silentWatcherPresenceMode } from "./lib/silent-watchers.js";
import { confirmedRankedWatchSeconds, updateRankedPresence } from "./lib/ranked-watch.js";
import {
  heartMeLevelFromEvent,
  heartMeStateFromUser,
  isHeartMeGift,
  nextHeartMeStatusForGift
} from "./lib/heart-me.js";
import { LiveCueForwarder } from "./lib/livecue-forwarder.js";
import { liveProviderInfo, loadLiveProvider } from "./lib/live-provider.js";
import { normalizeCollectorEvent } from "./lib/external-collector.js";
import { isFirstVisitClaim } from "./lib/first-visit-claim.js";
import { shouldRotateCollectorSession } from "./lib/external-collector.js";
import { optimizeAvatarImage } from "./lib/avatar-image.js";
import { tiktokProfileFromUser } from "./lib/tiktok-profile.js";

if (!globalThis.process) {
  globalThis.process = { env: {} };
}

const PORT = Number(globalThis.__TIKTOK_LIVE_PORT__ || globalThis.process?.env?.PORT || 3030);
const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const sessions = new Map();
const listenerSummaryCache = new Map();
const LISTENER_SUMMARY_CACHE_MS = 30000;
const listenerPageCache = new Map();
const listenerPagePromises = new Map();
const LISTENER_PAGE_CACHE_MS = 30000;
const LISTENER_TOTAL_PENDING_CACHE_MS = 10000;
const LISTENER_PAGE_CACHE_MAX = 100;
const SESSION_TTL_MS = Number(globalThis.process?.env?.SESSION_TTL_MS || 1000 * 60 * 60 * 24);
const DATABASE_RETRY_MS = Number(globalThis.process?.env?.DATABASE_RETRY_MS || 15000);
const COLLECTOR_HEARTBEAT_STALE_MS = Number(globalThis.process?.env?.COLLECTOR_HEARTBEAT_STALE_MS || 150000);
const COLLECTOR_RECEIVING_STALE_MS = Number(globalThis.process?.env?.COLLECTOR_RECEIVING_STALE_MS || 15 * 60 * 1000);
const COLLECTOR_NEW_LIVE_GAP_MS = Number(globalThis.process?.env?.COLLECTOR_NEW_LIVE_GAP_MS || 3 * 60 * 60 * 1000);
const SUPER_LURKER_ALERT_TYPES = new Set(["join", "comment", "gift", "share", "like", "follow", "subscribe"]);
let connectionPauseUntil = 0;
let databaseRecoveryPending = false;
const TIKTOOLS_SESSION_COOKIE = String(globalThis.process?.env?.TIKTOOLS_SESSION_COOKIE || "").trim();
const LISTENER_ADMIN_KEY = String(globalThis.process?.env?.LISTENER_ADMIN_KEY || "").trim();
const COLLECTOR_INGEST_KEY = String(globalThis.process?.env?.COLLECTOR_INGEST_KEY || "").trim();
const EXTERNAL_COLLECTOR_ENABLED = String(globalThis.process?.env?.LIVE_SOURCE || "").toLowerCase() === "collector"
  && Boolean(COLLECTOR_INGEST_KEY);
let collectorPreviewSessionId = null;
const providerInfo = EXTERNAL_COLLECTOR_ENABLED
  ? { id: "tikfinity", label: "TikFinity (note PC)", mode: "external", paidApiReady: false }
  : liveProviderInfo(globalThis.process?.env || {});
const eventStore = new EventStore({
  connectionString: globalThis.process?.env?.DATABASE_URL || "",
  ssl: String(globalThis.process?.env?.DATABASE_SSL || "").toLowerCase() === "false" ? false : undefined
});
const avatarCachePending = new Set();
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
    this.heartMeHistoryLookups = new Map();
    this.viewerStats = {
      current: 0,
      peak: 0,
      knownJoins: 0,
      totalLikes: 0,
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
    this.collectorBridge = null;
    this.collectorRecentIds = new Map();
    this.lastCollectorAt = null;
    this.lastCollectorHeartbeatAt = null;
    this.lastCollectorEventAt = null;
    this.recordingEnabled = options.recordingEnabled !== false;
    this.pendingVisitChecks = new Map();
    this.pendingDatabaseEvents = [];
    this.databaseFlushPromise = null;
    this.persistencePromises = new Set();
    this.persistenceTail = Promise.resolve();
    this.collectorDiagnostics = null;
    this.ingestionStats = {
      accepted: 0,
      duplicate: 0,
      stored: 0,
      queuedTotal: 0,
      acceptedByType: {},
      duplicateByType: {},
      storedByType: {},
      queuedByType: {},
      lastAcceptedAt: null,
      lastStoredAt: null,
      lastQueuedAt: null
    };
    this.firstVisitClaimPendingIds = new Set();
    this.firstVisitClaimAlertedIds = new Set();
    this.superLurkerPendingIds = new Set();
    this.superLurkerAlertedIds = new Set();
    this.superLurkerCheckedAt = new Map();
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
      this.broadcastSummary(`${connector.label}でTikTok LIVEへ接続中です。`);
      const state = await this.connectLiveWithRetries(connector);
      this.roomId = String(state?.roomId || this.connection?.roomId || this.roomId || "");
      this.displayName = displayNameFromRoomInfo(state?.roomInfo || this.connection?.roomInfo, this.username);
      this.status = "live";
      this.connectedAt = Date.now();
      this.lastEventAt = this.connectedAt;
      this.persistSession();
      this.broadcastSummary(`LIVE接続を開始しました。RoomId: ${this.roomId || "取得済み"}`);
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
      this.broadcastSummary(`TikTok LIVEへ接続中です。試行 ${index + 1}/${attempts.length}`);

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
      this.trackPersistence((async () => {
      const giftType = Number(data.giftType ?? data.giftDetails?.giftType ?? data.extendedGiftInfo?.giftType ?? 0);
      if (giftType === 1 && data.repeatEnd === false) return;
      const gift = parseGiftEvent(data, this.heartMeGiftIds);
      gift.source = this.currentEventSource();
      const previousUser = this.userStats.get(gift.userId);
      gift.previousHeartMeStatus = previousUser?.heartMeStatus || null;
      if (gift.isHeartMe) {
        if (gift.giftId) this.heartMeGiftIds.add(String(gift.giftId));
        const history = await this.heartMeHistoryFor(gift.userId);
        gift.heartMeHistoryKnown = history.known;
        gift.pastHeartMeGiftCount = history.pastCount;
        gift.lastPastHeartMeAt = history.lastAt;
      }
      this.markSeen({ userId: gift.userId, uniqueId: gift.uniqueId, nickname: gift.nickname, avatarUrl: gift.avatarUrl, signals: gift.signals }, gift.at, "gift");
      this.addGift(gift);
      })());
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
      const likeCount = Number(
        data.likeCount ?? data.like_count ?? data.count ?? data.likeMessage?.likeCount ?? 0
      );
      const totalLikes = Number(
        data.totalLikes ?? data.totalLikeCount ?? data.total_like_count ?? data.likeMessage?.totalLikeCount ?? 0
      );
      if (Number.isFinite(totalLikes) && totalLikes > 0) {
        this.viewerStats.totalLikes = Math.max(Number(this.viewerStats.totalLikes || 0), totalLikes);
      }
      this.markSeen(person, at, "like");
      this.emitNormalized({
        id: data.msgId || randomUUID(),
        type: "like",
        ...person,
        likeCount: Number.isFinite(likeCount) ? Math.max(0, likeCount) : 0,
        totalLikes: Number.isFinite(totalLikes) ? Math.max(0, totalLikes) : 0,
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
      this.trackPersistence((async () => {
      const person = personFromEvent(data);
      const at = eventTime(data);
      this.markSeen(person, at, "heart_me");
      const history = await this.heartMeHistoryFor(person.userId);
      this.markHeartMe(person, at, {
        status: "new_today",
        level: heartMeLevelFromEvent(data),
        source: "super_fan_event",
        history
      });
      })());
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
      const rankedUpdate = this.updateCurrentViewerRank(data, now);
      if (rankedUpdate !== null) {
        shouldBroadcast = true;
      }
      if (shouldBroadcast) {
        this.broadcastPresence(rankedUpdate?.users || [], {
          replaceCurrentRanking: Boolean(rankedUpdate),
          removedCurrentViewerIds: rankedUpdate?.removedUserIds || []
        });
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
        this.broadcastSummary(message);
      }
    });

    connection.on(events.CONNECTED || "connected", () => {
      if (this.stoppedAt) return;
      this.status = "live";
      this.connectedAt ||= Date.now();
      this.persistSession();
      this.broadcastSummary("TikTok LIVEへ接続しています。");
    });

    connection.on(events.ERROR || "error", (error) => {
      this.broadcastSummary(`接続エラー: ${diagnoseConnectError(error)}`);
    });
  }

  markSeen(person, at, presenceSource = "event", { entryEvent = false } = {}) {
    if (isAnonymousListenerIdentity(person)) return false;
    this.lastEventAt = Math.max(this.lastEventAt || 0, at);
    const user = this.getUserStat(person.userId, person.nickname, at, person.signals);
    if (person.uniqueId) user.uniqueId = person.uniqueId;
    if (person.avatarUrl) user.avatarUrl = person.avatarUrl;
    if (!user.hasJoined) {
      user.hasJoined = true;
      user.firstJoinAt = at;
      user.lastJoinAt = at;
      user.visitHistoryKnown = false;
      user.visitHistoryStatus = this.recordingEnabled ? "checking" : "unknown";
      user.visitCount = 0;
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
    return true;
  }

  markHeartMe(person, at, { status, level = 0, source = "", history = null } = {}) {
    if (isAnonymousListenerIdentity(person)) return false;
    const user = this.getUserStat(person.userId, person.nickname, at, person.signals);
    const resolvedStatus = status === "new_today"
      ? nextHeartMeStatusForGift(user.heartMeStatus)
      : status;
    user.heartMeStatus = resolvedStatus || user.heartMeStatus;
    if (status === "new_today") {
      user.heartMeToday = true;
      user.lastHeartMeAt = at;
      user.heartMeHistoryKnown = Boolean(history?.known);
      user.pastHeartMeGiftCount = Math.max(0, Number(history?.pastCount || 0));
      user.lastPastHeartMeAt = history?.lastAt || user.lastPastHeartMeAt || null;
      user.heartMeHistoryStatus = history?.known
        ? user.pastHeartMeGiftCount > 0 ? "returning" : "first_ever"
        : user.heartMeHistoryStatus || "unknown";
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
      isHeartMe: status === "new_today",
      repeatCount: status === "new_today" ? 1 : 0,
      at,
      source: this.currentEventSource()
    });
    this.broadcastPresence([user]);
    return true;
  }

  recordVisit(user, at, source) {
    if (!this.recordingEnabled) return;
    this.pendingVisitChecks.set(user.userId, {
      running: false,
      visit: {
        userId: user.userId,
        uniqueId: user.uniqueId || "",
        nickname: user.nickname,
        avatarUrl: user.avatarUrl || "",
        at,
        source
      }
    });
    this.runVisitCheck(user.userId).catch(() => {});
  }

  async runVisitCheck(userId) {
    const pending = this.pendingVisitChecks.get(userId);
    if (!pending || pending.running || !this.recordingEnabled) return false;
    pending.running = true;
    try {
      let judgmentApplied = false;
      const summary = await eventStore.recordVisit(this, pending.visit, {
        onJudgment: (judgment) => {
          judgmentApplied = this.applyVisitSummary(userId, pending.visit, judgment, { includeHeartMe: false });
        },
      });
      if (!judgmentApplied) {
        if (!this.applyVisitSummary(userId, pending.visit, summary, { includeHeartMe: true })) return false;
      } else {
        this.applyVisitSummary(userId, pending.visit, summary, { includeHeartMe: true });
      }
      const known = Boolean(summary?.visitHistoryKnown);
      if (known) this.pendingVisitChecks.delete(userId);
      return known;
    } finally {
      pending.running = false;
    }
  }

  applyVisitSummary(userId, visit, summary, { includeHeartMe = false } = {}) {
    const current = this.userStats.get(userId);
    if (!current) {
      this.pendingVisitChecks.delete(userId);
      return false;
    }
    if (!summary?.visitHistoryKnown) {
      current.visitHistoryKnown = false;
      current.visitHistoryStatus = "unknown";
      current.visitCount = 0;
    } else {
      current.visitHistoryKnown = true;
      current.visitHistoryStatus = Number(summary.visitCount || 0) === 1 ? "first" : "returning";
      current.visitCount = Math.max(1, Number(summary.visitCount || 1));
      current.firstVisitAt = summary.firstVisitAt || current.firstVisitAt || visit.at;
      current.lastVisitAt = summary.lastVisitAt || current.lastVisitAt || visit.at;
      current.previousVisitAt = summary.previousVisitAt || current.previousVisitAt || null;
    }
    if (includeHeartMe) {
      current.heartMeHistoryKnown = Boolean(summary?.heartMeHistoryKnown);
      current.pastHeartMeGiftCount = Math.max(0, Number(summary?.pastHeartMeGiftCount || 0));
      current.lastPastHeartMeAt = summary?.lastPastHeartMeAt || current.lastPastHeartMeAt || null;
      if (current.pastHeartMeGiftCount > 0) current.heartMeHistoryStatus = "returning";
    }
    this.userStats.set(current.userId, current);
    this.broadcastPresence([current]);
    return true;
  }

  async retryPendingVisits() {
    // Avoid a reconnect/maintenance tick launching hundreds of history
    // queries at once. Sequential retries are background work and do not
    // compete with new LIVE comments and gifts.
    for (const userId of [...this.pendingVisitChecks.keys()]) {
      await this.runVisitCheck(userId).catch(() => false);
    }
  }

  async heartMeHistoryFor(userId) {
    const key = String(userId || "");
    if (!key) return { known: false, pastCount: 0, lastAt: null };
    let lookup = this.heartMeHistoryLookups.get(key);
    if (!lookup) {
      lookup = eventStore.heartMeHistory({
        sessionId: this.id,
        roomId: this.roomId,
        username: this.username,
        userId: key
      });
      this.heartMeHistoryLookups.set(key, lookup);
    }
    const history = await lookup;
    if (!history.known) this.heartMeHistoryLookups.delete(key);
    return history;
  }

  markFollowedToday(person, at) {
    if (isAnonymousListenerIdentity(person)) return false;
    this.lastEventAt = Math.max(this.lastEventAt || 0, at);
    const user = this.getUserStat(person.userId, person.nickname, at, person.signals);
    user.followedToday = true;
    user.followedAt = at;
    user.isFollowingHost = true;
    user.followStatus = "following";
    user.followStatusSource = "follow_event";
    user.lastSeenAt = Math.max(user.lastSeenAt, at);
    this.userStats.set(user.userId, user);
    this.broadcastPresence([user]);
    return true;
  }

  addComment(comment) {
    if (isAnonymousListenerIdentity(comment)) return false;
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
    this.checkFirstVisitClaim(comment).catch(() => {});
    this.broadcast("comment", {
      comment: this.decorateUserEvent(comment),
      summary: this.summary(),
      users: [this.realtimeUser(current)]
    });
    return true;
  }

  addGift(gift) {
    if (isAnonymousListenerIdentity(gift)) return false;
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
      user.heartMeHistoryKnown = Boolean(gift.heartMeHistoryKnown);
      user.pastHeartMeGiftCount = Math.max(0, Number(gift.pastHeartMeGiftCount || 0));
      user.lastPastHeartMeAt = gift.lastPastHeartMeAt || user.lastPastHeartMeAt || null;
      user.heartMeHistoryStatus = gift.heartMeHistoryKnown
        ? user.pastHeartMeGiftCount > 0 ? "returning" : "first_ever"
        : user.heartMeHistoryStatus || "unknown";
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
    this.broadcast("gift", {
      gift: this.decorateUserEvent(normalizedGift),
      summary: this.summary(),
      users: [this.realtimeUser(user)],
      topGifts: this.currentTopGifts()
    });
    return true;
  }

  addShare(share) {
    if (isAnonymousListenerIdentity(share)) return false;
    this.lastEventAt = Math.max(this.lastEventAt || 0, share.at);
    this.shareCount += 1;
    this.shares.unshift(share);
    this.shares = this.shares.slice(0, 200);

    const user = this.getUserStat(share.userId, share.nickname, share.at, share.signals);
    user.shares = Number(user.shares || 0) + 1;
    user.lastSeenAt = share.at;
    this.userStats.set(user.userId, user);
    this.emitNormalized({ ...share, type: "share" });
    this.broadcast("share", {
      share: this.decorateUserEvent(share),
      summary: this.summary(),
      users: [this.realtimeUser(user)]
    });
    return true;
  }

  async checkFirstVisitClaim(comment) {
    if (
      !this.recordingEnabled
      || comment.source === "initial"
      || !isFirstVisitClaim(comment.text)
    ) return false;

    const identityKey = String(comment.userId || comment.uniqueId || "").toLowerCase();
    if (
      !identityKey
      || this.firstVisitClaimPendingIds.has(identityKey)
      || this.firstVisitClaimAlertedIds.has(identityKey)
    ) return false;

    this.firstVisitClaimPendingIds.add(identityKey);
    try {
      const current = this.userStats.get(comment.userId);
      const history = current?.visitHistoryKnown
        ? {
          known: true,
          priorVisitCount: Math.max(0, Number(current.visitCount || 0) - 1),
          lastPriorVisitAt: current.previousVisitAt || null,
        }
        : await eventStore.priorListenerHistory({
          sessionId: this.id,
          roomId: this.roomId,
          username: this.username,
          userId: comment.userId,
          uniqueId: comment.uniqueId,
        });
      if (!history.known || history.priorVisitCount < 1) return false;

      this.firstVisitClaimAlertedIds.add(identityKey);
      const alert = {
        id: `first-claim:${comment.id || randomUUID()}`,
        type: "first_visit_claim_alert",
        userId: comment.userId,
        uniqueId: comment.uniqueId || "",
        nickname: comment.nickname || comment.uniqueId || "TikTokユーザー",
        avatarUrl: comment.avatarUrl || "",
        text: "初見ではありません",
        at: comment.at || Date.now(),
        source: comment.source || "live",
        payload: {
          originalComment: String(comment.text || "").slice(0, 300),
          priorVisitCount: history.priorVisitCount,
          lastPriorVisitAt: history.lastPriorVisitAt,
        },
      };
      this.emitNormalized(alert);
      this.broadcast("first_visit_claim_alert", { alert });
      return true;
    } finally {
      this.firstVisitClaimPendingIds.delete(identityKey);
    }
  }

  async checkSuperLurker(event) {
    if (
      !this.recordingEnabled
      || isAnonymousListenerIdentity(event)
      || event.source === "initial"
      || !SUPER_LURKER_ALERT_TYPES.has(event.type)
    ) return false;

    const identityKey = String(event.userId || event.uniqueId || "").toLowerCase();
    if (!identityKey || this.superLurkerPendingIds.has(identityKey) || this.superLurkerAlertedIds.has(identityKey)) {
      return false;
    }
    const lastCheckedAt = Number(this.superLurkerCheckedAt.get(identityKey) || 0);
    if (Date.now() - lastCheckedAt < 15000) return false;

    this.superLurkerPendingIds.add(identityKey);
    this.superLurkerCheckedAt.set(identityKey, Date.now());
    try {
      const flags = await eventStore.listenerManagementFlags({
        userId: event.userId,
        uniqueId: event.uniqueId,
      });
      if (!flags.known || !flags.isSuperLurker) return false;

      this.superLurkerAlertedIds.add(identityKey);
      const alert = {
        id: `super-lurker:${this.id}:${flags.userId || identityKey}`,
        type: "super_lurker_alert",
        userId: flags.userId || event.userId || "",
        uniqueId: event.uniqueId || flags.uniqueId || "",
        nickname: event.nickname || flags.nickname || event.uniqueId || flags.uniqueId || "TikTokユーザー",
        avatarUrl: event.avatarUrl || (flags.avatarCached ? `/api/listeners/avatar/${encodeURIComponent(flags.userId)}` : flags.avatarUrl) || "",
        text: "スーパー潜り人！",
        at: event.at || Date.now(),
        source: event.source || "live",
        payload: { triggerType: event.type },
      };
      this.emitNormalized(alert);
      this.broadcast("super_lurker_alert", { alert });
      return true;
    } finally {
      this.superLurkerPendingIds.delete(identityKey);
    }
  }

  emitNormalized(event) {
    if (!this.recordingEnabled) return;
    // TikFinity can occasionally emit member events with no TikTok identity.
    // They are useful for transport diagnostics but must never become a
    // listener, visit, rank, or alert under the shared placeholder "unknown".
    if (isAnonymousListenerIdentity(event)) return;
    if (event?.type !== "super_lurker_alert") this.checkSuperLurker(event).catch(() => {});
    if (!eventStore.status().ready) {
      this.queueDatabaseEvent(event);
    } else {
      // Keep writes from one LIVE in event order. Bursts of member/like/chat
      // events used to update the same listener rows concurrently, which could
      // deadlock PostgreSQL and make the collector wait before sending the next
      // batch.
      const persistence = this.persistenceTail
        .catch(() => {})
        .then(async () => {
          const stored = await eventStore.recordEvent(this, event);
          if (!stored) this.queueDatabaseEvent(event);
          else {
            this.noteIngestion("stored", event.type);
            cacheListenerAvatar(event.userId, event.avatarUrl).catch(() => {});
          }
        })
        .catch(() => this.queueDatabaseEvent(event));
      this.persistenceTail = persistence;
      this.trackPersistence(persistence);
    }
    liveCue.publish(event);
  }

  trackPersistence(promise) {
    const tracked = Promise.resolve(promise);
    this.persistencePromises.add(tracked);
    tracked.finally(() => this.persistencePromises.delete(tracked)).catch(() => {});
    return tracked;
  }

  async awaitCollectorDurability() {
    // Acknowledge the collector as soon as the database is available. Event
    // persistence continues in the ordered background queue. Waiting for a
    // busy member/roomUser burst here blocked the collector's only HTTP request
    // and made later live comments appear many seconds late.
    this.flushPendingDatabaseEvents().catch(() => {});
    return eventStore.status().ready;
  }

  queueDatabaseEvent(event) {
    const key = `${event?.type || ""}:${event?.id || ""}`;
    if (key !== ":" && this.pendingDatabaseEvents.some((item) => item.key === key)) return false;
    this.pendingDatabaseEvents.push({ key, event: { ...event } });
    if (this.pendingDatabaseEvents.length > 10000) this.pendingDatabaseEvents.shift();
    this.noteIngestion("queued", event?.type);
    return true;
  }

  async flushPendingDatabaseEvents() {
    if (this.databaseFlushPromise) return this.databaseFlushPromise;
    this.databaseFlushPromise = (async () => {
      while (this.pendingDatabaseEvents.length && eventStore.status().ready) {
        const pending = this.pendingDatabaseEvents[0];
        const stored = await eventStore.recordEvent(this, pending.event);
        if (!stored) break;
        this.pendingDatabaseEvents.shift();
        this.noteIngestion("stored", pending.event?.type);
        cacheListenerAvatar(pending.event.userId, pending.event.avatarUrl).catch(() => {});
      }
      return this.pendingDatabaseEvents.length === 0;
    })();
    try {
      return await this.databaseFlushPromise;
    } finally {
      this.databaseFlushPromise = null;
    }
  }

  persistSession(options) {
    if (!this.recordingEnabled) return;
    eventStore.saveSession(this, options).catch(() => {});
  }

  noteIngestion(kind, rawType = "unknown") {
    const type = String(rawType || "unknown").slice(0, 40) || "unknown";
    const now = Date.now();
    if (kind === "accepted") {
      this.ingestionStats.accepted += 1;
      this.ingestionStats.acceptedByType[type] = Number(this.ingestionStats.acceptedByType[type] || 0) + 1;
      this.ingestionStats.lastAcceptedAt = now;
    } else if (kind === "duplicate") {
      this.ingestionStats.duplicate += 1;
      this.ingestionStats.duplicateByType[type] = Number(this.ingestionStats.duplicateByType[type] || 0) + 1;
    } else if (kind === "stored") {
      this.ingestionStats.stored += 1;
      this.ingestionStats.storedByType[type] = Number(this.ingestionStats.storedByType[type] || 0) + 1;
      this.ingestionStats.lastStoredAt = now;
    } else if (kind === "queued") {
      this.ingestionStats.queuedTotal += 1;
      this.ingestionStats.queuedByType[type] = Number(this.ingestionStats.queuedByType[type] || 0) + 1;
      this.ingestionStats.lastQueuedAt = now;
    }
  }

  updateCollectorDiagnostics(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const cleanCounts = (value) => Object.fromEntries(
      Object.entries(value && typeof value === "object" ? value : {})
        .slice(0, 80)
        .map(([key, count]) => [String(key).slice(0, 60), Math.max(0, Number(count) || 0)])
    );
    const receipt = raw.receipt && typeof raw.receipt === "object" && !Array.isArray(raw.receipt)
      ? raw.receipt
      : {};
    const cleanText = (value, limit = 300) => String(value || "").slice(0, limit);
    this.collectorDiagnostics = {
      startedAt: raw.startedAt || null,
      updatedAt: raw.updatedAt || Date.now(),
      receivedByType: cleanCounts(raw.receivedByType),
      forwardedByType: cleanCounts(raw.forwardedByType),
      unknownByType: cleanCounts(raw.unknownByType),
      serverAccepted: Math.max(0, Number(raw.serverAccepted) || 0),
      serverDropped: Math.max(0, Number(raw.serverDropped) || 0),
      pendingEvents: Math.max(0, Number(raw.pendingEvents) || 0),
      pendingReceiptEvents: Math.max(0, Number(raw.pendingReceiptEvents) || 0),
      receipt: {
        reachable: receipt.reachable === true,
        printerReady: receipt.printerReady === true,
        printerVerified: receipt.printerVerified === true,
        printer: cleanText(receipt.printer, 100),
        tikfinity: cleanText(receipt.tikfinity, 40),
        queueCount: Math.max(0, Number(receipt.queueCount) || 0),
        sharedReceiptPendingCount: Math.max(0, Number(receipt.sharedReceiptPendingCount) || 0),
        lastPrintAt: cleanText(receipt.lastPrintAt, 80),
        lastPrintError: cleanText(receipt.lastPrintError, 300),
        checkedAt: cleanText(receipt.checkedAt, 80)
      }
    };
  }

  ingestionDiagnosticsSnapshot() {
    return {
      ...this.ingestionStats,
      acceptedByType: { ...this.ingestionStats.acceptedByType },
      duplicateByType: { ...this.ingestionStats.duplicateByType },
      storedByType: { ...this.ingestionStats.storedByType },
      queuedByType: { ...this.ingestionStats.queuedByType },
      pendingDatabaseEvents: this.pendingDatabaseEvents.length,
      collector: this.collectorDiagnostics ? {
        ...this.collectorDiagnostics,
        receivedByType: { ...this.collectorDiagnostics.receivedByType },
        forwardedByType: { ...this.collectorDiagnostics.forwardedByType },
        unknownByType: { ...this.collectorDiagnostics.unknownByType }
      } : null
    };
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
      visitHistoryKnown: false,
      visitHistoryStatus: "unknown",
      visitCount: 0,
      visitSource: "",
      firstVisitAt: null,
      lastVisitAt: null,
      previousVisitAt: null,
      watchSeconds: 0,
      confirmedWatchSeconds: 0,
      confirmedWatchMilliseconds: 0,
      rankedPresenceUpdatedAt: null,
      rankedVisitCount: 0,
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
      heartMeHistoryKnown: false,
      heartMeHistoryStatus: "unknown",
      pastHeartMeGiftCount: 0,
      lastPastHeartMeAt: null,
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

    const previousRanks = new Map(
      [...this.currentViewerIds].map((userId) => [userId, this.userStats.get(userId)?.currentViewerRank ?? null])
    );

    const rankedUsers = [];
    entries.forEach((entry, index) => {
      const person = personFromRankedViewer(entry);
      if (!person) return;
      this.markSeen(person, at, "viewer_ranking");
      const user = this.getUserStat(person.userId, person.nickname, at, person.signals);
      user.lastSeenAt = Math.max(user.lastSeenAt, at);
      user.currentViewerRankedAt = at;
      rankedUsers.push({ user, rank: rankedViewerPosition(entry, index) });
      this.userStats.set(user.userId, user);
    });

    const rankedUserIds = new Set(rankedUsers.map(({ user }) => user.userId));
    for (const user of this.userStats.values()) {
      updateRankedPresence(user, rankedUserIds.has(user.userId), at);
      user.currentViewerRank = null;
    }
    this.currentViewerIds.clear();
    for (const { user, rank } of rankedUsers) {
      user.currentViewerRank = rank;
      this.currentViewerIds.add(user.userId);
    }

    this.currentViewerRankUpdatedAt = at;
    this.viewerStats.currentRanked = this.currentViewerIds.size;
    this.viewerStats.rankUpdatedAt = at;
    const changedUsers = [...this.currentViewerIds]
      .map((userId) => this.userStats.get(userId))
      .filter((user) => user && previousRanks.get(user.userId) !== user.currentViewerRank);
    const removedUserIds = [...previousRanks.keys()].filter((userId) => !this.currentViewerIds.has(userId));
    const removedUsers = removedUserIds.map((userId) => this.userStats.get(userId)).filter(Boolean);
    return { count: this.currentViewerIds.size, users: [...changedUsers, ...removedUsers], removedUserIds };
  }

  summary(message = "") {
    this.touch();
    if (message) this.notice = message;
    this.updateEstimatedWatch();
    const users = [...this.userStats.values()];
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
      followedTodayCount: users.filter((user) => user.followedToday).length,
      heartMeStats: summarizeHeartMe(users),
      followStats: summarizeFollowStatus(users),
      viewerStats: { ...this.viewerStats }
    };
  }

  realtimeUser(user) {
    const silent = isSilentWatcher(user);
    return {
      ...user,
      isSilentWatcher: silent,
      presenceMode: silent ? silentWatcherPresenceMode(user) : ""
    };
  }

  currentTopGifts() {
    return [...this.giftStats.values()]
      .sort((a, b) => b.diamonds - a.diamonds || b.count - a.count || b.lastGiftAt - a.lastGiftAt)
      .slice(0, 30);
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
      .filter((user) => user.confirmedWatchSeconds > 0)
      .sort((a, b) => b.confirmedWatchSeconds - a.confirmedWatchSeconds || b.comments - a.comments || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 30);
    const silentLongWatchers = [...users]
      .filter((user) => isSilentWatcher(user))
      .sort((a, b) => b.watchSeconds - a.watchSeconds || a.currentViewerRank - b.currentViewerRank || b.lastSeenAt - a.lastSeenAt)
      .map((user) => ({ ...user, presenceMode: silentWatcherPresenceMode(user) }))
      .slice(0, 100);
    const currentViewerRanking = [...users]
      .filter((user) => user.isCurrentlyRanked)
      .sort((a, b) => a.currentViewerRank - b.currentViewerRank || b.confirmedWatchSeconds - a.confirmedWatchSeconds || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 100);
    const visitors = [...users]
      .filter((user) => user.hasJoined)
      .sort((a, b) => b.firstJoinAt - a.firstJoinAt || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 200);
    const topGifts = this.currentTopGifts();
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
      viewerStats: this.viewerStats,
      ingestionDiagnostics: this.ingestionDiagnosticsSnapshot(),
      recordingEnabled: this.recordingEnabled,
      preview: !this.recordingEnabled
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
      user.confirmedWatchSeconds = confirmedRankedWatchSeconds(user, now);
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

  broadcastSummary(message = "") {
    this.broadcast("status", { summary: this.summary(message) });
  }

  broadcastPresence(users = [], options = {}) {
    this.broadcast("presence", {
      summary: this.summary(),
      users: users.filter(Boolean).map((user) => this.realtimeUser(user)),
      replaceCurrentRanking: Boolean(options.replaceCurrentRanking),
      removedCurrentViewerIds: options.removedCurrentViewerIds || []
    });
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
    this.broadcastSummary(message);
  }

  stop(message = "停止しました。") {
    if (this.stoppedAt) return;
    this.stoppedAt = Date.now();
    this.status = this.status === "ended" ? "ended" : "stopped";
    if (this.connection?.disconnect) {
      Promise.resolve(this.connection.disconnect()).catch(() => {});
    }
    this.persistSession({ autoResume: false });
    this.broadcastSummary(message);
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
  // A roomUser payload may also contain top-gifter rankings. Those users are not
  // proof of current presence, so only consume fields that explicitly describe
  // the current audience.
  const candidates = [
    data?.currentViewers,
    data?.viewerList,
    data?.onlineUsers,
    data?.audienceList,
    data?.data?.currentViewers,
    data?.data?.viewerList,
    data?.data?.onlineUsers,
    data?.data?.audienceList,
    data?.message?.currentViewers,
    data?.message?.viewerList,
    data?.message?.onlineUsers,
    data?.message?.audienceList
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
  const profile = tiktokProfileFromUser(rawUser);
  return {
    heartMe: heartMeStateFromUser(rawUser),
    follow: followStateFromUser(rawUser, profile),
    profile
  };
}

function followStateFromUser(rawUser, profile = tiktokProfileFromUser(rawUser)) {
  if (!rawUser || typeof rawUser !== "object") return null;
  if (!profile.followStatus) return null;
  return {
    status: profile.followStatus,
    rawStatus: profile.followStatusRaw,
    isFollowingHost: profile.followStatus === "following",
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
    heartMeHistoryKnown: Boolean(user.heartMeHistoryKnown),
    heartMeHistoryStatus: user.heartMeHistoryStatus || "unknown",
    pastHeartMeGiftCount: Number(user.pastHeartMeGiftCount || 0),
    lastPastHeartMeAt: user.lastPastHeartMeAt,
    visitHistoryKnown: Boolean(user.visitHistoryKnown),
    visitHistoryStatus: user.visitHistoryStatus || "unknown",
    visitCount: Number(user.visitCount || 0),
    firstVisitAt: user.firstVisitAt,
    lastVisitAt: user.lastVisitAt,
    previousVisitAt: user.previousVisitAt
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
  const nestedMessage = data.memberMessage || data.likeMessage || data.chatMessage || data.giftMessage || {};
  const rawUser = data.user || data.userInfo || data.viewer || data.author || data.data?.user || nestedMessage.user || data;
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

function isAnonymousListenerIdentity(value = {}) {
  const userId = String(value.userId || "").trim().toLowerCase();
  const uniqueId = String(value.uniqueId || "").trim().replace(/^@/, "").toLowerCase();
  const nickname = String(value.nickname || "").trim().toLowerCase();
  const missing = (part) => !part || part === "unknown";
  return missing(userId) && missing(uniqueId) && missing(nickname);
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
    giftImageUrl: giftImageUrlFromEvent(data, extended),
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
  const nestedMessage = data?.memberMessage || data?.likeMessage || data?.chatMessage || data?.giftMessage || {};
  const value = Number(
    data?.timestamp || data?.createTime || data?.create_time || data?.common?.createTime || nestedMessage?.createTime || 0
  );
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
  const json = Buffer.from(JSON.stringify(body));
  const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(String(response.req?.headers?.["accept-encoding"] || ""));
  const payload = acceptsGzip && json.length >= 512 ? gzipSync(json, { level: 6 }) : json;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": payload.length,
    Vary: "Accept-Encoding",
    ...(payload !== json ? { "Content-Encoding": "gzip" } : {})
  });
  response.end(payload);
}

function setBoundedCache(cache, key, value, maxEntries) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

function clearListenerCaches() {
  listenerPageCache.clear();
  listenerSummaryCache.clear();
}

function normalizeListenerSearch(value) {
  return String(value || "").normalize("NFKC").trim().replace(/^@/, "");
}

function publicContributionRank(rank) {
  if (!rank) return {};
  const { searchText: _searchText, userId: _userId, ...publicRank } = rank;
  return publicRank;
}

function listenerRowsToCsv(rows = []) {
  const output = [["ユーザーID", "TikTok ID", "表示名", "あなたをフォロー", "本人のフォロー数", "本人のフォロワー数", "プロフィール確認日時", "来訪回数", "コメント数", "ギフト個数", "ギフトコイン", "シェア回数", "スーパーファン", "初回来訪", "最終来訪", "タグ", "メモ"]];
  for (const item of rows) {
    output.push([
      item.userId, item.uniqueId, item.nickname, ({following:"フォロー中",not_following:"未フォロー"})[item.hostFollowStatus] || "未確認",
      item.followingCount ?? "", item.followerCount ?? "", item.profileCountsUpdatedAt ? new Date(item.profileCountsUpdatedAt).toISOString() : "",
      item.visits, item.comments, item.gifts,
      item.coins, item.shares, item.isSuperFan ? "はい" : "",
      item.firstSeenAt ? new Date(item.firstSeenAt).toISOString() : "",
      item.lastSeenAt ? new Date(item.lastSeenAt).toISOString() : "",
      (item.tags || []).join(" / "), item.notes || ""
    ]);
  }
  return `\uFEFF${output.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

function sessionRowsToCsv(rows = []) {
  const output = [["type", "source", "time", "user_id", "tiktok_id", "nickname", "text_or_gift", "count", "coins"]];
  for (const item of rows) {
    output.push([
      item.type, item.source || "live", item.at ? new Date(item.at).toISOString() : "",
      item.userId, item.uniqueId, item.nickname,
      item.type === "comment" ? item.text : item.giftName || item.giftId || item.text,
      item.count || "", item.coins || ""
    ]);
  }
  return `\uFEFF${output.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

function isAuthorizedWithKey(request, expectedKey) {
  if (!expectedKey) return false;
  const authorization = String(request.headers.authorization || "");
  const supplied = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(expectedKey);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function isAuthorizedListenerRequest(request) {
  return isAuthorizedWithKey(request, LISTENER_ADMIN_KEY);
}

const listenerAuthAttempts = new Map();

function listenerAuthClientKey(request) {
  return String(request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function listenerAuthBlocked(request) {
  const key = listenerAuthClientKey(request);
  const current = listenerAuthAttempts.get(key);
  if (!current) return false;
  if (current.blockedUntil > Date.now()) return true;
  if (current.startedAt < Date.now() - 10 * 60 * 1000) listenerAuthAttempts.delete(key);
  return false;
}

function noteListenerAuthFailure(request) {
  const key = listenerAuthClientKey(request);
  const now = Date.now();
  const previous = listenerAuthAttempts.get(key);
  const current = !previous || previous.startedAt < now - 10 * 60 * 1000
    ? { count: 0, startedAt: now, blockedUntil: 0 }
    : previous;
  current.count += 1;
  if (current.count >= 20) current.blockedUntil = now + 15 * 60 * 1000;
  listenerAuthAttempts.set(key, current);
}

function requireListenerAdmin(request, response) {
  if (!LISTENER_ADMIN_KEY) {
    sendJson(response, 503, { error: "リスナー管理キーがまだ設定されていません" });
    return false;
  }
  if (listenerAuthBlocked(request)) {
    sendJson(response, 429, { error: "管理キーの入力回数が多すぎます。15分後に再試行してください" });
    return false;
  }
  if (!isAuthorizedListenerRequest(request)) {
    noteListenerAuthFailure(request);
    sendJson(response, 401, { error: "管理キーを確認してください" });
    return false;
  }
  listenerAuthAttempts.delete(listenerAuthClientKey(request));
  return true;
}

function findCollectorSession(username, { activeOnly = false, recordingEnabled = true } = {}) {
  return [...sessions.values()]
    .filter((session) => session.username.toLowerCase() === username.toLowerCase())
    .filter((session) => session.recordingEnabled === recordingEnabled)
    .filter((session) => !activeOnly || (!session.stoppedAt && session.status !== "ended" && session.status !== "stopped"))
    .sort((left, right) => {
      const leftCollector = left.mode === "collector" ? 1 : 0;
      const rightCollector = right.mode === "collector" ? 1 : 0;
      return rightCollector - leftCollector || Number(right.startedAt || 0) - Number(left.startedAt || 0);
    })[0] || null;
}

function prepareCollectorSession(session) {
  if (!session.collectorBridge) {
    session.collectorBridge = new EventEmitter();
    session.attachLiveHandlers(session.collectorBridge, {});
  }
  if (session.connection) {
    Promise.resolve(session.connection.disconnect?.()).catch(() => {});
    session.connection = null;
  }
  if (session.stoppedAt) session.startedAt = Date.now();
  session.provider = "tikfinity";
  session.mode = "collector";
  session.status = "waiting";
  session.stoppedAt = null;
  session.errorCode = "";
  session.notice = session.recordingEnabled
    ? "note PCのTikFinityコレクターを待っています。"
    : "保存しない確認モードです。受信内容はデータベースへ記録されません。";
  session.persistSession();
  return session;
}

function ensureCollectorSession(username) {
  const existing = findCollectorSession(username, { activeOnly: true });
  if (existing) {
    if (existing.mode !== "collector" || !existing.collectorBridge) prepareCollectorSession(existing);
    return existing;
  }

  const session = prepareCollectorSession(new LiveSession(username));
  sessions.set(session.id, session);
  return session;
}

function collectorSessionForEvents(username, normalizedEvents = []) {
  const preview = activeCollectorPreviewSession();
  if (preview) return preview;
  const firstRoomId = normalizedEvents.find((event) => event.roomId)?.roomId || "";
  const eventAt = Math.max(0, ...normalizedEvents.map((event) => Number(event.at || 0))) || Date.now();
  const existing = findCollectorSession(username, { activeOnly: true, recordingEnabled: true });
  if (existing && shouldRotateCollectorSession({
    currentRoomId: existing.roomId,
    incomingRoomId: firstRoomId,
    lastEventAt: existing.lastCollectorEventAt || 0,
    eventAt,
    gapMs: COLLECTOR_NEW_LIVE_GAP_MS
  })) {
    existing.stop("新しい配信を検出したため、前の配信記録を終了しました。");
  }
  const session = existing?.stoppedAt ? ensureCollectorSession(username) : existing || ensureCollectorSession(username);
  if (firstRoomId && !session.roomId) session.roomId = String(firstRoomId);
  return session;
}

function activateCollectorSession(session) {
  if (session.mode !== "collector" || !session.collectorBridge) prepareCollectorSession(session);
  const wasLive = session.status === "live";
  session.status = "live";
  session.stoppedAt = null;
  session.connectedAt ||= Date.now();
  session.lastCollectorAt = Date.now();
  session.lastCollectorHeartbeatAt = session.lastCollectorAt;
  session.lastCollectorEventAt = session.lastCollectorAt;
  session.notice = session.recordingEnabled
    ? "note PCのTikFinityからLIVEイベントを受信中です。"
    : "保存しない確認モードでTikFinityのイベントを受信中です。";
  if (!wasLive) session.broadcastSummary(session.notice);
}

function activeCollectorPreviewSession() {
  if (!collectorPreviewSessionId) return null;
  const session = sessions.get(collectorPreviewSessionId);
  if (!session || session.recordingEnabled || session.stoppedAt) {
    collectorPreviewSessionId = null;
    return null;
  }
  return session;
}

function startCollectorPreviewSession(username) {
  const previous = activeCollectorPreviewSession();
  if (previous) previous.stop("別の保存しない確認モードへ切り替えました。");
  const session = prepareCollectorSession(new LiveSession(username, { recordingEnabled: false }));
  sessions.set(session.id, session);
  collectorPreviewSessionId = session.id;
  return session;
}

function addPreviewDemoEvents(session) {
  if (!session || session.recordingEnabled) return false;
  activateCollectorSession(session);
  const at = Date.now();
  const person = {
    userId: `preview-${randomUUID()}`,
    uniqueId: "demo_listener",
    nickname: "テスト視聴者",
    avatarUrl: "",
    signals: null
  };
  session.markSeen(person, at, "member", { entryEvent: true });
  session.addComment({
    id: randomUUID(),
    ...person,
    text: "配信前テストのコメントです",
    at: at + 1,
    source: "preview"
  });
  session.addGift({
    id: randomUUID(),
    ...person,
    giftId: "preview-rose",
    giftName: "テストのバラ",
    giftImageUrl: "/gift-preview-rose.svg",
    repeatCount: 3,
    diamondCount: 1,
    isHeartMe: false,
    at: at + 2,
    source: "preview"
  });
  session.addShare({
    id: randomUUID(),
    ...person,
    label: "テストシェア",
    at: at + 3,
    source: "preview"
  });
  session.viewerStats.current = 1;
  session.viewerStats.peak = Math.max(1, session.viewerStats.peak);
  session.broadcastPresence([session.userStats.get(person.userId)]);
  session.broadcastSummary("配信前テストを表示しました。データベース・印刷・外部連携には保存されません。");
  return true;
}

function isDuplicateCollectorEvent(session, key) {
  if (!key) return false;
  const now = Date.now();
  const previous = session.collectorRecentIds.get(key);
  session.collectorRecentIds.set(key, now);
  if (session.collectorRecentIds.size > 5000) {
    for (const [storedKey, storedAt] of session.collectorRecentIds) {
      if (storedAt < now - 1000 * 60 * 30 || session.collectorRecentIds.size > 4000) {
        session.collectorRecentIds.delete(storedKey);
      }
      if (session.collectorRecentIds.size <= 4000) break;
    }
  }
  return Boolean(previous && previous > now - 1000 * 60 * 30);
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

  if (request.method === "POST" && url.pathname === "/api/collector/events") {
    if (!EXTERNAL_COLLECTOR_ENABLED) {
      sendJson(response, 503, { error: "外部コレクターが設定されていません。" });
      return;
    }
    if (!isAuthorizedWithKey(request, COLLECTOR_INGEST_KEY)) {
      sendJson(response, 401, { error: "コレクター認証に失敗しました。" });
      return;
    }

    try {
      const body = await readBody(request);
      const username = normalizeTikTokUsername(body.streamUsername || body.username);
      if (!isValidUsername(username)) {
        sendJson(response, 400, { error: "配信者のTikTok IDを確認してください。" });
        return;
      }

      const incoming = Array.isArray(body.events) ? body.events.slice(0, 250) : [];
      const normalizedIncoming = incoming.map(normalizeCollectorEvent).filter(Boolean);
      const session = normalizedIncoming.length > 0
        ? collectorSessionForEvents(username, normalizedIncoming)
        : ensureCollectorSession(username);
      let accepted = 0;
      let dropped = Math.max(0, incoming.length - normalizedIncoming.length);
      session.updateCollectorDiagnostics(body.diagnostics);
      for (const normalized of normalizedIncoming) {
        if (!normalized) {
          dropped += 1;
          continue;
        }
        if (isDuplicateCollectorEvent(session, normalized.key)) {
          session.noteIngestion("duplicate", normalized.type);
          dropped += 1;
          continue;
        }
        activateCollectorSession(session);
        session.noteIngestion("accepted", normalized.type);
        session.collectorBridge.emit(normalized.type, normalized.data);
        if (normalized.roomId) session.roomId = String(normalized.roomId);
        session.lastCollectorEventAt = Math.max(Number(session.lastCollectorEventAt || 0), Number(normalized.at || Date.now()));
        accepted += 1;
      }
      session.lastCollectorAt = Date.now();
      session.lastCollectorHeartbeatAt = session.lastCollectorAt;
      if (accepted === 0 && body.heartbeat) {
        session.broadcastSummary("note PCのTikFinityコレクターから待機信号を受信しました。");
      }
      session.persistSession();
      const durable = incoming.length === 0 || await session.awaitCollectorDurability();
      sendJson(response, 202, {
        ok: true,
        durable,
        sessionId: session.id,
        preview: !session.recordingEnabled,
        status: session.status,
        accepted,
        dropped,
        lastCollectorAt: session.lastCollectorAt,
        collectorState: accepted > 0 ? "receiving" : "waiting"
      });
    } catch (error) {
      sendJson(response, 400, { error: shortError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/session") {
    try {
      const body = await readBody(request);
      const username = normalizeTikTokUsername(body.username);
      if (!isValidUsername(username)) {
        sendJson(response, 400, { error: "TikTok IDは2から32文字の英数字、_、.で入力してください。" });
        return;
      }
      const preview = body.preview === true;
      if (preview && !requireListenerAdmin(request, response)) return;
      if (!EXTERNAL_COLLECTOR_ENABLED && connectionPauseUntil > Date.now()) {
        sendJson(response, 429, {
          error: `TikTok側の接続回数制限中です。${new Date(connectionPauseUntil).toLocaleTimeString("ja-JP")}頃まで新しい接続を止めています。`,
          errorCode: "rate_limited",
          retryAt: connectionPauseUntil
        });
        return;
      }
      const existing = EXTERNAL_COLLECTOR_ENABLED && !preview
        ? findCollectorSession(username, { activeOnly: true, recordingEnabled: true })
        : null;
      const session = preview
        ? startCollectorPreviewSession(username)
        : existing || new LiveSession(username);
      sessions.set(session.id, session);
      if (EXTERNAL_COLLECTOR_ENABLED && !preview && (!existing || session.mode !== "collector" || !session.collectorBridge)) {
        prepareCollectorSession(session);
      }
      if (session.recordingEnabled) await eventStore.saveSession(session);
      sendJson(response, existing ? 200 : 201, { id: session.id, preview: !session.recordingEnabled });
      if (!EXTERNAL_COLLECTOR_ENABLED && !preview) session.start();
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    const collectorSessions = [...sessions.values()].filter((session) => session.recordingEnabled && session.mode === "collector");
    const collectorHeartbeatAt = Math.max(0, ...collectorSessions.map((session) => Number(session.lastCollectorHeartbeatAt || session.lastCollectorAt || 0))) || null;
    const collectorEventAt = Math.max(0, ...collectorSessions.map((session) => Number(session.lastCollectorEventAt || 0))) || null;
    const latestCollectorSession = collectorSessions
      .slice()
      .sort((a, b) => Number(b.lastCollectorHeartbeatAt || b.lastCollectorAt || 0) - Number(a.lastCollectorHeartbeatAt || a.lastCollectorAt || 0))[0];
    const collectorConnected = Boolean(collectorHeartbeatAt && collectorHeartbeatAt >= Date.now() - COLLECTOR_HEARTBEAT_STALE_MS);
    const collectorState = !collectorConnected
      ? "offline"
      : collectorEventAt && collectorEventAt >= Date.now() - COLLECTOR_RECEIVING_STALE_MS
        ? "receiving"
        : "waiting";
    sendJson(response, 200, {
      ok: true,
      sessions: sessions.size,
      uptimeSeconds: Math.floor(getUptimeSeconds()),
      provider: providerInfo,
      collector: {
        enabled: EXTERNAL_COLLECTOR_ENABLED,
        connected: collectorConnected,
        state: collectorState,
        lastHeartbeatAt: collectorHeartbeatAt,
        lastEventAt: collectorEventAt,
        diagnostics: latestCollectorSession?.ingestionDiagnosticsSnapshot() || null,
        previewActive: Boolean(activeCollectorPreviewSession()),
        previewUsername: activeCollectorPreviewSession()?.username || ""
      },
      database: {
        ...eventStore.status(),
        visitJudgmentMode: "early-result-v2",
        queuedEvents: [...sessions.values()].reduce((total, session) => total + session.pendingDatabaseEvents.length, 0),
        pendingVisitChecks: [...sessions.values()].reduce((total, session) => total + session.pendingVisitChecks.size, 0)
      },
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

  if (url.pathname === "/api/integrations/stamp-state") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      if (request.method === "GET") {
        sendJson(response, 200, await eventStore.sharedStampState({
          revision: Number(url.searchParams.get("revision") ?? -1),
          superFanRevision: String(url.searchParams.get("superFanRevision") || "")
        }));
        return;
      }
      if (request.method === "PUT") {
        const body = await readBody(request);
        sendJson(response, 200, await eventStore.updateSharedStampState(body.state, {
          sourceRevision: Number(body.revision || 0),
          source: String(body.source || "count-pocket")
        }));
        return;
      }
      sendJson(response, 405, { error: "GETまたはPUTを使用してください" });
    } catch (error) {
      sendJson(response, 400, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/integrations/superfans" && request.method === "GET") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const [items, revision] = await Promise.all([eventStore.superFans(), eventStore.superFanRevision()]);
      sendJson(response, 200, { items, revision });
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/integrations/receipt-print" && request.method === "POST") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      sendJson(response, 200, await eventStore.recordReceiptPrint(await readBody(request)));
    } catch (error) {
      sendJson(response, 400, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners/summary") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const username = normalizeTikTokUsername(url.searchParams.get("username") || "");
      const cacheKey = username.toLowerCase() || "*";
      const cached = listenerSummaryCache.get(cacheKey);
      const forceFresh = url.searchParams.get("fresh") === "1";
      if (!forceFresh && cached && cached.at >= Date.now() - LISTENER_SUMMARY_CACHE_MS) {
        sendJson(response, 200, cached.value);
        return;
      }
      const summary = await eventStore.listenerSummary({ username });
      listenerSummaryCache.set(cacheKey, { at: Date.now(), value: summary });
      sendJson(response, 200, summary);
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners/export.csv" && request.method === "GET") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const rows = await eventStore.listenerExportRows({
        username: normalizeTikTokUsername(url.searchParams.get("username") || ""),
        search: normalizeListenerSearch(url.searchParams.get("search") || "")
      });
      response.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="listeners-${new Date().toISOString().slice(0, 10)}.csv"`
      });
      response.end(listenerRowsToCsv(rows));
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
      const result = await backfillListenerAvatars({
        limit: Number(body.limit || 10),
        offset: Number(body.offset || 0)
      });
      clearListenerCaches();
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners/avatars/import" && request.method === "POST") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const body = await readBody(request);
      const result = await importResolvedListenerAvatars(body.items);
      clearListenerCaches();
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners/avatars/compact" && request.method === "POST") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const body = await readBody(request);
      const result = await compactListenerAvatars({
        limit: Number(body.limit || 25),
        after: String(body.after || "")
      });
      clearListenerCaches();
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners/import" && request.method === "POST") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const body = await readBody(request);
      const result = await eventStore.importListeners(body.items, {
        username: normalizeTikTokUsername(body.username || ""),
        source: String(body.source || "import")
      });
      clearListenerCaches();
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners/maintenance/clear-imported-super-fans" && request.method === "POST") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const result = await eventStore.clearImportedSuperFans();
      clearListenerCaches();
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  if (url.pathname === "/api/listeners" && request.method === "GET") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const options = {
        username: normalizeTikTokUsername(url.searchParams.get("username") || ""),
        search: normalizeListenerSearch(url.searchParams.get("search") || ""),
        sort: url.searchParams.get("sort") || "last_seen",
        direction: url.searchParams.get("direction") || "desc",
        classification: url.searchParams.get("classification") || "all",
        limit: Number(url.searchParams.get("limit") || 100),
        offset: Number(url.searchParams.get("offset") || 0),
        fresh: url.searchParams.get("fresh") === "1"
      };
      const cacheKey = JSON.stringify({
        username: options.username,
        search: options.search,
        sort: options.sort,
        direction: options.direction,
        classification: options.classification,
        limit: options.limit,
        offset: options.offset
      });
      const cached = listenerPageCache.get(cacheKey);
      const cacheMs = cached?.value?.totalPending
        ? LISTENER_TOTAL_PENDING_CACHE_MS
        : LISTENER_PAGE_CACHE_MS;
      if (!options.fresh && cached && cached.at >= Date.now() - cacheMs) {
        sendJson(response, 200, cached.value);
        return;
      }
      let pending = !options.fresh ? listenerPagePromises.get(cacheKey) : null;
      if (!pending) {
        pending = (async () => {
          if (options.sort === "contribution" || options.sort === "recent_contribution") {
            return eventStore.listenerContributionPage(options);
          }
          const result = await eventStore.listeners(options);
          const ranks = await eventStore.listenerContributionRankings({
            username: options.username,
            fresh: options.fresh,
            waitForRefresh: false
          });
          return {
            ...result,
            items: result.items.map((item) => ({ ...item, ...publicContributionRank(ranks.byUserId.get(item.userId)) })),
            rankingGeneratedAt: ranks.generatedAt,
            rankingPending: Boolean(ranks.pending)
          };
        })();
        listenerPagePromises.set(cacheKey, pending);
      }
      try {
        const value = await pending;
        setBoundedCache(listenerPageCache, cacheKey, { at: Date.now(), value }, LISTENER_PAGE_CACHE_MAX);
        sendJson(response, 200, value);
      } finally {
        if (listenerPagePromises.get(cacheKey) === pending) listenerPagePromises.delete(cacheKey);
      }
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  const listenerAvatarMatch = url.pathname.match(/^\/api\/listeners\/([^/]+)\/avatar$/);
  if (listenerAvatarMatch && request.method === "GET") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const avatar = await eventStore.listenerAvatarData(decodeURIComponent(listenerAvatarMatch[1]));
      if (!avatar?.data) {
        sendJson(response, 404, { error: "保存済みアイコンがありません" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": avatar.mime || "image/jpeg",
        "Content-Length": avatar.data.length,
        "Cache-Control": "private, max-age=86400"
      });
      response.end(avatar.data);
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
    return;
  }

  const listenerHistoryMatch = url.pathname.match(/^\/api\/listeners\/([^/]+)\/history$/);
  if (listenerHistoryMatch && request.method === "GET") {
    if (!requireListenerAdmin(request, response)) return;
    try {
      const history = await eventStore.listenerHistory(decodeURIComponent(listenerHistoryMatch[1]), {
        username: normalizeTikTokUsername(url.searchParams.get("username") || ""),
        kind: url.searchParams.get("kind") === "visits" ? "visits" : "comments",
        limit: Number(url.searchParams.get("limit") || 200),
        offset: Number(url.searchParams.get("offset") || 0)
      });
      sendJson(response, 200, history);
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
        if (detail) {
          const ranks = await eventStore.listenerContributionForIds({
            username: normalizeTikTokUsername(url.searchParams.get("username") || ""),
            userIds: [userId]
          });
          detail.listener = { ...detail.listener, ...ranks.get(userId) };
        }
        sendJson(response, detail ? 200 : 404, detail || { error: "リスナーが見つかりません" });
        return;
      }
      if (request.method === "PATCH") {
        const updated = await eventStore.updateListener(userId, await readBody(request));
        if (updated) clearListenerCaches();
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
      const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(String(request.headers["accept-encoding"] || ""));
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        Vary: "Accept-Encoding",
        "X-Accel-Buffering": "no",
        ...(acceptsGzip ? { "Content-Encoding": "gzip" } : {})
      });
      const stream = acceptsGzip
        ? createGzip({ flush: zlibConstants.Z_SYNC_FLUSH })
        : response;
      if (acceptsGzip) stream.pipe(response);
      const send = (event) => {
        stream.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
        if (acceptsGzip) stream.flush(zlibConstants.Z_SYNC_FLUSH);
      };
      // Subscribe before taking the initial snapshot. This closes the tiny gap
      // where a live event could previously arrive after the snapshot was made
      // but before the stream listener was attached.
      session.on("event", send);
      send({ type: "snapshot", payload: session.snapshot() });
      const keepAliveTimer = setInterval(() => {
        send({ type: "heartbeat", payload: { at: Date.now() } });
      }, 15000);
      keepAliveTimer.unref?.();
      request.on("close", () => {
        clearInterval(keepAliveTimer);
        session.off("event", send);
        if (acceptsGzip && !stream.destroyed) stream.end();
      });
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
        const persistent = session.recordingEnabled && eventStore.status().ready;
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
      const csv = session.recordingEnabled && eventStore.status().ready
        ? sessionRowsToCsv(await eventStore.sessionExportRows(session.id))
        : session.toCsv();
      response.end(csv);
      return;
    }

    if (request.method === "POST" && action === "demo") {
      if (!requireListenerAdmin(request, response)) return;
      if (session.recordingEnabled) {
        sendJson(response, 409, { error: "通常記録中の配信にはテストデータを追加できません。" });
        return;
      }
      addPreviewDemoEvents(session);
      sendJson(response, 200, session.snapshot());
      return;
    }

    if (request.method === "POST" && action === "stop") {
      session.stop();
      if (collectorPreviewSessionId === session.id) collectorPreviewSessionId = null;
      const stoppedSnapshot = session.snapshot();
      sendJson(response, 200, stoppedSnapshot);
      if (!session.recordingEnabled) {
        setTimeout(() => sessions.delete(session.id), 1000).unref?.();
      }
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

if ((EXTERNAL_COLLECTOR_ENABLED || providerInfo.paidApiReady) && eventStore.status().ready) {
  restorePersistentSessions().catch((error) => {
    console.error(`Session restore failed: ${shortError(error)}`);
  });
}

setInterval(() => {
  maintainDatabaseConnection().catch(() => {});
}, DATABASE_RETRY_MS).unref?.();

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
    if ([...sessions.values()].some((session) => session.recordingEnabled && session.username.toLowerCase() === username.toLowerCase())) continue;
    restoredUsernames.add(username.toLowerCase());
    const session = new LiveSession(username, {
      id: item.id,
      startedAt: item.startedAt,
      roomId: item.roomId
    });
    sessions.set(session.id, session);
    if (EXTERNAL_COLLECTOR_ENABLED) {
      session.lastCollectorAt = item.lastCollectorAt ? new Date(item.lastCollectorAt).getTime() : null;
      session.lastCollectorHeartbeatAt = session.lastCollectorAt;
      session.lastCollectorEventAt = item.lastCollectorEventAt ? new Date(item.lastCollectorEventAt).getTime() : null;
      prepareCollectorSession(session);
    } else {
      session.start();
    }
  }
}

async function maintainDatabaseConnection() {
  if (databaseRecoveryPending) return false;
  databaseRecoveryPending = true;
  const wasReady = eventStore.status().ready;
  try {
    const ready = await eventStore.ensureReady();
    if (!ready) return false;
    if (!wasReady && (EXTERNAL_COLLECTOR_ENABLED || providerInfo.paidApiReady)) {
      await restorePersistentSessions();
    }
    for (const session of sessions.values()) {
      if (!session.recordingEnabled) continue;
      if (!wasReady || session.pendingDatabaseEvents.length || session.pendingVisitChecks.size) {
        await eventStore.saveSession(session);
      }
      await session.retryPendingVisits();
      await session.flushPendingDatabaseEvents();
    }
    return true;
  } finally {
    databaseRecoveryPending = false;
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

async function importResolvedListenerAvatars(rawItems) {
  const input = Array.isArray(rawItems) ? rawItems.slice(0, 20) : [];
  if (!input.length) throw new Error("アイコン情報がありません");
  const items = [];
  for (const profile of input) {
    const userId = String(profile?.userId || profile?.user_id || profile?.id || "").trim();
    const uniqueId = String(profile?.uniqueId || profile?.username || "").replace(/^@/, "").trim();
    const avatarUrl = avatarUrlFromUser(profile);
    const targetUserId = await eventStore.listenerIdForIdentity({ userId, uniqueId });
    if ((!/^\d+$/.test(userId) && !uniqueId) || !targetUserId || !/^https:\/\//i.test(avatarUrl)) {
      items.push({ userId, uniqueId, ok: false, error: "一致するユーザーまたは画像URLがありません" });
      continue;
    }
    const updated = await eventStore.updateListenerAvatar(targetUserId, {
      uniqueId,
      nickname: profile.nickname || "",
      avatarUrl
    });
    let cached = false;
    const imageBase64 = String(profile?.imageBase64 || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    const mime = String(profile?.imageMime || "image/jpeg").toLowerCase();
    if (updated && imageBase64 && /^image\/[a-z0-9.+-]+$/i.test(mime)) {
      const imageData = Buffer.from(imageBase64, "base64");
      if (imageData.length > 0 && imageData.length <= 1024 * 1024) {
        cached = await eventStore.storeListenerAvatarData(targetUserId, await optimizeAvatarImage(imageData));
      }
    }
    items.push({ userId, uniqueId, targetUserId, ok: Boolean(updated), cached });
  }
  return {
    requested: input.length,
    updated: items.filter((item) => item.ok).length,
    failed: items.filter((item) => !item.ok).length,
    items
  };
}

async function cacheListenerAvatar(userId, avatarUrl) {
  const id = String(userId || "").trim();
  const url = String(avatarUrl || "").trim();
  if (!id || !/^https:\/\//i.test(url) || avatarCachePending.has(id)) return false;
  avatarCachePending.add(id);
  try {
    if (await eventStore.listenerHasCachedAvatar(id)) return true;
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return false;
    const mime = String(response.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!mime.startsWith("image/")) return false;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 1024 * 1024) return false;
    return await eventStore.storeListenerAvatarData(id, await optimizeAvatarImage(data));
  } catch {
    return false;
  } finally {
    avatarCachePending.delete(id);
  }
}

async function compactListenerAvatars({ limit = 25, after = "" } = {}) {
  const candidates = await eventStore.avatarCompactionCandidates({ limit, after });
  let updated = 0;
  let savedBytes = 0;
  for (const candidate of candidates) {
    try {
      const optimized = await optimizeAvatarImage(candidate.data);
      if (optimized.data.length >= candidate.data.length) continue;
      if (await eventStore.replaceListenerAvatarData(candidate.userId, optimized)) {
        updated += 1;
        savedBytes += candidate.data.length - optimized.data.length;
      }
    } catch {}
  }
  return {
    scanned: candidates.length,
    updated,
    savedBytes,
    nextAfter: candidates.at(-1)?.userId || "",
    done: candidates.length < Math.min(50, Math.max(1, Number(limit || 25)))
  };
}

async function fetchTikToolsProfilesByUserIds(userIds, apiKey) {
  const url = new URL("https://api.tik.tools/webcast/resolve_user_ids");
  url.searchParams.set("apiKey", apiKey);
  const response = await fetch(url, {
    method: "POST",
    headers: {
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
    throw new Error(payload.error || payload.message || payload.status_msg || payload.detail || `Tik.toolsユーザー変換失敗（HTTP ${response.status}）`);
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
