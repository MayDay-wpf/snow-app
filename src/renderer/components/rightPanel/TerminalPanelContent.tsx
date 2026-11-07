import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import {
  ClipboardPaste,
  Copy,
  Eraser,
  FolderInput,
  Keyboard,
  ListChecks,
  Send,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTerminalSettings } from "./useTerminalSettings";
import { useI18n } from "../../i18n";
import { ContextMenu, type ContextMenuItem } from "../common/ContextMenu";
import { requestOpenProjectMcpPanel } from "../mainContent/chatInput/projectMcpNavigation";
import {
  PanelMcpEnableBanner,
  TERMINAL_MCP_SERVER_ID,
} from "./PanelMcpEnableBanner";
import { useTerminalMcpInstance } from "./terminal/useTerminalMcpInstance";
import { detectAwaitingInput } from "./terminal/terminalInputDetector";
import {
  createTerminalFontZoom,
  resolveTerminalFontSize,
} from "./terminal/terminalFontZoom";
import {
  formatTerminalPathInsertion,
  readTerminalDropPaths,
} from "./terminal/terminalPathDrop";
import {
  TERMINAL_INSERT_TEXT_EVENT,
  hasTerminalMonitor,
  pushTerminalLines,
  type TerminalInsertTextPayload,
} from "./terminal/terminalMonitor";

export type TerminalPanelContentProps = {
  tabId: string;
  cwd: string;
  ptyId?: string;
  shellPath?: string;
  sessionId?: string;
  /** 当前项目 id：用于未开启终端控制 MCP 时的横幅提示 */
  projectId?: string;
  isActive: boolean;
  /** 用户点击标签时递增：已激活的终端也需要响应显式回焦请求。 */
  focusRequestId?: number;
  onTitleChange?: (title: string) => void;
  /** 点击终端内的链接时回调（用于打开内置浏览器 tab）。 */
  onOpenLink?: (url: string) => void;
  /** PTY 会话退出时回调（exitCode === 0 视为用户显式 exit）。 */
  onProcessExit?: (exitCode: number) => void;
  /** 迁移携带的屏幕快照：挂载时先写入新 xterm 实例，再接管 PTY 输出。 */
  initialSnapshot?: string;
  /** PTY 会话建立（传入 id）或退出（传入 null）时回调，供父级记录迁移所需的会话。 */
  onPtyChange?: (ptyId: string | null) => void;
};

/**
 * 当前由挂载实例接管（attach）的 PTY。StrictMode 开发模式下 effect 会同步执行
 * cleanup 后立即重跑；接管的会话若在 cleanup 中直接 kill 会被误杀。因此接管会话的
 * kill 延后到微任务再判定：重跑已重新登记则不杀，真正卸载则回收。
 */
const liveAttachedPtyIds = new Set<string>();

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
  // Windows ConPTY 会把 cmd/PowerShell 的默认前景色（属性 fg=7）转写成 SGR 37
  // 「白色」；浅色主题若 white 仍用接近背景的白色，常规输出会完全看不见。
  // 参照 VS Code Light+ 的做法，将 ANSI white 固定为深灰以保证 Windows 下可读。
  white: "#555555",
  brightBlack: "#4F525E",
  brightRed: "#E06C75",
  brightGreen: "#98C379",
  brightYellow: "#E5C07B",
  brightBlue: "#61AFEF",
  brightMagenta: "#C678DD",
  brightCyan: "#56B6C2",
  // 同上：SGR 97（brightWhite）在浅色背景上同样接近不可见，固定为中灰。
  brightWhite: "#a5a5a5",
};

/**
 * 终端画布底色取 CSS 变量 --terminal-bg（tokens.css 按明暗主题给出默认值）。
 * 布局风格（层叠下终端与右侧面板同色）与主题预设因此能统一改写终端底色，
 * 避免终端在面板里显出一块异色区域。变量缺失时回退到主题自带底色。
 */
