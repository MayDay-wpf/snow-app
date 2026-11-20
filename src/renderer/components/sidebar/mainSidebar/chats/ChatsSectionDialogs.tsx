import { useI18n } from "../../../../i18n";
import { ConfirmDialog } from "../../../common/ConfirmDialog";
import { ChatDeleteConfirmDialog } from "../ChatDeleteConfirmDialog";
import type { BatchDeleteProgress } from "./useConversationActions";

type ChatsSectionDialogsProps = {
  showBatchConfirm: boolean;
  isBatchDeleting: boolean;
  /** 批量删除的真实进度（null = 未在删除中） */
  batchDeleteProgress: BatchDeleteProgress | null;
  selectedCount: number;
  batchDeleteImages: boolean;
  batchDeleteMemories: boolean;
  batchImagesCount: number | null;
  batchMemoriesCount: number | null;
  onBatchImagesChange: (value: boolean) => void;
  onBatchMemoriesChange: (value: boolean) => void;
  onBatchCancel: () => void;
  onBatchConfirm: () => void;
  archivedDeleteTargetIds: string[] | null;
  isDeletingArchived: boolean;
  onArchivedDeleteCancel: () => void;
  onArchivedDeleteConfirm: () => void;
};

export function ChatsSectionDialogs({
  showBatchConfirm,
  isBatchDeleting,
  batchDeleteProgress,
  selectedCount,
  batchDeleteImages,
  batchDeleteMemories,
  batchImagesCount,
  batchMemoriesCount,
  onBatchImagesChange,
  onBatchMemoriesChange,
  onBatchCancel,
  onBatchConfirm,
  archivedDeleteTargetIds,
  isDeletingArchived,
  onArchivedDeleteCancel,
  onArchivedDeleteConfirm,
}: ChatsSectionDialogsProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <>
      {/* 单条与批量删除共用同一确认弹窗，并通过 portal 渲染到 body。 */}
      <ChatDeleteConfirmDialog
        conversationCount={selectedCount}
        deleteImages={batchDeleteImages}
        deleteMemories={batchDeleteMemories}
        imagesCount={batchImagesCount}
        memoriesCount={batchMemoriesCount}
        isBatch
        isConfirming={isBatchDeleting}
        progress={batchDeleteProgress}
        onCancel={onBatchCancel}
        onConfirm={onBatchConfirm}
        onDeleteImagesChange={onBatchImagesChange}
        onDeleteMemoriesChange={onBatchMemoriesChange}
        open={showBatchConfirm}
      />
      {/* 归档会话永久删除确认（归档数据不可恢复） */}
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("sidebar.chatActionDelete", {
          defaultValue: "Delete",
        })}
        isConfirming={isDeletingArchived}
        message={
          (archivedDeleteTargetIds?.length ?? 0) > 1
            ? t("sidebar.archivedChatMultiSelectDeleteConfirm", {
                defaultValue:
                  "Permanently delete {{count}} selected archived conversations?",
                values: { count: archivedDeleteTargetIds?.length ?? 0 },
              })
            : t("sidebar.archivedChatDeleteConfirm", {
                defaultValue: "Permanently delete this archived conversation?",
              })
        }
        onCancel={onArchivedDeleteCancel}
        onConfirm={onArchivedDeleteConfirm}
        open={archivedDeleteTargetIds !== null}
        title={t("sidebar.chatDeleteConfirmTitle", {
          defaultValue: "Confirm deletion",
        })}
        variant="danger"
      />
    </>
  );
}
