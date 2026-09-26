import { useEffect, useRef, useSyncExternalStore } from "react";

import type { WorkspaceDirectoryRecord } from "../../preload";
import { useI18n } from "../i18n";
import {
  runtimeSnapshot,
  type RuntimeSnapshot,
} from "../plugins/runtimeSnapshot";
import type { MainContentView } from "../components/mainContent/types";

/** 客户端脚本可用的事件名（脚本经 snow.client.openView 触发）。 */
const CLIENT_OPEN_VIEW_EVENT = "snow:client-open-view";

/** 稳定的订阅函数：避免每次渲染都重新订阅运行时快照。 */
const subscribeRuntime = (listener: () => void): (() => void) =>
  runtimeSnapshot.subscribe(() => listener());

const readRuntimeSnapshot = (): RuntimeSnapshot => runtimeSnapshot.get();

const SETTINGS_VIEWS = new Set<MainContentView>([
  "api-settings",
  "imagegen-settings",
  "image-library",
  "browser-settings",
  "browser-devices",
  "proxy-browser-settings",
  "codebase-settings",
  "git-settings",
  "system-prompt-settings",
  "personalization-settings",
  "custom-headers-settings",
  "mcp-settings",
  "lsp-settings",
  "skills-settings",
  "sub-agent-settings",
  "sensitive-command-settings",
  "custom-commands-settings",
  "hooks-settings",
  "terminal-settings",
  "theme-settings",
  "privacy-settings",
  "keyboard-shortcuts-settings",
  "pets-settings",
  "usage-settings",
  "system-logs",
  "general-settings",
  "remote-control-settings",
]);

type ClientScriptBridgeProps = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  activeView: MainContentView;
  isSidebarCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  onSelectMainView: (view: MainContentView) => void;
};

/**
 * 客户端脚本上下文桥：把当前界面上下文（视图 / 区域 / 右栏标签 / 主题 /
 * 语言 / 项目 / 会话 / 流式状态）发布给主进程，由主进程匹配客户端脚本并
 * 推给 preload 注入；同时承接脚本发起的界面操作（打开视图）。
 */
export const ClientScriptBridge = ({
  activeDirectory,
  activeView,
  isSidebarCollapsed,
  isRightPanelCollapsed,
  onSelectMainView,
}: ClientScriptBridgeProps): null => {
  const { locale } = useI18n();
  const snapshot = useSyncExternalStore(
    subscribeRuntime,
    readRuntimeSnapshot,
    readRuntimeSnapshot,
  );
  const publishTimer = useRef<number | null>(null);

  const panelsSignature = snapshot.panels.tabs.map((tab) => tab.type).join("|");
  const conversationId = snapshot.conversation?.conversationId ?? "";
  const isStreaming = snapshot.conversation?.isStreaming ?? false;

  useEffect(() => {
    const publish = (): void => {
      const surfaces: string[] = ["main", "topbar"];
      if (!isSidebarCollapsed) {
        surfaces.push("sidebar");
      }
      if (!isRightPanelCollapsed) {
        surfaces.push("right-panel");
      }
      if (activeView === "chat") {
        surfaces.push("chat");
      }
      if (SETTINGS_VIEWS.has(activeView)) {
        surfaces.push("settings");
      }
      const root = document.documentElement;
      window.snow
        .publishClientContext({
          view: activeView,
          surfaces,
          tabs: snapshot.panels.tabs.map((tab) => tab.type),
          theme: `${root.dataset.theme ?? ""}:${root.dataset.themePreset ?? ""}`,
          locale,
          projectId: activeDirectory?.directoryId ?? null,
          appReady: true,
          conversationId: conversationId || null,
          isStreaming,
        })
        .catch(() => {});
    };

    if (publishTimer.current !== null) {
      window.clearTimeout(publishTimer.current);
    }
    publishTimer.current = window.setTimeout(publish, 120);
    return () => {
      if (publishTimer.current !== null) {
        window.clearTimeout(publishTimer.current);
      }
    };
  }, [
    activeDirectory?.directoryId,
    activeView,
    conversationId,
    isStreaming,
    isRightPanelCollapsed,
    isSidebarCollapsed,
    locale,
    panelsSignature,
  ]);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ view?: unknown }>).detail;
      const view = typeof detail?.view === "string" ? detail.view.trim() : "";
      if (view) {
        onSelectMainView(view as MainContentView);
      }
    };
    window.addEventListener(CLIENT_OPEN_VIEW_EVENT, handler);
    return () => {
      window.removeEventListener(CLIENT_OPEN_VIEW_EVENT, handler);
    };
  }, [onSelectMainView]);

  return null;
};
