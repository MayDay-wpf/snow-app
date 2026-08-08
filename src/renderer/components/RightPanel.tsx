import { X } from "lucide-react";
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion } from "motion/react";

import { useI18n } from "../i18n";
import {
  appleLayoutTransition,
  useAppleThemeMotion,
} from "../hooks/useAppleThemeMotion";
import { GitPanelContent } from "./rightPanel/GitPanelContent";
import { DiffViewer } from "./rightPanel/DiffViewer";
import { FileDiffPreview } from "./common/FileDiffPreview";
import { RightPanelTabContextMenu } from "./rightPanel/RightPanelTabContextMenu";
import {
  useBrowserMcpCommandBridge,
  type BrowserMcpTabCallbacks,
} from "./rightPanel/browser/useBrowserMcpCommandBridge";
import { focusBrowserMcpInstance } from "./rightPanel/browser/browserMcpController";
import {
  useTerminalMcpCommandBridge,
  type TerminalMcpTabCallbacks,
} from "./rightPanel/terminal/useTerminalMcpCommandBridge";
import {
  rightPanelEvents,
  type OpenBrowserTabPayload,
  type FocusBrowserTabPayload,
  type OpenFileDiffPreviewPayload,
  type OpenFilePayload,
} from "./rightPanel/rightPanelEvents";
import { generateComparePatch } from "../utils/generateComparePatch";
import { getFileTypeIcon } from "../utils/fileIcons";
import { buildSshConnectParams } from "./sidebar/personalization/roleFileUtils";
import type {
  BrowserTabData,
  CodebaseTabData,
  DiffTabData,
  FileDiffPreviewTabData,
  FileViewerTabData,
  OpenDiffTabCallback,
  RemoteJobsTabData,
  RightPanelContentProps,
  RightPanelTab,
  TerminalTabData,
  TerminalOpenOptions,
} from "./rightPanel/types";

// 非默认 tab 的重组件按需加载，避免 xterm / highlight.js 等重型依赖打入首屏 chunk。
const FileViewerContent = lazy(() =>
  import("./rightPanel/FileViewerContent").then((m) => ({
    default: m.FileViewerContent,
  }))
);
const TerminalPanelContent = lazy(() =>
  import("./rightPanel/TerminalPanelContent").then((m) => ({
    default: m.TerminalPanelContent,
  }))
);
const BrowserPanelContent = lazy(() =>
  import("./rightPanel/BrowserPanelContent").then((m) => ({
    default: m.BrowserPanelContent,
  }))
);
const CodebasePanelContent = lazy(() =>
  import("./rightPanel/CodebasePanelContent").then((m) => ({
    default: m.CodebasePanelContent,
  }))
);
const RemoteJobsPanelContent = lazy(() =>
  import("./rightPanel/RemoteJobsPanelContent").then((m) => ({
    default: m.RemoteJobsPanelContent,
  }))
);

const GIT_TAB_ID = "git";
const CODEBASE_TAB_ID = "codebase";
const REMOTE_JOBS_TAB_ID = "remote-jobs";

// 文件类 tab(diff / file / file-diff-preview)在标题前显示对应的文件类型图标。
const getTabFileIcon = (tab: RightPanelTab): React.ReactNode => {
  if (tab.type === "diff") {
    const filePath = (tab.data as DiffTabData)?.selectedFile?.path;
    return filePath
      ? getFileTypeIcon(filePath.split("/").pop() ?? filePath, false, false, {
          size: 13,
          className: "right-panel-tab-icon",
        })
      : null;
  }
  if (tab.type === "file") {
    const fileName = (tab.data as FileViewerTabData)?.fileName;
    return fileName
      ? getFileTypeIcon(fileName, false, false, {
          size: 13,
          className: "right-panel-tab-icon",
        })
      : null;
  }
  if (tab.type === "file-diff-preview") {
    const fileName = (tab.data as FileDiffPreviewTabData)?.fileName;
    return fileName
      ? getFileTypeIcon(fileName, false, false, {
          size: 13,
          className: "right-panel-tab-icon",
        })
      : null;
  }
  return null;
};

