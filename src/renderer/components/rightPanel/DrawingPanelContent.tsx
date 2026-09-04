import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  AtSign,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  FileWarning,
  Gauge,
  Image as ImageIcon,
  ImageOff,
  ImagePlus,
  Images,
  KeyRound,
  Loader2,
  Maximize2,
  RefreshCw,
  Ruler,
  ServerCrash,
  Settings,
  ShieldAlert,
  Sparkles,
  TextCursorInput,
  Trash2,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { CustomSelect } from "../common/CustomSelect";
import {
  filterImageModels,
  inferModelCapabilities,
  isGrokModel,
  openaiFixedSizePresets,
  supportsSizeTier,
} from "./modelCapabilities";
import { DrawingPromptExamples } from "./DrawingPromptExamples";
import type { ModelCapabilities } from "./modelCapabilities";
import {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  IMAGE_GEN_SETTING_CODE,
} from "../sidebar/imagegenSettings/constants";
import {
  OPENAI_SIZE_PRESETS,
  OPENAI_SIZE_TIERS,
  buildGeminiSize,
  getGeminiResolution,
  getGeminiSizePresets,
  matchGeminiSizePreset,
  matchGrokSizePreset,
  matchOpenAISizePreset,
} from "../sidebar/imagegenSettings/constants";
import { readImageGenSettingsJson } from "../sidebar/imagegenSettings/utils";
import type { ImageGenChannelValue } from "../sidebar/imagegenSettings/types";
import { getErrorMessage } from "../mainContent/chatMessages/utils/conversationHelpers";
import {
  classifyImageGenError,
  imageGenErrorTitleKey,
  parseImageGenResult,
  type ClassifiedImageGenError,
  type GeneratedImage,
  type ImageGenErrorKind,
  type ParsedImageGenResult,
} from "../mainContent/chatMessages/toolCalls/imagegenUtils";
import {
  extensionForBlob,
  saveBlobToFile,
  srcToBlob,
} from "../../utils/imageDownload";
import {
  imageProxyUrl,
  localImageProxyUrl,
} from "../../utils/imageProxyUrl";

type DrawingPanelContentProps = {
  /** 当前 tab 是否激活：灯箱键盘快捷键仅在激活 tab 生效。 */
  isActive: boolean;
  /** 打开「图像生成」设置面板（错误卡片中的引导按钮）。 */
  onOpenImageGenSettings?: () => void;
};

/** 流式预览图（imagegen partial_image chunk）。 */
type StreamingImage = {
  index: number;
  mimeType: string;
  data: string;
};

type GenerationState =
  | { status: "idle" }
  | { status: "running"; streaming: StreamingImage[] }
  | { status: "done"; result: ParsedImageGenResult }
  | { status: "error"; error: ClassifiedImageGenError };

/** 画廊/灯箱统一展示项：本地图（data / 图库 path）+ 远程 URL。 */
type GalleryItem = {
  key: string;
  src: string;
  /** 本地图片路径（image/... 图库路径、upload/... 或绝对路径）：灯箱经 IPC 解析展示。 */
  path?: string;
  image?: GeneratedImage;
  record?: {
    id: string;
    relativePath: string;
    mimeType: string;
    prompt: string;
    createdAt: string;
  };
  remoteUrl?: string;
};

type LightboxState = {
  items: GalleryItem[];
  index: number;
};

/** 生成结果中图库落盘引用（image/... 前缀）的代理 URL 缓存。 */
const libraryProxyCache = new Map<string, string>();

/** 聚合模型列表项：模型 ID → 所属渠道（真实拉取，不做协议推断硬编码）。 */
type AggregatedModel = {
  id: string;
  channelId: string;
};

/** 生成数量选项（渲染时按模型能力上限 maxCount 过滤，如 grok 上限 10）。 */
const COUNT_OPTIONS = [1, 2, 4, 8, 10];

/**
 * 从 "WxH" 分辨率计算最简宽高比（如 1024x1024 → "1:1"、1792x1008 → "16:9"）。
 * 无法解析（非 WxH 格式，如 "auto"）返回空字符串。
 */
const ratioFromResolution = (size: string): string => {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim());
  if (!match) {
    return "";
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) {
    return "";
  }
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  if (divisor <= 1) {
    return `${width}:${height}`;
  }
  const w = width / divisor;
  const h = height / divisor;
  // 化简后数值过大（如 3840:1080）时保留原始分辨率，避免出现超长比例串。
  return w <= 100 && h <= 100 ? `${w}:${h}` : `${width}:${height}`;
};

/** OpenAI 输出格式选项（空 = 渠道默认）。 */
const OPENAI_FORMAT_OPTIONS = [
  { value: "", labelKey: "rightPanel.aiDrawing.formatDefault" },
  { value: "png", labelKey: "rightPanel.aiDrawing.formatPng" },
  { value: "jpeg", labelKey: "rightPanel.aiDrawing.formatJpeg" },
  { value: "webp", labelKey: "rightPanel.aiDrawing.formatWebp" },
];

/** OpenAI 输出压缩率选项（空 = 渠道默认）。 */
const COMPRESSION_OPTIONS = [
  { value: "", labelKey: "rightPanel.aiDrawing.compressionDefault" },
  { value: "10", labelKey: "rightPanel.aiDrawing.compression10" },
  { value: "50", labelKey: "rightPanel.aiDrawing.compression50" },
  { value: "90", labelKey: "rightPanel.aiDrawing.compression90" },
];

/** OpenAI 背景选项（透明背景仅 gpt-image-1 + png 生效）。 */
const BACKGROUND_OPTIONS = [
  { value: "", labelKey: "rightPanel.aiDrawing.backgroundDefault" },
  { value: "auto", labelKey: "rightPanel.aiDrawing.backgroundAuto" },
  { value: "opaque", labelKey: "rightPanel.aiDrawing.backgroundOpaque" },
  {
    value: "transparent",
    labelKey: "rightPanel.aiDrawing.backgroundTransparent",
  },
];

/** 保真度（图生图/编辑时生效）。 */
const FIDELITY_OPTIONS = [
  { value: "", labelKey: "rightPanel.aiDrawing.fidelityDefault" },
  { value: "auto", labelKey: "rightPanel.aiDrawing.fidelityAuto" },
  { value: "low", labelKey: "rightPanel.aiDrawing.fidelityLow" },
  { value: "high", labelKey: "rightPanel.aiDrawing.fidelityHigh" },
];

/** Gemini 思考级别。 */
const THINKING_OPTIONS = [
  { value: "", labelKey: "rightPanel.aiDrawing.thinkingDefault" },
  { value: "minimal", labelKey: "rightPanel.aiDrawing.thinkingMinimal" },
  { value: "high", labelKey: "rightPanel.aiDrawing.thinkingHigh" },
];

/** Gemini 人物生成策略。 */
const PERSON_OPTIONS = [
  { value: "", labelKey: "rightPanel.aiDrawing.personDefault" },
  { value: "dont_allow", labelKey: "rightPanel.aiDrawing.personDontAllow" },
  { value: "allow_all", labelKey: "rightPanel.aiDrawing.personAllowAll" },
  { value: "allow_adult", labelKey: "rightPanel.aiDrawing.personAllowAdult" },
];

const HISTORY_PAGE_SIZE = 20;

/**
 * 参考图数量兜底上限（未识别模型时使用；实际上限按模型能力
 * capabilities.maxReferenceImages 动态适配：gemini 3 系 14 / 2.5 系 3、
 * grok-imagine 3、openai gpt-image 14。与后端 imagegen 工具契约
 * MAX_IMAGES=14 保持一致）。
 */
const MAX_REF_IMAGES = 14;

/** 图片缓存（代理 URL / data URL）LRU 上限，避免长会话内存持续增长。 */
const IMAGE_CACHE_MAX = 300;

/** 工作台参数 + 草稿持久化键（localStorage，版本号便于未来迁移）。 */
const DRAWING_PERSIST_KEY = "snow:drawing-workbench:v1";

/**
 * 带 LRU 上限的 Map 写入：Map 保持插入顺序，超限时删除最旧的条目。
 */
const cacheSet = <K, V>(map: Map<K, V>, key: K, value: V, max: number): void => {
  if (map.has(key)) {
    map.delete(key); // 更新访问顺序：删除后重新插入到末尾
  }
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) {
      break;
    }
    map.delete(oldest.value);
  }
};

/** 把图库相对路径解析为可展示的代理 URL（带 LRU 缓存，避免重复构造）。 */
const proxyForLibraryPath = (path: string): string => {
  const cached = libraryProxyCache.get(path);
  if (cached) {
    cacheSet(libraryProxyCache, path, cached, IMAGE_CACHE_MAX); // LRU touch
    return cached;
  }
  const url = localImageProxyUrl(path);
  cacheSet(libraryProxyCache, path, url, IMAGE_CACHE_MAX);
  return url;
};

/** 图库图片的 data URL 缓存（IPC resolveLibraryImage，删除图片时同步失效）。 */
const libraryDataCache = new Map<string, string>();

/** 异步读取图库图片为 data URL（带 LRU 缓存；失败返回 null）。 */
const resolveLibraryDataUrl = async (path: string): Promise<string | null> => {
  const cached = libraryDataCache.get(path);
  if (cached) {
    cacheSet(libraryDataCache, path, cached, IMAGE_CACHE_MAX); // LRU touch
    return cached;
  }
  try {
    const dataUrl = await window.snow.resolveLibraryImage(path);
    if (dataUrl) {
      cacheSet(libraryDataCache, path, dataUrl, IMAGE_CACHE_MAX);
    }
    return dataUrl;
  } catch {
    return null;
  }
};

/** 上传/任意本地路径图片的 data URL 缓存（绝对路径或 upload/...，参考图用）。 */
const uploadDataCache = new Map<string, string>();

/** 异步读取 upload/ 相对路径或绝对路径图片为 data URL（带 LRU 缓存；失败返回 null）。 */
const resolveUploadDataUrl = async (path: string): Promise<string | null> => {
  const cached = uploadDataCache.get(path);
  if (cached) {
    cacheSet(uploadDataCache, path, cached, IMAGE_CACHE_MAX); // LRU touch
    return cached;
  }
  try {
    const dataUrl = await window.snow.resolveUploadImage(path);
    if (dataUrl) {
      cacheSet(uploadDataCache, path, dataUrl, IMAGE_CACHE_MAX);
    }
    return dataUrl;
  } catch {
    return null;
  }
};

/** 图片扩展名白名单（外部文件拖入判断用）。 */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|tiff?)$/i;

/** 按扩展名推断图片 MIME（上传参考图用；服务端亦会按扩展名兜底）。 */
const inferMimeFromPath = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
};

/**
 * 图库图片渲染组件：优先使用 img-proxy:// 协议（与聊天 markdown 图片同一链路），
 * 加载失败时自动回退到 IPC 读取的 data URL（聊天生成结果图链路），保证不出现破损图。
 */
