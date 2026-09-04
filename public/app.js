const form = document.querySelector("#connectForm");
const usernameInput = document.querySelector("#username");
const primarySessionBtn = document.querySelector("#primarySessionBtn");
const previewStartBtn = document.querySelector("#previewStartBtn");
const preflightTestBtn = document.querySelector("#preflightTestBtn");
const systemCheckBtn = document.querySelector("#systemCheckBtn");
const systemCheckDialog = document.querySelector("#systemCheckDialog");
const systemCheckCloseBtn = document.querySelector("#systemCheckCloseBtn");
const systemCheckRetryBtn = document.querySelector("#systemCheckRetryBtn");
const systemCheckSummary = document.querySelector("#systemCheckSummary");
const systemCheckList = document.querySelector("#systemCheckList");
const previewNotice = document.querySelector("#previewNotice");
const previewKeyDialog = document.querySelector("#previewKeyDialog");
const previewKeyForm = document.querySelector("#previewKeyForm");
const previewAdminKeyInput = document.querySelector("#previewAdminKey");
const previewKeyCancelBtn = document.querySelector("#previewKeyCancelBtn");
const exportLink = document.querySelector("#exportLink");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const modeText = document.querySelector("#modeText");
const serverState = document.querySelector("#serverState");
const tikTokState = document.querySelector("#tikTokState");
const lastEventTime = document.querySelector("#lastEventTime");
const cooldownTime = document.querySelector("#cooldownTime");
const ingestionDiagnosticsBody = document.querySelector("#ingestionDiagnosticsBody");
const commentCount = document.querySelector("#commentCount");
const initialCount = document.querySelector("#initialCount");
const giftCount = document.querySelector("#giftCount");
const giftDiamonds = document.querySelector("#giftDiamonds");
const elapsedTime = document.querySelector("#elapsedTime");
const visitorCount = document.querySelector("#visitorCount");
const commentList = document.querySelector("#commentList");
const userList = document.querySelector("#userList");
const giftHistory = document.querySelector("#giftHistory");
const giftHistoryFilterButton = document.querySelector("#giftHistoryFilterButton");
const giftHistoryFilterDialog = document.querySelector("#giftHistoryFilterDialog");
const giftHistoryFilterForm = document.querySelector("#giftHistoryFilterForm");
const giftHistoryFilterClose = document.querySelector("#giftHistoryFilterClose");
const giftHistoryFilterCancel = document.querySelector("#giftHistoryFilterCancel");
const giftHistoryFilterEnabled = document.querySelector("#giftHistoryFilterEnabled");
const giftHistoryFilterControls = document.querySelector("#giftHistoryFilterControls");
const giftHistoryFilterSearch = document.querySelector("#giftHistoryFilterSearch");
const giftHistoryFilterCount = document.querySelector("#giftHistoryFilterCount");
const giftHistoryFilterSelectVisible = document.querySelector("#giftHistoryFilterSelectVisible");
const giftHistoryFilterClear = document.querySelector("#giftHistoryFilterClear");
const giftHistoryFilterList = document.querySelector("#giftHistoryFilterList");
const giftHistoryFilterError = document.querySelector("#giftHistoryFilterError");
const giftHistoryFilterApply = document.querySelector("#giftHistoryFilterApply");
const shareHistory = document.querySelector("#shareHistory");
const visitorHistory = document.querySelector("#visitorHistory");
const visitorDemoBtn = document.querySelector("#visitorDemoBtn");
const reportList = document.querySelector("#reportList");
const recentIds = document.querySelector("#recentIds");
const recentIdList = document.querySelector("#recentIdList");
const sessionList = document.querySelector("#sessionList");
const panelToggles = [...document.querySelectorAll("[data-panel-toggle]")];
const layoutGrid = document.querySelector(".grid");
const layoutPanels = [...document.querySelectorAll(".grid [data-panel]")];
const layoutEditToggle = document.querySelector("#layoutEditToggle");
const resetLayoutBtn = document.querySelector("#resetLayoutBtn");
const fixedAccountLabel = document.querySelector("#fixedAccountLabel");
const pinAccountBtn = document.querySelector("#pinAccountBtn");
const startFixedBtn = document.querySelector("#startFixedBtn");
const clearFixedBtn = document.querySelector("#clearFixedBtn");
const singleModeToggle = document.querySelector("#singleModeToggle");
const activeStreamerState = document.querySelector("#activeStreamerState");
const activeStreamerName = document.querySelector("#activeStreamerName");
const activeStreamerId = document.querySelector("#activeStreamerId");
const settingsPanel = document.querySelector("#settingsPanel");
const settingsBackdrop = document.querySelector("#settingsBackdrop");
const settingsOpenBtn = document.querySelector("#settingsOpenBtn");
const settingsCloseBtn = document.querySelector("#settingsCloseBtn");
const settingsTabs = [...document.querySelectorAll("[data-settings-tab]")];
const settingsPages = [...document.querySelectorAll("[data-settings-page]")];
const fontSizeButtons = [...document.querySelectorAll("[data-font-size-level]")];

const LEGACY_STORAGE_KEY = "tiktok-live-active-session";
const SESSIONS_KEY = "tiktok-live-active-sessions";
const RECENT_IDS_KEY = "tiktok-live-recent-ids";
const PANEL_PREFS_KEY = "tiktok-live-panel-prefs";
const LAYOUT_PREFS_KEY = "tiktok-live-layout-prefs";
const RATE_LIMIT_KEY = "tiktok-live-rate-limit-until";
const FIXED_ACCOUNT_KEY = "tiktok-live-fixed-account";
const SINGLE_MODE_KEY = "tiktok-live-single-mode";
const FONT_SIZE_KEY = "tiktok-live-font-size-level";
const PREVIEW_ADMIN_KEY = "tiktok-listener-admin-key";
const GIFT_HISTORY_FILTER_KEY = "tiktok-live-gift-history-filter-v1";
const GIFT_HISTORY_MAGIC_POTION_MIGRATION_KEY = "tiktok-live-gift-history-magic-potion-v1";
const LEGACY_FEATURED_GIFT_KEYS = ["name:ハートミー", "name:だいすき", "name:折り鶴"];
const MAGIC_POTION_GIFT_KEY = "name:magic potion";
const MAX_RECENT_IDS = 8;
const MAX_ACTIVE_SESSIONS = 3;
const PANEL_SIZE_OPTIONS = ["small", "tall", "medium", "large", "wide"];
const PANEL_SIZE_LABELS = { small: "小", tall: "縦長", medium: "中", large: "大", wide: "横" };
const PANEL_HEIGHT_OPTIONS = ["normal", "long", "max"];
const PANEL_HEIGHT_LABELS = { normal: "高さ標準", long: "高さロング", max: "高さ最大" };
const DEFAULT_PANEL_SIZES = {
  report: "wide",
  visitors: "medium",
  comments: "large",
  shares: "medium",
  users: "medium",
  giftHistory: "medium"
};
const DEFAULT_PANEL_ORDER = layoutPanels.map((panel) => panel.dataset.panel);

const sessions = new Map();
const eventSources = new Map();
const eventStreamActivity = new Map();
const pendingProfileLookups = new Set();

let selectedSessionId = null;
let clockTimer = null;
let reconnectTimer = null;
let snapshotFetchTick = 0;
const realtimeRenderState = new Map();
const lastHeavyRealtimeRenderAt = new Map();
const lastRealtimeListRebuildAt = new Map();
const realtimeListRebuildTimers = new Map();
let visitorDemoActive = false;
let receiptGiftCatalog = [];
let sessionGiftCatalog = [];
let giftHistoryFilter = readGiftHistoryFilter();
let giftHistoryFilterDraft = cloneGiftHistoryFilter(giftHistoryFilter);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await startSession();
});
primarySessionBtn?.addEventListener("click", async () => {
  if (primarySessionBtn?.dataset.action === "stop") await stopSelectedSession();
  else await startSession();
});
usernameInput.addEventListener("input", updateSelectedControls);

window.addEventListener("pageshow", restoreSavedSessions);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) reconnectActiveSessions();
});
window.addEventListener("focus", reconnectActiveSessions);
window.addEventListener("online", reconnectActiveSessions);

setupPanelToggles();
setupLayoutTools();
setupFontSizeTools();
setupSettingsPanel();
setupFixedAccountTools();
setupGiftHistoryFilter();
renderRecentIds();
refreshMissingRecentProfiles();
restoreSavedSessions();
renderSessionCards();
renderSelectedSession();
refreshServerState();
setInterval(refreshServerState, 30000);
setInterval(checkEventStreamHealth, 15000);

visitorDemoBtn?.addEventListener("click", toggleVisitorDemo);
giftHistory?.addEventListener("error", (event) => {
  if (event.target?.matches?.("img.gift-image")) event.target.remove();
}, true);
previewStartBtn?.addEventListener("click", () => {
  previewStartBtn.closest("details")?.removeAttribute("open");
  startSession({ preview: true });
});
preflightTestBtn?.addEventListener("click", () => {
  preflightTestBtn.closest("details")?.removeAttribute("open");
  startSession({ preview: true, demo: true });
});
systemCheckBtn?.addEventListener("click", () => {
  systemCheckBtn.closest("details")?.removeAttribute("open");
  systemCheckDialog.hidden = false;
  runSystemCheck();
});
systemCheckCloseBtn?.addEventListener("click", () => { systemCheckDialog.hidden = true; });
systemCheckRetryBtn?.addEventListener("click", runSystemCheck);
systemCheckDialog?.addEventListener("click", (event) => {
  if (event.target === systemCheckDialog) systemCheckDialog.hidden = true;
});

