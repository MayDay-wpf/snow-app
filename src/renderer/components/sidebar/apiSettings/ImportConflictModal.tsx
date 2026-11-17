import { AlertTriangle, Copy, X } from "lucide-react";
import { useI18n } from "../../../i18n";
import { Modal } from "../../common/Modal";

/** 冲突确认弹窗中最多直接列出的同名项数量。 */
const MAX_LISTED_CONFLICTS = 8;

type ImportConflictModalProps = {
  open: boolean;
  totalCount: number;
  conflictNames: string[];
  isBusy: boolean;
  title?: string;
  description?: string;
  onCancel: () => void;
  onOverwrite: () => void;
  onDuplicate: () => void;
};

/** 导入文件存在同名项时的处理方式确认（覆盖 / 另存副本）。 */
export function ImportConflictModal({
  open,
  totalCount,
  conflictNames,
  isBusy,
  title,
  description,
  onCancel,
  onOverwrite,
  onDuplicate,
}: ImportConflictModalProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Modal
      open={open}
      title={
        title ??
        t("settings.modelTransferImportTitle", {
          defaultValue: "Import configs",
        })
      }
      description={(
        description ??
        t("settings.modelTransferImportInfo", {
          defaultValue:
            "{count} item(s) in the file, {conflict} share a name with an existing item.",
        })
      )
        .replace("{count}", String(totalCount))
        .replace("{conflict}", String(conflictNames.length))}
      closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
      onClose={onCancel}
      closeDisabled={isBusy}
      footer={
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
            className="api-settings-form-btn secondary"
            onClick={onDuplicate}
            type="button"
            disabled={isBusy}
          >
            <Copy size={15} strokeWidth={1.9} />
            <span>
              {t("settings.apiImportDuplicate", {
                defaultValue: "Keep both as copies",
              })}
            </span>
          </button>
          <button
            className="api-settings-form-btn primary"
            onClick={onOverwrite}
            type="button"
            disabled={isBusy}
          >
            <AlertTriangle size={15} strokeWidth={1.9} />
            <span>
              {t("settings.apiImportOverwrite", {
                defaultValue: "Overwrite existing",
              })}
            </span>
          </button>
        </>
      }
    >
      <div className="api-settings-import-conflict">
        <span>
          {t("settings.apiImportConflictHint", {
            defaultValue: "Choose how to handle the duplicated names:",
          })}
        </span>
        <ul>
          {conflictNames.slice(0, MAX_LISTED_CONFLICTS).map((name, index) => (
            <li key={`${name}-${index}`}>{name}</li>
          ))}
          {conflictNames.length > MAX_LISTED_CONFLICTS && (
            <li>+{conflictNames.length - MAX_LISTED_CONFLICTS}</li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
