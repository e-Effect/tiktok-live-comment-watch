const ACTIVE_BADGE_PATTERNS = [
  /super\s*fan/i,
  /superfan/i,
  /fan\s*club/i,
  /fanclub/i,
  /heart\s*me/i,
  /heartme/i,
  /ハート\s*ミー/u,
  /ファンクラブ/u
];

export function heartMeStateFromUser(rawUser) {
  if (!rawUser || typeof rawUser !== "object") return null;
  const fansClub = rawUser.fansClub || rawUser.fansClubMember || {};
  const preferData = fansClub.preferData && typeof fansClub.preferData === "object"
    ? Object.values(fansClub.preferData).find(Boolean)
    : null;
  const fansData = fansClub.data || preferData || rawUser.fansClubData || null;
  const fansInfo = rawUser.fansClubInfo || {};
  const badgeLevel = teamMemberLevelFromUser(rawUser);
  const level = firstPositiveNumber(
    fansData?.level,
    fansData?.badge?.level,
    fansData?.badge?.badgeLevel,
    fansInfo?.fansLevel,
    fansInfo?.level,
    rawUser.teamMemberLevel,
    badgeLevel
  );
  const rawStatus = firstDefined(
    fansData?.userFansClubStatus,
    fansData?.user_fans_club_status,
    fansData?.fansClubStatus,
    fansData?.status,
    fansClub?.userFansClubStatus,
    fansClub?.user_fans_club_status,
    fansInfo?.userFansClubStatus,
    fansInfo?.user_fans_club_status,
    rawUser.userFansClubStatus,
    rawUser.user_fans_club_status,
    rawUser.fansClubStatus
  );
  const status = fanClubStatusFromRaw(rawStatus);
  const isSleeping = firstBoolean(
    fansInfo?.isSleeping,
    fansInfo?.is_sleeping,
    fansData?.isSleeping,
    fansData?.is_sleeping,
    rawUser.isFansClubSleeping,
    rawUser.is_fans_club_sleeping
  );

  if (status) {
    if (status === "none") return { status, rawStatus, level: 0, source: "fans_club_status" };
    return { status, rawStatus, level, source: "fans_club_status" };
  }
  if (isSleeping === true) {
    return { status: "inactive", rawStatus: "sleeping", level, source: "fans_club_info" };
  }
  if (level > 0) {
    return { status: "active", rawStatus, level, source: "fan_badge_level" };
  }

  const badge = activeBadgeFromUser(rawUser);
  if (badge) {
    return {
      status: "active",
      rawStatus: badge,
      level: badgeLevelFromText(badge),
      source: "fan_badge_text"
    };
  }
  return null;
}

export function isHeartMeGift(data, extended = {}, knownGiftIds = []) {
  const giftId = String(data?.giftId || extended?.id || "");
  const rememberedIds = Array.isArray(knownGiftIds) ? knownGiftIds : [...(knownGiftIds || [])];
  if (giftId && rememberedIds.some((id) => String(id) === giftId)) return true;

  const fields = [
    data?.giftName,
    data?.giftNameKey,
    data?.describe,
    data?.description,
    data?.gift?.name,
    data?.gift?.giftNameKey,
    data?.gift?.describe,
    data?.gift?.description,
    data?.giftDetails?.name,
    data?.giftDetails?.giftNameKey,
    data?.giftDetails?.describe,
    data?.giftDetails?.description,
    data?.extendedGiftInfo?.name,
    data?.extendedGiftInfo?.giftNameKey,
    data?.extendedGiftInfo?.describe,
    data?.extendedGiftInfo?.description,
    extended?.name,
    extended?.giftNameKey,
    extended?.describe,
    extended?.description
  ];
  const text = normalizeGiftText(fields.filter(Boolean).join(" "));
  return text.includes("heartme") || text.includes("ハートミー");
}

export function nextHeartMeStatusForGift(previousStatus) {
  if (previousStatus === "active" || previousStatus === "inactive") return "active";
  return "new_today";
}

export function heartMeLevelFromEvent(data) {
  return firstPositiveNumber(
    data?.level,
    data?.fanLevel,
    data?.fansLevel,
    data?.user?.teamMemberLevel,
    badgeLevelFromText(activeBadgeFromUser(data?.user))
  );
}

function activeBadgeFromUser(rawUser) {
  const badges = [
    ...(Array.isArray(rawUser?.badges) ? rawUser.badges : []),
    ...(Array.isArray(rawUser?.userBadges) ? rawUser.userBadges : [])
  ];
  for (const badge of badges) {
    const text = typeof badge === "string"
      ? badge
      : [badge?.name, badge?.type, badge?.title, badge?.displayName, badge?.url].filter(Boolean).join(" ");
    if (text && ACTIVE_BADGE_PATTERNS.some((pattern) => pattern.test(text))) return text;
  }
  return "";
}

function teamMemberLevelFromUser(rawUser) {
  const direct = Number(rawUser?.teamMemberLevel || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const simplifiedBadge = Array.isArray(rawUser?.userBadges)
    ? rawUser.userBadges.find((badge) => Number(badge?.badgeSceneType) === 10 && Number(badge?.level || 0) > 0)
    : null;
  if (simplifiedBadge) return Number(simplifiedBadge.level);

  if (Array.isArray(rawUser?.badges)) {
    for (const badgeGroup of rawUser.badges) {
      if (!badgeGroup || typeof badgeGroup !== "object") continue;
      const scene = Number(firstDefined(badgeGroup.badgeSceneType, badgeGroup.badgeScene));
      if (scene !== 10) continue;
      const level = firstPositiveNumber(
        badgeGroup.level,
        badgeGroup.privilegeLogExtra?.level,
        ...(Array.isArray(badgeGroup.badges) ? badgeGroup.badges.map((badge) => badge?.level) : [])
      );
      return level || 1;
    }
  }
  return 0;
}

function fanClubStatusFromRaw(value) {
  const statusNumber = Number(value);
  if (Number.isFinite(statusNumber)) {
    if (statusNumber === 1) return "active";
    if (statusNumber === 2) return "inactive";
    if (statusNumber === 0) return "none";
  }
  const text = String(value || "").normalize("NFKC").toLowerCase();
  if (!text) return "";
  if (/inactive|sleep|frozen|freeze|expired|paused/.test(text)) return "inactive";
  if (/active|valid/.test(text)) return "active";
  if (/notjoined|not_joined|none|not joined/.test(text)) return "none";
  return "";
}

function badgeLevelFromText(value) {
  const match = String(value || "").match(/(?:lv|level|レベル)\s*[.:_-]?\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function normalizeGiftText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-・･.]/g, "");
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value || 0);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function firstBoolean(...values) {
  for (const value of values) {
    if (value === true || value === "true" || value === 1 || value === "1") return true;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
  }
  return null;
}
