import {
  ChevronRight,
  ClipboardList,
  Drill,
  Feather,
  GitBranch,
  Layers,
  Plus,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Target,
  Wand2,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import { Tooltip } from "../../common/Tooltip";
import { useReplyPredictionPreference } from "../../../hooks/useReplyPredictionPreference";
import { useDropdownDirection } from "./useDropdownDirection";

export type PlusMenuItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  description?: string;
  onSelect: () => void;
};

export type PlusMenuSection = {
  id: string;
  label: string;
  items: PlusMenuItem[];
};

export type PlusMenuProps = {
  sections: PlusMenuSection[];
  yoloMode: boolean;
  isUpdatingYoloMode: boolean;
  onYoloModeChange?: (enabled: boolean) => void;
  onRefreshYoloMode?: () => void | Promise<boolean | void>;
  liteMode: boolean;
  isUpdatingLiteMode: boolean;
  onLiteModeChange?: (enabled: boolean) => void;
  onRefreshLiteMode?: () => void | Promise<boolean | void>;
  goalMode: boolean;
  isUpdatingGoalMode: boolean;
  onGoalModeChange?: (enabled: boolean) => void;
  onRefreshGoalMode?: () => void | Promise<boolean | void>;
  worktreeMode: boolean;
  isUpdatingWorktreeMode: boolean;
  onWorktreeModeChange?: (enabled: boolean) => void;
  onRefreshWorktreeMode?: () => void | Promise<boolean | void>;
  workflowMode: boolean;
  isUpdatingWorkflowMode: boolean;
  onWorkflowModeChange?: (enabled: boolean) => void;
  onRefreshWorkflowMode?: () => void | Promise<boolean | void>;
  modesLocked?: boolean;
  goalModeTokenBudget: number;
  onGoalModeTokenBudgetChange?: (budget: number) => void;
  autoFormatEnabled: boolean;
  onAutoFormatChange?: (enabled: boolean) => void;
  onRefreshAutoFormat?: () => void | Promise<boolean | void>;
  toolCorrectionEnabled: boolean;
  onToolCorrectionChange?: (enabled: boolean) => void;
  onRefreshToolCorrection?: () => void | Promise<boolean | void>;
  contextFoldEnabled: boolean;
  onContextFoldChange?: (enabled: boolean) => void;
  onRefreshContextFold?: () => void | Promise<boolean | void>;
};

type PlusToggleRowProps = {
  icon: LucideIcon;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  locked?: boolean;
  lockedTitle?: string;
  onChange?: () => void;
};

// 说明文字改为悬停 Tooltip，锁定提示一并合入
const PlusToggleRow = ({
  icon: Icon,
  label,
  description,
  checked,
  disabled = false,
  locked = false,
  lockedTitle,
  onChange,
}: PlusToggleRowProps): React.JSX.Element => (
  <Tooltip
    placement="right"
    content={
      locked && lockedTitle ? (
        <>
          <div>{description}</div>
          <div className="plus-menu-tooltip-locked">{lockedTitle}</div>
        </>
      ) : (
        description
      )
    }
  >
    {/* 整行使用 label 承载原生激活，内部开关用 span，避免 JS 冒泡导致双重切换 */}
    <label
      className={`plus-menu-item plus-menu-yolo-item${locked ? " is-locked" : ""}`}
    >
      <Icon size={14} className="plus-menu-item-icon" />
      <span className="plus-menu-item-content">
        <span className="plus-menu-item-label">{label}</span>
      </span>
      <span className="toggle-switch plus-menu-yolo-switch">
        <input
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          type="checkbox"
        />
        <span className="toggle-slider" />
      </span>
    </label>
  </Tooltip>
);

// 模式二级面板定位参数（固定定位挂到 body，宽度随内容）
const MODE_FLYOUT_MIN_WIDTH = 200;
const MODE_FLYOUT_GAP = 6;

