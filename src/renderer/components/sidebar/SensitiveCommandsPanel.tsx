import {
  BrainCircuit,
  Download,
  Folder,
  Globe2,
  Loader2,
  Plus,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceDirectoryRecord } from "../../../preload";
import {
  DECISION_TOOL_MODEL_SETTING_CODE,
  loadDecisionModels,
  type DecisionModelConfig,
} from "../../constants/decisionModels";
import {
  DEFAULT_SENSITIVE_COMMAND_ASSIST_SETTINGS,
  SENSITIVE_COMMAND_ASSIST_SETTING_CODE,
  SENSITIVE_COMMAND_ASSIST_SETTING_NAME,
  readSensitiveCommandAssistSettings,
  toSensitiveCommandAssistJson,
  type SensitiveCommandAssistSettings,
} from "../../constants/sensitiveCommandAssist";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { SensitiveCommandDecisionAssist } from "./sensitiveCommands/SensitiveCommandDecisionAssist";
import {
  SensitiveCommandEditor,
  SensitiveCommandEditorActions,
} from "./sensitiveCommands/SensitiveCommandEditor";
import {
  SensitiveCommandList,
  type SensitiveCommandListItem,
} from "./sensitiveCommands/SensitiveCommandList";
import { SensitiveCommandSummary } from "./sensitiveCommands/SensitiveCommandSummary";
import {
  EMPTY_SENSITIVE_COMMAND_DRAFT,
  hasDuplicatePattern,
  toDraft,
  toInput,
} from "./sensitiveCommands/sensitiveCommandUtils";
import type {
  ProjectSensitiveCommandConfig,
  SensitiveCommandConfig,
  SensitiveCommandDraft,
} from "./sensitiveCommands/types";

type SensitiveCommandsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

type SensitiveCommandScope = "global" | "project";

type SensitiveCommandPanelTab = "rules" | "assist";

