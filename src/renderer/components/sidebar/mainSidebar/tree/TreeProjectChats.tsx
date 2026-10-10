import { Fragment, useCallback, useMemo } from "react";
import type { RefObject } from "react";

import { Loader2 } from "lucide-react";

import type { ChatConversationRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../../../mainContent/chatMessages";
import { ChatDeleteConfirmDialog } from "../ChatDeleteConfirmDialog";
import { ChatConversationRow } from "../chats/ChatConversationRow";
import { ChatListFooter } from "../chats/ChatListFooter";
import {
  ChatMultiSelectBar,
  type ChatMultiSelectAction,
} from "../chats/ChatMultiSelectBar";
import { useChatConversationList } from "../chats/useChatConversationList";
import { useChatSelection } from "../chats/useChatSelection";
import { useConversationActions } from "../chats/useConversationActions";
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
    sessions,
    streamingConversationIds,
    attentionRequiredConversationIds,
    completedConversationIds,
    clearInputDraft,
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
    upsertedConversationTimestamp: upsertedConversation?.timestamp,
    subAgentSessionEvents,
    activeConversationId,
    attentionRequiredConversationIds,
    runningConversationIds,
  });

  const selection = useChatSelection({
    conversations: list.conversations,
    runningConversationIds,
    surfacedConversationIds: tree.surfacedConversationIds,
  });

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
        ? t("sidebar.chatMultiSelectDeleting", {
            defaultValue: "Deleting...",
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

  const handleSelectConversationFromList = (
    conversation: ChatConversationRecord,
  ): void => {
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
  };

  const handleSelectChildConversation = (
    conversationId: string,
    childDirectoryId: string,
  ): void => {
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
  };

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
        activeConversationId={isActive ? conversationId : activeConversationId}
        attentionRequiredConversationIds={attentionRequiredConversationIds}
        completedConversationIds={completedConversationIds}
        conversation={conversation}
        expandedWorkflowNodeConversationIds={
          tree.expandedWorkflowNodeConversationIds
        }
        isArchiving={actions.archivingIds.has(conversationId)}
        isDeleting={actions.deletingIds.has(conversationId)}
        isMultiSelectMode={selection.isMultiSelectMode}
        isSelected={selection.selectedIds.has(conversationId)}
        isSubAgentExpanded={tree.expandedSubAgentConversationIds.has(
          conversationId,
        )}
        isWorkflowPanelExpanded={tree.expandedWorkflowConversationIds.has(
          conversationId,
        )}
        onArchive={() => void actions.handleArchive(conversation)}
        onDelete={(deleteImages, deleteMemories) =>
          void actions.handleDelete(conversation, deleteImages, deleteMemories)
        }
        onEnterMultiSelect={selection.enterMultiSelect}
        onExport={(format) => void actions.handleExport(conversation, format)}
        onFork={() => actions.handleFork(conversation)}
        onPin={() =>
          void (conversation.status === "pin"
            ? actions.handleUnpin(conversation)
            : actions.handlePin(conversation))
        }
        onRename={(newTitle) => actions.handleRename(conversation, newTitle)}
        onSelectChildConversation={handleSelectChildConversation}
        onSelectConversation={handleSelectConversationFromList}
        onSetEmoji={(emoji) => actions.handleSetEmoji(conversation, emoji)}
        onToggleSelect={() => selection.handleToggleSelect(conversationId)}
        onToggleSubAgentPanel={() =>
          tree.handleToggleSubAgentPanel(conversationId)
        }
        onToggleWorkflowNode={tree.handleToggleWorkflowNode}
        onToggleWorkflowPanel={() =>
          tree.handleToggleWorkflowPanel(conversationId)
        }
        pausedConversationIds={pausedConversationIds}
        runningConversationIds={runningConversationIds}
        showPinBadge
        streamingConversationIds={streamingConversationIds}
        subAgentConversations={tree.subAgentMap[conversationId] ?? []}
        subAgentMap={tree.subAgentMap}
        surfacedConversationIds={tree.surfacedConversationIds}
        workflowNodeConversations={tree.workflowNodeMap[conversationId] ?? []}
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
        onCancel={() => actions.setShowBatchConfirm(false)}
        onConfirm={() => void actions.handleBatchDelete()}
        onDeleteImagesChange={actions.setBatchDeleteImages}
        onDeleteMemoriesChange={actions.setBatchDeleteMemories}
        open={actions.showBatchConfirm}
      />
    </>
  );
}
