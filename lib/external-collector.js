const EVENT_ALIASES = new Map([
  ["chat", "chat"],
  ["comment", "chat"],
  ["gift", "gift"],
  ["member", "member"],
  ["join", "member"],
  ["follow", "follow"],
  ["share", "share"],
  ["social", "social"],
  ["like", "like"],
  ["subscribe", "subscribe"],
  ["subscription", "subscribe"],
  ["superfan", "superFan"],
  ["superfanjoin", "superFanJoin"],
  ["roomuser", "roomUser"],
  ["roomuserseq", "roomUser"],
  ["streamend", "streamEnd"]
]);

export function normalizeCollectorEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const rawType = String(raw.event || raw.type || raw.eventType || "").trim();
  const type = EVENT_ALIASES.get(rawType.toLowerCase());
  if (!type) {
    if (rawType.toLowerCase() === "control" && Number(raw.data?.action ?? raw.action) === 3) {
      return { type: "streamEnd", data: raw.data || raw, key: eventKey("streamEnd", raw.data || raw) };
    }
    if (rawType.toLowerCase() === "room" && Number(raw.data?.status ?? raw.status) === 4) {
      return { type: "streamEnd", data: raw.data || raw, key: eventKey("streamEnd", raw.data || raw) };
    }
    return null;
  }

  const data = raw.data && typeof raw.data === "object" ? raw.data : raw;
  return { type, data, key: eventKey(type, data) };
}

export function eventKey(type, data = {}) {
  const id = firstText(data.msgId, data.messageId, data.eventId, data.id);
  if (!id) return "";
  if (type !== "gift") return `${type}:${id}`;

  const repeatCount = Number(data.repeatCount ?? data.repeat_count ?? data.gift?.repeatCount ?? 0);
  const repeatEnd = data.repeatEnd ?? data.repeat_end ?? data.gift?.repeatEnd;
  return `${type}:${id}:${repeatCount}:${repeatEnd === true ? "end" : repeatEnd === false ? "pending" : "single"}`;
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}
