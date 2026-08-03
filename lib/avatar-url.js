export function avatarUrlFromUser(rawUser = {}) {
  const candidates = [
    rawUser.avatarLargeUrl,
    rawUser.avatarLarger,
    rawUser.avatarLarge,
    rawUser.avatarMedium,
    rawUser.avatarThumb,
    rawUser.profilePicture,
    rawUser.profilePictureUrl,
    rawUser.avatar,
    rawUser.avatar_url,
    rawUser.avatarUrl
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) return candidate;
    const list = candidate?.urlList || candidate?.url_list || candidate?.urls;
    if (Array.isArray(list)) {
      const url = list.find((item) => typeof item === "string" && /^https?:\/\//i.test(item));
      if (url) return url;
    }
  }
  return "";
}
