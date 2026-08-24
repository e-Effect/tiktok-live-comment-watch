const storageKey = "tiktok-listener-admin-key";
const state = {
  key: normalizeAdminKey(localStorage.getItem(storageKey)), items: [], summary: {}, timer: null,
  selectedUserId: "", avatarObjectUrls: new Map(), attentionExpires: new Map(),
  seenEventIds: new Set(), realtimeLoaded: false, attentionExpiryTimer: null, detailData: null,
  searchController: null, realtimeItems: [], realtimeCursor: 0, realtimeInFlight: false,
  listenerPage: 0, listenerPageSize: 100, listenerTotal: 0,
  lastListenerSearch: null, pendingListenerSearch: null
};
const el = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
const number = new Intl.NumberFormat("ja-JP");
const dateTime = new Intl.DateTimeFormat("ja-JP", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" });
const historyDateTime = new Intl.DateTimeFormat("ja-JP", { year:"numeric", month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" });

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.key = normalizeAdminKey(el.adminKey.value);
  el.adminKey.value = state.key;
  if (!state.key) return;
  await authenticate();
});
el.logout.addEventListener("click", logout);
el.backfillAvatars.addEventListener("click", backfillAvatars);
el.compactAvatars.addEventListener("click", compactAvatars);
el.refresh.addEventListener("click", refreshAll);
el.exportCsv.addEventListener("click", exportCsv);
el.search.addEventListener("input", debounce(() => { state.listenerPage = 0; refreshListeners(); }, 300));
el.streamUsername.addEventListener("change", () => {
  state.listenerPage = 0;
  resetRealtimeFeed();
  refreshAll();
});
el.sort.addEventListener("change", () => { state.listenerPage = 0; refreshListeners(); });
el.listenerPrev.addEventListener("click", () => {
  if (state.listenerPage <= 0) return;
  state.listenerPage -= 1;
  refreshListeners();
});
el.listenerNext.addEventListener("click", () => {
  if ((state.listenerPage + 1) * state.listenerPageSize >= state.listenerTotal) return;
  state.listenerPage += 1;
  refreshListeners();
});
el.detailClose.addEventListener("click", closeDetail);
el.detailBackdrop.addEventListener("click", closeDetail);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDetail(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.key) {
    refreshRealtime();
    refreshRestoredSearch();
  }
});
window.addEventListener("pageshow", scheduleRestoredSearchChecks);

if (state.key) authenticate();

async function authenticate() {
  el.loginError.textContent = "";
  try {
    const response = await api("/api/listeners/auth");
    if (!response.ok) throw new Error((await response.json()).error || "管理キーが違います");
    localStorage.setItem(storageKey, state.key);
    el.loginPanel.hidden = true;
    el.app.hidden = false;
    el.connectionStatus.textContent = "データベース接続済み";
    el.connectionStatus.classList.remove("error");
    await refreshAll();
    scheduleRestoredSearchChecks();
    clearInterval(state.timer);
    state.timer = setInterval(refreshRealtime, 10000);
  } catch (error) {
    localStorage.removeItem(storageKey);
    state.key = "";
    el.app.hidden = true;
    el.loginPanel.hidden = false;
    el.adminKey.value = "";
    el.adminKey.focus();
    el.loginError.textContent = error.message || "管理キーを確認して、もう一度入力してください";
  }
}

function normalizeAdminKey(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").trim();
}

function logout() {
  clearInterval(state.timer);
  clearTimeout(state.attentionExpiryTimer);
  localStorage.removeItem(storageKey);
  state.key = "";
  el.app.hidden = true;
  el.loginPanel.hidden = false;
  el.adminKey.value = "";
}

async function refreshAll() {
  await Promise.all([refreshSummary(), refreshListeners(), refreshRealtime()]);
}

