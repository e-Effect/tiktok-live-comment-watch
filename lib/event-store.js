import { randomUUID } from "node:crypto";

const MAX_QUERY_ROWS = 200;

export class EventStore {
  constructor({ connectionString = "", ssl } = {}) {
    this.connectionString = String(connectionString || "").trim();
    this.ssl = ssl;
    this.pool = null;
    this.ready = false;
    this.lastError = "";
  }

  async init() {
    if (!this.connectionString) return false;
    try {
      const { Pool } = await import("pg");
      const useSsl = this.ssl ?? !/localhost|127\.0\.0\.1/i.test(this.connectionString);
      this.pool = new Pool({
        connectionString: this.connectionString,
        ssl: useSsl ? { rejectUnauthorized: false } : false,
        max: 5
      });
      await this.pool.query(`
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
        ALTER TABLE live_events
          ADD COLUMN IF NOT EXISTS unique_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE live_events
          ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '';
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
        CREATE INDEX IF NOT EXISTS listener_stamps_user_idx
          ON listener_stamps (user_id, stamped_at DESC);
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
        CREATE INDEX IF NOT EXISTS receipt_prints_user_idx
          ON receipt_prints (user_id, printed_at DESC);
      `);
      this.ready = true;
      this.lastError = "";
      return true;
    } catch (error) {
      this.lastError = shortError(error);
      this.ready = false;
      await this.close();
      return false;
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
      this.lastError = shortError(error);
      return false;
    }
  }

