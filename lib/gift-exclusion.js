// Use the gift ID when supplied; a different gift with a similar name is not a match.
export function isExcludedPerformanceGift(gift) {
  if (gift?.source === "initial" || !gift?.userId) return false;
  const id = String(gift.giftId || "");
  return id ? id === "14007" : String(gift.giftName || "").normalize("NFKC").trim() === "だいすき";
}

export async function createGiftExclusionAlert(gift, lookup) {
  if (!isExcludedPerformanceGift(gift) || !await lookup(String(gift.userId))) return null;
  return {
    id: `gift-excluded:${gift.id}`,
    type: "gift_excluded_alert",
    userId: String(gift.userId), uniqueId: gift.uniqueId || "",
    nickname: gift.nickname || gift.uniqueId || "TikTokユーザー",
    avatarUrl: gift.avatarUrl || "",
    text: "パフォーマンス対象外です。",
    at: Date.now(), source: gift.source || "live",
    payload: { giftId: gift.giftId || "14007", triggerEventId: gift.id },
  };
}