async function runSystemCheck() {
  systemCheckRetryBtn.disabled = true;
  systemCheckSummary.textContent = "各サービスを確認しています…";
  systemCheckList.innerHTML = "";
  let health = null;
  let countPocketOk = false;
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (response.ok) health = await response.json();
  } catch {}
  try {
    const now = Date.now();
    const response = await fetch(`https://count-pocket.a-line.workers.dev/api/live-feed?giftSince=${now}&alertSince=${now}&limit=1&check=${now}`, { cache: "no-store" });
    countPocketOk = response.ok;
  } catch {}

  const diagnostics = health?.collector?.diagnostics?.collector || health?.collector?.diagnostics || {};
  const receipt = diagnostics.receipt || {};
  const receiptChecked = Boolean(receipt.checkedAt);
  const pendingCountsKnown = diagnostics.pendingEvents != null;
  const checks = [
    { label: "コメント表示サーバー", ok: Boolean(health?.ok), detail: health ? `稼働 ${formatDuration(health.uptimeSeconds || 0)}` : "Renderへ接続できません" },
    { label: "リスナーデータベース", ok: Boolean(health?.database?.ready), detail: health?.database?.ready ? `保存待ち ${health.database.queuedEvents || 0}件` : "データベースが未接続です" },
    { label: "note PCコレクター", ok: Boolean(health?.collector?.connected), detail: health?.collector?.connected ? `送信待ち ${diagnostics.pendingEvents || 0}件` : "TikFinityコレクターの待機信号がありません" },
    { label: "レシートアプリ", ok: receiptChecked && Boolean(receipt.reachable), pending: !receiptChecked, detail: !receiptChecked ? "note PC側の診断機能を更新すると確認できます" : receipt.reachable ? `${receipt.printer || "プリンター"}・印刷待ち ${receipt.queueCount || 0}件` : "note PCのレシートアプリを確認できません" },
    { label: "MP-B20", ok: receiptChecked && Boolean(receipt.printerReady), pending: !receiptChecked, detail: !receiptChecked ? "note PC側の診断機能を更新すると確認できます" : receipt.printerReady ? (receipt.printerVerified ? "接続確認済み" : "印刷キューを確認") : "プリンター電源とBluetoothを確認してください" },
    { label: "スマホアプリ連携", ok: countPocketOk, detail: countPocketOk ? "Count Pocketの受信経路は正常です" : "Count Pocketの受信経路を確認できません" },
    { label: "未送信データ", ok: pendingCountsKnown && Number(diagnostics.pendingEvents || 0) === 0 && Number(diagnostics.pendingReceiptEvents || 0) === 0 && (!receiptChecked || Number(receipt.sharedReceiptPendingCount || 0) === 0), pending: !pendingCountsKnown, detail: pendingCountsKnown ? `コメント等 ${diagnostics.pendingEvents || 0}件・印刷 ${diagnostics.pendingReceiptEvents || 0}件・台帳履歴 ${receipt.sharedReceiptPendingCount || 0}件` : "note PC側の更新後に件数を確認できます" },
  ];
  systemCheckList.innerHTML = checks.map((check) => `
    <div class="system-check-item ${check.pending ? "pending" : check.ok ? "ok" : "ng"}">
      <i>${check.pending ? "…" : check.ok ? "✓" : "!"}</i><strong>${escapeHtml(check.label)}</strong><span>${escapeHtml(check.detail)}</span>
    </div>`).join("");
  const failures = checks.filter((check) => !check.ok && !check.pending).length;
  const pending = checks.filter((check) => check.pending).length;
  systemCheckSummary.textContent = failures > 0
    ? `${failures}項目を確認してください。正常な機能はそのまま使えます。`
    : pending > 0
      ? `クラウド側は正常です。note PC更新後に残り${pending}項目を確認できます。`
      : "すべて正常です。このまま配信を開始できます。";
  systemCheckRetryBtn.disabled = false;
}

async function stopSelectedSession() {
  if (!selectedSessionId) return;
  const sessionId = selectedSessionId;
  setBusy(true);
  try {
    await fetch(`/api/session/${sessionId}/stop`, { method: "POST" });
  } finally {
    setVisitorDemoActive(false);
    closeSession(sessionId, { forget: true });
    setBusy(false);
  }
}

async function startSession(options = {}) {
  const preview = options.preview === true;
  if (!preview) setVisitorDemoActive(false);
  setBusy(true);
  setStatus("connecting", preview ? "保存しない確認モードを準備しています。" : "接続を準備しています。", preview ? "確認準備中" : "追加中");

  const username = cleanUsername(options.username ?? usernameInput.value)
    || (preview ? cleanUsername(sessions.get(selectedSessionId)?.username || localStorage.getItem(FIXED_ACCOUNT_KEY) || "preview_test") : "");
  if (!username) {
    setStatus("stopped", "TikTok IDを入力してください。", "入力待ち");
    setBusy(false);
    return;
  }
  const cooldown = readRateLimitCooldown();
  if (!preview && cooldown.active) {
    setStatus("stopped", `TikTok側の接続制限中です。${formatClock(cooldown.until)}頃まで新しい接続を止めます。`, "制限中");
    setBusy(false);
    return;
  }
  const existing = findSessionByUsername(username, { preview });
  if (existing) {
    selectSession(existing.id);
    try {
      if (preview && options.demo) {
        const adminKey = await getPreviewAdminKey();
        if (!adminKey) throw new Error("保存しない確認モードには管理キーが必要です。");
        await requestPreviewDemo(existing.id, adminKey);
        setVisitorDemoActive(true);
      }
    } catch (error) {
      setStatus("stopped", error.message, "テスト失敗");
    } finally {
      setBusy(false);
    }
    return existing.id;
  }
  const maxSessions = isSingleMode() ? 1 : MAX_ACTIVE_SESSIONS;
  if (!preview && activeSessionCount() >= maxSessions) {
    setStatus("stopped", `同時監視は最大${maxSessions}件までです。不要な配信を停止してから追加してください。`, "追加停止");
    setBusy(false);
    return;
  }

  try {
    const adminKey = preview ? await getPreviewAdminKey() : "";
    if (preview && !adminKey) throw new Error("保存しない確認モードには管理キーが必要です。");
    const response = await fetch("/api/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(preview ? { Authorization: `Bearer ${adminKey}` } : {})
      },
      body: JSON.stringify({ username, preview })
    });
    const body = await response.json();
    if (!response.ok) {
      if (body.errorCode === "rate_limited" || isRateLimitMessage(body.error)) {
        setRateLimitCooldown(body.error, body.retryAt);
      }
      throw new Error(body.error || "接続を開始できませんでした。");
    }

    activateSession(body.id, username, { select: true, preview: Boolean(body.preview) });
    if (!preview) {
      rememberRecentId(username);
      refreshRecentProfile(username);
    }
    usernameInput.value = "";
    if (preview && options.demo) {
      await requestPreviewDemo(body.id, adminKey);
      setVisitorDemoActive(true);
    }
    return body.id;
  } catch (error) {
    if (preview && /管理キー/.test(String(error.message || ""))) localStorage.removeItem(PREVIEW_ADMIN_KEY);
    setStatus("stopped", error.message, "未接続");
    return null;
  } finally {
    setBusy(false);
  }
}

function getPreviewAdminKey() {
  const saved = String(localStorage.getItem(PREVIEW_ADMIN_KEY) || "").trim();
  if (saved) return saved;
  if (!previewKeyDialog || !previewKeyForm || !previewAdminKeyInput) return "";
  previewKeyDialog.hidden = false;
  document.body.classList.add("preview-key-open");
  previewAdminKeyInput.value = "";
  previewAdminKeyInput.focus();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      previewKeyDialog.hidden = true;
      document.body.classList.remove("preview-key-open");
      previewKeyForm.removeEventListener("submit", submit);
      previewKeyCancelBtn?.removeEventListener("click", cancel);
      const key = String(value || "").trim();
      if (key) localStorage.setItem(PREVIEW_ADMIN_KEY, key);
      resolve(key);
    };
    const submit = (event) => {
      event.preventDefault();
      finish(previewAdminKeyInput.value);
    };
    const cancel = () => finish("");
    previewKeyForm.addEventListener("submit", submit);
    previewKeyCancelBtn?.addEventListener("click", cancel);
  });
}

async function requestPreviewDemo(sessionId, adminKey) {
  const response = await fetch(`/api/session/${sessionId}/demo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminKey}` }
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) localStorage.removeItem(PREVIEW_ADMIN_KEY);
    throw new Error(body.error || "配信前テストを表示できませんでした。");
  }
  renderSnapshot(body);
}

async function restoreSavedSessions() {
  const savedSessions = readSavedSessions();
  if (!savedSessions.length) return;
  let collectorEnabled = false;
  try {
    const health = await (await fetch("/api/health", { cache: "no-store" })).json();
    collectorEnabled = Boolean(health.collector?.enabled);
  } catch {}

  for (const saved of savedSessions) {
    if (!saved?.id || sessions.has(saved.id)) continue;
    try {
      let sessionId = saved.id;
      if (collectorEnabled && saved.username) {
        const activeResponse = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: saved.username })
        });
        if (activeResponse.ok) sessionId = (await activeResponse.json()).id || sessionId;
      }
      const response = await fetch(`/api/session/${sessionId}/snapshot`, { cache: "no-store" });
      if (!response.ok) continue;
      const snapshot = await response.json();
      activateSession(sessionId, saved.username || snapshot.username || "", {
        select: saved.id === selectedSessionId || !selectedSessionId
      });
      renderSnapshot(snapshot);
    } catch {
      if (!selectedSessionId) {
        setStatus("connecting", "保存済みの計測へ復帰待ちです。", "復帰待ち");
      }
    }
  }
  saveActiveSessions();
  renderSelectedSession();
}

function activateSession(sessionId, username, options = {}) {
  const existing = sessions.get(sessionId) || {};
  const session = {
    id: sessionId,
    username: cleanUsername(username || existing.username || ""),
    snapshot: existing.snapshot || null,
    userCache: existing.userCache || new Map(),
    createdAt: existing.createdAt || Date.now(),
    preview: options.preview ?? existing.preview ?? false
  };
  sessions.set(sessionId, session);
  if (options.select !== false) {
    selectSession(sessionId, { save: false });
  }
  openEventStream(sessionId);
  startSnapshotClock();
  saveActiveSessions();
  renderSessionCards();
  updateSelectedControls();
}

function openEventStream(sessionId) {
  if (!sessionId || eventSources.has(sessionId)) return;

  const source = new EventSource(`/api/session/${sessionId}/events`);
  eventSources.set(sessionId, source);
  markEventStreamActivity(sessionId);
  source.onopen = () => markEventStreamActivity(sessionId);
  source.addEventListener("heartbeat", () => markEventStreamActivity(sessionId));
  source.addEventListener("snapshot", (event) => {
    markEventStreamActivity(sessionId);
    renderSnapshot(JSON.parse(event.data));
  });
  source.addEventListener("status", (event) => {
    markEventStreamActivity(sessionId);
    applyRealtimePayload(sessionId, "status", JSON.parse(event.data));
  });
  source.addEventListener("presence", (event) => {
    markEventStreamActivity(sessionId);
    applyRealtimePayload(sessionId, "presence", JSON.parse(event.data));
  });
  source.addEventListener("comment", (event) => {
    markEventStreamActivity(sessionId);
    const payload = JSON.parse(event.data);
    applyRealtimePayload(sessionId, "comment", payload);
  });
  source.addEventListener("gift", (event) => {
    markEventStreamActivity(sessionId);
    const payload = JSON.parse(event.data);
    applyRealtimePayload(sessionId, "gift", payload);
  });
  source.addEventListener("share", (event) => {
    markEventStreamActivity(sessionId);
    const payload = JSON.parse(event.data);
    applyRealtimePayload(sessionId, "share", payload);
  });
  source.onerror = () => {
    source.close();
    eventSources.delete(sessionId);
    eventStreamActivity.delete(sessionId);
    const session = sessions.get(sessionId);
    if (!session) return;
    if (selectedSessionId === sessionId) {
      setStatus("connecting", "表示だけ再接続中です。集計はサーバー側で継続します。", "再接続中");
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectActiveSessions();
  }, 5000);
}

async function reconnectActiveSessions() {
  if (readRateLimitCooldown().active) return;
  if (!sessions.size) {
    await restoreSavedSessions();
    return;
  }

  await Promise.all([...sessions.keys()].map(async (sessionId) => {
    try {
      const response = await fetch(`/api/session/${sessionId}/snapshot`, { cache: "no-store" });
      if (!response.ok) throw new Error("セッション切れ");
      const snapshot = await response.json();
      renderSnapshot(snapshot);
      if (shouldKeepSessionConnected(snapshot) && !eventSources.has(sessionId)) {
        openEventStream(sessionId);
      }
    } catch {
      if (selectedSessionId === sessionId) {
        setStatus("connecting", "復帰待ちです。サーバーが起動中の場合は少し待ってください。", "復帰待ち");
      }
    }
  }));
}

