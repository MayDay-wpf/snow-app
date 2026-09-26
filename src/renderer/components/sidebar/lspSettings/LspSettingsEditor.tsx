import { Loader2, Save, X } from "lucide-react";
import { useI18n } from "../../../i18n";
import { McpStringListEditor } from "../mcpSettings/McpStringListEditor";
import { PRESET_LANGS, type LspServerDraft } from "./types";
import {
  createLspStringItem,
  getPresetTemplate,
  PRESET_SERVER_TEMPLATES,
} from "./lspSettingsUtils";

type LspSettingsEditorProps = {
  draft: LspServerDraft;
  isBusy: boolean;
  isSaving: boolean;
  onDraftChange: (patch: Partial<LspServerDraft>) => void;
  onUpdateItem: (
    group: "args" | "fileExtensions",
    itemId: string,
    value: string,
  ) => void;
  onAddItem: (group: "args" | "fileExtensions") => void;
  onRemoveItem: (group: "args" | "fileExtensions", itemId: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function LspSettingsEditor({
  draft,
  isBusy,
  isSaving,
  onDraftChange,
  onUpdateItem,
  onAddItem,
  onRemoveItem,
  onCancel,
  onSave,
}: LspSettingsEditorProps): React.JSX.Element {
  const { t } = useI18n();

  const handleLangChange = (newLang: string): void => {
    const patch: Partial<LspServerDraft> = { lang: newLang };
    // 新建未填写命令时，自动填充推荐预设
    if (!draft.id) {
      const template = getPresetTemplate(newLang);
      if (
        template &&
        (!draft.command.trim() ||
          draft.command === "pyright-langserver" ||
          draft.command === "pylsp")
      ) {
        patch.command = template.command;
        patch.args = template.args.map(createLspStringItem);
        patch.fileExtensions = template.fileExtensions.map(createLspStringItem);
        patch.installCommand = template.installCommand;
      }
    }
    onDraftChange(patch);
  };

  const applyPresetTemplate = (templateKey: string): void => {
    const template = PRESET_SERVER_TEMPLATES[templateKey];
    if (!template) return;
    onDraftChange({
      command: template.command,
      args: template.args.map(createLspStringItem),
      fileExtensions: template.fileExtensions.map(createLspStringItem),
      installCommand: template.installCommand,
    });
  };

  const isPython = draft.lang.trim().toLowerCase() === "python";

  return (
    <form
      id="lsp-settings-editor-form"
      className="api-settings-form-section lsp-settings-editor-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="api-settings-form-grid">
        <label className="api-settings-field">
          <span>{t("settings.lspLanguage", { defaultValue: "Language" })}</span>
          <input
            value={draft.lang}
            onChange={(event) => handleLangChange(event.target.value)}
            placeholder="rust"
            list="lsp-preset-langs"
            disabled={isBusy}
            spellCheck={false}
          />
          <datalist id="lsp-preset-langs">
            {PRESET_LANGS.map((lang) => (
              <option value={lang} key={lang} />
            ))}
          </datalist>
        </label>
        <label className="api-settings-field">
          <span>{t("settings.lspCommand", { defaultValue: "Command" })}</span>
          <input
            value={draft.command}
            onChange={(event) => onDraftChange({ command: event.target.value })}
            placeholder="rust-analyzer"
            disabled={isBusy}
            spellCheck={false}
          />
        </label>
        {isPython && (
          <div
            className="api-settings-field wide"
            style={{
              display: "flex",
              gap: "8px",
              alignItems: "center",
              marginTop: "-4px",
            }}
          >
            <span style={{ fontSize: "12px", opacity: 0.75 }}>
              {t("settings.lspPythonPresetHint", {
                defaultValue: "Python 预设选择：",
              })}
            </span>
            <button
              type="button"
              className={`icon-btn ghost ${draft.command === "pyright-langserver" ? "active" : ""}`}
              style={{ fontSize: "12px", padding: "2px 8px", height: "auto" }}
              onClick={() => applyPresetTemplate("python")}
              disabled={isBusy}
            >
              {t("settings.lspPythonRecommended")}
            </button>
            <button
              type="button"
              className={`icon-btn ghost ${draft.command === "pylsp" ? "active" : ""}`}
              style={{ fontSize: "12px", padding: "2px 8px", height: "auto" }}
              onClick={() => applyPresetTemplate("python (pylsp)")}
              disabled={isBusy}
            >
              Pylsp (python-lsp-server)
            </button>
          </div>
        )}
        <label className="api-settings-field wide">
          <span>
            {t("settings.lspInstallCommand", {
              defaultValue: "Install command (optional)",
            })}
          </span>
          <input
            value={draft.installCommand}
            onChange={(event) =>
              onDraftChange({ installCommand: event.target.value })
            }
            placeholder="rustup component add rust-analyzer"
            disabled={isBusy}
            spellCheck={false}
          />
        </label>
        <label className="api-settings-field wide">
          <span>
            {t("settings.lspInitializationOptions", {
              defaultValue: "Initialization options JSON (optional)",
            })}
          </span>
          <textarea
            className="lsp-editor-json-textarea"
            value={draft.initializationOptions}
            onChange={(event) =>
              onDraftChange({ initializationOptions: event.target.value })
            }
            placeholder={'{\n  "key": "value"\n}'}
            disabled={isBusy}
            spellCheck={false}
            rows={4}
          />
        </label>
        <button
          type="button"
          role="switch"
          className="lsp-accessible-switch"
          aria-checked={draft.enabled}
          onClick={() => onDraftChange({ enabled: !draft.enabled })}
          disabled={isBusy}
        >
          <span className="toggle-slider" aria-hidden="true" />
          <span>
            {t("settings.lspServerEnabled", {
              defaultValue: "Enable language server",
            })}
          </span>
        </button>
      </div>

      <McpStringListEditor
        title={t("settings.lspArgs", { defaultValue: "Args" })}
        items={draft.args}
        isBusy={isBusy}
        itemLabel={t("settings.lspArgValue", { defaultValue: "Argument" })}
        valuePlaceholder="--stdio"
        emptyMessage={t("settings.lspNoArgs", {
          defaultValue: "No arguments",
        })}
        onUpdateItem={(itemId, value) => onUpdateItem("args", itemId, value)}
        onAddItem={() => onAddItem("args")}
        onRemoveItem={(itemId) => onRemoveItem("args", itemId)}
      />

      <McpStringListEditor
        title={t("settings.lspFileExtensions", {
          defaultValue: "File extensions",
        })}
        items={draft.fileExtensions}
        isBusy={isBusy}
        itemLabel={t("settings.lspExtension", { defaultValue: "Extension" })}
        valuePlaceholder=".rs"
        emptyMessage={t("settings.lspNoExtensions", {
          defaultValue: "No file extensions",
        })}
        onUpdateItem={(itemId, value) =>
          onUpdateItem("fileExtensions", itemId, value)
        }
        onAddItem={() => onAddItem("fileExtensions")}
        onRemoveItem={(itemId) => onRemoveItem("fileExtensions", itemId)}
      />
    </form>
  );
}

type LspSettingsEditorActionsProps = {
  isBusy: boolean;
  isSaving: boolean;
  onCancel: () => void;
};

export function LspSettingsEditorActions({
  isBusy,
  isSaving,
  onCancel,
}: LspSettingsEditorActionsProps): React.JSX.Element {
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
        form="lsp-settings-editor-form"
        disabled={isBusy}
      >
        {isSaving ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <Save size={15} strokeWidth={1.9} />
        )}
        <span>
          {t("settings.lspSaveServer", { defaultValue: "Save server" })}
        </span>
      </button>
    </>
  );
}
