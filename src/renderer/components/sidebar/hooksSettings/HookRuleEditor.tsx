import { Loader2, Save, Trash2, X } from "lucide-react";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";
import type {
  HookActionDraft,
  HookActionType,
  HookConfigDraft,
  HookRuleDraft,
  HookType,
} from "./types";
import { TOOL_HOOK_TYPES } from "./types";
import {
  createHookActionDraft,
  isActionTypeAllowed,
} from "./hooksSettingsUtils";

type HookRuleEditorProps = {
  draft: HookConfigDraft;
  isBusy: boolean;
  isSaving: boolean;
  onDraftChange: (patch: Partial<HookConfigDraft>) => void;
  onUpdateRule: (ruleId: string, patch: Partial<HookRuleDraft>) => void;
  onAddRule: () => void;
  onRemoveRule: (ruleId: string) => void;
  onUpdateAction: (
    ruleId: string,
    actionId: string,
    patch: Partial<HookActionDraft>,
  ) => void;
  onAddAction: (ruleId: string) => void;
  onRemoveAction: (ruleId: string, actionId: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

const ACTION_TYPE_OPTIONS: { value: HookActionType; label: string }[] = [
  { value: "command", label: "command" },
  { value: "prompt", label: "prompt" },
  { value: "context", label: "context" },
];

const getActionTypeOptions = (
  hookType: HookType,
): { value: HookActionType; label: string }[] => {
  return ACTION_TYPE_OPTIONS.filter((option) =>
    isActionTypeAllowed(hookType, option.value),
  );
};

export function HookRuleEditor({
  draft,
  isBusy,
  isSaving,
  onDraftChange,
  onUpdateRule,
  onAddRule,
  onRemoveRule,
  onUpdateAction,
  onAddAction,
  onRemoveAction,
  onCancel,
  onSave,
}: HookRuleEditorProps): React.JSX.Element {
  const { t } = useI18n();
  const actionTypeOptions = getActionTypeOptions(draft.hookType);

  return (
    <form
      id="hooks-settings-editor-form"
      className="api-settings-form-section hooks-settings-editor-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="api-settings-form-grid">
        <label className="api-settings-field">
          <span>{t("settings.hookType", { defaultValue: "Hook type" })}</span>
          <input
            value={t(`hookTypes.${draft.hookType}`, {
              defaultValue: draft.hookType,
            })}
            title={draft.hookType}
            disabled
          />
        </label>
        <label className="api-settings-field">
          <span>{t("settings.hookScope", { defaultValue: "Scope" })}</span>
          <input
            value={
              draft.scope === "global"
                ? t("settings.hooksTabGlobal", { defaultValue: "Global" })
                : t("settings.hooksTabProject", {
                    defaultValue: "Project",
                  })
            }
            disabled
          />
        </label>
      </div>

      {draft.rules.length === 0 ? (
        <div className="system-prompt-empty compact">
          {t("settings.hooksNoRules", {
            defaultValue: "No rules configured. Add a rule to get started.",
          })}
        </div>
      ) : (
        draft.rules.map((rule, ruleIndex) => (
          <div key={rule.id} className="hooks-rule-block">
            <div className="hooks-rule-block-header">
              <strong>
                {t("settings.hooksRuleLabel", {
                  defaultValue: "Rule",
                })}{" "}
                {ruleIndex + 1}
              </strong>
              <button
                className="icon-btn ghost danger"
                onClick={() => onRemoveRule(rule.id)}
                type="button"
                aria-label={t("settings.delete", {
                  defaultValue: "Delete",
                })}
                title={t("settings.delete", { defaultValue: "Delete" })}
                disabled={isBusy}
              >
                <Trash2 size={14} strokeWidth={1.9} />
              </button>
            </div>

            <label className="api-settings-field">
              <span>
                {t("settings.hooksRuleDescription", {
                  defaultValue: "Description",
                })}
              </span>
              <input
                value={rule.description}
                onChange={(event) =>
                  onUpdateRule(rule.id, { description: event.target.value })
                }
                placeholder={t("settings.hooksRuleDescriptionPlaceholder", {
                  defaultValue: "Describe what this rule does",
                })}
                disabled={isBusy}
              />
            </label>

            {TOOL_HOOK_TYPES.includes(draft.hookType) && (
              <label className="api-settings-field">
                <span>
                  {t("settings.hooksMatcher", {
                    defaultValue: "Tool matcher",
                  })}
                  <ApiSettingsHintIcon
                    hint={t("settings.hooksMatcherHint", {
                      defaultValue:
                        "Comma-separated patterns. Supports * wildcard. Empty matches all tools.",
                    })}
                  />
                </span>
                <input
                  value={rule.matcher}
                  onChange={(event) =>
                    onUpdateRule(rule.id, { matcher: event.target.value })
                  }
                  placeholder={t("settings.hooksMatcherPlaceholder", {
                    defaultValue:
                      "e.g. filesystem-read or filesystem-* (comma-separated)",
                  })}
                  disabled={isBusy}
                />
              </label>
            )}

            {rule.hooks.map((action, actionIndex) => (
              <HookActionFields
                key={action.id}
                action={action}
                actionIndex={actionIndex}
                isBusy={isBusy}
                actionTypeOptions={actionTypeOptions}
                onUpdate={(patch) => onUpdateAction(rule.id, action.id, patch)}
                onRemove={() => onRemoveAction(rule.id, action.id)}
                onDraftChange={onDraftChange}
              />
            ))}

            <button
              className="api-settings-form-btn secondary compact"
              onClick={() => onAddAction(rule.id)}
              type="button"
              disabled={isBusy}
            >
              {t("settings.hooksAddAction", {
                defaultValue: "Add action",
              })}
            </button>
          </div>
        ))
      )}

      <button
        className="api-settings-form-btn secondary"
        onClick={onAddRule}
        type="button"
        disabled={isBusy}
      >
        {t("settings.hooksAddRule", { defaultValue: "Add rule" })}
      </button>
    </form>
  );
}

type HookRuleEditorActionsProps = {
  isBusy: boolean;
  isSaving: boolean;
  onCancel: () => void;
};

export function HookRuleEditorActions({
  isBusy,
  isSaving,
  onCancel,
}: HookRuleEditorActionsProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <button
        className="api-settings-form-btn secondary"
        onClick={onCancel}
        type="button"
        disabled={isBusy}
      >
        <X size={15} strokeWidth={1.9} />
        <span>{t("settings.cancel", { defaultValue: "Cancel" })}</span>
      </button>
      <button
        className="api-settings-form-btn primary"
        type="submit"
        form="hooks-settings-editor-form"
        disabled={isBusy}
      >
        {isSaving ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <Save size={15} strokeWidth={1.9} />
        )}
        <span>{t("settings.saveHooks", { defaultValue: "Save hooks" })}</span>
      </button>
    </>
  );
}

