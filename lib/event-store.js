import { createHash, randomUUID } from "node:crypto";
import { buildContributionRankings } from "./contribution-rank.js";

const MAX_QUERY_ROWS = 200;
const CONTRIBUTION_RANK_CACHE_MS = 5 * 60 * 1000;

export class EventStore {
  constructor({ connectionString = "", ssl } = {}) {
    this.connectionString = String(connectionString || "").trim();
    this.ssl = ssl;
    this.pool = null;
    this.ready = false;
    this.lastError = "";
    this.initPromise = null;
    this.contributionRankCache = new Map();
    this.contributionRankPromises = new Map();
  }

  async init() {
    if (!this.connectionString) return false;
    if (this.ready && this.pool) return true;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async ensureReady() {
    return this.ready && this.pool ? true : this.init();
  }

  async initialize() {
    await this.close();
    let pool = null;
    try {
      const { Pool } = await import("pg");
      const useSsl = this.ssl ?? !/localhost|127\.0\.0\.1/i.test(this.connectionString);
      pool = new Pool({
        connectionString: this.connectionString,
        ssl: useSsl ? { rejectUnauthorized: false } : false,
        max: 5,
        connectionTimeoutMillis: 10000
      });
      pool.on("error", (error) => {
        if (this.pool !== pool) return;
        this.rememberError(error);
      });
      this.pool = pool;
      await pool.query(`
        CREATE TABLE IF NOT EXISTS live_sessions (
          id UUID PRIMARY KEY,
          stream_username TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL DEFAULT 'legacy',
          status TEXT NOT NULL DEFAULT 'connecting',
          auto_resume BOOLEAN NOT NULL DEFAULT TRUE,
          room_id TEXT NOT NULL DEFAULT '',
          started_at TIMESTAMPTZ NOT NULL,
          connected_at TIMESTAMPTZ,
          stopped_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS live_sessions_resume_idx
          ON live_sessions (auto_resume, status, updated_at DESC);
        ALTER TABLE live_sessions
          ADD COLUMN IF NOT EXISTS room_id TEXT NOT NULL DEFAULT '';
        CREATE TABLE IF NOT EXISTS live_events (
          event_key TEXT PRIMARY KEY,
          session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          stream_username TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_at TIMESTAMPTZ NOT NULL,
          user_id TEXT NOT NULL DEFAULT '',
          nickname TEXT NOT NULL DEFAULT '',
          comment_text TEXT NOT NULL DEFAULT '',
          gift_id TEXT NOT NULL DEFAULT '',
          gift_name TEXT NOT NULL DEFAULT '',
          item_count INTEGER NOT NULL DEFAULT 0,
          diamonds INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'live',
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS live_events_stream_time_idx
          ON live_events (stream_username, event_at DESC);
        CREATE INDEX IF NOT EXISTS live_events_gift_idx
          ON live_events (event_type, gift_id, gift_name, event_at DESC);
        CREATE INDEX IF NOT EXISTS live_events_user_type_time_idx
          ON live_events (user_id, event_type, event_at DESC);
        CREATE TABLE IF NOT EXISTS viewer_visits (
          session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          stream_username TEXT NOT NULL,
          user_id TEXT NOT NULL,
          nickname TEXT NOT NULL DEFAULT '',
          first_seen_at TIMESTAMPTZ NOT NULL,
          last_seen_at TIMESTAMPTZ NOT NULL,
          first_source TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (session_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS viewer_visits_lookup_idx
          ON viewer_visits (stream_username, user_id, first_seen_at DESC);
        CREATE INDEX IF NOT EXISTS viewer_visits_user_time_idx
          ON viewer_visits (user_id, first_seen_at DESC);
        CREATE INDEX IF NOT EXISTS viewer_visits_stream_time_idx
          ON viewer_visits (stream_username, last_seen_at DESC);
        ALTER TABLE live_events
          ADD COLUMN IF NOT EXISTS unique_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE live_events
          ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '';
        ALTER TABLE live_events
          ADD COLUMN IF NOT EXISTS is_heart_me BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE live_events
        SET is_heart_me = TRUE
        WHERE event_type = 'gift'
          AND is_heart_me = FALSE
          AND (
            LOWER(gift_name) ~ 'heart[[:space:]_.・-]*me'
            OR gift_name LIKE '%ハートミー%'
          );
        CREATE INDEX IF NOT EXISTS live_events_heart_me_idx
          ON live_events (stream_username, user_id, event_at DESC)
          WHERE is_heart_me = TRUE;
        CREATE TABLE IF NOT EXISTS listeners (
          user_id TEXT PRIMARY KEY,
          latest_unique_id TEXT NOT NULL DEFAULT '',
          latest_nickname TEXT NOT NULL DEFAULT '',
          avatar_url TEXT NOT NULL DEFAULT '',
          first_seen_at TIMESTAMPTZ NOT NULL,
          last_seen_at TIMESTAMPTZ NOT NULL,
          is_super_fan BOOLEAN NOT NULL DEFAULT FALSE,
          notes TEXT NOT NULL DEFAULT '',
          tags JSONB NOT NULL DEFAULT '[]'::jsonb,
          manually_updated_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE listeners
          ADD COLUMN IF NOT EXISTS avatar_data BYTEA;
        ALTER TABLE listeners
          ADD COLUMN IF NOT EXISTS avatar_mime TEXT NOT NULL DEFAULT '';
        ALTER TABLE listeners
          ADD COLUMN IF NOT EXISTS needs_attention BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE listeners
          ADD COLUMN IF NOT EXISTS host_follow_status TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE listeners
          ADD COLUMN IF NOT EXISTS host_follow_status_updated_at TIMESTAMPTZ;
        ALTER TABLE listeners
          ADD COLUMN IF NOT EXISTS profile_follower_count BIGINT;
        ALTER TABLE listeners
          ADD COLUMN IF NOT EXISTS profile_following_count BIGINT;
        ALTER TABLE listeners
          ADD COLUMN IF NOT EXISTS profile_counts_updated_at TIMESTAMPTZ;
        CREATE INDEX IF NOT EXISTS listeners_last_seen_idx
          ON listeners (last_seen_at DESC);
        CREATE INDEX IF NOT EXISTS listeners_unique_id_idx
          ON listeners (LOWER(latest_unique_id));
        CREATE TABLE IF NOT EXISTS listener_aliases (
          user_id TEXT NOT NULL REFERENCES listeners(user_id) ON DELETE CASCADE,
          unique_id TEXT NOT NULL DEFAULT '',
          nickname TEXT NOT NULL DEFAULT '',
          first_seen_at TIMESTAMPTZ NOT NULL,
          last_seen_at TIMESTAMPTZ NOT NULL,
          seen_count BIGINT NOT NULL DEFAULT 1,
          PRIMARY KEY (user_id, unique_id, nickname)
        );
        CREATE INDEX IF NOT EXISTS listener_aliases_unique_idx
          ON listener_aliases (LOWER(unique_id));
        CREATE TABLE IF NOT EXISTS listener_stream_stats (
          stream_username TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES listeners(user_id) ON DELETE CASCADE,
          visit_count BIGINT NOT NULL DEFAULT 0,
          comment_count BIGINT NOT NULL DEFAULT 0,
          gift_count BIGINT NOT NULL DEFAULT 0,
          gift_coins BIGINT NOT NULL DEFAULT 0,
          share_count BIGINT NOT NULL DEFAULT 0,
          like_count BIGINT NOT NULL DEFAULT 0,
          follow_count BIGINT NOT NULL DEFAULT 0,
          subscribe_count BIGINT NOT NULL DEFAULT 0,
          join_count BIGINT NOT NULL DEFAULT 0,
          first_seen_at TIMESTAMPTZ NOT NULL,
          last_seen_at TIMESTAMPTZ NOT NULL,
          last_comment_at TIMESTAMPTZ,
          last_gift_at TIMESTAMPTZ,
          PRIMARY KEY (stream_username, user_id)
        );
        CREATE INDEX IF NOT EXISTS listener_stream_stats_rank_idx
          ON listener_stream_stats (stream_username, gift_coins DESC, comment_count DESC);
        CREATE INDEX IF NOT EXISTS listener_stream_stats_user_idx
          ON listener_stream_stats (user_id);
        CREATE TABLE IF NOT EXISTS listener_stamps (
          id UUID PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES listeners(user_id) ON DELETE CASCADE,
          stamp_type TEXT NOT NULL DEFAULT 'standard',
          quantity INTEGER NOT NULL DEFAULT 1,
          source TEXT NOT NULL DEFAULT 'manual',
          note TEXT NOT NULL DEFAULT '',
          stamped_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE listener_stamps
          ADD COLUMN IF NOT EXISTS external_key TEXT NOT NULL DEFAULT '';
        CREATE INDEX IF NOT EXISTS listener_stamps_user_idx
          ON listener_stamps (user_id, stamped_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS listener_stamps_external_key_idx
          ON listener_stamps (external_key) WHERE external_key <> '';
        CREATE TABLE IF NOT EXISTS receipt_prints (
          id UUID PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES listeners(user_id) ON DELETE CASCADE,
          gift_id TEXT NOT NULL DEFAULT '',
          gift_name TEXT NOT NULL DEFAULT '',
          item_count INTEGER NOT NULL DEFAULT 0,
          coins INTEGER NOT NULL DEFAULT 0,
          template_id TEXT NOT NULL DEFAULT '',
          printed_at TIMESTAMPTZ NOT NULL,
          source TEXT NOT NULL DEFAULT 'receipt-app',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE receipt_prints
          ADD COLUMN IF NOT EXISTS external_event_id TEXT NOT NULL DEFAULT '';
        CREATE INDEX IF NOT EXISTS receipt_prints_user_idx
          ON receipt_prints (user_id, printed_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS receipt_prints_external_event_idx
          ON receipt_prints (external_event_id) WHERE external_event_id <> '';
        CREATE TABLE IF NOT EXISTS shared_app_states (
          state_key TEXT PRIMARY KEY,
          state JSONB NOT NULL DEFAULT '{}'::jsonb,
          revision BIGINT NOT NULL DEFAULT 0,
          source_revision BIGINT NOT NULL DEFAULT 0,
          super_fan_revision TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      try {
        await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS listeners_search_trgm_idx
          ON listeners USING GIN (
            (LOWER(user_id || ' ' || latest_unique_id || ' ' || latest_nickname || ' ' || notes)) gin_trgm_ops
          )
        `);
      } catch (searchIndexError) {
        console.warn(`Listener search index unavailable: ${String(searchIndexError?.message || searchIndexError).slice(0, 160)}`);
      }
      this.ready = true;
      this.lastError = "";
      return true;
    } catch (error) {
      this.rememberError(error, { unavailable: true });
      if (this.pool === pool) await this.close();
      else await pool?.end().catch(() => {});
      return false;
    }
  }

  rememberError(error, { unavailable = false } = {}) {
    this.lastError = shortError(error);
    if (unavailable || /ECONN|ETIMEDOUT|connection terminated|connection closed|socket hang up/i.test(this.lastError)) {
      this.ready = false;
    }
  }

  status() {
    return {
      configured: Boolean(this.connectionString),
      ready: this.ready,
      lastError: this.lastError
    };
  }

