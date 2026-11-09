import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { useChatConversationContext } from "../../mainContent/chatMessages";
import { groupConversationsByTime, type TimeGroup } from "./chatTimeGroup";
import { ArchivedChatHeader } from "./chats/ArchivedChatHeader";
import { ArchivedChatList } from "./chats/ArchivedChatList";
import {
  ChatConversationRow,
  EMPTY_CONVERSATION_LIST,
} from "./chats/ChatConversationRow";
import { ChatListFooter } from "./chats/ChatListFooter";
import {
  ChatMultiSelectBar,
  type ChatMultiSelectAction,
} from "./chats/ChatMultiSelectBar";
import { ChatTimeGroupList } from "./chats/ChatTimeGroupList";
import { ChatImportProgress } from "./chats/ChatImportProgress";
import { ChatsSectionDialogs } from "./chats/ChatsSectionDialogs";
import { ChatsSectionHeader } from "./chats/ChatsSectionHeader";
import { CrossProjectNotificationList } from "./chats/CrossProjectNotificationList";
import { useArchivedConversations } from "./chats/useArchivedConversations";
import { useChatConversationList } from "./chats/useChatConversationList";
import { useChatImport } from "./chats/useChatImport";
import { useChatSelection } from "./chats/useChatSelection";
import {
  useChatsCollapse,
  useChatsSectionLayout,
} from "./chats/useChatsSectionLayout";
import { useConversationCycleShortcut } from "./chats/useConversationCycleShortcut";
import { useConversationActions } from "./chats/useConversationActions";
import { useConversationTree } from "./chats/useConversationTree";
import { usePausedConversationIds } from "./chats/usePausedConversationIds";
import { usePinnedConversations } from "./chats/usePinnedConversations";
import { useChatsSectionInteractions } from "./chats/useChatsSectionInteractions";
import type { CrossProjectNotificationGroup } from "./useCrossProjectNotifications";

type ChatsSectionProps = {
  isSwitchingDirectory: boolean;
  activeDirectory?: WorkspaceDirectoryRecord | null;
  /** 跨项目通知（其他项目的运行中/需关注/已完成会话分组） */
  crossProjectNotifications: CrossProjectNotificationGroup[];
  /** 收起状态变化时上报父组件（收起后剩余高度让给项目区域） */
  onCollapsedChange?: (collapsed: boolean) => void;
};

