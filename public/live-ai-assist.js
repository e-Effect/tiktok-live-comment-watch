const PREF = 'tiktok-live-ai-assist-enabled';
const ADMIN = 'tiktok-listener-admin-key';
const LABELS = { answer: '回答候補', word: 'ことば', reading: '読み方', quiz: 'なぞなぞ', check: '要確認' };
const AI_MODE_PREF = 'tiktok-live-ai-quality-v2';
const AI_MODE_LABELS = { fast: '1. 即答', light: '2. 軽く考える', thoughtful: '3. しっかり考える', balanced: '4. Terra標準', smart: '5. Terra熟考' };

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
    title.textContent = item.title;
    article.append(header);
    const answer = document.createElement('p');
    answer.className = 'ai-answer';
    answer.textContent = item.answer;
    article.append(answer, title);
    if (item.reading) {
      const reading = document.createElement('p');
      reading.className = 'ai-reading';
      reading.textContent = item.reading;
      article.append(reading);
    }
    if (item.detail) {
      const detail = document.createElement('p');
      detail.className = 'ai-detail';
      detail.textContent = item.detail;
      article.append(detail);
    }
    const comment = document.createElement('blockquote');
    comment.textContent = `${item.nickname ? item.nickname + '：' : ''}${item.comment}`;
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
        configuredGeneration === current || ended ? null : { enabled: toggle.checked, mode: selectedMode }, activeController.signal);
      if (current !== generation) return;
      // Only version zero is an unconfigured server state, not another viewer's OFF command.
      if (!ended && data.version === 0 && !data.enabled && (toggle.checked || data.mode !== selectedMode)) {
        data = await request('POST', { enabled: toggle.checked, mode: selectedMode }, activeController.signal);
        if (current !== generation) return;
      }
      configuredGeneration = current;
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
    cancel();
    session = next;
    if (changedId) { lastVersion = null; renderAssistItems(list, []); usage.textContent = ''; }
    void refresh();
  } };
}