function LibraryImage({
  path,
  src,
  alt,
  title,
  className,
  loading,
  onClick,
}: {
  /** 本地图库相对路径（image/...）；提供时忽略 src。 */
  path?: string;
  /** 直接图片 src（远程代理 URL / data URL）；仅无 path 时使用。 */
  src?: string;
  alt: string;
  title?: string;
  className?: string;
  loading?: "lazy" | "eager";
  onClick?: () => void;
}): React.JSX.Element {
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    // 预取 data URL 作为兜底（不阻塞首帧协议加载）。
    // 图库路径（image/...）走图库 IPC；upload/ 相对路径与绝对路径
    // （本地上传的参考图）走 resolveUploadImage（支持任意本地路径）。
    // 注意：path 变化时必须先清掉旧图的 data URL，否则同一组件实例
    // （灯箱左右切换、参考图 A→B）会一直残留并显示第一张已解析的图。
    const load = path.startsWith("image/")
      ? resolveLibraryDataUrl
      : resolveUploadDataUrl;
    setResolved(null);
    void load(path).then((dataUrl) => {
      if (!cancelled && dataUrl) {
        setResolved(dataUrl);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // 无 path：直接使用外部 src。
  if (!path) {
    return (
      <img
        src={src}
        alt={alt}
        title={title}
        className={className}
        loading={loading}
        onClick={onClick}
      />
    );
  }

  // 仅图库相对路径支持 img-proxy:// 协议；其余路径（upload/、绝对路径）
  // 无协议映射，只使用 IPC 解析出的 data URL。
  const isLibraryPath = path.startsWith("image/");
  const proxySrc = isLibraryPath ? proxyForLibraryPath(path) : undefined;
  const fallbackResolve = isLibraryPath
    ? resolveLibraryDataUrl
    : resolveUploadDataUrl;

  return (
    <img
      src={resolved ?? proxySrc}
      alt={alt}
      title={title}
      className={className}
      loading={loading}
      onClick={onClick}
      onError={() => {
        // 协议加载失败（如文件被移动）：回退 IPC data URL。
        const cached = isLibraryPath
          ? libraryDataCache.get(path)
          : uploadDataCache.get(path);
        if (cached) {
          setResolved(cached);
        } else {
          void fallbackResolve(path).then((dataUrl) => {
            if (dataUrl) {
              setResolved(dataUrl);
            }
          });
        }
      }}
    />
  );
}

/** 展示时间：MM-DD HH:mm。 */
const formatTime = (iso: string): string => {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours()
    )}:${pad(date.getMinutes())}`;
  } catch {
    return iso;
  }
};

/**
 * 错误分类 → 展示图标。同一图标按错误严重程度复用：
 * 红色 = 需要用户操作/服务端拒绝；橙色 = 可自行调整后重试。
 */
const ERROR_KIND_ICONS: Record<
  ImageGenErrorKind,
  React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
> = {
  timeout: Clock3,
  auth: KeyRound,
  rateLimit: Gauge,
  contentFiltered: ShieldAlert,
  server: ServerCrash,
  network: WifiOff,
  noModel: ImageOff,
  modelNotFound: FileWarning,
  modelUnsupported: Ban,
  missingPrompt: TextCursorInput,
  sizeInvalid: Ruler,
  invalidParams: AlertCircle,
  inputTooLarge: Maximize2,
  fallback: XCircle,
};

/** 需要引导用户去「图像生成设置」的错误类别（配置类问题）。 */
const ERROR_KINDS_OPEN_SETTINGS: ReadonlySet<ImageGenErrorKind> = new Set([
  "auth",
  "noModel",
  "modelNotFound",
]);

/** 错误建议文案 i18n key（本地化提示 + 修复引导）。 */
const errorHintKey = (kind: ImageGenErrorKind): string =>
  `rightPanel.aiDrawing.errorHint.${kind}`;

/**
 * 右侧面板「绘图工作台」：AI 绘图（复用系统现有 imagegen 全链路）。
 *
 * - 生成：复用 imagegen-generate MCP 工具（callMcpTool），渠道/模型/默认参数
 *   来自 设置 → 图像生成（imagegen_settings），无需重复配置
 * - 流式预览：partial_image chunk 实时展示中间结果
 * - 存储：生成结果由 Rust 侧自动落盘图库（image_library 表 + ~/.snowapp/image），
 *   工作台提供完整图库历史（缩略图网格 / 放大 / 删除 / 以图为参考重生成）
 * - 图生图：选择历史图作为参考图，复用 images 参数走编辑/重绘链路
 * - 导出：单张/全部保存（原生保存对话框，回退浏览器下载）
 */
/** 工作台可持久化参数（localStorage 草稿 + 参数；不含渠道/参考图等易失效数据）。 */
type PersistedDrawingParams = {
  prompt: string;
  negativePrompt: string;
  model: string;
  ratio: string;
  tier: string;
  resolution: string;
  quality: string;
  count: number;
  stream: boolean;
  outputFormat: string;
  outputCompression: string;
  background: string;
  inputFidelity: string;
  thinkingLevel: string;
  webSearch: boolean;
  imageSearch: boolean;
  personGeneration: string;
  seed: string;
  showAdvanced: boolean;
};

/** 从 localStorage 读取并净化持久化参数（脏数据/解析失败静默回退空对象）。 */
const readPersistedParams = (): Partial<PersistedDrawingParams> => {
  try {
    const raw = localStorage.getItem(DRAWING_PERSIST_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const clean: Partial<PersistedDrawingParams> = {};
    const str = (value: unknown): value is string => typeof value === "string";
    if (str(parsed.prompt)) clean.prompt = parsed.prompt;
    if (str(parsed.negativePrompt)) clean.negativePrompt = parsed.negativePrompt;
    if (str(parsed.model)) clean.model = parsed.model;
    if (str(parsed.ratio)) clean.ratio = parsed.ratio;
    if (str(parsed.tier)) clean.tier = parsed.tier;
    if (str(parsed.resolution)) clean.resolution = parsed.resolution;
    if (str(parsed.quality)) clean.quality = parsed.quality;
    if (
      typeof parsed.count === "number" &&
      Number.isInteger(parsed.count) &&
      COUNT_OPTIONS.includes(parsed.count)
    ) {
      clean.count = parsed.count;
    }
    if (typeof parsed.stream === "boolean") clean.stream = parsed.stream;
    if (str(parsed.outputFormat)) clean.outputFormat = parsed.outputFormat;
    if (str(parsed.outputCompression)) clean.outputCompression = parsed.outputCompression;
    if (str(parsed.background)) clean.background = parsed.background;
    if (str(parsed.inputFidelity)) clean.inputFidelity = parsed.inputFidelity;
    if (str(parsed.thinkingLevel)) clean.thinkingLevel = parsed.thinkingLevel;
    if (typeof parsed.webSearch === "boolean") clean.webSearch = parsed.webSearch;
    if (typeof parsed.imageSearch === "boolean") clean.imageSearch = parsed.imageSearch;
    if (str(parsed.personGeneration)) clean.personGeneration = parsed.personGeneration;
    if (str(parsed.seed)) clean.seed = parsed.seed;
    if (typeof parsed.showAdvanced === "boolean") clean.showAdvanced = parsed.showAdvanced;
    return clean;
  } catch {
    return {};
  }
};

/** 提示词中的参考图占位符：`{{Image N}}` / `{{image N}}`（大小写不敏感）。 */
const IMAGE_PLACEHOLDER_RE = /\{\{\s*[Ii]mage\s+(\d+)\s*\}\}/g;
const PROMPT_REF_SELECTOR = "[data-ref-token]";
const PROMPT_BLOCK_TAGS = new Set(["DIV", "P"]);

type PromptSelectionOffsets = { start: number; end: number };
type PromptDomBoundary = { node: Node; offset: number };

const readPromptEditor = (root: HTMLElement): string => {
  const serializeContainer = (parent: HTMLElement): string => {
    const units: string[] = [];
    let inline = "";
    let hasInlineNodes = false;
    const flushInline = (): void => {
      if (!hasInlineNodes) return;
      units.push(inline);
      inline = "";
      hasInlineNodes = false;
    };

    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        inline += node.textContent ?? "";
        hasInlineNodes = true;
        continue;
      }
      if (!(node instanceof HTMLElement)) continue;
      const token = node.dataset.refToken;
      if (token) {
        inline += token;
        hasInlineNodes = true;
        continue;
      }
      if (node.tagName === "BR") {
        inline += "\n";
        hasInlineNodes = true;
        continue;
      }
      if (!PROMPT_BLOCK_TAGS.has(node.tagName)) {
        inline += serializeContainer(node);
        hasInlineNodes = true;
        continue;
      }

      flushInline();
      const isPlaceholderBreak =
        node.childNodes.length === 1 &&
        node.firstChild instanceof HTMLElement &&
        node.firstChild.tagName === "BR";
      units.push(isPlaceholderBreak ? "" : serializeContainer(node));
    }
    flushInline();

    return units.reduce((result, unit, index) => {
      if (index === 0) return unit;
      const previous = units[index - 1];
      const separator = previous.endsWith("\n") || unit.startsWith("\n") ? "" : "\n";
      return result + separator + unit;
    }, "");
  };
  return serializeContainer(root);
};

const getPromptOffsetAt = (
  root: HTMLElement,
  container: Node,
  offset: number
): number | null => {
  if (container !== root && !root.contains(container)) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  try {
    before.setEnd(container, offset);
  } catch {
    return null;
  }
  const fragment = document.createElement("div");
  fragment.append(before.cloneContents());
  return readPromptEditor(fragment).length;
};

const getPromptSelectionOffset = (root: HTMLElement): number | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  return getPromptOffsetAt(root, selection.focusNode ?? root, selection.focusOffset);
};

const getPromptSelectionOffsets = (root: HTMLElement): PromptSelectionOffsets | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = getPromptOffsetAt(root, range.startContainer, range.startOffset);
  const end = getPromptOffsetAt(root, range.endContainer, range.endOffset);
  return start === null || end === null ? null : { start, end };
};

const getPromptDomBoundary = (root: HTMLElement, offset: number): PromptDomBoundary => {
  let remaining = Math.max(0, offset);
  const children = Array.from(root.childNodes);
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    const token = node instanceof HTMLElement ? node.dataset.refToken : undefined;
    const length = token?.length ?? node.textContent?.length ?? 0;
    if (remaining === 0) return { node: root, offset: index };
    if (remaining <= length) {
      return token
        ? { node: root, offset: index + 1 }
        : { node, offset: remaining };
    }
    remaining -= length;
  }
  return { node: root, offset: children.length };
};

const setPromptSelectionOffsets = (
  root: HTMLElement,
  offsets: PromptSelectionOffsets
): void => {
  const selection = window.getSelection();
  if (!selection) return;
  const start = getPromptDomBoundary(root, offsets.start);
  const end = getPromptDomBoundary(root, offsets.end);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
};

const setPromptCaretAfter = (node: Node): void => {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

const setPromptSelectionOffset = (root: HTMLElement, offset: number): void => {
  setPromptSelectionOffsets(root, { start: offset, end: offset });
};

/**
 * 默认反向提示词（自动预填；剥离 SD 权重语法，仅 Gemini Imagen 生效）。
 * 面向写实人物/服装类生成场景的通用负面词。
 */
const DEFAULT_NEGATIVE_PROMPT =
  "五官变形, 五官错位, 网红脸, 过度磨皮, 皮肤失真, 瘦身变形, 身材走形, " +
  "服装款式篡改, 面料变形, 纹理拉伸, AI感, 卡通感, 3D建模感, 低画质";

/**
 * 解析提示词中的 `{{Image N}}` 占位符（变量引用注入参考图）。
 *
 * 语义：`{{Image N}}` 引用上传的第 N 张参考图（1 起，与参考图缩略图编号
 * 角标一致）。替换为 `[Image N]`——OpenAI / Gemini 生图模型通用的图片
 * 引用惯例（prompt 中 "image 1" / "image 2" 指代第 1/2 张输入图）。
 *
 * @param refCount 已上传参考图数量（0..上限，上限按模型能力动态适配）
 * @returns expanded 替换后的提示词；unresolved 越界引用编号列表（N <= 0
 *   或 N > refCount），调用方应拦截生成并提示
 */
const resolveImagePlaceholders = (
  prompt: string,
  refCount: number
): { expanded: string; unresolved: number[] } => {
  const unresolved: number[] = [];
  const expanded = prompt.replace(IMAGE_PLACEHOLDER_RE, (match, rawIndex: string) => {
    const n = Number(rawIndex);
    if (n >= 1 && n <= refCount) {
      return `[Image ${n}]`;
    }
    unresolved.push(n);
    return match;
  });
  return { expanded, unresolved };
};

/**
 * 流式预览画廊（memo 隔离）：partial_image 高频更新时，
 * 父组件其余子树（参数栏/历史区）不随每帧重渲染。
 */
const StreamingGallery = memo(function StreamingGallery({
  items,
}: {
  items: StreamingImage[];
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="ai-drawing-gallery">
      {items.map((image) => (
        <div
          className="ai-drawing-gallery-item ai-drawing-gallery-item-streaming"
          key={`stream-${image.index}`}
        >
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={t("toolCall.imagegen.streamingPreview", {
              defaultValue: "Generating… preview",
            })}
          />
        </div>
      ))}
    </div>
  );
});

export function DrawingPanelContent({
  isActive,
  onOpenImageGenSettings,
}: DrawingPanelContentProps): React.JSX.Element {
  const { t } = useI18n();

  // ----------------------------------------------------------------
  // 参数区
  // ----------------------------------------------------------------
  /** 持久化参数（localStorage，首次渲染读取一次；后续经 effect 写入）。 */
  const [persisted] = useState(readPersistedParams);

  const [channels, setChannels] = useState<ImageGenChannelValue[]>([]);
  const [prompt, setPrompt] = useState(persisted.prompt ?? "");
  /** 反向提示词（仅 Gemini Imagen 生效；默认自动填充通用负面词，可编辑/清空）。 */
  const [negativePrompt, setNegativePrompt] = useState(
    persisted.negativePrompt ?? DEFAULT_NEGATIVE_PROMPT
  );
  const [channelId, setChannelId] = useState("");
  /** 当前选中的模型（聚合模型列表；优先恢复持久化值，加载完成后校验兜底）。 */
  const [model, setModel] = useState(persisted.model ?? "");
  /** 当前模型的 ref 镜像（loadModels 内部读取，避免切换模型触发重复拉取）。 */
  const modelRef = useRef(model);
  modelRef.current = model;
  /** 聚合模型列表（所有启用渠道模型 API 的并集，记录所属渠道）。 */
  const [modelList, setModelList] = useState<AggregatedModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  /** 模型列表拉取失败（无任何渠道返回可用模型）。 */
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  /** 宽高比（空 = 渠道默认）。 */
  const [ratio, setRatio] = useState(persisted.ratio ?? "");
  /** 档位 1K/2K/4K（空 = 渠道默认）。 */
  const [tier, setTier] = useState(persisted.tier ?? "");
  /** 分辨率（ratio-resolution 体系，如 xAI Grok 的 1k/2k；空 = 渠道默认）。 */
  const [resolution, setResolution] = useState(persisted.resolution ?? "");
  const [quality, setQuality] = useState(persisted.quality ?? "auto");
  const [count, setCount] = useState(persisted.count ?? 1);
  const [stream, setStream] = useState(persisted.stream ?? true);
  // 高级参数（按渠道协议分别生效）
  const [showAdvanced, setShowAdvanced] = useState(
    persisted.showAdvanced ?? false
  );
  const [outputFormat, setOutputFormat] = useState(persisted.outputFormat ?? "");
  const [outputCompression, setOutputCompression] = useState(
    persisted.outputCompression ?? ""
  );
  const [background, setBackground] = useState(persisted.background ?? "");
  const [inputFidelity, setInputFidelity] = useState(persisted.inputFidelity ?? "");
  const [thinkingLevel, setThinkingLevel] = useState(
    persisted.thinkingLevel ?? ""
  );
  const [webSearch, setWebSearch] = useState(persisted.webSearch ?? false);
  const [imageSearch, setImageSearch] = useState(persisted.imageSearch ?? false);
  const [personGeneration, setPersonGeneration] = useState(
    persisted.personGeneration ?? ""
  );
  const [seed, setSeed] = useState(persisted.seed ?? "");
  /** 图生图参考图列表（上限按模型能力动态适配；图库相对路径 image/... 或本地绝对路径）。 */
  const [refImages, setRefImages] = useState<Array<{ path: string; mimeType: string }>>([]);
  /** 参考图 ref 镜像（事件/拖拽追加时同步读取，避免闭包过期）。 */
  const refImagesRef = useRef(refImages);
  refImagesRef.current = refImages;

  /** maxRefLimit 的 ref 镜像（appendRefImages 内部读取，避免闭包过期；
   *  实际上限在 capabilities 派生后同步，见下）。 */
  const maxRefLimitRef = useRef(MAX_REF_IMAGES);
  /** 提示词 contenteditable 编辑器 ref。 */
  const promptEditorRef = useRef<HTMLDivElement | null>(null);
  const promptComposingRef = useRef(false);
  const promptRendererRef = useRef<((value: string) => void) | null>(null);
  const promptPresentationRefreshPendingRef = useRef(false);

  /** 追加参考图（去重 + 上限）；返回追加张数与跳过原因。 */
  const appendRefImages = useCallback(
    (
      images: Array<{ path: string; mimeType: string }>
    ): { added: number; duplicate: boolean; overLimit: boolean } => {
      const current = refImagesRef.current;
      const seen = new Set(current.map((item) => item.path));
      const next = [...current];
      let duplicate = false;
      let overLimit = false;
      for (const image of images) {
        if (seen.has(image.path)) {
          duplicate = true;
          continue;
        }
        if (next.length >= maxRefLimitRef.current) {
          overLimit = true;
          continue;
        }
        seen.add(image.path);
        next.push(image);
      }
      if (next.length !== current.length) {
        setRefImages(next);
      }
      return { added: next.length - current.length, duplicate, overLimit };
    },
    []
  );

  // 图库面板「设为参考图」事件（跨组件联动；组件常驻渲染，挂载即监听）。
  useEffect(() => {
    const handleSetReference = (event: Event): void => {
      const detail = (
        event as CustomEvent<{ path?: unknown; mimeType?: unknown }>
      ).detail;
      if (typeof detail?.path !== "string" || !detail.path) {
        return;
      }
      appendRefImages([
        {
          path: detail.path,
          mimeType:
            typeof detail.mimeType === "string" ? detail.mimeType : "image/png",
        },
      ]);
    };
    window.addEventListener("drawing:set-reference", handleSetReference);
    return () =>
      window.removeEventListener("drawing:set-reference", handleSetReference);
  }, [appendRefImages]);

  const [gen, setGen] = useState<GenerationState>({ status: "idle" });
  /** 用户已取消当前生成：IPC 完成后丢弃结果（后端无中断通道，仅前端放弃）。 */
  const cancelledRef = useRef(false);
  /** 生成代际序号：取消/新生成后旧 IPC 的 chunk 与结果全部作废，防串台。 */
  const genSeqRef = useRef(0);
  /** 流式帧合并缓冲（rAF 每帧 flush 一次，降低高频 chunk 的重渲染开销）。 */
  const pendingFramesRef = useRef<StreamingImage[]>([]);
  const rafRef = useRef<number | null>(null);
  /** 本次生成开始时刻（耗时统计）。 */
  const genStartedAtRef = useRef(0);
  /** 最近一次生成耗时（毫秒，结果标题栏展示）。 */
  const [lastDurationMs, setLastDurationMs] = useState(0);

  // 图库历史（存储的生成图片索引）
  const [library, setLibrary] = useState<
    Array<{
      id: string;
      relativePath: string;
      mimeType: string;
      prompt: string;
      createdAt: string;
    }>
  >([]);
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE);
  /** 图库历史是否折叠（仅标题行；瞬态不持久化）。 */
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  /** 图库历史搜索词（按提示词过滤）。 */
  const [historyQuery, setHistoryQuery] = useState("");
  /** 待删除确认的图库图片（弹窗确认）。 */
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    relativePath: string;
  } | null>(null);

  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  /** 将渠道默认尺寸同步到宽高比/档位/分辨率（切换渠道时调用）。 */
  const syncChannelSize = useCallback((channel: ImageGenChannelValue) => {
    setRatio("");
    setTier("");
    setResolution("");
    if (channel.provider === "gemini") {
      const preset = matchGeminiSizePreset(channel.defaultSize);
      setRatio(preset.ratio);
      setTier(preset.imageSize);
    } else if (isGrokModel(channel.model)) {
      // xAI Grok：尺寸 = 宽高比 + 分辨率（1k/2k），存储格式 "16:9@2k"
      const preset = matchGrokSizePreset(channel.defaultSize);
      setRatio(preset.ratio);
      setResolution(preset.resolution);
    } else {
      const preset = matchOpenAISizePreset(channel.defaultSize);
      if (preset) {
        setRatio(preset.ratio);
        setTier(preset.tier);
      } else {
        // 渠道默认无法匹配预设（自定义分辨率或 auto）：尽力解析出宽高比展示，
        // 档位留空（跟随渠道默认），避免下拉框只显示「渠道默认」这种抽象文案。
        // 仅当化简出的比例属于当前模型的可用选项时才填充，否则保持空
        // （「默认」选项的展示文本会由 defaultRatioLabel 兜底，避免 select 空白）。
        const fallbackRatio = ratioFromResolution(channel.defaultSize);
        const ratioAvailable = supportsSizeTier(channel.provider, channel.model)
          ? fallbackRatio in OPENAI_SIZE_PRESETS
          : openaiFixedSizePresets(channel.model).some(
              (item) => item.ratio === fallbackRatio
            );
        setRatio(fallbackRatio && ratioAvailable ? fallbackRatio : "");
        setTier("");
      }
    }
  }, []);

  /** 已同步过默认尺寸的渠道（避免刷新配置时重置用户手选的比例/档位）。 */
  const lastSyncedChannelRef = useRef<string | null>(null);

  // 读取现有生图渠道配置（复用设置面板同一解析逻辑）。
  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const raw = await window.snow.getSystemSettingValue(
        IMAGE_GEN_SETTING_CODE
      );
      const settings = readImageGenSettingsJson(raw);
      const usable = settings.channels.filter(
        (channel) => channel.enabled && channel.model.trim() !== ""
      );
      setChannels(usable);
      // 保留当前选中渠道（若仍可用），否则回退第一个可用渠道。
      const keepId = usable.some((channel) => channel.id === channelId)
        ? channelId
        : usable[0]?.id ?? "";
      setChannelId(keepId);
      const channel = usable.find((item) => item.id === keepId) ?? usable[0];
      // 仅当渠道真正变化时同步默认尺寸，避免覆盖用户手动选择的参数。
      if (channel && lastSyncedChannelRef.current !== keepId) {
        lastSyncedChannelRef.current = keepId;
        syncChannelSize(channel);
      }
    } catch (error) {
      console.warn("[ai-drawing] load imagegen settings failed", error);
    }
  }, [channelId, syncChannelSize]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  /**
   * 聚合所有启用渠道的模型 API（OpenAI /v1/models、Gemini models.list），
   * 筛选出生图模型并按模型 ID 去重（保留首个渠道；渠道配置的模型
   * 不在 API 列表中时也补充进列表）。不做任何硬编码模型候选。
   */
  const loadModels = useCallback(async (): Promise<void> => {
    if (channels.length === 0) {
      setModelList([]);
      setModelsLoadFailed(false);
      return;
    }
    setModelsLoading(true);
    setModelsLoadFailed(false);
    const aggregated: AggregatedModel[] = [];
    try {
      for (const channel of channels) {
        const isGemini = channel.provider === "gemini";
        try {
          const all = await window.snow.fetchAvailableModelsForConfig({
            baseUrl:
              channel.baseUrl.trim() ||
              (isGemini ? DEFAULT_GEMINI_BASE_URL : DEFAULT_OPENAI_BASE_URL),
            baseUrlMode: "custom",
            apiKey: channel.apiKey.trim(),
            requestMethod: isGemini ? "gemini" : "openai",
            customHeaderSchemeId: "",
          });
          const imageModels = filterImageModels(all, channel.provider);
          for (const item of imageModels) {
            aggregated.push({ id: item.id, channelId: channel.id });
          }
        } catch (error) {
          console.warn(
            `[ai-drawing] fetch models failed for channel ${channel.id}`,
            error
          );
        }
        // 渠道配置的模型补充进列表（API 拉取失败或自定义模型名时仍可用）。
        const channelModel = channel.model.trim();
        if (channelModel && !aggregated.some((item) => item.id === channelModel)) {
          aggregated.push({ id: channelModel, channelId: channel.id });
        }
      }
      // 模型 ID 去重：同 ID 出现在多个渠道时保留第一个（生成走其所属渠道）。
      const seen = new Map<string, AggregatedModel>();
      for (const item of aggregated) {
        if (!seen.has(item.id)) {
          seen.set(item.id, item);
        }
      }
      const list = [...seen.values()];
      setModelList(list);
      if (list.length === 0) {
        setModelsLoadFailed(true);
        return;
      }
      // 保留当前选中的模型（若仍可用），否则默认选中列表第一个，
      // 并同步到其所属渠道的默认尺寸（仅当模型真正变化时）。
      const currentModel = modelRef.current;
      const keepModel = list.some((item) => item.id === currentModel)
        ? currentModel
        : list[0].id;
      setModel(keepModel);
      if (keepModel !== currentModel) {
        const target = channels.find(
          (channel) =>
            channel.id ===
            (list.find((item) => item.id === keepModel)?.channelId ?? "")
        );
        if (target) {
          setChannelId(target.id);
          // 同步渠道切换标记：随后因 channelId 变化触发的 loadSettings
          // 不再重复 syncChannelSize，也避免并发加载时旧渠道状态回写。
          lastSyncedChannelRef.current = target.id;
          syncChannelSize(target);
        }
      }
    } finally {
      setModelsLoading(false);
    }
  }, [channels, syncChannelSize]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // ----------------------------------------------------------------
  // 派生参数：当前渠道、组装 size、Gemini 档位候选、模型能力
  // ----------------------------------------------------------------
  const selectedChannel = channels.find((channel) => channel.id === channelId);
  const isGemini = selectedChannel?.provider === "gemini";

  /** 当前生效模型（模型覆盖值优先，否则回退渠道默认）。 */
  const effectiveModel = model.trim() || selectedChannel?.model || "";

  /** 按当前生效模型推断能力（决定条件渲染）。 */
  const capabilities: ModelCapabilities | null = selectedChannel
    ? inferModelCapabilities(selectedChannel.provider, effectiveModel)
    : null;

  /** 参考图数量上限（按当前模型能力；未识别模型兜底 MAX_REF_IMAGES）。 */
  const maxRefLimit = capabilities?.maxReferenceImages ?? MAX_REF_IMAGES;
  maxRefLimitRef.current = maxRefLimit;

  /** 三位一体尺寸控件弹层开关（比例 × 尺寸 × 质量）。 */
  const [sizePanelOpen, setSizePanelOpen] = useState(false);
  const [sizePopoverRect, setSizePopoverRect] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const sizeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const updateSizePopoverPosition = useCallback((): void => {
    const trigger = sizeTriggerRef.current;
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const preferredWidth = 272;
    const width = Math.min(
      preferredWidth,
      Math.max(0, window.innerWidth - viewportPadding * 2)
    );
    const maxLeft = Math.max(
      viewportPadding,
      window.innerWidth - width - viewportPadding
    );
    const left = Math.min(
      Math.max(triggerRect.left, viewportPadding),
      maxLeft
    );
    const estimatedHeight = 420;
    const spaceBelow = window.innerHeight - triggerRect.bottom - viewportPadding;
    const spaceAbove = triggerRect.top - viewportPadding;
    const openAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
    const availableHeight = Math.max(
      80,
      Math.min(estimatedHeight, (openAbove ? spaceAbove : spaceBelow) - 6)
    );
    const top = openAbove
      ? Math.max(viewportPadding, triggerRect.top - availableHeight - 6)
      : triggerRect.bottom + 6;
    setSizePopoverRect({
      top,
      left,
      width,
      maxHeight: availableHeight,
    });
  }, []);

  useLayoutEffect(() => {
    if (!sizePanelOpen) {
      setSizePopoverRect(null);
      return;
    }
    updateSizePopoverPosition();
    window.addEventListener("resize", updateSizePopoverPosition);
    window.addEventListener("scroll", updateSizePopoverPosition, true);
    const triggerParent = sizeTriggerRef.current?.parentElement;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateSizePopoverPosition);
    if (triggerParent && resizeObserver) {
      resizeObserver.observe(triggerParent);
    }
    return () => {
      window.removeEventListener("resize", updateSizePopoverPosition);
      window.removeEventListener("scroll", updateSizePopoverPosition, true);
      resizeObserver?.disconnect();
    };
  }, [sizePanelOpen, updateSizePopoverPosition]);

  /** 当前模型是否支持「档位」（1K/2K/4K；OpenAI 仅 gpt-image-2 系，Gemini 全系）。 */
  const showTier = selectedChannel
    ? supportsSizeTier(selectedChannel.provider, effectiveModel)
    : false;

  /** 无档位 OpenAI 模型的固定尺寸预设（dall-e-3 / gpt-image-1 等）。 */
  const fixedSizePresets = useMemo(() => {
    if (!selectedChannel || selectedChannel.provider === "gemini" || showTier) {
      return [];
    }
    return openaiFixedSizePresets(effectiveModel);
  }, [selectedChannel, showTier, effectiveModel]);

  /** 当前模型的质量选项（按能力裁剪；空数组 = 隐藏质量控件）。 */
  const qualityOptions = useMemo(
    () => capabilities?.qualityOptions ?? [],
    [capabilities]
  );

  /** 组装后的 size 参数（"" = 渠道默认；ratio-resolution 体系不组装，见 handleGenerate）。 */
  const effectiveSize = useMemo((): string => {
    if (!selectedChannel) {
      return "";
    }
    if (selectedChannel.provider === "gemini") {
      return buildGeminiSize(ratio, tier);
    }
    if (capabilities?.sizeSystem === "ratio-resolution") {
      return "";
    }
    if (showTier && ratio && tier) {
      const presets = OPENAI_SIZE_PRESETS[ratio];
      if (presets && (OPENAI_SIZE_TIERS as readonly string[]).includes(tier)) {
        return presets[tier as keyof typeof presets];
      }
      return "";
    }
    // 无档位模型：宽高比 → 固定分辨率
    if (!showTier && ratio) {
      const preset = openaiFixedSizePresets(effectiveModel).find(
        (item) => item.ratio === ratio
      );
      if (preset) {
        return preset.size;
      }
    }
    return "";
  }, [selectedChannel, ratio, tier, showTier, effectiveModel, capabilities]);

  /** 渠道默认尺寸原文（空 = 未配置，如渠道使用服务商默认）。 */
  const channelDefaultSize = (selectedChannel?.defaultSize ?? "").trim();

  /** 渠道默认质量原文（空 = 未配置；「默认」选项展示用，实际参数由 Rust 侧应用）。 */
  const channelDefaultQuality = (selectedChannel?.defaultQuality ?? "").trim();

  /** 宽高比下拉「默认」选项的展示文本：优先显示渠道默认解析出的比例，否则显示默认尺寸原文。 */
  const defaultRatioLabel = useMemo((): string => {
    if (!selectedChannel || !channelDefaultSize) {
      return "";
    }
    if (selectedChannel.provider === "gemini") {
      return matchGeminiSizePreset(channelDefaultSize).ratio;
    }
    if (capabilities?.sizeSystem === "ratio-resolution") {
      return matchGrokSizePreset(channelDefaultSize).ratio;
    }
    return (
      matchOpenAISizePreset(channelDefaultSize)?.ratio ??
      ratioFromResolution(channelDefaultSize)
    );
  }, [selectedChannel, channelDefaultSize, capabilities]);

  /** 尺寸/分辨率下拉「默认」选项的展示文本：优先显示渠道默认解析出的具体值，否则显示默认尺寸原文。 */
  const defaultTierLabel = useMemo((): string => {
    if (!selectedChannel || !channelDefaultSize) {
      return "";
    }
    if (selectedChannel.provider === "gemini") {
      const preset = matchGeminiSizePreset(channelDefaultSize);
      return preset.imageSize || preset.ratio || "";
    }
    if (capabilities?.sizeSystem === "ratio-resolution") {
      const preset = matchGrokSizePreset(channelDefaultSize);
      return preset.resolution || preset.ratio || "";
    }
    const preset = matchOpenAISizePreset(channelDefaultSize);
    if (preset) {
      return OPENAI_SIZE_PRESETS[preset.ratio]?.[preset.tier] ?? preset.tier;
    }
    return channelDefaultSize;
  }, [selectedChannel, channelDefaultSize, capabilities]);

  /** Gemini 档位候选（按模型能力过滤）。 */
  const geminiTierOptions = useMemo(() => {
    if (!selectedChannel || selectedChannel.provider !== "gemini") {
      return [];
    }
    return getGeminiSizePresets(model.trim() || selectedChannel.model);
  }, [selectedChannel, model]);

  /** 三位一体控件：比例候选（按尺寸体系裁剪；空 = 不显示比例选择）。 */
  const sizeRatioOptions = useMemo((): string[] => {
    if (!capabilities) {
      return [];
    }
    if (
      capabilities.sizeSystem === "ratio-resolution" ||
      capabilities.sizeSystem === "gemini-tier"
    ) {
      return capabilities.ratios;
    }
    // openai-size：档位模型显示全部比例（gpt-image-2），
    // 无档位模型仅显示固定预设支持的比例（dall-e-3 / gpt-image-1）。
    return showTier
      ? Object.keys(OPENAI_SIZE_PRESETS)
      : fixedSizePresets.map((preset) => preset.ratio);
  }, [capabilities, showTier, fixedSizePresets]);

  /** 三位一体控件：尺寸候选（档位/分辨率；空 = 隐藏尺寸行，比例定尺寸）。 */
  const sizeTierOptions = useMemo((): string[] => {
    if (!capabilities) {
      return [];
    }
    if (capabilities.sizeSystem === "gemini-tier") {
      return geminiTierOptions;
    }
    if (capabilities.sizeSystem === "ratio-resolution") {
      return [...capabilities.resolutions];
    }
    return showTier ? [...OPENAI_SIZE_TIERS] : [];
  }, [capabilities, geminiTierOptions, showTier]);

  /** 当前生效的尺寸值（gemini/openai 档位 → tier；ratio-resolution → resolution）。 */
  const activeSize = capabilities?.sizeSystem === "ratio-resolution"
    ? resolution
    : tier;

  /** 尺寸候选副文本（实际分辨率，仅展示；无对应值返回空）。 */
  const sizeTierHint = useCallback(
    (value: string): string => {
      if (!capabilities || value === "") {
        return "";
      }
      if (capabilities.sizeSystem === "gemini-tier") {
        return ratio ? getGeminiResolution(effectiveModel, ratio, value) : "";
      }
      if (capabilities.sizeSystem === "ratio-resolution") {
        return ""; // grok 的 1k/2k 即档位名，无分辨率副文本
      }
      if (ratio && OPENAI_SIZE_PRESETS[ratio]) {
        return (
          OPENAI_SIZE_PRESETS[ratio][value as "1K" | "2K" | "4K"] ?? ""
        );
      }
      return "";
    },
    [capabilities, ratio, effectiveModel]
  );

  /** 尺寸候选选中判定（含「默认」空值）。 */
  const isSizeActive = useCallback(
    (value: string): boolean =>
      value === "" ? activeSize === "" : activeSize === value,
    [activeSize]
  );

  /** 尺寸候选选择（按体系写入 tier 或 resolution）。 */
  const handleSizeSelect = useCallback(
    (value: string): void => {
      if (capabilities?.sizeSystem === "ratio-resolution") {
        setResolution(value);
      } else {
        setTier(value);
      }
    },
    [capabilities]
  );

  /** 三位一体控件按钮摘要：比例 · 尺寸 · 质量（各维度按能力裁剪）。 */
  const sizeSummary = useMemo((): string => {
    const parts: string[] = [];
    const ratioText = ratio || defaultRatioLabel || "";
    if (ratioText) {
      parts.push(ratioText);
    }
    let sizeText = "";
    if (capabilities?.sizeSystem === "ratio-resolution") {
      sizeText = resolution || defaultTierLabel || "";
    } else if (capabilities?.sizeSystem === "gemini-tier" || showTier) {
      sizeText = tier || defaultTierLabel || "";
    } else if (ratio) {
      // 无档位模型：比例已决定固定分辨率
      sizeText =
        fixedSizePresets.find((preset) => preset.ratio === ratio)?.size ?? "";
    }
    if (sizeText) {
      parts.push(sizeText);
    }
    if (qualityOptions.length > 0) {
      const option = qualityOptions.find((item) => item.value === quality);
      parts.push(option ? t(option.labelKey) : t("rightPanel.aiDrawing.qualityDefault"));
    }
    return parts.length > 0
      ? parts.join(" · ")
      : t("rightPanel.aiDrawing.sizeDefault");
  }, [
    ratio,
    defaultRatioLabel,
    resolution,
    tier,
    defaultTierLabel,
    capabilities,
    showTier,
    fixedSizePresets,
    qualityOptions,
    quality,
    t,
  ]);

  /** 数量选项按模型能力裁剪（上限 maxCount；grok 支持到 10）。 */
  const countOptions = useMemo(
    () =>
      capabilities
        ? COUNT_OPTIONS.filter((value) => value <= capabilities.maxCount)
        : COUNT_OPTIONS,
    [capabilities]
  );

  /** 模型能力联动：不支持的选项自动回退（数量/透明背景/档位/搜索）。 */
  useEffect(() => {
    if (!capabilities) {
      return;
    }
    if (count > capabilities.maxCount) {
      setCount(capabilities.maxCount);
    }
    if (!capabilities.supportsMultiCount && count > 1) {
      setCount(1);
    }
    if (!capabilities.supportsTransparent && background === "transparent") {
      setBackground("");
    }
    if (!capabilities.supportsWebSearch && webSearch) {
      setWebSearch(false);
    }
    if (!capabilities.supportsImageSearch && imageSearch) {
      setImageSearch(false);
    }
  }, [capabilities, count, background, webSearch, imageSearch]);

  /** 质量选项联动：模型变化后当前值不在选项内时回退（默认 → auto → high → 首项）。 */
  useEffect(() => {
    const options = qualityOptions;
    if (options.length === 0) {
      return; // 无质量参数的模型：保留当前值但不发送
    }
    if (options.some((option) => option.value === quality)) {
      return;
    }
    const fallback =
      options.find((option) => option.value === "")?.value ??
      options.find((option) => option.value === "auto")?.value ??
      options.find((option) => option.value === "high")?.value ??
      options[0].value;
    setQuality(fallback);
  }, [qualityOptions, quality]);

  useEffect(() => {
    if (isGemini && tier && geminiTierOptions.length > 0) {
      if (!geminiTierOptions.includes(tier)) {
        setTier("");
      }
    }
  }, [isGemini, tier, geminiTierOptions]);

  /**
   * 模型选择变化：记录选中模型；若其所属渠道与当前渠道不同，
   * 自动切换到该渠道并同步其默认尺寸/档位。
   * 模型 → 渠道映射来自聚合的真实模型列表（不做协议推断硬编码）。
   */
  const handleModelChange = useCallback(
    (value: string) => {
      setModel(value);
      const entry = modelList.find((item) => item.id === value);
      if (!entry || !selectedChannel || entry.channelId === selectedChannel.id) {
        return;
      }
      const target = channels.find((channel) => channel.id === entry.channelId);
      if (!target) {
        return;
      }
      setChannelId(target.id);
      syncChannelSize(target);
    },
    [modelList, channels, selectedChannel, syncChannelSize]
  );

  // ----------------------------------------------------------------
  // 生成（复用 imagegen-generate MCP 工具 + 流式 partial_image 预览）
  // ----------------------------------------------------------------
  const isGenerating = gen.status === "running";

  /** 流式预览是否实际可用：数量>1 或存在参考图（图生图）时后端不支持（镜像其约束）。 */
  const streamDisabled =
    count > 1 ||
    (refImages.length > 0 && capabilities?.supportsReference !== false);
  const effectiveStream = streamDisabled ? false : stream;

  const handleGenerate = useCallback(async (): Promise<void> => {
    const rawText = prompt.trim();
    if (!rawText || isGenerating) {
      return;
    }
    // 变量引用注入：提示词中 `{{Image N}}` → `[Image N]`（模型图片引用惯例），
    // 对应第 N 张参考图；越界/无参考图引用则拦截并提示（不静默丢弃）。
    const { expanded, unresolved } = resolveImagePlaceholders(
      rawText,
      refImages.length
    );
    if (unresolved.length > 0) {
      setImportNotice({
        kind: "error",
        text: t("rightPanel.aiDrawing.refPlaceholderOutOfRange", {
          values: {
            refs: unresolved.map((n) => `{{Image ${n}}}`).join("、"),
            count: refImages.length,
          },
        }),
      });
      return;
    }
    const text = expanded;
    const args: Record<string, unknown> = {
      prompt: text,
      // 流式：模型不支持（如 xAI Grok）或场景不支持（多图/图生图）时强制关闭
      stream: capabilities?.supportsStream === false ? false : effectiveStream,
    };
    if (channelId) {
      args.provider = channelId;
    }
    if (model.trim()) {
      args.model = model.trim();
    }
    // ratio-resolution 体系（xAI Grok）：尺寸 = aspect_ratio + resolution，
    // 不走 OpenAI 的 size 参数。
    if (capabilities?.sizeSystem === "ratio-resolution") {
      if (ratio) {
        args.aspectRatio = ratio;
      }
      if (resolution) {
        args.resolution = resolution;
      }
    } else if (effectiveSize) {
      args.size = effectiveSize;
    }
    if (quality && quality !== "auto") {
      args.quality = quality;
    }
    if (count > 1) {
      args.n = count;
    }
    // 高级参数（OpenAI 系）：按模型能力逐项裁剪
    if (capabilities?.supportsOutputFormat !== false && outputFormat) {
      args.outputFormat = outputFormat;
    }
    if (capabilities?.supportsCompression !== false && outputCompression) {
      args.outputCompression = Number(outputCompression);
    }
    if (capabilities?.supportsBackground !== false && background) {
      args.background = background;
    }
    if (capabilities?.supportsFidelity !== false && inputFidelity) {
      args.inputFidelity = inputFidelity;
    }
    // 高级参数（Gemini 系）
    if (thinkingLevel) {
      args.thinkingLevel = thinkingLevel;
    }
    if (webSearch) {
      args.webSearch = true;
    }
    if (imageSearch) {
      args.imageSearch = true;
    }
    if (personGeneration) {
      args.personGeneration = personGeneration;
    }
    // 反向提示词：仅 Gemini Imagen（supportsNegativePrompt）生效，
    // 由后端写入 generationConfig.negativePrompt；其他模型忽略不发送。
    if (
      capabilities?.supportsNegativePrompt &&
      negativePrompt.trim() !== ""
    ) {
      args.negativePrompt = negativePrompt.trim();
    }
    // 种子（可复现；留空随机；模型不支持时忽略）
    if (capabilities?.supportsSeed !== false && seed.trim() !== "") {
      const parsedSeed = Number(seed.trim());
      if (Number.isFinite(parsedSeed)) {
        args.seed = Math.round(parsedSeed);
      }
    }
    // 图生图：模型明确不支持参考图时忽略（如 dall-e-3 / imagen 仅文生图）。
    if (refImages.length > 0 && capabilities?.supportsReference !== false) {
      const images: Array<{
        data?: string;
        mimeType: string;
        path?: string;
      }> = [];
      for (const ref of refImages) {
        // 图库图片（image/...）不在 imagegen 相对路径白名单（仅 upload/ 或绝对路径），
        // 先经 IPC 读为 data URL，再以内联 base64 传入。
        if (ref.path.startsWith("image/")) {
          const dataUrl = await resolveLibraryDataUrl(ref.path);
          if (dataUrl) {
            const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
            if (match) {
              images.push({ data: match[2], mimeType: match[1] });
            }
          }
        } else {
          images.push({ path: ref.path, mimeType: ref.mimeType });
        }
      }
      if (images.length > 0) {
        args.images = images;
      }
    }

    cancelledRef.current = false;
    genStartedAtRef.current = Date.now();
    const mySeq = ++genSeqRef.current;
    setGen({ status: "running", streaming: [] });
    try {
      const result = await window.snow.callMcpTool(
        "imagegen-generate",
        JSON.stringify(args),
        undefined, // projectId：生图不依赖会话目录
        undefined, // checkpointIds
        undefined, // checkpointWorkDir
        undefined, // sensitiveAuthorizationToken
        (chunk) => {
          if (
            chunk.stream !== "imagegen" ||
            cancelledRef.current ||
            genSeqRef.current !== mySeq
          ) {
            return;
          }
          try {
            const parsed: unknown = JSON.parse(chunk.data);
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              !Array.isArray(parsed) &&
              (parsed as Record<string, unknown>).type === "partial_image" &&
              typeof (parsed as Record<string, unknown>).data === "string" &&
              typeof (parsed as Record<string, unknown>).mimeType ===
                "string" &&
              typeof (parsed as Record<string, unknown>).index === "number"
            ) {
              const image = {
                index: (parsed as { index: number }).index,
                mimeType: (parsed as { mimeType: string }).mimeType,
                data: (parsed as { data: string }).data,
              };
              // 帧合并缓冲：同 index 覆盖，rAF 每帧 flush 一次，
              // 避免高频 partial_image 触发每 chunk 一次的全组件重渲染。
              const pending = pendingFramesRef.current;
              const existing = pending.findIndex(
                (item) => item.index === image.index
              );
              if (existing >= 0) {
                pending[existing] = image;
              } else {
                pending.push(image);
              }
              if (rafRef.current === null) {
                rafRef.current = window.requestAnimationFrame(() => {
                  rafRef.current = null;
                  if (
                    cancelledRef.current ||
                    genSeqRef.current !== mySeq
                  ) {
                    return;
                  }
                  const frames = pendingFramesRef.current;
                  pendingFramesRef.current = [];
                  if (frames.length === 0) {
                    return;
                  }
                  setGen((prev) => {
                    if (prev.status !== "running") {
                      return prev;
                    }
                    const merged = [...prev.streaming];
                    for (const frame of frames) {
                      const i = merged.findIndex(
                        (item) => item.index === frame.index
                      );
                      if (i >= 0) {
                        merged[i] = frame;
                      } else {
                        merged.push(frame);
                      }
                    }
                    merged.sort((a, b) => a.index - b.index);
                    return { status: "running", streaming: merged };
                  });
                });
              }
            }
          } catch {
            // 忽略无法解析的 chunk
          }
        },
        undefined, // interactionId：工作台独立生成，不挂接会话
        undefined, // subAgentAllowedTools
        false, // planMode
        false // planApproved
      );
      if (cancelledRef.current || genSeqRef.current !== mySeq) {
        return; // 已取消或已被新生成取代：丢弃结果，不更新 UI
      }
      setGen({ status: "done", result: parseImageGenResult(result) });
      setLastDurationMs(Date.now() - genStartedAtRef.current);
      // 生成完成：Rust 侧已自动落盘图库，刷新历史列表。
      void loadLibrary();
    } catch (error) {
      if (cancelledRef.current || genSeqRef.current !== mySeq) {
        return; // 已取消或已被新生成取代：不弹错误
      }
      setGen({
        status: "error",
        error: classifyImageGenError(getErrorMessage(error)),
      });
    }
  }, [
    prompt,
    negativePrompt,
    isGenerating,
    channelId,
    model,
    effectiveSize,
    capabilities,
    effectiveStream,
    quality,
    count,
    outputFormat,
    outputCompression,
    background,
    inputFidelity,
    thinkingLevel,
    webSearch,
    imageSearch,
    personGeneration,
    seed,
    refImages,
    t,
  ]);

  /** 取消生成：放弃等待并复位 UI（后端无中断通道，结果到达后被丢弃）。 */
  const handleCancel = useCallback((): void => {
    cancelledRef.current = true;
    genSeqRef.current += 1; // 作废旧代际的 chunk/结果
    pendingFramesRef.current = [];
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setGen({ status: "idle" });
  }, []);

  // 组件卸载时清理未 flush 的 rAF（组件常驻渲染，兜底严谨性）。
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  /** 将 prompt 字符串渲染成文本节点与不可编辑参考图卡片的单一排版流。 */
  const renderPromptEditor = useCallback(
    (value: string): void => {
      const editor = promptEditorRef.current;
      if (!editor) return;
      const fragment = document.createDocumentFragment();
      const pattern = new RegExp(IMAGE_PLACEHOLDER_RE.source, "gi");
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(value)) !== null) {
        if (match.index > last) fragment.append(document.createTextNode(value.slice(last, match.index)));
        const n = Number.parseInt(match[1], 10);
        const ref = refImages[n - 1];
        const card = document.createElement("button");
        card.type = "button";
        card.contentEditable = "false";
        card.dataset.refToken = match[0];
        card.dataset.refIndex = String(n);
        card.className = `ai-drawing-ref-card-inline${ref ? "" : " is-out-of-range"}`;
        card.disabled = !ref;
        card.title = ref
          ? t("rightPanel.aiDrawing.refOpenImage", { defaultValue: "Open reference image" })
          : t("rightPanel.aiDrawing.refPlaceholderOutOfRange", {
              values: { refs: match[0], count: refImages.length },
            });
        if (ref) {
          const image = document.createElement("img");
          image.className = "ai-drawing-ref-card-inline-thumb";
          image.alt = "";
          image.src = proxyForLibraryPath(ref.path);
          const fallback = ref.path.startsWith("image/")
            ? resolveLibraryDataUrl
            : resolveUploadDataUrl;
          void fallback(ref.path).then((dataUrl) => {
            if (dataUrl && image.isConnected) image.src = dataUrl;
          });
          card.append(image);
        } else {
          const missing = document.createElement("span");
          missing.className = "ai-drawing-ref-card-inline-missing";
          missing.textContent = "×";
          card.append(missing);
        }
        const label = document.createElement("span");
        label.className = "ai-drawing-ref-card-inline-label";
        label.textContent = t("rightPanel.aiDrawing.refChipLabel", { values: { n } });
        card.append(label);
        fragment.append(card);
        last = match.index + match[0].length;
      }
      if (last < value.length) fragment.append(document.createTextNode(value.slice(last)));
      editor.replaceChildren(fragment);
    },
    [refImages, t]
  );

  const refreshPromptPresentation = useCallback(
    (value: string): void => {
      const editor = promptEditorRef.current;
      if (!editor) return;
      const selectionOffsets = getPromptSelectionOffsets(editor);
      const scrollTop = editor.scrollTop;
      renderPromptEditor(value);
      promptRendererRef.current = renderPromptEditor;
      editor.scrollTop = scrollTop;
      if (selectionOffsets) {
        setPromptSelectionOffsets(editor, selectionOffsets);
      }
    },
    [renderPromptEditor]
  );

  useEffect(() => {
    const editor = promptEditorRef.current;
    if (!editor) return;
    const presentationChanged = promptRendererRef.current !== renderPromptEditor;
    const promptChanged = readPromptEditor(editor) !== prompt;
    if (!presentationChanged && !promptChanged) return;
    if (promptComposingRef.current) {
      promptPresentationRefreshPendingRef.current = true;
      return;
    }
    promptPresentationRefreshPendingRef.current = false;
    refreshPromptPresentation(prompt);
  }, [prompt, refreshPromptPresentation, renderPromptEditor]);

  const insertRefPlaceholder = useCallback((n: number): void => {
    const editor = promptEditorRef.current;
    const token = `{{Image ${n}}}`;
    if (!editor) {
      setPrompt((prev) => (prev ? `${prev} ${token}` : token));
      return;
    }
    editor.focus();
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const insertionRange = range && editor.contains(range.commonAncestorContainer) ? range : null;
    const tokenNode = document.createTextNode(token);
    if (insertionRange) {
      insertionRange.deleteContents();
      insertionRange.insertNode(tokenNode);
    } else {
      editor.append(tokenNode);
    }
    setPromptCaretAfter(tokenNode);
    const next = readPromptEditor(editor);
    const caretOffset = getPromptSelectionOffset(editor) ?? next.length;
    setPrompt(next);
    window.requestAnimationFrame(() => {
      renderPromptEditor(next);
      const root = promptEditorRef.current;
      if (!root) return;
      root.focus();
      setPromptSelectionOffset(root, caretOffset);
    });
  }, [renderPromptEditor]);

  /** 参考图 → 灯箱 GalleryItem（chip 点击打开图片，复用 openLightbox）。 */
  const refGalleryItems = useMemo<GalleryItem[]>(
    () =>
      refImages.map((ref, index) => ({
        key: `ref-${index}-${ref.path}`,
        src: ref.path,
        path: ref.path,
      })),
    [refImages]
  );

  const [refPickerOpen, setRefPickerOpen] = useState(false);

  const syncPromptFromEditor = useCallback((): void => {
    const editor = promptEditorRef.current;
    if (!editor) return;
    const value = readPromptEditor(editor);
    setPrompt(value);
    const pos = getPromptSelectionOffset(editor) ?? value.length;
    setRefPickerOpen(/@\s*$/.test(value.slice(0, pos)));
  }, []);

  const handlePromptCompositionEnd = useCallback((): void => {
    promptComposingRef.current = false;
    const editor = promptEditorRef.current;
    if (!editor) return;
    const value = readPromptEditor(editor);
    setPrompt(value);
    const pos = getPromptSelectionOffset(editor) ?? value.length;
    setRefPickerOpen(/@\s*$/.test(value.slice(0, pos)));
    if (!promptPresentationRefreshPendingRef.current) return;
    promptPresentationRefreshPendingRef.current = false;
    window.requestAnimationFrame(() => refreshPromptPresentation(value));
  }, [refreshPromptPresentation]);

  const handlePickRefImage = (n: number): void => {
    setRefPickerOpen(false);
    const editor = promptEditorRef.current;
    if (!editor) return;
    editor.focus();
    const value = readPromptEditor(editor);
    const pos = getPromptSelectionOffset(editor) ?? value.length;
    let start = pos;
    while (start > 0 && /\s/.test(value[start - 1])) start -= 1;
    if (start > 0 && value[start - 1] === "@") start -= 1;
    const next = value.slice(0, start) + `{{Image ${n}}}` + value.slice(pos);
    setPrompt(next);
    renderPromptEditor(next);
    window.requestAnimationFrame(() => {
      const root = promptEditorRef.current;
      if (!root) return;
      root.focus();
      setPromptSelectionOffset(root, start + `{{Image ${n}}}`.length);
    });
  };

  const handlePromptPaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    document.execCommand("insertText", false, text);
    syncPromptFromEditor();
  };

  const handlePromptCopy = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const fragment = document.createElement("div");
    fragment.append(selection.getRangeAt(0).cloneContents());
    event.preventDefault();
    event.clipboardData.setData("text/plain", readPromptEditor(fragment));
  };

  const handleKeyDownOnPrompt = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void handleGenerate();
        return;
      }
      if (event.key === "Escape" && refPickerOpen) {
        event.preventDefault();
        setRefPickerOpen(false);
      }
    },
    [handleGenerate, refPickerOpen]
  );

  // ----------------------------------------------------------------
  // 本次生成结果 → 画廊项
  // ----------------------------------------------------------------
  const resultItems = useMemo<GalleryItem[]>(() => {
    if (gen.status !== "done" || gen.result.type !== "success") {
      return [];
    }
    const items: GalleryItem[] = [];
    for (const [index, image] of gen.result.images.entries()) {
      items.push({
        // 无 path 的纯 base64 图：key 附加索引，避免两张等长 base64 撞 key。
        key: image.path ?? `img-${index}-${image.data.length}`,
        src: image.path
          ? proxyForLibraryPath(image.path)
          : `data:${image.mimeType};base64,${image.data}`,
        image,
        record: image.path
          ? {
              id: "",
              relativePath: image.path,
              mimeType: image.mimeType,
              prompt: gen.result.prompt,
              createdAt: "",
            }
          : undefined,
      });
    }
    for (const url of gen.result.remoteUrls) {
      items.push({
        key: `remote-${url}`,
        src: imageProxyUrl(url),
        remoteUrl: url,
      });
    }
    return items;
  }, [gen]);

  // ----------------------------------------------------------------
  // 图库历史（存储）
  // ----------------------------------------------------------------
  const loadLibrary = useCallback(async (): Promise<void> => {
    try {
      const records = await window.snow.listImageLibrary();
      setLibrary(
        records.map((record) => ({
          id: record.id,
          relativePath: record.relativePath,
          mimeType: record.mimeType,
          prompt: record.prompt,
          createdAt: record.createdAt,
        }))
      );
    } catch (error) {
      console.warn("[ai-drawing] list image library failed", error);
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  // tab 重新激活（false → true）时刷新配置/模型/图库，跟随设置页变更。
  // （组件在 RightPanel 中常驻渲染，配置不会因切换 tab 自动重载；
  // 模型列表由 channels 变化自动重新拉取。）
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = isActive;
    if (isActive && !wasActive) {
      void loadSettings();
      void loadLibrary();
    }
  }, [isActive, loadSettings, loadLibrary]);

  /** 搜索过滤后的图库列表（按提示词包含匹配，内存过滤已加载数据）。 */
  const filteredLibrary = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    if (!query) {
      return library;
    }
    return library.filter((record) =>
      record.prompt.toLowerCase().includes(query)
    );
  }, [library, historyQuery]);

  const visibleLibrary = filteredLibrary.slice(0, visibleCount);
  const hasMoreLibrary = visibleCount < filteredLibrary.length;

  const handleLoadMore = useCallback((): void => {
    setVisibleCount((count) => count + HISTORY_PAGE_SIZE);
  }, []);

  /** 点击删除：弹出确认框（避免误删，交互明确）。 */
  const handleDelete = useCallback(
    (record: { id: string; relativePath: string }): void => {
      setDeleteTarget(record);
    },
    []
  );

  /** 确认删除：物理文件 + 索引 + 会话消息重写（Rust 侧事务处理）。 */
  const confirmDelete = useCallback(
    async (record: { id: string; relativePath: string }): Promise<void> => {
      setDeleteTarget(null);
      try {
        await window.snow.deleteImageLibraryImage(record.id);
        // 缓存同步失效，避免同路径旧图残留。
        libraryProxyCache.delete(record.relativePath);
        libraryDataCache.delete(record.relativePath);
        uploadDataCache.delete(record.relativePath);
        // 被删图片若正作为参考图，一并清除。
        setRefImages((prev) =>
          prev.filter((item) => item.path !== record.relativePath)
        );
        void loadLibrary();
        setImportNotice({ kind: "ok", text: t("rightPanel.aiDrawing.deleted") });
      } catch (error) {
        console.warn("[ai-drawing] delete image failed", error);
        setImportNotice({
          kind: "error",
          text: t("rightPanel.aiDrawing.deleteFailed"),
        });
      }
    },
    [loadLibrary, t]
  );

  /** 以图库历史图为参考（图生图）：追加到参考图列表并回填提示词。 */
  const handleUseAsReference = useCallback(
    (record: {
      relativePath: string;
      mimeType: string;
      prompt: string;
    }) => {
      const { added, duplicate } = appendRefImages([
        { path: record.relativePath, mimeType: record.mimeType },
      ]);
      if (duplicate && added === 0) {
        setImportNotice({
          kind: "ok",
          text: t("rightPanel.aiDrawing.refSkippedDuplicate"),
        });
      }
      if (record.prompt) {
        setPrompt(record.prompt);
      }
    },
    [appendRefImages, t]
  );

  // ----------------------------------------------------------------
  // 保存（单张 / 全部）
  // ----------------------------------------------------------------
  const [saving, setSaving] = useState(false);

  /** 上传导入提示（成功/失败，数秒后自动消失）。 */
  const [importNotice, setImportNotice] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const importNoticeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!importNotice) {
      return;
    }
    if (importNoticeTimerRef.current !== null) {
      window.clearTimeout(importNoticeTimerRef.current);
    }
    importNoticeTimerRef.current = window.setTimeout(() => {
      setImportNotice(null);
    }, 3200);
    return () => {
      if (importNoticeTimerRef.current !== null) {
        window.clearTimeout(importNoticeTimerRef.current);
      }
    };
  }, [importNotice]);

  /** 上传本地图片作为参考图：多选全部追加（绝对路径，不进入图库），去重 + 上限 5 张。 */
  const handleUploadImages = useCallback(async (): Promise<void> => {
    try {
      const selected = await window.snow.selectImageFiles(
        t("rightPanel.aiDrawing.uploadDialogTitle")
      );
      if (!selected || selected.length === 0) {
        return;
      }
      const { added, duplicate, overLimit } = appendRefImages(
        selected.map((path) => ({ path, mimeType: inferMimeFromPath(path) }))
      );
      if (added > 0) {
        setImportNotice({
          kind: "ok",
          text: overLimit
            ? t("rightPanel.aiDrawing.refLimit", {
                values: { count: maxRefLimit },
              })
            : t("rightPanel.aiDrawing.refAdded"),
        });
      } else if (duplicate || overLimit) {
        setImportNotice({
          kind: "ok",
          text: overLimit
            ? t("rightPanel.aiDrawing.refLimit", {
                values: { count: maxRefLimit },
              })
            : t("rightPanel.aiDrawing.refSkippedDuplicate"),
        });
      }
    } catch (error) {
      console.warn("[ai-drawing] pick reference image failed", error);
      setImportNotice({
        kind: "error",
        text: t("rightPanel.aiDrawing.importFailed"),
      });
    }
  }, [appendRefImages, t]);

  // ----------------------------------------------------------------
  // 拖拽（图库 → 聊天框 / 工作台参考图；本地文件 → 参考图或导入图库）
  // ----------------------------------------------------------------
  /** 拖拽悬停区域（library = 图库区导入；canvas = 其他区域设为参考图）。 */
  const [dragOverZone, setDragOverZone] = useState<"library" | "canvas" | null>(
    null
  );

  /** 拖拽进入工作台：允许 application/json（图库图）与 Files（本地文件）。 */
  const handleRootDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      const types = event.dataTransfer.types;
      if (
        !types.includes("application/json") &&
        !types.includes("Files")
      ) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const inLibrary =
        (event.target as HTMLElement).closest(".ai-drawing-history") !== null;
      setDragOverZone(inLibrary ? "library" : "canvas");
    },
    []
  );

  const handleRootDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
        setDragOverZone(null);
      }
    },
    []
  );

  const handleRootDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>): Promise<void> => {
      event.preventDefault();
      setDragOverZone(null);
      const inLibrary =
        (event.target as HTMLElement).closest(".ai-drawing-history") !== null;

      // 1) 应用内拖拽：图库图片 → 参考图（拖到图库区时保持原行为，仅导入）。
      //    协议：{ type: "library-image", path, mimeType? } 单张，
      //    或 { type: "library-images", images: [{ path, mimeType? }] } 批量。
      const jsonData = event.dataTransfer.getData("application/json");
      if (jsonData) {
        try {
          const parsed = JSON.parse(jsonData) as Record<string, unknown>;
          const images: Array<{ path: string; mimeType: string }> = [];
          if (parsed.type === "library-image" && typeof parsed.path === "string") {
            images.push({
              path: parsed.path,
              mimeType:
                typeof parsed.mimeType === "string"
                  ? parsed.mimeType
                  : "image/png",
            });
          } else if (
            parsed.type === "library-images" &&
            Array.isArray(parsed.images)
          ) {
            for (const raw of parsed.images as Array<{
              path?: unknown;
              mimeType?: unknown;
            }>) {
              if (typeof raw?.path === "string") {
                images.push({
                  path: raw.path,
                  mimeType:
                    typeof raw.mimeType === "string"
                      ? raw.mimeType
                      : "image/png",
                });
              }
            }
          }
          if (images.length > 0 && !inLibrary) {
            const { added, duplicate, overLimit } = appendRefImages(images);
            setImportNotice({
              kind: "ok",
              text: overLimit
            ? t("rightPanel.aiDrawing.refLimit", {
                values: { count: maxRefLimit },
              })
                : duplicate && added === 0
                  ? t("rightPanel.aiDrawing.refSkippedDuplicate")
                  : t("rightPanel.aiDrawing.refSetDone"),
            });
            return;
          }
        } catch {
          // 无效拖拽数据：忽略
        }
      }

      // 2) 外部文件拖入（resolveDroppedFiles 解析真实路径）。
      const files: File[] = [];
      for (let i = 0; i < event.dataTransfer.files.length; i++) {
        const file = event.dataTransfer.files.item(i);
        if (file) {
          files.push(file);
        }
      }
      if (files.length === 0) {
        return;
      }
      const entries = await window.snow.resolveDroppedFiles(files);
      const imagePaths = entries.filter(
        (entry) => !entry.isDirectory && IMAGE_EXT_RE.test(entry.path)
      );
      if (imagePaths.length === 0) {
        return;
      }
      if (inLibrary) {
        // 拖入图库区：导入图库（复制 + 写索引）；失败给出明确提示。
        try {
          const imported = await window.snow.importImageFiles(
            imagePaths.map((entry) => entry.path)
          );
          if (imported.length > 0) {
            setImportNotice({
              kind: "ok",
              text: t("rightPanel.aiDrawing.importDone", {
                defaultValue: "Imported {{count}} images",
                values: { count: imported.length },
              }),
            });
            void loadLibrary();
          }
        } catch (error) {
          console.warn("[ai-drawing] import image files failed", error);
          setImportNotice({
            kind: "error",
            text: t("rightPanel.aiDrawing.importFailed"),
          });
        }
      } else {
        // 拖入其他区域：全部追加为参考图（绝对路径，不进入图库），去重 + 上限。
        const { added, duplicate, overLimit } = appendRefImages(
          imagePaths.map((entry) => ({
            path: entry.path,
            mimeType: inferMimeFromPath(entry.path),
          }))
        );
        setImportNotice({
          kind: "ok",
          text: overLimit
            ? t("rightPanel.aiDrawing.refLimit", {
                values: { count: maxRefLimit },
              })
            : duplicate && added === 0
              ? t("rightPanel.aiDrawing.refSkippedDuplicate")
              : t("rightPanel.aiDrawing.refSetDone"),
        });
      }
    },
    [loadLibrary, appendRefImages, t]
  );

  const saveItem = useCallback(async (item: GalleryItem): Promise<void> => {
    let src = item.src;
    // 本地图库图：优先 IPC data URL（与聊天保存链路一致，最可靠）。
    const localPath = item.image?.path ?? item.record?.relativePath;
    if (localPath) {
      const resolved = await resolveLibraryDataUrl(localPath);
      if (resolved) {
        src = resolved;
      }
    }
    if (!src && localPath) {
      src = proxyForLibraryPath(localPath);
    }
    if (!src) {
      return;
    }
    const blob = await srcToBlob(src);
    const filename = `ai-image-${Date.now()}.${extensionForBlob(blob)}`;
    await saveBlobToFile(blob, filename);
  }, []);

  const handleSaveOne = useCallback(
    async (item: GalleryItem): Promise<void> => {
      if (saving) {
        return;
      }
      setSaving(true);
      try {
        await saveItem(item);
      } catch (error) {
        console.warn("[ai-drawing] save image failed", error);
      } finally {
        setSaving(false);
      }
    },
    [saving, saveItem]
  );

  const handleSaveAll = useCallback(async (): Promise<void> => {
    if (saving || resultItems.length === 0) {
      return;
    }
    setSaving(true);
    try {
      for (const item of resultItems) {
        try {
          await saveItem(item);
        } catch (error) {
          console.warn("[ai-drawing] save all: item failed", item.key, error);
        }
      }
    } finally {
      setSaving(false);
    }
  }, [saving, resultItems, saveItem]);

  // ----------------------------------------------------------------
  // 灯箱（放大查看 / 左右切换 / 保存 / 以图为参考）
  // ----------------------------------------------------------------
  const openLightbox = useCallback((items: GalleryItem[], index: number) => {
    setLightbox({ items, index });
  }, []);

  const closeLightbox = useCallback(() => {
    setLightbox(null);
  }, []);

  const lightboxStep = useCallback((delta: number) => {
    setLightbox((prev) => {
      if (!prev || prev.items.length === 0) {
        return prev;
      }
      return {
        ...prev,
        index: (prev.index + delta + prev.items.length) % prev.items.length,
      };
    });
  }, []);

  useEffect(() => {
    if (!lightbox || !isActive) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeLightbox();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        lightboxStep(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        lightboxStep(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightbox, isActive, closeLightbox, lightboxStep]);

  const lightboxItem = lightbox ? lightbox.items[lightbox.index] : null;

  // 工作台 tab 失去激活时自动关闭灯箱（组件常驻渲染，切走时全屏浮层应消失）。
  useEffect(() => {
    if (!isActive && lightbox) {
      closeLightbox();
    }
  }, [isActive, lightbox, closeLightbox]);

  // ----------------------------------------------------------------
  // 参数持久化（localStorage）
  // ----------------------------------------------------------------
  const persistPayload = useMemo(
    () =>
      JSON.stringify({
        prompt,
        negativePrompt,
        model,
        ratio,
        tier,
        resolution,
        quality,
        count,
        stream,
        outputFormat,
        outputCompression,
        background,
        inputFidelity,
        thinkingLevel,
        webSearch,
        imageSearch,
        personGeneration,
        seed,
        showAdvanced,
      } satisfies PersistedDrawingParams),
    [
      prompt,
      negativePrompt,
      model,
      ratio,
      tier,
      resolution,
      quality,
      count,
      stream,
      outputFormat,
      outputCompression,
      background,
      inputFidelity,
      thinkingLevel,
      webSearch,
      imageSearch,
      personGeneration,
      seed,
      showAdvanced,
    ]
  );

  useEffect(() => {
    try {
      localStorage.setItem(DRAWING_PERSIST_KEY, persistPayload);
    } catch {
      // 忽略（存储受限/隐私模式等）
    }
  }, [persistPayload]);

  // ----------------------------------------------------------------
  // 派生渲染数据
  // ----------------------------------------------------------------
  const streamingItems = gen.status === "running" ? gen.streaming : [];

  const hasError =
    gen.status === "error" ||
    (gen.status === "done" && gen.result.type === "error");
  const errorInfo: ClassifiedImageGenError | null =
    gen.status === "error"
      ? gen.error
      : gen.status === "done" && gen.result.type === "error"
        ? classifyImageGenError(gen.result.message)
        : null;

  const resultRawText =
    gen.status === "done" && gen.result.type === "raw"
      ? gen.result.text
      : null;

  /** 错误卡片图标组件（按错误类别区分）。 */
  const errorIconComponent = errorInfo
    ? ERROR_KIND_ICONS[errorInfo.kind]
    : null;
  /** 配置类错误（密钥/无渠道/模型不存在）且提供回调时，显示「打开设置」引导。 */
  const showErrorSettingsButton =
    !!errorInfo &&
    !!onOpenImageGenSettings &&
    ERROR_KINDS_OPEN_SETTINGS.has(errorInfo.kind);

  const showEmptyHint =
    gen.status === "idle" ||
    (gen.status === "done" && gen.result.type === "empty");

  return (
    <div
      className={`ai-drawing-workbench${
        dragOverZone ? ` ai-drawing-drag-over-${dragOverZone}` : ""
      }`}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDrop={(event) => void handleRootDrop(event)}
    >
      {/* 内部布局包装层：container-type 放在这里，避免 layout containment
          把全屏 fixed 浮层（灯箱/删除弹窗）捕获为面板级定位 */}
      <div className="ai-drawing-body">
          {/* 提示词 + 生成 */}
          <div className="ai-drawing-composer">
          <div className="ai-drawing-prompt-wrap">
            <div
              ref={promptEditorRef}
              className="ai-drawing-prompt"
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label={t("rightPanel.aiDrawing.promptPlaceholder")}
              data-placeholder={t("rightPanel.aiDrawing.promptPlaceholder")}
              spellCheck
              onInput={syncPromptFromEditor}
              onPaste={handlePromptPaste}
              onCopy={handlePromptCopy}
              onCompositionStart={() => {
                promptComposingRef.current = true;
              }}
              onCompositionEnd={handlePromptCompositionEnd}
              onKeyDown={handleKeyDownOnPrompt}
              onMouseDown={(event) => {
                if ((event.target as HTMLElement).closest(PROMPT_REF_SELECTOR)) {
                  event.preventDefault();
                }
              }}
              onClick={(event) => {
                const card = (event.target as HTMLElement).closest<HTMLElement>(PROMPT_REF_SELECTOR);
                const n = Number(card?.dataset.refIndex);
                if (card && Number.isInteger(n) && refImages[n - 1]) {
                  openLightbox(refGalleryItems, n - 1);
                }
              }}
            />
            {/* `@` 唤起参考图选择弹窗：选择即插入 {{Image N}} 并关闭 */}
            {refPickerOpen && (
              <div className="ai-drawing-ref-picker">
                <div className="ai-drawing-ref-picker-header">
                  <Images size={12} strokeWidth={1.8} />
                  <span>
                    {t("rightPanel.aiDrawing.refPickerTitle", {
                      defaultValue: "Insert reference image",
                    })}
                  </span>
                </div>
                {refImages.length === 0 ? (
                  <div className="ai-drawing-ref-picker-empty">
                    {t("rightPanel.aiDrawing.refPickerEmpty", {
                      defaultValue: "Add reference images first",
                    })}
                  </div>
                ) : (
                  <div className="ai-drawing-ref-picker-grid">
                    {refImages.map((ref, index) => (
                      <button
                        type="button"
                        key={ref.path}
                        className="ai-drawing-ref-picker-item"
                        title={t("rightPanel.aiDrawing.refInsert", {
                          values: { n: index + 1 },
                        })}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => handlePickRefImage(index + 1)}
                      >
                        <LibraryImage
                          path={ref.path}
                          alt=""
                          className="ai-drawing-ref-picker-thumb"
                        />
                        <span className="ai-drawing-ref-picker-badge">
                          {index + 1}
                        </span>
                        <span className="ai-drawing-ref-picker-name">
                          {ref.path.split("/").pop()}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* 反向提示词（仅 Gemini Imagen 生效；默认自动填充通用负面词） */}
          {capabilities?.supportsNegativePrompt && (
            <div className="ai-drawing-negative">
              <textarea
                className="ai-drawing-negative-input"
                value={negativePrompt}
                placeholder={t("rightPanel.aiDrawing.negativePromptPlaceholder")}
                rows={2}
                onChange={(event) => setNegativePrompt(event.target.value)}
              />
              <div className="ai-drawing-negative-footer">
                <span className="ai-drawing-negative-hint">
                  <Ban size={11} strokeWidth={1.8} />
                  {t("rightPanel.aiDrawing.negativePromptHint")}
                </span>
                {negativePrompt.trim() !== "" && (
                  <button
                    type="button"
                    className="ai-drawing-negative-clear"
                    title={t("rightPanel.aiDrawing.negativePromptClear")}
                    onClick={() => setNegativePrompt("")}
                  >
                    <X size={11} strokeWidth={1.8} />
                    <span>{t("rightPanel.aiDrawing.negativePromptClear")}</span>
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="ai-drawing-composer-footer">
            <div className="ai-drawing-composer-actions">
              <button
                type="button"
                className="ai-drawing-upload-btn"
                title={t("rightPanel.aiDrawing.uploadHint")}
                onClick={() => void handleUploadImages()}
              >
                <ImagePlus size={13} strokeWidth={1.8} />
                <span>{t("rightPanel.aiDrawing.uploadImage")}</span>
              </button>
              <span className="ai-drawing-composer-hint">
                {t("rightPanel.aiDrawing.promptHint")}
              </span>
            </div>
            {isGenerating ? (
              <button
                type="button"
                className="ai-drawing-cancel-btn"
                title={t("rightPanel.aiDrawing.cancelHint")}
                onClick={handleCancel}
              >
                <X size={14} strokeWidth={1.8} />
                <span>{t("rightPanel.aiDrawing.cancel")}</span>
              </button>
            ) : (
              <button
                type="button"
                className="ai-drawing-generate-btn"
                disabled={!prompt.trim()}
                onClick={() => void handleGenerate()}
              >
                <Sparkles size={14} strokeWidth={1.8} />
                <span>{t("rightPanel.aiDrawing.generate")}</span>
              </button>
            )}
          </div>
        </div>
  
        {/* 参数栏（模型来自渠道模型 API 聚合，选择模型自动匹配服务商） */}
        <div className="ai-drawing-params">
          <label className="ai-drawing-param ai-drawing-param-model">
            <span className="ai-drawing-param-label">
              {t("rightPanel.aiDrawing.model")}
            </span>
            {channels.length === 0 ? (
              <span className="ai-drawing-no-channel">
                {t("rightPanel.aiDrawing.noChannel")}
              </span>
            ) : (
              <>
                <CustomSelect
                  value={
                    modelsLoading || modelsLoadFailed || modelList.length === 0
                      ? ""
                      : model
                  }
                  options={
                    modelsLoading
                      ? [
                          {
                            value: "",
                            label: t("rightPanel.aiDrawing.modelsLoading"),
                          },
                        ]
                      : modelsLoadFailed || modelList.length === 0
                        ? [
                            {
                              value: "",
                              label: t("rightPanel.aiDrawing.modelsLoadFailed"),
                            },
                          ]
                        : modelList.map((item) => ({
                            value: item.id,
                            label: item.id,
                          }))
                  }
                  disabled={modelsLoading || modelsLoadFailed}
                  title={t("rightPanel.aiDrawing.modelHint")}
                  onChange={handleModelChange}
                  portal
                />
                {modelsLoadFailed && (
                  <button
                    type="button"
                    className="ai-drawing-retry-models"
                    title={t("rightPanel.aiDrawing.retryModels")}
                    onClick={() => void loadModels()}
                  >
                    <RefreshCw size={12} strokeWidth={1.8} />
                  </button>
                )}
              </>
            )}
          </label>
  
          {/* 三位一体尺寸控件：比例 × 尺寸 × 质量（各维度按模型能力裁剪） */}
          {sizeRatioOptions.length > 0 && (
            <div className="ai-drawing-size-control">
              <span className="ai-drawing-param-label">
                {t("rightPanel.aiDrawing.tier")}
              </span>
              <div className="ai-drawing-size-trigger-wrap">
                <button
                  ref={sizeTriggerRef}
                  type="button"
                  className={`ai-drawing-size-trigger${
                    sizePanelOpen ? " open" : ""
                  }`}
                  title={t("rightPanel.aiDrawing.sizeControlHint")}
                  onClick={() => setSizePanelOpen((open) => !open)}
                >
                  <span className="ai-drawing-size-summary">{sizeSummary}</span>
                  <ChevronDown
                    size={12}
                    strokeWidth={1.8}
                    className={sizePanelOpen ? "rotate-180" : ""}
                  />
                </button>
                {sizePanelOpen && sizePopoverRect && createPortal(
                  <>
                    {/* 点击外部关闭弹层（透明 backdrop 优先捕获） */}
                    <div
                      className="ai-drawing-size-backdrop"
                      onClick={() => setSizePanelOpen(false)}
                    />
                    <div
                      className="ai-drawing-size-popover"
                      style={{
                        top: `${sizePopoverRect.top}px`,
                        left: `${sizePopoverRect.left}px`,
                        width: `${sizePopoverRect.width}px`,
                        maxHeight: `${sizePopoverRect.maxHeight}px`,
                      }}
                    >
                      {/* 比例 */}
                      <div className="ai-drawing-size-row">
                        <span className="ai-drawing-size-row-title">
                          {t("rightPanel.aiDrawing.ratio")}
                        </span>
                        <div className="ai-drawing-size-grid">
                          <button
                            type="button"
                            className={`ai-drawing-size-option${
                              ratio === "" ? " active" : ""
                            }`}
                            onClick={() => setRatio("")}
                          >
                            {t("rightPanel.aiDrawing.sizeDefault")}
                          </button>
                          {sizeRatioOptions.map((value) => (
                            <button
                              type="button"
                              key={value}
                              className={`ai-drawing-size-option${
                                ratio === value ? " active" : ""
                              }`}
                              onClick={() => setRatio(value)}
                            >
                              {value}
                            </button>
                          ))}
                        </div>
                      </div>
                      {/* 尺寸（档位/分辨率）；无档位模型（比例定尺寸）隐藏该行 */}
                      {sizeTierOptions.length > 0 && (
                        <div className="ai-drawing-size-row">
                          <span className="ai-drawing-size-row-title">
                            {t("rightPanel.aiDrawing.resolution")}
                          </span>
                          <div className="ai-drawing-size-grid">
                            <button
                              type="button"
                              className={`ai-drawing-size-option${
                                isSizeActive("") ? " active" : ""
                              }`}
                              onClick={() => handleSizeSelect("")}
                            >
                              {t("rightPanel.aiDrawing.sizeDefault")}
                            </button>
                            {sizeTierOptions.map((value) => {
                              const hint = sizeTierHint(value);
                              return (
                                <button
                                  type="button"
                                  key={value}
                                  className={`ai-drawing-size-option${
                                    isSizeActive(value) ? " active" : ""
                                  }`}
                                  onClick={() => handleSizeSelect(value)}
                                >
                                  <span>{value}</span>
                                  {hint ? (
                                    <em className="ai-drawing-size-hint">
                                      {hint}
                                    </em>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {/* 质量：按模型能力裁剪；无质量参数的模型隐藏该行 */}
                      {qualityOptions.length > 0 && (
                        <div className="ai-drawing-size-row">
                          <span className="ai-drawing-size-row-title">
                            {t("toolCall.imagegen.quality", {
                              defaultValue: "Quality",
                            })}
                          </span>
                          <div className="ai-drawing-size-grid">
                            {qualityOptions.map((option) => (
                              <button
                                type="button"
                                key={option.value}
                                className={`ai-drawing-size-option${
                                  quality === option.value ? " active" : ""
                                }`}
                                onClick={() => setQuality(option.value)}
                              >
                                {(option.value === "" ||
                                  option.value === "auto") &&
                                channelDefaultQuality
                                  ? `${t(option.labelKey)} (${channelDefaultQuality})`
                                  : t(option.labelKey)}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </>,
                  document.body
                )}
              </div>
            </div>
          )}
  
          <label className="ai-drawing-param">
            <span className="ai-drawing-param-label">
              {t("rightPanel.aiDrawing.count")}
            </span>
            <CustomSelect
              value={String(count)}
              options={countOptions.map((value) => ({
                value: String(value),
                label: t("toolCall.imagegen.countParam", {
                  defaultValue: "{{count}} images",
                  values: { count: value },
                }),
              }))}
              disabled={capabilities ? !capabilities.supportsMultiCount : false}
              title={
                capabilities && !capabilities.supportsMultiCount
                  ? t("rightPanel.aiDrawing.modelSingleCount")
                  : undefined
              }
              onChange={(value) => setCount(Number(value))}
              portal
            />
          </label>
  
          {/* 流式预览：模型不支持时隐藏（如 xAI Grok） */}
          {capabilities?.supportsStream !== false && (
            <label className="ai-drawing-param ai-drawing-param-stream">
              <input
                type="checkbox"
                checked={effectiveStream}
                disabled={streamDisabled}
                title={
                  streamDisabled
                    ? count > 1
                      ? t("rightPanel.aiDrawing.streamOffCount")
                      : t("rightPanel.aiDrawing.streamOffRef")
                    : undefined
                }
                onChange={(event) => setStream(event.target.checked)}
              />
              <span className="ai-drawing-param-label">
                {t("rightPanel.aiDrawing.stream")}
              </span>
            </label>
          )}
  
          <button
            type="button"
            className={`ai-drawing-advanced-toggle${
              showAdvanced ? " open" : ""
            }`}
            onClick={() => setShowAdvanced((open) => !open)}
          >
            <span>{t("rightPanel.aiDrawing.advanced")}</span>
            <ChevronRight
              size={12}
              strokeWidth={1.8}
              className={showAdvanced ? "rotate-90" : ""}
            />
          </button>
        </div>
  
        {/* 高级参数（按渠道协议 + 模型能力分别显示） */}
        {showAdvanced && (
          <div className="ai-drawing-advanced">
            {isGemini ? (
              <>
                {capabilities?.supportsThinking ? (
                  <label className="ai-drawing-param">
                    <span className="ai-drawing-param-label">
                      {t("rightPanel.aiDrawing.thinkingLevel")}
                    </span>
                    <CustomSelect
                      value={thinkingLevel}
                      options={THINKING_OPTIONS.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      }))}
                      onChange={setThinkingLevel}
                      portal
                    />
                  </label>
                ) : null}
                <label className="ai-drawing-param">
                  <span className="ai-drawing-param-label">
                    {t("rightPanel.aiDrawing.personGeneration")}
                  </span>
                  <CustomSelect
                    value={personGeneration}
                    options={PERSON_OPTIONS.map((option) => ({
                      value: option.value,
                      label: t(option.labelKey),
                    }))}
                    onChange={setPersonGeneration}
                    portal
                  />
                </label>
                {/* Google 搜索 grounding：仅 3.1 Flash + 3 Pro 支持（Lite / 2.5 隐藏） */}
                {capabilities?.supportsWebSearch !== false ? (
                  <label className="ai-drawing-param ai-drawing-param-stream">
                    <input
                      type="checkbox"
                      checked={webSearch}
                      onChange={(event) => setWebSearch(event.target.checked)}
                    />
                    <span className="ai-drawing-param-label">
                      {t("rightPanel.aiDrawing.webSearch")}
                    </span>
                  </label>
                ) : null}
                {/* Gemini 3 系列输出格式（response_format mime_type：png/jpeg） */}
                {capabilities?.supportsOutputFormat !== false ? (
                  <label className="ai-drawing-param">
                    <span className="ai-drawing-param-label">
                      {t("rightPanel.aiDrawing.outputFormat")}
                    </span>
                    <CustomSelect
                      value={outputFormat}
                      options={[
                        {
                          value: "",
                          label: t("rightPanel.aiDrawing.formatDefault"),
                        },
                        {
                          value: "png",
                          label: t("rightPanel.aiDrawing.formatPng"),
                        },
                        {
                          value: "jpeg",
                          label: t("rightPanel.aiDrawing.formatJpeg"),
                        },
                      ]}
                      onChange={setOutputFormat}
                      portal
                    />
                  </label>
                ) : null}
                {capabilities?.supportsImageSearch ? (
                  <label className="ai-drawing-param ai-drawing-param-stream">
                    <input
                      type="checkbox"
                      checked={imageSearch}
                      onChange={(event) => setImageSearch(event.target.checked)}
                    />
                    <span className="ai-drawing-param-label">
                      {t("rightPanel.aiDrawing.imageSearch")}
                    </span>
                  </label>
                ) : null}
              </>
            ) : (
              <>
                {/* OpenAI 系高级参数：按模型能力逐项裁剪（dall-e 家族 / grok 等不支持项自动隐藏） */}
                {capabilities?.supportsOutputFormat !== false ? (
                  <label className="ai-drawing-param">
                    <span className="ai-drawing-param-label">
                      {t("rightPanel.aiDrawing.outputFormat")}
                    </span>
                    <CustomSelect
                      value={outputFormat}
                      options={OPENAI_FORMAT_OPTIONS.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      }))}
                      onChange={setOutputFormat}
                      portal
                    />
                  </label>
                ) : null}
                {capabilities?.supportsCompression !== false ? (
                  <label className="ai-drawing-param">
                    <span className="ai-drawing-param-label">
                      {t("rightPanel.aiDrawing.compression")}
                    </span>
                    <CustomSelect
                      value={outputCompression}
                      options={COMPRESSION_OPTIONS.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      }))}
                      onChange={setOutputCompression}
                      portal
                    />
                  </label>
                ) : null}
                {capabilities?.supportsBackground !== false ? (
                  <label className="ai-drawing-param">
                    <span className="ai-drawing-param-label">
                      {t("rightPanel.aiDrawing.background")}
                    </span>
                    <CustomSelect
                      value={background}
                      options={BACKGROUND_OPTIONS.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                        disabled:
                          option.value === "transparent" &&
                          (capabilities ? !capabilities.supportsTransparent : false),
                      }))}
                      onChange={setBackground}
                      portal
                    />
                  </label>
                ) : null}
                {capabilities?.supportsFidelity !== false ? (
                  <label className="ai-drawing-param">
                    <span className="ai-drawing-param-label">
                      {t("rightPanel.aiDrawing.fidelity")}
                    </span>
                    <CustomSelect
                      value={inputFidelity}
                      options={FIDELITY_OPTIONS.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      }))}
                      onChange={setInputFidelity}
                      portal
                    />
                  </label>
                ) : null}
              </>
            )}
            {/* 种子：按模型能力显示（dall-e 家族 / grok 不支持，隐藏） */}
            {capabilities?.supportsSeed !== false && (
              <label className="ai-drawing-param">
                <span className="ai-drawing-param-label">
                  {t("rightPanel.aiDrawing.seed")}
                </span>
                <input
                  type="number"
                  className="ai-drawing-seed-input"
                  value={seed}
                  placeholder={t("rightPanel.aiDrawing.seedPlaceholder")}
                  title={t("rightPanel.aiDrawing.seedHint")}
                  onChange={(event) => setSeed(event.target.value)}
                />
              </label>
            )}
          </div>
        )}
  
        {/* 参考图（图生图，最多 5 张，逐张可移除；编号角标 = {{Image N}} 引用号） */}
        {refImages.length > 0 && (
          <div className="ai-drawing-refs">
            {refImages.map((ref, index) => (
              <div
                className="ai-drawing-ref"
                key={ref.path}
                title={t("rightPanel.aiDrawing.refInsert", {
                  values: { n: index + 1 },
                })}
                onClick={() => insertRefPlaceholder(index + 1)}
              >
                <LibraryImage
                  path={ref.path}
                  alt={t("toolCall.imagegen.refImage", {
                    defaultValue: "Reference image",
                  })}
                  className="ai-drawing-ref-thumb"
                />
                <span className="ai-drawing-ref-badge">{index + 1}</span>
                <button
                  type="button"
                  className="ai-drawing-ref-remove"
                  title={t("rightPanel.aiDrawing.removeReference")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setRefImages((prev) =>
                      prev.filter((item) => item.path !== ref.path)
                    );
                  }}
                >
                  <X size={13} strokeWidth={1.8} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 参考图变量引用提示：{{Image N}} 注入提示词 */}
        {refImages.length > 0 && (
          <div className="ai-drawing-ref-hint">
            <AtSign size={12} strokeWidth={1.8} />
            <span>{t("rightPanel.aiDrawing.refPlaceholderHint")}</span>
          </div>
        )}
  
        {/* 模型不支持参考图时提示（如 dall-e-3 / imagen 仅文生图） */}
        {refImages.length > 0 && capabilities && !capabilities.supportsReference && (
          <div className="ai-drawing-model-warn">
            <AlertCircle size={13} strokeWidth={1.8} />
            <span>{t("rightPanel.aiDrawing.modelUnsupportedRef")}</span>
          </div>
        )}
  
        {/* 上传导入提示（成功/失败，自动消失） */}
        {importNotice && (
          <div
            className={`ai-drawing-import-notice ai-drawing-import-notice-${importNotice.kind}`}
          >
            {importNotice.kind === "ok" ? (
              <CheckCircle2 size={13} strokeWidth={1.8} />
            ) : (
              <AlertCircle size={13} strokeWidth={1.8} />
            )}
            <span>{importNotice.text}</span>
          </div>
        )}
  
        {/* 本次生成结果（画布区：占据剩余空间） */}
        <div className="ai-drawing-section ai-drawing-canvas">
          {isGenerating ? (
            <>
              <div className="ai-drawing-status ai-drawing-status-generating">
                <Loader2 size={16} strokeWidth={1.8} className="ai-drawing-spin" />
                <span>
                  {streamingItems.length > 0
                    ? t("toolCall.imagegen.streamingPreview", {
                        defaultValue: "Generating… preview",
                      })
                    : t("rightPanel.aiDrawing.generatingDetail")}
                </span>
                {streamingItems.length > 0 && count > 1 && (
                  <span className="ai-drawing-streaming-count">
                    {streamingItems.length} / {count}
                  </span>
                )}
              </div>
              {streamingItems.length > 0 && (
                <StreamingGallery items={streamingItems} />
              )}
            </>
          ) : hasError && errorInfo && errorIconComponent ? (
            <div className="ai-drawing-error">
              <div className="ai-drawing-error-icon" aria-hidden="true">
                {(() => {
                  const Icon = errorIconComponent;
                  return <Icon size={18} strokeWidth={1.8} />;
                })()}
              </div>
              <div className="ai-drawing-error-body">
                <span className="ai-drawing-error-title">
                  {t(imageGenErrorTitleKey(errorInfo.kind))}
                </span>
                <span className="ai-drawing-error-hint">
                  {t(errorHintKey(errorInfo.kind))}
                </span>
                <span className="ai-drawing-error-detail">
                  {errorInfo.detail}
                </span>
                <div className="ai-drawing-error-actions">
                  <button
                    type="button"
                    className="ai-drawing-error-btn ai-drawing-error-btn-retry"
                    onClick={() => void handleGenerate()}
                  >
                    <RefreshCw size={12} strokeWidth={1.8} />
                    <span>{t("rightPanel.aiDrawing.retry")}</span>
                  </button>
                  {showErrorSettingsButton && (
                    <button
                      type="button"
                      className="ai-drawing-error-btn"
                      onClick={onOpenImageGenSettings}
                    >
                      <Settings size={12} strokeWidth={1.8} />
                      <span>{t("rightPanel.aiDrawing.openSettings")}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : resultRawText ? (
            <div className="ai-drawing-error">
              <div className="ai-drawing-error-icon" aria-hidden="true">
                <XCircle size={18} strokeWidth={1.8} />
              </div>
              <div className="ai-drawing-error-body">
                <span className="ai-drawing-error-title">
                  {t("toolCall.imagegen.error.fallback", {
                    defaultValue: "Image generation failed",
                  })}
                </span>
                <span className="ai-drawing-error-hint">
                  {t(errorHintKey("fallback"))}
                </span>
                <span className="ai-drawing-error-detail">
                  {resultRawText.slice(0, 600)}
                </span>
              </div>
            </div>
          ) : resultItems.length > 0 ? (
            <div className="ai-drawing-result-header">
              <span className="ai-drawing-result-title">
                <Sparkles size={13} strokeWidth={1.8} />
                <span>
                  {t("toolCall.imagegen.result", { defaultValue: "Result" })}
                </span>
                <span className="ai-drawing-history-count">
                  {t("rightPanel.aiDrawing.resultCount", {
                    values: { count: resultItems.length },
                  })}
                </span>
                {lastDurationMs > 0 && (
                  <span className="ai-drawing-result-duration">
                    {t("rightPanel.aiDrawing.duration", {
                      values: { seconds: (lastDurationMs / 1000).toFixed(1) },
                    })}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="ai-drawing-save-all-btn"
                disabled={saving}
                title={t("toolCall.imagegen.downloadAll", {
                  defaultValue: "Save all",
                })}
                onClick={() => void handleSaveAll()}
              >
                {saving ? (
                  <Loader2 size={13} strokeWidth={1.8} className="ai-drawing-spin" />
                ) : (
                  <Download size={13} strokeWidth={1.8} />
                )}
                <span>
                  {t("toolCall.imagegen.downloadAll", {
                    defaultValue: "Save all",
                  })}
                </span>
              </button>
            </div>
          ) : showEmptyHint ? (
            <div className="ai-drawing-status ai-drawing-status-empty">
              <div className="ai-drawing-empty-icon" aria-hidden="true">
                <Sparkles size={22} strokeWidth={1.6} />
              </div>
              <span className="ai-drawing-empty-title">
                {t("rightPanel.aiDrawing.emptyHint")}
              </span>
              <span className="ai-drawing-empty-sub">
                {t("rightPanel.aiDrawing.emptyHintSub")}
              </span>
              {/* 示例提示词（独立组件）：点击一键填入并聚焦输入框 */}
              <DrawingPromptExamples
                onPick={(example) => {
                  setPrompt(example);
                  promptEditorRef.current?.focus();
                }}
              />
            </div>
          ) : null}
  
          {!isGenerating &&
            !hasError &&
            !resultRawText &&
            resultItems.length > 0 && (
              <div className="ai-drawing-gallery">
                {resultItems.map((item) => (
                  <div className="ai-drawing-gallery-item" key={item.key}>
                    <LibraryImage
                      path={item.image?.path}
                      src={item.image?.path ? undefined : item.src}
                      alt={t("toolCall.imagegen.generatedImage", {
                        defaultValue: "Generated image",
                      })}
                      loading="lazy"
                      onClick={() =>
                        openLightbox(
                          resultItems,
                          resultItems.findIndex((it) => it.key === item.key)
                        )
                      }
                    />
                    <div className="ai-drawing-gallery-actions">
                      <button
                        type="button"
                        className="ai-drawing-img-action"
                        title={t("toolCall.imagegen.zoom", {
                          defaultValue: "Zoom image",
                        })}
                        onClick={() =>
                          openLightbox(
                            resultItems,
                            resultItems.findIndex((it) => it.key === item.key)
                          )
                        }
                      >
                        <ImageIcon size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className="ai-drawing-img-action"
                        title={t("toolCall.imagegen.download", {
                          defaultValue: "Save image",
                        })}
                        onClick={() => void handleSaveOne(item)}
                      >
                        <Download size={13} strokeWidth={1.8} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>
  
        {/* 图库历史（存储） */}
        <div
          className={`ai-drawing-section ai-drawing-history${
            historyCollapsed ? " collapsed" : ""
          }`}
          title={t("rightPanel.aiDrawing.libraryDragHint")}
        >
          <div className="ai-drawing-result-header">
            <span className="ai-drawing-result-title">
              <button
                type="button"
                className="ai-drawing-history-collapse"
                title={
                  historyCollapsed
                    ? t("rightPanel.aiDrawing.expand")
                    : t("rightPanel.aiDrawing.collapse")
                }
                aria-expanded={!historyCollapsed}
                onClick={() => setHistoryCollapsed((collapsed) => !collapsed)}
              >
                <ChevronDown size={13} strokeWidth={1.8} />
              </button>
              <Images size={13} strokeWidth={1.8} />
              <span>{t("rightPanel.aiDrawing.history")}</span>
              {library.length > 0 && (
                <span className="ai-drawing-history-count">
                  {historyQuery.trim()
                    ? `${filteredLibrary.length} / ${library.length}`
                    : library.length}
                </span>
              )}
            </span>
            <div className="ai-drawing-history-tools">
              {!historyCollapsed && library.length > 0 && (
                <input
                  type="text"
                  className="ai-drawing-history-search"
                  value={historyQuery}
                  placeholder={t("rightPanel.aiDrawing.searchHistory")}
                  onChange={(event) => setHistoryQuery(event.target.value)}
                />
              )}
              <button
                type="button"
                className="ai-drawing-refresh-btn"
                title={t("rightPanel.aiDrawing.refresh")}
                onClick={() => void loadLibrary()}
              >
                <RefreshCw size={13} strokeWidth={1.8} />
              </button>
            </div>
          </div>
  
          {historyCollapsed ? null : library.length === 0 ? (
            <div className="ai-drawing-status ai-drawing-status-empty">
              <Images size={18} strokeWidth={1.8} />
              <span>{t("rightPanel.aiDrawing.historyEmpty")}</span>
            </div>
          ) : filteredLibrary.length === 0 ? (
            <div className="ai-drawing-status ai-drawing-status-empty">
              <Images size={18} strokeWidth={1.8} />
              <span>{t("rightPanel.aiDrawing.historyNoMatch")}</span>
            </div>
          ) : (
            <>
              <div className="ai-drawing-library-grid">
                {visibleLibrary.map((record, index) => (
                  <div
                    className="ai-drawing-library-item"
                    key={record.id}
                    draggable
                    onDragStart={(event) => {
                      // 拖拽协议：application/json（与 file-tags/web-tag 同通道），
                      // 可拖到聊天输入框（发图）或工作台其他区域（设为参考图）。
                      event.dataTransfer.setData(
                        "application/json",
                        JSON.stringify({
                          type: "library-image",
                          path: record.relativePath,
                          mimeType: record.mimeType,
                          name:
                            record.relativePath.split("/").pop() ??
                            record.relativePath,
                        })
                      );
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                  >
                    <LibraryImage
                      path={record.relativePath}
                      alt={record.prompt || record.relativePath}
                      title={`${record.prompt || record.relativePath}\n${formatTime(
                        record.createdAt
                      )}`}
                      loading="lazy"
                      onClick={() =>
                        openLightbox(
                          visibleLibrary.map((item) => ({
                            key: item.id,
                            src: proxyForLibraryPath(item.relativePath),
                            record: item,
                          })),
                          index
                        )
                      }
                    />
                    <div className="ai-drawing-library-actions">
                      <button
                        type="button"
                        className="ai-drawing-img-action"
                        title={t("toolCall.imagegen.refEditTitle", {
                          defaultValue: "Regenerate using this image",
                        })}
                        onClick={() => handleUseAsReference(record)}
                      >
                        <Sparkles size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className="ai-drawing-img-action"
                        title={t("toolCall.imagegen.zoom", {
                          defaultValue: "Zoom image",
                        })}
                        onClick={() =>
                          openLightbox(
                            visibleLibrary.map((item) => ({
                              key: item.id,
                              src: proxyForLibraryPath(item.relativePath),
                              record: item,
                            })),
                            index
                          )
                        }
                      >
                        <ImageIcon size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className="ai-drawing-img-action ai-drawing-delete-btn"
                        title={t("rightPanel.aiDrawing.delete")}
                        onClick={() => handleDelete(record)}
                      >
                        <Trash2 size={13} strokeWidth={1.8} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {hasMoreLibrary && (
                <button
                  type="button"
                  className="ai-drawing-load-more"
                  onClick={handleLoadMore}
                >
                  {t("rightPanel.aiDrawing.loadMore")}
                </button>
              )}
            </>
          )}
      </div>
      </div>

      {/* 删除确认弹窗（fixed 全屏浮层，保持在 container-type 容器之外） */}
      {deleteTarget && (
        <div
          className="ai-drawing-delete-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("rightPanel.aiDrawing.deleteDialogTitle")}
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="ai-drawing-delete-dialog-body"
            onClick={(event) => event.stopPropagation()}
          >
            <LibraryImage
              path={deleteTarget.relativePath}
              alt={t("rightPanel.aiDrawing.deleteDialogTitle")}
              className="ai-drawing-delete-thumb"
            />
            <p className="ai-drawing-delete-text">
              {t("rightPanel.aiDrawing.deleteDialogBody")}
            </p>
            <div className="ai-drawing-delete-actions">
              <button
                type="button"
                className="ai-drawing-delete-cancel"
                onClick={() => setDeleteTarget(null)}
              >
                {t("rightPanel.aiDrawing.deleteDialogCancel")}
              </button>
              <button
                type="button"
                className="ai-drawing-delete-ok"
                onClick={() => void confirmDelete(deleteTarget)}
              >
                {t("rightPanel.aiDrawing.deleteDialogConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 灯箱 */}
      {lightbox && lightboxItem && (
        <div
          className="ai-drawing-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={closeLightbox}
        >
          <button
            type="button"
            className="ai-drawing-lightbox-close"
            title={t("toolCall.imagegen.close", { defaultValue: "Close" })}
            onClick={closeLightbox}
          >
            <X size={18} strokeWidth={1.8} />
          </button>
          {lightbox.items.length > 1 && (
            <>
              <button
                type="button"
                className="ai-drawing-lightbox-nav ai-drawing-lightbox-prev"
                title={t("toolCall.imagegen.prev", {
                  defaultValue: "Previous",
                })}
                onClick={(event) => {
                  event.stopPropagation();
                  lightboxStep(-1);
                }}
              >
                <ChevronLeft size={22} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="ai-drawing-lightbox-nav ai-drawing-lightbox-next"
                title={t("toolCall.imagegen.next", { defaultValue: "Next" })}
                onClick={(event) => {
                  event.stopPropagation();
                  lightboxStep(1);
                }}
              >
                <ChevronRight size={22} strokeWidth={1.8} />
              </button>
            </>
          )}
          <div
            className="ai-drawing-lightbox-body"
            onClick={(event) => event.stopPropagation()}
          >
            {lightbox.items.length > 1 && (
              <span className="ai-drawing-lightbox-counter">
                {t("rightPanel.aiDrawing.lightboxCounter", {
                  values: {
                    index: lightbox.index + 1,
                    total: lightbox.items.length,
                  },
                })}
              </span>
            )}
            <LibraryImage
              path={
                lightboxItem.path ??
                lightboxItem.record?.relativePath ??
                lightboxItem.image?.path
              }
              src={
                lightboxItem.path ??
                lightboxItem.record?.relativePath ??
                lightboxItem.image?.path
                  ? undefined
                  : lightboxItem.src
              }
              alt={t("toolCall.imagegen.generatedImage", {
                defaultValue: "Generated image",
              })}
            />
            {lightboxItem.record?.prompt && (
              <div className="ai-drawing-lightbox-meta">
                <span className="ai-drawing-lightbox-prompt">
                  {lightboxItem.record.prompt}
                </span>
                <span className="ai-drawing-lightbox-time">
                  {formatTime(lightboxItem.record.createdAt)}
                </span>
              </div>
            )}
            <div className="ai-drawing-lightbox-actions">
              {lightboxItem.record && (
                <button
                  type="button"
                  className="ai-drawing-lightbox-btn"
                  onClick={() => {
                    if (lightboxItem.record) {
                      handleUseAsReference(lightboxItem.record);
                    }
                    closeLightbox();
                  }}
                >
                  <Sparkles size={14} strokeWidth={1.8} />
                  <span>
                    {t("toolCall.imagegen.refEdit", {
                      defaultValue: "Use as reference",
                    })}
                  </span>
                </button>
              )}
              <button
                type="button"
                className="ai-drawing-lightbox-btn"
                disabled={saving}
                onClick={() => void handleSaveOne(lightboxItem)}
              >
                <Download size={14} strokeWidth={1.8} />
                <span>
                  {t("toolCall.imagegen.download", {
                    defaultValue: "Save image",
                  })}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