  async recordEvent(session, event) {
    if (!this.ready || !event?.type || !event?.id) return false;
    try {
      event.userId = await this.resolveListenerId(event.userId, event.uniqueId);
      await this.pool.query(`
        WITH inserted AS (
          INSERT INTO live_events (
            event_key, session_id, stream_username, event_type, event_at,
            user_id, unique_id, nickname, avatar_url, comment_text, gift_id, gift_name,
            item_count, diamonds, source, payload
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
          ON CONFLICT (event_key) DO NOTHING
          RETURNING *
        ), upsert_listener AS (
          INSERT INTO listeners (
            user_id, latest_unique_id, latest_nickname, avatar_url,
            first_seen_at, last_seen_at, updated_at
          )
          SELECT user_id, unique_id, nickname, avatar_url, event_at, event_at, NOW()
          FROM inserted WHERE user_id <> ''
          ON CONFLICT (user_id) DO UPDATE SET
            latest_unique_id = CASE WHEN EXCLUDED.latest_unique_id <> '' THEN EXCLUDED.latest_unique_id ELSE listeners.latest_unique_id END,
            latest_nickname = CASE WHEN EXCLUDED.latest_nickname <> '' THEN EXCLUDED.latest_nickname ELSE listeners.latest_nickname END,
            avatar_url = CASE WHEN EXCLUDED.avatar_url <> '' THEN EXCLUDED.avatar_url ELSE listeners.avatar_url END,
            first_seen_at = LEAST(listeners.first_seen_at, EXCLUDED.first_seen_at),
            last_seen_at = GREATEST(listeners.last_seen_at, EXCLUDED.last_seen_at),
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
        JSON.stringify(event.payload || {})
      ]);
      return true;
    } catch (error) {
      this.lastError = shortError(error);
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
          user_id, latest_unique_id, latest_nickname, avatar_url,
          first_seen_at, last_seen_at, is_super_fan, notes, tags,
          manually_updated_at, created_at, updated_at
        )
        SELECT $2, latest_unique_id, latest_nickname, avatar_url,
          first_seen_at, last_seen_at, is_super_fan, notes, tags,
          manually_updated_at, created_at, NOW()
        FROM listeners WHERE user_id = $1
        ON CONFLICT (user_id) DO UPDATE SET
          latest_unique_id = CASE WHEN listeners.latest_unique_id = '' THEN EXCLUDED.latest_unique_id ELSE listeners.latest_unique_id END,
          latest_nickname = CASE WHEN listeners.latest_nickname = '' THEN EXCLUDED.latest_nickname ELSE listeners.latest_nickname END,
          avatar_url = CASE WHEN listeners.avatar_url = '' THEN EXCLUDED.avatar_url ELSE listeners.avatar_url END,
          first_seen_at = LEAST(listeners.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(listeners.last_seen_at, EXCLUDED.last_seen_at),
          is_super_fan = listeners.is_super_fan OR EXCLUDED.is_super_fan,
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
      this.lastError = shortError(error);
      return false;
    } finally {
      client.release();
    }
  }

  async recordVisit(session, visit) {
    const fallback = {
      visitCount: 1,
      firstVisitAt: Number(visit?.at || Date.now()),
      lastVisitAt: Number(visit?.at || Date.now())
    };
    if (!this.ready || !visit?.userId) return fallback;
    try {
      const at = new Date(visit.at || Date.now());
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
          MAX(v.last_seen_at) AS "lastVisitAt"
        FROM viewer_visits v
        JOIN live_sessions s ON s.id = v.session_id
        WHERE LOWER(v.stream_username) = LOWER($1)
          AND v.user_id = $2
      `, [session.username, String(visit.userId)]);
      const row = result.rows[0] || {};
      await this.pool.query(`
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
      return {
        visitCount: Math.max(1, Number(row.visitCount || 1)),
        firstVisitAt: row.firstVisitAt ? new Date(row.firstVisitAt).getTime() : fallback.firstVisitAt,
        lastVisitAt: row.lastVisitAt ? new Date(row.lastVisitAt).getTime() : fallback.lastVisitAt
      };
    } catch (error) {
      this.lastError = shortError(error);
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
      SELECT id, stream_username AS username, room_id AS "roomId", started_at AS "startedAt"
      FROM live_sessions
      WHERE auto_resume = TRUE
        AND status IN ('connecting', 'live', 'disconnected')
        AND updated_at >= NOW() - ($1::double precision * INTERVAL '1 hour')
      ORDER BY updated_at DESC
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
        COUNT(*) FILTER (WHERE l.avatar_url <> '')::bigint AS avatars,
        COALESCE(SUM(t.visits), 0)::bigint AS visits,
        COALESCE(SUM(t.comments), 0)::bigint AS comments,
        COALESCE(SUM(t.gifts), 0)::bigint AS gifts,
        COALESCE(SUM(t.coins), 0)::bigint AS coins,
        COALESCE(SUM(t.shares), 0)::bigint AS shares,
        COUNT(*) FILTER (WHERE t.last_seen_at >= NOW() - INTERVAL '24 hours')::bigint AS "activeToday",
        COUNT(*) FILTER (WHERE t.visits >= 2)::bigint AS returning
      FROM totals t JOIN listeners l ON l.user_id = t.user_id
    `, [username]);
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
        WHERE ($1 = '' OR LOWER(stream_username) = LOWER($1))
        GROUP BY user_id
      ), filtered AS (
        SELECT l.*, t.*,
          LOWER(COALESCE(NULLIF(l.latest_nickname, ''), NULLIF(l.latest_unique_id, ''), l.user_id)) AS display_name_sort,
          COUNT(*) OVER()::bigint AS full_count
        FROM totals t JOIN listeners l ON l.user_id = t.user_id
        WHERE ($2 = '' OR l.user_id ILIKE '%' || $2 || '%'
          OR l.latest_unique_id ILIKE '%' || $2 || '%'
          OR l.latest_nickname ILIKE '%' || $2 || '%'
          OR l.notes ILIKE '%' || $2 || '%')
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

  async listenerDetail(userId, { username = "" } = {}) {
    if (!this.ready) return null;
    const listener = await this.pool.query(`
      SELECT * FROM listeners WHERE user_id = $1
    `, [userId]);
    if (!listener.rows[0]) return null;
    const [stats, aliases, gifts, comments, events, stamps, prints] = await Promise.all([
      this.pool.query(`SELECT * FROM listener_stream_stats WHERE user_id = $1 AND ($2 = '' OR LOWER(stream_username) = LOWER($2)) ORDER BY last_seen_at DESC`, [userId, username]),
      this.pool.query(`SELECT unique_id AS "uniqueId", nickname, first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt", seen_count::bigint AS "seenCount" FROM listener_aliases WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT 50`, [userId]),
      this.pool.query(`SELECT gift_id AS "giftId", gift_name AS "giftName", SUM(item_count)::bigint AS count, SUM(diamonds)::bigint AS coins, MAX(event_at) AS "lastAt" FROM live_events WHERE user_id = $1 AND event_type = 'gift' AND ($2 = '' OR LOWER(stream_username) = LOWER($2)) GROUP BY gift_id, gift_name ORDER BY SUM(diamonds) DESC, SUM(item_count) DESC LIMIT 100`, [userId, username]),
      this.pool.query(`SELECT event_at AS "at", comment_text AS text, stream_username AS "streamUsername" FROM live_events WHERE user_id = $1 AND event_type = 'comment' AND ($2 = '' OR LOWER(stream_username) = LOWER($2)) ORDER BY event_at DESC LIMIT 200`, [userId, username]),
      this.pool.query(`SELECT event_type AS type, event_at AS "at", comment_text AS text, gift_id AS "giftId", gift_name AS "giftName", item_count AS count, diamonds AS coins, stream_username AS "streamUsername" FROM live_events WHERE user_id = $1 AND ($2 = '' OR LOWER(stream_username) = LOWER($2)) ORDER BY event_at DESC LIMIT 200`, [userId, username]),
      this.pool.query(`SELECT id, stamp_type AS "stampType", quantity, source, note, stamped_at AS "stampedAt" FROM listener_stamps WHERE user_id = $1 ORDER BY stamped_at DESC LIMIT 100`, [userId]),
      this.pool.query(`SELECT id, gift_name AS "giftName", item_count AS count, coins, template_id AS "templateId", printed_at AS "printedAt" FROM receipt_prints WHERE user_id = $1 ORDER BY printed_at DESC LIMIT 100`, [userId])
    ]);
    return {
      listener: normalizeListenerRow(listener.rows[0]),
      stats: stats.rows.map(normalizeStreamStatsRow),
      aliases: aliases.rows.map(normalizeDates),
      gifts: gifts.rows.map(normalizeEventAggregate),
      comments: comments.rows.map(normalizeDates),
      events: events.rows.map(normalizeEventAggregate),
      stamps: stamps.rows.map(normalizeDates),
      receiptPrints: prints.rows.map(normalizeDates)
    };
  }

  async updateListener(userId, { isSuperFan, notes, tags } = {}) {
    if (!this.ready) return null;
    const result = await this.pool.query(`
      UPDATE listeners SET
        is_super_fan = COALESCE($2::boolean, is_super_fan),
        notes = COALESCE($3::text, notes),
        tags = COALESCE($4::jsonb, tags),
        manually_updated_at = NOW(),
        updated_at = NOW()
      WHERE user_id = $1
      RETURNING *
    `, [
      userId,
      typeof isSuperFan === "boolean" ? isSuperFan : null,
      typeof notes === "string" ? notes.slice(0, 4000) : null,
      Array.isArray(tags) ? JSON.stringify(tags.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)) : null
    ]);
    return result.rows[0] ? normalizeListenerRow(result.rows[0]) : null;
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

  async recentListenerEvents({ username = "", since = 0, limit = 100 } = {}) {
    if (!this.ready) return [];
    const boundedLimit = Math.min(250, Math.max(1, Number(limit || 100)));
    const result = await this.pool.query(`
      SELECT event_key AS id, event_type AS type, event_at AS "at", user_id AS "userId",
        unique_id AS "uniqueId", nickname, avatar_url AS "avatarUrl", comment_text AS text,
        gift_id AS "giftId", gift_name AS "giftName", item_count AS count, diamonds AS coins,
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
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = null;
    await pool.end().catch(() => {});
  }
}

function rangeStart(range) {
  const now = new Date();
  if (range === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (range === "7d") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (range === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
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

function normalizeListenerRow(row = {}) {
  const normalized = normalizeDates(row);
  return {
    ...normalized,
    userId: row.user_id || row.userId || "",
    uniqueId: row.latest_unique_id || row.uniqueId || "",
    nickname: row.latest_nickname || row.nickname || "",
    avatarUrl: row.avatar_url || row.avatarUrl || "",
    isSuperFan: Boolean(row.is_super_fan ?? row.isSuperFan),
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
  return {
    ...normalizeDates(row),
    count: Number(row.count || 0),
    coins: Number(row.coins || 0)
  };
}

function shortError(error) {
  return String(error?.message || error || "不明なエラー").slice(0, 180);
}