async function backfillAvatars() {
  const button = el.backfillAvatars;
  button.disabled = true;
  el.connectionStatus.textContent = "アイコンを取得中…";
  el.connectionStatus.classList.remove("error");
  try {
    const response = await api("/api/listeners/avatars/backfill", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({limit:10})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "アイコンを取得できませんでした");
    el.connectionStatus.textContent = result.requested
      ? `アイコン ${result.updated}人取得・${result.failed}人失敗`
      : "未取得アイコンはありません";
    await refreshAll();
  } catch (error) {
    showConnectionError(error);
  } finally {
    button.disabled = false;
  }
}

async function compactAvatars() {
  const button = el.compactAvatars;
  button.disabled = true;
  let after = "";
  let scanned = 0;
  let updated = 0;
  let savedBytes = 0;
  try {
    for (let batch = 0; batch < 1000; batch += 1) {
      el.connectionStatus.textContent = `アイコン軽量化中… ${number.format(scanned)}件確認`;
      const response = await api("/api/listeners/avatars/compact", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({limit:25,after})
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "アイコンを軽量化できませんでした");
      scanned += Number(result.scanned || 0);
      updated += Number(result.updated || 0);
      savedBytes += Number(result.savedBytes || 0);
      after = result.nextAfter || "";
      if (result.done || !result.scanned) break;
    }
    el.connectionStatus.textContent = `アイコン ${number.format(updated)}件軽量化・${(savedBytes / 1024 / 1024).toFixed(1)}MB削減`;
  } catch (error) {
    showConnectionError(error);
  } finally {
    button.disabled = false;
  }
}

async function refreshSummary(options = {}) {
  try {
    const response = await api(`/api/listeners/summary${params(options.fresh ? {fresh:"1"} : {})}`);
    if (!response.ok) throw new Error("集計を取得できません");
    state.summary = await response.json();
    const cards = [
      ["記録リスナー", state.summary.listeners], ["本日活動", state.summary.activeToday],
      ["リピーター", state.summary.returning], ["スーパーファン", state.summary.superFans],
      ["アイコン取得済み", state.summary.avatars],
      ["来訪回数", state.summary.visits], ["コメント", state.summary.comments],
      ["ギフト個数", state.summary.gifts], ["ギフトコイン", state.summary.coins, true], ["シェア", state.summary.shares]
    ];
    el.summary.innerHTML = cards.map(([label,value,highlight]) => `<article class="card summary-card ${highlight?"highlight":""}"><span>${label}</span><strong>${number.format(value||0)}</strong></article>`).join("");
  } catch (error) { showConnectionError(error); }
}

async function refreshListeners() {
  state.searchController?.abort();
  const controller = new AbortController();
  state.searchController = controller;
  try {
    const search = currentListenerSearch();
    state.pendingListenerSearch = search;
    el.listenerRows.setAttribute("aria-busy", "true");
    el.resultCount.textContent = search ? `「${search}」を検索中…` : "一覧を読み込み中…";
    const query = new URLSearchParams({
      search, sort:el.sort.value,
      direction:["first_seen","name"].includes(el.sort.value) ? "asc" : "desc",
      limit:String(state.listenerPageSize), offset:String(state.listenerPage * state.listenerPageSize)
    });
    const username = cleanUsername(); if (username) query.set("username",username);
    const response = await api(`/api/listeners?${query}`, {signal:controller.signal});
    if (!response.ok) throw new Error("一覧を取得できません");
    const data = await response.json(); state.items = data.items || [];
    state.lastListenerSearch = search;
    state.listenerTotal = Number(data.total || 0);
    const start = state.listenerTotal ? state.listenerPage * state.listenerPageSize + 1 : 0;
    const end = Math.min(state.listenerTotal, start + state.items.length - 1);
    el.resultCount.textContent = `${number.format(state.listenerTotal)}人中 ${number.format(start)}～${number.format(Math.max(start, end))}人`;
    el.listenerPage.textContent = `${number.format(state.listenerPage + 1)}ページ目`;
    el.listenerPrev.disabled = state.listenerPage <= 0;
    el.listenerNext.disabled = (state.listenerPage + 1) * state.listenerPageSize >= state.listenerTotal;
    el.emptyState.hidden = state.items.length > 0;
    renderListenerTable();
  } catch (error) {
    if (error?.name !== "AbortError") {
      el.resultCount.textContent = "検索を完了できませんでした";
      showConnectionError(error);
    }
  } finally {
    if (state.searchController === controller) {
      state.searchController = null;
      state.pendingListenerSearch = null;
      el.listenerRows.removeAttribute("aria-busy");
    }
  }
}