export function SensitiveCommandsPanel({
  activeDirectory,
}: SensitiveCommandsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  /** 顶部标签页：命令规则 / 决策模型辅助。 */
  const [activeTab, setActiveTab] = useState<SensitiveCommandPanelTab>("rules");
  const [activeScope, setActiveScope] =
    useState<SensitiveCommandScope>("global");
  const [commands, setCommands] = useState<SensitiveCommandConfig[]>([]);
  const [projectCommands, setProjectCommands] = useState<
    ProjectSensitiveCommandConfig[]
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  /** 决策模型辅助设置（全局）：与全局/项目标签页无关，始终显示。 */
  const [assistSettings, setAssistSettings] =
    useState<SensitiveCommandAssistSettings>(() => ({
      ...DEFAULT_SENSITIVE_COMMAND_ASSIST_SETTINGS,
    }));
  const [decisionModels, setDecisionModels] = useState<DecisionModelConfig[]>(
    [],
  );
  /** decision-evaluate 的默认决策模型 id（辅助里「跟随默认」的来源）。 */
  const [defaultDecisionModelId, setDefaultDecisionModelId] = useState("");
  const [draft, setDraft] = useState<SensitiveCommandDraft | null>(null);
  const [commandPendingDeletion, setCommandPendingDeletion] =
    useState<SensitiveCommandListItem | null>(null);
  const [resetPending, setResetPending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const loadGenerationRef = useRef(0);

  const isBusy = isLoading || isSaving;

  const load = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoading(true);
    setIsSaving(false);
    setDraft(null);
    setCommandPendingDeletion(null);
    setProjectCommands([]);
    setError("");

    try {
      const [
        globalItems,
        projectItems,
        assistRaw,
        storedDecisionModels,
        defaultModelRaw,
      ] = await Promise.all([
        window.snow.listSensitiveCommandConfigs(),
        activeDirectory
          ? window.snow.listProjectSensitiveCommandConfigs(
              activeDirectory.directoryId,
            )
          : Promise.resolve([]),
        // 辅助设置与决策模型只是展示依赖：读取失败时退回默认值，不阻断规则列表。
        window.snow
          .getSystemSettingValue(SENSITIVE_COMMAND_ASSIST_SETTING_CODE)
          .catch(() => null),
        loadDecisionModels().catch((): DecisionModelConfig[] => []),
        window.snow
          .getSystemSettingValue(DECISION_TOOL_MODEL_SETTING_CODE)
          .catch(() => null),
      ]);
      if (loadGenerationRef.current !== generation) {
        return;
      }

      setCommands(globalItems);
      setProjectCommands(projectItems);
      setAssistSettings(readSensitiveCommandAssistSettings(assistRaw));
      setDecisionModels(storedDecisionModels);
      setDefaultDecisionModelId((defaultModelRaw ?? "").trim());
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("settings.sensitiveCommandLoadError", {
                defaultValue: "Failed to load sensitive command rules",
              }),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [activeDirectory, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!activeDirectory && activeScope === "project") {
      setActiveScope("global");
    }
  }, [activeDirectory, activeScope]);

  const handleImport = async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    setStatus("");

    try {
      await window.snow.importSnowCliSensitiveCommandConfig();
      await load();
      setDraft(null);
      setStatus(
        t("settings.sensitiveCommandImportSuccess", {
          defaultValue: "Synced sensitive command rules from Snow CLI.",
        }),
      );
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : t("settings.sensitiveCommandImportError", {
              defaultValue: "Failed to sync Snow CLI sensitive command rules",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  };

  /** 持久化决策模型辅助设置：只写这两个开关与模型选择，不重载规则列表。 */
  const saveAssistSettings = async (
    next: SensitiveCommandAssistSettings,
  ): Promise<void> => {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      await window.snow.setSystemSetting(
        SENSITIVE_COMMAND_ASSIST_SETTING_NAME,
        SENSITIVE_COMMAND_ASSIST_SETTING_CODE,
        toSensitiveCommandAssistJson(next),
      );
      setAssistSettings(next);
      setStatus(
        t("settings.sensitiveCommandAssistSaveSuccess", {
          defaultValue: "Saved decision model assist settings.",
        }),
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t("settings.sensitiveCommandAssistSaveError", {
              defaultValue: "Failed to save decision model assist settings",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const startAdd = (): void => {
    const scopedCommands =
      activeScope === "global" ? commands : projectCommands;
    const maxSortOrder = scopedCommands.reduce(
      (max, command) => Math.max(max, command.sortOrder),
      -1,
    );
    setDraft({
      ...EMPTY_SENSITIVE_COMMAND_DRAFT,
      sortOrder: maxSortOrder + 1,
      source: activeScope === "global" ? "manual" : "project",
    });
    setError("");
    setStatus("");
  };

  const startEdit = (command: SensitiveCommandListItem): void => {
    if (!command.canEdit) {
      return;
    }

    if (activeScope === "global") {
      const globalCommand = commands.find(
        (item) => item.commandId === command.commandId,
      );
      if (globalCommand) {
        setDraft(toDraft(globalCommand));
      }
    } else {
      const projectCommand = projectCommands.find(
        (item) => item.commandId === command.commandId && !item.inherited,
      );
      if (projectCommand) {
        setDraft({
          commandId: projectCommand.commandId,
          pattern: projectCommand.pattern,
          description: projectCommand.description,
          enabled: projectCommand.enabled,
          isPreset: false,
          sortOrder: projectCommand.sortOrder,
          source: "project",
        });
      }
    }
    setError("");
    setStatus("");
  };

  const cancelDraft = (): void => {
    setDraft(null);
    setError("");
  };

  const patchDraft = (patch: Partial<SensitiveCommandDraft>): void => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : null));
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft || isSaving) {
      return;
    }

    if (!draft.pattern.trim()) {
      setError(
        t("settings.sensitiveCommandPatternRequired", {
          defaultValue: "Command pattern is required.",
        }),
      );
      setStatus("");
      return;
    }

    const duplicatePattern =
      activeScope === "global"
        ? hasDuplicatePattern(commands, draft)
        : projectCommands.some(
            (command) =>
              command.pattern.trim() === draft.pattern.trim() &&
              command.commandId !== draft.commandId,
          );
    if (duplicatePattern) {
      setError(
        t("settings.sensitiveCommandDuplicatePattern", {
          defaultValue: "Command pattern already exists.",
        }),
      );
      setStatus("");
      return;
    }

    const operationScope = activeScope;
    const operationProjectId = activeDirectory?.directoryId;
    const generation = loadGenerationRef.current;
    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      if (operationScope === "global") {
        const maxSortOrder = commands.reduce(
          (max, command) => Math.max(max, command.sortOrder),
          -1,
        );
        const items = await window.snow.upsertSensitiveCommandConfig(
          toInput(draft, maxSortOrder + 1),
        );
        setCommands(items);
      } else if (operationProjectId) {
        const maxSortOrder = projectCommands
          .filter((command) => !command.inherited)
          .reduce((max, command) => Math.max(max, command.sortOrder), -1);
        const items = await window.snow.upsertProjectSensitiveCommandConfig(
          operationProjectId,
          {
            commandId: draft.commandId,
            pattern: draft.pattern.trim(),
            description: draft.description.trim(),
            enabled: draft.enabled,
            sortOrder: draft.commandId ? draft.sortOrder : maxSortOrder + 1,
          },
        );
        if (loadGenerationRef.current !== generation) {
          return;
        }
        setProjectCommands(items);
      } else {
        return;
      }

      setDraft(null);
      setStatus(
        draft.commandId
          ? t("settings.sensitiveCommandSaveSuccess", {
              defaultValue: "Saved sensitive command rule.",
            })
          : t("settings.sensitiveCommandAddSuccess", {
              defaultValue: "Added sensitive command rule.",
            }),
      );
    } catch (saveError) {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : t("settings.sensitiveCommandSaveError", {
                defaultValue: "Failed to save sensitive command rule",
              }),
        );
      }
    } finally {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setIsSaving(false);
      }
    }
  };

  const toggleEnabled = async (
    command: SensitiveCommandListItem,
  ): Promise<void> => {
    if (isBusy) {
      return;
    }

    const operationScope = activeScope;
    const operationProjectId = activeDirectory?.directoryId;
    const generation = loadGenerationRef.current;
    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      if (operationScope === "global") {
        const globalCommand = commands.find(
          (item) => item.commandId === command.commandId,
        );
        if (!globalCommand) {
          return;
        }
        const items = await window.snow.upsertSensitiveCommandConfig({
          commandId: globalCommand.commandId,
          pattern: globalCommand.pattern,
          description: globalCommand.description,
          enabled: !globalCommand.enabled,
          isPreset: globalCommand.isPreset,
          sortOrder: globalCommand.sortOrder,
          source: globalCommand.source,
        });
        setCommands(items);
      } else if (operationProjectId) {
        const items = await window.snow.setProjectSensitiveCommandEnabled(
          operationProjectId,
          command.commandId,
          !command.enabled,
        );
        if (loadGenerationRef.current !== generation) {
          return;
        }
        setProjectCommands(items);
      }
    } catch (updateError) {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : t("settings.sensitiveCommandSaveError", {
                defaultValue: "Failed to update sensitive command rule",
              }),
        );
      }
    } finally {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setIsSaving(false);
      }
    }
  };

  const handleDelete = async (
    command: SensitiveCommandListItem,
  ): Promise<void> => {
    if (isBusy || !command.canDelete) {
      return;
    }

    setError("");
    setStatus("");

    const operationScope = activeScope;
    const operationProjectId = activeDirectory?.directoryId;
    const generation = loadGenerationRef.current;
    setIsSaving(true);

    try {
      if (operationScope === "global") {
        const items = await window.snow.deleteSensitiveCommandConfig(
          command.commandId,
        );
        setCommands(items);
      } else if (operationProjectId) {
        const items = await window.snow.deleteProjectSensitiveCommandConfig(
          operationProjectId,
          command.commandId,
        );
        if (loadGenerationRef.current !== generation) {
          return;
        }
        setProjectCommands(items);
      } else {
        return;
      }

      if (draft?.commandId === command.commandId) {
        setDraft(null);
      }
      setStatus(
        t("settings.sensitiveCommandDeleteSuccess", {
          defaultValue: "Deleted sensitive command rule.",
        }),
      );
    } catch (deleteError) {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : t("settings.sensitiveCommandDeleteError", {
                defaultValue: "Failed to delete sensitive command rule",
              }),
        );
      }
    } finally {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setIsSaving(false);
      }
    }
  };

  const confirmDelete = (): void => {
    if (!commandPendingDeletion || isBusy) {
      return;
    }

    const command = commandPendingDeletion;
    setCommandPendingDeletion(null);
    void handleDelete(command);
  };

  const handleReset = async (): Promise<void> => {
    if (isBusy) {
      return;
    }

    setResetPending(false);
    setIsSaving(true);
    setDraft(null);
    setError("");
    setStatus("");

    try {
      const items = await window.snow.resetSensitiveCommandConfigs();
      setCommands(items);
      setStatus(
        t("settings.sensitiveCommandResetSuccess", {
          defaultValue: "Reset sensitive command rules to system defaults.",
        }),
      );
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : t("settings.sensitiveCommandResetError", {
              defaultValue: "Failed to reset sensitive command rules",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const isGlobalScope = activeScope === "global";
  const globalListItems: SensitiveCommandListItem[] = commands.map(
    (command) => ({
      commandId: command.commandId,
      pattern: command.pattern,
      description: command.description,
      enabled: command.enabled,
      isPreset: command.isPreset,
      source: command.source,
      inherited: false,
      overridden: false,
      canEdit: true,
      canDelete: !command.isPreset,
    }),
  );
  const projectListItems: SensitiveCommandListItem[] = projectCommands.map(
    (command) => ({
      commandId: command.commandId,
      pattern: command.pattern,
      description: command.description,
      enabled: command.enabled,
      isPreset: command.isPreset,
      source: command.source,
      inherited: command.inherited,
      overridden:
        command.inherited && command.enabled !== command.globalEnabled,
      canEdit: !command.inherited,
      canDelete: !command.inherited,
    }),
  );
  const activeCommands = isGlobalScope ? globalListItems : projectListItems;
  const enabledCount = activeCommands.filter(
    (command) => command.enabled,
  ).length;
  const specialCount = isGlobalScope
    ? activeCommands.filter((command) => command.isPreset).length
    : activeCommands.filter((command) => command.inherited).length;
  const specialLabel = isGlobalScope
    ? t("settings.sensitiveCommandPresetCount", {
        defaultValue: "Preset rules",
      })
    : t("settings.sensitiveCommandInheritedCount", {
        defaultValue: "Inherited rules",
      });
  const listTitle = isGlobalScope
    ? t("settings.sensitiveCommandGlobalListTitle", {
        defaultValue: "Global sensitive command rules",
      })
    : t("settings.sensitiveCommandProjectListTitle", {
        defaultValue: "Effective project rules",
      });
  const emptyMessage = isGlobalScope
    ? t("settings.sensitiveCommandNoRules", {
        defaultValue:
          "No sensitive command rules yet. Sync from Snow CLI or add one manually.",
      })
    : t("settings.sensitiveCommandProjectNoRules", {
        defaultValue:
          "No sensitive command rules are available for this project.",
      });

  return (
    <div className="api-settings-page sensitive-commands-page" role="region">
      <div
        className="import-settings-tabs"
        role="tablist"
        aria-label={t("settings.sensitiveCommandPanelTabs", {
          defaultValue: "Sensitive command settings",
        })}
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "rules"}
          className={`import-settings-tab ${
            activeTab === "rules" ? "active" : ""
          }`}
          onClick={() => setActiveTab("rules")}
        >
          <ShieldCheck size={13} strokeWidth={1.8} />
          {t("settings.sensitiveCommandRulesTab", {
            defaultValue: "Command rules",
          })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "assist"}
          className={`import-settings-tab ${
            activeTab === "assist" ? "active" : ""
          }`}
          onClick={() => setActiveTab("assist")}
        >
          <BrainCircuit size={13} strokeWidth={1.8} />
          {t("settings.sensitiveCommandAssistTitle", {
            defaultValue: "Decision model assist",
          })}
        </button>
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      {activeTab === "rules" && (
        <>
          <SensitiveCommandSummary
            totalCount={activeCommands.length}
            enabledCount={enabledCount}
            specialCount={specialCount}
            specialLabel={specialLabel}
          />

          <div className="api-settings-actions sensitive-commands-actions">
            {isGlobalScope && (
              <button
                className="api-settings-action-btn primary"
                onClick={() => void handleImport()}
                type="button"
                disabled={isBusy}
              >
                {isLoading ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Download size={15} />
                )}
                <span>
                  {t("settings.syncSnowCliSensitiveCommands", {
                    defaultValue: "Sync Snow CLI sensitive commands",
                  })}
                </span>
              </button>
            )}
            {isGlobalScope && (
              <button
                className="api-settings-action-btn secondary"
                onClick={() => setResetPending(true)}
                type="button"
                disabled={isBusy}
                title={t("settings.sensitiveCommandReset", {
                  defaultValue: "Reset to system defaults",
                })}
              >
                <RotateCcw size={15} />
                <span>
                  {t("settings.sensitiveCommandReset", {
                    defaultValue: "Reset to system defaults",
                  })}
                </span>
              </button>
            )}
            <button
              className="api-settings-action-btn secondary"
              onClick={startAdd}
              type="button"
              disabled={isBusy || (!isGlobalScope && !activeDirectory)}
            >
              <Plus size={15} />
              <span>
                {t(
                  isGlobalScope
                    ? "settings.sensitiveCommandAddNew"
                    : "settings.sensitiveCommandAddProjectRule",
                  {
                    defaultValue: isGlobalScope
                      ? "Add rule"
                      : "Add project rule",
                  },
                )}
              </span>
            </button>
          </div>

          <div
            className="skills-settings-tabs"
            role="tablist"
            aria-label={t("settings.sensitiveCommandScopeTabs", {
              defaultValue: "Sensitive command scope",
            })}
          >
            <button
              className={`skills-settings-tab ${isGlobalScope ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={isGlobalScope}
              onClick={() => {
                setActiveScope("global");
                setDraft(null);
              }}
            >
              <Globe2 size={14} strokeWidth={1.8} />
              <span>
                {t("settings.sensitiveCommandTabGlobal", {
                  defaultValue: "Global",
                })}
              </span>
              <small>{globalListItems.length}</small>
            </button>
            <button
              className={`skills-settings-tab ${!isGlobalScope ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={!isGlobalScope}
              onClick={() => {
                setActiveScope("project");
                setDraft(null);
              }}
              disabled={!activeDirectory}
            >
              <Folder size={14} strokeWidth={1.8} />
              <span>
                {t("settings.sensitiveCommandTabProject", {
                  defaultValue: "Project",
                })}
              </span>
              <small>{projectListItems.length}</small>
            </button>
          </div>

          <div className="api-settings-manual-form">
            <div className="api-settings-manual-header">
              <strong>{listTitle}</strong>
              <span>
                {isGlobalScope
                  ? t("settings.sensitiveCommandGlobalTabInfo", {
                      defaultValue:
                        "Manage command approval rules shared by all projects.",
                    })
                  : t("settings.sensitiveCommandProjectTabInfo", {
                      defaultValue:
                        "Manage project rules for {{name}}. Inherited global rules can only be enabled or disabled here.",
                      values: { name: activeDirectory?.name ?? "" },
                    })}
              </span>
            </div>

            <div className="api-settings-form-body">
              <SensitiveCommandList
                commands={activeCommands}
                isBusy={isBusy}
                listTitle={listTitle}
                emptyMessage={emptyMessage}
                onToggleEnabled={(command) => void toggleEnabled(command)}
                onEdit={startEdit}
                onDelete={setCommandPendingDeletion}
              />
            </div>
          </div>
        </>
      )}

      {activeTab === "assist" && (
        <SensitiveCommandDecisionAssist
          settings={assistSettings}
          decisionModels={decisionModels}
          defaultModelId={defaultDecisionModelId}
          isBusy={isBusy}
          onChange={(next) => void saveAssistSettings(next)}
        />
      )}

      <Modal
        open={Boolean(draft)}
        title={t("settings.sensitiveCommandEditorTitle", {
          defaultValue: "Sensitive command rule editor",
        })}
        description={
          draft?.pattern ||
          t("settings.sensitiveCommandAddNew", { defaultValue: "Add rule" })
        }
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={cancelDraft}
        closeDisabled={isBusy}
        size="large"
        className="sensitive-command-editor-modal"
        footer={
          draft && (
            <SensitiveCommandEditorActions
              isBusy={isBusy}
              isSaving={isSaving}
              onCancel={cancelDraft}
              onSave={() => void saveDraft()}
            />
          )
        }
      >
        {draft && (
          <SensitiveCommandEditor
            draft={draft}
            isBusy={isBusy}
            isSaving={isSaving}
            onDraftChange={patchDraft}
            onCancel={cancelDraft}
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>
      <ConfirmDialog
        open={commandPendingDeletion !== null}
        title={t("settings.sensitiveCommandDeleteTitle", {
          defaultValue: "Delete sensitive command rule",
        })}
        message={t("settings.sensitiveCommandDeleteConfirm", {
          defaultValue: 'Delete sensitive command rule "{{pattern}}"?',
          values: { pattern: commandPendingDeletion?.pattern ?? "" },
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={confirmDelete}
        onCancel={() => setCommandPendingDeletion(null)}
        variant="danger"
      />
      <ConfirmDialog
        open={resetPending}
        title={t("settings.sensitiveCommandResetConfirmTitle", {
          defaultValue: "Reset sensitive command rules",
        })}
        message={t("settings.sensitiveCommandResetConfirm", {
          defaultValue:
            "Reset all sensitive command rules to system defaults? Custom rules will be removed and preset rules will be restored.",
        })}
        confirmLabel={t("settings.sensitiveCommandReset", {
          defaultValue: "Reset to system defaults",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void handleReset()}
        onCancel={() => setResetPending(false)}
        variant="warning"
      />
    </div>
  );
}
