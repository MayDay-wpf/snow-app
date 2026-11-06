import { Folder, Globe2, HelpCircle, Link, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HookConfigRecord,
  HookScope,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import {
  HookRuleEditor,
  HookRuleEditorActions,
} from "./hooksSettings/HookRuleEditor";
import { HooksSettingsList } from "./hooksSettings/HooksSettingsList";
import { HooksSettingsSummary } from "./hooksSettings/HooksSettingsSummary";
import {
  countEnabledActions,
  countTotalActions,
  createHookActionDraft,
  createHookRuleDraft,
  rulesFromJson,
  toDraft,
  toInput,
} from "./hooksSettings/hooksSettingsUtils";
import type {
  HookActionDraft,
  HookConfigDraft,
  HookListItem,
  HookRuleDraft,
  HookType,
} from "./hooksSettings/types";
import { SUPPORTED_HOOK_TYPES } from "./hooksSettings/types";
import {
  getAllHookDocs,
  getHookDecisionConfirmationDoc,
} from "./hooksSettings/hookDocsContent";
import type { HookDocContent } from "./hooksSettings/hookDocsContent";
import {
  usePublishSettingsPageActions,
  type SettingsPageAction,
} from "../TopBar/settingsPageActionsStore";

type HooksSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

export function HooksSettingsPanel({
  activeDirectory,
}: HooksSettingsPanelProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const [activeScope, setActiveScope] = useState<HookScope>("global");
  const [globalConfigs, setGlobalConfigs] = useState<HookConfigRecord[]>([]);
  const [projectConfigs, setProjectConfigs] = useState<HookConfigRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [draft, setDraft] = useState<HookConfigDraft | null>(null);
  const [hookPendingDeletion, setHookPendingDeletion] =
    useState<HookListItem | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const loadGenerationRef = useRef(0);

  const isBusy = isLoading || isSaving;

  const openDocs = useCallback((): void => setDocsOpen(true), []);

  usePublishSettingsPageActions(
    "hooks-settings",
    useMemo<SettingsPageAction[]>(
      () => [
        {
          id: "docs",
          label: t("settings.hooksDocsTitle", {
            defaultValue: "Hooks documentation",
          }),
          icon: HelpCircle,
          onClick: openDocs,
        },
      ],
      [t, openDocs],
    ),
  );

  const load = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoading(true);
    setIsSaving(false);
    setDraft(null);
    setHookPendingDeletion(null);
    setError("");

    try {
      const [globalItems, projectItems] = await Promise.all([
        window.snow.listHookConfigs("global"),
        activeDirectory
          ? window.snow.listHookConfigs("project", activeDirectory.directoryId)
          : Promise.resolve([]),
      ]);
      if (loadGenerationRef.current !== generation) {
        return;
      }

      setGlobalConfigs(globalItems);
      setProjectConfigs(projectItems);
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("settings.hooksLoadError", {
                defaultValue: "Failed to load hook configs",
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

  useEffect(() => {
    setDraft(null);
    setHookPendingDeletion(null);
    setProjectConfigs([]);
    setStatus("");
    setError("");
  }, [activeDirectory?.directoryId]);

  const buildListItem = (record: HookConfigRecord): HookListItem => {
    const rules = rulesFromJson(record.rulesJson);
    const draftFromRecord = toDraft(record);
    return {
      hookType: record.hookType as HookType,
      scope: record.scope,
      projectId: record.projectId,
      ruleCount: rules.length,
      enabledActionCount: countEnabledActions(draftFromRecord),
      totalActionCount: countTotalActions(draftFromRecord),
      updatedAt: record.updatedAt,
    };
  };

  const isGlobalScope = activeScope === "global";
  const activeConfigs = isGlobalScope ? globalConfigs : projectConfigs;
  const activeListItems: HookListItem[] = SUPPORTED_HOOK_TYPES.map(
    (hookType) => {
      const record = activeConfigs.find((item) => item.hookType === hookType);
      if (record) {
        return buildListItem(record);
      }
      return {
        hookType,
        scope: activeScope,
        projectId:
          activeScope === "project" ? (activeDirectory?.directoryId ?? "") : "",
        ruleCount: 0,
        enabledActionCount: 0,
        totalActionCount: 0,
        updatedAt: "",
      };
    },
  );

  const configuredCount = activeListItems.filter(
    (item) => item.ruleCount > 0,
  ).length;
  const enabledCount = activeListItems.filter(
    (item) => item.enabledActionCount > 0,
  ).length;

  const startEdit = (hook: HookListItem): void => {
    const record = activeConfigs.find(
      (item) => item.hookType === hook.hookType && item.scope === hook.scope,
    );
    if (record) {
      setDraft(toDraft(record));
    } else {
      setDraft({
        hookType: hook.hookType,
        scope: hook.scope,
        projectId:
          hook.scope === "project" ? (activeDirectory?.directoryId ?? "") : "",
        rules: [],
        updatedAt: "",
      });
    }
    setError("");
    setStatus("");
  };

  const cancelDraft = (): void => {
    setDraft(null);
    setError("");
  };

  const patchDraft = (patch: Partial<HookConfigDraft>): void => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : null));
  };

  const updateRule = (ruleId: string, patch: Partial<HookRuleDraft>): void => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            rules: previous.rules.map((rule) =>
              rule.id === ruleId ? { ...rule, ...patch } : rule,
            ),
          }
        : null,
    );
  };

  const addRule = (): void => {
    setDraft((previous) =>
      previous
        ? { ...previous, rules: [...previous.rules, createHookRuleDraft()] }
        : null,
    );
  };

  const removeRule = (ruleId: string): void => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            rules: previous.rules.filter((rule) => rule.id !== ruleId),
          }
        : null,
    );
  };

  const updateAction = (
    ruleId: string,
    actionId: string,
    patch: Partial<HookActionDraft>,
  ): void => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            rules: previous.rules.map((rule) =>
              rule.id === ruleId
                ? {
                    ...rule,
                    hooks: rule.hooks.map((action) =>
                      action.id === actionId ? { ...action, ...patch } : action,
                    ),
                  }
                : rule,
            ),
          }
        : null,
    );
  };

  const addAction = (ruleId: string): void => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            rules: previous.rules.map((rule) =>
              rule.id === ruleId
                ? {
                    ...rule,
                    hooks: [...rule.hooks, createHookActionDraft()],
                  }
                : rule,
            ),
          }
        : null,
    );
  };

  const removeAction = (ruleId: string, actionId: string): void => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            rules: previous.rules.map((rule) =>
              rule.id === ruleId
                ? {
                    ...rule,
                    hooks: rule.hooks.filter(
                      (action) => action.id !== actionId,
                    ),
                  }
                : rule,
            ),
          }
        : null,
    );
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft || isSaving) {
      return;
    }

    const operationScope = draft.scope;
    const operationProjectId =
      operationScope === "project" ? activeDirectory?.directoryId : undefined;
    const generation = loadGenerationRef.current;

    if (operationScope === "project" && !operationProjectId) {
      setError(
        t("settings.hooksProjectRequired", {
          defaultValue: "Select a project before saving project hooks.",
        }),
      );
      return;
    }

    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      const input = toInput({
        ...draft,
        projectId: operationProjectId ?? draft.projectId,
      });
      await window.snow.upsertHookConfig(input);
      if (loadGenerationRef.current !== generation) {
        return;
      }

      const items = await window.snow.listHookConfigs(
        operationScope,
        operationProjectId,
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }

      if (operationScope === "global") {
        setGlobalConfigs(items);
      } else {
        setProjectConfigs(items);
      }

      setDraft(null);
      setStatus(
        t("settings.hooksSaveSuccess", {
          defaultValue: "Saved hook configuration.",
        }),
      );
    } catch (saveError) {
      if (loadGenerationRef.current === generation) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : t("settings.hooksSaveError", {
                defaultValue: "Failed to save hook configuration",
              }),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsSaving(false);
      }
    }
  };

  const handleDelete = async (hook: HookListItem): Promise<void> => {
    if (isBusy) {
      return;
    }

    const operationScope = hook.scope;
    const operationProjectId =
      operationScope === "project" ? activeDirectory?.directoryId : undefined;
    const generation = loadGenerationRef.current;
    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      await window.snow.deleteHookConfig(
        hook.hookType,
        operationScope,
        operationProjectId,
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }

      const items = await window.snow.listHookConfigs(
        operationScope,
        operationProjectId,
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }

      if (operationScope === "global") {
        setGlobalConfigs(items);
      } else {
        setProjectConfigs(items);
      }

      if (draft?.hookType === hook.hookType) {
        setDraft(null);
      }
      setStatus(
        t("settings.hooksDeleteSuccess", {
          defaultValue: "Deleted hook configuration.",
        }),
      );
    } catch (deleteError) {
      if (loadGenerationRef.current === generation) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : t("settings.hooksDeleteError", {
                defaultValue: "Failed to delete hook configuration",
              }),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsSaving(false);
      }
    }
  };

  const confirmDelete = (): void => {
    if (!hookPendingDeletion || isBusy) {
      return;
    }
    const hook = hookPendingDeletion;
    setHookPendingDeletion(null);
    void handleDelete(hook);
  };

  const listTitle = isGlobalScope
    ? t("settings.hooksGlobalListTitle", {
        defaultValue: "Global hook configurations",
      })
    : t("settings.hooksProjectListTitle", {
        defaultValue: "Project hook configurations",
      });
  const emptyMessage = isGlobalScope
    ? t("settings.hooksGlobalEmpty", {
        defaultValue:
          "No global hooks configured yet. Select a hook type to begin.",
      })
    : t("settings.hooksProjectEmpty", {
        defaultValue:
          "No project hooks configured yet. Select a hook type to begin.",
      });

  return (
    <div className="api-settings-page" role="region">
      <HooksSettingsSummary
        totalCount={SUPPORTED_HOOK_TYPES.length}
        configuredCount={configuredCount}
        enabledCount={enabledCount}
      />

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div
        className="segmented-tabs segmented-tabs--spaced"
        role="tablist"
        aria-label={t("settings.hooksScopeTabs", {
          defaultValue: "Hooks scope",
        })}
      >
        <button
          className={`segmented-tab ${isGlobalScope ? "active" : ""}`}
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
            {t("settings.hooksTabGlobal", { defaultValue: "Global" })}
          </span>
          <small>
            {
              globalConfigs.filter(
                (item) => rulesFromJson(item.rulesJson).length > 0,
              ).length
            }
          </small>
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
            {t("settings.hooksTabProject", {
              defaultValue: "Project",
            })}
          </span>
          <small>
            {
              projectConfigs.filter(
                (item) => rulesFromJson(item.rulesJson).length > 0,
              ).length
            }
          </small>
        </button>
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>{listTitle}</strong>
          <span>
            {isGlobalScope
              ? t("settings.hooksGlobalTabInfo", {
                  defaultValue:
                    "Manage lifecycle hooks shared by all projects.",
                })
              : t("settings.hooksProjectTabInfo", {
                  defaultValue:
                    "Manage project hooks for {{name}}. Project hooks override global hooks when configured.",
                  values: { name: activeDirectory?.name ?? "" },
                })}
          </span>
        </div>

        <div className="api-settings-form-body">
          {isLoading ? (
            <div className="system-prompt-empty">
              <Loader2 size={16} className="spin" />
              <span>
                {t("settings.hooksLoading", {
                  defaultValue: "Loading hook configurations...",
                })}
              </span>
            </div>
          ) : (
            <HooksSettingsList
              hooks={activeListItems}
              isBusy={isBusy}
              listTitle={listTitle}
              emptyMessage={emptyMessage}
              onEdit={startEdit}
              onDelete={setHookPendingDeletion}
            />
          )}
        </div>
      </div>

      <Modal
        open={Boolean(draft)}
        title={t("settings.hooksEditorTitle", {
          defaultValue: "Hook configuration editor",
        })}
        description={
          draft?.hookType ||
          t("settings.hooksEditorTitle", {
            defaultValue: "Hook configuration editor",
          })
        }
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={cancelDraft}
        closeDisabled={isBusy}
        size="large"
        className="hooks-settings-editor-modal"
        footer={
          draft && (
            <HookRuleEditorActions
              isBusy={isBusy}
              isSaving={isSaving}
              onCancel={cancelDraft}
            />
          )
        }
      >
        {draft && (
          <HookRuleEditor
            draft={draft}
            isBusy={isBusy}
            isSaving={isSaving}
            onDraftChange={patchDraft}
            onUpdateRule={updateRule}
            onAddRule={addRule}
            onRemoveRule={removeRule}
            onUpdateAction={updateAction}
            onAddAction={addAction}
            onRemoveAction={removeAction}
            onCancel={cancelDraft}
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={hookPendingDeletion !== null}
        title={t("settings.hooksDeleteTitle", {
          defaultValue: "Delete hook configuration",
        })}
        message={t("settings.hooksDeleteConfirm", {
          defaultValue:
            'Delete configuration for hook "{{hookType}}" in {{scope}} scope?',
          values: {
            hookType: hookPendingDeletion
              ? t(`hookTypes.${hookPendingDeletion.hookType}`, {
                  defaultValue: hookPendingDeletion.hookType,
                })
              : "",
            scope:
              hookPendingDeletion?.scope === "global"
                ? t("settings.hooksTabGlobal", { defaultValue: "global" })
                : t("settings.hooksTabProject", { defaultValue: "project" }),
          },
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={confirmDelete}
        onCancel={() => setHookPendingDeletion(null)}
        variant="danger"
      />

      <Modal
        open={docsOpen}
        title={t("settings.hooksDocsTitle", {
          defaultValue: "Hooks documentation",
        })}
        closeLabel={t("settings.close", { defaultValue: "Close" })}
        onClose={() => setDocsOpen(false)}
        size="large"
        className="docs-modal"
      >
        <HooksDocsContent locale={locale} />
      </Modal>
    </div>
  );
}

function HooksDocsContent({ locale }: { locale: string }): React.JSX.Element {
  const docsLocale = locale as Parameters<typeof getAllHookDocs>[0];
  const docs = getAllHookDocs(docsLocale);
  const decisionConfirmationDoc = getHookDecisionConfirmationDoc(docsLocale);
  const { t } = useI18n();

  const entries = Object.entries(docs) as [string, HookDocContent][];

  return (
    <div className="docs-container">
      <div className="docs-section">
        <h3 className="docs-section-title">{decisionConfirmationDoc.title}</h3>
        <p className="docs-section-description">
          {decisionConfirmationDoc.description}
        </p>
        <div className="docs-example">
          <pre className="docs-example-code">
            {decisionConfirmationDoc.body}
          </pre>
          <p className="docs-example-explanation">
            {decisionConfirmationDoc.explanation}
          </p>
        </div>
      </div>
      {entries.map(([key, doc]) => (
        <div key={key} className="docs-section">
          <h3 className="docs-section-title">{doc.title}</h3>
          <p className="docs-section-description">{doc.description}</p>
          <div className="docs-subsection">
            <strong>
              {t("settings.hooksDocsContextFields", {
                defaultValue: "Context fields",
              })}
            </strong>
            <table className="docs-table">
              <tbody>
                {doc.contextFields.map((field) => (
                  <tr key={field.name}>
                    <td className="docs-field-name">{field.name}</td>
                    <td className="docs-field-desc">{field.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="docs-subsection">
            <strong>
              {t("settings.hooksDocsExitCodes", {
                defaultValue: "Exit codes",
              })}
            </strong>
            <table className="docs-table">
              <tbody>
                {doc.exitCodes.map((code) => (
                  <tr key={code.code}>
                    <td className="docs-code-value">{code.code}</td>
                    <td className="docs-code-meaning">{code.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {doc.examples.length > 0 && (
            <div className="docs-subsection">
              <strong>
                {t("settings.hooksDocsExamples", {
                  defaultValue: "Examples",
                })}
              </strong>
              {doc.examples.map((example, idx) => (
                <div key={idx} className="docs-example">
                  <div className="docs-example-header">
                    <span className="docs-example-title">{example.title}</span>
                    <span className="docs-example-badge">
                      {example.actionType}
                    </span>
                    {example.matcher && (
                      <span className="docs-example-badge">
                        matcher: {example.matcher}
                      </span>
                    )}
                  </div>
                  <pre className="docs-example-code">{example.body}</pre>
                  <p className="docs-example-explanation">
                    {example.explanation}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
