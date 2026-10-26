/**
 * 独立面板窗口入口（右侧面板 tab「在新窗口中打开」）。
 *
 * 窗口承载一个 RightPanel 实例（detachedWindow 模式）：初始 tab 由主进程暂存的
 * payload 经 token 取回；窗口内新开 tab、移回主窗口等行为与主面板保持一致。
 * 窗口没有聊天输入框与侧边栏，元素选择、打开设置等需主窗口承接的事件经主进程转发。
 */
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./themes/bundled-fonts.css";
import "./themes/context-menu.css";
import "./themes/tokens.css";
import "./themes/hljs.css";
import "./themes/markdown.css";
import "./themes/tool-cards.css";
import "./themes/data-table.css";
import "./themes/tool-results.css";
import "./themes/theme-settings.css";
import "./themes/preset-cream.css";
import "./themes/preset-google.css";
import "./themes/preset-win95.css";
import "./themes/preset-macos.css";
import "./themes/preset-cyberpunk.css";
import "./themes/preset-notion.css";
import "./themes/preset-compact.css";
import "./themes/preset-wenjie.css";
import "./themes/preset-rococo.css";
import "./themes/layout-layered.css";
import "./themes/layout-flush.css";
import type { WorkspaceDirectoryRecord } from "../preload";
import type { DetachedPanelPayload } from "../shared/detachedPanel";
import { I18nProvider, useI18n } from "./i18n";
import { useTheme } from "./hooks/useTheme";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { applyThemeCacheToDocument } from "./components/sidebar/themeSettings/themeSettingsUtils";
import {
  KeyboardShortcutsProvider,
  useKeyboardShortcutsSettings,
} from "./components/KeyboardShortcutsProvider";
import { openNewChatInNewWindow } from "./components/sidebar/mainSidebar/openConversationInNewWindow";
import { AppErrorBoundary } from "./components/common/AppErrorBoundary";
import { GlobalEditContextMenu } from "./components/common/GlobalEditContextMenu";
import { ConfirmDialog } from "./components/common/ConfirmDialog";
import { DetachedPanelTitleBar } from "./components/DetachedPanelTitleBar";
import { RightPanel } from "./components/RightPanel";
import { ChatConversationProvider } from "./components/mainContent/chatMessages/components/ChatConversationContext";
import {
  hasMountedConversationPane,
  toRightPanelTab,
} from "./components/rightPanel/detachedPanelTab";
import { applyPluginRuntimeMirror } from "./plugins/runtimeMirror";
import {
  INSERT_ELEMENT_TAG_EVENT,
  type ElementTag,
} from "./components/mainContent/chatInput/fileTagUtils";
import { APP_CONTROL_OPEN_SETTINGS_EVENT } from "./hooks/useAppControl";
import { setActiveSshWorkspace } from "./ssh/sshConnectionStore";

// 与主窗口 main.tsx 一致：React 渲染前同步应用缓存的主题快照，避免首屏白闪。
applyThemeCacheToDocument();

