/**
 * 右侧面板的分屏布局模型：同一个面板里可以并排显示多组 tab（每组自带 tab 栏
 * 与内容区），组与组之间用可拖拽的分隔条调整大小。
 *
 * 几何计算返回的是「相对布局容器的比例矩形」，渲染层把它们写成 CSS 变量
 * （--rp-<节点 id>-l/t/w/h）。拖拽分隔条时只改这些变量即可实时重排，不必
 * 逐帧 setState；所有 tab 的内容面板挂在同一个绝对定位层里、按所属组的矩形
 * 定位，因此把 tab 拖到另一组只改变它的定位变量，不会重建终端 / 浏览器 /
 * 画布等重组件。
 */

import type { RightPanelTab } from "../types";

/** tab 拖到另一组内容区时的落点：中心表示合并进该组，四边表示拆分出新组。 */
export type PaneEdge = "left" | "right" | "top" | "bottom" | "center";

/** 一组 tab（tab 栏 + 内容区）。 */
export type RightPaneLeaf = {
  kind: "leaf";
  id: string;
  /** 组内 tab id（按显示顺序）。 */
  tabIds: string[];
  /** 组内当前激活的 tab；组内有 tab 时非空。 */
  activeTabId: string | null;
};

/** 分割节点：row = 左右并排，column = 上下堆叠。 */
export type RightPaneSplit = {
  kind: "split";
  id: string;
  orientation: "row" | "column";
  children: RightPaneNode[];
  /** 与 children 一一对应的尺寸权重（和为 1）。 */
  sizes: number[];
};

export type RightPaneNode = RightPaneLeaf | RightPaneSplit;

/** 相对布局容器的比例矩形（0..1）。 */
export type PaneRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** 可拖拽的分隔条：贴在相邻两个子节点的交界线上。 */
export type PaneSplitter = {
  key: string;
  splitId: string;
  /** 分隔条前的相邻子节点 id；分隔条贴它的右 / 下边缘，拖拽时随它移动。 */
  childId: string;
  /** 分隔条位于 children[index] 与 children[index + 1] 之间（拖拽时按它取尺寸）。 */
  index: number;
  orientation: "row" | "column";
};

/** 面板工作区：tab 注册表 + 分屏布局 + 当前聚焦的组。 */
export type RightPanelWorkspace = {
  tabs: RightPanelTab[];
  layout: RightPaneNode;
  activePaneId: string;
};

let paneSeq = 0;
const nextPaneNodeId = (prefix: string): string =>
  `${prefix}-${(paneSeq += 1)}`;

export const createLeaf = (
  tabIds: string[],
  activeTabId: string | null = tabIds[0] ?? null,
): RightPaneLeaf => ({
  kind: "leaf",
  id: nextPaneNodeId("pane"),
  tabIds: [...tabIds],
  activeTabId,
});

export const collectLeaves = (node: RightPaneNode): RightPaneLeaf[] =>
  node.kind === "leaf" ? [node] : node.children.flatMap(collectLeaves);

export const findLeafById = (
  node: RightPaneNode,
  leafId: string,
): RightPaneLeaf | null => {
  if (node.kind === "leaf") {
    return node.id === leafId ? node : null;
  }
  for (const child of node.children) {
    const found = findLeafById(child, leafId);
    if (found) {
      return found;
    }
  }
  return null;
};

export const findLeafByTab = (
  node: RightPaneNode,
  tabId: string,
): RightPaneLeaf | null => {
  if (node.kind === "leaf") {
    return node.tabIds.includes(tabId) ? node : null;
  }
  for (const child of node.children) {
    const found = findLeafByTab(child, tabId);
    if (found) {
      return found;
    }
  }
  return null;
};

export const findSplitById = (
  node: RightPaneNode,
  splitId: string,
): RightPaneSplit | null => {
  if (node.kind === "leaf") {
    return null;
  }
  if (node.id === splitId) {
    return node;
  }
  for (const child of node.children) {
    const found = findSplitById(child, splitId);
    if (found) {
      return found;
    }
  }
  return null;
};

