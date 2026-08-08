/**
 * imagegen 工具调用（imagegen-generate）的公共解析逻辑与画廊布局工具。
 *
 * 被 ImageGenToolCall（单个调用）与 ImageGenGallery（并行调用合并画廊）共用，
 * 避免两处重复实现 parse 逻辑与分档列数规则。
 */

/** 上游服务商不支持单次调用多图（n>1 / prompts 数组）时，多图场景完全由
 *  并行独立调用构成；本文件同时支撑两种数据形态的解析。 */

export type ParsedImageGenArgs = {
  prompt: string;
  /** 逐请求不同提示词（一次调用生成多张不同设计稿）；提供时覆盖 n */
  prompts?: string[];
  model?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  outputCompression?: number;
  n?: number;
  provider?: string;
  personGeneration?: string;
  webSearch?: boolean;
  stream?: boolean;
  inputFidelity?: string;
  background?: string;
  moderation?: string;
  seed?: number;
  thinkingLevel?: string;
  imageSearch?: boolean;
  images?: Array<{
    data: string;
    mimeType: string;
    /** 纯文本主模型场景下的磁盘相对路径引用（upload/...），渲染端仅作占位展示 */
    path?: string;
  }>;
  /** 逐请求独立参考图组（第 i 组对应第 i 个请求） */
  requestImages?: Array<
    Array<{
      data: string;
      mimeType: string;
      path?: string;
    }>
  >;
};

export type GeneratedImage = {
  data: string;
  mimeType: string;
  /** 图库相对路径引用（image/...，图片已落盘到图库目录），经 IPC 读取；优先于 data */
  path?: string;
};

export type ParsedImageGenResult =
  | {
      type: "success";
      prompt: string;
      model: string;
      imageCount: number;
      images: GeneratedImage[];
      remoteUrls: string[];
      contentPreview: string;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

/** 画廊统一展示项：本地图片（data / path）+ 远程 URL（经 img-proxy 代理展示）。 */
export type GalleryItem = {
  key: string;
  src: string;
  image?: GeneratedImage;
  remoteUrl?: string;
};

/** 灯箱目标：本地图片或远程 URL。 */
export type LightboxTarget =
  | { kind: "image"; image: GeneratedImage }
  | { kind: "remote"; url: string };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseImageGenArgs = (args: string): ParsedImageGenArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      !isRecord(parsed) ||
      typeof parsed.prompt !== "string" ||
      parsed.prompt.trim() === ""
    ) {
      return null;
    }

    const result: ParsedImageGenArgs = { prompt: parsed.prompt };
    if (typeof parsed.model === "string") {
      result.model = parsed.model;
    }
    if (typeof parsed.size === "string") {
      result.size = parsed.size;
    }
    if (typeof parsed.quality === "string") {
      result.quality = parsed.quality;
    }
    if (typeof parsed.outputFormat === "string") {
      result.outputFormat = parsed.outputFormat;
    }
    if (typeof parsed.n === "number") {
      result.n = parsed.n;
    }
    if (typeof parsed.outputCompression === "number") {
      result.outputCompression = parsed.outputCompression;
    }
    if (typeof parsed.provider === "string" && parsed.provider.trim() !== "") {
      result.provider = parsed.provider;
    }
    if (typeof parsed.seed === "number") {
      result.seed = parsed.seed;
    }
    if (typeof parsed.thinkingLevel === "string") {
      result.thinkingLevel = parsed.thinkingLevel;
    }
    if (typeof parsed.imageSearch === "boolean") {
      result.imageSearch = parsed.imageSearch;
    }
    if (
      typeof parsed.personGeneration === "string" &&
      parsed.personGeneration.trim() !== ""
    ) {
      result.personGeneration = parsed.personGeneration;
    }
    if (typeof parsed.webSearch === "boolean") {
      result.webSearch = parsed.webSearch;
    }
    if (typeof parsed.stream === "boolean") {
      result.stream = parsed.stream;
    }
    if (typeof parsed.inputFidelity === "string") {
      result.inputFidelity = parsed.inputFidelity;
    }
    if (typeof parsed.background === "string") {
      result.background = parsed.background;
    }
    if (typeof parsed.moderation === "string") {
      result.moderation = parsed.moderation;
    }
    if (Array.isArray(parsed.images)) {
      const images: Array<{
        data: string;
        mimeType: string;
        path?: string;
      }> = [];
      for (const item of parsed.images) {
        if (isRecord(item) && typeof item.mimeType === "string") {
          if (typeof item.data === "string" && item.data.trim() !== "") {
            // 内联 base64 参考图
            images.push({ data: item.data, mimeType: item.mimeType });
          } else if (typeof item.path === "string" && item.path.trim() !== "") {
            // 磁盘路径引用（绝对路径或 upload/ 相对路径，来自文本化消息的
            // [Reference image #N ...] 块），服务端已按此路径读取原图完成
            // 图生图；渲染端无法直接访问该路径，以占位图展示
            images.push({
              data: "",
              mimeType: item.mimeType,
              path: item.path.trim(),
            });
          }
        }
      }
      if (images.length > 0) {
        result.images = images;
      }
    }
    if (Array.isArray(parsed.prompts)) {
      const prompts: string[] = [];
      for (const item of parsed.prompts) {
        if (typeof item === "string" && item.trim() !== "") {
          prompts.push(item.trim());
        }
      }
      if (prompts.length > 0) {
        result.prompts = prompts;
      }
    }
    if (Array.isArray(parsed.requestImages)) {
      const requestImages: NonNullable<ParsedImageGenArgs["requestImages"]> = [];
      for (const group of parsed.requestImages) {
        if (!Array.isArray(group)) {
          continue;
        }
        const groupItems: NonNullable<
          NonNullable<ParsedImageGenArgs["requestImages"]>[number]
        > = [];
        for (const item of group) {
          if (isRecord(item) && typeof item.mimeType === "string") {
            if (typeof item.data === "string" && item.data.trim() !== "") {
              groupItems.push({ data: item.data, mimeType: item.mimeType });
            } else if (typeof item.path === "string" && item.path.trim() !== "") {
              groupItems.push({
                data: "",
                mimeType: item.mimeType,
                path: item.path.trim(),
              });
            }
          }
        }
        if (groupItems.length > 0) {
          requestImages.push(groupItems);
        }
      }
      if (requestImages.length > 0) {
        result.requestImages = requestImages;
      }
    }
    return result;
  } catch {
    return null;
  }
};

