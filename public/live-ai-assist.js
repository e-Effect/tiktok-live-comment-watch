const PREF = 'tiktok-live-ai-assist-enabled';
const ADMIN = 'tiktok-listener-admin-key';
const LABELS = { answer: '回答候補', word: 'ことば', reading: '読み方', quiz: 'なぞなぞ', check: '要確認' };

export function renderAssistItems(root, items, document = root.ownerDocument) {
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const article = document.createElement('article');
    article.className = `ai-note ai-note-${Object.hasOwn(LABELS, item.kind) ? item.kind : 'check'}`;
    const header = document.createElement('header');
    const type = document.createElement('span');
    type.className = 'ai-kind';
    type.textContent = item.confidence === 'verified' ? '計算確認済み' : LABELS[item.kind] || '補足';
    const time = document.createElement('time');
    time.textContent = new Date(item.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    header.append(type, time);
    const title = document.createElement('h3');
    title.textContent = item.title;
    article.append(header, title);
    if (item.reading) {
      const reading = document.createElement('p');
      reading.className = 'ai-reading';
      reading.textContent = item.reading;
      article.append(reading);
    }
    const answer = document.createElement('p');
    answer.className = 'ai-answer';
    answer.textContent = item.answer;
    article.append(answer);
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
  if (!root) return { setSession() {} };
  const list = root.querySelector('#aiAssistList');
  const status = root.querySelector('#aiAssistStatus');
  const toggle = root.querySelector('#aiAssistEnabled');
  const keyForm = root.querySelector('#aiAssistKeyForm');
  const keyInput = root.querySelector('#aiAssistKey');
  const usage = root.querySelector('#aiAssistUsage');
  let session = null;
  let generation = 0;
  let timer = null;
  let controller = null;
  let lastVersion = null;
  let configuredGeneration = -1;
  toggle.checked = storage.getItem(PREF) !== 'false';

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
  }

  async function refresh() {
    const current = generation;
    clearTimeout(timer);
    if (!session?.id) { status.textContent = '配信を選択してください'; keyForm.hidden = true; return; }
    if (!storage.getItem(ADMIN)) {
      status.textContent = toggle.checked ? '管理キーで接続' : '停止中';
      keyForm.hidden = !toggle.checked;
      return;
    }
    const activeController = new AbortController();
    controller = activeController;
    let retry = true;
    const timeout = setTimeout(() => activeController.abort(), 10000);
    try {
      const ended = Boolean(session.stoppedAt) || ['stopped', 'ended'].includes(session.status);
      const data = await request(configuredGeneration === current || ended ? 'GET' : 'POST',
        configuredGeneration === current || ended ? null : { enabled: toggle.checked }, activeController.signal);
      if (current !== generation) return;
      configuredGeneration = current;
      keyForm.hidden = true;
      status.textContent = !data.configured ? 'APIキー未設定' : data.error || (ended ? '配信終了' : !data.enabled ? '停止中' : data.pending ? `補足を確認中 · ${data.pending}件` : '自動補足 ON');
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
    } finally {
      clearTimeout(timeout);
      if (retry && current === generation && session?.id) timer = setTimeout(refresh, document.hidden ? 15000 : 2500);
    }
  }

  toggle.addEventListener('change', () => {
    storage.setItem(PREF, String(toggle.checked));
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
  return { setSession(next) {
    if (session?.id === next?.id && session?.status === next?.status && session?.stoppedAt === next?.stoppedAt) return;
    const changedId = session?.id !== next?.id;
    cancel();
    session = next;
    if (changedId) { lastVersion = null; renderAssistItems(list, []); usage.textContent = ''; }
    void refresh();
  } };
}