export type RightPanelRef = {
  openTerminal: (cwd: string) => void;
  openBrowser: (url?: string) => void;
  openCodebase: (projectId: string, projectName: string) => void;
  openFile: (
    filePath: string,
    fileName: string,
    isSsh?: boolean,
    sshSessionId?: string | null,
    focusLine?: number,
    sshWorkspaceRoot?: string,
    sshWorkspaceId?: string
  ) => void;
};

type RightPanelProps = RightPanelContentProps & {
  isCollapsed: boolean;
  isFullscreen: boolean;
  isResizing?: boolean;
};

export const RightPanel = forwardRef<RightPanelRef, RightPanelProps>(
  (
    { isCollapsed, isFullscreen, isResizing = false, activeDirectory },
    ref
  ): React.JSX.Element => {
    const { t } = useI18n();
    const { enabled: appleMotionEnabled, reducedMotion } = useAppleThemeMotion();
    const [tabs, setTabs] = useState<RightPanelTab[]>([
      { id: GIT_TAB_ID, type: "git", title: t("rightPanel.gitTab") },
    ]);
    const [activeTabId, setActiveTabId] = useState<string>(GIT_TAB_ID);
    const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
    // 聊天区 Ctrl+点击远程路径时按工作区复用 SSH 连接；Promise 缓存还能
    // 合并快速连续点击产生的并发连接请求。
    const sshFileSessionPromisesRef = useRef<Map<string, Promise<string>>>(
      new Map()
    );
    // tab 右键菜单：记录触发位置与目标 tab（Git 固定 tab 无关闭项；
    // tabId 为 null 表示右键在 tab 栏空白区域，仅提供新建项）。
    const [tabContextMenu, setTabContextMenu] = useState<{
      x: number;
      y: number;
      tabId: string | null;
    } | null>(null);

    const handleOpenDiffTab = useCallback<OpenDiffTabCallback>(
      (file, diffResult, diffLoading) => {
        const tabId = `diff:${file.path}`;
        setTabs((prev) => {
          const existing = prev.find((t) => t.id === tabId);
          if (existing) {
            return prev.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    data: {
                      filePath: file.path,
                      selectedFile: file,
                      diffResult,
                      diffLoading,
                    },
                  }
                : t
            );
          }
          const newTab: RightPanelTab = {
            id: tabId,
            type: "diff",
            title: file.path.split("/").pop() ?? file.path,
            data: {
              filePath: file.path,
              selectedFile: file,
              diffResult,
              diffLoading,
            },
          };
          return [...prev, newTab];
        });
        setActiveTabId(tabId);
      },
      []
    );

    const handleOpenTerminalTab = useCallback(
      (
        cwd: string,
        requestedTabId?: string,
        options?: TerminalOpenOptions
      ): string => {
        const tabId = requestedTabId ?? `terminal-${Date.now()}`;
        const terminalData: TerminalTabData = {
          cwd,
          ...(options ?? {}),
        };
        setTabs((prev) => [
          ...prev,
          {
            id: tabId,
            type: "terminal",
            title: t("rightPanel.terminalTab"),
            data: terminalData,
          },
        ]);
        setActiveTabId(tabId);
        return tabId;
      },
      [t]
    );

    const handleTerminalTitleChange = useCallback(
      (tabId: string, title: string) => {
        setTabs((prev) =>
          prev.map((tab) => (tab.id === tabId ? { ...tab, title } : tab))
        );
      },
      []
    );

    const handleOpenBrowserTab = useCallback(
      (url?: string, requestedInstanceId?: string): string => {
        const instanceId =
          requestedInstanceId ??
          `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const browserData: BrowserTabData = {
          instanceId,
          url: url ?? "",
        };
        setTabs((prev) => [
          ...prev,
          {
            id: instanceId,
            type: "browser",
            title: t("rightPanel.browserTab"),
            data: browserData,
          },
        ]);
        setActiveTabId(instanceId);
        return instanceId;
      },
      [t]
    );

    const handleBrowserTitleChange = useCallback(
      (tabId: string, title: string) => {
        setTabs((prev) =>
          prev.map((tab) => (tab.id === tabId ? { ...tab, title } : tab))
        );
      },
      []
    );

    // 打开（或切换到已存在的）代码库数据 tab。tab id 固定，避免同一时间
    // 存在多个代码库 tab；切换项目时通过更新 data 复用同一个 tab。
    const handleOpenCodebaseTab = useCallback(
      (projectId: string, projectName: string) => {
        setTabs((prev) => {
          const existing = prev.find((t) => t.id === CODEBASE_TAB_ID);
          if (existing) {
            return prev.map((t) =>
              t.id === CODEBASE_TAB_ID
                ? {
                    ...t,
                    data: { projectId, projectName } as CodebaseTabData,
                  }
                : t
            );
          }
          const codebaseData: CodebaseTabData = { projectId, projectName };
          return [
            ...prev,
            {
              id: CODEBASE_TAB_ID,
              type: "codebase",
              title: t("rightPanel.codebaseTab"),
              data: codebaseData,
            },
          ];
        });
        setActiveTabId(CODEBASE_TAB_ID);
      },
      [t]
    );

    // 项目切换后重新判断代码库 tab：
    // - 新项目有索引（totalChunks > 0）：更新 tab 数据，触发列表重新加载。
    // - 新项目没有索引：自动关闭代码库 tab。
    const handleCodebaseProjectChanged = useCallback(
      (projectId: string) => {
        const hasCodebaseTab = tabs.some((t) => t.type === "codebase");
        if (!hasCodebaseTab) {
          return;
        }
        let cancelled = false;
        void window.snow
          .getCodebaseIndexStats(projectId)
          .then((stats) => {
            if (cancelled) {
              return;
            }
            if (stats.totalChunks > 0) {
              setTabs((prev) =>
                prev.map((tab) =>
                  tab.type === "codebase"
                    ? {
                        ...tab,
                        data: {
                          projectId,
                          projectName: activeDirectory?.name ?? tab.title,
                        } as CodebaseTabData,
                      }
                    : tab
                )
              );
            } else {
              setTabs((prev) => prev.filter((t) => t.type !== "codebase"));
              setActiveTabId((currentActive) => {
                if (currentActive !== CODEBASE_TAB_ID) {
                  return currentActive;
                }
                // 回退到左侧相邻 tab；没有则回到 Git tab。
                const currentIndex = tabs.findIndex(
                  (t) => t.id === CODEBASE_TAB_ID
                );
                if (currentIndex > 0) {
                  return tabs[currentIndex - 1].id;
                }
                const gitTab = tabs.find((t) => t.id === GIT_TAB_ID);
                return gitTab ? GIT_TAB_ID : (tabs[1]?.id ?? currentActive);
              });
            }
          })
          .catch(() => {
            // 查询失败时保守处理：保留 tab，由用户手动关闭。
          });
        return () => {
          cancelled = true;
        };
      },
      [tabs, activeDirectory]
    );

    useEffect(() => {
      if (!activeDirectory?.directoryId) {
        return;
      }
      return handleCodebaseProjectChanged(activeDirectory.directoryId);
    }, [activeDirectory?.directoryId, handleCodebaseProjectChanged]);

    useEffect(() => {
      const workspacePath = activeDirectory?.path;
      if (!workspacePath?.startsWith("ssh://")) {
        setTabs((current) =>
          current.filter((tab) => tab.id !== REMOTE_JOBS_TAB_ID)
        );
        setActiveTabId((current) =>
          current === REMOTE_JOBS_TAB_ID ? GIT_TAB_ID : current
        );
        return;
      }
      setTabs((current) => {
        const data: RemoteJobsTabData = { workspacePath };
        const existing = current.find((tab) => tab.id === REMOTE_JOBS_TAB_ID);
        if (existing) {
          return current.map((tab) =>
            tab.id === REMOTE_JOBS_TAB_ID
              ? { ...tab, data, title: t("rightPanel.remoteJobsTab") }
              : tab
          );
        }
        return [
          ...current,
          {
            id: REMOTE_JOBS_TAB_ID,
            type: "remote-jobs",
            title: t("rightPanel.remoteJobsTab"),
            data,
          },
        ];
      });
    }, [activeDirectory?.path, t]);

    const handleOpenFileTab = useCallback(
      (
        filePath: string,
        fileName: string,
        isSsh: boolean,
        sshSessionId?: string | null,
        focusLine?: number,
        sshWorkspaceRoot?: string,
        sshWorkspaceId?: string
      ) => {
        const tabId = isSsh
          ? `file:ssh:${sshSessionId ?? "unknown"}:${filePath}`
          : `file:${filePath}`;
        setTabs((prev) => {
          const existing = prev.find((t) => t.id === tabId);
          if (existing) {
            // 已存在 tab：仅更新 focusLine，不重建（避免重载文件内容）。
            return prev.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    data: {
                      ...(t.data as FileViewerTabData),
                      focusLine,
                      sshWorkspaceRoot:
                        sshWorkspaceRoot ??
                        (t.data as FileViewerTabData).sshWorkspaceRoot,
                      sshWorkspaceId:
                        sshWorkspaceId ??
                        (t.data as FileViewerTabData).sshWorkspaceId,
                    },
                  }
                : t
            );
          }
          const fileData: FileViewerTabData = {
            filePath,
            fileName,
            isSsh,
            sshSessionId: sshSessionId ?? undefined,
            sshWorkspaceRoot,
            sshWorkspaceId,
            focusLine,
          };
          const newTab: RightPanelTab = {
            id: tabId,
            type: "file",
            title: fileName,
            data: fileData,
          };
          return [...prev, newTab];
        });
        setActiveTabId(tabId);
      },
      []
    );

    // Git 变更/暂存区文件「打开文件」按钮：以本地仓库文件（isSsh=false）
    // 在右侧面板新建 file tab，通过 FileViewerContent 显示文件原文。
    const handleOpenFileFromGit = useCallback(
      (filePath: string, fileName: string) => {
        handleOpenFileTab(filePath, fileName, false);
      },
      [handleOpenFileTab]
    );

    const handleOpenFileDiffPreviewTab = useCallback(
      (payload: OpenFileDiffPreviewPayload) => {
        const tabId = `file-diff-preview:${payload.filePath}`;
        const patch = generateComparePatch(
          payload.fileName,
          payload.oldContent,
          payload.newContent,
          payload.oldStartLine,
          payload.newStartLine
        );
        const data: FileDiffPreviewTabData = {
          fileName: payload.fileName,
          filePath: payload.filePath,
          patch,
          oldStartLine: payload.oldStartLine,
          newStartLine: payload.newStartLine,
          changeType: payload.changeType,
        };
        setTabs((prev) => {
          const existing = prev.find((t) => t.id === tabId);
          if (existing) {
            return prev.map((t) => (t.id === tabId ? { ...t, data } : t));
          }
          const newTab: RightPanelTab = {
            id: tabId,
            type: "file-diff-preview",
            title: payload.fileName,
            data,
          };
          return [...prev, newTab];
        });
        setActiveTabId(tabId);
        rightPanelEvents.emit("request-expand");
      },
      []
    );

    useEffect(() => {
      return rightPanelEvents.on(
        "open-file-diff-preview",
        handleOpenFileDiffPreviewTab
      );
    }, [handleOpenFileDiffPreviewTab]);

    // 工具调用组件（如 WebSearch）请求在应用内浏览器新建 tab 打开链接。
    // 带短时去抖：同一 URL 600ms 内的重复触发（双击）只创建一个 tab。
    const lastBrowserOpenRef = useRef<{ url: string; at: number }>({
      url: "",
      at: 0,
    });

    const handleOpenBrowserTabEvent = useCallback(
      (payload: OpenBrowserTabPayload) => {
        const url = payload.url.trim();
        if (!url) {
          return;
        }
        const now = Date.now();
        const last = lastBrowserOpenRef.current;
        if (last.url === url && now - last.at < 600) {
          return;
        }
        lastBrowserOpenRef.current = { url, at: now };
        handleOpenBrowserTab(url);
        rightPanelEvents.emit("request-expand");
      },
      [handleOpenBrowserTab]
    );

    useEffect(() => {
      return rightPanelEvents.on("open-browser-tab", handleOpenBrowserTabEvent);
    }, [handleOpenBrowserTabEvent]);

    // 为远程文件查看建立/复用 SSH 会话。失败时删除缓存，允许下次重试。
    const getSshFileSession = useCallback(
      (workspacePath: string): Promise<string> => {
        const cached = sshFileSessionPromisesRef.current.get(workspacePath);
        if (cached) {
          return cached;
        }
        const connecting = buildSshConnectParams(workspacePath)
          .then((params) => {
            if (!params) {
              throw new Error("Unable to resolve SSH connection parameters");
            }
            return window.snow.sshConnect(params);
          })
          .catch((error: unknown) => {
            sshFileSessionPromisesRef.current.delete(workspacePath);
            throw error;
          });
        sshFileSessionPromisesRef.current.set(workspacePath, connecting);
        return connecting;
      },
      []
    );

    useEffect(() => {
      const sessions = sshFileSessionPromisesRef.current;
      return () => {
        for (const sessionPromise of sessions.values()) {
          void sessionPromise
            .then((sessionId) => window.snow.sshDisconnect(sessionId))
            .catch(() => {
              // 连接失败或已断开，无需额外处理。
            });
        }
        sessions.clear();
      };
    }, []);

    // Ctrl+点击聊天区路径（usePathClickOpen 委托）请求打开文件：
    // 在右侧面板新建 file tab 查看，与 Git 面板「打开文件」行为一致。
    const handleOpenFileEvent = useCallback(
      (payload: OpenFilePayload) => {
        const filePath = payload.filePath.trim();
        if (!filePath) {
          return;
        }

        void (async () => {
          const isSsh = payload.isSsh ?? false;
          let sshSessionId = payload.sshSessionId;
          if (isSsh && !sshSessionId) {
            const workspacePath = payload.sshWorkspacePath?.trim();
            if (!workspacePath) {
              return;
            }
            sshSessionId = await getSshFileSession(workspacePath);
          }

          const fileName =
            payload.fileName ??
            filePath.split(/[\\/]/).filter(Boolean).pop() ??
            filePath;
          handleOpenFileTab(
            filePath,
            fileName,
            isSsh,
            sshSessionId,
            payload.focusLine,
            payload.sshWorkspaceRoot ?? payload.sshWorkspacePath,
            payload.sshWorkspaceId
          );
          rightPanelEvents.emit("request-expand");
        })().catch((error: unknown) => {
          console.error("Failed to open file from chat path", error);
        });
      },
      [getSshFileSession, handleOpenFileTab]
    );

    useEffect(() => {
      return rightPanelEvents.on("open-file", handleOpenFileEvent);
    }, [handleOpenFileEvent]);

    useImperativeHandle(
      ref,
      () => ({
        openTerminal: (cwd: string) => {
          handleOpenTerminalTab(cwd);
        },
        openBrowser: (url?: string) => {
          handleOpenBrowserTab(url);
        },
        openCodebase: (projectId: string, projectName: string) => {
          handleOpenCodebaseTab(projectId, projectName);
        },
        openFile: (
          filePath: string,
          fileName: string,
          isSsh?: boolean,
          sshSessionId?: string | null,
          focusLine?: number,
          sshWorkspaceRoot?: string,
          sshWorkspaceId?: string
        ) => {
          handleOpenFileTab(
            filePath,
            fileName,
            isSsh ?? false,
            sshSessionId,
            focusLine,
            sshWorkspaceRoot,
            sshWorkspaceId
          );
        },
      }),
      [
        handleOpenTerminalTab,
        handleOpenBrowserTab,
        handleOpenCodebaseTab,
        handleOpenFileTab,
      ]
    );

    const handleCloseTab = useCallback(
      (tabId: string) => {
        setTabs((prev) => {
          if (tabId === GIT_TAB_ID) {
            return prev;
          }
          const filtered = prev.filter((t) => t.id !== tabId);
          if (filtered.length === 0) {
            return prev;
          }
          return filtered;
        });
        setDirtyTabs((prev) => {
          if (!prev.has(tabId)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
        setActiveTabId((currentActive) => {
          if (currentActive !== tabId) {
            return currentActive;
          }
          // 关闭当前激活的 tab：优先向左顺延选择相邻 tab，
          // 仅当左侧没有其他 tab 时才回退到 Git tab。
          const currentIndex = tabs.findIndex((t) => t.id === tabId);
          if (currentIndex > 0) {
            return tabs[currentIndex - 1].id;
          }
          // currentIndex === 0：左侧无 tab，回退到 Git tab（若存在）
          const gitTab = tabs.find((t) => t.id === GIT_TAB_ID);
          return gitTab ? GIT_TAB_ID : tabs[1]?.id ?? currentActive;
        });
      },
      [tabs]
    );

    // 关闭所有可关闭的 tab（Git 为固定 tab，始终保留），回到 Git 视图。
    const handleCloseAllTabs = useCallback(() => {
      setTabs((prev) => prev.filter((t) => t.id === GIT_TAB_ID));
      setDirtyTabs(new Set());
      setActiveTabId(GIT_TAB_ID);
    }, []);

    const handleCloseBrowserTab = useCallback(
      (instanceId: string): boolean => {
        const tab = tabs.find(
          (t) => t.id === instanceId && t.type === "browser"
        );
        if (!tab) {
          return false;
        }
        handleCloseTab(instanceId);
        return true;
      },
      [tabs, handleCloseTab]
    );

    const handleFocusBrowserTab = useCallback(
      (instanceId: string): boolean => {
        const tab = tabs.find(
          (t) => t.id === instanceId && t.type === "browser"
        );
        if (!tab) {
          return false;
        }
        setActiveTabId(instanceId);
        focusBrowserMcpInstance(instanceId);
        return true;
      },
      [tabs]
    );

    // 工具调用组件（BrowserToolCall）请求切换到指定浏览器实例的 tab。
    const handleFocusBrowserTabEvent = useCallback(
      (payload: FocusBrowserTabPayload) => {
        const instanceId = payload.instanceId.trim();
        if (!instanceId) {
          return;
        }
        if (handleFocusBrowserTab(instanceId)) {
          rightPanelEvents.emit("request-expand");
        }
      },
      [handleFocusBrowserTab]
    );

    useEffect(() => {
      return rightPanelEvents.on(
        "focus-browser-tab",
        handleFocusBrowserTabEvent
      );
    }, [handleFocusBrowserTabEvent]);

    const handleListBrowserTabs = useCallback(() => {
      return tabs
        .filter((t) => t.type === "browser")
        .map((t) => ({
          instanceId: t.id,
          title: t.title,
          isActive: t.id === activeTabId,
        }));
    }, [tabs, activeTabId]);

    const browserMcpCallbacks = useMemo<BrowserMcpTabCallbacks>(
      () => ({
        openTab: handleOpenBrowserTab,
        closeTab: handleCloseBrowserTab,
        focusTab: handleFocusBrowserTab,
        listTabs: handleListBrowserTabs,
      }),
      [
        handleOpenBrowserTab,
        handleCloseBrowserTab,
        handleFocusBrowserTab,
        handleListBrowserTabs,
      ]
    );

    useBrowserMcpCommandBridge(browserMcpCallbacks);

    const handleCloseTerminalTab = useCallback(
      (tabId: string): boolean => {
        const tab = tabs.find(
          (t) => t.id === tabId && t.type === "terminal"
        );
        if (!tab) {
          return false;
        }
        handleCloseTab(tabId);
        return true;
      },
      [tabs, handleCloseTab]
    );

    const handleFocusTerminalTab = useCallback(
      (tabId: string): boolean => {
        const tab = tabs.find(
          (t) => t.id === tabId && t.type === "terminal"
        );
        if (!tab) {
          return false;
        }
        setActiveTabId(tabId);
        return true;
      },
      [tabs]
    );

    const handleListTerminalTabs = useCallback(() => {
      return tabs
        .filter((t) => t.type === "terminal")
        .map((t) => ({
          tabId: t.id,
          title: t.title,
          cwd: (t.data as TerminalTabData)?.cwd ?? "",
          isActive: t.id === activeTabId,
        }));
    }, [tabs, activeTabId]);

    const terminalMcpCallbacks = useMemo<TerminalMcpTabCallbacks>(
      () => ({
        openTab: handleOpenTerminalTab,
        closeTab: handleCloseTerminalTab,
        focusTab: handleFocusTerminalTab,
        listTabs: handleListTerminalTabs,
      }),
      [
        handleOpenTerminalTab,
        handleCloseTerminalTab,
        handleFocusTerminalTab,
        handleListTerminalTabs,
      ]
    );

    useTerminalMcpCommandBridge(terminalMcpCallbacks, activeDirectory);

    const tabListRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const el = tabListRef.current;
      if (!el) {
        return;
      }
      const onWheel = (e: WheelEvent) => {
        if (e.deltaY === 0) {
          return;
        }
        const canScroll = el.scrollWidth > el.clientWidth;
        if (!canScroll) {
          return;
        }
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    }, [tabs.length]);

    const panelClasses = [
      "right-panel",
      isCollapsed ? "collapsed" : "",
      isFullscreen ? "fullscreen" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const renderTabContent = (tab: RightPanelTab): React.ReactNode => {
      if (tab.type === "git") {
        return (
          <GitPanelContent
            activeDirectory={activeDirectory}
            onOpenInTab={handleOpenDiffTab}
            onOpenFile={handleOpenFileFromGit}
            onOpenTerminal={(cwd) => handleOpenTerminalTab(cwd)}
          />
        );
      }

      // 非 Git tab 均为懒加载组件，需要 Suspense 包裹。
      return (
        <Suspense fallback={null}>
          {tab.type === "terminal" ? (
            <TerminalPanelContent
              tabId={tab.id}
              cwd={(tab.data as TerminalTabData).cwd}
              ptyId={(tab.data as TerminalTabData).ptyId}
              shellPath={(tab.data as TerminalTabData).shellPath}
              sessionId={(tab.data as TerminalTabData).sessionId}
              isActive={activeTabId === tab.id}
              onTitleChange={(title) =>
                handleTerminalTitleChange(tab.id, title)
              }
              onOpenLink={(url) => handleOpenBrowserTab(url)}
              // 用户显式 exit（exitCode 0）后延迟自动关闭 tab（对齐 VS Code
              // 终端行为）；异常退出（非 0）保留现场供排查。
              onProcessExit={(exitCode) => {
                if (exitCode === 0) {
                  window.setTimeout(() => handleCloseTab(tab.id), 1200);
                }
              }}
            />
          ) : tab.type === "browser" ? (
            <BrowserPanelContent
              instanceId={(tab.data as BrowserTabData).instanceId}
              initialUrl={(tab.data as BrowserTabData).url}
              isActive={activeTabId === tab.id}
              onTitleChange={(title) => handleBrowserTitleChange(tab.id, title)}
            />
          ) : tab.type === "codebase" ? (
            (tab.data as CodebaseTabData) ? (
              <CodebasePanelContent
                projectId={(tab.data as CodebaseTabData).projectId}
                projectName={(tab.data as CodebaseTabData).projectName}
              />
            ) : null
          ) : tab.type === "remote-jobs" ? (
            (tab.data as RemoteJobsTabData) ? (
              <RemoteJobsPanelContent
                workspacePath={(tab.data as RemoteJobsTabData).workspacePath}
                isActive={activeTabId === tab.id}
                onAttach={(attachment) =>
                  handleOpenTerminalTab(
                    (tab.data as RemoteJobsTabData).workspacePath,
                    `remote-job-${attachment.jobId}-${Date.now()}`,
                    { ptyId: attachment.ptyId }
                  )
                }
              />
            ) : null
          ) : tab.type === "diff" ? (
            (tab.data as DiffTabData) ? (
              <DiffViewer
                selectedFile={(tab.data as DiffTabData).selectedFile}
                diffResult={(tab.data as DiffTabData).diffResult}
                diffLoading={(tab.data as DiffTabData).diffLoading}
              />
            ) : null
          ) : tab.type === "file" ? (
            (tab.data as FileViewerTabData) ? (
              <FileViewerContent
                filePath={(tab.data as FileViewerTabData).filePath}
                fileName={(tab.data as FileViewerTabData).fileName}
                isSsh={(tab.data as FileViewerTabData).isSsh}
                sshSessionId={(tab.data as FileViewerTabData).sshSessionId}
                sshWorkspaceRoot={(tab.data as FileViewerTabData).sshWorkspaceRoot}
                sshWorkspaceId={(tab.data as FileViewerTabData).sshWorkspaceId}
                focusLine={(tab.data as FileViewerTabData).focusLine}
                onOpenTerminal={(cwd) => handleOpenTerminalTab(cwd)}
                onDirtyChange={(dirty) =>
                  setDirtyTabs((prev) => {
                    const next = new Set(prev);
                    if (dirty) {
                      next.add(tab.id);
                    } else {
                      next.delete(tab.id);
                    }
                    return next;
                  })
                }
              />
            ) : null
          ) : tab.type === "file-diff-preview" ? (
            (tab.data as FileDiffPreviewTabData) ? (
              <FileDiffPreview
                diffs={[
                  {
                    path: (tab.data as FileDiffPreviewTabData).filePath,
                    changeType: (tab.data as FileDiffPreviewTabData).changeType,
                    content: (tab.data as FileDiffPreviewTabData).patch ?? "",
                    isBinary: false,
                  },
                ]}
                isLoading={false}
                hasError={(tab.data as FileDiffPreviewTabData).patch == null}
                labels={{
                  loading: t("rightPanel.loadingDiff"),
                  error: t("rightPanel.diffPreviewError"),
                  empty: t("rightPanel.noChangesToDisplay"),
                  selectFile: t("rightPanel.selectFileToViewDiff"),
                }}
              />
            ) : null
          ) : null}
        </Suspense>
      );
    };

    return (
      <motion.aside
        className={panelClasses}
        layout={appleMotionEnabled && !isResizing}
        transition={
          appleMotionEnabled ? appleLayoutTransition(reducedMotion) : undefined
        }
      >
        {tabs.length > 1 && (
          <div className="right-panel-tabs">
            <div
              ref={tabListRef}
              className="right-panel-tab-list"
              onContextMenu={(event) => {
                // 仅空白区域触发：tab 项上已有各自的右键菜单。
                if (
                  (event.target as HTMLElement).closest(
                    ".right-panel-tab-item"
                  )
                ) {
                  return;
                }
                event.preventDefault();
                setTabContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  tabId: null,
                });
              }}
            >
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`right-panel-tab-item ${
                    activeTabId === tab.id ? "active" : ""
                  }`}
                  onClick={() => setActiveTabId(tab.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setActiveTabId(tab.id);
                    setTabContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      tabId: tab.id,
                    });
                  }}
                >
                  {getTabFileIcon(tab)}
                  <span className="right-panel-tab-title" title={tab.title}>
                    {dirtyTabs.has(tab.id) && (
                      <span
                        className="right-panel-tab-dirty-dot"
                        aria-hidden="true"
                      />
                    )}
                    {tab.title}
                  </span>
                  {tab.id !== GIT_TAB_ID && (
                    <button
                      type="button"
                      className="right-panel-tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseTab(tab.id);
                      }}
                      aria-label={t("rightPanel.closeTab")}
                    >
                      <X size={12} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="right-panel-content-wrapper">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`right-panel-tab-pane ${
                activeTabId === tab.id ? "active" : ""
              }`}
            >
              {renderTabContent(tab)}
            </div>
          ))}
        </div>
        {tabContextMenu && (
          <RightPanelTabContextMenu
            x={tabContextMenu.x}
            y={tabContextMenu.y}
            isClosable={
              tabContextMenu.tabId !== null &&
              tabContextMenu.tabId !== GIT_TAB_ID
            }
            onCloseAllTabs={
              tabContextMenu.tabId === null
                ? () => {
                    setTabContextMenu(null);
                    handleCloseAllTabs();
                  }
                : undefined
            }
            onNewTerminal={() => {
              setTabContextMenu(null);
              handleOpenTerminalTab(activeDirectory?.path ?? "");
            }}
            onNewBrowser={() => {
              setTabContextMenu(null);
              handleOpenBrowserTab();
            }}
            onCloseTab={() => {
              setTabContextMenu(null);
              if (tabContextMenu.tabId !== null) {
                handleCloseTab(tabContextMenu.tabId);
              }
            }}
            onClose={() => setTabContextMenu(null)}
          />
        )}
      </motion.aside>
    );
  }
);

RightPanel.displayName = "RightPanel";
