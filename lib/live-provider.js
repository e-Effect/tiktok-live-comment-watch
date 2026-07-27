import { EventEmitter } from "node:events";

const STANDARD_EVENTS = {
  CHAT: "chat",
  GIFT: "gift",
  MEMBER: "member",
  FOLLOW: "follow",
  SOCIAL: "social",
  ROOM_USER: "roomUser",
  STREAM_END: "streamEnd",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  ERROR: "error",
  LIKE: "like",
  SUBSCRIBE: "subscribe"
};

export function liveProviderInfo(env = process.env) {
  const tikToolsEnabled = Boolean(String(env.TIKTOOLS_API_KEY || "").trim());
  const requestedMode = String(env.TIKTOOLS_MODE || "direct").toLowerCase();
  return {
    id: tikToolsEnabled ? "tiktools" : "legacy",
    label: tikToolsEnabled ? "Tik.tools" : "標準接続",
    mode: tikToolsEnabled && requestedMode === "relayed" ? "relayed" : "direct",
    paidApiReady: tikToolsEnabled
  };
}

export async function loadLiveProvider(env = process.env) {
  const info = liveProviderInfo(env);
  if (info.id === "tiktools") {
    const { TikTokLive } = await import("@tiktool/live");
    return {
      ...info,
      Connection: class extends TikToolsConnection {
        constructor(username) {
          super(username, TikTokLive, env);
        }
      },
      events: STANDARD_EVENTS
    };
  }

  const mod = await import("tiktok-live-connector");
  const Connection = mod.TikTokLiveConnection
    || mod.WebcastPushConnection
    || mod.default?.TikTokLiveConnection
    || mod.default?.WebcastPushConnection;
  if (!Connection) return null;
  return {
    ...info,
    Connection,
    events: { ...STANDARD_EVENTS, ...(mod.WebcastEvent || {}) }
  };
}

class TikToolsConnection extends EventEmitter {
  constructor(username, TikTokLive, env) {
    super();
    this.username = username;
    this.roomId = "";
    this.roomInfo = null;
    const reconnectAttempts = Number(env.TIKTOOLS_MAX_RECONNECT_ATTEMPTS || 50);
    this.client = new TikTokLive({
      uniqueId: username,
      apiKey: String(env.TIKTOOLS_API_KEY || "").trim(),
      mode: String(env.TIKTOOLS_MODE || "direct").toLowerCase() === "relayed" ? "relayed" : "direct",
      autoReconnect: true,
      maxReconnectAttempts: Number.isFinite(reconnectAttempts) ? Math.max(5, reconnectAttempts) : 50,
      debug: String(env.TIKTOOLS_DEBUG || "").toLowerCase() === "true",
      proxy: String(env.TIKTOOLS_PROXY || "").trim() || undefined
    });
    this.forwardEvents();
  }

  forwardEvents() {
    this.client.on("connected", () => this.emit("connected"));
    this.client.on("disconnected", (code, reason) => this.emit("disconnected", code, reason));
    this.client.on("error", (error) => this.emit("error", error));
    this.client.on("roomInfo", (info) => {
      this.roomInfo = info;
      this.roomId = info?.roomId || this.roomId;
      this.emit("roomInfo", info);
    });
    this.client.on("chat", (event) => this.emit("chat", event));
    this.client.on("gift", (event) => this.emit("gift", event));
    this.client.on("member", (event) => this.emit("member", event));
    this.client.on("like", (event) => this.emit("like", event));
    this.client.on("subscribe", (event) => this.emit("subscribe", event));
    this.client.on("social", (event) => {
      this.emit("social", event);
      if (event.action === "follow") this.emit("follow", event);
    });
    this.client.on("roomUserSeq", (event) => this.emit("roomUser", event));
    this.client.on("control", (event) => {
      if (Number(event.action) === 3) this.emit("streamEnd", event);
    });
    this.client.on("room", (event) => {
      if (Number(event.status) === 4) this.emit("streamEnd", event);
    });
  }

  async connect() {
    await this.client.connect();
    this.roomId = this.client.roomId || this.roomId;
    return { roomId: this.roomId, roomInfo: this.roomInfo };
  }

  disconnect() {
    this.client.disconnect();
  }
}
