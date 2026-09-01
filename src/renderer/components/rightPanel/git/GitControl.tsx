import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Copy,
  Diff,
  FolderOpen,
  GitCommitHorizontal,
  GitGraph as GitGraphIcon,
  Loader2,
  RefreshCw,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import type {
  GitCommitFile,
  GitFileStatus,
  GitRepoInfo,
  GitStatusResult,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { useGitStatus } from "./useGitStatus";
import { useRemotePolling } from "./useRemotePolling";
import { BranchSelector } from "./BranchSelector";
import { GitFileList } from "./GitFileList";
import { GitGraph } from "./GitGraph";
import { RepoSelector } from "./RepoSelector";
import type { OpenDiffTabCallback } from "../types";

type GitControlProps = {
  repoPath: string | undefined | null;
  repos?: GitRepoInfo[];
  onRepoSelect?: (path: string) => void;
  /** 点击变更区/暂存区文件：回调携带点击来源，供上层区分 diff 类型。 */
  onFileSelect: (
    file: GitFileStatus | null,
    section?: "staged" | "unstaged",
  ) => void;
  /** 提交树中点击提交内文件，请求查看该提交中该文件的差异。 */
  onCommitFileSelect?: (
    file: GitCommitFile,
    hash: string,
    parentHash: string | null,
  ) => void;
  onStatusChange?: (status: GitStatusResult | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  /** 在文件所在目录打开终端。 */
  onOpenTerminal?: (cwd: string) => void;
  /** 在新标签页打开提交内文件的 Diff。 */
  onOpenInTab?: OpenDiffTabCallback;
};

const isSelectedKey = (section: "staged" | "unstaged", path: string) =>
  `${section}:${path}`;

// ===== 提交信息草稿缓存（模块级，按仓库路径隔离） =====
// 提交信息跟随项目：切换项目或折叠右面板时 GitControl 可能重新挂载，
// 草稿统一存放在模块级 Map 中，切换项目后只显示目标仓库自己的草稿，
// 切回时从缓存回显；空草稿直接从缓存移除，避免 Map 无限增长。
const commitMessageDrafts = new Map<string, string>();

// 正在生成提交消息的仓库 → 流 ID。生成状态同样放在模块级：用户切换
// 项目后旧仓库的 AI 生成在后台继续，迟到的流式分片写入旧仓库缓存，
// 切回时能看到完整结果；并发流（切走后新仓库再生成）互不干扰。
const commitMsgGenerations = new Map<string, string>();

type CommitMsgGenerationListener = () => void;
const commitMsgGenerationListeners = new Set<CommitMsgGenerationListener>();

const startCommitMsgGeneration = (repo: string): void => {
  commitMsgGenerations.set(repo, "");
  for (const listener of commitMsgGenerationListeners) {
    listener();
  }
};

const endCommitMsgGeneration = (repo: string): void => {
  commitMsgGenerations.delete(repo);
  for (const listener of commitMsgGenerationListeners) {
    listener();
  }
};

export const GitControl = ({
  repoPath,
  repos,
  onRepoSelect,
  onFileSelect,
  onCommitFileSelect,
  onStatusChange,
  onOpenFile,
  onOpenTerminal,
  onOpenInTab,
}: GitControlProps): React.JSX.Element => {
  const { t } = useI18n();
  const { status, isLoading, error, refresh } = useGitStatus(repoPath);
  // Keep ahead/behind counts fresh by periodically fetching from the
  // remote; a successful fetch refreshes the status so the pull button
  // badge reflects the latest remote state.
  useRemotePolling(repoPath, refresh);
  // 提交信息草稿：state 只表达“当前显示值”，权威存储是模块级
  // commitMessageDrafts 缓存（按仓库路径隔离）。挂载时回显缓存，
  // 折叠右面板后重新展开草稿也不丢失。
  const [commitMessage, setCommitMessage] = useState<string>(() => {
    const initialRepo = repoPath ?? null;
    return initialRepo ? (commitMessageDrafts.get(initialRepo) ?? "") : "";
  });
  // 提交按钮模式：仅提交，或提交并推送。选择持久化在 localStorage，
  // 下次启动应用时自动复原。
  const [commitMode, setCommitMode] = useState<"commit" | "commitAndPush">(
    () =>
      localStorage.getItem("git-commit-mode") === "commitAndPush"
        ? "commitAndPush"
        : "commit",
  );
  const handleSelectCommitMode = useCallback(
    (mode: "commit" | "commitAndPush") => {
      setCommitModeMenu(null);
      setCommitMode(mode);
      try {
        localStorage.setItem("git-commit-mode", mode);
      } catch {
        // localStorage 不可用时静默忽略，模式仅本次会话生效。
      }
    },
    [],
  );
  // 提交按钮右侧下拉菜单的弹出位置（viewport 坐标）。
  const [commitModeMenu, setCommitModeMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [actionInProgress, setActionInProgress] = useState<
    | "commit"
    | "push"
    | "pull"
    | "stage"
    | "unstage"
    | "stageAll"
    | "unstageAll"
    | "discard"
    | null
  >(null);
  // “当前仓库是否正在生成提交消息”。权威状态在模块级
  // commitMsgGenerations，本 state 通过下方的订阅 effect 同步，
  // 后台生成（切走后仍在跑的流）结束或开始时 UI 都能正确恢复。
  const [isGeneratingCommitMsg, setIsGeneratingCommitMsg] = useState(
    () => repoPath != null && commitMsgGenerations.has(repoPath),
  );
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [discardTarget, setDiscardTarget] = useState<GitFileStatus[]>([]);
  const [operationError, setOperationError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  // 顶部操作区（刷新/拉取/推送等图标按钮）右键菜单：提供与按钮一致的
  // Git 操作入口，外加仓库路径复制/文件管理器/终端快捷项。
  const [actionsContextMenu, setActionsContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const lastClickedPathRef = useRef<string | null>(null);
  const lastClickedSectionRef = useRef<"staged" | "unstaged" | null>(null);
  const prevStatusRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set to true after a commit succeeds; the effect below resets scroll
  // to top once the refreshed status has been applied to the DOM.
  const commitPendingRef = useRef(false);
  const [viewMode, setViewMode] = useState<"changes" | "graph">("changes");
  // Spins the toolbar refresh button until the current view's refresh
  // settles: status fetch always, plus the GitGraph reload when the graph
  // view is active. graphLoadedResolveRef bridges the GitGraph onLoaded
  // callback into the refresh promise chain.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  const graphLoadedResolveRef = useRef<(() => void) | null>(null);

  // 渲染期间同步“当前显示的仓库”。repoPath 变化的那一次渲染里
  // currentRepoRef 先指向旧仓库、随即更新为新仓库；配合
  // displayedCommitMessage 派生值，切换瞬间直接显示目标仓库的缓存
  // 草稿，避免旧项目消息在新项目输入框闪现一帧。
  const currentRepoRef = useRef<string | null>(repoPath ?? null);
  const repoSwitched = currentRepoRef.current !== (repoPath ?? null);
  currentRepoRef.current = repoPath ?? null;
  const displayedCommitMessage =
    repoSwitched && repoPath
      ? (commitMessageDrafts.get(repoPath) ?? "")
      : commitMessage;

  // 跟随项目切换：把显示值同步为当前仓库的缓存草稿（无缓存则清空），
  // 并同步该仓库的 AI 生成状态（切回时可能仍在后台生成）。
  useEffect(() => {
    setCommitMessage(repoPath ? (commitMessageDrafts.get(repoPath) ?? "") : "");
    setIsGeneratingCommitMsg(
      repoPath != null && commitMsgGenerations.has(repoPath),
    );
  }, [repoPath]);

  // 订阅模块级生成状态广播：任意仓库的生成开始/结束都会通知，
  // isGeneratingCommitMsg 始终反映“当前仓库”的实时状态（包括切走后
  // 在后台继续的流）。
  useEffect(() => {
    const listener = (): void => {
      const repo = currentRepoRef.current;
      setIsGeneratingCommitMsg(repo != null && commitMsgGenerations.has(repo));
    };
    commitMsgGenerationListeners.add(listener);
    return () => {
      commitMsgGenerationListeners.delete(listener);
    };
  }, []);

  // 统一写入草稿：先写模块级缓存（按仓库路径隔离），仅当目标仓库
  // 仍是当前显示的仓库时才同步 UI。切换项目后，旧项目迟到的 AI
  // 流式分片只会进入旧项目的缓存，不会污染新项目的输入框。
  const applyCommitMessage = useCallback(
    (repo: string, value: string): void => {
      if (value) {
        commitMessageDrafts.set(repo, value);
      } else {
        commitMessageDrafts.delete(repo);
      }
      if (repo === currentRepoRef.current) {
        setCommitMessage(value);
      }
    },
    [],
  );

  // Propagate status changes upward via ref to avoid render-cycle side effects
  useEffect(() => {
    if (!onStatusChange) {
      return;
    }
    const serialized = status ? JSON.stringify(status) : null;
    if (serialized !== prevStatusRef.current) {
      prevStatusRef.current = serialized;
      onStatusChange(status);
    }
  }, [status, onStatusChange]);

  // After a commit, the staged file list shrinks which can leave a large
  // empty gap if the user had scrolled down. When commitPendingRef is set,
  // reset scroll to top once the refreshed status has rendered.
  useEffect(() => {
    if (!commitPendingRef.current) {
      return;
    }
    commitPendingRef.current = false;
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0 });
    }
  }, [status]);

  // Prune selectedPaths that are no longer present in the current status.
  // Keys are stored as "section:path" composite keys.
  useEffect(() => {
    if (!status) {
      return;
    }
    const stagedPaths = new Set(
      status.files
        .filter(
          (f) =>
            f.indexStatus !== " " &&
            f.indexStatus !== "?" &&
            f.indexStatus !== "",
        )
        .map((f) => f.path),
    );
    const unstagedPaths = new Set(
      status.files
        .filter(
          (f) =>
            f.workdirStatus === "?" ||
            (f.workdirStatus !== " " && f.workdirStatus !== ""),
        )
        .map((f) => f.path),
    );
    setSelectedPaths((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      let changed = false;
      const next = new Set<string>();
      for (const key of prev) {
        const colonIdx = key.indexOf(":");
        if (colonIdx === -1) {
          changed = true;
          continue;
        }
        const sec = key.slice(0, colonIdx);
        const path = key.slice(colonIdx + 1);
        const valid =
          (sec === "staged" && stagedPaths.has(path)) ||
          (sec === "unstaged" && unstagedPaths.has(path));
        if (valid) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [status]);

  const handleStatusChange = useCallback(() => {
    refresh();
  }, [refresh]);

  // Manual refresh: re-fetch status and, when the graph view is active,
  // also force GitGraph to reload its history. The spinner runs until BOTH
  // settle. GitGraph is only mounted in graph mode, so its onLoaded is
  // bridged through graphLoadedResolveRef and only awaited there; in
  // changes mode the status promise alone stops the spinner.
  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    const statusPromise = refresh();
    if (viewMode === "graph") {
      setGraphRefreshKey((key) => key + 1);
      const graphPromise = new Promise<void>((resolve) => {
        graphLoadedResolveRef.current = resolve;
      });
      void Promise.all([statusPromise, graphPromise]).finally(() => {
        setIsRefreshing(false);
      });
    } else {
      void statusPromise.finally(() => {
        setIsRefreshing(false);
      });
    }
  }, [refresh, viewMode]);

  const handleGraphLoaded = useCallback(() => {
    const resolve = graphLoadedResolveRef.current;
    graphLoadedResolveRef.current = null;
    resolve?.();
  }, []);

  // Switching views unmounts GitGraph (graph -> changes), so its onLoaded
  // callback will never fire; resolve any pending graph wait and stop the
  // spinner regardless of direction — remounting into graph mode reloads
  // on its own.
  const handleToggleViewMode = useCallback(() => {
    setViewMode((prev) => (prev === "graph" ? "changes" : "graph"));
    graphLoadedResolveRef.current?.();
    graphLoadedResolveRef.current = null;
    setIsRefreshing(false);
  }, []);

  const handleFileSelect = useCallback(
    (
      file: GitFileStatus,
      e: React.MouseEvent,
      section: "staged" | "unstaged",
    ) => {
      const isMulti = e.metaKey || e.ctrlKey;
      const isRange = e.shiftKey;
      const fileLists = status?.files ?? [];
      const key = isSelectedKey(section, file.path);

      setSelectedPaths((prev) => {
        const next = new Set(prev);

        if (isRange && lastClickedPathRef.current !== null) {
          // Range select: select all files between last clicked and current.
          // Only operate within the same section to avoid cross-section leakage.
          const lastKey = lastClickedPathRef.current;
          const sameSection = lastClickedSectionRef.current === section;
          const lastKeyPath = lastKey.includes(":")
            ? lastKey.slice(lastKey.indexOf(":") + 1)
            : lastKey;
          const sectionFiles = fileLists.filter((f) =>
            section === "staged"
              ? f.indexStatus !== " " &&
                f.indexStatus !== "?" &&
                f.indexStatus !== ""
              : f.workdirStatus === "?" ||
                (f.workdirStatus !== " " && f.workdirStatus !== ""),
          );
          const lastIndex = sameSection
            ? sectionFiles.findIndex((f) => f.path === lastKeyPath)
            : -1;
          const currentIndex = sectionFiles.findIndex(
            (f) => f.path === file.path,
          );
          if (lastIndex !== -1 && currentIndex !== -1) {
            const start = Math.min(lastIndex, currentIndex);
            const end = Math.max(lastIndex, currentIndex);
            // If not multi-selecting, clear previous selection first
            if (!isMulti) {
              next.clear();
            }
            for (let i = start; i <= end; i++) {
              next.add(isSelectedKey(section, sectionFiles[i].path));
            }
          } else if (!isMulti) {
            next.clear();
            next.add(key);
          } else {
            next.add(key);
          }
          lastClickedPathRef.current = key;
          lastClickedSectionRef.current = section;
          return next;
        }

        if (isMulti) {
          if (next.has(key)) {
            next.delete(key);
          } else {
            next.add(key);
          }
        } else {
          next.clear();
          next.add(key);
        }

        lastClickedPathRef.current = key;
        lastClickedSectionRef.current = section;
        return next;
      });

      // Notify parent for diff display - send the clicked file and the
      // section it was clicked in, so the parent can pick the right diff
      // (staged vs worktree) even when the same path exists in both lists.
      onFileSelect(file, section);
    },
    [status, onFileSelect],
  );

  const handleOpenFile = useCallback(
    (file: GitFileStatus) => {
      if (!repoPath || !onOpenFile) {
        return;
      }
      const base = repoPath.replace(/[\\/]+$/, "");
      const absolutePath = `${base}/${file.path}`;
      const lastSep = Math.max(
        file.path.lastIndexOf("/"),
        file.path.lastIndexOf("\\"),
      );
      const fileName =
        lastSep === -1 ? file.path : file.path.slice(lastSep + 1);
      onOpenFile(absolutePath, fileName);
    },
    [repoPath, onOpenFile],
  );

  const handleStageToggle = useCallback(
    (files: GitFileStatus[], section: "staged" | "unstaged") => {
      if (!repoPath || files.length === 0) {
        return;
      }

      const isStaged = section === "staged";
      const paths = files.map((f) => f.path);

      setActionInProgress(isStaged ? "unstage" : "stage");
      if (isStaged) {
        window.snow
          .gitUnstage(repoPath, paths)
          .then((result) => {
            if (result.success) {
              setSelectedPaths(new Set());
              refresh();
            }
          })
          .finally(() => setActionInProgress(null));
      } else {
        window.snow
          .gitStage(repoPath, paths)
          .then((result) => {
            if (result.success) {
              setSelectedPaths(new Set());
              refresh();
            }
          })
          .finally(() => setActionInProgress(null));
      }
    },
    [repoPath, refresh],
  );

  const handleStageAll = useCallback(() => {
    if (!repoPath) {
      return;
    }
    setActionInProgress("stageAll");
    window.snow
      .gitStageAll(repoPath)
      .then(() => {
        setSelectedPaths(new Set());
        refresh();
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, refresh]);

  const handleUnstageAll = useCallback(() => {
    if (!repoPath) {
      return;
    }
    setActionInProgress("unstageAll");
    window.snow
      .gitUnstageAll(repoPath)
      .then(() => {
        setSelectedPaths(new Set());
        refresh();
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, refresh]);

  const handleCommit = useCallback(() => {
    if (!repoPath || !displayedCommitMessage.trim()) {
      return;
    }
    setActionInProgress("commit");
    const shouldPush = commitMode === "commitAndPush";
    window.snow
      .gitCommit(repoPath, displayedCommitMessage)
      .then((result) => {
        if (!result.success) {
          return;
        }
        // 清空的是“该仓库”的草稿：若提交期间已切换项目，UI 不受影响。
        applyCommitMessage(repoPath, "");
        commitPendingRef.current = true;
        // 提交并推送模式下，提交成功后紧接着推送。
        if (shouldPush) {
          return window.snow.gitPush(repoPath);
        }
        return null;
      })
      .then((pushResult) => {
        if (pushResult) {
          if (pushResult.success) {
            refresh();
          } else {
            setOperationError({
              title: t("git.pushFailed"),
              message: pushResult.message,
            });
          }
        } else {
          refresh();
        }
      })
      .catch((err: unknown) => {
        setOperationError({
          title: t("git.pushFailed"),
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setActionInProgress(null));
  }, [
    repoPath,
    displayedCommitMessage,
    commitMode,
    refresh,
    t,
    applyCommitMessage,
  ]);

  const handlePush = useCallback(() => {
    if (!repoPath) {
      return;
    }
    setActionInProgress("push");
    window.snow
      .gitPush(repoPath)
      .then((result) => {
        if (result.success) {
          refresh();
        } else {
          setOperationError({
            title: t("git.pushFailed"),
            message: result.message,
          });
        }
      })
      .catch((err: unknown) => {
        setOperationError({
          title: t("git.pushFailed"),
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, refresh, t]);

  const handlePull = useCallback(() => {
    if (!repoPath) {
      return;
    }
    setActionInProgress("pull");
    window.snow
      .gitPull(repoPath)
      .then((result) => {
        if (result.success) {
          refresh();
        } else {
          setOperationError({
            title: t("git.pullFailed"),
            message: result.message,
          });
        }
      })
      .catch((err: unknown) => {
        setOperationError({
          title: t("git.pullFailed"),
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, refresh, t]);

  const handleDiscardRequest = useCallback((files: GitFileStatus[]) => {
    if (files.length === 0) {
      return;
    }
    setDiscardTarget(files);
  }, []);

  const handleDiscardConfirm = useCallback(() => {
    if (!repoPath || discardTarget.length === 0) {
      return;
    }
    const paths = discardTarget.map((f) => f.path);
    setDiscardTarget([]);
    setActionInProgress("discard");
    window.snow
      .gitDiscardChanges(repoPath, paths)
      .then(() => {
        setSelectedPaths(new Set());
        refresh();
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, discardTarget, refresh]);

  const handleDiscardCancel = useCallback(() => {
    setDiscardTarget([]);
  }, []);

  const handleDismissError = useCallback(() => {
    setOperationError(null);
  }, []);

  /** 顶部操作区（刷新/拉取/推送等图标）右键菜单。 */
  const buildActionsMenuItems = (): ContextMenuItem[] => {
    const busy = actionInProgress !== null;
    const repoBase = repoPath ?? "";
    return [
      {
        id: "refresh",
        label: t("git.refresh"),
        icon: <RefreshCw size={13} strokeWidth={1.8} />,
        disabled: busy || isRefreshing,
        onClick: () => {
          setActionsContextMenu(null);
          handleRefresh();
        },
      },
      {
        id: "pull",
        label: t("git.pull"),
        icon: <ArrowDownToLine size={13} strokeWidth={1.8} />,
        disabled: busy,
        onClick: () => {
          setActionsContextMenu(null);
          handlePull();
        },
      },
      {
        id: "push",
        label: t("git.push"),
        icon: <ArrowUpFromLine size={13} strokeWidth={1.8} />,
        disabled: busy,
        onClick: () => {
          setActionsContextMenu(null);
          handlePush();
        },
      },
      {
        id: "copy-repo-path",
        separator: true,
        label: t("git.copyRepoPath", {
          defaultValue: "Copy Repository Path",
        }),
        icon: <Copy size={13} strokeWidth={1.8} />,
        disabled: !repoBase,
        onClick: () => {
          setActionsContextMenu(null);
          void window.snow.writeClipboardText(repoBase).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "reveal-repo",
        label: t("git.revealInExplorer", {
          defaultValue: "Show in Explorer",
        }),
        icon: <FolderOpen size={13} strokeWidth={1.8} />,
        disabled: !repoBase,
        onClick: () => {
          setActionsContextMenu(null);
          void window.snow.showItemInFolder(repoBase).catch(() => {
            // 打开文件管理器失败时静默忽略。
          });
        },
      },
      ...(onOpenTerminal
        ? [
            {
              id: "open-terminal",
              label: t("git.openInTerminal", {
                defaultValue: "Open in Terminal",
              }),
              icon: <TerminalIcon size={13} strokeWidth={1.8} />,
              disabled: !repoBase,
              onClick: () => {
                setActionsContextMenu(null);
                onOpenTerminal(repoBase);
              },
            },
          ]
        : []),
    ];
  };

  const handleGenerateCommitMessage = useCallback(() => {
    // 生成绑定到发起时的仓库：同一仓库不重复生成；切换项目后旧仓库
    // 的生成在后台继续，结果只写入旧仓库的缓存。
    const targetRepo = repoPath;
    if (!targetRepo || commitMsgGenerations.has(targetRepo)) {
      return;
    }

    startCommitMsgGeneration(targetRepo);
    applyCommitMessage(targetRepo, "");

    window.snow
      .generateCommitMessage(
        targetRepo,
        (chunk) => {
          if (chunk.contentDelta) {
            const next =
              (commitMessageDrafts.get(targetRepo) ?? "") + chunk.contentDelta;
            applyCommitMessage(targetRepo, next);
          }
        },
        (streamId) => {
          commitMsgGenerations.set(targetRepo, streamId);
        },
      )
      .then((result) => {
        if (result.status === "error") {
          applyCommitMessage(targetRepo, "");
        } else if (result.content) {
          applyCommitMessage(targetRepo, result.content);
        }
      })
      .catch(() => {
        // 出错或取消：保留已流式生成的内容（已写入缓存），切回时可回显。
      })
      .finally(() => {
        endCommitMsgGeneration(targetRepo);
      });
  }, [repoPath, applyCommitMessage]);

  const handleAbortCommitMessage = useCallback(() => {
    const repo = currentRepoRef.current;
    if (!repo) {
      return;
    }
    const streamId = commitMsgGenerations.get(repo);
    if (streamId) {
      void window.snow.abortCommitMessage(streamId);
    }
  }, []);

  if (!repoPath) {
    return (
      <div className="git-control">
        <div className="git-control-empty">{t("git.noWorkspaceDirectory")}</div>
      </div>
    );
  }

  if (isLoading && !status) {
    return (
      <div className="git-control">
        <div className="git-control-loading">{t("git.loadingStatus")}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git-control">
        <div className="git-control-error">{t(error)}</div>
      </div>
    );
  }

  if (!status || !status.isRepo) {
    return (
      <div className="git-control">
        <div className="git-control-empty">{t("git.notARepo")}</div>
      </div>
    );
  }

  const stagedFiles = status.files.filter(
    (f) =>
      f.indexStatus !== " " && f.indexStatus !== "?" && f.indexStatus !== "",
  );
  const unstagedFiles = status.files.filter(
    (f) =>
      f.workdirStatus === "?" ||
      (f.workdirStatus !== " " && f.workdirStatus !== ""),
  );

  return (
    <div className="git-control">
      <div className="git-control-top">
        {repos && repos.length > 1 && onRepoSelect && (
          <div className="git-repo-selector-bar">
            <RepoSelector
              repos={repos}
              selectedRepoPath={repoPath ?? null}
              onSelect={onRepoSelect}
              onOpenTerminal={onOpenTerminal}
            />
          </div>
        )}
        <div className="git-control-header">
          <BranchSelector
            repoPath={repoPath}
            currentBranch={status.currentBranch}
            onBranchChanged={handleStatusChange}
          />
          <div
            className="git-control-actions"
            onContextMenu={(e) => {
              e.preventDefault();
              setActionsContextMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <button
              type="button"
              className="icon-btn git-action-btn"
              onClick={handleRefresh}
              disabled={actionInProgress !== null || isRefreshing}
              title={t("git.refresh")}
            >
              {isRefreshing ? (
                <Loader2 size={14} strokeWidth={1.8} className="spin" />
              ) : (
                <RefreshCw size={14} strokeWidth={1.8} />
              )}
            </button>
            <button
              type="button"
              className="icon-btn git-action-btn"
              onClick={handlePull}
              disabled={actionInProgress !== null}
              title={
                status.behind > 0
                  ? t("git.pullBehind", { values: { count: status.behind } })
                  : t("git.pull")
              }
            >
              {actionInProgress === "pull" ? (
                <Loader2 size={14} strokeWidth={1.8} className="spin" />
              ) : (
                <ArrowDownToLine size={14} strokeWidth={1.8} />
              )}
              {status.behind > 0 && (
                <span className="git-pull-badge" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="icon-btn git-action-btn"
              onClick={handlePush}
              disabled={actionInProgress !== null}
              title={t("git.push")}
            >
              {actionInProgress === "push" ? (
                <Loader2 size={14} strokeWidth={1.8} className="spin" />
              ) : (
                <ArrowUpFromLine size={14} strokeWidth={1.8} />
              )}
            </button>
            <button
              type="button"
              className={`icon-btn git-action-btn${
                viewMode === "graph" ? " active" : ""
              }`}
              onClick={handleToggleViewMode}
              title={viewMode === "graph" ? t("git.changes") : t("git.graph")}
            >
              {viewMode === "graph" ? (
                <Diff size={14} strokeWidth={1.8} />
              ) : (
                <GitGraphIcon size={14} strokeWidth={1.8} />
              )}
            </button>
          </div>
        </div>

        {(status.ahead > 0 || status.behind > 0) && (
          <div className="git-sync-status">
            {status.ahead > 0 && (
              <span className="git-sync-ahead">
                {t("git.ahead", { values: { count: status.ahead } })}
              </span>
            )}
            {status.behind > 0 && (
              <span className="git-sync-behind">
                {t("git.behind", { values: { count: status.behind } })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="git-control-scroll" ref={scrollRef}>
        {viewMode === "changes" ? (
          <>
            <GitFileList
              repoPath={repoPath}
              files={unstagedFiles}
              section="unstaged"
              selectedPaths={selectedPaths}
              actionInProgress={actionInProgress}
              onFileSelect={handleFileSelect}
              onStageToggle={handleStageToggle}
              onStageAll={handleStageAll}
              onDiscard={handleDiscardRequest}
              onOpenFile={handleOpenFile}
              onOpenTerminal={onOpenTerminal}
            />

            <GitFileList
              repoPath={repoPath}
              files={stagedFiles}
              section="staged"
              selectedPaths={selectedPaths}
              actionInProgress={actionInProgress}
              onFileSelect={handleFileSelect}
              onStageToggle={handleStageToggle}
              onUnstageAll={handleUnstageAll}
              onOpenFile={handleOpenFile}
              onOpenTerminal={onOpenTerminal}
            />

            <div className="git-commit-section">
              <div className="git-commit-input-wrapper">
                <textarea
                  className="git-commit-input"
                  placeholder={t("git.commitMessagePlaceholder")}
                  value={displayedCommitMessage}
                  onChange={(e) => applyCommitMessage(repoPath, e.target.value)}
                  rows={1}
                />
                <div className="git-commit-input-actions">
                  <button
                    type="button"
                    className="git-commit-btn git-ai-commit-btn"
                    onClick={
                      isGeneratingCommitMsg
                        ? handleAbortCommitMessage
                        : handleGenerateCommitMessage
                    }
                    disabled={
                      !isGeneratingCommitMsg &&
                      (actionInProgress !== null || stagedFiles.length === 0)
                    }
                  >
                    {isGeneratingCommitMsg ? (
                      <Square size={14} strokeWidth={1.8} />
                    ) : (
                      <Sparkles size={14} strokeWidth={1.8} />
                    )}
                  </button>
                </div>
              </div>
              <div className="git-commit-actions">
                <div className="git-commit-split-btn">
                  <button
                    type="button"
                    className="git-commit-btn"
                    onClick={handleCommit}
                    disabled={
                      actionInProgress !== null ||
                      isGeneratingCommitMsg ||
                      !displayedCommitMessage.trim() ||
                      stagedFiles.length === 0
                    }
                  >
                    {actionInProgress === "commit" ? (
                      <Loader2 size={14} strokeWidth={1.8} className="spin" />
                    ) : (
                      <GitCommitHorizontal size={14} strokeWidth={1.8} />
                    )}
                    <span>
                      {commitMode === "commitAndPush"
                        ? t("git.commitAndPush")
                        : t("git.commit")}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="git-commit-mode-toggle"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCommitModeMenu({ x: e.clientX, y: e.clientY });
                    }}
                    disabled={
                      actionInProgress !== null || isGeneratingCommitMsg
                    }
                    title={t("git.commitMode")}
                  >
                    <ChevronDown size={14} strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <GitGraph
            repoPath={repoPath}
            refreshKey={graphRefreshKey}
            onLoaded={handleGraphLoaded}
            onCommitFileSelect={onCommitFileSelect}
            onOpenInTab={onOpenInTab}
          />
        )}
      </div>

      <ConfirmDialog
        open={discardTarget.length > 0}
        title={t("git.discardTitle")}
        message={t("git.discardConfirm", {
          values: { count: discardTarget.length },
        })}
        confirmLabel={t("git.discardConfirmBtn")}
        cancelLabel={t("git.discardCancelBtn")}
        onConfirm={handleDiscardConfirm}
        onCancel={handleDiscardCancel}
      />

      {actionsContextMenu && (
        <ContextMenu
          x={actionsContextMenu.x}
          y={actionsContextMenu.y}
          items={buildActionsMenuItems()}
          onClose={() => setActionsContextMenu(null)}
        />
      )}

      {commitModeMenu && (
        <ContextMenu
          x={commitModeMenu.x}
          y={commitModeMenu.y}
          items={[
            {
              id: "mode-commit",
              label: t("git.commit"),
              icon: (
                <Check
                  size={13}
                  strokeWidth={1.8}
                  style={
                    commitMode === "commit"
                      ? undefined
                      : { visibility: "hidden" }
                  }
                />
              ),
              onClick: () => handleSelectCommitMode("commit"),
            },
            {
              id: "mode-commit-and-push",
              label: t("git.commitAndPush"),
              icon: (
                <Check
                  size={13}
                  strokeWidth={1.8}
                  style={
                    commitMode === "commitAndPush"
                      ? undefined
                      : { visibility: "hidden" }
                  }
                />
              ),
              onClick: () => handleSelectCommitMode("commitAndPush"),
            },
          ]}
          onClose={() => setCommitModeMenu(null)}
        />
      )}

      <ConfirmDialog
        open={operationError !== null}
        variant="danger"
        title={operationError?.title ?? ""}
        message={operationError?.message ?? ""}
        confirmLabel={t("git.errorDismiss")}
        onConfirm={handleDismissError}
        onCancel={handleDismissError}
      />
    </div>
  );
};