function normalizeListenerSearch(value) {
  return String(value || "").normalize("NFKC").trim().replace(/^@/, "");
}

function currentListenerSearch() {
  const search = normalizeListenerSearch(el.search.value);
  if (el.search.value !== search) el.search.value = search;
  return search;
}

function refreshRestoredSearch() {
  if (!state.key || el.app.hidden) return;
  const search = currentListenerSearch();
  if (!search || search === state.pendingListenerSearch || search === state.lastListenerSearch && state.items.length) return;
  state.listenerPage = 0;
  refreshListeners();
}

function scheduleRestoredSearchChecks() {
  [50, 250, 750, 1500, 3000].forEach((delay) => setTimeout(refreshRestoredSearch, delay));
}

async function refreshRealtime() {
  if (document.hidden || state.realtimeInFlight) return;
  state.realtimeInFlight = true;
  try {
    const extra = {limit:"80"};
    if (state.realtimeCursor > 0) extra.since = String(Math.max(0, state.realtimeCursor - 1));
    const response = await api(`/api/listeners/events${params(extra)}`);
    if (!response.ok) throw new Error("受信履歴を取得できません");
    const data = await response.json();
    const incoming = Array.isArray(data.items) ? data.items : [];
    trackAttentionEvents(incoming);
    const merged = new Map(state.realtimeItems.map((item) => [String(item.id || `${item.userId}:${item.type}:${item.at}`), item]));
    for (const item of incoming) merged.set(String(item.id || `${item.userId}:${item.type}:${item.at}`), item);
    state.realtimeItems = [...merged.values()]
      .sort((a, b) => eventTimestamp(b.at) - eventTimestamp(a.at))
      .slice(0, 80);
    state.realtimeCursor = Math.max(state.realtimeCursor, ...incoming.map((item) => eventTimestamp(item.at)), 0);
    el.liveEvents.innerHTML = state.realtimeItems.map(eventHtml).join("") || `<p class="empty">まだ受信データがありません。</p>`;
    renderListenerTable();
    el.connectionStatus.textContent = "リアルタイム更新中"; el.connectionStatus.classList.remove("error");
  } catch (error) { showConnectionError(error); }
  finally { state.realtimeInFlight = false; }
}

function resetRealtimeFeed() {
  state.realtimeItems = [];
  state.realtimeCursor = 0;
  state.realtimeLoaded = false;
  state.realtimeInFlight = false;
  state.seenEventIds.clear();
}

function eventTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowHtml(item, attentionActive = false) {
  const rawName = item.nickname || item.uniqueId || item.userId;
  const name = escapeHtml(rawName);
  const sub = item.uniqueId ? `@${escapeHtml(item.uniqueId)}` : escapeHtml(item.userId);
  return `<tr class="listener-row ${attentionActive?"attention-active":""}" data-user-id="${escapeAttr(item.userId)}"><td><div class="person">${avatar(item)}<div><strong>${name}${item.isSuperFan?'<span class="fan">スパファン</span>':''}${item.needsAttention?'<span class="attention-badge">要確認</span>':''}</strong><small>${sub}${attentionActive?'・<b class="attention-now">いま反応あり</b>':''}</small></div></div></td><td class="follow-status-cell">${followBadge(item.hostFollowStatus)}</td><td class="fan-cell"><input class="fan-toggle" type="checkbox" ${item.isSuperFan?"checked":""} aria-label="${escapeAttr(rawName)}をスーパーファンとして管理"></td><td class="attention-cell"><input class="attention-toggle" type="checkbox" ${item.needsAttention?"checked":""} aria-label="${escapeAttr(rawName)}を要確認として管理"></td><td>${number.format(item.visits||0)}</td><td>${number.format(item.comments||0)}</td><td>${number.format(item.gifts||0)}</td><td>${number.format(item.coins||0)}</td><td>${formatDate(item.lastSeenAt)}</td></tr>`;
}

