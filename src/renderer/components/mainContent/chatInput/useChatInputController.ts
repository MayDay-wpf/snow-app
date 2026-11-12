import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BrainCircuit } from "lucide-react";
import type { ApiConfigRecord, Model } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { isImeComposing } from "../../../../shared/imeKeyboard";
import { shortcutEvents } from "../../shortcutEvents";
import {
  PLUGIN_INSERT_INPUT_TEXT_EVENT,
  PLUGIN_SEND_INPUT_MESSAGE_EVENT,
} from "../../../plugins/pluginEvents";
import {
  DEFAULT_THINKING_VALUE,
  THINKING_OPTIONS_BY_METHOD,
} from "./constants";
import {
  getResponsesFastModeFromConfig,
  getThinkingValueFromConfig,
  normalizeRequestMethod,
} from "./configThinking";
import { markPluginDraftChanged } from "../../../plugins/pluginDraft";
import { resolveAutoSendOptions } from "./autoSendOptions";
import { useSendKeyMode } from "./useSendKeyMode";
import {
  useBusySendBehavior,
  type BusySendBehavior,
} from "../../../constants/busySendBehavior";
import type {
  AutoSendRequest,
  ChatInputActions,
  ChatInputSendOptions,
  ChatInputState,
  ConversationInputRuntimeState,
  ModelMenuView,
} from "./types";
import {
  buildSegmentsHtml,
  isEditableContentEmpty,
  parseContentSegments,
  placeCaretAtEditableEnd,
  renumberImageChips,
} from "./fileTagUtils";
import { getEditableHistory } from "./editableHistory";
type UseChatInputControllerParams = {
  projectId?: string;
  conversationId?: string;
  onSend?: (message: string, options: ChatInputSendOptions) => void;
  isStreaming?: boolean;
  isAborting?: boolean;
  onAbort?: () => void;
  draftToRestore?: string | null;
  onDraftRestored?: () => void;
  autoSendRequest?: AutoSendRequest | null;
  claimAutoSend?: (id: number) => boolean;
  completeAutoSend?: (id: number) => void;
  saveInputDraft?: (
    conversationId: string | undefined,
    content: string,
  ) => void;
  getInputDraft?: (conversationId: string | undefined) => string | undefined;
  clearInputDraft?: (conversationId: string | undefined) => void;
  rollbackInputState?: ConversationInputRuntimeState | null;
  onRuntimeInputStateChange?: (state: ConversationInputRuntimeState) => void;
  /**
   * 读取指定会话的内存态输入选择（渠道/模型/思考强度/Fast Mode）。
   * 内存态是本次运行的权威值：切换后尚未发送的选择必须在会话切换后保留，
   * 因此 hydration 时优先于数据库里的持久化快照。
   */
  getRuntimeInputState?: (
    conversationId: string,
  ) => ConversationInputRuntimeState | undefined;
};

type UseChatInputControllerResult = ChatInputState & ChatInputActions;

/** 聚焦可编辑元素并把光标落到内容末尾 */
const focusEditableAtEnd = (element: HTMLElement | null): void => {
  if (!element) {
    return;
  }
  element.focus();
  placeCaretAtEditableEnd(element);
};

