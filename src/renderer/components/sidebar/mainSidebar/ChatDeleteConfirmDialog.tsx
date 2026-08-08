import { ConfirmDialog } from "../../common/ConfirmDialog";
import { useI18n } from "../../../i18n";

type ChatDeleteConfirmDialogProps = {
  open: boolean;
  conversationCount: number;
  isBatch: boolean;
  imagesCount: number | null;
  deleteImages: boolean;
  onDeleteImagesChange: (deleteImages: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/** 单条与批量会话删除共用的确认弹窗。 */
export function ChatDeleteConfirmDialog({
  open,
  conversationCount,
  isBatch,
  imagesCount,
  deleteImages,
  onDeleteImagesChange,
  onConfirm,
  onCancel,
}: ChatDeleteConfirmDialogProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <ConfirmDialog
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      confirmLabel={t("sidebar.chatActionDelete", {
        defaultValue: "Delete",
      })}
      message={
        isBatch
          ? t("sidebar.chatMultiSelectDeleteConfirm", {
              defaultValue: "Delete {{count}} selected conversations?",
              values: { count: conversationCount },
            })
          : t("sidebar.chatDeleteConfirm", {
              defaultValue: "Are you sure you want to delete this conversation?",
            })
      }
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={t("sidebar.chatDeleteConfirmTitle", {
        defaultValue: "Confirm deletion",
      })}
      variant="danger"
    >
      {imagesCount !== null && imagesCount > 0 ? (
        <label className="chat-item-menu-delete-images">
          <input
            checked={deleteImages}
            onChange={(event) => onDeleteImagesChange(event.target.checked)}
            type="checkbox"
          />
          <span>
            {isBatch
              ? t("sidebar.chatDeleteImagesOptionBatch", {
                  defaultValue:
                    "Also delete the {{count}} image(s) generated in the selected conversations",
                  values: { count: imagesCount },
                })
              : t("sidebar.chatDeleteImagesOption", {
                  defaultValue:
                    "Also delete the {{count}} image(s) generated in this conversation",
                  values: { count: imagesCount },
                })}
          </span>
        </label>
      ) : null}
    </ConfirmDialog>
  );
}
