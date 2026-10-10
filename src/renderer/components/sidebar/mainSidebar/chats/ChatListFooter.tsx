import { Loader2 } from "lucide-react";
import type { Ref } from "react";

import { useI18n } from "../../../../i18n";

type ChatListFooterProps = {
  hasMore: boolean;
  isLoadingMore: boolean;
  sentinelRef?: Ref<HTMLDivElement>;
  manual?: boolean;
  onLoadMore?: () => void;
};

export function ChatListFooter({
  sentinelRef,
  hasMore,
  isLoadingMore,
  manual = false,
  onLoadMore,
}: ChatListFooterProps): React.JSX.Element {
  const { t } = useI18n();

  if (!hasMore) {
    return (
      <div className="chat-all-loaded">
        {t("sidebar.chatAllLoaded", {
          defaultValue: "All chats loaded",
        })}
      </div>
    );
  }

  if (manual) {
    return (
      <div className="chat-load-more is-manual">
        <button
          className="chat-load-more-btn"
          type="button"
          disabled={isLoadingMore}
          onClick={onLoadMore}
        >
          {isLoadingMore ? (
            <Loader2 className="spin" size={13} aria-hidden="true" />
          ) : null}
          <span>
            {isLoadingMore
              ? t("sidebar.chatLoadingMore", {
                  defaultValue: "Loading more chats...",
                })
              : t("sidebar.chatLoadMore", {
                  defaultValue: "Load more",
                })}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={`chat-load-more ${isLoadingMore ? "is-loading" : ""}`}
      ref={sentinelRef}
      role={isLoadingMore ? "status" : undefined}
      aria-live="polite"
      aria-label={
        isLoadingMore
          ? t("sidebar.chatLoadingMore", {
              defaultValue: "Loading more chats...",
            })
          : undefined
      }
    >
      {isLoadingMore ? (
        <>
          <Loader2 className="spin" size={14} aria-hidden="true" />
          <span>
            {t("sidebar.chatLoadingMore", {
              defaultValue: "Loading more chats...",
            })}
          </span>
        </>
      ) : null}
    </div>
  );
}
