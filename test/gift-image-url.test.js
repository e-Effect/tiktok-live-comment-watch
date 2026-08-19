import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { giftImageUrlFromEvent } from "../lib/gift-image-url.js";

const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("reads the gift image URL emitted by TikFinity", () => {
  assert.equal(giftImageUrlFromEvent({
    giftPictureUrl: "https://p16-webcast.tiktokcdn.com/gift.webp"
  }), "https://p16-webcast.tiktokcdn.com/gift.webp");
});

test("reads nested TikTok gift image URL lists and rejects insecure URLs", () => {
  assert.equal(giftImageUrlFromEvent({
    extendedGiftInfo: { image: { url_list: ["https://p19-webcast.tiktokcdn.com/gift.png"] } }
  }), "https://p19-webcast.tiktokcdn.com/gift.png");
  assert.equal(giftImageUrlFromEvent({ giftPictureUrl: "http://example.com/gift.png" }), "");
});

test("gift history renders artwork, gift name, count, and diamonds", () => {
  assert.match(client, /function renderGiftArtwork\(gift\)/);
  assert.match(client, /class="gift-image"/);
  assert.match(client, /\$\{renderGiftArtwork\(gift\)\}/);
  assert.match(client, /\$\{escapeHtml\(gift\.giftName \|\| "ギフト"\)\}/);
  assert.match(client, /×\$\{formatNumber\(gift\.repeatCount\)\}/);
});
