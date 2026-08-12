import {
  CircleCheck,
  Clock,
  Copy,
  Gauge,
  ImageIcon,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Search,
  SearchX,
  Trash2,
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
import { ApiModelCombobox } from "./apiSettings/ApiModelCombobox";
import { buildDuplicateName } from "./duplicateName";
import type { Model } from "../../../preload";
import {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_IMAGE_GEN_CHANNEL,
  DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
  DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
  DEFAULT_OPENAI_BASE_URL,
  GEMINI_MODEL_EXAMPLES,
  GEMINI_ASPECT_RATIOS,
  IMAGE_GEN_MAX_CONCURRENT_RANGE,
  IMAGE_GEN_SETTING_CODE,
  IMAGE_GEN_SETTING_NAME,
  IMAGE_GEN_TIMEOUT_RANGE,
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
import type {
  ImageGenChannelValue,
  ImageGenProvider,
  ImageGenSettingsPanelProps,
} from "./imagegenSettings/types";

/**
 * OpenAI 标准模型能力（依据 openai-node SDK images.ts，2026-08）：
 * - dall-e-3：1024x1024 / 1792x1024 / 1024x1792，质量 hd / standard
 * - dall-e-2：256x256 / 512x512 / 1024x1024，质量 standard
 * - 其余 GPT image：1024x1024 / 1536x1024 / 1024x1536，质量 auto/low/medium/high
 * gpt-image-2 系支持 `auto` 与任意分辨率，尺寸预设走「比例 × 档位」联动
 * （OPENAI_SIZE_PRESETS 推荐表）。
 */
const OPENAI_STANDARD_CAPS: Array<{
  match: (id: string) => boolean;
  sizes: string[];
  quality: string[];
}> = [
  {
    match: (id) => id.includes("dall-e-3"),
    sizes: ["1024x1024", "1792x1024", "1024x1792"],
    quality: ["", "hd", "standard"],
  },
  {
    match: (id) => id.includes("dall-e-2"),
    sizes: ["256x256", "512x512", "1024x1024"],
    quality: ["standard"],
  },
  {
    match: () => true,
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    quality: ["", "low", "medium", "high"],
  },
];

/** gpt-image-2 系（含兼容中转）支持任意分辨率判定。 */
const supportsArbitraryOpenAISize = (modelId: string): boolean =>
  modelId.toLowerCase().includes("gpt-image-2");

/** 查询某 OpenAI 模型的标准能力（未识别模型使用默认规则）。 */
const openaiStandardCaps = (modelId: string) => {
  const id = modelId.toLowerCase();
  return (
    OPENAI_STANDARD_CAPS.find((rule) => rule.match(id)) ??
    OPENAI_STANDARD_CAPS[OPENAI_STANDARD_CAPS.length - 1]
  );
};

/**
 * 已知生图模型知识表（别名 / 预览 / 弃用），用于模型下拉选项增强。
 * 模型 ID 依据 OpenAI SDK ImageModel 枚举与 Gemini 官方模型清单（2026-08）。
 */
const KNOWN_IMAGE_MODELS: Array<{
  id: string;
  provider: ImageGenProvider;
  alias?: string;
  preview?: boolean;
  deprecated?: boolean;
}> = [
  // OpenAI 兼容
  { id: "gpt-image-2", provider: "openai", alias: "GPT Image 2" },
  {
    id: "chatgpt-image-latest",
    provider: "openai",
    alias: "ChatGPT Image (latest)",
    preview: true,
  },
  { id: "dall-e-3", provider: "openai", alias: "DALL·E 3" },
  { id: "dall-e-2", provider: "openai", alias: "DALL·E 2", deprecated: true },
  // Google Gemini
  {
    id: "gemini-3.1-flash-image",
    provider: "gemini",
    alias: "Nano Banana 2",
  },
  {
    id: "gemini-3-pro-image",
    provider: "gemini",
    alias: "Nano Banana Pro",
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

/** 宽高比下拉选项：小矩形图示 + 比例文本。 */
const RatioDiagram = ({ ratio }: { ratio: string }): React.JSX.Element => {
  const [width, height] = ratio.split(":").map(Number);
  const scale = 6;
  const isPortrait = height > width;
  return (
    <span className="imagegen-ratio-option">
      <span
        className={`imagegen-ratio-box${isPortrait ? " portrait" : ""}`}
        style={{
          width: `${Math.max(width * scale, 10)}px`,
          height: `${Math.max(height * scale, 10)}px`,
        }}
      />
      <span className="imagegen-ratio-option-label">{ratio}</span>
    </span>
  );
};

/** 尺寸预设下拉选项（CustomSelect 用）。 */
const sizePresetOptions = (presets: string[]): CustomSelectOption[] =>
  presets.map((preset) => ({ value: preset, label: preset }));

type SizeControlsProps = {
  draft: ImageGenChannelValue;
  onUpdate: <K extends keyof ImageGenChannelValue>(
    field: K,
    value: ImageGenChannelValue[K]
  ) => void;
  disabled: boolean;
  t: (key: string, options?: { defaultValue?: string }) => string;
};

/** Gemini 尺寸：自定义输入 + 档位下拉 + 宽高比下拉（组合为 "16:9@2K"）。 */
const GeminiSizeControls = ({
  draft,
  onUpdate,
  disabled,
  t,
}: SizeControlsProps): React.JSX.Element => {
  const parsed = matchGeminiSizePreset(draft.defaultSize);
  const supportedSizes = getGeminiSizePresets(draft.model);

  return (
    <div className="imagegen-editor-size-row">
      <input
        className="imagegen-size-input"
        type="text"
        value={draft.defaultSize}
        onChange={(event) => onUpdate("defaultSize", event.target.value)}
        placeholder="1K / 16:9 / 16:9@2K"
        disabled={disabled}
        spellCheck={false}
      />
      <CustomSelect
        value={parsed.imageSize}
        options={[
          {
            value: "",
            label: t("settings.imagegenSizeTier", {
              defaultValue: "Size tier",
            }),
          },
          ...sizePresetOptions(supportedSizes),
        ]}
        onChange={(value) =>
          onUpdate("defaultSize", buildGeminiSize(parsed.ratio, value))
        }
        disabled={disabled}
        portal
      />
      <CustomSelect
        value={parsed.ratio}
        options={[
          {
            value: "",
            label: t("settings.imagegenAspectRatio", {
              defaultValue: "Aspect ratio",
            }),
          },
          ...GEMINI_ASPECT_RATIOS.map((ratio) => ({
            value: ratio,
            label: ratio,
          })),
        ]}
        onChange={(value) =>
          onUpdate("defaultSize", buildGeminiSize(value, parsed.imageSize))
        }
        disabled={disabled}
        portal
        renderOption={(option) =>
          option.value ? <RatioDiagram ratio={option.value} /> : option.label
        }
      />
    </div>
  );
};

/** gpt-image-2 尺寸：自定义输入 + 比例下拉 + 档位下拉（推荐分辨率表）。 */
const GptImage2SizeControls = ({
  draft,
  onUpdate,
  disabled,
  t,
}: SizeControlsProps): React.JSX.Element => {
  const parsed = matchOpenAISizePreset(draft.defaultSize);
  const ratioOptions = Object.keys(OPENAI_SIZE_PRESETS).map((ratio) => ({
    value: ratio,
    label: ratio,
  }));

  const pickSize = (ratio: string, tier: string): string => {
    const normalizedRatio =
      ratio && OPENAI_SIZE_PRESETS[ratio] ? ratio : "16:9";
    const normalizedTier =
      tier && (OPENAI_SIZE_TIERS as readonly string[]).includes(tier)
        ? (tier as keyof (typeof OPENAI_SIZE_PRESETS)[string])
        : "1K";
    return OPENAI_SIZE_PRESETS[normalizedRatio][normalizedTier];
  };

  return (
    <div className="imagegen-editor-size-row">
      <input
        className="imagegen-size-input"
        type="text"
        value={draft.defaultSize}
        onChange={(event) => onUpdate("defaultSize", event.target.value)}
        placeholder="auto / 1792x1008"
        disabled={disabled}
        spellCheck={false}
      />
      <CustomSelect
        value={parsed?.ratio ?? ""}
        options={[
          {
            value: "",
            label: t("settings.imagegenAspectRatio", {
              defaultValue: "Aspect ratio",
            }),
          },
          ...ratioOptions,
        ]}
        onChange={(value) =>
          onUpdate("defaultSize", pickSize(value, parsed?.tier ?? "1K"))
        }
        disabled={disabled}
        portal
        renderOption={(option) =>
          option.value ? <RatioDiagram ratio={option.value} /> : option.label
        }
      />
      <CustomSelect
        value={parsed?.tier ?? ""}
        options={[
          {
            value: "",
            label: t("settings.imagegenSizeTier", {
              defaultValue: "Size tier",
            }),
          },
          ...sizePresetOptions([...OPENAI_SIZE_TIERS]),
        ]}
        onChange={(value) =>
          onUpdate("defaultSize", pickSize(parsed?.ratio ?? "16:9", value))
        }
        disabled={disabled}
        portal
      />
    </div>
  );
};

/** 从 API 返回的模型列表中筛选生图模型。 */
const filterImageModels = (models: Model[], provider: string): Model[] => {
  if (provider === "gemini") {
    return models.filter((model) => {
      const id = model.id.toLowerCase();
      return id.includes("-image") || id.startsWith("imagen");
    });
  }
  return models.filter((model) => {
    const id = model.id.toLowerCase();
    return id.includes("gpt-image") || id.includes("dall-e");
  });
};

/** 根据模型 ID 推断能力标签（i18n 键）。 */
const getModelCapabilities = (modelId: string): string[] => {
  const id = modelId.toLowerCase();
  if (id.includes("gemini-3.1-flash-lite-image")) {
    return ["cap1kOnly", "capFast"];
  }
  if (id.includes("gemini-3.1-flash-image")) {
    return [
      "cap4k",
      "capStream",
      "capImageToImage",
      "capThinking",
      "capImageSearch",
    ];
  }
  if (id.includes("gemini-3-pro-image")) {
    return ["cap4k", "capImageToImage", "capThinking", "capInterleaved"];
  }
  if (id.includes("gemini-2.5-flash-image")) {
    return ["cap1kOnly", "capUpTo3Images", "capLegacy"];
  }
  if (id.startsWith("imagen")) {
    return ["capDeprecated"];
  }
  if (id.includes("gpt-image-2") || id.includes("gpt-image-1.5")) {
    return ["cap4k", "capStream", "capImageToImage"];
  }
  if (id.includes("chatgpt-image")) {
    return ["cap4k", "capStream", "capImageToImage"];
  }
  if (id.includes("gpt-image-1-mini")) {
    return ["capFast", "capStream"];
  }
  if (id.includes("gpt-image-1")) {
    return ["cap2k", "capStream", "capImageToImage", "capFidelity"];
  }
  if (id.includes("grok-imagine")) {
    // xAI Grok Imagine：OpenAI 兼容协议，比例+分辨率（1k/2k），支持图生图
    return ["cap2k", "capImageToImage"];
  }
  if (id.includes("dall-e")) {
    return ["capTextToImageOnly"];
  }
  return [];
};

export function ImageGenSettingsPanel({
  onClose,
}: ImageGenSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [channels, setChannels] = useState<ImageGenChannelValue[]>([]);
  /** 同一批次生图请求的最大并发数（1-8，立即保存）。 */
  const [maxConcurrent, setMaxConcurrent] = useState(
    DEFAULT_IMAGE_GEN_MAX_CONCURRENT
  );
  /** persistChannels 闭包内读取最新并发数（避免 state 过期）。 */
  const maxConcurrentRef = useRef(DEFAULT_IMAGE_GEN_MAX_CONCURRENT);
  /** 生图请求超时（秒，60-3600，立即保存）。 */
  const [timeoutSecs, setTimeoutSecs] = useState(
    DEFAULT_IMAGE_GEN_TIMEOUT_SECS
  );
  /** persistChannels 闭包内读取最新超时（避免 state 过期）。 */
  const timeoutSecsRef = useRef(DEFAULT_IMAGE_GEN_TIMEOUT_SECS);
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

  // 弹窗内模型列表（基于草稿的 baseUrl/apiKey）
  const [draftModels, setDraftModels] = useState<Model[]>([]);
  const [draftModelsLoading, setDraftModelsLoading] = useState(false);
  const [draftModelsError, setDraftModelsError] = useState<string | null>(null);

  // 搜索
  const [searchQuery, setSearchQuery] = useState("");

  // 删除渠道确认对话框
  const [channelPendingDeletion, setChannelPendingDeletion] =
    useState<ImageGenChannelValue | null>(null);

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
        IMAGE_GEN_SETTING_CODE
      );
      const settings = readImageGenSettingsJson(raw);
      setChannels(settings.channels);
      setMaxConcurrent(settings.maxConcurrentImages);
      maxConcurrentRef.current = settings.maxConcurrentImages;
      setTimeoutSecs(settings.timeoutSecs);
      timeoutSecsRef.current = settings.timeoutSecs;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.imagegenLoadError", {
              defaultValue: "Failed to load image generation settings",
            })
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
    successMessage?: string
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
        })
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
            })
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
    return t("settings.imagegenChannelOpenai", {
      defaultValue: "OpenAI",
    });
  };

  /** 渠道行内启用/禁用（立即保存）。未配置密钥或模型的渠道不允许启用：
   * 后端只在渠道同时具备 API key 与模型时才向 agent 暴露生图工具。 */
  const toggleEnabled = async (channel: ImageGenChannelValue) => {
    if (isSaving) {
      return;
    }
    if (!channel.enabled && (!channel.model.trim() || !channel.apiKey.trim())) {
      setError(
        t("settings.imagegenToggleMissingModel", {
          defaultValue:
            "Configure an API key and a model for this channel before enabling it — the image generation tool only becomes available when a channel has both.",
        })
      );
      return;
    }
    const next = channels.map((item) =>
      item.id === channel.id ? { ...item, enabled: !item.enabled } : item
    );
    await persistChannels(next);
  };

  /** 打开添加弹窗。 */
  const openAddEditor = () => {
    setError("");
    setStatus("");
    const index = channels.length;
    setDraft({
      ...DEFAULT_IMAGE_GEN_CHANNEL,
      id: generateChannelId("openai", index),
      enabled: true,
    });
    setIsNewChannel(true);
    setDraftModels([]);
    setDraftModelsError(null);
    setEditorOpen(true);
  };

  /** 打开编辑弹窗。 */
  const openEditEditor = (channel: ImageGenChannelValue) => {
    setError("");
    setStatus("");
    setDraft({ ...channel });
    setIsNewChannel(false);
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
            previous.defaultQuality
          )
            ? previous.defaultQuality
            : "",
        };
      }
      if (supportsArbitraryOpenAISize(previous.model)) {
        // gpt-image-2：auto / 任意分辨率均合法，仅修正质量
        return ["", "low", "medium", "high"].includes(previous.defaultQuality)
          ? previous
          : { ...previous, defaultQuality: "" };
      }
      const caps = openaiStandardCaps(previous.model);
      const currentSize = previous.defaultSize.trim();
      return {
        ...previous,
        defaultSize: caps.sizes.includes(currentSize)
          ? previous.defaultSize
          : caps.sizes[0] ?? "",
        defaultQuality: caps.quality.includes(previous.defaultQuality)
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

    const saved: ImageGenChannelValue = {
      ...draft,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim(),
      defaultSize: draft.defaultSize.trim(),
      defaultQuality: draft.defaultQuality.trim(),
      outputFormat: draft.outputFormat.trim(),
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
          }).replace("{name}", channelLabel(saved))
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
      }).replace("{name}", label)
    );
  };

  /** 复制渠道（生成 *-Copy-n 唯一名称与新 id，默认未启用）。 */
  const duplicateChannel = async (channel: ImageGenChannelValue) => {
    if (isSaving) {
      return;
    }
    // 命名规则：*-Copy-n（n 为递增数字，避免与既有渠道名冲突）。
    const sourceName = channel.name.trim() || defaultChannelName(channel.provider);
    const nextName = buildDuplicateName(
      sourceName,
      channels.map((item) => item.name)
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
      }).replace("{name}", channelLabel(cloned))
    );
  };

  /** 弹窗内草稿字段更新。 */
  const updateDraft = <K extends keyof ImageGenChannelValue>(
    field: K,
    value: ImageGenChannelValue[K]
  ) => {
    setDraft((previous) =>
      previous ? { ...previous, [field]: value } : previous
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
    const defaultBaseUrl = isGemini
      ? DEFAULT_GEMINI_BASE_URL
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

  const renderDraftPanel = (): React.JSX.Element => {
    if (!draft) {
      return <></>;
    }
    const isGemini = draft.provider === "gemini";
    const defaultBaseUrl = isGemini
      ? DEFAULT_GEMINI_BASE_URL
      : DEFAULT_OPENAI_BASE_URL;
    const modelPlaceholder = isGemini
      ? GEMINI_MODEL_EXAMPLES
      : OPENAI_MODEL_EXAMPLES;
    const capabilities = getModelCapabilities(draft.model);

    return (
      <div className="imagegen-editor">
        <div className="api-settings-form-grid">
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
              ]}
              onChange={(provider) => {
                updateDraft("provider", provider as ImageGenProvider);
                // 切换服务商时清空对目标不适用且已条件隐藏的字段，
                // 避免残留值在隐藏状态下继续生效而用户无法管理：
                // Gemini 不使用 defaultQuality/outputFormat；
                // OpenAI 不使用 webSearch。
                if (provider === "gemini") {
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

        <div className="imagegen-groups">
          <section className="imagegen-group">
            <h4 className="imagegen-group-title">
              {t("settings.imagegenConnection", {
                defaultValue: "Provider connection",
              })}
            </h4>
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
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={updateDraftEvent("apiKey")}
                  placeholder="sk-..."
                  disabled={draftSaving}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            </div>
          </section>

          <section className="imagegen-group">
            <h4 className="imagegen-group-title">
              {t("settings.imagegenModel", { defaultValue: "Model" })}
            </h4>
            <div className="api-settings-field imagegen-field-wide">
              <ApiModelCombobox
                label={t("settings.imagegenModel", { defaultValue: "Model" })}
                value={draft.model}
                placeholder={modelPlaceholder}
                disabled={draftSaving}
                models={draftModels}
                isLoading={draftModelsLoading}
                error={draftModelsError}
                hasLoaded={draftModels.length > 0 || Boolean(draftModelsError)}
                loadingText={t("settings.imagegenModelsLoading", {
                  defaultValue: "Loading image models...",
                })}
                noModelsText={t("settings.imagegenModelsEmpty", {
                  defaultValue:
                    "No image models found. Check the base URL and API key, or enter the model ID manually.",
                })}
                retryText={t("settings.imagegenModelsRetry", {
                  defaultValue: "Retry",
                })}
                onChange={(modelId) => updateDraft("model", modelId)}
                onRequestModels={() => void requestDraftModels()}
                onRetry={() => void requestDraftModels()}
                knownModels={KNOWN_IMAGE_MODELS.filter(
                  (entry) => entry.provider === draft.provider
                )}
                previewBadgeText={t("settings.imagegenModelPreviewBadge", {
                  defaultValue: "Preview",
                })}
                deprecatedBadgeText={t("settings.imagegenCap.capDeprecated", {
                  defaultValue: "Deprecated",
                })}
              />
              {capabilities.length > 0 ? (
                <span className="imagegen-model-caps">
                  {capabilities.map((cap) => (
                    <span className="imagegen-model-cap" key={cap}>
                      {t(`settings.imagegenCap.${cap}`)}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          </section>

          <section className="imagegen-group">
            <h4 className="imagegen-group-title">
              {t("settings.imagegenDefaults", {
                defaultValue: "Default parameters",
              })}
            </h4>
            <div className="api-settings-form-grid">
              <label className="api-settings-field imagegen-field-wide">
                <span className="api-settings-field-label">
                  {t("settings.imagegenDefaultSize", {
                    defaultValue: "Default size",
                  })}
                </span>
                {isGemini ? (
                  <GeminiSizeControls
                    draft={draft}
                    onUpdate={updateDraft}
                    disabled={draftSaving}
                    t={t}
                  />
                ) : supportsArbitraryOpenAISize(draft.model) ? (
                  <GptImage2SizeControls
                    draft={draft}
                    onUpdate={updateDraft}
                    disabled={draftSaving}
                    t={t}
                  />
                ) : (
                  <div className="imagegen-editor-size-row">
                    <input
                      className="imagegen-size-input"
                      type="text"
                      value={draft.defaultSize}
                      onChange={updateDraftEvent("defaultSize")}
                      placeholder="1024x1024"
                      disabled={draftSaving}
                      spellCheck={false}
                    />
                    <CustomSelect
                      value={
                        openaiStandardCaps(draft.model).sizes.includes(
                          draft.defaultSize.trim()
                        )
                          ? draft.defaultSize.trim()
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
                          openaiStandardCaps(draft.model).sizes
                        ),
                      ]}
                      onChange={(preset) => {
                        if (preset) {
                          updateDraft("defaultSize", preset);
                        }
                      }}
                      disabled={draftSaving}
                      portal
                    />
                  </div>
                )}
                {!isGemini && supportsArbitraryOpenAISize(draft.model) ? (
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

              {/* 默认质量仅 OpenAI 生效（Gemini 仅接受 low/medium/high，面板
                  默认值 "auto" 会被忽略），Gemini 渠道不显示。 */}
              {!isGemini ? (
                <label className="api-settings-field">
                  <span className="api-settings-field-label">
                    {t("settings.imagegenDefaultQuality", {
                      defaultValue: "Default quality",
                    })}
                  </span>
                  <CustomSelect
                    value={draft.defaultQuality}
                    options={openaiStandardCaps(draft.model).quality.map(
                      (value) => ({
                        value,
                        label:
                          value === ""
                            ? t("settings.imagegenQualityAuto", {
                                defaultValue: "Auto",
                              })
                            : value,
                      })
                    )}
                    onChange={(value) => updateDraft("defaultQuality", value)}
                    disabled={draftSaving}
                    portal
                  />
                </label>
              ) : null}

              {/* 输出格式仅 OpenAI 生效（Gemini 忽略），Gemini 渠道不显示。 */}
              {!isGemini ? (
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
              ) : null}
            </div>
          </section>

          <section className="imagegen-group">
            <h4 className="imagegen-group-title">
              {t("settings.imagegenAdvanced", {
                defaultValue: "Advanced",
              })}
            </h4>
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
                          "Gemini only: let Imagen use real-time web information",
                      })}
                    </small>
                  </span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={draft.webSearch}
                      onChange={updateDraftEvent("webSearch")}
                      disabled={draftSaving}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              ) : null}

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
          </section>
        </div>
      </div>
    );
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.imagegenSettings", {
              defaultValue: "Image generation",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.imagegenDescription", {
              defaultValue:
                "Configure independent OpenAI/Gemini channels; the agent picks one per request. Hidden when none configured.",
            })}
          </span>
        </div>
        {onClose ? (
          <button
            type="button"
            className="icon-btn ghost"
            onClick={onClose}
            aria-label={t("settings.closeImagegenSettings", {
              defaultValue: "Close image generation settings",
            })}
            title={t("settings.closeImagegenSettings", {
              defaultValue: "Close image generation settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        ) : null}
      </div>

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
              −
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
      </div>

      {/* 操作区：搜索 + 添加渠道（与 API 设置页交互一致） */}
      <div className="imagegen-actions">
        <div className="api-settings-table-search imagegen-search">
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
            disabled={isBusy && channels.length === 0}
          />
        </div>
        <button
          type="button"
          className="api-settings-form-btn primary imagegen-add-btn"
          onClick={openAddEditor}
          disabled={isBusy}
        >
          <Plus size={13} strokeWidth={2} aria-hidden="true" />
          {t("settings.imagegenAddChannel", {
            defaultValue: "Add channel",
          })}
        </button>
      </div>

      {/* 渠道表格：复用 API 设置表格样式 */}
      <div className="api-settings-table-panel imagegen-table-panel">
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
                  <th>
                    {t("settings.tableStatus", { defaultValue: "Status" })}
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
                  return (
                    <tr key={channel.id}>
                      <td className="cell-name">
                        <strong>{channelLabel(channel)}</strong>
                        <small className="profile-name-hint">
                          {channel.id}
                        </small>
                      </td>
                      <td className="cell-url">
                        {channel.baseUrl.trim() ||
                          t("settings.imagegenDefaultEndpoint", {
                            defaultValue: "Provider default",
                          })}
                      </td>
                      <td>{channel.model || "-"}</td>
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
                            : t("settings.imagegenProviderOpenai", {
                                defaultValue: "OpenAI",
                              })}
                        </span>
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
                      <td className="api-settings-table-actions-col">
                        <div className="api-settings-table-actions">
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
      </div>

      <Modal
        open={editorOpen}
        title={
          isNewChannel
            ? t("settings.imagegenAddChannelTitle", {
                defaultValue: "Add channel",
              })
            : t("settings.imagegenEditChannelTitle", {
                defaultValue: "Edit channel",
              })
        }
        description={t("settings.imagegenEditorInfo", {
          defaultValue:
            "Each channel is fully independent: provider, base URL, API key, model and defaults.",
        })}
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={closeEditor}
        closeDisabled={draftSaving}
        size="large"
        className="imagegen-editor-modal"
        footer={
          <div className="api-settings-form-actions imagegen-editor-actions">
            <button
              type="button"
              className="api-settings-form-btn secondary"
              onClick={closeEditor}
              disabled={draftSaving}
            >
              {t("settings.cancel", { defaultValue: "Cancel" })}
            </button>
            <button
              type="button"
              className="api-settings-form-btn primary"
              onClick={() => void saveDraft()}
              disabled={draftSaving || !draft}
            >
              {draftSaving ? (
                <Loader2
                  className="tool-call-icon-spinning"
                  size={13}
                  aria-hidden="true"
                />
              ) : (
                <Plus size={13} strokeWidth={2} aria-hidden="true" />
              )}
              {isNewChannel
                ? t("settings.imagegenAddChannel", {
                    defaultValue: "Add channel",
                  })
                : t("settings.imagegenSaveChannel", {
                    defaultValue: "Save channel",
                  })}
            </button>
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
