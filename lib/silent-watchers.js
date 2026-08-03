export function silentWatcherPresenceMode(user = {}) {
  if (user.isCurrentlyRanked) return "viewer_ranking";
  if (Number(user.entryEventCount || 0) > 0) return "entry_estimate";
  return "";
}

export function isSilentWatcher(user = {}, minimumSeconds = 15 * 60) {
  return Number(user.comments || 0) === 0
    && Number(user.watchSeconds || 0) >= minimumSeconds
    && Boolean(silentWatcherPresenceMode(user));
}
