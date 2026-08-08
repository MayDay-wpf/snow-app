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
import { shortcutEvents } from "../../shortcutEvents";
import {
  DEFAULT_TEXTAREA_ROWS,
  DEFAULT_THINKING_VALUE,
  MAX_TEXTAREA_ROWS,
  THINKING_OPTIONS_BY_METHOD,
} from "./constants";
import {
  getResponsesFastModeFromConfig,
  getThinkingValueFromConfig,
  normalizeRequestMethod,
  toConfigUpdatePayload,
  toResponsesFastModeUpdatePayload,
} from "./configThinking";
import type {
  ChatInputActions,
  ChatInputSendOptions,
  ChatInputState,
  ModelMenuView,
} from "./types";
import {
  buildSegmentsHtml,
  parseContentSegments,
  renumberImageChips,
} from "./fileTagUtils";
type UseChatInputControllerParams = {
  conversationId?: string;
  onSend?: (message: string, options: ChatInputSendOptions) => void;
  isStreaming?: boolean;
  isAborting?: boolean;
  onAbort?: () => void;
  draftToRestore?: string | null;
  autoSendToken?: number;
  onDraftRestored?: () => void;
  saveInputDraft?: (conversationId: string | undefined, content: string) => void;
  getInputDraft?: (conversationId: string | undefined) => string | undefined;
  clearInputDraft?: (conversationId: string | undefined) => void;
};

type UseChatInputControllerResult = ChatInputState & ChatInputActions;

const isComposingKeyboardEvent = (
  event: React.KeyboardEvent<HTMLElement>
): boolean => {
  const nativeEvent = event.nativeEvent;
  const nativeEventWithKeyCode = nativeEvent as unknown as { keyCode?: number };

  return nativeEvent.isComposing || nativeEventWithKeyCode.keyCode === 229;
};

