import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("top-gifter rankings are not treated as proof that a listener is present", () => {
  const start = source.indexOf("function rankedViewerEntries");
  const end = source.indexOf("function personFromRankedViewer", start);
  const implementation = source.slice(start, end);

  assert.match(implementation, /currentViewers/);
  assert.match(implementation, /viewerList/);
  assert.doesNotMatch(implementation, /topViewers/);
  assert.doesNotMatch(implementation, /ranksList/);
});
