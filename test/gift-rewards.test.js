import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  dailyGiftRewards,
  updateGiftReward,
  rewardDayRange,
  rewardTiers,
  giftRewardsSchema,
  mergeGiftRewards,
  rewardStreams,
} from "../lib/gift-rewards.js";

test("Japan calendar boundaries and inclusive reward tiers", () => {
  assert.deepEqual(rewardDayRange("2026-10-14"), {
    start: "2026-10-13T15:00:00.000Z",
    end: "2026-10-14T15:00:00.000Z",
  });
  assert.throws(() => rewardDayRange("2026-02-30"));
  assert.throws(() => rewardDayRange("2026-2-1"));
  assert.deepEqual(rewardTiers(4999), { chip: false, card: false });
  assert.deepEqual(rewardTiers(5000), { chip: true, card: false });
  assert.deepEqual(rewardTiers(9999), { chip: true, card: false });
  assert.deepEqual(rewardTiers(10000), { chip: true, card: true });
});

test("real PostgreSQL aggregation, persistence, concurrency and identity merge", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE live_sessions(stream_username text,started_at timestamptz);
    CREATE TABLE live_events(event_key text PRIMARY KEY,session_id text,stream_username text,event_type text,event_at timestamptz,
      user_id text,nickname text,unique_id text,gift_id text,gift_name text,item_count integer,diamonds integer,payload jsonb);
    CREATE TABLE listeners(user_id text PRIMARY KEY,latest_nickname text,latest_unique_id text); ${giftRewardsSchema}`);
  const store = { ready: true, pool: db };
  async function gift(key, user, coins, options = {}) {
    await db.query(
      `INSERT INTO live_events VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
      [
        key,
        options.session || "session1",
        options.stream || "host",
        options.type || "gift",
        options.at || "2026-10-14T01:00:00+09:00",
        user,
        options.name || user,
        user,
        options.giftId ?? "rose",
        options.giftName || "Rose",
        options.quantity || 1,
        coins,
        JSON.stringify({ giftImageUrl: "https://example.com/rose.png" }),
      ],
    );
  }
  await gift("a1", "card", 6000, {
    quantity: 6,
    at: "2026-10-14T00:00:00+09:00",
  });
  await gift("a2", "card", 4000, {
    session: "session2",
    quantity: 4,
    giftName: "バラ",
    at: "2026-10-14T23:59:59.999+09:00",
  });
  await gift("a2", "card", 4000); // duplicate persisted key does not create another reward
  await gift("b1", "chip", 5000);
  await gift("c1", "below", 4999);
  await gift("d1", "almost", 9999);
  await gift("previous", "card", 99000, {
    at: "2026-10-13T23:59:59.999+09:00",
  });
  await gift("next", "card", 99000, { at: "2026-10-15T00:00:00+09:00" });
  await gift("otherhost", "card", 99000, { stream: "another" });
  await gift("notgift", "card", 99000, { type: "comment" });
  await gift("unknown", "card", 0, { giftId: "unknown", giftName: "Unknown" });
  await gift("anonymous", "", 6000);
  await db.query(
    "INSERT INTO listeners VALUES ('card','現在の名前','current_id')",
  );
  await db.query(
    "INSERT INTO live_sessions VALUES ('HOST',NOW()),('host',NOW()),('another',NOW())",
  );
  const scope = { day: "2026-10-14", username: "@HOST" };
  const report = await dailyGiftRewards(store, scope);
  assert.equal(report.chipCount, 3);
  assert.equal(report.cardCount, 1);
  assert.equal(report.unknownCoinEvents, 1);
  assert.equal(report.unidentifiedEvents, 1);
  const card = report.items.find((p) => p.userId === "card");
  assert.equal(card.coins, 10000); // already quantity-adjusted
  assert.equal(card.quantity, 11);
  assert.equal(card.nickname, "現在の名前");
  assert.equal(card.gifts.length, 2);
  assert.equal(card.gifts[0].quantity, 10);
  assert.equal(card.gifts[0].coins, 10000);
  assert.equal((await rewardStreams(store)).length, 2);
  const input = { ...scope, userId: "card", revision: 0 };
  const first = await updateGiftReward(store, { ...input, chipShipped: true });
  assert.equal(first.chipShipped, true);
  assert.equal(first.cardShipped, false);
  assert.equal(first.revision, 1);
  await assert.rejects(
    updateGiftReward(store, { ...input, cardShipped: true }),
    { status: 409 },
  );
  const design = await updateGiftReward(store, {
    ...input,
    revision: 1,
    selectedGiftKey: "id:rose",
  });
  assert.equal(design.selectedGiftKey, "id:rose");
  assert.equal(design.chipShipped, true);
  const sent = await updateGiftReward(store, {
    ...input,
    revision: 2,
    cardShipped: true,
  });
  assert.equal(sent.cardShipped, true);
  assert.equal(sent.chipShipped, true);
  const reread = (await dailyGiftRewards(store, scope)).items.find(
    (p) => p.userId === "card",
  );
  assert.equal(reread.selectedGiftKey, "id:rose");
  assert.equal(reread.cardShipped, true);
  await assert.rejects(
    updateGiftReward(store, {
      ...input,
      revision: 3,
      selectedGiftKey: "id:not-sent",
    }),
    { status: 400 },
  );
  await assert.rejects(
    updateGiftReward(store, { ...input, revision: 3, chipShipped: "false" }),
    { status: 400 },
  );
  await assert.rejects(
    updateGiftReward(store, { ...input, userId: "below", chipShipped: true }),
    { status: 404 },
  );
  await assert.rejects(
    updateGiftReward(store, { ...input, userId: "chip", cardShipped: true }),
    { status: 400 },
  );
  await assert.rejects(
    updateGiftReward(store, {
      ...input,
      userId: "chip",
      revision: 9,
      chipShipped: true,
    }),
    { status: 409 },
  );
  const cleared = await updateGiftReward(store, {
    ...input,
    revision: 3,
    selectedGiftKey: "",
  });
  assert.equal(cleared.selectedGiftKey, "");
  await updateGiftReward(store, { ...input, revision: 4, chipShipped: false });
  assert.equal(
    (await dailyGiftRewards(store, scope)).items.find(
      (p) => p.userId === "card",
    ).chipShipped,
    false,
  );
  assert.equal(
    (await dailyGiftRewards(store, { ...scope, day: "2026-10-15" })).items[0]
      .cardShipped,
    false,
  );
  assert.equal(
    (await dailyGiftRewards(store, { ...scope, username: "another" })).items[0]
      .cardShipped,
    false,
  );
  await mergeGiftRewards(db, "card", "canonical");
  assert.equal(
    (
      await db.query(
        "SELECT card_shipped FROM daily_gift_rewards WHERE user_id='canonical'",
      )
    ).rows[0].card_shipped,
    true,
  );
  assert.equal(
    (await db.query("SELECT * FROM daily_gift_rewards WHERE user_id='card'"))
      .rows.length,
    0,
  );
  await gift("new1", "race", 6000);
  const race = { ...scope, userId: "race", revision: 0, chipShipped: true };
  const results = await Promise.allSettled([
    updateGiftReward(store, race),
    updateGiftReward(store, race),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  await gift("named1", "named", 6000, { giftId: "", giftName: "Named Gift" });
  await gift("named2", "named", 5000, { giftId: "", giftName: "named gift" });
  const named = (await dailyGiftRewards(store, scope)).items.find(
    (item) => item.userId === "named",
  );
  assert.equal(named.gifts.length, 1);
  assert.equal(named.coins, 11000);
  assert.equal(
    (await dailyGiftRewards(store, { ...scope, day: "2026-01-01" })).items
      .length,
    0,
  );
  await assert.rejects(dailyGiftRewards({ ready: false }, scope), {
    status: 503,
  });
});
