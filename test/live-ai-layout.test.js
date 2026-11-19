import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/live-workspace.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
test('workspace grid placement outranks saved tall/long and max-height panel rules without deleting preferences', () => {
  // Legacy .grid > section.panel-height-long:not(.panel-size-small) is (0,3,1).
  // Omitting section below makes it (0,3,0), so a saved height moves entire panels.
  for (const name of ['visitors', 'comments', 'aiAssist', 'giftHistory', 'shares']) {
    assert.ok(css.includes(`.live-workspace .grid > section[data-panel="${name}"] { grid-area:`), name);
  }
  assert.match(css, /\.live-workspace \.grid > section\[hidden\] \{ display: none; \}/);
  assert.match(html, /value="custom"> 自由配置（従来）/);
});
