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
          started_at TIMESTAMPTZ NOT NULL,
          connected_at TIMESTAMPTZ,
          stopped_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS live_sessions_resume_idx
          ON live_sessions (auto_resume, status, updated_at DESC);
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
          started_at, connected_at, stopped_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          provider = EXCLUDED.provider,
          status = EXCLUDED.status,
          auto_resume = EXCLUDED.auto_resume,
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
      await this.pool.query(`
        INSERT INTO live_events (
          event_key, session_id, stream_username, event_type, event_at,
          user_id, nickname, comment_text, gift_id, gift_name,
          item_count, diamonds, source, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
        ON CONFLICT (event_key) DO NOTHING
      `, [
        `${session.id}:${event.id}`,
        session.id,
        session.username,
        event.type,
        new Date(event.at || Date.now()),
        event.userId || "",
        event.nickname || "",
        event.text || "",
        String(event.giftId || ""),
        event.giftName || "",
        Math.max(0, Number(event.count || event.repeatCount || 0)),
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
      SELECT id, stream_username AS username, started_at AS "startedAt"
      FROM live_sessions
      WHERE auto_resume = TRUE
        AND status IN ('connecting', 'live', 'disconnected')
        AND updated_at >= NOW() - ($1::double precision * INTERVAL '1 hour')
      ORDER BY updated_at DESC
    `, [Math.max(1, Number(maxAgeHours || 12))]);
    return result.rows;
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

function shortError(error) {
  return String(error?.message || error || "不明なエラー").slice(0, 180);
}
