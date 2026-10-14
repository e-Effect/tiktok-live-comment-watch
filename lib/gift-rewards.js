export const giftRewardsSchema = `
  CREATE TABLE IF NOT EXISTS daily_gift_rewards (
    stream_username TEXT NOT NULL,
    reward_day DATE NOT NULL,
    user_id TEXT NOT NULL,
    chip_shipped BOOLEAN NOT NULL DEFAULT FALSE,
    card_shipped BOOLEAN NOT NULL DEFAULT FALSE,
    selected_gift_key TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stream_username, reward_day, user_id)
  );
`;

export class RewardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function rewardDayRange(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)))
    throw new RewardError("日付を確認してください");
  const midnight = new Date(`${day}T00:00:00.000Z`);
  if (
    !Number.isFinite(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== day
  ) {
    throw new RewardError("日付を確認してください");
  }
  const start = new Date(midnight.getTime() - 9 * 3600000);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 86400000).toISOString(),
  };
}

export function rewardStream(value) {
  const username = String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  if (!/^[a-z0-9_.]{2,32}$/.test(username))
    throw new RewardError("配信者を選択してください");
  return username;
}

export function rewardTiers(coins) {
  return { chip: coins >= 5000, card: coins >= 10000 };
}

function requireStore(store) {
  if (!store.ready)
    throw new RewardError(
      "データベースに接続できません。時間をおいて再試行してください。",
      503,
    );
}

export async function rewardStreams(store) {
  requireStore(store);
  const { rows } = await store.pool
    .query(`SELECT LOWER(stream_username) AS username,
    MAX(started_at) AS "lastAt" FROM live_sessions GROUP BY LOWER(stream_username) ORDER BY MAX(started_at) DESC`);
  return rows;
}

export async function dailyGiftRewards(store, { day, username }) {
  requireStore(store);
  const stream = rewardStream(username);
  const { start, end } = rewardDayRange(day);
  // A single snapshot joins all sessions in the JST day. Stored diamonds already
  // include quantity; multiplying by item_count again would overstate rewards.
  const { rows } = await store.pool.query(
    `
    WITH day_events AS MATERIALIZED (
      SELECT user_id, nickname, unique_id, gift_id, gift_name, item_count, diamonds, event_at,
        payload->>'giftImageUrl' AS image_url,
        CASE WHEN gift_id <> '' THEN 'id:' || gift_id
          ELSE 'name:' || LOWER(TRIM(gift_name)) END AS gift_key
      FROM live_events
      WHERE event_type = 'gift' AND event_at >= $2::timestamptz AND event_at < $3::timestamptz
        AND LOWER(stream_username) = $1
    ), totals AS (
      SELECT user_id, SUM(diamonds)::bigint AS coins, SUM(item_count)::bigint AS quantity,
        MAX(nickname) AS nickname, MAX(unique_id) AS unique_id,
        COUNT(*) FILTER (WHERE diamonds <= 0)::integer AS unknown_coins
      FROM day_events WHERE user_id <> '' GROUP BY user_id HAVING SUM(diamonds) >= 5000
    ), kinds AS (
      SELECT e.user_id, e.gift_key, MAX(e.gift_id) AS gift_id, MAX(e.gift_name) AS gift_name,
        MAX(NULLIF(e.image_url, '')) AS image_url,
        SUM(e.item_count)::bigint AS quantity, SUM(e.diamonds)::bigint AS coins
      FROM day_events e JOIN totals t ON t.user_id = e.user_id
      GROUP BY e.user_id, e.gift_key
    ), gifts AS (
      SELECT user_id, jsonb_agg(jsonb_build_object('key',gift_key,'id',gift_id,'name',gift_name,
        'imageUrl',image_url,'quantity',quantity,'coins',coins) ORDER BY coins DESC, gift_key) AS gifts
      FROM kinds GROUP BY user_id
    ), report AS (
      SELECT t.user_id AS "userId", COALESCE(NULLIF(l.latest_nickname,''),t.nickname,t.user_id) AS nickname,
        COALESCE(NULLIF(l.latest_unique_id,''),t.unique_id) AS "uniqueId", t.coins, t.quantity,
        t.unknown_coins AS "unknownCoins", g.gifts,
        COALESCE(r.chip_shipped,FALSE) AS "chipShipped", COALESCE(r.card_shipped,FALSE) AS "cardShipped",
        COALESCE(r.selected_gift_key,'') AS "selectedGiftKey", COALESCE(r.revision,0) AS revision
      FROM totals t LEFT JOIN listeners l ON l.user_id = t.user_id
      JOIN gifts g ON g.user_id = t.user_id
      LEFT JOIN daily_gift_rewards r ON r.stream_username = $1 AND r.reward_day = $4::date AND r.user_id = t.user_id
    )
    SELECT COALESCE((SELECT jsonb_agg(report ORDER BY coins DESC, "userId") FROM report),'[]'::jsonb) AS items,
      (SELECT COUNT(*) FROM day_events) AS "eventCount",
      (SELECT COUNT(*) FROM day_events WHERE diamonds <= 0) AS "unknownCoinEvents",
      (SELECT COUNT(*) FROM day_events WHERE user_id = '') AS "unidentifiedEvents"
  `,
    [stream, start, end, day],
  );
  const result = rows[0] || {};
  const items = (result.items || []).map((item) => ({
    ...item,
    coins: Number(item.coins),
    quantity: Number(item.quantity),
  }));
  return {
    day,
    username: stream,
    start,
    end,
    items,
    eventCount: Number(result.eventCount || 0),
    unknownCoinEvents: Number(result.unknownCoinEvents || 0),
    unidentifiedEvents: Number(result.unidentifiedEvents || 0),
    chipCount: items.length,
    cardCount: items.filter((item) => rewardTiers(item.coins).card).length,
  };
}

