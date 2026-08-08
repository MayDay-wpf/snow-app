/**
 * 终端监控 / 日志桥接：跨组件通信（RightPanel 终端面板 ⇄ 主内容区输入框）
 *
 * - 日志订阅：ChatInput 进入「监控终端」模式时订阅指定 tab 的增量日志流；
 *   终端 PTY 输出到达时通过 pushTerminalLines 推送（模块级 Map，无 DOM 事件开销）。
 * - 插入输入框：终端工具栏「添加到输入框」按钮通过 window CustomEvent
 *   将选中日志/全部日志文本发送到当前聊天输入框。
 * - 拖拽监控：终端工具栏拖拽手柄携带 TERMINAL_DRAG_MIME 数据，
 *   输入框 drop 后进入监控模式。
 */

/** 终端 → 输入框：插入文本事件名 */
export const TERMINAL_INSERT_TEXT_EVENT = "snow:terminal-insert-text";

export type TerminalInsertTextPayload = {
  /** 要插入输入框的文本 */
  text: string;
  /** 来源描述（终端工作目录） */
  source: string;
};

/** 终端拖拽数据的 MIME 类型（拖手柄到输入框 = 监控该终端） */
export const TERMINAL_DRAG_MIME = "application/x-snow-terminal";

export type TerminalDragPayload = {
  /** 终端 tab 唯一 id */
  tabId: string;
  /** 终端工作目录 */
  cwd: string;
  /** 终端标题（可选） */
  title?: string;
};

type TerminalMonitorListener = (lines: string[]) => void;

/** 当前被监控的终端 tab：tabId → 监听回调（同一 tab 重复订阅时覆盖） */
const listeners = new Map<string, TerminalMonitorListener>();

/** 开始监控某个终端 tab（由 ChatInput 在进入监控模式时调用） */
export const startTerminalMonitor = (
  tabId: string,
  listener: TerminalMonitorListener
): void => {
  listeners.set(tabId, listener);
};

/** 停止监控（由 ChatInput 在退出监控模式时调用） */
export const stopTerminalMonitor = (tabId: string): void => {
  listeners.delete(tabId);
};

/** 终端侧推送增量日志行给监控方（无监控者时零开销） */
export const pushTerminalLines = (tabId: string, lines: string[]): void => {
  if (lines.length === 0) return;
  const listener = listeners.get(tabId);
  if (listener) {
    listener(lines);
  }
};
