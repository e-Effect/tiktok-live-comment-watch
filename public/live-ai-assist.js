const PREF = 'tiktok-live-ai-assist-enabled';
const ADMIN = 'tiktok-listener-admin-key';
const LABELS = { answer: '回答候補', word: 'ことば', reading: '読み方', quiz: 'なぞなぞ', check: '要確認' };
const AI_MODE_PREF = 'tiktok-live-ai-quality-v2';
const AI_MODE_LABELS = { fast: '1. 即答', light: '2. 軽く考える', thoughtful: '3. しっかり考える', balanced: '4. Terra標準', smart: '5. Terra熟考' };

function readGlossary(value) {
  return [...String(value || '').matchAll(/([\p{Script=Han}々ぁ-ゖァ-ヺー]{1,40})[（(]([ぁ-ゖー]{1,80})[）)]/gu)]
    .sort((a, b) => b[1].length - a[1].length);
}

const commonReadings = readGlossary('嚥下機能（えんげきのう） 嚥下（えんげ） 頸部前屈（けいぶぜんくつ） 頸部（けいぶ） 前屈（ぜんくつ） 仰臥位（ぎょうがい） 誤嚥（ごえん） 食事介助（しょくじかいじょ） 摂食中枢（せっしょくちゅうすう） 延髄（えんずい） 小脳（しょうのう） 下垂体（かすいたい） 視床下部（ししょうかぶ） 酸素投与器具（さんそとうよきぐ） 高濃度（こうのうど） 吸入（きゅうにゅう） 過量服用（かりょうふくよう） 臓器障害（ぞうきしょうがい） 肝障害（かんしょうがい） 肝機能障害（かんきのうしょうがい） 急性肝不全（きゅうせいかんふぜん） 傷害罪（しょうがいざい） 故意（こい） 因果関係（いんがかんけい） 売買契約（ばいばいけいやく） 口頭（こうとう） 瑕疵（かし） 過失（かしつ） 債務不履行（さいむふりこう）');

function writeWithRuby(node, value, terms) {
  let rest = String(value || '');
  while (rest) {
    let start = rest.length, term;
    for (const entry of terms) {
      const at = rest.indexOf(entry[1]);
      if (at >= 0 && at < start) { start = at; term = entry; }
    }
    node.append(rest.slice(0, start));
    if (!term) break;
    const ruby = node.ownerDocument.createElement('ruby');
    const rt = node.ownerDocument.createElement('rt');
    rt.textContent = term[2];
    ruby.append(term[1], rt);
    node.append(ruby);
    rest = rest.slice(start + term[1].length);
  }
}

export function renderAssistItems(root, items, document = root.ownerDocument) {
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const article = document.createElement('article');
    article.className = `ai-note ai-note-${Object.hasOwn(LABELS, item.kind) ? item.kind : 'check'}`;
    const header = document.createElement('header');
    const type = document.createElement('span');
    type.className = 'ai-kind';
    type.textContent = ['verified', 'high'].includes(item.confidence) ? '●●●　自信：高' : item.confidence === 'candidate' ? '●●○　自信：中' : '●○○　自信：低';
    const time = document.createElement('time');
    time.textContent = new Date(item.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    header.append(type, time);
    const title = document.createElement('h3');
    const supplied = readGlossary(item.reading);
    const terms = [...commonReadings, ...supplied].sort((a,b) => b[1].length - a[1].length);
    writeWithRuby(title, item.title, terms);
    article.append(header);
    const answer = document.createElement('p');
    answer.className = 'ai-answer';
    writeWithRuby(answer, item.answer, terms);
    article.append(answer, title);
    if (item.reading && !supplied.length) {
      const reading = document.createElement('p');
      reading.className = 'ai-reading';
      reading.textContent = item.reading;
      article.append(reading);
    }
    if (item.detail) {
      const detail = document.createElement('p');
      detail.className = 'ai-detail';
      writeWithRuby(detail, item.detail, terms);
      article.append(detail);
    }
    const comment = document.createElement('blockquote');
    if (item.nickname) comment.append(item.nickname + '：');
    writeWithRuby(comment, item.comment, terms);
    article.append(comment);
    fragment.append(article);
  }
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '補足が必要なコメントを待っています。';
    fragment.append(empty);
  }
  root.replaceChildren(fragment);
}

