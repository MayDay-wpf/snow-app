import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AutoDismissNotice } from "../AutoDismissNotice";
import { useBlurAutoSave } from "../../hooks/useBlurAutoSave";
import { useI18n } from "../../i18n";
import { GIT_SETTINGS_CHANGED_EVENT } from "../../constants/gitEvents";
import { ApiSettingsHintIcon } from "./apiSettings/ApiSettingsFieldLabel";

type GitScanSettings = {
  maxDepth: number;
  ignoredFolders: string[];
  changeDebounceMs: number;
  remotePollIntervalMs: number;
  statusLimit: number;
  autoRefresh: boolean;
  confirmPullPush: boolean;
};

type GitSettingsFormValue = {
  maxDepth: string;
  ignoredFolders: string;
  changeDebounceMs: string;
  remotePollIntervalMs: string;
  statusLimit: string;
  autoRefresh: boolean;
  confirmPullPush: boolean;
};

const toSettings = (form: GitSettingsFormValue): GitScanSettings => {
  const parse = (value: string, fallback: number): number => {
    const num = Number.parseInt(value.trim(), 10);
    return Number.isNaN(num) ? fallback : num;
  };
  return {
    maxDepth: parse(form.maxDepth, 1),
    ignoredFolders: form.ignoredFolders
      .split(",")
      .map((folder) => folder.trim())
      .filter(Boolean),
    changeDebounceMs: parse(form.changeDebounceMs, 400),
    remotePollIntervalMs: parse(form.remotePollIntervalMs, 10000),
    statusLimit: parse(form.statusLimit, 10000),
    autoRefresh: form.autoRefresh,
    confirmPullPush: form.confirmPullPush,
  };
};

const toForm = (settings: GitScanSettings): GitSettingsFormValue => ({
  maxDepth: String(settings.maxDepth),
  ignoredFolders: settings.ignoredFolders.join(", "),
  changeDebounceMs: String(settings.changeDebounceMs),
  remotePollIntervalMs: String(settings.remotePollIntervalMs),
  statusLimit: String(settings.statusLimit),
  autoRefresh: settings.autoRefresh,
  confirmPullPush: settings.confirmPullPush,
});

