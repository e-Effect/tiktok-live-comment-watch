const lists = new Set(['topViewers', 'ranksList', 'ranks', 'seats']);

export function normalizeRoomUserVisit(data = {}) {
  if (data.roomUserVisitVersion !== 1 || !lists.has(data.snapshotList)) return null;
  const roomId = String(data.roomId || '');
  if (!/^[\w:-]{1,100}$/.test(roomId)) return null;
  const raw = data.user;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const numeric = raw.id ?? raw.userId;
  if (typeof numeric === 'number' && !Number.isSafeInteger(numeric)) return null;
  const uniqueId = String(raw.uniqueId || raw.displayId || '').replace(/^@/, '');
  const validUniqueId = /^[a-zA-Z0-9._]{1,120}$/.test(uniqueId)
    && !/^(unknown|anonymous|null|undefined)$/i.test(uniqueId) ? uniqueId : '';
  // Display IDs can change. Match the same stable numeric ID used by entries.
  const id = /^\d{5,30}$/.test(String(numeric || '')) ? String(numeric) : '';
  if (!id) return null;
  const at = Number(data.snapshotAt);
  if (!Number.isFinite(at) || at <= 0) return null;
  return {
    ...data, roomId, at,
    user: {id, userId:id, uniqueId:validUniqueId,
      nickname:String(raw.nickname || raw.nickName || validUniqueId || id).slice(0,200),
      avatarUrl:String(raw.avatarUrl || raw.profilePictureUrl || '').slice(0,1000)},
  };
}

export function roomUserVisitEventId(roomId, userId) {
  return 'room-user:' + roomId + ':' + userId;
}
