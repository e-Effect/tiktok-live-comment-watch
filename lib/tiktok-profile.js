export function tiktokProfileFromUser(rawUser) {
  if (!rawUser || typeof rawUser !== "object") {
    return { followStatus: null, followStatusRaw: null, followerCount: null, followingCount: null };
  }

  const followStatusRaw = firstPresent(
    rawUser.followInfo?.followStatus,
    rawUser.follow_info?.follow_status,
    rawUser.followRole,
    rawUser.follow_role
  );
  const followStatus = normalizeFollowStatus(followStatusRaw);
  const followerCount = firstCount(
    rawUser.followInfo?.followerCount,
    rawUser.follow_info?.follower_count,
    rawUser.followerCount,
    rawUser.follower_count,
    rawUser.userDetails?.followerCount,
    rawUser.user_details?.follower_count
  );
  const followingCount = firstCount(
    rawUser.followInfo?.followingCount,
    rawUser.follow_info?.following_count,
    rawUser.followingCount,
    rawUser.following_count,
    rawUser.userDetails?.followingCount,
    rawUser.user_details?.following_count
  );

  return { followStatus, followStatusRaw, followerCount, followingCount };
}

function normalizeFollowStatus(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value === true) return "following";
  if (value === false) return "not_following";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric > 0 ? "following" : "not_following";
}

function firstCount(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.trunc(numeric);
  }
  return null;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "") ?? null;
}
