const form = document.querySelector("#connectForm");
const usernameInput = document.querySelector("#username");
const stopBtn = document.querySelector("#stopBtn");
const exportLink = document.querySelector("#exportLink");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const modeText = document.querySelector("#modeText");
const serverState = document.querySelector("#serverState");
const tikTokState = document.querySelector("#tikTokState");
const lastEventTime = document.querySelector("#lastEventTime");
const cooldownTime = document.querySelector("#cooldownTime");
const commentCount = document.querySelector("#commentCount");
const initialCount = document.querySelector("#initialCount");
const giftCount = document.querySelector("#giftCount");
const giftDiamonds = document.querySelector("#giftDiamonds");
const elapsedTime = document.querySelector("#elapsedTime");
const currentViewers = document.querySelector("#currentViewers");
const watchTime = document.querySelector("#watchTime");
const commentList = document.querySelector("#commentList");
const userList = document.querySelector("#userList");
const giftList = document.querySelector("#giftList");
const giftHistory = document.querySelector("#giftHistory");
const shareHistory = document.querySelector("#shareHistory");
const watcherList = document.querySelector("#watcherList");
const silentList = document.querySelector("#silentList");
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

const LEGACY_STORAGE_KEY = "tiktok-live-active-session";
const SESSIONS_KEY = "tiktok-live-active-sessions";
const RECENT_IDS_KEY = "tiktok-live-recent-ids";
const PANEL_PREFS_KEY = "tiktok-live-panel-prefs";
const LAYOUT_PREFS_KEY = "tiktok-live-layout-prefs";
const RATE_LIMIT_KEY = "tiktok-live-rate-limit-until";
const FIXED_ACCOUNT_KEY = "tiktok-live-fixed-account";
const SINGLE_MODE_KEY = "tiktok-live-single-mode";
const MAX_RECENT_IDS = 8;
const MAX_ACTIVE_SESSIONS = 3;
const PANEL_SIZE_OPTIONS = ["small", "medium", "large", "wide"];
const PANEL_SIZE_LABELS = { small: "小", medium: "中", large: "大", wide: "横" };
const DEFAULT_PANEL_SIZES = {
  report: "wide",
  comments: "large",
  shares: "medium",
  watchers: "medium",
  silent: "medium",
  gifts: "medium",
  users: "medium",
  giftHistory: "medium"
};
const DEFAULT_PANEL_ORDER = layoutPanels.map((panel) => panel.dataset.panel);

const sessions = new Map();
const eventSources = new Map();
const pendingProfileLookups = new Set();

let selectedSessionId = null;
let clockTimer = null;
let reconnectTimer = null;
let snapshotFetchTick = 0;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await startSession();
});

stopBtn.addEventListener("click", async () => {
  if (!selectedSessionId) return;
  const sessionId = selectedSessionId;
  try {
    await fetch(`/api/session/${sessionId}/stop`, { method: "POST" });
  } finally {
    closeSession(sessionId, { forget: true });
  }
});

window.addEventListener("pageshow", restoreSavedSessions);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) reconnectActiveSessions();
});
window.addEventListener("focus", reconnectActiveSessions);
window.addEventListener("online", reconnectActiveSessions);

setupPanelToggles();
setupLayoutTools();
setupFixedAccountTools();
renderRecentIds();
refreshMissingRecentProfiles();
restoreSavedSessions();
renderSessionCards();
renderSelectedSession();
refreshServerState();
setInterval(refreshServerState, 30000);

async function startSession(options = {}) {
  setBusy(true);
  setStatus("connecting", "接続を準備しています。", "追加中");

  const username = cleanUsername(options.username ?? usernameInput.value);
  if (!username) {
    setStatus("stopped", "TikTok IDを入力してください。", "入力待ち");
    setBusy(false);
    return;
  }
  const cooldown = readRateLimitCooldown();
  if (cooldown.active) {
    setStatus("stopped", `TikTok側の接続制限中です。${formatClock(cooldown.until)}頃まで新しい接続を止めます。`, "制限中");
    setBusy(false);
    return;
  }
  const existing = findSessionByUsername(username);
  if (existing) {
    selectSession(existing.id);
    setBusy(false);
    return;
  }
  const maxSessions = isSingleMode() ? 1 : MAX_ACTIVE_SESSIONS;
  if (activeSessionCount() >= maxSessions) {
    setStatus("stopped", `同時監視は最大${maxSessions}件までです。不要な配信を停止してから追加してください。`, "追加停止");
    setBusy(false);
    return;
  }

  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username })
    });
    const body = await response.json();
    if (!response.ok) {
      if (body.errorCode === "rate_limited" || isRateLimitMessage(body.error)) {
        setRateLimitCooldown(body.error, body.retryAt);
      }
      throw new Error(body.error || "接続を開始できませんでした。");
    }

    activateSession(body.id, username, { select: true });
    rememberRecentId(username);
    refreshRecentProfile(username);
    usernameInput.value = "";
  } catch (error) {
    setStatus("stopped", error.message, "未接続");
  } finally {
    setBusy(false);
  }
}

