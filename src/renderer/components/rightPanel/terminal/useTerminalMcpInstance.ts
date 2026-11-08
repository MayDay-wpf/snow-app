import { useEffect, useRef } from "react";
import type { IMarker, Terminal } from "@xterm/xterm";
import { registerTerminalMcpInstance } from "./terminalMcpController";
import { resolveTerminalKeys } from "./terminalKeys";
import { detectAwaitingInput } from "./terminalInputDetector";

/**
 * Register a terminal tab's xterm.js instance with the terminal MCP
 * controller so that MCP commands (send, read, resize, wait) can reach it.
 *
 * The handler performs PTY-level operations using the PTY id and the
 * xterm.js Terminal instance:
 *
 * - send: writes input to the PTY via the IPC bridge
 * - read: serializes the xterm buffer (visible screen) to plain text
 * - resize: resizes both the xterm display and the PTY process
 * - wait: polls for output quiescence and returns only the text produced
 *   since the last delivered checkpoint (incremental, not the full buffer)
 *
 * 默认目标（省略 tabId / current）由 RightPanel 按面板激活 tab 同步，
 * 不在这里按组内 isActive 推断：分屏时多个组的 tab 同时可见，组内激活
 * 不等于用户最近聚焦。
 */
export const useTerminalMcpInstance = (
  tabId: string,
  cwd: string,
  termRef: React.RefObject<Terminal | null>,
  ptyIdRef: React.RefObject<string | null>,
): void => {
  // 已交付内容检查点：wait 只返回此标记之后的新增行，避免重复历史
  const checkpointMarkerRef = useRef<IMarker | null>(null);

  useEffect(() => {
    const unregister = registerTerminalMcpInstance(
      tabId,
      async (operation, args) => {
        const term = termRef.current;
        const ptyId = ptyIdRef.current;

        switch (operation) {
          case "send": {
            if (!ptyId) {
              throw new Error("Terminal PTY is not ready yet");
            }
            // keys 模式：命名按键/控制序列，不自动补换行（用于交互提示与 TUI 导航）；
            // input 模式：普通文本，Rust 端已保证末尾带换行。
            const keys = Array.isArray(args.keys)
              ? args.keys.filter(
                  (key): key is string => typeof key === "string",
                )
              : [];
            const input = typeof args.input === "string" ? args.input : "";
            const payload = keys.length > 0 ? resolveTerminalKeys(keys) : input;
            // 写入前推进检查点，避免快速命令的输出在 wait 开始前被漏掉
            if (term) {
              advanceCheckpoint(term, checkpointMarkerRef);
            }
            await window.snow.ptyWrite(ptyId, payload);
            return {
              sent: true,
              length: payload.length,
              ...(keys.length > 0 ? { keys: keys.length } : {}),
            };
          }
          case "read": {
            if (!term) {
              throw new Error("Terminal display is not ready yet");
            }
            const waitMs =
              typeof args.waitMs === "number" && args.waitMs > 0
                ? Math.min(args.waitMs, 60000)
                : 0;
            if (waitMs > 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
            }
            const text = serializeTerminalBuffer(term);
            const { awaiting, hint } = detectAwaitingInput(term);
            return {
              text,
              read: true,
              // 终端是否正在等待输入（Agent 据此判断是否需要用户介入）
              awaitingInput: awaiting,
              // 等待输入时屏幕上的提示文本
              inputHint: hint,
            };
          }

          case "resize": {
            if (!term) {
              throw new Error("Terminal display is not ready yet");
            }
            const cols =
              typeof args.cols === "number"
                ? Math.max(1, Math.floor(args.cols))
                : 80;
            const rows =
              typeof args.rows === "number"
                ? Math.max(1, Math.floor(args.rows))
                : 24;
            try {
              term.resize(cols, rows);
            } catch {
              // xterm may throw if dimensions are the same
            }
            if (ptyId) {
              await window.snow.ptyResize(ptyId, cols, rows);
            }
            return { cols, rows, resized: true };
          }

          case "wait": {
            if (!term) {
              throw new Error("Terminal display is not ready yet");
            }
            const timeoutMs =
              typeof args.timeoutMs === "number"
                ? Math.max(args.timeoutMs, 1000)
                : 10000;
            const idleMs =
              typeof args.idleMs === "number"
                ? Math.min(Math.max(args.idleMs, 100), 5000)
                : 500;

            // 只返回检查点之后的新增内容；marker 失效时退化为读全量
            const marker = checkpointMarkerRef.current;
            const startLine = marker && marker.line >= 0 ? marker.line : 0;
            const result = await waitForTerminalIdle(term, timeoutMs, idleMs);
            const text = serializeTerminalBufferFrom(term, startLine);
            advanceCheckpoint(term, checkpointMarkerRef);
            const { awaiting, hint } = detectAwaitingInput(term);
            return {
              idle: result.idle,
              elapsedMs: result.elapsedMs,
              // 本轮新增文本（增量，不重复历史）
              text,
              // 兼容保留，与 text 相同
              afterText: text,
              // 终端是否正在等待输入（如 Press Enter / [y/N] / 密码等交互提示）
              awaitingInput: awaiting,
              // 等待输入时屏幕上的提示文本
              inputHint: hint,
            };
          }

          default:
            throw new Error(`Unknown terminal operation: ${operation}`);
        }
      },
      { title: cwd || "Terminal", cwd: cwd || "" },
    );
    // 上报 tab 归属：tab 迁移到独立面板窗口后，主进程据此把带 tabId 的终端命令
    // 路由到持有该 tab 的渲染进程。
    window.snow.notifyTerminalTabRegistered(tabId);

    return () => {
      checkpointMarkerRef.current?.dispose();
      checkpointMarkerRef.current = null;
      window.snow.notifyTerminalTabUnregistered(tabId);
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);
};

/**
 * Serialize the visible xterm.js buffer to plain text.
 *
 * Reads each line from the terminal buffer, trims trailing whitespace,
 * and joins with newlines. ANSI escape codes are not present in the
 * buffer API output (they are processed during rendering), so the
 * result is clean text.
 */
const serializeTerminalBuffer = (term: Terminal): string =>
  serializeTerminalBufferFrom(term, 0);

/**
 * Serialize the xterm.js buffer from an absolute buffer line (inclusive)
 * to the end, skipping already-delivered history.
 */
const serializeTerminalBufferFrom = (
  term: Terminal,
  startLine: number,
): string => {
  const buffer = term.buffer.active;
  const length = buffer.length;
  const start = Math.max(0, Math.min(startLine, length));
  const lines: string[] = [];
  for (let i = start; i < length; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  // Trim trailing empty lines.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
};

/**
 * 推进检查点到当前光标行：dispose 旧 marker，在当前光标行新建。
 * send 写入前与 wait 读取完成后调用。
 */
const advanceCheckpoint = (
  term: Terminal,
  checkpointMarkerRef: React.RefObject<IMarker | null>,
): void => {
  const previous = checkpointMarkerRef.current;
  if (previous) {
    previous.dispose();
  }
  checkpointMarkerRef.current = term.registerMarker(0) ?? null;
};

/**
 * Wait for the terminal to become idle (no new output for idleMs).
 *
 * Polls the buffer cursor position periodically. When the cursor
 * hasn't moved for idleMs, the terminal is considered idle. Returns
 * when either idle is detected or timeoutMs elapses.
 */
const waitForTerminalIdle = (
  term: Terminal,
  timeoutMs: number,
  idleMs: number,
): Promise<{ idle: boolean; elapsedMs: number }> => {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let lastCursorX = term.buffer.active.cursorX;
    let lastCursorY = term.buffer.active.cursorY;
    let lastChangeTime = Date.now();
    const pollInterval = Math.min(idleMs / 2, 200);

    const check = () => {
      const now = Date.now();
      const elapsed = now - startTime;

      const currentX = term.buffer.active.cursorX;
      const currentY = term.buffer.active.cursorY;
      if (currentX !== lastCursorX || currentY !== lastCursorY) {
        lastCursorX = currentX;
        lastCursorY = currentY;
        lastChangeTime = now;
      }

      if (now - lastChangeTime >= idleMs) {
        resolve({ idle: true, elapsedMs: elapsed });
        return;
      }

      if (elapsed >= timeoutMs) {
        resolve({ idle: false, elapsedMs: elapsed });
        return;
      }

      setTimeout(check, pollInterval);
    };

    setTimeout(check, pollInterval);
  });
};
