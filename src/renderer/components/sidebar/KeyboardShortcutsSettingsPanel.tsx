import { Keyboard, RotateCcw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useI18n } from "../../i18n";
import { useKeyboardShortcutsSettings } from "../KeyboardShortcutsProvider";
import type {
  KeyboardShortcutAction,
  KeyboardShortcutConfig,
  KeyboardShortcutsSettings,
} from "../../../preload";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_META,
  eventToKey,
  findConflicts,
  isMacOS,
  keyToDisplay,
} from "../../utils/shortcutUtils";

/**
 * 默认按键绑定：用于"恢复默认"操作。
 * 与 Rust seed 默认值保持一致。
 * cycleApiProfile 平台相关：macOS 用 Ctrl+P，其他平台用 Alt+P。
 * toggleWindow 用 mod+shift+h（全局生效，由主进程 globalShortcut 注册）。
 * togglePet 用 mod+shift+p（仅台前生效，由渲染进程快捷键触发）。
 * focusInput 用 mod+i（仅台前生效，由渲染进程快捷键触发）。
 */
const DEFAULT_KEYS: Record<KeyboardShortcutAction, string> = {
  cancelSession: "escape",
  openSearch: "mod+f",
  openMemo: "mod+b",
  openTodo: "mod+t",
  cycleProject: "mod+backtick",
  openProjectExplorer: "mod+d",
  cycleApiProfile: isMacOS() ? "ctrl+p" : "alt+p",
  toggleWindow: "mod+shift+h",
  togglePet: "mod+shift+p",
  focusInput: "mod+i",
};

type KeyboardShortcutsSettingsPanelProps = {
  onClose: () => void;
};