export const useChatInputController = ({
  projectId,
  conversationId,
  onSend,
  isStreaming = false,
  isAborting = false,
  onAbort,
  draftToRestore = null,
  onDraftRestored,
  autoSendRequest = null,
  claimAutoSend,
  completeAutoSend,
  saveInputDraft,
  getInputDraft,
  clearInputDraft,
  rollbackInputState,
  onRuntimeInputStateChange,
  getRuntimeInputState,
}: UseChatInputControllerParams): UseChatInputControllerResult => {
  const { t } = useI18n();
  const { sendKeyMode, setSendKeyMode } = useSendKeyMode();
  const { behavior: busySendBehavior } = useBusySendBehavior();
  const [value, setInputValue] = useState("");
  const textareaRef = useRef<HTMLDivElement>(null);
  const setValue = useCallback((content: string): void => {
    markPluginDraftChanged(textareaRef.current);
    setInputValue(content);
  }, []);
  // Mirrors `value` so unmount cleanup can save the latest draft without
  // stale closure captures.
  const latestValueRef = useRef(value);
  latestValueRef.current = value;

  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isManualMode, setIsManualMode] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [runtimeApiConfig, setRuntimeApiConfig] =
    useState<ApiConfigRecord | null>(null);
  // All available API config profiles. The selected one is conversation-
  // scoped: switching it here never mutates the global profile settings.
  const [apiConfigs, setApiConfigs] = useState<ApiConfigRecord[]>([]);
  const [selectedApiProfile, setSelectedApiProfile] = useState<string>("");
  const [modelMenuView, setModelMenuView] = useState<ModelMenuView>("root");
  const [isSubAgentConversation, setIsSubAgentConversation] = useState(false);
  const [isLoadingApiConfig, setIsLoadingApiConfig] = useState(true);
  // `thinkingOverride` is the nullable conversation-level value represented
  // by an empty string in the menu; effectiveThinkingValue is derived below
  // from the selected profile when this is empty.
  const [thinkingOverride, setThinkingOverride] = useState("");
  const [thinkingError, setThinkingError] = useState<string | null>(null);
  const [responsesFastModeOverride, setResponsesFastModeOverride] = useState<
    string | null
  >(null);
  const [fastModeError, setFastModeError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Hydration/model requests are scoped to the current project + conversation.
  // A token is stronger than a cancelled flag when the same mounted instance
  // receives a new target before an older model request resolves.
  const hydrationRequestTokenRef = useRef(0);

  const labels = useMemo(
    () => ({
      selectModel: t("chat.selectModel", { defaultValue: "Select model" }),
      selectApiProfile: t("chat.selectApiProfile", {
        defaultValue: "Provider",
      }),
      loadModelsError: t("chat.loadModelsError", {
        defaultValue: "Failed to load models",
      }),
      loadingModels: t("chat.loadingModels", {
        defaultValue: "Loading models...",
      }),
      refreshModels: t("chat.refreshModels", {
        defaultValue: "Refresh models",
      }),
      manualModel: t("chat.manualModel", {
        defaultValue: "Enter model manually",
      }),
      manualModelPlaceholder: t("chat.manualModelPlaceholder", {
        defaultValue: "e.g. gpt-4.1",
      }),
      noModelsFound: t("chat.noModelsFound", {
        defaultValue: "No models found",
      }),
      searchModels: t("chat.searchModels", {
        defaultValue: "Search models",
      }),
      noMatchingModels: t("chat.noMatchingModels", {
        defaultValue: "No matching models",
      }),
      searchApiProfiles: t("chat.searchApiProfiles", {
        defaultValue: "Search providers",
      }),
      noMatchingApiProfiles: t("chat.noMatchingApiProfiles", {
        defaultValue: "No matching providers",
      }),
      cancel: t("common.cancel", { defaultValue: "Cancel" }),
      confirm: t("common.confirm", { defaultValue: "Confirm" }),
      retry: t("common.retry", { defaultValue: "Retry" }),
      noApiConfig: t("chat.noApiConfig", {
        defaultValue:
          "No API configuration found. Please configure one in Settings first.",
      }),
    }),
    [t],
  );

  useEffect(() => {
    const requestToken = ++hydrationRequestTokenRef.current;
    let cancelled = false;
    const isCurrentRequest = (): boolean =>
      !cancelled && hydrationRequestTokenRef.current === requestToken;

    // Clear every conversation-bound value before starting asynchronous work.
    // This prevents the previous target from being displayed during hydration.
    setApiConfigs([]);
    setSelectedApiProfile("");
    setRuntimeApiConfig(null);
    setSelectedModel("");
    setModels([]);
    setIsLoadingModels(false);
    setModelError(null);
    setThinkingOverride("");
    setResponsesFastModeOverride(null);
    setThinkingError(null);
    setFastModeError(null);
    setIsModelMenuOpen(false);
    setIsManualMode(false);
    setManualValue("");
    setModelMenuView("root");
    setIsSubAgentConversation(false);
    setIsLoadingApiConfig(true);

    const loadRuntimeApiConfig = async (): Promise<void> => {
      try {
        const [configs, conversation, runtimeOverride] = await Promise.all([
          window.snow.listApiConfigs(),
          conversationId
            ? window.snow.getChatConversation(conversationId)
            : Promise.resolve(null),
          conversationId
            ? window.snow.getConversationRuntimeConfig(conversationId)
            : Promise.resolve(null),
        ]);
        if (!isCurrentRequest()) {
          return;
        }

        // Resolve the conversation-scoped profile from its persisted binding.
        // Sub-agent history is strict; main chats retain the active-profile
        // fallback for legacy rows without a binding.
        const subAgentConversation =
          conversation?.conversationType === "sub_agent";
        const rollbackState = !conversationId ? rollbackInputState : null;
        // 内存态选择（尚未随发送落库）优先于数据库快照：切换会话后必须
        // 保留用户刚刚做出的选择，而不是回退到上次持久化的旧值。
        const inMemoryState = conversationId
          ? getRuntimeInputState?.(conversationId)
          : undefined;
        const requestedProfile =
          rollbackState?.apiProfile?.trim() ||
          inMemoryState?.apiProfile?.trim() ||
          conversation?.apiProfileName?.trim() ||
          "";
        let runtimeConfig: ApiConfigRecord | null = null;
        if (requestedProfile) {
          runtimeConfig =
            configs.find((config) => config.profileName === requestedProfile) ??
            null;
          if (!runtimeConfig && !subAgentConversation) {
            runtimeConfig =
              configs.find((config) => config.isActive) ?? configs[0] ?? null;
          }
        } else {
          runtimeConfig =
            configs.find((config) => config.isActive) ?? configs[0] ?? null;
        }

        if (!runtimeConfig) {
          if (configs.length === 0 && !subAgentConversation) {
            throw new Error("NO_API_CONFIG");
          }
          throw new Error(
            requestedProfile
              ? `API profile is not available: ${requestedProfile}`
              : "No API configuration found",
          );
        }

        const rememberedModel =
          rollbackState?.model?.trim() ||
          inMemoryState?.model?.trim() ||
          conversation?.model?.trim() ||
          "";
        const persistedThinkingOverride = rollbackState
          ? rollbackState.thinkingStrength
          : inMemoryState
            ? inMemoryState.thinkingStrength
            : (runtimeOverride?.thinkingStrength ?? null);
        const persistedFastModeOverride = rollbackState
          ? rollbackState.responsesFastMode
          : inMemoryState
            ? inMemoryState.responsesFastMode
            : (runtimeOverride?.responsesFastMode ?? null);

        setApiConfigs(configs);
        setIsSubAgentConversation(subAgentConversation);
        setSelectedApiProfile(runtimeConfig.profileName);
        setRuntimeApiConfig(runtimeConfig);
        setSelectedModel(rememberedModel || runtimeConfig.advancedModel || "");
        setThinkingOverride(persistedThinkingOverride ?? "");
        setResponsesFastModeOverride(persistedFastModeOverride);
      } catch (error) {
        if (!isCurrentRequest()) {
          return;
        }

        const message =
          error instanceof Error
            ? error.message === "NO_API_CONFIG"
              ? labels.noApiConfig
              : error.message
            : "Failed to load API configuration";
        setApiConfigs([]);
        setRuntimeApiConfig(null);
        setSelectedApiProfile("");
        setSelectedModel("");
        setModels([]);
        setThinkingOverride("");
        setResponsesFastModeOverride(null);
        setModelError(message);
        setThinkingError(message);
        setFastModeError(message);
      } finally {
        if (isCurrentRequest()) {
          setIsLoadingApiConfig(false);
        }
      }
    };

    void loadRuntimeApiConfig();

    return () => {
      cancelled = true;
      if (hydrationRequestTokenRef.current === requestToken) {
        hydrationRequestTokenRef.current += 1;
      }
    };
  }, [
    conversationId,
    projectId,
    labels,
    rollbackInputState,
    getRuntimeInputState,
  ]);

  useEffect(() => {
    if (isLoadingApiConfig || !onRuntimeInputStateChange) {
      return;
    }
    onRuntimeInputStateChange({
      model: selectedModel,
      apiProfile: selectedApiProfile,
      thinkingStrength: thinkingOverride === "" ? null : thinkingOverride,
      responsesFastMode: responsesFastModeOverride,
    });
  }, [
    isLoadingApiConfig,
    onRuntimeInputStateChange,
    responsesFastModeOverride,
    selectedApiProfile,
    selectedModel,
    thinkingOverride,
  ]);

  const loadModels = useCallback(
    async (force = false, configOverride?: ApiConfigRecord | null) => {
      if (isLoadingModels || (!force && (models.length > 0 || modelError))) {
        return;
      }

      const requestToken = hydrationRequestTokenRef.current;
      const configAtRequest = configOverride ?? runtimeApiConfig;
      setIsLoadingModels(true);
      setModelError(null);

      try {
        if (!configAtRequest) {
          throw new Error("API configuration is not available");
        }

        const availableModels = await window.snow.fetchAvailableModelsForConfig(
          {
            baseUrl: configAtRequest.baseUrl,
            baseUrlMode: configAtRequest.baseUrlMode,
            apiKey: configAtRequest.apiKey,
            requestMethod: configAtRequest.requestMethod,
            customHeaderSchemeId: configAtRequest.customHeaderSchemeId,
            configJson: configAtRequest.configJson.trim() || undefined,
            profileName: configAtRequest.profileName,
          },
        );
        if (hydrationRequestTokenRef.current !== requestToken) {
          return;
        }

        setModels(availableModels);
        if (availableModels.length > 0) {
          setSelectedModel(
            (currentModel) =>
              currentModel ||
              configAtRequest.advancedModel ||
              availableModels[0].id,
          );
        }
      } catch (error) {
        if (hydrationRequestTokenRef.current !== requestToken) {
          return;
        }
        setModelError(
          error instanceof Error ? error.message : labels.loadModelsError,
        );
      } finally {
        if (hydrationRequestTokenRef.current === requestToken) {
          setIsLoadingModels(false);
        }
      }
    },
    [
      runtimeApiConfig,
      isLoadingModels,
      labels.loadModelsError,
      modelError,
      models.length,
    ],
  );

  // runtimeApiConfig 就绪或渠道切换后自动预拉模型列表：手机远控与任何依赖
  // modelIds 的场景不应要求用户先在桌面打开过模型菜单。按“渠道 + 请求方式”
  // 去重（同一实例内不重复拉取；会话重挂载 / 换渠道后各拉一次），force 覆盖
  // “上次失败未重试”的情况；依赖仅 runtimeApiConfig，避免失败重试风暴。
  const modelPrefetchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!runtimeApiConfig) return;
    const key = `${runtimeApiConfig.profileName}|${runtimeApiConfig.requestMethod}`;
    if (modelPrefetchKeyRef.current === key) return;
    modelPrefetchKeyRef.current = key;
    void loadModels(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeApiConfig]);

  useEffect(() => {
    if (isStreaming && isModelMenuOpen) {
      setIsModelMenuOpen(false);
      setIsManualMode(false);
    }
  }, [isStreaming, isModelMenuOpen]);

  // 菜单关闭时重置二级视图
  useEffect(() => {
    if (!isModelMenuOpen) {
      setModelMenuView("root");
    }
  }, [isModelMenuOpen]);

  useEffect(() => {
    if (!isModelMenuOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      // 编辑弹窗等 Modal 打开时，点击 Modal 内部不应关闭背后的模型菜单
      const isInModal =
        event.target instanceof Element &&
        event.target.closest(".app-modal-overlay") != null;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        !isInModal
      ) {
        setIsModelMenuOpen(false);
        setIsManualMode(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isModelMenuOpen]);

  const adjustHeight = useCallback(() => {
    // contenteditable 随内容自然伸缩，行数上下限由 CSS 约束。
    // 仅清除历史内联高度：写入固定高度前会先置 auto，该瞬时塌缩会
    // 改变聊天区 clientHeight 并钳制 scrollTop，导致流式输出跳动
    textareaRef.current?.style.removeProperty("height");
  }, []);

  // 程序化自动发送（buildFromContent 队首请求）：只发送，绝不写进输入框——
  // 写进去会在输入区实例重建时被卸载快照存成草稿，又被新实例的草稿恢复逻辑
  // 写回输入框（表现为消息发出后提示词仍留在输入框）。claim 保证同一请求只被
  // 一个输入区实例发送一次，发送后 complete 才激活下一条请求。
  useEffect(() => {
    if (!autoSendRequest || !claimAutoSend?.(autoSendRequest.id)) {
      return;
    }
    const request = autoSendRequest;
    const autoSendTextarea = textareaRef.current;
    if (autoSendTextarea) {
      autoSendTextarea.innerHTML = "";
      autoSendTextarea.dataset.empty = "true";
      getEditableHistory(autoSendTextarea)?.reset();
      adjustHeight();
    }
    setValue("");
    clearInputDraft?.(conversationId);
    requestAnimationFrame(() => {
      const message = request.content.trim();
      if (message) {
        onSend?.(
          message,
          resolveAutoSendOptions({
            apiConfigs,
            selectedModel,
            selectedApiProfile,
          }),
        );
      }
      completeAutoSend?.(request.id);
    });
  }, [
    autoSendRequest,
    claimAutoSend,
    completeAutoSend,
    adjustHeight,
    onSend,
    apiConfigs,
    selectedModel,
    selectedApiProfile,
    conversationId,
    clearInputDraft,
  ]);

  useEffect(() => {
    if (draftToRestore === null) {
      return;
    }

    setValue(draftToRestore);

    const textarea = textareaRef.current;
    if (textarea) {
      const html = buildSegmentsHtml(parseContentSegments(draftToRestore));

      textarea.innerHTML = html;
      // 固定 chip 宽度，确保 hover 显示 remove 按钮时布局不跳动、
      // 名字能正确省略。与新输入时 syncContent -> renumberImageChips 一致。
      renumberImageChips(textarea);
      textarea.dataset.empty = isEditableContentEmpty(draftToRestore)
        ? "true"
        : "false";
      // 回滚写回可撤销，撤销后回到写回前的输入
      getEditableHistory(textarea)?.record();
      // 回滚消息已回写：同步清除该会话的旧草稿。否则 onDraftRestored 把
      // draftToRestore 置回 null 后，草稿恢复 effect 会用回滚前的输入内容
      // 覆盖刚回写的消息（输入框非空时回滚即触发，表现为"消息有概率无法回写"）。
      clearInputDraft?.(conversationId);
      requestAnimationFrame(() => {
        adjustHeight();
        focusEditableAtEnd(textarea);
      });
    }

    onDraftRestored?.();
  }, [
    draftToRestore,
    onDraftRestored,
    adjustHeight,
    conversationId,
    clearInputDraft,
  ]);

  const handleChange = useCallback(
    (nextValue: string) => {
      setValue(nextValue);
      // Persist the draft so it survives ChatInput instance rebuilds on
      // conversation switches / new-chat.
      saveInputDraft?.(conversationId, nextValue);
      adjustHeight();
    },
    [adjustHeight, conversationId, saveInputDraft],
  );

  // resetHistory：切换会话恢复草稿时清空撤销栈；其余整体替换记为可撤销一步
  const restoreContent = useCallback(
    (content: string, options?: { resetHistory?: boolean }) => {
      setValue(content);
      // 同步镜像：/clear 会令 ChatInput 因 key 变化重建，重建前若只靠
      // setValue 的异步更新，卸载清理会用旧值（如过滤词 /clear）把残留
      // 写回草稿池并在重建后恢复出来。这里立即同步 latestValueRef。
      latestValueRef.current = content;
      saveInputDraft?.(conversationId, content);

      if (textareaRef.current) {
        const html = buildSegmentsHtml(parseContentSegments(content));

        textareaRef.current.innerHTML = html;
        renumberImageChips(textareaRef.current);
        textareaRef.current.dataset.empty = isEditableContentEmpty(content)
          ? "true"
          : "false";
        const history = getEditableHistory(textareaRef.current);
        if (options?.resetHistory) {
          history?.reset();
        } else {
          history?.record();
        }
        requestAnimationFrame(() => {
          adjustHeight();
          focusEditableAtEnd(textareaRef.current);
        });
      }
    },
    [adjustHeight, textareaRef, conversationId, saveInputDraft, setValue],
  );

  // --- Per-conversation draft persistence ---
  // ChatInput 实例随会话切换（key 变化）而重建，卸载时草稿存入
  // per-conversation 草稿池；新实例挂载后——或 conversationId prop 变化
  // 而实例未重建时——恢复目标会话的草稿。Rollback 草稿（draftToRestore）
  // 与待投递的自动发送优先，由上面的 effect 处理。
  useEffect(() => {
    if (draftToRestore !== null || autoSendRequest !== null) {
      return;
    }
    const draft = getInputDraft?.(conversationId);
    if (draft) {
      restoreContent(draft, { resetHistory: true });
    }
  }, [
    conversationId,
    draftToRestore,
    autoSendRequest,
    getInputDraft,
    restoreContent,
  ]);

  // Save the current input when the component unmounts or the conversation
  // changes, so nothing typed is lost (latestValueRef avoids stale closures).
  useEffect(() => {
    return () => {
      saveInputDraft?.(conversationId, latestValueRef.current);
    };
  }, [conversationId, saveInputDraft]);

  // 新会话视图挂载后聚焦输入框：/clear 或点击新建对话都会使 ChatInput
  // 因 key 变化重建，重建后需主动把焦点还给输入框，否则用户要再点一次。
  useEffect(() => {
    if (conversationId == null) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
    // 仅挂载时执行一次；conversationId 在同一实例生命周期内稳定（key 含其值）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestMethod = normalizeRequestMethod(runtimeApiConfig?.requestMethod);
  const thinkingOptions = THINKING_OPTIONS_BY_METHOD[requestMethod];
  const profileThinkingValue = runtimeApiConfig
    ? getThinkingValueFromConfig(runtimeApiConfig)
    : DEFAULT_THINKING_VALUE;
  const effectiveThinkingValue =
    thinkingOverride === "" ? profileThinkingValue : thinkingOverride;
  const profileThinkingOption = thinkingOptions.find(
    (option) => option.value === profileThinkingValue,
  );
  const thinkingDefaultLabel =
    profileThinkingOption?.label ?? profileThinkingValue;
  const profileResponsesFastMode = runtimeApiConfig
    ? getResponsesFastModeFromConfig(runtimeApiConfig)
    : "off";
  // Do not use truthy fallback here: an explicit conversation override must
  // remain distinct from `null` (inherit profile default).
  const responsesFastMode =
    responsesFastModeOverride !== null
      ? responsesFastModeOverride
      : profileResponsesFastMode;

  const handleSend = useCallback(
    (deliveryMode?: BusySendBehavior, origin: "user" | "internal" = "user") => {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }

      // 未配置任何 API（初次安装）时阻止发送，避免直接落到后端报错；
      // 引导提示由 ChatInputView 的空配置条展示。
      if (apiConfigs.length === 0 || !runtimeApiConfig) {
        return;
      }

      // The selected profile is conversation-scoped: for a brand-new
      // conversation it is carried on the request so the backend binds the
      // created conversation to this provider; for existing conversations the
      // binding is already persisted and the backend resolves it automatically.
      onSend?.(trimmed, {
        origin,
        deliveryMode:
          isStreaming || isAborting
            ? (deliveryMode ?? busySendBehavior)
            : undefined,
        model: selectedModel || undefined,
        apiProfile: selectedApiProfile || undefined,
        // Manual sends carry effective values so the agent loop captures the
        // exact settings used by this turn. The snapshot is separate: null means
        // the conversation follows the current profile default.
        thinkingStrength: effectiveThinkingValue,
        responsesFastMode:
          requestMethod === "responses" ? responsesFastMode : null,
        conversationRuntimeConfigOverride: {
          thinkingStrength: thinkingOverride === "" ? null : thinkingOverride,
          responsesFastMode: responsesFastModeOverride,
        },
      });
      setValue("");
      // The message was handed off to the agent loop; the draft must not be
      // restored when switching back to this conversation.
      clearInputDraft?.(conversationId);

      if (textareaRef.current) {
        textareaRef.current.innerHTML = "";
        textareaRef.current.dataset.empty = "true";
        getEditableHistory(textareaRef.current)?.reset();
        requestAnimationFrame(() => {
          adjustHeight();
        });
      }
    },
    [
      adjustHeight,
      apiConfigs.length,
      clearInputDraft,
      conversationId,
      effectiveThinkingValue,
      busySendBehavior,
      isStreaming,
      isAborting,
      runtimeApiConfig,
      onSend,
      requestMethod,
      responsesFastMode,
      responsesFastModeOverride,
      selectedApiProfile,
      selectedModel,
      thinkingOverride,
      value,
    ],
  );

  const sendRef = useRef(handleSend);

  useEffect(() => {
    sendRef.current = handleSend;
  }, [handleSend]);

  useEffect(() => {
    const insertHandler = (event: Event): void => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail;
      const text = typeof detail?.text === "string" ? detail.text : "";
      if (!text) {
        return;
      }
      const current = latestValueRef.current ?? "";
      restoreContent(current ? `${current}${text}` : text);
    };
    const sendHandler = (event: Event): void => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail;
      const text = typeof detail?.text === "string" ? detail.text.trim() : "";
      if (text) {
        restoreContent(text);
      }
      window.setTimeout(() => {
        sendRef.current("queue", "internal");
      }, 0);
    };
    window.addEventListener(PLUGIN_INSERT_INPUT_TEXT_EVENT, insertHandler);
    window.addEventListener(PLUGIN_SEND_INPUT_MESSAGE_EVENT, sendHandler);
    return () => {
      window.removeEventListener(PLUGIN_INSERT_INPUT_TEXT_EVENT, insertHandler);
      window.removeEventListener(PLUGIN_SEND_INPUT_MESSAGE_EVENT, sendHandler);
    };
  }, [restoreContent]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" || isImeComposing(event)) {
        return;
      }
      const hasMod = event.ctrlKey || event.metaKey;
      const isSendCombo =
        !event.altKey &&
        (sendKeyMode === "ctrlEnter"
          ? hasMod && !event.shiftKey
          : !hasMod && !event.shiftKey);
      const isAlternateCombo =
        !event.altKey &&
        hasMod &&
        (sendKeyMode === "ctrlEnter" ? event.shiftKey : !event.shiftKey);
      const busy = isStreaming || isAborting;
      if (!isSendCombo && !(busy && isAlternateCombo)) {
        return;
      }

      event.preventDefault();
      handleSend(
        busy && isAlternateCombo
          ? busySendBehavior === "queue"
            ? "steer"
            : "queue"
          : undefined,
      );
    },
    [handleSend, sendKeyMode, isStreaming, isAborting, busySendBehavior],
  );

  const handleSelectModel = useCallback(async (modelId: string) => {
    setSelectedModel(modelId);
    setIsModelMenuOpen(false);
    setIsManualMode(false);
    // Conversation-scoped model selection: the model is remembered on the
    // conversation row by the backend on the next exchange. It intentionally
    // does NOT mutate the profile's global advanced_model — that default
    // stays editable in the API settings panel.
  }, []);

  const handleOpenManualMode = useCallback(() => {
    setIsManualMode(true);
    setManualValue(selectedModel);
  }, [selectedModel]);

  const handleConfirmManualModel = useCallback(async () => {
    const trimmed = manualValue.trim();
    if (trimmed) {
      setSelectedModel(trimmed);
    }
    setIsManualMode(false);
    setIsModelMenuOpen(false);
  }, [manualValue]);

  const handleManualKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (isImeComposing(event)) {
          return;
        }

        event.preventDefault();
        void handleConfirmManualModel();
      } else if (event.key === "Escape") {
        setIsManualMode(false);
      }
    },
    [handleConfirmManualModel],
  );

  const handleRetryFetchModels = useCallback(async () => {
    await loadModels(true);
  }, [loadModels]);

  // 渠道编辑弹窗保存后同步最新配置：刷新列表，若命中当前渠道则强制重拉模型
  const handleApiConfigSaved = useCallback(
    (
      configs: ApiConfigRecord[],
      previousProfileName: string | null,
      savedProfileName: string,
    ) => {
      setApiConfigs(configs);
      const renamedSelected =
        previousProfileName !== null &&
        previousProfileName === selectedApiProfile &&
        previousProfileName !== savedProfileName;
      if (renamedSelected) {
        setSelectedApiProfile(savedProfileName);
        if (conversationId && !isSubAgentConversation) {
          // 渠道被重命名后，已持久化的旧绑定名会失效；这里同步修复一次，
          // 避免摘要等读取持久绑定的路径找不到该渠道。
          void window.snow
            .updateConversationApiProfile(conversationId, savedProfileName)
            .catch(() => {
              // 修复失败不阻断保存流程，下次发送会重新写入绑定。
            });
        }
      }
      if (savedProfileName !== selectedApiProfile && !renamedSelected) {
        return;
      }
      const record = configs.find(
        (config) => config.profileName === savedProfileName,
      );
      if (!record) {
        return;
      }
      // 让仍在飞行中的旧 key 模型请求作废，避免其晚到后覆盖新结果
      hydrationRequestTokenRef.current += 1;
      setRuntimeApiConfig(record);
      setModels([]);
      setModelError(null);
      void loadModels(true, record);
    },
    [selectedApiProfile, conversationId, isSubAgentConversation, loadModels],
  );

  const handleToggleModelMenu = useCallback(() => {
    setIsModelMenuOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        // 列表为空（首次打开或上次加载失败）时强制重拉：非 force 路径在
        // modelError 存在时会跳过，否则一次失败后菜单将永远为空。
        void loadModels(models.length === 0);
      }
      return nextOpen;
    });
  }, [loadModels, models.length]);

  // Switch the conversation-scoped API profile. A profile switch starts a new
  // runtime snapshot: old thinking/Fast overrides are never migrated. The
  // selection lives in memory until the next send persists it (same lifecycle
  // as the model), so switching alone never writes to the database.
  const handleSelectApiProfile = useCallback(
    (profileName: string) => {
      const nextConfig = apiConfigs.find(
        (config) => config.profileName === profileName,
      );
      if (!nextConfig) {
        return;
      }
      if (profileName === selectedApiProfile) {
        setIsModelMenuOpen(false);
        setModelMenuView("root");
        return;
      }

      // Invalidate an in-flight model request for the previous profile.
      hydrationRequestTokenRef.current += 1;

      setSelectedApiProfile(profileName);
      setIsModelMenuOpen(false);
      setModelMenuView("root");
      setRuntimeApiConfig(nextConfig);
      setModels([]);
      setIsLoadingModels(false);
      setModelError(null);
      setThinkingError(null);
      setFastModeError(null);
      setSelectedModel(nextConfig.advancedModel || "");
      setThinkingOverride("");
      setResponsesFastModeOverride(null);
    },
    [apiConfigs, selectedApiProfile],
  );

  // Open the API profile picker (a sub-view of the model menu). Driven by the
  // Alt+P / Ctrl+P shortcut; no-op while a conversation is streaming, for
  // sub-agent conversations (their provider is fixed by the agent config),
  // or when no API profile exists.
  const handleOpenApiProfileMenu = useCallback((): void => {
    if (isStreaming || isSubAgentConversation || apiConfigs.length === 0) {
      return;
    }
    setIsModelMenuOpen(true);
    setModelMenuView("apiProfile");
  }, [apiConfigs.length, isStreaming, isSubAgentConversation]);

  useEffect(() => {
    return shortcutEvents.on("open-api-profile-menu", handleOpenApiProfileMenu);
  }, [handleOpenApiProfileMenu]);

  // 聚焦输入框（Ctrl/Cmd+I 快捷键触发）：焦点移到内容末尾，便于直接输入。
  const handleFocusInput = useCallback((): void => {
    focusEditableAtEnd(textareaRef.current);
  }, [textareaRef]);

  useEffect(() => {
    return shortcutEvents.on("focus-chat-input", handleFocusInput);
  }, [handleFocusInput]);

  useEffect(() => {
    return shortcutEvents.on("send-message", handleSend);
  }, [handleSend]);

  const activeThinkingOption = useMemo(() => {
    const matchingOption = thinkingOptions.find(
      (option) => option.value === effectiveThinkingValue,
    );

    return {
      label: matchingOption?.label ?? effectiveThinkingValue,
      icon: matchingOption?.icon ?? BrainCircuit,
    };
  }, [effectiveThinkingValue, thinkingOptions]);

  const handleSelectThinking = useCallback(
    (nextValue: string) => {
      if (!runtimeApiConfig) {
        return;
      }

      setThinkingOverride(nextValue);
      setIsModelMenuOpen(false);
      setThinkingError(null);
    },
    [runtimeApiConfig],
  );

  const handleSelectResponsesFastMode = useCallback(
    (tier: string): void => {
      if (
        !runtimeApiConfig ||
        requestMethod !== "responses" ||
        isStreaming ||
        isSubAgentConversation
      ) {
        return;
      }

      // Selection is always an explicit tier override (including "off"), so it
      // never silently inherits the profile default. Persisted on the next send.
      setResponsesFastModeOverride(tier);
      setFastModeError(null);
      setIsModelMenuOpen(false);
    },
    [isStreaming, isSubAgentConversation, requestMethod, runtimeApiConfig],
  );

  useLayoutEffect(() => {
    adjustHeight();
  }, [adjustHeight]);

  const displayModel = selectedModel || labels.selectModel;

  return {
    value,
    textareaRef,
    apiConfigs,
    selectedApiProfile,
    modelMenuView,
    isSubAgentConversation,
    models,
    selectedModel,
    displayModel,
    isLoadingModels,
    modelError,
    isModelMenuOpen,
    isManualMode,
    manualValue,
    dropdownRef,
    runtimeApiConfig,
    requestMethod,
    thinkingOptions,
    thinkingValue: thinkingOverride,
    effectiveThinkingValue,
    thinkingLabel: activeThinkingOption.label,
    thinkingDefaultLabel,
    ActiveThinkingIcon: activeThinkingOption.icon,
    isLoadingApiConfig,
    thinkingError,
    responsesFastMode,
    responsesFastModeOverride,
    fastModeError,
    labels,
    isStreaming,
    isAborting,
    sendKeyMode,
    setManualValue,
    setIsManualMode,
    handleChange,
    handleSend,
    handleAbort: onAbort ?? (() => {}),
    handleKeyDown,
    handleSelectModel,
    handleOpenManualMode,
    handleConfirmManualModel,
    handleManualKeyDown,
    handleRetryFetchModels,
    handleApiConfigSaved,
    handleToggleModelMenu,
    setModelMenuView,
    handleOpenApiProfileMenu,
    handleSelectApiProfile,
    handleSelectThinking,
    handleSelectResponsesFastMode,
    setSendKeyMode,
    restoreContent,
  };
};
