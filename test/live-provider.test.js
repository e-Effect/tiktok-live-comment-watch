import assert from "node:assert/strict";
import test from "node:test";
import { liveProviderInfo } from "../lib/live-provider.js";

test("uses the existing connector before the paid API key is configured", () => {
  assert.deepEqual(liveProviderInfo({}), {
    id: "legacy",
    label: "標準接続",
    mode: "direct",
    paidApiReady: false
  });
});
test("switches to Tik.tools without changing application code", () => {
  assert.deepEqual(liveProviderInfo({
    TIKTOOLS_API_KEY: "configured",
    TIKTOOLS_MODE: "relayed"
  }), {
    id: "tiktools",
    label: "Tik.tools",
    mode: "relayed",
    paidApiReady: true
  });
});