function DetachedPanelWindowApp(): React.JSX.Element | null {
  const { t } = useI18n();
  // 主题 CSS 变量由主窗口注入，独立窗口需自行应用（读 Rust 后端持久化的主题设置）。
  useTheme();
  // 局部快捷键（如文件查看器的文内搜索）依赖 document 级 keydown 引擎；
  // 全局动作在本窗口没有注册处理器，引擎对其为空操作。
  useKeyboardShortcuts();
  const { registerHandler } = useKeyboardShortcutsSettings();

  // 元素选择确认后派发 INSERT_ELEMENT_TAG_EVENT（useWebviewElementPicker 的 confirmPicker）。
  // 本窗口挂载着会话面板时，标签由其中的聊天输入框接收；否则转发给主窗口的聊天输入框。
  useEffect(() => {
    const handleElementTag = (event: Event): void => {
      const tag = (event as CustomEvent<ElementTag>).detail;
      if (!tag || hasMountedConversationPane()) {
        return;
      }
      window.snow.forwardElementTagToChat({
        url: tag.url,
        tag: tag.tag,
        label: tag.label,
        text: tag.text,
        note: tag.note,
        domTree: tag.domTree,
      });
    };
    window.addEventListener(INSERT_ELEMENT_TAG_EVENT, handleElementTag);
    return () => {
      window.removeEventListener(INSERT_ELEMENT_TAG_EVENT, handleElementTag);
    };
  }, []);

  // 「浏览器设置」等设置入口派发 APP_CONTROL_OPEN_SETTINGS_EVENT，但本窗口没有 Sidebar
  // 监听该事件，因此转发给主窗口（主进程聚焦主窗口后由 Sidebar 打开设置）。
  useEffect(() => {
    const handleOpenSettings = (event: Event): void => {
      const detail = (event as CustomEvent<{ view?: string }>).detail;
      window.snow.forwardOpenSettingsToMain(detail?.view ?? "browser-settings");
    };
    window.addEventListener(
      APP_CONTROL_OPEN_SETTINGS_EVENT,
      handleOpenSettings,
    );
    return () => {
      window.removeEventListener(
        APP_CONTROL_OPEN_SETTINGS_EVENT,
        handleOpenSettings,
      );
    };
  }, []);

  // 插件面板依赖的会话 / 项目等实时状态由主窗口镜像推送（见 plugins/runtimeMirror.ts）。
  // 先订阅广播再取回最近一份镜像：广播与取回回复按主进程发送顺序到达，后到的快照不会被旧值覆盖。
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.snow.onDetachedRuntimeMirror((mirror) => {
      applyPluginRuntimeMirror(mirror);
    });
    void window.snow
      .takeDetachedRuntimeMirror()
      .then((mirror) => {
        if (mirror && !cancelled) {
          applyPluginRuntimeMirror(mirror);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  // 顶部操作栏显示的标题：由 RightPanel 回传活动 tab 标题。
  const [windowTitle, setWindowTitle] = useState("Snow");
  // 用户请求关闭窗口（标题栏关闭、系统关闭）时由主进程拦截并通知，这里弹出二次确认。
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);
  useEffect(
    () =>
      window.snow.onDetachedPanelCloseRequested(() => {
        setIsCloseConfirmOpen(true);
      }),
    [],
  );
  // undefined：加载中；null：payload 已失效（窗口应关闭）。
  const [payload, setPayload] = useState<
    DetachedPanelPayload | null | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    void window.snow
      .takeDetachedPanelPayload(token)
      .then((value) => {
        if (!cancelled) {
          setPayload(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPayload(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (payload === null) {
      // payload 已失效：窗口无内容可保留，直接关闭（不询问）。
      void window.snow.confirmDetachedPanelClose();
    }
  }, [payload]);

  const activeDirectory = (payload?.activeDirectory ??
    null) as WorkspaceDirectoryRecord | null;

  // 独立窗口同样持有其 SSH 项目的连接引用：文件解析与工具读取都依赖它。
  const activeSshWorkspacePath =
    activeDirectory?.kind === "ssh" ? activeDirectory.path : null;
  useEffect(() => {
    setActiveSshWorkspace(activeSshWorkspacePath);
    return () => {
      setActiveSshWorkspace(null);
    };
  }, [activeSshWorkspacePath]);

  // 快捷键在独立窗口内同样生效：新建会话沿用本窗口的项目，循环切换由主进程统一处理。
  useEffect(() => {
    const unsubNewChat = registerHandler("newChatInNewWindow", () => {
      openNewChatInNewWindow(
        activeDirectory,
        t("sidebar.newChat", { defaultValue: "New Chat" }),
      ).catch((error: unknown) => {
        console.error("Failed to open new chat in new window", error);
      });
    });
    const unsubCycle = registerHandler("cycleDetachedWindow", () => {
      void window.snow.focusNextDetachedPanelWindow();
    });
    return () => {
      unsubNewChat();
      unsubCycle();
    };
  }, [registerHandler, activeDirectory, t]);

  return (
    <AppErrorBoundary>
      <DetachedPanelTitleBar title={windowTitle} />
      <div className="detached-panel-body">
        {payload === undefined ? (
          // payload 尚未取回：与 detachedPanel.html 内置的占位保持一致，避免内容区空白。
          <div className="detached-panel-boot" role="status" aria-busy="true">
            <div className="detached-panel-boot-spinner" />
          </div>
        ) : payload ? (
          <ChatConversationProvider
            directoryId={activeDirectory?.directoryId}
            directoryPath={activeDirectory?.path}
            isDetachedWindow
          >
            <RightPanel
              isCollapsed={false}
              isFullscreen={false}
              activeDirectory={activeDirectory}
              detachedWindow={{ initialTab: toRightPanelTab(payload.tab) }}
              onActiveTabTitleChange={setWindowTitle}
              onRequestCloseDetachedWindow={() => setIsCloseConfirmOpen(true)}
            />
          </ChatConversationProvider>
        ) : null}
      </div>
      <ConfirmDialog
        open={isCloseConfirmOpen}
        title={t("detachedPanel.closeConfirmTitle", {
          defaultValue: "Close detached window",
        })}
        message={t("detachedPanel.closeConfirmMessage", {
          defaultValue:
            "Close this detached window? Conversations running in it will stop.",
        })}
        confirmLabel={t("common.confirm", { defaultValue: "Confirm" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="warning"
        onConfirm={() => {
          setIsCloseConfirmOpen(false);
          void window.snow.confirmDetachedPanelClose();
        }}
        onCancel={() => setIsCloseConfirmOpen(false)}
      />
    </AppErrorBoundary>
  );
}

const container = document.getElementById("detached-panel-root");
if (container) {
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <I18nProvider>
        <KeyboardShortcutsProvider>
          <DetachedPanelWindowApp />
        </KeyboardShortcutsProvider>
        <GlobalEditContextMenu />
      </I18nProvider>
    </React.StrictMode>,
  );
}
