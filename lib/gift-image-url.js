export function giftImageUrlFromEvent(data = {}, extended = {}) {
  const candidates = [
    data.giftPictureUrl,
    data.giftImageUrl,
    data.giftPicture,
    data.gift?.image,
    data.gift?.icon,
    data.giftDetails?.image,
    data.giftDetails?.icon,
    data.extendedGiftInfo?.image,
    data.extendedGiftInfo?.icon,
    extended.image,
    extended.icon,
    extended.picture,
    extended.imageUrl,
    extended.pictureUrl
  ];
  for (const candidate of candidates) {
    const url = imageUrlFromCandidate(candidate);
    if (url) return url;
  }
  return "";
}

function imageUrlFromCandidate(candidate) {
  if (typeof candidate === "string") return /^https:\/\//i.test(candidate.trim()) ? candidate.trim() : "";
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const url = imageUrlFromCandidate(item);
      if (url) return url;
    }
    return "";
  }
  if (!candidate || typeof candidate !== "object") return "";
  const nested = [
    candidate.url,
    candidate.src,
    candidate.uri,
    candidate.urlList,
    candidate.url_list,
    candidate.urls,
    candidate.webp,
    candidate.png
  ];
  for (const item of nested) {
    const url = imageUrlFromCandidate(item);
    if (url) return url;
  }
  return "";
}
