export class AttentionAlerts {
  constructor() { this.ids = new Set(); this.expires = new Map(); this.alerts = new Map(); }
  active(sessionId, now = Date.now()) {
    for (const [key, item] of this.alerts) if (item.alert.expiresAt <= now || !this.ids.has(item.alert.userId)) this.alerts.delete(key);
    return [...this.alerts.values()].filter(item => item.sessionId === sessionId).map(item => item.alert);
  }
  replace(ids) { this.ids = new Set(ids.map(String)); }
  update(id, enabled) { enabled ? this.ids.add(String(id)) : this.ids.delete(String(id)); }
  accept(sessionId, person, at, now = Date.now()) {
    if (!this.ids.has(String(person.userId)) || !Number.isFinite(Number(at)) || now - Number(at) > 30000 || Number(at) > now + 5000) return null;
    for (const [key, expiry] of this.expires) if (expiry <= now) this.expires.delete(key);
    const key = `${sessionId}:${person.userId}`;
    if (this.expires.has(key)) return null;
    this.expires.set(key, now + 30000);
    const alert = { userId: String(person.userId), nickname: person.nickname || person.uniqueId || "TikTokユーザー", uniqueId: person.uniqueId || "", expiresAt: now + 30000 };
    this.active(sessionId, now);
    this.alerts.set(key, { sessionId, alert });
    return alert;
  }
}
