import { AlertCircle, FileText, Globe, Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { useI18n } from "../../../i18n";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";
import { RoleSwitchRow } from "./RoleSwitchRow";

/**
 * 全局规则编辑器：编辑 ~/.snow/ROLE.md 及其「覆盖内置提示词」开关。
 * 保存的内容会被 native 系统提示词构建管线读取，并默认与项目规则组合。
 */
export const GlobalRoleEditor = (): React.JSX.Element => {
  const { t } = useI18n();
  const [filePath, setFilePath] = useState("");
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [overrideBuiltinPrompt, setOverrideBuiltinPrompt] = useState(false);
  const [originalOverrideBuiltinPrompt, setOriginalOverrideBuiltinPrompt] =
    useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    setSaveSuccess(false);

    try {
      const result = await window.snow.getGlobalRole();
      setFilePath(result.filePath);
      setContent(result.content);
      setOriginalContent(result.content);
      setOverrideBuiltinPrompt(result.overrideBuiltinPrompt);
      setOriginalOverrideBuiltinPrompt(result.overrideBuiltinPrompt);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async (): Promise<void> => {
    if (isSaving) return;

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      await window.snow.saveGlobalRole(
        content,
        overrideBuiltinPrompt !== originalOverrideBuiltinPrompt
          ? overrideBuiltinPrompt
          : undefined,
      );
      setOriginalContent(content);
      setOriginalOverrideBuiltinPrompt(overrideBuiltinPrompt);
      setSaveSuccess(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges =
    content !== originalContent ||
    overrideBuiltinPrompt !== originalOverrideBuiltinPrompt;

  return (
    <section
      className="personalization-section"
      aria-label={t("personalization.globalTitle")}
    >
      <div className="personalization-section-header">
        <div className="personalization-section-title">
          <span className="personalization-section-icon">
            <Globe size={15} strokeWidth={2} />
          </span>
          <strong>
            {t("personalization.globalTitle", {
              defaultValue: "Global rules",
            })}
            <ApiSettingsHintIcon
              hint={`${t("personalization.globalInfo", {
                defaultValue:
                  "Rules that apply to all projects and conversations.",
              })} ${t("personalization.globalScopeNote", {
                defaultValue:
                  "Global rules are saved to ~/.snow/ROLE.md and apply to every project.",
              })}`}
            />
          </strong>
        </div>
      </div>

      <RoleSwitchRow
        checked={overrideBuiltinPrompt}
        description={t("personalization.overrideBuiltinDesc", {
          defaultValue:
            "When enabled, the rules replace the built-in prompt in normal mode; Goal / WorkFlow / WorkTree modes keep their own built-in guidance. System prompts bound in the API profile still apply.",
        })}
        disabled={isLoading || isSaving}
        onChange={(checked) => {
          setOverrideBuiltinPrompt(checked);
          setSaveSuccess(false);
        }}
        title={t("personalization.overrideBuiltinTitle", {
          defaultValue: "Override built-in prompt",
        })}
      />

      <div className="personalization-toolbar">
        <div className="personalization-toolbar-main">
          <FileText size={14} />
          <div className="personalization-toolbar-info">
            {filePath ? (
              <small className="project-skills-path" title={filePath}>
                {filePath}
              </small>
            ) : null}
          </div>
        </div>
        <div>
          <button
            className="personalization-save-btn"
            disabled={isSaving || isLoading || !hasChanges}
            onClick={() => void handleSave()}
            type="button"
          >
            {isSaving ? (
              <Loader2 className="spin" size={14} />
            ) : (
              <Save size={14} />
            )}
            <span>{t("personalization.save", { defaultValue: "Save" })}</span>
          </button>
        </div>
      </div>

      {error ? (
        <div className="project-sensitive-command-error">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {saveSuccess ? (
        <AutoDismissNotice
          message={t("personalization.globalSaved", {
            defaultValue: "Global rules saved.",
          })}
          tone="success"
          onDismiss={() => setSaveSuccess(false)}
        />
      ) : null}

      {isLoading ? (
        <div className="project-sensitive-command-state">
          <Loader2 className="spin" size={18} />
          <span>
            {t("roleEditor.loading", { defaultValue: "Loading ROLE.md..." })}
          </span>
        </div>
      ) : (
        <>
          <textarea
            aria-label={t("personalization.globalTitle", {
              defaultValue: "Global rules",
            })}
            className="personalization-textarea"
            onChange={(event) => {
              setContent(event.target.value);
              setSaveSuccess(false);
            }}
            placeholder={t("personalization.globalPlaceholder", {
              defaultValue:
                "Enter global rules here, e.g. role definition, output style, coding conventions...",
            })}
            spellCheck={false}
            value={content}
          />
          <div className="role-editor-footer">
            <small>
              {t("personalization.globalHint", {
                defaultValue: "Changes take effect in the next conversation.",
              })}
            </small>
          </div>
        </>
      )}
    </section>
  );
};
