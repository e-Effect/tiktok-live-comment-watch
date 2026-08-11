import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("the top bar has one clear primary start and stop control", () => {
  assert.match(html, /id="primarySessionBtn"[^>]*>配信記録を開始/);
  assert.doesNotMatch(html, />追加<|id="stopBtn"/);
  assert.match(client, /primarySessionBtn\?\.dataset\.action === "stop"/);
  assert.match(client, /"配信記録を停止"/);
  assert.match(client, /"別の配信記録を開始"/);
});

test("test controls are grouped and first-visit demo joins preflight", () => {
  assert.match(html, /<summary>テスト・確認<\/summary>/);
  assert.match(html, /id="preflightTestBtn"/);
  assert.match(html, /id="previewStartBtn"/);
  assert.doesNotMatch(html, /id="visitorDemoShortcutBtn"/);
  assert.match(client, /requestPreviewDemo\(body\.id, adminKey\);\s*setVisitorDemoActive\(true\)/);
});