const resolveTerminalBackground = (
  fallback: string | undefined,
): string | undefined => {
  if (typeof document === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--terminal-bg")
    .trim();
  return value || fallback;
};

const getTerminalTheme = (): ITheme => {
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark";
  const base = isDark ? darkTerminalTheme : lightTerminalTheme;
  return { ...base, background: resolveTerminalBackground(base.background) };
};

// 默认字体栈：优先命中系统里的常见 Nerd Font。Oh My Posh / starship 等提示符
// 依赖 Nerd Font 的私有区图标字形，字体缺失时这些字符只能渲染成方框；未安装
// Nerd Font 时逐级回退到平台自带等宽字体，保证正文可读。用户显式配置
// 终端字体（settings.fontFamily）时以用户配置为准，不走这条默认链。
const DEFAULT_FONT_FAMILY = [
  // 中文场景优先：Maple Mono 系列同时提供 CJK 字形与 Nerd Font 图标。
  "'Maple Mono Normal NF CN'",
  "'Maple Mono NF CN'",
  "'Maple Mono Normal NF'",
  "'Maple Mono NF'",
  // JetBrains Mono 与 Maple Mono 的融合版本，字宽与 JetBrains Mono 保持一致。
  "'JetBrains Maple Mono'",
  "'CaskaydiaCove Nerd Font'",
  "'CaskaydiaCove NF'",
  "'JetBrainsMono Nerd Font'",
  "'JetBrainsMono NF'",
  "'MesloLGS NF'",
  "'FiraCode Nerd Font'",
  "'Hack Nerd Font'",
  // 纯图标字体：只提供 Nerd Font 的符号字形，常与普通等宽字体搭配安装。
  "'Symbols Nerd Font Mono'",
  "'SF Mono'",
  "'Menlo'",
  "'Consolas'",
  "'Liberation Mono'",
  "monospace",
].join(", ");

// 「添加到输入框」浮动按钮：相对鼠标松开点的偏移，以及面板四边的最小留白。
const SEND_BUTTON_OFFSET_X = 12;
const SEND_BUTTON_OFFSET_Y = 18;
const SEND_BUTTON_EDGE_GAP = 8;

// 菜单打开期间忽略的纯修饰键：组合键前半段不收起菜单。
const MODIFIER_ONLY_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
]);

