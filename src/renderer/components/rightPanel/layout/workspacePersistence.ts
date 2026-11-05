/**
 * 右侧面板工作区的本地记忆：分屏结构、各组 tab 与面板激活项持久化在
 * localStorage，应用重启后原样恢复。
 *
 * 落盘的是「可重建」的最小数据：终端只留 cwd / shell，SSH 文件 tab 不留会话
 * id（重启后失效，恢复时按远端工作区重新连接），diff / 差异预览等临时内容
 * 不落盘。
 */
import type {
  BrowserTabData,
  CodebaseTabData,
  ConversationTabData,
  ExplorerTabData,
  FileViewerTabData,
  PluginTabData,
  RightPanelTab,
  RightPanelTabType,
  TerminalTabData,
} from "../types";
import {
  workspaceActiveTabId,
  type PaneLayoutSnapshot,
  type RightPaneNode,
  type RightPanelWorkspace,
} from "./paneLayout";

const STORAGE_KEY = "snow.layout.right-panel-workspace";
const STORAGE_VERSION = 1;

/** 持久化的 tab：id 直接复用（运行时按类型生成，重启后不会与新建 tab 冲突）。 */
export type PersistedTab = {
  id: string;
  type: RightPanelTabType;
  title: string;
  data?: Record<string, unknown>;
};

export type PersistedWorkspace = {
  version: number;
  tabs: PersistedTab[];
  layout: PaneLayoutSnapshot;
  /** 面板级激活 tab（决定聚焦组），供恢复后定位。 */
  activeTabId: string;
};

/** 临时视图不持久化：重启后没有可复用的 diff 数据。 */
const PERSISTED_TYPES: ReadonlySet<RightPanelTabType> = new Set([
  "git",
  "terminal",
  "browser",
  "file",
  "codebase",
  "explorer",
  "drawing",
  "plugin",
  "tasks",
  "conversation",
]);

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const pickData = (tab: RightPanelTab): Record<string, unknown> | undefined => {
  switch (tab.type) {
    case "terminal": {
      const data = tab.data as TerminalTabData | undefined;
      const shellPath = asString(data?.shellPath);
      return { cwd: asString(data?.cwd), ...(shellPath ? { shellPath } : {}) };
    }
    case "browser": {
      const data = tab.data as BrowserTabData | undefined;
      const displayDeviceId = asString(data?.displayDeviceId);
      return {
        url: asString(data?.url),
        ...(displayDeviceId ? { displayDeviceId } : {}),
      };
    }
    case "file": {
      const data = tab.data as FileViewerTabData | undefined;
      if (!data?.filePath) {
        return undefined;
      }
      const sshWorkspaceRoot = asString(data.sshWorkspaceRoot);
      const sshWorkspaceId = asString(data.sshWorkspaceId);
      return {
        filePath: data.filePath,
        fileName: asString(data.fileName),
        isSsh: data.isSsh === true,
        ...(sshWorkspaceRoot ? { sshWorkspaceRoot } : {}),
        ...(sshWorkspaceId ? { sshWorkspaceId } : {}),
        ...(typeof data.focusLine === "number"
          ? { focusLine: data.focusLine }
          : {}),
      };
    }
    case "codebase": {
      const data = tab.data as CodebaseTabData | undefined;
      if (!data?.projectId) {
        return undefined;
      }
      return {
        projectId: data.projectId,
        projectName: asString(data.projectName),
      };
    }
    case "explorer":
      return {
        directoryId: asString(
          (tab.data as ExplorerTabData | undefined)?.directoryId,
        ),
      };
    case "plugin": {
      const data = tab.data as PluginTabData | undefined;
      if (!data?.pluginId || !data.panelId) {
        return undefined;
      }
      return { pluginId: data.pluginId, panelId: data.panelId };
    }
    case "conversation": {
      const data = tab.data as ConversationTabData | undefined;
      if (!data?.conversationId) {
        return undefined;
      }
      const viewConversationId = asString(data.viewConversationId);
      return {
        conversationId: data.conversationId,
        ...(viewConversationId ? { viewConversationId } : {}),
      };
    }
    default:
      return undefined;
  }
};

const toPersistedTab = (tab: RightPanelTab): PersistedTab | null => {
  if (!PERSISTED_TYPES.has(tab.type)) {
    return null;
  }
  const data = pickData(tab);
  return {
    id: tab.id,
    type: tab.type,
    title: tab.title,
    ...(data ? { data } : {}),
  };
};

/** 布局按持久化的 tab 集合裁剪：丢弃已失效 tab 与因此变空的组。 */
const toPersistedLayout = (
  node: RightPaneNode,
  keep: ReadonlySet<string>,
): PaneLayoutSnapshot | null => {
  if (node.kind === "leaf") {
    const tabIds = node.tabIds.filter((id) => keep.has(id));
    if (tabIds.length === 0) {
      return null;
    }
    const activeTabId =
      node.activeTabId && tabIds.includes(node.activeTabId)
        ? node.activeTabId
        : tabIds[0];
    return { kind: "leaf", tabIds, activeTabId };
  }
  const children: PaneLayoutSnapshot[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const next = toPersistedLayout(child, keep);
    if (next) {
      children.push(next);
      sizes.push(node.sizes[index] ?? 1);
    }
  });
  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0];
  }
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  return {
    kind: "split",
    orientation: node.orientation,
    sizes: sizes.map((size) => size / total),
    children,
  };
};

