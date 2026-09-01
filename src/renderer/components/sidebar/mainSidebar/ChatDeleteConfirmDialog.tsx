import { ConfirmDialog } from "../../common/ConfirmDialog";
import { useI18n } from "../../../i18n";

type ChatDeleteConfirmDialogProps = {
  open: boolean;
  conversationCount: number;
  isBatch: boolean;
  imagesCount: number | null;
  deleteImages: boolean;
  onDeleteImagesChange: (deleteImages: boolean) => void;
  /** 这些会话保存的项目记忆条数（null = 未查询到/不可用） */
  memoriesCount: number | null;
  /** 用户是否选择连带删除记忆（默认不勾选 = 保留记忆） */
  deleteMemories: boolean;
  onDeleteMemoriesChange: (deleteMemories: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** 删除进行中：确认按钮显示 loading */
  isConfirming?: boolean;
};

/** 单条与批量会话删除共用的确认弹窗。 */
export function ChatDeleteConfirmDialog({
  open,
  conversationCount,
  isBatch,
  imagesCount,
  deleteImages,
  onDeleteImagesChange,
  memoriesCount,
  deleteMemories,
  onDeleteMemoriesChange,
  onConfirm,
  onCancel,
  isConfirming = false,
}: ChatDeleteConfirmDialogProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <ConfirmDialog
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      confirmLabel={t("sidebar.chatActionDelete", {
        defaultValue: "Delete",
      })}
      isConfirming={isConfirming}
      message={
        isBatch
          ? t("sidebar.chatMultiSelectDeleteConfirm", {
              defaultValue: "Delete {{count}} selected conversations?",
              values: { count: conversationCount },
            })
          : t("sidebar.chatDeleteConfirm", {
              defaultValue:
                "Are you sure you want to delete this conversation?",
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
            disabled={isConfirming}
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
      {memoriesCount !== null && memoriesCount > 0 ? (
        <label className="chat-item-menu-delete-images">
          <input
            checked={deleteMemories}
            disabled={isConfirming}
            onChange={(event) => onDeleteMemoriesChange(event.target.checked)}
            type="checkbox"
          />
          <span>
            {isBatch
              ? t("sidebar.chatDeleteMemoriesOptionBatch", {
                  defaultValue:
                    "Also delete the {{count}} project memories saved from the selected conversations",
                  values: { count: memoriesCount },
                })
              : t("sidebar.chatDeleteMemoriesOption", {
                  defaultValue:
                    "Also delete the {{count}} project memories saved from this conversation (uncheck to keep them in the project memory bank)",
                  values: { count: memoriesCount },
                })}
          </span>
        </label>
      ) : null}
    </ConfirmDialog>
  );
}
