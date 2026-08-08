import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { useI18n } from "../../i18n";
import { useBlurAutoSave } from "../../hooks/useBlurAutoSave";
import { TerminalSettingsForm } from "./terminalSettings/TerminalSettingsForm";
import { TerminalSettingsSummary } from "./terminalSettings/TerminalSettingsSummary";
import {
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_SETTING_CODE,
  TERMINAL_SETTING_NAME,
} from "./terminalSettings/terminalSettingsConstants";
import {
  readTerminalSettingsJson,
  toTerminalForm,
  toTerminalSettings,
} from "./terminalSettings/terminalSettingsUtils";
import { notifyTerminalSettingsChanged } from "../rightPanel/useTerminalSettings";
import type {
  DetectedTerminalOption,
  TerminalSettingsForm as TerminalSettingsFormValue,
  TerminalSettingsPanelProps,
  TerminalSettingsValue,
} from "./terminalSettings/types";

export function TerminalSettingsPanel({
  onClose,
}: TerminalSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState<TerminalSettingsFormValue>(() =>
    toTerminalForm(DEFAULT_TERMINAL_SETTINGS)
  );
  const [lastSaved, setLastSaved] = useState<TerminalSettingsValue>(
    DEFAULT_TERMINAL_SETTINGS
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSelectingExecutable, setIsSelectingExecutable] = useState(false);
  const [detectedTerminals, setDetectedTerminals] = useState<
    DetectedTerminalOption[]
  >([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const isMountedRef = useRef(true);

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
      const [value, terminals] = await Promise.all([
        window.snow.getSystemSettingValue(TERMINAL_SETTING_CODE),
        window.snow.detectTerminals(),
      ]);
      const settings = readTerminalSettingsJson(value);
      setForm(toTerminalForm(settings));
      setLastSaved(settings);
      setDetectedTerminals(terminals);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.terminalLoadError", {
              defaultValue: "Failed to load terminal settings",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const isBusy = isLoading || isSaving || isSelectingExecutable;
  const preview = toTerminalSettings(form);

  const updateField =
    (field: keyof TerminalSettingsFormValue) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = event.target.value;
      setForm((previous) => ({ ...previous, [field]: value }));
    };

  const setValue = (field: keyof TerminalSettingsFormValue, value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }));
  };

  const validate = useCallback(
    (currentForm: TerminalSettingsFormValue): string | null => {
      const fontSize = Number.parseFloat(currentForm.fontSize);
      const lineHeight = Number.parseFloat(currentForm.lineHeight);

      if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 72) {
        return t("settings.terminalFontSizeValidationError", {
          defaultValue: "Font size must be between 6 and 72.",
        });
      }

      if (!Number.isFinite(lineHeight) || lineHeight < 0.5 || lineHeight > 3) {
        return t("settings.terminalLineHeightValidationError", {
          defaultValue: "Line height must be between 0.5 and 3.",
        });
      }

      return null;
    },
    [t]
  );

  const saveSettings = useCallback(
    async (settings: TerminalSettingsValue) => {
      setIsSaving(true);
      setError("");
      try {
        // 校验 shell 路径有效性：非空时含路径分隔符的路径必须真实存在，
        // 避免保存后终端无法启动（纯文件名交由运行时按 PATH 解析）。
        if (settings.shellPath) {
          const shellValidation = await window.snow.validateTerminalShellPath(
            settings.shellPath
          );
          if (!shellValidation.valid) {
            if (isMountedRef.current) {
              setError(
                t("settings.terminalShellPathValidationError", {
                  defaultValue:
                    "Shell executable does not exist. Check the path or leave it empty to auto-detect.",
                })
              );
            }
            return;
          }
        }
        await window.snow.setSystemSetting(
          TERMINAL_SETTING_NAME,
          TERMINAL_SETTING_CODE,
          JSON.stringify(settings)
        );
        if (isMountedRef.current) {
          setLastSaved(settings);
          notifyTerminalSettingsChanged();
          setStatus(
            t("settings.terminalSaveSuccess", {
              defaultValue: "Saved terminal settings.",
            })
          );
        }
      } catch (e) {
        if (isMountedRef.current) {
          setError(
            e instanceof Error
              ? e.message
              : t("settings.terminalSaveError", {
                  defaultValue: "Failed to save terminal settings",
                })
          );
        }
      } finally {
        if (isMountedRef.current) {
          setIsSaving(false);
        }
      }
    },
    [t]
  );

  // 失焦保存：输入框真正失焦、下拉控件完成选择时立即保存（选择时携带新值调用），
  // 验证失败则不保存，卸载时立即冲刷避免丢失。
  const commitSave = useBlurAutoSave(
    form,
    validate,
    toTerminalSettings,
    lastSaved,
    saveSettings,
    setError
  );

  const handleSelectExecutable = async () => {
    setIsSelectingExecutable(true);
    setError("");
    setStatus("");

    try {
      const selectedPath = await window.snow.selectTerminalExecutable(
        t("settings.terminalSelectExecutableDialogTitle", {
          defaultValue: "Select terminal executable",
        })
      );

      if (selectedPath) {
        setForm((previous) => ({ ...previous, shellPath: selectedPath }));
        commitSave({ ...form, shellPath: selectedPath });
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.terminalExecutableSelectError", {
              defaultValue: "Failed to select terminal executable",
            })
      );
    } finally {
      setIsSelectingExecutable(false);
    }
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.terminalTitle", {
              defaultValue: "Terminal settings",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.terminalSettingsInfo", {
              defaultValue: "Configure terminal shell, font, and appearance.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeTerminalSettings", {
              defaultValue: "Close terminal settings",
            })}
            title={t("settings.closeTerminalSettings", {
              defaultValue: "Close terminal settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <span>
              {t("settings.terminalLoading", {
                defaultValue: "Loading terminal settings...",
              })}
            </span>
          </div>
        </div>
      ) : (
        <>
          <TerminalSettingsSummary preview={preview} />

          <AutoDismissNotice
            message={error || status}
            tone={error ? "error" : "success"}
            onDismiss={() => {
              setError("");
              setStatus("");
            }}
          />

          <TerminalSettingsForm
            form={form}
            isBusy={isBusy}
            isSelectingExecutable={isSelectingExecutable}
            detectedTerminals={detectedTerminals}
            onUpdateField={updateField}
            onSetValue={setValue}
            onBlurSave={commitSave}
            onShellPathChange={(path) =>
              setForm((previous) => ({ ...previous, shellPath: path }))
            }
            onReset={() => {
              const defaults = toTerminalForm(DEFAULT_TERMINAL_SETTINGS);
              setForm(defaults);
              void saveSettings(DEFAULT_TERMINAL_SETTINGS);
            }}
            onSelectExecutable={() => void handleSelectExecutable()}
          />
        </>
      )}
    </div>
  );
}
