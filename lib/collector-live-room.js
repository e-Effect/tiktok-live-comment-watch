export function verifiedLiveRoom(info, username) {
  const { user, liveRoom } = info || {};
  const roomId = user?.roomId;
  if (typeof roomId !== 'string' || !/^\d{15,25}$/.test(roomId)) return '';
  if (String(user?.uniqueId || '').toLowerCase() !== username.toLowerCase()) return '';
  if (Number(liveRoom?.status) !== 2) return '';
  return roomId;
}

export function createCollectorLiveRoomLookup(loadConnector = () => import('tiktok-live-connector'), now = Date.now) {
  const pending = new Map();
  return function lookup(username) {
    if (pending.has(username)) return pending.get(username);
    if (pending.size >= 3) return Promise.resolve({ roomId: '', validForMs: 0 });
    const task = (async () => {
      const connector = await loadConnector();
      if (!connector) return '';
      const connection = new connector.TikTokLiveConnection(username, {
        webClientOptions: { timeout: { request: 2300 }, retry: { limit: 0 } },
      });
      const args = { uniqueId: username, webClient: connection.webClient };
      const sources = await Promise.allSettled([
        connector.fetchRoomInfoFromHtmlRoute(args),
        connector.fetchRoomInfoFromApiLiveRoute(args).then(value => value?.data)
      ]);
      const ids = new Set(sources.flatMap(result =>
        result.status === 'fulfilled' ? [verifiedLiveRoom(result.value, username)].filter(Boolean) : []
      ));
      return ids.size === 1 ? [...ids][0] : '';
    })().catch(() => '').then(roomId => ({
      roomId, checkedAt: now(), validForMs: roomId ? 22000 : 0
    })).finally(() => pending.delete(username));
    pending.set(username, task);
    return task;
  };
}