  async saveSession(session, { autoResume = true } = {}) {
    if (!this.ready) return false;
    try {
      await this.pool.query(`
        INSERT INTO live_sessions (
          id, stream_username, display_name, provider, status, auto_resume,
          room_id, started_at, connected_at, stopped_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          provider = EXCLUDED.provider,
          status = EXCLUDED.status,
          auto_resume = EXCLUDED.auto_resume,
          room_id = CASE
            WHEN EXCLUDED.room_id <> '' THEN EXCLUDED.room_id
            ELSE live_sessions.room_id
          END,
          connected_at = EXCLUDED.connected_at,
          stopped_at = EXCLUDED.stopped_at,
          updated_at = NOW()
      `, [
        session.id,
        session.username,
        session.displayName || session.username,
        session.provider || "legacy",
        session.status,
        Boolean(autoResume && !session.stoppedAt),
        String(session.roomId || ""),
        new Date(session.startedAt),
        session.connectedAt ? new Date(session.connectedAt) : null,
        session.stoppedAt ? new Date(session.stoppedAt) : null
      ]);
      return true;
    } catch (error) {
      this.rememberError(error);
      return false;
    }
  }

  async recordEvent(session, event) {
    if (!this.ready || !event?.type || !event?.id) return false;
    try {
      event.userId = await this.resolveListenerId(event.userId, event.uniqueId);
      const payload = event.payload && typeof event.payload === "object" ? { ...event.payload } : {};
      if (event.giftImageUrl) payload.giftImageUrl = String(event.giftImageUrl).slice(0, 2000);
      const profile = listenerProfileFromEvent(event);
      await this.pool.query(`
        WITH inserted AS (
          INSERT INTO live_events (
            event_key, session_id, stream_username, event_type, event_at,
            user_id, unique_id, nickname, avatar_url, comment_text, gift_id, gift_name,
            item_count, diamonds, source, is_heart_me, payload
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
          ON CONFLICT (event_key) DO NOTHING
          RETURNING *
        ), upsert_listener AS (
          INSERT INTO listeners (
            user_id, latest_unique_id, latest_nickname, avatar_url,
            first_seen_at, last_seen_at, host_follow_status, host_follow_status_updated_at,
            profile_follower_count, profile_following_count, profile_counts_updated_at, updated_at
          )
          SELECT user_id, unique_id, nickname, avatar_url, event_at, event_at,
            COALESCE($18::text, 'unknown'), $19::timestamptz,
            $20::bigint, $21::bigint, $22::timestamptz, NOW()
          FROM inserted WHERE user_id <> ''
          ON CONFLICT (user_id) DO UPDATE SET
            latest_unique_id = CASE WHEN EXCLUDED.latest_unique_id <> '' THEN EXCLUDED.latest_unique_id ELSE listeners.latest_unique_id END,
            latest_nickname = CASE WHEN EXCLUDED.latest_nickname <> '' THEN EXCLUDED.latest_nickname ELSE listeners.latest_nickname END,
            avatar_url = CASE WHEN EXCLUDED.avatar_url <> '' THEN EXCLUDED.avatar_url ELSE listeners.avatar_url END,
            first_seen_at = LEAST(listeners.first_seen_at, EXCLUDED.first_seen_at),
            last_seen_at = GREATEST(listeners.last_seen_at, EXCLUDED.last_seen_at),
            host_follow_status = CASE
              WHEN EXCLUDED.host_follow_status_updated_at IS NOT NULL
                AND (listeners.host_follow_status_updated_at IS NULL OR EXCLUDED.host_follow_status_updated_at >= listeners.host_follow_status_updated_at)
              THEN EXCLUDED.host_follow_status ELSE listeners.host_follow_status END,
            host_follow_status_updated_at = GREATEST(listeners.host_follow_status_updated_at, EXCLUDED.host_follow_status_updated_at),
            profile_follower_count = CASE
              WHEN EXCLUDED.profile_counts_updated_at IS NOT NULL
                AND (listeners.profile_counts_updated_at IS NULL OR EXCLUDED.profile_counts_updated_at >= listeners.profile_counts_updated_at)
                AND EXCLUDED.profile_follower_count IS NOT NULL
              THEN EXCLUDED.profile_follower_count ELSE listeners.profile_follower_count END,
            profile_following_count = CASE
              WHEN EXCLUDED.profile_counts_updated_at IS NOT NULL
                AND (listeners.profile_counts_updated_at IS NULL OR EXCLUDED.profile_counts_updated_at >= listeners.profile_counts_updated_at)
                AND EXCLUDED.profile_following_count IS NOT NULL
              THEN EXCLUDED.profile_following_count ELSE listeners.profile_following_count END,
            profile_counts_updated_at = GREATEST(listeners.profile_counts_updated_at, EXCLUDED.profile_counts_updated_at),
            updated_at = NOW()
          RETURNING user_id
        ), upsert_alias AS (
          INSERT INTO listener_aliases (
            user_id, unique_id, nickname, first_seen_at, last_seen_at, seen_count
          )
          SELECT user_id, unique_id, nickname, event_at, event_at, 1
          FROM inserted WHERE user_id <> ''
          ON CONFLICT (user_id, unique_id, nickname) DO UPDATE SET
            first_seen_at = LEAST(listener_aliases.first_seen_at, EXCLUDED.first_seen_at),
            last_seen_at = GREATEST(listener_aliases.last_seen_at, EXCLUDED.last_seen_at),
            seen_count = listener_aliases.seen_count + 1
          RETURNING user_id
        )
        INSERT INTO listener_stream_stats (
          stream_username, user_id, comment_count, gift_count, gift_coins,
          share_count, like_count, follow_count, subscribe_count, join_count,
          first_seen_at, last_seen_at, last_comment_at, last_gift_at
        )
        SELECT
          stream_username, user_id,
          CASE WHEN event_type = 'comment' THEN 1 ELSE 0 END,
          CASE WHEN event_type = 'gift' THEN item_count ELSE 0 END,
          CASE WHEN event_type = 'gift' THEN diamonds ELSE 0 END,
          CASE WHEN event_type = 'share' THEN 1 ELSE 0 END,
          CASE WHEN event_type = 'like' THEN GREATEST(item_count, 1) ELSE 0 END,
          CASE WHEN event_type = 'follow' THEN 1 ELSE 0 END,
          CASE WHEN event_type = 'subscribe' THEN 1 ELSE 0 END,
          CASE WHEN event_type = 'join' THEN 1 ELSE 0 END,
          event_at, event_at,
          CASE WHEN event_type = 'comment' THEN event_at ELSE NULL END,
          CASE WHEN event_type = 'gift' THEN event_at ELSE NULL END
        FROM inserted WHERE user_id <> ''
        ON CONFLICT (stream_username, user_id) DO UPDATE SET
          comment_count = listener_stream_stats.comment_count + EXCLUDED.comment_count,
          gift_count = listener_stream_stats.gift_count + EXCLUDED.gift_count,
          gift_coins = listener_stream_stats.gift_coins + EXCLUDED.gift_coins,
          share_count = listener_stream_stats.share_count + EXCLUDED.share_count,
          like_count = listener_stream_stats.like_count + EXCLUDED.like_count,
          follow_count = listener_stream_stats.follow_count + EXCLUDED.follow_count,
          subscribe_count = listener_stream_stats.subscribe_count + EXCLUDED.subscribe_count,
          join_count = listener_stream_stats.join_count + EXCLUDED.join_count,
          first_seen_at = LEAST(listener_stream_stats.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(listener_stream_stats.last_seen_at, EXCLUDED.last_seen_at),
          last_comment_at = GREATEST(listener_stream_stats.last_comment_at, EXCLUDED.last_comment_at),
          last_gift_at = GREATEST(listener_stream_stats.last_gift_at, EXCLUDED.last_gift_at)
      `, [
        `${session.id}:${event.id}`,
        session.id,
        session.username,
        event.type,
        new Date(event.at || Date.now()),
        event.userId || "",
        event.uniqueId || "",
        event.nickname || "",
        event.avatarUrl || "",
        event.text || "",
        String(event.giftId || ""),
        event.giftName || "",
        Math.max(0, Number(event.count || event.repeatCount || event.likeCount || 0)),
        Math.max(0, Number(event.diamonds || event.totalDiamonds || 0)),
        event.source || "live",
        Boolean(event.isHeartMe),
        JSON.stringify(payload),
        profile.followStatus,
        profile.followStatus ? new Date(event.at || Date.now()) : null,
        profile.followerCount,
        profile.followingCount,
        profile.hasCounts ? new Date(event.at || Date.now()) : null
      ]);
      return true;
    } catch (error) {
      this.rememberError(error);
      return false;
    }
  }

  async resolveListenerId(rawUserId, rawUniqueId) {
    const userId = String(rawUserId || "").trim();
    const uniqueId = String(rawUniqueId || "").trim();
    if (!this.ready || !/^\d{5,}$/.test(userId) || !uniqueId) return userId;
    const match = await this.pool.query(`
      SELECT user_id FROM listeners
      WHERE user_id <> $1
        AND (LOWER(latest_unique_id) = LOWER($2) OR user_id = $3)
      ORDER BY CASE WHEN user_id = $3 THEN 0 ELSE 1 END, last_seen_at DESC
      LIMIT 1
    `, [userId, uniqueId, `username:${uniqueId.toLowerCase()}`]);
    const sourceId = String(match.rows[0]?.user_id || "");
    if (sourceId && sourceId !== userId) await this.mergeListenerRecords(sourceId, userId);
    return userId;
  }

