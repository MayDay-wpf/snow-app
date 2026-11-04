import { Component, type ErrorInfo, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { writeRendererLog } from "../../utils/rendererLog";

// ---------------------------------------------------------------------------
// 动态分包加载失败的自愈机制：自动 reload 恢复，5 秒内超 2 次则停止，
// 展示可手动重载的错误界面（sessionStorage 记录计数）。
// ---------------------------------------------------------------------------

const RECOVERY_STORAGE_KEY = "snow.chunk-reload-state";
const RECOVERY_WINDOW_MS = 5000;
const MAX_AUTO_RELOADS = 2;

type RecoveryState = {
  count: number;
  lastAt: number;
};

const readRecoveryState = (): RecoveryState => {
  try {
    const raw = window.sessionStorage.getItem(RECOVERY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as RecoveryState;
      if (
        typeof parsed.count === "number" &&
        typeof parsed.lastAt === "number"
      ) {
        return parsed;
      }
    }
  } catch {
    // sessionStorage 不可用时按首次失败处理。
  }
  return { count: 0, lastAt: 0 };
};

const writeRecoveryState = (state: RecoveryState): void => {
  try {
    window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 写入失败不影响主流程。
  }
};

/** 判定错误是否为「动态分包加载失败」的典型形态。 */
export const isChunkLoadError = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return (
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("net::ERR_FILE_NOT_FOUND")
  );
};

/**
 * 触发一次自动恢复刷新（带防循环计数）。
 * 返回 true 表示已发起刷新；false 表示已达自动刷新上限，需用户手动处理。
 */
export const requestChunkRecoveryReload = (): boolean => {
  const now = Date.now();
  const state = readRecoveryState();
  // 距上次自动刷新超过窗口期说明页面已恢复正常，重置计数额度。
  const count = now - state.lastAt > RECOVERY_WINDOW_MS ? 1 : state.count + 1;
  writeRecoveryState({ count, lastAt: now });

  if (count <= MAX_AUTO_RELOADS) {
    window.location.reload();
    return true;
  }
  return false;
};

type ErrorFallbackProps = {
  message: string;
};

const ErrorFallback = ({ message }: ErrorFallbackProps): React.JSX.Element => {
  const { t } = useI18n();

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-primary, #ffffff)",
        color: "var(--text-primary, #111827)",
        fontFamily:
          "var(--app-font-family, var(--font-sans, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif))",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 440, textAlign: "center" }}>
        <p
          style={{
            margin: 0,
            fontSize: 17,
            fontWeight: 600,
            lineHeight: 1.5,
          }}
        >
          {t("common.errorTitle")}
        </p>
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--text-secondary, #374151)",
          }}
        >
          {t("common.errorDescription")}
        </p>
        {message ? (
          <p
            style={{
              margin: "14px auto 0",
              maxWidth: 380,
              fontSize: 11,
              lineHeight: 1.5,
              wordBreak: "break-all",
              color: "var(--text-muted, #9ca3af)",
            }}
          >
            {message}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => {
            writeRecoveryState({ count: 0, lastAt: 0 });
            // 优先走主进程强制刷新：渲染进程自身状态可能已异常，
            // location.reload() 可能无效；IPC 不可用时回退到它。
            const reload = window.snow?.reloadWindow?.();
            if (reload) {
              reload.catch(() => window.location.reload());
            } else {
              window.location.reload();
            }
          }}
          style={{
            marginTop: 20,
            padding: "8px 22px",
            borderRadius: 6,
            border: "1px solid var(--bg-active, #e5e7eb)",
            background: "var(--bg-secondary, #f9fafb)",
            color: "var(--text-primary, #111827)",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {t("common.reload")}
        </button>
      </div>
    </div>
  );
};

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

/**
 * 应用级错误边界：任何子组件渲染错误都会落到这里，避免 React 卸载整棵树
 * 导致白屏。分包加载失败时自动刷新自愈，其余错误展示可恢复的错误界面。
 */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("AppErrorBoundary caught error:", error, info.componentStack);

    writeRendererLog("ERROR", {
      module: "renderer/AppErrorBoundary",
      func: "componentDidCatch",
      message: "React render error caught",
      error: `${error.name}: ${error.message}`,
      context: (info.componentStack ?? "").slice(0, 4000),
    });

    if (isChunkLoadError(error)) {
      requestChunkRecoveryReload();
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorFallback message={this.state.error.message} />;
    }
    return this.props.children;
  }
}