/** 按视觉顺序（深度优先）展开所有 tab id。 */
export const flattenTabIds = (node: RightPaneNode): string[] =>
  collectLeaves(node).flatMap((leaf) => leaf.tabIds);

const updateLeaf = (
  node: RightPaneNode,
  leafId: string,
  update: (leaf: RightPaneLeaf) => RightPaneNode,
): RightPaneNode => {
  if (node.kind === "leaf") {
    return node.id === leafId ? update(node) : node;
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateLeaf(child, leafId, update);
    if (next !== child) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...node, children } : node;
};

export const updateSplitNode = (
  node: RightPaneNode,
  splitId: string,
  update: (split: RightPaneSplit) => RightPaneNode,
): RightPaneNode => {
  if (node.kind === "leaf") {
    return node;
  }
  if (node.id === splitId) {
    return update(node);
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateSplitNode(child, splitId, update);
    if (next !== child) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...node, children } : node;
};

/** 从布局中移除某个 tab（保留可能因此变空的组，由 pruneEmptyLeaves 处理）。 */
export const removeTabFromPanes = (
  node: RightPaneNode,
  tabId: string,
): RightPaneNode => {
  if (node.kind === "leaf") {
    if (!node.tabIds.includes(tabId)) {
      return node;
    }
    const tabIds = node.tabIds.filter((id) => id !== tabId);
    return {
      ...node,
      tabIds,
      activeTabId:
        node.activeTabId === tabId ? (tabIds[0] ?? null) : node.activeTabId,
    };
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = removeTabFromPanes(child, tabId);
    if (next !== child) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...node, children } : node;
};

/** 兜底：保证工作区至少保留一个组（独立面板窗口允许面板清空）。 */
export const ensureLayout = (node: RightPaneNode | null): RightPaneNode =>
  node ?? createLeaf([], null);

/**
 * 折叠空组：空组从布局中移除，只剩一个子节点的分割节点被替换为该子节点，
 * 释放出来的空间按剩余兄弟的权重比例重新分配（视觉上不跳动）。
 */
export const pruneEmptyLeaves = (node: RightPaneNode): RightPaneNode => {
  const pruned = pruneEmpty(node);
  return ensureLayout(pruned ?? (node.kind === "leaf" ? node : null));
};

const pruneEmpty = (node: RightPaneNode): RightPaneNode | null => {
  if (node.kind === "leaf") {
    return node.tabIds.length > 0 ? node : null;
  }
  const children: RightPaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const next = pruneEmpty(child);
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
  return { ...node, children, sizes: sizes.map((size) => size / total) };
};

/** 丢弃布局中已不存在的 tab（关闭 tab 后调用），并折叠因此变空的组。 */
export const pruneTabs = (
  node: RightPaneNode,
  validTabIds: Set<string>,
): RightPaneNode => {
  const next = pruneTabsRecursive(node, validTabIds);
  return ensureLayout(next);
};

const pruneTabsRecursive = (
  node: RightPaneNode,
  validTabIds: Set<string>,
): RightPaneNode => {
  if (node.kind === "leaf") {
    const tabIds = node.tabIds.filter((id) => validTabIds.has(id));
    if (tabIds.length === node.tabIds.length) {
      return node;
    }
    return {
      ...node,
      tabIds,
      activeTabId:
        node.activeTabId && tabIds.includes(node.activeTabId)
          ? node.activeTabId
          : (tabIds[0] ?? null),
    };
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = pruneTabsRecursive(child, validTabIds);
    if (next !== child) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...node, children } : node;
};

/** 把 tab 追加到指定组（未激活的 tab，不改变组内当前激活项）。 */
export const appendTabsToLeaf = (
  node: RightPaneNode,
  leafId: string,
  tabIds: string[],
): RightPaneNode =>
  updateLeaf(node, leafId, (leaf) => {
    const merged = [...leaf.tabIds];
    for (const id of tabIds) {
      if (!merged.includes(id)) {
        merged.push(id);
      }
    }
    return {
      ...leaf,
      tabIds: merged,
      activeTabId: leaf.activeTabId ?? merged[0] ?? null,
    };
  });