export function setupLiveAiAssist({ root, fetchImpl = fetch, storage = localStorage }) {
  if (!root) return { setSession() {}, notifyReady() {} };
  const list = root.querySelector('#aiAssistList');
  const status = root.querySelector('#aiAssistStatus');
  const toggle = root.querySelector('#aiAssistEnabled');
  const quiz = root.querySelector('#aiQuizMode');
  let requestedQuiz;
  const keyForm = root.querySelector('#aiAssistKeyForm');
  const keyInput = root.querySelector('#aiAssistKey');
  const usage = root.querySelector('#aiAssistUsage');
  const modeInputs = [...root.ownerDocument.querySelectorAll('[name="aiQuality"]')];
  const modeStatus = root.ownerDocument.querySelector('#aiQualityStatus');
  let selectedMode = Object.hasOwn(AI_MODE_LABELS, storage.getItem(AI_MODE_PREF)) ? storage.getItem(AI_MODE_PREF) : 'fast';
  let session = null;
  let generation = 0;
  let timer = null;
  let controller = null;
  let lastVersion = null;
  let configuredGeneration = -1;
  let pendingReady = false;
  toggle.checked = storage.getItem(PREF) !== 'false';
  const syncMode = () => modeInputs.forEach(input => { input.checked = input.value === selectedMode; });
  const setModeStatus = text => { if (modeStatus) modeStatus.textContent = text; };
  syncMode();
  setModeStatus('保存済み');

  async function request(method, body, signal) {
    const key = storage.getItem(ADMIN) || '';
    if (!key) throw new Error('auth');
    const since = method === 'GET' && lastVersion !== null ? `?version=${encodeURIComponent(lastVersion)}` : '';
    const response = await fetchImpl(`/api/session/${encodeURIComponent(session.id)}/ai-assist${since}`, {
      method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal
    });
    if ([401, 403].includes(response.status)) throw new Error('auth');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI補足に接続できません。');
    return data;
  }

  function cancel() {
    generation += 1;
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    pendingReady = false;
  }

  async function refresh() {
    const current = generation;
    clearTimeout(timer);
    if (!session?.id) { status.textContent = '配信を選択してください'; keyForm.hidden = true; setModeStatus('次の配信に適用'); return; }
    if (!storage.getItem(ADMIN)) {
      status.textContent = toggle.checked ? '管理キーで接続' : '停止中';
      keyForm.hidden = !toggle.checked;
      setModeStatus('管理キーで接続');
      return;
    }
    const activeController = new AbortController();
    controller = activeController;
    let retry = true;
    const timeout = setTimeout(() => activeController.abort(), 10000);
    try {
      const ended = Boolean(session.stoppedAt) || ['stopped', 'ended'].includes(session.status);
      let data = await request(configuredGeneration === current || ended ? 'GET' : 'POST',
        configuredGeneration === current || ended ? null : { enabled: toggle.checked, mode: selectedMode, quiz: requestedQuiz }, activeController.signal);
      if (current !== generation) return;
      // Only version zero is an unconfigured server state, not another viewer's OFF command.
      if (!ended && data.version === 0 && !data.enabled && (toggle.checked || data.mode !== selectedMode)) {
        data = await request('POST', { enabled: toggle.checked, mode: selectedMode }, activeController.signal);
        if (current !== generation) return;
      }
      configuredGeneration = current;
      requestedQuiz = undefined;
      if (quiz) { quiz.checked = Boolean(data.quiz) && !ended; quiz.disabled = ended || !data.enabled || !data.configured; }
      keyForm.hidden = true;
      if (!ended && Object.hasOwn(AI_MODE_LABELS, data.mode) && selectedMode !== data.mode) {
        selectedMode = data.mode;
        storage.setItem(AI_MODE_PREF, selectedMode);
        syncMode();
      }
      setModeStatus(ended ? '次の配信に適用' : data.configured ? '適用済み' : 'APIキー未設定');
      const stateText = ended ? '配信終了' : !data.enabled ? '停止中' : data.pending ? `補足を確認中 · ${data.pending}件` : '自動補足 ON';
      const appliedLabel = AI_MODE_LABELS[data.mode] || '';
      status.textContent = !data.configured ? 'APIキー未設定' : data.error || `${stateText}${appliedLabel ? ` · ${appliedLabel}` : ''}`;
      usage.textContent = `直近24h ${data.dailyCalls} / ${data.dailyLimit} 回${data.skipped ? ` · 省略 ${data.skipped}件` : ''}`;
      if (lastVersion !== data.version) {
        lastVersion = data.version;
        const oldTop = list.scrollTop;
        const oldHeight = list.scrollHeight;
        renderAssistItems(list, data.items || []);
        if (oldTop > 40) list.scrollTop = oldTop + list.scrollHeight - oldHeight;
      }
    } catch (error) {
      if (current !== generation) return;
      retry = error.message !== 'auth';
      keyForm.hidden = error.message !== 'auth' || !toggle.checked;
      status.textContent = error.message === 'auth' ? '管理キーで接続' : 'AI補足は再接続待ち';
      setModeStatus(error.message === 'auth' ? '管理キーで接続' : '未反映・再接続待ち');
    } finally {
      clearTimeout(timeout);
      if (current === generation) {
        controller = null;
        if (retry && session?.id) timer = setTimeout(refresh, pendingReady && !document.hidden ? 0 : document.hidden ? 15000 : 2500);
        pendingReady = false;
      }
    }
  }

  toggle.addEventListener('change', () => {
    storage.setItem(PREF, String(toggle.checked));
    cancel();
    void refresh();
  });
  quiz?.addEventListener('change', () => {
    requestedQuiz = quiz.checked;
    quiz.disabled = true;
    cancel();
    void refresh();
  });
  modeInputs.forEach(input => input.addEventListener('change', () => {
    if (!input.checked || !Object.hasOwn(AI_MODE_LABELS, input.value)) return;
    selectedMode = input.value;
    storage.setItem(AI_MODE_PREF, selectedMode);
    syncMode();
    setModeStatus('反映中…');
    cancel();
    void refresh();
  }));
  window.addEventListener('storage', event => {
    if (event.key !== AI_MODE_PREF || !Object.hasOwn(AI_MODE_LABELS, event.newValue)) return;
    selectedMode = event.newValue;
    syncMode();
    cancel();
    void refresh();
  });
  keyForm.addEventListener('submit', event => {
    event.preventDefault();
    storage.setItem(ADMIN, keyInput.value.trim());
    keyInput.value = '';
    cancel();
    void refresh();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { cancel(); void refresh(); } });
  window.addEventListener('pagehide', cancel);
  for (const event of ['pageshow', 'online']) window.addEventListener(event, () => { cancel(); void refresh(); });
  return { notifyReady(id) {
    if (session?.id !== id || document.hidden || !toggle.checked || !storage.getItem(ADMIN)) return;
    if (controller) { pendingReady = true; return; }
    if (configuredGeneration !== generation) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 0);
  }, setSession(next) {
    if (session?.id === next?.id && session?.status === next?.status && session?.stoppedAt === next?.stoppedAt) return;
    const changedId = session?.id !== next?.id;
    if (changedId) { requestedQuiz = undefined; if (quiz) { quiz.checked = false; quiz.disabled = true; } }
    cancel();
    session = next;
    if (changedId) { lastVersion = null; renderAssistItems(list, []); usage.textContent = ''; }
    void refresh();
  } };
}
