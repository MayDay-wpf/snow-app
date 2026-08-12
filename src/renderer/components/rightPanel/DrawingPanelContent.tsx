import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Ban,
  CheckCircle2,
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
import type { Model } from "../../../preload";
import {
  filterImageModels,
  inferModelCapabilities,
  isGrokModel,
  openaiFixedSizePresets,
  supportsSizeTier,
} from "./modelCapabilities";
import type { ModelCapabilities } from "./modelCapabilities";
import {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  IMAGE_GEN_SETTING_CODE,
} from "../sidebar/imagegenSettings/constants";
import {
  OPENAI_SIZE_PRESETS,
  OPENAI_SIZE_TIERS,
  GEMINI_SIZE_PRESETS,
  GROK_SIZE_PRESETS,
  buildGeminiSize,
  buildGrokSize,
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

const COUNT_OPTIONS = [1, 2, 4, 8];

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

/** 把图库相对路径解析为可展示的代理 URL（带缓存，避免重复构造）。 */
const proxyForLibraryPath = (path: string): string => {
  const cached = libraryProxyCache.get(path);
  if (cached) {
    return cached;
  }
  const url = localImageProxyUrl(path);
  libraryProxyCache.set(path, url);
  return url;
};

/** 图库图片的 data URL 缓存（IPC resolveLibraryImage，删除图片时同步失效）。 */
const libraryDataCache = new Map<string, string>();

/** 异步读取图库图片为 data URL（带缓存；失败返回 null）。 */
const resolveLibraryDataUrl = async (path: string): Promise<string | null> => {
  const cached = libraryDataCache.get(path);
  if (cached) {
    return cached;
  }
  try {
    const dataUrl = await window.snow.resolveLibraryImage(path);
    if (dataUrl) {
      libraryDataCache.set(path, dataUrl);
    }
    return dataUrl;
  } catch {
    return null;
  }
};

/** 上传/任意本地路径图片的 data URL 缓存（绝对路径或 upload/...，参考图用）。 */
const uploadDataCache = new Map<string, string>();

/** 异步读取 upload/ 相对路径或绝对路径图片为 data URL（带缓存；失败返回 null）。 */
const resolveUploadDataUrl = async (path: string): Promise<string | null> => {
  const cached = uploadDataCache.get(path);
  if (cached) {
    return cached;
  }
  try {
    const dataUrl = await window.snow.resolveUploadImage(path);
    if (dataUrl) {
      uploadDataCache.set(path, dataUrl);
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
    const load = path.startsWith("image/")
      ? resolveLibraryDataUrl
      : resolveUploadDataUrl;
    void load(path).then((dataUrl) => {
      if (!cancelled && dataUrl) {
        setResolved((prev) => prev ?? dataUrl);
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
export function DrawingPanelContent({
  isActive,
  onOpenImageGenSettings,
}: DrawingPanelContentProps): React.JSX.Element {
  const { t } = useI18n();

  // ----------------------------------------------------------------
  // 参数区
  // ----------------------------------------------------------------
  const [channels, setChannels] = useState<ImageGenChannelValue[]>([]);
  const [prompt, setPrompt] = useState("");
  const [channelId, setChannelId] = useState("");
  /** 当前选中的模型（来自聚合的渠道模型列表；加载完成后默认选中第一个）。 */
  const [model, setModel] = useState("");
  /** 当前模型的 ref 镜像（loadModels 内部读取，避免切换模型触发重复拉取）。 */
  const modelRef = useRef(model);
  modelRef.current = model;
  /** 聚合模型列表（所有启用渠道模型 API 的并集，记录所属渠道）。 */
  const [modelList, setModelList] = useState<AggregatedModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  /** 模型列表拉取失败（无任何渠道返回可用模型）。 */
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  /** 宽高比（空 = 渠道默认）。 */
  const [ratio, setRatio] = useState("");
  /** 档位 1K/2K/4K（空 = 渠道默认）。 */
  const [tier, setTier] = useState("");
  /** 分辨率（ratio-resolution 体系，如 xAI Grok 的 1k/2k；空 = 渠道默认）。 */
  const [resolution, setResolution] = useState("");
  const [quality, setQuality] = useState("auto");
  const [count, setCount] = useState(1);
  const [stream, setStream] = useState(true);
  // 高级参数（按渠道协议分别生效）
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [outputFormat, setOutputFormat] = useState("");
  const [outputCompression, setOutputCompression] = useState("");
  const [background, setBackground] = useState("");
  const [inputFidelity, setInputFidelity] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [webSearch, setWebSearch] = useState(false);
  const [imageSearch, setImageSearch] = useState(false);
  const [personGeneration, setPersonGeneration] = useState("");
  const [seed, setSeed] = useState("");
  /** 图生图参考图（图库相对路径 image/...）。 */
  const [refImage, setRefImage] = useState<{
    path: string;
    mimeType: string;
  } | null>(null);

  // 图库面板「设为参考图」事件（跨组件联动；组件常驻渲染，挂载即监听）。
  useEffect(() => {
    const handleSetReference = (event: Event): void => {
      const detail = (
        event as CustomEvent<{ path?: unknown; mimeType?: unknown }>
      ).detail;
      if (typeof detail?.path !== "string" || !detail.path) {
        return;
      }
      setRefImage({
        path: detail.path,
        mimeType:
          typeof detail.mimeType === "string" ? detail.mimeType : "image/png",
      });
    };
    window.addEventListener("drawing:set-reference", handleSetReference);
    return () =>
      window.removeEventListener("drawing:set-reference", handleSetReference);
  }, []);

  const [gen, setGen] = useState<GenerationState>({ status: "idle" });

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

  /** Gemini 档位候选（按模型能力过滤）。 */
  const geminiTierOptions = useMemo(() => {
    if (!selectedChannel || selectedChannel.provider !== "gemini") {
      return [];
    }
    return getGeminiSizePresets(model.trim() || selectedChannel.model);
  }, [selectedChannel, model]);

  /** 模型能力联动：不支持的选项自动回退（数量/透明背景/档位/搜索）。 */
  useEffect(() => {
    if (!capabilities) {
      return;
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

  /** 质量选项联动：模型变化后当前值不在选项内时回退（auto → high → 首项）。 */
  useEffect(() => {
    const options = qualityOptions;
    if (options.length === 0) {
      return; // 无质量参数的模型：保留当前值但不发送
    }
    if (options.some((option) => option.value === quality)) {
      return;
    }
    const fallback =
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

  const handleGenerate = useCallback(async (): Promise<void> => {
    const text = prompt.trim();
    if (!text || isGenerating) {
      return;
    }
    const args: Record<string, unknown> = {
      prompt: text,
      // 流式：模型不支持（如 xAI Grok）时强制关闭
      stream: capabilities?.supportsStream === false ? false : stream,
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
    // 种子（可复现；留空随机；模型不支持时忽略）
    if (capabilities?.supportsSeed !== false && seed.trim() !== "") {
      const parsedSeed = Number(seed.trim());
      if (Number.isFinite(parsedSeed)) {
        args.seed = Math.round(parsedSeed);
      }
    }
    // 图生图：模型明确不支持参考图时忽略（如 dall-e-3 / imagen 仅文生图）。
    if (refImage && capabilities?.supportsReference !== false) {
      // 图库图片（image/...）不在 imagegen 相对路径白名单（仅 upload/ 或绝对路径），
      // 先经 IPC 读为 data URL，再以内联 base64 传入。
      if (refImage.path.startsWith("image/")) {
        const dataUrl = await resolveLibraryDataUrl(refImage.path);
        if (dataUrl) {
          const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
          if (match) {
            args.images = [{ data: match[2], mimeType: match[1] }];
          }
        }
      } else {
        args.images = [{ path: refImage.path, mimeType: refImage.mimeType }];
      }
    }

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
          if (chunk.stream !== "imagegen") {
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
              setGen((prev) => {
                if (prev.status !== "running") {
                  return prev;
                }
                const list = prev.streaming;
                const existing = list.findIndex(
                  (item) => item.index === image.index
                );
                const next =
                  existing >= 0
                    ? list.map((item, i) => (i === existing ? image : item))
                    : [...list, image].sort((a, b) => a.index - b.index);
                return { status: "running", streaming: next };
              });
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
      setGen({ status: "done", result: parseImageGenResult(result) });
      // 生成完成：Rust 侧已自动落盘图库，刷新历史列表。
      void loadLibrary();
    } catch (error) {
      setGen({
        status: "error",
        error: classifyImageGenError(getErrorMessage(error)),
      });
    }
  }, [
    prompt,
    isGenerating,
    channelId,
    model,
    effectiveSize,
    capabilities,
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
    refImage,
  ]);

  const handleKeyDownOnPrompt = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void handleGenerate();
      }
    },
    [handleGenerate]
  );

  // ----------------------------------------------------------------
  // 本次生成结果 → 画廊项
  // ----------------------------------------------------------------
  const resultItems = useMemo<GalleryItem[]>(() => {
    if (gen.status !== "done" || gen.result.type !== "success") {
      return [];
    }
    const items: GalleryItem[] = [];
    for (const image of gen.result.images) {
      items.push({
        key: image.path ?? `img-${image.data.length}`,
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

  const visibleLibrary = library.slice(0, visibleCount);
  const hasMoreLibrary = visibleCount < library.length;

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
        setRefImage((prev) => (prev?.path === record.relativePath ? null : prev));
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

  /** 以图库历史图为参考（图生图）重新生成。 */
  const handleUseAsReference = useCallback(
    (record: {
      relativePath: string;
      mimeType: string;
      prompt: string;
    }) => {
      setRefImage({
        path: record.relativePath,
        mimeType: record.mimeType,
      });
      if (record.prompt) {
        setPrompt(record.prompt);
      }
    },
    []
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

  /** 上传本地图片作为参考图：选择文件 → 直接以绝对路径设为参考图（不进入图库）。 */
  const handleUploadImages = useCallback(async (): Promise<void> => {
    try {
      const selected = await window.snow.selectImageFiles(
        t("rightPanel.aiDrawing.uploadDialogTitle")
      );
      if (!selected || selected.length === 0) {
        return;
      }
      // 仅取第一张作为参考图；imagegen 支持绝对路径参考图，无需导入图库。
      const first = selected[0];
      setRefImage({ path: first, mimeType: inferMimeFromPath(first) });
      setImportNotice({
        kind: "ok",
        text: t("rightPanel.aiDrawing.uploadRefDone"),
      });
    } catch (error) {
      console.warn("[ai-drawing] pick reference image failed", error);
      setImportNotice({
        kind: "error",
        text: t("rightPanel.aiDrawing.importFailed"),
      });
    }
  }, [t]);

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
      //    或 { type: "library-images", images: [{ path, mimeType? }] } 批量（取第一张）。
      const jsonData = event.dataTransfer.getData("application/json");
      if (jsonData) {
        try {
          const parsed = JSON.parse(jsonData) as Record<string, unknown>;
          let image: { path: string; mimeType: string } | null = null;
          if (parsed.type === "library-image" && typeof parsed.path === "string") {
            image = {
              path: parsed.path,
              mimeType:
                typeof parsed.mimeType === "string"
                  ? parsed.mimeType
                  : "image/png",
            };
          } else if (
            parsed.type === "library-images" &&
            Array.isArray(parsed.images) &&
            parsed.images.length > 0
          ) {
            const first = parsed.images[0] as {
              path?: unknown;
              mimeType?: unknown;
            };
            if (typeof first?.path === "string") {
              image = {
                path: first.path,
                mimeType:
                  typeof first.mimeType === "string"
                    ? first.mimeType
                    : "image/png",
              };
            }
          }
          if (image && !inLibrary) {
            setRefImage(image);
            setImportNotice({
              kind: "ok",
              text: t("rightPanel.aiDrawing.refSetDone"),
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
        // 拖入图库区：导入图库（复制 + 写索引）。
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
      } else {
        // 拖入其他区域：第一张设为参考图（绝对路径，不进入图库）。
        setRefImage({
          path: imagePaths[0].path,
          mimeType: inferMimeFromPath(imagePaths[0].path),
        });
        setImportNotice({
          kind: "ok",
          text: t("rightPanel.aiDrawing.refSetDone"),
        });
      }
    },
    [loadLibrary, t]
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
      {/* 提示词 + 生成 */}
      <div className="ai-drawing-composer">
        <textarea
          className="ai-drawing-prompt"
          value={prompt}
          placeholder={t("rightPanel.aiDrawing.promptPlaceholder")}
          rows={3}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleKeyDownOnPrompt}
        />
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
          <button
            type="button"
            className="ai-drawing-generate-btn"
            disabled={!prompt.trim() || isGenerating}
            onClick={() => void handleGenerate()}
          >
            {isGenerating ? (
              <Loader2 size={14} strokeWidth={1.8} className="ai-drawing-spin" />
            ) : (
              <Sparkles size={14} strokeWidth={1.8} />
            )}
            <span>
              {isGenerating
                ? t("toolCall.imagegen.generating", {
                    defaultValue: "Generating image...",
                  })
                : t("rightPanel.aiDrawing.generate")}
            </span>
          </button>
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
            <select
              value={model}
              disabled={modelsLoading || modelsLoadFailed}
              title={t("rightPanel.aiDrawing.modelHint")}
              onChange={(event) => handleModelChange(event.target.value)}
            >
              {modelsLoading ? (
                <option value="">
                  {t("rightPanel.aiDrawing.modelsLoading")}
                </option>
              ) : modelsLoadFailed || modelList.length === 0 ? (
                <option value="">
                  {t("rightPanel.aiDrawing.modelsLoadFailed")}
                </option>
              ) : (
                modelList.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                  </option>
                ))
              )}
            </select>
          )}
        </label>

        <label className="ai-drawing-param">
          <span className="ai-drawing-param-label">
            {t("rightPanel.aiDrawing.ratio")}
          </span>
          <select
            value={ratio}
            onChange={(event) => setRatio(event.target.value)}
          >
            <option value="">{t("rightPanel.aiDrawing.sizeDefault")}</option>
            {(capabilities?.sizeSystem === "ratio-resolution" ||
            capabilities?.sizeSystem === "gemini-tier"
              ? capabilities.ratios
              : showTier
                ? Object.keys(OPENAI_SIZE_PRESETS)
                : fixedSizePresets.map((preset) => preset.ratio)
            ).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        {/* 分辨率（ratio-resolution 体系，如 xAI Grok 的 1k/2k） */}
        {capabilities?.sizeSystem === "ratio-resolution" && (
          <label className="ai-drawing-param">
            <span className="ai-drawing-param-label">
              {t("rightPanel.aiDrawing.resolution")}
            </span>
            <select
              value={resolution}
              onChange={(event) => setResolution(event.target.value)}
            >
              {capabilities.resolutions.map((value) => (
                <option key={value} value={value}>
                  {value === ""
                    ? t("rightPanel.aiDrawing.sizeDefault")
                    : value}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* 档位（像素规格 1K/2K/4K）：仅支持档位的模型显示（gpt-image-2 + Gemini） */}
        {showTier && (
          <label className="ai-drawing-param">
            <span className="ai-drawing-param-label">
              {t("rightPanel.aiDrawing.tier")}
            </span>
            <select
              value={tier}
              onChange={(event) => setTier(event.target.value)}
              title={
                isGemini || !ratio
                  ? undefined
                  : ratio && tier
                    ? OPENAI_SIZE_PRESETS[ratio]?.[
                        tier as "1K" | "2K" | "4K"
                      ]
                    : undefined
              }
            >
              <option value="">{t("rightPanel.aiDrawing.sizeDefault")}</option>
              {(isGemini
                ? geminiTierOptions
                : OPENAI_SIZE_TIERS
              ).map((value) => (
                <option key={value} value={value}>
                  {value}
                  {!isGemini &&
                    ratio &&
                    OPENAI_SIZE_PRESETS[ratio]?.[
                      value as "1K" | "2K" | "4K"
                    ] &&
                    ` (${OPENAI_SIZE_PRESETS[ratio][
                      value as "1K" | "2K" | "4K"
                    ]})`}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* 质量：按模型能力裁剪选项；无质量参数的模型（dall-e-2 / grok-quality）隐藏 */}
        {qualityOptions.length > 0 && (
          <label className="ai-drawing-param">
            <span className="ai-drawing-param-label">
              {t("toolCall.imagegen.quality", { defaultValue: "Quality" })}
            </span>
            <select
              value={quality}
              onChange={(event) => setQuality(event.target.value)}
            >
              {qualityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="ai-drawing-param">
          <span className="ai-drawing-param-label">
            {t("rightPanel.aiDrawing.count")}
          </span>
          <select
            value={count}
            disabled={capabilities ? !capabilities.supportsMultiCount : false}
            title={
              capabilities && !capabilities.supportsMultiCount
                ? t("rightPanel.aiDrawing.modelSingleCount")
                : undefined
            }
            onChange={(event) => setCount(Number(event.target.value))}
          >
            {COUNT_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {t("toolCall.imagegen.countParam", {
                  defaultValue: "{{count}} images",
                  values: { count: value },
                })}
              </option>
            ))}
          </select>
        </label>

        {/* 流式预览：模型不支持时隐藏（如 xAI Grok） */}
        {capabilities?.supportsStream !== false && (
          <label className="ai-drawing-param ai-drawing-param-stream">
            <input
              type="checkbox"
              checked={stream}
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
                  <select
                    value={thinkingLevel}
                    onChange={(event) => setThinkingLevel(event.target.value)}
                  >
                    {THINKING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="ai-drawing-param">
                <span className="ai-drawing-param-label">
                  {t("rightPanel.aiDrawing.personGeneration")}
                </span>
                <select
                  value={personGeneration}
                  onChange={(event) => setPersonGeneration(event.target.value)}
                >
                  {PERSON_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </option>
                  ))}
                </select>
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
                  <select
                    value={outputFormat}
                    onChange={(event) => setOutputFormat(event.target.value)}
                  >
                    <option value="">
                      {t("rightPanel.aiDrawing.formatDefault")}
                    </option>
                    <option value="png">
                      {t("rightPanel.aiDrawing.formatPng")}
                    </option>
                    <option value="jpeg">
                      {t("rightPanel.aiDrawing.formatJpeg")}
                    </option>
                  </select>
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
                  <select
                    value={outputFormat}
                    onChange={(event) => setOutputFormat(event.target.value)}
                  >
                    {OPENAI_FORMAT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {capabilities?.supportsCompression !== false ? (
                <label className="ai-drawing-param">
                  <span className="ai-drawing-param-label">
                    {t("rightPanel.aiDrawing.compression")}
                  </span>
                  <select
                    value={outputCompression}
                    onChange={(event) =>
                      setOutputCompression(event.target.value)
                    }
                  >
                    {COMPRESSION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {capabilities?.supportsBackground !== false ? (
                <label className="ai-drawing-param">
                  <span className="ai-drawing-param-label">
                    {t("rightPanel.aiDrawing.background")}
                  </span>
                  <select
                    value={background}
                    onChange={(event) => setBackground(event.target.value)}
                  >
                    {BACKGROUND_OPTIONS.map((option) => (
                      <option
                        key={option.value}
                        value={option.value}
                        disabled={
                          option.value === "transparent" &&
                          (capabilities
                            ? !capabilities.supportsTransparent
                            : false)
                        }
                      >
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {capabilities?.supportsFidelity !== false ? (
                <label className="ai-drawing-param">
                  <span className="ai-drawing-param-label">
                    {t("rightPanel.aiDrawing.fidelity")}
                  </span>
                  <select
                    value={inputFidelity}
                    onChange={(event) => setInputFidelity(event.target.value)}
                  >
                    {FIDELITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
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

      {/* 参考图（图生图） */}
      {refImage && (
        <div className="ai-drawing-ref">
          <LibraryImage
            path={refImage.path}
            alt={t("toolCall.imagegen.refImage", {
              defaultValue: "Reference image",
            })}
            className="ai-drawing-ref-thumb"
          />
          <span className="ai-drawing-ref-label">
            {t("rightPanel.aiDrawing.reference")}
          </span>
          <button
            type="button"
            className="ai-drawing-ref-remove"
            title={t("rightPanel.aiDrawing.removeReference")}
            onClick={() => setRefImage(null)}
          >
            <X size={13} strokeWidth={1.8} />
          </button>
        </div>
      )}

      {/* 模型不支持参考图时提示（如 dall-e-3 / imagen 仅文生图） */}
      {refImage && capabilities && !capabilities.supportsReference && (
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
              <div className="ai-drawing-gallery">
                {streamingItems.map((image) => (
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
        className="ai-drawing-section ai-drawing-history"
        title={t("rightPanel.aiDrawing.libraryDragHint")}
      >
        <div className="ai-drawing-result-header">
          <span className="ai-drawing-result-title">
            <Images size={13} strokeWidth={1.8} />
            <span>{t("rightPanel.aiDrawing.history")}</span>
            {library.length > 0 && (
              <span className="ai-drawing-history-count">
                {library.length}
              </span>
            )}
          </span>
          <button
            type="button"
            className="ai-drawing-refresh-btn"
            title={t("rightPanel.aiDrawing.refresh")}
            onClick={() => void loadLibrary()}
          >
            <RefreshCw size={13} strokeWidth={1.8} />
          </button>
        </div>

        {library.length === 0 ? (
          <div className="ai-drawing-status ai-drawing-status-empty">
            <Images size={18} strokeWidth={1.8} />
            <span>{t("rightPanel.aiDrawing.historyEmpty")}</span>
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

      {/* 删除确认弹窗 */}
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
                lightboxItem.record?.relativePath ?? lightboxItem.image?.path
              }
              src={
                lightboxItem.record?.relativePath ?? lightboxItem.image?.path
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