/** 把 tab 插入指定组的位置 index，并激活它。 */
export const insertTabIntoLeaf = (
  node: RightPaneNode,
  leafId: string,
  tabId: string,
  index: number | null,
): RightPaneNode =>
  updateLeaf(node, leafId, (leaf) => {
    const rest = leaf.tabIds.filter((id) => id !== tabId);
    const at =
      index === null ? rest.length : Math.max(0, Math.min(index, rest.length));
    rest.splice(at, 0, tabId);
    return { ...leaf, tabIds: rest, activeTabId: tabId };
  });

/** 拆分组：把 tab 放进新建的组，与原组按 edge 方向并排。 */
export const splitLeafWithTab = (
  node: RightPaneNode,
  leafId: string,
  tabId: string,
  edge: PaneEdge,
): RightPaneNode => {
  const orientation: "row" | "column" =
    edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  const newLeaf = createLeaf([tabId]);
  const split: RightPaneSplit = {
    kind: "split",
    id: nextPaneNodeId("split"),
    orientation,
    sizes: [0.5, 0.5],
    children: [],
  };
  return updateLeaf(node, leafId, (leaf) => ({
    ...split,
    children: before ? [newLeaf, leaf] : [leaf, newLeaf],
  }));
};

export const setSplitSizes = (
  node: RightPaneNode,
  splitId: string,
  sizes: number[],
): RightPaneNode =>
  updateSplitNode(node, splitId, (split) => ({ ...split, sizes }));

/** 所有子节点等分（分隔条双击复位）。 */
export const equalizeSplit = (split: RightPaneSplit): RightPaneSplit => ({
  ...split,
  sizes: split.children.map(() => 1 / split.children.length),
});

/** 计算所有节点（组与分割节点）相对容器的比例矩形。 */
export const computeRects = (node: RightPaneNode): Map<string, PaneRect> => {
  const rects = new Map<string, PaneRect>();
  const walk = (current: RightPaneNode, rect: PaneRect): void => {
    rects.set(current.id, rect);
    if (current.kind === "leaf") {
      return;
    }
    const total = current.sizes.reduce((sum, size) => sum + size, 0) || 1;
    let offset = 0;
    current.children.forEach((child, index) => {
      const fraction = (current.sizes[index] ?? 1) / total;
      if (current.orientation === "row") {
        walk(child, {
          left: rect.left + offset * rect.width,
          top: rect.top,
          width: fraction * rect.width,
          height: rect.height,
        });
      } else {
        walk(child, {
          left: rect.left,
          top: rect.top + offset * rect.height,
          width: rect.width,
          height: fraction * rect.height,
        });
      }
      offset += fraction;
    });
  };
  walk(node, { left: 0, top: 0, width: 1, height: 1 });
  return rects;
};

/** 分隔条列表：每条贴在某个子节点与其后一个子节点的交界线上。 */
export const computeSplitters = (node: RightPaneNode): PaneSplitter[] => {
  const splitters: PaneSplitter[] = [];
  const walk = (current: RightPaneNode): void => {
    if (current.kind === "leaf") {
      return;
    }
    for (let index = 0; index < current.children.length - 1; index += 1) {
      splitters.push({
        key: `${current.id}:${index}`,
        splitId: current.id,
        childId: current.children[index].id,
        index,
        orientation: current.orientation,
      });
    }
    current.children.forEach(walk);
  };
  walk(node);
  return splitters;
};

export const paneRectVar = (id: string, part: "l" | "t" | "w" | "h"): string =>
  `--rp-${id}-${part}`;

export const formatFraction = (value: number): string =>
  `${(value * 100).toFixed(4)}%`;

