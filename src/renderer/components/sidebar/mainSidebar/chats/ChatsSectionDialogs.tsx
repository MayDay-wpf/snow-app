import { useI18n } from "../../../../i18n";
import { ChatDeleteConfirmDialog } from "../ChatDeleteConfirmDialog";
import type { ArchivedDeleteTarget } from "./useArchivedConversations";
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
  archivedDeleteTarget: ArchivedDeleteTarget | null;
  /** 归档永久删除的真实进度（null = 未在删除中） */
  archivedDeleteProgress: BatchDeleteProgress | null;
  isDeletingArchived: boolean;
  onArchivedDeleteCancel: () => void;
  onArchivedDeleteConfirm: () => void;
};

const noopBoolean = (): void => {};

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
  archivedDeleteTarget,
  archivedDeleteProgress,
  isDeletingArchived,
  onArchivedDeleteCancel,
  onArchivedDeleteConfirm,
}: ChatsSectionDialogsProps): React.JSX.Element {
  const { t } = useI18n();

  const archivedDeleteCount = !archivedDeleteTarget
    ? 0
    : archivedDeleteTarget.mode === "all"
      ? archivedDeleteTarget.count
      : archivedDeleteTarget.ids.length;
  const archivedDeleteMessage = !archivedDeleteTarget
    ? ""
    : archivedDeleteTarget.mode === "all"
      ? archivedDeleteTarget.keyword
        ? t("sidebar.archivedChatDeleteMatchedConfirm", {
            defaultValue:
              'Permanently delete all {{count}} archived conversations matching "{{keyword}}"? This cannot be undone.',
            values: {
              count: archivedDeleteCount,
              keyword: archivedDeleteTarget.keyword,
            },
          })
        : t("sidebar.archivedChatDeleteAllConfirm", {
            defaultValue:
              "Permanently delete all {{count}} archived conversations in this project? This cannot be undone.",
            values: { count: archivedDeleteCount },
          })
      : archivedDeleteCount > 1
        ? t("sidebar.archivedChatMultiSelectDeleteConfirm", {
            defaultValue:
              "Permanently delete {{count}} selected archived conversations?",
            values: { count: archivedDeleteCount },
          })
        : t("sidebar.archivedChatDeleteConfirm", {
            defaultValue: "Permanently delete this archived conversation?",
          });

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
      {/* 归档会话永久删除确认（归档数据不可恢复），删除期间展示真实进度 */}
      <ChatDeleteConfirmDialog
        conversationCount={archivedDeleteCount}
        deleteImages={false}
        deleteMemories={false}
        imagesCount={null}
        memoriesCount={null}
        isBatch={archivedDeleteCount > 1}
        isConfirming={isDeletingArchived}
        message={archivedDeleteMessage}
        progress={archivedDeleteProgress}
        onCancel={onArchivedDeleteCancel}
        onConfirm={onArchivedDeleteConfirm}
        onDeleteImagesChange={noopBoolean}
        onDeleteMemoriesChange={noopBoolean}
        open={archivedDeleteTarget !== null}
      />
    </>
  );
}
