import {
  Bug,
  Database,
  FolderTree,
  Gauge,
  GitBranch,
  Globe,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Minimize2,
  Paintbrush,
  Terminal,
  X,
} from "lucide-react";
import {
  Fragment,
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
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
import { ConversationTabSwitcher } from "./rightPanel/ConversationTabSwitcher";
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
import { focusTerminalTab } from "./rightPanel/terminal/terminalMcpController";
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
import {
  CONVERSATION_DRAG_MIME,
  readConversationDragPayload,
} from "./sidebar/mainSidebar/conversationDrag";
import { subscribePanelConversationFocus } from "./common/conversationPanelOwnership";
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
import type { BackgroundTaskFocus } from "./rightPanel/TaskManagerBackgroundTasks";
import {
  toDetachedTabPayload,
  toRightPanelTab,
} from "./rightPanel/detachedPanelTab";
import {
  activateTabInWorkspace,
  closeTabsInWorkspace,
  collectLeaves,
  computeRects,
  computeSplitters,
  createWorkspace,
  createWorkspaceFromSnapshot,
  equalizeSplitInWorkspace,
  findSplitById,
  focusPaneInWorkspace,
  moveTabToPaneInWorkspace,
  paneLayoutVars,
  paneRectVar,
  resizeSplitInWorkspace,
  syncWorkspaceTabs,
  workspaceActiveTabId,
  type PaneEdge,
  type PaneSplitter,
  type RightPanelWorkspace,
} from "./rightPanel/layout/paneLayout";
import {
  readPersistedWorkspace,
  restoreTabs,
  writePersistedWorkspace,
} from "./rightPanel/layout/workspacePersistence";

/** 右侧面板内拖拽 tab 的 MIME（携带 { tabId }）：拖到别的组即合并/拆分。 */
const RIGHT_PANE_TAB_MIME = "application/x-snow-right-pane-tab";

/** 拖到内容区边缘的比例阈值：以内为拆分新组，以外为合并进该组。 */
const DROP_EDGE_RATIO = 0.26;

/** 分隔条拖拽时每组在分割轴上的最小尺寸（px）。 */
const MIN_PANE_PX = 120;

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
// 主窗口的「会话面板」：与独立面板窗口的会话 tab 不同，它自带独立的会话视图
// （见 ConversationPanel / ChatSessionScope），可与其它面板并排、同时运行。
const ConversationPanel = lazy(() =>
  import("./rightPanel/ConversationPanel").then((m) => ({
    default: m.ConversationPanel,
  })),
);

const GIT_TAB_ID = "git";
const CODEBASE_TAB_ID = "codebase";
const EXPLORER_TAB_ID = "explorer";
const TASKS_TAB_ID = "tasks";

/** 会话面板 tab 的 id：按会话稳定（与独立面板窗口的会话 tab 同一约定）。 */
const conversationPanelTabId = (conversationId: string): string =>
  `conversation:${conversationId}`;

// tab 栏图标：面板类 tab（终端 / 浏览器 / 代码库 / 资源管理器 / 绘图 /
// 任务管理器 / 会话 / 插件）显示对应功能图标，文件类 tab(diff / file /
// file-diff-preview)显示文件类型图标。
const getTabIcon = (tab: RightPanelTab): React.ReactNode => {
  const panelIconProps = {
    size: 13,
    strokeWidth: 1.8,
    className: "right-panel-tab-icon",
  } as const;
  switch (tab.type) {
    case "git":
      return <GitBranch {...panelIconProps} />;
    case "terminal":
      return <Terminal {...panelIconProps} />;
    case "browser":
      return <Globe {...panelIconProps} />;
    case "codebase":
      return <Database {...panelIconProps} />;
    case "explorer":
      return <FolderTree {...panelIconProps} />;
    case "drawing":
      return <Paintbrush {...panelIconProps} />;
    case "tasks":
      return <Gauge {...panelIconProps} />;
    case "conversation":
      return <MessageSquare {...panelIconProps} />;
    case "plugin": {
      const pluginData = tab.data as PluginTabData | undefined;
      if (!pluginData) {
        return null;
      }
      const plugin = pluginStore.getById(pluginData.pluginId);
      const panel = plugin?.panels.find(
        (item) => item.id === pluginData.panelId,
      );
      return (
        <PluginIcon
          pluginId={pluginData.pluginId}
          icon={panel?.icon || plugin?.icon || ""}
          size={13}
          className="right-panel-tab-icon"
        />
      );
    }
    case "diff": {
      const filePath = (tab.data as DiffTabData)?.selectedFile?.path;
      return filePath
        ? getFileTypeIcon(filePath.split("/").pop() ?? filePath, false, false, {
            size: 13,
            className: "right-panel-tab-icon",
          })
        : null;
    }
    case "file": {
      const fileName = (tab.data as FileViewerTabData)?.fileName;
      return fileName
        ? getFileTypeIcon(fileName, false, false, {
            size: 13,
            className: "right-panel-tab-icon",
          })
        : null;
    }
    case "file-diff-preview": {
      const fileName = (tab.data as FileDiffPreviewTabData)?.fileName;
      return fileName
        ? getFileTypeIcon(fileName, false, false, {
            size: 13,
            className: "right-panel-tab-icon",
          })
        : null;
    }
    default:
      return null;
  }
};

// 文件 tab 的唯一 id：本地按路径区分，远程再带上会话 id（同一远端路径可能来自不同会话）。
const toFileTabId = (
  filePath: string,
  isSsh: boolean,
  sshSessionId?: string | null,
): string =>
  isSsh
    ? `file:ssh:${sshSessionId ?? "unknown"}:${filePath}`
    : `file:${filePath}`;

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
    // 面板工作区 = tab 注册表 + 分屏布局 + 当前聚焦的组。两者放在同一状态里，
    // 保证任何一次增删改都不会让布局与 tab 列表错位；原调用点继续使用同名适配器
    // setTabs / setActiveTabId，语义保持不变。
    const [workspace, setWorkspace] = useState<RightPanelWorkspace>(() => {
      if (detachedWindow) {
        return createWorkspace([detachedWindow.initialTab]);
      }
      // 上次的分屏布局与 tab 从 localStorage 恢复；固定 tab 标题按当前语言重建。
      const snapshot = readPersistedWorkspace();
      if (snapshot) {
        const restoredTabs = restoreTabs(snapshot.tabs).map((tab) => {
          if (tab.id === GIT_TAB_ID) {
            return { ...tab, title: t("rightPanel.gitTab") };
          }
          if (tab.id === EXPLORER_TAB_ID) {
            return { ...tab, title: t("rightPanel.explorerTab") };
          }
          if (tab.id === TASKS_TAB_ID) {
            return { ...tab, title: t("rightPanel.tasksTab") };
          }
          if (tab.id === CODEBASE_TAB_ID) {
            return { ...tab, title: t("rightPanel.codebaseTab") };
          }
          if (tab.type === "terminal") {
            return { ...tab, title: t("rightPanel.terminalTab") };
          }
          if (tab.type === "browser") {
            return { ...tab, title: t("rightPanel.browserTab") };
          }
          if (tab.type === "drawing") {
            return { ...tab, title: t("rightPanel.drawingTab") };
          }
          return tab;
        });
        // Git 为固定 tab：快照里没有说明数据异常，退回默认布局。
        if (restoredTabs.some((tab) => tab.id === GIT_TAB_ID)) {
          return createWorkspaceFromSnapshot(
            restoredTabs,
            snapshot.layout,
            snapshot.activeTabId,
          );
        }
      }
      return createWorkspace([
        { id: GIT_TAB_ID, type: "git", title: t("rightPanel.gitTab") },
      ]);
    });
    // tab 拖拽提示：落点组与位置（内容区四边=拆分成新组，中心=合并进该组）。
    const [dropTarget, setDropTarget] = useState<{
      paneId: string;
      edge: PaneEdge;
    } | null>(null);
    // tab 栏内的插入位置提示（同组内重排 / 跨组合并都用它）。
    const [tabDropIndex, setTabDropIndex] = useState<{
      paneId: string;
      index: number;
    } | null>(null);
    const layoutRef = useRef<HTMLDivElement>(null);
    const resizeGuideRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLElement>(null);
    // 聚焦请求独立于布局：重复点击当前终端也生效，不持久化或重建 PTY。
    const [terminalFocusRequest, setTerminalFocusRequest] = useState<{
      tabId: string;
      sequence: number;
    } | null>(null);

    const tabs = workspace.tabs;
    // 布局 / tab / 聚焦组变化后落盘；独立面板窗口的 tab 由主进程管理，不写入。
    useEffect(() => {
      if (isDetachedWindow) {
        return;
      }
      const timer = window.setTimeout(
        () => writePersistedWorkspace(workspace),
        300,
      );
      return () => window.clearTimeout(timer);
    }, [workspace, isDetachedWindow]);
    // 关闭窗口时兜底写一次，避免 debounce 窗口内退出丢掉最后一次布局变更。
    const workspaceRef = useRef(workspace);
    workspaceRef.current = workspace;
    useEffect(() => {
      if (isDetachedWindow) {
        return;
      }
      const flush = (): void => writePersistedWorkspace(workspaceRef.current);
      window.addEventListener("beforeunload", flush);
      return () => window.removeEventListener("beforeunload", flush);
    }, [isDetachedWindow]);
    const paneModel = useMemo(() => {
      const leaves = collectLeaves(workspace.layout);
      const activeByLeaf = new Map<string, string | null>();
      for (const leaf of leaves) {
        activeByLeaf.set(leaf.id, leaf.activeTabId);
      }
      return {
        leaves,
        activeByLeaf,
        splitters: computeSplitters(workspace.layout),
        activeTabId: workspaceActiveTabId(workspace),
        tabById: new Map(workspace.tabs.map((tab) => [tab.id, tab])),
        layoutVars: paneLayoutVars(workspace.layout) as React.CSSProperties,
        // 承载操作区（新建 + 全屏）的组：优先 Git 固定 tab 所在的组，切分屏时不会跳动。
        primaryPaneId:
          (leaves.find((leaf) => leaf.tabIds.includes(GIT_TAB_ID)) ?? leaves[0])
            ?.id ?? "",
      };
    }, [workspace]);
    const activeTabId = paneModel.activeTabId;
    const layoutVars = paneModel.layoutVars;
    // tab 注册表更新：同步把新 tab 放进聚焦组、把已关闭的 tab 从布局移除。
    const setTabs = useCallback<Dispatch<SetStateAction<RightPanelTab[]>>>(
      (action) => {
        setWorkspace((prev) => {
          const nextTabs =
            typeof action === "function" ? action(prev.tabs) : action;
          return nextTabs === prev.tabs
            ? prev
            : syncWorkspaceTabs(prev, nextTabs);
        });
      },
      [],
    );
    const setActiveTabId = useCallback<Dispatch<SetStateAction<string>>>(
      (action) => {
        setWorkspace((prev) => {
          const nextId =
            typeof action === "function"
              ? action(workspaceActiveTabId(prev))
              : action;
          return activateTabInWorkspace(prev, nextId);
        });
      },
      [],
    );
    // 聚焦某个组：该组当前激活的 tab 即成为面板激活 tab（点击内容区、点 tab 都会走到这里）。
    const focusPane = useCallback((paneId: string): void => {
      setWorkspace((prev) => focusPaneInWorkspace(prev, paneId));
    }, []);
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
    // tab 右键菜单：记录触发位置与目标 tab（Git 固定 tab 无关闭项；
    // tabId 为 null 表示右键在 tab 栏空白区域，仅提供新建项）。
    const [tabContextMenu, setTabContextMenu] = useState<{
      x: number;
      y: number;
      tabId: string | null;
    } | null>(null);
    // 关闭二次确认 tooltip：terminal / browser tab 点 X 后先弹出确认浮层，
    // 定位在关闭按钮下方（相对面板的坐标，支持任意分组）。
    const [closeConfirm, setCloseConfirm] = useState<{
      tabId: string;
      x: number;
      y: number;
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

    // 显示尺寸按浏览器 tab 独立保存：切换设备只写回当前 tab 的数据。
    const handleBrowserDisplayDeviceChange = useCallback(
      (tabId: string, displayDeviceId: string) => {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId && tab.type === "browser"
              ? {
                  ...tab,
                  data: { ...(tab.data as BrowserTabData), displayDeviceId },
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

    /**
     * 打开（或激活）会话面板 tab：把一个会话挂成右侧面板里的独立聊天视图，
     * 可与其他会话面板 / 终端 / 浏览器等并排显示并同时运行。
     * 已存在同一会话的 tab 时只激活，不重复创建（同一会话不会有两个面板实例）。
     */
    const handleOpenConversationTab = useCallback(
      (conversationId: string, title?: string): string => {
        const trimmedId = conversationId.trim();
        const tabId = conversationPanelTabId(trimmedId);
        const fallbackTitle =
          title?.trim() ||
          t("sidebar.untitledChat", { defaultValue: "Untitled" });
        setTabs((prev) =>
          prev.some((tab) => tab.id === tabId)
            ? prev.map((tab) =>
                tab.id === tabId && title?.trim()
                  ? { ...tab, title: title.trim() }
                  : tab,
              )
            : [
                ...prev,
                {
                  id: tabId,
                  type: "conversation",
                  title: fallbackTitle,
                  data: { conversationId: trimmedId } as ConversationTabData,
                },
              ],
        );
        setActiveTabId(tabId);
        return tabId;
      },
      [t],
    );

    /** 会话摘要变化后回写 tab 标题（面板上报，未变化时不触发状态更新）。 */
    const handleConversationPanelTitleChange = useCallback(
      (tabId: string, title: string): void => {
        const nextTitle = title.trim();
        if (!nextTitle) {
          return;
        }
        setTabs((prev) => {
          const target = prev.find((tab) => tab.id === tabId);
          if (!target || target.title === nextTitle) {
            return prev;
          }
          return prev.map((tab) =>
            tab.id === tabId ? { ...tab, title: nextTitle } : tab,
          );
        });
      },
      [],
    );

    /**
     * 会话 tab 标题下拉切换展示的会话（子代理 / Workflow 节点）：
     * 只改写该 tab 的展示目标与标题，不新建 tab、不影响其它面板。
     * 切回根会话时清除 viewConversationId（回到 tab 的默认绑定）。
     */
    const handleSelectConversationTabView = useCallback(
      (tabId: string, conversationId: string, title: string): void => {
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== tabId || tab.type !== "conversation") {
              return tab;
            }
            const data = tab.data as ConversationTabData | undefined;
            if (!data) {
              return tab;
            }
            const rootConversationId = data.conversationId;
            const nextViewConversationId =
              conversationId === rootConversationId
                ? undefined
                : conversationId;
            const nextTitle = title.trim() || tab.title;
            if (
              data.viewConversationId === nextViewConversationId &&
              tab.title === nextTitle
            ) {
              return tab;
            }
            return {
              ...tab,
              title: nextTitle,
              data: { ...data, viewConversationId: nextViewConversationId },
            };
          }),
        );
      },
      [],
    );

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

    // 后台任务定位请求（bash 卡片徽章点击）：nonce 变化触发列表重新定位。
    const [taskFocus, setTaskFocus] = useState<BackgroundTaskFocus | null>(
      null,
    );
    useEffect(
      () =>
        rightPanelEvents.on("focus-background-task", (payload) => {
          handleOpenTaskManagerTab();
          setTaskFocus({
            taskId: payload.taskId?.trim() ?? "",
            pid: payload.pid ?? 0,
            nonce: Date.now(),
          });
          rightPanelEvents.emit("request-expand");
        }),
      [handleOpenTaskManagerTab],
    );

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

    // 会话面板聚焦请求（选中被面板承载的会话时由会话运行时发出）：激活承载它的
    // tab 并展开右侧面板 —— 同一会话只保留面板这一个聊天表面。承载 tab 由归属
    // 注册表给出（面板可在同一 tab 内切换展示的会话，tab id 不一定等于会话 id）。
    useEffect(
      () =>
        subscribePanelConversationFocus((_conversationId, tabId) => {
          setActiveTabId(tabId);
          rightPanelEvents.emit("request-expand");
        }),
      [],
    );

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
        const tabId = toFileTabId(filePath, isSsh, sshSessionId);
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

    // 远程文件 tab 复用工作区的 profile 连接（与资源管理器打开文件一致）：
    // profile ID 跨重连保持稳定，底层会话断开后由连接管理器自动重连，
    // 不会再拿着已失效的一次性会话 id 读文件。这里只确保连接已建立，
    // 随即归还引用，连接的生命周期仍由活动工作区持有。
    const getSshFileSession = useCallback(
      async (workspacePath: string): Promise<string> => {
        const profile =
          await window.snow.sshConnectWorkspaceProfile(workspacePath);
        void window.snow
          .sshReleaseProfile(profile.profileId)
          .catch(() => undefined);
        return profile.profileId;
      },
      [],
    );

    // 重启恢复的远程文件 tab：旧会话已失效，按远端工作区重连后回填会话 id。
    // 每个 tab 只尝试一次，避免工作区其它变化触发反复重连。
    const recoveredSshTabsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
      for (const tab of workspace.tabs) {
        if (tab.type !== "file") {
          continue;
        }
        const fileData = tab.data as FileViewerTabData;
        if (!fileData.isSsh || fileData.sshSessionId) {
          continue;
        }
        const workspacePath = fileData.sshWorkspaceRoot;
        if (!workspacePath || recoveredSshTabsRef.current.has(tab.id)) {
          continue;
        }
        recoveredSshTabsRef.current.add(tab.id);
        void getSshFileSession(workspacePath)
          .then((sshSessionId) => {
            setTabs((prev) =>
              prev.map((item) =>
                item.id === tab.id && item.type === "file"
                  ? {
                      ...item,
                      data: {
                        ...(item.data as FileViewerTabData),
                        sshSessionId,
                      },
                    }
                  : item,
              ),
            );
          })
          .catch(() => {
            // 连接失败：保留空白占位，用户可关闭该 tab。
          });
      }
    }, [workspace.tabs, getSshFileSession]);

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

    // 关闭 tab：布局裁剪与激活位置在同一次工作区更新内完成，关闭激活 tab 后由
    // 左侧相邻 tab 接管（而非回落到组内第一个）。
    const handleCloseTab = useCallback(
      (tabId: string) => {
        terminalPtyIdsRef.current.delete(tabId);
        setWorkspace((prev) => {
          if (tabId === GIT_TAB_ID) {
            return prev;
          }
          // 主面板至少保留一个 tab；独立面板窗口允许清空（清空即关闭窗口）。
          if (prev.tabs.length <= 1 && !isDetachedWindow) {
            return prev;
          }
          return closeTabsInWorkspace(prev, new Set([tabId]));
        });
        setDirtyTabs((prev) => {
          if (!prev.has(tabId)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
      },
      [isDetachedWindow],
    );

    // 资源管理器双击文件打开快速编辑弹窗：同一文件的阅读器 tab 自动关闭，
    // 避免「右侧阅读器 + 编辑弹窗」两份视图并存；阅读器里有未保存修改时保留 tab。
    useEffect(() => {
      return rightPanelEvents.on("close-file", (payload) => {
        const tabId = toFileTabId(
          payload.filePath,
          payload.isSsh,
          payload.sshSessionId,
        );
        if (!tabs.some((tab) => tab.id === tabId) || dirtyTabs.has(tabId)) {
          return;
        }
        handleCloseTab(tabId);
      });
    }, [tabs, dirtyTabs, handleCloseTab]);

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

    // 批量关闭：移除 closed 中的 tab 并清理 dirty 标记；各组的激活位置由
    // 左邻 tab 接管（见 closeTabsInWorkspace）。
    const batchCloseTabs = useCallback((closed: RightPanelTab[]) => {
      if (closed.length === 0) {
        return;
      }
      const closedIds = new Set(closed.map((t) => t.id));
      closedIds.forEach((id) => terminalPtyIdsRef.current.delete(id));
      setWorkspace((prev) => closeTabsInWorkspace(prev, closedIds));
      setDirtyTabs((prev) => {
        const next = new Set(prev);
        closedIds.forEach((id) => next.delete(id));
        return next;
      });
    }, []);

    // 关闭除指定 tab（与 Git 固定 tab）外的所有 tab。
    const handleCloseOthers = useCallback(
      (tabId: string) => {
        batchCloseTabs(
          tabs.filter((t) => t.id !== GIT_TAB_ID && t.id !== tabId),
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
        batchCloseTabs(tabs.slice(idx + 1).filter((t) => t.id !== GIT_TAB_ID));
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
        batchCloseTabs(tabs.slice(0, idx).filter((t) => t.id !== GIT_TAB_ID));
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

    // MCP 默认目标与 terminal-list 的 isActive 同源：面板激活 tab 为终端时
    // 记为最近聚焦。分屏下点击另一组的终端只会切换聚焦组、不改变组内激活
    // tab，因此不能依赖终端实例自身的 isActive。
    const activeTabIsTerminal =
      paneModel.tabById.get(activeTabId)?.type === "terminal";
    useEffect(() => {
      if (activeTabIsTerminal) {
        focusTerminalTab(activeTabId);
      }
    }, [activeTabId, activeTabIsTerminal]);

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

    // tab 栏横向滚轮：多组 tab 共用一个委托监听（纵向滚轮转成横向滚动）。
    useEffect(() => {
      const container = layoutRef.current;
      if (!container) {
        return;
      }
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY === 0) {
          return;
        }
        const target = event.target as HTMLElement | null;
        const list = target?.closest(
          ".right-panel-tab-list",
        ) as HTMLElement | null;
        if (!list || list.scrollWidth <= list.clientWidth) {
          return;
        }
        event.preventDefault();
        list.scrollLeft += event.deltaY;
      };
      container.addEventListener("wheel", onWheel, { passive: false });
      return () => container.removeEventListener("wheel", onWheel);
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
    // 其余类型（file / diff 等）直接关闭。浮层定位在关闭按钮下方（相对面板的
    // 坐标），与 tab 属于哪一组无关。
    const handleTabCloseClick = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>, tab: RightPanelTab) => {
        if (tab.type !== "terminal" && tab.type !== "browser") {
          requestCloseTab(tab.id);
          return;
        }
        const panelRect = panelRef.current?.getBoundingClientRect();
        if (!panelRect) {
          requestCloseTab(tab.id);
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        setCloseConfirm({
          tabId: tab.id,
          x: rect.left - panelRect.left,
          y: rect.bottom - panelRect.top,
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

    // 拖拽 tab / 会话行期间，webview 与 iframe 会把拖拽事件吞掉，宿主页
    // 收不到 dragover，落点无法定位到其覆盖区域（例如浏览器面板的下半部分）。
    // 拖拽进入窗口时给 body 打标记让它们不参与命中，拖拽结束后撤销；
    // 拖拽期间不会派发 pointermove，借它兜底跨窗口拖拽未收到 drop/dragend 的情况。
    useEffect(() => {
      const draggingClass = "is-right-pane-tab-dragging";
      const handleDragEnter = (event: DragEvent): void => {
        const types = event.dataTransfer?.types;
        if (
          types &&
          (types.includes(RIGHT_PANE_TAB_MIME) ||
            types.includes(CONVERSATION_DRAG_MIME))
        ) {
          document.body.classList.add(draggingClass);
        }
      };
      const clearDragging = (): void => {
        document.body.classList.remove(draggingClass);
      };
      window.addEventListener("dragenter", handleDragEnter, true);
      window.addEventListener("drop", clearDragging, true);
      window.addEventListener("dragend", clearDragging, true);
      window.addEventListener("pointermove", clearDragging, true);
      return () => {
        window.removeEventListener("dragenter", handleDragEnter, true);
        window.removeEventListener("drop", clearDragging, true);
        window.removeEventListener("dragend", clearDragging, true);
        window.removeEventListener("pointermove", clearDragging, true);
        clearDragging();
      };
    }, []);

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
      ? t("topBar.exitFullscreenRightPanel", {
          defaultValue: "Exit right panel fullscreen",
        })
      : t("topBar.fullscreenRightPanel", {
          defaultValue: "Right panel fullscreen",
        });

    const panelClasses = [
      "right-panel",
      isCollapsed ? "collapsed" : "",
      isFullscreen ? "fullscreen" : "",
      isDetachedWindow ? "right-panel-detached" : "",
    ]
      .filter(Boolean)
      .join(" ");

    // 激活状态按「所属组内是否为当前 tab」判定：分屏后每个组都有自己的激活 tab。
    const renderTabContent = (
      tab: RightPanelTab,
      isTabActive: boolean,
    ): React.ReactNode => {
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
              isActive={isTabActive}
              focusRequestId={
                terminalFocusRequest?.tabId === tab.id
                  ? terminalFocusRequest.sequence
                  : undefined
              }
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
              isActive={isTabActive}
              isPanelCollapsed={isCollapsed && !isDetachedWindow}
              projectId={activeDirectory?.directoryId}
              displayDeviceId={(tab.data as BrowserTabData).displayDeviceId}
              onDisplayDeviceChange={(id) =>
                handleBrowserDisplayDeviceChange(tab.id, id)
              }
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
              isActive={isTabActive}
              onOpenImageGenSettings={
                onSelectMainView
                  ? () => onSelectMainView("imagegen-settings")
                  : undefined
              }
            />
          ) : tab.type === "tasks" ? (
            <TaskManagerContent
              isActive={isTabActive}
              focusRequest={taskFocus}
              projectPath={activeDirectory?.path ?? ""}
            />
          ) : tab.type === "conversation" ? (
            isDetachedWindow ? (
              <ConversationTabPane
                conversationId={
                  (tab.data as ConversationTabData).conversationId
                }
                isActive={isTabActive}
                activeDirectory={activeDirectory}
              />
            ) : (
              // 主窗口：会话面板自带独立的会话视图（同一运行时 + 会话作用域），
              // 可与其它面板并排、同时收发消息；展示的会话可由 tab 标题下拉
              // 切到该会话的子代理 / Workflow 节点。
              <ConversationPanel
                conversationId={
                  (tab.data as ConversationTabData).conversationId
                }
                viewConversationId={
                  (tab.data as ConversationTabData).viewConversationId
                }
                tabId={tab.id}
                activeDirectory={activeDirectory}
                onTitleChange={handleConversationPanelTitleChange}
                onSelectConversationInTab={(
                  targetConversationId,
                  targetTitle,
                ) =>
                  handleSelectConversationTabView(
                    tab.id,
                    targetConversationId,
                    targetTitle,
                  )
                }
              />
            )
          ) : tab.type === "plugin" ? (
            (tab.data as PluginTabData) ? (
              <PluginPanelContent
                pluginId={(tab.data as PluginTabData).pluginId}
                panelId={(tab.data as PluginTabData).panelId}
                isActive={isTabActive}
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
              // 恢复的远程文件 tab 等会话重建完成，避免按本地路径读取远端文件。
              (tab.data as FileViewerTabData).isSsh &&
              !(tab.data as FileViewerTabData).sshSessionId ? null : (
                <FileViewerContent
                  filePath={(tab.data as FileViewerTabData).filePath}
                  fileName={(tab.data as FileViewerTabData).fileName}
                  isSsh={(tab.data as FileViewerTabData).isSsh}
                  sshSessionId={(tab.data as FileViewerTabData).sshSessionId}
                  sshWorkspaceRoot={
                    (tab.data as FileViewerTabData).sshWorkspaceRoot
                  }
                  sshWorkspaceId={
                    (tab.data as FileViewerTabData).sshWorkspaceId
                  }
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
              )
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

    // ===== 分屏几何与交互 =====

    const paneBoxStyle = (paneId: string): React.CSSProperties => ({
      left: `var(${paneRectVar(paneId, "l")})`,
      top: `var(${paneRectVar(paneId, "t")})`,
      width: `var(${paneRectVar(paneId, "w")})`,
      height: `var(${paneRectVar(paneId, "h")})`,
    });

    // tab 内容面板外框：顶上让出 tab 栏高度，其余按所属组的矩形铺满。
    const paneViewportStyle = (paneId: string): React.CSSProperties => ({
      left: `var(${paneRectVar(paneId, "l")})`,
      top: `calc(var(${paneRectVar(paneId, "t")}) + var(--rp-tabbar-h))`,
      width: `var(${paneRectVar(paneId, "w")})`,
      height: `calc(var(${paneRectVar(paneId, "h")}) - var(--rp-tabbar-h))`,
    });

    // 分隔条贴在前一个子节点的右（下）边缘：几何来自布局变量，尺寸只在拖拽
    // 结束后提交，所以分隔条会随布局一起过渡到新位置。
    const splitterStyle = (splitter: PaneSplitter): React.CSSProperties =>
      splitter.orientation === "row"
        ? {
            left: `calc(var(${paneRectVar(splitter.childId, "l")}) + var(${paneRectVar(splitter.childId, "w")}))`,
            top: `var(${paneRectVar(splitter.childId, "t")})`,
            height: `var(${paneRectVar(splitter.childId, "h")})`,
          }
        : {
            top: `calc(var(${paneRectVar(splitter.childId, "t")}) + var(${paneRectVar(splitter.childId, "h")}))`,
            left: `var(${paneRectVar(splitter.childId, "l")})`,
            width: `var(${paneRectVar(splitter.childId, "w")})`,
          };

    const hasPaneTabDrag = (event: React.DragEvent): boolean =>
      event.dataTransfer.types.includes(RIGHT_PANE_TAB_MIME);

    /** 侧边栏会话行拖入面板：落点即新建（或激活）会话面板 tab。 */
    const hasConversationPanelDrag = (event: React.DragEvent): boolean =>
      event.dataTransfer.types.includes(CONVERSATION_DRAG_MIME);

    /**
     * 落点反馈只能取效果集合允许的值：tab 拖到聊天输入框时终端用 link、文件用
     * copy，若在这里强行写 move 会被浏览器判为不可放置（drop 不触发）。
     */
    const resolveDropEffect = (
      effectAllowed: string,
    ): "move" | "copy" | "link" => {
      if (effectAllowed === "link") {
        return "link";
      }
      if (effectAllowed === "copy" || effectAllowed === "copyLink") {
        return "copy";
      }
      return "move";
    };

    const readDraggedTabId = (event: React.DragEvent): string | null => {
      const raw = event.dataTransfer.getData(RIGHT_PANE_TAB_MIME);
      if (!raw) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as { tabId?: string };
        return parsed.tabId ?? null;
      } catch {
        return null;
      }
    };

    // 只有一个 tab 时没有可布局的内容：面板内 tab 拖到内容区不产生落点
    // （拖到 tab 栏仍可重排），避免出现无意义的拆分反馈。
    const canSplitPanes = tabs.length > 1;

    // 内容区落点：靠近四边 → 拆分成新组；中间 → 合并进该组。
    const resolveDropEdge = (
      event: React.DragEvent,
      element: HTMLElement,
    ): PaneEdge => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return "center";
      }
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      const candidates: { edge: PaneEdge; distance: number }[] = [
        { edge: "left", distance: x },
        { edge: "right", distance: 1 - x },
        { edge: "top", distance: y },
        { edge: "bottom", distance: 1 - y },
      ];
      let best = candidates[0];
      for (const candidate of candidates) {
        if (candidate.distance < best.distance) {
          best = candidate;
        }
      }
      return best.distance < DROP_EDGE_RATIO ? best.edge : "center";
    };

    // 仅当拖的是本面板的 tab 或侧边栏会话行时才接管；资源管理器 / 终端自身的
    // 拖放不受影响。
    const handlePaneDragOver = (
      event: React.DragEvent<HTMLDivElement>,
      paneId: string,
    ): void => {
      if (!hasPaneTabDrag(event) && !hasConversationPanelDrag(event)) {
        return;
      }
      // 只有一个 tab：面板内 tab 无处可分，不接管拖拽（不给落点提示）。
      if (!canSplitPanes && hasPaneTabDrag(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = resolveDropEffect(
        event.dataTransfer.effectAllowed,
      );
      const edge = resolveDropEdge(event, event.currentTarget);
      setDropTarget((prev) =>
        prev && prev.paneId === paneId && prev.edge === edge
          ? prev
          : { paneId, edge },
      );
    };

    const handlePaneDragLeave = (
      event: React.DragEvent<HTMLDivElement>,
    ): void => {
      if (!hasPaneTabDrag(event) && !hasConversationPanelDrag(event)) {
        return;
      }
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      setDropTarget(null);
    };

    const handlePaneDrop = (
      event: React.DragEvent<HTMLDivElement>,
      paneId: string,
    ): void => {
      // 侧边栏会话行：落点中心=并入该组，落点四边=拆分成新组。
      if (hasConversationPanelDrag(event)) {
        const payload = readConversationDragPayload(event.dataTransfer);
        if (!payload) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const edge = resolveDropEdge(event, event.currentTarget);
        setDropTarget(null);
        setTabDropIndex(null);
        const panelTabId = handleOpenConversationTab(
          payload.conversationId,
          payload.title,
        );
        if (edge !== "center") {
          setWorkspace((prev) =>
            moveTabToPaneInWorkspace(prev, panelTabId, paneId, null, edge),
          );
        }
        return;
      }
      const tabId = readDraggedTabId(event);
      // 只有一个 tab：不落布局（拖回 tab 栏仍可重排）。
      if (!tabId || !canSplitPanes) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const edge = resolveDropEdge(event, event.currentTarget);
      setDropTarget(null);
      setTabDropIndex(null);
      setWorkspace((prev) =>
        moveTabToPaneInWorkspace(prev, tabId, paneId, null, edge),
      );
    };

    // tab 栏插入位置：与各 tab 中点比较，得到插入下标。
    const resolveTabDropIndex = (
      event: React.DragEvent<HTMLElement>,
      element: HTMLElement,
    ): number => {
      const items = Array.from(
        element.querySelectorAll<HTMLElement>(".right-panel-tab-item"),
      );
      for (let index = 0; index < items.length; index += 1) {
        const rect = items[index].getBoundingClientRect();
        if (event.clientX < rect.left + rect.width / 2) {
          return index;
        }
      }
      return items.length;
    };

    const handleTabBarDragOver = (
      event: React.DragEvent<HTMLDivElement>,
      paneId: string,
    ): void => {
      if (!hasPaneTabDrag(event) && !hasConversationPanelDrag(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = resolveDropEffect(
        event.dataTransfer.effectAllowed,
      );
      const index = resolveTabDropIndex(event, event.currentTarget);
      setDropTarget(null);
      setTabDropIndex((prev) =>
        prev && prev.paneId === paneId && prev.index === index
          ? prev
          : { paneId, index },
      );
    };

    const handleTabBarDrop = (
      event: React.DragEvent<HTMLDivElement>,
      paneId: string,
    ): void => {
      // 侧边栏会话行：落到 tab 栏即在该组内新建（或激活）会话面板 tab。
      if (hasConversationPanelDrag(event)) {
        const payload = readConversationDragPayload(event.dataTransfer);
        if (!payload) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const index = resolveTabDropIndex(event, event.currentTarget);
        setTabDropIndex(null);
        setDropTarget(null);
        const panelTabId = handleOpenConversationTab(
          payload.conversationId,
          payload.title,
        );
        setWorkspace((prev) =>
          moveTabToPaneInWorkspace(prev, panelTabId, paneId, index, "center"),
        );
        return;
      }
      const tabId = readDraggedTabId(event);
      if (!tabId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const index = resolveTabDropIndex(event, event.currentTarget);
      setTabDropIndex(null);
      setDropTarget(null);
      setWorkspace((prev) =>
        moveTabToPaneInWorkspace(prev, tabId, paneId, index, "center"),
      );
    };

    // 分隔条拖拽：拖拽期间布局保持原样，只在指针位置画一条指示线作为新的分界；
    // 松手后才把新的尺寸权重一次性提交给布局，终端 / 浏览器等重内容因此不会在
    // 拖拽过程中参与任何重排。
    const handleSplitterPointerDown = (
      event: React.PointerEvent<HTMLDivElement>,
      splitter: PaneSplitter,
    ): void => {
      if (event.button !== 0) {
        return;
      }
      const container = layoutRef.current;
      const guide = resizeGuideRef.current;
      const baseLayout = workspace.layout;
      const split = findSplitById(baseLayout, splitter.splitId);
      if (!container || !guide || !split || split.children.length < 2) {
        return;
      }
      const splitRect = computeRects(baseLayout).get(split.id);
      if (!splitRect) {
        return;
      }
      const horizontal = splitter.orientation === "row";
      const containerRect = container.getBoundingClientRect();
      const axisPx = horizontal
        ? splitRect.width * containerRect.width
        : splitRect.height * containerRect.height;
      if (axisPx <= 0) {
        return;
      }
      const total = split.sizes.reduce((sum, size) => sum + size, 0) || 1;
      const firstPx = (split.sizes[splitter.index] / total) * axisPx;
      const secondPx = (split.sizes[splitter.index + 1] / total) * axisPx;
      const pairPx = firstPx + secondPx;
      if (pairPx <= 0) {
        return;
      }
      const minPx = Math.max(48, Math.min(MIN_PANE_PX, pairPx / 2 - 1));
      const start = horizontal ? event.clientX : event.clientY;
      const target = event.currentTarget;
      // 指示线在容器内的可用范围：轴向从分割节点的起点算，横向铺满分割节点。
      const axisOffset = horizontal
        ? splitRect.left * containerRect.width
        : splitRect.top * containerRect.height;
      const crossOffset = horizontal
        ? splitRect.top * containerRect.height
        : splitRect.left * containerRect.width;
      const crossSize = horizontal
        ? splitRect.height * containerRect.height
        : splitRect.width * containerRect.width;

      let delta = 0;
      let frame = 0;

      const clampFirst = (): number =>
        Math.min(Math.max(firstPx + delta, minPx), pairPx - minPx);

      const paintGuide = (): void => {
        frame = 0;
        const axisPos = axisOffset + clampFirst();
        guide.style.left = `${horizontal ? axisPos : crossOffset}px`;
        guide.style.top = `${horizontal ? crossOffset : axisPos}px`;
        guide.style.width = `${horizontal ? 2 : crossSize}px`;
        guide.style.height = `${horizontal ? crossSize : 2}px`;
      };

      const handleMove = (moveEvent: PointerEvent): void => {
        delta = (horizontal ? moveEvent.clientX : moveEvent.clientY) - start;
        if (frame === 0) {
          frame = window.requestAnimationFrame(paintGuide);
        }
      };

      const handleEnd = (): void => {
        if (frame !== 0) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
        document.removeEventListener("pointermove", handleMove);
        document.removeEventListener("pointerup", handleEnd);
        document.removeEventListener("pointercancel", handleEnd);
        target.removeEventListener("lostpointercapture", handleEnd);
        document.body.classList.remove(
          "is-right-pane-resizing",
          "is-right-pane-resizing-x",
          "is-right-pane-resizing-y",
        );
        guide.classList.remove("active");
        target.classList.remove("is-dragging");
        // 位置没有实质变化（只是点了一下）时不提交，避免无意义的布局更新。
        const nextFirst = clampFirst();
        if (Math.abs(nextFirst - firstPx) < 0.5) {
          return;
        }
        const sizes = [...split.sizes];
        sizes[splitter.index] = (nextFirst / axisPx) * total;
        sizes[splitter.index + 1] = ((pairPx - nextFirst) / axisPx) * total;
        setWorkspace((prev) => resizeSplitInWorkspace(prev, split.id, sizes));
      };

      event.preventDefault();
      target.setPointerCapture(event.pointerId);
      document.addEventListener("pointermove", handleMove);
      document.addEventListener("pointerup", handleEnd);
      document.addEventListener("pointercancel", handleEnd);
      target.addEventListener("lostpointercapture", handleEnd);
      document.body.classList.add("is-right-pane-resizing");
      document.body.classList.add(
        horizontal ? "is-right-pane-resizing-x" : "is-right-pane-resizing-y",
      );
      target.classList.add("is-dragging");
      guide.classList.add("active");
      paintGuide();
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

    // 关闭确认浮层相对面板的横向位置（贴边时向内收，避免被面板裁掉）。
    const closeConfirmLeft = closeConfirm
      ? Math.max(
          4,
          Math.min(
            closeConfirm.x,
            Math.max(4, (panelRef.current?.clientWidth ?? 0) - 172),
          ),
        )
      : 0;

    return (
      <aside
        ref={panelRef}
        className={panelClasses}
        data-snow-anchor="rightPanel"
      >
        <div
          ref={layoutRef}
          className="right-panel-content-wrapper"
          data-snow-anchor="rightPanel.content"
          style={layoutVars}
        >
          {tabs.length > 0 && (
            <>
              {paneModel.leaves.map((leaf) => (
                <div
                  key={leaf.id}
                  className="right-pane-box"
                  style={paneBoxStyle(leaf.id)}
                  onPointerDown={() => focusPane(leaf.id)}
                >
                  <div
                    className="right-panel-tabs"
                    data-snow-anchor={
                      leaf.id === paneModel.primaryPaneId
                        ? "rightPanel.tabs"
                        : undefined
                    }
                    onDragOver={(event) => handleTabBarDragOver(event, leaf.id)}
                    onDrop={(event) => handleTabBarDrop(event, leaf.id)}
                    onDragLeave={(event) => {
                      if (
                        event.currentTarget.contains(
                          event.relatedTarget as Node | null,
                        )
                      ) {
                        return;
                      }
                      setTabDropIndex(null);
                    }}
                  >
                    <OverlayScrollbar
                      className="right-panel-tab-list"
                      orientation="horizontal"
                      onScroll={() => setCloseConfirm(null)}
                      onContextMenu={(event) => {
                        // 仅空白区域触发：tab 项上已有各自的右键菜单。
                        if (
                          (event.target as HTMLElement).closest(
                            ".right-panel-tab-item",
                          )
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
                      {leaf.tabIds.map((tabId, index) => {
                        const tab = paneModel.tabById.get(tabId);
                        if (!tab) {
                          return null;
                        }
                        const isTabActive =
                          paneModel.activeByLeaf.get(leaf.id) === tab.id;
                        return (
                          <Fragment key={tab.id}>
                            {tabDropIndex?.paneId === leaf.id &&
                              tabDropIndex.index === index && (
                                <div
                                  className="right-panel-tab-drop-line"
                                  aria-hidden="true"
                                />
                              )}
                            <div
                              key={tab.id}
                              className={`right-panel-tab-item ${
                                isTabActive ? "active" : ""
                              }`}
                              onClick={() => {
                                setCloseConfirm(null);
                                setActiveTabId(tab.id);
                                if (tab.type === "terminal") {
                                  setTerminalFocusRequest((prev) => ({
                                    tabId: tab.id,
                                    sequence: (prev?.sequence ?? 0) + 1,
                                  }));
                                }
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
                              draggable
                              onDragStart={(event) => {
                                handleTabDragStart(event, tab);
                                // 面板内部拖拽：用独立 MIME 携带 tab id——拖到别组
                                // tab 栏即合并进该组，拖到内容区边缘即拆分成新组。
                                event.dataTransfer.setData(
                                  RIGHT_PANE_TAB_MIME,
                                  JSON.stringify({ tabId: tab.id }),
                                );
                                if (
                                  !DRAGGABLE_TAB_TYPES.has(tab.type) &&
                                  event.dataTransfer.effectAllowed ===
                                    "uninitialized"
                                ) {
                                  event.dataTransfer.effectAllowed = "move";
                                }
                              }}
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
                              {getTabIcon(tab)}
                              {tab.type === "browser" &&
                                getBrowserAgentAccess(tab.id)?.shared && (
                                  <span
                                    className="right-panel-tab-agent-badge"
                                    title={t("browser.sharedBadge")}
                                    aria-hidden="true"
                                  />
                                )}
                              {tab.type === "conversation" &&
                              !isDetachedWindow ? (
                                // 主窗口的会话 tab：标题即下拉，可在根会话与其
                                // 子代理 / Workflow 节点（含节点下的子代理）之间切换。
                                <ConversationTabSwitcher
                                  rootConversationId={
                                    (tab.data as ConversationTabData)
                                      .conversationId
                                  }
                                  viewConversationId={
                                    (tab.data as ConversationTabData)
                                      .viewConversationId ?? ""
                                  }
                                  title={tab.title}
                                  onSelect={(conversationId, nextTitle) =>
                                    handleSelectConversationTabView(
                                      tab.id,
                                      conversationId,
                                      nextTitle,
                                    )
                                  }
                                />
                              ) : (
                                <span
                                  className="right-panel-tab-title"
                                  title={tab.title}
                                >
                                  {dirtyTabs.has(tab.id) && (
                                    <span
                                      className="right-panel-tab-dirty-dot"
                                      aria-hidden="true"
                                    />
                                  )}
                                  {tab.title}
                                </span>
                              )}
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
                          </Fragment>
                        );
                      })}
                      {tabDropIndex?.paneId === leaf.id &&
                        tabDropIndex.index >= leaf.tabIds.length && (
                          <div
                            className="right-panel-tab-drop-line"
                            aria-hidden="true"
                          />
                        )}
                    </OverlayScrollbar>
                    {leaf.id === paneModel.primaryPaneId &&
                      (hasCustomFrame || isDetachedWindow) && (
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
                              <FullscreenToggleIcon
                                size={16}
                                strokeWidth={1.8}
                              />
                            </button>
                          )}
                        </div>
                      )}
                  </div>
                  <div
                    className={`right-pane-drop-indicator ${
                      dropTarget?.paneId === leaf.id
                        ? `edge-${dropTarget.edge} active`
                        : "edge-center"
                    }`}
                    aria-hidden="true"
                  />
                </div>
              ))}
              {paneModel.splitters.map((splitter) => (
                <div
                  key={splitter.key}
                  className={`right-pane-splitter ${splitter.orientation}`}
                  style={splitterStyle(splitter)}
                  role="separator"
                  aria-orientation={
                    splitter.orientation === "row" ? "vertical" : "horizontal"
                  }
                  onPointerDown={(event) =>
                    handleSplitterPointerDown(event, splitter)
                  }
                  onDoubleClick={() =>
                    setWorkspace((prev) =>
                      equalizeSplitInWorkspace(prev, splitter.splitId),
                    )
                  }
                />
              ))}
              {/* 分隔条拖拽指示线：位置由拖拽处理命令式写入，拖拽结束才提交布局。 */}
              <div
                ref={resizeGuideRef}
                className="right-pane-resize-guide"
                aria-hidden="true"
              />
              <div className="right-pane-content-layer">
                {paneModel.leaves.flatMap((leaf) =>
                  leaf.tabIds.map((tabId) => {
                    const tab = paneModel.tabById.get(tabId);
                    if (!tab) {
                      return null;
                    }
                    const paneActive =
                      paneModel.activeByLeaf.get(leaf.id) === tab.id;
                    return (
                      <div
                        key={tab.id}
                        className={`right-panel-tab-pane ${
                          paneActive ? "active" : ""
                        }`}
                        style={paneViewportStyle(leaf.id)}
                        data-pane-id={leaf.id}
                        data-browser-instance-id={
                          tab.type === "browser"
                            ? (tab.data as BrowserTabData | undefined)
                                ?.instanceId
                            : undefined
                        }
                        onDragOver={(event) =>
                          handlePaneDragOver(event, leaf.id)
                        }
                        onDragLeave={handlePaneDragLeave}
                        onDrop={(event) => handlePaneDrop(event, leaf.id)}
                        onPointerDownCapture={() => focusPane(leaf.id)}
                      >
                        {/* 内容面板里的实际内容：铺满外框；拖拽分隔条期间布局
                            不变，松手后随新尺寸一次性重排。 */}
                        <div className="right-panel-tab-pane-body">
                          {renderTabContent(tab, paneActive)}
                        </div>
                      </div>
                    );
                  }),
                )}
              </div>
            </>
          )}
        </div>
        {closeConfirm && (
          <div
            className="right-panel-close-confirm"
            style={{
              left: closeConfirmLeft,
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
                  Math.min(closeConfirm.x + 8 - closeConfirmLeft, 148),
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
