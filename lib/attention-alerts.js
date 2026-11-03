export class AttentionAlerts {
  constructor({firstDisplayMs=10000,repeatDisplayMs=5000}={}) {
    this.ids=new Set();this.expires=new Map();this.alerts=new Map();
    this.displayed=new Map();this.firstDisplayMs=firstDisplayMs;this.repeatDisplayMs=repeatDisplayMs;
  }
  active(sessionId, now = Date.now()) {
    for (const [key, item] of this.alerts) if (item.alert.expiresAt <= now || !this.ids.has(item.alert.userId)) this.alerts.delete(key);
    return [...this.alerts.values()].filter(item => item.sessionId === sessionId).map(item => item.alert);
  }
  replace(ids) { this.ids = new Set(ids.map(String)); }
  update(id, enabled) { enabled ? this.ids.add(String(id)) : this.ids.delete(String(id)); }
  accept(sessionId, person, at, now = Date.now(), broadcastId = sessionId) {
    if (!this.ids.has(String(person.userId)) || !Number.isFinite(Number(at)) || now - Number(at) > 30000 || Number(at) > now + 5000) return null;
    for (const [key, expiry] of this.expires) if (expiry <= now) this.expires.delete(key);
    const id=String(person.userId);
    const scopes=[...new Set([sessionId,broadcastId])];
    const key=`${sessionId}:${id}`;
    if(scopes.some(scope=>this.expires.has(`${scope}:${id}`)))return null;
    const repeat=scopes.some(scope=>this.displayed.get(scope)?.has(id));
    const expiresAt=now+(repeat?this.repeatDisplayMs:this.firstDisplayMs);
    for(const scope of scopes){
      this.expires.set(`${scope}:${id}`,expiresAt);
      if(this.firstDisplayMs===this.repeatDisplayMs)continue;
      const users=this.displayed.get(scope)||new Set();
      users.add(id);
      this.displayed.delete(scope);
      this.displayed.set(scope,users);
    }
    while(this.displayed.size>200)this.displayed.delete(this.displayed.keys().next().value);
    const alert = { userId:id, nickname: person.nickname || person.uniqueId || "TikTokユーザー", uniqueId: person.uniqueId || "", expiresAt };
    this.active(sessionId, now);
    this.alerts.set(key, { sessionId, alert });
    return alert;
  }
}
