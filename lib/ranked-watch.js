export function updateRankedPresence(user, isRanked, at) {
  const currentAt = Math.max(0, Number(at || 0));
  const wasRanked = Boolean(user.isCurrentlyRanked);
  const previousAt = Math.max(0, Number(user.rankedPresenceUpdatedAt || 0));
  const accumulated = Math.max(0, Number(user.confirmedWatchMilliseconds || 0));

  if (wasRanked && previousAt > 0 && currentAt >= previousAt) {
    user.confirmedWatchMilliseconds = accumulated + (currentAt - previousAt);
  } else {
    user.confirmedWatchMilliseconds = accumulated;
  }

  if (isRanked) {
    if (!wasRanked) user.rankedVisitCount = Math.max(0, Number(user.rankedVisitCount || 0)) + 1;
    user.rankedPresenceUpdatedAt = currentAt;
  } else {
    user.rankedPresenceUpdatedAt = null;
  }
  user.isCurrentlyRanked = Boolean(isRanked);
  return user;
}

export function confirmedRankedWatchSeconds(user, now = Date.now()) {
  let milliseconds = Math.max(0, Number(user?.confirmedWatchMilliseconds || 0));
  const previousAt = Math.max(0, Number(user?.rankedPresenceUpdatedAt || 0));
  const currentAt = Math.max(0, Number(now || 0));
  if (user?.isCurrentlyRanked && previousAt > 0 && currentAt >= previousAt) {
    milliseconds += currentAt - previousAt;
  }
  return Math.floor(milliseconds / 1000);
}
