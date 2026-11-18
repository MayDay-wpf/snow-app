import { Loader2, Save, X } from "lucide-react";
import type {
  CustomCommandScope,
  CustomCommandType,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";
import { Modal } from "../../common/Modal";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";

export type CustomCommandDraft = {
  commandId: string;
  scope: CustomCommandScope;
  name: string;
  commandType: CustomCommandType;
  content: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
};

export const EMPTY_CUSTOM_COMMAND_DRAFT: CustomCommandDraft = {
  commandId: "",
  scope: "global",
  name: "",
  commandType: "prompt",
  content: "",
  description: "",
  enabled: true,
  sortOrder: 0,
};

type CustomCommandEditModalProps = {
  draft: CustomCommandDraft | null;
  scopeHint: string;
  isSaving: boolean;
  onChange: (patch: Partial<CustomCommandDraft>) => void;
  onClose: () => void;
  onSave: () => void;
};

export function CustomCommandEditModal({
  draft,
  scopeHint,
  isSaving,
  onChange,
  onClose,
  onSave,
}: CustomCommandEditModalProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Modal
      className="custom-command-editor-modal"
      closeDisabled={isSaving}
      closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
      description={draft ? `/${draft.name.trim() || "..."}` : ""}
      onClose={onClose}
      open={Boolean(draft)}
      size="large"
      title={t(
        draft?.commandId
          ? "settings.customCommandEditTitle"
          : "settings.customCommandAddTitle",
        {
          defaultValue: draft?.commandId
            ? "Edit custom command"
            : "New custom command",
        },
      )}
      footer={
        draft && (
          <>
            <button
              className="api-settings-form-btn secondary"
              disabled={isSaving}
              onClick={onClose}
              type="button"
            >
              <X size={15} strokeWidth={1.9} />
              <span>{t("settings.cancel", { defaultValue: "Cancel" })}</span>
            </button>
            <button
              className="api-settings-form-btn primary"
              disabled={isSaving}
              onClick={onSave}
              type="button"
            >
              {isSaving ? (
                <Loader2 className="spin" size={15} />
              ) : (
                <Save size={15} strokeWidth={1.9} />
              )}
              <span>
                {t("settings.saveCustomCommand", {
                  defaultValue: "Save command",
                })}
              </span>
            </button>
          </>
        )
      }
    >
      {draft && (
        <div className="api-settings-form-grid">
          <label className="api-settings-field wide">
            <span>
              {t("settings.customCommandName", {
                defaultValue: "Command name",
              })}
            </span>
            <input
              disabled={isSaving}
              onChange={(event) => onChange({ name: event.target.value })}
              placeholder="deploy"
              value={draft.name}
            />
          </label>

          <label className="api-settings-field">
            <span>
              {t("settings.customCommandType", { defaultValue: "Type" })}
            </span>
            <CustomSelect
              disabled={isSaving}
              onChange={(value) =>
                onChange({ commandType: value as CustomCommandType })
              }
              options={[
                {
                  value: "prompt",
                  label: t("settings.customCommandTypePrompt", {
                    defaultValue: "Prompt (send to AI)",
                  }),
                },
                {
                  value: "bash",
                  label: t("settings.customCommandTypeBash", {
                    defaultValue: "Bash (run shell command)",
                  }),
                },
              ]}
              value={draft.commandType}
            />
          </label>

          <label className="api-settings-field wide">
            <span>
              {draft.commandType === "bash"
                ? t("settings.customCommandBashContent", {
                    defaultValue: "Command",
                  })
                : t("settings.customCommandPromptContent", {
                    defaultValue: "Prompt",
                  })}
              <ApiSettingsHintIcon
                hint={t("settings.customCommandArgumentsHint", {
                  defaultValue:
                    "Text typed after the command name is passed in: $ARGUMENTS is replaced in place, otherwise it is appended.",
                })}
              />
            </span>
            <textarea
              className="api-settings-field-textarea"
              disabled={isSaving}
              onChange={(event) => onChange({ content: event.target.value })}
              placeholder={
                draft.commandType === "bash"
                  ? "npm run build"
                  : t("settings.customCommandPromptPlaceholder", {
                      defaultValue:
                        "Review $ARGUMENTS and list the risky parts.",
                    })
              }
              rows={6}
              value={draft.content}
            />
          </label>

          <label className="api-settings-field wide">
            <span>
              {t("settings.customCommandDescription", {
                defaultValue: "Description",
              })}
            </span>
            <input
              disabled={isSaving}
              onChange={(event) =>
                onChange({ description: event.target.value })
              }
              placeholder={t("settings.customCommandDescriptionPlaceholder", {
                defaultValue: "Shown in the slash command panel",
              })}
              value={draft.description}
            />
          </label>

          <label className="toggle-switch mcp-enabled-switch">
            <input
              checked={draft.enabled}
              disabled={isSaving}
              onChange={(event) => onChange({ enabled: event.target.checked })}
              type="checkbox"
            />
            <span className="toggle-slider" />
            <span>
              {t("settings.customCommandEnabled", { defaultValue: "Enabled" })}
            </span>
          </label>

          <p className="custom-command-arguments-hint">{scopeHint}</p>
        </div>
      )}
    </Modal>
  );
}
