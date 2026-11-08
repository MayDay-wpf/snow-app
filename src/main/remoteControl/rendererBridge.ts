import { getMainWindow } from "../app/mainWindow";
import { native } from "../native/nativeBridge";

/**
 * 渲染进程远控桥的调用层。
 *
 * 手机远控的 HTTP 服务（监听、鉴权、静态资源、附件、图片）已在 Rust 侧完成；
 * 需要桌面 UI 实时状态的操作由 Rust 通过 napi 回调这里，再由本模块执行
 * executeJavaScript 调用渲染进程的 window.__snowRemoteControl
 * （桥定义见 renderer/components/RemoteControlBridge.tsx）。
 */

/** 等待桌面渲染进程返回的上限。 */
const RENDERER_TIMEOUT_MS = 10_000;
/** AI 生成类桥调用的等待上限（模型响应可能持续数十秒）。 */
const LONG_RUNNING_TIMEOUT_MS = 120_000;
/** 需要放宽等待上限的桥动作。 */
const LONG_RUNNING_ACTIONS = new Set(["gitGenerateCommitMessage"]);

const withTimeout = <T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * 在渲染进程内调用远控桥方法；桥方法异常与基础设施故障以不同错误抛出：
 * - 渲染进程业务错误：`RENDERER_ERROR:<message>`
 * - 主窗口 / 桥不可用：原始错误消息
 */
const callRemoteRenderer = async (
  action: string,
  args: unknown[] = [],
): Promise<unknown> => {
  const window = getMainWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    throw new Error("Snow 主窗口不可用");
  }
  // 在 Renderer 内捕获桥方法异常并结构化返回：业务错误（“电脑端不在对话页”
  // 等）由调用侧透传给手机端；只有基础设施故障才落到 503 兜底文案。
  const invocation = `(() => {
    const api = window.__snowRemoteControl;
    if (!api) return { __snowRemoteError: "远程控制桥尚未就绪" };
    try {
      return Promise.resolve(api[${JSON.stringify(action)}](...${JSON.stringify(args)})).then(
        (value) => ({ __snowRemoteValue: value }),
        (error) => ({ __snowRemoteError: (error && error.message) || String(error) }),
      );
    } catch (error) {
      return { __snowRemoteError: (error && error.message) || String(error) };
    }
  })()`;
  const raw = await withTimeout(
    window.webContents.executeJavaScript(invocation, true),
    LONG_RUNNING_ACTIONS.has(action)
      ? LONG_RUNNING_TIMEOUT_MS
      : RENDERER_TIMEOUT_MS,
    "桌面 Snow 响应超时，请确认主窗口仍在运行",
  );
  if (raw && typeof raw === "object" && "__snowRemoteError" in raw) {
    throw new Error(
      `RENDERER_ERROR:${String((raw as { __snowRemoteError: unknown }).__snowRemoteError)}`,
    );
  }
  if (raw && typeof raw === "object" && "__snowRemoteValue" in raw) {
    return (raw as { __snowRemoteValue: unknown }).__snowRemoteValue;
  }
  return raw;
};

let bridgeInstallation: Promise<void> | null = null;

/**
 * 把渲染进程桥注册到 Rust 远控服务（幂等）。
 *
 * Rust 通过 `{ action, argsJson }` 派发调用，这里返回 JSON 字符串：
 * `{ ok: true, value }`、`{ ok: false, kind: "renderer", error }`（业务错误，
 * 文案透传给手机端）或 `{ ok: false, kind: "infra", error }`（下层故障）。
 */
export const installRemoteRendererBridge = (): Promise<void> => {
  if (!bridgeInstallation) {
    bridgeInstallation = (async () => {
      await native.setRemoteControlRendererBridge(
        async (request: { action: string; argsJson: string }) => {
          try {
            const parsed: unknown = JSON.parse(request.argsJson || "[]");
            const args = Array.isArray(parsed) ? parsed : [parsed];
            const value = await callRemoteRenderer(request.action, args);
            return JSON.stringify({ ok: true, value: value ?? null });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            // 渲染进程业务错误（RENDERER_ERROR: 前缀）透传给手机端；
            // 其余按下层故障处理，由原生服务回 503 兜底文案。
            const rendererPrefix = "RENDERER_ERROR:";
            if (message.startsWith(rendererPrefix)) {
              return JSON.stringify({
                ok: false,
                kind: "renderer",
                error: message.slice(rendererPrefix.length),
              });
            }
            return JSON.stringify({ ok: false, kind: "infra", error: message });
          }
        },
      );
    })().catch((error) => {
      // 注册失败允许下次调用重试（例如 native 绑定尚未就绪）。
      bridgeInstallation = null;
      throw error;
    });
  }
  return bridgeInstallation;
};
