/** 头像图片压缩参数：正方形边长与 WebP 质量。 */
const AVATAR_EDGE = 256;
const AVATAR_QUALITY = 0.9;
/** 原图体积上限（10MB）。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decode"));
    image.src = src;
  });

/**
 * 把本地图片裁剪成方形并压缩为 data URL（WebP 优先，失败回退 PNG）。
 * 结果直接存进团队头像色字段，体积控制在几十 KB，可随成员信息同步。
 */
export const readAvatarImage = async (file: File): Promise<string> => {
  if (!file.type.startsWith("image/")) {
    throw new Error("unsupported");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("too-large");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const edge = Math.min(image.naturalWidth, image.naturalHeight);
    if (!edge) {
      throw new Error("decode");
    }
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_EDGE;
    canvas.height = AVATAR_EDGE;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("canvas");
    }
    context.drawImage(
      image,
      (image.naturalWidth - edge) / 2,
      (image.naturalHeight - edge) / 2,
      edge,
      edge,
      0,
      0,
      AVATAR_EDGE,
      AVATAR_EDGE,
    );
    const webp = canvas.toDataURL("image/webp", AVATAR_QUALITY);
    return webp.startsWith("data:image/webp")
      ? webp
      : canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};
