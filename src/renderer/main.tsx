import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { applyThemeCacheToDocument } from "./components/sidebar/themeSettings/themeSettingsUtils";
import {
  AppErrorBoundary,
  isChunkLoadError,
  requestChunkRecoveryReload,
} from "./components/common/AppErrorBoundary";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./themes/tokens.css";
import "./themes/hljs.css";
import "./themes/theme-settings.css";
import "./themes/preset-cream.css";
import "./themes/preset-google.css";
import "./themes/preset-apple.css";

// 在 React 渲染之前同步应用 localStorage 中缓存的主题快照。
// 主题持久化在 Rust 后端，渲染进程启动时需通过 IPC 异步读取，
// 期间 CSS 变量保持默认浅色，会导致深色用户看到短暂白闪。
// 这里同步应用缓存，使首屏即呈现用户上次选择的主题。
applyThemeCacheToDocument();

// 兜底未进入 React 渲染路径的动态导入失败（如 mermaid 的手动 import()）。
// React.lazy 的失败会被 React 内部消费并转成渲染错误，由 AppErrorBoundary
// 捕获；这里的监听只覆盖裸 import() 产生的 unhandledrejection。
window.addEventListener("unhandledrejection", (event) => {
  if (isChunkLoadError(event.reason)) {
    console.error("Dynamic chunk import failed, attempting recovery reload");
    requestChunkRecoveryReload();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </I18nProvider>
  </React.StrictMode>
);
