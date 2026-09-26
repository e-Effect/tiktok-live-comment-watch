import { AttentionAlerts } from './attention-alerts.js';

// Viewer-only arrival notices, once per listener per session (not every action).
export class WelcomeAlerts extends AttentionAlerts {
  constructor() { super(); this.seen = new Map(); }
  accept(sessionId, person, at, now = Date.now()) {
    const id = String(person.userId);
    if (this.seen.get(sessionId)?.has(id)) return null;
    const alert = super.accept(sessionId, person, at, now);
    if (!alert) return null;
    if (!this.seen.has(sessionId)) this.seen.set(sessionId, new Set());
    this.seen.get(sessionId).add(id);
    while (this.seen.size > 100) this.seen.delete(this.seen.keys().next().value);
    alert.avatarUrl = person.avatarUrl || '';
    alert.kind = 'welcome';
    return alert;
  }
}
