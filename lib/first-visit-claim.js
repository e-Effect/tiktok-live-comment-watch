const negativeClaimPattern = /(?:初見|初めまして|はじめまして|お初|初訪問|初めて|はじめて).*(?:じゃない|ではない|でわない|じゃありません|ではありません|じゃなく|ではなく|詐欺|のふり|扱い)/;
const greetingPrefix = /^(?:こんばんは|こんばんわ|こんにちは|こんにちわ|おはよう(?:ございます)?)/;
const actionSuffix = /(?:やりたいです|参加したいです|フォロ(?:してハトミ)?しました|ハトミしました)$/;

const directClaimPatterns = [
  /^(?:今日|この枠|この配信)?(?:初見|しょけん|ショケン)(?:です|でっす|ですう*|ですが|だよ|だお|だ|ですよ|になります|なんです|でございます|でござる|なり)?(?:よろしく(?:お願い(?:します|いたします)?|です|ね)?|こんにちは|こんばんは|お邪魔します|失礼します|初めまして|はじめまして)?$/,
  /^(?:初めまして|はじめまして)(?:です|ですが|ですよ|でございます)?(?:よろしく(?:お願い(?:します|いたします)?|です)?)?$/,
  /^(?:お初|初訪問)(?:です|ですが|ですよ|になります)?(?:よろしく(?:お願い(?:します|いたします)?|です)?)?$/,
  /^(?:この枠|この配信)?(?:初めて|はじめて)(?:来ました|来た|来たよ|見に来ました|見に来た|です|なんです|お邪魔します)(?:よろしく(?:お願い(?:します|いたします)?|です|ね)?)?$/,
];

export function normalizeFirstVisitClaim(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/で[ー〜～~]+す/g, "です")
    .replace(/ー+/g, "")
    .replace(/[\p{P}\p{S}\s\u200d\ufe0e\ufe0f]+/gu, "")
    .slice(0, 180);
}

export function isFirstVisitClaim(value) {
  const normalized = normalizeFirstVisitClaim(value);
  if (!normalized || negativeClaimPattern.test(normalized)) return false;
  const claim = normalized.replace(greetingPrefix, "").replace(actionSuffix, "");
  return directClaimPatterns.some((pattern) => pattern.test(claim));
}