/** 匹配 result 文本中追加的内联图片标签（@@image:data:...@@）。该标签由
 *  formatMcpToolResultForModel 在持久化时生成（真实 base64 换占位符 +
 *  标签），历史回放时由 Rust resolve_inline_images_from_disk 还原为
 *  data URL。剥离标签后 result 才是纯 JSON。 */
const INLINE_IMAGE_TAG_RE = /@@image:(data:[^@]+)@@/g;

export const parseImageGenResult = (
  result: string | undefined
): ParsedImageGenResult => {
  if (!result) {
    return { type: "empty" };
  }

  // 历史消息回放时 result 形如 "{JSON}\n@@image:data:...@@\n..."，
  // 直接 JSON.parse 会失败 → 走 raw 兜底把 JSON + base64 当文本展示
  // （表现为生图结果区域渲染出大量乱码/重复字符）。先提取并剥离标签。
  const inlineDataUrls: string[] = [];
  const stripped = result
    .replace(INLINE_IMAGE_TAG_RE, (_match, dataUrl: string) => {
      inlineDataUrls.push(dataUrl);
      return "";
    })
    .trim();

  try {
    const parsed: unknown = JSON.parse(stripped);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }

    const images: GeneratedImage[] = [];
    const remoteUrls: string[] = [];

    if (Array.isArray(parsed.content)) {
      let inlineIndex = 0;
      for (const block of parsed.content) {
        if (
          isRecord(block) &&
          block.type === "image" &&
          typeof block.mimeType === "string"
        ) {
          const data = typeof block.data === "string" ? block.data : "";
          // 存储时真实 base64 被替换为占位符，这里用标签中的 data URL 还原
          let resolvedData = data;
          if (
            (data === "" || data === "[attached as multimodal image]") &&
            inlineIndex < inlineDataUrls.length
          ) {
            const dataUrl = inlineDataUrls[inlineIndex];
            const comma = dataUrl.indexOf(",");
            if (comma > 0) {
              resolvedData = dataUrl.slice(comma + 1);
            }
          }
          inlineIndex += 1;
          if (
            typeof block.path === "string" &&
            block.path.trim() !== "" &&
            resolvedData === ""
          ) {
            // 图库落盘引用（image/...）：渲染时经 IPC 读取文件
            images.push({
              data: "",
              mimeType: block.mimeType as string,
              path: block.path.trim(),
            });
          } else {
            images.push({
              data: resolvedData,
              mimeType: block.mimeType as string,
            });
          }
        }
      }
    }

    if (Array.isArray(parsed.remoteUrls)) {
      for (const url of parsed.remoteUrls) {
        if (typeof url === "string" && url.trim() !== "") {
          remoteUrls.push(url);
        }
      }
    }

    if (images.length === 0 && remoteUrls.length === 0) {
      return { type: "raw", text: result };
    }

    return {
      type: "success",
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      imageCount:
        typeof parsed.imageCount === "number"
          ? parsed.imageCount
          : images.length + remoteUrls.length,
      images,
      remoteUrls,
      contentPreview:
        typeof parsed.contentPreview === "string" ? parsed.contentPreview : "",
    };
  } catch {
    return { type: "raw", text: result };
  }
};

export const truncateLabel = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

