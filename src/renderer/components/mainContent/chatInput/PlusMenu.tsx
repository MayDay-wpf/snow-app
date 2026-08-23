import {
  ArrowDownToLine,
  ClipboardList,
  Feather,
  GitBranch,
  Plus,
  ShieldAlert,
  Target,
  Wand2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
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
  planMode: boolean;
  isUpdatingPlanMode: boolean;
  onPlanModeChange?: (enabled: boolean) => void;
  onRefreshPlanMode?: () => void | Promise<boolean | void>;
  goalMode: boolean;
  isUpdatingGoalMode: boolean;
  onGoalModeChange?: (enabled: boolean) => void;
  onRefreshGoalMode?: () => void | Promise<boolean | void>;
  worktreeMode: boolean;
  isUpdatingWorktreeMode: boolean;
  onWorktreeModeChange?: (enabled: boolean) => void;
  onRefreshWorktreeMode?: () => void | Promise<boolean | void>;
  goalModeTokenBudget: number;
  onGoalModeTokenBudgetChange?: (budget: number) => void;
  autoScrollEnabled: boolean;
  onAutoScrollChange?: (enabled: boolean) => void;
  autoFormatEnabled: boolean;
  onAutoFormatChange?: (enabled: boolean) => void;
  onRefreshAutoFormat?: () => void | Promise<boolean | void>;
};

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
  planMode,
  isUpdatingPlanMode,
  onPlanModeChange,
  onRefreshPlanMode,
  goalMode,
  isUpdatingGoalMode,
  onGoalModeChange,
  onRefreshGoalMode,
  worktreeMode,
  isUpdatingWorktreeMode,
  onWorktreeModeChange,
  onRefreshWorktreeMode,
  goalModeTokenBudget,
  onGoalModeTokenBudgetChange,
  autoScrollEnabled,
  onAutoScrollChange,
  autoFormatEnabled,
  onAutoFormatChange,
  onRefreshAutoFormat,
}: PlusMenuProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownDir = useDropdownDirection(containerRef, isOpen);
  const [showGoalBudget, setShowGoalBudget] = useState(false);

  useEffect(() => {
    if (!goalMode) {
      setShowGoalBudget(false);
    }
  }, [goalMode]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        // Re-read the persisted app setting whenever the menu opens.
        void onRefreshYoloMode?.();
        void onRefreshLiteMode?.();
        void onRefreshPlanMode?.();
        void onRefreshGoalMode?.();
        void onRefreshWorktreeMode?.();
        void onRefreshAutoFormat?.();
      }
      return next;
    });
  }, [
    onRefreshYoloMode,
    onRefreshLiteMode,
    onRefreshPlanMode,
    onRefreshGoalMode,
    onRefreshWorktreeMode,
    onRefreshAutoFormat,
  ]);

  const handleItemClick = useCallback(
    (item: PlusMenuItem) => {
      item.onSelect();
      handleClose();
    },
    [handleClose],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleDocumentPointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
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
      {isOpen && (
        <div className={`plus-menu-dropdown drop-${dropdownDir}`}>
          {sections.map((section, sectionIndex) => (
            <div key={section.id} className="plus-menu-section">
              <div className="plus-menu-section-title">{section.label}</div>
              {section.items.map((item) => {
                const ItemIcon = item.icon;
                return (
                  <button
                    key={item.id}
                    className="plus-menu-item"
                    onClick={() => handleItemClick(item)}
                    type="button"
                  >
                    <ItemIcon size={14} className="plus-menu-item-icon" />
                    <div className="plus-menu-item-content">
                      <span className="plus-menu-item-label">{item.label}</span>
                      {item.description && (
                        <span className="plus-menu-item-description">
                          {item.description}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
              {sectionIndex < sections.length - 1 && (
                <div className="plus-menu-section-divider" />
              )}
            </div>
          ))}
          <div className="plus-menu-section">
            <div className="plus-menu-section-divider" />
            <div className="plus-menu-section-title">
              {t("plusMenu.sectionMode")}
            </div>
            <div className="plus-menu-item plus-menu-yolo-item">
              <ArrowDownToLine size={14} className="plus-menu-item-icon" />
              <div className="plus-menu-item-content">
                <span className="plus-menu-item-label">
                  {t("plusMenu.autoScroll")}
                </span>
                <span className="plus-menu-item-description">
                  {t("plusMenu.autoScrollDescription")}
                </span>
              </div>
              <label className="toggle-switch plus-menu-yolo-switch">
                <input
                  aria-label={t("plusMenu.autoScroll")}
                  checked={autoScrollEnabled}
                  disabled={!onAutoScrollChange}
                  onChange={() => {
                    onAutoScrollChange?.(!autoScrollEnabled);
                  }}
                  type="checkbox"
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="plus-menu-item plus-menu-yolo-item">
              <Wand2 size={14} className="plus-menu-item-icon" />
              <div className="plus-menu-item-content">
                <span className="plus-menu-item-label">
                  {t("plusMenu.autoFormat")}
                </span>
                <span className="plus-menu-item-description">
                  {t("plusMenu.autoFormatDescription")}
                </span>
              </div>
              <label className="toggle-switch plus-menu-yolo-switch">
                <input
                  aria-label={t("plusMenu.autoFormat")}
                  checked={autoFormatEnabled}
                  disabled={!onAutoFormatChange}
                  onChange={() => {
                    onAutoFormatChange?.(!autoFormatEnabled);
                  }}
                  type="checkbox"
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="plus-menu-item plus-menu-yolo-item">
              <ShieldAlert size={14} className="plus-menu-item-icon" />
              <div className="plus-menu-item-content">
                <span className="plus-menu-item-label">
                  {t("plusMenu.yoloMode")}
                </span>
                <span className="plus-menu-item-description">
                  {t("plusMenu.yoloModeDescription")}
                </span>
              </div>
              <label className="toggle-switch plus-menu-yolo-switch">
                <input
                  aria-label={t("plusMenu.yoloMode")}
                  checked={yoloMode}
                  disabled={isUpdatingYoloMode || !onYoloModeChange}
                  onChange={() => {
                    void onYoloModeChange?.(!yoloMode);
                  }}
                  type="checkbox"
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="plus-menu-item plus-menu-yolo-item">
              <Feather size={14} className="plus-menu-item-icon" />
              <div className="plus-menu-item-content">
                <span className="plus-menu-item-label">
                  {t("plusMenu.liteMode")}
                </span>
                <span className="plus-menu-item-description">
                  {t("plusMenu.liteModeDescription")}
                </span>
              </div>
              <label className="toggle-switch plus-menu-yolo-switch">
                <input
                  aria-label={t("plusMenu.liteMode")}
                  checked={liteMode}
                  disabled={isUpdatingLiteMode || !onLiteModeChange}
                  onChange={() => {
                    void onLiteModeChange?.(!liteMode);
                  }}
                  type="checkbox"
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="plus-menu-item plus-menu-yolo-item">
              <ClipboardList size={14} className="plus-menu-item-icon" />
              <div className="plus-menu-item-content">
                <span className="plus-menu-item-label">
                  {t("plusMenu.planMode")}
                </span>
                <span className="plus-menu-item-description">
                  {t("plusMenu.planModeDescription")}
                </span>
              </div>
              <label className="toggle-switch plus-menu-yolo-switch">
                <input
                  aria-label={t("plusMenu.planMode")}
                  checked={planMode}
                  disabled={isUpdatingPlanMode || !onPlanModeChange}
                  onChange={() => {
                    void onPlanModeChange?.(!planMode);
                  }}
                  type="checkbox"
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="plus-menu-item plus-menu-yolo-item">
              <GitBranch size={14} className="plus-menu-item-icon" />
              <div className="plus-menu-item-content">
                <span className="plus-menu-item-label">
                  {t("plusMenu.worktreeMode")}
                </span>
                <span className="plus-menu-item-description">
                  {t("plusMenu.worktreeModeDescription")}
                </span>
              </div>
              <label className="toggle-switch plus-menu-yolo-switch">
                <input
                  aria-label={t("plusMenu.worktreeMode")}
                  checked={worktreeMode}
                  disabled={isUpdatingWorktreeMode || !onWorktreeModeChange}
                  onChange={() => {
                    void onWorktreeModeChange?.(!worktreeMode);
                  }}
                  type="checkbox"
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="plus-menu-item plus-menu-yolo-item">
              <Target size={14} className="plus-menu-item-icon" />
              <div className="plus-menu-item-content">
                <span className="plus-menu-item-label">
                  {t("plusMenu.goalMode")}
                </span>
                <span className="plus-menu-item-description">
                  {t("plusMenu.goalModeDescription")}
                </span>
              </div>
              <label className="toggle-switch plus-menu-yolo-switch">
                <input
                  aria-label={t("plusMenu.goalMode")}
                  checked={goalMode}
                  disabled={isUpdatingGoalMode || !onGoalModeChange}
                  onChange={() => {
                    void onGoalModeChange?.(!goalMode);
                  }}
                  type="checkbox"
                />
                <span className="toggle-slider" />
              </label>
            </div>
            {goalMode && (
              <div className="plus-menu-goal-budget-panel">
                <div className="plus-menu-goal-budget-title">
                  {t("plusMenu.goalBudgetTitle")}
                </div>
                <div className="plus-menu-goal-budget-input-row">
                  <input
                    className="plus-menu-goal-budget-input"
                    type="number"
                    min={10000}
                    step={100000}
                    value={goalModeTokenBudget}
                    disabled={goalModeTokenBudget <= 0}
                    onChange={(e) => {
                      const value = parseInt(e.target.value, 10);
                      if (!Number.isNaN(value) && value > 0) {
                        onGoalModeTokenBudgetChange?.(value);
                      }
                    }}
                    aria-label={t("plusMenu.goalBudgetTitle")}
                  />
                  <span className="plus-menu-goal-budget-unit">tokens</span>
                </div>
                <label className="plus-menu-goal-unlimited-row">
                  <input
                    type="checkbox"
                    checked={goalModeTokenBudget <= 0}
                    onChange={(e) => {
                      // 0 = unlimited (no budget section is injected into the
                      // Goal Mode system prompt); unchecking restores the
                      // built-in default budget.
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
          </div>
        </div>
      )}
    </div>
  );
};