export const useChatInputController = ({
  conversationId,
  onSend,
  isStreaming = false,
  isAborting = false,
  onAbort,
  draftToRestore = null,
  autoSendToken = 0,
  onDraftRestored,
  saveInputDraft,
  getInputDraft,
  clearInputDraft,
}: UseChatInputControllerParams): UseChatInputControllerResult => {
  const { t } = useI18n();
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
  const [thinkingValue, setThinkingValue] = useState(DEFAULT_THINKING_VALUE);
  const [isSavingThinking, setIsSavingThinking] = useState(false);
  const [thinkingError, setThinkingError] = useState<string | null>(null);
  const [isSavingFastMode, setIsSavingFastMode] = useState(false);
  const [fastModeError, setFastModeError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
      cancel: t("common.cancel", { defaultValue: "Cancel" }),
      confirm: t("common.confirm", { defaultValue: "Confirm" }),
      retry: t("common.retry", { defaultValue: "Retry" }),
    }),
    [t]
  );

  useEffect(() => {
    let cancelled = false;

    const loadRuntimeApiConfig = async () => {
      setIsLoadingApiConfig(true);
      setThinkingError(null);
      setFastModeError(null);
      setModelError(null);
      setModels([]);

      try {
        const [configs, conversation] = await Promise.all([
          window.snow.listApiConfigs(),
          conversationId
            ? window.snow.getChatConversation(conversationId)
            : Promise.resolve(null),
        ]);
        if (cancelled) {
          return;
        }

        setApiConfigs(configs);

        // Resolve the conversation-scoped profile from the persisted runtime
        // snapshot. Sub-agent history must never consult the current agent
        // configuration because that configuration may have changed or been
        // deleted after the run completed.
        const subAgentConversation =
          conversation?.conversationType === "sub_agent";
        const requestedProfile = conversation?.apiProfileName?.trim() ?? "";
        setIsSubAgentConversation(subAgentConversation);

        // A persisted profile snapshot is strict for sub-agents. Legacy rows
        // without a snapshot retain the old active-profile fallback so existing
        // history remains readable after migration.
        let runtimeConfig: ApiConfigRecord | null = null;
        if (requestedProfile) {
          runtimeConfig =
            configs.find(
              (config) => config.profileName === requestedProfile
            ) ?? null;
          if (!runtimeConfig && !subAgentConversation) {
            runtimeConfig =
              configs.find((config) => config.isActive) ??
              configs[0] ??
              null;
          }
        } else {
          runtimeConfig =
            configs.find((config) => config.isActive) ?? configs[0] ?? null;
        }
        if (!runtimeConfig) {
          throw new Error(
            requestedProfile
              ? `API profile is not available: ${requestedProfile}`
              : "No API configuration found"
          );
        }

        setSelectedApiProfile(runtimeConfig.profileName);
        setRuntimeApiConfig(runtimeConfig);
        // Persisted conversation model is the immutable display snapshot for
        // completed sub-agents and the remembered selection for main chats.
        const rememberedModel = conversation?.model?.trim() ?? "";
        setSelectedModel(rememberedModel || runtimeConfig.advancedModel || "");
        setThinkingValue(getThinkingValueFromConfig(runtimeConfig));
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : "Failed to load API configuration";
        setRuntimeApiConfig(null);
        setSelectedApiProfile("");
        setSelectedModel("");
        setThinkingValue(DEFAULT_THINKING_VALUE);
        setModelError(message);
        setThinkingError(message);
        setFastModeError(message);
      } finally {
        if (!cancelled) {
          setIsLoadingApiConfig(false);
        }
      }
    };

    void loadRuntimeApiConfig();

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const loadModels = useCallback(
    async (force = false) => {
      if (isLoadingModels || (!force && (models.length > 0 || modelError))) {
        return;
      }

      setIsLoadingModels(true);
      setModelError(null);

      try {
        if (!runtimeApiConfig) {
          throw new Error("API configuration is not available");
        }

        const availableModels = await window.snow.fetchAvailableModelsForConfig(
          {
            baseUrl: runtimeApiConfig.baseUrl,
            baseUrlMode: runtimeApiConfig.baseUrlMode,
            apiKey: runtimeApiConfig.apiKey,
            requestMethod: runtimeApiConfig.requestMethod,
            customHeaderSchemeId: runtimeApiConfig.customHeaderSchemeId,
          }
        );
        setModels(availableModels);

        if (availableModels.length > 0) {
          setSelectedModel(
            (currentModel) =>
              currentModel ||
              runtimeApiConfig.advancedModel ||
              availableModels[0].id
          );
        }
      } catch (error) {
        setModelError(
          error instanceof Error ? error.message : labels.loadModelsError
        );
      } finally {
        setIsLoadingModels(false);
      }
    },
    [
      runtimeApiConfig,
      isLoadingModels,
      labels.loadModelsError,
      modelError,
      models.length,
    ]
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
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
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
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    const lineHeight =
      parseInt(getComputedStyle(textarea).lineHeight, 10) || 20;
    const minHeight = lineHeight * DEFAULT_TEXTAREA_ROWS;
    const maxHeight = lineHeight * MAX_TEXTAREA_ROWS;
    textarea.style.height = `${Math.min(
      Math.max(textarea.scrollHeight, minHeight),
      maxHeight
    )}px`;
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
      textarea.dataset.empty = draftToRestore.trim() === "" ? "true" : "false";
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
            onSend?.(message, { model: selectedModel || undefined });
          }
          setValue("");
          // The queued content was sent; do not keep it as a per-conversation
          // draft (otherwise it would reappear after switching away/back).
          clearInputDraft?.(conversationId);
          textarea.innerHTML = "";
          textarea.dataset.empty = "true";
          adjustHeight();
        }
      });
    }

    onDraftRestored?.();
  }, [draftToRestore, onDraftRestored, adjustHeight, autoSendToken, onSend, selectedModel, conversationId, clearInputDraft]);

  const handleChange = useCallback(
    (nextValue: string) => {
      setValue(nextValue);
      // Persist the draft so it survives ChatInput unmounts caused by
      // conversation switches / new-chat (isLoadingInitialHistory).
      saveInputDraft?.(conversationId, nextValue);
      adjustHeight();
    },
    [adjustHeight, conversationId, saveInputDraft]
  );

  const restoreContent = useCallback(
    (content: string) => {
      setValue(content);

      if (textareaRef.current) {
        const html = buildSegmentsHtml(parseContentSegments(content));

        textareaRef.current.innerHTML = html;
        renumberImageChips(textareaRef.current);
        textareaRef.current.dataset.empty =
          content.trim() === "" ? "true" : "false";
        requestAnimationFrame(() => {
          adjustHeight();
          textareaRef.current?.focus();
        });
      }
    },
    [adjustHeight, textareaRef]
  );

  // --- Per-conversation draft persistence ---
  // ChatInput unmounts while initial history loads (conversation switch /
  // new chat). On (re)mount — or when the conversation prop changes without
  // unmounting — restore the target conversation's saved draft. Rollback
  // drafts (draftToRestore) take precedence and are handled above.
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

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }

    // The selected profile is conversation-scoped: for a brand-new
    // conversation it is carried on the request so the backend binds the
    // created conversation to this provider; for existing conversations the
    // binding is already persisted and the backend resolves it automatically.
    onSend?.(trimmed, {
      model: selectedModel || undefined,
      apiProfile: selectedApiProfile || undefined,
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
  }, [adjustHeight, onSend, selectedModel, selectedApiProfile, value, conversationId, clearInputDraft]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isComposingKeyboardEvent(event)
      ) {
        return;
      }

      event.preventDefault();
      handleSend();
    },
    [handleSend]
  );

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      setSelectedModel(modelId);
      setIsModelMenuOpen(false);
      setIsManualMode(false);
      // Conversation-scoped model selection: the model is remembered on the
      // conversation row by the backend on the next exchange. It intentionally
      // does NOT mutate the profile's global advanced_model — that default
      // stays editable in the API settings panel.
    },
    []
  );

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
    [handleConfirmManualModel]
  );

  const handleRetryFetchModels = useCallback(async () => {
    await loadModels(true);
  }, [loadModels]);

  const handleToggleModelMenu = useCallback(() => {
    setIsModelMenuOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        void loadModels();
      }
      return nextOpen;
    });
  }, [loadModels]);

  // Switch the conversation-scoped API profile. Persists the binding on the
  // conversation row so it survives reloads; for a brand-new conversation the
  // choice is kept locally and carried on the first request instead.
  const handleSelectApiProfile = useCallback(
    async (profileName: string) => {
      const nextConfig = apiConfigs.find(
        (config) => config.profileName === profileName
      );
      if (!nextConfig) {
        return;
      }

      setSelectedApiProfile(profileName);
      setIsModelMenuOpen(false);
      setModelMenuView("root");
      setRuntimeApiConfig(nextConfig);
      // Reset the model picker to the new provider's default.
      setModels([]);
      setModelError(null);
      setFastModeError(null);
      setSelectedModel(nextConfig.advancedModel || "");
      setThinkingValue(getThinkingValueFromConfig(nextConfig));

      if (conversationId && !isSubAgentConversation) {
        try {
          await window.snow.updateConversationApiProfile(
            conversationId,
            profileName
          );
        } catch (error) {
          setModelError(
            error instanceof Error
              ? error.message
              : "Failed to update conversation API profile"
          );
        }
      }
    },
    [apiConfigs, conversationId, isSubAgentConversation]
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
    return shortcutEvents.on(
      "open-api-profile-menu",
      handleOpenApiProfileMenu
    );
  }, [handleOpenApiProfileMenu]);

  const requestMethod = normalizeRequestMethod(runtimeApiConfig?.requestMethod);
  const responsesFastModeEnabled =
    requestMethod === "responses" &&
    runtimeApiConfig !== null &&
    getResponsesFastModeFromConfig(runtimeApiConfig);
  const thinkingOptions = THINKING_OPTIONS_BY_METHOD[requestMethod];
  const activeThinkingOption = useMemo(() => {
    const matchingOption = thinkingOptions.find(
      (option) => option.value === thinkingValue
    );

    return {
      label: matchingOption?.label ?? thinkingValue,
      icon: matchingOption?.icon ?? BrainCircuit,
    };
  }, [thinkingOptions, thinkingValue]);

  const handleSelectThinking = useCallback(
    async (nextValue: string) => {
      if (!runtimeApiConfig) {
        return;
      }

      setThinkingValue(nextValue);
      setIsModelMenuOpen(false);
      setIsSavingThinking(true);
      setThinkingError(null);

      try {
        const updatedConfigs = await window.snow.upsertApiConfig(
          toConfigUpdatePayload(runtimeApiConfig, nextValue)
        );
        const nextRuntimeConfig =
          updatedConfigs.find(
            (config) => config.profileName === runtimeApiConfig.profileName
          ) ?? null;
        setRuntimeApiConfig(nextRuntimeConfig);
        setThinkingValue(
          nextRuntimeConfig
            ? getThinkingValueFromConfig(nextRuntimeConfig)
            : nextValue
        );
      } catch (error) {
        setThinkingValue(getThinkingValueFromConfig(runtimeApiConfig));
        setThinkingError(
          error instanceof Error
            ? error.message
            : t("chat.saveThinkingStrengthError")
        );
      } finally {
        setIsSavingThinking(false);
      }
    },
    [runtimeApiConfig, t]
  );

  const handleToggleResponsesFastMode = useCallback(async (): Promise<void> => {
    if (
      !runtimeApiConfig ||
      requestMethod !== "responses" ||
      isStreaming ||
      isSubAgentConversation ||
      isSavingFastMode
    ) {
      return;
    }

    const previousConfig = runtimeApiConfig;
    const nextEnabled = !getResponsesFastModeFromConfig(previousConfig);
    const optimisticConfig = toResponsesFastModeUpdatePayload(
      previousConfig,
      nextEnabled
    );

    setRuntimeApiConfig(optimisticConfig);
    setIsSavingFastMode(true);
    setFastModeError(null);

    try {
      const updatedConfigs = await window.snow.upsertApiConfig(optimisticConfig);
      const nextRuntimeConfig =
        updatedConfigs.find(
          (config) => config.profileName === previousConfig.profileName
        ) ?? optimisticConfig;
      setApiConfigs(updatedConfigs);
      setRuntimeApiConfig((currentConfig) =>
        currentConfig?.profileName === previousConfig.profileName
          ? nextRuntimeConfig
          : currentConfig
      );
    } catch (error) {
      setRuntimeApiConfig((currentConfig) =>
        currentConfig?.profileName === previousConfig.profileName
          ? previousConfig
          : currentConfig
      );
      setFastModeError(
        error instanceof Error ? error.message : t("chat.saveFastModeError")
      );
    } finally {
      setIsSavingFastMode(false);
    }
  }, [
    isSavingFastMode,
    isStreaming,
    isSubAgentConversation,
    requestMethod,
    runtimeApiConfig,
    t,
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
    thinkingValue,
    thinkingLabel: activeThinkingOption.label,
    ActiveThinkingIcon: activeThinkingOption.icon,
    isLoadingApiConfig,
    isSavingThinking,
    thinkingError,
    responsesFastModeEnabled,
    isSavingFastMode,
    fastModeError,
    labels,
    isStreaming,
    isAborting,
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
    handleToggleModelMenu,
    setModelMenuView,
    handleOpenApiProfileMenu,
    handleSelectApiProfile,
    handleSelectThinking,
    handleToggleResponsesFastMode,
    restoreContent,
  };
};
