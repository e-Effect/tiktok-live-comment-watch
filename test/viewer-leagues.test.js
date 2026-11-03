import test from "node:test";
import assert from "node:assert/strict";
import { ViewerLeagues } from "../lib/viewer-leagues.js";

const START = 1_789_000_000_000;
const MINUTE = 60_000;
const DIVISIONS = { A1: 2000, A2: 1900, A3: 1800, B1: 1500, B2: 1400, B3: 1300, B4: 1200, C1: 1000 };

function fixture() {
  const requests = [];
  const changes = [];
  let now = START;
  let phase = 0;
  const leagues = new ViewerLeagues({
    apiKey: "fixture",
    now: () => now,
    onChange: matches => changes.push(matches),
    async fetchFn(url, options) {
      assert.equal(url.origin, "https://api.tik.tools");
      assert.equal(options.headers["x-api-key"], "fixture");
      assert.equal(url.searchParams.get("region"), "JP");
      const classType = Number(url.searchParams.get("class"));
      requests.push(classType);
      if (!classType) return { ok: phase !== 2, json: async () => ({
        region: "JP", available: true, leagues: Object.entries(DIVISIONS).map(([classLabel, classType]) =>
          ({ classLabel, classType, updatedAt: now - (classLabel === "A3" ? 25 * 60 * MINUTE : 0) }))
      }) };
      const classLabel = Object.keys(DIVISIONS).find(key => DIVISIONS[key] === classType);
      return { ok: true, json: async () => ({
        region: "JP", classType, classLabel, available: true, hasFullAccess: classLabel !== "B2",
        entries: [
          { uniqueId: `creator_${classLabel}` },
          ...(classLabel === "A1" && phase === 0 ? [{ uniqueId: "rotates" }] : []),
          ...(classLabel === "B3" && phase === 1 ? [{ uniqueId: "rotates" }] : []),
          ...(["A1", "A2", "B3"].includes(classLabel) ? [{ uniqueId: "conflict" }] : []),
          { uniqueId: "masked", masked: true },
          { nickname: "nickname_only" }
        ]
      }) };
    }
  });
  return { leagues, requests, changes, advance(ms, nextPhase) { now += ms; phase = nextPhase; } };
}

test("league is opt-in, and blank identities do not make requests", () => {
  const fail = () => assert.fail("unexpected fetch");
  assert.equal(new ViewerLeagues({ fetchFn: fail }).get("creator_a1"), "");
  assert.equal(new ViewerLeagues({ apiKey: "fixture", fetchFn: fail }).get("unknown"), "");
});

test("exact @ID matches only the allowed fresh and unmasked boards, with one shared refresh", async () => {
  const { leagues, requests, changes } = fixture();
  assert.equal(leagues.get("@Creator_A1"), "");
  assert.equal(leagues.get("creator_b3"), "");
  await leagues.pending;
  assert.deepEqual(requests, [0, 2000, 1900, 1500, 1400, 1300]);
  for (const league of ["A1", "A2", "B1", "B3"]) assert.equal(leagues.get(`@creator_${league}`), league);
  for (const id of ["creator_a3", "creator_b2", "creator_b4", "creator_c1", "masked", "conflict", "nickname_only", "creator"]) {
    assert.equal(leagues.get(id), "", id);
  }
  assert.equal(changes.length, 1);
  assert.equal(changes[0]("@CREATOR_A1"), true);
  assert.equal(changes[0]("nickname_only"), false);
});

test("refresh can move a badge; unavailable or expired data is not served", async () => {
  const { leagues, changes, advance } = fixture();
  leagues.get("rotates");
  await leagues.pending;
  assert.equal(leagues.get("rotates"), "A1");
  advance(30 * MINUTE, 1);
  assert.equal(leagues.get("rotates"), "A1", "refresh never blocks a live event");
  await leagues.pending;
  assert.equal(leagues.get("rotates"), "B3");
  assert.equal(changes[1]("rotates"), true);
  assert.equal(changes[1]("creator_a1"), false);
  advance(24 * 60 * MINUTE, 2);
  assert.equal(leagues.get("rotates"), "");
  await leagues.pending;
  assert.equal(leagues.get("creator_a1"), "");
  assert.equal(changes[2]("rotates"), true);
});