function startSnapshotClock() {
  if (clockTimer) return;
  clockTimer = setInterval(async () => {
    if (!sessions.size) return;
    snapshotFetchTick += 1;
    for (const session of sessions.values()) {
      if (!session.snapshot || session.snapshot.stoppedAt) continue;
      session.snapshot.elapsedSeconds = Math.floor((Date.now() - session.snapshot.startedAt) / 1000);
    }
    renderSelectedSessionClock();
    if (document.hidden || snapshotFetchTick % 60 !== 0) return;
    await Promise.all([...sessions.keys()].map(async (sessionId) => {
      try {
        const snapshot = await (await fetch(`/api/session/${sessionId}/snapshot`, { cache: "no-store" })).json();
        renderSnapshot(snapshot);
      } catch {
        // Keep the last good state; the event stream or next reconciliation will refresh it.
      }
    }));
  }, 1000);
}

function renderSelectedSessionClock() {
  const selected = selectedSessionId ? sessions.get(selectedSessionId) : null;
  const snapshot = selected?.snapshot;
  if (!snapshot) return;
  renderConnectionDetails(snapshot);
  renderMetrics(snapshot);
}

function closeSession(sessionId, { forget } = { forget: false }) {
  const source = eventSources.get(sessionId);
  if (source) source.close();
  eventSources.delete(sessionId);
  eventStreamActivity.delete(sessionId);
  const pendingRender = realtimeRenderState.get(sessionId);
  if (pendingRender?.timer) clearTimeout(pendingRender.timer);
  realtimeRenderState.delete(sessionId);
  lastHeavyRealtimeRenderAt.delete(sessionId);
  lastRealtimeListRebuildAt.delete(sessionId);
  const listTimer = realtimeListRebuildTimers.get(sessionId);
  if (listTimer) clearTimeout(listTimer);
  realtimeListRebuildTimers.delete(sessionId);
  sessions.delete(sessionId);

  if (selectedSessionId === sessionId) {
    selectedSessionId = sessions.keys().next().value || null;
  }
  if (!sessions.size && clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
  if (forget) saveActiveSessions();
  renderSessionCards();
  renderSelectedSession();
}

function selectSession(sessionId, options = {}) {
  if (!sessions.has(sessionId)) return;
  selectedSessionId = sessionId;
  if (options.save !== false) saveActiveSessions();
  renderSessionCards();
  renderSelectedSession();
}

function findSessionByUsername(username, { preview = false } = {}) {
  const cleaned = cleanUsername(username).toLowerCase();
  return [...sessions.values()].find((session) => (
    session.username.toLowerCase() === cleaned
    && Boolean(session.preview || session.snapshot?.preview) === preview
  ));
}

function activeSessionCount() {
  return [...sessions.values()].filter((session) => shouldKeepSessionConnected(session.snapshot)).length;
}

function shouldKeepSessionConnected(snapshot) {
  return !snapshot || (!snapshot.stoppedAt && snapshot.status !== "ended" && snapshot.errorCode !== "rate_limited");
}

function isRateLimitMessage(message) {
  return /rate.?limit|too many connections|rate_limit_account_day|接続回数制限/i.test(String(message || ""));
}

function readRateLimitCooldown() {
  const until = Number(localStorage.getItem(RATE_LIMIT_KEY) || 0);
  return { active: until > Date.now(), until };
}

function setRateLimitCooldown(message = "", retryAt = 0) {
  const given = Number(retryAt || 0);
  if (given > Date.now()) {
    localStorage.setItem(RATE_LIMIT_KEY, String(given));
    return given;
  }
  const now = new Date();
  const until = /account_day/i.test(String(message))
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 30).getTime()
    : Date.now() + 30 * 60 * 1000;
  localStorage.setItem(RATE_LIMIT_KEY, String(until));
  return until;
}

function saveActiveSessions() {
  const persistentSessions = [...sessions.values()].filter((session) => !session.preview && !session.snapshot?.preview);
  const selected = persistentSessions.find((session) => session.id === selectedSessionId) || persistentSessions[0];
  const items = persistentSessions.map((session) => ({
    id: session.id,
    username: session.username || session.snapshot?.username || "",
    selected: session.id === selected?.id,
    savedAt: Date.now()
  }));
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(items));
  if (selected) {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({
      id: selected.id,
      username: selected?.username || "",
      savedAt: Date.now()
    }));
  } else {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
}

function readSavedSessions() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
    if (Array.isArray(value) && value.length) {
      const selected = value.find((item) => item.selected);
      if (selected) selectedSessionId = selected.id;
      return value.filter((item) => item?.id);
    }
  } catch {}

  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null");
    return legacy?.id ? [legacy] : [];
  } catch {
    return [];
  }
}

function rememberRecentId(username, displayName = "", options = {}) {
  const cleaned = cleanUsername(username);
  if (!cleaned) return;

  const moveToTop = options.moveToTop !== false;
  const display = cleanRecentDisplayName(displayName, cleaned);
  const entries = readRecentIds();
  const existingIndex = entries.findIndex((entry) => entry.id.toLowerCase() === cleaned.toLowerCase());
  const existing = existingIndex >= 0 ? entries[existingIndex] : null;
  const nextDisplayName = display || existing?.displayName || "";
  const nextEntry = {
    id: cleaned,
    displayName: nextDisplayName,
    updatedAt: !existing || nextDisplayName !== existing.displayName ? Date.now() : existing.updatedAt
  };

  let next = entries.filter((entry) => entry.id.toLowerCase() !== cleaned.toLowerCase());
  if (moveToTop) {
    next.unshift(nextEntry);
  } else if (existingIndex >= 0) {
    next.splice(existingIndex, 0, nextEntry);
  } else {
    next.unshift(nextEntry);
  }
  next = next.slice(0, MAX_RECENT_IDS);

  if (JSON.stringify(entries) === JSON.stringify(next)) return;
  writeRecentIds(next);
  renderRecentIds();
}

function removeRecentId(username) {
  const cleaned = cleanUsername(username);
  const next = readRecentIds().filter((entry) => entry.id.toLowerCase() !== cleaned.toLowerCase());
  writeRecentIds(next);
  renderRecentIds();
}

function readRecentIds() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_IDS_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.map(normalizeRecentEntry).filter(Boolean).slice(0, MAX_RECENT_IDS);
  } catch {
    return [];
  }
}

function writeRecentIds(entries) {
  localStorage.setItem(RECENT_IDS_KEY, JSON.stringify(entries.slice(0, MAX_RECENT_IDS)));
}

function normalizeRecentEntry(entry) {
  if (typeof entry === "string") {
    const id = cleanUsername(entry);
    return id ? { id, displayName: "", updatedAt: 0 } : null;
  }
  const id = cleanUsername(entry?.id || entry?.username);
  if (!id) return null;
  return {
    id,
    displayName: cleanRecentDisplayName(entry.displayName || entry.name || "", id),
    updatedAt: Number(entry.updatedAt || 0)
  };
}

function renderRecentIds() {
  const entries = readRecentIds();
  recentIds.innerHTML = entries.map((entry) => `
    <option value="${escapeHtml(entry.id)}" label="${escapeHtml(entry.displayName || `@${entry.id}`)}"></option>
  `).join("");
  if (!entries.length) {
    recentIdList.innerHTML = "";
    return;
  }
  recentIdList.innerHTML = entries.map((entry) => `
    <div class="recent-item">
      <button type="button" class="recent-main" data-recent-id="${escapeHtml(entry.id)}">
        ${entry.displayName ? `<span class="recent-name">${escapeHtml(entry.displayName)}</span>` : ""}
        <span class="recent-id">@${escapeHtml(entry.id)}</span>
      </button>
      <button type="button" class="recent-start" data-start-recent="${escapeHtml(entry.id)}">追加</button>
      <button type="button" class="recent-remove" data-remove-recent="${escapeHtml(entry.id)}" aria-label="${escapeHtml(entry.id)}を履歴から削除" title="履歴から削除">×</button>
    </div>
  `).join("");
  recentIdList.querySelectorAll("[data-recent-id]").forEach((button) => {
    button.addEventListener("click", () => {
      usernameInput.value = button.dataset.recentId;
      usernameInput.focus();
    });
  });
  recentIdList.querySelectorAll("[data-start-recent]").forEach((button) => {
    button.addEventListener("click", async () => {
      usernameInput.value = button.dataset.startRecent;
      await startSession({ username: button.dataset.startRecent });
    });
  });
  recentIdList.querySelectorAll("[data-remove-recent]").forEach((button) => {
    button.addEventListener("click", () => removeRecentId(button.dataset.removeRecent));
  });
}

function refreshMissingRecentProfiles() {
  readRecentIds()
    .filter((entry) => !entry.displayName)
    .slice(0, MAX_RECENT_IDS)
    .forEach((entry) => refreshRecentProfile(entry.id));
}

async function refreshRecentProfile(username) {
  const cleaned = cleanUsername(username);
  if (!cleaned || pendingProfileLookups.has(cleaned.toLowerCase())) return;
  pendingProfileLookups.add(cleaned.toLowerCase());
  try {
    const response = await fetch(`/api/profile/${encodeURIComponent(cleaned)}`, { cache: "no-store" });
    const body = await response.json();
    if (body?.displayName) {
      rememberRecentId(body.username || cleaned, body.displayName, { moveToTop: false });
    }
  } catch {
    // 表示名の取得に失敗しても、ID履歴はそのまま使えるようにします。
  } finally {
    pendingProfileLookups.delete(cleaned.toLowerCase());
  }
}

function cleanUsername(value) {
  return String(value || "").trim().replace(/^@/, "");
}

function cleanRecentDisplayName(value, username) {
  const text = String(value || "").trim().replace(/^@/, "");
  if (!text || text.toLowerCase() === cleanUsername(username).toLowerCase()) return "";
  return text;
}

function setupFixedAccountTools() {
  if (singleModeToggle) {
    singleModeToggle.checked = isSingleMode();
    singleModeToggle.addEventListener("change", () => {
      localStorage.setItem(SINGLE_MODE_KEY, singleModeToggle.checked ? "1" : "0");
      applySingleMode();
      renderSelectedSession();
    });
  }
  pinAccountBtn?.addEventListener("click", () => {
    const username = cleanUsername(usernameInput.value || sessions.get(selectedSessionId)?.username || "");
    if (!username) {
      setStatus("stopped", "固定するTikTok IDを入力してください。", "固定未設定");
      return;
    }
    localStorage.setItem(FIXED_ACCOUNT_KEY, username);
    updateFixedAccountUi();
  });
  startFixedBtn?.addEventListener("click", async () => {
    const fixed = readFixedAccount();
    if (!fixed) {
      setStatus("stopped", "先に固定アカウントを設定してください。", "固定未設定");
      return;
    }
    usernameInput.value = fixed;
    await startSession();
  });
  clearFixedBtn?.addEventListener("click", () => {
    localStorage.removeItem(FIXED_ACCOUNT_KEY);
    updateFixedAccountUi();
  });
  updateFixedAccountUi();
  applySingleMode();
}