type HookActionFieldsProps = {
  action: HookActionDraft;
  actionIndex: number;
  isBusy: boolean;
  actionTypeOptions: { value: HookActionType; label: string }[];
  onUpdate: (patch: Partial<HookActionDraft>) => void;
  onRemove: () => void;
  onDraftChange: (patch: Partial<HookConfigDraft>) => void;
};

function HookActionFields({
  action,
  actionIndex,
  isBusy,
  actionTypeOptions,
  onUpdate,
  onRemove,
}: HookActionFieldsProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="hooks-action-fields">
      <div className="hooks-action-fields-header">
        <span>
          {t("settings.hooksActionLabel", {
            defaultValue: "Action",
          })}{" "}
          {actionIndex + 1}
        </span>
        <button
          className="icon-btn ghost danger"
          onClick={onRemove}
          type="button"
          aria-label={t("settings.delete", {
            defaultValue: "Delete",
          })}
          title={t("settings.delete", { defaultValue: "Delete" })}
          disabled={isBusy}
        >
          <Trash2 size={13} strokeWidth={1.9} />
        </button>
      </div>

      <div className="api-settings-form-grid">
        <div className="api-settings-field">
          <span>
            {t("settings.hooksActionType", {
              defaultValue: "Action type",
            })}
          </span>
          <CustomSelect
            value={action.type}
            options={actionTypeOptions}
            onChange={(value) =>
              onUpdate({
                type: value as HookActionType,
              })
            }
            disabled={isBusy}
          />
        </div>
        <label className="toggle-switch hooks-action-enabled-switch">
          <input
            type="checkbox"
            checked={action.enabled}
            onChange={(event) => onUpdate({ enabled: event.target.checked })}
            disabled={isBusy}
          />
          <span className="toggle-slider" />
          <span>
            {t("settings.hooksActionEnabled", {
              defaultValue: "Enabled",
            })}
          </span>
        </label>
        <label className="api-settings-field">
          <span>
            {t("settings.hooksActionTimeout", {
              defaultValue: "Timeout (ms)",
            })}
          </span>
          <input
            value={action.timeout}
            onChange={(event) => onUpdate({ timeout: event.target.value })}
            placeholder="5000"
            disabled={isBusy}
          />
        </label>
      </div>

      {action.type === "command" && (
        <label className="api-settings-field wide">
          <span>
            {t("settings.hooksActionCommand", {
              defaultValue: "Command",
            })}
          </span>
          <input
            value={action.command}
            onChange={(event) => onUpdate({ command: event.target.value })}
            placeholder='echo "Hello from hook"'
            disabled={isBusy}
          />
        </label>
      )}
      {action.type === "prompt" && (
        <label className="api-settings-field wide">
          <span>
            {t("settings.hooksActionPrompt", {
              defaultValue: "Prompt",
            })}
          </span>
          <textarea
            value={action.prompt}
            onChange={(event) => onUpdate({ prompt: event.target.value })}
            placeholder="What should I do next?"
            disabled={isBusy}
            rows={3}
          />
        </label>
      )}
      {action.type === "context" && (
        <label className="api-settings-field wide">
          <span>
            {t("settings.hooksActionContent", {
              defaultValue: "Context content",
            })}
          </span>
          <textarea
            value={action.content}
            onChange={(event) => onUpdate({ content: event.target.value })}
            placeholder="Static additional context text"
            disabled={isBusy}
            rows={3}
          />
        </label>
      )}
    </div>
  );
}

export { createHookActionDraft };
