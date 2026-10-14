const el = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((node) => [node.id, node]),
);
const storageKey = "tiktok-listener-admin-key";
const initialParams = new URLSearchParams(location.search);
const state = {
  key: localStorage.getItem(storageKey) || "",
  tier: initialParams.get("tier") === "card" ? "card" : "chip",
  report: null,
  loadId: 0,
  saving: false,
  selected: null,
  catalog: new Map(),
};
const number = new Intl.NumberFormat("ja-JP");
const dayFormat = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
  timeZone: "Asia/Tokyo",
});
const today = () =>
  new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const dayLabel = (day) => dayFormat.format(new Date(`${day}T00:00:00+09:00`));
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const safeImage = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};
const icons = () => window.lucide?.createIcons();
const showError = (message) => {
  el.error.textContent = message;
  el.error.hidden = !message;
};

el.day.value = /^\d{4}-\d{2}-\d{2}$/.test(initialParams.get("day") || "")
  ? initialParams.get("day")
  : today();
if (!el.day.value) el.day.value = today();
el.day.max = today();
el.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.key = el.adminKey.value.normalize("NFKC").replace(/\s+/g, "");
  connect();
});
el.day.addEventListener("change", loadReport);
el.stream.addEventListener("change", () => {
  localStorage.setItem("tiktok-rewards-stream", el.stream.value);
  loadReport();
});
el.today.addEventListener("click", () => {
  el.day.value = today();
  loadReport();
});
el.prevDay.addEventListener("click", () => changeDay(-1));
el.nextDay.addEventListener("click", () => changeDay(1));
el.refresh.addEventListener("click", loadReport);
el.search.addEventListener("input", render);
el.pendingOnly.addEventListener("change", render);
for (const button of [el.chipTab, el.cardTab]) {
  button.addEventListener("click", () => {
    state.tier = button.dataset.tier;
    rememberView();
    render();
  });
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target =
      event.key === "Home"
        ? el.chipTab
        : event.key === "End"
          ? el.cardTab
          : button === el.chipTab
            ? el.cardTab
            : el.chipTab;
    target.click();
    target.focus();
  });
}
el.rows.addEventListener("change", (event) => {
  const box = event.target.closest("[data-shipped]");
  if (box) save(box.dataset.user, box.dataset.shipped, box.checked);
});
el.rows.addEventListener("click", (event) => {
  const button = event.target.closest("[data-design]");
  if (button) openDesign(button.dataset.design);
});
el.closeDesign.addEventListener("click", () => el.designDialog.close());
el.designDialog.addEventListener("click", (event) => {
  if (event.target === el.designDialog) {
    const r = el.designDialog.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      el.designDialog.close();
  }
});
el.clearDesign.addEventListener("click", () => {
  el.giftOptions.querySelectorAll("input").forEach((input) => {
    input.checked = false;
  });
});
el.saveDesign.addEventListener("click", async () => {
  const key = el.giftOptions.querySelector("input:checked")?.value || "";
  if (await save(state.selected, "selectedGiftKey", key))
    el.designDialog.close();
});
document.addEventListener(
  "error",
  (event) => {
    if (event.target instanceof HTMLImageElement) {
      event.target.hidden = true;
      event.target.parentElement
        .querySelector(".image-fallback")
        ?.removeAttribute("hidden");
    }
  },
  true,
);
icons();
if (state.key) connect();
else el.loginPanel.hidden = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: { Authorization: `Bearer ${state.key}`, ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "読み込みに失敗しました");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function connect() {
  showError("");
  el.notice.textContent = "接続中…";
  el.loginForm.querySelector("button").disabled = true;
  try {
    const streams = await api("/api/gift-rewards/streams");
    localStorage.setItem(storageKey, state.key);
    el.loginPanel.hidden = true;
    el.app.hidden = false;
    el.adminKey.value = "";
    const preferred = (
      initialParams.get("username") ||
      localStorage.getItem("tiktok-rewards-stream") ||
      localStorage.getItem("tiktok-live-fixed-account") ||
      "mentalist_k"
    )
      .replace(/^@/, "")
      .toLowerCase();
    el.stream.innerHTML = streams.items
      .map(
        (item) =>
          `<option value="${escape(item.username)}">@${escape(item.username)}</option>`,
      )
      .join("");
    if (streams.items.some((item) => item.username === preferred))
      el.stream.value = preferred;
    fetch("/receipt-gift-catalog.json")
      .then((r) => r.json())
      .then((items) => {
        state.catalog = new Map(items.map((gift) => [String(gift.id), gift]));
        render();
      })
      .catch(() => {});
    await loadReport();
  } catch (error) {
    showError(error.message);
    el.loginPanel.hidden = false;
    el.app.hidden = true;
  } finally {
    el.notice.textContent = "";
    el.loginForm.querySelector("button").disabled = false;
  }
}

