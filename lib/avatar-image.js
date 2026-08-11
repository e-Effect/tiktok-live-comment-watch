import sharp from "sharp";

export async function optimizeAvatarImage(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > 1024 * 1024) {
    throw new Error("Avatar image size is invalid");
  }
  const output = await sharp(data, { failOn: "none" })
    .rotate()
    .resize(128, 128, { fit: "cover", withoutEnlargement: true })
    .webp({ quality: 72, effort: 4 })
    .toBuffer();
  if (!output.length || output.length > 150 * 1024) throw new Error("Optimized avatar is invalid");
  return { data: output, mime: "image/webp" };
}
