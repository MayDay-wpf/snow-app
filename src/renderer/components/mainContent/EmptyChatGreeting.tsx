import {
  AlertCircle,
  Check,
  CheckCircle2,
  CircleHelp,
  Copy,
  Folder,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Loader2,
  Palette,
  Plug,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { MainContentView } from "./types";
import type {
  GitWorktreeInfo,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import { useI18n } from "../../i18n";
import {
  formatDisplayPath,
  normalizePathForCompare,
} from "../../utils/formatDisplayPath";
import { HelpSkillDisabledDialog } from "../common/HelpSkillDisabledDialog";
import { PixelLogo } from "../common/PixelLogo";
import { useChatConversationContext } from "./chatMessages";
import { rightPanelEvents } from "../rightPanel/rightPanelEvents";
import {
  dismissHelpGuideHint,
  isHelpSkillDisabled,
  markHelpGuideUsed,
  useHelpGuideHint,
} from "../../constants/helpGuide";

/** 提取末级工作树文件夹名称。 */
const getFolderName = (p: string): string => {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
};

type EmptyChatGreetingProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onNavigateToView?: (view: MainContentView) => void;
};

export function EmptyChatGreeting({
  activeDirectory,
  onNavigateToView,
}: EmptyChatGreetingProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    pendingWorktreeId,
    setPendingWorktreeId,
    prefillComposer,
    isDetachedWindow,
  } = useChatConversationContext();
  const showHelpHint = useHelpGuideHint();
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);

  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    const dirId = activeDirectory?.directoryId;
    if (!dirId) {
      setWorktrees([]);
      return;
    }

    const load = (): void => {
      window.snow
        .gitListWorktrees(dirId)
        .then((items) => {
          setWorktrees(items);
        })
        .catch(() => {
          setWorktrees([]);
        });
    };

    load();
    window.addEventListener("snow:worktrees-changed", load);
    return () => {
      window.removeEventListener("snow:worktrees-changed", load);
    };
  }, [activeDirectory?.directoryId]);

  const handleToggleWorktree = useCallback(
    (worktreeId: string): void => {
      if (pendingWorktreeId === worktreeId) {
        setPendingWorktreeId(null);
      } else {
        setPendingWorktreeId(worktreeId);
        const textarea = document.querySelector<HTMLTextAreaElement>(
          ".chat-input-textarea",
        );
        textarea?.focus();
      }
    },
    [pendingWorktreeId, setPendingWorktreeId],
  );

  const handleCopyPath = useCallback((id: string, path: string): void => {
    void window.snow.writeClipboardText(path).then(() => {
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1500);
    });
  }, []);

  const handleOpenTerminal = useCallback((cwd: string): void => {
    rightPanelEvents.emit("open-terminal-command", {
      cwd,
      command: "",
      title: getFolderName(formatDisplayPath(cwd)),
    });
  }, []);

  const handleAddProject = useCallback(async (): Promise<void> => {
    if (isAddingProject) {
      return;
    }

    setIsAddingProject(true);
    setAddProjectError(null);

    try {
      const selectedPath = await window.snow.selectWorkspaceDirectory(
        t("sidebar.selectLocalDirectoryTitle", {
          defaultValue: "Select local workspace directory",
        }),
      );

      if (selectedPath) {
        const trimmedPath = selectedPath.trim();
        const name =
          trimmedPath.split(/[\\/]/).filter(Boolean).pop() || trimmedPath;
        await window.snow.upsertWorkspaceDirectory({
          directoryId: `local:${trimmedPath}`,
          name,
          path: trimmedPath,
          kind: "local",
          isActive: true,
          sortOrder: 0,
          source: "manual",
        });
      }
    } catch (error) {
      setAddProjectError(
        error instanceof Error
          ? error.message
          : t("sidebar.addDirectoryError", {
              defaultValue: "Failed to add workspace directory",
            }),
      );
    } finally {
      setIsAddingProject(false);
    }
  }, [isAddingProject, t]);

  const [isHelpSkillDialogOpen, setIsHelpSkillDialogOpen] = useState(false);

  const handleAskHelp = useCallback((): void => {
    void isHelpSkillDisabled(activeDirectory?.directoryId).then((disabled) => {
      if (disabled) {
        setIsHelpSkillDialogOpen(true);
        return;
      }
      markHelpGuideUsed();
      prefillComposer(t("chatCommand.helpPromptGeneral"));
      document.querySelector<HTMLElement>(".chat-input-textarea")?.focus();
    });
  }, [activeDirectory?.directoryId, prefillComposer, t]);

  return (
    <div className="chat-empty-greeting">
      <div className="chat-empty-greeting-brand">
        <PixelLogo className="chat-empty-greeting-logo" />
      </div>
      <p className="chat-empty-greeting-title">
        {activeDirectory
          ? t("chat.greetingWithProject", {
              defaultValue: "What would you like to work on in {{name}}?",
              values: { name: activeDirectory.name },
            })
          : t("chat.greetingNoProject", {
              defaultValue: "Select a workspace project to get started.",
            })}
      </p>
      {showHelpHint && (
        <div className="chat-empty-help-hint">
          <CircleHelp size={13} strokeWidth={1.8} />
          <span>
            {t("chat.helpHintText", {
              defaultValue: "You can also ask me how to use Snow",
            })}
          </span>
          <button
            className="chat-empty-help-hint-action"
            onClick={handleAskHelp}
            type="button"
          >
            {t("chat.helpHintAsk", { defaultValue: "Ask" })}
          </button>
          <button
            className="chat-empty-help-hint-dismiss"
            onClick={dismissHelpGuideHint}
            type="button"
          >
            {t("chat.helpHintDismiss", { defaultValue: "Don't show again" })}
          </button>
        </div>
      )}
      {worktrees.length > 0 && (
        <div className="chat-empty-worktrees-section">
          <div className="chat-empty-worktrees-header">
            <div className="chat-empty-worktrees-title">
              <FolderGit2
                size={13}
                className="chat-empty-worktrees-title-icon"
              />
              <span>{t("git.worktreesTitle", { defaultValue: "工作树" })}</span>
              <span className="chat-empty-worktrees-badge">
                {worktrees.length}
              </span>
            </div>
            <span className="chat-empty-worktrees-hint">
              {pendingWorktreeId
                ? t("chat.worktreeSelectedHint", {
                    defaultValue: "已预选工作树，发送消息将在此工作树下执行",
                  })
                : t("chat.selectWorktreeHint", {
                    defaultValue: "选择工作树开启独立会话，或直接在输入框提问",
                  })}
            </span>
          </div>

          <div className="chat-empty-worktrees-grid">
            {worktrees.map((wt) => {
              const isSelected = pendingWorktreeId === wt.worktreeId;
              const isMain =
                normalizePathForCompare(wt.worktreePath) ===
                normalizePathForCompare(activeDirectory?.path || "");
              const cleanedPath = formatDisplayPath(wt.worktreePath);
              const folderName = getFolderName(cleanedPath);
              const isCopied = copiedId === wt.worktreeId;

              return (
                <div
                  key={wt.worktreeId}
                  className={`chat-empty-worktree-card ${
                    isSelected ? "is-selected" : ""
                  } ${isMain ? "is-main" : ""}`}
                  onClick={() => handleToggleWorktree(wt.worktreeId)}
                  role="button"
                  tabIndex={0}
                  title={`${wt.branchName || t("git.graphDetachedHead", { defaultValue: "游离 HEAD" })}\n${cleanedPath}`}
                >
                  <div className="chat-empty-worktree-card-top">
                    <div className="chat-empty-worktree-branch">
                      <GitBranch
                        size={13}
                        className={
                          isSelected ? "branch-icon-active" : "branch-icon"
                        }
                      />
                      <span className="chat-empty-worktree-name">
                        {wt.branchName ||
                          t("git.graphDetachedHead", {
                            defaultValue: "游离 HEAD",
                          })}
                      </span>
                      {isMain && (
                        <span className="chat-empty-worktree-main-badge">
                          {t("git.mainDirectory", { defaultValue: "主目录" })}
                        </span>
                      )}
                    </div>
                    {wt.isDirty ? (
                      <span
                        className="chat-empty-worktree-status-badge is-dirty"
                        title={t("git.worktreeDirty")}
                      >
                        <AlertCircle size={10} />
                        <span>{t("git.worktreeDirty")}</span>
                      </span>
                    ) : (
                      <span className="chat-empty-worktree-status-badge is-clean">
                        <CheckCircle2 size={10} />
                        <span>
                          {t("git.graphWorktreeClean", {
                            defaultValue: "干净",
                          })}
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="chat-empty-worktree-card-bottom">
                    <div
                      className="chat-empty-worktree-path-info"
                      title={cleanedPath}
                    >
                      <Folder size={11} className="folder-icon" />
                      <span className="chat-empty-worktree-folder-text">
                        {folderName}
                      </span>
                    </div>
                    <div
                      className="chat-empty-worktree-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="chat-empty-wt-action-btn"
                        onClick={() =>
                          handleCopyPath(wt.worktreeId, wt.worktreePath)
                        }
                        title={t("git.copyWorktreePath", {
                          defaultValue: "复制完整路径",
                        })}
                      >
                        {isCopied ? (
                          <Check size={11} className="text-green-500" />
                        ) : (
                          <Copy size={11} />
                        )}
                      </button>
                      <button
                        type="button"
                        className="chat-empty-wt-action-btn"
                        onClick={() => handleOpenTerminal(wt.worktreePath)}
                        title={t("git.openTerminal", {
                          defaultValue: "在此工作树打开终端",
                        })}
                      >
                        <Terminal size={11} />
                      </button>
                    </div>
                  </div>

                  {isSelected && (
                    <div
                      className="chat-empty-worktree-selected-indicator"
                      title={t("chat.worktreeSelectedActive", {
                        defaultValue: "当前已选定",
                      })}
                    >
                      <Check size={11} strokeWidth={2.5} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {!isDetachedWindow && (
        <div className="chat-empty-quick-actions">
          <button
            className="chat-empty-quick-card"
            type="button"
            disabled={isAddingProject}
            onClick={() => void handleAddProject()}
          >
            <span className="chat-empty-quick-card-icon">
              {isAddingProject ? (
                <Loader2 size={15} strokeWidth={1.8} className="spin" />
              ) : (
                <FolderPlus size={15} strokeWidth={1.8} />
              )}
            </span>
            <span className="chat-empty-quick-card-text">
              <span className="chat-empty-quick-card-title">
                {t("chat.quickActionAddProject", {
                  defaultValue: "Add a project",
                })}
              </span>
              <span className="chat-empty-quick-card-desc">
                {t("chat.quickActionAddProjectDesc", {
                  defaultValue: "Open a local workspace directory",
                })}
              </span>
            </span>
          </button>
          <button
            className="chat-empty-quick-card is-api"
            type="button"
            onClick={() => onNavigateToView?.("api-settings")}
          >
            <span className="chat-empty-quick-card-icon">
              <Plug size={15} strokeWidth={1.8} />
            </span>
            <span className="chat-empty-quick-card-text">
              <span className="chat-empty-quick-card-title">
                {t("chat.quickActionConfigApi", {
                  defaultValue: "Configure AI API",
                })}
              </span>
              <span className="chat-empty-quick-card-desc">
                {t("chat.quickActionConfigApiDesc", {
                  defaultValue: "Set up providers, models and credentials",
                })}
              </span>
            </span>
          </button>
          <button
            className="chat-empty-quick-card is-theme"
            type="button"
            onClick={() => onNavigateToView?.("theme-settings")}
          >
            <span className="chat-empty-quick-card-icon">
              <Palette size={15} strokeWidth={1.8} />
            </span>
            <span className="chat-empty-quick-card-text">
              <span className="chat-empty-quick-card-title">
                {t("chat.quickActionCustomizeTheme", {
                  defaultValue: "Customize appearance",
                })}
              </span>
              <span className="chat-empty-quick-card-desc">
                {t("chat.quickActionCustomizeThemeDesc", {
                  defaultValue: "Choose theme, light or dark mode",
                })}
              </span>
            </span>
          </button>
        </div>
      )}
      {addProjectError ? (
        <p className="chat-empty-quick-error">{addProjectError}</p>
      ) : null}
      <HelpSkillDisabledDialog
        open={isHelpSkillDialogOpen}
        onClose={() => setIsHelpSkillDialogOpen(false)}
      />
    </div>
  );
}
