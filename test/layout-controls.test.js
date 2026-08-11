import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("resetting the layout requires explicit confirmation", () => {
  assert.match(client, /window\.confirm\("レイアウトを初期配置に戻しますか？/);
  assert.match(client, /if \(!confirmed\) return;\s*localStorage\.removeItem\(LAYOUT_PREFS_KEY\)/);
});
