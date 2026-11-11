import { useEffect, useRef, useState } from "react";
import {
  GitBranch,
  ChevronDown,
  Check,
  Unlink,
  FolderGit2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import type { GitWorktreeInfo } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { useChatConversationContext } from "../chatMessages";
import { notifyConversationWorktreeChanged } from "../../../utils/conversationWorktreeEvents";
import { formatDisplayPath } from "../../../utils/formatDisplayPath";

/** 提取末级工作树文件夹名称。 */
const getFolderName = (p: string): string => {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
};

export function WorktreeSessionSelector(): React.JSX.Element | null {
  const {
    activeConversationId,
    conversationDirectoryId,
    pendingWorktreeId,
    setPendingWorktreeId,
    isStreaming,
    isAborting,
    isCompacting,
  } = useChatConversationContext();
  const isSessionRunning = isStreaming || isAborting || isCompacting;
  const { t } = useI18n();
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [current, setCurrent] = useState<GitWorktreeInfo | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const requestGenerationRef = useRef(0);
  const activeContextRef = useRef({
    conversationId: activeConversationId,
    directoryId: conversationDirectoryId,
  });
  activeContextRef.current = {
    conversationId: activeConversationId,
    directoryId: conversationDirectoryId,
  };

  const isCurrentRequest = (
    conversationId: string | undefined,
    directoryId: string,
    generation: number,
  ): boolean =>
    requestGenerationRef.current === generation &&
    activeContextRef.current.conversationId === conversationId &&
    activeContextRef.current.directoryId === directoryId;

  useEffect(() => {
    const conversationId = activeConversationId;
    const directoryId = conversationDirectoryId;
    if (!directoryId) {
      requestGenerationRef.current += 1;
      setCurrent(null);
      setWorktrees([]);
      return;
    }

    const reload = (): void => {
      const generation = ++requestGenerationRef.current;
      const worktreesPromise = window.snow.gitListWorktrees(directoryId);
      const boundPromise = conversationId
        ? window.snow.getConversationWorktree(conversationId)
        : Promise.resolve(null);

      void Promise.all([worktreesPromise, boundPromise])
        .then(([items, bound]) => {
          if (!isCurrentRequest(conversationId, directoryId, generation))
            return;
          setWorktrees(items);
          if (conversationId) {
            setCurrent(bound);
          } else {
            const preselected = pendingWorktreeId
              ? (items.find((item) => item.worktreeId === pendingWorktreeId) ??
                null)
              : null;
            setCurrent(preselected);
          }
        })
        .catch(() => {
          if (isCurrentRequest(conversationId, directoryId, generation)) {
            // Keep existing state on error
          }
        });
    };

    reload();
    window.addEventListener("snow:worktrees-changed", reload);
    return () => {
      requestGenerationRef.current += 1;
      window.removeEventListener("snow:worktrees-changed", reload);
    };
  }, [activeConversationId, conversationDirectoryId, pendingWorktreeId]);

  useEffect(() => {
    if (!activeConversationId) {
      const preselected = pendingWorktreeId
        ? (worktrees.find((item) => item.worktreeId === pendingWorktreeId) ??
          null)
        : null;
      setCurrent(preselected);
    }
  }, [pendingWorktreeId, activeConversationId, worktrees]);

  useEffect(() => {
    if (isSessionRunning && isOpen) {
      setIsOpen(false);
    }
  }, [isSessionRunning, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent): void => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  if (!conversationDirectoryId) return null;

  // 优化点：若当前项目没有任何 Worktree 且当前未绑定或预选任何 Worktree，坚决隐藏此选择器，避免霸占底栏空间
  if (worktrees.length === 0 && !current && !pendingWorktreeId) {
    return null;
  }

  const bind = (worktreeId: string | null): void => {
    if (isSessionRunning) return;
    const conversationId = activeConversationId;
    const directoryId = conversationDirectoryId;
    const generation = ++requestGenerationRef.current;

    if (conversationId) {
      void window.snow
        .setConversationWorktree(conversationId, worktreeId)
        .then(() => {
          notifyConversationWorktreeChanged();
          if (!isCurrentRequest(conversationId, directoryId, generation))
            return;
          setCurrent(
            worktrees.find((item) => item.worktreeId === worktreeId) ?? null,
          );
          setIsOpen(false);
        })
        .catch(() => {
          // Keep current state on fail
        });
    } else {
      // 当前为新建会话状态（无活跃会话 ID）：作为待生效预选工作树
      setPendingWorktreeId(worktreeId);
      setCurrent(
        worktrees.find((item) => item.worktreeId === worktreeId) ?? null,
      );
      setIsOpen(false);
    }
  };

  const branchName = current?.branchName ?? t("git.graphDetachedHead");
  const cleanedCurrentPath = current
    ? formatDisplayPath(current.worktreePath)
    : "";
  const isPendingPreselect = !activeConversationId && Boolean(current);
  const currentTitle = current
    ? isPendingPreselect
      ? t("git.worktreesSessionPreselectStatus", {
          defaultValue: `已预选工作树: ${cleanedCurrentPath} (${branchName})${current.isDirty ? ` · ${t("git.worktreeDirty")}` : ""}（发送首条消息时自动绑定）`,
          values: {
            path: cleanedCurrentPath,
            branch: branchName,
            dirty: current.isDirty ? ` · ${t("git.worktreeDirty")}` : "",
          },
        })
      : t("git.worktreesSessionStatus", {
          values: {
            path: cleanedCurrentPath,
            branch: branchName,
            dirty: current.isDirty ? ` · ${t("git.worktreeDirty")}` : "",
          },
        })
    : t("git.worktreesUnbound");

  return (
    <div className="worktree-session-selector-container" ref={dropdownRef}>
      <button
        type="button"
        className={`worktree-session-pill-btn ${current ? "is-bound" : ""} ${isPendingPreselect ? "is-pending-preselect" : ""} ${isOpen ? "is-open" : ""} ${isSessionRunning ? "is-disabled" : ""}`}
        disabled={isSessionRunning}
        onClick={() => {
          if (!isSessionRunning) {
            setIsOpen(!isOpen);
          }
        }}
        title={
          isSessionRunning
            ? t("plusMenu.modeLockedRunning", {
                defaultValue: "会话进行中，暂不可切换模式",
              })
            : currentTitle
        }
        aria-label={t("git.worktreesSessionSelector")}
        aria-expanded={isOpen}
      >
        <GitBranch
          size={12}
          className="worktree-pill-icon"
          aria-hidden="true"
        />
        <span className="worktree-pill-text">
          {current
            ? branchName
            : t("git.worktreesTitle", { defaultValue: "Worktree" })}
        </span>
        {current?.isDirty && (
          <span
            className="worktree-pill-dirty-dot"
            title={t("git.worktreeDirty")}
          />
        )}
        <ChevronDown
          size={11}
          className={`worktree-pill-arrow ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div className="worktree-session-dropdown" role="menu">
          <div className="worktree-session-dropdown-header">
            <span>{t("git.worktreesSessionSelector")}</span>
          </div>

          <div className="worktree-session-dropdown-list">
            <button
              type="button"
              role="menuitem"
              className={`worktree-session-dropdown-item ${!current ? "is-active" : ""}`}
              onClick={() => bind(null)}
            >
              <div className="worktree-item-info">
                <div className="worktree-item-title-row">
                  <Unlink size={12} className="text-muted" />
                  <span className="worktree-item-name">
                    {t("git.worktreesUnbound")}
                  </span>
                </div>
                <span className="worktree-item-desc">
                  {t("git.worktreeDefaultMain", {
                    defaultValue: "在主项目根目录运行",
                  })}
                </span>
              </div>
              {!current && <Check size={13} className="worktree-item-check" />}
            </button>

            {worktrees.map((item) => {
              const cleanedPath = formatDisplayPath(item.worktreePath);
              const folderName = getFolderName(cleanedPath);
              const isSelected = current?.worktreeId === item.worktreeId;

              return (
                <button
                  key={item.worktreeId}
                  type="button"
                  role="menuitem"
                  className={`worktree-session-dropdown-item ${isSelected ? "is-active" : ""}`}
                  onClick={() => bind(item.worktreeId)}
                  title={`${item.branchName || t("git.graphDetachedHead")}\n${cleanedPath}`}
                >
                  <div className="worktree-item-info">
                    <div className="worktree-item-title-row">
                      <GitBranch size={12} className="text-primary" />
                      <span className="worktree-item-name">
                        {item.branchName || t("git.graphDetachedHead")}
                      </span>
                      {item.isDirty ? (
                        <span
                          className="worktree-status-badge is-dirty"
                          title={t("git.worktreeDirty")}
                        >
                          <AlertCircle size={9} />
                          {t("git.worktreeDirty")}
                        </span>
                      ) : (
                        <span className="worktree-status-badge is-clean">
                          <CheckCircle2 size={9} />
                          {t("git.graphWorktreeClean", {
                            defaultValue: "干净",
                          })}
                        </span>
                      )}
                    </div>
                    <div className="worktree-item-path-row">
                      <span className="worktree-folder-tag">
                        <FolderGit2 size={9} />
                        {folderName}
                      </span>
                      <code className="worktree-item-path">{cleanedPath}</code>
                    </div>
                  </div>
                  {isSelected && (
                    <Check size={13} className="worktree-item-check" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