  async mergeListenerRecords(sourceId, targetId) {
    if (!this.ready || !sourceId || !targetId || sourceId === targetId) return false;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO listeners (
          user_id, latest_unique_id, latest_nickname, avatar_url, avatar_data, avatar_mime,
          first_seen_at, last_seen_at, is_super_fan, notes, tags,
          host_follow_status, host_follow_status_updated_at,
          profile_follower_count, profile_following_count, profile_counts_updated_at,
          manually_updated_at, created_at, updated_at
        )
        SELECT $2, latest_unique_id, latest_nickname, avatar_url, avatar_data, avatar_mime,
          first_seen_at, last_seen_at, is_super_fan, notes, tags,
          host_follow_status, host_follow_status_updated_at,
          profile_follower_count, profile_following_count, profile_counts_updated_at,
          manually_updated_at, created_at, NOW()
        FROM listeners WHERE user_id = $1
        ON CONFLICT (user_id) DO UPDATE SET
          latest_unique_id = CASE WHEN listeners.latest_unique_id = '' THEN EXCLUDED.latest_unique_id ELSE listeners.latest_unique_id END,
          latest_nickname = CASE WHEN listeners.latest_nickname = '' THEN EXCLUDED.latest_nickname ELSE listeners.latest_nickname END,
          avatar_url = CASE WHEN listeners.avatar_url = '' THEN EXCLUDED.avatar_url ELSE listeners.avatar_url END,
          avatar_data = COALESCE(listeners.avatar_data, EXCLUDED.avatar_data),
          avatar_mime = CASE WHEN listeners.avatar_mime = '' THEN EXCLUDED.avatar_mime ELSE listeners.avatar_mime END,
          first_seen_at = LEAST(listeners.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(listeners.last_seen_at, EXCLUDED.last_seen_at),
          is_super_fan = listeners.is_super_fan OR EXCLUDED.is_super_fan,
          host_follow_status = CASE
            WHEN EXCLUDED.host_follow_status_updated_at IS NOT NULL
              AND (listeners.host_follow_status_updated_at IS NULL OR EXCLUDED.host_follow_status_updated_at > listeners.host_follow_status_updated_at)
            THEN EXCLUDED.host_follow_status ELSE listeners.host_follow_status END,
          host_follow_status_updated_at = GREATEST(listeners.host_follow_status_updated_at, EXCLUDED.host_follow_status_updated_at),
          profile_follower_count = CASE
            WHEN EXCLUDED.profile_counts_updated_at IS NOT NULL
              AND (listeners.profile_counts_updated_at IS NULL OR EXCLUDED.profile_counts_updated_at > listeners.profile_counts_updated_at)
            THEN EXCLUDED.profile_follower_count ELSE listeners.profile_follower_count END,
          profile_following_count = CASE
            WHEN EXCLUDED.profile_counts_updated_at IS NOT NULL
              AND (listeners.profile_counts_updated_at IS NULL OR EXCLUDED.profile_counts_updated_at > listeners.profile_counts_updated_at)
            THEN EXCLUDED.profile_following_count ELSE listeners.profile_following_count END,
          profile_counts_updated_at = GREATEST(listeners.profile_counts_updated_at, EXCLUDED.profile_counts_updated_at),
          notes = CASE WHEN listeners.notes = '' THEN EXCLUDED.notes ELSE listeners.notes END,
          tags = CASE WHEN jsonb_array_length(listeners.tags) = 0 THEN EXCLUDED.tags ELSE listeners.tags END,
          updated_at = NOW()
      `, [sourceId, targetId]);
      await client.query(`
        INSERT INTO listener_stream_stats (
          stream_username, user_id, visit_count, comment_count, gift_count, gift_coins,
          share_count, like_count, follow_count, subscribe_count, join_count,
          first_seen_at, last_seen_at, last_comment_at, last_gift_at
        )
        SELECT stream_username, $2, visit_count, comment_count, gift_count, gift_coins,
          share_count, like_count, follow_count, subscribe_count, join_count,
          first_seen_at, last_seen_at, last_comment_at, last_gift_at
        FROM listener_stream_stats WHERE user_id = $1
        ON CONFLICT (stream_username, user_id) DO UPDATE SET
          visit_count = listener_stream_stats.visit_count + EXCLUDED.visit_count,
          comment_count = listener_stream_stats.comment_count + EXCLUDED.comment_count,
          gift_count = listener_stream_stats.gift_count + EXCLUDED.gift_count,
          gift_coins = listener_stream_stats.gift_coins + EXCLUDED.gift_coins,
          share_count = listener_stream_stats.share_count + EXCLUDED.share_count,
          like_count = listener_stream_stats.like_count + EXCLUDED.like_count,
          follow_count = listener_stream_stats.follow_count + EXCLUDED.follow_count,
          subscribe_count = listener_stream_stats.subscribe_count + EXCLUDED.subscribe_count,
          join_count = listener_stream_stats.join_count + EXCLUDED.join_count,
          first_seen_at = LEAST(listener_stream_stats.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(listener_stream_stats.last_seen_at, EXCLUDED.last_seen_at),
          last_comment_at = GREATEST(listener_stream_stats.last_comment_at, EXCLUDED.last_comment_at),
          last_gift_at = GREATEST(listener_stream_stats.last_gift_at, EXCLUDED.last_gift_at)
      `, [sourceId, targetId]);
      await client.query(`DELETE FROM listener_stream_stats WHERE user_id = $1`, [sourceId]);
      await client.query(`
        INSERT INTO listener_aliases (user_id, unique_id, nickname, first_seen_at, last_seen_at, seen_count)
        SELECT $2, unique_id, nickname, first_seen_at, last_seen_at, seen_count
        FROM listener_aliases WHERE user_id = $1
        ON CONFLICT (user_id, unique_id, nickname) DO UPDATE SET
          first_seen_at = LEAST(listener_aliases.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(listener_aliases.last_seen_at, EXCLUDED.last_seen_at),
          seen_count = listener_aliases.seen_count + EXCLUDED.seen_count
      `, [sourceId, targetId]);
      await client.query(`DELETE FROM listener_aliases WHERE user_id = $1`, [sourceId]);
      await client.query(`UPDATE listener_stamps SET user_id = $2 WHERE user_id = $1`, [sourceId, targetId]);
      await client.query(`UPDATE receipt_prints SET user_id = $2 WHERE user_id = $1`, [sourceId, targetId]);
      await client.query(`UPDATE live_events SET user_id = $2 WHERE user_id = $1`, [sourceId, targetId]);
      await client.query(`
        INSERT INTO viewer_visits (session_id, stream_username, user_id, nickname, first_seen_at, last_seen_at, first_source)
        SELECT session_id, stream_username, $2, nickname, first_seen_at, last_seen_at, first_source
        FROM viewer_visits WHERE user_id = $1
        ON CONFLICT (session_id, user_id) DO UPDATE SET
          first_seen_at = LEAST(viewer_visits.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(viewer_visits.last_seen_at, EXCLUDED.last_seen_at),
          nickname = CASE WHEN viewer_visits.nickname = '' THEN EXCLUDED.nickname ELSE viewer_visits.nickname END
      `, [sourceId, targetId]);
      await client.query(`DELETE FROM viewer_visits WHERE user_id = $1`, [sourceId]);
      await client.query(`DELETE FROM listeners WHERE user_id = $1`, [sourceId]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      this.rememberError(error);
      return false;
    } finally {
      client.release();
    }
  }

  async recordVisit(session, visit) {
    const fallback = {
      visitHistoryKnown: false,
      visitCount: 0,
      firstVisitAt: null,
      lastVisitAt: null,
      previousVisitAt: null,
      heartMeHistoryKnown: false,
      pastHeartMeGiftCount: 0,
      lastPastHeartMeAt: null
    };
    if (!this.ready || !visit?.userId) return fallback;
    try {
      const at = new Date(visit.at || Date.now());
      const currentVisitKey = String(session.roomId || session.id);
      await this.pool.query(`
        INSERT INTO viewer_visits (
          session_id, stream_username, user_id, nickname,
          first_seen_at, last_seen_at, first_source
        )
        VALUES ($1, $2, $3, $4, $5, $5, $6)
        ON CONFLICT (session_id, user_id) DO UPDATE SET
          nickname = EXCLUDED.nickname,
          last_seen_at = GREATEST(viewer_visits.last_seen_at, EXCLUDED.last_seen_at)
      `, [
        session.id,
        session.username,
        String(visit.userId),
        visit.nickname || "",
        at,
        visit.source || ""
      ]);
      const result = await this.pool.query(`
        SELECT
          COUNT(DISTINCT COALESCE(NULLIF(s.room_id, ''), v.session_id::text))::bigint AS "visitCount",
          MIN(v.first_seen_at) AS "firstVisitAt",
          MAX(v.last_seen_at) AS "lastVisitAt",
          MAX(v.last_seen_at) FILTER (
            WHERE COALESCE(NULLIF(s.room_id, ''), v.session_id::text) <> $3
          ) AS "previousVisitAt"
        FROM viewer_visits v
        JOIN live_sessions s ON s.id = v.session_id
        WHERE LOWER(v.stream_username) = LOWER($1)
          AND v.user_id = $2
      `, [session.username, String(visit.userId), currentVisitKey]);
      const row = result.rows[0] || {};
      const heartMeHistoryPromise = this.heartMeHistory({
        sessionId: session.id,
        roomId: session.roomId,
        username: session.username,
        userId: String(visit.userId)
      });
      const listenerSyncPromise = this.pool.query(`
        WITH upsert_listener AS (
        INSERT INTO listeners (
          user_id, latest_unique_id, latest_nickname, avatar_url,
          first_seen_at, last_seen_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $5, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          latest_unique_id = CASE WHEN EXCLUDED.latest_unique_id <> '' THEN EXCLUDED.latest_unique_id ELSE listeners.latest_unique_id END,
          latest_nickname = CASE WHEN EXCLUDED.latest_nickname <> '' THEN EXCLUDED.latest_nickname ELSE listeners.latest_nickname END,
          avatar_url = CASE WHEN EXCLUDED.avatar_url <> '' THEN EXCLUDED.avatar_url ELSE listeners.avatar_url END,
          first_seen_at = LEAST(listeners.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(listeners.last_seen_at, EXCLUDED.last_seen_at),
          updated_at = NOW()
        RETURNING user_id
        )
        INSERT INTO listener_stream_stats (
          stream_username, user_id, visit_count, first_seen_at, last_seen_at
        ) SELECT $6, user_id, $7, $5, $5 FROM upsert_listener
        ON CONFLICT (stream_username, user_id) DO UPDATE SET
          visit_count = GREATEST(listener_stream_stats.visit_count, EXCLUDED.visit_count),
          first_seen_at = LEAST(listener_stream_stats.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(listener_stream_stats.last_seen_at, EXCLUDED.last_seen_at)
      `, [
        String(visit.userId),
        String(visit.uniqueId || "").slice(0, 120),
        visit.nickname || "",
        String(visit.avatarUrl || "").slice(0, 1000),
        at,
        session.username,
        Math.max(1, Number(row.visitCount || 1))
      ]);
      const [heartMeHistory] = await Promise.all([heartMeHistoryPromise, listenerSyncPromise]);
      return {
        visitHistoryKnown: true,
        visitCount: Math.max(1, Number(row.visitCount || 1)),
        firstVisitAt: row.firstVisitAt ? new Date(row.firstVisitAt).getTime() : fallback.firstVisitAt,
        lastVisitAt: row.lastVisitAt ? new Date(row.lastVisitAt).getTime() : fallback.lastVisitAt,
        previousVisitAt: row.previousVisitAt ? new Date(row.previousVisitAt).getTime() : null,
        heartMeHistoryKnown: heartMeHistory.known,
        pastHeartMeGiftCount: heartMeHistory.pastCount,
        lastPastHeartMeAt: heartMeHistory.lastAt
      };
    } catch (error) {
      this.rememberError(error);
      return fallback;
    }
  }

  async heartMeHistory({ sessionId = "", roomId = "", username = "", userId = "" } = {}) {
    const fallback = { known: false, pastCount: 0, lastAt: null };
    if (!this.ready || !username || !userId) return fallback;
    try {
      const currentLiveKey = String(roomId || sessionId);
      const result = await this.pool.query(`
        SELECT
          COALESCE(SUM(GREATEST(e.item_count, 1)), 0)::bigint AS "pastCount",
          MAX(e.event_at) AS "lastAt"
        FROM live_events e
        JOIN live_sessions s ON s.id = e.session_id
        WHERE LOWER(e.stream_username) = LOWER($1)
          AND e.user_id = $2
          AND e.is_heart_me = TRUE
          AND COALESCE(NULLIF(s.room_id, ''), e.session_id::text) <> $3
      `, [username, userId, currentLiveKey]);
      const row = result.rows[0] || {};
      return {
        known: true,
        pastCount: Math.max(0, Number(row.pastCount || 0)),
        lastAt: row.lastAt ? new Date(row.lastAt).getTime() : null
      };
    } catch (error) {
      this.rememberError(error);
      return fallback;
    }
  }

  async priorListenerHistory({ sessionId = "", roomId = "", username = "", userId = "", uniqueId = "" } = {}) {
    const fallback = { known: false, priorVisitCount: 0, lastPriorVisitAt: null };
    if (!this.ready || !username || (!userId && !uniqueId)) return fallback;
    try {
      const currentLiveKey = String(roomId || sessionId);
      const result = await this.pool.query(`
        WITH identity_ids AS (
          SELECT $2::text AS user_id WHERE $2 <> ''
          UNION
          SELECT user_id FROM listeners
          WHERE $3 <> '' AND LOWER(latest_unique_id) = LOWER($3)
          UNION
          SELECT user_id FROM listener_aliases
          WHERE $3 <> '' AND LOWER(unique_id) = LOWER($3)
        ), prior_records AS (
          SELECT COALESCE(NULLIF(s.room_id, ''), v.session_id::text) AS live_key,
                 v.last_seen_at AS seen_at
          FROM viewer_visits v
          JOIN live_sessions s ON s.id = v.session_id
          WHERE LOWER(v.stream_username) = LOWER($1)
            AND v.user_id IN (SELECT user_id FROM identity_ids)
            AND COALESCE(NULLIF(s.room_id, ''), v.session_id::text) <> $4
          UNION ALL
          SELECT COALESCE(NULLIF(s.room_id, ''), e.session_id::text) AS live_key,
                 e.event_at AS seen_at
          FROM live_events e
          JOIN live_sessions s ON s.id = e.session_id
          WHERE LOWER(e.stream_username) = LOWER($1)
            AND e.user_id IN (SELECT user_id FROM identity_ids)
            AND COALESCE(NULLIF(s.room_id, ''), e.session_id::text) <> $4
        ), prior_lives AS (
          SELECT live_key, MAX(seen_at) AS seen_at
          FROM prior_records
          GROUP BY live_key
        )
        SELECT COUNT(*)::bigint AS "priorVisitCount",
               MAX(seen_at) AS "lastPriorVisitAt"
        FROM prior_lives
      `, [username, String(userId || ""), String(uniqueId || "").replace(/^@/, ""), currentLiveKey]);
      const row = result.rows[0] || {};
      return {
        known: true,
        priorVisitCount: Math.max(0, Number(row.priorVisitCount || 0)),
        lastPriorVisitAt: row.lastPriorVisitAt ? new Date(row.lastPriorVisitAt).getTime() : null,
      };
    } catch (error) {
      this.rememberError(error);
      return fallback;
    }
  }

  async giftCatalog({ sessionId = "", username = "" } = {}) {
    if (!this.ready) return [];
    const clauses = ["event_type = 'gift'"];
    const values = [];
    if (sessionId) {
      values.push(sessionId);
      clauses.push(`session_id = $${values.length}`);
    } else if (username) {
      values.push(username);
      clauses.push(`stream_username = $${values.length}`);
    }
    const result = await this.pool.query(`
      SELECT gift_id AS "giftId", gift_name AS "giftName",
             SUM(item_count)::bigint AS count,
             MAX(event_at) AS "lastGiftAt"
      FROM live_events
      WHERE ${clauses.join(" AND ")}
      GROUP BY gift_id, gift_name
      ORDER BY MAX(event_at) DESC
      LIMIT ${MAX_QUERY_ROWS}
    `, values);
    return result.rows.map(normalizeNumericRow);
  }

  async giftRanking({ sessionId = "", username = "", giftId = "", giftName = "", range = "session" } = {}) {
    if (!this.ready) return [];
    const clauses = ["event_type = 'gift'"];
    const values = [];
    if (range === "session") {
      values.push(sessionId);
      clauses.push(`session_id = $${values.length}`);
    } else {
      values.push(username);
      clauses.push(`stream_username = $${values.length}`);
      const from = rangeStart(range);
      if (from) {
        values.push(from);
        clauses.push(`event_at >= $${values.length}`);
      }
    }
    if (giftId) {
      values.push(String(giftId));
      clauses.push(`gift_id = $${values.length}`);
    } else if (giftName) {
      values.push(giftName);
      clauses.push(`gift_name = $${values.length}`);
    }
    const result = await this.pool.query(`
      SELECT user_id AS "userId", MAX(nickname) AS nickname,
             SUM(item_count)::bigint AS count,
             SUM(diamonds)::bigint AS diamonds,
             MAX(event_at) AS "lastGiftAt"
      FROM live_events
      WHERE ${clauses.join(" AND ")}
      GROUP BY user_id
      ORDER BY SUM(item_count) DESC, SUM(diamonds) DESC, MAX(event_at) DESC
      LIMIT ${MAX_QUERY_ROWS}
    `, values);
    return result.rows.map(normalizeNumericRow);
  }

  async restorableSessions(maxAgeHours = 12) {
    if (!this.ready) return [];
    const result = await this.pool.query(`
      SELECT s.id, s.stream_username AS username, s.room_id AS "roomId", s.started_at AS "startedAt",
        s.updated_at AS "lastCollectorAt",
        (SELECT MAX(e.event_at) FROM live_events e WHERE e.session_id = s.id) AS "lastCollectorEventAt"
      FROM live_sessions s
      WHERE auto_resume = TRUE
        AND status IN ('connecting', 'live', 'disconnected', 'waiting')
        AND s.updated_at >= NOW() - ($1::double precision * INTERVAL '1 hour')
      ORDER BY s.updated_at DESC
    `, [Math.max(1, Number(maxAgeHours || 12))]);
    return result.rows;
  }

  async listenerSummary({ username = "" } = {}) {
    if (!this.ready) return emptyListenerSummary();
    const result = await this.pool.query(`
      WITH totals AS (
        SELECT user_id,
          SUM(visit_count)::bigint AS visits,
          SUM(comment_count)::bigint AS comments,
          SUM(gift_count)::bigint AS gifts,
          SUM(gift_coins)::bigint AS coins,
          SUM(share_count)::bigint AS shares,
          MAX(last_seen_at) AS last_seen_at
        FROM listener_stream_stats
        WHERE ($1 = '' OR LOWER(stream_username) = LOWER($1))
        GROUP BY user_id
      )
      SELECT
        COUNT(*)::bigint AS listeners,
        COUNT(*) FILTER (WHERE l.is_super_fan)::bigint AS "superFans",
        COUNT(*) FILTER (WHERE l.avatar_data IS NOT NULL)::bigint AS avatars,
        COALESCE(SUM(t.visits), 0)::bigint AS visits,
        COALESCE(SUM(t.comments), 0)::bigint AS comments,
        COALESCE(SUM(t.gifts), 0)::bigint AS gifts,
        COALESCE(SUM(t.coins), 0)::bigint AS coins,
        COALESCE(SUM(t.shares), 0)::bigint AS shares,
        COUNT(*) FILTER (WHERE t.last_seen_at >= $2)::bigint AS "activeToday",
        COUNT(*) FILTER (WHERE t.visits >= 2)::bigint AS returning
      FROM totals t JOIN listeners l ON l.user_id = t.user_id
    `, [username, rangeStart("today")]);
    return normalizeSummaryRow(result.rows[0]);
  }

  async listeners({ username = "", search = "", sort = "last_seen", direction = "desc", limit = 100, offset = 0 } = {}) {
    if (!this.ready) return { items: [], total: 0 };
    const sortColumns = {
      last_seen: "stats_last_seen_at",
      first_seen: "stats_first_seen_at",
      visits: "visits",
      comments: "comments",
      gifts: "gifts",
      coins: "coins",
      shares: "shares",
      name: "display_name_sort"
    };
    const orderBy = sortColumns[sort] || sortColumns.last_seen;
    const orderDirection = String(direction).toLowerCase() === "asc" ? "ASC" : "DESC";
    const boundedLimit = Math.min(250, Math.max(1, Number(limit || 100)));
    const boundedOffset = Math.max(0, Number(offset || 0));
    const query = String(search || "").trim();
    const fastSortColumns = {
      last_seen: "last_seen_at",
      first_seen: "first_seen_at",
      name: "display_name_sort"
    };
    const fastOrderBy = !username ? fastSortColumns[sort] : null;
    if (fastOrderBy) {
      const fastResult = await this.pool.query(`
        WITH matched_listeners AS MATERIALIZED (
          SELECT l.user_id, l.latest_unique_id, l.latest_nickname, l.avatar_url,
            (l.avatar_data IS NOT NULL) AS avatar_cached,
            l.first_seen_at, l.last_seen_at, l.is_super_fan, l.needs_attention, l.notes, l.tags,
            l.host_follow_status, l.host_follow_status_updated_at,
            l.profile_follower_count, l.profile_following_count, l.profile_counts_updated_at,
            l.manually_updated_at, l.created_at, l.updated_at,
            LOWER(COALESCE(NULLIF(l.latest_nickname, ''), NULLIF(l.latest_unique_id, ''), l.user_id)) AS display_name_sort,
            COUNT(*) OVER()::bigint AS full_count
          FROM listeners l
          WHERE ($1 = '' OR LOWER(l.user_id || ' ' || l.latest_unique_id || ' ' || l.latest_nickname || ' ' || l.notes)
            LIKE '%' || LOWER($1) || '%')
        ), page AS MATERIALIZED (
          SELECT * FROM matched_listeners
          ORDER BY ${fastOrderBy} ${orderDirection} NULLS LAST, last_seen_at DESC
          LIMIT $2 OFFSET $3
        ), totals AS (
          SELECT s.user_id,
            SUM(visit_count)::bigint AS visits,
            SUM(comment_count)::bigint AS comments,
            SUM(gift_count)::bigint AS gifts,
            SUM(gift_coins)::bigint AS coins,
            SUM(share_count)::bigint AS shares,
            SUM(like_count)::bigint AS likes,
            SUM(follow_count)::bigint AS follows,
            MIN(s.first_seen_at) AS stats_first_seen_at,
            MAX(s.last_seen_at) AS stats_last_seen_at,
            MAX(s.last_comment_at) AS last_comment_at,
            MAX(s.last_gift_at) AS last_gift_at
          FROM listener_stream_stats s
          JOIN page p ON p.user_id = s.user_id
          GROUP BY s.user_id
        )
        SELECT p.*, t.*
        FROM page p LEFT JOIN totals t ON t.user_id = p.user_id
        ORDER BY p.${fastOrderBy} ${orderDirection} NULLS LAST, p.last_seen_at DESC
      `, [query, boundedLimit, boundedOffset]);
      return {
        items: fastResult.rows.map(normalizeListenerRow),
        total: Number(fastResult.rows[0]?.full_count || 0)
      };
    }
    const result = await this.pool.query(`
      WITH matched_listeners AS MATERIALIZED (
        SELECT l.user_id, l.latest_unique_id, l.latest_nickname, l.avatar_url,
          (l.avatar_data IS NOT NULL) AS avatar_cached,
          l.first_seen_at, l.last_seen_at, l.is_super_fan, l.needs_attention, l.notes, l.tags,
          l.host_follow_status, l.host_follow_status_updated_at,
          l.profile_follower_count, l.profile_following_count, l.profile_counts_updated_at,
          l.manually_updated_at, l.created_at, l.updated_at,
          LOWER(COALESCE(NULLIF(l.latest_nickname, ''), NULLIF(l.latest_unique_id, ''), l.user_id)) AS display_name_sort
        FROM listeners l
        WHERE ($2 = '' OR LOWER(l.user_id || ' ' || l.latest_unique_id || ' ' || l.latest_nickname || ' ' || l.notes)
          LIKE '%' || LOWER($2) || '%')
      ), totals AS (
        SELECT s.user_id,
          SUM(visit_count)::bigint AS visits,
          SUM(comment_count)::bigint AS comments,
          SUM(gift_count)::bigint AS gifts,
          SUM(gift_coins)::bigint AS coins,
          SUM(share_count)::bigint AS shares,
          SUM(like_count)::bigint AS likes,
          SUM(follow_count)::bigint AS follows,
          MIN(s.first_seen_at) AS stats_first_seen_at,
          MAX(s.last_seen_at) AS stats_last_seen_at,
          MAX(s.last_comment_at) AS last_comment_at,
          MAX(s.last_gift_at) AS last_gift_at
        FROM listener_stream_stats s
        JOIN matched_listeners m ON m.user_id = s.user_id
        WHERE ($1 = '' OR LOWER(s.stream_username) = LOWER($1))
        GROUP BY s.user_id
      ), filtered AS (
        SELECT m.*, t.*,
          COUNT(*) OVER()::bigint AS full_count
        FROM totals t JOIN matched_listeners m ON m.user_id = t.user_id
      )
      SELECT * FROM filtered
      ORDER BY ${orderBy} ${orderDirection} NULLS LAST, stats_last_seen_at DESC
      LIMIT $3 OFFSET $4
    `, [username, query, boundedLimit, boundedOffset]);
    return {
      items: result.rows.map(normalizeListenerRow),
      total: Number(result.rows[0]?.full_count || 0)
    };
  }

  async listenerContributionRankings({ username = "", fresh = false } = {}) {
    if (!this.ready) return { byUserId: new Map(), lifetimeOrder: [], recentOrder: [], generatedAt: 0 };
    const cacheKey = String(username || "").trim().toLowerCase() || "*";
    const cached = this.contributionRankCache.get(cacheKey);
    if (!fresh && cached) {
      if (cached.generatedAt < Date.now() - CONTRIBUTION_RANK_CACHE_MS) {
        this.refreshListenerContributionRankings(username, cacheKey).catch(() => {});
      }
      return cached;
    }
    return this.refreshListenerContributionRankings(username, cacheKey);
  }

  async refreshListenerContributionRankings(username, cacheKey = String(username || "").trim().toLowerCase() || "*") {
    const pending = this.contributionRankPromises.get(cacheKey);
    if (pending) return pending;
    const refresh = (async () => {
      const result = await this.pool.query(`
      WITH lifetime AS (
        SELECT user_id,
          SUM(visit_count)::bigint AS visits,
          SUM(comment_count)::bigint AS comments,
          SUM(like_count)::bigint AS likes,
          MAX(last_seen_at) AS stats_last_seen_at
        FROM listener_stream_stats
        WHERE ($1 = '' OR LOWER(stream_username) = LOWER($1))
        GROUP BY user_id
      ), rankable_gifts AS (
        SELECT user_id, SUM(diamonds)::bigint AS coins
        FROM live_events
        WHERE event_type = 'gift'
          AND user_id <> ''
          AND item_count > 0
          AND diamonds::numeric / item_count > 10
          AND ($1 = '' OR LOWER(stream_username) = LOWER($1))
        GROUP BY user_id
      ), recent_visits AS (
        SELECT user_id,
          COUNT(DISTINCT session_id)::bigint AS recent_visits,
          MAX(last_seen_at) AS recent_visit_at
        FROM viewer_visits
        WHERE last_seen_at >= NOW() - INTERVAL '30 days'
          AND ($1 = '' OR LOWER(stream_username) = LOWER($1))
        GROUP BY user_id
      ), recent_events AS (
        SELECT user_id,
          COUNT(*) FILTER (WHERE event_type = 'comment')::bigint AS recent_comments,
          COALESCE(SUM(diamonds) FILTER (
            WHERE event_type = 'gift'
              AND item_count > 0
              AND diamonds::numeric / item_count > 10
          ), 0)::bigint AS recent_coins,
          COALESCE(SUM(GREATEST(item_count, 1)) FILTER (WHERE event_type = 'like'), 0)::bigint AS recent_likes,
          MAX(event_at) FILTER (WHERE event_type IN ('comment', 'gift', 'like')) AS recent_event_at
        FROM live_events
        WHERE event_at >= NOW() - INTERVAL '30 days'
          AND event_type IN ('comment', 'gift', 'like')
          AND user_id <> ''
          AND ($1 = '' OR LOWER(stream_username) = LOWER($1))
        GROUP BY user_id
      )
      SELECT l.user_id,
        LOWER(CONCAT_WS(' ', l.user_id, l.latest_unique_id, l.latest_nickname, l.notes)) AS search_text,
        COALESCE(t.visits, 0)::bigint AS visits,
        COALESCE(t.comments, 0)::bigint AS comments,
        COALESCE(rg.coins, 0)::bigint AS coins,
        COALESCE(t.likes, 0)::bigint AS likes,
        COALESCE(t.stats_last_seen_at, l.last_seen_at) AS stats_last_seen_at,
        COALESCE(rv.recent_visits, 0)::bigint AS recent_visits,
        COALESCE(re.recent_comments, 0)::bigint AS recent_comments,
        COALESCE(re.recent_coins, 0)::bigint AS recent_coins,
        COALESCE(re.recent_likes, 0)::bigint AS recent_likes,
        GREATEST(rv.recent_visit_at, re.recent_event_at) AS recent_last_seen_at
      FROM listeners l
      LEFT JOIN lifetime t ON t.user_id = l.user_id
      LEFT JOIN rankable_gifts rg ON rg.user_id = l.user_id
      LEFT JOIN recent_visits rv ON rv.user_id = l.user_id
      LEFT JOIN recent_events re ON re.user_id = l.user_id
      WHERE ($1 = '' OR t.user_id IS NOT NULL)
      `, [username]);
      const rankings = {
        ...buildContributionRankings(result.rows),
        generatedAt: Date.now()
      };
      this.contributionRankCache.set(cacheKey, rankings);
      return rankings;
    })();
    this.contributionRankPromises.set(cacheKey, refresh);
    try {
      return await refresh;
    } finally {
      if (this.contributionRankPromises.get(cacheKey) === refresh) this.contributionRankPromises.delete(cacheKey);
    }
  }

  async listenerContributionForIds({ username = "", userIds = [], fresh = false } = {}) {
    const rankings = await this.listenerContributionRankings({ username, fresh });
    return new Map(userIds.map((userId) => [String(userId), publicContributionRank(rankings.byUserId.get(String(userId)))]).filter(([, rank]) => rank));
  }

  async listenerContributionPage({ username = "", search = "", sort = "contribution", limit = 100, offset = 0, fresh = false } = {}) {
    const rankings = await this.listenerContributionRankings({ username, fresh });
    const normalizedSearch = String(search || "").normalize("NFKC").trim().replace(/^@/, "").toLocaleLowerCase("ja-JP");
    const order = sort === "recent_contribution" ? rankings.recentOrder : rankings.lifetimeOrder;
    const filteredIds = normalizedSearch
      ? order.filter((userId) => rankings.byUserId.get(userId)?.searchText.includes(normalizedSearch))
      : order;
    const boundedLimit = Math.min(250, Math.max(1, Number(limit || 100)));
    const boundedOffset = Math.max(0, Number(offset || 0));
    const pageIds = filteredIds.slice(boundedOffset, boundedOffset + boundedLimit);
    const items = await this.listenerRowsByIds(pageIds, { username });
    return {
      items: items.map((item) => ({ ...item, ...publicContributionRank(rankings.byUserId.get(item.userId)) })),
      total: filteredIds.length,
      rankingGeneratedAt: rankings.generatedAt
    };
  }

  async listenerRowsByIds(userIds = [], { username = "" } = {}) {
    const ids = [...new Set(userIds.map(String).filter(Boolean))];
    if (!this.ready || !ids.length) return [];
    const result = await this.pool.query(`
      WITH totals AS (
        SELECT user_id,
          SUM(visit_count)::bigint AS visits,
          SUM(comment_count)::bigint AS comments,
          SUM(gift_count)::bigint AS gifts,
          SUM(gift_coins)::bigint AS coins,
          SUM(share_count)::bigint AS shares,
          SUM(like_count)::bigint AS likes,
          SUM(follow_count)::bigint AS follows,
          MIN(first_seen_at) AS stats_first_seen_at,
          MAX(last_seen_at) AS stats_last_seen_at,
          MAX(last_comment_at) AS last_comment_at,
          MAX(last_gift_at) AS last_gift_at
        FROM listener_stream_stats
        WHERE user_id = ANY($2::text[])
          AND ($1 = '' OR LOWER(stream_username) = LOWER($1))
        GROUP BY user_id
      )
      SELECT l.user_id, l.latest_unique_id, l.latest_nickname, l.avatar_url,
        (l.avatar_data IS NOT NULL) AS avatar_cached,
        l.first_seen_at, l.last_seen_at, l.is_super_fan, l.needs_attention, l.notes, l.tags,
        l.host_follow_status, l.host_follow_status_updated_at,
        l.profile_follower_count, l.profile_following_count, l.profile_counts_updated_at,
        l.manually_updated_at, l.created_at, l.updated_at, t.*
      FROM totals t JOIN listeners l ON l.user_id = t.user_id
    `, [username, ids]);
    const rows = new Map(result.rows.map((row) => {
      const normalized = normalizeListenerRow(row);
      return [normalized.userId, normalized];
    }));
    return ids.map((userId) => rows.get(userId)).filter(Boolean);
  }

  async listenerExportRows({ username = "", search = "" } = {}) {
    if (!this.ready) return [];
    const query = String(search || "").trim();
    const result = await this.pool.query(`
      WITH totals AS (
        SELECT user_id,
          SUM(visit_count)::bigint AS visits,
          SUM(comment_count)::bigint AS comments,
          SUM(gift_count)::bigint AS gifts,
          SUM(gift_coins)::bigint AS coins,
          SUM(share_count)::bigint AS shares,
          MIN(first_seen_at) AS stats_first_seen_at,
          MAX(last_seen_at) AS stats_last_seen_at
        FROM listener_stream_stats
        WHERE ($1 = '' OR LOWER(stream_username) = LOWER($1))
        GROUP BY user_id
      )
      SELECT l.user_id, l.latest_unique_id, l.latest_nickname,
        l.is_super_fan, l.needs_attention, l.notes, l.tags,
        l.host_follow_status, l.host_follow_status_updated_at,
        l.profile_follower_count, l.profile_following_count, l.profile_counts_updated_at, t.*
      FROM totals t JOIN listeners l ON l.user_id = t.user_id
      WHERE ($2 = '' OR l.user_id ILIKE '%' || $2 || '%'
        OR l.latest_unique_id ILIKE '%' || $2 || '%'
        OR l.latest_nickname ILIKE '%' || $2 || '%'
        OR l.notes ILIKE '%' || $2 || '%')
      ORDER BY t.stats_last_seen_at DESC NULLS LAST, l.user_id
    `, [username, query]);
    return result.rows.map(normalizeListenerRow);
  }

  async sessionExportRows(sessionId) {
    if (!this.ready) return [];
    const result = await this.pool.query(`
      SELECT event_type AS type, source, event_at AS "at", user_id AS "userId",
        unique_id AS "uniqueId", nickname, comment_text AS text,
        gift_id AS "giftId", gift_name AS "giftName", item_count AS count,
        diamonds AS coins
      FROM live_events
      WHERE session_id = $1
      ORDER BY event_at ASC, event_key ASC
    `, [sessionId]);
    return result.rows.map(normalizeEventAggregate);
  }

  async listenerDetail(userId, { username = "" } = {}) {
    if (!this.ready) return null;
    const listener = await this.pool.query(`
      SELECT user_id, latest_unique_id, latest_nickname, avatar_url,
        (avatar_data IS NOT NULL) AS avatar_cached,
        first_seen_at, last_seen_at, is_super_fan, needs_attention, notes, tags,
        host_follow_status, host_follow_status_updated_at,
        profile_follower_count, profile_following_count, profile_counts_updated_at,
        manually_updated_at, created_at, updated_at
      FROM listeners WHERE user_id = $1
    `, [userId]);
    if (!listener.rows[0]) return null;
    const [stats, aliases, gifts, stamps, prints] = await Promise.all([
      this.pool.query(`SELECT * FROM listener_stream_stats WHERE user_id = $1 AND ($2 = '' OR LOWER(stream_username) = LOWER($2)) ORDER BY last_seen_at DESC`, [userId, username]),
      this.pool.query(`SELECT unique_id AS "uniqueId", nickname, first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt", seen_count::bigint AS "seenCount" FROM listener_aliases WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT 50`, [userId]),
      this.pool.query(`SELECT gift_id AS "giftId", gift_name AS "giftName", SUM(item_count)::bigint AS count, SUM(diamonds)::bigint AS coins, MAX(event_at) AS "lastAt" FROM live_events WHERE user_id = $1 AND event_type = 'gift' AND ($2 = '' OR LOWER(stream_username) = LOWER($2)) GROUP BY gift_id, gift_name ORDER BY SUM(diamonds) DESC, SUM(item_count) DESC LIMIT 100`, [userId, username]),
      this.pool.query(`SELECT id, stamp_type AS "stampType", quantity, source, note, stamped_at AS "stampedAt" FROM listener_stamps WHERE user_id = $1 ORDER BY stamped_at DESC LIMIT 100`, [userId]),
      this.pool.query(`SELECT id, gift_name AS "giftName", item_count AS count, coins, template_id AS "templateId", printed_at AS "printedAt" FROM receipt_prints WHERE user_id = $1 ORDER BY printed_at DESC LIMIT 100`, [userId])
    ]);
    return {
      listener: normalizeListenerRow(listener.rows[0]),
      stats: stats.rows.map(normalizeStreamStatsRow),
      aliases: aliases.rows.map(normalizeDates),
      gifts: gifts.rows.map(normalizeEventAggregate),
      stamps: stamps.rows.map(normalizeDates),
      receiptPrints: prints.rows.map(normalizeDates)
    };
  }

  async listenerHistory(userId, { username = "", kind = "comments", limit = 200, offset = 0 } = {}) {
    if (!this.ready) return { items: [], total: 0 };
    const boundedLimit = Math.min(500, Math.max(1, Number(limit || 200)));
    const boundedOffset = Math.max(0, Number(offset || 0));
    if (kind === "visits") {
      const result = await this.pool.query(`
        WITH days AS (
          SELECT TO_CHAR(v.first_seen_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS day,
            MIN(v.first_seen_at) AS "firstSeenAt",
            MAX(v.last_seen_at) AS "lastSeenAt",
            COUNT(DISTINCT COALESCE(NULLIF(s.room_id, ''), v.session_id::text))::bigint AS "liveCount",
            ARRAY_AGG(DISTINCT v.stream_username ORDER BY v.stream_username) AS "streamUsernames"
          FROM viewer_visits v
          JOIN live_sessions s ON s.id = v.session_id
          WHERE v.user_id = $1
            AND ($2 = '' OR LOWER(v.stream_username) = LOWER($2))
          GROUP BY TO_CHAR(v.first_seen_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD')
        )
        SELECT *, COUNT(*) OVER()::bigint AS "fullCount"
        FROM days
        ORDER BY day DESC
        LIMIT $3 OFFSET $4
      `, [userId, username, boundedLimit, boundedOffset]);
      return {
        items: result.rows.map((row) => ({
          ...normalizeDates(row),
          liveCount: Number(row.liveCount || 0),
          streamUsernames: Array.isArray(row.streamUsernames) ? row.streamUsernames : []
        })),
        total: Number(result.rows[0]?.fullCount || 0)
      };
    }
    const result = await this.pool.query(`
      SELECT event_key AS id, event_at AS "at", comment_text AS text,
        stream_username AS "streamUsername", COUNT(*) OVER()::bigint AS "fullCount"
      FROM live_events
      WHERE user_id = $1 AND event_type = 'comment'
        AND ($2 = '' OR LOWER(stream_username) = LOWER($2))
      ORDER BY event_at DESC, event_key DESC
      LIMIT $3 OFFSET $4
    `, [userId, username, boundedLimit, boundedOffset]);
    return {
      items: result.rows.map(normalizeDates),
      total: Number(result.rows[0]?.fullCount || 0)
    };
  }

  async updateListener(userId, { isSuperFan, needsAttention, notes, tags } = {}) {
    if (!this.ready) return null;
    const result = await this.pool.query(`
      UPDATE listeners SET
        is_super_fan = COALESCE($2::boolean, is_super_fan),
        needs_attention = COALESCE($3::boolean, needs_attention),
        notes = COALESCE($4::text, notes),
        tags = COALESCE($5::jsonb, tags),
        manually_updated_at = NOW(),
        updated_at = NOW()
      WHERE user_id = $1
      RETURNING *
    `, [
      userId,
      typeof isSuperFan === "boolean" ? isSuperFan : null,
      typeof needsAttention === "boolean" ? needsAttention : null,
      typeof notes === "string" ? notes.slice(0, 4000) : null,
      Array.isArray(tags) ? JSON.stringify(tags.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)) : null
    ]);
    return result.rows[0] ? normalizeListenerRow(result.rows[0]) : null;
  }

  async superFanRevision() {
    if (!this.ready) return "0:0";
    const result = await this.pool.query(`
      SELECT COUNT(*) FILTER (WHERE is_super_fan = TRUE)::bigint AS count,
        COALESCE(FLOOR(EXTRACT(EPOCH FROM MAX(manually_updated_at)) * 1000), 0)::bigint AS changed
      FROM listeners
    `);
    return `${Number(result.rows[0]?.count || 0)}:${Number(result.rows[0]?.changed || 0)}`;
  }

  async superFans() {
    if (!this.ready) return [];
    const result = await this.pool.query(`
      SELECT user_id AS "userId", latest_unique_id AS "uniqueId",
        latest_nickname AS nickname, avatar_url AS "avatarUrl"
      FROM listeners
      WHERE is_super_fan = TRUE
      ORDER BY latest_nickname, latest_unique_id, user_id
    `);
    return result.rows;
  }

  async sharedStampState({ revision = -1, superFanRevision = "" } = {}) {
    if (!this.ready) return { unavailable: true };
    const [stored, currentSuperFanRevision] = await Promise.all([
      this.pool.query(`
        SELECT state, revision::bigint AS revision, source_revision::bigint AS "sourceRevision",
          super_fan_revision AS "superFanRevision", updated_at AS "updatedAt"
        FROM shared_app_states WHERE state_key = 'stamp-card'
      `),
      this.superFanRevision()
    ]);
    const row = stored.rows[0];
    if (!row) {
      return {
        unchanged: false,
        state: null,
        revision: 0,
        sourceRevision: 0,
        superFanRevision: currentSuperFanRevision,
        updatedAt: null
      };
    }
    const storedRevision = Number(row.revision || 0);
    if (storedRevision === Number(revision) && currentSuperFanRevision === String(superFanRevision || "")) {
      return {
        unchanged: true,
        revision: storedRevision,
        sourceRevision: Number(row.sourceRevision || 0),
        superFanRevision: currentSuperFanRevision,
        updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : null
      };
    }
    let state = row.state;
    if (row.superFanRevision !== currentSuperFanRevision) {
      const enriched = await this.enrichStampState(state);
      state = enriched.state;
      await this.pool.query(`
        UPDATE shared_app_states
        SET state = $2::jsonb, super_fan_revision = $3, updated_at = NOW()
        WHERE state_key = 'stamp-card'
      `, ['stamp-card', JSON.stringify(state), currentSuperFanRevision]);
    }
    return {
      unchanged: false,
      state,
      revision: storedRevision,
      sourceRevision: Number(row.sourceRevision || 0),
      superFanRevision: currentSuperFanRevision,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : null
    };
  }

  async updateSharedStampState(state, { sourceRevision = 0, source = "count-pocket" } = {}) {
    if (!this.ready || !state || typeof state !== "object") throw new Error("スタンプカードの状態が不正です");
    const current = await this.pool.query(`
      SELECT revision::bigint AS revision, source_revision::bigint AS "sourceRevision"
      FROM shared_app_states WHERE state_key = 'stamp-card'
    `);
    const previous = current.rows[0];
    const incomingSourceRevision = Math.max(0, Number(sourceRevision || state.revision || 0));
    if (previous && incomingSourceRevision && incomingSourceRevision < Number(previous.sourceRevision || 0)) {
      return { stale: true, revision: Number(previous.revision || 0), sourceRevision: Number(previous.sourceRevision || 0) };
    }
    const enriched = await this.enrichStampState(state);
    const superFanRevision = await this.superFanRevision();
    const nextRevision = Math.max(Number(previous?.revision || 0) + 1, incomingSourceRevision || 1);
    await this.pool.query(`
      INSERT INTO shared_app_states (
        state_key, state, revision, source_revision, super_fan_revision, source, updated_at
      ) VALUES ('stamp-card', $1::jsonb, $2, $3, $4, $5, NOW())
      ON CONFLICT (state_key) DO UPDATE SET
        state = EXCLUDED.state,
        revision = EXCLUDED.revision,
        source_revision = GREATEST(shared_app_states.source_revision, EXCLUDED.source_revision),
        super_fan_revision = EXCLUDED.super_fan_revision,
        source = EXCLUDED.source,
        updated_at = NOW()
    `, [JSON.stringify(enriched.state), nextRevision, incomingSourceRevision, superFanRevision, String(source).slice(0, 100)]);
    return {
      stale: false,
      revision: nextRevision,
      sourceRevision: incomingSourceRevision,
      superFanRevision,
      users: enriched.users,
      importedStamps: enriched.importedStamps
    };
  }

  async enrichStampState(inputState) {
    const state = structuredClone(inputState || {});
    const users = Array.isArray(state.users) ? state.users.slice(0, 10000) : [];
    if (!users.length) return { state: { ...state, users: [] }, users: 0, importedStamps: 0 };

    const numericIds = [...new Set(users.map((item) => cleanNumericUserId(item.tiktokUserId || item.userId)).filter(Boolean))];
    const handles = [...new Set(users.map((item) => cleanUniqueId(item.tiktokUniqueId || item.uniqueId)).filter(Boolean).map((item) => item.toLowerCase()))];
    const existing = await this.pool.query(`
      SELECT user_id AS "userId", latest_unique_id AS "uniqueId", is_super_fan AS "isSuperFan"
      FROM listeners
      WHERE user_id = ANY($1::text[])
         OR LOWER(latest_unique_id) = ANY($2::text[])
    `, [numericIds, handles]);
    const byId = new Map(existing.rows.map((item) => [String(item.userId), item]));
    const byHandle = new Map(existing.rows.filter((item) => item.uniqueId).map((item) => [String(item.uniqueId).toLowerCase(), item]));
    const prepared = users.map((item, index) => {
      const numericId = cleanNumericUserId(item.tiktokUserId || item.userId);
      const handle = cleanUniqueId(item.tiktokUniqueId || item.uniqueId);
      const matched = (numericId && byId.get(numericId)) || (handle && byHandle.get(handle.toLowerCase()));
      const fallbackKey = String(item.id || index);
      const userId = String(matched?.userId || numericId || (handle ? `username:${handle.toLowerCase()}` : `stamp:${fallbackKey}`));
      const at = validDate(item.lastEventAt || item.updatedAt || item.createdAt || Date.now());
      return {
        item,
        userId,
        uniqueId: handle,
        nickname: String(item.name || item.nickname || handle || userId).slice(0, 250),
        at,
        isSuperFan: Boolean(matched?.isSuperFan)
      };
    });

    await this.pool.query(`
      INSERT INTO listeners (
        user_id, latest_unique_id, latest_nickname, first_seen_at, last_seen_at, notes, tags, updated_at
      )
      SELECT x.user_id, x.unique_id, x.nickname, x.at, x.at, 'count-pocket', '["スタンプカード"]'::jsonb, NOW()
      FROM jsonb_to_recordset($1::jsonb) AS x(user_id text, unique_id text, nickname text, at timestamptz)
      ON CONFLICT (user_id) DO UPDATE SET
        latest_unique_id = CASE WHEN EXCLUDED.latest_unique_id <> '' THEN EXCLUDED.latest_unique_id ELSE listeners.latest_unique_id END,
        latest_nickname = CASE WHEN EXCLUDED.latest_nickname <> '' THEN EXCLUDED.latest_nickname ELSE listeners.latest_nickname END,
        last_seen_at = GREATEST(listeners.last_seen_at, EXCLUDED.last_seen_at),
        updated_at = NOW()
    `, [JSON.stringify(prepared.map((item) => ({
      user_id: item.userId,
      unique_id: item.uniqueId,
      nickname: item.nickname,
      at: item.at.toISOString()
    })))]);

    const canonical = await this.pool.query(`
      SELECT user_id AS "userId", is_super_fan AS "isSuperFan"
      FROM listeners WHERE user_id = ANY($1::text[])
    `, [[...new Set(prepared.map((item) => item.userId))]]);
    const superFanById = new Map(canonical.rows.map((item) => [String(item.userId), Boolean(item.isSuperFan)]));
    const stamps = [];
    state.users = prepared.map(({ item, userId }) => {
      const normalized = {
        ...item,
        tiktokUserId: userId,
        isSuperFan: Boolean(superFanById.get(userId))
      };
      for (const stamp of (Array.isArray(item.stamps) ? item.stamps : []).slice(0, 5000)) {
        const stampIdentity = String(stamp.id || `${stamp.type || "standard"}:${stamp.at || stamp.stampedAt || ""}:${stamp.label || ""}`);
        const externalKey = `count-pocket:${userId}:${createHash("sha256").update(stampIdentity).digest("hex")}`;
        stamps.push({
          id: isUuid(stamp.id) ? String(stamp.id) : randomUUID(),
          user_id: userId,
          stamp_type: String(stamp.type || stamp.stampType || "standard").slice(0, 100),
          quantity: Math.max(1, Math.min(9999, Number(stamp.quantity || 1))),
          source: String(stamp.source || "count-pocket").slice(0, 100),
          note: String(stamp.note || stamp.label || "").slice(0, 500),
          stamped_at: validDate(stamp.at || stamp.stampedAt || item.lastEventAt || Date.now()).toISOString(),
          external_key: externalKey
        });
      }
      return normalized;
    });
    let importedStamps = 0;
    if (stamps.length) {
      await this.pool.query(`
        UPDATE listener_stamps AS saved
        SET external_key = incoming.external_key
        FROM jsonb_to_recordset($1::jsonb) AS incoming(id text, external_key text)
        WHERE saved.id = incoming.id::uuid
          AND saved.external_key = ''
      `, [JSON.stringify(stamps.map((stamp) => ({ id: stamp.id, external_key: stamp.external_key })))]);
      const inserted = await this.pool.query(`
        INSERT INTO listener_stamps (
          id, user_id, stamp_type, quantity, source, note, stamped_at, external_key
        )
        SELECT x.id::uuid, x.user_id, x.stamp_type, x.quantity, x.source, x.note, x.stamped_at, x.external_key
        FROM jsonb_to_recordset($1::jsonb) AS x(
          id text, user_id text, stamp_type text, quantity integer, source text,
          note text, stamped_at timestamptz, external_key text
        )
        ON CONFLICT DO NOTHING
      `, [JSON.stringify(stamps)]);
      importedStamps = Number(inserted.rowCount || 0);
    }
    return { state, users: state.users.length, importedStamps };
  }

  async recordReceiptPrint(input = {}) {
    if (!this.ready) throw new Error("共有データベースへ接続できていません");
    const numericId = cleanNumericUserId(input.userId);
    const uniqueId = cleanUniqueId(input.uniqueId);
    if (!numericId && !uniqueId) throw new Error("印刷履歴にユーザーIDがありません");
    const existingId = await this.listenerIdForIdentity({ userId: numericId, uniqueId });
    const userId = existingId || numericId || `username:${uniqueId.toLowerCase()}`;
    const printedAt = validDate(input.printedAt || input.at || Date.now());
    await this.pool.query(`
      INSERT INTO listeners (
        user_id, latest_unique_id, latest_nickname, first_seen_at, last_seen_at, updated_at
      ) VALUES ($1, $2, $3, $4, $4, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        latest_unique_id = CASE WHEN EXCLUDED.latest_unique_id <> '' THEN EXCLUDED.latest_unique_id ELSE listeners.latest_unique_id END,
        latest_nickname = CASE WHEN EXCLUDED.latest_nickname <> '' THEN EXCLUDED.latest_nickname ELSE listeners.latest_nickname END,
        last_seen_at = GREATEST(listeners.last_seen_at, EXCLUDED.last_seen_at),
        updated_at = NOW()
    `, [userId, uniqueId, String(input.nickname || uniqueId || userId).slice(0, 250), printedAt]);
    const externalEventId = String(input.eventId || input.externalEventId || "").slice(0, 250);
    const result = await this.pool.query(`
      INSERT INTO receipt_prints (
        id, user_id, gift_id, gift_name, item_count, coins, template_id,
        printed_at, source, external_event_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (external_event_id) WHERE external_event_id <> '' DO NOTHING
      RETURNING id
    `, [
      randomUUID(), userId, String(input.giftId || "").slice(0, 120),
      String(input.giftName || "").slice(0, 250), Math.max(0, Number(input.count || input.itemCount || 0)),
      Math.max(0, Number(input.coins || 0)), String(input.templateId || "").slice(0, 120), printedAt,
      String(input.source || "receipt-app").slice(0, 100), externalEventId
    ]);
    return { recorded: Boolean(result.rows[0]), duplicate: !result.rows[0], userId };
  }

  async listenersMissingAvatars({ limit = 10, offset = 0 } = {}) {
    if (!this.ready) return [];
    const boundedLimit = Math.min(20, Math.max(1, Number(limit || 10)));
    const boundedOffset = Math.max(0, Number(offset || 0));
    const result = await this.pool.query(`
      SELECT user_id AS "userId", latest_unique_id AS "uniqueId", latest_nickname AS nickname
      FROM listeners
      WHERE avatar_url = '' AND user_id ~ '^[0-9]+$'
      ORDER BY last_seen_at DESC
      LIMIT $1 OFFSET $2
    `, [boundedLimit, boundedOffset]);
    return result.rows;
  }

  async listenerIdForIdentity({ userId = "", uniqueId = "" } = {}) {
    if (!this.ready) return "";
    const numericId = String(userId || "").trim();
    const handle = String(uniqueId || "").replace(/^@/, "").trim();
    const result = await this.pool.query(`
      SELECT user_id AS "userId"
      FROM listeners
      WHERE ($1 <> '' AND user_id = $1)
         OR ($2 <> '' AND LOWER(latest_unique_id) = LOWER($2))
      ORDER BY CASE WHEN user_id = $1 THEN 0 ELSE 1 END, last_seen_at DESC
      LIMIT 1
    `, [numericId, handle]);
    return String(result.rows[0]?.userId || "");
  }

  async updateListenerAvatar(userId, { uniqueId = "", nickname = "", avatarUrl = "" } = {}) {
    if (!this.ready || !avatarUrl) return null;
    const result = await this.pool.query(`
      UPDATE listeners SET
        latest_unique_id = CASE WHEN $2 <> '' THEN $2 ELSE latest_unique_id END,
        latest_nickname = CASE WHEN $3 <> '' THEN $3 ELSE latest_nickname END,
        avatar_url = $4,
        updated_at = NOW()
      WHERE user_id = $1
      RETURNING *
    `, [
      String(userId),
      String(uniqueId).slice(0, 120),
      String(nickname).slice(0, 250),
      String(avatarUrl).slice(0, 1000)
    ]);
    return result.rows[0] ? normalizeListenerRow(result.rows[0]) : null;
  }

  async listenerHasCachedAvatar(userId) {
    if (!this.ready) return false;
    const result = await this.pool.query(`
      SELECT avatar_data IS NOT NULL AS cached FROM listeners WHERE user_id = $1
    `, [String(userId)]);
    return Boolean(result.rows[0]?.cached);
  }

  async storeListenerAvatarData(userId, { data, mime = "image/jpeg" } = {}) {
    if (!this.ready || !Buffer.isBuffer(data) || !data.length) return false;
    const result = await this.pool.query(`
      UPDATE listeners SET avatar_data = $2, avatar_mime = $3, updated_at = NOW()
      WHERE user_id = $1 AND avatar_data IS NULL
      RETURNING user_id
    `, [String(userId), data, String(mime).slice(0, 100)]);
    return Boolean(result.rows[0]);
  }

  async avatarCompactionCandidates({ limit = 25, after = "" } = {}) {
    if (!this.ready) return [];
    const boundedLimit = Math.min(50, Math.max(1, Number(limit || 25)));
    const result = await this.pool.query(`
      SELECT user_id AS "userId", avatar_data AS data, avatar_mime AS mime
      FROM listeners
      WHERE avatar_data IS NOT NULL
        AND OCTET_LENGTH(avatar_data) > 30000
        AND ($1 = '' OR user_id > $1)
      ORDER BY user_id
      LIMIT $2
    `, [String(after || ""), boundedLimit]);
    return result.rows;
  }

  async replaceListenerAvatarData(userId, { data, mime = "image/webp" } = {}) {
    if (!this.ready || !Buffer.isBuffer(data) || !data.length) return false;
    const result = await this.pool.query(`
      UPDATE listeners SET avatar_data = $2, avatar_mime = $3, updated_at = NOW()
      WHERE user_id = $1 AND (avatar_data IS NULL OR OCTET_LENGTH(avatar_data) > OCTET_LENGTH($2::bytea))
      RETURNING user_id
    `, [String(userId), data, String(mime).slice(0, 100)]);
    return Boolean(result.rows[0]);
  }

  async listenerAvatarData(userId) {
    if (!this.ready) return null;
    const result = await this.pool.query(`
      SELECT avatar_data AS data, avatar_mime AS mime
      FROM listeners WHERE user_id = $1 AND avatar_data IS NOT NULL
    `, [String(userId)]);
    return result.rows[0] || null;
  }

  async recentListenerEvents({ username = "", since = 0, limit = 100 } = {}) {
    if (!this.ready) return [];
    const boundedLimit = Math.min(250, Math.max(1, Number(limit || 100)));
    const result = await this.pool.query(`
      SELECT event_key AS id, event_type AS type, event_at AS "at", user_id AS "userId",
        unique_id AS "uniqueId", nickname, avatar_url AS "avatarUrl", comment_text AS text,
        gift_id AS "giftId", gift_name AS "giftName", item_count AS count, diamonds AS coins,
        payload->>'giftImageUrl' AS "giftImageUrl",
        payload->>'originalComment' AS "originalComment",
        payload->>'priorVisitCount' AS "priorVisitCount",
        payload->>'lastPriorVisitAt' AS "lastPriorVisitAt",
        stream_username AS "streamUsername"
      FROM live_events
      WHERE ($1 = '' OR LOWER(stream_username) = LOWER($1))
        AND ($2::bigint = 0 OR event_at > TO_TIMESTAMP($2::double precision / 1000.0))
      ORDER BY event_at DESC LIMIT $3
    `, [username, Math.max(0, Number(since || 0)), boundedLimit]);
    return result.rows.map(normalizeEventAggregate);
  }

  async importListeners(items, { username = "", source = "import" } = {}) {
    if (!this.ready || !Array.isArray(items)) return { imported: 0 };
    const normalizedSource = String(source || "import").trim().toLowerCase();
    const importSuperFanStatus = normalizedSource !== "count-pocket";
    let imported = 0;
    let importedStamps = 0;
    for (const item of items.slice(0, 2000)) {
      const userId = String(item.userId || "").trim();
      if (!userId) continue;
      const at = new Date(item.lastSeenAt || item.firstSeenAt || Date.now());
      await this.pool.query(`
        INSERT INTO listeners (
          user_id, latest_unique_id, latest_nickname, avatar_url,
          first_seen_at, last_seen_at, is_super_fan, notes, tags, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          latest_unique_id = CASE WHEN EXCLUDED.latest_unique_id <> '' THEN EXCLUDED.latest_unique_id ELSE listeners.latest_unique_id END,
          latest_nickname = CASE WHEN EXCLUDED.latest_nickname <> '' THEN EXCLUDED.latest_nickname ELSE listeners.latest_nickname END,
          avatar_url = CASE WHEN EXCLUDED.avatar_url <> '' THEN EXCLUDED.avatar_url ELSE listeners.avatar_url END,
          first_seen_at = LEAST(listeners.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(listeners.last_seen_at, EXCLUDED.last_seen_at),
          is_super_fan = listeners.is_super_fan OR EXCLUDED.is_super_fan,
          notes = CASE WHEN listeners.notes = '' THEN EXCLUDED.notes ELSE listeners.notes END,
          updated_at = NOW()
      `, [
        userId,
        String(item.uniqueId || item.username || "").slice(0, 120),
        String(item.nickname || item.name || item.username || userId).slice(0, 250),
        String(item.avatarUrl || "").slice(0, 1000),
        new Date(item.firstSeenAt || at),
        at,
        importSuperFanStatus && Boolean(item.isSuperFan),
        source === "import" ? "" : String(source).slice(0, 200),
        JSON.stringify(Array.isArray(item.tags) ? item.tags.slice(0, 20) : [])
      ]);
      if (username) {
        await this.pool.query(`
          INSERT INTO listener_stream_stats (
            stream_username, user_id, visit_count, comment_count, gift_count, gift_coins,
            share_count, first_seen_at, last_seen_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (stream_username, user_id) DO UPDATE SET
            visit_count = GREATEST(listener_stream_stats.visit_count, EXCLUDED.visit_count),
            comment_count = GREATEST(listener_stream_stats.comment_count, EXCLUDED.comment_count),
            gift_count = GREATEST(listener_stream_stats.gift_count, EXCLUDED.gift_count),
            gift_coins = GREATEST(listener_stream_stats.gift_coins, EXCLUDED.gift_coins),
            share_count = GREATEST(listener_stream_stats.share_count, EXCLUDED.share_count),
            first_seen_at = LEAST(listener_stream_stats.first_seen_at, EXCLUDED.first_seen_at),
            last_seen_at = GREATEST(listener_stream_stats.last_seen_at, EXCLUDED.last_seen_at)
        `, [
          username,
          userId,
          Math.max(0, Number(item.visitCount || 0)),
          Math.max(0, Number(item.commentCount || 0)),
          Math.max(0, Number(item.giftCount || item.totalGifts || 0)),
          Math.max(0, Number(item.giftCoins || item.totalCoins || 0)),
          Math.max(0, Number(item.shareCount || 0)),
          new Date(item.firstSeenAt || at),
          at
        ]);
      }
      for (const stamp of (Array.isArray(item.stamps) ? item.stamps : []).slice(0, 1000)) {
        const stampId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(stamp.id || ""))
          ? String(stamp.id)
          : randomUUID();
        const stampedAt = new Date(stamp.at || stamp.stampedAt || at);
        await this.pool.query(`
          INSERT INTO listener_stamps (
            id, user_id, stamp_type, quantity, source, note, stamped_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO NOTHING
        `, [
          stampId,
          userId,
          String(stamp.type || stamp.stampType || "standard").slice(0, 100),
          Math.max(1, Math.min(9999, Number(stamp.quantity || 1))),
          String(stamp.source || source).slice(0, 100),
          String(stamp.note || stamp.label || "").slice(0, 500),
          Number.isNaN(stampedAt.getTime()) ? at : stampedAt
        ]);
        importedStamps += 1;
      }
      imported += 1;
    }
    return { imported, importedStamps };
  }

  async clearImportedSuperFans({ source = "count-pocket", tag = "スタンプカード" } = {}) {
    if (!this.ready) return { updated: 0 };
    const result = await this.pool.query(`
      UPDATE listeners SET
        is_super_fan = FALSE,
        updated_at = NOW()
      WHERE is_super_fan = TRUE
        AND manually_updated_at IS NULL
        AND notes = $1
        AND tags @> $2::jsonb
      RETURNING user_id
    `, [
      String(source).slice(0, 200),
      JSON.stringify([String(tag).slice(0, 100)])
    ]);
    return { updated: result.rowCount || result.rows.length };
  }

  async close() {
    this.ready = false;
    this.contributionRankCache.clear();
    this.contributionRankPromises.clear();
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = null;
    await pool.end().catch(() => {});
  }
}

export function rangeStart(range, now = new Date()) {
  const current = new Date(now);
  if (range === "today") {
    const shifted = new Date(current.getTime() + 9 * 60 * 60 * 1000);
    return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 9 * 60 * 60 * 1000);
  }
  if (range === "7d") return new Date(current.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (range === "30d") return new Date(current.getTime() - 30 * 24 * 60 * 60 * 1000);
  return null;
}

function normalizeNumericRow(row) {
  return {
    ...row,
    count: Number(row.count || 0),
    diamonds: Number(row.diamonds || 0),
    lastGiftAt: row.lastGiftAt ? new Date(row.lastGiftAt).getTime() : null
  };
}

function emptyListenerSummary() {
  return { listeners: 0, superFans: 0, avatars: 0, visits: 0, comments: 0, gifts: 0, coins: 0, shares: 0, activeToday: 0, returning: 0 };
}

function normalizeSummaryRow(row = {}) {
  return Object.fromEntries(Object.entries({ ...emptyListenerSummary(), ...row }).map(([key, value]) => [key, Number(value || 0)]));
}

function normalizeDates(row = {}) {
  const normalized = { ...row };
  for (const [key, value] of Object.entries(normalized)) {
    if (value instanceof Date || /(?:At|_at)$/.test(key) && value) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) normalized[key] = date.getTime();
    }
    if (typeof value === "bigint") normalized[key] = Number(value);
  }
  return normalized;
}

function normalizeTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) ? numeric : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeListenerRow(row = {}) {
  const { avatar_data: _avatarData, ...safeRow } = row;
  const normalized = normalizeDates(safeRow);
  return {
    ...normalized,
    userId: row.user_id || row.userId || "",
    uniqueId: row.latest_unique_id || row.uniqueId || "",
    nickname: row.latest_nickname || row.nickname || "",
    avatarUrl: row.avatar_url || row.avatarUrl || "",
    avatarCached: Boolean(row.avatar_cached ?? row.avatarCached ?? row.avatar_data),
    isSuperFan: Boolean(row.is_super_fan ?? row.isSuperFan),
    needsAttention: Boolean(row.needs_attention ?? row.needsAttention),
    hostFollowStatus: normalizeHostFollowStatus(row.host_follow_status ?? row.hostFollowStatus),
    hostFollowStatusUpdatedAt: normalized.host_follow_status_updated_at || normalized.hostFollowStatusUpdatedAt || null,
    followerCount: nullableNumber(row.profile_follower_count ?? row.followerCount),
    followingCount: nullableNumber(row.profile_following_count ?? row.followingCount),
    profileCountsUpdatedAt: normalized.profile_counts_updated_at || normalized.profileCountsUpdatedAt || null,
    firstSeenAt: normalized.first_seen_at || normalized.firstSeenAt || null,
    lastSeenAt: normalized.last_seen_at || normalized.lastSeenAt || null,
    visits: Number(row.visits || row.visit_count || 0),
    comments: Number(row.comments || row.comment_count || 0),
    gifts: Number(row.gifts || row.gift_count || 0),
    coins: Number(row.coins || row.gift_coins || 0),
    shares: Number(row.shares || row.share_count || 0),
    likes: Number(row.likes || row.like_count || 0),
    follows: Number(row.follows || row.follow_count || 0),
    tags: Array.isArray(row.tags) ? row.tags : []
  };
}

