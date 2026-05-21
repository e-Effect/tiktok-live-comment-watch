document.body["inner\x48\x54\x4d\x4c"]="<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>&#x54;ik&#x54;ok &#x4c;&#x49;&#x56;&#x45; &#x30b3;&#x30e1;&#x30f3;&#x30c8;&#x8a08;&#x6e2c;</title><link rel=\"stylesheet\" href=\"/styles.css\"></head><body><main class=\"app\"><section class=\"panel\"><h1>&#x54;ik&#x54;ok &#x4c;&#x49;&#x56;&#x45; &#x30b3;&#x30e1;&#x30f3;&#x30c8;&#x8a08;&#x6e2c;</h1><form id=\"connect&#x46;orm\" class=\"form\"><label for=\"username\">&#x54;ik&#x54;ok &#x49;&#x44;</label><div class=\"row\"><input id=\"username\" name=\"username\" autocomplete=\"off\" placeholder=\"@username\" required><button type=\"submit\">&#x63a5;&#x7d9a;</button></div><div class=\"modes\" role=\"group\" aria-label=\"&#x63a5;&#x7d9a;&#x30e2;&#x30fc;&#x30c9;\"><label><input type=\"radio\" name=\"mode\" value=\"auto\" checked> &#x5b9f;&#x63a5;&#x7d9a;</label><label><input type=\"radio\" name=\"mode\" value=\"demo\"> &#x30c7;&#x30e2;</label></div></form><div class=\"actions\"><button id=\"stop&#x42;tn\" type=\"button\" disabled>&#x505c;&#x6b62;</button><a id=\"export&#x4c;ink\" class=\"disabled\" aria-disabled=\"true\">&#x43;&#x53;&#x56;&#x51fa;&#x529b;</a></div></section><section class=\"dashboard\" aria-live=\"polite\"><div class=\"status\"><span id=\"status&#x44;ot\"></span><span id=\"status&#x54;ext\">&#x672a;&#x63a5;&#x7d9a;</span><strong id=\"mode&#x54;ext\">&#x5f85;&#x6a5f;&#x4e2d;</strong></div><div class=\"metrics\"><article><span>&#x30b3;&#x30e1;&#x30f3;&#x30c8;&#x6570;</span><strong id=\"comment&#x43;ount\">0</strong></article><article><span>&#x8a08;&#x6e2c;&#x6642;&#x9593;</span><strong id=\"elapsed&#x54;ime\">00:00</strong></article><article><span>&#x73fe;&#x5728;&#x8996;&#x8074;</span><strong id=\"current&#x56;iewers\">-</strong></article><article><span>&#x63a8;&#x5b9a;&#x6ede;&#x5728;</span><strong id=\"watch&#x54;ime\">-</strong></article></div><div class=\"grid\"><section><h2>&#x30b3;&#x30e1;&#x30f3;&#x30c8;</h2><div id=\"comment&#x4c;ist\" class=\"list\"><p class=\"empty\">&#x63a5;&#x7d9a;&#x3059;&#x308b;&#x3068;&#x30b3;&#x30e1;&#x30f3;&#x30c8;&#x304c;&#x3053;&#x3053;&#x306b;&#x6d41;&#x308c;&#x307e;&#x3059;&#x3002;</p></div></section><section><h2>&#x30e6;&#x30fc;&#x30b6;&#x30fc;&#x5225;&#x30b3;&#x30e1;&#x30f3;&#x30c8;&#x6570;</h2><div id=\"user&#x4c;ist\" class=\"list small\"><p class=\"empty\">&#x307e;&#x3060;&#x96c6;&#x8a08;&#x306f;&#x3042;&#x308a;&#x307e;&#x305b;&#x3093;&#x3002;</p></div></section></div></section></main><script src=\"/app.js\" type=\"module\"></script></body></html>";
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
