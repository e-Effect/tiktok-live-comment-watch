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
  assert.ok(receiptCatalog.length >= 600);
  assert.equal(new Set(receiptCatalog.map((gift) => Number(gift.id))).size, receiptCatalog.length);
  assert.ok(receiptCatalog.every((gift) => Number(gift.id) > 0 && String(gift.name).trim() && Number(gift.coins) >= 0));
  assert.equal(receiptCatalog.find((gift) => Number(gift.id) === 7934)?.name, "ハートミー");
  assert.equal(receiptCatalog.find((gift) => Number(gift.id) === 14753)?.name, "Magic Potion");
  assert.match(client, /fetch\("\/receipt-gift-catalog\.json"/);
  assert.match(client, /\.\.\.receiptGiftCatalog, \.\.\.sessionGiftCatalog/);
});

test("adds Magic Potion once to the existing featured-gift filter", () => {
  assert.match(client, /LEGACY_FEATURED_GIFT_KEYS = \["name:ハートミー", "name:だいすき", "name:折り鶴"\]/);
  assert.match(client, /MAGIC_POTION_GIFT_KEY = "name:magic potion"/);
  assert.match(client, /addMagicPotionToFeaturedGiftFilter\(filter\)/);
  assert.match(client, /GIFT_HISTORY_MAGIC_POTION_MIGRATION_KEY/);
});
