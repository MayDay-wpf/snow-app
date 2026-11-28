import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type {
  ChatConversationRecord,
  ConversationDeleteProgress,
} from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import {
  resolveBatchDeleteProgress,
  useBatchDeleteProgress,
} from "./useConversationActions";

const ARCHIVE_PAGE_SIZE = 20;

/** 待确认的永久删除：单条/所选会话，或一键删除当前列表范围
 *  （有搜索关键词时只包含匹配项，与列表展示的范围一致）。 */
export type ArchivedDeleteTarget =
  | { mode: "selected"; ids: string[] }
  | { mode: "all"; count: number; keyword: string };

type UseArchivedConversationsOptions = {
  directoryId: string;
  isCollapsed: boolean;
  sectionListRef: RefObject<HTMLDivElement | null>;
  refreshConversations: () => void;
  onExitChatMultiSelect: () => void;
};

export function useArchivedConversations({
  directoryId,
  isCollapsed,
  sectionListRef,
  refreshConversations,
  onExitChatMultiSelect,
}: UseArchivedConversationsOptions) {
  const { t } = useI18n();
  // 归档模式：true 时侧边栏展示归档会话列表（还原后才能继续使用）
  const [isArchiveMode, setIsArchiveMode] = useState(false);
  const [archivedConversations, setArchivedConversations] = useState<
    ChatConversationRecord[]
  >([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [isArchivedLoading, setIsArchivedLoading] = useState(false);
  const [isArchivedLoadingMore, setIsArchivedLoadingMore] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [archivedSelectedIds, setArchivedSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isArchivedMultiSelect, setIsArchivedMultiSelect] = useState(false);
  // 归档会话永久删除确认：待删除目标（null = 未打开）
  const [archivedDeleteTarget, setArchivedDeleteTarget] =
    useState<ArchivedDeleteTarget | null>(null);
  const {
    progress: archivedDeleteProgress,
    applyProgress: applyArchivedDeleteProgress,
    startProgress: startArchivedDeleteProgress,
    stopProgress: stopArchivedDeleteProgress,
  } = useBatchDeleteProgress();
  const [restoringIds, setRestoringIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingArchivedIds, setDeletingArchivedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const archivedLoadMoreRef = useRef<HTMLDivElement | null>(null);
  // 搜索输入（即时）与生效关键词（防抖后）
  const [archivedSearchInput, setArchivedSearchInput] = useState("");
  const [archivedKeyword, setArchivedKeyword] = useState("");
  // 请求序号：快速输入时丢弃过期响应，避免旧结果覆盖新结果
  const archivedRequestIdRef = useRef(0);

  const loadArchivedFirstPage = useCallback(async (): Promise<void> => {
    if (!directoryId) {
      archivedRequestIdRef.current += 1;
      setArchivedConversations([]);
      setArchivedTotal(0);
      return;
    }

    const requestId = archivedRequestIdRef.current + 1;
    archivedRequestIdRef.current = requestId;
    setIsArchivedLoading(true);
    setArchivedError(null);

    try {
      const result = await window.snow.listArchivedConversationsPaginated(
        directoryId,
        ARCHIVE_PAGE_SIZE,
        0,
        archivedKeyword,
      );
      if (archivedRequestIdRef.current !== requestId) {
        return;
      }
      setArchivedConversations(result.items);
      setArchivedTotal(result.total);
    } catch (err) {
      if (archivedRequestIdRef.current !== requestId) {
        return;
      }
      setArchivedError(
        err instanceof Error
          ? err.message
          : t("sidebar.loadChatsError", {
              defaultValue: "Failed to load chats",
            }),
      );
    } finally {
      if (archivedRequestIdRef.current === requestId) {
        setIsArchivedLoading(false);
      }
    }
  }, [archivedKeyword, directoryId, t]);

  // 搜索防抖：输入停顿后再查询归档库
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setArchivedKeyword(archivedSearchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [archivedSearchInput]);

  // 切换项目时重置归档搜索
  useEffect(() => {
    setArchivedSearchInput("");
    setArchivedKeyword("");
  }, [directoryId]);

  // 进入归档模式或切换项目/关键词时加载归档列表第一页
  useEffect(() => {
    if (!isArchiveMode) {
      return;
    }
    void loadArchivedFirstPage();
  }, [isArchiveMode, loadArchivedFirstPage]);

  const hasMoreArchived = archivedConversations.length < archivedTotal;

  const loadArchivedMore = useCallback(async (): Promise<void> => {
    if (
      isArchivedLoadingMore ||
      !hasMoreArchived ||
      !directoryId ||
      isArchivedLoading
    ) {
      return;
    }

    const requestId = archivedRequestIdRef.current;
    setIsArchivedLoadingMore(true);

    try {
      const result = await window.snow.listArchivedConversationsPaginated(
        directoryId,
        ARCHIVE_PAGE_SIZE,
        archivedConversations.length,
        archivedKeyword,
      );
      if (archivedRequestIdRef.current !== requestId) {
        return;
      }
      setArchivedConversations((prev) => [...prev, ...result.items]);
      setArchivedTotal(result.total);
    } catch {
      // Silent fail for pagination
    } finally {
      setIsArchivedLoadingMore(false);
    }
  }, [
    archivedConversations.length,
    archivedKeyword,
    directoryId,
    hasMoreArchived,
    isArchivedLoading,
    isArchivedLoadingMore,
  ]);

  // 归档列表无限滚动
  useEffect(() => {
    if (
      !isArchiveMode ||
      !hasMoreArchived ||
      isArchivedLoading ||
      isCollapsed
    ) {
      return;
    }

    const sentinel = archivedLoadMoreRef.current;

    if (!sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadArchivedMore();
        }
      },
      {
        root: sectionListRef.current,
        rootMargin: "0px 0px 64px",
        threshold: 0.1,
      },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [
    isArchiveMode,
    hasMoreArchived,
    isArchivedLoading,
    isCollapsed,
    loadArchivedMore,
    sectionListRef,
  ]);

  const handleExitArchivedMultiSelect = useCallback((): void => {
    if (deletingArchivedIds.size > 0 || restoringIds.size > 0) {
      return;
    }
    setIsArchivedMultiSelect(false);
    setArchivedSelectedIds(new Set());
  }, [deletingArchivedIds.size, restoringIds.size]);

  /** 切换会话区/归档区视图：切换后主动重拉目标视图的列表，
   *  避免还原/归档操作后出现列表数据滞后（还原的会话不可见） */
  const toggleArchiveMode = (): void => {
    if (isArchiveMode) {
      // 退出归档视图：回到普通会话列表并全量重拉
      setIsArchiveMode(false);
      handleExitArchivedMultiSelect();
      refreshConversations();
    } else {
      // 进入归档视图：退出普通多选模式，避免状态交叉；清空上次搜索
      onExitChatMultiSelect();
      setArchivedSearchInput("");
      setArchivedKeyword("");
      setIsArchiveMode(true);
      void loadArchivedFirstPage();
    }
  };

  /** 还原单个归档会话 */
  const handleRestore = async (
    conversation: ChatConversationRecord,
  ): Promise<void> => {
    if (restoringIds.size > 0) {
      return;
    }
    const restoreId = conversation.conversationId;
    setRestoringIds(new Set([restoreId]));
    setArchivedConversations((previous) =>
      previous.filter((item) => item.conversationId !== restoreId),
    );
    setArchivedTotal((total) => Math.max(0, total - 1));
    try {
      await window.snow.restoreArchivedConversations([restoreId]);
      await Promise.all([loadArchivedFirstPage(), refreshConversations()]);
    } catch {
      // Silent fail
      await loadArchivedFirstPage();
    } finally {
      setRestoringIds(new Set());
    }
  };

  /** 批量还原所选归档会话 */
  const handleBatchRestore = async (): Promise<void> => {
    if (restoringIds.size > 0 || archivedSelectedIds.size === 0) {
      return;
    }

    const restoreIds = [...archivedSelectedIds];
    setRestoringIds(new Set(restoreIds));
    const restoreIdSet = new Set(restoreIds);
    setArchivedConversations((previous) =>
      previous.filter((item) => !restoreIdSet.has(item.conversationId)),
    );
    setArchivedTotal((total) => Math.max(0, total - restoreIds.length));
    try {
      await window.snow.restoreArchivedConversations(restoreIds);
      await Promise.all([loadArchivedFirstPage(), refreshConversations()]);
      setArchivedSelectedIds(new Set());
      setIsArchivedMultiSelect(false);
    } catch {
      // Silent fail
      await loadArchivedFirstPage();
    } finally {
      setRestoringIds(new Set());
    }
  };

  const handleDeleteArchived = (conversation: ChatConversationRecord): void => {
    setArchivedDeleteTarget({
      mode: "selected",
      ids: [conversation.conversationId],
    });
  };

  /** 批量永久删除所选归档会话（弹出确认框） */
  const handleBatchDeleteArchived = (): void => {
    if (archivedSelectedIds.size === 0) {
      return;
    }
    setArchivedDeleteTarget({ mode: "selected", ids: [...archivedSelectedIds] });
  };

  /** 一键永久删除当前列表范围内的全部归档会话（弹出确认框） */
  const handleDeleteAllArchived = (): void => {
    if (archivedTotal === 0) {
      return;
    }
    setArchivedDeleteTarget({
      mode: "all",
      count: archivedTotal,
      keyword: archivedKeyword,
    });
  };

  /** 确认永久删除归档会话：确认弹窗内展示后端推送的真实进度 */
  const handleArchivedDeleteConfirm = async (): Promise<void> => {
    if (deletingArchivedIds.size > 0 || !archivedDeleteTarget) {
      return;
    }

    const target = archivedDeleteTarget;
    setDeletingArchivedIds(
      new Set(
        target.mode === "all"
          ? archivedConversations.map((conv) => conv.conversationId)
          : target.ids,
      ),
    );
    startArchivedDeleteProgress();
    const onProgress = (progress: ConversationDeleteProgress): void =>
      applyArchivedDeleteProgress(resolveBatchDeleteProgress(progress, false));

    try {
      if (target.mode === "all") {
        await window.snow.deleteAllArchivedConversations(
          directoryId,
          target.keyword,
          onProgress,
        );
      } else {
        await window.snow.deleteArchivedConversations(target.ids, onProgress);
      }
      await loadArchivedFirstPage();
      setArchivedSelectedIds(new Set());
      setIsArchivedMultiSelect(false);
    } catch {
      // Silent fail
    } finally {
      // 删除完成（含 VACUUM 收缩文件）后才关闭确认弹窗，期间显示进度
      stopArchivedDeleteProgress();
      setDeletingArchivedIds(new Set());
      setArchivedDeleteTarget(null);
    }
  };

  const handleArchivedToggleSelect = (conversationId: string): void => {
    setArchivedSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  const handleArchivedSelectAll = (): void => {
    setArchivedSelectedIds(
      new Set(archivedConversations.map((conv) => conv.conversationId)),
    );
  };

  const handleArchivedDeselectAll = (): void => {
    setArchivedSelectedIds(new Set());
  };

  const enterArchivedMultiSelect = (): void => {
    setArchivedSelectedIds(new Set());
    setIsArchivedMultiSelect(true);
  };

  return {
    isArchiveMode,
    archivedConversations,
    archivedTotal,
    archivedSearchInput,
    setArchivedSearchInput,
    archivedKeyword,
    isArchivedLoading,
    isArchivedLoadingMore,
    archivedError,
    archivedSelectedIds,
    isArchivedMultiSelect,
    archivedDeleteTarget,
    setArchivedDeleteTarget,
    archivedDeleteProgress,
    restoringIds,
    deletingArchivedIds,
    archivedLoadMoreRef,
    hasMoreArchived,
    loadArchivedFirstPage,
    toggleArchiveMode,
    handleRestore,
    handleBatchRestore,
    handleDeleteArchived,
    handleBatchDeleteArchived,
    handleDeleteAllArchived,
    handleArchivedDeleteConfirm,
    handleExitArchivedMultiSelect,
    enterArchivedMultiSelect,
    handleArchivedToggleSelect,
    handleArchivedSelectAll,
    handleArchivedDeselectAll,
  };
}
