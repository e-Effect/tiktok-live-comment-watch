const negativeClaimPattern = /(?:初見|初めまして|はじめまして|お初|初訪問|初めて|はじめて).*(?:じゃない|ではない|でわない|じゃありません|ではありません|じゃなく|ではなく|詐欺|のふり|扱い)/;

const directClaimPatterns = [
  /^(?:今日|この枠|この配信)?初見(?:です|ですが|だよ|だ|ですよ|になります|なんです|でございます)?(?:よろしく(?:お願い(?:します|いたします)?|です)?|こんにちは|こんばんは|お邪魔します|失礼します)?$/,
  /^(?:初めまして|はじめまして)(?:です|ですが|ですよ|でございます)?(?:よろしく(?:お願い(?:します|いたします)?|です)?)?$/,
  /^(?:お初|初訪問)(?:です|ですが|ですよ|になります)?(?:よろしく(?:お願い(?:します|いたします)?|です)?)?$/,
  /^(?:この枠|この配信)?(?:初めて|はじめて)(?:来ました|見に来ました|です|なんです|お邪魔します)(?:よろしく(?:お願い(?:します|いたします)?|です)?)?$/,
];

export function normalizeFirstVisitClaim(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/で[ー〜～~]+す/g, "です")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .slice(0, 180);
}

export function isFirstVisitClaim(value) {
  const normalized = normalizeFirstVisitClaim(value);
  if (!normalized || negativeClaimPattern.test(normalized)) return false;
  return directClaimPatterns.some((pattern) => pattern.test(normalized));
}
