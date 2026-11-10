import { useEffect, useRef, useState } from "react";

import type { GitWorktreeInfo } from "../../../../preload";
import { useChatConversationContext } from "../../mainContent/chatMessages";
import { CONVERSATION_WORKTREE_CHANGED_EVENT } from "../../../utils/conversationWorktreeEvents";

const WORKTREES_CHANGED_EVENT = "snow:worktrees-changed";

type ResolvedWorktree = {
  /** 解析时的会话键：切换会话后旧结果直接失效，不短暂串用。 */
  key: string;
  worktree: GitWorktreeInfo | null;
};

type ConversationGitWorkspace = {
  /** 会话绑定的工作树路径；未绑定或失效时回退项目目录。 */
  workspacePath: string | null;
  /** 工作树列表与分支操作使用的项目目录 id。 */
  directoryId: string | null;
  worktree: GitWorktreeInfo | null;
};

/**
 * 把当前会话绑定的 Git 工作树解析成仓库根路径。
 *
 * Git 面板与顶栏共用这一来源：会话绑定了有效的工作树就跟随它，否则沿用
 * 项目目录。绑定变化、工作树变化或切换会话都会重新解析。
 */
export const useConversationGitWorkspace = (
  fallbackPath: string | null | undefined,
  fallbackDirectoryId: string | null | undefined,
): ConversationGitWorkspace => {
  const fallbackWorkspacePath = fallbackPath ?? null;
  const fallbackProjectDirectoryId = fallbackDirectoryId ?? null;

  let chatContext: ReturnType<typeof useChatConversationContext> | null = null;
  try {
    chatContext = useChatConversationContext();
  } catch {
    chatContext = null;
  }
  const activeConversationId = chatContext?.activeConversationId;
  const conversationDirectoryId = chatContext?.conversationDirectoryId ?? null;
  const pendingWorktreeId = chatContext?.pendingWorktreeId ?? null;

  const conversationKey = activeConversationId
    ? `conv:${activeConversationId}`
    : pendingWorktreeId
      ? `pending:${pendingWorktreeId}`
      : "none";

  const [resolved, setResolved] = useState<ResolvedWorktree | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const directoryId = conversationDirectoryId ?? fallbackProjectDirectoryId;
    if (!directoryId || conversationKey === "none") {
      generationRef.current += 1;
      setResolved({ key: conversationKey, worktree: null });
      return;
    }
    const generation = ++generationRef.current;
    const load = (): void => {
      if (activeConversationId) {
        void window.snow
          .getConversationWorktree(activeConversationId)
          .then((binding) => {
            if (generationRef.current !== generation) {
              return;
            }
            setResolved({
              key: conversationKey,
              worktree:
                binding &&
                binding.isValid &&
                binding.directoryId === directoryId
                  ? binding
                  : null,
            });
          })
          .catch((error: unknown) => {
            if (generationRef.current !== generation) {
              return;
            }
            console.error("Failed to resolve conversation worktree", error);
            setResolved({ key: conversationKey, worktree: null });
          });
        return;
      }
      void window.snow
        .gitListWorktrees(directoryId)
        .then((items) => {
          if (generationRef.current !== generation) {
            return;
          }
          const preselected = items.find(
            (item) => item.worktreeId === pendingWorktreeId,
          );
          setResolved({
            key: conversationKey,
            worktree: preselected?.isValid ? preselected : null,
          });
        })
        .catch((error: unknown) => {
          if (generationRef.current !== generation) {
            return;
          }
          console.error("Failed to resolve pending worktree", error);
          setResolved({ key: conversationKey, worktree: null });
        });
    };
    load();
    window.addEventListener(WORKTREES_CHANGED_EVENT, load);
    window.addEventListener(CONVERSATION_WORKTREE_CHANGED_EVENT, load);
    return () => {
      generationRef.current += 1;
      window.removeEventListener(WORKTREES_CHANGED_EVENT, load);
      window.removeEventListener(CONVERSATION_WORKTREE_CHANGED_EVENT, load);
    };
  }, [
    activeConversationId,
    conversationDirectoryId,
    conversationKey,
    fallbackProjectDirectoryId,
    pendingWorktreeId,
  ]);

  const worktree = resolved?.key === conversationKey ? resolved.worktree : null;

  return {
    workspacePath: worktree?.worktreePath ?? fallbackWorkspacePath,
    directoryId: conversationDirectoryId ?? fallbackProjectDirectoryId,
    worktree,
  };
};