export function GitSettingsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState<GitSettingsFormValue>(() =>
    toForm({
      maxDepth: 1,
      ignoredFolders: [],
      changeDebounceMs: 400,
      remotePollIntervalMs: 10000,
      statusLimit: 10000,
      autoRefresh: true,
      confirmPullPush: true,
    }),
  );
  const [lastSaved, setLastSaved] = useState<GitScanSettings>({
    maxDepth: 1,
    ignoredFolders: [],
    changeDebounceMs: 400,
    remotePollIntervalMs: 10000,
    statusLimit: 10000,
    autoRefresh: true,
    confirmPullPush: true,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    try {
      const settings = await window.snow.getGitScanSettings();
      setForm(toForm(settings));
      setLastSaved(settings);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("settings.gitLoadError", {
              defaultValue: "Failed to load Git settings",
            }),
      );
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = useCallback(
    async (settings: GitScanSettings): Promise<void> => {
      try {
        await window.snow.setGitScanSettings(settings);
        // 广播给 Git 面板：二次确认等开关无需重挂载即可生效。
        window.dispatchEvent(new CustomEvent(GIT_SETTINGS_CHANGED_EVENT));
        if (isMountedRef.current) {
          setLastSaved(settings);
          setStatus(
            t("settings.gitSaveSuccess", {
              defaultValue: "Git settings saved.",
            }),
          );
        }
      } catch (saveError) {
        if (isMountedRef.current) {
          setError(
            saveError instanceof Error
              ? saveError.message
              : t("settings.gitSaveError", {
                  defaultValue: "Failed to save Git settings",
                }),
          );
        }
      }
    },
    [t],
  );

  const updateField =
    (field: keyof GitSettingsFormValue) => (value: string | boolean) => {
      setForm((previous) => ({ ...previous, [field]: value }));
    };

  // 失焦自动保存：输入框失焦时保存；开关等即时控件变更时立即保存；
  // 切换页面时若有未保存的脏数据自动冲刷，不会丢失。
  const commitSave = useBlurAutoSave(
    form,
    () => null,
    toSettings,
    lastSaved,
    (settings) => void saveSettings(settings),
    setError,
  );

  const handleToggleAutoRefresh = (checked: boolean): void => {
    const nextForm = { ...form, autoRefresh: checked };
    setForm(nextForm);
    commitSave(nextForm);
  };

  const handleToggleConfirmPullPush = (checked: boolean): void => {
    const nextForm = { ...form, confirmPullPush: checked };
    setForm(nextForm);
    commitSave(nextForm);
  };

  return (
    <div className="api-settings-page" role="region">
      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div className="api-settings-manual-form">
        {isLoading ? (
          <Loader2 className="spin" size={16} />
        ) : (
          <>
            <label className="form-dialog-field">
              <span className="form-dialog-label">
                {t("settings.gitScanDepthLabel", {
                  defaultValue: "Repository scan depth",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.gitScanDepthHint", {
                    defaultValue:
                      "How many levels below the workspace root are scanned for .git folders (default 1). Enter -1 for unlimited depth. Deeper scans can consume significant resources on large directories.",
                  })}
                />
              </span>
              <input
                className="form-dialog-input"
                inputMode="numeric"
                onChange={(event) =>
                  updateField("maxDepth")(event.target.value)
                }
                onBlur={() => commitSave()}
                placeholder="1"
                value={form.maxDepth}
              />
            </label>

            <label className="form-dialog-field">
              <span className="form-dialog-label">
                {t("settings.gitIgnoredFoldersLabel", {
                  defaultValue: "Ignored folders",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.gitIgnoredFoldersHint", {
                    defaultValue:
                      "Comma-separated folder names that are never traversed during repository discovery (matched case-insensitively).",
                  })}
                />
              </span>
              <input
                className="form-dialog-input"
                onChange={(event) =>
                  updateField("ignoredFolders")(event.target.value)
                }
                onBlur={() => commitSave()}
                placeholder="node_modules, vendor, archives"
                value={form.ignoredFolders}
              />
            </label>

            <label className="form-dialog-field">
              <span className="form-dialog-label">
                {t("settings.gitChangeDebounceLabel", {
                  defaultValue: "Change detection debounce (ms)",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.gitChangeDebounceHint", {
                    defaultValue:
                      "How long file changes are collected before refreshing git status. Higher values reduce disk/CPU usage on busy repositories.",
                  })}
                />
              </span>
              <input
                className="form-dialog-input"
                inputMode="numeric"
                onChange={(event) =>
                  updateField("changeDebounceMs")(event.target.value)
                }
                onBlur={() => commitSave()}
                placeholder="400"
                value={form.changeDebounceMs}
              />
            </label>

            <label className="form-dialog-field">
              <span className="form-dialog-label">
                {t("settings.gitRemotePollLabel", {
                  defaultValue: "Remote repo poll interval (ms)",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.gitRemotePollHint", {
                    defaultValue:
                      "How often the status of SSH (ssh://) repositories is refreshed by polling, since remote repos have no local file watcher.",
                  })}
                />
              </span>
              <input
                className="form-dialog-input"
                inputMode="numeric"
                onChange={(event) =>
                  updateField("remotePollIntervalMs")(event.target.value)
                }
                onBlur={() => commitSave()}
                placeholder="10000"
                value={form.remotePollIntervalMs}
              />
            </label>

            <label className="form-dialog-field">
              <span className="form-dialog-label">
                {t("settings.gitStatusLimitLabel", {
                  defaultValue: "Change list limit",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.gitStatusLimitHint", {
                    defaultValue:
                      "Maximum number of changes shown in the git panel. 0 disables the limit. Hitting the limit keeps huge repositories responsive.",
                  })}
                />
              </span>
              <input
                className="form-dialog-input"
                inputMode="numeric"
                onChange={(event) =>
                  updateField("statusLimit")(event.target.value)
                }
                onBlur={() => commitSave()}
                placeholder="10000"
                value={form.statusLimit}
              />
            </label>

            <label className="form-dialog-field">
              <span className="form-dialog-label">
                {t("settings.gitAutoRefreshLabel", {
                  defaultValue: "Auto refresh on file changes",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.gitAutoRefreshHint", {
                    defaultValue:
                      "When enabled, git status refreshes automatically when files change. Disable to only refresh manually, saving resources on very large repositories.",
                  })}
                />
              </span>
              <label
                className="toggle-switch"
                title={
                  form.autoRefresh
                    ? t("settings.gitAutoRefreshOn", {
                        defaultValue: "On",
                      })
                    : t("settings.gitAutoRefreshOff", {
                        defaultValue: "Off",
                      })
                }
              >
                <input
                  type="checkbox"
                  checked={form.autoRefresh}
                  onChange={(event) =>
                    handleToggleAutoRefresh(event.target.checked)
                  }
                  hidden
                />
                <span className="toggle-slider" />
              </label>
            </label>

            <label className="form-dialog-field">
              <span className="form-dialog-label">
                {t("settings.gitConfirmPullPushLabel", {
                  defaultValue: "Confirm before pull / push",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.gitConfirmPullPushHint", {
                    defaultValue:
                      "When enabled, a confirmation bubble appears before pulling or pushing so the operation is never triggered by accident.",
                  })}
                />
              </span>
              <label
                className="toggle-switch"
                title={
                  form.confirmPullPush
                    ? t("settings.gitAutoRefreshOn", {
                        defaultValue: "On",
                      })
                    : t("settings.gitAutoRefreshOff", {
                        defaultValue: "Off",
                      })
                }
              >
                <input
                  type="checkbox"
                  checked={form.confirmPullPush}
                  onChange={(event) =>
                    handleToggleConfirmPullPush(event.target.checked)
                  }
                  hidden
                />
                <span className="toggle-slider" />
              </label>
            </label>
          </>
        )}
      </div>
    </div>
  );
}
