import { Info, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";
import type { SchemeDraft } from "./types";

/**
 * 请求头值支持的内置变量：全部是「当前会话 ID」的等价写法，
 * 与 native/src/api/common.rs 的 SESSION_ID_PLACEHOLDER_TOKENS 保持一致。
 * 可单独使用，也可与其它文本组合（如 `snow-app-{{session_id}}`）。
 */
const SESSION_ID_VARIABLES = [
  "{{session_id}}",
  "{{sessionId}}",
  "{{conversation_id}}",
  "{{conversationId}}",
  "${session_id}",
  "${conversation_id}",
] as const;

type CustomHeadersEditorProps = {
  draft: SchemeDraft;
  isBusy: boolean;
  isSaving: boolean;
  onNameChange: (name: string) => void;
  onUpdateHeaderPair: (
    pairId: string,
    field: "key" | "value",
    value: string,
  ) => void;
  onAddHeaderPair: () => void;
  onRemoveHeaderPair: (pairId: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function CustomHeadersEditor({
  draft,
  isBusy,
  isSaving,
  onNameChange,
  onUpdateHeaderPair,
  onAddHeaderPair,
  onRemoveHeaderPair,
  onCancel,
  onSave,
}: CustomHeadersEditorProps): React.JSX.Element {
  const { t } = useI18n();
  const [lastFocusedPairId, setLastFocusedPairId] = useState<string | null>(
    null,
  );
  const valueInputsRef = useRef(new Map<string, HTMLInputElement>());

  // 变量插入目标：优先最近聚焦的请求头值输入框，没有则第一行。
  const insertTarget =
    draft.headers.find((pair) => pair.id === lastFocusedPairId) ??
    draft.headers[0];

  const insertVariable = (token: string) => {
    if (!insertTarget) return;

    const input = valueInputsRef.current.get(insertTarget.id) ?? null;
    const start = input?.selectionStart ?? insertTarget.value.length;
    const end = input?.selectionEnd ?? insertTarget.value.length;
    const nextValue = `${insertTarget.value.slice(0, start)}${token}${insertTarget.value.slice(end)}`;
    onUpdateHeaderPair(insertTarget.id, "value", nextValue);

    // 插入后把光标移到变量之后，便于继续输入。
    if (input) {
      window.requestAnimationFrame(() => {
        input.focus();
        const caret = start + token.length;
        input.setSelectionRange(caret, caret);
      });
    }
  };

  return (
    <>
      <div className="api-settings-form-grid">
        <label className="api-settings-field wide">
          <span>
            {t("settings.customHeadersSchemeName", {
              defaultValue: "Scheme name",
            })}
          </span>
          <input
            value={draft.name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={t("settings.customHeadersNamePlaceholder", {
              defaultValue: "e.g. OpenAI headers",
            })}
            disabled={isBusy}
          />
        </label>
      </div>

      <div className="custom-headers-editor-list">
        {draft.headers.map((pair) => (
          <div className="custom-headers-editor-row" key={pair.id}>
            <label className="api-settings-field">
              <span>
                {t("settings.customHeadersHeaderName", {
                  defaultValue: "Header name",
                })}
              </span>
              <input
                value={pair.key}
                onChange={(event) =>
                  onUpdateHeaderPair(pair.id, "key", event.target.value)
                }
                placeholder={t("settings.customHeadersHeaderNamePlaceholder", {
                  defaultValue: "e.g. X-Request-ID",
                })}
                disabled={isBusy}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.customHeadersHeaderValue", {
                  defaultValue: "Header value",
                })}
              </span>
              <input
                ref={(element) => {
                  if (element) {
                    valueInputsRef.current.set(pair.id, element);
                  } else {
                    valueInputsRef.current.delete(pair.id);
                  }
                }}
                value={pair.value}
                onChange={(event) =>
                  onUpdateHeaderPair(pair.id, "value", event.target.value)
                }
                onFocus={() => setLastFocusedPairId(pair.id)}
                placeholder={t("settings.customHeadersHeaderValuePlaceholder", {
                  defaultValue: "Header value",
                })}
                disabled={isBusy}
              />
            </label>
            <button
              className="icon-btn ghost danger custom-headers-remove-btn"
              onClick={() => onRemoveHeaderPair(pair.id)}
              type="button"
              aria-label={t("settings.customHeadersRemoveHeader", {
                defaultValue: "Remove header",
              })}
              title={t("settings.customHeadersRemoveHeader", {
                defaultValue: "Remove header",
              })}
              disabled={isBusy}
            >
              <Trash2 size={14} strokeWidth={1.9} />
            </button>
          </div>
        ))}
      </div>

      <div className="custom-headers-variables">
        <span className="custom-headers-variables-icon" aria-hidden="true">
          <Info size={13} strokeWidth={1.9} />
        </span>
        <div className="custom-headers-variables-body">
          <span className="custom-headers-variables-label">
            {t("settings.customHeadersVariablesLabel", {
              defaultValue: "Available variables",
            })}
            <ApiSettingsHintIcon
              hint={t("settings.customHeadersVariablesHint", {
                defaultValue:
                  "All six spellings are equivalent: they are replaced with the session ID of the conversation that sends the request (they can be combined with other text, e.g. snow-app-{{session_id}}); requests without a session context (e.g. model listing) omit this header.",
              })}
            />
          </span>
          <div className="custom-headers-variables-chips">
            {SESSION_ID_VARIABLES.map((variable) => (
              <button
                className="custom-headers-variable-chip"
                disabled={isBusy || draft.headers.length === 0}
                key={variable}
                onClick={() => insertVariable(variable)}
                title={t("settings.customHeadersVariablesInsertTip", {
                  defaultValue: "Click to insert into the header value",
                })}
                type="button"
              >
                {variable}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

type CustomHeadersEditorActionsProps = {
  isBusy: boolean;
  isSaving: boolean;
  onAddHeaderPair: () => void;
  onCancel: () => void;
  onSave: () => void;
};

export function CustomHeadersEditorActions({
  isBusy,
  isSaving,
  onAddHeaderPair,
  onCancel,
  onSave,
}: CustomHeadersEditorActionsProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <button
        className="api-settings-form-btn secondary"
        onClick={onAddHeaderPair}
        type="button"
        disabled={isBusy}
      >
        <Plus size={15} />
        <span>
          {t("settings.customHeadersAddHeader", {
            defaultValue: "Add header",
          })}
        </span>
      </button>
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
        onClick={onSave}
        type="button"
        disabled={isBusy}
      >
        {isSaving ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <Save size={15} strokeWidth={1.9} />
        )}
        <span>
          {t("settings.saveCustomHeaders", {
            defaultValue: "Save scheme",
          })}
        </span>
      </button>
    </>
  );
}
