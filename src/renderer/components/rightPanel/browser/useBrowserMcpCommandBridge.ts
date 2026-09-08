import { useEffect, useRef } from "react";
import type { BrowserCommandRequest } from "../../../../preload";
import { rightPanelEvents } from "../rightPanelEvents";
import {
  createBrowserInstanceId,
  executeBrowserMcpCommand,
  getFocusedBrowserInstanceId,
  parseBrowserMcpCommandArgs,
  waitForBrowserMcpInstance,
} from "./browserMcpController";

/** 等待右侧面板展开的兜底超时（毫秒），避免命令被永远挂起。 */
const EXPAND_WAIT_TIMEOUT_MS = 3_000;

export type BrowserTabInfo = {
  instanceId: string;
  title: string;
  url: string;
  isActive: boolean;
};

export type BrowserMcpTabCallbacks = {
  openTab: (url?: string, instanceId?: string) => string;
  closeTab: (instanceId: string) => boolean;
  focusTab: (instanceId: string) => boolean;
  listTabs: () => BrowserTabInfo[];
};

const resolveInstanceId = (argsJson: string): string | null => {
  const args = parseBrowserMcpCommandArgs(argsJson);
  const requested =
    typeof args.instanceId === "string" ? args.instanceId.trim() : "";
  if (!requested || requested.toLowerCase() === "current") {
    return getFocusedBrowserInstanceId();
  }
  return requested;
};

export const useBrowserMcpCommandBridge = (
  callbacks: BrowserMcpTabCallbacks,
  isCollapsed: boolean,
): void => {
  // 通过 ref 持有最新的 callbacks，避免 effect 因 callbacks 引用变化
  // 而反复执行 cleanup/setup。cleanup 会触发 browser:renderer-unregister，
  // 导致主进程立即 reject 所有正在等待的浏览器命令（例如 create 正在
  // 等待 waitForBrowserMcpInstance 时被中断）。
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  // isCollapsed 同因：ref 镜像避免命令 handler（只绑定一次）闭包过期。
  const isCollapsedRef = useRef(isCollapsed);
  isCollapsedRef.current = isCollapsed;

  // 面板折叠时 webview 不可见（.right-panel.collapsed 宽度为 0），
  // capturePage 只能返回空白 PNG，screenshot 等依赖渲染结果的操作
  // 必然失败。命令执行前若面板处于折叠状态，先请求展开（App 侧
  // request-expand 监听负责 setState），再轮询等待面板真正展开：
  // collapsed class 移除（React 完成重渲染）且宽度过渡动画结束
  // （> 0），保证 webview 已可见后才继续执行命令。
  const ensurePanelExpanded = async (): Promise<void> => {
    if (!isCollapsedRef.current) {
      return;
    }
    rightPanelEvents.emit("request-expand");
    const deadline = Date.now() + EXPAND_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const panel = document.querySelector(".right-panel");
      if (
        panel &&
        !panel.classList.contains("collapsed") &&
        panel.getBoundingClientRect().width > 10
      ) {
        return;
      }
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(undefined)),
      );
    }
  };

  useEffect(() => {
    return window.snow.registerBrowserCommandHandler(
      async (request: BrowserCommandRequest): Promise<string> => {
        await ensurePanelExpanded();
        const cb = callbacksRef.current;

        switch (request.operation) {
          case "create": {
            const args = parseBrowserMcpCommandArgs(request.argsJson);
            const url =
              typeof args.url === "string" ? args.url.trim() : undefined;
            const instanceId = createBrowserInstanceId();
            cb.openTab(url, instanceId);
            await waitForBrowserMcpInstance(instanceId);
            return JSON.stringify({
              instanceId,
              url: url || null,
              created: true,
            });
          }

          case "close": {
            const instanceId = resolveInstanceId(request.argsJson);
            if (!instanceId) {
              throw new Error(
                "No embedded browser is available to close; open a browser tab first",
              );
            }
            const closed = cb.closeTab(instanceId);
            if (!closed) {
              throw new Error(`Browser tab was not found: ${instanceId}`);
            }
            return JSON.stringify({
              instanceId,
              closed: true,
            });
          }

          case "focus": {
            const args = parseBrowserMcpCommandArgs(request.argsJson);
            const instanceId =
              typeof args.instanceId === "string" ? args.instanceId.trim() : "";
            if (!instanceId) {
              throw new Error("instanceId is required for browser-focus");
            }
            const focused = cb.focusTab(instanceId);
            if (!focused) {
              throw new Error(`Browser tab was not found: ${instanceId}`);
            }
            return JSON.stringify({
              instanceId,
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
            return executeBrowserMcpCommand(
              request.operation,
              request.argsJson,
            );
        }
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};
