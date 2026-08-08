import { useEffect, useRef } from "react";
import type {
  TerminalCommandRequest,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import type { TerminalOpenOptions } from "../types";
import {
  createTerminalTabId,
  executeTerminalMcpCommand,
  getFocusedTerminalTabId,
  parseTerminalMcpCommandArgs,
  waitForTerminalTab,
} from "./terminalMcpController";

export type TerminalTabInfo = {
  tabId: string;
  title: string;
  cwd: string;
  isActive: boolean;
};

export type TerminalMcpTabCallbacks = {
  openTab: (
    cwd: string,
    tabId?: string,
    options?: TerminalOpenOptions
  ) => string;
  closeTab: (tabId: string) => boolean;
  focusTab: (tabId: string) => boolean;
  listTabs: () => TerminalTabInfo[];
};

const resolveTabId = (argsJson: string): string | null => {
  const args = parseTerminalMcpCommandArgs(argsJson);
  const requested =
    typeof args.tabId === "string" ? args.tabId.trim() : "";
  if (!requested || requested.toLowerCase() === "current") {
    return getFocusedTerminalTabId();
  }
  return requested;
};

export const useTerminalMcpCommandBridge = (
  callbacks: TerminalMcpTabCallbacks,
  activeDirectory?: WorkspaceDirectoryRecord | null
): void => {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const activeDirRef = useRef(activeDirectory);
  activeDirRef.current = activeDirectory;

  useEffect(() => {
    return window.snow.registerTerminalCommandHandler(
      async (request: TerminalCommandRequest): Promise<string> => {
        const cb = callbacksRef.current;

        switch (request.operation) {
          case "open": {
            const args = parseTerminalMcpCommandArgs(request.argsJson);
            const requestedCwd =
              typeof args.cwd === "string" ? args.cwd.trim() : "";
            const shellPath =
              typeof args.shellPath === "string"
                ? args.shellPath.trim() || undefined
                : undefined;
            const sessionId =
              typeof args.sessionId === "string"
                ? args.sessionId.trim() || undefined
                : undefined;
            const activeDir = activeDirRef.current;
            const cwd =
              requestedCwd ||
              activeDir?.path ||
              "";
            const tabId = createTerminalTabId();
            cb.openTab(cwd, tabId, { shellPath, sessionId });
            await waitForTerminalTab(tabId);
            return JSON.stringify({
              tabId,
              cwd: cwd || null,
              shellPath: shellPath || null,
              opened: true,
            });
          }

          case "close": {
            const tabId = resolveTabId(request.argsJson);
            if (!tabId) {
              throw new Error(
                "No terminal tab is available to close; open a terminal tab first"
              );
            }
            const closed = cb.closeTab(tabId);
            if (!closed) {
              throw new Error(`Terminal tab was not found: ${tabId}`);
            }
            return JSON.stringify({
              tabId,
              closed: true,
            });
          }

          case "focus": {
            const args = parseTerminalMcpCommandArgs(request.argsJson);
            const tabId =
              typeof args.tabId === "string" ? args.tabId.trim() : "";
            if (!tabId) {
              throw new Error("tabId is required for terminal-focus");
            }
            const focused = cb.focusTab(tabId);
            if (!focused) {
              throw new Error(`Terminal tab was not found: ${tabId}`);
            }
            return JSON.stringify({
              tabId,
              focused: true,
            });
          }

          case "list": {
            const tabs = cb.listTabs();
            return JSON.stringify({
              tabs,
              totalTabs: tabs.length,
            });
          }

          default:
            // Delegate instance-level operations (send, read, resize, wait)
            // to the terminal MCP controller which dispatches to the
            // individual TerminalPanelContent instance handler.
            return executeTerminalMcpCommand(
              request.operation,
              request.argsJson
            );
        }
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};
