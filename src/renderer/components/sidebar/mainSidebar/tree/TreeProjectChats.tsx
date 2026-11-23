import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";

import { ChevronRight, Loader2 } from "lucide-react";

import type { ChatConversationRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../../../mainContent/chatMessages";
import { isPendingSessionKey } from "../../../mainContent/chatMessages/utils/conversationTypes";
import { ChatDeleteConfirmDialog } from "../ChatDeleteConfirmDialog";
import { SidebarCollapse } from "../SidebarCollapse";
import {
  ChatConversationRow,
  EMPTY_CONVERSATION_LIST,
} from "../chats/ChatConversationRow";
import { ChatListFooter } from "../chats/ChatListFooter";
import {
  ChatMultiSelectBar,
  type ChatMultiSelectAction,
} from "../chats/ChatMultiSelectBar";
import { useChatConversationList } from "../chats/useChatConversationList";
import { useChatSelection } from "../chats/useChatSelection";
import { useConversationActions } from "../chats/useConversationActions";
import { useConversationCycleShortcut } from "../chats/useConversationCycleShortcut";
import { useConversationTree } from "../chats/useConversationTree";
import { useConversationWorktreeBindings } from "../chats/useConversationWorktreeBindings";
import { usePausedConversationIds } from "../chats/usePausedConversationIds";
import { usePinnedConversations } from "../chats/usePinnedConversations";
import { useSidebarOnlyRunningPinnedChats } from "../sidebarChatFilter";

type TreeProjectChatsProps = {
  directoryId: string;
  activeDirectoryId?: string;
  activeConversationId?: string;
  sectionListRef: RefObject<HTMLDivElement | null>;
};

export function TreeProjectChats({
  directoryId,
  activeDirectoryId,
  activeConversationId,
  sectionListRef,
}: TreeProjectChatsProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    conversationListVersion,
    conversationTreeVersion,
    upsertedConversation,
    pendingToRealConversationIdRef,
    subAgentSessionEvents,
    refreshConversations,
    updateConversationSummary,
    handleSelectConversation,
    handleForkConversation,
    handleNewChat,
    activeSessionKeyRef,
    abortConversation,
    streamingConversationIds,
    attentionRequiredConversationIds,
    completedConversationIds,
    clearInputDraft,
    // 会话内存态投影：内容指纹不变时引用稳定，列表不随后台会话逐帧重渲染。
    sessionsForList: sessions,
  } = useChatConversationContext();

  const runningConversationIds = useMemo(
    () =>
      new Set([
        ...streamingConversationIds,
        ...attentionRequiredConversationIds,
      ]),
    [streamingConversationIds, attentionRequiredConversationIds],
  );
  const pausedConversationIds = usePausedConversationIds(sessions);

  // 过滤模式下保留在主列表的会话：运行中、需关注与已完成待查看。
  const keptConversationIds = useMemo(
    () => new Set([...runningConversationIds, ...completedConversationIds]),
    [runningConversationIds, completedConversationIds],
  );

  const { onlyRunningPinned } = useSidebarOnlyRunningPinnedChats();
  // 过滤模式下历史会话收纳为「加载更多会话」，按项目独立展开
  const [isHistoryRevealed, setIsHistoryRevealed] = useState(false);

  useEffect(() => {
    if (!onlyRunningPinned) {
      setIsHistoryRevealed(false);
    }
  }, [onlyRunningPinned]);

  const list = useChatConversationList({
    directoryId,
    conversationListVersion,
    upsertedConversation,
    pendingToRealConversationIdRef,
    runningConversationIds,
    sessions,
    isCollapsed: false,
    infiniteScroll: false,
    sectionListRef,
  });

  const tree = useConversationTree({
    conversationsRef: list.conversationsRef,
    conversationIdsKey: list.conversationIdsKey,
    conversationListVersion,
    conversationTreeVersion,
    upsertedConversationTimestamp: upsertedConversation?.timestamp,
    subAgentSessionEvents,
    activeConversationId,
    attentionRequiredConversationIds,
    runningConversationIds,
  });

  const selection = useChatSelection({
    directoryId,
    conversations: list.conversations,
    // 历史分组收起时，全选只覆盖仍可见的会话
    getOrderedConversationIds: () =>
      (onlyRunningPinned && !isHistoryRevealed
        ? list.conversations.filter((conversation) =>
            keptConversationIds.has(conversation.conversationId),
          )
        : list.conversations
      ).map((conversation) => conversation.conversationId),
    runningConversationIds,
    surfacedConversationIds: tree.surfacedConversationIds,
  });

  // 树节点切换项目后仍挂载；只清理离开的节点，保留刚激活节点的点击锚点。
  useEffect(() => {
    if (activeDirectoryId !== directoryId) {
      selection.resetMultiSelect();
    }
  }, [activeDirectoryId, directoryId, selection.resetMultiSelect]);

  // 多选需要覆盖全部会话：进入多选时自动展开历史分组
  useEffect(() => {
    if (selection.isMultiSelectMode) {
      setIsHistoryRevealed(true);
    }
  }, [selection.isMultiSelectMode]);

  const actions = useConversationActions({
    activeConversationId,
    selectedIds: selection.selectedIds,
    resetMultiSelect: selection.resetMultiSelect,
    collectConversationTreeIds: tree.collectConversationTreeIds,
    refreshConversations,
    updateConversationSummary,
    abortConversation,
    clearInputDraft,
    handleNewChat,
    handleForkConversation,
    setConversations: list.setConversations,
  });

  const pinned = usePinnedConversations({
    directoryId,
    conversationListVersion,
    upsertedConversation,
  });

  // 只显示活动会话与置顶：置顶会话单独渲染，主体保留运行中、需关注与
  // 已完成待查看的会话，其余历史会话收进「历史会话」分组展开/收起。
  const isHistoryCollapsed = onlyRunningPinned && !isHistoryRevealed;
  const keptConversations = onlyRunningPinned
    ? list.conversations.filter((conversation) =>
        keptConversationIds.has(conversation.conversationId),
      )
    : list.conversations;
  const historyConversations = onlyRunningPinned
    ? list.conversations.filter(
        (conversation) => !keptConversationIds.has(conversation.conversationId),
      )
    : [];

  // 分组计数用项目会话总数推算（总数 - 已落库的活动会话），
  // 直接数已加载行只会显示分页大小（20），没有参考意义。
  const historyTotal = useMemo(() => {
    if (!onlyRunningPinned) {
      return 0;
    }
    const keptDbCount = keptConversations.filter(
      (conversation) => !isPendingSessionKey(conversation.conversationId),
    ).length;
    return Math.max(historyConversations.length, list.total - keptDbCount);
  }, [
    onlyRunningPinned,
    keptConversations,
    historyConversations.length,
    list.total,
  ]);

  // Option/Alt+方向键切换会话：树里只让当前激活项目注册，避免多个项目节点重复响应。
  const cycleOrderIds = useMemo(
    () => [
      ...pinned.pinnedConversations.map((c) => c.conversationId),
      ...list.conversations.map((c) => c.conversationId),
    ],
    [pinned.pinnedConversations, list.conversations],
  );
  const worktreeBindings = useConversationWorktreeBindings(cycleOrderIds);
  useConversationCycleShortcut({
    activeConversationId,
    enabled: activeDirectoryId === directoryId,
    onSelect: (conversationId) =>
      void handleSelectConversation(
        conversationId,
        undefined,
        undefined,
        directoryId,
      ),
    orderedConversationIds: cycleOrderIds,
  });

  const exitMultiSelect = useCallback((): void => {
    if (actions.isActionLocked) {
      return;
    }
    selection.exitMultiSelect();
    actions.setShowBatchConfirm(false);
  }, [actions, selection]);

  const allSelected =
    selection.selectedIds.size === selection.multiSelectableCount;

  const multiSelectActions: ChatMultiSelectAction[] = [
    {
      key: "archive",
      label:
        actions.archivingIds.size > 0
          ? t("sidebar.chatMultiSelectArchiving", {
              defaultValue: "Archiving...",
            })
          : t("sidebar.chatMultiSelectArchive", {
              defaultValue: "Archive selected",
            }),
      icon: actions.archivingIds.size > 0 ? "spinner" : "archive",
      disabled:
        actions.archivingIds.size > 0 || selection.selectedIds.size === 0,
      onClick: () => void actions.handleBatchArchive(),
    },
    {
      key: "delete",
      label: actions.isBatchDeleting
        ? t("sidebar.chatMultiSelectDeletingProgress", {
            defaultValue: "Deleting {{percent}}%",
            values: {
              percent: Math.round(actions.batchDeleteProgress?.percent ?? 0),
            },
          })
        : t("sidebar.chatMultiSelectDelete", {
            defaultValue: "Delete selected",
          }),
      icon: actions.isBatchDeleting ? "spinner" : "trash",
      disabled:
        actions.isBatchDeleting ||
        actions.archivingIds.size > 0 ||
        selection.selectedIds.size === 0,
      danger: true,
      onClick: actions.handleOpenBatchConfirm,
    },
  ];

  const handleSelectConversationFromList = useCallback(
    (conversation: ChatConversationRecord): void => {
      void (async (): Promise<void> => {
        if (
          conversation.directoryId &&
          conversation.directoryId !== activeDirectoryId
        ) {
          try {
            await window.snow.activateWorkspaceDirectory(
              conversation.directoryId,
            );
          } catch {}
        }
        await handleSelectConversation(
          conversation.conversationId,
          conversation.summary || conversation.title,
          {
            inputTokens: conversation.inputTokens,
            outputTokens: conversation.outputTokens,
            cacheCreationInputTokens: conversation.cacheCreationInputTokens,
            cacheReadInputTokens: conversation.cacheReadInputTokens,
          },
          conversation.directoryId,
        );
      })();
    },
    [activeDirectoryId, handleSelectConversation],
  );

  const handleSelectChildConversation = useCallback(
    (conversationId: string, childDirectoryId: string): void => {
      void (async (): Promise<void> => {
        if (childDirectoryId && childDirectoryId !== activeDirectoryId) {
          try {
            await window.snow.activateWorkspaceDirectory(childDirectoryId);
          } catch {}
        }
        await handleSelectConversation(
          conversationId,
          undefined,
          undefined,
          childDirectoryId,
        );
      })();
    },
    [activeDirectoryId, handleSelectConversation],
  );

  const renderConversationRow = (
    conversation: ChatConversationRecord,
  ): React.JSX.Element => {
    const conversationId = conversation.conversationId;
    const conversationKey = list.getConversationKey(conversation);
    const isActive =
      conversationId === activeConversationId ||
      conversationKey === activeSessionKeyRef.current ||
      (activeConversationId !== undefined &&
        pendingToRealConversationIdRef.current.get(conversationKey) ===
          activeConversationId);
    return (
      <ChatConversationRow
        attentionRequiredConversationIds={attentionRequiredConversationIds}
        completedConversationIds={completedConversationIds}
        conversation={conversation}
        worktree={worktreeBindings.get(conversationId)}
        expandedWorkflowNodeConversationIds={
          tree.expandedWorkflowNodeConversationIds
        }
        isActive={isActive}
        isArchiving={actions.archivingIds.has(conversationId)}
        isDeleting={actions.deletingIds.has(conversationId)}
        isMultiSelectMode={selection.isMultiSelectMode}
        isSelected={selection.selectedIds.has(conversationId)}
        isTreeExpanded={tree.isConversationTreeExpanded(conversationId)}
        onArchive={actions.handleArchive}
        onDelete={actions.handleDelete}
        onEnterMultiSelect={selection.enterMultiSelect}
        onExport={actions.handleExport}
        onFork={actions.handleFork}
        onPin={actions.handlePin}
        onRename={actions.handleRename}
        onSelectChildConversation={handleSelectChildConversation}
        onSelectConversation={handleSelectConversationFromList}
        onSelectionBlockedChange={selection.handleSelectionBlockedChange}
        onToggleSelect={selection.handleToggleSelect}
        onToggleTree={tree.handleToggleConversationTree}
        onToggleWorkflowNode={tree.handleToggleWorkflowNode}
        onUnpin={actions.handleUnpin}
        pausedConversationIds={pausedConversationIds}
        runningConversationIds={runningConversationIds}
        showPinBadge
        streamingConversationIds={streamingConversationIds}
        subAgentConversations={
          tree.subAgentMap[conversationId] ?? EMPTY_CONVERSATION_LIST
        }
        subAgentMap={tree.subAgentMap}
        surfacedConversationIds={tree.surfacedConversationIds}
        workflowNodeConversations={
          tree.workflowNodeMap[conversationId] ?? EMPTY_CONVERSATION_LIST
        }
      />
    );
  };

  const showLoading = list.isLoading && list.conversations.length === 0;
  const isEmpty =
    !showLoading &&
    !list.error &&
    list.conversations.length === 0 &&
    pinned.pinnedConversations.length === 0;

  return (
    <>
      {selection.isMultiSelectMode ? (
        <>
          <ChatMultiSelectBar
            actions={multiSelectActions}
            allSelected={allSelected}
            isExitDisabled={actions.isActionLocked}
            onExit={exitMultiSelect}
            onToggleSelectAll={
              allSelected
                ? selection.handleDeselectAll
                : selection.handleSelectAll
            }
            selectAllDisabled={actions.isActionLocked}
            selectedCount={selection.selectedIds.size}
          />
          {/* 批量删除的真实进度：后端按实际工作单元计数。 */}
          {actions.batchDeleteProgress ? (
            <div
              className="chat-import-progress chat-delete-progress-inline"
              role="status"
              aria-live="polite"
            >
              <div className="chat-import-progress-text">
                <Loader2 className="spin" size={12} aria-hidden="true" />
                <span>
                  {t("sidebar.chatMultiSelectDeletingProgress", {
                    defaultValue: "Deleting {{percent}}%",
                    values: {
                      percent: Math.round(actions.batchDeleteProgress.percent),
                    },
                  })}
                </span>
              </div>
              <div className="chat-import-progress-track" aria-hidden="true">
                <div
                  className="chat-import-progress-bar chat-delete-progress-bar"
                  style={{
                    width: `${Math.max(
                      2,
                      Math.min(100, actions.batchDeleteProgress.percent),
                    )}%`,
                  }}
                />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {showLoading ? (
        <span className="empty-text loading">
          <Loader2 className="spin" size={13} />
          {t("sidebar.loadingWorkspaceContent", {
            defaultValue: "Loading workspace content...",
          })}
        </span>
      ) : list.error ? (
        <span className="empty-text error">{list.error}</span>
      ) : isEmpty ? (
        <span className="empty-text">
          {t("sidebar.noChats", { defaultValue: "No chats" })}
        </span>
      ) : (
        <>
          {!selection.isMultiSelectMode &&
            pinned.pinnedConversations.map((conversation) => (
              <Fragment key={list.getConversationKey(conversation)}>
                {renderConversationRow(conversation)}
              </Fragment>
            ))}
          {(onlyRunningPinned ? keptConversations : list.conversations).map(
            (conversation) => (
              <Fragment key={list.getConversationKey(conversation)}>
                {renderConversationRow(conversation)}
              </Fragment>
            ),
          )}
          {onlyRunningPinned && historyConversations.length > 0 ? (
            <div className="tree-chat-history-group">
              <button
                aria-expanded={!isHistoryCollapsed}
                className="chat-time-group-header"
                onClick={() => setIsHistoryRevealed((prev) => !prev)}
                title={t("sidebar.chatHistoryToggle", {
                  defaultValue: "Expand/collapse history chats",
                })}
                type="button"
              >
                <ChevronRight
                  className={
                    isHistoryCollapsed ? "" : "chat-time-group-chevron--open"
                  }
                  size={12}
                />
                <span>
                  {t("sidebar.chatHistoryGroup", {
                    defaultValue: "History chats",
                  })}
                </span>
                <span className="chat-time-group-count">{historyTotal}</span>
              </button>
              <SidebarCollapse open={!isHistoryCollapsed}>
                {historyConversations.map((conversation) => (
                  <Fragment key={list.getConversationKey(conversation)}>
                    {renderConversationRow(conversation)}
                  </Fragment>
                ))}
              </SidebarCollapse>
            </div>
          ) : null}
          {isHistoryCollapsed ? null : (
            <ChatListFooter
              hasMore={list.hasMore}
              isLoadingMore={list.isLoadingMore}
              manual
              onLoadMore={() => void list.loadMore()}
            />
          )}
        </>
      )}
      <ChatDeleteConfirmDialog
        conversationCount={selection.selectedIds.size}
        deleteImages={actions.batchDeleteImages}
        deleteMemories={actions.batchDeleteMemories}
        imagesCount={actions.batchImagesCount}
        isBatch
        isConfirming={actions.isBatchDeleting}
        memoriesCount={actions.batchMemoriesCount}
        progress={actions.batchDeleteProgress}
        onCancel={() => actions.setShowBatchConfirm(false)}
        onConfirm={() => void actions.handleBatchDelete()}
        onDeleteImagesChange={actions.setBatchDeleteImages}
        onDeleteMemoriesChange={actions.setBatchDeleteMemories}
        open={actions.showBatchConfirm}
      />
    </>
  );
}
