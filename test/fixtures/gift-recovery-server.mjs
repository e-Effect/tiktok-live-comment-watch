// Isolated child process: use the real server, route, auth and EventStore SQL.
// Only database initialization and the listening address are replaced here.
import { Server } from "node:http";
import { Socket } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { EventStore } from "../../lib/event-store.js";
import { screenshotRecordsSchema } from "../../lib/screenshot-records.js";

// Fail closed if startup ever attempts an outbound connection (including pg).
Socket.prototype.connect = function () {
  throw new Error("Outbound connections are disabled in gift recovery tests");
};
globalThis.fetch = async () => {
  throw new Error("Outbound fetch is disabled in gift recovery tests");
};

const db = new PGlite();
await db.exec(`
  SET TIME ZONE 'UTC';
  CREATE TABLE live_events (
    event_key TEXT PRIMARY KEY, event_type TEXT, event_at TIMESTAMPTZ,
    session_id TEXT, stream_username TEXT, user_id TEXT, unique_id TEXT,
    nickname TEXT, avatar_url TEXT, comment_text TEXT, gift_id TEXT,
    gift_name TEXT, item_count INT, diamonds INT, payload JSONB DEFAULT '{}'
  );
  CREATE TABLE live_sessions (
    id TEXT PRIMARY KEY, stream_username TEXT, room_id TEXT,
    started_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    auto_resume BOOLEAN, status TEXT
  );
  ${screenshotRecordsSchema}
  INSERT INTO live_events (event_key, event_type, event_at, stream_username,
    user_id, unique_id, nickname, gift_id, gift_name, item_count, diamonds, payload)
  VALUES ('missed-gift', 'gift', '2026-11-08T00:00:01Z', 'busy_host',
    '12345', 'listener', 'テスト視聴者', '7934', 'Heart Me', 2, 10,
    '{"giftImageUrl":"/test-gift.png","slotExcluded":true}');
  INSERT INTO live_events (event_key, event_type, event_at, stream_username, user_id, comment_text)
  SELECT 'comment-' || i, 'comment', TIMESTAMPTZ '2026-11-08T00:00:10Z' + i * INTERVAL '1 second',
    'busy_host', 'commenter', 'test comment ' || i FROM generate_series(1,300) i;
  INSERT INTO live_events (event_key, event_type, event_at, stream_username, user_id, gift_id, gift_name, item_count, diamonds)
  SELECT 'filter-gift-' || i, 'gift', TIMESTAMPTZ '2026-11-08T00:00:00Z' + i * INTERVAL '1 second',
    'filter_host', '23456', '7934', 'Heart Me', i, i * 5 FROM generate_series(1,3) i;
  INSERT INTO live_events (event_key, event_type, event_at, stream_username, user_id, comment_text)
  VALUES ('filter-comment', 'comment', '2026-11-08T00:00:09Z', 'filter_host', '23456', 'test'),
    ('hidden-stay', 'room_user_stay', '2026-11-08T00:00:09.5Z', 'filter_host', '23456', ''),
    ('hidden-unknown', 'gift', '2026-11-08T00:00:09.6Z', 'filter_host', 'UnKnOwN', '');
  INSERT INTO live_events (event_key, event_type, event_at, stream_username, user_id, item_count, diamonds)
  SELECT 'bulk-gift-' || i, 'gift', TIMESTAMPTZ '2026-11-08T00:00:04Z' + i * INTERVAL '1 millisecond',
    'bulk_host', '34567', 1, 1 FROM generate_series(1,260) i;
  INSERT INTO live_events (event_key, event_type, event_at, stream_username, user_id, item_count, diamonds)
  VALUES ('other-gift', 'gift', '2026-11-08T00:00:05Z', 'other_host', '45678', 1, 1);
`);

let queryCount = 0;
EventStore.prototype.init = async function () {
  this.pool = {
    query(sql, params) {
      queryCount += 1;
      return db.query(sql, params);
    }
  };
  this.ready = true;
  return true;
};

// Bind port 0 on loopback, avoiding fixed-port races with other test files.
const listen = Server.prototype.listen;
Server.prototype.listen = function (_port, callback) {
  return listen.call(this, 0, "127.0.0.1", () => {
    callback?.();
    process.send({ type: "ready", port: this.address().port });
  });
};

process.on("message", async ({ type }) => {
  if (type !== "audit") return;
  const { rows } = await db.query("SELECT * FROM live_events ORDER BY event_key");
  process.send({ type: "audit", queryCount, rows });
});

await import("../../server.js");
