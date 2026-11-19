const grid = document.querySelector('.dashboard .grid');
const key = 'tiktok-live-column-widths-v1';
const columns = [
  ['visitors', '入室履歴', 21, 145], ['comments', 'コメント', 36, 205],
  ['aiAssist', 'AI補足', 26, 170], ['giftHistory', 'ギフト履歴', 17, 145]
].map(([id, name, weight, min]) => ({panel: grid.querySelector(`[data-panel="${id}"]`), name, weight, min}));
const defaults = columns.map(c => c.weight);
let weights = defaults.slice();
try {
  const saved = JSON.parse(localStorage.getItem(key));
  if (Array.isArray(saved) && saved.length === columns.length && saved.every(n => Number.isFinite(n) && n > 0)) weights = saved;
} catch {}

const width = c => c.panel.getBoundingClientRect().width;
const nextVisible = i => columns.findIndex((c, j) => j > i && !c.panel.hidden);
function persist() {
  try { localStorage.setItem(key, JSON.stringify(weights)); } catch {}
}
function paint() {
  grid.style.setProperty('--live-columns', columns.map((c, i) =>
    c.panel.hidden ? '0px' : `minmax(${c.min}px, ${weights[i]}fr)`).join(' '));
  columns.forEach((c, i) => {
    if (!c.handle) return;
    const j = nextVisible(i);
    c.handle.hidden = c.panel.hidden || j === -1;
    if (!c.handle.hidden) {
      c.handle.setAttribute('aria-label', `${c.name}と${columns[j].name}の列幅`);
      c.handle.setAttribute('aria-valuenow', Math.round(weights[i] / (weights[i] + weights[j]) * 100));
    }
  });
}

// Use rendered widths at gesture start so minimum-width clamps do not cause jumps.
function gesture(i) {
  const j = nextVisible(i);
  if (j < 0) return;
  const sizes = columns.map(width);
  const total = sizes.reduce((a,b) => a+b, 0);
  const visibleWeight = weights.reduce((sum,w,k) => sum + (columns[k].panel.hidden ? 0 : w), 0);
  return delta => {
    const change = Math.max(columns[i].min - sizes[i], Math.min(sizes[j] - columns[j].min, delta));
    sizes.forEach((size,k) => {
      if (size) weights[k] = (size + (k === i ? change : k === j ? -change : 0)) / total * visibleWeight;
    });
    paint();
  };
}
for (const [i, c] of columns.slice(0,-1).entries()) {
  const h = document.createElement('div');
  c.handle = h;
  h.className = 'column-divider';
  h.tabIndex = 0;
  h.setAttribute('role', 'separator');
  h.setAttribute('aria-orientation', 'vertical');
  h.title = 'ドラッグで列幅を調整・ダブルクリックで標準幅に戻す';
  c.panel.append(h);
  let drag;
  h.addEventListener('pointerdown', e => {
    if (e.button !== 0 || drag) return;
    drag = {id: e.pointerId, x: e.clientX, move: gesture(i)};
    h.setPointerCapture(e.pointerId);
    h.classList.add('dragging');
  });
  h.addEventListener('pointermove', e => {
    if (drag?.id === e.pointerId) drag.move(e.clientX - drag.x);
  });
  h.addEventListener('lostpointercapture', () => {
    drag = null; h.classList.remove('dragging'); persist();
  });
  h.addEventListener('keydown', e => {
    if (!['ArrowLeft','ArrowRight'].includes(e.key)) return;
    e.preventDefault(); gesture(i)?.(e.key === 'ArrowRight' ? 16 : -16); persist();
  });
  h.addEventListener('dblclick', () => { weights = defaults.slice(); paint(); persist(); });
}
const observer = new MutationObserver(paint);
columns.forEach(c => observer.observe(c.panel, {attributes:true, attributeFilter:['hidden']}));
paint();