function changeDay(offset) {
  if (state.saving) return;
  const date = new Date(`${el.day.value || today()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  el.day.value = date.toISOString().slice(0, 10);
  loadReport();
}

function rememberView() {
  const url = new URL(location.href);
  url.searchParams.set("day", el.day.value);
  url.searchParams.set("username", el.stream.value);
  url.searchParams.set("tier", state.tier);
  history.replaceState(null, "", url);
}

async function loadReport() {
  if (state.saving) return;
  const id = ++state.loadId;
  showError("");
  state.report = null;
  el.designDialog.close();
  el.rows.replaceChildren();
  el.chipCount.textContent = el.cardCount.textContent = "—";
  el.progress.textContent = "";
  el.listTitle.textContent = "";
  el.updatedAt.textContent = "";
  el.empty.hidden = false;
  el.empty.textContent = "読み込み中…";
  el.results.setAttribute("aria-busy", "true");
  el.nextDay.disabled = el.day.value >= today();
  el.dayTitle.textContent = el.day.value
    ? dayLabel(el.day.value)
    : "日付を選択";
  try {
    if (!el.stream.value) {
      el.empty.textContent = "保存済みの配信がありません";
      return;
    }
    if (!el.day.value) throw new Error("集計日を選択してください");
    const report = await api(
      `/api/gift-rewards?${new URLSearchParams({ day: el.day.value, username: el.stream.value })}`,
    );
    if (id !== state.loadId) return;
    state.report = report;
    rememberView();
    render();
    el.updatedAt.textContent = `更新 ${new Date().toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" })}`;
    if (report.unknownCoinEvents || report.unidentifiedEvents)
      showError(
        `要確認：金額不明 ${report.unknownCoinEvents}件・送信者不明 ${report.unidentifiedEvents}件。合計や対象者に不足がある可能性があります。`,
      );
  } catch (error) {
    if (id !== state.loadId) return;
    showError(error.message);
    el.empty.textContent = "取得できませんでした";
    if (error.status === 401) {
      el.loginPanel.hidden = false;
      el.app.hidden = true;
    }
  } finally {
    if (id === state.loadId) el.results.setAttribute("aria-busy", "false");
  }
}

function giftImage(gift) {
  return (
    safeImage(gift.imageUrl) ||
    safeImage(state.catalog.get(String(gift.id))?.imageUrl)
  );
}

function render() {
  const report = state.report;
  const card = state.tier === "card";
  for (const tab of [el.chipTab, el.cardTab]) {
    const selected = tab.dataset.tier === state.tier;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  el.results.setAttribute("aria-labelledby", card ? "cardTab" : "chipTab");
  el.designHeading.hidden = !card;
  if (!report) return;
  el.chipCount.textContent = report.chipCount;
  el.cardCount.textContent = report.cardCount;
  el.listTitle.textContent = `${dayLabel(report.day)}の${card ? "10,000" : "5,000"}達成`;
  const field = card ? "cardShipped" : "chipShipped";
  const eligible = report.items.filter(
    (item) => item.coins >= (card ? 10000 : 5000),
  );
  const sent = eligible.filter((item) => item[field]).length;
  const query = el.search.value.trim().toLowerCase();
  const items = eligible.filter(
    (item) =>
      (!el.pendingOnly.checked || !item[field]) &&
      `${item.nickname} ${item.uniqueId} ${item.userId}`
        .toLowerCase()
        .includes(query),
  );
  el.progress.textContent = `${eligible.length}人・発送済み ${sent} / ${eligible.length}`;
  el.empty.hidden = items.length > 0;
  el.empty.textContent = eligible.length
    ? "条件に一致する対象者はいません"
    : "この日の達成者はいません";
  el.rows.innerHTML = items
    .map((item) => {
      const gift = item.gifts.find((gift) => gift.key === item.selectedGiftKey);
      const image = gift && giftImage(gift);
      return `<tr><td><div class="person"><span class="person-mark" aria-hidden="true">${escape(Array.from(item.nickname || "?")[0])}</span><div><strong>${escape(item.nickname || item.userId)}</strong><small>${escape(item.uniqueId ? "@" + item.uniqueId : item.userId)}</small></div></div></td>
      <td class="amount"><span class="coin-value">${number.format(item.coins)}</span></td>
      ${card ? `<td><button type="button" class="design-button" data-design="${escape(item.userId)}" aria-label="${escape(item.nickname)}のカードデザイン" ${state.saving ? "disabled" : ""}>${image ? `<img src="${escape(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<i data-lucide="image"></i>'}<span>${escape(gift?.name || (gift ? "名称不明" : "未選択"))}<small> · ${item.gifts.length}種類</small></span></button></td>` : ""}
      <td><label class="shipment"><input type="checkbox" data-user="${escape(item.userId)}" data-shipped="${field}" aria-label="${escape(item.nickname)}の${card ? "カード" : "チップ"}発送済み" ${item[field] ? "checked" : ""} ${state.saving ? "disabled" : ""}><span>${item[field] ? "発送済み" : "未発送"}</span></label></td></tr>`;
    })
    .join("");
  icons();
}

function openDesign(userId) {
  const item = state.report?.items.find((item) => item.userId === userId);
  if (!item || state.saving) return;
  state.selected = userId;
  el.designDate.textContent = dayLabel(state.report.day);
  el.designPerson.textContent = `${item.nickname} · ${number.format(item.coins)}コイン · ${item.gifts.length}種類`;
  el.giftOptions.innerHTML = item.gifts
    .map((gift) => {
      const image = giftImage(gift);
      return `<label class="gift-choice"><input type="radio" name="gift" value="${escape(gift.key)}" ${item.selectedGiftKey === gift.key ? "checked" : ""}><span class="gift-art">${image ? `<img src="${escape(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span class="image-fallback" ${image ? "hidden" : ""}><i data-lucide="gift"></i></span></span><strong>${escape(gift.name || "名称不明")}</strong><small>${number.format(gift.quantity)}個 · ${number.format(gift.coins)}コイン</small></label>`;
    })
    .join("");
  icons();
  el.designDialog.showModal();
}

async function save(userId, field, value) {
  if (state.saving) return false;
  const report = state.report;
  const person = report?.items.find((item) => item.userId === userId);
  if (!person) return false;
  state.saving = true;
  showError("");
  el.notice.textContent = "保存中…";
  const controls = [
    el.day,
    el.stream,
    el.prevDay,
    el.nextDay,
    el.today,
    el.refresh,
    el.saveDesign,
    el.clearDesign,
    el.closeDesign,
  ];
  controls.forEach((control) => {
    control.disabled = true;
  });
  render();
  try {
    const update = await api("/api/gift-rewards", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        day: report.day,
        username: report.username,
        userId,
        revision: person.revision,
        [field]: value,
      }),
    });
    Object.assign(person, update);
    el.notice.textContent = "保存しました";
    return true;
  } catch (error) {
    el.notice.textContent = "";
    showError(error.message);
    // Keep the previous confirmed state; a failed request must not look saved.
    if (el.designDialog.open) el.designDialog.close();
    return false;
  } finally {
    state.saving = false;
    controls.forEach((control) => {
      control.disabled = false;
    });
    el.nextDay.disabled = el.day.value >= today();
    render();
  }
}
