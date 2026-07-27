const MAX_QUEUE = 2000;

export class LiveCueForwarder {
  constructor({ endpoint = "", channelId = "", token = "" } = {}) {
    this.endpoint = String(endpoint || "").trim();
    this.channelId = String(channelId || "").trim();
    this.token = String(token || "").trim();
    this.queue = [];
    this.sending = false;
    this.sent = 0;
    this.failed = 0;
    this.lastError = "";
  }

  get configured() {
    return Boolean(this.endpoint && this.channelId);
  }

  status() {
    return {
      configured: this.configured,
      queued: this.queue.length,
      sent: this.sent,
      failed: this.failed,
      lastError: this.lastError
    };
  }

  publish(event) {
    if (!this.configured) return;
    const payload = toLiveCueEvent(event, this.channelId, this.token);
    if (!payload) return;
    this.queue.push({ payload, attempts: 0 });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    this.drain();
  }

  async drain() {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    while (this.queue.length) {
      const item = this.queue[0];
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.payload),
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        this.queue.shift();
        this.sent += 1;
        this.lastError = "";
      } catch (error) {
        item.attempts += 1;
        this.failed += 1;
        this.lastError = String(error?.message || error).slice(0, 180);
        if (item.attempts >= 5) {
          this.queue.shift();
        } else {
          await wait(Math.min(30000, 1000 * 2 ** item.attempts));
        }
      }
    }
    this.sending = false;
  }
}

export function toLiveCueEvent(event, channelId, token = "") {
  const allowed = new Set(["comment", "gift", "like", "follow", "share", "join", "subscribe"]);
  if (!allowed.has(event?.type)) return null;
  return {
    channelId,
    token,
    type: event.type,
    username: event.nickname || event.userId || "",
    giftName: event.giftName || "",
    repeatCount: Math.max(1, Number(event.repeatCount || event.count || 1)),
    coins: Math.max(0, Number(event.diamondCount || event.diamonds || event.totalDiamonds || 0)),
    comment: event.text || "",
    likeCount: Math.max(0, Number(event.likeCount || 0)),
    totalLikes: Math.max(0, Number(event.totalLikes || 0)),
    subMonth: Math.max(0, Number(event.subMonth || 0))
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
