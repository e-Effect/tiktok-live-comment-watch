import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const receiptCatalog = JSON.parse(await readFile(new URL("../public/receipt-gift-catalog.json", import.meta.url), "utf8"));

test("gift history has a saved multi-gift display filter", () => {
  assert.match(html, /id="giftHistoryFilterButton"/);
  assert.match(html, /特定のギフトだけ表示する/);
  assert.match(client, /GIFT_HISTORY_FILTER_KEY/);
  assert.match(client, /gifts\.filter\(giftMatchesHistoryFilter\)/);
  assert.match(client, /localStorage\.setItem\(GIFT_HISTORY_FILTER_KEY/);
});

test("gift filter includes the receipt application's catalog", () => {
  assert.equal(receiptCatalog.length, 645);
  assert.ok(receiptCatalog.every((gift) => Array.isArray(gift) && gift.length === 3));
  assert.match(client, /fetch\("\/receipt-gift-catalog\.json"/);
  assert.match(client, /\.\.\.receiptGiftCatalog, \.\.\.sessionGiftCatalog/);
});