function publicContributionRank(rank) {
  if (!rank) return null;
  return {
    contributionScore: Number(rank.contributionScore || 0),
    contributionPosition: rank.contributionPosition ?? null,
    contributionTotal: Number(rank.contributionTotal || 0),
    contributionRank: rank.contributionRank || "集計不足",
    contributionCoins: Number(rank.contributionCoins || 0),
    contributionCoinsPerVisit: Number(rank.contributionCoinsPerVisit || 0),
    recentContributionScore: Number(rank.recentContributionScore || 0),
    recentContributionPosition: rank.recentContributionPosition ?? null,
    recentContributionTotal: Number(rank.recentContributionTotal || 0),
    recentContributionRank: rank.recentContributionRank || "活動なし",
    recentContributionCoins: Number(rank.recentContributionCoins || 0),
    recentContributionCoinsPerVisit: Number(rank.recentContributionCoinsPerVisit || 0)
  };
}

function listenerProfileFromEvent(event = {}) {
  const profile = event.profile || event.signals?.profile || {};
  const followStatus = event.type === "follow"
    ? "following"
    : normalizeHostFollowStatus(profile.followStatus, null);
  const followerCount = nullableCount(profile.followerCount);
  const followingCount = nullableCount(profile.followingCount);
  return {
    followStatus,
    followerCount,
    followingCount,
    hasCounts: followerCount !== null || followingCount !== null
  };
}

