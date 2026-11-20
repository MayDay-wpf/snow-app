import { Fragment, useCallback, useEffect, useMemo } from "react";
import type { RefObject } from "react";

import { Loader2 } from "lucide-react";

import type { ChatConversationRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../../../mainContent/chatMessages";
import { ChatDeleteConfirmDialog } from "../ChatDeleteConfirmDialog";
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
import { usePausedConversationIds } from "../chats/usePausedConversationIds";
import { usePinnedConversations } from "../chats/usePinnedConversations";

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
    getOrderedConversationIds: () =>
      list.conversations.map((conversation) => conversation.conversationId),
    runningConversationIds,
    surfacedConversationIds: tree.surfacedConversationIds,
  });

  // 树节点切换项目后仍挂载；只清理离开的节点，保留刚激活节点的点击锚点。
  useEffect(() => {
    if (activeDirectoryId !== directoryId) {
      selection.resetMultiSelect();
    }
  }, [activeDirectoryId, directoryId, selection.resetMultiSelect]);

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

  // Option/Alt+方向键切换会话：树里只让当前激活项目注册，避免多个项目节点重复响应。
  const cycleOrderIds = useMemo(
    () => [
      ...pinned.pinnedConversations.map((c) => c.conversationId),
      ...list.conversations.map((c) => c.conversationId),
    ],
    [pinned.pinnedConversations, list.conversations],
  );
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
                  className="chat-import-progress-bar"
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
          {list.conversations.map((conversation) => (
            <Fragment key={list.getConversationKey(conversation)}>
              {renderConversationRow(conversation)}
            </Fragment>
          ))}
          <ChatListFooter
            hasMore={list.hasMore}
            isLoadingMore={list.isLoadingMore}
            manual
            onLoadMore={() => void list.loadMore()}
          />
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