function readFixedAccount() {
  return cleanUsername(localStorage.getItem(FIXED_ACCOUNT_KEY) || "");
}

function updateFixedAccountUi() {
  const fixed = readFixedAccount();
  if (fixedAccountLabel) fixedAccountLabel.textContent = fixed ? `@${fixed}` : "未設定";
  if (startFixedBtn) startFixedBtn.disabled = !fixed;
}

function isSingleMode() {
  return localStorage.getItem(SINGLE_MODE_KEY) === "1";
}

function applySingleMode() {
  document.body.classList.toggle("single-mode", isSingleMode());
}

function setupSettingsPanel() {
  const setOpen = (open) => {
    document.body.classList.toggle("settings-open", open);
    settingsPanel?.setAttribute("aria-hidden", String(!open));
    settingsOpenBtn?.setAttribute("aria-expanded", String(open));
    if (settingsBackdrop) settingsBackdrop.hidden = !open;
  };

  const selectTab = (name) => {
    settingsTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.settingsTab === name));
    settingsPages.forEach((page) => {
      const active = page.dataset.settingsPage === name;
      page.classList.toggle("active", active);
      page.hidden = !active;
    });
  };

  settingsOpenBtn?.addEventListener("click", () => setOpen(true));
  settingsCloseBtn?.addEventListener("click", () => setOpen(false));
  settingsBackdrop?.addEventListener("click", () => setOpen(false));
  settingsTabs.forEach((tab) => tab.addEventListener("click", () => selectTab(tab.dataset.settingsTab)));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("settings-open")) setOpen(false);
  });
}

function setupPanelToggles() {
  const prefs = readPanelPrefs();
  panelToggles.forEach((toggle) => {
    const panel = toggle.dataset.panelToggle;
    if (Object.hasOwn(prefs, panel)) {
      toggle.checked = Boolean(prefs[panel]);
    }
    toggle.addEventListener("change", () => {
      const next = readPanelPrefs();
      next[panel] = toggle.checked;
      localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(next));
      applyPanelPrefs();
    });
  });
  applyPanelPrefs();
}

function readPanelPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function applyPanelPrefs() {
  const prefs = readPanelPrefs();
  panelToggles.forEach((toggle) => {
    const panelName = toggle.dataset.panelToggle;
    const visible = Object.hasOwn(prefs, panelName) ? Boolean(prefs[panelName]) : toggle.checked;
    toggle.checked = visible;
    document.querySelectorAll(`[data-panel="${panelName}"]`).forEach((panel) => {
      panel.hidden = !visible;
    });
  });
}

function setupLayoutTools() {
  if (!layoutGrid) return;
  let draggedPanel = null;

  layoutPanels.forEach((panel) => {
    panel.classList.add("layout-card");
    ensurePanelLayoutControls(panel);

    panel.addEventListener("dragstart", (event) => {
      if (!isLayoutEditing()) {
        event.preventDefault();
        return;
      }
      draggedPanel = panel;
      panel.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", panel.dataset.panel);
    });

    panel.addEventListener("dragover", (event) => {
      if (!draggedPanel || draggedPanel === panel) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      const insertAfter = event.clientY > rect.top + rect.height / 2;
      layoutGrid.insertBefore(draggedPanel, insertAfter ? panel.nextSibling : panel);
    });

    panel.addEventListener("drop", (event) => {
      if (!draggedPanel) return;
      event.preventDefault();
      saveCurrentLayoutOrder();
    });

    panel.addEventListener("dragend", () => {
      if (draggedPanel) saveCurrentLayoutOrder();
      draggedPanel = null;
      panel.classList.remove("dragging");
    });
  });

  layoutEditToggle?.addEventListener("change", () => setLayoutEditing(layoutEditToggle.checked));
  resetLayoutBtn?.addEventListener("click", () => {
    const confirmed = window.confirm("レイアウトを初期配置に戻しますか？\n現在の並び順とサイズ設定は元に戻せません。");
    if (!confirmed) return;
    localStorage.removeItem(LAYOUT_PREFS_KEY);
    applyLayoutPrefs();
  });

  applyLayoutPrefs();
  setLayoutEditing(Boolean(layoutEditToggle?.checked));
}

function ensurePanelLayoutControls(panel) {
  const heading = panel.querySelector("h2");
  if (!heading || heading.querySelector(".layout-controls")) return;
  heading.classList.add("panel-heading");

  const controls = document.createElement("span");
  controls.className = "layout-controls";
  controls.setAttribute("aria-label", `${heading.textContent.trim()}のサイズ`);

  const moveUp = document.createElement("button");
  moveUp.type = "button";
  moveUp.className = "layout-move-btn";
  moveUp.textContent = "↑";
  moveUp.title = `${heading.textContent.trim()}を前へ移動`;
  moveUp.addEventListener("click", () => movePanel(panel, -1));
  controls.appendChild(moveUp);

  const moveDown = document.createElement("button");
  moveDown.type = "button";
  moveDown.className = "layout-move-btn";
  moveDown.textContent = "↓";
  moveDown.title = `${heading.textContent.trim()}を後ろへ移動`;
  moveDown.addEventListener("click", () => movePanel(panel, 1));
  controls.appendChild(moveDown);

  PANEL_SIZE_OPTIONS.forEach((size) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "layout-size-btn";
    button.dataset.layoutSize = size;
    button.textContent = PANEL_SIZE_LABELS[size];
    button.title = `${heading.textContent.trim()}を${PANEL_SIZE_LABELS[size]}サイズにする`;
    button.addEventListener("click", () => setPanelSize(panel.dataset.panel, size));
    controls.appendChild(button);
  });

  const heightButton = document.createElement("button");
  heightButton.type = "button";
  heightButton.className = "layout-height-btn";
  heightButton.dataset.layoutHeightToggle = "";
  heightButton.textContent = PANEL_HEIGHT_LABELS.normal;
  heightButton.title = `${heading.textContent.trim()}の高さを切り替える`;
  heightButton.addEventListener("click", () => cyclePanelHeight(panel.dataset.panel));
  controls.appendChild(heightButton);

  heading.appendChild(controls);
}

function isLayoutEditing() {
  return Boolean(layoutEditToggle?.checked);
}

function setLayoutEditing(isEditing) {
  document.body.classList.toggle("layout-editing", isEditing);
  layoutPanels.forEach((panel) => {
    panel.draggable = isEditing;
  });
}

function readLayoutPrefs() {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_PREFS_KEY) || "{}") || {};
    return {
      order: Array.isArray(value.order) ? value.order.filter((name) => DEFAULT_PANEL_ORDER.includes(name)) : [],
      sizes: value.sizes && typeof value.sizes === "object" ? value.sizes : {},
      heights: value.heights && typeof value.heights === "object" ? value.heights : {}
    };
  } catch {
    return { order: [], sizes: {}, heights: {} };
  }
}

function writeLayoutPrefs(prefs) {
  localStorage.setItem(LAYOUT_PREFS_KEY, JSON.stringify({
    order: normalizedPanelOrder(prefs.order),
    sizes: normalizedPanelSizes(prefs.sizes),
    heights: normalizedPanelHeights(prefs.heights)
  }));
}