function normalizeHostFollowStatus(value, fallback = "unknown") {
  return value === "following" || value === "not_following" ? value : fallback;
}

function nullableCount(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeStreamStatsRow(row = {}) {
  const normalized = normalizeDates(row);
  return {
    ...normalized,
    streamUsername: row.stream_username || "",
    visitCount: Number(row.visit_count || 0),
    commentCount: Number(row.comment_count || 0),
    giftCount: Number(row.gift_count || 0),
    giftCoins: Number(row.gift_coins || 0),
    shareCount: Number(row.share_count || 0),
    likeCount: Number(row.like_count || 0),
    followCount: Number(row.follow_count || 0),
    subscribeCount: Number(row.subscribe_count || 0),
    joinCount: Number(row.join_count || 0)
  };
}

function normalizeEventAggregate(row = {}) {
  const normalized = normalizeDates(row);
  return {
    ...normalized,
    count: Number(row.count || 0),
    coins: Number(row.coins || 0),
    priorVisitCount: Number(row.priorVisitCount || 0),
    lastPriorVisitAt: normalizeTimestamp(row.lastPriorVisitAt)
  };
}

function cleanNumericUserId(value) {
  const normalized = String(value || "").trim();
  return /^\d{5,}$/.test(normalized) ? normalized : "";
}

function cleanUniqueId(value) {
  return String(value || "").replace(/^@/, "").trim().slice(0, 120);
}

function validDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function shortError(error) {
  return String(error?.message || error || "不明なエラー").slice(0, 180);
}
