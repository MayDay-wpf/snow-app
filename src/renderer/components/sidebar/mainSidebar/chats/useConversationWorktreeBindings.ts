import { useEffect, useMemo, useRef, useState } from "react";

import type { ConversationWorktreeInfo } from "../../../../../preload";
import { CONVERSATION_WORKTREE_CHANGED_EVENT } from "../../../../utils/conversationWorktreeEvents";

const WORKTREES_CHANGED_EVENT = "snow:worktrees-changed";
/** 会话 id 分隔符：会话 id 内不含换行，作为去重键足够。 */
const ID_SEPARATOR = "\n";

/**
 * 按当前列表批量读取会话的工作树绑定。
 *
 * 只返回仍有效（工作树存在于其仓库）的绑定；绑定或工作树变化时按同一批 id
 * 重新拉取，拉取失败保留上次结果并记录错误。
 */
export const useConversationWorktreeBindings = (
  conversationIds: string[],
): Map<string, ConversationWorktreeInfo> => {
  const idsKey = useMemo(
    () => conversationIds.join(ID_SEPARATOR),
    [conversationIds],
  );
  const [bindings, setBindings] = useState<
    Map<string, ConversationWorktreeInfo>
  >(() => new Map());
  const requestRef = useRef(0);

  useEffect(() => {
    const ids = idsKey ? idsKey.split(ID_SEPARATOR) : [];
    if (ids.length === 0) {
      requestRef.current += 1;
      setBindings(new Map());
      return;
    }
    const generation = ++requestRef.current;
    const load = (): void => {
      void window.snow
        .getConversationWorktrees(ids)
        .then((rows) => {
          if (requestRef.current !== generation) {
            return;
          }
          setBindings(
            new Map(
              rows
                .filter((row) => row.isValid)
                .map((row) => [row.conversationId, row]),
            ),
          );
        })
        .catch((error: unknown) => {
          if (requestRef.current !== generation) {
            return;
          }
          console.error("Failed to load conversation worktree bindings", error);
        });
    };
    load();
    window.addEventListener(WORKTREES_CHANGED_EVENT, load);
    window.addEventListener(CONVERSATION_WORKTREE_CHANGED_EVENT, load);
    return () => {
      requestRef.current += 1;
      window.removeEventListener(WORKTREES_CHANGED_EVENT, load);
      window.removeEventListener(CONVERSATION_WORKTREE_CHANGED_EVENT, load);
    };
  }, [idsKey]);

  return bindings;
};
