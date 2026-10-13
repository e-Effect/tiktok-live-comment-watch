export function searchUrl(text) {
  return `https://www.google.com/search?${new URLSearchParams({ q: text.trim() })}`;
}

export function createCommentUpdateGate(isPaused) {
  let pending = null;
  return {
    update(render) {
      pending = render;
      this.flush();
    },
    flush() {
      if (isPaused() || !pending) return;
      const render = pending;
      pending = null;
      render();
    },
    discard() { pending = null; },
  };
}

export function setupCommentSelectionSearch(list, history) {
  const toolbar = document.createElement('div');
  toolbar.className = 'comment-search-toolbar';
  toolbar.hidden = true;
  const link = document.createElement('a');
  link.textContent = '検索';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = '選択した文字をGoogleで検索';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', '文字選択を解除');
  toolbar.append(link, close);
  document.body.append(toolbar);
  let pointerActive = false;
  let frame = null;

  const element = node => node?.nodeType === 1 ? node : node?.parentElement;
  const within = (root, node) => Boolean(node && root?.contains(node));
  const inList = () => {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed &&
      (within(list, selection.anchorNode) || within(list, selection.focusNode)));
  };
  const isPaused = () => pointerActive || inList();
  const gate = createCommentUpdateGate(isPaused);

  function selectedComment() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const start = element(selection.anchorNode)?.closest('.comment-text');
    const end = element(selection.focusNode)?.closest('.comment-text');
    if (!start || start !== end || (!within(list, start) && !within(history, start))) return null;
    const text = selection.toString().trim();
    return text ? { text, node: start, range: selection.getRangeAt(0) } : null;
  }

  function refresh() {
    frame = null;
    const selected = selectedComment();
    if (!selected) {
      toolbar.hidden = true;
      gate.flush();
      return;
    }
    const host = selected.node.closest('dialog[open]') || document.body;
    if (toolbar.parentElement !== host) host.append(toolbar);
    link.href = searchUrl(selected.text);
    link.setAttribute('aria-label', `「${selected.text}」をGoogleで検索（新しいタブ）`);
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const rect = selected.range.getBoundingClientRect();
    const container = (within(list, selected.node) ? list : history).getBoundingClientRect();
    const hostRect = host === document.body ? null : host.getBoundingClientRect();
    const visibleTop = Math.max(top, hostRect?.top ?? top);
    const visibleBottom = Math.min(top + height, hostRect?.bottom ?? top + height);
    if (rect.bottom < Math.max(visibleTop, container.top) || rect.top > Math.min(visibleBottom, container.bottom)) {
      toolbar.hidden = true;
      return;
    }
    toolbar.hidden = false;
    const box = toolbar.getBoundingClientRect();
    // Below the selection leaves room for the phone's native copy/selection menu.
    const y = rect.bottom + 14 + box.height <= visibleBottom - 8
      ? rect.bottom + 14 : rect.top - box.height - 14;
    toolbar.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - box.width - 8))}px`;
    toolbar.style.top = `${Math.max(visibleTop + 8, Math.min(y, visibleBottom - box.height - 8))}px`;
  }

  function schedule() {
    if (frame === null) frame = requestAnimationFrame(refresh);
  }

  function clear() {
    pointerActive = false;
    if (inList() || selectedComment()) window.getSelection()?.removeAllRanges();
    toolbar.hidden = true;
    gate.flush();
  }

  list.addEventListener('pointerdown', event => {
    if (event.button === 0) pointerActive = true;
  });
  const release = () => {
    pointerActive = false;
    // A tap must finish its click/history action before replacing its row.
    setTimeout(schedule, 0);
  };
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  window.addEventListener('blur', () => { pointerActive = false; schedule(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selectedComment()) {
      event.preventDefault();
      event.stopPropagation();
      clear();
    }
  }, true);
  // Preserve the range until the browser follows the link, including touch taps.
  toolbar.addEventListener('pointerdown', event => event.preventDefault());
  link.addEventListener('click', () => { setTimeout(clear, 0); });
  close.addEventListener('click', clear);
  history?.closest('dialog')?.addEventListener('close', clear);

  return {
    isPaused,
    update: render => gate.update(render),
    reset() { gate.discard(); clear(); },
  };
}