export const PlusMenu = ({
  sections,
  yoloMode,
  isUpdatingYoloMode,
  onYoloModeChange,
  onRefreshYoloMode,
  liteMode,
  isUpdatingLiteMode,
  onLiteModeChange,
  onRefreshLiteMode,
  goalMode,
  isUpdatingGoalMode,
  onGoalModeChange,
  onRefreshGoalMode,
  worktreeMode,
  isUpdatingWorktreeMode,
  onWorktreeModeChange,
  onRefreshWorktreeMode,
  workflowMode,
  isUpdatingWorkflowMode,
  onWorkflowModeChange,
  onRefreshWorkflowMode,
  modesLocked = false,
  goalModeTokenBudget,
  onGoalModeTokenBudgetChange,
  autoFormatEnabled,
  onAutoFormatChange,
  onRefreshAutoFormat,
  toolCorrectionEnabled,
  onToolCorrectionChange,
  onRefreshToolCorrection,
  contextFoldEnabled,
  onContextFoldChange,
  onRefreshContextFold,
}: PlusMenuProps): React.JSX.Element => {
  const { t } = useI18n();
  const { replyPredictionEnabled, setReplyPredictionEnabled } =
    useReplyPredictionPreference();
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownDir = useDropdownDirection(containerRef, isOpen);
  const [showGoalBudget, setShowGoalBudget] = useState(false);
  const [isModesOpen, setIsModesOpen] = useState(false);
  const [modeFlyoutPosition, setModeFlyoutPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const modesTriggerRef = useRef<HTMLButtonElement>(null);
  const modesFlyoutRef = useRef<HTMLDivElement>(null);
  const modeCloseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!goalMode) {
      setShowGoalBudget(false);
    }
  }, [goalMode]);

  useEffect(() => {
    if (!isOpen) {
      setIsModesOpen(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isClosing) {
      return;
    }
    const timer = window.setTimeout(() => setIsClosing(false), 160);
    return () => window.clearTimeout(timer);
  }, [isClosing]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setIsClosing(true);
  }, []);

  const handleToggle = useCallback(() => {
    setIsClosing(false);
    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        // Re-read the persisted app setting whenever the menu opens.
        void onRefreshYoloMode?.();
        void onRefreshLiteMode?.();
        void onRefreshGoalMode?.();
        void onRefreshWorktreeMode?.();
        void onRefreshWorkflowMode?.();
        void onRefreshAutoFormat?.();
        void onRefreshToolCorrection?.();
        void onRefreshContextFold?.();
      }
      return next;
    });
  }, [
    onRefreshYoloMode,
    onRefreshLiteMode,
    onRefreshGoalMode,
    onRefreshWorktreeMode,
    onRefreshWorkflowMode,
    onRefreshAutoFormat,
    onRefreshToolCorrection,
    onRefreshContextFold,
  ]);

  const handleItemClick = useCallback(
    (item: PlusMenuItem) => {
      item.onSelect();
      handleClose();
    },
    [handleClose],
  );

  const clearModeCloseTimer = useCallback(() => {
    if (modeCloseTimerRef.current !== null) {
      window.clearTimeout(modeCloseTimerRef.current);
      modeCloseTimerRef.current = null;
    }
  }, []);

  const openModeFlyout = useCallback(() => {
    clearModeCloseTimer();
    setIsModesOpen(true);
  }, [clearModeCloseTimer]);

  // 悬停留出缓冲，避免指针穿过间隙时面板闪退
  const scheduleCloseModeFlyout = useCallback(() => {
    clearModeCloseTimer();
    modeCloseTimerRef.current = window.setTimeout(() => {
      modeCloseTimerRef.current = null;
      setIsModesOpen(false);
    }, 140);
  }, [clearModeCloseTimer]);

  useEffect(() => {
    return () => {
      clearModeCloseTimer();
    };
  }, [clearModeCloseTimer]);

  const updateModeFlyoutPosition = useCallback(() => {
    const trigger = modesTriggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const maxHeight = Math.min(420, Math.round(window.innerHeight * 0.6));
    const width = modesFlyoutRef.current?.offsetWidth || MODE_FLYOUT_MIN_WIDTH;
    let left = rect.right + MODE_FLYOUT_GAP;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, rect.left - width - MODE_FLYOUT_GAP);
    }
    const height = Math.min(
      modesFlyoutRef.current?.offsetHeight ?? maxHeight,
      maxHeight,
    );
    // 二级面板在侧面展开：优先向上，底部与触发项底部对齐
    let top = rect.bottom - height;
    if (top < 8) {
      // 上方空间不足时改回向下展开
      top = rect.top;
      if (top + height > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - 8 - height);
      }
    }
    setModeFlyoutPosition({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!isModesOpen) {
      setModeFlyoutPosition(null);
      return;
    }
    updateModeFlyoutPosition();
    const raf = window.requestAnimationFrame(updateModeFlyoutPosition);
    window.addEventListener("resize", updateModeFlyoutPosition);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateModeFlyoutPosition);
    };
    // goalMode 切换会增减预算行，需重新测量尺寸
  }, [isModesOpen, goalMode, updateModeFlyoutPosition]);

  const modeItemTitle = modesLocked
    ? t("plusMenu.modeLockedRunning")
    : undefined;

  const activeModeLabels = [
    yoloMode ? t("plusMenu.yoloMode") : null,
    liteMode ? t("plusMenu.liteMode") : null,
    worktreeMode ? t("plusMenu.worktreeMode") : null,
    workflowMode ? t("plusMenu.workflowMode") : null,
    goalMode ? t("plusMenu.goalMode") : null,
  ].filter((label): label is string => Boolean(label));
  const activeModeSummary =
    activeModeLabels.length > 0
      ? activeModeLabels.join(" · ")
      : t("plusMenu.modeNone");

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // 二级面板挂在 body 上，需单独放行
      if (modesFlyoutRef.current?.contains(target)) {
        return;
      }
      if (containerRef.current && !containerRef.current.contains(target)) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handleDocumentPointerDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentPointerDown);
    };
  }, [isOpen, handleClose]);

  return (
    <div className="plus-menu" ref={containerRef}>
      <button
        className="toolbar-btn plus-trigger"
        aria-label={t("plusMenu.label")}
        aria-expanded={isOpen}
        onClick={handleToggle}
        type="button"
      >
        <Plus size={16} />
      </button>
      {(isOpen || isClosing) && (
        <div
          className={`plus-menu-dropdown drop-${dropdownDir}${
            isClosing ? " is-closing" : ""
          }`}
          onScroll={() => {
            // 滚动后触发器位置失效，收掉二级面板
            if (isModesOpen) {
              setIsModesOpen(false);
            }
          }}
        >
          {sections.map((section, sectionIndex) => (
            <div key={section.id} className="plus-menu-section">
              <div className="plus-menu-section-title">{section.label}</div>
              {section.items.map((item) => {
                const ItemIcon = item.icon;
                const button = (
                  <button
                    className="plus-menu-item"
                    onClick={() => handleItemClick(item)}
                    type="button"
                  >
                    <ItemIcon size={14} className="plus-menu-item-icon" />
                    <div className="plus-menu-item-content">
                      <span className="plus-menu-item-label">{item.label}</span>
                    </div>
                  </button>
                );
                return item.description ? (
                  <Tooltip
                    key={item.id}
                    placement="right"
                    content={item.description}
                  >
                    {button}
                  </Tooltip>
                ) : (
                  <Fragment key={item.id}>{button}</Fragment>
                );
              })}
              {sectionIndex < sections.length - 1 && (
                <div className="plus-menu-section-divider" />
              )}
            </div>
          ))}
          <div className="plus-menu-section">
            {sections.length > 0 && (
              <div className="plus-menu-section-divider" />
            )}
            <div className="plus-menu-section-title">
              {t("plusMenu.sectionPreferences")}
            </div>
            <PlusToggleRow
              icon={Wand2}
              label={t("plusMenu.autoFormat")}
              description={t("plusMenu.autoFormatDescription")}
              checked={autoFormatEnabled}
              disabled={!onAutoFormatChange}
              onChange={() => {
                onAutoFormatChange?.(!autoFormatEnabled);
              }}
            />
            <PlusToggleRow
              icon={Sparkles}
              label={t("plusMenu.replyPrediction")}
              description={t("plusMenu.replyPredictionDescription")}
              checked={replyPredictionEnabled}
              onChange={() => {
                setReplyPredictionEnabled(!replyPredictionEnabled);
              }}
            />
            <PlusToggleRow
              icon={Drill}
              label={t("plusMenu.toolCorrection")}
              description={t("plusMenu.toolCorrectionDescription")}
              checked={toolCorrectionEnabled}
              disabled={!onToolCorrectionChange}
              onChange={() => {
                onToolCorrectionChange?.(!toolCorrectionEnabled);
              }}
            />
            <PlusToggleRow
              icon={Layers}
              label={t("plusMenu.contextFold")}
              description={t("plusMenu.contextFoldDescription")}
              checked={contextFoldEnabled}
              disabled={!onContextFoldChange}
              onChange={() => {
                onContextFoldChange?.(!contextFoldEnabled);
              }}
            />
          </div>
          <div className="plus-menu-section">
            <div className="plus-menu-section-divider" />
            <button
              ref={modesTriggerRef}
              type="button"
              className={`plus-menu-item plus-menu-submenu-trigger${
                isModesOpen ? " is-open" : ""
              }`}
              aria-haspopup="true"
              aria-expanded={isModesOpen}
              onMouseEnter={openModeFlyout}
              onMouseLeave={scheduleCloseModeFlyout}
              onFocus={openModeFlyout}
              onClick={openModeFlyout}
            >
              <SlidersHorizontal size={14} className="plus-menu-item-icon" />
              <div className="plus-menu-item-content">
                <span className="plus-menu-item-label">
                  {t("plusMenu.sectionMode")}
                </span>
                <span className="plus-menu-item-description">
                  {activeModeSummary}
                </span>
              </div>
              <ChevronRight size={14} className="plus-menu-submenu-chevron" />
            </button>
            {isModesOpen &&
              createPortal(
                <div
                  ref={modesFlyoutRef}
                  className="plus-menu-modes-flyout"
                  style={{
                    left: modeFlyoutPosition?.left ?? 0,
                    top: modeFlyoutPosition?.top ?? 0,
                    visibility: modeFlyoutPosition ? "visible" : "hidden",
                  }}
                  onMouseEnter={clearModeCloseTimer}
                  onMouseLeave={scheduleCloseModeFlyout}
                >
                  <PlusToggleRow
                    icon={ShieldAlert}
                    label={t("plusMenu.yoloMode")}
                    description={t("plusMenu.yoloModeDescription")}
                    checked={yoloMode}
                    disabled={isUpdatingYoloMode || !onYoloModeChange}
                    onChange={() => {
                      void onYoloModeChange?.(!yoloMode);
                    }}
                  />
                  <PlusToggleRow
                    icon={Feather}
                    label={t("plusMenu.liteMode")}
                    description={t("plusMenu.liteModeDescription")}
                    checked={liteMode}
                    disabled={
                      modesLocked || isUpdatingLiteMode || !onLiteModeChange
                    }
                    locked={modesLocked}
                    lockedTitle={modeItemTitle}
                    onChange={() => {
                      void onLiteModeChange?.(!liteMode);
                    }}
                  />
                  <PlusToggleRow
                    icon={GitBranch}
                    label={t("plusMenu.worktreeMode")}
                    description={t("plusMenu.worktreeModeDescription")}
                    checked={worktreeMode}
                    disabled={
                      modesLocked ||
                      isUpdatingWorktreeMode ||
                      !onWorktreeModeChange
                    }
                    locked={modesLocked}
                    lockedTitle={modeItemTitle}
                    onChange={() => {
                      void onWorktreeModeChange?.(!worktreeMode);
                    }}
                  />
                  <PlusToggleRow
                    icon={Workflow}
                    label={t("plusMenu.workflowMode")}
                    description={t("plusMenu.workflowModeDescription")}
                    checked={workflowMode}
                    disabled={
                      modesLocked ||
                      isUpdatingWorkflowMode ||
                      !onWorkflowModeChange
                    }
                    locked={modesLocked}
                    lockedTitle={modeItemTitle}
                    onChange={() => {
                      void onWorkflowModeChange?.(!workflowMode);
                    }}
                  />
                  <PlusToggleRow
                    icon={Target}
                    label={t("plusMenu.goalMode")}
                    description={t("plusMenu.goalModeDescription")}
                    checked={goalMode}
                    disabled={
                      modesLocked || isUpdatingGoalMode || !onGoalModeChange
                    }
                    locked={modesLocked}
                    lockedTitle={modeItemTitle}
                    onChange={() => {
                      void onGoalModeChange?.(!goalMode);
                    }}
                  />
                  {goalMode && (
                    <div className="plus-menu-goal-budget-row">
                      <span className="plus-menu-goal-budget-title">
                        {t("plusMenu.goalBudgetTitle")}
                      </span>
                      <input
                        className="plus-menu-goal-budget-input"
                        type="number"
                        min={10000}
                        step={100000}
                        value={goalModeTokenBudget}
                        disabled={modesLocked || goalModeTokenBudget <= 0}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10);
                          if (!Number.isNaN(value) && value > 0) {
                            onGoalModeTokenBudgetChange?.(value);
                          }
                        }}
                        aria-label={t("plusMenu.goalBudgetTitle")}
                      />
                      <span className="plus-menu-goal-budget-unit">tokens</span>
                      <label className="plus-menu-goal-unlimited-row">
                        <input
                          type="checkbox"
                          checked={goalModeTokenBudget <= 0}
                          disabled={modesLocked}
                          onChange={(e) => {
                            // 0 = unlimited；取消勾选恢复默认预算
                            onGoalModeTokenBudgetChange?.(
                              e.target.checked ? 0 : 2000000,
                            );
                          }}
                          aria-label={t("plusMenu.goalBudgetUnlimited")}
                        />
                        <span>{t("plusMenu.goalBudgetUnlimited")}</span>
                      </label>
                    </div>
                  )}
                </div>,
                document.body,
              )}
          </div>
        </div>
      )}
    </div>
  );
};