export async function updateGiftReward(store, input) {
  const allowed = new Set([
    "day",
    "username",
    "userId",
    "revision",
    "chipShipped",
    "cardShipped",
    "selectedGiftKey",
  ]);
  if (!input || Object.keys(input).some((key) => !allowed.has(key)))
    throw new RewardError("更新内容を確認してください");
  const fields = ["chipShipped", "cardShipped", "selectedGiftKey"].filter(
    (key) => Object.hasOwn(input, key),
  );
  if (
    fields.length !== 1 ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0
  )
    throw new RewardError("更新内容を確認してください");
  const field = fields[0];
  if (field !== "selectedGiftKey" && typeof input[field] !== "boolean")
    throw new RewardError("発送状態を確認してください");
  if (
    field === "selectedGiftKey" &&
    (typeof input[field] !== "string" || input[field].length > 500)
  )
    throw new RewardError("ギフトを選択してください");
  const report = await dailyGiftRewards(store, input);
  const person = report.items.find((item) => item.userId === input.userId);
  if (!person)
    throw new RewardError("この日の5,000コイン達成者ではありません", 404);
  if (field !== "chipShipped" && !rewardTiers(person.coins).card)
    throw new RewardError("カードは10,000コイン達成者が対象です");
  if (
    field === "selectedGiftKey" &&
    input[field] &&
    !person.gifts.some((gift) => gift.key === input[field])
  ) {
    throw new RewardError("この日に送られたギフトから選択してください");
  }
  const columns = {
    chipShipped: "chip_shipped",
    cardShipped: "card_shipped",
    selectedGiftKey: "selected_gift_key",
  };
  const { rows } = await store.pool.query(
    `
    INSERT INTO daily_gift_rewards (stream_username,reward_day,user_id,${columns[field]},revision)
    SELECT $1,$2::date,$3,$4,1 WHERE $5::integer = 0
      OR EXISTS (SELECT 1 FROM daily_gift_rewards WHERE stream_username=$1 AND reward_day=$2::date AND user_id=$3)
    ON CONFLICT (stream_username,reward_day,user_id) DO UPDATE SET
      ${columns[field]}=EXCLUDED.${columns[field]}, revision=daily_gift_rewards.revision+1, updated_at=NOW()
    WHERE daily_gift_rewards.revision=$5
    RETURNING chip_shipped AS "chipShipped",card_shipped AS "cardShipped",selected_gift_key AS "selectedGiftKey",revision
  `,
    [report.username, input.day, input.userId, input[field], input.revision],
  );
  if (!rows.length)
    throw new RewardError(
      "別の画面で更新されています。再読み込みしてから操作してください。",
      409,
    );
  return rows[0];
}

export async function mergeGiftRewards(client, sourceId, targetId) {
  await client.query(
    `INSERT INTO daily_gift_rewards
    (stream_username,reward_day,user_id,chip_shipped,card_shipped,selected_gift_key,revision,updated_at)
    SELECT stream_username,reward_day,$2,chip_shipped,card_shipped,selected_gift_key,revision+1,updated_at
    FROM daily_gift_rewards WHERE user_id=$1
    ON CONFLICT (stream_username,reward_day,user_id) DO UPDATE SET
      chip_shipped=daily_gift_rewards.chip_shipped OR EXCLUDED.chip_shipped,
      card_shipped=daily_gift_rewards.card_shipped OR EXCLUDED.card_shipped,
      selected_gift_key=CASE WHEN EXCLUDED.updated_at > daily_gift_rewards.updated_at
        THEN EXCLUDED.selected_gift_key ELSE daily_gift_rewards.selected_gift_key END,
      revision=GREATEST(daily_gift_rewards.revision,EXCLUDED.revision)+1, updated_at=NOW()`,
    [sourceId, targetId],
  );
  await client.query("DELETE FROM daily_gift_rewards WHERE user_id=$1", [
    sourceId,
  ]);
}