function normalizedPanelOrder(order = []) {
  const seen = new Set();
  const valid = order.filter((name) => {
    if (!DEFAULT_PANEL_ORDER.includes(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  return [...valid, ...DEFAULT_PANEL_ORDER.filter((name) => !seen.has(name))];
}

function normalizedPanelSizes(sizes = {}) {
  const next = {};
  DEFAULT_PANEL_ORDER.forEach((name) => {
    const size = sizes[name] || DEFAULT_PANEL_SIZES[name] || "medium";
    next[name] = PANEL_SIZE_OPTIONS.includes(size) ? size : DEFAULT_PANEL_SIZES[name] || "medium";
  });
  return next;
}

function normalizedPanelHeights(heights = {}) {
  const next = {};
  DEFAULT_PANEL_ORDER.forEach((name) => {
    const height = heights[name] || "normal";
    next[name] = PANEL_HEIGHT_OPTIONS.includes(height) ? height : "normal";
  });
  return next;
}

function applyLayoutPrefs() {
  if (!layoutGrid) return;
  const prefs = readLayoutPrefs();
  const order = normalizedPanelOrder(prefs.order);
  const sizes = normalizedPanelSizes(prefs.sizes);
  const heights = normalizedPanelHeights(prefs.heights);
  const panelsByName = new Map(layoutPanels.map((panel) => [panel.dataset.panel, panel]));

  order.forEach((name) => {
    const panel = panelsByName.get(name);
    if (panel) layoutGrid.appendChild(panel);
  });

  layoutPanels.forEach((panel) => {
    const size = sizes[panel.dataset.panel] || "medium";
    PANEL_SIZE_OPTIONS.forEach((option) => panel.classList.remove(`panel-size-${option}`));
    panel.classList.add(`panel-size-${size}`);
    panel.querySelectorAll("[data-layout-size]").forEach((button) => {
      button.classList.toggle("active", button.dataset.layoutSize === size);
    });
    const height = heights[panel.dataset.panel] || "normal";
    PANEL_HEIGHT_OPTIONS.forEach((option) => panel.classList.remove(`panel-height-${option}`));
    panel.classList.add(`panel-height-${height}`);
    panel.querySelectorAll("[data-layout-height-toggle]").forEach((button) => {
      button.textContent = PANEL_HEIGHT_LABELS[height];
      button.title = `${PANEL_HEIGHT_LABELS[height]}で表示中。クリックで切り替え`;
      button.classList.toggle("active", height !== "normal");
    });
  });
}

function setPanelSize(panelName, size) {
  if (!DEFAULT_PANEL_ORDER.includes(panelName) || !PANEL_SIZE_OPTIONS.includes(size)) return;
  const prefs = readLayoutPrefs();
  prefs.sizes = { ...normalizedPanelSizes(prefs.sizes), [panelName]: size };
  writeLayoutPrefs({ ...prefs, order: currentPanelOrder() });
  applyLayoutPrefs();
}

function cyclePanelHeight(panelName) {
  if (!DEFAULT_PANEL_ORDER.includes(panelName)) return;
  const prefs = readLayoutPrefs();
  const heights = normalizedPanelHeights(prefs.heights);
  const currentIndex = PANEL_HEIGHT_OPTIONS.indexOf(heights[panelName]);
  heights[panelName] = PANEL_HEIGHT_OPTIONS[(currentIndex + 1) % PANEL_HEIGHT_OPTIONS.length];
  writeLayoutPrefs({ ...prefs, heights, order: currentPanelOrder() });
  applyLayoutPrefs();
}

function movePanel(panel, direction) {
  if (!layoutGrid || !panel) return;
  const panels = [...layoutGrid.querySelectorAll("[data-panel]")];
  const index = panels.indexOf(panel);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= panels.length) return;

  if (direction < 0) {
    layoutGrid.insertBefore(panel, panels[targetIndex]);
  } else {
    layoutGrid.insertBefore(panel, panels[targetIndex].nextSibling);
  }
  saveCurrentLayoutOrder();
}

function currentPanelOrder() {
  return [...layoutGrid?.querySelectorAll("[data-panel]") || []].map((panel) => panel.dataset.panel);
}

function saveCurrentLayoutOrder() {
  const prefs = readLayoutPrefs();
  writeLayoutPrefs({ ...prefs, order: currentPanelOrder() });
  applyLayoutPrefs();
}

function setBusy(isBusy) {
  if (primarySessionBtn) primarySessionBtn.disabled = isBusy;
  if (previewStartBtn) previewStartBtn.disabled = isBusy;
  if (preflightTestBtn) preflightTestBtn.disabled = isBusy;
  usernameInput.disabled = isBusy;
}

function applyRealtimePayload(sessionId, type, payload) {
  if (payload?.snapshot) {
    renderSnapshot(payload.snapshot);
    return;
  }
  if (payload?.id && Array.isArray(payload.comments)) {
    renderSnapshot(payload);
    return;
  }

  const session = sessions.get(sessionId);
  if (!session?.snapshot) return;
  const summary = payload?.summary || {};
  const next = {
    ...session.snapshot,
    ...summary,
    id: summary.id || sessionId,
    viewerStats: summary.viewerStats
      ? { ...(session.snapshot.viewerStats || {}), ...summary.viewerStats }
      : session.snapshot.viewerStats
  };
  const cache = session.userCache || seedSessionUserCache(session, session.snapshot);

  if (!session.pendingDisplayUserIds) session.pendingDisplayUserIds = new Set();
  for (const user of payload?.users || []) {
    upsertRealtimeUser(cache, user);
    const userId = String(user?.userId || "");
    if (userId) session.pendingDisplayUserIds.add(userId);
  }

  if (type === "comment" && payload?.comment) {
    next.comments = prependRealtimeEvent(next.comments, payload.comment);
  } else if (type === "gift" && payload?.gift) {
    next.gifts = prependRealtimeEvent(next.gifts, payload.gift);
    rememberSessionGifts([payload.gift]);
  } else if (type === "share" && payload?.share) {
    next.shares = prependRealtimeEvent(next.shares, payload.share);
  }
  session.snapshot = next;
  scheduleRealtimeRender(sessionId, type);
  scheduleRealtimeListRebuild(sessionId);
}

function scheduleRealtimeRender(sessionId, type = "status") {
  const current = realtimeRenderState.get(sessionId) || { types: new Set(), timer: null, dueAt: 0 };
  current.types.add(type);
  const urgent = ["comment", "gift", "share"].includes(type);
  const delayMs = urgent ? 60 : 400;
  const dueAt = Date.now() + delayMs;
  if (!current.timer || dueAt < current.dueAt) {
    if (current.timer) clearTimeout(current.timer);
    current.dueAt = dueAt;
    current.timer = setTimeout(() => {
      const pending = realtimeRenderState.get(sessionId);
      realtimeRenderState.delete(sessionId);
      if (!pending || !sessions.has(sessionId)) return;
      if ([...pending.types].some((dirtyType) => ["comment", "gift", "share", "status"].includes(dirtyType))) {
        renderSessionCards();
      }
      if (selectedSessionId === sessionId) {
        renderSelectedSession({ dirtyTypes: pending.types });
      }
    }, delayMs);
  }
  realtimeRenderState.set(sessionId, current);
}

function scheduleRealtimeListRebuild(sessionId) {
  if (realtimeListRebuildTimers.has(sessionId)) return;
  const lastRebuildAt = Number(lastRealtimeListRebuildAt.get(sessionId) || Date.now());
  const waitMs = Math.max(0, 1000 - (Date.now() - lastRebuildAt));
  const timer = setTimeout(() => {
    realtimeListRebuildTimers.delete(sessionId);
    const session = sessions.get(sessionId);
    if (!session?.snapshot) return;
    rebuildRealtimeLists(session.snapshot, session.userCache || new Map());
    refreshVisibleCommentRows(session.snapshot.comments || [], session.pendingDisplayUserIds || new Set());
    session.pendingDisplayUserIds?.clear();
    lastRealtimeListRebuildAt.set(sessionId, Date.now());
    if (selectedSessionId === sessionId) {
      renderSelectedSession({ dirtyTypes: new Set(["lists"]) });
    }
  }, waitMs);
  realtimeListRebuildTimers.set(sessionId, timer);
}

function prependRealtimeEvent(items, event) {
  const current = Array.isArray(items) ? items : [];
  return [event, ...current.filter((item) => item?.id !== event?.id)].slice(0, 200);
}

function seedSessionUserCache(session, snapshot) {
  const cache = new Map();
  const groups = [
    snapshot?.topUsers,
    snapshot?.visitors
  ];
  for (const users of groups) {
    for (const user of users || []) upsertRealtimeUser(cache, user);
  }
  session.userCache = cache;
  return cache;
}

function upsertRealtimeUser(cache, user) {
  const userId = String(user?.userId || "");
  if (!userId) return;
  cache.set(userId, { ...(cache.get(userId) || {}), ...user, userId });
}

function markEventStreamActivity(sessionId) {
  eventStreamActivity.set(sessionId, Date.now());
}

function checkEventStreamHealth() {
  if (document.hidden) return;
  const staleBefore = Date.now() - 45000;
  let recycled = false;
  for (const [sessionId, source] of eventSources) {
    if ((eventStreamActivity.get(sessionId) || 0) >= staleBefore) continue;
    source.close();
    eventSources.delete(sessionId);
    eventStreamActivity.delete(sessionId);
    recycled = true;
  }
  if (recycled) scheduleReconnect();
}

function rebuildRealtimeLists(snapshot, cache) {
  const users = normalizedRealtimeUsers(cache);
  snapshot.topUsers = [...users]
    .sort((a, b) => Number(b.comments || 0) - Number(a.comments || 0)
      || Number(b.gifts || 0) - Number(a.gifts || 0)
      || Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
    .slice(0, 30);
  snapshot.visitors = [...users]
    .filter((user) => user.hasJoined)
    .sort((a, b) => Number(b.firstJoinAt || 0) - Number(a.firstJoinAt || 0)
      || Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
    .slice(0, 200);
  snapshot.comments = refreshEventDisplayState(snapshot.comments, cache);
  snapshot.gifts = refreshEventDisplayState(snapshot.gifts, cache);
  snapshot.shares = refreshEventDisplayState(snapshot.shares, cache);
}

function normalizedRealtimeUsers(cache) {
  return [...cache.values()];
}

function refreshEventDisplayState(events, cache) {
  return (events || []).map((event) => {
    const user = cache.get(String(event?.userId || ""));
    if (!user) return event;
    return {
      ...event,
      avatarUrl: event.avatarUrl || user.avatarUrl || "",
      followedToday: Boolean(user.followedToday),
      isFollowingHost: user.isFollowingHost,
      followStatus: user.followStatus,
      heartMeStatus: user.heartMeStatus,
      heartMeStatusSource: user.heartMeStatusSource,
      heartMeLevel: user.heartMeLevel,
      heartMeHistoryStatus: user.heartMeHistoryStatus,
      visitHistoryKnown: Boolean(user.visitHistoryKnown),
      visitHistoryStatus: user.visitHistoryStatus || "unknown",
      visitCount: Number(user.visitCount || 0),
      firstVisitAt: user.firstVisitAt,
      lastVisitAt: user.lastVisitAt,
      previousVisitAt: user.previousVisitAt
    };
  });
}

function refreshVisibleCommentRows(comments, changedUserIds) {
  if (visitorDemoActive || !changedUserIds?.size || !commentList) return;
  const commentsByUser = new Map();
  for (const comment of comments || []) {
    const userId = String(comment?.userId || "");
    if (!changedUserIds.has(userId)) continue;
    const items = commentsByUser.get(userId) || [];
    items.push(comment);
    commentsByUser.set(userId, items);
  }
  const usedByUser = new Map();
  for (const row of commentList.querySelectorAll("article.comment[data-user-id]")) {
    const userId = String(row.dataset.userId || "");
    if (!changedUserIds.has(userId)) continue;
    const index = usedByUser.get(userId) || 0;
    const comment = commentsByUser.get(userId)?.[index];
    if (comment) row.outerHTML = commentArticleHtml(comment);
    usedByUser.set(userId, index + 1);
  }
}

function renderSnapshot(snapshot, options = {}) {
  if (!snapshot?.id) return;
  if (snapshot.errorCode === "rate_limited" || isRateLimitMessage(snapshot.message)) {
    setRateLimitCooldown(snapshot.message);
  }
  const session = sessions.get(snapshot.id) || {
    id: snapshot.id,
    username: snapshot.username || "",
    createdAt: Date.now()
  };
  session.username = snapshot.username || session.username;
  session.preview = Boolean(snapshot.preview);
  session.snapshot = snapshot;
  rememberSessionGifts(snapshot.gifts || []);
  if (!options.preserveUserCache) seedSessionUserCache(session, snapshot);
  sessions.set(snapshot.id, session);
  lastRealtimeListRebuildAt.set(snapshot.id, Date.now());

  if (!selectedSessionId) selectedSessionId = snapshot.id;
  if (snapshot.username && !snapshot.preview) {
    rememberRecentId(snapshot.username, snapshot.displayName, { moveToTop: false });
  }
  if (!shouldKeepSessionConnected(snapshot)) {
    const source = eventSources.get(snapshot.id);
    if (source) source.close();
    eventSources.delete(snapshot.id);
    eventStreamActivity.delete(snapshot.id);
  }
  saveActiveSessions();
  renderSessionCards();
  if (selectedSessionId === snapshot.id) renderSelectedSession();
}

function renderSelectedSession(options = {}) {
  const selected = selectedSessionId ? sessions.get(selectedSessionId) : null;
  const snapshot = selected?.snapshot;
  const dirtyTypes = options.dirtyTypes instanceof Set ? options.dirtyTypes : null;
  const fullRender = !dirtyTypes;
  const dirty = (...types) => fullRender || types.some((type) => dirtyTypes.has(type));
  updateSelectedControls();
  if (!snapshot) {
    if (previewNotice) previewNotice.hidden = true;
    setStatus("stopped", sessions.size ? "配信を選択してください。" : "未接続", sessions.size ? "選択待ち" : "待機中");
    renderActiveStreamer(selected, null);
    renderConnectionDetails(null);
    renderMetrics(emptySnapshot());
    renderReport(null);
    renderComments([]);
    renderUsers([]);
    renderGiftHistory([]);
    renderShareHistory([]);
    renderVisitorHistory([]);
    return;
  }
  const now = Date.now();
  const lastHeavyAt = Number(lastHeavyRealtimeRenderAt.get(snapshot.id) || 0);
  const heavyRequested = dirty("comment", "gift", "share", "presence", "status", "lists");
  const heavyDue = fullRender || dirty("status", "lists") || (heavyRequested && now - lastHeavyAt >= 1000);
  if (heavyDue) lastHeavyRealtimeRenderAt.set(snapshot.id, now);
  const cooldown = readRateLimitCooldown();
  const message = snapshot.errorCode === "rate_limited" && cooldown.active
    ? `${snapshot.message || statusMessage(snapshot)} 新規追加は${formatClock(cooldown.until)}頃まで止めています。`
    : snapshot.message || statusMessage(snapshot);
  setStatus(snapshot.status, message, modeLabel(snapshot));
  if (fullRender || dirty("status")) renderActiveStreamer(selected, snapshot);
  if (fullRender || dirty("status", "presence")) renderConnectionDetails(snapshot);
  if (fullRender || dirty("comment", "gift", "share", "presence", "status")) renderMetrics(snapshot);
  if (heavyDue) renderReport(snapshot);
  if (dirty("comment", "status")) renderComments(snapshot.comments || []);
  if (heavyDue && dirty("comment", "gift", "presence", "status", "lists")) {
    renderUsers(snapshot.topUsers || []);
    renderVisitorHistory(snapshot.visitors || []);
  }
  if (dirty("gift", "status")) {
    renderGiftHistory(snapshot.gifts || []);
  }
  if (dirty("share", "status")) renderShareHistory(snapshot.shares || []);
}

function setupFontSizeTools() {
  applyFontSize(readFontSizeLevel());
  fontSizeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const level = normalizeFontSizeLevel(button.dataset.fontSizeLevel);
      localStorage.setItem(FONT_SIZE_KEY, String(level));
      applyFontSize(level);
    });
  });
}

function readFontSizeLevel() {
  return normalizeFontSizeLevel(localStorage.getItem(FONT_SIZE_KEY) || 2);
}

function normalizeFontSizeLevel(value) {
  const level = Math.round(Number(value));
  return level >= 1 && level <= 5 ? level : 2;
}

function applyFontSize(level) {
  const normalized = normalizeFontSizeLevel(level);
  document.documentElement.dataset.fontSize = String(normalized);
  fontSizeButtons.forEach((button) => {
    const active = Number(button.dataset.fontSizeLevel) === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderActiveStreamer(selected, snapshot) {
  if (!activeStreamerState || !activeStreamerName || !activeStreamerId) return;
  if (!selected) {
    activeStreamerState.textContent = "未接続";
    activeStreamerState.classList.remove("live");
    activeStreamerName.textContent = "ライバー未選択";
    activeStreamerId.textContent = "-";
    return;
  }
  if (previewNotice) previewNotice.hidden = !snapshot?.preview;
  const username = snapshot?.username || selected.username || "";
  const displayName = snapshot?.displayName || username || "読み込み中";
  const isLive = snapshot?.status === "live";
  activeStreamerState.textContent = snapshot?.preview ? "保存なし" : isLive ? "接続中" : "選択中";
  activeStreamerState.classList.toggle("live", isLive);
  activeStreamerName.textContent = displayName;
  activeStreamerId.textContent = username ? `@${username}` : "-";
}

function updateSelectedControls() {
  const selected = selectedSessionId ? sessions.get(selectedSessionId) : null;
  const snapshot = selected?.snapshot;
  const canStop = Boolean(selected && shouldKeepSessionConnected(snapshot));
  const enteredUsername = cleanUsername(usernameInput.value);
  const selectedUsername = cleanUsername(snapshot?.username || selected?.username || "");
  const addingDifferentSession = Boolean(enteredUsername && selectedUsername && enteredUsername.toLowerCase() !== selectedUsername.toLowerCase());
  const shouldStop = canStop && !addingDifferentSession;
  if (primarySessionBtn) {
    primarySessionBtn.dataset.action = shouldStop ? "stop" : "start";
    primarySessionBtn.textContent = shouldStop
      ? snapshot?.preview ? "テストを終了" : "配信記録を停止"
      : addingDifferentSession ? "別の配信記録を開始" : "配信記録を開始";
    primarySessionBtn.classList.toggle("is-stop", shouldStop);
  }
  if (selected && !selected.preview && !snapshot?.preview) {
    exportLink.href = `/api/session/${selected.id}/export.csv`;
    exportLink.classList.remove("disabled");
    exportLink.removeAttribute("aria-disabled");
  } else {
    exportLink.removeAttribute("href");
    exportLink.classList.add("disabled");
    exportLink.setAttribute("aria-disabled", "true");
  }
}

function renderSessionCards() {
  const items = [...sessions.values()]
    .sort((a, b) => (b.snapshot?.startedAt || b.createdAt) - (a.snapshot?.startedAt || a.createdAt));
  if (!items.length) {
    sessionList.innerHTML = `<p class="empty compact">まだ監視中の配信はありません。</p>`;
    return;
  }
  sessionList.innerHTML = items.map((session) => {
    const snapshot = session.snapshot;
    const name = snapshot?.displayName && snapshot.displayName.toLowerCase() !== session.username.toLowerCase()
      ? snapshot.displayName
      : `@${session.username}`;
    const isSelected = session.id === selectedSessionId;
    const previewLabel = session.preview || snapshot?.preview ? "保存なし・" : "";
    return `
      <button type="button" class="session-card ${isSelected ? "selected" : ""}" data-session-id="${escapeHtml(session.id)}">
        <span class="session-title">${escapeHtml(name)}</span>
        <span class="session-id">@${escapeHtml(session.username || snapshot?.username || "")}</span>
        <span class="session-stats">
          <strong>${formatNumber(snapshot?.commentCount || 0)}</strong> コメント
          <strong>${formatNumber(snapshot?.giftCount || 0)}</strong> ギフト
        </span>
        <span class="session-state">${escapeHtml(previewLabel + modeLabel(snapshot || { mode: "connecting" }))}</span>
      </button>
    `;
  }).join("");
  sessionList.querySelectorAll("[data-session-id]").forEach((button) => {
    button.addEventListener("click", () => selectSession(button.dataset.sessionId));
  });
}

function emptySnapshot() {
  return {
    commentCount: 0,
    initialEventCount: 0,
    giftCount: 0,
    giftDiamondTotal: 0,
    elapsedSeconds: 0,
    viewerStats: {}
  };
}

function renderConnectionDetails(snapshot) {
  const cooldown = readRateLimitCooldown();
  if (tikTokState) {
    if (!snapshot) {
      tikTokState.textContent = "TikTok未接続";
    } else if (snapshot.errorCode === "rate_limited") {
      tikTokState.textContent = "TikTok制限中";
    } else if (snapshot.status === "live") {
      tikTokState.textContent = "TikTok接続中";
    } else if (snapshot.status === "ended") {
      tikTokState.textContent = "TikTok終了";
    } else {
      tikTokState.textContent = "TikTok切断/待機";
    }
  }
  if (lastEventTime) {
    lastEventTime.textContent = snapshot?.lastEventAt
      ? `最終イベント ${formatRelativeTime(snapshot.lastEventAt)}`
      : "最終イベント -";
  }
  if (cooldownTime) {
    cooldownTime.textContent = cooldown.active
      ? `制限解除まで ${formatCountdown(cooldown.until - Date.now())}`
      : "制限なし";
  }
  renderIngestionDiagnostics(snapshot?.ingestionDiagnostics);
}

function renderIngestionDiagnostics(diagnostics) {
  if (!ingestionDiagnosticsBody) return;
  if (!diagnostics) {
    ingestionDiagnosticsBody.textContent = "配信開始後に取得状況を表示します。";
    return;
  }
  const collector = diagnostics.collector || {};
  const received = collector.receivedByType || {};
  const accepted = diagnostics.acceptedByType || {};
  const stored = diagnostics.storedByType || {};
  const sum = (bucket, names) => names.reduce((total, name) => total + Number(bucket[name] || 0), 0);
  const rows = [
    ["入室", ["member", "join"]],
    ["いいね", ["like"]],
    ["コメント", ["chat", "comment"]],
    ["ギフト", ["gift"]]
  ];
  const unknown = Object.entries(collector.unknownByType || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 8);
  const latency = diagnostics.pipelineLatencyByType || {};
  const latencyText = [
    ["コメント", latency.comment],
    ["ギフト", latency.gift]
  ].map(([label, item]) => {
    const delivery = Number(item?.collectorToServerMs?.count) > 0 ? Number(item.collectorToServerMs.p95) : NaN;
    const persistence = Number(item?.persistenceQueueMs?.count) > 0 ? Number(item.persistenceQueueMs.p95) : NaN;
    if (!Number.isFinite(delivery) && !Number.isFinite(persistence)) return "";
    return `${label}：受信→Render ${formatLatency(delivery)}・保存待ち ${formatLatency(persistence)}`;
  }).filter(Boolean).join(" / ");
  ingestionDiagnosticsBody.innerHTML = `
    <div class="ingestion-diagnostics-grid">
      <strong>種類</strong><strong>TikFinity</strong><strong>Render</strong><strong>帳簿</strong>
      ${rows.map(([label, names]) => `
        <span>${label}</span>
        <span>${formatNumber(sum(received, names))}</span>
        <span>${formatNumber(sum(accepted, names))}</span>
        <span>${formatNumber(sum(stored, names))}</span>
      `).join("")}
    </div>
    <p>保存待ち ${formatNumber(diagnostics.pendingDatabaseEvents || 0)}件・重複除外 ${formatNumber(diagnostics.duplicate || 0)}件</p>
    ${latencyText ? `<p>直近最大300件の95%値　${escapeHtml(latencyText)}</p>` : ""}
    ${unknown.length ? `<p>未対応イベント: ${unknown.map(([name, count]) => `${escapeHtml(name)} ${formatNumber(count)}`).join("、")}</p>` : ""}
  `;
}

function formatLatency(value) {
  if (!Number.isFinite(value)) return "-";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}秒` : `${Math.round(value)}ms`;
}

async function refreshServerState() {
  if (!serverState) return;
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error("health");
    const provider = body.provider?.label || (body.provider?.paidApiReady ? "Tik.tools" : "標準接続");
    const storage = body.database?.ready ? "長期保存" : "一時保存";
    const collectorLabels = {
      receiving: "LIVEイベント受信中",
      waiting: "note PC接続済み・イベント待機中",
      offline: "note PCオフライン"
    };
    const collector = body.collector?.enabled ? `・${collectorLabels[body.collector.state] || "note PC確認中"}` : "";
    serverState.textContent = `サーバー ${formatDuration(body.uptimeSeconds)}・${formatNumber(body.sessions)}接続・${provider}・${storage}${collector}`;
  } catch {
    serverState.textContent = "サーバー確認不可";
  }
}

function renderReport(snapshot) {
  if (!reportList) return;
  if (!snapshot) {
    reportList.innerHTML = `<p class="empty">接続すると集計レポートがここに出ます。</p>`;
    return;
  }
  const topCommenter = snapshot.topUsers?.[0];
  const followedCount = Number(snapshot.followedTodayCount || 0);
  const shareCount = Number(snapshot.shareCount || snapshot.shares?.length || 0);
  const visitors = Number(snapshot.viewerStats?.knownJoins || 0);
  const heartMeStats = snapshot.heartMeStats || {};
  const followStats = snapshot.followStats || {};
  const heartMeActiveCount = Number(heartMeStats.active || 0) + Number(heartMeStats.new_today || 0);
  const followHostCount = Number(followStats.following || 0);
  const statusCards = `
    <article><span>ハート有効</span><strong>${formatNumber(heartMeActiveCount)}</strong><small>人</small></article>
    <article><span>フォロー中</span><strong>${formatNumber(followHostCount)}</strong><small>人</small></article>
  `;
  reportList.innerHTML = `
    ${statusCards}
    <article><span>コメント最多</span><strong>${escapeHtml(topCommenter?.nickname || topCommenter?.userId || "-")}</strong><small>${formatNumber(topCommenter?.comments || 0)}件</small></article>
    <article><span>シェア</span><strong>${formatNumber(shareCount)}</strong><small>回</small></article>
    <article><span>本日フォロー</span><strong>${formatNumber(followedCount)}</strong><small>人</small></article>
    <article><span>確認来訪</span><strong>${formatNumber(visitors)}</strong><small>この配信</small></article>
  `;
}

function renderMetrics(snapshot) {
  commentCount.textContent = formatNumber(snapshot.commentCount);
  initialCount.textContent = formatNumber(snapshot.initialEventCount);
  giftCount.textContent = formatNumber(snapshot.giftCount);
  giftDiamonds.textContent = formatNumber(snapshot.giftDiamondTotal);
  elapsedTime.textContent = formatDuration(snapshot.elapsedSeconds);
  if (visitorCount) visitorCount.textContent = formatNumber(snapshot.viewerStats?.knownJoins || 0);
}

function renderComments(comments) {
  if (visitorDemoActive) comments = visitorDemoComments();
  if (!comments.length) {
    commentList.innerHTML = `<p class="empty">接続するとコメントがここに流れます。</p>`;
    return;
  }
  commentList.innerHTML = comments.map(commentArticleHtml).join("");
}

function commentArticleHtml(comment) {
  return `
    <article class="comment ${commentVisitClass(comment)}" data-user-id="${escapeHtml(String(comment?.userId || ""))}">
      <header>
        ${renderEventAvatar(comment)}
        <span class="name">${renderDecoratedName(comment)}</span>
        <span class="comment-side">
          ${commentVisitMeta(comment)}
          <span class="time">${formatClock(comment.at)}</span>
        </span>
      </header>
      <p>${eventSourceBadge(comment)}${escapeHtml(comment.text)}</p>
    </article>
  `;
}

function commentVisitClass(comment) {
  return comment.visitHistoryKnown && Number(comment.visitCount || 0) === 1 ? "first-visit-comment" : "";
}

function commentVisitMeta(comment) {
  if (!comment.visitHistoryKnown) {
    const label = comment.visitHistoryStatus === "checking" ? "履歴確認中" : "履歴未確認";
    return `<span class="comment-visit-meta">${label}</span>`;
  }
  const count = Number(comment.visitCount || 0);
  if (count <= 0) return "";
  if (count === 1) return `<span class="comment-visit-meta first">初見</span>`;
  const previousAt = comment.previousVisitAt || comment.firstVisitAt;
  const previousLabel = previousAt ? `（${formatVisitDate(previousAt)}）` : "";
  return `<span class="comment-visit-meta">${formatNumber(count)}回目${previousLabel}</span>`;
}

function renderUsers(users) {
  renderRankList(userList, users, "まだ集計はありません。", (user) => formatNumber(user.comments));
}

function renderRankList(target, users, emptyText, valueRenderer) {
  if (!users.length) {
    target.innerHTML = `<p class="empty">${emptyText}</p>`;
    return;
  }
  target.innerHTML = users.map((user, index) => `
    <div class="user-row">
      <span class="rank">${index + 1}</span>
      <span class="name">${renderDecoratedName(user)}</span>
      <span class="count">${valueRenderer(user)}</span>
    </div>
  `).join("");
}

function setupGiftHistoryFilter() {
  updateGiftHistoryFilterSummary();
  loadReceiptGiftCatalog();

  giftHistoryFilterButton?.addEventListener("click", openGiftHistoryFilter);
  giftHistoryFilterClose?.addEventListener("click", closeGiftHistoryFilter);
  giftHistoryFilterCancel?.addEventListener("click", closeGiftHistoryFilter);
  giftHistoryFilterEnabled?.addEventListener("change", () => {
    giftHistoryFilterDraft.enabled = giftHistoryFilterEnabled.checked;
    renderGiftHistoryFilterList();
  });
  giftHistoryFilterSearch?.addEventListener("input", renderGiftHistoryFilterList);
  giftHistoryFilterSelectVisible?.addEventListener("click", () => {
    const selected = new Set(giftHistoryFilterDraft.selected);
    for (const gift of visibleGiftCatalog()) selected.add(giftChoiceKey(gift));
    giftHistoryFilterDraft.selected = [...selected];
    renderGiftHistoryFilterList();
  });
  giftHistoryFilterClear?.addEventListener("click", () => {
    giftHistoryFilterDraft.selected = [];
    renderGiftHistoryFilterList();
  });
  giftHistoryFilterList?.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-gift-key]");
    if (!input) return;
    const selected = new Set(giftHistoryFilterDraft.selected);
    if (input.checked) selected.add(input.dataset.giftKey);
    else selected.delete(input.dataset.giftKey);
    giftHistoryFilterDraft.selected = [...selected];
    updateGiftHistoryFilterDialogState();
  });
  giftHistoryFilterForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (giftHistoryFilterDraft.enabled && !giftHistoryFilterDraft.selected.length) {
      updateGiftHistoryFilterDialogState();
      return;
    }
    giftHistoryFilter = cloneGiftHistoryFilter(giftHistoryFilterDraft);
    localStorage.setItem(GIFT_HISTORY_FILTER_KEY, JSON.stringify(giftHistoryFilter));
    updateGiftHistoryFilterSummary();
    closeGiftHistoryFilter();
    renderSelectedSession();
  });
  giftHistoryFilterDialog?.addEventListener("click", (event) => {
    if (event.target === giftHistoryFilterDialog) closeGiftHistoryFilter();
  });
}

function openGiftHistoryFilter() {
  giftHistoryFilterDraft = cloneGiftHistoryFilter(giftHistoryFilter);
  if (giftHistoryFilterSearch) giftHistoryFilterSearch.value = "";
  renderGiftHistoryFilterList();
  giftHistoryFilterDialog?.showModal();
}

function closeGiftHistoryFilter() {
  if (giftHistoryFilterDialog?.open) giftHistoryFilterDialog.close();
}

function readGiftHistoryFilter() {
  try {
    const filter = cloneGiftHistoryFilter(JSON.parse(localStorage.getItem(GIFT_HISTORY_FILTER_KEY) || "null"));
    return addMagicPotionToFeaturedGiftFilter(filter);
  } catch {
    return cloneGiftHistoryFilter(null);
  }
}

function addMagicPotionToFeaturedGiftFilter(filter) {
  if (!filter.enabled || localStorage.getItem(GIFT_HISTORY_MAGIC_POTION_MIGRATION_KEY)) return filter;
  const selected = new Set(filter.selected);
  if (!LEGACY_FEATURED_GIFT_KEYS.every((key) => selected.has(key)) || selected.has(MAGIC_POTION_GIFT_KEY)) {
    return filter;
  }
  selected.add(MAGIC_POTION_GIFT_KEY);
  const migrated = { ...filter, selected: [...selected] };
  localStorage.setItem(GIFT_HISTORY_FILTER_KEY, JSON.stringify(migrated));
  localStorage.setItem(GIFT_HISTORY_MAGIC_POTION_MIGRATION_KEY, "1");
  return migrated;
}

function cloneGiftHistoryFilter(value) {
  return {
    enabled: Boolean(value?.enabled),
    selected: [...new Set(Array.isArray(value?.selected) ? value.selected.map(String).filter(Boolean) : [])]
  };
}

async function loadReceiptGiftCatalog() {
  try {
    const response = await fetch("/receipt-gift-catalog.json", { cache: "no-store" });
    const catalog = await response.json();
    receiptGiftCatalog = Array.isArray(catalog) ? catalog : [];
  } catch {
    receiptGiftCatalog = [];
  }
  if (giftHistoryFilterDialog?.open) renderGiftHistoryFilterList();
}

function normalizeGiftChoice(gift) {
  if (Array.isArray(gift)) {
    return {
      id: String(gift[0] ?? ""),
      name: String(gift[1] ?? "").trim(),
      coins: Math.max(0, Number(gift[2] ?? 0)),
      count: 0
    };
  }
  return {
    id: String(gift?.giftId ?? gift?.id ?? ""),
    name: String(gift?.giftName ?? gift?.name ?? "").trim(),
    coins: Math.max(0, Number(gift?.coins ?? gift?.diamondCount ?? 0)),
    count: Math.max(0, Number(gift?.count ?? gift?.repeatCount ?? 0))
  };
}

function rememberSessionGifts(gifts) {
  const merged = new Map(sessionGiftCatalog.map((gift) => [giftChoiceKey(gift), normalizeGiftChoice(gift)]));
  for (const rawGift of gifts || []) {
    const gift = normalizeGiftChoice(rawGift);
    const key = giftChoiceKey(gift);
    if (!key) continue;
    const current = merged.get(key);
    merged.set(key, current
      ? {
          id: gift.id || current.id,
          name: gift.name || current.name,
          coins: gift.coins || current.coins,
          count: Math.max(gift.count, current.count)
        }
      : gift);
  }
  sessionGiftCatalog = [...merged.values()];
  if (giftHistoryFilterDialog?.open) renderGiftHistoryFilterList();
}

function giftChoiceKey(gift) {
  const normalized = normalizeGiftChoice(gift);
  if (normalized.name) return `name:${normalized.name.toLocaleLowerCase("ja-JP")}`;
  return normalized.id ? `id:${normalized.id}` : "";
}

function combinedGiftCatalog() {
  const merged = new Map();
  for (const rawGift of [...receiptGiftCatalog, ...sessionGiftCatalog]) {
    const gift = normalizeGiftChoice(rawGift);
    const key = giftChoiceKey(gift);
    if (!key) continue;
    const current = merged.get(key);
    merged.set(key, current
      ? {
          id: gift.id || current.id,
          name: gift.name || current.name,
          coins: gift.coins || current.coins,
          count: Math.max(gift.count, current.count)
        }
      : gift);
  }
  return [...merged.values()].sort((left, right) =>
    left.coins - right.coins || left.name.localeCompare(right.name, "ja-JP")
  );
}

function visibleGiftCatalog() {
  const query = String(giftHistoryFilterSearch?.value || "").trim().toLocaleLowerCase("ja-JP");
  const catalog = combinedGiftCatalog();
  if (!query) return catalog;
  return catalog.filter((gift) =>
    gift.name.toLocaleLowerCase("ja-JP").includes(query)
      || String(gift.coins).includes(query)
  );
}

function renderGiftHistoryFilterList() {
  if (!giftHistoryFilterList) return;
  if (giftHistoryFilterEnabled) giftHistoryFilterEnabled.checked = giftHistoryFilterDraft.enabled;
  const catalog = visibleGiftCatalog();
  const selected = new Set(giftHistoryFilterDraft.selected);
  giftHistoryFilterList.innerHTML = catalog.length
    ? catalog.map((gift) => {
        const key = giftChoiceKey(gift);
        const detail = gift.coins > 0 ? `${formatNumber(gift.coins)}コイン` : "コイン数未取得";
        return `
          <label class="gift-filter-option">
            <input type="checkbox" data-gift-key="${escapeHtml(key)}" ${selected.has(key) ? "checked" : ""}>
            <span>${escapeHtml(gift.name || `ギフト ${gift.id}`)}</span>
            <small>${detail}</small>
          </label>
        `;
      }).join("")
    : `<p class="empty">該当するギフトがありません。</p>`;
  updateGiftHistoryFilterDialogState();
}

function updateGiftHistoryFilterDialogState() {
  const enabled = giftHistoryFilterDraft.enabled;
  const selectedCount = giftHistoryFilterDraft.selected.length;
  giftHistoryFilterControls?.classList.toggle("disabled", !enabled);
  giftHistoryFilterControls?.querySelectorAll("input, button").forEach((control) => {
    control.disabled = !enabled;
  });
  if (giftHistoryFilterCount) giftHistoryFilterCount.textContent = `${formatNumber(selectedCount)}種類を選択中`;
  if (giftHistoryFilterError) giftHistoryFilterError.hidden = !enabled || selectedCount > 0;
  if (giftHistoryFilterApply) giftHistoryFilterApply.disabled = enabled && selectedCount === 0;
}

function updateGiftHistoryFilterSummary() {
  if (!giftHistoryFilterButton) return;
  giftHistoryFilterButton.textContent = giftHistoryFilter.enabled
    ? `対象 ${formatNumber(giftHistoryFilter.selected.length)}種類`
    : "すべてのギフトを表示";
  giftHistoryFilterButton.classList.toggle("active", giftHistoryFilter.enabled);
}

function giftMatchesHistoryFilter(gift) {
  if (!giftHistoryFilter.enabled) return true;
  return new Set(giftHistoryFilter.selected).has(giftChoiceKey(gift));
}

function renderGiftArtwork(gift) {
  const imageUrl = String(gift?.giftImageUrl || "").trim();
  const image = /^https:\/\//i.test(imageUrl) || imageUrl.startsWith("/")
    ? `<img class="gift-image" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : "";
  return `<span class="gift-artwork" aria-hidden="true"><span>🎁</span>${image}</span>`;
}

function renderGiftHistory(gifts) {
  if (!gifts.length) {
    giftHistory.innerHTML = `<p class="empty">ギフトが届くとここに表示されます。</p>`;
    return;
  }
  const visibleGifts = gifts.filter(giftMatchesHistoryFilter);
  if (!visibleGifts.length) {
    giftHistory.innerHTML = `<p class="empty">選択したギフトはまだ届いていません。</p>`;
    return;
  }
  giftHistory.innerHTML = visibleGifts.map((gift) => `
    <article class="comment gift-card ${commentVisitClass(gift)}">
      <header>
        ${renderEventAvatar(gift)}
        <span class="name">${renderDecoratedName(gift)}</span>
        <span class="comment-side">
          ${commentVisitMeta(gift)}
          <span class="time">${formatClock(gift.at)}</span>
        </span>
      </header>
      <div class="gift-event-body">
        ${renderGiftArtwork(gift)}
        <div class="gift-event-info">
          <strong>${escapeHtml(gift.giftName || "ギフト")}</strong>
          ${eventSourceBadge(gift)}
          <span>×${formatNumber(gift.repeatCount)}</span>
          <small>${formatNumber(gift.totalDiamonds)} ダイヤ</small>
        </div>
      </div>
    </article>
  `).join("");
}

function renderShareHistory(shares) {
  if (!shareHistory) return;
  if (!shares.length) {
    shareHistory.innerHTML = `<p class="empty">シェアされるとユーザー名と時刻がここに表示されます。</p>`;
    return;
  }
  shareHistory.innerHTML = shares.map((share) => `
    <article class="comment share-card ${commentVisitClass(share)}">
      <header>
        ${renderEventAvatar(share)}
        <span class="name">${renderDecoratedName(share)}</span>
        <span class="comment-side">
          ${commentVisitMeta(share)}
          <span class="time">${formatClock(share.at)}</span>
        </span>
      </header>
      <p>${eventSourceBadge(share)}シェア</p>
    </article>
  `).join("");
}

function renderVisitorHistory(visitors) {
  if (!visitorHistory) return;
  if (visitorDemoActive) visitors = visitorDemoUsers();
  if (!visitors.length) {
    visitorHistory.innerHTML = `<p class="empty">入室を確認したユーザーがここに表示されます。</p>`;
    return;
  }
  const demoNotice = visitorDemoActive
    ? `<p class="visitor-demo-notice">デモ表示中です。訪問回数や台帳には保存されません。</p>`
    : "";
  visitorHistory.innerHTML = demoNotice + visitors.map((user) => {
    const historyKnown = Boolean(user.visitHistoryKnown);
    const visits = Number(user.visitCount || 0);
    const entryEvents = Number(user.entryEventCount || 0);
    const previousVisit = user.previousVisitAt ? formatVisitDate(user.previousVisitAt) : "";
    const visitLabel = !historyKnown
      ? user.visitHistoryStatus === "checking" ? "履歴確認中" : "履歴未確認"
      : visits > 1
      ? `${formatNumber(visits)}回目${previousVisit ? `（${previousVisit}）` : ""}`
      : "初見";
    const reentryLabel = entryEvents > 1 ? `・入室通知${formatNumber(entryEvents)}回` : "";
    return `
      <div class="user-row visitor-row ${historyKnown && visits === 1 ? "first-visit-row" : ""}">
        ${renderEventAvatar(user)}
        <span class="name">${renderDecoratedName(user)}</span>
        <span class="visit-meta">
          <strong>${visitLabel}</strong>
          <small>${formatClock(user.firstJoinAt || user.firstSeenAt)}${reentryLabel}</small>
        </span>
      </div>
    `;
  }).join("");
}

function toggleVisitorDemo() {
  setVisitorDemoActive(!visitorDemoActive);
}

function setVisitorDemoActive(active) {
  visitorDemoActive = Boolean(active);
  if (visitorDemoBtn) {
    visitorDemoBtn.textContent = visitorDemoActive ? "デモ表示を終了" : "初見・再訪をデモ表示";
    visitorDemoBtn.setAttribute("aria-pressed", String(visitorDemoActive));
    visitorDemoBtn.classList.toggle("active", visitorDemoActive);
  }
  const selected = selectedSessionId ? sessions.get(selectedSessionId) : null;
  renderVisitorHistory(selected?.snapshot?.visitors || []);
  renderComments(selected?.snapshot?.comments || []);
}

function visitorDemoUsers() {
  const now = Date.now();
  return [
    {
      userId: "demo-first",
      nickname: "はじめて来たリスナー",
      visitHistoryKnown: true,
      visitHistoryStatus: "first",
      visitCount: 1,
      entryEventCount: 1,
      visitSource: "member",
      firstJoinAt: now,
      firstSeenAt: now
    },
    {
      userId: "demo-return",
      nickname: "また来てくれたリスナー",
      visitHistoryKnown: true,
      visitHistoryStatus: "returning",
      visitCount: 3,
      entryEventCount: 1,
      visitSource: "viewer_ranking",
      previousVisitAt: now - 24 * 60 * 60 * 1000,
      firstJoinAt: now - 60_000,
      firstSeenAt: now - 60_000
    }
  ];
}

function visitorDemoComments() {
  const [firstVisit, returnVisit] = visitorDemoUsers();
  return [
    { ...firstVisit, at: Date.now(), text: "はじめまして！" },
    { ...returnVisit, at: Date.now() - 15_000, text: "また来ました！" }
  ];
}

function eventSourceBadge(item) {
  return item.source === "initial" ? `<span class="source-badge">遡り</span>` : "";
}

function setStatus(status, message, mode) {
  statusDot.className = `status-dot ${status === "live" ? "live" : ""}`;
  statusText.textContent = message || "待機中";
  modeText.textContent = mode;
}

function renderDecoratedName(user) {
  const name = escapeHtml(user.nickname || user.userId);
  return `${heartMeMark(user)}${todayFollowMark(user)}${name}`;
}

function renderEventAvatar(user) {
  const name = String(user?.nickname || user?.uniqueId || user?.userId || "?").trim();
  const fallback = Array.from(name)[0] || "?";
  const avatarUrl = String(user?.avatarUrl || "").trim();
  const image = /^https:\/\//i.test(avatarUrl)
    ? `<img src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : "";
  return `<span class="event-avatar" aria-hidden="true"><span>${escapeHtml(fallback)}</span>${image}</span>`;
}

function heartMeMark(user) {
  const membershipStatus = user.heartMeStatus || "unknown";
  const historyStatus = user.heartMeHistoryStatus || "unknown";
  const level = Number(user.heartMeLevel || 0);
  const status = membershipStatus === "inactive"
    ? "inactive"
    : historyStatus === "first_ever"
      ? "new-today"
      : historyStatus === "returning"
        ? "active"
        : "unknown";
  const titleMap = {
    "new-today": "全期間で初めてハートミー送信",
    active: "過去の配信でもハートミー送信記録あり",
    inactive: "ハートミー休止・凍結",
    unknown: "ハートミー送信履歴未確認"
  };
  const title = `${titleMap[status]}${level > 0 ? ` Lv.${level}` : ""}`;
  const symbol = status === "unknown" ? "♡" : "♥";
  return `<span class="heart-mark heart-${status}" title="${escapeHtml(title)}">${symbol}</span>`;
}

function todayFollowMark(user) {
  return user.followedToday ? `<span class="follow-mark" title="本日フォロー">✓</span>` : "";
}

function modeLabel(snapshot) {
  if (snapshot?.preview) return snapshot?.status === "live" ? "確認中" : "確認待機";
  if (snapshot?.errorCode === "rate_limited") return "制限中";
  if (snapshot?.status === "ended") return "終了";
  if (snapshot?.mode === "live") return snapshot?.provider === "tiktools" ? "Tik.tools" : "実接続";
  if (snapshot?.mode === "error") return "接続失敗";
  return "接続中";
}

function statusMessage(snapshot) {
  if (snapshot.preview) return `${snapshot.username} を保存せず確認中です。`;
  if (snapshot.status === "live") return `${snapshot.username} のLIVEを計測中です。`;
  if (snapshot.status === "ended") return "LIVEが終了しました。";
  if (snapshot.status === "stopped") return "停止しました。";
  return "接続中です。";
}

function formatNumber(value) {
  return new Intl.NumberFormat("ja-JP").format(value || 0);
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatCountdown(ms) {
  const seconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分`;
  return `${seconds}秒`;
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - Number(timestamp || 0);
  if (!timestamp || diff < 0) return "-";
  if (diff < 60000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  return formatClock(timestamp);
}

function formatClock(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}

function formatVisitDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  const options = date.getFullYear() === now.getFullYear()
    ? { month: "numeric", day: "numeric" }
    : { year: "numeric", month: "numeric", day: "numeric" };
  return new Intl.DateTimeFormat("ja-JP", options).format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
