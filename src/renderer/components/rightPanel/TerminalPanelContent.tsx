import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import {
  ClipboardPaste,
  Copy,
  Eraser,
  Keyboard,
  ListChecks,
  Send,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTerminalSettings } from "./useTerminalSettings";
import { ContextMenu, type ContextMenuItem } from "../common/ContextMenu";
import { useTerminalMcpInstance } from "./terminal/useTerminalMcpInstance";
import { detectAwaitingInput } from "./terminal/terminalInputDetector";
import {
  TERMINAL_INSERT_TEXT_EVENT,
  pushTerminalLines,
  type TerminalInsertTextPayload,
} from "./terminal/terminalMonitor";

export type TerminalPanelContentProps = {
  tabId: string;
  cwd: string;
  ptyId?: string;
  shellPath?: string;
  sessionId?: string;
  isActive: boolean;
  onTitleChange?: (title: string) => void;
  /** 点击终端内的链接时回调（用于打开内置浏览器 tab）。 */
  onOpenLink?: (url: string) => void;
  /** PTY 会话退出时回调（exitCode === 0 视为用户显式 exit）。 */
  onProcessExit?: (exitCode: number) => void;
};

// 深色主题 ANSI 16 色：Windows Terminal 默认 (Campbell) 配色，
// 保证 git diff / ls --color / 各类 CLI 输出在终端里可读。
const darkTerminalTheme: ITheme = {
  background: "#0E0E0E",
  foreground: "#e0e0e0",
  cursor: "#e0e0e0",
  selectionBackground: "rgba(255, 255, 255, 0.18)",
  black: "#0C0C0C",
  red: "#C50F1F",
  green: "#13A10E",
  yellow: "#C19C00",
  blue: "#0037DA",
  magenta: "#881798",
  cyan: "#3A96DD",
  white: "#CCCCCC",
  brightBlack: "#767676",
  brightRed: "#E74856",
  brightGreen: "#16C60C",
  brightYellow: "#F9F1A5",
  brightBlue: "#3B78FF",
  brightMagenta: "#B4009E",
  brightCyan: "#61D6D6",
  brightWhite: "#F2F2F2",
};

// 浅色主题 ANSI 16 色：One Half Light 配色，浅底上红/绿对比足够清晰。
const lightTerminalTheme: ITheme = {
  background: "#FBFCFD",
  foreground: "#333333",
  cursor: "#333333",
  selectionBackground: "rgba(0, 0, 0, 0.12)",
  black: "#383A42",
  red: "#E45649",
  green: "#50A14F",
  yellow: "#C18401",
  blue: "#0184BC",
  magenta: "#A626A4",
  cyan: "#0997B3",
  white: "#FAFAFA",
  brightBlack: "#4F525E",
  brightRed: "#E06C75",
  brightGreen: "#98C379",
  brightYellow: "#E5C07B",
  brightBlue: "#61AFEF",
  brightMagenta: "#C678DD",
  brightCyan: "#56B6C2",
  brightWhite: "#FFFFFF",
};

const getTerminalTheme = (): ITheme => {
  if (
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark"
  ) {
    return darkTerminalTheme;
  }
  return lightTerminalTheme;
};

const DEFAULT_FONT_FAMILY =
  "'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', monospace";

