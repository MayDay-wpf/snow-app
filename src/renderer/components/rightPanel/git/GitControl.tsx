import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Copy,
  FolderTree,
  FolderOpen,
  GitCommitHorizontal,
  List,
  Loader2,
  RefreshCw,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import { Tooltip } from "../../common/Tooltip";
import type {
  GitFileStatus,
  GitRemoteInfo,
  GitRepoInfo,
  GitStageResult,
  GitStatusResult,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { GIT_SETTINGS_CHANGED_EVENT } from "../../../constants/gitEvents";
import { useGitStatus } from "./useGitStatus";
import { useRemotePolling } from "./useRemotePolling";
import { GitConfirmBubble, type GitConfirmAnchor } from "./GitConfirmBubble";
import { GitFileList } from "./GitFileList";
import { RepoSelector } from "./RepoSelector";

type GitControlProps = {
  repoPath: string | undefined | null;
  directoryId?: string;
  repos?: GitRepoInfo[];
  onRepoSelect?: (path: string) => void;
  /** 双击变更区/暂存区文件：回调携带双击来源，供上层打开对应差异 tab。 */
  onFileSelect: (
    file: GitFileStatus | null,
    section?: "staged" | "unstaged",
  ) => void;
  onStatusChange?: (status: GitStatusResult | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  /** 在文件所在目录打开终端。 */
  onOpenTerminal?: (cwd: string) => void;
  /** 手动刷新或历史发生变化（提交、推送、拉取成功）时触发，供上层刷新提交图。 */
  onHistoryRefresh?: () => void;
};

const isSelectedKey = (section: "staged" | "unstaged", path: string) =>
  `${section}:${path}`;

// ===== 提交信息草稿缓存（模块级，按仓库路径隔离） =====
// 提交信息跟随项目：切换项目或折叠右面板时 GitControl 可能重新挂载，
// 草稿统一存放在模块级 Map 中，切换项目后只显示目标仓库自己的草稿，
// 切回时从缓存回显；空草稿直接从缓存移除，避免 Map 无限增长。
const commitMessageDrafts = new Map<string, string>();

// 草稿变更广播：右面板与分支下拉“变更”页可能各自挂载一个 GitControl，
// 发起生成的实例被卸载（如收起右面板）后，流式分片仍需送达其他实例。
type CommitMessageDraftListener = (repo: string, value: string) => void;
const commitMessageDraftListeners = new Set<CommitMessageDraftListener>();

// 统一写入草稿：先写模块级缓存（按仓库路径隔离），再广播给所有挂载中的
// 实例，由各实例只同步自己当前显示的仓库。切换项目后，旧项目迟到的 AI
// 流式分片只会进入旧项目的缓存，不会污染新项目的输入框。
const applyCommitMessage = (repo: string, value: string): void => {
  if (value) {
    commitMessageDrafts.set(repo, value);
  } else {
    commitMessageDrafts.delete(repo);
  }
  for (const listener of commitMessageDraftListeners) {
    listener(repo, value);
  }
};

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
  onStatusChange,
  onOpenFile,
  onOpenTerminal,
  onHistoryRefresh,
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
  // 变更区“全部放弃修改”的二次确认浮层锚点，非空即显示。
  const [discardAllAnchor, setDiscardAllAnchor] =
    useState<GitConfirmAnchor | null>(null);
  // 变更区未暂存文件数：用于确认浮层文案。
  const discardableCount = useMemo(
    () =>
      status
        ? status.files.filter(
            (f) =>
              f.workdirStatus === "?" ||
              (f.workdirStatus !== " " && f.workdirStatus !== ""),
          ).length
        : 0,
    [status],
  );
  // 拉取/推送二次确认：开关值来自 Git 设置面板，保存后通过自定义事件同步。
  const [confirmPullPush, setConfirmPullPush] = useState(true);
  const [remotes, setRemotes] = useState<GitRemoteInfo[]>([]);
  const remotesRequestIdRef = useRef(0);
  const [remotesLoaded, setRemotesLoaded] = useState(false);
  const [manualRemoteOverrides, setManualRemoteOverrides] = useState<
    Map<string, string>
  >(() => new Map());
  const selectedRemote = useMemo(() => {
    const manualRemote = repoPath
      ? manualRemoteOverrides.get(repoPath)
      : undefined;
    if (
      manualRemote &&
      remotes.some((remote) => remote.name === manualRemote)
    ) {
      return manualRemote;
    }
    const upstream = status?.upstream;
    const trackingRemote = upstream
      ? remotes
          .filter((remote) => upstream.startsWith(`${remote.name}/`))
          .sort((left, right) => right.name.length - left.name.length)[0]
      : undefined;
    return (
      trackingRemote?.name ??
      remotes.find((remote) => remote.name === "origin")?.name ??
      remotes[0]?.name ??
      ""
    );
  }, [manualRemoteOverrides, remotes, repoPath, status?.upstream]);
  const [setUpstream, setSetUpstream] = useState<boolean>(false);
  const [gitActionConfirm, setGitActionConfirm] = useState<{
    action: "pull" | "push" | "commitAndPush";
    anchor: GitConfirmAnchor;
    branch?: string;
    commitMessage?: string;
    remote?: string;
  } | null>(null);
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
  // 提交信息输入框引用：生成提交信息时把最新流式分片滚入视野
  // （高度由 CSS field-sizing 随内容自适应，无需 JS 写尺寸）。
  const commitInputRef = useRef<HTMLTextAreaElement>(null);
  // Set to true after a commit succeeds; the effect below resets scroll
  // to top once the refreshed status has been applied to the DOM.
  const commitPendingRef = useRef(false);
  // 变更/暂存区文件展示方式：平铺列表或按目录分组的树，偏好存 localStorage。
  const [fileViewMode, setFileViewMode] = useState<"list" | "tree">(() => {
    try {
      return localStorage.getItem("git-file-view") === "tree" ? "tree" : "list";
    } catch {
      return "list";
    }
  });
  const handleToggleFileViewMode = useCallback(() => {
    setFileViewMode((prev) => {
      const next = prev === "list" ? "tree" : "list";
      try {
        localStorage.setItem("git-file-view", next);
      } catch {
        // localStorage 不可用时静默忽略，仅本次会话生效。
      }
      return next;
    });
  }, []);
  // 工具栏刷新按钮的旋转态：状态刷新结束时停止（提交图由上层另行重载）。
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  // 切换仓库时收起放弃确认浮层，避免确认后误伤新仓库。
  useEffect(() => {
    setDiscardAllAnchor(null);
  }, [repoPath]);

  // 读取“拉取/推送二次确认”开关；设置面板保存后经自定义事件通知刷新，
  // 无需重挂载 Git 面板即可生效。
  useEffect(() => {
    let cancelled = false;
    const loadConfirmSetting = (): void => {
      void window.snow
        .getGitScanSettings()
        .then((settings) => {
          if (!cancelled) {
            setConfirmPullPush(settings.confirmPullPush);
          }
        })
        .catch(() => {
          // 读取失败时保持默认值（开启二次确认）。
        });
    };
    loadConfirmSetting();
    window.addEventListener(GIT_SETTINGS_CHANGED_EVENT, loadConfirmSetting);
    return () => {
      cancelled = true;
      window.removeEventListener(
        GIT_SETTINGS_CHANGED_EVENT,
        loadConfirmSetting,
      );
    };
  }, []);

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

  // 生成期间输入框只读，内容随流式分片持续变长；未聚焦的 textarea 不会
  // 自动跟随光标，这里把最新内容滚入视野（高度未达上限时
  // scrollHeight === clientHeight，赋值无副作用）。
  useEffect(() => {
    if (!isGeneratingCommitMsg) {
      return;
    }
    const input = commitInputRef.current;
    if (input) {
      input.scrollTop = input.scrollHeight;
    }
  }, [isGeneratingCommitMsg, displayedCommitMessage]);

  // 订阅模块级草稿广播：任意实例（含已卸载实例发起的后台生成）写入
  // 草稿时，仅当目标仓库是本实例当前显示的仓库才同步 UI。
  useEffect(() => {
    const listener = (repo: string, value: string): void => {
      if (repo === currentRepoRef.current) {
        setCommitMessage(value);
      }
    };
    commitMessageDraftListeners.add(listener);
    return () => {
      commitMessageDraftListeners.delete(listener);
    };
  }, []);

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

  // Load remotes; the selected destination is derived from a manual per-repo
  // override or, otherwise, the current upstream and the configured fallback.
  const loadRemotes = useCallback(() => {
    const requestId = ++remotesRequestIdRef.current;
    setRemotes([]);
    setRemotesLoaded(false);
    if (!repoPath) {
      setRemotesLoaded(true);
      return;
    }
    window.snow
      .gitRemotes(repoPath)
      .then((list) => {
        if (requestId !== remotesRequestIdRef.current) return;
        setRemotes(list);
        setRemotesLoaded(true);
      })
      .catch(() => {
        if (requestId === remotesRequestIdRef.current) {
          setRemotesLoaded(true);
        }
        // Silent fail
      });
  }, [repoPath]);

  useEffect(() => {
    loadRemotes();
  }, [loadRemotes]);
  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    onHistoryRefresh?.();
    void refresh().finally(() => {
      setIsRefreshing(false);
    });
  }, [refresh, onHistoryRefresh]);

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
    },
    [status],
  );

  // 双击文件打开差异视图：来源 section 决定取工作区 diff 还是 --cached diff。
  const handleFileActivate = useCallback(
    (file: GitFileStatus, section: "staged" | "unstaged") => {
      onFileSelect(file, section);
    },
    [onFileSelect],
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

  // Git 操作失败弹窗：后端会带回 git 的完整输出，空消息时兜底提示，
  // 保证用户始终能看到失败原因。
  const reportGitError = useCallback(
    (title: string, message: string) => {
      setOperationError({
        title,
        message: message || t("git.operationFailedGeneric"),
      });
    },
    [t],
  );

  // 文件级操作（暂存/取消暂存/放弃）统一处理：失败展示 git 原文，无论成败都刷新（可能部分生效）。
  const runFileAction = useCallback(
    (
      action: "stage" | "unstage" | "stageAll" | "unstageAll" | "discard",
      failedTitle: string,
      task: () => Promise<GitStageResult>,
    ) => {
      setActionInProgress(action);
      task()
        .then((result) => {
          if (result.success) {
            setSelectedPaths(new Set());
          } else {
            reportGitError(failedTitle, result.message);
          }
        })
        .catch((err: unknown) => {
          reportGitError(
            failedTitle,
            err instanceof Error ? err.message : String(err),
          );
        })
        .finally(() => {
          setActionInProgress(null);
          refresh();
        });
    },
    [refresh, reportGitError],
  );

  const handleStageToggle = useCallback(
    (files: GitFileStatus[], section: "staged" | "unstaged") => {
      if (!repoPath || files.length === 0) {
        return;
      }
      const paths = files.map((f) => f.path);
      if (section === "staged") {
        runFileAction("unstage", t("git.unstageFailed"), () =>
          window.snow.gitUnstage(repoPath, paths),
        );
      } else {
        runFileAction("stage", t("git.stageFailed"), () =>
          window.snow.gitStage(repoPath, paths),
        );
      }
    },
    [repoPath, runFileAction, t],
  );

  const handleStageAll = useCallback(() => {
    if (!repoPath) {
      return;
    }
    runFileAction("stageAll", t("git.stageFailed"), () =>
      window.snow.gitStageAll(repoPath),
    );
  }, [repoPath, runFileAction, t]);

  const handleUnstageAll = useCallback(() => {
    if (!repoPath) {
      return;
    }
    runFileAction("unstageAll", t("git.unstageFailed"), () =>
      window.snow.gitUnstageAll(repoPath),
    );
  }, [repoPath, runFileAction, t]);

  const runCommit = useCallback(
    (
      message: string,
      pushAfterCommit: boolean,
      targetRemote: string,
      targetBranch: string,
      targetSetUpstream: boolean,
    ): void => {
      if (!repoPath || !message.trim()) return;
      setActionInProgress("commit");
      let committed = false;
      void (async () => {
        try {
          const commitResult = await window.snow.gitCommit(repoPath, message);
          if (!commitResult.success) {
            reportGitError(t("git.commitFailed"), commitResult.message);
            return;
          }
          committed = true;
          // 提交产生新历史，刷新提交图。
          onHistoryRefresh?.();
          applyCommitMessage(repoPath, "");
          commitPendingRef.current = true;
          refresh();
          if (!pushAfterCommit) return;

          setActionInProgress("push");
          const pushResult = await window.snow.gitPush(
            repoPath,
            targetRemote || undefined,
            targetBranch || undefined,
            targetSetUpstream,
          );
          if (pushResult.success) {
            // 推送会移动远端跟踪分支（提交图上的 origin/* 徽章），刷新提交图。
            onHistoryRefresh?.();
            refresh();
            loadRemotes();
          } else {
            reportGitError(t("git.pushFailed"), pushResult.message);
          }
        } catch (err: unknown) {
          reportGitError(
            committed ? t("git.pushFailed") : t("git.commitFailed"),
            err instanceof Error ? err.message : String(err),
          );
        } finally {
          setActionInProgress(null);
        }
      })();
    },
    [repoPath, refresh, loadRemotes, t, reportGitError, onHistoryRefresh],
  );

  const handleCommit = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const message = displayedCommitMessage;
      if (!repoPath || !message.trim()) return;
      const branch = status?.currentBranch ?? "";
      if (commitMode === "commitAndPush") {
        if (remotesLoaded && remotes.length === 0) {
          reportGitError(t("git.pushFailed"), t("team.header.noRemote"));
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const trackingRemote = status?.upstream?.split("/", 1)[0] ?? "";
        const shouldSetUpstream =
          !status?.upstream || trackingRemote !== selectedRemote;
        setSetUpstream(shouldSetUpstream);
        if (!confirmPullPush && remotesLoaded && remotes.length <= 1) {
          runCommit(message, true, selectedRemote, branch, shouldSetUpstream);
        } else {
          setGitActionConfirm({
            action: "commitAndPush",
            anchor: { left: rect.left, right: rect.right, bottom: rect.bottom },
            commitMessage: message,
            branch,
            remote: selectedRemote,
          });
        }
        return;
      }
      runCommit(message, false, "", branch, false);
    },
    [
      repoPath,
      displayedCommitMessage,
      status?.currentBranch,
      commitMode,
      selectedRemote,
      status?.upstream,
      confirmPullPush,
      remotes.length,
      remotesLoaded,
      setUpstream,
      setSetUpstream,
      setGitActionConfirm,
      runCommit,
      reportGitError,
      t,
    ],
  );

  const handlePush = useCallback(
    (overrideRemote?: string, overrideSetUpstream?: boolean) => {
      if (!repoPath) return;
      const targetRemote = overrideRemote ?? selectedRemote;
      const targetSetUpstream = overrideSetUpstream ?? setUpstream;
      const targetBranch = status?.currentBranch ?? "";
      setActionInProgress("push");
      void window.snow
        .gitPush(
          repoPath,
          targetRemote || undefined,
          targetBranch || undefined,
          targetSetUpstream,
        )
        .then((result) => {
          if (result.success) {
            // 推送会移动远端跟踪分支（提交图上的 origin/* 徽章），刷新提交图。
            onHistoryRefresh?.();
            refresh();
            loadRemotes();
          } else {
            reportGitError(t("git.pushFailed"), result.message);
          }
        })
        .catch((err: unknown) => {
          reportGitError(
            t("git.pushFailed"),
            err instanceof Error ? err.message : String(err),
          );
        })
        .finally(() => setActionInProgress(null));
    },
    [
      repoPath,
      selectedRemote,
      setUpstream,
      status?.currentBranch,
      refresh,
      loadRemotes,
      t,
      reportGitError,
      onHistoryRefresh,
    ],
  );

  const handlePull = useCallback(
    (overrideRemote?: string) => {
      if (!repoPath) return;
      const targetRemote = overrideRemote ?? selectedRemote;
      const targetBranch = status?.currentBranch ?? "";
      setActionInProgress("pull");
      void window.snow
        .gitPull(repoPath, targetRemote || undefined, targetBranch || undefined)
        .then((result) => {
          if (result.success) {
            // 拉取可能带入新提交，刷新提交图。
            onHistoryRefresh?.();
            refresh();
            loadRemotes();
          } else {
            reportGitError(t("git.pullFailed"), result.message);
          }
        })
        .catch((err: unknown) => {
          reportGitError(
            t("git.pullFailed"),
            err instanceof Error ? err.message : String(err),
          );
        })
        .finally(() => setActionInProgress(null));
    },
    [
      repoPath,
      selectedRemote,
      status?.currentBranch,
      refresh,
      loadRemotes,
      t,
      reportGitError,
      onHistoryRefresh,
    ],
  );

  // Always confirm when multiple remotes exist; the selected destination is captured and reused.
  const requestGitAction = useCallback(
    (
      action: "pull" | "push" | "commitAndPush",
      anchor: GitConfirmAnchor,
      overrideRemote?: string,
      commitMessage?: string,
      branch?: string,
    ) => {
      const targetRemote = overrideRemote ?? selectedRemote;
      if (overrideRemote !== undefined && repoPath) {
        setManualRemoteOverrides((previous) =>
          new Map(previous).set(repoPath, overrideRemote),
        );
      }
      const trackingRemote = status?.upstream?.split("/", 1)[0] ?? "";
      const shouldSetUpstream =
        !status?.upstream || trackingRemote !== targetRemote;
      setSetUpstream(shouldSetUpstream);
      if (!confirmPullPush && remotesLoaded && remotes.length <= 1) {
        if (action === "pull") handlePull(targetRemote);
        else if (action === "push") handlePush(targetRemote, shouldSetUpstream);
        else
          runCommit(
            commitMessage ?? "",
            true,
            targetRemote,
            branch ?? status?.currentBranch ?? "",
            shouldSetUpstream,
          );
        return;
      }
      setGitActionConfirm({
        action,
        anchor,
        branch,
        commitMessage,
        remote: targetRemote,
      });
    },
    [
      confirmPullPush,
      remotes.length,
      remotesLoaded,
      selectedRemote,
      repoPath,
      status?.upstream,
      status?.currentBranch,
      handlePull,
      handlePush,
      runCommit,
    ],
  );

  const handleConfirmGitAction = useCallback(() => {
    const pending = gitActionConfirm;
    if (!pending) return;
    setGitActionConfirm(null);
    if (
      pending.action === "commitAndPush" &&
      remotesLoaded &&
      remotes.length === 0
    ) {
      reportGitError(t("git.pushFailed"), t("team.header.noRemote"));
      return;
    }
    const targetRemote = selectedRemote || pending.remote || "";
    if (pending.action === "pull") {
      handlePull(targetRemote);
    } else if (pending.action === "push") {
      handlePush(targetRemote, setUpstream);
    } else {
      runCommit(
        pending.commitMessage ?? "",
        true,
        targetRemote,
        pending.branch ?? "",
        setUpstream,
      );
    }
  }, [
    gitActionConfirm,
    remotesLoaded,
    remotes.length,
    selectedRemote,
    setUpstream,
    handlePull,
    handlePush,
    runCommit,
    reportGitError,
    t,
  ]);

  const handleSelectConfirmRemote = useCallback(
    (remote: string): void => {
      if (repoPath) {
        setManualRemoteOverrides((previous) =>
          new Map(previous).set(repoPath, remote),
        );
      }
      const trackingRemote = status?.upstream?.split("/", 1)[0] ?? "";
      setSetUpstream(!status?.upstream || trackingRemote !== remote);
    },
    [repoPath, status?.upstream],
  );

  const handleCancelGitAction = useCallback(() => {
    setGitActionConfirm(null);
  }, []);

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
    runFileAction("discard", t("git.discardFailed"), () =>
      window.snow.gitDiscardChanges(repoPath, paths),
    );
  }, [repoPath, discardTarget, runFileAction, t]);

  const handleDiscardCancel = useCallback(() => {
    setDiscardTarget([]);
  }, []);

  const handleDiscardAllRequest = useCallback((anchor: GitConfirmAnchor) => {
    setDiscardAllAnchor(anchor);
  }, []);

  const handleDiscardAllCancel = useCallback(() => {
    setDiscardAllAnchor(null);
  }, []);

  // 放弃变更区全部修改：未跟踪文件由后端 git clean 删除，其余恢复到 HEAD。
  const handleDiscardAllConfirm = useCallback(() => {
    setDiscardAllAnchor(null);
    if (!repoPath || !status) {
      return;
    }
    const paths = status.files
      .filter(
        (f) =>
          f.workdirStatus === "?" ||
          (f.workdirStatus !== " " && f.workdirStatus !== ""),
      )
      .map((f) => f.path);
    if (paths.length === 0) {
      return;
    }
    runFileAction("discard", t("git.discardFailed"), () =>
      window.snow.gitDiscardChanges(repoPath, paths),
    );
  }, [repoPath, status, runFileAction, t]);

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
      ...(remotes.length > 1
        ? remotes.map((r) => ({
            id: `pull-${r.name}`,
            label: `${t("git.pull")} (${r.name})`,
            icon: <ArrowDownToLine size={13} strokeWidth={1.8} />,
            disabled: busy,
            onClick: () => {
              const anchorX = actionsContextMenu?.x ?? 0;
              const anchorY = actionsContextMenu?.y ?? 0;
              setActionsContextMenu(null);
              requestGitAction(
                "pull",
                { left: anchorX, right: anchorX, bottom: anchorY },
                r.name,
              );
            },
          }))
        : [
            {
              id: "pull",
              label: t("git.pull"),
              icon: <ArrowDownToLine size={13} strokeWidth={1.8} />,
              disabled: busy,
              onClick: () => {
                const anchorX = actionsContextMenu?.x ?? 0;
                const anchorY = actionsContextMenu?.y ?? 0;
                setActionsContextMenu(null);
                requestGitAction("pull", {
                  left: anchorX,
                  right: anchorX,
                  bottom: anchorY,
                });
              },
            },
          ]),
      ...(remotes.length > 1
        ? remotes.map((r) => ({
            id: `push-${r.name}`,
            label: `${t("git.push")} → ${r.name}${
              selectedRemote === r.name
                ? ` (${t("git.currentRemote", { defaultValue: "current" })})`
                : ""
            }`,
            icon: <ArrowUpFromLine size={13} strokeWidth={1.8} />,
            disabled: busy,
            onClick: () => {
              const anchorX = actionsContextMenu?.x ?? 0;
              const anchorY = actionsContextMenu?.y ?? 0;
              setActionsContextMenu(null);
              requestGitAction(
                "push",
                { left: anchorX, right: anchorX, bottom: anchorY },
                r.name,
              );
            },
          }))
        : [
            {
              id: "push",
              label: t("git.push"),
              icon: <ArrowUpFromLine size={13} strokeWidth={1.8} />,
              disabled: busy,
              onClick: () => {
                const anchorX = actionsContextMenu?.x ?? 0;
                const anchorY = actionsContextMenu?.y ?? 0;
                setActionsContextMenu(null);
                requestGitAction("push", {
                  left: anchorX,
                  right: anchorX,
                  bottom: anchorY,
                });
              },
            },
          ]),
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
  }, [repoPath]);

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

  const refreshLabel = t("git.refresh");
  const pullLabel =
    status.behind > 0
      ? t("git.pullBehind", { values: { count: status.behind } })
      : t("git.pull");
  const pushLabel = t("git.push");
  const fileViewModeLabel =
    fileViewMode === "tree"
      ? t("git.showAsList", { defaultValue: "Show as List" })
      : t("git.showAsTree", { defaultValue: "Show as Tree" });

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
          <div className="git-commit-input-wrapper">
            <textarea
              ref={commitInputRef}
              className={`git-commit-input${
                isGeneratingCommitMsg ? " is-generating" : ""
              }`}
              placeholder={t("git.commitMessagePlaceholder")}
              value={displayedCommitMessage}
              onChange={(e) => applyCommitMessage(repoPath, e.target.value)}
              readOnly={isGeneratingCommitMsg}
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
              disabled={actionInProgress !== null || isGeneratingCommitMsg}
              title={t("git.commitMode")}
            >
              <ChevronDown size={14} strokeWidth={1.8} />
            </button>
          </div>
          <div
            className="git-control-actions"
            onContextMenu={(e) => {
              e.preventDefault();
              setActionsContextMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <Tooltip content={refreshLabel}>
              <button
                type="button"
                className="icon-btn git-action-btn"
                onClick={handleRefresh}
                disabled={actionInProgress !== null || isRefreshing}
                aria-label={refreshLabel}
              >
                {isRefreshing ? (
                  <Loader2 size={14} strokeWidth={1.8} className="spin" />
                ) : (
                  <RefreshCw size={14} strokeWidth={1.8} />
                )}
              </button>
            </Tooltip>
            <Tooltip content={pullLabel}>
              <button
                type="button"
                className="icon-btn git-action-btn"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  requestGitAction("pull", {
                    left: rect.left,
                    right: rect.right,
                    bottom: rect.bottom,
                  });
                }}
                disabled={actionInProgress !== null}
                aria-label={pullLabel}
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
            </Tooltip>
            <Tooltip content={pushLabel}>
              <button
                type="button"
                className="icon-btn git-action-btn"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  requestGitAction("push", {
                    left: rect.left,
                    right: rect.right,
                    bottom: rect.bottom,
                  });
                }}
                disabled={actionInProgress !== null}
                aria-label={pushLabel}
              >
                {actionInProgress === "push" ? (
                  <Loader2 size={14} strokeWidth={1.8} className="spin" />
                ) : (
                  <ArrowUpFromLine size={14} strokeWidth={1.8} />
                )}
              </button>
            </Tooltip>
            <Tooltip content={fileViewModeLabel}>
              <button
                type="button"
                className={`icon-btn git-action-btn${
                  fileViewMode === "tree" ? " active" : ""
                }`}
                onClick={handleToggleFileViewMode}
                aria-label={fileViewModeLabel}
              >
                {fileViewMode === "tree" ? (
                  <List size={14} strokeWidth={1.8} />
                ) : (
                  <FolderTree size={14} strokeWidth={1.8} />
                )}
              </button>
            </Tooltip>
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
        <GitFileList
          repoPath={repoPath}
          files={stagedFiles}
          section="staged"
          selectedPaths={selectedPaths}
          actionInProgress={actionInProgress}
          viewMode={fileViewMode}
          onFileSelect={handleFileSelect}
          onFileActivate={handleFileActivate}
          onStageToggle={handleStageToggle}
          onUnstageAll={handleUnstageAll}
          onOpenFile={handleOpenFile}
          onOpenTerminal={onOpenTerminal}
        />

        <GitFileList
          repoPath={repoPath}
          files={unstagedFiles}
          section="unstaged"
          selectedPaths={selectedPaths}
          actionInProgress={actionInProgress}
          viewMode={fileViewMode}
          onFileSelect={handleFileSelect}
          onFileActivate={handleFileActivate}
          onStageToggle={handleStageToggle}
          onStageAll={handleStageAll}
          onDiscardAll={handleDiscardAllRequest}
          onDiscard={handleDiscardRequest}
          onOpenFile={handleOpenFile}
          onOpenTerminal={onOpenTerminal}
        />
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

      {discardAllAnchor && (
        <GitConfirmBubble
          anchor={discardAllAnchor}
          message={t("git.discardAllConfirm", {
            values: { count: discardableCount },
          })}
          confirmLabel={t("git.discardConfirmBtn")}
          cancelLabel={t("common.cancel")}
          onConfirm={handleDiscardAllConfirm}
          onCancel={handleDiscardAllCancel}
          width={200}
          danger
          confirmDisabled={actionInProgress !== null}
        />
      )}

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

      {gitActionConfirm && (
        <GitConfirmBubble
          anchor={gitActionConfirm.anchor}
          message={
            gitActionConfirm.action === "commitAndPush"
              ? t("git.confirmCommitAndPush")
              : gitActionConfirm.action === "pull"
                ? remotes.length > 1
                  ? t("git.confirmPullFromRemote")
                  : t("git.confirmPull")
                : remotes.length > 1
                  ? t("git.confirmPushToRemote")
                  : t("git.confirmPush")
          }
          confirmLabel={
            gitActionConfirm.action === "pull"
              ? t("git.confirmPullBtn")
              : t("git.confirmPushBtn")
          }
          cancelLabel={t("common.cancel")}
          onConfirm={handleConfirmGitAction}
          onCancel={handleCancelGitAction}
          remotes={remotes}
          selectedRemote={selectedRemote}
          onSelectRemote={handleSelectConfirmRemote}
          remoteLabel={t("git.targetRemote")}
          showSetUpstreamOption={gitActionConfirm.action !== "pull"}
          setUpstream={setUpstream}
          onToggleSetUpstream={setSetUpstream}
          setUpstreamLabel={t("git.setUpstreamLabel")}
          confirmDisabled={!remotesLoaded || actionInProgress !== null}
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
