const storageKey = "tiktok-listener-admin-key";
const state = { key: localStorage.getItem(storageKey) || "", items: [], summary: {}, timer: null, selectedUserId: "" };
const el = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
const number = new Intl.NumberFormat("ja-JP");
const dateTime = new Intl.DateTimeFormat("ja-JP", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" });

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.key = el.adminKey.value.trim();
  if (!state.key) return;
  await authenticate();
});
el.logout.addEventListener("click", logout);
el.refresh.addEventListener("click", refreshAll);
el.exportCsv.addEventListener("click", exportCsv);
el.search.addEventListener("input", debounce(refreshListeners, 300));
el.streamUsername.addEventListener("change", refreshAll);
el.sort.addEventListener("change", refreshListeners);
el.detailClose.addEventListener("click", closeDetail);
el.detailBackdrop.addEventListener("click", closeDetail);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDetail(); });

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
    clearInterval(state.timer);
    state.timer = setInterval(refreshRealtime, 10000);
  } catch (error) {
    el.loginError.textContent = error.message;
  }
}

function logout() {
  clearInterval(state.timer);
  localStorage.removeItem(storageKey);
  state.key = "";
  el.app.hidden = true;
  el.loginPanel.hidden = false;
  el.adminKey.value = "";
}

async function refreshAll() {
  await Promise.all([refreshSummary(), refreshListeners(), refreshRealtime()]);
}

async function refreshSummary() {
  try {
    const response = await api(`/api/listeners/summary${params()}`);
    if (!response.ok) throw new Error("集計を取得できません");
    state.summary = await response.json();
    const cards = [
      ["記録リスナー", state.summary.listeners], ["本日活動", state.summary.activeToday],
      ["リピーター", state.summary.returning], ["スーパーファン", state.summary.superFans],
      ["来訪回数", state.summary.visits], ["コメント", state.summary.comments],
      ["ギフト個数", state.summary.gifts], ["ギフトコイン", state.summary.coins, true], ["シェア", state.summary.shares]
    ];
    el.summary.innerHTML = cards.map(([label,value,highlight]) => `<article class="card summary-card ${highlight?"highlight":""}"><span>${label}</span><strong>${number.format(value||0)}</strong></article>`).join("");
  } catch (error) { showConnectionError(error); }
}

async function refreshListeners() {
  try {
    const query = new URLSearchParams({ search:el.search.value.trim(), sort:el.sort.value, limit:"250" });
    const username = cleanUsername(); if (username) query.set("username",username);
    const response = await api(`/api/listeners?${query}`);
    if (!response.ok) throw new Error("一覧を取得できません");
    const data = await response.json(); state.items = data.items || [];
    el.resultCount.textContent = `${number.format(data.total || 0)}人`;
    el.emptyState.hidden = state.items.length > 0;
    el.listenerRows.innerHTML = state.items.map(rowHtml).join("");
    el.listenerRows.querySelectorAll("tr[data-user-id]").forEach((row) => row.addEventListener("click", () => openDetail(row.dataset.userId)));
  } catch (error) { showConnectionError(error); }
}

async function refreshRealtime() {
  try {
    const response = await api(`/api/listeners/events${params({limit:"80"})}`);
    if (!response.ok) throw new Error("受信履歴を取得できません");
    const data = await response.json();
    el.liveEvents.innerHTML = (data.items || []).map(eventHtml).join("") || `<p class="empty">まだ受信データがありません。</p>`;
    el.connectionStatus.textContent = "リアルタイム更新中"; el.connectionStatus.classList.remove("error");
  } catch (error) { showConnectionError(error); }
}

function rowHtml(item) {
  const name = escapeHtml(item.nickname || item.uniqueId || item.userId);
  const sub = item.uniqueId ? `@${escapeHtml(item.uniqueId)}` : escapeHtml(item.userId);
  return `<tr class="listener-row" data-user-id="${escapeAttr(item.userId)}"><td><div class="person">${avatar(item)}<div><strong>${name}${item.isSuperFan?'<span class="fan">スパファン</span>':''}</strong><small>${sub}</small></div></div></td><td>${number.format(item.visits||0)}</td><td>${number.format(item.comments||0)}</td><td>${number.format(item.gifts||0)}</td><td>${number.format(item.coins||0)}</td><td>${formatDate(item.lastSeenAt)}</td></tr>`;
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
    const response = await api(`/api/listeners/${encodeURIComponent(userId)}${params()}`);
    if (!response.ok) throw new Error("詳細を取得できません");
    renderDetail(await response.json());
  } catch (error) { el.detailContent.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
}

