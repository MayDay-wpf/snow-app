import { removeConversationTrees } from "../../../mainContent/chatMessages/hooks/conversationMessageBridge";
import { useCallback, useRef, useState } from "react";

import type {
  ChatConversationRecord,
  ConversationDeleteProgress,
} from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import type { ExportFormat } from "../ChatItemMenu";

type UseConversationActionsOptions = {
  activeConversationId: string | undefined;
  selectedIds: Set<string>;
  resetMultiSelect: () => void;
  collectConversationTreeIds: (conversationId: string) => string[];
  refreshConversations: () => void;
  updateConversationSummary: (conversationId: string, summary: string) => void;
  abortConversation: (conversationId: string) => void;
  clearInputDraft: (conversationId: string) => void;
  handleNewChat: () => void;
  handleForkConversation: (
    conversationId: string,
    messageId: string,
  ) => Promise<void> | void;
  setConversations: (
    updater: (prev: ChatConversationRecord[]) => ChatConversationRecord[],
  ) => void;
};

/** 批量删除的展示进度：percent 由后端真实计数换算，不是定时动画。 */
export type BatchDeleteProgress = {
  phase: "prepare" | "images" | "delete" | "cleanup";
  done: number;
  total: number;
  percent: number;
};

/** 准备阶段占 0-5%；图库图片占 5-25%；会话数据与附件清理占剩余区间。 */
const PREPARE_STAGE_END = 5;
const IMAGE_STAGE_END = 25;

const scalePercent = (
  done: number,
  total: number,
  from: number,
  to: number,
): number => {
  if (total <= 0) {
    return from;
  }
  const ratio = Math.min(1, Math.max(0, done / total));
  return from + (to - from) * ratio;
};

/** 把后端阶段进度换算成 0-100 的总进度。 */
const resolveBatchDeleteProgress = (
  progress: ConversationDeleteProgress,
  hasImageStage: boolean,
): BatchDeleteProgress => {
  const dataStart = hasImageStage ? IMAGE_STAGE_END : PREPARE_STAGE_END;
  if (progress.phase === "images") {
    return {
      phase: "images",
      done: progress.done,
      total: progress.total,
      percent: scalePercent(
        progress.done,
        progress.total,
        PREPARE_STAGE_END,
        IMAGE_STAGE_END,
      ),
    };
  }
  if (progress.phase === "delete" || progress.phase === "cleanup") {
    return {
      phase: progress.phase,
      done: progress.done,
      total: progress.total,
      percent: scalePercent(progress.done, progress.total, dataStart, 100),
    };
  }
  return {
    phase: "prepare",
    done: progress.done,
    total: progress.total,
    percent: scalePercent(progress.done, progress.total, 0, PREPARE_STAGE_END),
  };
};

