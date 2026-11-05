import {
  BadgeCheck,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Clock,
  Copy,
  Eye,
  EyeOff,
  Gauge,
  GripVertical,
  ImageIcon,
  Layers,
  Loader2,
  Minus,
  Pencil,
  Plus,
  Search,
  SearchX,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { CustomSelect, type CustomSelectOption } from "../common/CustomSelect";
import { useI18n } from "../../i18n";
import { ModelBrandIcon } from "../common/ModelBrandIcon";
import { ApiModelCombobox } from "./apiSettings/ApiModelCombobox";
import { ApiSettingsFormActions } from "./apiSettings/ApiSettingsFormPanel";
import { buildDuplicateName } from "./duplicateName";
import {
  applyCapability,
  filterImageModels,
  forceApplyCapability,
  getModelCapabilities,
  openaiStandardCaps,
  resolvePrimaryIndex,
  supportsArbitraryOpenAISize,
  type KnownImageModel,
} from "./imagegenSettings/panelLogic";
import {
  GeminiSizeControls,
  GptImage2SizeControls,
  sizePresetOptions,
} from "./imagegenSettings/SizeControls";
import type { Model } from "../../../preload";
import {
  API_CONFIG_ROW_ATTRIBUTE,
  useApiConfigReorder,
} from "./apiSettings/apiConfigReorder";
import {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_IMAGE_GEN_CHANNEL,
  DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
  DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
  DEFAULT_IMAGE_GEN_EXECUTION_MODE,
  DEFAULT_NOVELAI_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  GEMINI_MODEL_EXAMPLES,
  GEMINI_ASPECT_RATIOS,
  IMAGE_GEN_MAX_CONCURRENT_RANGE,
  IMAGE_GEN_SETTING_CODE,
  IMAGE_GEN_SETTING_NAME,
  IMAGE_GEN_TIMEOUT_RANGE,
  IMAGE_GEN_TEMPLATES,
  NOVELAI_MODEL_EXAMPLES,
  OPENAI_MODEL_EXAMPLES,
  OPENAI_SIZE_PRESETS,
  OPENAI_SIZE_TIERS,
  buildGeminiSize,
  getGeminiSizePresets,
  matchGeminiSizePreset,
  matchOpenAISizePreset,
} from "./imagegenSettings/constants";
import {
  generateChannelId,
  readImageGenSettingsJson,
  toImageGenSettingsJson,
} from "./imagegenSettings/utils";
import {
  isGeminiFamilyModel,
  resolveModelCapability,
} from "./imagegenSettings/modelCapabilities";
import type {
  ImageGenChannelValue,
  ImageGenExecutionMode,
  ImageGenModelItem,
  ImageGenProvider,
  ImageGenTemplate,
} from "./imagegenSettings/types";

/**
 * 已知生图模型知识表（别名 / 预览 / 弃用），用于模型下拉选项增强。
 * 模型 ID 依据 OpenAI SDK ImageModel 枚举与 Gemini 官方模型清单。
 */
const KNOWN_IMAGE_MODELS: KnownImageModel[] = [
  // OpenAI 兼容
  {
    id: "gpt-image-2.6-flare",
    provider: "openai",
    alias: "GPT Image 2.6 Flare",
  },
  {
    id: "gpt-image-2.6-sunburst",
    provider: "openai",
    alias: "GPT Image 2.6 Sunburst",
  },
  {
    id: "gpt-image-2.5-flare",
    provider: "openai",
    alias: "GPT Image 2.5 Flare",
  },
  {
    id: "gpt-image-2.5-sunburst",
    provider: "openai",
    alias: "GPT Image 2.5 Sunburst",
  },
  { id: "gpt-image-2", provider: "openai", alias: "GPT Image 2" },
  {
    id: "chatgpt-image-latest",
    provider: "openai",
    alias: "ChatGPT Image (latest)",
    preview: true,
  },
  { id: "dall-e-3", provider: "openai", alias: "DALL·E 3" },
  { id: "dall-e-2", provider: "openai", alias: "DALL·E 2", deprecated: true },
  {
    id: "grok-imagine-image-2.0",
    provider: "openai",
    alias: "Grok Imagine 2.0 (xAI)",
  },
  {
    id: "qwen-image-2.1",
    provider: "openai",
    alias: "Qwen Image 2.1 (通义千问)",
  },
  {
    id: "wanx2.1-t2i-plus",
    provider: "openai",
    alias: "Wanx 2.1 Plus (通义万相)",
  },
  {
    id: "niji-6",
    provider: "openai",
    alias: "Midjourney Niji 6 (二次元动漫)",
  },
  {
    id: "nai-diffusion-4-full",
    provider: "openai",
    alias: "NovelAI Diffusion Anime V4",
  },
  {
    id: "animagine-xl-3.1",
    provider: "openai",
    alias: "Animagine XL 3.1 (SDXL 动漫)",
  },
  {
    id: "flux-1.1-pro",
    provider: "openai",
    alias: "FLUX.1.1 Pro (超写实摄影)",
  },
  {
    id: "flux-1.1-ultra",
    provider: "openai",
    alias: "FLUX 1.1 Ultra (4MP Raw)",
  },
  {
    id: "cogview-3-plus",
    provider: "openai",
    alias: "CogView-3-Plus (智谱清言)",
  },
  {
    id: "cogview-4",
    provider: "openai",
    alias: "CogView-4 (智谱最新)",
  },
  {
    id: "qwen-image-2.1-turbo",
    provider: "openai",
    alias: "Qwen Image 2.1 Turbo (极速)",
  },
  {
    id: "wanx2.1-t2i-turbo",
    provider: "openai",
    alias: "Wanx 2.1 Turbo",
  },
  // Google Gemini
  {
    id: "gemini-nano-banana-2.1",
    provider: "gemini",
    alias: "Nano Banana 2.1 (最新香蕉 2.1)",
  },
  {
    id: "gemini-3.1-flash-image",
    provider: "gemini",
    alias: "Nano Banana 2 (3.1 Flash)",
  },
  {
    id: "gemini-3.1-flash-image-preview",
    provider: "gemini",
    alias: "Nano Banana 2 (Preview)",
    preview: true,
  },
  {
    id: "gemini-3-pro-image",
    provider: "gemini",
    alias: "Nano Banana Pro",
  },
  {
    id: "gemini-3-pro-image-preview",
    provider: "gemini",
    alias: "Nano Banana Pro (Preview)",
    preview: true,
  },
  {
    id: "gemini-3.1-flash-lite-image",
    provider: "gemini",
    alias: "Nano Banana 2 Lite",
  },
  {
    id: "gemini-2.5-flash-image",
    provider: "gemini",
    alias: "Nano Banana 1 (legacy)",
    deprecated: true,
  },
  {
    id: "imagen-3.0-generate-002",
    provider: "gemini",
    alias: "Imagen 3",
    deprecated: true,
  },
];

export function ImageGenSettingsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [channels, setChannels] = useState<ImageGenChannelValue[]>([]);
  /** 同一批次生图请求的最大并发数（1-8，立即保存）。 */
  const [maxConcurrent, setMaxConcurrent] = useState(
    DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
  );
  /** persistChannels 闭包内读取最新并发数（避免 state 过期）。 */
  const maxConcurrentRef = useRef(DEFAULT_IMAGE_GEN_MAX_CONCURRENT);
  /** 生图请求超时（秒，60-3600，立即保存）。 */
  const [timeoutSecs, setTimeoutSecs] = useState(
    DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
  );
  /** persistChannels 闭包内读取最新超时（避免 state 过期）。 */
  const timeoutSecsRef = useRef(DEFAULT_IMAGE_GEN_TIMEOUT_SECS);
  /** 生图执行模式（auto / sync / async，立即保存）。 */
  const [executionMode, setExecutionMode] = useState<ImageGenExecutionMode>(
    DEFAULT_IMAGE_GEN_EXECUTION_MODE,
  );
  /** persistChannels 闭包内读取最新执行模式（避免 state 过期）。 */
  const executionModeRef = useRef<ImageGenExecutionMode>(
    DEFAULT_IMAGE_GEN_EXECUTION_MODE,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const isMountedRef = useRef(true);

  // 弹窗编辑状态
  const [editorOpen, setEditorOpen] = useState(false);
  const [isNewChannel, setIsNewChannel] = useState(false);
  const [draft, setDraft] = useState<ImageGenChannelValue | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [activeModelIndex, setActiveModelIndex] = useState(0);

  // 弹窗内模型列表（基于草稿的 baseUrl/apiKey）
  const [draftModels, setDraftModels] = useState<Model[]>([]);
  const [draftModelsLoading, setDraftModelsLoading] = useState(false);
  const [draftModelsError, setDraftModelsError] = useState<string | null>(null);

  // 搜索
  const [searchQuery, setSearchQuery] = useState("");

  // 表格多选与批量删除（与 LLM 模型表格一致）
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [bulkDeletePending, setBulkDeletePending] = useState(false);

  // 删除渠道确认对话框
  const [channelPendingDeletion, setChannelPendingDeletion] =
    useState<ImageGenChannelValue | null>(null);

  // 删除渠道内模型确认对话框（弹窗内二级确认，替代原生 window.confirm）
  const [modelPendingDeletion, setModelPendingDeletion] = useState<
    number | null
  >(null);

  // 顶部模板替换已有模型列表的确认（避免静默清空多模型配置）
  const [templatePendingApply, setTemplatePendingApply] = useState<
    string | null
  >(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const raw = await window.snow.getSystemSettingValue(
        IMAGE_GEN_SETTING_CODE,
      );
      const settings = readImageGenSettingsJson(raw);
      setChannels(settings.channels);
      setMaxConcurrent(settings.maxConcurrentImages);
      maxConcurrentRef.current = settings.maxConcurrentImages;
      setTimeoutSecs(settings.timeoutSecs);
      timeoutSecsRef.current = settings.timeoutSecs;
      setExecutionMode(settings.executionMode);
      executionModeRef.current = settings.executionMode;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.imagegenLoadError", {
              defaultValue: "Failed to load image generation settings",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 将渠道数组写入存储（即时保存，与 API 设置交互一致）。 */
  const persistChannels = async (
    next: ImageGenChannelValue[],
    successMessage?: string,
  ): Promise<boolean> => {
    setIsSaving(true);
    setError("");
    try {
      await window.snow.setSystemSetting(
        IMAGE_GEN_SETTING_NAME,
        IMAGE_GEN_SETTING_CODE,
        toImageGenSettingsJson({
          channels: next,
          maxConcurrentImages: maxConcurrentRef.current,
          timeoutSecs: timeoutSecsRef.current,
          executionMode: executionModeRef.current,
        }),
      );
      setChannels(next);
      if (successMessage) {
        setStatus(successMessage);
      }
      return true;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.imagegenSaveError", {
              defaultValue: "Failed to save image generation settings",
            }),
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  /** 更新最大并发生成数（收敛到允许范围后立即保存）。 */
  const updateMaxConcurrent = async (rawValue: number) => {
    if (isSaving) {
      return;
    }
    const { min, max } = IMAGE_GEN_MAX_CONCURRENT_RANGE;
    const next = Math.min(max, Math.max(min, Math.round(rawValue)));
    setMaxConcurrent(next);
    maxConcurrentRef.current = next;
    await persistChannels(channels);
  };

  /** 更新生图请求超时（秒，收敛到允许范围后立即保存）。 */
  const updateTimeoutSecs = async (rawValue: number) => {
    if (isSaving) {
      return;
    }
    const { min, max } = IMAGE_GEN_TIMEOUT_RANGE;
    const next = Math.min(max, Math.max(min, Math.round(rawValue)));
    setTimeoutSecs(next);
    timeoutSecsRef.current = next;
    await persistChannels(channels);
  };

  /** 更新生图执行模式（立即保存）。 */
  const updateExecutionMode = async (mode: ImageGenExecutionMode) => {
    if (isSaving) {
      return;
    }
    setExecutionMode(mode);
    executionModeRef.current = mode;
    await persistChannels(channels);
  };

  /** 渠道显示名（name 留空回退协议默认名）。 */
  const channelLabel = (channel: ImageGenChannelValue): string => {
    if (channel.name.trim()) {
      return channel.name.trim();
    }
    return defaultChannelName(channel.provider);
  };

  /** 协议默认名（名称留空时的回退）。 */
  const defaultChannelName = (provider: ImageGenProvider): string => {
    if (provider === "gemini") {
      return t("settings.imagegenChannelGemini", {
        defaultValue: "Google Gemini",
      });
    }
    if (provider === "novelai") {
      return t("settings.imagegenProviderNovelai", {
        defaultValue: "NovelAI",
      });
    }
    return t("settings.imagegenChannelOpenai", {
      defaultValue: "OpenAI",
    });
  };

  /** 渠道行内启用/禁用（立即保存）。未配置密钥或模型的渠道不允许启用：
   * 后端只在渠道同时具备 API key 与模型时才向 agent 暴露生图工具。
   * 「模型」判定需与后端 is_usable 一致：顶层 model 非空，或渠道内存在
   * 已启用且 model 非空的子模型（多模型渠道常见顶层 model 为空的情况）。 */
  const toggleEnabled = async (channel: ImageGenChannelValue) => {
    if (isSaving) {
      return;
    }
    const hasModel =
      channel.model.trim() !== "" ||
      (channel.models ?? []).some(
        (item) => item.enabled !== false && item.model.trim() !== "",
      );
    if (!channel.enabled && (!hasModel || !channel.apiKey.trim())) {
      setError(
        t("settings.imagegenToggleMissingModel", {
          defaultValue:
            "Configure an API key and a model for this channel before enabling it — the image generation tool only becomes available when a channel has both.",
        }),
      );
      return;
    }
    const next = channels.map((item) =>
      item.id === channel.id ? { ...item, enabled: !item.enabled } : item,
    );
    await persistChannels(next);
  };

  /** 打开添加弹窗（无内置默认模型：模型 ID 与参数全部留空，由用户或模板填入）。 */
  const openAddEditor = () => {
    setError("");
    setStatus("");
    const index = channels.length;
    // 空白模型项：仅作为「多模型列表」的容器占位，所有参数留空，
    // 保持与 DEFAULT_IMAGE_GEN_CHANNEL「无内置默认模型」一致的原则。
    const initialModelItem: ImageGenModelItem = {
      id: "model-1",
      model: "",
      name: "",
      defaultSize: "",
      defaultQuality: "",
      supportedRatios: "",
      supportedResolutions: "",
      supportedThinking: "",
      customPrompt: "",
      enabled: true,
    };
    setDraft({
      ...DEFAULT_IMAGE_GEN_CHANNEL,
      id: generateChannelId("openai", index),
      enabled: true,
      models: [initialModelItem],
    });
    setActiveModelIndex(0);
    setIsNewChannel(true);
    setShowApiKey(false);
    setDraftModels([]);
    setDraftModelsError(null);
    setEditorOpen(true);
  };

  /** 打开编辑弹窗（把渠道配置规范化为多模型列表，并校正主模型一致性）。 */
  const openEditEditor = (channel: ImageGenChannelValue) => {
    setError("");
    setStatus("");
    const modelsList: ImageGenModelItem[] =
      channel.models && channel.models.length > 0
        ? channel.models.map((m, idx) => ({
            ...m,
            id: m.id || `model-${idx + 1}`,
            enabled: m.enabled !== false,
          }))
        : [
            {
              // 旧单模型数据：用渠道顶层字段合成一条模型项（无硬编码默认模型）
              id: "model-1",
              model: channel.model || "",
              name: "",
              defaultSize: channel.defaultSize || "",
              defaultQuality: channel.defaultQuality || "",
              supportedRatios: channel.supportedRatios || "",
              supportedResolutions: channel.supportedResolutions || "",
              supportedThinking: channel.supportedThinking || "",
              supportedQualities: channel.supportedQualities || "",
              customPrompt: channel.customPrompt || "",
              enabled: true,
            },
          ];

    // 主模型一致性校正：channel.model 必须在 modelsList 中命中，否则回退首个
    // 有模型 ID 的项（历史脏数据 / 手工编辑存储导致的不一致），并把该模型的
    // 参数同步回顶层兼容字段，避免「主模型指向不存在的 ID」。
    // 统一走 resolvePrimaryIndex：即使存在多个同 ID 模型项，也只有第一个被
    // 视为主模型，保证「一个渠道只有一个默认主模型」。
    const targetIndex = resolvePrimaryIndex(modelsList, channel.model);
    const primaryItem = modelsList[targetIndex];
    const syncedDraft: ImageGenChannelValue = {
      ...channel,
      models: modelsList,
      model: primaryItem?.model ?? channel.model,
      defaultSize: primaryItem?.defaultSize ?? channel.defaultSize,
      defaultQuality: primaryItem?.defaultQuality ?? channel.defaultQuality,
      supportedRatios: primaryItem?.supportedRatios ?? channel.supportedRatios,
      supportedResolutions:
        primaryItem?.supportedResolutions ?? channel.supportedResolutions,
      supportedThinking:
        primaryItem?.supportedThinking ?? channel.supportedThinking,
      supportedQualities:
        primaryItem?.supportedQualities ?? channel.supportedQualities,
      customPrompt: primaryItem?.customPrompt ?? channel.customPrompt,
    };

    setDraft(syncedDraft);
    setActiveModelIndex(targetIndex);
    setIsNewChannel(false);
    setShowApiKey(false);
    setDraftModels([]);
    setDraftModelsError(null);
    setEditorOpen(true);
  };

  /** 关闭弹窗。 */
  const closeEditor = () => {
    if (draftSaving) {
      return;
    }
    setEditorOpen(false);
    setDraft(null);
  };

  /** 获取当前草稿的规范化多模型列表。 */
  const currentModelList = useMemo((): ImageGenModelItem[] => {
    if (!draft) return [];
    if (draft.models && draft.models.length > 0) {
      return draft.models;
    }
    return [
      {
        id: "default",
        model: draft.model,
        defaultSize: draft.defaultSize,
        defaultQuality: draft.defaultQuality,
        supportedRatios: draft.supportedRatios,
        supportedResolutions: draft.supportedResolutions,
        supportedThinking: draft.supportedThinking,
        customPrompt: draft.customPrompt,
        enabled: true,
      },
    ];
  }, [draft]);

  const safeModelIndex = Math.min(
    Math.max(0, activeModelIndex),
    Math.max(0, currentModelList.length - 1),
  );
  const activeModelItem: ImageGenModelItem = currentModelList[
    safeModelIndex
  ] ?? {
    id: "fallback",
    model: draft?.model ?? "",
    enabled: true,
  };

  /** 更新当前选中的模型配置，若该模型为主模型，则自动同步渠道顶层兼容属性。 */
  const updateActiveModelItem = (
    field: keyof ImageGenModelItem,
    value: unknown,
  ) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const list =
        prev.models && prev.models.length > 0
          ? [...prev.models]
          : [
              {
                id: "default",
                model: prev.model,
                defaultSize: prev.defaultSize,
                defaultQuality: prev.defaultQuality,
                supportedRatios: prev.supportedRatios,
                supportedResolutions: prev.supportedResolutions,
                supportedThinking: prev.supportedThinking,
                customPrompt: prev.customPrompt,
                enabled: true,
              },
            ];
      const idx = Math.min(
        Math.max(0, activeModelIndex),
        Math.max(0, list.length - 1),
      );
      const current = list[idx] ?? { id: `model-${idx}`, model: "" };
      // 必须在覆盖字段之前判定「是否主模型」：若在之后判定，编辑主模型的
      // model 字段时 updatedItem.model（新值）≠ prev.model（旧值），会导致
      // 主模型判定失败、顶层 model 停留在旧 ID（渠道主模型指向不存在的 ID）。
      // 统一走 resolvePrimaryIndex，保证多 tab 同 ID 时只有唯一主模型。
      const wasPrimary = idx === resolvePrimaryIndex(list, prev.model);
      let updatedItem: ImageGenModelItem = {
        ...current,
        [field]: value,
      };
      // 修改模型 ID 时按内置能力库自动填充能力字段（纯函数，用户手改过的
      // 值不会被覆盖，见 applyCapability 的「未定制」判定）。
      if (field === "model") {
        if (updatedItem.model !== current.model) {
          updatedItem.defaultComplexity = "";
          updatedItem.defaultOutputFormat = "";
        }
        updatedItem = applyCapability(updatedItem, current.model);
      }
      list[idx] = updatedItem;

      const nextDraft: ImageGenChannelValue = {
        ...prev,
        models: list,
      };

      // 主模型变更时，把该模型项的完整配置同步到渠道顶层兼容字段（旧版
      // 后端 / 旧版读取路径只认顶层字段，双写保证平滑兼容）。
      if (wasPrimary) {
        nextDraft.model = updatedItem.model ?? "";
        nextDraft.defaultSize = updatedItem.defaultSize ?? "";
        nextDraft.defaultQuality = updatedItem.defaultQuality ?? "";
        nextDraft.supportedRatios = updatedItem.supportedRatios ?? "";
        nextDraft.supportedResolutions = updatedItem.supportedResolutions ?? "";
        nextDraft.supportedThinking = updatedItem.supportedThinking ?? "";
        nextDraft.supportedQualities = updatedItem.supportedQualities ?? "";
        nextDraft.customPrompt = updatedItem.customPrompt ?? "";
      }

      return nextDraft;
    });
  };

  /**
   * 显式「按模型 ID 填充能力」：用内置能力库**无条件覆盖**当前模型的能力字段。
   *
   * 与改模型 ID 时的静默自动填充不同——用户点击按钮即视为明确要求套用能力库，
   * 因此不做 applyCapability 的「未定制」判定；命中能力库即覆盖 6 个能力字段
   * （并同步主模型的顶层兼容字段），未收录则提示、不改动任何字段。
   * 用单次 setDraft 完成，updater 内只做纯计算（StrictMode 下会被双调用）。
   */
  const fillCapabilityFromModel = () => {
    setError("");
    const capability = resolveModelCapability(activeModelItem.model);
    if (!capability) {
      setError(
        t("settings.imagegenCapabilityFillUnavailable", {
          defaultValue:
            "No built-in capability profile for model {model} — fill the fields manually.",
        }).replace("{model}", activeModelItem.model.trim() || "—"),
      );
      return;
    }
    // 能力库对「尺寸空间开放」的模型（gpt-image-2 / 2.5 系、Seedream、FLUX.2 等）
    // 故意留空 supported*：留空 = 未声明 = 后端不校验（放行任意合法尺寸），
    // 声明成白名单反而会误拦合法尺寸，因此提示语要说明「留空≠漏填」。
    const openSizeSpace =
      !capability.supportedRatios.trim() &&
      !capability.supportedResolutions.trim();
    setDraft((prev) => {
      if (!prev) return prev;
      const list =
        prev.models && prev.models.length > 0 ? [...prev.models] : [];
      const idx = Math.min(
        Math.max(0, activeModelIndex),
        Math.max(0, list.length - 1),
      );
      const current = list[idx];
      if (!current) return prev;
      const filled = forceApplyCapability(current);
      if (!filled) return prev;
      const wasPrimary = idx === resolvePrimaryIndex(list, prev.model);
      list[idx] = filled;
      const nextDraft: ImageGenChannelValue = { ...prev, models: list };
      // 与 updateActiveModelItem 一致：主模型变更时同步顶层兼容字段。
      if (wasPrimary) {
        nextDraft.model = filled.model ?? "";
        nextDraft.defaultSize = filled.defaultSize ?? "";
        nextDraft.defaultQuality = filled.defaultQuality ?? "";
        nextDraft.supportedRatios = filled.supportedRatios ?? "";
        nextDraft.supportedResolutions = filled.supportedResolutions ?? "";
        nextDraft.supportedThinking = filled.supportedThinking ?? "";
        nextDraft.supportedQualities = filled.supportedQualities ?? "";
      }
      return nextDraft;
    });
    // 结果提示：说明哪些字段因「尺寸空间开放」而故意留空（留空 = 后端不校验 = 放行）。
    setStatus(
      openSizeSpace
        ? t("settings.imagegenFillCapabilityOpenSpace", {
            defaultValue:
              "Filled from the built-in profile. This model has an open size space, so aspect ratios / resolutions stay empty (= no restriction, any valid size passes).",
          })
        : t("settings.imagegenFillCapabilityDone", {
            defaultValue: "Filled from the built-in profile for this model.",
          }),
    );
  };

  /** 将指定索引的模型设为默认主模型（一个渠道只有一个，切换即替换）。 */
  const setAsPrimaryModel = (index: number) => {
    setDraft((prev) => {
      if (!prev || !prev.models || !prev.models[index]) return prev;
      const target = prev.models[index];
      return {
        ...prev,
        model: target.model,
        defaultSize: target.defaultSize ?? prev.defaultSize,
        defaultQuality: target.defaultQuality ?? prev.defaultQuality,
        supportedRatios: target.supportedRatios ?? prev.supportedRatios,
        supportedResolutions:
          target.supportedResolutions ?? prev.supportedResolutions,
        supportedThinking: target.supportedThinking ?? prev.supportedThinking,
        supportedQualities:
          target.supportedQualities ?? prev.supportedQualities,
        customPrompt: target.customPrompt ?? prev.customPrompt,
      };
    });
  };

  /**
   * 提交模型 ID：同渠道内模型 ID 必须唯一。
   * 命中重复时拒绝写入（输入框会回退为原值）并提示，从源头杜绝
   * 「多个 tab 带同一默认主模型标记」。不切换 tab，避免打断输入。
   */
  const commitActiveModelId = (modelId: string) => {
    const target = modelId.trim();
    const duplicateIndex = currentModelList.findIndex(
      (item, idx) =>
        idx !== safeModelIndex &&
        target !== "" &&
        item.model.trim().toLowerCase() === target.toLowerCase(),
    );
    if (duplicateIndex >= 0) {
      setError(
        t("settings.imagegenModelDuplicateEdit", {
          defaultValue:
            "Model {model} already exists in this channel. Each model ID can only be configured once — edit the existing one instead.",
        }).replace("{model}", target),
      );
      return;
    }
    updateActiveModelItem("model", modelId);
  };

  /**
   * 查找已存在的同 ID 模型项索引（忽略大小写）。
   * 一个渠道内同一个模型 ID 只能配置一次——否则默认主模型标记无法唯一。
   */
  const findDuplicateModelIndex = (modelId: string): number => {
    const target = modelId.trim().toLowerCase();
    if (!target) return -1;
    return currentModelList.findIndex(
      (item) => item.model.trim().toLowerCase() === target,
    );
  };

  /** 从预设模板添加模型到当前渠道（同 ID 已存在时提示并跳到该 tab）。 */
  const addModelFromTemplate = (template: ImageGenTemplate) => {
    const duplicateIndex = findDuplicateModelIndex(template.model);
    if (duplicateIndex >= 0) {
      setActiveModelIndex(duplicateIndex);
      setError(
        t("settings.imagegenModelDuplicate", {
          defaultValue:
            "Model {model} is already configured in this channel — switched to it instead.",
        }).replace("{model}", template.model),
      );
      return;
    }
    setDraft((prev) => {
      if (!prev) return prev;
      const list = prev.models ? [...prev.models] : [];
      const newId = `model-${Date.now()}-${list.length + 1}`;
      const newItem: ImageGenModelItem = {
        id: newId,
        model: template.model,
        name: template.name.replace(/^[^ -]+ - /, ""),
        defaultSize: template.defaultSize ?? "",
        defaultQuality: template.defaultQuality ?? "",
        supportedRatios: template.supportedRatios ?? "",
        supportedResolutions: template.supportedResolutions ?? "",
        supportedThinking: template.supportedThinking ?? "",
        customPrompt: template.customPrompt ?? "",
        enabled: true,
      };
      list.push(newItem);
      return {
        ...prev,
        models: list,
      };
    });
    setActiveModelIndex(currentModelList.length);
  };

  /** 添加空白自定义模型（能力字段留空，选定模型 ID 后由能力库自动填充）。 */
  const addCustomModel = () => {
    setDraft((prev) => {
      if (!prev) return prev;
      const list = prev.models ? [...prev.models] : [];
      const newId = `model-${Date.now()}-${list.length + 1}`;
      const newItem: ImageGenModelItem = {
        id: newId,
        model: "",
        name: "",
        // 留空而非套用协议默认尺寸：避免「已有值」判定阻断后续能力库自动填充。
        defaultSize: "",
        defaultQuality: "",
        supportedRatios: "",
        supportedResolutions: "",
        supportedThinking: "",
        customPrompt: "",
        enabled: true,
      };
      list.push(newItem);
      return {
        ...prev,
        models: list,
      };
    });
    setActiveModelIndex(currentModelList.length);
  };

  /** 请求删除模型（弹出项目统一的确认对话框，替代原生 window.confirm）。 */
  const removeModelItem = (index: number) => {
    if (currentModelList.length <= 1) return;
    setModelPendingDeletion(index);
  };

  /** 确认删除模型（真正执行）。 */
  const confirmRemoveModelItem = (index: number) => {
    setModelPendingDeletion(null);
    setDraft((prev) => {
      if (!prev || !prev.models || prev.models.length <= 1) return prev;
      const list = prev.models.filter((_, i) => i !== index);
      // 删除的是主模型时，主模型顺延到剩余列表的首个（与 resolvePrimaryIndex
      // 的回退规则一致）；否则保持原主模型不变。
      const isDeletingPrimary =
        index === resolvePrimaryIndex(prev.models, prev.model);
      const nextPrimary = isDeletingPrimary
        ? (list[0]?.model ?? "")
        : prev.model;
      const nextPrimaryItem =
        list[resolvePrimaryIndex(list, nextPrimary)] ?? list[0];
      return {
        ...prev,
        model: nextPrimary,
        defaultSize: nextPrimaryItem?.defaultSize ?? prev.defaultSize,
        defaultQuality: nextPrimaryItem?.defaultQuality ?? prev.defaultQuality,
        supportedRatios:
          nextPrimaryItem?.supportedRatios ?? prev.supportedRatios,
        supportedResolutions:
          nextPrimaryItem?.supportedResolutions ?? prev.supportedResolutions,
        supportedThinking:
          nextPrimaryItem?.supportedThinking ?? prev.supportedThinking,
        customPrompt: nextPrimaryItem?.customPrompt ?? prev.customPrompt,
        models: list,
      };
    });
    setActiveModelIndex((curr) => {
      if (curr >= index && curr > 0) return curr - 1;
      return 0;
    });
  };

  /** 应用预设模板到草稿（会整体替换 models 列表）。 */
  const applyTemplate = (templateId: string) => {
    const tmpl = IMAGE_GEN_TEMPLATES.find((item) => item.id === templateId);
    if (!tmpl) return;
    const templateModelItem: ImageGenModelItem = {
      id: `model-${Date.now()}-1`,
      model: tmpl.model,
      name: tmpl.name.replace(/^[^ -]+ - /, ""),
      defaultSize: tmpl.defaultSize ?? "",
      defaultQuality: tmpl.defaultQuality ?? "",
      supportedRatios: tmpl.supportedRatios ?? "",
      supportedResolutions: tmpl.supportedResolutions ?? "",
      supportedThinking: tmpl.supportedThinking ?? "",
      customPrompt: tmpl.customPrompt ?? "",
      enabled: true,
    };
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        name: prev.name.trim()
          ? prev.name
          : tmpl.name.replace(/^[^ -]+ - /, ""),
        provider: tmpl.provider,
        baseUrl: tmpl.baseUrl ?? prev.baseUrl,
        model: tmpl.model,
        defaultSize: tmpl.defaultSize ?? prev.defaultSize,
        defaultQuality: tmpl.defaultQuality ?? "",
        supportedRatios: tmpl.supportedRatios ?? "",
        supportedResolutions: tmpl.supportedResolutions ?? "",
        supportedThinking: tmpl.supportedThinking ?? "",
        customPrompt: tmpl.customPrompt ?? "",
        outputFormat: tmpl.outputFormat ?? "",
        webSearch: tmpl.webSearch ?? false,
        defaultStream: tmpl.defaultStream ?? prev.defaultStream,
        models: [templateModelItem],
      };
    });
    setActiveModelIndex(0);
  };

  /** 顶部模板选择：已有已配置模型时先二次确认，避免静默清空多模型配置。 */
  const requestApplyTemplate = (templateId: string) => {
    if (!templateId) return;
    const configuredCount = currentModelList.filter(
      (item) => item.model.trim() !== "",
    ).length;
    if (configuredCount > 1) {
      setTemplatePendingApply(templateId);
      return;
    }
    applyTemplate(templateId);
  };

  /**
   * 模型联动：切换模型后，若当前尺寸/质量不在该模型支持列表内，自动
   * 回退到该模型支持的第一个预设（尺寸）或 Auto（质量）。Gemini 覆盖
   * 512px/1K/2K/4K 档位（如 Pro 无 512px、Lite 仅 1K）；OpenAI 覆盖
   * dall-e/gpt-image 各自的标准尺寸与质量集。
   */
  useEffect(() => {
    setDraft((previous) => {
      if (!previous) {
        return previous;
      }
      if (previous.provider === "gemini") {
        const parsed = matchGeminiSizePreset(previous.defaultSize);
        const supportedSizes = getGeminiSizePresets(previous.model);
        return {
          ...previous,
          defaultSize: parsed.imageSize
            ? buildGeminiSize(parsed.ratio, supportedSizes[0] ?? "")
            : previous.defaultSize,
          defaultQuality: ["", "low", "medium", "high"].includes(
            previous.defaultQuality,
          )
            ? previous.defaultQuality
            : "",
        };
      }
      const caps = openaiStandardCaps(previous.model);
      const isArbitrary = supportsArbitraryOpenAISize(previous.model);
      const currentSize = previous.defaultSize.trim();
      return {
        ...previous,
        defaultSize: isArbitrary
          ? previous.defaultSize
          : caps.sizes.includes(currentSize)
            ? previous.defaultSize
            : (caps.sizes[0] ?? ""),
        defaultQuality:
          caps.quality.includes(previous.defaultQuality) ||
          previous.defaultQuality === ""
            ? previous.defaultQuality
            : "",
      };
    });
  }, [draft?.model, draft?.provider]);

  /** 保存弹窗草稿（添加或编辑）。 */
  const saveDraft = async () => {
    if (!draft) {
      return;
    }
    setDraftSaving(true);
    setError("");
    setStatus("");

    const cleanedModels: ImageGenModelItem[] = (draft.models ?? [])
      .map((m) => ({
        ...m,
        id: m.id || m.model.trim(),
        model: m.model.trim(),
        name: (m.name ?? "").trim(),
        defaultSize: (m.defaultSize ?? "").trim(),
        defaultQuality: (m.defaultQuality ?? "").trim(),
        supportedRatios: (m.supportedRatios ?? "").trim(),
        supportedResolutions: (m.supportedResolutions ?? "").trim(),
        supportedThinking: (m.supportedThinking ?? "").trim(),
        customPrompt: (m.customPrompt ?? "").trim(),
        enabled: m.enabled !== false,
      }))
      .filter((m) => m.model.length > 0)
      // 兜底去重：同一个模型 ID 只保留首个，保证默认主模型标记唯一
      // （面板已在添加/失焦两处拦截，这里防止历史脏数据再次写回存储）。
      .filter(
        (m, index, all) =>
          all.findIndex(
            (other) => other.model.toLowerCase() === m.model.toLowerCase(),
          ) === index,
      );

    let primaryModel = draft.model.trim();
    if (!primaryModel && cleanedModels.length > 0) {
      primaryModel = cleanedModels[0].model;
    }

    const primaryItem =
      cleanedModels.find((m) => m.model === primaryModel) ?? cleanedModels[0];

    const saved: ImageGenChannelValue = {
      ...draft,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      model: primaryModel,
      defaultSize: primaryItem?.defaultSize ?? draft.defaultSize.trim(),
      defaultQuality:
        primaryItem?.defaultQuality ?? draft.defaultQuality.trim(),
      supportedRatios:
        primaryItem?.supportedRatios ?? (draft.supportedRatios ?? "").trim(),
      supportedResolutions:
        primaryItem?.supportedResolutions ??
        (draft.supportedResolutions ?? "").trim(),
      supportedThinking:
        primaryItem?.supportedThinking ??
        (draft.supportedThinking ?? "").trim(),
      supportedQualities:
        primaryItem?.supportedQualities ??
        (draft.supportedQualities ?? "").trim(),
      customPrompt:
        primaryItem?.customPrompt ?? (draft.customPrompt ?? "").trim(),
      outputFormat: draft.outputFormat.trim(),
      models: cleanedModels.length > 0 ? cleanedModels : undefined,
    };

    const next = isNewChannel
      ? [...channels, saved]
      : channels.map((item) => (item.id === saved.id ? saved : item));

    const ok = await persistChannels(
      next,
      isNewChannel
        ? t("settings.imagegenAddChannelSuccess", {
            defaultValue: "Channel {name} added.",
          }).replace("{name}", channelLabel(saved))
        : t("settings.imagegenEditChannelSuccess", {
            defaultValue: "Channel {name} updated.",
          }).replace("{name}", channelLabel(saved)),
    );
    setDraftSaving(false);
    if (ok) {
      setEditorOpen(false);
      setDraft(null);
    }
  };

  /** 请求删除渠道（弹出确认对话框）。 */
  const requestRemoveChannel = (channel: ImageGenChannelValue) => {
    setChannelPendingDeletion(channel);
  };

  /** 确认删除渠道（立即保存）。 */
  const confirmRemoveChannel = async () => {
    const channel = channelPendingDeletion;
    if (!channel) {
      return;
    }
    setChannelPendingDeletion(null);
    const label = channelLabel(channel);
    const next = channels.filter((item) => item.id !== channel.id);
    await persistChannels(
      next,
      t("settings.imagegenDeleteChannelSuccess", {
        defaultValue: "Channel {name} deleted.",
      }).replace("{name}", label),
    );
  };

  /** 复制渠道（生成 *-Copy-n 唯一名称与新 id，默认未启用）。 */
  const duplicateChannel = async (channel: ImageGenChannelValue) => {
    if (isSaving) {
      return;
    }
    // 命名规则：*-Copy-n（n 为递增数字，避免与既有渠道名冲突）。
    const sourceName =
      channel.name.trim() || defaultChannelName(channel.provider);
    const nextName = buildDuplicateName(
      sourceName,
      channels.map((item) => item.name),
    );
    const cloned: ImageGenChannelValue = {
      ...channel,
      id: generateChannelId(channel.provider, channels.length),
      name: nextName,
      // 复制后默认未启用，避免多个渠道同时启用造成混淆。
      enabled: false,
    };
    const next = [...channels, cloned];
    await persistChannels(
      next,
      t("settings.imagegenDuplicateChannelSuccess", {
        defaultValue: "Channel {name} duplicated.",
      }).replace("{name}", channelLabel(cloned)),
    );
  };

  /** 弹窗内草稿字段更新。 */
  const updateDraft = <K extends keyof ImageGenChannelValue>(
    field: K,
    value: ImageGenChannelValue[K],
  ) => {
    setDraft((previous) =>
      previous ? { ...previous, [field]: value } : previous,
    );
  };

  const updateDraftEvent =
    (field: keyof ImageGenChannelValue) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value =
        event.target instanceof HTMLInputElement &&
        event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value;
      updateDraft(field, value as never);
    };

  /** 弹窗内加载模型列表。 */
  const requestDraftModels = async () => {
    if (!draft || draftModelsLoading) {
      return;
    }
    setDraftModelsLoading(true);
    setDraftModelsError(null);
    const isGemini = draft.provider === "gemini";
    const isNovelai = draft.provider === "novelai";
    const defaultBaseUrl = isGemini
      ? DEFAULT_GEMINI_BASE_URL
      : isNovelai
        ? DEFAULT_NOVELAI_BASE_URL
        : DEFAULT_OPENAI_BASE_URL;

    try {
      const allModels = await window.snow.fetchAvailableModelsForConfig({
        baseUrl: draft.baseUrl.trim() || defaultBaseUrl,
        baseUrlMode: "custom",
        apiKey: draft.apiKey.trim(),
        requestMethod: isGemini ? "gemini" : "openai",
        customHeaderSchemeId: "",
      });
      setDraftModels(filterImageModels(allModels, draft.provider));
    } catch (e) {
      setDraftModelsError(e instanceof Error ? e.message : String(e));
    } finally {
      setDraftModelsLoading(false);
    }
  };

  const filteredChannels = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return channels;
    }
    return channels.filter((channel) => {
      const haystack = [
        channel.name,
        channel.baseUrl,
        channel.model,
        channel.provider,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [channels, searchQuery]);

  const enabledCount = channels.filter((channel) => channel.enabled).length;
  const isBusy = isLoading || isSaving;

  const selectedChannelIdSet = useMemo(
    () => new Set(selectedChannelIds),
    [selectedChannelIds],
  );
  const selectedChannelCount = selectedChannelIds.length;
  const isAllFilteredSelected =
    filteredChannels.length > 0 &&
    filteredChannels.every((channel) => selectedChannelIdSet.has(channel.id));
  const isPartiallySelected =
    !isAllFilteredSelected &&
    filteredChannels.some((channel) => selectedChannelIdSet.has(channel.id));

  // 列表变化（删除、导入、保存）后丢弃已不存在的选中项。
  useEffect(() => {
    setSelectedChannelIds((previous) => {
      const available = new Set(channels.map((channel) => channel.id));
      const next = previous.filter((id) => available.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [channels]);

  const toggleChannelSelection = (channelId: string) => {
    setSelectedChannelIds((previous) =>
      previous.includes(channelId)
        ? previous.filter((id) => id !== channelId)
        : [...previous, channelId],
    );
  };

  const toggleSelectAll = () => {
    const filteredIds = filteredChannels.map((channel) => channel.id);
    setSelectedChannelIds((previous) => {
      const everySelected =
        filteredIds.length > 0 &&
        filteredIds.every((id) => previous.includes(id));
      return everySelected
        ? previous.filter((id) => !filteredIds.includes(id))
        : Array.from(new Set([...previous, ...filteredIds]));
    });
  };

  /** 按渠道 id 顺序重排并立即保存（顺序即设置文件中的渠道顺序）。 */
  const reorderChannels = async (orderedIds: string[]): Promise<void> => {
    const remaining = new Map(channels.map((channel) => [channel.id, channel]));
    const next: ImageGenChannelValue[] = [];
    for (const id of orderedIds) {
      const channel = remaining.get(id);
      if (channel) {
        next.push(channel);
        remaining.delete(id);
      }
    }
    for (const channel of channels) {
      if (remaining.has(channel.id)) {
        next.push(channel);
      }
    }
    await persistChannels(next);
  };

  const reorder = useApiConfigReorder({
    allNames: channels.map((channel) => channel.id),
    visibleNames: filteredChannels.map((channel) => channel.id),
    onReorder: (orderedIds) => void reorderChannels(orderedIds),
  });

  /** 批量删除已选渠道（一次确认、一次保存）。 */
  const confirmRemoveSelected = async (): Promise<void> => {
    setBulkDeletePending(false);
    const next = channels.filter(
      (channel) => !selectedChannelIdSet.has(channel.id),
    );
    const count = channels.length - next.length;
    await persistChannels(
      next,
      t("settings.imagegenDeleteSelectedSuccess", {
        defaultValue: "Deleted {count} channels.",
      }).replace("{count}", String(count)),
    );
    setSelectedChannelIds([]);
  };

  const renderDraftPanel = (): React.JSX.Element => {
    if (!draft) {
      return <></>;
    }
    const isGemini = draft.provider === "gemini";
    const isNovelai = draft.provider === "novelai";
    const defaultBaseUrl = isGemini
      ? DEFAULT_GEMINI_BASE_URL
      : isNovelai
        ? DEFAULT_NOVELAI_BASE_URL
        : DEFAULT_OPENAI_BASE_URL;
    const modelPlaceholder = isGemini
      ? GEMINI_MODEL_EXAMPLES
      : isNovelai
        ? NOVELAI_MODEL_EXAMPLES
        : OPENAI_MODEL_EXAMPLES;
    const currentModelId = activeModelItem.model;
    // 尺寸/思考等参数控件沿用原判定：渠道协议为 Gemini，或模型 ID 属于
    // Gemini 生图家族（兼容「OpenAI 兼容中转跑 Gemini 模型」的场景）。
    const isGeminiModel = isGemini || isGeminiFamilyModel(currentModelId);
    const activeCaps = getModelCapabilities(currentModelId);
    const capability = resolveModelCapability(currentModelId);
    // 联网搜索仅 Gemini **原生协议**（google_search grounding）支持：必须
    // 渠道协议为 Gemini，且当前模型属于 Gemini 生图家族，且能力库确认支持。
    const supportsWebSearch =
      isGemini &&
      isGeminiFamilyModel(currentModelId) &&
      capability?.webSearch !== false;
    // 默认主模型唯一：索引与「主模型解析」结果一致才算主模型，多 tab 同 ID
    // 时只有唯一一个 tab 会被标记。
    const isPrimaryActive =
      safeModelIndex === resolvePrimaryIndex(currentModelList, draft.model);

    return (
      <div className="api-settings-form-body">
        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.formBasic", { defaultValue: "Basic" })}
          </strong>
          <div className="api-settings-form-grid">
            <label className="api-settings-field imagegen-field-wide">
              <span className="api-settings-field-label">
                <Sparkles
                  size={13}
                  style={{
                    display: "inline-block",
                    marginRight: 4,
                    verticalAlign: -1,
                  }}
                />
                {t("settings.imagegenTemplate", {
                  defaultValue: "Preset template",
                })}
              </span>
              <CustomSelect
                value=""
                options={[
                  {
                    value: "",
                    label: t("settings.imagegenTemplateSelect", {
                      defaultValue:
                        "Select a template to auto-fill settings...",
                    }),
                  },
                  ...IMAGE_GEN_TEMPLATES.map((tmpl) => ({
                    value: tmpl.id,
                    label: tmpl.name,
                    description: tmpl.description,
                  })),
                ]}
                onChange={(templateId) => requestApplyTemplate(templateId)}
                disabled={draftSaving}
                portal
              />
            </label>

            <label className="api-settings-field imagegen-field-wide">
              <span className="api-settings-field-label">
                {t("settings.imagegenChannelName", {
                  defaultValue: "Channel name",
                })}
              </span>
              <input
                type="text"
                value={draft.name}
                onChange={updateDraftEvent("name")}
                placeholder={defaultChannelName(draft.provider)}
                disabled={draftSaving}
                spellCheck={false}
                autoFocus
              />
              <small className="api-settings-field-hint">
                {t("settings.imagegenChannelNameHint", {
                  defaultValue:
                    "Custom name shown in the list and used by the agent (leave empty to use the default).",
                })}
              </small>
            </label>

            <label className="api-settings-field">
              <span className="api-settings-field-label">
                {t("settings.imagegenProvider", { defaultValue: "Provider" })}
              </span>
              <CustomSelect
                value={draft.provider}
                options={[
                  {
                    value: "openai",
                    label: t("settings.imagegenProviderOpenai", {
                      defaultValue: "OpenAI",
                    }),
                  },
                  {
                    value: "gemini",
                    label: t("settings.imagegenProviderGemini", {
                      defaultValue: "Google Gemini",
                    }),
                  },
                  {
                    value: "novelai",
                    label: t("settings.imagegenProviderNovelai", {
                      defaultValue: "NovelAI",
                    }),
                  },
                ]}
                onChange={(provider) => {
                  updateDraft("provider", provider as ImageGenProvider);
                  // 切换服务商时清空对目标不适用且已条件隐藏的字段，
                  // 避免残留值在隐藏状态下继续生效而用户无法管理：
                  // Gemini / NovelAI 不使用 defaultQuality/outputFormat；
                  // OpenAI 不使用 webSearch。
                  if (provider === "gemini" || provider === "novelai") {
                    updateDraft("defaultQuality", "");
                    updateDraft("outputFormat", "");
                  } else {
                    updateDraft("webSearch", false);
                  }
                }}
                disabled={draftSaving}
                portal
              />
            </label>

            <label className="api-settings-field">
              <span className="api-settings-field-label">
                {t("settings.imagegenEnabled", { defaultValue: "Enabled" })}
              </span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={updateDraftEvent("enabled")}
                  disabled={draftSaving}
                />
                <span className="toggle-slider" />
              </label>
            </label>
          </div>
        </div>

        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.imagegenConnection", {
              defaultValue: "Provider connection",
            })}
          </strong>
          <div className="api-settings-form-grid">
            <label className="api-settings-field">
              <span className="api-settings-field-label">
                {t("settings.imagegenBaseUrl", {
                  defaultValue: "Base URL",
                })}
              </span>
              <input
                type="text"
                value={draft.baseUrl}
                onChange={updateDraftEvent("baseUrl")}
                placeholder={defaultBaseUrl}
                disabled={draftSaving}
                spellCheck={false}
              />
              <small className="api-settings-field-hint">
                {t("settings.imagegenBaseUrlHint", {
                  defaultValue: "Leave empty to use the provider default",
                })}
              </small>
            </label>

            <label className="api-settings-field">
              <span className="api-settings-field-label">
                {t("settings.imagegenApiKey", { defaultValue: "API key" })}
              </span>
              <div className="api-settings-password-wrap">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={updateDraftEvent("apiKey")}
                  placeholder="sk-..."
                  disabled={draftSaving}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="api-settings-password-toggle"
                  onClick={() => setShowApiKey((value) => !value)}
                  tabIndex={-1}
                >
                  {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </label>
          </div>
        </div>

        {/* 多模型配置区块（支持单渠道配置多个绘图模型及各自独立参数） */}
        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.imagegenMultiModelsGroup", {
              defaultValue: "Image models (multi-model channel)",
            })}
          </strong>
          <small
            className="api-settings-field-hint"
            style={{ marginBottom: 6 }}
          >
            {t("settings.imagegenMultiModelsHint", {
              defaultValue:
                "A channel connection can include multiple image models. Each model independently configures size, quality, thinking effort, and custom prompt.",
            })}
          </small>

          <div className="imagegen-models-manager">
            {/* 多模型 Tab 栏与添加入口 */}
            <div className="imagegen-models-tabs-bar">
              <div className="imagegen-models-tabs-list" role="tablist">
                {currentModelList.map((item, idx) => {
                  const isTabActive = idx === safeModelIndex;
                  // 默认主模型标记唯一：与 resolvePrimaryIndex 结果一致才标记。
                  const isPrimary =
                    idx === resolvePrimaryIndex(currentModelList, draft.model);
                  const tabLabel =
                    item.name?.trim() ||
                    item.model?.trim() ||
                    `模型 #${idx + 1}`;
                  return (
                    <div
                      key={item.id || `m-${idx}`}
                      className={`imagegen-model-tab${
                        isTabActive ? " active" : ""
                      }${item.enabled === false ? " disabled" : ""}`}
                      onClick={() => setActiveModelIndex(idx)}
                      role="tab"
                      aria-selected={isTabActive}
                      title={
                        item.model ? `${tabLabel} (${item.model})` : tabLabel
                      }
                    >
                      {item.model ? (
                        <ModelBrandIcon
                          model={item.model}
                          size={13}
                          className="imagegen-model-tab-icon"
                        />
                      ) : null}
                      {isPrimary ? (
                        <span
                          className="imagegen-model-tab-star"
                          title={t("settings.imagegenPrimaryBadge", {
                            defaultValue: "Primary default model",
                          })}
                        >
                          <BadgeCheck size={12} strokeWidth={2} />
                        </span>
                      ) : null}
                      <span>{tabLabel}</span>
                      {currentModelList.length > 1 ? (
                        <button
                          type="button"
                          className="imagegen-model-tab-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeModelItem(idx);
                          }}
                          title={t("settings.imagegenDeleteModel", {
                            defaultValue: "Delete model",
                          })}
                          aria-label={t("settings.imagegenDeleteModel", {
                            defaultValue: "Delete model",
                          })}
                        >
                          <X size={11} />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <CustomSelect
                  value=""
                  options={[
                    {
                      value: "",
                      label: `+ ${t("settings.imagegenAddModel", {
                        defaultValue: "Add model",
                      })}`,
                    },
                    {
                      value: "__custom__",
                      label: t("settings.imagegenAddCustomModel", {
                        defaultValue: "Add custom blank model",
                      }),
                    },
                    ...IMAGE_GEN_TEMPLATES.filter(
                      (tmpl) => tmpl.provider === draft.provider,
                    ).map((tmpl) => ({
                      value: tmpl.id,
                      label: tmpl.name,
                      description: tmpl.model,
                    })),
                  ]}
                  onChange={(val) => {
                    if (!val) return;
                    if (val === "__custom__") {
                      addCustomModel();
                    } else {
                      const tmpl = IMAGE_GEN_TEMPLATES.find(
                        (t) => t.id === val,
                      );
                      if (tmpl) addModelFromTemplate(tmpl);
                    }
                  }}
                  disabled={draftSaving}
                  portal
                  dropdownMinWidth={300}
                />
              </div>
            </div>

            {/* 当前活跃模型控制条 */}
            <div className="imagegen-model-actions-bar">
              <div className="imagegen-model-actions-title">
                <span style={{ color: "var(--text-muted)" }}>
                  {t("settings.imagegenActiveModelConfig", {
                    defaultValue: "Configuring:",
                  })}
                </span>
                <strong title={activeModelItem.model || undefined}>
                  {activeModelItem.name?.trim() ||
                    activeModelItem.model?.trim() ||
                    "新模型"}
                </strong>
                {isPrimaryActive ? (
                  <span
                    className="imagegen-model-primary-tag"
                    title={t("settings.imagegenPrimaryHint", {
                      defaultValue:
                        "Default model called when AI does not specify a specific model",
                    })}
                  >
                    <BadgeCheck size={13} strokeWidth={2} />
                    {t("settings.imagegenPrimaryBadge", {
                      defaultValue: "Default primary model",
                    })}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="api-settings-form-btn secondary"
                    style={{
                      fontSize: 11,
                      padding: "1px 7px",
                      height: "auto",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                    onClick={() => setAsPrimaryModel(safeModelIndex)}
                    disabled={draftSaving}
                    title={t("settings.imagegenPrimaryHint", {
                      defaultValue:
                        "Set this model as default primary when AI does not specify a model",
                    })}
                  >
                    <BadgeCheck size={12} strokeWidth={2} />
                    {t("settings.imagegenSetAsPrimary", {
                      defaultValue: "Set as default primary model",
                    })}
                  </button>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    cursor: "pointer",
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={activeModelItem.enabled !== false}
                    onChange={(e) =>
                      updateActiveModelItem("enabled", e.target.checked)
                    }
                    disabled={draftSaving}
                  />
                  {t("settings.imagegenModelEnabled", {
                    defaultValue: "Enable this model",
                  })}
                </label>
                {currentModelList.length > 1 ? (
                  <button
                    type="button"
                    className="icon-btn ghost danger"
                    style={{ width: 22, height: 22, padding: 0 }}
                    onClick={() => removeModelItem(safeModelIndex)}
                    disabled={draftSaving}
                    title={t("settings.imagegenDeleteModel", {
                      defaultValue: "Delete model",
                    })}
                  >
                    <Trash2 size={12} />
                  </button>
                ) : null}
              </div>
            </div>

            {/* 当前活跃模型的详细配置表单 */}
            <div className="api-settings-form-grid">
              {/* 模型标识 ID：标签行由 ApiModelCombobox 统一渲染，
                    右侧内联「按模型 ID 填充能力」，避免标签重复导致与右列错位 */}
              <div className="api-settings-field">
                <ApiModelCombobox
                  label={t("settings.imagegenModel", {
                    defaultValue: "Model ID",
                  })}
                  labelAction={
                    capability ? (
                      <button
                        type="button"
                        className="api-settings-form-btn secondary"
                        style={{
                          fontSize: 11,
                          padding: "1px 7px",
                          height: "auto",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                        onClick={(event) => {
                          // 按钮位于 ApiModelCombobox 的 <label> 内：阻止标签
                          // 默认行为把点击转发给输入框（会误触发下拉列表）
                          event.preventDefault();
                          fillCapabilityFromModel();
                        }}
                        disabled={draftSaving}
                        title={t("settings.imagegenFillCapabilityHint", {
                          defaultValue:
                            "Overwrite default size / quality / thinking and supported ranges with the built-in capability profile for this model ID",
                        })}
                      >
                        <Wand2 size={11} style={{ marginRight: 4 }} />
                        {t("settings.imagegenFillCapability", {
                          defaultValue: "Fill from model ID",
                        })}
                      </button>
                    ) : null
                  }
                  value={activeModelItem.model}
                  placeholder={modelPlaceholder}
                  disabled={draftSaving}
                  models={draftModels}
                  isLoading={draftModelsLoading}
                  error={draftModelsError}
                  hasLoaded={
                    draftModels.length > 0 || Boolean(draftModelsError)
                  }
                  loadingText={t("settings.imagegenModelsLoading", {
                    defaultValue: "Loading image models...",
                  })}
                  noModelsText={t("settings.imagegenModelsEmpty", {
                    defaultValue:
                      "No image models found. Check base URL / API key, or enter model ID manually.",
                  })}
                  retryText={t("settings.imagegenModelsRetry", {
                    defaultValue: "Retry",
                  })}
                  onChange={(modelId) => commitActiveModelId(modelId)}
                  onRequestModels={() => void requestDraftModels()}
                  onRetry={() => void requestDraftModels()}
                  knownModels={KNOWN_IMAGE_MODELS.filter(
                    (entry) => entry.provider === draft.provider,
                  )}
                  previewBadgeText={t("settings.imagegenModelPreviewBadge", {
                    defaultValue: "Preview",
                  })}
                  deprecatedBadgeText={t("settings.imagegenCap.capDeprecated", {
                    defaultValue: "Deprecated",
                  })}
                />
                {activeCaps.length > 0 ? (
                  <span className="imagegen-model-caps">
                    {activeCaps.map((cap) => (
                      <span className="imagegen-model-cap" key={cap}>
                        {t(`settings.imagegenCap.${cap}`)}
                      </span>
                    ))}
                  </span>
                ) : null}
              </div>

              {/* 模型显示别名 */}
              <label className="api-settings-field">
                <span className="api-settings-field-label">
                  {t("settings.imagegenModelAlias", {
                    defaultValue: "Model display alias",
                  })}
                </span>
                <input
                  type="text"
                  value={activeModelItem.name ?? ""}
                  onChange={(e) =>
                    updateActiveModelItem("name", e.target.value)
                  }
                  placeholder={t("settings.imagegenModelAliasPlaceholder", {
                    defaultValue: "e.g. Ultra / Fast (optional)",
                  })}
                  disabled={draftSaving}
                  spellCheck={false}
                />
                <small className="api-settings-field-hint">
                  {t("settings.imagegenModelAliasHint", {
                    defaultValue:
                      "Custom label shown on tabs for easier identification (shows model ID if empty)",
                  })}
                </small>
              </label>

              {/* 默认尺寸 */}
              <label className="api-settings-field imagegen-field-wide">
                <span className="api-settings-field-label">
                  {t("settings.imagegenDefaultSize", {
                    defaultValue: "Default size",
                  })}
                </span>
                {isGeminiModel ? (
                  <GeminiSizeControls
                    model={currentModelId}
                    defaultSize={activeModelItem.defaultSize ?? ""}
                    onUpdateSize={(size) =>
                      updateActiveModelItem("defaultSize", size)
                    }
                    disabled={draftSaving}
                    t={t}
                  />
                ) : supportsArbitraryOpenAISize(currentModelId) ? (
                  <GptImage2SizeControls
                    model={currentModelId}
                    defaultSize={activeModelItem.defaultSize ?? ""}
                    onUpdateSize={(size) =>
                      updateActiveModelItem("defaultSize", size)
                    }
                    disabled={draftSaving}
                    t={t}
                  />
                ) : (
                  <div className="imagegen-editor-size-row">
                    <input
                      className="imagegen-size-input"
                      type="text"
                      value={activeModelItem.defaultSize ?? ""}
                      onChange={(e) =>
                        updateActiveModelItem("defaultSize", e.target.value)
                      }
                      placeholder="1024x1024"
                      disabled={draftSaving}
                      spellCheck={false}
                    />
                    <CustomSelect
                      value={
                        openaiStandardCaps(currentModelId).sizes.includes(
                          (activeModelItem.defaultSize ?? "").trim(),
                        )
                          ? (activeModelItem.defaultSize ?? "").trim()
                          : ""
                      }
                      options={[
                        {
                          value: "",
                          label: t("settings.imagegenSizePreset", {
                            defaultValue: "Preset",
                          }),
                        },
                        ...sizePresetOptions(
                          openaiStandardCaps(currentModelId).sizes,
                        ),
                      ]}
                      onChange={(preset) => {
                        if (preset) {
                          updateActiveModelItem("defaultSize", preset);
                        }
                      }}
                      disabled={draftSaving}
                      portal
                    />
                  </div>
                )}
                {!isGeminiModel &&
                supportsArbitraryOpenAISize(currentModelId) ? (
                  <small className="imagegen-model-size-hint">
                    {t("settings.imagegenSizeLimitsHint", {
                      defaultValue:
                        "Rules: max side ≤3840px AND total pixels 655,360–8,294,400 (multiples of 16, aspect ≤3:1). Largest square is 2880x2880; 16:9 tops at 3840x2160; the 4K tier is the recommended size closest to the pixel cap for each ratio.",
                    })}
                  </small>
                ) : null}
                <small className="api-settings-field-hint">
                  {t("settings.imagegenDefaultSizeHint", {
                    defaultValue:
                      "Gemini: image size (1K/2K/4K) or aspect ratio (16:9). OpenAI: e.g. 1024x1024",
                  })}
                </small>
              </label>

              {/* 默认质量（仅 OpenAI） */}
              {!isGemini ? (
                <label className="api-settings-field">
                  <span className="api-settings-field-label">
                    {t("settings.imagegenDefaultQuality", {
                      defaultValue: "Default quality",
                    })}
                  </span>
                  <CustomSelect
                    value={activeModelItem.defaultQuality ?? ""}
                    options={(activeModelItem.supportedQualities?.trim()
                      ? [
                          "",
                          ...activeModelItem.supportedQualities
                            .split(/[,\s;/]+/)
                            .filter(Boolean),
                        ]
                      : openaiStandardCaps(currentModelId).quality
                    ).map((value) => {
                      const labelMap: Record<string, string> = {
                        "": t("settings.imagegenQualityAuto", {
                          defaultValue: "Auto",
                        }),
                        low: t("rightPanel.aiDrawing.qualityLow", {
                          defaultValue: "Low",
                        }),
                        medium: t("rightPanel.aiDrawing.qualityMedium", {
                          defaultValue: "Medium",
                        }),
                        high: t("rightPanel.aiDrawing.qualityHigh", {
                          defaultValue: "High",
                        }),
                        xhigh: t("rightPanel.aiDrawing.qualityXhigh", {
                          defaultValue: "Ultra High",
                        }),
                        max: t("rightPanel.aiDrawing.qualityMax", {
                          defaultValue: "Max",
                        }),
                        standard: t("rightPanel.aiDrawing.qualityStandard", {
                          defaultValue: "Standard",
                        }),
                        hd: t("rightPanel.aiDrawing.qualityHd", {
                          defaultValue: "HD",
                        }),
                      };
                      return {
                        value,
                        label: labelMap[value.toLowerCase()] ?? value,
                      };
                    })}
                    onChange={(value) =>
                      updateActiveModelItem("defaultQuality", value)
                    }
                    disabled={draftSaving}
                    portal
                  />
                </label>
              ) : null}

              {draft.provider === "openai" &&
              currentModelId.toLowerCase().includes("gpt-image-2.6") ? (
                <>
                  <label className="api-settings-field">
                    <span className="api-settings-field-label">
                      {t("settings.imagegenDefaultComplexity")}
                    </span>
                    <CustomSelect
                      value={activeModelItem.defaultComplexity ?? ""}
                      options={[
                        {
                          value: "",
                          label: t("settings.imagegenComplexityAuto"),
                        },
                        {
                          value: "low",
                          label: t("rightPanel.aiDrawing.qualityLow"),
                        },
                        {
                          value: "medium",
                          label: t("rightPanel.aiDrawing.qualityMedium"),
                        },
                        {
                          value: "high",
                          label: t("rightPanel.aiDrawing.qualityHigh"),
                        },
                      ]}
                      onChange={(value) =>
                        updateActiveModelItem("defaultComplexity", value)
                      }
                      disabled={draftSaving}
                      portal
                    />
                  </label>
                  <label className="api-settings-field">
                    <span className="api-settings-field-label">
                      {t("settings.imagegenModelOutputFormat")}
                    </span>
                    <CustomSelect
                      value={activeModelItem.defaultOutputFormat ?? ""}
                      options={[
                        {
                          value: "",
                          label: t("settings.imagegenModelOutputChannel"),
                        },
                        ...["png", "jpeg", "webp", "svg", "gif"].map(
                          (value) => ({ value, label: value }),
                        ),
                      ]}
                      onChange={(value) =>
                        updateActiveModelItem("defaultOutputFormat", value)
                      }
                      disabled={draftSaving}
                      portal
                    />
                    <small className="api-settings-field-hint">
                      {t("settings.imagegenVectorAnimationHint")}
                    </small>
                  </label>
                </>
              ) : null}

              {/* 支持宽高比 */}
              <label className="api-settings-field">
                <span className="api-settings-field-label">
                  {t("settings.imagegenSupportedRatios", {
                    defaultValue: "Supported aspect ratios",
                  })}
                </span>
                <input
                  type="text"
                  value={activeModelItem.supportedRatios ?? ""}
                  onChange={(e) =>
                    updateActiveModelItem("supportedRatios", e.target.value)
                  }
                  placeholder="1:1, 16:9, 9:16, 4:3, 3:4, 21:9"
                  disabled={draftSaving}
                  spellCheck={false}
                />
                <small className="api-settings-field-hint">
                  {activeModelItem.supportedRatios?.trim()
                    ? t("settings.imagegenSupportedRatiosHint", {
                        defaultValue:
                          "Ratios available for this model (comma-separated, e.g. 1:1, 16:9, 9:16)",
                      })
                    : t("settings.imagegenCapabilityEmptyHint", {
                        defaultValue:
                          "Empty = unrestricted: the backend skips the check and lets any valid value through.",
                      })}
                </small>
              </label>

              {/* 支持分辨率 / 档位 */}
              <label className="api-settings-field">
                <span className="api-settings-field-label">
                  {t("settings.imagegenSupportedResolutions", {
                    defaultValue: "Supported resolutions / tiers",
                  })}
                </span>
                <input
                  type="text"
                  value={activeModelItem.supportedResolutions ?? ""}
                  onChange={(e) =>
                    updateActiveModelItem(
                      "supportedResolutions",
                      e.target.value,
                    )
                  }
                  placeholder="1K, 2K, 4K 或 1024x1024, 1792x1024"
                  disabled={draftSaving}
                  spellCheck={false}
                />
                <small className="api-settings-field-hint">
                  {activeModelItem.supportedResolutions?.trim()
                    ? t("settings.imagegenSupportedResolutionsHint", {
                        defaultValue:
                          "Resolution tiers or dimensions (e.g. 1K, 2K, 4K or 1024x1024)",
                      })
                    : t("settings.imagegenCapabilityEmptyHint", {
                        defaultValue:
                          "Empty = unrestricted: the backend skips the check and lets any valid value through.",
                      })}
                </small>
              </label>

              {/* 支持思考强度（仅 Gemini：OpenAI Images API 无该请求参数） */}
              {isGeminiModel ? (
                <label className="api-settings-field imagegen-field-wide">
                  <span className="api-settings-field-label">
                    {t("settings.imagegenSupportedThinking", {
                      defaultValue: "Supported thinking strength",
                    })}
                  </span>
                  <input
                    type="text"
                    value={activeModelItem.supportedThinking ?? ""}
                    onChange={(e) =>
                      updateActiveModelItem("supportedThinking", e.target.value)
                    }
                    placeholder="minimal, medium, high"
                    disabled={draftSaving}
                    spellCheck={false}
                  />
                  <small className="api-settings-field-hint">
                    {activeModelItem.supportedThinking?.trim()
                      ? t("settings.imagegenSupportedThinkingHint", {
                          defaultValue:
                            "thinking_level values supported by this model (e.g. minimal, medium, high / minimal, high)",
                        })
                      : t("settings.imagegenCapabilityEmptyHint", {
                          defaultValue:
                            "Empty = unrestricted: the backend skips the check and lets any valid value through.",
                        })}
                  </small>
                </label>
              ) : null}

              {/* 支持画质 / 质量选项（仅 OpenAI：Gemini 无 quality 请求参数） */}
              {!isGemini ? (
                <label className="api-settings-field imagegen-field-wide">
                  <span className="api-settings-field-label">
                    {t("settings.imagegenSupportedQualities", {
                      defaultValue: "Supported qualities",
                    })}
                  </span>
                  <input
                    type="text"
                    value={activeModelItem.supportedQualities ?? ""}
                    onChange={(e) =>
                      updateActiveModelItem(
                        "supportedQualities",
                        e.target.value,
                      )
                    }
                    placeholder="low, medium, high, xhigh, max"
                    disabled={draftSaving}
                    spellCheck={false}
                  />
                  <small className="api-settings-field-hint">
                    {activeModelItem.supportedQualities?.trim()
                      ? t("settings.imagegenSupportedQualitiesHint", {
                          defaultValue:
                            "Qualities available for this model (comma-separated, e.g. low, medium, high, xhigh, max)",
                        })
                      : t("settings.imagegenCapabilityEmptyHint", {
                          defaultValue:
                            "Empty = unrestricted: the backend skips the check and lets any valid value through.",
                        })}
                  </small>
                </label>
              ) : null}

              {/* 自定义提示词说明与自动生成 */}
              <label className="api-settings-field imagegen-field-wide">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 4,
                  }}
                >
                  <span className="api-settings-field-label">
                    {t("settings.imagegenCustomPrompt", {
                      defaultValue: "Custom prompt instructions for this model",
                    })}
                  </span>
                  <button
                    type="button"
                    className="api-settings-form-btn secondary"
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      height: "auto",
                    }}
                    onClick={() => {
                      const parts: string[] = [];
                      if (activeModelItem.model.trim()) {
                        parts.push(`模型：${activeModelItem.model.trim()}`);
                      }
                      if (activeModelItem.supportedRatios?.trim()) {
                        parts.push(
                          `支持宽高比：${activeModelItem.supportedRatios.trim()}`,
                        );
                      }
                      if (activeModelItem.supportedResolutions?.trim()) {
                        parts.push(
                          `支持分辨率：${activeModelItem.supportedResolutions.trim()}`,
                        );
                      }
                      if (activeModelItem.supportedThinking?.trim()) {
                        parts.push(
                          `支持思考强度：${activeModelItem.supportedThinking.trim()}`,
                        );
                      }
                      if (activeModelItem.defaultSize?.trim()) {
                        parts.push(
                          `默认尺寸：${activeModelItem.defaultSize.trim()}`,
                        );
                      }
                      if (activeModelItem.defaultQuality?.trim()) {
                        parts.push(
                          `默认质量：${activeModelItem.defaultQuality.trim()}`,
                        );
                      }
                      const result =
                        parts.length > 0 ? parts.join("；") + "。" : "";
                      if (result) {
                        updateActiveModelItem("customPrompt", result);
                      }
                    }}
                    disabled={draftSaving}
                    title={t("settings.imagegenAutoGeneratePrompt", {
                      defaultValue:
                        "Auto-generate prompt from parameters above",
                    })}
                  >
                    <Sparkles size={11} style={{ marginRight: 4 }} />
                    {t("settings.imagegenAutoGeneratePrompt", {
                      defaultValue: "Auto-generate prompt",
                    })}
                  </button>
                </div>
                <textarea
                  className="api-settings-field-textarea"
                  value={activeModelItem.customPrompt ?? ""}
                  onChange={(event) =>
                    updateActiveModelItem("customPrompt", event.target.value)
                  }
                  placeholder={t("settings.imagegenCustomPromptPlaceholder", {
                    defaultValue:
                      "Custom instructions and capability notes injected into imagegen-generate tool description...",
                  })}
                  rows={3}
                  disabled={draftSaving}
                  spellCheck={false}
                />
                <small className="api-settings-field-hint">
                  {t("settings.imagegenCustomPromptHint", {
                    defaultValue:
                      "Directly injected into AI tool description to guide model on parameters and features.",
                  })}
                </small>
              </label>
            </div>
          </div>
        </div>

        {/* 全局输出格式（仅 OpenAI 生效）：分组标题与字段名分开，
              避免同一屏出现两个「输出格式」 */}
        {!isGemini ? (
          <div className="api-settings-form-section">
            <strong className="api-settings-form-section-title">
              {t("settings.imagegenOutputGroup", {
                defaultValue: "Output settings",
              })}
            </strong>
            <div className="api-settings-form-grid">
              <label className="api-settings-field">
                <span className="api-settings-field-label">
                  {t("settings.imagegenOutputFormat", {
                    defaultValue: "Output format",
                  })}
                </span>
                <CustomSelect
                  value={draft.outputFormat}
                  options={[
                    {
                      value: "",
                      label: t("settings.imagegenFormatDefault", {
                        defaultValue: "Default (png)",
                      }),
                    },
                    { value: "png", label: "png" },
                    { value: "jpeg", label: "jpeg" },
                    { value: "webp", label: "webp" },
                  ]}
                  onChange={(value) => updateDraft("outputFormat", value)}
                  disabled={draftSaving}
                  portal
                />
              </label>
            </div>
          </div>
        ) : null}

        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.imagegenAdvanced", {
              defaultValue: "Advanced",
            })}
          </strong>
          <div className="imagegen-toggle-list">
            {isGemini ? (
              <div className="imagegen-toggle-row">
                <span className="imagegen-toggle-copy">
                  <span>
                    {t("settings.imagegenWebSearch", {
                      defaultValue: "Google Search grounding",
                    })}
                  </span>
                  <small>
                    {t("settings.imagegenWebSearchHint", {
                      defaultValue:
                        "Gemini native protocol only: let the model use real-time web information via google_search grounding",
                    })}
                  </small>
                  {!supportsWebSearch ? (
                    <small className="api-settings-field-hint">
                      {t("settings.imagegenWebSearchModelUnsupported", {
                        defaultValue:
                          "The current model ({model}) is not a Gemini image model — grounding is ignored. Pick a Gemini / Nano Banana model to enable it.",
                      }).replace("{model}", currentModelId || "—")}
                    </small>
                  ) : null}
                </span>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={draft.webSearch}
                    onChange={updateDraftEvent("webSearch")}
                    disabled={draftSaving || !supportsWebSearch}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            ) : (
              <div className="imagegen-toggle-row">
                <span className="imagegen-toggle-copy">
                  <span>
                    {t("settings.imagegenWebSearch", {
                      defaultValue: "Google Search grounding",
                    })}
                  </span>
                  <small>
                    {t("settings.imagegenWebSearchProtocolOnly", {
                      defaultValue:
                        "Only available on the Gemini native protocol (google_search grounding). Switch this channel's provider to Google Gemini to enable it — OpenAI-compatible endpoints do not support web search.",
                    })}
                  </small>
                </span>
                <label className="toggle-switch">
                  <input type="checkbox" checked={false} disabled />
                  <span className="toggle-slider" />
                </label>
              </div>
            )}

            <div className="imagegen-toggle-row">
              <span className="imagegen-toggle-copy">
                <span>
                  {t("settings.imagegenStreaming", {
                    defaultValue: "Streaming preview",
                  })}
                </span>
                <small>
                  {t("settings.imagegenStreamingHint", {
                    defaultValue:
                      "Streaming: show intermediate preview images while generating; Non-streaming: show images once generation finishes (OpenAI gpt-image / Gemini Imagen)",
                  })}
                </small>
              </span>
              <div
                className="imagegen-stream-segmented"
                role="group"
                aria-label={t("settings.imagegenStreaming", {
                  defaultValue: "Streaming preview",
                })}
              >
                <button
                  type="button"
                  className={`imagegen-stream-segmented-btn${
                    draft.defaultStream ? " active" : ""
                  }`}
                  onClick={() => updateDraft("defaultStream", true)}
                  disabled={draftSaving}
                >
                  {t("settings.imagegenStreamModeOn", {
                    defaultValue: "Streaming",
                  })}
                </button>
                <button
                  type="button"
                  className={`imagegen-stream-segmented-btn${
                    !draft.defaultStream ? " active" : ""
                  }`}
                  onClick={() => updateDraft("defaultStream", false)}
                  disabled={draftSaving}
                >
                  {t("settings.imagegenStreamModeOff", {
                    defaultValue: "Non-streaming",
                  })}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="api-settings-page imagegen-tab-page" role="region">
      {/* 汇总卡片：参照 API 设置页（渠道数 / 已启用 / 最大并发生成数） */}
      <div className="api-settings-summary-grid imagegen-summary-grid">
        <div className="api-settings-summary-card">
          <Layers size={15} strokeWidth={1.8} />
          <span>{channels.length}</span>
          <small>
            {t("settings.imagegenChannels", { defaultValue: "Channels" })}
          </small>
        </div>
        <div className="api-settings-summary-card">
          <CircleCheck size={15} strokeWidth={1.8} />
          <span>{enabledCount}</span>
          <small>
            {t("settings.imagegenEnabled", { defaultValue: "Enabled" })}
          </small>
        </div>
        <div className="api-settings-summary-card imagegen-concurrency-card">
          <span className="imagegen-concurrency-head">
            <Gauge size={14} strokeWidth={1.8} />
            {t("settings.imagegenMaxConcurrent", {
              defaultValue: "Max concurrent generations",
            })}
          </span>
          <div className="imagegen-concurrency-control">
            <button
              type="button"
              className="icon-btn ghost"
              onClick={() => void updateMaxConcurrent(maxConcurrent - 1)}
              disabled={
                isBusy || maxConcurrent <= IMAGE_GEN_MAX_CONCURRENT_RANGE.min
              }
              aria-label={t("settings.imagegenMaxConcurrentDecrease", {
                defaultValue: "Decrease max concurrent generations",
              })}
              title={t("settings.imagegenMaxConcurrentDecrease", {
                defaultValue: "Decrease max concurrent generations",
              })}
            >
              <Minus size={13} strokeWidth={2} aria-hidden="true" />
            </button>
            <input
              type="number"
              min={IMAGE_GEN_MAX_CONCURRENT_RANGE.min}
              max={IMAGE_GEN_MAX_CONCURRENT_RANGE.max}
              value={maxConcurrent}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed)) {
                  void updateMaxConcurrent(parsed);
                }
              }}
              disabled={isBusy}
              aria-label={t("settings.imagegenMaxConcurrent", {
                defaultValue: "Max concurrent generations",
              })}
            />
            <button
              type="button"
              className="icon-btn ghost"
              onClick={() => void updateMaxConcurrent(maxConcurrent + 1)}
              disabled={
                isBusy || maxConcurrent >= IMAGE_GEN_MAX_CONCURRENT_RANGE.max
              }
              aria-label={t("settings.imagegenMaxConcurrentIncrease", {
                defaultValue: "Increase max concurrent generations",
              })}
              title={t("settings.imagegenMaxConcurrentIncrease", {
                defaultValue: "Increase max concurrent generations",
              })}
            >
              +
            </button>
            <span className="imagegen-concurrency-range">
              {IMAGE_GEN_MAX_CONCURRENT_RANGE.min}–
              {IMAGE_GEN_MAX_CONCURRENT_RANGE.max}
            </span>
          </div>
          <small
            className="imagegen-concurrency-hint"
            title={t("settings.imagegenMaxConcurrentHint", {
              defaultValue:
                "When the agent requests several images at once, at most this many are generated in parallel; the rest wait in the queue. Lower it if your provider rate-limits image requests.",
            })}
          >
            {t("settings.imagegenMaxConcurrentHint", {
              defaultValue:
                "When the agent requests several images at once, at most this many are generated in parallel; the rest wait in the queue. Lower it if your provider rate-limits image requests.",
            })}
          </small>
        </div>
        <div className="api-settings-summary-card imagegen-concurrency-card imagegen-timeout-card">
          <span className="imagegen-concurrency-head">
            <Clock size={14} strokeWidth={1.8} />
            {t("settings.imagegenTimeout", {
              defaultValue: "Generation timeout (s)",
            })}
          </span>
          <div className="imagegen-concurrency-control">
            <button
              type="button"
              className="icon-btn ghost"
              onClick={() => void updateTimeoutSecs(timeoutSecs - 30)}
              disabled={isBusy || timeoutSecs <= IMAGE_GEN_TIMEOUT_RANGE.min}
              aria-label={t("settings.imagegenTimeoutDecrease", {
                defaultValue: "Decrease generation timeout",
              })}
              title={t("settings.imagegenTimeoutDecrease", {
                defaultValue: "Decrease generation timeout",
              })}
            >
              −
            </button>
            <input
              type="number"
              min={IMAGE_GEN_TIMEOUT_RANGE.min}
              max={IMAGE_GEN_TIMEOUT_RANGE.max}
              step={30}
              value={timeoutSecs}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed)) {
                  void updateTimeoutSecs(parsed);
                }
              }}
              disabled={isBusy}
              aria-label={t("settings.imagegenTimeout", {
                defaultValue: "Generation timeout (s)",
              })}
            />
            <button
              type="button"
              className="icon-btn ghost"
              onClick={() => void updateTimeoutSecs(timeoutSecs + 30)}
              disabled={isBusy || timeoutSecs >= IMAGE_GEN_TIMEOUT_RANGE.max}
              aria-label={t("settings.imagegenTimeoutIncrease", {
                defaultValue: "Increase generation timeout",
              })}
              title={t("settings.imagegenTimeoutIncrease", {
                defaultValue: "Increase generation timeout",
              })}
            >
              +
            </button>
            <span className="imagegen-concurrency-range">
              {IMAGE_GEN_TIMEOUT_RANGE.min}–{IMAGE_GEN_TIMEOUT_RANGE.max}
            </span>
          </div>
          <small
            className="imagegen-concurrency-hint"
            title={t("settings.imagegenTimeoutHint", {
              defaultValue:
                "Max wait time per generation/edit request (including streaming). Complex prompts or 2K/4K output can take several minutes — raise this if requests time out.",
            })}
          >
            {t("settings.imagegenTimeoutHint", {
              defaultValue:
                "Max wait time per generation/edit request (including streaming). Complex prompts or 2K/4K output can take several minutes — raise this if requests time out.",
            })}
          </small>
        </div>
        <div className="api-settings-summary-card imagegen-concurrency-card imagegen-mode-card">
          <span className="imagegen-concurrency-head">
            <Layers size={14} strokeWidth={1.8} />
            {t("settings.imagegenExecutionMode", {
              defaultValue: "Execution mode",
            })}
          </span>
          <div className="imagegen-concurrency-control imagegen-mode-control">
            <CustomSelect
              value={executionMode}
              options={[
                {
                  value: "auto",
                  label: t("settings.imagegenExecutionModeAuto", {
                    defaultValue: "Auto",
                  }),
                },
                {
                  value: "sync",
                  label: t("settings.imagegenExecutionModeSync", {
                    defaultValue: "Sync",
                  }),
                },
                {
                  value: "async",
                  label: t("settings.imagegenExecutionModeAsync", {
                    defaultValue: "Async",
                  }),
                },
              ]}
              onChange={(mode) =>
                void updateExecutionMode(mode as ImageGenExecutionMode)
              }
              disabled={isBusy}
              portal
            />
          </div>
        </div>
      </div>

      {/* 操作区：与 LLM 模型页一致的操作栏（搜索位于表格工具栏内） */}
      <div className="api-settings-actions">
        <button
          type="button"
          className="api-settings-action-btn primary"
          onClick={openAddEditor}
          disabled={isBusy}
        >
          <Plus size={15} strokeWidth={1.8} />
          <span>
            {t("settings.imagegenAddChannel", {
              defaultValue: "Add channel",
            })}
          </span>
        </button>
      </div>

      {/* 渠道表格：复用 API 设置表格样式 */}
      <div className="api-settings-table-panel imagegen-table-panel">
        <div className="api-settings-table-toolbar">
          <label className="api-settings-table-search">
            <Search size={14} strokeWidth={1.8} aria-hidden="true" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("settings.imagegenSearchPlaceholder", {
                defaultValue: "Search channels, models, or base URLs",
              })}
              aria-label={t("settings.imagegenSearchPlaceholder", {
                defaultValue: "Search channels",
              })}
              disabled={isLoading && channels.length === 0}
            />
          </label>
        </div>

        {selectedChannelCount > 0 && (
          <div className="api-settings-selection-bar">
            <span>
              {t("settings.apiSelectedCount", {
                defaultValue: "{count} selected",
              }).replace("{count}", String(selectedChannelCount))}
            </span>
            <div className="api-settings-selection-bar-actions">
              <button
                className="api-settings-action-btn danger"
                onClick={() => setBulkDeletePending(true)}
                type="button"
                disabled={isBusy}
              >
                <Trash2 size={14} strokeWidth={1.8} />
                <span>
                  {t("settings.apiDeleteSelected", {
                    defaultValue: "Delete selected",
                  })}
                </span>
              </button>
              <button
                className="icon-btn ghost"
                onClick={() => setSelectedChannelIds([])}
                type="button"
                title={t("settings.clearSelection", {
                  defaultValue: "Clear selection",
                })}
                aria-label={t("settings.clearSelection", {
                  defaultValue: "Clear selection",
                })}
              >
                <X size={13} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        )}

        <div className="api-settings-table-wrap">
          {isLoading ? (
            <div className="api-settings-empty">
              <Loader2 size={16} className="spin" />
              {t("settings.imagegenModelsLoading", {
                defaultValue: "Loading...",
              })}
            </div>
          ) : channels.length === 0 ? (
            <div className="api-settings-empty imagegen-empty-state">
              <ImageIcon size={28} strokeWidth={1.4} aria-hidden="true" />
              <span>
                {t("settings.imagegenNoChannels", {
                  defaultValue:
                    'No channels yet. Click "Add channel" to create one.',
                })}
              </span>
            </div>
          ) : filteredChannels.length === 0 ? (
            <div className="api-settings-empty imagegen-empty-state">
              <SearchX size={24} strokeWidth={1.5} aria-hidden="true" />
              <span>
                {t("settings.imagegenSearchEmpty", {
                  defaultValue: "No channels match your search.",
                })}
              </span>
            </div>
          ) : (
            <table className="api-settings-table">
              <thead>
                <tr>
                  <th className="api-settings-table-order" />
                  <th className="api-settings-table-select">
                    <input
                      type="checkbox"
                      checked={isAllFilteredSelected}
                      ref={(element) => {
                        if (element) {
                          element.indeterminate = isPartiallySelected;
                        }
                      }}
                      onChange={toggleSelectAll}
                      title={t("settings.apiSelectAll", {
                        defaultValue: "Select all",
                      })}
                      aria-label={t("settings.apiSelectAll", {
                        defaultValue: "Select all",
                      })}
                    />
                  </th>
                  <th>
                    {t("settings.tableStatus", { defaultValue: "Status" })}
                  </th>
                  <th>{t("settings.tableName", { defaultValue: "Name" })}</th>
                  <th>
                    {t("settings.imagegenBaseUrl", {
                      defaultValue: "Base URL",
                    })}
                  </th>
                  <th>
                    {t("settings.imagegenModel", { defaultValue: "Model" })}
                  </th>
                  <th>
                    {t("settings.imagegenProvider", {
                      defaultValue: "Provider",
                    })}
                  </th>
                  <th className="api-settings-table-actions-col">
                    {t("settings.tableActions", { defaultValue: "Actions" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredChannels.map((channel) => {
                  const isGemini = channel.provider === "gemini";
                  const statusLabel = channel.enabled
                    ? t("settings.imagegenEnabled", {
                        defaultValue: "Enabled",
                      })
                    : t("settings.imagegenDisabled", {
                        defaultValue: "Disabled",
                      });
                  const isSelected = selectedChannelIdSet.has(channel.id);
                  const isDragging = reorder.draggingName === channel.id;
                  const isDropTarget = reorder.dropTargetName === channel.id;
                  const rowClassName = [
                    isSelected && "is-selected",
                    isDragging && "is-dragging",
                    isDropTarget &&
                      (reorder.dropPlacement === "before"
                        ? "is-drop-before"
                        : "is-drop-after"),
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <tr
                      key={channel.id}
                      {...reorder.getDropTargetProps(channel.id)}
                      {...{ [API_CONFIG_ROW_ATTRIBUTE]: channel.id }}
                      className={rowClassName || undefined}
                    >
                      <td className="api-settings-table-order">
                        <span
                          className="api-settings-drag-handle"
                          {...reorder.getDragHandleProps(channel.id)}
                          title={t("settings.apiDragToReorder", {
                            defaultValue: "Drag to reorder",
                          })}
                        >
                          <GripVertical size={13} strokeWidth={1.8} />
                        </span>
                      </td>
                      <td className="api-settings-table-select">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleChannelSelection(channel.id)}
                          aria-label={t("settings.apiSelectProfile", {
                            defaultValue: "Select {name}",
                          }).replace("{name}", channelLabel(channel))}
                        />
                      </td>
                      <td>
                        <label
                          className="toggle-switch api-settings-table-switch"
                          title={t("settings.imagegenToggleHint", {
                            defaultValue:
                              "Click to enable or disable this channel",
                          })}
                          aria-label={t("settings.imagegenToggleHint", {
                            defaultValue:
                              "Click to enable or disable this channel",
                          })}
                        >
                          <input
                            type="checkbox"
                            checked={channel.enabled}
                            onChange={() => void toggleEnabled(channel)}
                            disabled={isBusy}
                          />
                          <span className="toggle-slider" />
                          <span>{statusLabel}</span>
                        </label>
                      </td>
                      <td className="cell-name">
                        <button
                          className="cell-name-button"
                          onClick={() => openEditEditor(channel)}
                          type="button"
                          title={t("settings.edit", { defaultValue: "Edit" })}
                          aria-label={t("settings.apiEditProfile", {
                            defaultValue: "Edit {name}",
                          }).replace("{name}", channelLabel(channel))}
                        >
                          <strong>{channelLabel(channel)}</strong>
                          <small className="profile-name-hint">
                            {channel.id}
                          </small>
                        </button>
                      </td>
                      <td className="cell-url">
                        {channel.baseUrl.trim() ||
                          t("settings.imagegenDefaultEndpoint", {
                            defaultValue: "Provider default",
                          })}
                      </td>
                      <td>
                        <span className="imagegen-table-model">
                          {channel.model ? (
                            <ModelBrandIcon
                              model={channel.model}
                              size={13}
                              className="imagegen-table-model-icon"
                            />
                          ) : null}
                          <span className="imagegen-table-model-id">
                            {channel.model || "-"}
                          </span>
                          {channel.models && channel.models.length > 1 ? (
                            <span
                              className="imagegen-model-more-tag"
                              title={channel.models
                                .map((item) => item.model)
                                .join("\n")}
                            >
                              {t("settings.imagegenMoreModels", {
                                defaultValue: "+{count} models",
                              }).replace(
                                "{count}",
                                String(channel.models.length - 1),
                              )}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`badge method imagegen-provider-badge${
                            isGemini ? " gemini" : ""
                          }`}
                        >
                          {isGemini
                            ? t("settings.imagegenProviderGemini", {
                                defaultValue: "Gemini",
                              })
                            : channel.provider === "novelai"
                              ? t("settings.imagegenProviderNovelai", {
                                  defaultValue: "NovelAI",
                                })
                              : t("settings.imagegenProviderOpenai", {
                                  defaultValue: "OpenAI",
                                })}
                        </span>
                      </td>
                      <td className="api-settings-table-actions-col">
                        <div className="api-settings-table-actions">
                          <button
                            className="icon-btn ghost"
                            onClick={() => reorder.moveUp(channel.id)}
                            disabled={!reorder.canMoveUp(channel.id) || isBusy}
                            type="button"
                            title={t("settings.apiMoveUp", {
                              defaultValue: "Move up",
                            })}
                            aria-label={t("settings.apiMoveUp", {
                              defaultValue: "Move up",
                            })}
                          >
                            <ChevronUp size={13} strokeWidth={1.8} />
                          </button>
                          <button
                            className="icon-btn ghost"
                            onClick={() => reorder.moveDown(channel.id)}
                            disabled={
                              !reorder.canMoveDown(channel.id) || isBusy
                            }
                            type="button"
                            title={t("settings.apiMoveDown", {
                              defaultValue: "Move down",
                            })}
                            aria-label={t("settings.apiMoveDown", {
                              defaultValue: "Move down",
                            })}
                          >
                            <ChevronDown size={13} strokeWidth={1.8} />
                          </button>
                          <button
                            className="icon-btn ghost"
                            onClick={() => void duplicateChannel(channel)}
                            type="button"
                            title={t("settings.duplicate", {
                              defaultValue: "Duplicate",
                            })}
                            aria-label={t("settings.duplicate", {
                              defaultValue: "Duplicate",
                            })}
                            disabled={isBusy}
                          >
                            <Copy size={13} strokeWidth={1.8} />
                          </button>
                          <button
                            className="icon-btn ghost"
                            onClick={() => openEditEditor(channel)}
                            type="button"
                            title={t("settings.edit", { defaultValue: "Edit" })}
                            aria-label={t("settings.edit", {
                              defaultValue: "Edit",
                            })}
                            disabled={isBusy}
                          >
                            <Pencil size={13} strokeWidth={1.8} />
                          </button>
                          <button
                            className="icon-btn ghost danger"
                            onClick={() => requestRemoveChannel(channel)}
                            type="button"
                            title={t("settings.delete", {
                              defaultValue: "Delete",
                            })}
                            aria-label={t("settings.delete", {
                              defaultValue: "Delete",
                            })}
                            disabled={isBusy}
                          >
                            <Trash2 size={13} strokeWidth={1.8} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {searchQuery.trim() && filteredChannels.length > 0 ? (
          <span className="api-settings-search-count">
            {t("settings.imagegenSearchResultCount", {
              defaultValue: "Found {count} channel(s)",
            }).replace("{count}", String(filteredChannels.length))}
          </span>
        ) : null}
      </div>

      <Modal
        open={editorOpen}
        title={
          isNewChannel
            ? t("settings.imagegenAddChannelTitle", {
                defaultValue: "Add channel",
              })
            : `${t("settings.imagegenEditChannelTitle", {
                defaultValue: "Edit channel",
              })}: ${draft ? channelLabel(draft) : ""}`
        }
        description={t("settings.imagegenEditorInfo", {
          defaultValue:
            "Each channel is fully independent: provider, base URL, API key, model and defaults.",
        })}
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={closeEditor}
        closeDisabled={draftSaving}
        size="large"
        className="api-settings-editor-modal imagegen-editor-modal"
        footer={
          <div className="api-settings-form-actions imagegen-editor-actions">
            <ApiSettingsFormActions
              isSaving={draftSaving}
              onCancel={closeEditor}
              onSave={() => void saveDraft()}
              saveLabel={
                isNewChannel
                  ? t("settings.imagegenAddChannel", {
                      defaultValue: "Add channel",
                    })
                  : t("settings.imagegenSaveChannel", {
                      defaultValue: "Save channel",
                    })
              }
            />
          </div>
        }
      >
        {renderDraftPanel()}
      </Modal>

      <ConfirmDialog
        open={channelPendingDeletion !== null}
        title={t("settings.imagegenDeleteChannelTitle", {
          defaultValue: "Delete channel",
        })}
        message={t("settings.imagegenDeleteConfirm", {
          values: {
            name: channelPendingDeletion
              ? channelLabel(channelPendingDeletion)
              : "",
          },
          defaultValue: `Delete channel "${
            channelPendingDeletion ? channelLabel(channelPendingDeletion) : ""
          }"?`,
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmRemoveChannel()}
        onCancel={() => setChannelPendingDeletion(null)}
        variant="danger"
      />

      {/* 批量删除已选渠道（与 LLM 模型表格一致） */}
      <ConfirmDialog
        open={bulkDeletePending}
        title={t("settings.imagegenDeleteSelectedTitle", {
          defaultValue: "Delete channels",
        })}
        message={t("settings.imagegenDeleteSelectedConfirm", {
          defaultValue:
            "Delete {count} selected channel(s)? This cannot be undone.",
        }).replace("{count}", String(selectedChannelCount))}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        isConfirming={isSaving}
        onConfirm={() => void confirmRemoveSelected()}
        onCancel={() => setBulkDeletePending(false)}
        variant="danger"
      />

      {/* 删除渠道内模型的确认（替代原生 window.confirm，与项目组件一致） */}
      <ConfirmDialog
        open={modelPendingDeletion !== null}
        title={t("settings.imagegenDeleteModel", {
          defaultValue: "Delete model",
        })}
        message={
          modelPendingDeletion !== null
            ? `${t("settings.imagegenDeleteModelConfirm", {
                defaultValue:
                  "Are you sure you want to remove this model config from the channel?",
              })} (${
                currentModelList[modelPendingDeletion]?.name?.trim() ||
                currentModelList[modelPendingDeletion]?.model?.trim() ||
                `#${modelPendingDeletion + 1}`
              })`
            : ""
        }
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => {
          if (modelPendingDeletion !== null) {
            confirmRemoveModelItem(modelPendingDeletion);
          }
        }}
        onCancel={() => setModelPendingDeletion(null)}
        variant="danger"
      />

      {/* 顶部模板替换已配置多模型的二次确认（避免静默清空） */}
      <ConfirmDialog
        open={templatePendingApply !== null}
        title={t("settings.imagegenTemplate", {
          defaultValue: "Preset template",
        })}
        message={t("settings.imagegenTemplateReplaceConfirm", {
          defaultValue:
            "Applying this template will REPLACE all models currently configured in this channel. Continue?",
        })}
        confirmLabel={t("settings.imagegenApplyTemplate", {
          defaultValue: "Apply template",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => {
          if (templatePendingApply) {
            applyTemplate(templatePendingApply);
          }
          setTemplatePendingApply(null);
        }}
        onCancel={() => setTemplatePendingApply(null)}
        variant="warning"
      />

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
        durationMs={error ? 6000 : 3000}
      />
    </div>
  );
}
