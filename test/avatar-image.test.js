import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { optimizeAvatarImage } from "../lib/avatar-image.js";

test("avatars are resized and encoded as compact WebP", async () => {
  const source = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#e33" } }).png().toBuffer();
  const result = await optimizeAvatarImage(source);
  const metadata = await sharp(result.data).metadata();
  assert.equal(result.mime, "image/webp");
  assert.ok(metadata.width <= 128);
  assert.ok(metadata.height <= 128);
  assert.ok(result.data.length < source.length);
});