export function useConversationActions({
  activeConversationId,
  selectedIds,
  resetMultiSelect,
  collectConversationTreeIds,
  refreshConversations,
  updateConversationSummary,
  abortConversation,
  clearInputDraft,
  handleNewChat,
  handleForkConversation,
  setConversations,
}: UseConversationActionsOptions) {
  const { t } = useI18n();
  // 活动会话 id 的实时镜像：删除/归档要判断"是否正在打开被删会话"，但把它
  // 放进 useCallback 依赖会让这两个回调在每次切换会话时换引用，从而让整张
  // 会话列表的 memo 全部失效（每次切换重渲染所有行）。
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [archivingIds, setArchivingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [batchDeleteProgress, setBatchDeleteProgress] =
    useState<BatchDeleteProgress | null>(null);
  // 节流：进度条只在整数百分比或阶段变化时重渲染。
  const lastProgressRef = useRef<{ phase: string; percent: number } | null>(
    null,
  );
  // 删除结束后可能有残留的进度事件在途：用活动标记丢弃它们。
  const batchDeleteActiveRef = useRef(false);
  const applyBatchDeleteProgress = useCallback(
    (next: BatchDeleteProgress): void => {
      if (!batchDeleteActiveRef.current) {
        return;
      }
      const last = lastProgressRef.current;
      if (
        last &&
        last.phase === next.phase &&
        Math.floor(last.percent) === Math.floor(next.percent)
      ) {
        return;
      }
      lastProgressRef.current = { phase: next.phase, percent: next.percent };
      setBatchDeleteProgress((prev) => ({
        ...next,
        // total 在阶段内可能扩大（例如附件清理），进度条不应回退。
        percent: prev ? Math.max(prev.percent, next.percent) : next.percent,
      }));
    },
    [],
  );
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [batchImagesCount, setBatchImagesCount] = useState<number | null>(null);
  const [batchDeleteImages, setBatchDeleteImages] = useState(false);
  const [batchMemoriesCount, setBatchMemoriesCount] = useState<number | null>(
    null,
  );
  const [batchDeleteMemories, setBatchDeleteMemories] = useState(false);

  const handlePin = useCallback(
    async (conversation: ChatConversationRecord): Promise<void> => {
      try {
        await window.snow.updateConversationStatus(
          conversation.conversationId,
          "pin",
        );
        refreshConversations();
      } catch {
        // Silent fail
      }
    },
    [refreshConversations],
  );

  /** 取消置顶：状态改回 active，会话回到普通时间分组 */
  const handleUnpin = useCallback(
    async (conversation: ChatConversationRecord): Promise<void> => {
      try {
        await window.snow.updateConversationStatus(
          conversation.conversationId,
          "active",
        );
        refreshConversations();
      } catch {
        // Silent fail
      }
    },
    [refreshConversations],
  );

  const handleRename = useCallback(
    async (
      conversation: ChatConversationRecord,
      newTitle: string,
    ): Promise<void> => {
      await window.snow.renameConversation(
        conversation.conversationId,
        newTitle,
      );
      // 同步更新内存中 session 的 summary，让 TopBar 标题即时刷新
      updateConversationSummary(conversation.conversationId, newTitle);
      refreshConversations();
    },
    [refreshConversations, updateConversationSummary],
  );

  const handleDelete = useCallback(
    async (
      conversation: ChatConversationRecord,
      deleteImages: boolean,
      deleteMemories: boolean,
    ): Promise<void> => {
      if (deletingIds.size > 0) {
        return;
      }
      setDeletingIds(new Set([conversation.conversationId]));
      try {
        await removeConversationTrees(
          [conversation.conversationId],
          async () => {
            if (deleteImages)
              await window.snow.deleteConversationImages([
                conversation.conversationId,
              ]);
            await window.snow.deleteConversation(
              conversation.conversationId,
              deleteMemories,
            );
          },
          { skipPinned: false },
        );
        refreshConversations();
      } catch {
        // 失败时不从列表移除该会话，保留可重试的真实状态。
        refreshConversations();
      } finally {
        setDeletingIds(new Set());
      }
    },
    [
      abortConversation,
      clearInputDraft,
      collectConversationTreeIds,
      deletingIds,
      handleNewChat,
      refreshConversations,
    ],
  );

  /** 归档单个会话：中止相关流、清理草稿，若正在打开则新建会话 */
  const handleArchive = useCallback(
    async (conversation: ChatConversationRecord): Promise<void> => {
      if (archivingIds.size > 0) {
        return;
      }
      const archiveId = conversation.conversationId;
      setArchivingIds(new Set([archiveId]));
      try {
        await removeConversationTrees(
          [archiveId],
          () => window.snow.archiveConversations([archiveId]),
          { skipPinned: true },
        );
        refreshConversations();
      } catch {
        // 失败时不从列表移除该会话，保留可重试的真实状态。
        refreshConversations();
      } finally {
        setArchivingIds(new Set());
      }
    },
    [
      abortConversation,
      archivingIds,
      clearInputDraft,
      collectConversationTreeIds,
      handleNewChat,
      refreshConversations,
    ],
  );

  const handleExport = useCallback(
    async (
      conversation: ChatConversationRecord,
      format: ExportFormat,
    ): Promise<void> => {
      const fileName =
        conversation.summary ||
        conversation.title ||
        t("sidebar.untitledChat", { defaultValue: "Untitled" });
      await window.snow.exportConversation(
        conversation.conversationId,
        format,
        fileName,
      );
    },
    [t],
  );

  /** 从侧边栏直接创建分支（复制整个会话），无需先打开会话 */
  const handleFork = useCallback(
    (conversation: ChatConversationRecord): void => {
      void handleForkConversation(conversation.conversationId, "");
    },
    [handleForkConversation],
  );

  // 打开批量删除确认框：查询所选会话引用的图库图片数
  const handleOpenBatchConfirm = (): void => {
    setShowBatchConfirm(true);
    setBatchImagesCount(null);
    setBatchDeleteImages(false);
    // 同时查询所选会话保存的项目记忆数（>0 才显示「同时删除记忆」选项）
    setBatchMemoriesCount(null);
    setBatchDeleteMemories(false);
    if (selectedIds.size > 0) {
      void window.snow
        .countConversationImages([...selectedIds])
        .then((count) => setBatchImagesCount(count))
        .catch(() => setBatchImagesCount(0));
      void window.snow
        .countProjectMemoriesByConversations([...selectedIds])
        .then((count) => setBatchMemoriesCount(count))
        .catch(() => setBatchMemoriesCount(0));
    }
  };

  const handleBatchDelete = async (): Promise<void> => {
    if (isBatchDeleting || selectedIds.size === 0) {
      return;
    }

    const targetIds = [...selectedIds];
    // 图库图片先删，占进度条的 5%-25% 区间；会话数据与附件清理占剩余区间。
    const hasImageStage = batchDeleteImages && (batchImagesCount ?? 0) > 0;

    setIsBatchDeleting(true);
    setDeletingIds(new Set(targetIds));
    lastProgressRef.current = null;
    batchDeleteActiveRef.current = true;
    setBatchDeleteProgress({ phase: "prepare", done: 0, total: 0, percent: 0 });

    try {
      await removeConversationTrees(
        targetIds,
        async () => {
          if (hasImageStage) {
            await window.snow.deleteConversationImages(targetIds, (progress) =>
              applyBatchDeleteProgress(
                resolveBatchDeleteProgress(progress, hasImageStage),
              ),
            );
          }
          await window.snow.deleteConversations(
            targetIds,
            batchDeleteMemories,
            (progress) =>
              applyBatchDeleteProgress(
                resolveBatchDeleteProgress(progress, hasImageStage),
              ),
          );
        },
        {
          skipPinned: false,
          onPrepareProgress: (done, total) =>
            applyBatchDeleteProgress({
              phase: "prepare",
              done,
              total,
              percent: scalePercent(done, total, 0, PREPARE_STAGE_END),
            }),
        },
      );
      refreshConversations();
      resetMultiSelect();
    } catch {
      // 失败时保留列表条目与真实状态，由用户重新发起。
      refreshConversations();
    } finally {
      // 删除完成后才关闭确认弹窗，期间显示真实进度
      batchDeleteActiveRef.current = false;
      setIsBatchDeleting(false);
      setShowBatchConfirm(false);
      setBatchDeleteProgress(null);
      setDeletingIds(new Set());
      lastProgressRef.current = null;
    }
  };

  /** 批量归档所选会话（置顶会话由 Rust 侧跳过，不参与归档） */
  const handleBatchArchive = async (): Promise<void> => {
    if (archivingIds.size > 0 || selectedIds.size === 0) {
      return;
    }

    setArchivingIds(new Set(selectedIds));
    try {
      await removeConversationTrees(
        [...selectedIds],
        () => window.snow.archiveConversations([...selectedIds]),
        { skipPinned: true },
      );
      refreshConversations();
      resetMultiSelect();
    } catch {
      // 失败时保留列表条目与真实状态，由用户重新发起。
      refreshConversations();
    } finally {
      setArchivingIds(new Set());
    }
  };

  const isActionLocked = isBatchDeleting || archivingIds.size > 0;

  return {
    deletingIds,
    archivingIds,
    isBatchDeleting,
    /** 批量删除的真实进度（null = 未在删除中） */
    batchDeleteProgress,
    showBatchConfirm,
    setShowBatchConfirm,
    batchImagesCount,
    batchDeleteImages,
    setBatchDeleteImages,
    batchMemoriesCount,
    batchDeleteMemories,
    setBatchDeleteMemories,
    isActionLocked,
    handlePin,
    handleUnpin,
    handleRename,
    handleDelete,
    handleArchive,
    handleExport,
    handleFork,
    handleOpenBatchConfirm,
    handleBatchDelete,
    handleBatchArchive,
  };
}