// ---------------------------------------------------------------------------
// 失败原因分类与国际化
//
// 后端（Rust）生成的错误消息是英文自由文本（含上游 API message 与修复
// 建议），无法整体翻译。这里按关键词将错误归类为有限的本地化类别，
// UI 层展示「本地化标题 + 原始英文详情（小字）」，既看懂原因又不丢细节。
// ---------------------------------------------------------------------------

export type ImageGenErrorKind =
  | "timeout"
  | "auth"
  | "rateLimit"
  | "server"
  | "network"
  | "noModel"
  | "modelUnsupported"
  | "missingPrompt"
  | "sizeInvalid"
  | "fallback";

export type ClassifiedImageGenError = {
  kind: ImageGenErrorKind;
  /** 原始英文错误消息（后端完整输出，保留细节与修复建议） */
  detail: string;
};

/** 错误分类规则：按顺序匹配，先精确后通用。 */
const ERROR_CLASSIFIERS: Array<{
  kind: ImageGenErrorKind;
  test: (lower: string) => boolean;
}> = [
  {
    kind: "timeout",
    test: (m) =>
      m.includes("timed out") ||
      m.includes("timeout") ||
      m.includes("deadline exceeded") ||
      m.includes("took too long"),
  },
  {
    kind: "auth",
    test: (m) =>
      m.includes("401") ||
      m.includes("403") ||
      m.includes("unauthorized") ||
      m.includes("authentication") ||
      m.includes("invalid api key") ||
      m.includes("api key") ||
      m.includes("permission denied") ||
      m.includes("forbidden"),
  },
  {
    kind: "rateLimit",
    test: (m) =>
      m.includes("429") ||
      m.includes("rate limit") ||
      m.includes("too many requests") ||
      m.includes("quota") ||
      m.includes("insufficient") ||
      m.includes("exceeded"),
  },
  {
    kind: "server",
    test: (m) =>
      m.includes("500") ||
      m.includes("502") ||
      m.includes("503") ||
      m.includes("504") ||
      m.includes("internal server") ||
      m.includes("server error") ||
      m.includes("service unavailable") ||
      m.includes("bad gateway"),
  },
  {
    kind: "network",
    test: (m) =>
      m.includes("connection") ||
      m.includes("connect ") ||
      m.includes("dns") ||
      m.includes("reqwest") ||
      m.includes("tls") ||
      m.includes("ssl") ||
      m.includes("certificate") ||
      m.includes("reset by peer") ||
      m.includes("unexpected eof") ||
      m.includes("failed to create http client"),
  },
  {
    kind: "noModel",
    test: (m) =>
      m.includes("no image model configured") ||
      m.includes("no model configured") ||
      m.includes("model is required"),
  },
  {
    kind: "modelUnsupported",
    test: (m) =>
      (m.includes("does not support image") ||
        m.includes("does not support image-to-image") ||
        m.includes("image input") ||
        m.includes("multimodal")) &&
      (m.includes("not supported") || m.includes("does not support")),
  },
  {
    kind: "missingPrompt",
    test: (m) =>
      m.includes("prompt is required") || m.includes("missing prompt"),
  },
  {
    kind: "sizeInvalid",
    test: (m) =>
      (m.includes("size") || m.includes("aspect ratio")) &&
      (m.includes("invalid") ||
        m.includes("not supported") ||
        m.includes("unsupported")),
  },
];

/** 将后端英文错误消息归类为本地化类别。 */
export const classifyImageGenError = (
  message: string
): ClassifiedImageGenError => {
  const lower = message.toLowerCase();
  for (const rule of ERROR_CLASSIFIERS) {
    if (rule.test(lower)) {
      return { kind: rule.kind, detail: message };
    }
  }
  return { kind: "fallback", detail: message };
};

/** 本地化标题对应的 i18n key（配合 t() 使用）。 */
export const imageGenErrorTitleKey = (kind: ImageGenErrorKind): string =>
  `toolCall.imagegen.error.${kind}`;

/** 宽高比超过该阈值视为超宽（通栏展示），低于该阈值视为超窄（限高展示） */
export const IMG_WIDE_RATIO = 1.6;
export const IMG_TALL_RATIO = 0.7;

/**
 * 并行图片分档列数（2-8 张全覆盖，宽容器 ≥640px 时生效）：
 *
 *   2 张 → 2 列一行（对比大图）
 *   3 张 → 3 列一行
 *   4 张 → 4 列一行（最常见场景，一行占满）
 *   5 张 → 3 列两行（3+2，尾行不孤，每张比 5 列一行更大）
 *   6 张 → 3 列两行（3+3 完美矩形）
 *   7 张 → 4 列两行（4+3，比 3 列两行（3+4）尾行更长更稳）
 *   8 张 → 4 列两行（4+4 完美矩形）
 *
 * 窄容器（<640px）由 ImageGenGallery 的容器查询自动降列
 * （3 列 → 2 列 → 1 列），避免小窗口下每格过窄。
 */
export const columnsForCount = (count: number): number => {
  if (count <= 4) return count;
  if (count <= 6) return 3;
  return 4;
};
