import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BrainCircuit } from "lucide-react";
import type {
  ApiConfigRecord,
  Model,
  ScheduledTaskRunOptions,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { shortcutEvents } from "../../shortcutEvents";
import {
  DEFAULT_THINKING_VALUE,
  THINKING_OPTIONS_BY_METHOD,
} from "./constants";
import {
  getResponsesFastModeFromConfig,
  getThinkingValueFromConfig,
  normalizeRequestMethod,
} from "./configThinking";
import { resolveAutoSendOptions } from "./autoSendOptions";
import { useSendKeyMode } from "./useSendKeyMode";
import type {
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
  renumberImageChips,
} from "./fileTagUtils";
type UseChatInputControllerParams = {
  projectId?: string;
  conversationId?: string;
  onSend?: (message: string, options: ChatInputSendOptions) => void;
  isStreaming?: boolean;
  isAborting?: boolean;
  onAbort?: () => void;
  draftToRestore?: string | null;
  autoSendToken?: number;
  onDraftRestored?: () => void;
  autoSendOverride?: ScheduledTaskRunOptions | null;
  onAutoSendOverrideConsumed?: () => void;
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

const isComposingKeyboardEvent = (
  event: React.KeyboardEvent<HTMLElement>,
): boolean => {
  const nativeEvent = event.nativeEvent;
  const nativeEventWithKeyCode = nativeEvent as unknown as { keyCode?: number };

  return nativeEvent.isComposing || nativeEventWithKeyCode.keyCode === 229;
};

export const useChatInputController = ({
  projectId,
  conversationId,
  onSend,
  isStreaming = false,
  isAborting = false,
  onAbort,
  draftToRestore = null,
  autoSendToken = 0,
  onDraftRestored,
  autoSendOverride = null,
  onAutoSendOverrideConsumed,
  saveInputDraft,
  getInputDraft,
  clearInputDraft,
  rollbackInputState,
  onRuntimeInputStateChange,
  getRuntimeInputState,
}: UseChatInputControllerParams): UseChatInputControllerResult => {
  const { t } = useI18n();
  const { sendKeyMode, setSendKeyMode } = useSendKeyMode();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLDivElement>(null);
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
    boolean | null
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
      // 回滚消息已回写：同步清除该会话的旧草稿。否则 onDraftRestored 把
      // draftToRestore 置回 null 后，草稿恢复 effect 会用回滚前的输入内容
      // 覆盖刚回写的消息（输入框非空时回滚即触发，表现为"消息有概率无法回写"）。
      clearInputDraft?.(conversationId);
      requestAnimationFrame(() => {
        adjustHeight();
        textarea.focus();
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(textarea);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }

        // If autoSendToken is non-zero, this draft was queued by
        // buildFromContent — automatically send it right after restore.
        if (autoSendToken > 0) {
          const message = draftToRestore.trim();
          if (message) {
            // Scheduled-task runs may carry one-shot profile/model/title-model
            // overrides. The resolver never borrows selectedModel when a task
            // names a profile, and this existing callback remains the sole
            // consumption point so snapshots cannot leak into manual sends.
            onSend?.(
              message,
              resolveAutoSendOptions({
                autoSendOverride,
                apiConfigs,
                selectedModel,
                selectedApiProfile,
              }),
            );
          }
          setValue("");
          // The queued content was sent; do not keep it as a per-conversation
          // draft (otherwise it would reappear after switching away/back).
          clearInputDraft?.(conversationId);
          textarea.innerHTML = "";
          textarea.dataset.empty = "true";
          adjustHeight();
          onAutoSendOverrideConsumed?.();
        }
      });
    }

    onDraftRestored?.();
  }, [
    draftToRestore,
    onDraftRestored,
    adjustHeight,
    autoSendToken,
    onSend,
    apiConfigs,
    selectedModel,
    selectedApiProfile,
    autoSendOverride,
    onAutoSendOverrideConsumed,
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

  const restoreContent = useCallback(
    (content: string) => {
      setValue(content);
      // 同步镜像：/clear 会令 ChatInput 因 key 变化重建，重建前若只靠
      // setValue 的异步更新，卸载清理会用旧值（如过滤词 /clear）把残留
      // 写回草稿池并在重建后恢复出来。这里立即同步 latestValueRef。
      latestValueRef.current = content;

      if (textareaRef.current) {
        const html = buildSegmentsHtml(parseContentSegments(content));

        textareaRef.current.innerHTML = html;
        renumberImageChips(textareaRef.current);
        textareaRef.current.dataset.empty = isEditableContentEmpty(content)
          ? "true"
          : "false";
        requestAnimationFrame(() => {
          adjustHeight();
          textareaRef.current?.focus();
        });
      }
    },
    [adjustHeight, textareaRef],
  );

  // --- Per-conversation draft persistence ---
  // ChatInput 实例随会话切换（key 变化）而重建，卸载时草稿存入
  // per-conversation 草稿池；新实例挂载后——或 conversationId prop 变化
  // 而实例未重建时——恢复目标会话的草稿。Rollback 草稿（draftToRestore）
  // 优先，由上面的 effect 处理。
  useEffect(() => {
    if (draftToRestore !== null) {
      return;
    }
    const draft = getInputDraft?.(conversationId);
    if (draft) {
      restoreContent(draft);
    }
  }, [conversationId, draftToRestore, getInputDraft, restoreContent]);

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
  const profileFastModeEnabled = runtimeApiConfig
    ? getResponsesFastModeFromConfig(runtimeApiConfig)
    : false;
  // Do not use truthy fallback here: `false` is an explicit conversation
  // override and must remain distinct from `null` (inherit profile default).
  const responsesFastModeEnabled =
    responsesFastModeOverride !== null
      ? responsesFastModeOverride
      : profileFastModeEnabled;

  const handleSend = useCallback(() => {
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
      model: selectedModel || undefined,
      apiProfile: selectedApiProfile || undefined,
      // Manual sends carry effective values so the agent loop captures the
      // exact settings used by this turn. The snapshot is separate: null means
      // the conversation follows the current profile default.
      thinkingStrength: effectiveThinkingValue,
      responsesFastMode:
        requestMethod === "responses" ? responsesFastModeEnabled : null,
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
      requestAnimationFrame(() => {
        adjustHeight();
      });
    }
  }, [
    adjustHeight,
    apiConfigs.length,
    clearInputDraft,
    conversationId,
    effectiveThinkingValue,
    onSend,
    requestMethod,
    responsesFastModeEnabled,
    responsesFastModeOverride,
    selectedApiProfile,
    selectedModel,
    thinkingOverride,
    value,
  ]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" || isComposingKeyboardEvent(event)) {
        return;
      }
      const hasMod = event.ctrlKey || event.metaKey;
      // 按当前快捷键模式判断本次回车是否为发送组合键。
      const isSendCombo =
        sendKeyMode === "ctrlEnter"
          ? hasMod && !event.shiftKey && !event.altKey
          : !hasMod && !event.shiftKey && !event.altKey;
      if (!isSendCombo) {
        return;
      }

      event.preventDefault();
      handleSend();
    },
    [handleSend, sendKeyMode],
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
        if (isComposingKeyboardEvent(event)) {
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
        void loadModels();
      }
      return nextOpen;
    });
  }, [loadModels]);

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
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(textarea);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [textareaRef]);

  useEffect(() => {
    return shortcutEvents.on("focus-chat-input", handleFocusInput);
  }, [handleFocusInput]);

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

  const handleToggleResponsesFastMode = useCallback((): void => {
    if (
      !runtimeApiConfig ||
      requestMethod !== "responses" ||
      isStreaming ||
      isSubAgentConversation
    ) {
      return;
    }

    // Toggle from the effective value, then keep an explicit boolean in
    // memory. In particular, turning Fast Mode off must stay `false`, not
    // inherit the profile default. The value is persisted on the next send.
    setResponsesFastModeOverride(!responsesFastModeEnabled);
    setFastModeError(null);
  }, [
    isStreaming,
    isSubAgentConversation,
    requestMethod,
    responsesFastModeEnabled,
    runtimeApiConfig,
  ]);

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
    thinkingLabel: activeThinkingOption.label,
    thinkingDefaultLabel,
    ActiveThinkingIcon: activeThinkingOption.icon,
    isLoadingApiConfig,
    thinkingError,
    responsesFastModeEnabled,
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
    handleToggleResponsesFastMode,
    setSendKeyMode,
    restoreContent,
  };
};
