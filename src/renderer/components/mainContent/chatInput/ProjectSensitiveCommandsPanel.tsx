import {
  AlertCircle,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectSensitiveCommandConfigInput,
  ProjectSensitiveCommandConfigRecord,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { Modal } from "../../common/Modal";

type ProjectSensitiveCommandsPanelProps = {
  open: boolean;
  projectId?: string;
  projectName?: string;
  onClose: () => void;
};

type ProjectSensitiveCommandDraft = ProjectSensitiveCommandConfigInput;

const EMPTY_DRAFT: ProjectSensitiveCommandDraft = {
  commandId: "",
  pattern: "",
  description: "",
  enabled: true,
  sortOrder: 0,
};

export const ProjectSensitiveCommandsPanel = ({
  open,
  projectId,
  projectName,
  onClose,
}: ProjectSensitiveCommandsPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const [commands, setCommands] = useState<
    ProjectSensitiveCommandConfigRecord[]
  >([]);
  const [draft, setDraft] = useState<ProjectSensitiveCommandDraft | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandPendingDeletion, setCommandPendingDeletion] =
    useState<ProjectSensitiveCommandConfigRecord | null>(null);
  const [pendingCommandIds, setPendingCommandIds] = useState<Set<string>>(
    () => new Set(),
  );
  const pendingCommandGenerationsRef = useRef<Map<string, number>>(new Map());
  const loadGenerationRef = useRef(0);

  const loadCommands = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    pendingCommandGenerationsRef.current.clear();
    setPendingCommandIds(new Set());
    setCommands([]);
    setDraft(null);
    setCommandPendingDeletion(null);
    setError(null);
    setIsSaving(false);

    if (!projectId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const nextCommands =
        await window.snow.listProjectSensitiveCommandConfigs(projectId);
      if (loadGenerationRef.current === generation) {
        setCommands(nextCommands);
      }
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    if (open) {
      void loadCommands();
      return;
    }

    loadGenerationRef.current += 1;
    pendingCommandGenerationsRef.current.clear();
    setPendingCommandIds(new Set());
    setIsLoading(false);
    setIsSaving(false);
    setCommandPendingDeletion(null);
  }, [loadCommands, open]);

  const inheritedCommands = useMemo(
    () => commands.filter((command) => command.inherited),
    [commands],
  );
  const projectCommands = useMemo(
    () => commands.filter((command) => !command.inherited),
    [commands],
  );
  const startAdd = (): void => {
    const maxSortOrder = projectCommands.reduce(
      (max, command) => Math.max(max, command.sortOrder),
      -1,
    );
    setDraft({ ...EMPTY_DRAFT, sortOrder: maxSortOrder + 1 });
    setError(null);
  };

  const startEdit = (command: ProjectSensitiveCommandConfigRecord): void => {
    if (command.inherited) {
      return;
    }
    setDraft({
      commandId: command.commandId,
      pattern: command.pattern,
      description: command.description,
      enabled: command.enabled,
      sortOrder: command.sortOrder,
    });
    setError(null);
  };

  const saveDraft = async (): Promise<void> => {
    if (!projectId || !draft || isSaving) {
      return;
    }
    const pattern = draft.pattern.trim();
    if (!pattern) {
      setError(t("projectSensitiveCommands.patternRequired"));
      return;
    }
    const hasDuplicate = commands.some(
      (command) =>
        command.commandId !== draft.commandId &&
        command.pattern.trim() === pattern,
    );
    if (hasDuplicate) {
      setError(t("projectSensitiveCommands.duplicatePattern"));
      return;
    }

    const generation = loadGenerationRef.current;
    const operationProjectId = projectId;
    const nextDraft = {
      ...draft,
      pattern,
      description: draft.description.trim(),
    };
    setIsSaving(true);
    setError(null);
    try {
      const nextCommands =
        await window.snow.upsertProjectSensitiveCommandConfig(
          operationProjectId,
          nextDraft,
        );
      if (loadGenerationRef.current === generation) {
        setCommands(nextCommands);
        setDraft(null);
      }
    } catch (saveError) {
      if (loadGenerationRef.current === generation) {
        setError(
          saveError instanceof Error ? saveError.message : String(saveError),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsSaving(false);
      }
    }
  };

  const toggleCommand = async (
    command: ProjectSensitiveCommandConfigRecord,
    enabled: boolean,
  ): Promise<void> => {
    if (
      !projectId ||
      pendingCommandGenerationsRef.current.has(command.commandId)
    ) {
      return;
    }

    const generation = loadGenerationRef.current;
    const operationProjectId = projectId;
    pendingCommandGenerationsRef.current.set(command.commandId, generation);
    setPendingCommandIds((current) => {
      const next = new Set(current);
      next.add(command.commandId);
      return next;
    });
    setError(null);
    setCommands((current) =>
      current.map((item) =>
        item.commandId === command.commandId ? { ...item, enabled } : item,
      ),
    );
    try {
      const nextCommands = await window.snow.setProjectSensitiveCommandEnabled(
        operationProjectId,
        command.commandId,
        enabled,
      );
      if (loadGenerationRef.current === generation) {
        setCommands(nextCommands);
      }
    } catch (updateError) {
      if (loadGenerationRef.current === generation) {
        setCommands((current) =>
          current.map((item) =>
            item.commandId === command.commandId
              ? { ...item, enabled: command.enabled }
              : item,
          ),
        );
        setError(
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
        );
      }
    } finally {
      if (
        pendingCommandGenerationsRef.current.get(command.commandId) ===
        generation
      ) {
        pendingCommandGenerationsRef.current.delete(command.commandId);
        setPendingCommandIds((current) => {
          const next = new Set(current);
          next.delete(command.commandId);
          return next;
        });
      }
    }
  };

  const deleteCommand = async (
    command: ProjectSensitiveCommandConfigRecord,
  ): Promise<void> => {
    if (!projectId || command.inherited || isSaving) {
      return;
    }

    const generation = loadGenerationRef.current;
    const operationProjectId = projectId;
    setIsSaving(true);
    setError(null);
    try {
      const nextCommands =
        await window.snow.deleteProjectSensitiveCommandConfig(
          operationProjectId,
          command.commandId,
        );
      if (loadGenerationRef.current === generation) {
        setCommands(nextCommands);
        if (draft?.commandId === command.commandId) {
          setDraft(null);
        }
      }
    } catch (deleteError) {
      if (loadGenerationRef.current === generation) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : String(deleteError),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsSaving(false);
      }
    }
  };

  const renderCommandGroup = (
    title: string,
    description: string,
    groupCommands: ProjectSensitiveCommandConfigRecord[],
  ): React.JSX.Element => (
    <section className="project-sensitive-command-group">
      <div className="project-sensitive-command-group-header">
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <span>{groupCommands.length}</span>
      </div>
      {groupCommands.length === 0 ? (
        <div className="project-sensitive-command-empty">
          {t("projectSensitiveCommands.emptyGroup")}
        </div>
      ) : (
        <div className="project-sensitive-command-list">
          {groupCommands.map((command) => {
            return (
              <article
                className={`project-sensitive-command-row${
                  command.enabled ? " is-enabled" : ""
                }`}
                key={command.commandId}
              >
                <ShieldAlert size={15} />
                <div className="project-sensitive-command-content">
                  <div>
                    <code>{command.pattern}</code>
                    <span className="project-sensitive-command-source">
                      {command.inherited
                        ? t("projectSensitiveCommands.inherited")
                        : t("projectSensitiveCommands.projectOnly")}
                    </span>
                  </div>
                  <span>{command.description || "-"}</span>
                </div>
                <div className="project-sensitive-command-actions">
                  {!command.inherited ? (
                    <>
                      <button
                        aria-label={t("settings.edit")}
                        className="icon-btn ghost"
                        disabled={isSaving}
                        onClick={() => startEdit(command)}
                        title={t("settings.edit")}
                        type="button"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        aria-label={t("settings.delete")}
                        className="icon-btn ghost danger"
                        disabled={isSaving}
                        onClick={() => setCommandPendingDeletion(command)}
                        title={t("settings.delete")}
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  ) : null}
                  <label
                    className="toggle-switch"
                    title={
                      command.enabled
                        ? t("projectSensitiveCommands.disableForProject")
                        : t("projectSensitiveCommands.enableForProject")
                    }
                  >
                    <input
                      aria-label={
                        command.enabled
                          ? t("projectSensitiveCommands.disableForProject")
                          : t("projectSensitiveCommands.enableForProject")
                      }
                      checked={command.enabled}
                      disabled={
                        isSaving || pendingCommandIds.has(command.commandId)
                      }
                      hidden
                      onChange={(event) =>
                        void toggleCommand(command, event.target.checked)
                      }
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
    </section>
  );

  const confirmDeleteCommand = (): void => {
    if (!commandPendingDeletion || isSaving) {
      return;
    }
    const command = commandPendingDeletion;
    setCommandPendingDeletion(null);
    void deleteCommand(command);
  };

  return (
    <>
      <Modal
        className="project-sensitive-command-modal"
        closeDisabled={isSaving}
        closeLabel={t("projectSensitiveCommands.close")}
        closeOnEscape
        description={
          projectId
            ? t("projectSensitiveCommands.description", {
                values: { project: projectName || projectId },
              })
            : t("projectSensitiveCommands.noProject")
        }
        onClose={onClose}
        open={open}
        size="large"
        title={t("projectSensitiveCommands.title")}
      >
        {!projectId ? (
          <div className="project-sensitive-command-state">
            <AlertCircle size={18} />
            <span>{t("projectSensitiveCommands.noProject")}</span>
          </div>
        ) : isLoading && commands.length === 0 ? (
          <div className="project-sensitive-command-state">
            <Loader2 className="spin" size={18} />
            <span>{t("projectSensitiveCommands.loading")}</span>
          </div>
        ) : (
          <>
            <div className="project-sensitive-command-toolbar">
              <div>
                <span>{t("projectSensitiveCommands.scopeNote")}</span>
              </div>
              <div>
                <button
                  className="project-sensitive-command-toolbar-btn"
                  disabled={isLoading || isSaving}
                  onClick={startAdd}
                  type="button"
                >
                  <Plus size={14} />
                  <span>{t("projectSensitiveCommands.add")}</span>
                </button>
                <button
                  className="project-sensitive-command-toolbar-btn"
                  disabled={isLoading || isSaving}
                  onClick={() => void loadCommands()}
                  type="button"
                >
                  <RefreshCw className={isLoading ? "spin" : ""} size={14} />
                  <span>{t("projectSensitiveCommands.refresh")}</span>
                </button>
              </div>
            </div>

            {error ? (
              <div className="project-sensitive-command-error">
                <AlertCircle size={15} />
                <span>{error}</span>
              </div>
            ) : null}

            {draft ? (
              <section className="project-sensitive-command-editor">
                <div className="project-sensitive-command-editor-header">
                  <strong>
                    {draft.commandId
                      ? t("projectSensitiveCommands.editRule")
                      : t("projectSensitiveCommands.addRule")}
                  </strong>
                  <button
                    aria-label={t("settings.cancel")}
                    className="icon-btn ghost"
                    disabled={isSaving}
                    onClick={() => setDraft(null)}
                    type="button"
                  >
                    <X size={14} />
                  </button>
                </div>
                <label>
                  <span>{t("settings.sensitiveCommandPattern")}</span>
                  <input
                    disabled={isSaving}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, pattern: event.target.value }
                          : current,
                      )
                    }
                    placeholder="git reset*--hard"
                    value={draft.pattern}
                  />
                </label>
                <label>
                  <span>{t("settings.sensitiveCommandDescription")}</span>
                  <input
                    disabled={isSaving}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, description: event.target.value }
                          : current,
                      )
                    }
                    placeholder={t(
                      "settings.sensitiveCommandDescriptionPlaceholder",
                    )}
                    value={draft.description}
                  />
                </label>
                <div className="project-sensitive-command-editor-footer">
                  <label className="project-sensitive-command-enabled-field">
                    <input
                      checked={draft.enabled}
                      disabled={isSaving}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? { ...current, enabled: event.target.checked }
                            : current,
                        )
                      }
                      type="checkbox"
                    />
                    <span>{t("settings.sensitiveCommandEnabled")}</span>
                  </label>
                  <button
                    className="project-sensitive-command-save"
                    disabled={isSaving}
                    onClick={() => void saveDraft()}
                    type="button"
                  >
                    {isSaving ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Save size={14} />
                    )}
                    <span>{t("settings.saveSensitiveCommand")}</span>
                  </button>
                </div>
              </section>
            ) : null}

            <div className="project-sensitive-command-groups">
              {renderCommandGroup(
                t("projectSensitiveCommands.inheritedTitle"),
                t("projectSensitiveCommands.inheritedDescription"),
                inheritedCommands,
              )}
              {renderCommandGroup(
                t("projectSensitiveCommands.projectTitle"),
                t("projectSensitiveCommands.projectDescription"),
                projectCommands,
              )}
            </div>
          </>
        )}
      </Modal>
      <ConfirmDialog
        cancelLabel={t("settings.cancel")}
        confirmLabel={t("settings.delete")}
        message={t("projectSensitiveCommands.deleteConfirm", {
          values: {
            commandId: commandPendingDeletion?.commandId ?? "",
          },
        })}
        onCancel={() => setCommandPendingDeletion(null)}
        onConfirm={confirmDeleteCommand}
        open={commandPendingDeletion !== null}
        title={t("projectSensitiveCommands.deleteTitle")}
        variant="danger"
      />
    </>
  );
};
