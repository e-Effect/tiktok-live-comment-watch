import assert from "node:assert/strict";
import test from "node:test";
import { avatarUrlFromUser } from "../lib/avatar-url.js";

test("reads the avatar fields emitted by Tik.tools LIVE events", () => {
  assert.equal(
    avatarUrlFromUser({ profilePicture: "https://cdn.example/thumb.jpg" }),
    "https://cdn.example/thumb.jpg"
  );
  assert.equal(
    avatarUrlFromUser({
      profilePicture: "https://cdn.example/thumb.jpg",
      avatarLargeUrl: "https://cdn.example/large.jpg"
    }),
    "https://cdn.example/large.jpg"
  );
});

test("reads avatar URL lists from legacy LIVE events", () => {
  assert.equal(
    avatarUrlFromUser({ avatarThumb: { urlList: ["https://cdn.example/list.jpg"] } }),
    "https://cdn.example/list.jpg"
  );
});