function renderListenerTable() {
  const now = Date.now();
  for (const [userId, expiresAt] of state.attentionExpires) if (expiresAt <= now) state.attentionExpires.delete(userId);
  const rows = state.items.map((item, index) => ({ item, index, active:item.needsAttention && (state.attentionExpires.get(item.userId) || 0) > now }));
  rows.sort((a,b) => Number(b.active)-Number(a.active) || (b.active ? (state.attentionExpires.get(b.item.userId)||0)-(state.attentionExpires.get(a.item.userId)||0) : a.index-b.index));
  el.listenerRows.innerHTML = rows.map(({item,active}) => rowHtml(item,active)).join("");
  hydrateAvatars(el.listenerRows);
  el.listenerRows.querySelectorAll("tr[data-user-id]").forEach((row) => row.addEventListener("click", () => openDetail(row.dataset.userId)));
  el.listenerRows.querySelectorAll(".fan-cell,.attention-cell").forEach((cell) => cell.addEventListener("click", (event) => event.stopPropagation()));
  el.listenerRows.querySelectorAll(".fan-toggle").forEach((input) => input.addEventListener("change", () => setInlineSuperFan(input)));
  el.listenerRows.querySelectorAll(".attention-toggle").forEach((input) => input.addEventListener("change", () => setInlineAttention(input)));
  clearTimeout(state.attentionExpiryTimer);
  const nextExpiry = Math.min(...[...state.attentionExpires.values()].filter((value) => value > now));
  if (Number.isFinite(nextExpiry)) state.attentionExpiryTimer = setTimeout(renderListenerTable, Math.max(50, nextExpiry-now+50));
}

function trackAttentionEvents(items) {
  const now = Date.now();
  for (const item of items) {
    if (!item.userId) continue;
    const eventId = String(item.id || `${item.userId}:${item.type}:${item.at}`);
    if (state.seenEventIds.has(eventId)) continue;
    state.seenEventIds.add(eventId);
    const at = eventTimestamp(item.at);
    if (!state.realtimeLoaded) {
      if (at > now-30000) state.attentionExpires.set(item.userId, Math.max(state.attentionExpires.get(item.userId)||0, at+30000));
    } else {
      state.attentionExpires.set(item.userId, now+30000);
    }
  }
  state.realtimeLoaded = true;
  if (state.seenEventIds.size > 2000) state.seenEventIds = new Set([...state.seenEventIds].slice(-1000));
}

async function setInlineSuperFan(input) {
  const row = input.closest("tr[data-user-id]");
  const userId = row?.dataset.userId || "";
  const item = state.items.find((candidate) => candidate.userId === userId);
  if (!row || !item) return;
  const previous = Boolean(item.isSuperFan);
  input.disabled = true;
  try {
    const response = await api(`/api/listeners/${encodeURIComponent(userId)}`, {
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({isSuperFan:Boolean(input.checked)})
    });
    if (!response.ok) throw new Error("スーパーファン設定を保存できませんでした");
    const updated = await response.json();
    item.isSuperFan = Boolean(updated.isSuperFan);
    input.checked = item.isSuperFan;
    const name = row.querySelector(".person strong");
    name?.querySelector(".fan")?.remove();
    if (item.isSuperFan && name) name.insertAdjacentHTML("beforeend", '<span class="fan">スパファン</span>');
    await refreshSummary({fresh:true});
  } catch (error) {
    input.checked = previous;
    showConnectionError(error);
  } finally {
    input.disabled = false;
  }
}

