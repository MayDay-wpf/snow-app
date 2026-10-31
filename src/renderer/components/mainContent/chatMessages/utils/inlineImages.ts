import { localImageProxyUrl } from "../../../../utils/imageProxyUrl";

/**
 * 工具结果里的图片引用。
 *
 * Rust 执行工具后把图片写入 upload 目录，结果里只保留相对路径
 * （图片块 `{ type: "image", data: 占位符, path: "upload/..." }`，交给模型的
 * 文本追加 `@@image:upload/...@@` 标签）；旧数据仍可能是内联 data URL。
 * 渲染进程只拿路径，经 img-proxy 按需读盘显示，不在内存里持有 base64。
 */

/** 图片块 data 字段的占位符：真实图片在内联标签或落盘路径里。 */
export const IMAGE_DATA_PLACEHOLDER = "[attached as multimodal image]";

/** 内联图片标签 `@@image:<值>@@`，值为 data URL 或 upload/ 相对路径。 */
const INLINE_IMAGE_TAG_PATTERN = /@@image:([^@]+)@@/g;

/** 工具结果图片的落盘相对路径（upload/...）。 */
export const isUploadImagePath = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("upload/");

/** 标签值转为 <img> 地址：data URL 原样使用，路径经 img-proxy 读盘。 */
export const inlineImageSrc = (value: string): string =>
  value.startsWith("data:") ? value : localImageProxyUrl(value);

/** 剥离文本中的内联图片标签，返回剩余文本与按出现顺序的标签值。 */
export const stripInlineImageTags = (
  result: string,
): { text: string; values: string[] } => {
  const values: string[] = [];
  const text = result
    .replace(INLINE_IMAGE_TAG_PATTERN, (_match, value: string) => {
      values.push(value);
      return "";
    })
    .trim();
  return { text, values };
};

/**
 * 图片块转为 <img> 地址：data 为真实 base64 时直接使用；为占位符时依次消费
 * 内联标签值（交给模型的格式化结果），否则取块上的落盘路径（原始结果）。
 */
export const imageBlockSrc = (
  block: Record<string, unknown>,
  pendingInlineValues: string[],
): string | null => {
  const mimeType =
    typeof block.mimeType === "string" ? block.mimeType : "image/png";
  const data = typeof block.data === "string" ? block.data.trim() : "";
  if (data && data !== IMAGE_DATA_PLACEHOLDER) {
    return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
  }
  const inlineValue = pendingInlineValues.shift();
  if (inlineValue) {
    return inlineImageSrc(inlineValue);
  }
  return isUploadImagePath(block.path) ? localImageProxyUrl(block.path) : null;
};
