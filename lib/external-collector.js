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
      const data = raw.data || raw;
      return { type: "streamEnd", data, key: eventKey("streamEnd", data), roomId: collectorRoomId(raw), at: collectorEventTime(raw) };
    }
    if (rawType.toLowerCase() === "room" && Number(raw.data?.status ?? raw.status) === 4) {
      const data = raw.data || raw;
      return { type: "streamEnd", data, key: eventKey("streamEnd", data), roomId: collectorRoomId(raw), at: collectorEventTime(raw) };
    }
    return null;
  }

  const data = raw.data && typeof raw.data === "object" ? raw.data : raw;
  return { type, data, key: eventKey(type, data), roomId: collectorRoomId(raw), at: collectorEventTime(raw) };
}

function collectorRoomId(raw = {}) {
  const data = raw?.data && typeof raw.data === "object" ? raw.data : raw;
  return firstText(
    data?.roomId,
    data?.room_id,
    data?.room?.id,
    data?.roomInfo?.id,
    data?.roomInfo?.roomId,
    raw?.roomId,
    raw?.room_id
  );
}

function collectorEventTime(raw = {}) {
  const data = raw?.data && typeof raw.data === "object" ? raw.data : raw;
  const candidate = Number(data?.at ?? data?.timestamp ?? data?.createTime ?? data?.create_time ?? raw?.at ?? Date.now());
  if (!Number.isFinite(candidate) || candidate <= 0) return Date.now();
  return candidate < 10_000_000_000 ? candidate * 1000 : candidate;
}

export function shouldRotateCollectorSession({ currentRoomId = "", incomingRoomId = "", lastEventAt = 0, eventAt = Date.now(), gapMs = 3 * 60 * 60 * 1000 } = {}) {
  if (currentRoomId && incomingRoomId && String(currentRoomId) !== String(incomingRoomId)) return true;
  const previous = Number(lastEventAt || 0);
  const current = Number(eventAt || Date.now());
  return previous > 0 && current > previous && current - previous >= Math.max(60_000, Number(gapMs || 0));
}

function eventKey(type, data = {}) {
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
