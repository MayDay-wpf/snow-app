import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleOff,
  GripVertical,
  Keyboard,
  Loader2,
  Pencil,
  Pin,
  RefreshCw,
  Search,
  Settings,
  X,
  Zap,
} from "lucide-react";
import { ModelBrandIcon } from "../../common/ModelBrandIcon";
import { DoubleZapIcon } from "../../common/DoubleZapIcon";
import { Tooltip } from "../../common/Tooltip";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useI18n } from "../../../i18n";
import { OAuthQuotaPanel } from "../../common/OAuthQuotaPanel";
import { ThinkingStrengthMenu } from "./ThinkingStrengthMenu";
import { getThinkingTint } from "./thinkingIcons";
import { useDropdownDirection } from "./useDropdownDirection";
import type { MainContentView } from "../types";
import type { ChatInputActions, ChatInputState } from "./types";
import { ApiSettingsEditModal } from "../../sidebar/apiSettings/ApiSettingsEditModal";
import {
  orderApiConfigsByName,
  useApiConfigReorder,
} from "../../sidebar/apiSettings/apiConfigReorder";
import type { ApiConfigRecord } from "../../../../preload";

type ModelSelectorProps = Pick<
  ChatInputState,
  | "apiConfigs"
  | "selectedApiProfile"
  | "modelMenuView"
  | "isSubAgentConversation"
  | "models"
  | "selectedModel"
  | "displayModel"
  | "isLoadingModels"
  | "modelError"
  | "isModelMenuOpen"
  | "isManualMode"
  | "manualValue"
  | "runtimeApiConfig"
  | "requestMethod"
  | "thinkingOptions"
  | "thinkingValue"
  | "thinkingLabel"
  | "ActiveThinkingIcon"
  | "isLoadingApiConfig"
  | "thinkingError"
  | "responsesFastMode"
  | "fastModeError"
  | "labels"
  | "isStreaming"
> &
  Pick<
    ChatInputActions,
    | "setManualValue"
    | "setIsManualMode"
    | "setModelMenuView"
    | "handleSelectModel"
    | "handleOpenManualMode"
    | "handleConfirmManualModel"
    | "handleManualKeyDown"
    | "handleRetryFetchModels"
    | "handleApiConfigSaved"
    | "handleToggleModelMenu"
    | "handleSelectApiProfile"
    | "handleSelectThinking"
    | "handleSelectResponsesFastMode"
  > & {
    dropdownRef: RefObject<HTMLDivElement | null>;
    onNavigateToView?: (view: MainContentView) => void;
  };