export const TerminalPanelContent = ({
  tabId,
  cwd,
  ptyId: attachedPtyId,
  shellPath: shellPathProp,
  sessionId,
  projectId,
  isActive,
  focusRequestId,
  onTitleChange,
  onOpenLink,
  onProcessExit,
  initialSnapshot,
  onPtyChange,
}: TerminalPanelContentProps): React.JSX.Element => {
  const { t } = useI18n();
  const settings = useTerminalSettings();
  const shellPath = shellPathProp?.trim() || settings.shellPath;
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const handledFocusRequestRef = useRef<number | undefined>(undefined);
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
  /** 当前挂载的 WebGL 渲染 addon（未启用/tab 失活时为 null，回退 DOM 渲染器）。 */
  const webglRef = useRef<WebglAddon | null>(null);
  /** GPU 渲染设置镜像：主 effect 不依赖 settings（避免终端随设置重建），
   *  创建 Terminal 时从这里读取最新值决定是否挂 WebGL addon。 */
  const gpuRenderingRef = useRef(settings.gpuRendering);
  const fontSizeRef = useRef(settings.fontSize);

  // ------------------------------------------------------------------
  // 终端日志流：按行切分后实时推送给监控方（输入框「监控终端」模式）
  // ------------------------------------------------------------------

  /** 终端当前是否有选中文本（驱动 Cursor 式「添加到输入框」浮动按钮） */
  const [hasSelection, setHasSelection] = useState(false);
  /** 选区结束（鼠标左键松开）位置，面板坐标系；null 时按钮用默认右上角位。 */
  const [selectionAnchor, setSelectionAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  /** 浮动按钮最终坐标（面板坐标系，已按面板边界收拢）。 */
  const [sendButtonPos, setSendButtonPos] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const [isPathDragOver, setIsPathDragOver] = useState(false);
  const pathDragOverRef = useRef(false);
  /** 尚未遇到换行的输出残段（跨 data 分片的行拼接） */
  const logDraftRef = useRef("");

  /** 追加一段 PTY 输出：按换行切分，推送增量行给监控方（无监控者时零开销） */
  const appendLog = useCallback(
    (data: string): void => {
      // 没有监控订阅者时不拼接、不切分：重输出场景下这是纯浪费。
      if (!hasTerminalMonitor(tabId)) {
        logDraftRef.current = "";
        return;
      }
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

  const onPtyChangeRef = useRef(onPtyChange);
  useEffect(() => {
    onPtyChangeRef.current = onPtyChange;
  }, [onPtyChange]);

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

  // GPU 渲染设置镜像同步：effect 定义在主 effect 之前，保证主 effect 创建
  // Terminal 时读取到的是最新值。
  useEffect(() => {
    gpuRenderingRef.current = settings.gpuRendering;
  }, [settings.gpuRendering]);

  useEffect(() => {
    fontSizeRef.current = settings.fontSize;
  }, [settings.fontSize]);

  const applyTerminalFontSize = useCallback((fontSize: number): void => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) {
      return;
    }
    term.options.fontSize = fontSize;
    const container = containerRef.current;
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
      return;
    }
  }, []);

  /** 尝试挂载 WebGL2 渲染 addon（GPU 绘制整屏字形，性能远超 DOM 渲染器）。
   *  WebGL 不可用（远程桌面/驱动禁用等）或初始化失败时静默保持 DOM 渲染。 */
  const attachWebgl = useCallback((): void => {
    const term = termRef.current;
    if (!term || webglRef.current) {
      return;
    }
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        // WebGL 上下文丢失（驱动重置/系统睡眠恢复）：卸载 addon，
        // xterm 自动回退 DOM 渲染器并全量重绘，终端保持可用。
        if (webglRef.current === addon) {
          webglRef.current = null;
        }
        try {
          addon.dispose();
        } catch {
          // ignore
        }
      });
      term.loadAddon(addon);
      webglRef.current = addon;
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[terminal] WebGL unavailable, using DOM renderer");
      webglRef.current = null;
    }
  }, []);

  /** 卸载 WebGL addon（关闭设置/tab 失活），回退 DOM 渲染器。 */
  const detachWebgl = useCallback((): void => {
    const addon = webglRef.current;
    if (!addon) {
      return;
    }
    webglRef.current = null;
    try {
      addon.dispose();
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
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

    // 缩放控制器：滚轮距离先累积、再按帧推进字号（逐帧一档，避免整屏跳变）。
    const fontZoom = createTerminalFontZoom(
      () => fontSizeRef.current,
      applyTerminalFontSize,
    );

    // Windows 终端惯例键位：
    // - 有选中文本时 Ctrl+C / Ctrl+Insert / Ctrl+Shift+C = 复制（不发送 \x03）
    // - 无选中文本时 Ctrl+C = 发送中断给 shell（pwsh 7 行为：仅取消当前行）
    // - Ctrl+V / Ctrl+Shift+V / Shift+Insert = 粘贴
    term.attachCustomKeyEventHandler((event) => {
      // xterm invokes this handler for both keydown and keyup; clipboard I/O
      // must run only once per physical shortcut.
      if (event.type !== "keydown") {
        return true;
      }
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

      if (mod && (key === "=" || key === "+")) {
        event.preventDefault();
        fontZoom.zoomBy(1);
        return false;
      }

      if (mod && (key === "-" || key === "_")) {
        event.preventDefault();
        fontZoom.zoomBy(-1);
        return false;
      }

      return true;
    });

    const handleFontZoomWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      fontZoom.handleWheel(event);
    };
    container.addEventListener("wheel", handleFontZoomWheel, {
      capture: true,
      passive: false,
    });

    term.open(container);

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

    // GPU 渲染（默认关闭）：设置开启时为新建的 Terminal 挂 WebGL addon。
    // 终端因 cwd/PTY 变化重建后由此处重新挂载；运行中的开关切换与 tab
    // 激活状态变化由下方独立 effect 处理。
    if (gpuRenderingRef.current && isActive) {
      attachWebgl();
    }

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
    resizeObserver.observe(container);

    const themeObserver = new MutationObserver(() => {
      if (!disposed) {
        term.options.theme = getTerminalTheme();
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      // data-theme 决定明暗配色；主题预设与布局风格会改写 --terminal-bg（终端底色）
      attributeFilter: ["data-theme", "data-theme-preset", "data-layout-style"],
    });

    const initPty = async () => {
      try {
        const cols = term.cols > 0 ? term.cols : 80;
        const rows = term.rows > 0 ? term.rows : 24;
        if (initialSnapshot) {
          // 迁移快照先于 PTY 输出写入：历史在前、实时输出在后。
          term.write(initialSnapshot.replace(/\r?\n/g, "\r\n"));
        }
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
        if (attachedPtyId) {
          // 接管已有会话：同步登记并转移输出通道与回收归属（见 liveAttachedPtyIds）。
          liveAttachedPtyIds.add(id);
          void window.snow.ptyAttach(id);
        }
        ptyIdRef.current = id;
        onPtyChangeRef.current?.(id);

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
            onPtyChangeRef.current?.(null);
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
      container.removeEventListener("wheel", handleFontZoomWheel, {
        capture: true,
      });
      fontZoom.dispose();
      disposeOutput?.();
      disposeExit?.();
      if (ptyIdRef.current) {
        const killedPtyId = ptyIdRef.current;
        ptyIdRef.current = null;
        if (attachedPtyId) {
          liveAttachedPtyIds.delete(killedPtyId);
          queueMicrotask(() => {
            if (!liveAttachedPtyIds.has(killedPtyId)) {
              void window.snow.ptyKill(killedPtyId);
            }
          });
        } else {
          void window.snow.ptyKill(killedPtyId);
        }
      }
      term.dispose();
      // term.dispose() 会连带销毁已挂载的 WebGL addon，这里只需清引用；
      // 终端重建后由主 effect 按当前设置重新挂载。
      webglRef.current = null;
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
    const fontFamily = settings.fontFamily.trim() || DEFAULT_FONT_FAMILY;
    const fontSize = resolveTerminalFontSize(settings.fontSize);
    const fontWeight = settings.fontWeight as "normal" | "bold" | number;
    // 缩放持久化后会带着同一个值再广播一次设置：值没变时跳过，避免多余的
    // 字体测量 / 字形图集重建让缩放过程掉帧。
    if (
      term.options.fontFamily === fontFamily &&
      term.options.fontSize === fontSize &&
      term.options.fontWeight === fontWeight &&
      term.options.lineHeight === settings.lineHeight
    ) {
      return;
    }
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    term.options.fontWeight = fontWeight;
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

  // 标签点击是一次性聚焦请求，不依赖 isActive 翻转，也不改变现有激活/重绘流程。
  useEffect(() => {
    if (
      focusRequestId === undefined ||
      focusRequestId === handledFocusRequestRef.current
    ) {
      return;
    }
    handledFocusRequestRef.current = focusRequestId;
    const term = termRef.current;
    const container = containerRef.current;
    if (
      !isActive ||
      !term ||
      !container?.isConnected ||
      container.clientWidth === 0 ||
      container.clientHeight === 0
    ) {
      return;
    }
    term.focus();
  }, [focusRequestId, isActive]);

  // GPU 渲染状态同步：设置开启且当前 tab 激活时挂载 WebGL 渲染器；
  // 关闭或 tab 失活时卸载释放 GPU 资源。非激活 tab 容器为 display:none
  // 无需渲染，多终端场景下同时最多保留一个 WebGL 上下文，避免上下文
  // 数量与显存占用随 tab 数量膨胀（Chromium 对单页 WebGL 上下文数有上限）。
  useEffect(() => {
    if (settings.gpuRendering && isActive) {
      attachWebgl();
    } else {
      detachWebgl();
    }
  }, [settings.gpuRendering, isActive, attachWebgl, detachWebgl]);

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

  // 菜单打开期间的退出规则：
  // - Esc：关闭菜单并拦住该键，避免送进 shell；
  // - 其他按键：关闭菜单，但按键照常进入终端（方向键/字符/回车都不接管）；
  // - 单独按修饰键、输入法组字中：忽略，避免组合键前半段或中文输入误关；
  // - 滚轮：关闭菜单，滚动本身仍由终端处理。
  // xterm 在输入区阻止事件冒泡，所以键盘监听必须放在捕获阶段。
  const contextMenuOpen = contextMenu !== null;
  useEffect(() => {
    if (!contextMenuOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu(null);
        return;
      }
      if (MODIFIER_ONLY_KEYS.has(event.key)) {
        return;
      }
      // 只收起浮层，不接管按键。
      setContextMenu(null);
    };
    const handleWheel = (): void => {
      // 菜单里没有可滚动内容，滚轮说明用户已回到终端，直接收起。
      setContextMenu(null);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, [contextMenuOpen]);

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

  // 浮动按钮跟随鼠标落点：拖拽选择/双击选词结束后记录左键松开处的位置
  // （面板坐标系），按钮据此定位，而不是固定停在右上角。
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const handleMouseUp = (event: MouseEvent): void => {
      if (event.button !== 0) {
        return;
      }
      const rect = panel.getBoundingClientRect();
      setSelectionAnchor({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, []);

  // 按面板边界收拢按钮坐标，避免鼠标落点靠近右/下边缘时按钮溢出被裁掉；
  // 在布局阶段测量真实尺寸，绘制前定位完成，不会出现先出角再跳动。
  useLayoutEffect(() => {
    if (!hasSelection || !selectionAnchor) {
      setSendButtonPos(null);
      return;
    }
    const panel = panelRef.current;
    const button = sendButtonRef.current;
    if (!panel || !button) {
      return;
    }
    const maxLeft = Math.max(
      SEND_BUTTON_EDGE_GAP,
      panel.clientWidth - button.offsetWidth - SEND_BUTTON_EDGE_GAP,
    );
    const maxTop = Math.max(
      SEND_BUTTON_EDGE_GAP,
      panel.clientHeight - button.offsetHeight - SEND_BUTTON_EDGE_GAP,
    );
    const left = Math.min(
      Math.max(selectionAnchor.x + SEND_BUTTON_OFFSET_X, SEND_BUTTON_EDGE_GAP),
      maxLeft,
    );
    const top = Math.min(
      Math.max(selectionAnchor.y + SEND_BUTTON_OFFSET_Y, SEND_BUTTON_EDGE_GAP),
      maxTop,
    );
    setSendButtonPos((prev) =>
      prev && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [hasSelection, selectionAnchor]);

  const runMenuAction = useCallback((action: () => void): void => {
    setContextMenu(null);
    action();
    // 仅菜单动作同步回焦；外部点击关闭和剪贴板异步返回均不抢回焦点。
    termRef.current?.focus();
  }, []);

  const buildMenuItems = (): ContextMenuItem[] => {
    const term = termRef.current;
    const items: ContextMenuItem[] = [];
    if (term?.hasSelection()) {
      items.push({
        id: "copy",
        label: t("common.copy"),
        icon: <Copy size={13} strokeWidth={1.8} />,
        onClick: () => runMenuAction(copySelection),
      });
    }
    items.push({
      id: "paste",
      label: t("common.paste"),
      icon: <ClipboardPaste size={13} strokeWidth={1.8} />,
      onClick: () => runMenuAction(pasteClipboard),
    });
    items.push({
      id: "select-all",
      label: t("common.selectAll"),
      icon: <ListChecks size={13} strokeWidth={1.8} />,
      onClick: () => runMenuAction(() => termRef.current?.selectAll()),
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

  const handlePathDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      const types = event.dataTransfer.types;
      if (!types.includes("application/json") && !types.includes("Files")) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!pathDragOverRef.current) {
        pathDragOverRef.current = true;
        setIsPathDragOver(true);
      }
    },
    [],
  );

  const handlePathDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      pathDragOverRef.current = false;
      setIsPathDragOver(false);
    },
    [],
  );

  const handlePathDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      pathDragOverRef.current = false;
      setIsPathDragOver(false);
      void readTerminalDropPaths(event.dataTransfer).then((paths) => {
        const term = termRef.current;
        if (!term || paths.length === 0) {
          return;
        }
        term.paste(formatTerminalPathInsertion(paths, shellPath));
        term.focus();
      });
    },
    [shellPath],
  );

  return (
    <div ref={panelRef} className="terminal-panel">
      <PanelMcpEnableBanner
        active={isActive}
        messageKey="panelMcpGate.terminalMessage"
        onOpenMcpPanel={requestOpenProjectMcpPanel}
        projectId={projectId}
        serverId={TERMINAL_MCP_SERVER_ID}
      />
      {/* Cursor 式：选中终端文本后在鼠标落点附近浮动「添加到输入框」按钮 */}
      {hasSelection ? (
        <button
          ref={sendButtonRef}
          type="button"
          className="terminal-toolbar-send"
          style={
            sendButtonPos
              ? {
                  left: sendButtonPos.left,
                  top: sendButtonPos.top,
                  right: "auto",
                }
              : undefined
          }
          onClick={insertToComposer}
          title={t("terminal.addSelectionToInput")}
        >
          <Send size={12} strokeWidth={2} aria-hidden="true" />
          {t("terminal.addToInput")}
        </button>
      ) : null}
      <div
        ref={containerRef}
        className="terminal-container"
        onDragOver={handlePathDragOver}
        onDragLeave={handlePathDragLeave}
        onDrop={handlePathDrop}
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
      {isPathDragOver ? (
        <div className="terminal-drop-overlay" aria-hidden="true">
          <FolderInput size={13} strokeWidth={1.8} />
          {t("terminal.dropToInsertPath")}
        </div>
      ) : null}
      {/* 终端等待输入提示条：程序/shell 正在等待用户输入时显示，
          明确告知用户当前状态，避免误以为 Agent 卡住。 */}
      {awaitingInput ? (
        <div className="terminal-waiting-banner" role="status">
          <span className="terminal-waiting-dot" aria-hidden="true" />
          <Keyboard size={12} strokeWidth={1.8} aria-hidden="true" />
          <span className="terminal-waiting-label">
            {t("terminal.awaitingInput")}
          </span>
          <code className="terminal-waiting-hint">{awaitingInput}</code>
        </div>
      ) : null}
      {contextMenu && (
        <ContextMenu
          ariaLabel={t("rightPanel.terminalTab")}
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems()}
          footerItems={[
            {
              id: "clear",
              label: t("terminal.contextMenu.clear"),
              icon: <Eraser size={13} strokeWidth={1.8} />,
              onClick: () => runMenuAction(clearScreen),
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
