import { Loader2 } from "lucide-react";
import type { RefObject } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { ArchivedChatItem } from "../ArchivedChatItem";
import { ChatListFooter } from "./ChatListFooter";

type ArchivedChatListProps = {
  directoryId: string;
  isSwitchingDirectory: boolean;
  isArchivedLoading: boolean;
  isArchivedLoadingMore: boolean;
  archivedError: string | null;
  archivedConversations: ChatConversationRecord[];
  hasMoreArchived: boolean;
  loadMoreRef: RefObject<HTMLDivElement | null>;
  archivedSearchInput: string;
  isArchivedMultiSelect: boolean;
  archivedSelectedIds: Set<string>;
  restoringIds: Set<string>;
  deletingArchivedIds: Set<string>;
  onToggleSelect: (conversationId: string) => void;
  onRestore: (conversation: ChatConversationRecord) => void;
  onDelete: (conversation: ChatConversationRecord) => void;
};

/** 归档会话列表：头部（搜索/提示/多选）由 ArchivedChatHeader 渲染在滚动区之外 */
export function ArchivedChatList({
  directoryId,
  isSwitchingDirectory,
  isArchivedLoading,
  isArchivedLoadingMore,
  archivedError,
  archivedConversations,
  hasMoreArchived,
  loadMoreRef,
  archivedSearchInput,
  isArchivedMultiSelect,
  archivedSelectedIds,
  restoringIds,
  deletingArchivedIds,
  onToggleSelect,
  onRestore,
  onDelete,
}: ArchivedChatListProps): React.JSX.Element {
  const { t } = useI18n();
  const hasKeyword = archivedSearchInput.trim().length > 0;

  if (
    isSwitchingDirectory ||
    (isArchivedLoading && archivedConversations.length === 0)
  ) {
    return (
      <span className="empty-text loading">
        <Loader2 className="spin" size={13} />
        {t("sidebar.loadingWorkspaceContent", {
          defaultValue: "Loading workspace content...",
        })}
      </span>
    );
  }

  if (!directoryId) {
    return (
      <span className="empty-text">
        {t("sidebar.noActiveDirectory", {
          defaultValue: "No active directory",
        })}
      </span>
    );
  }

  if (archivedError) {
    return <span className="empty-text error">{archivedError}</span>;
  }

  if (archivedConversations.length === 0) {
    return (
      <span className="empty-text">
        {hasKeyword
          ? t("sidebar.archivedChatsSearchEmpty", {
              defaultValue: "No matching archived chats",
            })
          : t("sidebar.archivedChatsEmpty", {
              defaultValue: "No archived chats",
            })}
      </span>
    );
  }

  return (
    <>
      {archivedConversations.map((conversation) => (
        <ArchivedChatItem
          key={conversation.conversationId}
          conversation={conversation}
          isMultiSelectMode={isArchivedMultiSelect}
          isSelected={archivedSelectedIds.has(conversation.conversationId)}
          isRestoring={restoringIds.has(conversation.conversationId)}
          isDeleting={deletingArchivedIds.has(conversation.conversationId)}
          onToggleSelect={() => onToggleSelect(conversation.conversationId)}
          onRestore={() => onRestore(conversation)}
          onDelete={() => onDelete(conversation)}
        />
      ))}
      <ChatListFooter
        sentinelRef={loadMoreRef}
        hasMore={hasMoreArchived}
        isLoadingMore={isArchivedLoadingMore}
      />
    </>
  );
}
