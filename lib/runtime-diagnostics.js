// Metadata only: never retain SQL text, bind values, listener IDs or comments.
export class RuntimeDiagnostics {
  constructor({ now = Date.now, write = line => console.log(line) } = {}) {
    this.now = now;
    this.write = write;
    this.active = new Map();
    this.nextId = 0;
    this.completed = 0;
    this.failed = 0;
    this.recent = [];
    this.lastLogAt = -Infinity;
    this.lastState = "";
    this.lastFailed = 0;
  }

  instrument(pool, name) {
    const query = pool.query.bind(pool);
    pool.query = (...args) => {
      // Preserve callback-style callers; application queries use promises.
      if (typeof args.at(-1) === "function") return query(...args);
      const id = ++this.nextId;
      const startedAt = this.now();
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
      const kind = queryKind(sql);
      if (this.active.size < 128) this.active.set(id, { pool: name, kind, startedAt });
      const finish = error => {
        this.active.delete(id);
        this.completed += 1;
        if (error) this.failed += 1;
        const ms = Math.max(0, this.now() - startedAt);
        if (error || ms >= 1000) {
          const code = /^[A-Z0-9]{2,20}$/.test(String(error?.code || "")) ? error.code : error ? "ERROR" : "";
          this.recent.push({ at: this.now(), pool: name, kind, ms, code });
          if (this.recent.length > 12) this.recent.shift();
        }
      };
      try {
        return Promise.resolve(query(...args)).then(value => { finish(); return value; }, error => { finish(error); throw error; });
      } catch (error) { finish(error); throw error; }
    };
  }

  sample({ ready, pools, pending, visitPending, activeStream, memory }) {
    const now = this.now();
    const state = String(ready);
    const changed = state !== this.lastState || this.failed !== this.lastFailed;
    const interval = changed ? 15000 : activeStream || pending || visitPending ? 60000 : 300000;
    if (now - this.lastLogAt < interval) return false;
    this.write("[runtime-diagnostics] " + JSON.stringify({
      at: new Date(now).toISOString(), ready, pools, pending, visitPending,
      appMemoryMB: { rss: Math.round(memory.rss / 1048576), heap: Math.round(memory.heapUsed / 1048576) },
      completed: this.completed, failed: this.failed,
      active: [...this.active.values()].slice(0, 12).map(q => ({pool:q.pool,kind:q.kind,ms:now-q.startedAt})),
      recent: this.recent
    }));
    this.lastLogAt = now;
    this.lastState = state;
    this.lastFailed = this.failed;
    return true;
  }
}

function queryKind(sql) {
  if (/CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(sql)) return "schema";
  if (/WITH inserted AS/i.test(sql)) return "event-write";
  if (/WITH upsert_listener AS/i.test(sql)) return "visit-enrichment";
  if (/needs_attention = TRUE/i.test(sql)) return "attention";
  if (/rankable_gifts AS/i.test(sql)) return "ranking";
  if (/live_event_inbox/i.test(sql)) return "inbox";
  if (/viewer_visits/i.test(sql)) return "visits";
  if (/avatar_data/i.test(sql)) return "avatar-or-ledger";
  if (/listener_stream_stats/i.test(sql)) return "listener-stats";
  if (/shared_app_states/i.test(sql)) return "shared-state";
  return /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.exec(sql)?.[1].toLowerCase() || "other";
}
