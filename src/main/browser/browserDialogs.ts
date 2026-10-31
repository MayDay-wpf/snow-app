import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  redactBrowserText,
  redactBrowserUrl,
} from "../../shared/browserRedaction";

type PendingDialog = {
  /** 不透明句柄，供定向响应；不暴露 CDP session。 */
  id: string;
  type: string;
  message: string;
  url: string;
  defaultPrompt: string;
  openedAt: string;
  /** 弹窗所属帧 CDP session；主帧为空。 */
  sessionId?: string;
  timer: ReturnType<typeof setTimeout>;
  responding: boolean;
};
const pendingDialogs = new Map<number, Map<string, PendingDialog>>();
const DIALOG_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 5_000;

const dialogKey = (sessionId?: string): string => sessionId ?? "";

/** 按 webContents 清理全部 pending；传 sessionId 时只清理该帧会话。 */
export const clearBrowserDialogs = (
  webContentsId: number,
  sessionId?: string,
): void => {
  const dialogs = pendingDialogs.get(webContentsId);
  if (!dialogs) return;
  if (sessionId === undefined) {
    for (const dialog of dialogs.values()) clearTimeout(dialog.timer);
    pendingDialogs.delete(webContentsId);
    return;
  }
  const key = dialogKey(sessionId);
  const dialog = dialogs.get(key);
  if (!dialog) return;
  clearTimeout(dialog.timer);
  dialogs.delete(key);
  if (dialogs.size === 0) pendingDialogs.delete(webContentsId);
};

// Called by the existing shared debugger listener, never attach another session.
export const handleBrowserDialogMessage = (
  contents: WebContents,
  method: string,
  params: unknown,
  sessionId = "",
): void => {
  if (method === "Page.javascriptDialogClosed") {
    clearBrowserDialogs(contents.id, sessionId);
    return;
  }
  if (method !== "Page.javascriptDialogOpening") return;
  const raw = (params ?? {}) as Record<string, unknown>;
  // 同一帧会话只能有一个打开的 JS 弹窗；其他帧会话的 pending 保留。
  clearBrowserDialogs(contents.id, sessionId);
  const pending: PendingDialog = {
    id: randomUUID(),
    type: typeof raw.type === "string" ? raw.type : "unknown",
    message:
      typeof raw.message === "string" ? redactBrowserText(raw.message) : "",
    url: typeof raw.url === "string" ? redactBrowserUrl(raw.url) : "",
    defaultPrompt:
      typeof raw.defaultPrompt === "string"
        ? redactBrowserText(raw.defaultPrompt)
        : "",
    openedAt: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
    responding: false,
    // Keep a bounded response window; abandoned dialogs must not freeze the tab forever.
    timer: setTimeout(() => {
      const dialogs = pendingDialogs.get(contents.id);
      if (dialogs?.get(dialogKey(sessionId)) !== pending) return;
      clearBrowserDialogs(contents.id, sessionId);
      if (!contents.isDestroyed() && contents.debugger.isAttached()) {
        void contents.debugger
          .sendCommand(
            "Page.handleJavaScriptDialog",
            { accept: false },
            sessionId || undefined,
          )
          .catch(() => {});
      }
    }, DIALOG_TIMEOUT_MS),
  };
  let dialogs = pendingDialogs.get(contents.id);
  if (!dialogs) {
    dialogs = new Map();
    pendingDialogs.set(contents.id, dialogs);
  }
  dialogs.set(dialogKey(sessionId), pending);
};

export const listBrowserDialogs = (
  webContentsId: number,
): Record<string, unknown>[] => {
  const dialogs = pendingDialogs.get(webContentsId);
  if (!dialogs) return [];
  return [...dialogs.entries()].map(([key, pending]) => {
    const {
      timer: _timer,
      responding: _responding,
      sessionId: _sessionId,
      id,
      ...dialog
    } = pending;
    return {
      ...dialog,
      dialogId: id,
      frame: key ? "iframe" : "main",
      expiresAfterMs: DIALOG_TIMEOUT_MS,
    };
  });
};

export const respondBrowserDialog = async (
  contents: WebContents,
  accept: boolean,
  promptText?: string,
  dialogId?: string,
): Promise<{ responded: boolean; remaining: number; error?: string }> => {
  const dialogs = pendingDialogs.get(contents.id);
  if (!dialogs || dialogs.size === 0)
    return {
      responded: false,
      remaining: 0,
      error: "No pending JavaScript dialog",
    };
  // dialogId 定向处理一个弹窗；省略时保持原有的「同一响应处理所有 pending」语义。
  const entries = dialogId
    ? [...dialogs.entries()].filter(([, dialog]) => dialog.id === dialogId)
    : [...dialogs.entries()];
  if (entries.length === 0)
    return {
      responded: false,
      remaining: dialogs.size,
      error:
        "No pending JavaScript dialog matches dialogId; it may have been closed or timed out",
    };
  if (entries.some(([, dialog]) => dialog.responding))
    throw new Error("JavaScript dialog response is already in progress");
  const failures: string[] = [];
  let responded = 0;
  for (const [key, pending] of entries) {
    pending.responding = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        contents.debugger.sendCommand(
          "Page.handleJavaScriptDialog",
          {
            accept,
            ...(promptText !== undefined && pending.type === "prompt"
              ? { promptText }
              : {}),
          },
          pending.sessionId,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("JavaScript dialog response timed out")),
            RESPONSE_TIMEOUT_MS,
          );
        }),
      ]);
      const current = pendingDialogs.get(contents.id);
      if (current?.get(key) === pending) {
        clearTimeout(pending.timer);
        current.delete(key);
        if (current.size === 0) pendingDialogs.delete(contents.id);
      }
      responded += 1;
    } catch (error) {
      failures.push(
        redactBrowserText(
          error instanceof Error ? error.message : String(error),
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
      pending.responding = false;
    }
  }
  const remaining = pendingDialogs.get(contents.id)?.size ?? 0;
  return {
    responded: responded > 0,
    remaining,
    ...(failures.length > 0 ? { error: failures.join("; ") } : {}),
  };
};
