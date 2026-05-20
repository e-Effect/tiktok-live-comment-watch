const form = document.querySelector("#connectForm");
const usernameInput = document.querySelector("#username");
const stopBtn = document.querySelector("#stopBtn");
const exportLink = document.querySelector("#exportLink");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const modeText = document.querySelector("#modeText");
const commentCount = document.querySelector("#commentCount");
const elapsedTime = document.querySelector("#elapsedTime");
const currentViewers = document.querySelector("#currentViewers");
const watchTime = document.querySelector("#watchTime");
const commentList = document.querySelector("#commentList");
const userList = document.querySelector("#userList");
const liveLabel = document.querySelector("#liveLabel");

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
  const mode = new FormData(form).get("mode");

  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, mode })
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
      latestSnapshot = payload.snapshot;
      renderSnapshot(payload.snapshot);
    });
    eventSource.onerror = () => {
      setStatus("stopped", "接続が中断されました。", "再接続待ち");
    };

    clockTimer = setInterval(() => {
      if (latestSnapshot && !latestSnapshot.stoppedAt) {
        latestSnapshot.elapsedSeconds = Math.floor((Date.now() - latestSnapshot.startedAt) / 1000);
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
  renderUsers(snapshot.topUsers || []);

  if (snapshot.stoppedAt || snapshot.status === "ended") {
    if (eventSource) eventSource.close();
    stopBtn.disabled = true;
  }
}

function renderMetrics(snapshot) {
  commentCount.textContent = formatNumber(snapshot.commentCount);
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

function setStatus(status, message, mode) {
  statusDot.className = `status-dot ${status === "live" ? "live" : status === "demo" ? "demo" : ""}`;
  statusText.textContent = message || "待機中";
  modeText.textContent = mode;
}

function modeLabel(snapshot) {
  if (snapshot.mode === "live") return "実接続";
  if (snapshot.mode === "demo") return "デモ";
  return "接続中";
}

function statusMessage(snapshot) {
  if (snapshot.status === "live") return `${snapshot.username} のLIVEを計測中です。`;
  if (snapshot.status === "demo") return `${snapshot.username} をデモ計測中です。`;
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
