import {
  Database,
  Globe,
  Maximize2,
  Minimize2,
  Paintbrush,
  Terminal,
  X,
} from "lucide-react";
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
import type { BrowserRestorePayload } from "../../preload";

import { useI18n } from "../i18n";
import { setWebTagDragData } from "./rightPanel/browserDrag";
import { GitPanelContent } from "./rightPanel/GitPanelContent";
import { DiffViewer } from "./rightPanel/DiffViewer";
import { FileDiffPreview } from "./common/FileDiffPreview";
import {
  PlusMenuButton,
  type PlusMenuAction,
  type PlusMenuItem,
} from "./common/PlusMenuButton";
import { RightPanelTabContextMenu } from "./rightPanel/RightPanelTabContextMenu";
// 浏览器面板静态导入（非 lazy）：模块（含 homepage 缓存）随应用启动加载并
// 预取起始页，避免首次创建浏览器实例时异步拉取 chunk 造成「不进预设起始页」
// 与时序类问题（useBrowserHomepage 的模块级状态在 lazy 加载前不存在）。
import { BrowserPanelContent } from "./rightPanel/BrowserPanelContent";
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
  RightPanelContentProps,
  RightPanelTab,
  TerminalTabData,
  TerminalOpenOptions,
} from "./rightPanel/types";
import {
  TERMINAL_DRAG_MIME,
  type TerminalDragPayload,
} from "./rightPanel/terminal/terminalMonitor";
import type { MainContentView } from "./mainContent/types";

/** 可拖拽到聊天输入框的 tab 类型（git / codebase 为固定面板，不参与） */
const DRAGGABLE_TAB_TYPES = new Set([
  "terminal",
  "file",
  "diff",
  "file-diff-preview",
  "browser",
]);

/**
 * 右侧 tab 拖拽到聊天输入框：
 * - 终端 tab → 携带 TERMINAL_DRAG_MIME，输入框 drop 后进入「监控终端」模式
 * - 文件类 tab（file / diff / file-diff-preview）→ 携带 file-tags，
 *   输入框 drop 后插入文件引用 chip（与 git 面板拖 commit 标签同一套机制）
 * - 浏览器 tab → 携带 web-tag（实时 URL + 页面标题），
 *   输入框 drop 后插入网页引用 chip
 */
const handleTabDragStart = (
  event: React.DragEvent<HTMLDivElement>,
  tab: RightPanelTab,
): void => {
  if (!DRAGGABLE_TAB_TYPES.has(tab.type)) {
    return;
  }
  if (tab.type === "terminal") {
    const terminalTab = tab.data as TerminalTabData | undefined;
    const payload: TerminalDragPayload = {
      tabId: tab.id,
      cwd: terminalTab?.cwd ?? "",
      title: tab.title,
    };
    event.dataTransfer.setData(TERMINAL_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "link";
    return;
  }
  if (tab.type === "browser") {
    // 浏览器 tab：携带实时 URL（页面内导航后由 onUrlChange 同步到 data.url）
    // 与实例 id（无内层 tabId → 输入框 drop 后快照请求以该实例激活标签页兜底）。
    const browserTab = tab.data as BrowserTabData | undefined;
    const url = browserTab?.url;
    if (!url) {
      return;
    }
    setWebTagDragData(event, url, tab.title, {
      instanceId: browserTab.instanceId,
    });
    return;
  }
  // 文件类 tab：统一取出 filePath + 名称，作为 file-tags 拖入输入框
  const data = tab.data as
    FileViewerTabData | DiffTabData | FileDiffPreviewTabData;
  const filePath = data.filePath;
  const fileName =
    (data as FileViewerTabData).fileName ??
    (data as FileDiffPreviewTabData).fileName ??
    filePath.split("/").pop() ??
    filePath;
  if (!filePath) {
    return;
  }
  const tags = [{ path: filePath, name: fileName }];
  event.dataTransfer.setData(
    "application/json",
    JSON.stringify({ type: "file-tags", tags }),
  );
  event.dataTransfer.effectAllowed = "copy";
};

// 非默认 tab 的重组件按需加载，避免 xterm / highlight.js 等重型依赖打入首屏 chunk。
const FileViewerContent = lazy(() =>
  import("./rightPanel/FileViewerContent").then((m) => ({
    default: m.FileViewerContent,
  })),
);
const TerminalPanelContent = lazy(() =>
  import("./rightPanel/TerminalPanelContent").then((m) => ({
    default: m.TerminalPanelContent,
  })),
);
const CodebasePanelContent = lazy(() =>
  import("./rightPanel/CodebasePanelContent").then((m) => ({
    default: m.CodebasePanelContent,
  })),
);
const DrawingPanelContent = lazy(() =>
  import("./rightPanel/DrawingPanelContent").then((m) => ({
    default: m.DrawingPanelContent,
  })),
);

const GIT_TAB_ID = "git";
const CODEBASE_TAB_ID = "codebase";

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
  openDrawing: () => void;
  openFile: (
    filePath: string,
    fileName: string,
    isSsh?: boolean,
    sshSessionId?: string | null,
    focusLine?: number,
    sshWorkspaceRoot?: string,
    sshWorkspaceId?: string,
  ) => void;
};

