/**
 * Terminal MCP controller — mirrors the browser MCP controller pattern.
 *
 * Each open terminal tab registers itself here with a handler that can
 * perform PTY-level operations (send, read, resize, wait). The RightPanel
 * registers a command bridge that handles tab-level operations (open,
 * close, focus, list).
 *
 * The controller is a module-level singleton (not a React hook) so that
 * MCP command dispatch can reach any terminal tab regardless of which
 * component is currently mounted.
 */

export type TerminalMcpCommandArgs = Record<string, unknown>;

export type TerminalMcpCommandHandler = (
  operation: string,
  args: TerminalMcpCommandArgs,
) => Promise<unknown>;

export type TerminalTabInfo = {
  tabId: string;
  title: string;
  cwd: string;
  isActive: boolean;
};

type TabWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Registered terminal instances keyed by tab ID. */
const instances = new Map<string, TerminalMcpCommandHandler>();

/** Metadata for list operations (title, cwd, active state). */
const tabMetadata = new Map<string, { title: string; cwd: string }>();

/** Waiters for tabs that are being opened (waiting for TerminalPanelContent to mount). */
const tabWaiters = new Map<string, Set<TabWaiter>>();

/**
 * 最近聚焦的终端 tab：由右侧面板按「面板激活 tab」同步写入（与 terminal-manage
 * action=list 的 isActive 同源）。可能指向尚未挂载或已关闭的 tab，解析时由
 * getFallbackTabId 校验，失效则回退到最后注册的实例。
 */
let focusedTabId: string | null = null;

const parseCommandArgs = (argsJson: string): TerminalMcpCommandArgs => {
  const value = JSON.parse(argsJson) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Terminal command arguments must be a JSON object");
  }
  return value as TerminalMcpCommandArgs;
};

const getFallbackTabId = (): string | null => {
  if (focusedTabId && instances.has(focusedTabId)) {
    return focusedTabId;
  }
  const registeredTabIds = [...instances.keys()];
  return registeredTabIds.at(-1) ?? null;
};

export const createTerminalTabId = (): string =>
  `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// 不校验是否已注册：终端内容为懒加载组件，激活时实例可能尚未挂载，
// 记录下来待注册后即可命中。
export const focusTerminalTab = (tabId: string): void => {
  focusedTabId = tabId;
};

export const registerTerminalMcpInstance = (
  tabId: string,
  handler: TerminalMcpCommandHandler,
  metadata: { title: string; cwd: string },
): (() => void) => {
  instances.set(tabId, handler);
  tabMetadata.set(tabId, metadata);

  // Resolve any waiters that were blocked on this tab becoming ready.
  const waiters = tabWaiters.get(tabId);
  if (waiters) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    tabWaiters.delete(tabId);
  }

  return () => {
    if (instances.get(tabId) === handler) {
      instances.delete(tabId);
      tabMetadata.delete(tabId);
    }
  };
};

export const waitForTerminalTab = (
  tabId: string,
  timeoutMs = 10_000,
): Promise<void> => {
  if (instances.has(tabId)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = tabWaiters.get(tabId);
      waiters?.delete(waiter);
      if (waiters?.size === 0) {
        tabWaiters.delete(tabId);
      }
      reject(new Error(`Terminal tab did not become ready: ${tabId}`));
    }, timeoutMs);
    const waiter: TabWaiter = { resolve, reject, timer };
    const waiters = tabWaiters.get(tabId) ?? new Set<TabWaiter>();
    waiters.add(waiter);
    tabWaiters.set(tabId, waiters);
  });
};

export const executeTerminalMcpCommand = async (
  operation: string,
  argsJson: string,
): Promise<string> => {
  const args = parseCommandArgs(argsJson);
  const requestedTabId =
    typeof args.tabId === "string" ? args.tabId.trim() : "";
  const useFocusedTab =
    !requestedTabId || requestedTabId.toLowerCase() === "current";
  const tabId = useFocusedTab ? getFallbackTabId() : requestedTabId;
  if (!tabId) {
    throw new Error(
      `No terminal tab is available for terminal-manage action=${operation}; open a terminal tab first`,
    );
  }

  const handler = instances.get(tabId);
  if (!handler) {
    throw new Error(`Terminal tab was not found: ${tabId}`);
  }
  const result = await handler(operation, { ...args, tabId });
  return JSON.stringify(result);
};

export const parseTerminalMcpCommandArgs = parseCommandArgs;

export const getFocusedTerminalTabId = (): string | null => getFallbackTabId();

export const getTerminalTabMetadata = (
  tabId: string,
): { title: string; cwd: string } | undefined => tabMetadata.get(tabId);

export const hasTerminalMcpInstance = (tabId: string): boolean =>
  instances.has(tabId);