async function setInlineAttention(input) {
  const row = input.closest("tr[data-user-id]");
  const userId = row?.dataset.userId || "";
  const item = state.items.find((candidate) => candidate.userId === userId);
  if (!row || !item) return;
  const previous = Boolean(item.needsAttention);
  input.disabled = true;
  try {
    const response = await api(`/api/listeners/${encodeURIComponent(userId)}`, {
      method:"PATCH", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({needsAttention:Boolean(input.checked)})
    });
    if (!response.ok) throw new Error("要確認設定を保存できませんでした");
    const updated = await response.json();
    item.needsAttention = Boolean(updated.needsAttention);
    renderListenerTable();
  } catch (error) {
    input.checked = previous;
    showConnectionError(error);
  } finally {
    input.disabled = false;
  }
}

function eventHtml(item) {
  const label = ({comment:"コメント",gift:"ギフト",share:"シェア",follow:"フォロー",join:"入室",like:"いいね",subscribe:"サブスク"})[item.type] || item.type;
  const text = item.type === "comment" ? item.text : item.type === "gift" ? `${item.giftName || "ギフト"} × ${number.format(item.count||1)}（${number.format(item.coins||0)}コイン）` : label;
  return `<div class="event ${escapeAttr(item.type)}"><span class="event-type">${escapeHtml(label)}</span><div><strong>${escapeHtml(item.nickname||item.uniqueId||item.userId)}</strong><p>${escapeHtml(text||"")}</p></div><time>${formatDate(item.at)}</time></div>`;
}

