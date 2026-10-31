import {
  Bug,
  Database,
  FolderTree,
  Gauge,
  Globe,
  Maximize2,
  Minimize2,
  MessageSquarePlus,
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

import { useI18n } from "../i18n";
import { useShortcutLabel } from "../hooks/useShortcutLabel";
import { setWebTagDragData } from "./rightPanel/browserDrag";
import { GitPanelContent } from "./rightPanel/GitPanelContent";
import { openGitFileDiff } from "./rightPanel/git/openGitFileDiff";
import { DiffViewer } from "./rightPanel/DiffViewer";
import { FileDiffPreview } from "./common/FileDiffPreview";
import { codebaseSyncStore } from "./TopBar/codebaseSyncStore";
import { explorerPlacementStore } from "./common/explorerPlacementStore";
import {
  PlusMenuButton,
  type PlusMenuAction,
  type PlusMenuItem,
} from "./common/PlusMenuButton";
import { RightPanelTabContextMenu } from "./rightPanel/RightPanelTabContextMenu";
import { DetachedConversationSync } from "./rightPanel/DetachedConversationSync";
import { OverlayScrollbar } from "./common/OverlayScrollbar";
import { PluginIcon } from "./common/PluginIcon";
import { Puzzle } from "lucide-react";
import { resolveLocalized } from "../plugins/manifest";
import { pluginStore, usePluginStore } from "../plugins/pluginStore";
import { runtimeSnapshot } from "../plugins/runtimeSnapshot";
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
  getBrowserAgentAccess,
  subscribeBrowserAgentAccess,
  type BrowserAgentAccess,
} from "./rightPanel/browser/browserAgentAccess";
import {
  useTerminalMcpCommandBridge,
  type TerminalMcpTabCallbacks,
} from "./rightPanel/terminal/useTerminalMcpCommandBridge";
import { runCommandInTerminal } from "./rightPanel/terminal/terminalCommandRunner";
import {
  rightPanelEvents,
  type OpenBrowserTabPayload,
  type FocusBrowserTabPayload,
  type OpenFileDiffPreviewPayload,
  type OpenFilePayload,
  type OpenTerminalCommandPayload,
} from "./rightPanel/rightPanelEvents";
import { generateComparePatch } from "../utils/generateComparePatch";
import { isPdfFilePath, openBrowserFile } from "../utils/browserFileOpen";
import { hasCustomWindowFrame } from "../utils/platform";
import { getFileTypeIcon } from "../utils/fileIcons";
import { buildSshConnectParams } from "./sidebar/personalization/roleFileUtils";
import type {
  BrowserTabData,
  CodebaseTabData,
  ConversationTabData,
  DiffTabData,
  ExplorerTabData,
  FileDiffPreviewTabData,
  FileViewerTabData,
  OpenDiffTabCallback,
  PluginTabData,
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
import type { DetachedPanelTabPayload } from "../../shared/detachedPanel";
import {
  toDetachedTabPayload,
  toRightPanelTab,
} from "./rightPanel/detachedPanelTab";

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
    // 与实例 id（输入框 drop 后向该实例的 webview 请求三层网页快照）。
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
const PluginPanelContent = lazy(() =>
  import("./rightPanel/PluginPanelContent").then((m) => ({
    default: m.PluginPanelContent,
  })),
);
const ProjectExplorerContent = lazy(() =>
  import("./rightPanel/ProjectExplorerContent").then((m) => ({
    default: m.ProjectExplorerContent,
  })),
);
const TaskManagerContent = lazy(() =>
  import("./rightPanel/TaskManagerContent").then((m) => ({
    default: m.TaskManagerContent,
  })),
);
const ConversationTabPane = lazy(() =>
  import("./rightPanel/ConversationTabPane").then((m) => ({
    default: m.ConversationTabPane,
  })),
);

const GIT_TAB_ID = "git";
const CODEBASE_TAB_ID = "codebase";
const EXPLORER_TAB_ID = "explorer";
const TASKS_TAB_ID = "tasks";

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

const toLocalBrowserUrl = (url: string | undefined): string => {
  const trimmed = url?.trim() ?? "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : "";
};

export type RightPanelRef = {
  openTerminal: (cwd: string) => void;
  openBrowser: (url?: string) => void;
  openCodebase: (projectId: string, projectName: string) => void;
  openExplorer: (directoryId: string) => void;
  openDrawing: () => void;
  openTaskManager: () => void;
  openPluginPanel: (pluginId: string, panelId: string) => void;
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
  /** 切换主内容视图（绘图工作台错误卡片跳转设置用）。 */
  onSelectMainView?: (view: MainContentView) => void;
  /** 切换右面板全屏（Windows 下由 tab 操作区的最大化按钮触发）。 */
  onToggleRightPanelFullscreen?: () => void;
  /**
   * 独立面板窗口模式：窗口只承载本面板实例，初始 tab 由主进程交付。
   * 不提供 Git 固定 tab；最后一个 tab 关闭后关闭窗口。
   */
  detachedWindow?: { initialTab: RightPanelTab };
  /** 独立面板窗口模式：活动 tab 标题变化时回调（顶部操作栏显示用）。 */
  onActiveTabTitleChange?: (title: string) => void;
  /** 独立面板窗口模式：用户主动关闭最后一个 tab 时请求父级二次确认（确认后关窗）。 */
  onRequestCloseDetachedWindow?: () => void;
};

export const RightPanel = forwardRef<RightPanelRef, RightPanelProps>(
  (
    {
      isCollapsed,
      isFullscreen,
      activeDirectory,
      onSelectMainView,
      onToggleRightPanelFullscreen,
      detachedWindow,
      onActiveTabTitleChange,
      onRequestCloseDetachedWindow,
    },
    ref,
  ): React.JSX.Element => {
    const hasCustomFrame = hasCustomWindowFrame();
    const { t, locale } = useI18n();
    const fullscreenShortcutLabel = useShortcutLabel(
      "toggleRightPanelFullscreen",
    );
    const isDetachedWindow = detachedWindow !== undefined;
    const [tabs, setTabs] = useState<RightPanelTab[]>(() =>
      detachedWindow
        ? [detachedWindow.initialTab]
        : [{ id: GIT_TAB_ID, type: "git", title: t("rightPanel.gitTab") }],
    );
    const [activeTabId, setActiveTabId] = useState<string>(() =>
      detachedWindow ? detachedWindow.initialTab.id : GIT_TAB_ID,
    );
    // 「+」菜单「新建会话」入口（由 DetachedConversationSync 注册，仅独立窗口生效）。
    const createConversationTabRef = useRef<(() => void) | null>(null);
    // 终端 tab 当前绑定的 PTY id（会话建立时上报）。仅用于 tab 迁移时交接会话，
    // 不放进 tab.data：tab.data 变化会触发终端重建。
    const terminalPtyIdsRef = useRef(new Map<string, string>());
    const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
    // 浏览器 tab 的 Agent 共享状态来自 browserAgentAccess 注册表（非 React 状态），
    // 用版本号驱动重渲染以刷新标签栏徽标。
    const [, setAgentAccessVersion] = useState(0);
    useEffect(
      () =>
        subscribeBrowserAgentAccess(() =>
          setAgentAccessVersion((version) => version + 1),
        ),
      [],
    );
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

    // 订阅 TopBar 发布的代码库同步快照（TopBar 为 watcher 唯一持有者）。
    // Plus 菜单的“代码库”项据此判定是否对当前项目提供入口。
    const [codebaseSyncSnapshot, setCodebaseSyncSnapshot] = useState(() =>
      codebaseSyncStore.get(),
    );
    useEffect(() => codebaseSyncStore.subscribe(setCodebaseSyncSnapshot), []);

    // 订阅资源管理器显示位置偏好：仅“右侧面板”方案下提供 Plus 菜单入口；
    // 偏好切回左侧面板时同一批次内关闭右侧 tab，避免同一目录双实例。
    const [explorerPlacement, setExplorerPlacement] = useState(() =>
      explorerPlacementStore.get(),
    );
    useEffect(
      () =>
        explorerPlacementStore.subscribe((next) => {
          setExplorerPlacement(next);
          if (next !== "sidebar") {
            return;
          }
          setTabs((prev) =>
            prev.some((t) => t.id === EXPLORER_TAB_ID)
              ? prev.filter((t) => t.id !== EXPLORER_TAB_ID)
              : prev,
          );
          setActiveTabId((current) =>
            current === EXPLORER_TAB_ID ? GIT_TAB_ID : current,
          );
        }),
      [],
    );

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
        const { title, ...terminalOptions } = options ?? {};
        const terminalData: TerminalTabData = {
          cwd,
          ...terminalOptions,
        };
        setTabs((prev) => [
          ...prev,
          {
            id: tabId,
            type: "terminal",
            title: title?.trim() || t("rightPanel.terminalTab"),
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
      (
        url?: string,
        requestedInstanceId?: string,
        activate = true,
        access?: BrowserAgentAccess,
      ): string => {
        const instanceId =
          requestedInstanceId ??
          `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const browserData: BrowserTabData = {
          instanceId,
          url: url ?? "",
          agentAccess: access ?? {
            shared: false,
            isolated: false,
            origin: "user",
            url: url ?? "",
          },
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
        if (activate) {
          setActiveTabId(instanceId);
        }
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

    // 打开（或切换到已存在的）资源管理器 tab。tab id 固定：全局唯一，
    // 切换项目时更新 data 复用同一 tab，文件列表随之重新加载。
    const handleOpenExplorerTab = useCallback(
      (directoryId: string) => {
        setTabs((prev) => {
          const existing = prev.find((t) => t.id === EXPLORER_TAB_ID);
          if (existing) {
            return prev.map((t) =>
              t.id === EXPLORER_TAB_ID
                ? { ...t, data: { directoryId } as ExplorerTabData }
                : t,
            );
          }
          const explorerData: ExplorerTabData = { directoryId };
          return [
            ...prev,
            {
              id: EXPLORER_TAB_ID,
              type: "explorer",
              title: t("rightPanel.explorerTab"),
              data: explorerData,
            },
          ];
        });
        setActiveTabId(EXPLORER_TAB_ID);
        rightPanelEvents.emit("request-expand");
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

    // 打开（或切换到已存在的）应用任务管理器 tab：全局唯一固定 tab。
    const handleOpenTaskManagerTab = useCallback((): void => {
      setTabs((prev) =>
        prev.some((tab) => tab.id === TASKS_TAB_ID)
          ? prev
          : [
              ...prev,
              {
                id: TASKS_TAB_ID,
                type: "tasks",
                title: t("rightPanel.tasksTab"),
              },
            ],
      );
      setActiveTabId(TASKS_TAB_ID);
    }, [t]);

    // 插件面板 tab：同一插件的同一面板复用同一个 tab（避免重复实例）。
    const handleOpenPluginPanel = useCallback(
      (pluginId: string, panelId: string, title: string): string => {
        const tabId = `plugin:${pluginId}:${panelId}`;
        setTabs((prev) =>
          prev.some((tab) => tab.id === tabId)
            ? prev
            : [
                ...prev,
                {
                  id: tabId,
                  type: "plugin",
                  title,
                  data: { pluginId, panelId },
                },
              ],
        );
        setActiveTabId(tabId);
        return tabId;
      },
      [],
    );

    useEffect(() => {
      return rightPanelEvents.on("open-plugin-panel", (payload) => {
        handleOpenPluginPanel(
          payload.pluginId,
          payload.panelId,
          payload.title?.trim() || payload.pluginId,
        );
        rightPanelEvents.emit("request-expand");
      });
    }, [handleOpenPluginPanel]);

    useEffect(() => {
      return rightPanelEvents.on("open-explorer", (payload) => {
        handleOpenExplorerTab(payload.directoryId);
      });
    }, [handleOpenExplorerTab]);

    const pluginState = usePluginStore();

    useEffect(() => {
      void pluginStore.ensureLoaded();
    }, []);

    useEffect(() => {
      runtimeSnapshot.patch({
        panels: {
          tabs: tabs.map((tab) => {
            const pluginData =
              tab.type === "plugin" ? (tab.data as PluginTabData) : null;
            return {
              id: tab.id,
              type: tab.type,
              title: tab.title,
              isActive: tab.id === activeTabId,
              ...(pluginData
                ? {
                    pluginId: pluginData.pluginId,
                    panelId: pluginData.panelId,
                  }
                : {}),
            };
          }),
          activeTabId,
          isCollapsed,
          isFullscreen,
        },
      });
    }, [tabs, activeTabId, isCollapsed, isFullscreen]);

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

    // 切换项目后资源管理器 tab 自动指向新的活动目录，文件列表随之重新加载。
    useEffect(() => {
      const directoryId = activeDirectory?.directoryId;
      if (!directoryId) {
        return;
      }
      setTabs((prev) =>
        prev.some((t) => t.id === EXPLORER_TAB_ID)
          ? prev.map((t) =>
              t.id === EXPLORER_TAB_ID
                ? { ...t, data: { directoryId } as ExplorerTabData }
                : t,
            )
          : prev,
      );
    }, [activeDirectory?.directoryId]);

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
        // 本地 PDF 交给内置浏览器自带的查看器渲染，不进文件阅读器：
        // 渲染层 pdf.js 预览需要额外的解析器与字体资源，且容易停在加载态。
        // 远端 PDF 无法用 file:// 打开，仍由文件阅读器抽取文本展示。
        if (!isSsh && isPdfFilePath(filePath) && openBrowserFile(filePath)) {
          return;
        }
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

    // 当前活动工作区为 SSH 工作区时的根路径与工作区 id：Git 面板打开远程文件
    // 需要用它建立 SSH 会话，并为文件 tab 提供下载等远程能力（本地为 undefined）。
    const activeSshWorkspacePath =
      activeDirectory && activeDirectory.path.startsWith("ssh://")
        ? activeDirectory.path
        : undefined;
    const activeSshWorkspaceId = activeSshWorkspacePath
      ? activeDirectory?.directoryId
      : undefined;

    // Git 变更/暂存区文件「打开文件」按钮：在右侧面板新建 file tab，通过
    // FileViewerContent 显示文件原文。SSH 仓库的路径是 ssh:// URI，必须先转成
    // SFTP 使用的裸远端路径并建立 SSH 会话，否则会被当成不存在的本地路径读取。
    const handleOpenFileFromGit = useCallback(
      (filePath: string, fileName: string) => {
        if (!filePath.startsWith("ssh://")) {
          handleOpenFileTab(filePath, fileName, false);
          return;
        }

        // 剥离 ssh://authority，得到 /home/... 形式的裸远端路径（与聊天区
        // Ctrl+点击路径打开远程文件时使用的解析方式一致）。
        const remotePath = filePath.replace(/^ssh:\/\/[^/]+/, "") || "/";
        void getSshFileSession(activeSshWorkspacePath ?? filePath)
          .then((sshSessionId) => {
            handleOpenFileTab(
              remotePath,
              fileName,
              true,
              sshSessionId,
              undefined,
              activeSshWorkspacePath,
              activeSshWorkspaceId,
            );
          })
          .catch((error: unknown) => {
            console.error("Failed to open remote file from git panel", error);
          });
      },
      [
        activeSshWorkspaceId,
        activeSshWorkspacePath,
        getSshFileSession,
        handleOpenFileTab,
      ],
    );

    // 顶栏 Git 变更视图（右面板收起时）请求打开差异/原文，打开后展开面板
    useEffect(() => {
      const offDiff = rightPanelEvents.on("open-git-diff", (payload) => {
        openGitFileDiff(
          payload.repoPath,
          payload.file,
          payload.staged,
          handleOpenDiffTab,
        );
        rightPanelEvents.emit("request-expand");
      });
      const offFile = rightPanelEvents.on("open-git-file", (payload) => {
        handleOpenFileFromGit(payload.filePath, payload.fileName);
        rightPanelEvents.emit("request-expand");
      });
      return () => {
        offDiff();
        offFile();
      };
    }, [handleOpenDiffTab, handleOpenFileFromGit]);

    const handleOpenFileDiffPreviewTab = useCallback(
      (payload: OpenFileDiffPreviewPayload) => {
        const tabId = `file-diff-preview:${payload.filePath}`;
        const patch =
          typeof payload.patch === "string"
            ? payload.patch
            : generateComparePatch(
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

    // 自定义指令（Bash 类型）请求：新建终端 tab，等 PTY 就绪后把命令写进去，
    // 由真实 shell 执行——输出与后续交互都留在终端里。
    const handleOpenTerminalCommandEvent = useCallback(
      (payload: OpenTerminalCommandPayload) => {
        const command = payload.command.trim();
        const cwd = payload.cwd.trim() || activeDirectory?.path || "";
        const tabId = handleOpenTerminalTab(cwd, undefined, {
          title: payload.title?.trim() || undefined,
        });
        rightPanelEvents.emit("request-expand");
        if (command) {
          void runCommandInTerminal(tabId, command).catch((error: unknown) => {
            console.error("Failed to run command in terminal", error);
          });
        }
      },
      [activeDirectory?.path, handleOpenTerminalTab],
    );

    useEffect(() => {
      return rightPanelEvents.on(
        "open-terminal-command",
        handleOpenTerminalCommandEvent,
      );
    }, [handleOpenTerminalCommandEvent]);

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
        openExplorer: (directoryId: string) => {
          handleOpenExplorerTab(directoryId);
        },
        openDrawing: () => {
          handleOpenDrawingTab();
        },
        openTaskManager: () => {
          handleOpenTaskManagerTab();
        },
        openPluginPanel: (pluginId: string, panelId: string) => {
          const plugin = pluginStore.getById(pluginId);
          const panel = plugin?.panels.find((item) => item.id === panelId);
          handleOpenPluginPanel(
            pluginId,
            panelId,
            panel
              ? resolveLocalized(panel.title, locale)
              : (plugin?.pluginId ?? pluginId),
          );
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
        handleOpenExplorerTab,
        handleOpenDrawingTab,
        handleOpenTaskManagerTab,
        handleOpenPluginPanel,
        handleOpenFileTab,
      ],
    );

    const handleCloseTab = useCallback(
      (tabId: string) => {
        terminalPtyIdsRef.current.delete(tabId);
        setTabs((prev) => {
          if (tabId === GIT_TAB_ID) {
            return prev;
          }
          const filtered = prev.filter((t) => t.id !== tabId);
          // 独立面板窗口允许清空（清空即关闭窗口）；主面板至少保留一个 tab。
          if (filtered.length === 0 && !isDetachedWindow) {
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
      [tabs, isDetachedWindow],
    );

    // 快捷键切换资源管理器：折叠时先展开；已停在该 tab 时关闭（切到相邻 tab）。
    useEffect(() => {
      return rightPanelEvents.on("toggle-explorer", (payload) => {
        if (isCollapsed) {
          rightPanelEvents.emit("request-expand");
          if (activeTabId !== EXPLORER_TAB_ID) {
            handleOpenExplorerTab(payload.directoryId);
          }
          return;
        }
        if (activeTabId === EXPLORER_TAB_ID) {
          handleCloseTab(EXPLORER_TAB_ID);
          return;
        }
        handleOpenExplorerTab(payload.directoryId);
      });
    }, [activeTabId, isCollapsed, handleCloseTab, handleOpenExplorerTab]);

    // 关闭所有可关闭的 tab（Git 为固定 tab，始终保留），回到 Git 视图。
    const handleCloseAllTabs = useCallback(() => {
      terminalPtyIdsRef.current.clear();
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
        closed.forEach((t) => terminalPtyIdsRef.current.delete(t.id));
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

    const handleOpenBrowserInLocalBrowser = useCallback(
      (tabId: string): void => {
        const tab = tabs.find((t) => t.id === tabId && t.type === "browser");
        const url = toLocalBrowserUrl(
          tab ? (tab.data as BrowserTabData).url : undefined,
        );
        if (!url) {
          return;
        }
        window.open(url, "_blank");
      },
      [tabs],
    );

    // 右侧面板 tab「在新窗口中打开」（所有类型统一）：tab 快照交给主进程创建独立面板窗口，
    // 成功后从本面板移除。Git 为固定 tab，主面板保留它，新窗口内得到一份副本。
    const handleOpenTabInNewWindow = useCallback(
      (tabId: string): void => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) {
          return;
        }
        void toDetachedTabPayload(tab, terminalPtyIdsRef.current.get(tab.id))
          .then((snapshot) =>
            window.snow.openDetachedPanelWindow({
              tab: snapshot,
              activeDirectory: activeDirectory ?? null,
            }),
          )
          .then(() => {
            if (tab.id !== GIT_TAB_ID) {
              handleCloseTab(tab.id);
            }
          })
          .catch((error: unknown) => {
            console.error("Failed to open tab in new window", error);
          });
      },
      [tabs, activeDirectory, handleCloseTab],
    );

    // 独立面板窗口「移回主窗口」：快照经主进程转发给主窗口恢复为 tab；主进程确认
    // 投递后才从本窗口移除，避免主窗口不可用时 tab 丢失。
    const handleReturnTabToMain = useCallback(
      (tabId: string): void => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) {
          return;
        }
        void toDetachedTabPayload(tab, terminalPtyIdsRef.current.get(tab.id))
          .then((snapshot) => window.snow.returnDetachedPanelTab(snapshot))
          .then((delivered) => {
            if (delivered) {
              handleCloseTab(tab.id);
            }
          })
          .catch((error: unknown) => {
            console.error("Failed to return tab to main window", error);
          });
      },
      [tabs, handleCloseTab],
    );

    // 独立面板窗口移回的 tab：恢复为主面板 tab（同 id 已存在则仅激活，如 Git 固定 tab）。
    const handleDetachedTabReturn = useCallback(
      (payload: DetachedPanelTabPayload): void => {
        const restored = toRightPanelTab(payload);
        setTabs((prev) =>
          prev.some((t) => t.id === restored.id) ? prev : [...prev, restored],
        );
        setActiveTabId(restored.id);
        rightPanelEvents.emit("request-expand");
      },
      [],
    );

    useEffect(
      () => window.snow.onDetachedPanelReturn(handleDetachedTabReturn),
      [handleDetachedTabReturn],
    );

    // 独立面板窗口：窗口标题（任务栏）与顶部操作栏跟随当前活动 tab；清空所有 tab 后关闭窗口。
    useEffect(() => {
      if (!isDetachedWindow) {
        return;
      }
      const activeTitle =
        tabs.find((tab) => tab.id === activeTabId)?.title || "Snow";
      document.title = activeTitle;
      onActiveTabTitleChange?.(activeTitle);
    }, [isDetachedWindow, tabs, activeTabId, onActiveTabTitleChange]);

    useEffect(() => {
      if (isDetachedWindow && tabs.length === 0) {
        // 程序性清空（移出 / 移回等）：直接关闭；用户主动关闭最后一个 tab 已由 requestCloseTab 确认。
        void window.snow.confirmDetachedPanelClose();
      }
    }, [isDetachedWindow, tabs.length]);

    // 主窗口外部请求新建浏览器 tab（设置页历史记录等经主进程转发）：在右侧面板新建浏览器 tab。
    useEffect(() => {
      return window.snow.onOpenBrowserTabInMain((payload) => {
        const url = payload.url.trim();
        if (!url) {
          return;
        }
        handleOpenBrowserTab(url);
        rightPanelEvents.emit("request-expand");
      });
    }, [handleOpenBrowserTab]);

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
        .map((t) => {
          const access = getBrowserAgentAccess(t.id);
          return {
            instanceId: t.id,
            title: t.title,
            url: (t.data as BrowserTabData)?.url ?? "",
            isActive: t.id === activeTabId,
            shared: access?.shared ?? false,
            isolated: access?.isolated ?? false,
            origin: access?.origin ?? ("user" as const),
          };
        });
    }, [tabs, activeTabId]);

    const browserMcpCallbacks = useMemo<BrowserMcpTabCallbacks>(
      () => ({
        openTab: (url, instanceId, access) =>
          handleOpenBrowserTab(url, instanceId, true, access),
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

    // 用户主动关闭 tab（标签按钮、中键、右键菜单）的统一入口：独立窗口的最后一个 tab
    // 关闭即关窗，先交由父级确认框二次确认（与点击窗口关闭按钮一致）。
    const requestCloseTab = useCallback(
      (tabId: string): void => {
        if (
          isDetachedWindow &&
          tabs.length === 1 &&
          tabs[0].id === tabId &&
          onRequestCloseDetachedWindow
        ) {
          onRequestCloseDetachedWindow();
          return;
        }
        handleCloseTab(tabId);
      },
      [isDetachedWindow, tabs, handleCloseTab, onRequestCloseDetachedWindow],
    );

    // tab 关闭按钮点击：terminal / browser 需要二次确认（tooltip 浮层），
    // 其余类型（file / diff 等）直接关闭。浮层坐标基于关闭按钮相对
    // tab-list 的位置计算，maxX 用于防止浮层超出 tab 栏右边界。
    const handleTabCloseClick = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>, tab: RightPanelTab) => {
        if (tab.type !== "terminal" && tab.type !== "browser") {
          requestCloseTab(tab.id);
          return;
        }
        const listRect = tabListRef.current?.getBoundingClientRect();
        if (!listRect) {
          requestCloseTab(tab.id);
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
      [requestCloseTab],
    );

    // 确认关闭：执行关闭并收起浮层。
    const confirmCloseTab = useCallback((): void => {
      if (closeConfirm) {
        requestCloseTab(closeConfirm.tabId);
      }
      setCloseConfirm(null);
    }, [closeConfirm, requestCloseTab]);

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
    // 与 TopBar 一致：代码库功能已为当前项目启用且索引建立完毕后，才在
    // Plus 菜单中提供“代码库”项；判定数据来自 codebaseSyncStore 快照。
    const canOpenCodebase =
      Boolean(activeDirectory?.directoryId) &&
      codebaseSyncSnapshot !== null &&
      codebaseSyncSnapshot.enabled &&
      codebaseSyncSnapshot.isIndexed &&
      codebaseSyncSnapshot.activeProjectId === activeDirectory?.directoryId;
    const pluginPanels = pluginState.plugins.flatMap((plugin) =>
      plugin.enabled
        ? plugin.panels.map((_, panelIndex) => ({ plugin, panelIndex }))
        : [],
    );
    const plusMenuItems: PlusMenuItem[] = [
      ...(isDetachedWindow
        ? [
            {
              id: "conversation",
              label: t("sidebar.newChat", { defaultValue: "New Chat" }),
              icon: MessageSquarePlus,
            },
          ]
        : []),
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
      ...(explorerPlacement === "right-panel"
        ? [
            {
              id: "explorer" as PlusMenuAction,
              label: t("topBar.plusMenu.explorer", {
                defaultValue: "Explorer",
              }),
              icon: FolderTree,
            },
          ]
        : []),
      ...(canOpenCodebase
        ? [
            {
              id: "codebase" as PlusMenuAction,
              label: t("topBar.plusMenu.codebase"),
              icon: Database,
            },
          ]
        : []),
      {
        id: "tasks",
        label: t("topBar.plusMenu.tasks", { defaultValue: "Task manager" }),
        icon: Gauge,
      },
      {
        id: "devtools",
        label: t("topBar.plusMenu.devtools", {
          defaultValue: "Developer tools",
        }),
        icon: Bug,
      },
      ...pluginPanels.map(({ plugin, panelIndex }) => {
        const panel = plugin.panels[panelIndex];
        const panelTitle = resolveLocalized(panel.title, locale);
        return {
          id: `plugin:${plugin.pluginId}:${panel.id}`,
          label: panelTitle,
          title: `${resolveLocalized(plugin.name, locale)} · ${panelTitle}`,
          icon: Puzzle,
          section: "plugins",
          sectionLabel: t("rightPanel.tabContextGroupPlugins", {
            defaultValue: "Plugins",
          }),
          iconNode: (
            <PluginIcon
              pluginId={plugin.pluginId}
              icon={panel.icon || plugin.icon}
              size={13}
            />
          ),
        } satisfies PlusMenuItem;
      }),
    ];

    const handlePlusMenuAction = (actionId: PlusMenuAction): void => {
      if (actionId.startsWith("plugin:")) {
        const [, pluginId, panelId] = actionId.split(":");
        if (pluginId && panelId) {
          const plugin = pluginStore.getById(pluginId);
          const panel = plugin?.panels.find((item) => item.id === panelId);
          handleOpenPluginPanel(
            pluginId,
            panelId,
            panel
              ? resolveLocalized(panel.title, locale)
              : (plugin?.name[locale] ?? pluginId),
          );
        }
        return;
      }
      if (actionId === "conversation") {
        createConversationTabRef.current?.();
      } else if (actionId === "terminal") {
        handleOpenTerminalTab(activeDirectory?.path ?? "");
      } else if (actionId === "browser") {
        handleOpenBrowserTab();
      } else if (actionId === "drawing") {
        handleOpenDrawingTab();
      } else if (actionId === "tasks") {
        handleOpenTaskManagerTab();
      } else if (actionId === "devtools") {
        void window.snow.toggleDevTools();
      } else if (actionId === "explorer") {
        handleOpenExplorerTab(activeDirectory?.directoryId ?? "");
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
      isDetachedWindow ? "right-panel-detached" : "",
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
              projectId={activeDirectory?.directoryId}
              isActive={activeTabId === tab.id}
              onTitleChange={(title) =>
                handleTerminalTitleChange(tab.id, title)
              }
              onOpenLink={(url) => handleOpenBrowserTab(url)}
              initialSnapshot={(tab.data as TerminalTabData).snapshot}
              onPtyChange={(ptyId) => {
                if (ptyId) {
                  terminalPtyIdsRef.current.set(tab.id, ptyId);
                } else {
                  terminalPtyIdsRef.current.delete(tab.id);
                }
              }}
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
              isPanelCollapsed={isCollapsed && !isDetachedWindow}
              projectId={activeDirectory?.directoryId}
              agentAccess={(tab.data as BrowserTabData).agentAccess}
              detached={isDetachedWindow}
              onRestoreToTabs={
                isDetachedWindow
                  ? () => handleReturnTabToMain(tab.id)
                  : undefined
              }
              onTitleChange={(title) => handleBrowserTitleChange(tab.id, title)}
              onUrlChange={(url) => handleBrowserUrlChange(tab.id, url)}
              onOpenNewTab={(url, activate) =>
                handleOpenBrowserTab(url, undefined, activate)
              }
            />
          ) : tab.type === "codebase" ? (
            (tab.data as CodebaseTabData) ? (
              <CodebasePanelContent
                projectId={(tab.data as CodebaseTabData).projectId}
                projectName={(tab.data as CodebaseTabData).projectName}
              />
            ) : null
          ) : tab.type === "explorer" ? (
            <ProjectExplorerContent
              directoryId={
                (tab.data as ExplorerTabData | undefined)?.directoryId ?? ""
              }
              onOpenFile={handleOpenFileTab}
              onOpenTerminal={(cwd) => handleOpenTerminalTab(cwd ?? "")}
            />
          ) : tab.type === "drawing" ? (
            <DrawingPanelContent
              isActive={activeTabId === tab.id}
              onOpenImageGenSettings={
                onSelectMainView
                  ? () => onSelectMainView("imagegen-settings")
                  : undefined
              }
            />
          ) : tab.type === "tasks" ? (
            <TaskManagerContent isActive={activeTabId === tab.id} />
          ) : tab.type === "conversation" ? (
            <ConversationTabPane
              conversationId={(tab.data as ConversationTabData).conversationId}
              isActive={activeTabId === tab.id}
              activeDirectory={activeDirectory}
            />
          ) : tab.type === "plugin" ? (
            (tab.data as PluginTabData) ? (
              <PluginPanelContent
                pluginId={(tab.data as PluginTabData).pluginId}
                panelId={(tab.data as PluginTabData).panelId}
                isActive={activeTabId === tab.id}
              />
            ) : null
          ) : tab.type === "diff" ? (
            (tab.data as DiffTabData) ? (
              <DiffViewer
                selectedFile={(tab.data as DiffTabData).selectedFile}
                diffResult={(tab.data as DiffTabData).diffResult}
                diffLoading={(tab.data as DiffTabData).diffLoading}
                imageDiff={(tab.data as DiffTabData).imageDiff ?? null}
                directoryId={activeDirectory?.directoryId ?? null}
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
    // 目标 tab 是否存在：决定是否提供「在新窗口中打开」（所有类型通用）。
    const contextMenuTargetExists =
      tabContextMenu !== null &&
      tabContextMenu.tabId !== null &&
      tabs.some((t) => t.id === tabContextMenu.tabId);
    // 目标 tab 是否为会话 tab：会话运行时只能留在所在窗口，不提供「在新窗口中打开」与「移回主窗口」。
    const contextMenuTargetIsConversation =
      tabContextMenu !== null && tabContextMenu.tabId !== null
        ? tabs.some(
            (t) => t.id === tabContextMenu.tabId && t.type === "conversation",
          )
        : false;
    // 目标 tab 是否为浏览器 tab：决定是否提供「在本地浏览器中打开」。
    const contextMenuTargetIsBrowser =
      tabContextMenu !== null && tabContextMenu.tabId !== null
        ? tabs.some(
            (t) => t.id === tabContextMenu.tabId && t.type === "browser",
          )
        : false;
    const contextMenuTargetLocalBrowserUrl = toLocalBrowserUrl(
      tabContextMenu !== null &&
        tabContextMenu.tabId !== null &&
        contextMenuTargetIsBrowser
        ? (
            tabs.find((t) => t.id === tabContextMenu.tabId)?.data as
              BrowserTabData | undefined
          )?.url
        : undefined,
    );
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
      <aside className={panelClasses} data-snow-anchor="rightPanel">
        {tabs.length > 0 && (
          <div className="right-panel-tabs" data-snow-anchor="rightPanel.tabs">
            <OverlayScrollbar
              ref={tabListRef}
              className="right-panel-tab-list"
              orientation="horizontal"
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
                  onMouseDown={(event) => {
                    // 中键快速关闭（Git 固定 tab 除外）；preventDefault 阻止自动滚动
                    if (event.button === 1) {
                      event.preventDefault();
                      if (tab.id !== GIT_TAB_ID) {
                        setCloseConfirm(null);
                        requestCloseTab(tab.id);
                      }
                    }
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
                  {tab.type === "browser" &&
                    getBrowserAgentAccess(tab.id)?.shared && (
                      <span
                        className="right-panel-tab-agent-badge"
                        title={t("browser.sharedBadge")}
                        aria-hidden="true"
                      />
                    )}
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
            </OverlayScrollbar>
            {(hasCustomFrame || isDetachedWindow) && (
              <div className="right-panel-tab-actions">
                <PlusMenuButton
                  items={plusMenuItems}
                  onAction={handlePlusMenuAction}
                />
                {!isDetachedWindow && (
                  <button
                    className="icon-btn ghost right-panel-fullscreen-btn"
                    type="button"
                    aria-label={fullscreenToggleLabel}
                    title={
                      fullscreenShortcutLabel
                        ? `${fullscreenToggleLabel} (${fullscreenShortcutLabel})`
                        : fullscreenToggleLabel
                    }
                    onClick={() => onToggleRightPanelFullscreen?.()}
                  >
                    <FullscreenToggleIcon size={16} strokeWidth={1.8} />
                  </button>
                )}
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
        <div
          className="right-panel-content-wrapper"
          data-snow-anchor="rightPanel.content"
        >
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`right-panel-tab-pane ${
                activeTabId === tab.id ? "active" : ""
              }`}
              data-browser-instance-id={
                tab.type === "browser"
                  ? (tab.data as BrowserTabData | undefined)?.instanceId
                  : undefined
              }
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
            pluginItems={pluginPanels.map(({ plugin, panelIndex }) => {
              const panel = plugin.panels[panelIndex];
              return {
                id: `plugin:${plugin.pluginId}:${panel.id}`,
                label: resolveLocalized(panel.title, locale) || panel.id,
                icon: (
                  <PluginIcon
                    pluginId={plugin.pluginId}
                    icon={panel.icon || plugin.icon}
                    size={13}
                  />
                ),
                onClick: () => {
                  setTabContextMenu(null);
                  const current = pluginStore.getById(plugin.pluginId);
                  const currentPanel = current?.panels.find(
                    (item) => item.id === panel.id,
                  );
                  if (!current?.enabled || !currentPanel) return;
                  handleOpenPluginPanel(
                    current.pluginId,
                    currentPanel.id,
                    resolveLocalized(currentPanel.title, locale) ||
                      currentPanel.id,
                  );
                },
              };
            })}
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
            onNewTasks={() => {
              setTabContextMenu(null);
              handleOpenTaskManagerTab();
            }}
            onOpenInNewWindow={
              contextMenuTargetExists && !contextMenuTargetIsConversation
                ? () => {
                    setTabContextMenu(null);
                    if (tabContextMenu.tabId !== null) {
                      handleOpenTabInNewWindow(tabContextMenu.tabId);
                    }
                  }
                : undefined
            }
            onReturnToMain={
              isDetachedWindow &&
              contextMenuTargetExists &&
              !contextMenuTargetIsConversation
                ? () => {
                    setTabContextMenu(null);
                    if (tabContextMenu.tabId !== null) {
                      handleReturnTabToMain(tabContextMenu.tabId);
                    }
                  }
                : undefined
            }
            onOpenInLocalBrowser={
              contextMenuTargetIsBrowser
                ? () => {
                    setTabContextMenu(null);
                    if (tabContextMenu.tabId !== null) {
                      handleOpenBrowserInLocalBrowser(tabContextMenu.tabId);
                    }
                  }
                : undefined
            }
            localBrowserUrl={contextMenuTargetLocalBrowserUrl}
            onCloseTab={() => {
              setTabContextMenu(null);
              if (tabContextMenu.tabId !== null) {
                requestCloseTab(tabContextMenu.tabId);
              }
            }}
            onClose={() => setTabContextMenu(null)}
          />
        )}
        {isDetachedWindow ? (
          <DetachedConversationSync
            tabs={tabs}
            setTabs={setTabs}
            activeTabId={activeTabId}
            setActiveTabId={setActiveTabId}
            createTabRef={createConversationTabRef}
          />
        ) : null}
      </aside>
    );
  },
);

RightPanel.displayName = "RightPanel";