export function KeyboardShortcutsSettingsPanel({
  onClose,
}: KeyboardShortcutsSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const { settings, updateShortcutConfig } = useKeyboardShortcutsSettings();
  const [recordingAction, setRecordingAction] =
    useState<KeyboardShortcutAction | null>(null);

  const handleEnabledChange = useCallback(
    (action: KeyboardShortcutAction) =>
      (event: ChangeEvent<HTMLInputElement>): void => {
        updateShortcutConfig(action, { enabled: event.target.checked });
      },
    [updateShortcutConfig],
  );

  const handleForegroundOnlyChange = useCallback(
    (action: KeyboardShortcutAction) =>
      (event: ChangeEvent<HTMLInputElement>): void => {
        updateShortcutConfig(action, { foregroundOnly: event.target.checked });
      },
    [updateShortcutConfig],
  );

  const startRecording = useCallback((action: KeyboardShortcutAction): void => {
    setRecordingAction(action);
  }, []);

  const cancelRecording = useCallback((): void => {
    setRecordingAction(null);
  }, []);

  const handleReset = useCallback(
    (action: KeyboardShortcutAction): void => {
      updateShortcutConfig(action, { key: DEFAULT_KEYS[action] });
    },
    [updateShortcutConfig],
  );

  const handleResetAll = useCallback((): void => {
    for (const action of SHORTCUT_ACTIONS) {
      updateShortcutConfig(action, { key: DEFAULT_KEYS[action] });
    }
  }, [updateShortcutConfig]);

  // 录制模式：捕获 keydown，绑定新组合键。
  // 特殊处理：cancelSession 录制时 ESC 是有效绑定值；
  //           其他 action 录制时 ESC 用于取消录制。
  useEffect(() => {
    if (!recordingAction) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();

      // cancelSession 允许绑定 Escape（它本就是单键快捷键）
      const isCancelRecording = recordingAction === "cancelSession";
      if (event.key === "Escape" && !isCancelRecording) {
        cancelRecording();
        return;
      }

      const newKey = eventToKey(event);
      if (!newKey) return; // 纯修饰键或不可绑定按键，继续等待

      updateShortcutConfig(recordingAction, { key: newKey });
      cancelRecording();
    };

    // 使用 capture 阶段，确保在全局快捷键引擎之前拦截
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [recordingAction, updateShortcutConfig, cancelRecording]);

  // 卸载或关闭面板时若仍在录制，自动退出
  const recordingActionRef = useRef(recordingAction);
  recordingActionRef.current = recordingAction;
  useEffect(() => {
    return () => {
      recordingActionRef.current = null;
    };
  }, []);

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.keyboardShortcuts", {
              defaultValue: "Keyboard shortcuts",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.keyboardShortcutsInfo", {
              defaultValue:
                "Configure keyboard shortcuts. Each shortcut can be enabled independently and toggled to only work when the app is focused.",
            })}
          </span>
        </div>
        <button
          className="icon-btn ghost"
          onClick={onClose}
          type="button"
          aria-label={t("settings.closePanel", {
            defaultValue: "Close",
          })}
          title={t("settings.closePanel", {
            defaultValue: "Close",
          })}
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.shortcutListTitle", {
              defaultValue: "Shortcut list",
            })}
          </strong>
          <span>
            {t("settings.shortcutListInfo", {
              defaultValue:
                "Toggle each shortcut on or off, and click the key to rebind it.",
            })}
          </span>
        </div>

        <div className="shortcut-list">
          {SHORTCUT_ACTIONS.map((action) => {
            // 防御：native 版本错配导致个别字段缺失时回退默认，避免整页崩溃
            const config: KeyboardShortcutConfig = settings[action] ?? {
              key: DEFAULT_KEYS[action],
              enabled: true,
              foregroundOnly: action !== "toggleWindow",
            };
            const meta = SHORTCUT_META[action];
            const isRecording = recordingAction === action;
            const conflicts = findConflicts(settings, config.key, action);
            const hasConflict = conflicts.length > 0;

            return (
              <div
                className={`shortcut-item${isRecording ? " recording" : ""}${
                  hasConflict ? " conflict" : ""
                }`}
                key={action}
              >
                {/* 启用开关：首位 */}
                <label
                  className="toggle-switch shortcut-enabled-switch"
                  title={t("settings.shortcutEnabled", {
                    defaultValue: "Enabled",
                  })}
                >
                  <input
                    type="checkbox"
                    checked={config.enabled}
                    onChange={handleEnabledChange(action)}
                    hidden
                  />
                  <span className="toggle-slider" />
                </label>

                {/* 按键标签 + 描述：点击进入录制 */}
                <button
                  className="shortcut-info"
                  onClick={() =>
                    isRecording ? cancelRecording() : startRecording(action)
                  }
                  type="button"
                  disabled={!config.enabled && !isRecording}
                  title={t("settings.shortcutClickToRebind", {
                    defaultValue: "Click to rebind",
                  })}
                >
                  <span className="shortcut-key">
                    {isRecording
                      ? t("settings.shortcutRecording", {
                          defaultValue: "Press a key combination...",
                        })
                      : keyToDisplay(config.key)}
                  </span>
                  <span className="shortcut-desc">
                    {t(meta.descKey, { defaultValue: meta.descDefault })}
                  </span>
                  {hasConflict && (
                    <span className="shortcut-conflict-hint">
                      {t("settings.shortcutConflict", {
                        defaultValue: "Conflicts with: {{actions}}",
                        values: {
                          actions: conflicts
                            .map((c) =>
                              t(SHORTCUT_META[c].descKey, {
                                defaultValue: SHORTCUT_META[c].descDefault,
                              }),
                            )
                            .join(", "),
                        },
                      })}
                    </span>
                  )}
                </button>

                {/* 仅前台开关 + 恢复默认。
                    toggleWindow 不显示"仅前台"开关：它由主进程 globalShortcut
                    注册，本质就是全局生效（窗口隐藏时也要能呼出），
                    该开关对它无意义。 */}
                <div className="shortcut-toggles">
                  {action !== "toggleWindow" && (
                    <label className="toggle-switch shortcut-foreground-switch">
                      <input
                        type="checkbox"
                        checked={config.foregroundOnly}
                        onChange={handleForegroundOnlyChange(action)}
                        disabled={!config.enabled}
                        hidden
                      />
                      <span className="toggle-slider" />
                      <span>
                        {t("settings.shortcutForegroundOnly", {
                          defaultValue: "Foreground only",
                        })}
                      </span>
                    </label>
                  )}
                  {config.key !== DEFAULT_KEYS[action] && (
                    <button
                      className="icon-btn ghost shortcut-reset-btn"
                      onClick={() => handleReset(action)}
                      type="button"
                      title={t("settings.shortcutReset", {
                        defaultValue: "Reset to default",
                      })}
                      aria-label={t("settings.shortcutReset", {
                        defaultValue: "Reset to default",
                      })}
                    >
                      <RotateCcw size={13} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {recordingAction && (
          <p className="shortcut-recording-hint">
            <Keyboard size={13} strokeWidth={1.8} />
            {t("settings.shortcutRecordingHint", {
              defaultValue: "Press a key combo to bind, or Esc to cancel",
            })}
          </p>
        )}

        <p className="shortcut-note">
          {t("settings.shortcutForegroundOnlyNote", {
            defaultValue:
              'When "Foreground only" is on, the shortcut only works while the app window is focused. When off, it works as long as the process is running (limited to app-focused scenarios in the current implementation).',
          })}
        </p>

        <div className="api-settings-form-actions">
          <button
            className="api-settings-form-btn secondary"
            onClick={handleResetAll}
            type="button"
          >
            <RotateCcw size={15} strokeWidth={1.9} />
            <span>
              {t("settings.shortcutReset", {
                defaultValue: "Reset to default",
              })}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

// 保持 Settings 类型引用，避免未使用导入告警（类型用于工具函数签名一致性）
export type { KeyboardShortcutsSettings };