async function restoreSavedSessions() {
  const savedSessions = readSavedSessions();
  if (!savedSessions.length) return;

  for (const saved of savedSessions) {
    if (!saved?.id || sessions.has(saved.id)) continue;
    try {
      const response = await fetch(`/api/session/${saved.id}/snapshot`, { cache: "no-store" });
      if (!response.ok) continue;
      const snapshot = await response.json();
      activateSession(saved.id, saved.username || snapshot.username || "", {
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
    createdAt: existing.createdAt || Date.now()
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
  source.addEventListener("status", (event) => renderSnapshot(JSON.parse(event.data)));
  source.addEventListener("comment", (event) => {
    const payload = JSON.parse(event.data);
    renderSnapshot(payload.snapshot);
  });
  source.addEventListener("gift", (event) => {
    const payload = JSON.parse(event.data);
    renderSnapshot(payload.snapshot);
  });
  source.addEventListener("share", (event) => {
    const payload = JSON.parse(event.data);
    renderSnapshot(payload.snapshot);
  });
  source.onerror = () => {
    source.close();
    eventSources.delete(sessionId);
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
    renderSessionCards();
    renderSelectedSession();
    if (document.hidden || snapshotFetchTick % 5 !== 0) return;
    await Promise.all([...sessions.keys()].map(async (sessionId) => {
      try {
        const snapshot = await (await fetch(`/api/session/${sessionId}/snapshot`, { cache: "no-store" })).json();
        renderSnapshot(snapshot);
      } catch {
        renderSessionCards();
      }
    }));
  }, 1000);
}

function closeSession(sessionId, { forget } = { forget: false }) {
  const source = eventSources.get(sessionId);
  if (source) source.close();
  eventSources.delete(sessionId);
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

function findSessionByUsername(username) {
  const cleaned = cleanUsername(username).toLowerCase();
  return [...sessions.values()].find((session) => session.username.toLowerCase() === cleaned);
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
  const items = [...sessions.values()].map((session) => ({
    id: session.id,
    username: session.username || session.snapshot?.username || "",
    selected: session.id === selectedSessionId,
    savedAt: Date.now()
  }));
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(items));
  if (selectedSessionId) {
    const selected = sessions.get(selectedSessionId);
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({
      id: selectedSessionId,
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

function clearSavedSession() {
  saveActiveSessions();
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
      sizes: value.sizes && typeof value.sizes === "object" ? value.sizes : {}
    };
  } catch {
    return { order: [], sizes: {} };
  }
}

function writeLayoutPrefs(prefs) {
  localStorage.setItem(LAYOUT_PREFS_KEY, JSON.stringify({
    order: normalizedPanelOrder(prefs.order),
    sizes: normalizedPanelSizes(prefs.sizes)
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

function applyLayoutPrefs() {
  if (!layoutGrid) return;
  const prefs = readLayoutPrefs();
  const order = normalizedPanelOrder(prefs.order);
  const sizes = normalizedPanelSizes(prefs.sizes);
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
  });
}

function setPanelSize(panelName, size) {
  if (!DEFAULT_PANEL_ORDER.includes(panelName) || !PANEL_SIZE_OPTIONS.includes(size)) return;
  const prefs = readLayoutPrefs();
  prefs.sizes = { ...normalizedPanelSizes(prefs.sizes), [panelName]: size };
  writeLayoutPrefs({ ...prefs, order: currentPanelOrder() });
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
  form.querySelector("button[type='submit']").disabled = isBusy;
  usernameInput.disabled = isBusy;
}

function renderSnapshot(snapshot) {
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
  session.snapshot = snapshot;
  sessions.set(snapshot.id, session);

  if (!selectedSessionId) selectedSessionId = snapshot.id;
  if (snapshot.username) {
    rememberRecentId(snapshot.username, snapshot.displayName, { moveToTop: false });
  }
  if (!shouldKeepSessionConnected(snapshot)) {
    const source = eventSources.get(snapshot.id);
    if (source) source.close();
    eventSources.delete(snapshot.id);
  }
  saveActiveSessions();
  renderSessionCards();
  if (selectedSessionId === snapshot.id) renderSelectedSession();
}

function renderSelectedSession() {
  const selected = selectedSessionId ? sessions.get(selectedSessionId) : null;
  const snapshot = selected?.snapshot;
  updateSelectedControls();
  if (!snapshot) {
    setStatus("stopped", sessions.size ? "配信を選択してください。" : "未接続", sessions.size ? "選択待ち" : "待機中");
    renderConnectionDetails(null);
    renderMetrics(emptySnapshot());
    renderReport(null);
    renderComments([]);
    renderWatchers([]);
    renderSilentLongWatchers([]);
    renderUsers([]);
    renderGifters([]);
    renderGiftHistory([]);
    renderShareHistory([]);
    return;
  }
  const cooldown = readRateLimitCooldown();
  const message = snapshot.errorCode === "rate_limited" && cooldown.active
    ? `${snapshot.message || statusMessage(snapshot)} 新規追加は${formatClock(cooldown.until)}頃まで止めています。`
    : snapshot.message || statusMessage(snapshot);
  setStatus(snapshot.status, message, modeLabel(snapshot));
  renderConnectionDetails(snapshot);
  renderMetrics(snapshot);
  renderReport(snapshot);
  renderComments(snapshot.comments || []);
  renderWatchers(snapshot.topWatchers || []);
  renderSilentLongWatchers(snapshot.silentLongWatchers || []);
  renderUsers(snapshot.topUsers || []);
  renderGifters(snapshot.topGifters || []);
  renderGiftHistory(snapshot.gifts || []);
  renderShareHistory(snapshot.shares || []);
}

function updateSelectedControls() {
  const selected = selectedSessionId ? sessions.get(selectedSessionId) : null;
  const snapshot = selected?.snapshot;
  const canStop = Boolean(selected && shouldKeepSessionConnected(snapshot));
  stopBtn.disabled = !canStop;
  if (selected) {
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
    return `
      <button type="button" class="session-card ${isSelected ? "selected" : ""}" data-session-id="${escapeHtml(session.id)}">
        <span class="session-title">${escapeHtml(name)}</span>
        <span class="session-id">@${escapeHtml(session.username || snapshot?.username || "")}</span>
        <span class="session-stats">
          <strong>${formatNumber(snapshot?.commentCount || 0)}</strong> コメント
          <strong>${formatNumber(snapshot?.giftCount || 0)}</strong> ギフト
        </span>
        <span class="session-state">${escapeHtml(modeLabel(snapshot || { mode: "connecting" }))}</span>
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
}

async function refreshServerState() {
  if (!serverState) return;
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error("health");
    serverState.textContent = `サーバー稼働中 ${formatDuration(body.uptimeSeconds)}・${formatNumber(body.sessions)}接続`;
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
  const topGifter = snapshot.topGifters?.[0];
  const topWatcher = snapshot.topWatchers?.[0];
  const silentCount = Number(snapshot.silentLongWatchers?.length || 0);
  const followedCount = Number(snapshot.followedTodayCount || 0);
  const shareCount = Number(snapshot.shareCount || snapshot.shares?.length || 0);
  reportList.innerHTML = `
    <article><span>コメント最多</span><strong>${escapeHtml(topCommenter?.nickname || topCommenter?.userId || "-")}</strong><small>${formatNumber(topCommenter?.comments || 0)}件</small></article>
    <article><span>ギフト最多</span><strong>${escapeHtml(topGifter?.nickname || topGifter?.userId || "-")}</strong><small>${formatNumber(topGifter?.diamonds || 0)}ダイヤ</small></article>
    <article><span>最長滞在</span><strong>${escapeHtml(topWatcher?.nickname || topWatcher?.userId || "-")}</strong><small>${formatDuration(topWatcher?.watchSeconds || 0)}</small></article>
    <article><span>現視聴15分無言</span><strong>${formatNumber(silentCount)}</strong><small>人</small></article>
    <article><span>シェア</span><strong>${formatNumber(shareCount)}</strong><small>回</small></article>
    <article><span>本日フォロー</span><strong>${formatNumber(followedCount)}</strong><small>人</small></article>
    <article><span>計測時間</span><strong>${formatDuration(snapshot.elapsedSeconds)}</strong><small>${escapeHtml(snapshot.displayName || snapshot.username || "")}</small></article>
  `;
}

function renderMetrics(snapshot) {
  commentCount.textContent = formatNumber(snapshot.commentCount);
  initialCount.textContent = formatNumber(snapshot.initialEventCount);
  giftCount.textContent = formatNumber(snapshot.giftCount);
  giftDiamonds.textContent = formatNumber(snapshot.giftDiamondTotal);
  elapsedTime.textContent = formatDuration(snapshot.elapsedSeconds);
  currentViewers.textContent = snapshot.viewerStats?.current ? formatNumber(snapshot.viewerStats.current) : "-";
  watchTime.textContent = snapshot.viewerStats?.estimatedWatchSeconds
    ? formatDuration(Math.floor(snapshot.viewerStats.estimatedWatchSeconds))
    : "-";
}

function renderComments(comments) {
  if (!comments.length) {
    commentList.innerHTML = `<p class="empty">接続するとコメントがここに流れます。</p>`;
    return;
  }
  commentList.innerHTML = comments.map((comment) => `
    <article class="comment">
      <header>
        <span class="name">${escapeHtml(comment.nickname || comment.userId)}</span>
        <span class="time">${formatClock(comment.at)}</span>
      </header>
      <p>${eventSourceBadge(comment)}${escapeHtml(comment.text)}</p>
    </article>
  `).join("");
}

function renderWatchers(users) {
  renderRankList(watcherList, users, "まだ滞在時間はありません。", (user) => formatDuration(user.watchSeconds));
}

function renderSilentLongWatchers(users) {
  if (!users.length) {
    silentList.innerHTML = `<p class="empty">視聴者ランキングにいる対象者はいません。</p>`;
    return;
  }
  silentList.innerHTML = users.map((user, index) => `
    <div class="user-row silent-row ${silentLevelClass(user.watchSeconds)}">
      <span class="rank">${index + 1}</span>
      <span class="name">${renderName(user)}</span>
      <span class="count">${formatDuration(user.watchSeconds)}</span>
    </div>
  `).join("");
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
      <span class="name">${renderName(user)}</span>
      <span class="count">${valueRenderer(user)}</span>
    </div>
  `).join("");
}

function renderGifters(users) {
  if (!users.length) {
    giftList.innerHTML = `<p class="empty">まだギフトはありません。</p>`;
    return;
  }
  giftList.innerHTML = users.map((user, index) => `
    <div class="user-row gift-row">
      <span class="rank">${index + 1}</span>
      <span class="name">${renderName(user)}</span>
      <span class="gift-score">
        <strong>${formatNumber(user.diamonds)}</strong>
        <small>${formatNumber(user.gifts)}個</small>
      </span>
    </div>
  `).join("");
}

function renderGiftHistory(gifts) {
  if (!gifts.length) {
    giftHistory.innerHTML = `<p class="empty">ギフトが届くとここに表示されます。</p>`;
    return;
  }
  giftHistory.innerHTML = gifts.map((gift) => `
    <article class="comment gift-card">
      <header>
        <span class="name">${escapeHtml(gift.nickname || gift.userId)}</span>
        <span class="time">${formatClock(gift.at)}</span>
      </header>
      <p>
        ${escapeHtml(gift.giftName || "ギフト")}
        ${eventSourceBadge(gift)}
        <strong>x${formatNumber(gift.repeatCount)}</strong>
        <span>${formatNumber(gift.totalDiamonds)} ダイヤ</span>
      </p>
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
    <article class="comment share-card">
      <header>
        <span class="name">${escapeHtml(share.nickname || share.userId)}</span>
        <span class="time">${formatClock(share.at)}</span>
      </header>
      <p>${eventSourceBadge(share)}シェア</p>
    </article>
  `).join("");
}

function silentLevelClass(seconds) {
  if (seconds >= 90 * 60) return "silent-red";
  if (seconds >= 60 * 60) return "silent-green";
  if (seconds >= 30 * 60) return "silent-yellow";
  return "";
}

function eventSourceBadge(item) {
  return item.source === "initial" ? `<span class="source-badge">遡り</span>` : "";
}

function setStatus(status, message, mode) {
  statusDot.className = `status-dot ${status === "live" ? "live" : ""}`;
  statusText.textContent = message || "待機中";
  modeText.textContent = mode;
}

function renderName(user) {
  const name = escapeHtml(user.nickname || user.userId);
  return user.followedToday ? `<span class="follow-mark" title="本日フォロー">✓</span>${name}` : name;
}

function modeLabel(snapshot) {
  if (snapshot?.errorCode === "rate_limited") return "制限中";
  if (snapshot?.status === "ended") return "終了";
  if (snapshot?.mode === "live") return "実接続";
  if (snapshot?.mode === "error") return "接続失敗";
  return "接続中";
}

function statusMessage(snapshot) {
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
