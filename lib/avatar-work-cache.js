// Best-effort work: bounded concurrency and bounded TTL cache, never a live-event queue.
export function createAvatarWorkCache({ now = Date.now, maxConcurrent = 2, maxEntries = 5000,
  successTtl = 60 * 60 * 1000, failureTtl = 60 * 1000 } = {}) {
  const pending = new Set();
  const cached = new Map();
  return async (key, work) => {
    const previous = cached.get(key);
    if (previous && previous.until > now()) return previous.ok;
    if (pending.has(key) || pending.size >= maxConcurrent) return false;
    pending.add(key);
    let ok = false;
    try { ok = Boolean(await work()); return ok; }
    catch { return false; }
    finally {
      pending.delete(key);
      cached.delete(key);
      cached.set(key, { ok, until: now() + (ok ? successTtl : failureTtl) });
      while (cached.size > maxEntries) cached.delete(cached.keys().next().value);
    }
  };
}