/** 把几何写成 CSS 变量对象（可直接作为容器的 style 使用）。 */
export const paneLayoutVars = (
  layout: RightPaneNode,
): Record<string, string> => {
  const vars: Record<string, string> = {};
  for (const [id, rect] of computeRects(layout)) {
    vars[paneRectVar(id, "l")] = formatFraction(rect.left);
    vars[paneRectVar(id, "t")] = formatFraction(rect.top);
    vars[paneRectVar(id, "w")] = formatFraction(rect.width);
    vars[paneRectVar(id, "h")] = formatFraction(rect.height);
  }
  return vars;
};

/**
 * 命令式写入几何变量（拖拽分隔条时逐帧调用，避免每帧 setState）。
 * 返回本次计算出的矩形表，供命中测试复用。
 */
export const applyLayoutVars = (
  element: HTMLElement,
  layout: RightPaneNode,
): Map<string, PaneRect> => {
  const rects = computeRects(layout);
  for (const [id, rect] of rects) {
    element.style.setProperty(paneRectVar(id, "l"), formatFraction(rect.left));
    element.style.setProperty(paneRectVar(id, "t"), formatFraction(rect.top));
    element.style.setProperty(paneRectVar(id, "w"), formatFraction(rect.width));
    element.style.setProperty(
      paneRectVar(id, "h"),
      formatFraction(rect.height),
    );
  }
  return rects;
};

/** tab 顺序按布局的视觉顺序重排（关闭 / 移动后保证索引语义与显示一致）。 */
const orderTabsByLayout = (
  tabs: RightPanelTab[],
  layout: RightPaneNode,
): RightPanelTab[] => {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered: RightPanelTab[] = [];
  for (const id of flattenTabIds(layout)) {
    const tab = byId.get(id);
    if (tab) {
      ordered.push(tab);
      byId.delete(id);
    }
  }
  if (byId.size > 0) {
    for (const tab of tabs) {
      if (byId.has(tab.id)) {
        ordered.push(tab);
      }
    }
  }
  if (
    ordered.length === tabs.length &&
    ordered.every((tab, index) => tab === tabs[index])
  ) {
    return tabs;
  }
  return ordered;
};

const finalizeWorkspace = (
  workspace: RightPanelWorkspace,
  preferredPaneId?: string,
): RightPanelWorkspace => {
  const leaves = collectLeaves(workspace.layout);
  const wanted = preferredPaneId ?? workspace.activePaneId;
  const activePaneId = leaves.some((leaf) => leaf.id === wanted)
    ? wanted
    : leaves[0].id;
  const tabs = orderTabsByLayout(workspace.tabs, workspace.layout);
  if (tabs === workspace.tabs && activePaneId === workspace.activePaneId) {
    return workspace;
  }
  return { tabs, layout: workspace.layout, activePaneId };
};

export const workspaceActiveTabId = (
  workspace: RightPanelWorkspace,
): string => {
  const leaf =
    findLeafById(workspace.layout, workspace.activePaneId) ??
    collectLeaves(workspace.layout)[0];
  return leaf?.activeTabId ?? "";
};

export const createWorkspace = (tabs: RightPanelTab[]): RightPanelWorkspace => {
  const leaf = createLeaf(
    tabs.map((tab) => tab.id),
    tabs[0]?.id ?? null,
  );
  return { tabs, layout: leaf, activePaneId: leaf.id };
};

/** tab 注册表变化后同步布局：新 tab 放进当前聚焦的组，已关闭的 tab 从布局移除。 */
export const syncWorkspaceTabs = (
  workspace: RightPanelWorkspace,
  nextTabs: RightPanelTab[],
): RightPanelWorkspace => {
  const validTabIds = new Set(nextTabs.map((tab) => tab.id));
  let layout = pruneEmptyLeaves(pruneTabs(workspace.layout, validTabIds));
  const placed = new Set(flattenTabIds(layout));
  const newcomers = nextTabs
    .filter((tab) => !placed.has(tab.id))
    .map((tab) => tab.id);
  if (newcomers.length > 0) {
    const target =
      findLeafById(layout, workspace.activePaneId) ?? collectLeaves(layout)[0];
    layout = target
      ? appendTabsToLeaf(layout, target.id, newcomers)
      : createLeaf(newcomers);
  }
  return finalizeWorkspace({
    tabs: nextTabs,
    layout,
    activePaneId: workspace.activePaneId,
  });
};

