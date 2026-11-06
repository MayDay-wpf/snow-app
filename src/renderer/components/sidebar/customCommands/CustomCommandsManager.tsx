import {
  AlertCircle,
  Folder,
  Globe2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  SquareTerminal,
  Trash2,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CustomCommandRecord } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { BUILT_IN_COMMAND_NAMES } from "../../mainContent/chatInput/commands/commandRegistry";
import {
  CUSTOM_COMMAND_NAME_PATTERN,
  notifyCustomCommandsChanged,
} from "../../mainContent/chatInput/commands/customCommands";
import {
  CustomCommandEditModal,
  type CustomCommandDraft,
  EMPTY_CUSTOM_COMMAND_DRAFT,
} from "./CustomCommandEditModal";

type CustomCommandsManagerProps = {
  projectId?: string;
  projectName?: string;
};

export function CustomCommandsManager({
  projectId,
  projectName,
}: CustomCommandsManagerProps): React.JSX.Element {
  const { t } = useI18n();
  const [records, setRecords] = useState<CustomCommandRecord[]>([]);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [draft, setDraft] = useState<CustomCommandDraft | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pendingDeletion, setPendingDeletion] =
    useState<CustomCommandRecord | null>(null);

  const isBusy = isLoading || isSaving;

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    try {
      const items = await window.snow.listCustomCommands(projectId);
      setRecords(items);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("settings.customCommandsLoadError", {
              defaultValue: "Failed to load custom commands",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    setDraft(null);
    setPendingDeletion(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !window.snow?.onCustomCommandsChanged
    ) {
      return undefined;
    }
    return window.snow.onCustomCommandsChanged(() => {
      void load();
    });
  }, [load]);

  useEffect(() => {
    if (!projectId && scope === "project") {
      setScope("global");
    }
  }, [projectId, scope]);

  const globalRecords = useMemo(
    () => records.filter((record) => record.scope === "global"),
    [records],
  );
  const projectRecords = useMemo(
    () => records.filter((record) => record.scope === "project"),
    [records],
  );
  const scopeRecords = scope === "global" ? globalRecords : projectRecords;

  const startAdd = (): void => {
    setDraft({ ...EMPTY_CUSTOM_COMMAND_DRAFT, scope });
    setError("");
    setStatus("");
  };

  const startEdit = (record: CustomCommandRecord): void => {
    setDraft({
      commandId: record.commandId,
      scope: record.scope,
      name: record.name,
      commandType: record.commandType,
      content: record.content,
      description: record.description,
      enabled: record.enabled,
      sortOrder: record.sortOrder,
    });
    setError("");
    setStatus("");
  };

  const patchDraft = (patch: Partial<CustomCommandDraft>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const validateDraft = (nextDraft: CustomCommandDraft): string | null => {
    const name = nextDraft.name.trim();
    if (!name) {
      return t("settings.customCommandNameRequired", {
        defaultValue: "Command name is required.",
      });
    }
    if (!CUSTOM_COMMAND_NAME_PATTERN.test(name)) {
      return t("settings.customCommandNameInvalid", {
        defaultValue:
          "Command name only supports letters, digits, hyphen, underscore and dot.",
      });
    }
    if (BUILT_IN_COMMAND_NAMES.has(name.toLowerCase())) {
      return t("settings.customCommandNameReserved", {
        defaultValue: "This name is used by a built-in command.",
      });
    }
    if (!nextDraft.content.trim()) {
      return t("settings.customCommandContentRequired", {
        defaultValue: "Command content is required.",
      });
    }
    const duplicated = records.some(
      (record) =>
        record.scope === nextDraft.scope &&
        record.commandId !== nextDraft.commandId &&
        record.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicated) {
      return t("settings.customCommandDuplicateName", {
        defaultValue: "A command with this name already exists in this scope.",
      });
    }
    if (nextDraft.scope === "project" && !projectId) {
      return t("settings.customCommandsNoProject", {
        defaultValue: "Select a project first to manage project commands.",
      });
    }
    return null;
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft || isSaving) {
      return;
    }
    const validationError = validateDraft(draft);
    if (validationError) {
      setError(validationError);
      setStatus("");
      return;
    }

    setIsSaving(true);
    setError("");
    setStatus("");
    try {
      const isExisting = records.some(
        (record) => record.commandId === draft.commandId,
      );
      const maxSortOrder = records
        .filter((record) => record.scope === draft.scope)
        .reduce((max, record) => Math.max(max, record.sortOrder), -1);
      await window.snow.upsertCustomCommand({
        commandId: draft.commandId,
        scope: draft.scope,
        projectId: draft.scope === "project" ? (projectId ?? "") : "",
        name: draft.name.trim(),
        commandType: draft.commandType,
        content: draft.content.trim(),
        description: draft.description.trim(),
        enabled: draft.enabled,
        sortOrder: isExisting ? draft.sortOrder : maxSortOrder + 1,
      });
      await load();
      notifyCustomCommandsChanged();
      setDraft(null);
      setStatus(
        isExisting
          ? t("settings.customCommandSaveSuccess", {
              defaultValue: "Saved custom command.",
            })
          : t("settings.customCommandAddSuccess", {
              defaultValue: "Added custom command.",
            }),
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t("settings.customCommandSaveError", {
              defaultValue: "Failed to save the custom command",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const toggleEnabled = async (record: CustomCommandRecord): Promise<void> => {
    setIsSaving(true);
    setError("");
    setStatus("");
    try {
      await window.snow.upsertCustomCommand({
        commandId: record.commandId,
        scope: record.scope,
        projectId: record.projectId,
        name: record.name,
        commandType: record.commandType,
        content: record.content,
        description: record.description,
        enabled: !record.enabled,
        sortOrder: record.sortOrder,
      });
      await load();
      notifyCustomCommandsChanged();
    } catch (toggleError) {
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : t("settings.customCommandSaveError", {
              defaultValue: "Failed to save the custom command",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = (): void => {
    if (!pendingDeletion || isSaving) {
      return;
    }
    const record = pendingDeletion;
    setPendingDeletion(null);
    void (async (): Promise<void> => {
      setIsSaving(true);
      setError("");
      setStatus("");
      try {
        await window.snow.deleteCustomCommand(record.commandId);
        await load();
        notifyCustomCommandsChanged();
        setDraft((current) =>
          current?.commandId === record.commandId ? null : current,
        );
        setStatus(
          t("settings.customCommandDeleteSuccess", {
            defaultValue: "Deleted custom command.",
          }),
        );
      } catch (deleteError) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : t("settings.customCommandDeleteError", {
                defaultValue: "Failed to delete the custom command",
              }),
        );
      } finally {
        setIsSaving(false);
      }
    })();
  };

  const scopeHint =
    scope === "project"
      ? t("settings.customCommandsProjectScopeHint", {
          defaultValue:
            "Saved for {{project}}. A project command with the same name overrides the global one.",
          values: { project: projectName || projectId || "" },
        })
      : t("settings.customCommandsGlobalScopeHint", {
          defaultValue: "Saved for every project on this device.",
        });

  const scopeTabsLabel = t("settings.customCommandsTitle", {
    defaultValue: "Custom commands",
  });

  return (
    <div className="custom-commands-manager">
      <div className="custom-command-toolbar">
        <span className="custom-command-scope-hint">{scopeHint}</span>
        <div className="custom-command-toolbar-actions">
          <button
            className="api-settings-action-btn secondary"
            disabled={isBusy}
            onClick={startAdd}
            type="button"
          >
            <Plus size={15} />
            <span>
              {t("settings.customCommandsAdd", { defaultValue: "Add command" })}
            </span>
          </button>
          <button
            className="api-settings-action-btn secondary"
            disabled={isBusy}
            onClick={() => void load()}
            type="button"
          >
            <RefreshCw className={isLoading ? "spin" : ""} size={15} />
            <span>
              {t("settings.customCommandsRefresh", { defaultValue: "Refresh" })}
            </span>
          </button>
        </div>
      </div>

      <AutoDismissNotice
        durationMs={error ? 4500 : 2000}
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div
        aria-label={scopeTabsLabel}
        className="segmented-tabs segmented-tabs--spaced"
        role="tablist"
      >
        <button
          aria-selected={scope === "global"}
          className={`segmented-tab ${scope === "global" ? "active" : ""}`}
          onClick={() => {
            setScope("global");
            setDraft(null);
          }}
          role="tab"
          type="button"
        >
          <Globe2 size={14} strokeWidth={1.8} />
          <span>
            {t("settings.customCommandsGlobalTab", { defaultValue: "Global" })}
          </span>
          <small>{globalRecords.length}</small>
        </button>
        <button
          aria-selected={scope === "project"}
          className={`segmented-tab ${scope === "project" ? "active" : ""}`}
          disabled={!projectId}
          onClick={() => {
            setScope("project");
            setDraft(null);
          }}
          role="tab"
          title={
            projectId
              ? projectName || projectId
              : t("settings.customCommandsNoProject", {
                  defaultValue:
                    "Select a project first to manage project commands.",
                })
          }
          type="button"
        >
          <Folder size={14} strokeWidth={1.8} />
          <span>
            {t("settings.customCommandsProjectTab", {
              defaultValue: "Current project",
            })}
          </span>
          <small>{projectRecords.length}</small>
        </button>
      </div>

      {isLoading && records.length === 0 ? (
        <div className="custom-command-state">
          <Loader2 className="spin" size={18} />
          <span>
            {t("settings.customCommandsLoading", {
              defaultValue: "Loading custom commands...",
            })}
          </span>
        </div>
      ) : scopeRecords.length === 0 ? (
        <div className="custom-command-state">
          <AlertCircle size={18} />
          <span>
            {t("settings.customCommandsEmpty", {
              defaultValue: "No custom commands yet.",
            })}
          </span>
        </div>
      ) : (
        <div className="custom-command-list">
          {scopeRecords.map((record) => {
            const CommandIcon =
              record.commandType === "bash" ? SquareTerminal : Wand2;
            const isShadowedScope =
              record.scope === "global" && record.shadowed;
            return (
              <article
                className={`custom-command-row${record.enabled ? " is-enabled" : ""}`}
                key={record.commandId}
              >
                <CommandIcon size={15} />
                <div className="custom-command-content">
                  <div className="custom-command-title">
                    <code>/{record.name}</code>
                    <span className="custom-command-type">
                      {record.commandType === "bash"
                        ? t("settings.customCommandTypeBash", {
                            defaultValue: "Bash (run shell command)",
                          })
                        : t("settings.customCommandTypePrompt", {
                            defaultValue: "Prompt (send to AI)",
                          })}
                    </span>
                    {isShadowedScope ? (
                      <span className="custom-command-type muted">
                        {t("settings.customCommandShadowed", {
                          defaultValue: "Overridden by a project command",
                        })}
                      </span>
                    ) : null}
                  </div>
                  <span className="custom-command-description">
                    {record.description || record.content}
                  </span>
                </div>
                <div className="custom-command-actions">
                  <button
                    aria-label={t("settings.edit", { defaultValue: "Edit" })}
                    className="icon-btn ghost"
                    disabled={isSaving}
                    onClick={() => startEdit(record)}
                    title={t("settings.edit", { defaultValue: "Edit" })}
                    type="button"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    aria-label={t("settings.delete", {
                      defaultValue: "Delete",
                    })}
                    className="icon-btn ghost danger"
                    disabled={isSaving}
                    onClick={() => setPendingDeletion(record)}
                    title={t("settings.delete", { defaultValue: "Delete" })}
                    type="button"
                  >
                    <Trash2 size={14} />
                  </button>
                  <label
                    className="toggle-switch"
                    title={
                      record.enabled
                        ? t("settings.customCommandDisable", {
                            defaultValue: "Disable",
                          })
                        : t("settings.customCommandEnable", {
                            defaultValue: "Enable",
                          })
                    }
                  >
                    <input
                      aria-label={
                        record.enabled
                          ? t("settings.customCommandDisable", {
                              defaultValue: "Disable",
                            })
                          : t("settings.customCommandEnable", {
                              defaultValue: "Enable",
                            })
                      }
                      checked={record.enabled}
                      disabled={isSaving}
                      hidden
                      onChange={() => void toggleEnabled(record)}
                      type="checkbox"
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <CustomCommandEditModal
        draft={draft}
        isSaving={isSaving}
        onChange={patchDraft}
        onClose={() => setDraft(null)}
        onSave={() => void saveDraft()}
        scopeHint={scopeHint}
      />

      <ConfirmDialog
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        message={t("settings.customCommandDeleteConfirm", {
          defaultValue: "Delete /{{name}}? This cannot be undone.",
          values: { name: pendingDeletion?.name ?? "" },
        })}
        onCancel={() => setPendingDeletion(null)}
        onConfirm={confirmDelete}
        open={pendingDeletion !== null}
        title={t("settings.customCommandDeleteTitle", {
          defaultValue: "Delete custom command",
        })}
        variant="danger"
      />
    </div>
  );
}