export const serializeWorkspace = (
  workspace: RightPanelWorkspace,
): PersistedWorkspace => {
  const tabs: PersistedTab[] = [];
  for (const tab of workspace.tabs) {
    const persisted = toPersistedTab(tab);
    if (persisted) {
      tabs.push(persisted);
    }
  }
  const keep = new Set(tabs.map((tab) => tab.id));
  const layout = toPersistedLayout(workspace.layout, keep) ?? {
    kind: "leaf",
    tabIds: [],
    activeTabId: null,
  };
  const activeTabId = workspaceActiveTabId(workspace);
  return {
    version: STORAGE_VERSION,
    tabs,
    layout,
    activeTabId: activeTabId && keep.has(activeTabId) ? activeTabId : "",
  };
};

const isLayoutSnapshot = (value: unknown): value is PaneLayoutSnapshot => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const node = value as {
    kind?: unknown;
    tabIds?: unknown;
    orientation?: unknown;
    sizes?: unknown;
    children?: unknown;
  };
  if (node.kind === "leaf") {
    return (
      Array.isArray(node.tabIds) &&
      node.tabIds.every((id) => typeof id === "string")
    );
  }
  if (node.kind === "split") {
    return (
      (node.orientation === "row" || node.orientation === "column") &&
      Array.isArray(node.sizes) &&
      node.sizes.every(
        (size) => typeof size === "number" && Number.isFinite(size) && size > 0,
      ) &&
      Array.isArray(node.children) &&
      node.children.every(isLayoutSnapshot)
    );
  }
  return false;
};

/** 读取上次的布局；没有记录或数据损坏时返回 null，由调用方回落默认布局。 */
export const readPersistedWorkspace = (): PersistedWorkspace | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspace> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== STORAGE_VERSION ||
      !Array.isArray(parsed.tabs) ||
      !isLayoutSnapshot(parsed.layout)
    ) {
      return null;
    }
    return {
      version: STORAGE_VERSION,
      tabs: parsed.tabs.filter(
        (tab): tab is PersistedTab =>
          Boolean(tab) &&
          typeof tab === "object" &&
          typeof (tab as PersistedTab).id === "string" &&
          typeof (tab as PersistedTab).type === "string",
      ),
      layout: parsed.layout,
      activeTabId: asString(parsed.activeTabId),
    };
  } catch {
    return null;
  }
};

export const writePersistedWorkspace = (
  workspace: RightPanelWorkspace,
): void => {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(serializeWorkspace(workspace)),
    );
  } catch {
    // 持久化失败时仅本次会话生效。
  }
};

/** 快照 tab 还原为面板 tab；字段不全或类型不可恢复时丢弃。 */
export const restoreTabs = (tabs: PersistedTab[]): RightPanelTab[] => {
  const restored: RightPanelTab[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (!tab || !tab.id || seen.has(tab.id)) {
      continue;
    }
    const data = tab.data ?? {};
    const title = asString(tab.title);
    let next: RightPanelTab | null = null;
    switch (tab.type) {
      case "git":
        next = { id: tab.id, type: "git", title };
        break;
      case "terminal": {
        const cwd = asString(data.cwd);
        const shellPath = asString(data.shellPath);
        next = {
          id: tab.id,
          type: "terminal",
          title,
          data: { cwd, ...(shellPath ? { shellPath } : {}) },
        };
        break;
      }
      case "browser": {
        const displayDeviceId = asString(data.displayDeviceId);
        next = {
          id: tab.id,
          type: "browser",
          title,
          data: {
            instanceId: tab.id,
            url: asString(data.url),
            ...(displayDeviceId ? { displayDeviceId } : {}),
          },
        };
        break;
      }
      case "file": {
        const filePath = asString(data.filePath);
        if (!filePath) {
          break;
        }
        const sshWorkspaceRoot = asString(data.sshWorkspaceRoot);
        const sshWorkspaceId = asString(data.sshWorkspaceId);
        next = {
          id: tab.id,
          type: "file",
          title,
          data: {
            filePath,
            fileName:
              asString(data.fileName) ||
              filePath.split(/[\\/]/).filter(Boolean).pop() ||
              filePath,
            isSsh: data.isSsh === true,
            ...(sshWorkspaceRoot ? { sshWorkspaceRoot } : {}),
            ...(sshWorkspaceId ? { sshWorkspaceId } : {}),
            ...(typeof data.focusLine === "number"
              ? { focusLine: data.focusLine }
              : {}),
          },
        };
        break;
      }
      case "codebase": {
        const projectId = asString(data.projectId);
        if (!projectId) {
          break;
        }
        next = {
          id: tab.id,
          type: "codebase",
          title,
          data: { projectId, projectName: asString(data.projectName) },
        };
        break;
      }
      case "explorer":
        next = {
          id: tab.id,
          type: "explorer",
          title,
          data: { directoryId: asString(data.directoryId) },
        };
        break;
      case "drawing":
        next = { id: tab.id, type: "drawing", title };
        break;
      case "tasks":
        next = { id: tab.id, type: "tasks", title };
        break;
      case "plugin": {
        const pluginId = asString(data.pluginId);
        const panelId = asString(data.panelId);
        if (!pluginId || !panelId) {
          break;
        }
        next = {
          id: tab.id,
          type: "plugin",
          title,
          data: { pluginId, panelId },
        };
        break;
      }
      case "conversation": {
        const conversationId = asString(data.conversationId);
        if (!conversationId) {
          break;
        }
        const viewConversationId = asString(data.viewConversationId);
        next = {
          id: tab.id,
          type: "conversation",
          title,
          data: {
            conversationId,
            ...(viewConversationId ? { viewConversationId } : {}),
          },
        };
        break;
      }
      default:
        break;
    }
    if (next) {
      seen.add(next.id);
      restored.push(next);
    }
  }
  return restored;
};
