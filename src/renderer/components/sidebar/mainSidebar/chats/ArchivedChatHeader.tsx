import { ListChecks, Search, X } from "lucide-react";

import { useI18n } from "../../../../i18n";
import {
  ChatMultiSelectBar,
  type ChatMultiSelectAction,
} from "./ChatMultiSelectBar";

type ArchivedChatHeaderProps = {
  archivedCount: number;
  hasKeyword: boolean;
  isMultiSelect: boolean;
  isRestoring: boolean;
  isDeleting: boolean;
  selectedCount: number;
  allSelected: boolean;
  searchInput: string;
  onChangeSearch: (value: string) => void;
  onEnterMultiSelect: () => void;
  onExitMultiSelect: () => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onBatchRestore: () => void;
  onBatchDelete: () => void;
};

/** 归档列表头部：渲染在滚动列表之外，滚动会话时不跟随移动 */
export function ArchivedChatHeader({
  archivedCount,
  hasKeyword,
  isMultiSelect,
  isRestoring,
  isDeleting,
  selectedCount,
  allSelected,
  searchInput,
  onChangeSearch,
  onEnterMultiSelect,
  onExitMultiSelect,
  onSelectAll,
  onDeselectAll,
  onBatchRestore,
  onBatchDelete,
}: ArchivedChatHeaderProps): React.JSX.Element | null {
  const { t } = useI18n();
  const isBusy = isRestoring || isDeleting;
  // 无结果时仍保留搜索框，便于清空关键词
  const showSearchRow = !isMultiSelect && (archivedCount > 0 || hasKeyword);
  const showToolbar = !isMultiSelect && archivedCount > 0;

  if (!showSearchRow && !isMultiSelect) {
    return null;
  }

  const actions: ChatMultiSelectAction[] = [
    {
      key: "restore",
      label: isRestoring
        ? t("sidebar.chatMultiSelectRestoring", {
            defaultValue: "Restoring...",
          })
        : t("sidebar.archivedChatMultiSelectRestore", {
            defaultValue: "Restore selected",
          }),
      icon: isRestoring ? "spinner" : "restore",
      disabled: isRestoring || selectedCount === 0,
      onClick: onBatchRestore,
    },
    {
      key: "delete",
      label: t("sidebar.archivedChatMultiSelectDelete", {
        defaultValue: "Delete selected",
      }),
      icon: isDeleting ? "spinner" : "trash",
      disabled: isBusy || selectedCount === 0,
      danger: true,
      onClick: onBatchDelete,
    },
  ];

  return (
    <div className="archived-list-header">
      {isMultiSelect ? (
        <ChatMultiSelectBar
          selectedCount={selectedCount}
          allSelected={allSelected}
          isExitDisabled={isBusy}
          selectAllDisabled={isBusy}
          onExit={onExitMultiSelect}
          onToggleSelectAll={allSelected ? onDeselectAll : onSelectAll}
          actions={actions}
        />
      ) : null}
      {showSearchRow ? (
        <div className="archived-search-row">
          <Search
            aria-hidden="true"
            className="archived-search-icon"
            size={13}
            strokeWidth={2}
          />
          <input
            aria-label={t("sidebar.archivedChatsSearchPlaceholder", {
              defaultValue: "Search archived chats",
            })}
            className="archived-search-input"
            onChange={(event) => onChangeSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchInput !== "") {
                event.preventDefault();
                event.stopPropagation();
                onChangeSearch("");
              }
            }}
            placeholder={t("sidebar.archivedChatsSearchPlaceholder", {
              defaultValue: "Search archived chats",
            })}
            type="text"
            value={searchInput}
          />
          {searchInput !== "" ? (
            <button
              aria-label={t("sidebar.archivedChatsSearchClear", {
                defaultValue: "Clear search",
              })}
              className="archived-search-clear"
              onClick={() => onChangeSearch("")}
              title={t("sidebar.archivedChatsSearchClear", {
                defaultValue: "Clear search",
              })}
              type="button"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      {showToolbar ? (
        <div className="archived-chat-toolbar">
          <span className="archived-chat-toolbar-hint">
            {t("sidebar.archivedChatsHint", {
              defaultValue: "Restore archived chats to continue using them",
            })}
          </span>
          <button
            type="button"
            className="archived-multi-select-btn"
            onClick={onEnterMultiSelect}
          >
            <ListChecks size={13} />
            <span>
              {t("sidebar.chatActionMultiSelect", {
                defaultValue: "Multi-select",
              })}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
