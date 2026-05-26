const form = document.querySelector("#connectForm");
const usernameInput = document.querySelector("#username");
const stopBtn = document.querySelector("#stopBtn");
const exportLink = document.querySelector("#exportLink");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const modeText = document.querySelector("#modeText");
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
const watcherList = document.querySelector("#watcherList");
const silentList = document.querySelector("#silentList");
const recentIds = document.querySelector("#recentIds");
const recentIdList = document.querySelector("#recentIdList");
const panelToggles = [...document.querySelectorAll("[data-panel-toggle]")];

const STORAGE_KEY = "tiktok-live-active-session";
const RECENT_IDS_KEY = "tiktok-live-recent-ids";
const PANEL_PREFS_KEY = "tiktok-live-panel-prefs";
const MAX_RECENT_IDS = 8;

let eventSource = null;
let activeSession = null;
let latestSnapshot = null;
let clockTimer = null;
let reconnectTimer = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await startSession();
});

stopBtn.addEventListener("click", async () => {
  if (!activeSession) return;
  await fetch(`/api/session/${activeSession}/stop`, { method: "POST" });
  clearSavedSession();
});

window.addEventListener("pageshow", restoreSavedSession);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) reconnectActiveSession();
});
window.addEventListener("focus", reconnectActiveSession);
window.addEventListener("online", reconnectActiveSession);

setupPanelToggles();
renderRecentIds();
restoreSavedSession();

async function startSession() {
  closeCurrent({ forget: false });
  setBusy(true);
  setStatus("connecting", "接続を準備しています。", "接続中");

  const username = usernameInput.value.trim().replace(/^@/, "");

  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "接続を開始できませんでした。");

    activateSession(body.id, username);
    rememberRecentId(username);
  } catch (error) {
    closeCurrent({ forget: true });
    setStatus("stopped", error.message, "未接続");
  } finally {
    setBusy(false);
  }
}

async function restoreSavedSession() {
  const saved = readSavedSession();
  if (!saved?.id || activeSession === saved.id) return;

  try {
    const response = await fetch(`/api/session/${saved.id}/snapshot`, { cache: "no-store" });
    if (!response.ok) {
      clearSavedSession();
      return;
    }
    activateSession(saved.id, saved.username || "");
    renderSnapshot(await response.json());
  } catch {
    setStatus("connecting", "保存済みの計測へ復帰待ちです。", "復帰待ち");
  }
}

function activateSession(sessionId, username) {
  activeSession = sessionId;
  if (username) usernameInput.value = username;
  saveActiveSession(sessionId, usernameInput.value.trim().replace(/^@/, ""));
  exportLink.href = `/api/session/${activeSession}/export.csv`;
  exportLink.classList.remove("disabled");
  exportLink.removeAttribute("aria-disabled");
  stopBtn.disabled = false;
  openEventStream();
  startSnapshotClock();
}

function openEventStream() {
  if (!activeSession) return;
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/session/${activeSession}/events`);
  eventSource.addEventListener("status", (event) => renderSnapshot(JSON.parse(event.data)));
  eventSource.addEventListener("comment", (event) => {
    const payload = JSON.parse(event.data);
    renderSnapshot(payload.snapshot);
  });
  eventSource.addEventListener("gift", (event) => {
    const payload = JSON.parse(event.data);
    renderSnapshot(payload.snapshot);
  });
  eventSource.onerror = () => {
    if (!activeSession) return;
    setStatus("connecting", "表示だけ再接続中です。集計はサーバー側で継続します。", "再接続中");
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectActiveSession();
  }, 5000);
}

async function reconnectActiveSession() {
  if (!activeSession) {
    await restoreSavedSession();
    return;
  }
  try {
    const response = await fetch(`/api/session/${activeSession}/snapshot`, { cache: "no-store" });
    if (!response.ok) throw new Error("セッション切れ");
    renderSnapshot(await response.json());
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
      openEventStream();
    }
  } catch {
    setStatus("connecting", "復帰待ちです。サーバーが起動中の場合は少し待ってください。", "復帰待ち");
  }
}

function startSnapshotClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(async () => {
    if (!latestSnapshot || latestSnapshot.stoppedAt || !activeSession) return;
    latestSnapshot.elapsedSeconds = Math.floor((Date.now() - latestSnapshot.startedAt) / 1000);
    renderMetrics(latestSnapshot);
    if (document.hidden) return;
    try {
      const snapshot = await (await fetch(`/api/session/${activeSession}/snapshot`, { cache: "no-store" })).json();
      renderSnapshot(snapshot);
    } catch {
      renderMetrics(latestSnapshot);
    }
  }, 1000);
}

function closeCurrent({ forget } = { forget: false }) {
  if (eventSource) eventSource.close();
  eventSource = null;
  activeSession = null;
  latestSnapshot = null;
  if (clockTimer) clearInterval(clockTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  clockTimer = null;
  reconnectTimer = null;
  exportLink.removeAttribute("href");
  exportLink.classList.add("disabled");
  exportLink.setAttribute("aria-disabled", "true");
  stopBtn.disabled = true;
  if (forget) clearSavedSession();
}

function saveActiveSession(id, username) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, username, savedAt: Date.now() }));
}

function readSavedSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function clearSavedSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function rememberRecentId(username) {
  const cleaned = username.trim().replace(/^@/, "");
  if (!cleaned) return;
  const ids = readRecentIds().filter((id) => id.toLowerCase() !== cleaned.toLowerCase());
  ids.unshift(cleaned);
  localStorage.setItem(RECENT_IDS_KEY, JSON.stringify(ids.slice(0, MAX_RECENT_IDS)));
  renderRecentIds();
}

function readRecentIds() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_IDS_KEY) || "[]");
    return Array.isArray(value) ? value.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function renderRecentIds() {
  const ids = readRecentIds();
  recentIds.innerHTML = ids.map((id) => `<option value="${escapeHtml(id)}"></option>`).join("");
  if (!ids.length) {
    recentIdList.innerHTML = "";
    return;
  }
  recentIdList.innerHTML = ids.map((id) => `
    <button type="button" data-recent-id="${escapeHtml(id)}">@${escapeHtml(id)}</button>
  `).join("");
  recentIdList.querySelectorAll("[data-recent-id]").forEach((button) => {
    button.addEventListener("click", () => {
      usernameInput.value = button.dataset.recentId;
      usernameInput.focus();
    });
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

function setBusy(isBusy) {
  form.querySelector("button[type='submit']").disabled = isBusy;
  usernameInput.disabled = isBusy;
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot;
  setStatus(snapshot.status, snapshot.message || statusMessage(snapshot), modeLabel(snapshot));
  renderMetrics(snapshot);
  renderComments(snapshot.comments || []);
  renderWatchers(snapshot.topWatchers || []);
  renderSilentLongWatchers(snapshot.silentLongWatchers || []);
  renderUsers(snapshot.topUsers || []);
  renderGifters(snapshot.topGifters || []);
  renderGiftHistory(snapshot.gifts || []);

  if (snapshot.stoppedAt || snapshot.status === "ended") {
    if (eventSource) eventSource.close();
    stopBtn.disabled = true;
    clearSavedSession();
  }
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
    silentList.innerHTML = `<p class="empty">まだ対象者はいません。</p>`;
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
  if (snapshot.mode === "live") return "実接続";
  if (snapshot.mode === "error") return "接続失敗";
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