function renderDetail(data) {
  const item = data.listener;
  const totals = (data.stats||[]).reduce((a,s)=>({visits:a.visits+s.visitCount,comments:a.comments+s.commentCount,gifts:a.gifts+s.giftCount,coins:a.coins+s.giftCoins}),{visits:0,comments:0,gifts:0,coins:0});
  el.detailContent.innerHTML = `
    <div class="detail-hero">${avatar(item)}<div><h2>${escapeHtml(item.nickname||item.uniqueId||item.userId)}</h2><p>${item.uniqueId?`@${escapeHtml(item.uniqueId)}`:""}</p><p>ユーザーID: ${escapeHtml(item.userId)}</p></div></div>
    <div class="detail-metrics">${metric("来訪",totals.visits)}${metric("コメント",totals.comments)}${metric("ギフト個数",totals.gifts)}${metric("コイン",totals.coins)}</div>
    <section class="detail-section"><h3>管理情報</h3><form id="detailForm" class="detail-form"><label class="check"><input id="detailSuperFan" type="checkbox" ${item.isSuperFan?"checked":""}> スーパーファンとして管理</label><label>タグ（カンマ区切り）<input id="detailTags" value="${escapeAttr((item.tags||[]).join(", "))}"></label><label>メモ<textarea id="detailNotes">${escapeHtml(item.notes||"")}</textarea></label><button class="detail-save" type="submit">管理情報を保存</button><p id="detailSaveStatus"></p></form></section>
    <section class="detail-section"><h3>ギフト内訳</h3><div class="gift-grid">${(data.gifts||[]).map(g=>`<div class="gift-item"><strong>${escapeHtml(g.giftName||g.giftId||"ギフト")}</strong><small>${number.format(g.count||0)}個・${number.format(g.coins||0)}コイン</small></div>`).join("")||'<p class="empty">ギフト履歴なし</p>'}</div></section>
    <section class="detail-section"><h3>最近のコメント</h3><div>${(data.comments||[]).map(c=>`<div class="history-item"><time>${formatDate(c.at)}</time><p>${escapeHtml(c.text||"")}</p></div>`).join("")||'<p class="empty">コメント履歴なし</p>'}</div></section>
    <section class="detail-section"><h3>過去に確認した名前</h3><div>${(data.aliases||[]).map(a=>`<div class="history-item"><strong>${escapeHtml(a.nickname||"")}</strong> <small>${a.uniqueId?`@${escapeHtml(a.uniqueId)}`:""}</small><p>${formatDate(a.firstSeenAt)} ～ ${formatDate(a.lastSeenAt)}</p></div>`).join("")||'<p class="empty">別名履歴なし</p>'}</div></section>`;
  el.detailForm.addEventListener("submit", saveDetail);
}

async function saveDetail(event) {
  event.preventDefault();
  const payload = { isSuperFan:el.detailSuperFan.checked, notes:el.detailNotes.value, tags:el.detailTags.value.split(",").map(v=>v.trim()).filter(Boolean) };
  const response = await api(`/api/listeners/${encodeURIComponent(state.selectedUserId)}`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  el.detailSaveStatus.textContent = response.ok ? "保存しました" : "保存できませんでした";
  if (response.ok) refreshAll();
}

function closeDetail(){el.detailBackdrop.hidden=true;el.detailPanel.classList.remove("open");el.detailPanel.setAttribute("aria-hidden","true");state.selectedUserId=""}
function metric(label,value){return `<div class="metric"><span>${label}</span><strong>${number.format(value||0)}</strong></div>`}
function avatar(item){return item.avatarUrl?`<img class="avatar" src="${escapeAttr(item.avatarUrl)}" alt="" referrerpolicy="no-referrer">`:`<span class="avatar avatar-fallback">${escapeHtml((item.nickname||item.uniqueId||"?").slice(0,1))}</span>`}
function cleanUsername(){return el.streamUsername.value.trim().replace(/^@/,"")}
function params(extra={}){const q=new URLSearchParams(extra);const u=cleanUsername();if(u)q.set("username",u);const s=q.toString();return s?`?${s}`:""}
function api(path,options={}){return fetch(path,{...options,cache:"no-store",headers:{Authorization:`Bearer ${state.key}`,...(options.headers||{})}})}
function showConnectionError(error){el.connectionStatus.textContent=error.message;el.connectionStatus.classList.add("error")}
function formatDate(value){if(!value)return"-";const d=new Date(value);return Number.isNaN(d.getTime())?"-":dateTime.format(d)}
function debounce(fn,ms){let id;return(...args)=>{clearTimeout(id);id=setTimeout(()=>fn(...args),ms)}}
function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[c])}
function escapeAttr(value){return escapeHtml(value).replace(/`/g,"&#096;")}

function exportCsv(){
  const rows=[["ユーザーID","TikTok ID","表示名","来訪回数","コメント数","ギフト個数","ギフトコイン","シェア回数","スーパーファン","初回来訪","最終来訪","タグ","メモ"]];
  state.items.forEach(i=>rows.push([i.userId,i.uniqueId,i.nickname,i.visits,i.comments,i.gifts,i.coins,i.shares,i.isSuperFan?"はい":"",new Date(i.firstSeenAt||0).toISOString(),new Date(i.lastSeenAt||0).toISOString(),(i.tags||[]).join(" / "),i.notes||""]));
  const csv="\uFEFF"+rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download=`listeners-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);
}