export const ModelSelector = ({
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
  runtimeApiConfig,
  requestMethod,
  thinkingOptions,
  thinkingValue,
  thinkingLabel,
  ActiveThinkingIcon,
  isLoadingApiConfig,
  thinkingError,
  responsesFastMode,
  fastModeError,
  labels,
  isStreaming,
  dropdownRef,
  setManualValue,
  setIsManualMode,
  setModelMenuView,
  handleSelectModel,
  handleOpenManualMode,
  handleConfirmManualModel,
  handleManualKeyDown,
  handleRetryFetchModels,
  handleApiConfigSaved,
  handleToggleModelMenu,
  handleSelectApiProfile,
  handleSelectThinking,
  handleSelectResponsesFastMode,
  onNavigateToView,
}: ModelSelectorProps): React.JSX.Element => {
  const { t } = useI18n();
  // 思考强度按档位取进度条同色
  const thinkingTintStyle = useMemo(() => {
    if (thinkingError || isLoadingApiConfig) {
      return undefined;
    }
    const tint = getThinkingTint(thinkingOptions, thinkingValue);
    return tint ? { color: tint } : undefined;
  }, [isLoadingApiConfig, thinkingError, thinkingOptions, thinkingValue]);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [apiProfileSearchQuery, setApiProfileSearchQuery] = useState("");
  // 键盘导航高亮索引（-1 = 未高亮）
  const [modelActiveIndex, setModelActiveIndex] = useState(-1);
  const [apiProfileActiveIndex, setApiProfileActiveIndex] = useState(-1);
  const modelListRef = useRef<HTMLDivElement | null>(null);
  const apiProfileListRef = useRef<HTMLDivElement | null>(null);
  const modelDropdownDir = useDropdownDirection(dropdownRef, isModelMenuOpen);
  const [isMenuClosing, setIsMenuClosing] = useState(false);
  const [prevMenuOpen, setPrevMenuOpen] = useState(isModelMenuOpen);
  const [lastMenuView, setLastMenuView] = useState(modelMenuView);

  if (isModelMenuOpen !== prevMenuOpen) {
    setPrevMenuOpen(isModelMenuOpen);
    setIsMenuClosing(!isModelMenuOpen);
  }

  useEffect(() => {
    if (!isMenuClosing) {
      return;
    }
    const timer = window.setTimeout(() => setIsMenuClosing(false), 160);
    return () => window.clearTimeout(timer);
  }, [isMenuClosing]);

  useEffect(() => {
    if (isModelMenuOpen) {
      setLastMenuView(modelMenuView);
    }
  }, [isModelMenuOpen, modelMenuView]);

  const displayView = isModelMenuOpen ? modelMenuView : lastMenuView;
  const menuHidden = !isModelMenuOpen && !isMenuClosing;
  // 在渠道菜单内直接编辑配置后，用最新列表覆盖 props（props 仅在会话切换时刷新）
  const [apiConfigsOverride, setApiConfigsOverride] = useState<
    ApiConfigRecord[] | null
  >(null);
  const [editingApiConfig, setEditingApiConfig] =
    useState<ApiConfigRecord | null>(null);
  // 正在切换为默认启用配置的渠道名（图钉按钮的进行中状态）
  const [pendingDefaultProfile, setPendingDefaultProfile] = useState<
    string | null
  >(null);
  useEffect(() => {
    setApiConfigsOverride(null);
  }, [apiConfigs]);
  const effectiveApiConfigs = apiConfigsOverride ?? apiConfigs;
  const selectedApiConfig =
    effectiveApiConfigs.find(
      (config) => config.profileName === selectedApiProfile,
    ) ?? null;

  useEffect(() => {
    if (menuHidden || displayView !== "model") {
      setModelSearchQuery("");
      setModelActiveIndex(-1);
    }
    if (menuHidden || displayView !== "apiProfile") {
      setApiProfileSearchQuery("");
      setApiProfileActiveIndex(-1);
    }
  }, [menuHidden, displayView]);

  // 进入模型/渠道视图时，把键盘高亮定位到当前选中项
  useEffect(() => {
    if (!isModelMenuOpen || modelMenuView !== "model" || isManualMode) {
      return;
    }
    const index = models.findIndex((model) => model.id === selectedModel);
    setModelActiveIndex(index >= 0 ? index : 0);
  }, [isModelMenuOpen, modelMenuView, isManualMode, models, selectedModel]);

  // 进入渠道视图时把键盘高亮定位到当前选中项；
  // 视图已打开时列表变化（如拖拽排序）不再打断用户当前的高亮位置。
  const apiProfileViewEnteredRef = useRef(false);
  useEffect(() => {
    if (!isModelMenuOpen || modelMenuView !== "apiProfile") {
      apiProfileViewEnteredRef.current = false;
      return;
    }
    if (apiProfileViewEnteredRef.current) {
      return;
    }
    apiProfileViewEnteredRef.current = true;
    const index = effectiveApiConfigs.findIndex(
      (config) => config.profileName === selectedApiProfile,
    );
    setApiProfileActiveIndex(index >= 0 ? index : 0);
  }, [isModelMenuOpen, modelMenuView, effectiveApiConfigs, selectedApiProfile]);

  // 键盘导航：↑↓/Home/End 移动高亮，Enter 选中高亮项
  const handleDropdownKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const isModelList = modelMenuView === "model" && !isManualMode;
    const isProfileList = modelMenuView === "apiProfile";
    if (!isModelList && !isProfileList) {
      return;
    }

    const list = isModelList ? filteredModels : filteredApiConfigs;
    const activeIndex = isModelList ? modelActiveIndex : apiProfileActiveIndex;
    const setActiveIndex = isModelList
      ? setModelActiveIndex
      : setApiProfileActiveIndex;
    if (list.length === 0 || (isModelList && isLoadingModels)) {
      return;
    }

    // 焦点在返回/刷新/手动输入等操作按钮上时，Enter 交给原生按钮行为
    const isActionButton = !!(event.target as HTMLElement).closest(
      ".model-menu-back, .model-dropdown-action, .model-dropdown-retry, .model-dropdown-edit-btn, .model-dropdown-pin-btn",
    );

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % list.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) =>
          index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length,
        );
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(list.length - 1);
        break;
      case "Enter": {
        if (isActionButton) {
          return;
        }
        const index = activeIndex >= 0 ? activeIndex : 0;
        const item = list[index];
        if (!item) {
          return;
        }
        event.preventDefault();
        if (isModelList) {
          void handleSelectModel(item.id);
        } else {
          void handleSelectApiProfile(
            "profileName" in item ? item.profileName : "",
          );
        }
        break;
      }
    }
  };

  const filteredModels = useMemo(() => {
    const query = modelSearchQuery.trim().toLowerCase();
    if (!query) {
      return models;
    }
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(query) ||
        model.ownedBy.toLowerCase().includes(query),
    );
  }, [models, modelSearchQuery]);

  const filteredApiConfigs = useMemo(() => {
    const query = apiProfileSearchQuery.trim().toLowerCase();
    if (!query) {
      return effectiveApiConfigs;
    }
    return effectiveApiConfigs.filter(
      (config) =>
        config.displayName.toLowerCase().includes(query) ||
        config.profileName.toLowerCase().includes(query) ||
        (config.advancedModel || "").toLowerCase().includes(query) ||
        (config.basicModel || "").toLowerCase().includes(query),
    );
  }, [effectiveApiConfigs, apiProfileSearchQuery]);

  const apiConfigNames = useMemo(
    () => effectiveApiConfigs.map((config) => config.profileName),
    [effectiveApiConfigs],
  );
  const apiConfigVisibleNames = useMemo(
    () => filteredApiConfigs.map((config) => config.profileName),
    [filteredApiConfigs],
  );

  // 渠道列表排序：本地先按新顺序即时反馈，落库后以 Rust 返回的列表为准。
  const handleReorderApiConfigs = (orderedNames: string[]): void => {
    const base = apiConfigsOverride ?? apiConfigs;
    setApiConfigsOverride(orderApiConfigsByName(base, orderedNames));
    void window.snow
      .reorderApiConfigs(orderedNames)
      .then((list) => setApiConfigsOverride(list))
      .catch(() => setApiConfigsOverride(null));
  };

  const apiConfigReorder = useApiConfigReorder({
    allNames: apiConfigNames,
    visibleNames: apiConfigVisibleNames,
    onReorder: handleReorderApiConfigs,
  });

  // 图钉：把该渠道切换为全局默认启用配置（isActive 由 Rust 保证唯一）。
  const handleSetDefaultApiProfile = async (
    config: ApiConfigRecord,
  ): Promise<void> => {
    if (config.isActive || pendingDefaultProfile !== null) {
      return;
    }
    setPendingDefaultProfile(config.profileName);
    try {
      const list = await window.snow.upsertApiConfig({
        ...config,
        isActive: true,
        // 空字符串表示沿用库里已有的密钥，避免把密钥回写覆盖。
        apiKey: "",
        visionApiKey: "",
      });
      setApiConfigsOverride(list);
    } catch {
      // 切换失败（如未配置模型）时保持原默认启用配置不变。
    } finally {
      setPendingDefaultProfile(null);
    }
  };

  // 过滤结果变化时收敛索引，避免越界
  useEffect(() => {
    setModelActiveIndex((index) =>
      filteredModels.length === 0
        ? -1
        : Math.min(index, filteredModels.length - 1),
    );
  }, [filteredModels]);

  useEffect(() => {
    setApiProfileActiveIndex((index) =>
      filteredApiConfigs.length === 0
        ? -1
        : Math.min(index, filteredApiConfigs.length - 1),
    );
  }, [filteredApiConfigs]);

  // 高亮项滚动进入可视区域
  useEffect(() => {
    if (modelMenuView === "model" && modelActiveIndex >= 0) {
      const items = modelListRef.current?.querySelectorAll<HTMLElement>(
        ".model-dropdown-item",
      );
      items?.[modelActiveIndex]?.scrollIntoView({ block: "nearest" });
    }
    if (modelMenuView === "apiProfile" && apiProfileActiveIndex >= 0) {
      const items = apiProfileListRef.current?.querySelectorAll<HTMLElement>(
        ".model-dropdown-item",
      );
      items?.[apiProfileActiveIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [
    modelActiveIndex,
    apiProfileActiveIndex,
    modelMenuView,
    filteredModels,
    filteredApiConfigs,
  ]);

  const fastModeOptions = useMemo(
    () => [
      { value: "off", label: t("chat.fastModeOff"), icon: CircleOff },
      { value: "fast", label: t("chat.fastModeFast"), icon: Zap },
      {
        value: "ultrafast",
        label: t("chat.fastModeUltrafast"),
        icon: DoubleZapIcon,
      },
    ],
    [t],
  );
  const activeFastModeOption = fastModeOptions.find(
    (option) => option.value === responsesFastMode,
  );
  const activeFastModeLabel = activeFastModeOption?.label ?? responsesFastMode;
  const ActiveFastModeIcon = activeFastModeOption?.icon ?? Zap;

  return (
    <div className="model-selector" ref={dropdownRef}>
      <button
        className={`toolbar-btn model ${modelError ? "model-error" : ""}${
          isStreaming || isSubAgentConversation ? " is-disabled" : ""
        }`}
        aria-label={labels.selectModel}
        aria-expanded={isModelMenuOpen}
        onClick={handleToggleModelMenu}
        disabled={
          isStreaming ||
          isSubAgentConversation ||
          effectiveApiConfigs.length === 0 ||
          !runtimeApiConfig
        }
        title={
          isSubAgentConversation
            ? t("chat.subAgentModelFixed")
            : effectiveApiConfigs.length === 0 || !runtimeApiConfig
              ? labels.noApiConfig
              : labels.selectModel
        }
        type="button"
      >
        {modelError ? (
          <AlertCircle size={14} className="model-icon" />
        ) : (
          <ModelBrandIcon model={displayModel} size={14} />
        )}
        <span className="model-name" title={displayModel}>
          {displayModel}
        </span>
        <span
          className="model-trigger-thinking"
          style={thinkingTintStyle}
          title={
            thinkingError ??
            (isLoadingApiConfig
              ? t("chat.loadingApiConfig")
              : t("chat.thinkingStrengthWithValue", {
                  values: { value: thinkingLabel },
                }))
          }
        >
          {isLoadingApiConfig ? (
            <Loader2 size={12} className="spin" />
          ) : thinkingError ? (
            <AlertCircle size={12} />
          ) : (
            <ActiveThinkingIcon size={12} />
          )}
          <span className="model-trigger-thinking-label">{thinkingLabel}</span>
        </span>
        {requestMethod === "responses" && responsesFastMode !== "off" && (
          <span
            className="model-trigger-fast"
            title={
              fastModeError ??
              t("chat.fastModeActive", {
                values: { tier: activeFastModeLabel },
              })
            }
          >
            <ActiveFastModeIcon size={12} />
            <span>{activeFastModeLabel}</span>
          </span>
        )}
        <ChevronDown size={12} />
      </button>
      {(isModelMenuOpen || isMenuClosing) && (
        <div
          className={`model-dropdown drop-${modelDropdownDir}${
            displayView === "apiProfile" ? " is-api-profile-view" : ""
          }${isMenuClosing ? " is-closing" : ""}`}
          onKeyDown={handleDropdownKeyDown}
        >
          {displayView === "root" && (
            <div className="model-dropdown-list">
              <button
                className="model-dropdown-item"
                onClick={() => setModelMenuView("model")}
                type="button"
              >
                <span className="model-dropdown-item-name">
                  {t("chat.model")}
                </span>
                <span className="model-menu-value">
                  <ModelBrandIcon model={displayModel} size={14} />
                  <span className="model-menu-value-text" title={displayModel}>
                    {displayModel}
                  </span>
                  <ChevronRight size={12} />
                </span>
              </button>
              <button
                className="model-dropdown-item"
                disabled={!runtimeApiConfig || isLoadingApiConfig}
                onClick={() => setModelMenuView("thinking")}
                type="button"
              >
                <span className="model-dropdown-item-name">
                  {t("chat.thinkingStrength")}
                </span>
                <span className="model-menu-value">
                  {isLoadingApiConfig ? (
                    <Loader2 size={14} className="spin" />
                  ) : thinkingError ? (
                    <AlertCircle size={14} />
                  ) : (
                    <ActiveThinkingIcon size={14} style={thinkingTintStyle} />
                  )}
                  <span className="model-menu-value-text">{thinkingLabel}</span>
                  <ChevronRight size={12} />
                </span>
              </button>
              {requestMethod === "responses" && (
                <button
                  className="model-dropdown-item"
                  disabled={
                    !runtimeApiConfig ||
                    isLoadingApiConfig ||
                    isStreaming ||
                    isSubAgentConversation
                  }
                  onClick={() => setModelMenuView("fastMode")}
                  type="button"
                  title={fastModeError ?? t("chat.fastModeHint")}
                >
                  <span className="model-dropdown-item-name with-icon">
                    <Zap size={14} className="thinking-option-icon" />
                    <span>{t("chat.fastMode")}</span>
                  </span>
                  <span className="model-menu-value">
                    <span className="model-menu-value-text">
                      {activeFastModeLabel}
                    </span>
                    <ChevronRight size={12} />
                  </span>
                </button>
              )}
              {!isSubAgentConversation && effectiveApiConfigs.length > 0 && (
                <button
                  className="model-dropdown-item"
                  onClick={() => setModelMenuView("apiProfile")}
                  type="button"
                >
                  <span className="model-dropdown-item-name">
                    {labels.selectApiProfile}
                  </span>
                  <span className="model-menu-value">
                    <span
                      className="model-menu-value-text"
                      title={runtimeApiConfig?.displayName}
                    >
                      {runtimeApiConfig?.displayName || labels.selectApiProfile}
                    </span>
                    <ChevronRight size={12} />
                  </span>
                </button>
              )}
            </div>
          )}
          {displayView === "root" && (
            <OAuthQuotaPanel config={selectedApiConfig} />
          )}
          {displayView === "apiProfile" && (
            <>
              <div className="model-menu-header">
                <button
                  aria-label={t("common.back")}
                  className="model-menu-back"
                  onClick={() => setModelMenuView("root")}
                  type="button"
                >
                  <ChevronLeft size={14} />
                </button>
                <span>{labels.selectApiProfile}</span>
              </div>
              <div className="model-dropdown-search">
                <Search size={13} className="model-dropdown-search-icon" />
                <input
                  autoFocus
                  className="model-dropdown-search-input"
                  type="text"
                  value={apiProfileSearchQuery}
                  onChange={(event) =>
                    setApiProfileSearchQuery(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setApiProfileSearchQuery("");
                    }
                  }}
                  placeholder={labels.searchApiProfiles}
                />
                {apiProfileSearchQuery && (
                  <button
                    className="model-dropdown-search-clear"
                    type="button"
                    aria-label={labels.searchApiProfiles}
                    onClick={() => setApiProfileSearchQuery("")}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="model-dropdown-list" ref={apiProfileListRef}>
                {effectiveApiConfigs.length > 0 &&
                  filteredApiConfigs.length === 0 && (
                    <div className="model-dropdown-empty">
                      {labels.noMatchingApiProfiles}
                    </div>
                  )}
                {filteredApiConfigs.map((config, index) => (
                  <div
                    key={config.profileName}
                    {...apiConfigReorder.getDropTargetProps(config.profileName)}
                    className={`model-dropdown-item ${
                      config.profileName === selectedApiProfile ? "active" : ""
                    } ${apiProfileActiveIndex === index ? "highlighted" : ""}${
                      apiConfigReorder.draggingName === config.profileName
                        ? " is-dragging"
                        : ""
                    }${
                      apiConfigReorder.dropTargetName === config.profileName
                        ? apiConfigReorder.dropPlacement === "before"
                          ? " is-drop-before"
                          : " is-drop-after"
                        : ""
                    }`}
                    onClick={() => {
                      void handleSelectApiProfile(config.profileName);
                    }}
                    onMouseEnter={() => setApiProfileActiveIndex(index)}
                    onKeyDown={(event) => {
                      // 焦点在行内的按钮（图钉/编辑）上时，把按键交给按钮自身处理。
                      if (event.target !== event.currentTarget) {
                        return;
                      }
                      if (event.key === " ") {
                        event.preventDefault();
                        void handleSelectApiProfile(config.profileName);
                      }
                    }}
                    role="button"
                    tabIndex={-1}
                  >
                    <span
                      className="model-dropdown-drag-handle"
                      {...apiConfigReorder.getDragHandleProps(
                        config.profileName,
                      )}
                      title={t("settings.apiDragToReorder", {
                        defaultValue: "Drag to reorder",
                      })}
                    >
                      <GripVertical size={12} />
                    </span>
                    <span
                      className="model-dropdown-item-name"
                      title={config.displayName}
                    >
                      {config.displayName}
                    </span>
                    <span
                      className="model-dropdown-item-model"
                      title={
                        config.advancedModel || config.basicModel || undefined
                      }
                    >
                      {(config.advancedModel || config.basicModel) && (
                        <ModelBrandIcon
                          model={
                            config.advancedModel || config.basicModel || ""
                          }
                          size={12}
                        />
                      )}
                      <span className="model-dropdown-item-model-text">
                        {config.advancedModel || config.basicModel || "-"}
                      </span>
                    </span>
                    {config.profileName === selectedApiProfile && (
                      <Check size={14} className="model-dropdown-check" />
                    )}
                    {config.isActive ? (
                      <span
                        className="model-dropdown-default-mark"
                        title={t("settings.activeProfile", {
                          defaultValue: "Enabled profile",
                        })}
                      >
                        <Pin size={11} fill="currentColor" />
                      </span>
                    ) : (
                      <Tooltip
                        content={t("settings.clickToActivate", {
                          defaultValue: "Set as default profile",
                        })}
                      >
                        <button
                          className="model-dropdown-pin-btn"
                          aria-label={t("settings.clickToActivate", {
                            defaultValue: "Set as default profile",
                          })}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleSetDefaultApiProfile(config);
                          }}
                          disabled={pendingDefaultProfile !== null}
                          type="button"
                        >
                          {pendingDefaultProfile === config.profileName ? (
                            <Loader2 size={12} className="spin" />
                          ) : (
                            <Pin size={12} />
                          )}
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip
                      content={t("settings.apiEditTitle", {
                        defaultValue: "Edit profile",
                      })}
                    >
                      <button
                        className="model-dropdown-edit-btn"
                        aria-label={t("settings.apiEditTitle", {
                          defaultValue: "Edit profile",
                        })}
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingApiConfig(config);
                        }}
                        type="button"
                      >
                        <Pencil size={12} />
                      </button>
                    </Tooltip>
                  </div>
                ))}
              </div>
              <div className="model-dropdown-footer">
                <button
                  className="model-dropdown-action"
                  disabled={!onNavigateToView}
                  onClick={() => {
                    onNavigateToView?.("api-settings");
                    handleToggleModelMenu();
                  }}
                  type="button"
                >
                  <Settings size={14} />
                  <span>{t("settings.apiSettings")}</span>
                </button>
              </div>
            </>
          )}
          {displayView === "model" &&
            (isManualMode ? (
              <>
                <div className="model-menu-header">
                  <button
                    aria-label={t("common.back")}
                    className="model-menu-back"
                    onClick={() => setModelMenuView("root")}
                    type="button"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>{labels.manualModel}</span>
                </div>
                <div className="model-manual-input">
                  <input
                    autoFocus
                    value={manualValue}
                    onChange={(event) => setManualValue(event.target.value)}
                    onKeyDown={handleManualKeyDown}
                    placeholder={labels.manualModelPlaceholder}
                    className="model-manual-field"
                  />
                  <div className="model-manual-actions">
                    <button
                      className="model-manual-btn secondary"
                      onClick={() => setIsManualMode(false)}
                      type="button"
                    >
                      {labels.cancel}
                    </button>
                    <button
                      className="model-manual-btn primary"
                      onClick={() => void handleConfirmManualModel()}
                      disabled={!manualValue.trim()}
                      type="button"
                    >
                      {labels.confirm}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="model-menu-header">
                  <button
                    aria-label={t("common.back")}
                    className="model-menu-back"
                    onClick={() => setModelMenuView("root")}
                    type="button"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>{labels.selectModel}</span>
                </div>
                {modelError && (
                  <div className="model-dropdown-error">
                    <AlertCircle size={14} />
                    <span>{modelError}</span>
                    <button
                      className="model-dropdown-retry"
                      onClick={() => void handleRetryFetchModels()}
                      disabled={isLoadingModels}
                      type="button"
                    >
                      {labels.retry}
                    </button>
                  </div>
                )}
                <div className="model-dropdown-search">
                  <Search size={13} className="model-dropdown-search-icon" />
                  <input
                    autoFocus
                    className="model-dropdown-search-input"
                    type="text"
                    value={modelSearchQuery}
                    onChange={(event) =>
                      setModelSearchQuery(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setModelSearchQuery("");
                      }
                    }}
                    placeholder={labels.searchModels}
                  />
                  {modelSearchQuery && (
                    <button
                      className="model-dropdown-search-clear"
                      type="button"
                      aria-label={labels.searchModels}
                      onClick={() => setModelSearchQuery("")}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
                <div className="model-dropdown-list" ref={modelListRef}>
                  {isLoadingModels ? (
                    <div className="model-dropdown-status" aria-live="polite">
                      <Loader2 size={14} className="spin" />
                      <span>{labels.loadingModels}</span>
                    </div>
                  ) : (
                    <>
                      {models.length === 0 && !modelError && (
                        <div className="model-dropdown-empty">
                          {labels.noModelsFound}
                        </div>
                      )}
                      {models.length > 0 && filteredModels.length === 0 && (
                        <div className="model-dropdown-empty">
                          {labels.noMatchingModels}
                        </div>
                      )}
                      {filteredModels.map((model, index) => (
                        <button
                          key={model.id}
                          className={`model-dropdown-item ${
                            selectedModel === model.id ? "active" : ""
                          } ${modelActiveIndex === index ? "highlighted" : ""}`}
                          onClick={() => void handleSelectModel(model.id)}
                          onMouseEnter={() => setModelActiveIndex(index)}
                          type="button"
                          title={model.id}
                        >
                          <span className="model-dropdown-item-name with-icon">
                            <ModelBrandIcon model={model.id} size={16} />
                            <span className="model-dropdown-item-name-text">
                              {model.id}
                            </span>
                          </span>
                          {selectedModel === model.id && (
                            <Check size={14} className="model-dropdown-check" />
                          )}
                        </button>
                      ))}
                    </>
                  )}
                </div>
                <div className="model-dropdown-footer model-dropdown-footer-actions">
                  <button
                    className="model-dropdown-action"
                    onClick={() => void handleRetryFetchModels()}
                    disabled={isLoadingModels}
                    title={labels.refreshModels}
                    type="button"
                  >
                    <RefreshCw size={14} />
                    <span>{labels.refreshModels}</span>
                  </button>
                  <button
                    className="model-dropdown-action"
                    onClick={handleOpenManualMode}
                    type="button"
                  >
                    <Keyboard size={14} />
                    <span>{labels.manualModel}</span>
                  </button>
                </div>
              </>
            ))}
          {displayView === "thinking" && (
            <ThinkingStrengthMenu
              open={isModelMenuOpen}
              value={thinkingValue}
              options={thinkingOptions}
              subtitle={requestMethod}
              showBack
              onBack={() => setModelMenuView("root")}
              onSelect={(value) => void handleSelectThinking(value)}
            />
          )}
          {displayView === "fastMode" && (
            <>
              <div className="model-menu-header">
                <button
                  aria-label={t("common.back")}
                  className="model-menu-back"
                  onClick={() => setModelMenuView("root")}
                  type="button"
                >
                  <ChevronLeft size={14} />
                </button>
                <span>{t("chat.fastMode")}</span>
              </div>
              <div className="model-dropdown-list">
                {fastModeOptions.map((option) => {
                  const FastModeOptionIcon = option.icon;

                  return (
                    <button
                      key={option.value}
                      className={`model-dropdown-item ${
                        responsesFastMode === option.value ? "active" : ""
                      }`}
                      onClick={() =>
                        void handleSelectResponsesFastMode(option.value)
                      }
                      type="button"
                    >
                      <span className="model-dropdown-item-name with-icon">
                        <FastModeOptionIcon
                          size={14}
                          className="thinking-option-icon"
                        />
                        <span>{option.label}</span>
                      </span>
                      {responsesFastMode === option.value && (
                        <Check size={14} className="model-dropdown-check" />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
      <ApiSettingsEditModal
        config={editingApiConfig}
        onClose={() => setEditingApiConfig(null)}
        onSaved={(list, savedProfileName) => {
          const previousProfileName = editingApiConfig?.profileName ?? null;
          setApiConfigsOverride(list);
          setEditingApiConfig(null);
          handleApiConfigSaved(list, previousProfileName, savedProfileName);
        }}
      />
    </div>
  );
};