export const TerminalPanelContent = ({
  tabId,
  cwd,
  ptyId: attachedPtyId,
  shellPath: shellPathProp,
  sessionId,
  isActive,
  onTitleChange,
  onOpenLink,
  onProcessExit,
}: TerminalPanelContentProps): React.JSX.Element => {
  const settings = useTerminalSettings();
  const shellPath = shellPathProp?.trim() || settings.shellPath;
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  /** 终端当前等待输入时屏幕上的提示文本（null = 无等待输入提示） */
  const [awaitingInput, setAwaitingInput] = useState<string | null>(null);
  /** 等待输入检测的防抖 timer(输出停止片刻后才判定,避免刷屏闪烁) */
  const awaitingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** PTY resize 通知的尾沿防抖 timer(动画/拖拽期间的连续 resize 只发最终值) */
  const ptyResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ------------------------------------------------------------------
  // 终端日志流：按行切分后实时推送给监控方（输入框「监控终端」模式）
  // ------------------------------------------------------------------

  /** 终端当前是否有选中文本（驱动 Cursor 式「添加到输入框」浮动按钮） */
  const [hasSelection, setHasSelection] = useState(false);
  /** 尚未遇到换行的输出残段（跨 data 分片的行拼接） */
  const logDraftRef = useRef("");

  /** 追加一段 PTY 输出：按换行切分，推送增量行给监控方（无监控者时零开销） */
  const appendLog = useCallback(
    (data: string): void => {
      const merged = logDraftRef.current + data;
      const parts = merged.split("\n");
      logDraftRef.current = parts.pop() ?? "";
      const newLines: string[] = [];
      for (const part of parts) {
        // \r\n 拆行后行尾残留 \r，去掉避免日志里出现孤立回车
        newLines.push(part.replace(/\r$/, ""));
      }
      pushTerminalLines(tabId, newLines);
    },
    [tabId],
  );

  // onOpenLink 存 ref：避免父组件每次渲染产生新引用导致 PTY 重建。
  const onOpenLinkRef = useRef(onOpenLink);
  useEffect(() => {
    onOpenLinkRef.current = onOpenLink;
  }, [onOpenLink]);

  const onProcessExitRef = useRef(onProcessExit);
  useEffect(() => {
    onProcessExitRef.current = onProcessExit;
  }, [onProcessExit]);

  /** 复制终端选中文本（剪贴板走主进程 IPC，渲染进程无权限限制）。 */
  const copySelection = useCallback((): void => {
    const term = termRef.current;
    if (!term?.hasSelection()) {
      return;
    }
    const text = term.getSelection();
    if (text) {
      void window.snow.writeClipboardText(text).catch(() => {
        // 写入失败时静默忽略。
      });
      // Windows Terminal 惯例：复制后清除选中。
      term.clearSelection();
    }
  }, []);

  /** 从剪贴板粘贴到终端（term.paste 正确处理 bracketed paste）。 */
  const pasteClipboard = useCallback((): void => {
    void window.snow
      .readClipboardText()
      .then((text) => {
        if (text) {
          termRef.current?.paste(text);
        }
      })
      .catch(() => {
        // 剪贴板读取失败时静默忽略。
      });
  }, []);

  // Register this terminal tab with the MCP controller so that
  // terminal-send/read/resize/wait commands can reach it.
  useTerminalMcpInstance(tabId, cwd, isActive, termRef, ptyIdRef);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let disposeOutput: (() => void) | null = null;
    let disposeExit: (() => void) | null = null;
    let exited = false;

    const fontFamily = settings.fontFamily.trim() || DEFAULT_FONT_FAMILY;

    const term = new Terminal({
      fontFamily,
      fontSize: settings.fontSize,
      fontWeight: settings.fontWeight as "normal" | "bold" | number,
      lineHeight: settings.lineHeight,
      cursorBlink: true,
      theme: getTerminalTheme(),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    // 终端链接：点击时打开内置浏览器 tab。
    const webLinks = new WebLinksAddon((_event, uri) => {
      onOpenLinkRef.current?.(uri);
    });
    term.loadAddon(webLinks);

    // Windows 终端惯例键位：
    // - 有选中文本时 Ctrl+C / Ctrl+Insert / Ctrl+Shift+C = 复制（不发送 \x03）
    // - 无选中文本时 Ctrl+C = 发送中断给 shell（pwsh 7 行为：仅取消当前行）
    // - Ctrl+V / Ctrl+Shift+V / Shift+Insert = 粘贴
    term.attachCustomKeyEventHandler((event) => {
      const current = termRef.current;
      if (!current) {
        return true;
      }
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (mod && (key === "c" || key === "insert")) {
        if (current.hasSelection()) {
          copySelection();
          event.preventDefault();
          return false;
        }
        // 无选中时：仅放行 Ctrl+C（中断交给 shell），
        // Ctrl+Shift+C / Ctrl+Insert 无选中则直接忽略。
        return key === "c" && !event.shiftKey;
      }

      if ((mod && key === "v") || (event.shiftKey && key === "insert")) {
        event.preventDefault();
        pasteClipboard();
        return false;
      }

      return true;
    });

    term.open(containerRef.current);

    // Cursor 式交互：选中文本后浮动显示「添加到输入框」按钮；
    // 选区变化（选择/清除/点击）都会触发，布尔 state 重复值自动跳过渲染。
    // 空缓冲区全选时 hasSelection() 可能为 true 但无实际文本，需过滤。
    term.onSelectionChange(() => {
      if (!disposed) {
        setHasSelection(term.hasSelection() && term.getSelection().length > 0);
      }
    });

    // Synchronously fit so PTY is created with correct cols/rows.
    // Without this, initPty() reads default 80x24 dimensions, the PTY
    // starts with wrong size, and the subsequent resize causes zsh to
    // emit PROMPT_EOL_MARK (%) at the end of the prompt line.
    try {
      fit.fit();
    } catch {
      // ignore
    }

    if (disposed) {
      term.dispose();
      return;
    }

    termRef.current = term;
    fitRef.current = fit;

    resizeObserver = new ResizeObserver(() => {
      if (disposed) {
        return;
      }
      const container = containerRef.current;
      // 容器不可见(display:none 的非激活 tab、width:0 的折叠面板、宽度
      // 过渡动画的中间态)时 fit 会算出 2 列之类的极小合法尺寸并 resize
      // PTY,触发 ConPTY 破坏性全屏重绘——隐藏期间冻结 fit,恢复激活时
      // 由 isActive effect 统一按真实尺寸修正。
      if (
        !container ||
        container.clientWidth === 0 ||
        container.clientHeight === 0
      ) {
        return;
      }
      try {
        fit.fit();
      } catch {
        // ignore
      }
    });
    resizeObserver.observe(containerRef.current);

    const themeObserver = new MutationObserver(() => {
      if (!disposed) {
        term.options.theme = getTerminalTheme();
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const initPty = async () => {
      try {
        const cols = term.cols > 0 ? term.cols : 80;
        const rows = term.rows > 0 ? term.rows : 24;
        const id =
          attachedPtyId ??
          (await window.snow.ptyCreate({
            cwd,
            cols,
            rows,
            shellPath: shellPath || undefined,
            sessionId,
          }));
        if (disposed) {
          void window.snow.ptyKill(id);
          return;
        }
        ptyIdRef.current = id;

        disposeOutput = window.snow.onPtyOutput((payload) => {
          if (payload.id === id && !disposed) {
            term.write(payload.data);
            appendLog(payload.data);
            // 防抖检测"等待输入"：输出停止约 250ms 后按屏幕最后一行判定，
            // 避免长输出刷屏时提示条反复闪烁。
            if (awaitingTimerRef.current) {
              clearTimeout(awaitingTimerRef.current);
            }
            awaitingTimerRef.current = setTimeout(() => {
              if (disposed) {
                return;
              }
              const { awaiting, hint } = detectAwaitingInput(term);
              setAwaitingInput(awaiting ? hint : null);
            }, 250);
          }
        });

        disposeExit = window.snow.onPtyExit((payload) => {
          if (payload.id === id && !disposed) {
            exited = true;
            term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
            setAwaitingInput(null);
            onProcessExitRef.current?.(payload.exitCode);
            disposeOutput?.();
            disposeExit?.();
          }
        });

        term.onData((data) => {
          if (!exited && ptyIdRef.current) {
            void window.snow.ptyWrite(id, data);
          }
        });

        // PTY resize 尾沿防抖:面板宽度过渡动画 / 拖拽分割条期间 fit 每帧
        // 触发,连续 resize 会令 ConPTY 每次都全屏重绘,重绘与正在输出的
        // 内容交错造成行重叠;只在尺寸停止变化后发送最终值。
        term.onResize(({ cols, rows }) => {
          if (exited || !ptyIdRef.current) {
            return;
          }
          if (ptyResizeTimerRef.current) {
            clearTimeout(ptyResizeTimerRef.current);
          }
          ptyResizeTimerRef.current = setTimeout(() => {
            ptyResizeTimerRef.current = null;
            if (!disposed && !exited && ptyIdRef.current === id) {
              void window.snow.ptyResize(id, cols, rows);
            }
          }, 120);
        });

        term.onTitleChange((title) => {
          if (!disposed && onTitleChange) {
            onTitleChange(title);
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 将启动失败原因直接写入终端，替代仅 console 输出——用户与智能体
        // 都能看到"传参无效"之类的明确错误，而不是空白终端。
        term.write(
          `\r\n\x1b[91m[Terminal failed to start: ${message}]\x1b[0m\r\n`,
        );
        // eslint-disable-next-line no-console
        console.error("Failed to initialize PTY:", err);
      }
    };

    void initPty();

    cleanupRef.current = () => {
      disposed = true;
      if (awaitingTimerRef.current) {
        clearTimeout(awaitingTimerRef.current);
        awaitingTimerRef.current = null;
      }
      if (ptyResizeTimerRef.current) {
        clearTimeout(ptyResizeTimerRef.current);
        ptyResizeTimerRef.current = null;
      }
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      disposeOutput?.();
      disposeExit?.();
      if (ptyIdRef.current) {
        void window.snow.ptyKill(ptyIdRef.current);
        ptyIdRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachedPtyId, cwd, shellPath, sessionId]);

  // Live-update font settings without recreating the terminal / PTY.
  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.options.fontFamily = settings.fontFamily.trim() || DEFAULT_FONT_FAMILY;
    term.options.fontSize = settings.fontSize;
    term.options.fontWeight = settings.fontWeight as "normal" | "bold" | number;
    term.options.lineHeight = settings.lineHeight;
    const container = containerRef.current;
    // 终端不可见(非激活 tab / 折叠面板)时跳过 fit——极小尺寸会触发
    // ConPTY 破坏性重绘;重新激活时 isActive effect 会按新字体重新 fit。
    if (
      !container ||
      container.clientWidth === 0 ||
      container.clientHeight === 0
    ) {
      return;
    }
    try {
      fitRef.current?.fit();
    } catch {
      // ignore
    }
  }, [
    settings.fontFamily,
    settings.fontSize,
    settings.fontWeight,
    settings.lineHeight,
  ]);

  useEffect(() => {
    if (!isActive || !termRef.current || !fitRef.current) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      try {
        const term = termRef.current;
        const fit = fitRef.current;
        if (!term || !fit) {
          return;
        }
        const prevCols = term.cols;
        const prevRows = term.rows;
        fit.fit();
        // 隐藏期间渲染器处于陈旧状态(fit 被冻结、渲染暂停),尺寸未变时
        // onResize 不会触发,这里强制重绘可见区,修复切回 tab 后的
        // 内容残留/重叠;尺寸变化时 term.resize 内部会全量重绘。
        if (term.cols === prevCols && term.rows === prevRows) {
          term.refresh(0, term.rows - 1);
        }
        term.focus();
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive]);

  // 右键菜单：弹出复制 / 粘贴 / 全选 / 清屏（剪贴板走主进程 IPC，
  // 规避渲染进程 navigator.clipboard 的 clipboard-read 权限限制）。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      setContextMenu({ x: event.clientX, y: event.clientY });
    };
    container.addEventListener("contextmenu", handleContextMenu);
    return () =>
      container.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  // 点击终端面板以外的任意位置时隐藏「添加到输入框」浮动按钮：
  // 与终端是否持有焦点无关，只要鼠标落在面板外就收起，避免按钮残留。
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const handlePointerDown = (event: MouseEvent): void => {
      if (!panel.contains(event.target as Node)) {
        setHasSelection(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown, true);
    return () =>
      document.removeEventListener("mousedown", handlePointerDown, true);
  }, []);

  const buildMenuItems = (): ContextMenuItem[] => {
    const term = termRef.current;
    const items: ContextMenuItem[] = [];
    if (term?.hasSelection()) {
      items.push({
        id: "copy",
        label: "复制",
        icon: <Copy size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          copySelection();
        },
      });
    }
    items.push({
      id: "paste",
      label: "粘贴",
      icon: <ClipboardPaste size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        pasteClipboard();
      },
    });
    items.push({
      id: "select-all",
      label: "全选",
      icon: <ListChecks size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        termRef.current?.selectAll();
      },
    });
    return items;
  };

  /** 清屏（右键菜单用） */
  const clearScreen = useCallback((): void => {
    termRef.current?.clear();
  }, []);

  /**
   * 将选中的终端文本添加到聊天输入框：
   * 浮动按钮仅在终端有选中文本时出现，因此这里只处理选中内容；
   * 输入框侧会把日志编码为 text-snippet 小组件（chip），避免大段文本铺开。
   */
  const insertToComposer = useCallback((): void => {
    const term = termRef.current;
    if (!term?.hasSelection()) {
      return;
    }
    const text = term.getSelection();
    if (!text) {
      return;
    }
    const payload: TerminalInsertTextPayload = { text, source: cwd };
    window.dispatchEvent(
      new CustomEvent(TERMINAL_INSERT_TEXT_EVENT, { detail: payload }),
    );
    // 插入后清除选区（按钮随之隐藏），与复制行为保持一致的交互惯例
    term.clearSelection();
  }, [cwd]);

  return (
    <div ref={panelRef} className="terminal-panel">
      {/* Cursor 式：选中终端文本后浮动「添加到输入框」按钮 */}
      {hasSelection ? (
        <button
          type="button"
          className="terminal-toolbar-send"
          onClick={insertToComposer}
          title="将选中的日志添加到输入框"
        >
          <Send size={12} strokeWidth={2} aria-hidden="true" />
          添加到输入框
        </button>
      ) : null}
      <div
        ref={containerRef}
        className="terminal-container"
        onMouseDown={(event) => {
          // xterm 在点击空白区域清除选区时不一定触发 onSelectionChange，
          // 先清理按钮状态，拖拽选择后再由 onSelectionChange 显示按钮。
          if (event.button === 0) {
            setHasSelection(false);
          }
        }}
        style={{
          width: "100%",
          height: "100%",
          minHeight: "200px",
        }}
      />
      {/* 终端等待输入提示条：程序/shell 正在等待用户输入时显示，
          明确告知用户当前状态，避免误以为 Agent 卡住。 */}
      {awaitingInput ? (
        <div className="terminal-waiting-banner" role="status">
          <span className="terminal-waiting-dot" aria-hidden="true" />
          <Keyboard size={12} strokeWidth={1.8} aria-hidden="true" />
          <span className="terminal-waiting-label">终端等待输入</span>
          <code className="terminal-waiting-hint">{awaitingInput}</code>
        </div>
      ) : null}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems()}
          footerItems={[
            {
              id: "clear",
              label: "清屏",
              icon: <Eraser size={13} strokeWidth={1.8} />,
              onClick: () => {
                setContextMenu(null);
                clearScreen();
              },
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
