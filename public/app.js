const form = document.querySelector("#connectForm");
const usernameInput = document.querySelector("#username");
const stopBtn = document.querySelector("#stopBtn");
const exportLink = document.querySelector("#exportLink");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const modeText = document.querySelector("#modeText");
const commentCount = document.querySelector("#commentCount");
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

let eventSource = null;
let activeSession = null;
let latestSnapshot = null;
let clockTimer = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await startSession();
});

stopBtn.addEventListener("click", async () => {
  if (!activeSession) return;
  await fetch(`/api/session/${activeSession}/stop`, { method: "POST" });
});

async function startSession() {
  closeCurrent();
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

    activeSession = body.id;
    exportLink.href = `/api/session/${activeSession}/export.csv`;
    exportLink.classList.remove("disabled");
    exportLink.removeAttribute("aria-disabled");
    stopBtn.disabled = false;

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
      setStatus("stopped", "接続が中断されました。", "再接続待ち");
    };

    clockTimer = setInterval(async () => {
      if (!latestSnapshot || latestSnapshot.stoppedAt || !activeSession) return;
      latestSnapshot.elapsedSeconds = Math.floor((Date.now() - latestSnapshot.startedAt) / 1000);
      renderMetrics(latestSnapshot);
      try {
        const snapshot = await (await fetch(`/api/session/${activeSession}/snapshot`)).json();
        renderSnapshot(snapshot);
      } catch {
        renderMetrics(latestSnapshot);
      }
    }, 1000);
  } catch (error) {
    closeCurrent();
    setStatus("stopped", error.message, "未接続");
  } finally {
    setBusy(false);
  }
}

function closeCurrent() {
  if (eventSource) eventSource.close();
  eventSource = null;
  activeSession = null;
  latestSnapshot = null;
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
  exportLink.removeAttribute("href");
  exportLink.classList.add("disabled");
  exportLink.setAttribute("aria-disabled", "true");
  stopBtn.disabled = true;
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
  renderUsers(snapshot.topUsers || []);
  renderGifters(snapshot.topGifters || []);
  renderGiftHistory(snapshot.gifts || []);

  if (snapshot.stoppedAt || snapshot.status === "ended") {
    if (eventSource) eventSource.close();
    stopBtn.disabled = true;
  }
}

function renderMetrics(snapshot) {
  commentCount.textContent = formatNumber(snapshot.commentCount);
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
      <p>${escapeHtml(comment.text)}</p>
    </article>
  `).join("");
}

function renderWatchers(users) {
  if (!users.length) {
    watcherList.innerHTML = `<p class="empty">まだ滞在時間はありません。</p>`;
    return;
  }
  watcherList.innerHTML = users.map((user, index) => `
    <div class="user-row">
      <span class="rank">${index + 1}</span>
      <span class="name">${escapeHtml(user.nickname || user.userId)}</span>
      <span class="count">${formatDuration(user.watchSeconds)}</span>
    </div>
  `).join("");
}

function renderUsers(users) {
  if (!users.length) {
    userList.innerHTML = `<p class="empty">まだ集計はありません。</p>`;
    return;
  }
  userList.innerHTML = users.map((user, index) => `
    <div class="user-row">
      <span class="rank">${index + 1}</span>
      <span class="name">${escapeHtml(user.nickname || user.userId)}</span>
      <span class="count">${formatNumber(user.comments)}</span>
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
      <span class="name">${escapeHtml(user.nickname || user.userId)}</span>
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
        <strong>x${formatNumber(gift.repeatCount)}</strong>
        <span>${formatNumber(gift.totalDiamonds)} ダイヤ</span>
      </p>
    </article>
  `).join("");
}

function setStatus(status, message, mode) {
  statusDot.className = `status-dot ${status === "live" ? "live" : ""}`;
  statusText.textContent = message || "待機中";
  modeText.textContent = mode;
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