type RightPanelProps = RightPanelContentProps & {
  isCollapsed: boolean;
  isFullscreen: boolean;
  isResizing?: boolean;
  /** 切换主内容视图（绘图工作台错误卡片跳转设置用）。 */
  onSelectMainView?: (view: MainContentView) => void;
  /** 切换右面板全屏（Windows 下由 tab 操作区的最大化按钮触发）。 */
  onToggleRightPanelFullscreen?: () => void;
};

export const RightPanel = forwardRef<RightPanelRef, RightPanelProps>(
  (
    {
      isCollapsed,
      isFullscreen,
      isResizing = false,
      activeDirectory,
      onSelectMainView,
      onToggleRightPanelFullscreen,
    },
    ref,
  ): React.JSX.Element => {
    const isWindows = navigator.userAgent.includes("Win");
    const { t } = useI18n();
    const [tabs, setTabs] = useState<RightPanelTab[]>([
      { id: GIT_TAB_ID, type: "git", title: t("rightPanel.gitTab") },
    ]);
    const [activeTabId, setActiveTabId] = useState<string>(GIT_TAB_ID);
    const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
    // 聊天区 Ctrl+点击远程路径时按工作区复用 SSH 连接；Promise 缓存还能
    // 合并快速连续点击产生的并发连接请求。
    const sshFileSessionPromisesRef = useRef<Map<string, Promise<string>>>(
      new Map(),
    );
    // tab 右键菜单：记录触发位置与目标 tab（Git 固定 tab 无关闭项；
    // tabId 为 null 表示右键在 tab 栏空白区域，仅提供新建项）。
    const [tabContextMenu, setTabContextMenu] = useState<{
      x: number;
      y: number;
      tabId: string | null;
    } | null>(null);
    // 关闭二次确认 tooltip：terminal / browser tab 点 X 后先弹出确认浮层，
    // 定位在关闭按钮下方（相对 tab-list 的坐标），避免误关。
    const [closeConfirm, setCloseConfirm] = useState<{
      tabId: string;
      x: number;
      y: number;
      maxX: number;
    } | null>(null);

    const handleOpenDiffTab = useCallback<OpenDiffTabCallback>(
      (file, diffResult, diffLoading, imageDiff) => {
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
                      imageDiff,
                    },
                  }
                : t,
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
              imageDiff,
            },
          };
          return [...prev, newTab];
        });
        setActiveTabId(tabId);
      },
      [],
    );

    const handleOpenTerminalTab = useCallback(
      (
        cwd: string,
        requestedTabId?: string,
        options?: TerminalOpenOptions,
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
      [t],
    );

    const handleTerminalTitleChange = useCallback(
      (tabId: string, title: string) => {
        setTabs((prev) =>
          prev.map((tab) => (tab.id === tabId ? { ...tab, title } : tab)),
        );
      },
      [],
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
      [t],
    );

    const handleBrowserTitleChange = useCallback(
      (tabId: string, title: string) => {
        setTabs((prev) =>
          prev.map((tab) => (tab.id === tabId ? { ...tab, title } : tab)),
        );
      },
      [],
    );

    // 页面导航（含页面内跳转）后同步 tab 的实时 URL，
    // 供拖拽引用时携带最新地址（BrowserPanelContent 的 onUrlChange 回调）。
    const handleBrowserUrlChange = useCallback((tabId: string, url: string) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId && tab.type === "browser"
            ? {
                ...tab,
                data: { ...(tab.data as BrowserTabData), url },
              }
            : tab,
        ),
      );
    }, []);

    // 实例内部全部标签页快照同步（BrowserPanelContent 的 onTabsChange 回调，
    // 激活页置首）。写入 BrowserTabData.tabs，供「在新窗口中打开」/
    // 「还原为标签页」迁移时完整携带。
    const handleBrowserTabsChange = useCallback(
      (tabId: string, tabs: { url: string; title: string }[]) => {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId && tab.type === "browser"
              ? {
                  ...tab,
                  data: { ...(tab.data as BrowserTabData), tabs },
                }
              : tab,
          ),
        );
      },
      [],
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
                : t,
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
      [t],
    );

    // 新建绘图工作台 tab：每次新建独立画布，可开多个并行绘图。
    const handleOpenDrawingTab = useCallback((): string => {
      const tabId = `drawing-${Date.now()}`;
      setTabs((prev) => [
        ...prev,
        {
          id: tabId,
          type: "drawing",
          title: t("rightPanel.drawingTab"),
        },
      ]);
      setActiveTabId(tabId);
      return tabId;
    }, [t]);

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
                    : tab,
                ),
              );
            } else {
              setTabs((prev) => prev.filter((t) => t.type !== "codebase"));
              setActiveTabId((currentActive) => {
                if (currentActive !== CODEBASE_TAB_ID) {
                  return currentActive;
                }
                // 回退到左侧相邻 tab；没有则回到 Git tab。
                const currentIndex = tabs.findIndex(
                  (t) => t.id === CODEBASE_TAB_ID,
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
      [tabs, activeDirectory],
    );

    useEffect(() => {
      if (!activeDirectory?.directoryId) {
        return;
      }
      return handleCodebaseProjectChanged(activeDirectory.directoryId);
    }, [activeDirectory?.directoryId, handleCodebaseProjectChanged]);

    const handleOpenFileTab = useCallback(
      (
        filePath: string,
        fileName: string,
        isSsh: boolean,
        sshSessionId?: string | null,
        focusLine?: number,
        sshWorkspaceRoot?: string,
        sshWorkspaceId?: string,
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
                : t,
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
      [],
    );

    // Git 变更/暂存区文件「打开文件」按钮：以本地仓库文件（isSsh=false）
    // 在右侧面板新建 file tab，通过 FileViewerContent 显示文件原文。
    const handleOpenFileFromGit = useCallback(
      (filePath: string, fileName: string) => {
        handleOpenFileTab(filePath, fileName, false);
      },
      [handleOpenFileTab],
    );

    const handleOpenFileDiffPreviewTab = useCallback(
      (payload: OpenFileDiffPreviewPayload) => {
        const tabId = `file-diff-preview:${payload.filePath}`;
        const patch = generateComparePatch(
          payload.fileName,
          payload.oldContent,
          payload.newContent,
          payload.oldStartLine,
          payload.newStartLine,
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
      [],
    );

    useEffect(() => {
      return rightPanelEvents.on(
        "open-file-diff-preview",
        handleOpenFileDiffPreviewTab,
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
      [handleOpenBrowserTab],
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
      [],
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
            payload.sshWorkspaceId,
          );
          rightPanelEvents.emit("request-expand");
        })().catch((error: unknown) => {
          console.error("Failed to open file from chat path", error);
        });
      },
      [getSshFileSession, handleOpenFileTab],
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
        openDrawing: () => {
          handleOpenDrawingTab();
        },
        openFile: (
          filePath: string,
          fileName: string,
          isSsh?: boolean,
          sshSessionId?: string | null,
          focusLine?: number,
          sshWorkspaceRoot?: string,
          sshWorkspaceId?: string,
        ) => {
          handleOpenFileTab(
            filePath,
            fileName,
            isSsh ?? false,
            sshSessionId,
            focusLine,
            sshWorkspaceRoot,
            sshWorkspaceId,
          );
        },
      }),
      [
        handleOpenTerminalTab,
        handleOpenBrowserTab,
        handleOpenCodebaseTab,
        handleOpenDrawingTab,
        handleOpenFileTab,
      ],
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
          return gitTab ? GIT_TAB_ID : (tabs[1]?.id ?? currentActive);
        });
      },
      [tabs],
    );

    // 关闭所有可关闭的 tab（Git 为固定 tab，始终保留），回到 Git 视图。
    const handleCloseAllTabs = useCallback(() => {
      setTabs((prev) => prev.filter((t) => t.id === GIT_TAB_ID));
      setDirtyTabs(new Set());
      setActiveTabId(GIT_TAB_ID);
    }, []);

    // 批量关闭：移除 closed 中的 tab 并清理 dirty 标记；
    // 若当前激活的 tab 也在关闭列表内，则切换到 fallbackTabId。
    const batchCloseTabs = useCallback(
      (closed: RightPanelTab[], fallbackTabId: string) => {
        if (closed.length === 0) {
          return;
        }
        const closedIds = new Set(closed.map((t) => t.id));
        setTabs((prev) => prev.filter((t) => !closedIds.has(t.id)));
        setDirtyTabs((prev) => {
          const next = new Set(prev);
          closed.forEach((t) => next.delete(t.id));
          return next;
        });
        setActiveTabId((current) =>
          closedIds.has(current) ? fallbackTabId : current,
        );
      },
      [],
    );

    // 关闭除指定 tab（与 Git 固定 tab）外的所有 tab。
    const handleCloseOthers = useCallback(
      (tabId: string) => {
        batchCloseTabs(
          tabs.filter((t) => t.id !== GIT_TAB_ID && t.id !== tabId),
          tabId,
        );
      },
      [tabs, batchCloseTabs],
    );

    // 关闭指定 tab 右侧的所有 tab（Git 固定 tab 始终保留）。
    const handleCloseToRight = useCallback(
      (tabId: string) => {
        const idx = tabs.findIndex((t) => t.id === tabId);
        if (idx < 0) {
          return;
        }
        batchCloseTabs(
          tabs.slice(idx + 1).filter((t) => t.id !== GIT_TAB_ID),
          tabId,
        );
      },
      [tabs, batchCloseTabs],
    );

    // 关闭指定 tab 左侧的所有可关闭 tab（Git 固定 tab 始终保留）。
    const handleCloseToLeft = useCallback(
      (tabId: string) => {
        const idx = tabs.findIndex((t) => t.id === tabId);
        if (idx < 0) {
          return;
        }
        batchCloseTabs(
          tabs.slice(0, idx).filter((t) => t.id !== GIT_TAB_ID),
          tabId,
        );
      },
      [tabs, batchCloseTabs],
    );

    const handleCloseBrowserTab = useCallback(
      (instanceId: string): boolean => {
        const tab = tabs.find(
          (t) => t.id === instanceId && t.type === "browser",
        );
        if (!tab) {
          return false;
        }
        handleCloseTab(instanceId);
        return true;
      },
      [tabs, handleCloseTab],
    );

    // 浏览器 tab「在新窗口中打开」：主进程创建独立 BrowserWindow 承载
    // 同一实例（继承 instanceId，browser.rs 工具仍可继续操作），并把
    // 实例内部的全部标签页快照（tabs）一并携带，独立窗口重建完整标签页，
    // 成功后关闭原 tab 完成迁移。
    const handleOpenBrowserInNewWindow = useCallback(
      (tabId: string): void => {
        const tab = tabs.find((t) => t.id === tabId && t.type === "browser");
        if (!tab) {
          return;
        }
        const browserTab = tab.data as BrowserTabData;
        void window.snow
          .openDetachedBrowserWindow(
            browserTab.instanceId,
            browserTab.url,
            browserTab.tabs,
          )
          .then(() => {
            handleCloseTab(tabId);
          })
          .catch((error) => {
            console.error("Failed to open browser in new window", error);
          });
      },
      [tabs, handleCloseTab],
    );

    // 独立浏览器窗口「还原为标签页」：主进程转发还原请求后，把该实例恢复
    // 为右侧面板浏览器 tab。保持原 instanceId（MCP 浏览器工具按实例路由，
    // 新 tab 挂载上报后自动接管）；携带的全部内部标签页快照经
    // initialTabs 初始化，第一个为激活页。
    const handleRestoreBrowserFromDetachedWindow = useCallback(
      (payload: BrowserRestorePayload): void => {
        const instanceId = payload.instanceId.trim();
        if (!instanceId) {
          return;
        }
        const restoredTabs = (payload.tabs ?? [])
          .map((tab) => ({ url: tab.url, title: tab.title }))
          .filter((tab) => tab.url.trim());
        const firstUrl = restoredTabs[0]?.url ?? "";
        setTabs((prev) => {
          const existing = prev.find(
            (t) => t.id === instanceId && t.type === "browser",
          );
          if (existing) {
            // 同实例 tab 已存在（极端竞态）：刷新快照并激活，不重复创建。
            const existingData = existing.data as BrowserTabData;
            return prev.map((t) =>
              t.id === instanceId && t.type === "browser"
                ? {
                    ...t,
                    title: restoredTabs[0]?.title || existing.title,
                    data: {
                      ...existingData,
                      url: firstUrl || existingData.url,
                      tabs: restoredTabs,
                    },
                  }
                : t,
            );
          }
          return [
            ...prev,
            {
              id: instanceId,
              type: "browser",
              title: restoredTabs[0]?.title || t("rightPanel.browserTab"),
              data: {
                instanceId,
                url: firstUrl,
                tabs: restoredTabs,
              },
            },
          ];
        });
        setActiveTabId(instanceId);
        rightPanelEvents.emit("request-expand");
      },
      [t],
    );

    useEffect(() => {
      return window.snow.onRestoreBrowserToMain(
        handleRestoreBrowserFromDetachedWindow,
      );
    }, [handleRestoreBrowserFromDetachedWindow]);

    const handleFocusBrowserTab = useCallback(
      (instanceId: string): boolean => {
        const tab = tabs.find(
          (t) => t.id === instanceId && t.type === "browser",
        );
        if (!tab) {
          return false;
        }
        setActiveTabId(instanceId);
        focusBrowserMcpInstance(instanceId);
        return true;
      },
      [tabs],
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
      [handleFocusBrowserTab],
    );

    useEffect(() => {
      return rightPanelEvents.on(
        "focus-browser-tab",
        handleFocusBrowserTabEvent,
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
      ],
    );

    // MCP 浏览器命令桥：传入 isCollapsed，面板折叠时命令执行前先自动
    // 展开（webview 不可见时 capturePage 返回空白，screenshot 必然失败）。
    useBrowserMcpCommandBridge(browserMcpCallbacks, isCollapsed);

    const handleCloseTerminalTab = useCallback(
      (tabId: string): boolean => {
        const tab = tabs.find((t) => t.id === tabId && t.type === "terminal");
        if (!tab) {
          return false;
        }
        handleCloseTab(tabId);
        return true;
      },
      [tabs, handleCloseTab],
    );

    const handleFocusTerminalTab = useCallback(
      (tabId: string): boolean => {
        const tab = tabs.find((t) => t.id === tabId && t.type === "terminal");
        if (!tab) {
          return false;
        }
        setActiveTabId(tabId);
        return true;
      },
      [tabs],
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
      ],
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

    // tab 关闭按钮点击：terminal / browser 需要二次确认（tooltip 浮层），
    // 其余类型（file / diff 等）直接关闭。浮层坐标基于关闭按钮相对
    // tab-list 的位置计算，maxX 用于防止浮层超出 tab 栏右边界。
    const handleTabCloseClick = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>, tab: RightPanelTab) => {
        if (tab.type !== "terminal" && tab.type !== "browser") {
          handleCloseTab(tab.id);
          return;
        }
        const listRect = tabListRef.current?.getBoundingClientRect();
        if (!listRect) {
          handleCloseTab(tab.id);
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        setCloseConfirm({
          tabId: tab.id,
          x: rect.left - listRect.left,
          y: rect.bottom - listRect.top,
          maxX: listRect.width - 4,
        });
      },
      [handleCloseTab],
    );

    // 确认关闭：执行关闭并收起浮层。
    const confirmCloseTab = useCallback((): void => {
      if (closeConfirm) {
        handleCloseTab(closeConfirm.tabId);
      }
      setCloseConfirm(null);
    }, [closeConfirm, handleCloseTab]);

    // 点击浮层以外的任意位置时收起确认浮层（捕获阶段，浮层内已阻止冒泡）。
    useEffect(() => {
      if (!closeConfirm) {
        return;
      }
      const handlePointerDown = (event: MouseEvent): void => {
        const target = event.target as Element | null;
        if (target && !target.closest(".right-panel-close-confirm")) {
          setCloseConfirm(null);
        }
      };
      document.addEventListener("mousedown", handlePointerDown, true);
      return () =>
        document.removeEventListener("mousedown", handlePointerDown, true);
    }, [closeConfirm]);

    // Windows 下 Plus 菜单与最大化按钮位于 tab 操作区（right-panel-tabs 内），
    // 替代 TopBar 右侧的同名按钮；非 Windows 平台不渲染操作区。
    const plusMenuItems: PlusMenuItem[] = [
      {
        id: "terminal",
        label: t("topBar.plusMenu.terminal", { defaultValue: "Terminal" }),
        icon: Terminal,
      },
      {
        id: "browser",
        label: t("topBar.plusMenu.browser", { defaultValue: "Browser" }),
        icon: Globe,
      },
      {
        id: "drawing",
        label: t("topBar.plusMenu.drawing", { defaultValue: "Drawing" }),
        icon: Paintbrush,
      },
      // 代码库项需要具体项目承载；项目不可用时隐藏（与 TopBar 一致）。
      ...(activeDirectory?.directoryId
        ? [
            {
              id: "codebase" as PlusMenuAction,
              label: t("topBar.plusMenu.codebase"),
              icon: Database,
            },
          ]
        : []),
    ];

    const handlePlusMenuAction = (actionId: PlusMenuAction): void => {
      if (actionId === "terminal") {
        handleOpenTerminalTab(activeDirectory?.path ?? "");
      } else if (actionId === "browser") {
        handleOpenBrowserTab();
      } else if (actionId === "drawing") {
        handleOpenDrawingTab();
      } else if (actionId === "codebase" && activeDirectory?.directoryId) {
        handleOpenCodebaseTab(
          activeDirectory.directoryId,
          activeDirectory.name,
        );
      }
    };

    const FullscreenToggleIcon = isFullscreen ? Minimize2 : Maximize2;
    const fullscreenToggleLabel = isFullscreen
      ? "Exit right panel fullscreen"
      : "Right panel fullscreen";

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
              initialTabs={(tab.data as BrowserTabData).tabs}
              isActive={activeTabId === tab.id}
              onTitleChange={(title) => handleBrowserTitleChange(tab.id, title)}
              onUrlChange={(url) => handleBrowserUrlChange(tab.id, url)}
              onTabsChange={(tabs) => handleBrowserTabsChange(tab.id, tabs)}
            />
          ) : tab.type === "codebase" ? (
            (tab.data as CodebaseTabData) ? (
              <CodebasePanelContent
                projectId={(tab.data as CodebaseTabData).projectId}
                projectName={(tab.data as CodebaseTabData).projectName}
              />
            ) : null
          ) : tab.type === "drawing" ? (
            <DrawingPanelContent
              isActive={activeTabId === tab.id}
              onOpenImageGenSettings={
                onSelectMainView
                  ? () => onSelectMainView("imagegen-settings")
                  : undefined
              }
            />
          ) : tab.type === "diff" ? (
            (tab.data as DiffTabData) ? (
              <DiffViewer
                selectedFile={(tab.data as DiffTabData).selectedFile}
                diffResult={(tab.data as DiffTabData).diffResult}
                diffLoading={(tab.data as DiffTabData).diffLoading}
                imageDiff={(tab.data as DiffTabData).imageDiff ?? null}
              />
            ) : null
          ) : tab.type === "file" ? (
            (tab.data as FileViewerTabData) ? (
              <FileViewerContent
                filePath={(tab.data as FileViewerTabData).filePath}
                fileName={(tab.data as FileViewerTabData).fileName}
                isSsh={(tab.data as FileViewerTabData).isSsh}
                sshSessionId={(tab.data as FileViewerTabData).sshSessionId}
                sshWorkspaceRoot={
                  (tab.data as FileViewerTabData).sshWorkspaceRoot
                }
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

    // tab 右键菜单的派生状态：目标 tab 在 tabs 中的下标（无目标或
    // 空白区域右键时为 -1）与各关闭项是否适用（Git 固定 tab 除外）。
    const contextMenuTargetIndex =
      tabContextMenu !== null && tabContextMenu.tabId !== null
        ? tabs.findIndex((t) => t.id === tabContextMenu.tabId)
        : -1;
    const contextMenuTargetClosable =
      tabContextMenu !== null &&
      tabContextMenu.tabId !== null &&
      tabContextMenu.tabId !== GIT_TAB_ID;
    // 目标 tab 是否为浏览器 tab：决定是否提供「在新窗口中打开」。
    const contextMenuTargetIsBrowser =
      tabContextMenu !== null && tabContextMenu.tabId !== null
        ? tabs.some(
            (t) => t.id === tabContextMenu.tabId && t.type === "browser",
          )
        : false;
    const hasClosableTabs = tabs.some((t) => t.id !== GIT_TAB_ID);
    const hasClosableOthers =
      contextMenuTargetIndex >= 0 &&
      tabs.some((t, i) => i !== contextMenuTargetIndex && t.id !== GIT_TAB_ID);
    const hasClosableRight =
      contextMenuTargetIndex >= 0 &&
      tabs.slice(contextMenuTargetIndex + 1).some((t) => t.id !== GIT_TAB_ID);
    const hasClosableLeft =
      contextMenuTargetIndex >= 0 &&
      tabs.slice(0, contextMenuTargetIndex).some((t) => t.id !== GIT_TAB_ID);

    return (
      <aside className={panelClasses}>
        {tabs.length > 0 && (
          <div className="right-panel-tabs">
            <div
              ref={tabListRef}
              className="right-panel-tab-list"
              onScroll={() => setCloseConfirm(null)}
              onContextMenu={(event) => {
                // 仅空白区域触发：tab 项上已有各自的右键菜单。
                if (
                  (event.target as HTMLElement).closest(".right-panel-tab-item")
                ) {
                  return;
                }
                event.preventDefault();
                setCloseConfirm(null);
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
                  onClick={() => {
                    setCloseConfirm(null);
                    setActiveTabId(tab.id);
                  }}
                  draggable={DRAGGABLE_TAB_TYPES.has(tab.type)}
                  onDragStart={(event) => handleTabDragStart(event, tab)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setCloseConfirm(null);
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
                        handleTabCloseClick(e, tab);
                      }}
                      aria-label={t("rightPanel.closeTab")}
                    >
                      <X size={12} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {isWindows && (
              <div className="right-panel-tab-actions">
                <PlusMenuButton
                  items={plusMenuItems}
                  onAction={handlePlusMenuAction}
                />
                <button
                  className="icon-btn ghost right-panel-fullscreen-btn"
                  type="button"
                  aria-label={fullscreenToggleLabel}
                  title={fullscreenToggleLabel}
                  onClick={() => onToggleRightPanelFullscreen?.()}
                >
                  <FullscreenToggleIcon size={16} strokeWidth={1.8} />
                </button>
              </div>
            )}
            {closeConfirm && (
              <div
                className="right-panel-close-confirm"
                style={{
                  left: Math.max(
                    4,
                    Math.min(closeConfirm.x, closeConfirm.maxX - 168),
                  ),
                  top: closeConfirm.y + 5,
                }}
                role="tooltip"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <span
                  className="right-panel-close-confirm-arrow"
                  style={{
                    left: Math.max(
                      10,
                      Math.min(
                        closeConfirm.x +
                          8 -
                          Math.max(
                            4,
                            Math.min(closeConfirm.x, closeConfirm.maxX - 168),
                          ),
                        148,
                      ),
                    ),
                  }}
                  aria-hidden="true"
                />
                <span className="right-panel-close-confirm-text">
                  {tabs.find((t) => t.id === closeConfirm.tabId)?.type ===
                  "terminal"
                    ? t("rightPanel.confirmCloseTerminal", {
                        defaultValue: "关闭终端？",
                      })
                    : t("rightPanel.confirmCloseBrowser", {
                        defaultValue: "关闭浏览器？",
                      })}
                </span>
                <div className="right-panel-close-confirm-actions">
                  <button
                    type="button"
                    className="right-panel-close-confirm-btn danger"
                    onClick={confirmCloseTab}
                  >
                    {t("common.close")}
                  </button>
                  <button
                    type="button"
                    className="right-panel-close-confirm-btn"
                    onClick={() => setCloseConfirm(null)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
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
            isClosable={contextMenuTargetClosable}
            onCloseOthers={
              contextMenuTargetClosable && hasClosableOthers
                ? () => {
                    setTabContextMenu(null);
                    if (tabContextMenu.tabId !== null) {
                      handleCloseOthers(tabContextMenu.tabId);
                    }
                  }
                : undefined
            }
            onCloseToRight={
              contextMenuTargetClosable && hasClosableRight
                ? () => {
                    setTabContextMenu(null);
                    if (tabContextMenu.tabId !== null) {
                      handleCloseToRight(tabContextMenu.tabId);
                    }
                  }
                : undefined
            }
            onCloseToLeft={
              contextMenuTargetClosable && hasClosableLeft
                ? () => {
                    setTabContextMenu(null);
                    if (tabContextMenu.tabId !== null) {
                      handleCloseToLeft(tabContextMenu.tabId);
                    }
                  }
                : undefined
            }
            onCloseAllTabs={
              hasClosableTabs
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
            onNewDrawing={() => {
              setTabContextMenu(null);
              handleOpenDrawingTab();
            }}
            onOpenInNewWindow={
              contextMenuTargetIsBrowser
                ? () => {
                    setTabContextMenu(null);
                    if (tabContextMenu.tabId !== null) {
                      handleOpenBrowserInNewWindow(tabContextMenu.tabId);
                    }
                  }
                : undefined
            }
            onCloseTab={() => {
              setTabContextMenu(null);
              if (tabContextMenu.tabId !== null) {
                handleCloseTab(tabContextMenu.tabId);
              }
            }}
            onClose={() => setTabContextMenu(null)}
          />
        )}
      </aside>
    );
  },
);

RightPanel.displayName = "RightPanel";