export function ChatsSection({
  isSwitchingDirectory,
  activeDirectory,
  crossProjectNotifications,
  onCollapsedChange,
}: ChatsSectionProps): React.JSX.Element {
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
    activeConversationId,
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
  // 被用户暂停的流式会话（agent loop 阻塞等待恢复），图标切换为暂停态。
  const pausedConversationIds = usePausedConversationIds(sessions);

  const directoryId = activeDirectory?.directoryId ?? "";
  const sectionListRef = useRef<HTMLDivElement | null>(null);
  const collapse = useChatsCollapse({ onCollapsedChange });

  const pinned = usePinnedConversations({
    directoryId,
    conversationListVersion,
    upsertedConversation,
  });

  const list = useChatConversationList({
    directoryId,
    conversationListVersion,
    upsertedConversation,
    pendingToRealConversationIdRef,
    runningConversationIds,
    sessions,
    isCollapsed: collapse.isCollapsed,
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
      timeGroups
        .filter((group) => layout.collapsedGroupKeys[group.key] !== true)
        .flatMap((group) =>
          group.conversations.map(
            (conversation) => conversation.conversationId,
          ),
        ),
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

  const exitMultiSelect = useCallback((): void => {
    if (actions.isActionLocked) {
      return;
    }
    selection.exitMultiSelect();
    actions.setShowBatchConfirm(false);
  }, [actions, selection]);

  const layout = useChatsSectionLayout({
    isMultiSelectMode: selection.isMultiSelectMode,
  });

  const archived = useArchivedConversations({
    directoryId,
    isCollapsed: collapse.isCollapsed,
    sectionListRef,
    refreshConversations,
    onExitChatMultiSelect: exitMultiSelect,
  });

  const chatImport = useChatImport({
    directoryId,
    refreshConversations,
  });

  /** 收起/展开会话区域；收起时退出多选模式 */
  const toggleCollapsed = (): void => {
    collapse.setCollapsedPersisted(!collapse.isCollapsed);
    if (selection.isMultiSelectMode) {
      exitMultiSelect();
    }
    if (archived.isArchivedMultiSelect) {
      archived.handleExitArchivedMultiSelect();
    }
  };

  const interactions = useChatsSectionInteractions({
    isArchiveMode: archived.isArchiveMode,
    setIsChatDragOver: layout.setIsChatDragOver,
    refreshConversations,
    handleSelectConversation,
  });
  const {
    handleOpenCrossProjectNotification,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePinnedDragOver,
    handlePinnedDragLeave,
    handlePinnedDrop,
    isPinnedDragOver,
    handleSelectConversationFromList,
    handleSelectChildConversation,
  } = interactions;

  const timeGroups = groupConversationsByTime(
    list.conversations,
    new Date(),
    tree.surfacedConversationIds,
  );
  // 运行中会话分组排在最前，随列表一起滚动（不再固定在列表头部）
  const runningGroup = timeGroups.find((group) => group.key === "running");
  const contentGroups = timeGroups.filter((group) => group.key !== "running");
  // 置顶会话在会话列表内单独成组（随列表滚动），行内以 Pin 图标标注
  const pinnedGroups: TimeGroup[] =
    pinned.pinnedConversations.length > 0
      ? [{ key: "pinned", conversations: pinned.pinnedConversations }]
      : [];

  // 快捷键切换上一个/下一个会话：列表顺序 = 置顶 + 时间分组（排除运行中组）。
  const cycleOrderIds = useMemo(
    () => [
      ...pinned.pinnedConversations.map((c) => c.conversationId),
      ...contentGroups.flatMap((group) =>
        group.conversations.map((c) => c.conversationId),
      ),
    ],
    [pinned.pinnedConversations, contentGroups],
  );
  useConversationCycleShortcut({
    orderedConversationIds: cycleOrderIds,
    activeConversationId,
    onSelect: (conversationId) => void handleSelectConversation(conversationId),
  });

  const showLoading =
    isSwitchingDirectory || (list.isLoading && directoryId !== "");

  // 多选模式下会话列表按选择集合渲染，置顶分组临时隐藏避免不可选条目干扰
  const showPinnedGroup =
    !archived.isArchiveMode &&
    !collapse.isCollapsed &&
    !showLoading &&
    directoryId !== "" &&
    !list.error &&
    !selection.isMultiSelectMode;

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

  return (
    <div
      className={`sidebar-section chats-section${
        collapse.isCollapsed ? " collapsed" : ""
      }`}
      ref={layout.sectionRef}
    >
      {selection.isMultiSelectMode ? (
        <ChatMultiSelectBar
          actions={multiSelectActions}
          allSelected={allSelected}
          headerRef={layout.headerRef}
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
      ) : (
        <ChatsSectionHeader
          archivedTotal={archived.archivedTotal}
          headerRef={layout.headerRef}
          isArchiveMode={archived.isArchiveMode}
          isCollapsed={collapse.isCollapsed}
          isImportingConversations={chatImport.isImporting}
          onImportConversations={() =>
            void chatImport.handleImportConversations()
          }
          onToggleArchiveMode={archived.toggleArchiveMode}
          onToggleCollapsed={toggleCollapsed}
        />
      )}
      <ChatImportProgress progress={chatImport.progress} />
      <AutoDismissNotice
        durationMs={3000}
        message={chatImport.notice?.message ?? ""}
        onDismiss={chatImport.dismissNotice}
        tone={chatImport.notice?.tone ?? "success"}
      />
      {archived.isArchiveMode ? (
        <ArchivedChatHeader
          allSelected={
            archived.archivedSelectedIds.size ===
              archived.archivedConversations.length &&
            archived.archivedConversations.length > 0
          }
          archivedCount={archived.archivedConversations.length}
          hasKeyword={archived.archivedSearchInput.trim().length > 0}
          isDeleting={archived.deletingArchivedIds.size > 0}
          isMultiSelect={archived.isArchivedMultiSelect}
          isRestoring={archived.restoringIds.size > 0}
          onBatchDelete={archived.handleBatchDeleteArchived}
          onBatchRestore={() => void archived.handleBatchRestore()}
          onChangeSearch={archived.setArchivedSearchInput}
          onDeselectAll={archived.handleArchivedDeselectAll}
          onEnterMultiSelect={archived.enterArchivedMultiSelect}
          onExitMultiSelect={archived.handleExitArchivedMultiSelect}
          onSelectAll={archived.handleArchivedSelectAll}
          searchInput={archived.archivedSearchInput}
          selectedCount={archived.archivedSelectedIds.size}
        />
      ) : null}
      <div
        className={`section-list${
          layout.isChatDragOver ? " chat-drag-over" : ""
        }`}
        ref={sectionListRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {archived.isArchiveMode ? (
          <ArchivedChatList
            archivedConversations={archived.archivedConversations}
            archivedError={archived.archivedError}
            archivedSearchInput={archived.archivedSearchInput}
            archivedSelectedIds={archived.archivedSelectedIds}
            deletingArchivedIds={archived.deletingArchivedIds}
            directoryId={directoryId}
            hasMoreArchived={archived.hasMoreArchived}
            isArchivedLoading={archived.isArchivedLoading}
            isArchivedLoadingMore={archived.isArchivedLoadingMore}
            isArchivedMultiSelect={archived.isArchivedMultiSelect}
            isSwitchingDirectory={isSwitchingDirectory}
            loadMoreRef={archived.archivedLoadMoreRef}
            onDelete={archived.handleDeleteArchived}
            onRestore={(conversation) =>
              void archived.handleRestore(conversation)
            }
            onToggleSelect={archived.handleArchivedToggleSelect}
            restoringIds={archived.restoringIds}
          />
        ) : showLoading ? (
          <span className="empty-text loading">
            <span className="spin-layer">
              <Loader2 size={13} />
            </span>
            {t("sidebar.loadingWorkspaceContent", {
              defaultValue: "Loading workspace content...",
            })}
          </span>
        ) : !directoryId ? (
          <span className="empty-text">
            {t("sidebar.noActiveDirectory", {
              defaultValue: "No active directory",
            })}
          </span>
        ) : list.error ? (
          <span className="empty-text error">{list.error}</span>
        ) : list.conversations.length === 0 &&
          crossProjectNotifications.length === 0 &&
          pinnedGroups.length === 0 ? (
          <span className="empty-text">
            {t("sidebar.noChats", { defaultValue: "No chats" })}
          </span>
        ) : (
          <>
            {/* 运行中会话分组：排在列表最前，随列表滚动（不固定） */}
            {runningGroup ? (
              <div className="chats-running-group">
                <ChatTimeGroupList
                  collapsedGroupKeys={layout.collapsedGroupKeys}
                  getGroupLabel={layout.getGroupLabel}
                  getConversationKey={list.getConversationKey}
                  groups={[runningGroup]}
                  isMultiSelectable={selection.isMultiSelectable}
                  isMultiSelectMode={selection.isMultiSelectMode}
                  onToggleGroupCollapsed={layout.toggleGroupCollapsed}
                  onToggleGroupSelect={selection.handleToggleGroupSelect}
                  renderRow={renderConversationRow}
                  selectedIds={selection.selectedIds}
                />
              </div>
            ) : null}
            {/* 置顶会话分组：随列表滚动；拖入该分组=置顶，拖到普通列表区=取消置顶 */}
            {showPinnedGroup && (
              <div
                className={`chat-pinned-group${
                  isPinnedDragOver ? " chat-drag-over" : ""
                }`}
                onDragOver={handlePinnedDragOver}
                onDragLeave={handlePinnedDragLeave}
                onDrop={handlePinnedDrop}
              >
                <ChatTimeGroupList
                  collapsedGroupKeys={layout.collapsedGroupKeys}
                  getGroupLabel={layout.getGroupLabel}
                  getConversationKey={list.getConversationKey}
                  groups={pinnedGroups}
                  isMultiSelectable={selection.isMultiSelectable}
                  isMultiSelectMode={selection.isMultiSelectMode}
                  onToggleGroupCollapsed={layout.toggleGroupCollapsed}
                  onToggleGroupSelect={selection.handleToggleGroupSelect}
                  renderRow={renderConversationRow}
                  selectedIds={selection.selectedIds}
                />
              </div>
            )}
            {/* 跨项目通知：其他项目运行中/需关注/已完成的会话，
                  点击自动切换项目并打开对应会话 */}
            {crossProjectNotifications.length > 0 && (
              <CrossProjectNotificationList
                groups={crossProjectNotifications}
                isCollapsed={layout.isCrossProjectCollapsed}
                onOpenNotification={(group, notification) =>
                  void handleOpenCrossProjectNotification(group, notification)
                }
                onToggleCollapsed={layout.toggleCrossProjectCollapsed}
              />
            )}
            <ChatTimeGroupList
              collapsedGroupKeys={layout.collapsedGroupKeys}
              getGroupLabel={layout.getGroupLabel}
              getConversationKey={list.getConversationKey}
              groups={contentGroups}
              isMultiSelectable={selection.isMultiSelectable}
              isMultiSelectMode={selection.isMultiSelectMode}
              onToggleGroupCollapsed={layout.toggleGroupCollapsed}
              onToggleGroupSelect={selection.handleToggleGroupSelect}
              renderRow={renderConversationRow}
              selectedIds={selection.selectedIds}
            />
            <ChatListFooter
              hasMore={list.hasMore}
              isLoadingMore={list.isLoadingMore}
              sentinelRef={list.loadMoreRef}
            />
          </>
        )}
      </div>
      <ChatsSectionDialogs
        archivedDeleteTargetIds={archived.archivedDeleteTargetIds}
        batchDeleteImages={actions.batchDeleteImages}
        batchDeleteMemories={actions.batchDeleteMemories}
        batchImagesCount={actions.batchImagesCount}
        batchMemoriesCount={actions.batchMemoriesCount}
        isBatchDeleting={actions.isBatchDeleting}
        isDeletingArchived={archived.deletingArchivedIds.size > 0}
        onArchivedDeleteCancel={() => archived.setArchivedDeleteTargetIds(null)}
        onArchivedDeleteConfirm={() =>
          void archived.handleArchivedDeleteConfirm()
        }
        onBatchCancel={() => actions.setShowBatchConfirm(false)}
        onBatchConfirm={() => void actions.handleBatchDelete()}
        onBatchImagesChange={actions.setBatchDeleteImages}
        onBatchMemoriesChange={actions.setBatchDeleteMemories}
        selectedCount={selection.selectedIds.size}
        showBatchConfirm={actions.showBatchConfirm}
      />
    </div>
  );
}