/** 激活某个 tab（同时把它所在的组设为聚焦组）。 */
export const activateTabInWorkspace = (
  workspace: RightPanelWorkspace,
  tabId: string,
): RightPanelWorkspace => {
  const leaf = findLeafByTab(workspace.layout, tabId);
  if (!leaf) {
    return workspace;
  }
  if (leaf.activeTabId === tabId && workspace.activePaneId === leaf.id) {
    return workspace;
  }
  const layout = updateLeaf(workspace.layout, leaf.id, (current) => ({
    ...current,
    activeTabId: tabId,
  }));
  return finalizeWorkspace({ ...workspace, layout }, leaf.id);
};

/** 聚焦某个组（该组当前激活的 tab 成为面板激活 tab）。 */
export const focusPaneInWorkspace = (
  workspace: RightPanelWorkspace,
  paneId: string,
): RightPanelWorkspace => {
  if (workspace.activePaneId === paneId) {
    return workspace;
  }
  const leaf = findLeafById(workspace.layout, paneId);
  if (!leaf) {
    return workspace;
  }
  return { ...workspace, activePaneId: paneId };
};

/**
 * 把 tab 移动到目标组：
 * - edge 为 center：合并进目标组（index 为插入位置，null 表示追加到末尾）；
 * - 其余方向：以该 tab 拆出新的组，落在目标组的对应一侧。
 */
export const moveTabToPaneInWorkspace = (
  workspace: RightPanelWorkspace,
  tabId: string,
  targetLeafId: string,
  index: number | null,
  edge: PaneEdge,
): RightPanelWorkspace => {
  const source = findLeafByTab(workspace.layout, tabId);
  if (!source) {
    return workspace;
  }
  const sourceIndex = source.tabIds.indexOf(tabId);
  let layout = pruneEmptyLeaves(removeTabFromPanes(workspace.layout, tabId));
  const target = findLeafById(layout, targetLeafId);
  if (!target) {
    // 源组因移出唯一 tab 被折叠（等价于原地不动）。
    return workspace;
  }
  if (edge === "center") {
    let at = index === null ? target.tabIds.length : index;
    if (source.id === target.id && sourceIndex < at) {
      at -= 1;
    }
    layout = insertTabIntoLeaf(layout, target.id, tabId, at);
    return finalizeWorkspace({ ...workspace, layout }, target.id);
  }
  layout = splitLeafWithTab(layout, target.id, tabId, edge);
  const created = findLeafByTab(layout, tabId);
  return finalizeWorkspace({ ...workspace, layout }, created?.id ?? target.id);
};

/** 分隔条拖拽结束后提交新的尺寸权重。 */
export const resizeSplitInWorkspace = (
  workspace: RightPanelWorkspace,
  splitId: string,
  sizes: number[],
): RightPanelWorkspace => {
  const split = findSplitById(workspace.layout, splitId);
  if (
    split &&
    split.sizes.length === sizes.length &&
    split.sizes.every((size, index) => size === sizes[index])
  ) {
    return workspace;
  }
  return {
    ...workspace,
    layout: setSplitSizes(workspace.layout, splitId, sizes),
  };
};

/** 分隔条双击：该分割节点下所有子节点等分。 */
export const equalizeSplitInWorkspace = (
  workspace: RightPanelWorkspace,
  splitId: string,
): RightPanelWorkspace => {
  const split = findSplitById(workspace.layout, splitId);
  if (!split) {
    return workspace;
  }
  return {
    ...workspace,
    layout: updateSplitNode(workspace.layout, splitId, equalizeSplit),
  };
};