async function openDetail(userId) {
  state.selectedUserId = userId;
  el.detailBackdrop.hidden = false; el.detailPanel.classList.add("open"); el.detailPanel.setAttribute("aria-hidden","false");
  el.detailContent.innerHTML = `<p class="empty">読み込み中…</p>`;
  try {
    const [response, commentsResponse, visitsResponse] = await Promise.all([
      api(`/api/listeners/${encodeURIComponent(userId)}${params()}`),
      api(listenerHistoryUrl(userId,"comments",0)),
      api(listenerHistoryUrl(userId,"visits",0))
    ]);
    if (!response.ok || !commentsResponse.ok || !visitsResponse.ok) throw new Error("詳細を取得できません");
    state.detailData = {
      ...(await response.json()),
      commentHistory:await commentsResponse.json(),
      visitHistory:await visitsResponse.json()
    };
    renderDetail(state.detailData);
  } catch (error) { el.detailContent.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
}

function renderDetail(data) {
  const item = data.listener;
  const totals = (data.stats||[]).reduce((a,s)=>({visits:a.visits+s.visitCount,comments:a.comments+s.commentCount,gifts:a.gifts+s.giftCount,coins:a.coins+s.giftCoins}),{visits:0,comments:0,gifts:0,coins:0});
  const stampTotal = (data.stamps||[]).reduce((sum, stamp)=>sum+Number(stamp.quantity||1),0);
  const receiptTotal = (data.receiptPrints||[]).length;
  el.detailContent.innerHTML = `
    <div class="detail-hero">${avatar(item)}<div><h2>${escapeHtml(item.nickname||item.uniqueId||item.userId)}</h2><p>${item.uniqueId?`@${escapeHtml(item.uniqueId)}`:""}</p><p>ユーザーID: ${escapeHtml(item.userId)}</p></div></div>
    <div class="detail-metrics">${metric("来訪",totals.visits)}${metric("コメント",totals.comments)}${metric("ギフト個数",totals.gifts)}${metric("コイン",totals.coins)}${metric("スタンプ",stampTotal)}${metric("印刷",receiptTotal)}</div>
    <section class="detail-section"><h3>TikTokプロフィール</h3><div class="profile-facts"><div class="profile-fact"><span>あなたをフォロー</span><strong>${followBadge(item.hostFollowStatus)}</strong><small>${item.hostFollowStatusUpdatedAt?`最終確認 ${escapeHtml(formatHistoryDate(item.hostFollowStatusUpdatedAt))}`:"まだ確認できていません"}</small></div><div class="profile-fact"><span>本人のフォロー数</span><strong>${profileCount(item.followingCount)}</strong></div><div class="profile-fact"><span>本人のフォロワー数</span><strong>${profileCount(item.followerCount)}</strong></div><div class="profile-fact"><span>人数の更新</span><strong class="profile-updated">${item.profileCountsUpdatedAt?escapeHtml(formatHistoryDate(item.profileCountsUpdatedAt)):"未取得"}</strong></div></div><p class="profile-note">TikTokから最後に受信できたプロフィール情報です。未確認は未フォローという意味ではありません。</p></section>
    <section class="detail-section"><h3>管理情報</h3><form id="detailForm" class="detail-form"><label class="check"><input id="detailSuperFan" type="checkbox" ${item.isSuperFan?"checked":""}> スーパーファンとして管理</label><label class="check attention-check"><input id="detailNeedsAttention" type="checkbox" ${item.needsAttention?"checked":""}> 要確認（配信中に反応したら30秒間、赤く上部表示）</label><label>タグ（カンマ区切り）<input id="detailTags" value="${escapeAttr((item.tags||[]).join(", "))}"></label><label>メモ<textarea id="detailNotes">${escapeHtml(item.notes||"")}</textarea></label><button class="detail-save" type="submit">管理情報を保存</button><p id="detailSaveStatus"></p></form></section>
    ${historySection("visits",data.visitHistory)}
    <section class="detail-section"><h3>スタンプカード履歴</h3><div>${(data.stamps||[]).map(s=>`<div class="history-item"><time>${formatDate(s.stampedAt)}</time><strong>${escapeHtml(stampLabel(s.stampType))} × ${number.format(s.quantity||1)}</strong>${s.note?`<p>${escapeHtml(s.note)}</p>`:""}</div>`).join("")||'<p class="empty">スタンプ履歴なし</p>'}</div></section>
    <section class="detail-section"><h3>レシート印刷履歴</h3><div>${(data.receiptPrints||[]).map(p=>`<div class="history-item"><time>${formatDate(p.printedAt)}</time><strong>${escapeHtml(p.giftName||"ギフト")} × ${number.format(p.count||1)}</strong><p>${number.format(p.coins||0)}コイン${p.templateId?`・テンプレート ${escapeHtml(p.templateId)}`:""}</p></div>`).join("")||'<p class="empty">レシート印刷履歴なし</p>'}</div></section>
    <section class="detail-section"><h3>ギフト内訳</h3><div class="gift-grid">${(data.gifts||[]).map(g=>`<div class="gift-item"><strong>${escapeHtml(g.giftName||g.giftId||"ギフト")}</strong><small>${number.format(g.count||0)}個・${number.format(g.coins||0)}コイン</small></div>`).join("")||'<p class="empty">ギフト履歴なし</p>'}</div></section>
    ${historySection("comments",data.commentHistory)}
    <section class="detail-section"><h3>過去に確認した名前</h3><div>${(data.aliases||[]).map(a=>`<div class="history-item"><strong>${escapeHtml(a.nickname||"")}</strong> <small>${a.uniqueId?`@${escapeHtml(a.uniqueId)}`:""}</small><p>${formatDate(a.firstSeenAt)} ～ ${formatDate(a.lastSeenAt)}</p></div>`).join("")||'<p class="empty">別名履歴なし</p>'}</div></section>`;
  hydrateAvatars(el.detailContent);
  document.getElementById("detailForm")?.addEventListener("submit", saveDetail);
  el.detailContent.querySelectorAll("[data-load-history]").forEach((button)=>button.addEventListener("click",()=>loadMoreHistory(button.dataset.loadHistory)));
}

function historySection(kind, history = {}) {
  const items = history.items || [];
  const total = Number(history.total || 0);
  const isVisits = kind === "visits";
  const rows = isVisits
    ? items.map((visit)=>`<div class="history-item visit-day"><strong>${escapeHtml(formatVisitDay(visit.day))}</strong><p>初回検知 ${escapeHtml(formatTime(visit.firstSeenAt))}・最終検知 ${escapeHtml(formatTime(visit.lastSeenAt))}・配信 ${number.format(visit.liveCount||1)}回</p>${visit.streamUsernames?.length>1?`<small>${visit.streamUsernames.map((name)=>`@${escapeHtml(name)}`).join(" / ")}</small>`:""}</div>`).join("")
    : items.map((comment)=>`<div class="history-item"><time>${formatHistoryDate(comment.at)}${comment.streamUsername?`・@${escapeHtml(comment.streamUsername)}`:""}</time><p>${escapeHtml(comment.text||"")}</p></div>`).join("");
  const remaining = Math.max(0,total-items.length);
  return `<section class="detail-section history-section"><h3>${isVisits?"入室した全ての日":"これまでの全コメント"} <span>${number.format(total)}件</span></h3><div>${rows||`<p class="empty">${isVisits?"来訪日":"コメント"}履歴なし</p>`}</div>${remaining?`<button class="history-more" type="button" data-load-history="${kind}">続きを表示（残り${number.format(remaining)}件）</button>`:""}</section>`;
}

function listenerHistoryUrl(userId, kind, offset) {
  const query = new URLSearchParams({kind,limit:"200",offset:String(offset||0)});
  const username = cleanUsername(); if (username) query.set("username",username);
  return `/api/listeners/${encodeURIComponent(userId)}/history?${query}`;
}

async function loadMoreHistory(kind) {
  if (!state.selectedUserId || !state.detailData) return;
  const key = kind === "visits" ? "visitHistory" : "commentHistory";
  const current = state.detailData[key] || {items:[],total:0};
  const button = el.detailContent.querySelector(`[data-load-history="${kind}"]`);
  if (button) { button.disabled = true; button.textContent = "読み込み中…"; }
  try {
    const response = await api(listenerHistoryUrl(state.selectedUserId,kind,current.items.length));
    if (!response.ok) throw new Error("続きを取得できません");
    const next = await response.json();
    state.detailData[key] = {items:[...current.items,...(next.items||[])],total:Number(next.total||current.total||0)};
    const scrollTop = el.detailPanel.scrollTop;
    renderDetail(state.detailData);
    el.detailPanel.scrollTop = scrollTop;
  } catch (error) { showConnectionError(error); if (button) button.disabled = false; }
}

function stampLabel(type){return({visit:"来店スタンプ",action:"応援スタンプ",legacy:"過去分スタンプ",standard:"スタンプ"})[type]||type||"スタンプ"}

async function saveDetail(event) {
  event.preventDefault();
  const superFan = document.getElementById("detailSuperFan");
  const needsAttention = document.getElementById("detailNeedsAttention");
  const notes = document.getElementById("detailNotes");
  const tags = document.getElementById("detailTags");
  const saveStatus = document.getElementById("detailSaveStatus");
  const payload = { isSuperFan:Boolean(superFan?.checked), needsAttention:Boolean(needsAttention?.checked), notes:notes?.value || "", tags:(tags?.value || "").split(",").map(v=>v.trim()).filter(Boolean) };
  const response = await api(`/api/listeners/${encodeURIComponent(state.selectedUserId)}`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  if (saveStatus) saveStatus.textContent = response.ok ? "保存しました" : "保存できませんでした";
  if (response.ok) refreshAll();
}

function closeDetail(){el.detailBackdrop.hidden=true;el.detailPanel.classList.remove("open");el.detailPanel.setAttribute("aria-hidden","true");state.selectedUserId="";state.detailData=null}
function metric(label,value){return `<div class="metric"><span>${label}</span><strong>${number.format(value||0)}</strong></div>`}
function followBadge(status){const normalized=status==="following"?"following":status==="not_following"?"not-following":"unknown";const label=normalized==="following"?"フォロー中":normalized==="not-following"?"未フォロー":"未確認";return `<span class="follow-badge ${normalized}">${label}</span>`}
function profileCount(value){return value===null||value===undefined?'<span class="profile-missing">未取得</span>':number.format(value)}
function avatar(item){
  const first=Array.from(item.nickname||item.uniqueId||"?")[0]||"?";
  const cached=item.avatarCached?` data-avatar-user="${escapeAttr(item.userId)}"`:"";
  const image=!item.avatarCached&&item.avatarUrl?`<img class="avatar-image" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" src="${escapeAttr(item.avatarUrl)}" alt="" referrerpolicy="no-referrer">`:"";
  return `<span class="avatar avatar-fallback avatar-shell" style="position:relative;overflow:hidden;flex:0 0 auto"${cached}>${escapeHtml(first)}${image}</span>`;
}
async function hydrateAvatars(root){
  root.querySelectorAll(".avatar-image").forEach((img)=>img.addEventListener("error",()=>img.remove(),{once:true}));
  for(const shell of root.querySelectorAll("[data-avatar-user]")){
    const userId=shell.dataset.avatarUser;
    try{
      let objectUrl=state.avatarObjectUrls.get(userId);
      if(!objectUrl){const response=await api(`/api/listeners/${encodeURIComponent(userId)}/avatar`);if(!response.ok)continue;objectUrl=URL.createObjectURL(await response.blob());state.avatarObjectUrls.set(userId,objectUrl)}
      shell.querySelector("img")?.remove();
      const img=document.createElement("img");img.className="avatar-image";img.style.cssText="position:absolute;inset:0;width:100%;height:100%;object-fit:cover";img.alt="";img.src=objectUrl;img.addEventListener("error",()=>img.remove(),{once:true});shell.appendChild(img);
    }catch{}
  }
}
function cleanUsername(){return el.streamUsername.value.trim().replace(/^@/,"")}
function params(extra={}){const q=new URLSearchParams(extra);const u=cleanUsername();if(u)q.set("username",u);const s=q.toString();return s?`?${s}`:""}
function api(path,options={}){return fetch(path,{...options,cache:"no-store",headers:{Authorization:`Bearer ${state.key}`,...(options.headers||{})}})}
function showConnectionError(error){el.connectionStatus.textContent=error.message;el.connectionStatus.classList.add("error")}
function formatDate(value){if(!value)return"-";const d=new Date(value);return Number.isNaN(d.getTime())?"-":dateTime.format(d)}
function formatHistoryDate(value){if(!value)return"-";const d=new Date(value);return Number.isNaN(d.getTime())?"-":historyDateTime.format(d)}
function formatTime(value){if(!value)return"-";const d=new Date(value);return Number.isNaN(d.getTime())?"-":new Intl.DateTimeFormat("ja-JP",{hour:"2-digit",minute:"2-digit"}).format(d)}
function formatVisitDay(value){const match=String(value||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!match)return String(value||"-");const date=new Date(`${value}T12:00:00+09:00`);const weekday=new Intl.DateTimeFormat("ja-JP",{weekday:"short"}).format(date);return `${Number(match[1])}/${Number(match[2])}/${Number(match[3])}（${weekday}）`}
function debounce(fn,ms){let id;return(...args)=>{clearTimeout(id);id=setTimeout(()=>fn(...args),ms)}}
function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[c])}
function escapeAttr(value){return escapeHtml(value).replace(/`/g,"&#096;")}

async function exportCsv(){
  const button=el.exportCsv;button.disabled=true;el.connectionStatus.textContent="全件CSVを作成中…";
  try{
    const query=new URLSearchParams();const username=cleanUsername();if(username)query.set("username",username);const search=currentListenerSearch();if(search)query.set("search",search);
    const response=await api(`/api/listeners/export.csv?${query}`);if(!response.ok)throw new Error("CSVを作成できませんでした");
    const url=URL.createObjectURL(await response.blob());const a=document.createElement("a");a.href=url;a.download=`listeners-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);
    el.connectionStatus.textContent="全件CSVを保存しました";el.connectionStatus.classList.remove("error");
  }catch(error){showConnectionError(error)}finally{button.disabled=false}
}
