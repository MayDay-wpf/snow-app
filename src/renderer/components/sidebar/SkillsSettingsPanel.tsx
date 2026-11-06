import {
  BookOpen,
  CircleCheck,
  CirclePause,
  Download,
  Folder,
  Globe2,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GithubSkillRecord,
  ProjectSkillDefinition,
  SkillDefinition,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { GitHubLogo } from "../common/GitHubLogo";
import { SkillEditModal } from "./SkillEditModal";

type SkillsSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

type SkillsScope = "global" | "project";

// 行模型：全局 tab 只列全局技能；项目 tab 列该项目可用的全部技能
type SkillRow = {
  skill: SkillDefinition;
  scope: SkillsScope;
  // 项目行：全局总闸已关闭，项目层不可启用
  globallyDisabled: boolean;
};

/** Loose check: github.com URL or owner/repo shorthand; the backend download validates the rest. */
function isGitHubSource(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) {
    return false;
  }
  if (/^https?:\/\/(?:www\.)?github\.com(\/|$)/i.test(trimmed)) {
    return true;
  }
  return !/^https?:\/\//i.test(trimmed) && trimmed.includes("/");
}

export function SkillsSettingsPanel({
  activeDirectory,
}: SkillsSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [activeScope, setActiveScope] = useState<SkillsScope>("global");
  const [globalSkills, setGlobalSkills] = useState<SkillDefinition[]>([]);
  const [projectSkills, setProjectSkills] = useState<ProjectSkillDefinition[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [updatingSkillId, setUpdatingSkillId] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const [githubSkills, setGithubSkills] = useState<GithubSkillRecord[]>([]);
  const [installUrl, setInstallUrl] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const [uninstallingSkillId, setUninstallingSkillId] = useState("");
  const [pendingUninstallSkill, setPendingUninstallSkill] =
    useState<SkillDefinition | null>(null);
  const [editingSkill, setEditingSkill] = useState<SkillDefinition | null>(
    null,
  );
  // 全局总闸关闭前的确认：关闭后所有项目都无法使用
  const [pendingGlobalDisable, setPendingGlobalDisable] =
    useState<SkillDefinition | null>(null);

  const loadSequenceRef = useRef(0);
  // 仅首次加载周期用整块 loading 占位；之后的常规刷新
  // （启停、安装、卸载、点刷新）一律保留现有列表——列表被占位替换会让
  // 页面高度骤降，滚动容器 scrollTop 被夹回顶部，表现为「启停一次就跳回页首」。
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  // 当前列表数据所属的项目：切换项目时旧数据立即让位给占位，
  // 避免在新项目下短暂显示（并可误操作）旧项目的 Skills。
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  // loadedScopeKey 的镜像：失败分支要在回调里判断「现有数据属于哪个项目」，
  // 直接读 state 会把 loadedScopeKey 拖进 loadSkills 依赖，触发重载循环。
  const loadedScopeKeyRef = useRef<string | null>(null);
  // 上一次的全局/项目 Tab，用于切换时自动刷新
  const previousScopeRef = useRef<SkillsScope>(activeScope);
  const scopeKey = activeDirectory?.directoryId ?? "";
  const isScopeStale = loadedScopeKey !== null && loadedScopeKey !== scopeKey;

  const loadSkills = useCallback(async (): Promise<void> => {
    // Only the latest load may write state.
    const sequence = ++loadSequenceRef.current;
    const requestScopeKey = activeDirectory?.directoryId ?? "";
    setIsLoading(true);
    setError("");

    try {
      const [globalSkills, projectSkills, githubRecords] = await Promise.all([
        window.snow.listAvailableSkills(),
        // 与技能选择面板同源：项目可用技能含全局叠加后的全部条目
        activeDirectory
          ? window.snow.listProjectSkills(activeDirectory.directoryId)
          : Promise.resolve([] as ProjectSkillDefinition[]),
        window.snow.listGithubSkills(),
      ]);
      if (sequence !== loadSequenceRef.current) {
        return;
      }

      setGlobalSkills(globalSkills);
      setProjectSkills(projectSkills);
      setGithubSkills(githubRecords);
      loadedScopeKeyRef.current = requestScopeKey;
      setLoadedScopeKey(requestScopeKey);
    } catch (loadError) {
      if (sequence !== loadSequenceRef.current) {
        return;
      }
      // 范围切换后的加载失败：旧项目数据不能冒充新项目数据，清空列表并认领
      // 失败范围，结束整块占位让错误可见（否则 isScopeStale 永远为 true，永久转圈）。
      // 同范围刷新失败则保留旧列表：清空同样会塌缩列表并重置滚动位置。
      if (loadedScopeKeyRef.current !== requestScopeKey) {
        setGlobalSkills([]);
        setProjectSkills([]);
        loadedScopeKeyRef.current = requestScopeKey;
        setLoadedScopeKey(requestScopeKey);
      }
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("settings.skillsLoadError", {
              defaultValue: "Failed to load Skills",
            }),
      );
    } finally {
      if (sequence === loadSequenceRef.current) {
        setIsLoading(false);
        setIsInitialLoading(false);
      }
    }
  }, [activeDirectory, t]);

  // 全局开关写技能文件 enable（总闸）；项目开关写项目覆盖，两者互不改写。
  const applySkillEnabled = useCallback(
    async (
      skill: SkillDefinition,
      nextEnabled: boolean,
      projectScoped: boolean,
    ): Promise<void> => {
      const projectId = activeDirectory?.directoryId;
      if (projectScoped && !projectId) {
        return;
      }
      setUpdatingSkillId(skill.id);
      setError("");
      setStatus("");

      try {
        if (projectScoped && projectId) {
          await window.snow.setProjectSkillEnabled(
            projectId,
            skill.id,
            nextEnabled,
          );
        } else {
          await window.snow.setSkillEnabled(undefined, skill.id, nextEnabled);
        }
        await loadSkills();
        setStatus(
          t(
            nextEnabled
              ? "settings.skillsEnableSuccess"
              : "settings.skillsDisableSuccess",
            {
              defaultValue: nextEnabled
                ? "Skill enabled."
                : "Skill disabled and removed from skill-execute.",
            },
          ),
        );
      } catch (updateError) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : t("settings.skillsUpdateError", {
                defaultValue: "Failed to update Skill",
              }),
        );
      } finally {
        setUpdatingSkillId("");
      }
    },
    [activeDirectory, loadSkills, t],
  );

  const requestSkillToggle = useCallback(
    (row: SkillRow): void => {
      const nextEnabled = !row.skill.enabled;
      if (row.scope === "project") {
        // 全局已停用时项目层不能启用
        if (row.globallyDisabled) {
          return;
        }
        void applySkillEnabled(row.skill, nextEnabled, true);
        return;
      }
      if (!nextEnabled) {
        setPendingGlobalDisable(row.skill);
        return;
      }
      void applySkillEnabled(row.skill, true, false);
    },
    [applySkillEnabled],
  );

  const handleInstall = useCallback(async (): Promise<void> => {
    const url = installUrl.trim();
    if (!url || !isGitHubSource(url)) {
      setError(
        t("settings.skillsInstallInvalidUrl", {
          defaultValue: "Please enter a valid GitHub URL.",
        }),
      );
      return;
    }
    if (activeScope === "project" && !activeDirectory) {
      setError(
        t("settings.skillsInstallError", {
          defaultValue: "Install failed: {{error}}",
          values: { error: "No active project" },
        }),
      );
      return;
    }

    setIsInstalling(true);
    setError("");
    setStatus("");

    try {
      const result = await window.snow.installSkillFromGithub(
        url,
        activeScope,
        activeScope === "project" ? activeDirectory?.directoryId : undefined,
      );
      if (result.success) {
        const names = result.results
          .filter((r) => r.success)
          .map((r) => r.skillId)
          .join(", ");
        setStatus(
          `${t("settings.skillsInstallSuccess", {
            defaultValue: "{{count}} skill(s) installed successfully.",
            values: { count: result.installedCount },
          })}${names ? ` (${names})` : ""}`,
        );
        setInstallUrl("");
        await loadSkills();
      } else {
        setError(
          t("settings.skillsInstallError", {
            defaultValue: "Install failed: {{error}}",
            values: { error: result.error ?? "Unknown error" },
          }),
        );
      }
    } catch (installError) {
      setError(
        t("settings.skillsInstallError", {
          defaultValue: "Install failed: {{error}}",
          values: {
            error:
              installError instanceof Error
                ? installError.message
                : "Unknown error",
          },
        }),
      );
    } finally {
      setIsInstalling(false);
    }
  }, [installUrl, activeScope, activeDirectory, loadSkills, t]);

  const requestUninstall = useCallback((skill: SkillDefinition): void => {
    setPendingUninstallSkill(skill);
  }, []);

  const confirmUninstall = useCallback(async (): Promise<void> => {
    const skill = pendingUninstallSkill;
    if (!skill) {
      return;
    }
    setPendingUninstallSkill(null);
    setUninstallingSkillId(skill.id);
    setError("");
    setStatus("");

    try {
      const result = await window.snow.uninstallGithubSkill(
        skill.id,
        skill.location === "project" ? activeDirectory?.directoryId : undefined,
      );
      if (result.success) {
        setStatus(
          t("settings.skillsUninstallSuccess", {
            defaultValue: "Skill uninstalled.",
          }),
        );
        await loadSkills();
      } else {
        setError(
          t("settings.skillsUninstallError", {
            defaultValue: "Failed to uninstall: {{error}}",
            values: { error: result.error ?? result.message },
          }),
        );
      }
    } catch (uninstallError) {
      setError(
        t("settings.skillsUninstallError", {
          defaultValue: "Failed to uninstall: {{error}}",
          values: {
            error:
              uninstallError instanceof Error
                ? uninstallError.message
                : "Unknown error",
          },
        }),
      );
    } finally {
      setUninstallingSkillId("");
    }
  }, [pendingUninstallSkill, activeDirectory?.directoryId, loadSkills, t]);

  const dismissNotice = useCallback((): void => {
    setError("");
    setStatus("");
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  // 全局/项目 Tab 切换后自动刷新列表
  useEffect(() => {
    if (previousScopeRef.current === activeScope) {
      return;
    }
    previousScopeRef.current = activeScope;
    void loadSkills();
  }, [activeScope, loadSkills]);

  useEffect(() => {
    if (!activeDirectory && activeScope === "project") {
      setActiveScope("global");
    }
  }, [activeDirectory, activeScope]);

  const githubSkillIds = useMemo(
    () => new Set(githubSkills.map((r) => r.id)),
    [githubSkills],
  );

  const isGlobalScope = activeScope === "global";
  // 项目 tab 与技能选择面板同源：列出该项目可用的全部技能（含全局）
  const rows = useMemo<SkillRow[]>(
    () =>
      isGlobalScope
        ? globalSkills.map((skill) => ({
            skill,
            scope: "global",
            globallyDisabled: false,
          }))
        : projectSkills.map((skill) => ({
            skill,
            scope: "project",
            // 只有全局来源的技能受全局总闸约束；项目目录内的技能按项目覆盖处理
            globallyDisabled:
              skill.location === "global" && !skill.defaultEnabled,
          })),
    [globalSkills, isGlobalScope, projectSkills],
  );
  const enabledCount = rows.filter((row) => row.skill.enabled).length;
  const disabledCount = rows.length - enabledCount;
  const scopeTitle = isGlobalScope
    ? t("settings.skillsGlobalListTitle", { defaultValue: "Global Skills" })
    : t("settings.skillsProjectListTitle", { defaultValue: "Project Skills" });
  const scopeDescription = isGlobalScope
    ? t("settings.skillsGlobalTabInfo", {
        defaultValue:
          "The global switch is a gate: when off, no project can use the Skill; project switches then stay greyed out.",
      })
    : t("settings.skillsProjectTabInfo", {
        defaultValue:
          "All Skills available to {{name}}, including global ones. A Skill disabled globally cannot be enabled here.",
        values: { name: activeDirectory?.name ?? "" },
      });

  // 有内容即可点击，合法性在 handleInstall 里判断。
  const canInstall = !isInstalling && installUrl.trim().length > 0;

  return (
    <div className="api-settings-page skills-settings-page" role="region">
      <div className="api-settings-summary-grid skills-settings-summary-grid">
        <div className="api-settings-summary-card">
          <BookOpen size={15} strokeWidth={1.8} />
          <span>{rows.length}</span>
          <small>
            {t("settings.skillsAvailableCount", { defaultValue: "Skills" })}
          </small>
        </div>
        <div className="api-settings-summary-card">
          <CircleCheck size={15} strokeWidth={1.8} />
          <span>{enabledCount}</span>
          <small>
            {t("settings.skillsEnabledCount", { defaultValue: "Enabled" })}
          </small>
        </div>
        <div className="api-settings-summary-card">
          <CirclePause size={15} strokeWidth={1.8} />
          <span>{disabledCount}</span>
          <small>
            {t("settings.skillsDisabledCount", { defaultValue: "Disabled" })}
          </small>
        </div>
      </div>

      <div className="api-settings-actions skills-settings-actions">
        <button
          className="api-settings-action-btn secondary"
          onClick={() => void loadSkills()}
          type="button"
          disabled={isLoading || Boolean(updatingSkillId) || isInstalling}
          aria-label={t("settings.skillsRefresh", {
            defaultValue: "Refresh Skills",
          })}
          title={t("settings.skillsRefresh", {
            defaultValue: "Refresh Skills",
          })}
        >
          <RefreshCw size={15} className={isLoading ? "spin" : ""} />
          <span>
            {t(
              isLoading
                ? "settings.skillsRefreshing"
                : "settings.skillsRefresh",
              { defaultValue: isLoading ? "Refreshing..." : "Refresh Skills" },
            )}
          </span>
        </button>
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={dismissNotice}
      />

      <div
        className="segmented-tabs segmented-tabs--spaced"
        role="tablist"
        aria-label={t("settings.skillsScopeTabs", {
          defaultValue: "Skills scope",
        })}
      >
        <button
          className={`segmented-tab ${isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={isGlobalScope}
          onClick={() => setActiveScope("global")}
        >
          <Globe2 size={14} strokeWidth={1.8} />
          <span>
            {t("settings.skillsTabGlobal", { defaultValue: "Global" })}
          </span>
          <small>{globalSkills.length}</small>
        </button>
        <button
          className={`segmented-tab ${!isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={!isGlobalScope}
          onClick={() => setActiveScope("project")}
          disabled={!activeDirectory}
        >
          <Folder size={14} strokeWidth={1.8} />
          <span>
            {t("settings.skillsTabProject", { defaultValue: "Project" })}
          </span>
          <small>{projectSkills.length}</small>
        </button>
      </div>

      <section className="api-settings-form-section skills-settings-section skills-settings-install-section">
        <div className="skills-settings-section-header">
          <div>
            <strong className="api-settings-form-section-title">
              {t("settings.skillsInstallTitle", {
                defaultValue: "Install from GitHub",
              })}
            </strong>
            <span>
              {t("settings.skillsInstallUrlHint", {
                defaultValue:
                  "Supports full URLs, shorthand owner/repo, with optional branch and sub-directory.",
              })}
            </span>
          </div>
          <GitHubLogo size={16} />
        </div>

        <div className="skills-settings-install-form">
          <div className="skills-settings-install-row">
            <input
              className="skills-settings-install-input"
              type="text"
              value={installUrl}
              onChange={(event) => setInstallUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canInstall) {
                  void handleInstall();
                }
              }}
              placeholder={t("settings.skillsInstallUrlPlaceholder", {
                defaultValue:
                  "https://github.com/owner/repo or owner/repo@branch",
              })}
              disabled={isInstalling}
              aria-label={t("settings.skillsInstallUrlLabel", {
                defaultValue: "GitHub URL",
              })}
            />
            <button
              className="api-settings-action-btn primary skills-settings-install-btn"
              onClick={() => void handleInstall()}
              type="button"
              disabled={!canInstall}
            >
              {isInstalling ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Download size={15} strokeWidth={1.8} />
              )}
              <span>
                {isInstalling
                  ? t("settings.skillsInstallInstalling", {
                      defaultValue: "Installing...",
                    })
                  : t("settings.skillsInstallButton", {
                      defaultValue: "Install",
                    })}
              </span>
            </button>
          </div>
          <span className="skills-settings-install-target">
            {t("settings.skillsInstallTarget", {
              defaultValue: "Installs to: {{scope}}",
              values: {
                scope: isGlobalScope
                  ? t("settings.skillsInstallLocationGlobal", {
                      defaultValue: "Global",
                    })
                  : t("settings.skillsInstallLocationProject", {
                      defaultValue: "Project",
                    }),
              },
            })}
          </span>
          <span className="skills-settings-install-example">
            {t("settings.skillsInstallExample", { defaultValue: "Example:" })}{" "}
            <code>https://github.com/upstash/context7/tree/master/skills</code>
          </span>
        </div>
      </section>

      <section className="api-settings-form-section skills-settings-section">
        <div className="skills-settings-section-header">
          <div>
            <strong className="api-settings-form-section-title">
              {scopeTitle}
            </strong>
            <span>{scopeDescription}</span>
          </div>
          <div className="skills-settings-paths" aria-label={scopeTitle}>
            <code>.snow/skills/</code>
            <code>.agents/skills/</code>
          </div>
        </div>

        <div
          className="system-prompt-list mcp-server-list skills-settings-list"
          aria-live="polite"
        >
          {isInitialLoading || isScopeStale ? (
            <div className="system-prompt-empty skills-settings-empty">
              <Loader2 size={15} className="spin" />
              <span>
                {t("settings.skillsLoading", {
                  defaultValue: "Loading Skills...",
                })}
              </span>
            </div>
          ) : rows.length === 0 ? (
            <div className="system-prompt-empty skills-settings-empty">
              <BookOpen size={15} />
              <span>
                {t(
                  isGlobalScope
                    ? "settings.skillsGlobalEmpty"
                    : "settings.skillsProjectEmpty",
                  {
                    defaultValue: isGlobalScope
                      ? "No global Skills found."
                      : "No Skills available for this project.",
                  },
                )}
              </span>
            </div>
          ) : (
            rows.map((row) => {
              const skill = row.skill;
              const isUpdating = updatingSkillId === skill.id;
              const isUninstalling = uninstallingSkillId === skill.id;
              const isGithubInstalled = githubSkillIds.has(skill.id);
              const toggleLabel = row.globallyDisabled
                ? t("settings.skillsGlobalGateRequired", {
                    defaultValue: "Turn on the global switch first",
                  })
                : skill.enabled
                  ? t("settings.skillsDisable", {
                      defaultValue: "Disable Skill",
                    })
                  : t("settings.skillsEnable", {
                      defaultValue: "Enable Skill",
                    });
              const stateLabel = row.globallyDisabled
                ? t("settings.skillsGlobalGateOff", {
                    defaultValue: "Globally disabled",
                  })
                : skill.enabled
                  ? t("settings.enabled", { defaultValue: "Enabled" })
                  : t("settings.inactive", { defaultValue: "Disabled" });
              const uninstallLabel = t("settings.skillsUninstall", {
                defaultValue: "Uninstall",
              });
              const editLabel = t("settings.skillsEdit", {
                defaultValue: "Edit Skill",
              });

              return (
                <div
                  className={`system-prompt-item skills-settings-item ${
                    skill.enabled ? "active" : "inactive"
                  }`}
                  key={`${row.scope}:${skill.id}`}
                >
                  <div className="system-prompt-item-main skills-settings-item-main">
                    <label
                      className="toggle-switch system-prompt-switch skills-settings-switch"
                      aria-label={toggleLabel}
                      title={toggleLabel}
                    >
                      <input
                        type="checkbox"
                        checked={skill.enabled}
                        onChange={() => requestSkillToggle(row)}
                        disabled={
                          isLoading ||
                          Boolean(updatingSkillId) ||
                          isInstalling ||
                          row.globallyDisabled
                        }
                        hidden
                      />
                      <span className="toggle-slider" />
                      <span>{stateLabel}</span>
                    </label>
                    <div className="system-prompt-item-info skills-settings-item-info">
                      <div className="skills-settings-item-title">
                        <strong>{skill.name}</strong>
                        <code>{skill.id}</code>
                        {isGithubInstalled && (
                          <span
                            className="skills-settings-github-badge"
                            title={t("settings.skillsInstallTitle", {
                              defaultValue: "Install from GitHub",
                            })}
                          >
                            <GitHubLogo size={11} />
                          </span>
                        )}
                      </div>
                      <span className="skills-settings-item-description">
                        {skill.description ||
                          t("settings.skillsNoDescription", {
                            defaultValue: "No description provided.",
                          })}
                      </span>
                      <span className="skills-settings-item-path">
                        <Folder size={12} strokeWidth={1.8} />
                        <code title={skill.path}>{skill.path}</code>
                      </span>
                    </div>
                  </div>
                  <div className="system-prompt-item-actions skills-settings-item-actions">
                    {isUpdating && <Loader2 size={13} className="spin" />}
                    {skill.allowedTools && skill.allowedTools.length > 0 && (
                      <span
                        className="skills-settings-tools-count"
                        title={`${t("settings.skillsAllowedTools", {
                          defaultValue: "Allowed tools",
                        })}: ${skill.allowedTools.join(", ")}`}
                      >
                        <Wrench size={12} strokeWidth={1.8} />
                        {skill.allowedTools.length}
                      </span>
                    )}
                    {!isGlobalScope && (
                      <span className="skills-settings-badge">
                        {skill.location === "project"
                          ? t("settings.skillsScopeProject", {
                              defaultValue: "Project",
                            })
                          : t("settings.skillsScopeGlobal", {
                              defaultValue: "Global",
                            })}
                      </span>
                    )}
                    {row.globallyDisabled && (
                      <span className="skills-settings-badge">
                        {t("settings.skillsGlobalGateOff", {
                          defaultValue: "Globally disabled",
                        })}
                      </span>
                    )}
                    <span className="skills-settings-badge">
                      .{skill.source}
                    </span>
                    <button
                      className="icon-btn ghost skills-settings-uninstall-btn"
                      onClick={() => setEditingSkill(skill)}
                      type="button"
                      disabled={
                        isLoading || Boolean(updatingSkillId) || isInstalling
                      }
                      aria-label={editLabel}
                      title={editLabel}
                    >
                      <Pencil size={13} strokeWidth={1.8} />
                    </button>
                    {isGithubInstalled && (
                      <button
                        className="icon-btn ghost skills-settings-uninstall-btn"
                        onClick={() => requestUninstall(skill)}
                        type="button"
                        disabled={
                          Boolean(updatingSkillId) ||
                          isInstalling ||
                          isUninstalling
                        }
                        aria-label={uninstallLabel}
                        title={uninstallLabel}
                      >
                        {isUninstalling ? (
                          <Loader2 size={13} className="spin" />
                        ) : (
                          <Trash2 size={13} strokeWidth={1.8} />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <ConfirmDialog
        open={Boolean(pendingGlobalDisable)}
        title={t("settings.skillsGlobalDisableTitle", {
          defaultValue: "Disable global Skill",
        })}
        message={t("settings.skillsGlobalDisableConfirm", {
          defaultValue:
            "Disabling {{name}} globally makes it unavailable in every project, and project switches stay greyed out. Disable anyway?",
          values: { name: pendingGlobalDisable?.name ?? "" },
        })}
        confirmLabel={t("settings.disable", { defaultValue: "Disable" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="warning"
        onConfirm={() => {
          const skill = pendingGlobalDisable;
          if (!skill) {
            return;
          }
          setPendingGlobalDisable(null);
          void applySkillEnabled(skill, false, false);
        }}
        onCancel={() => setPendingGlobalDisable(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingUninstallSkill)}
        title={t("settings.skillsUninstall", { defaultValue: "Uninstall" })}
        message={t("settings.skillsUninstallConfirm", {
          defaultValue: "Uninstall this skill?",
          values: { name: pendingUninstallSkill?.name ?? "" },
        })}
        confirmLabel={t("settings.skillsUninstall", {
          defaultValue: "Uninstall",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void confirmUninstall()}
        onCancel={() => setPendingUninstallSkill(null)}
      />
      {editingSkill && (
        <SkillEditModal
          key={editingSkill.path}
          skill={editingSkill}
          onClose={() => setEditingSkill(null)}
        />
      )}
    </div>
  );
}
