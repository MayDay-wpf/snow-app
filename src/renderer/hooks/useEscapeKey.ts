import { useEffect, useRef } from "react";

/**
 * 统一的 ESC 关闭层级栈 Hook。
 *
 * 解决的问题：项目内 Modal / ConfirmDialog / FormDialog 等弹窗此前各自
 * 监听 Escape，行为不一致（部分仅焦点位于浮层内才生效），且会与全局
 * 快捷键引擎（useKeyboardShortcuts 把 Escape 绑定到 cancelSession）
 * 冲突——按 Esc 关弹窗的同时误中断正在运行的会话。
 *
 * 层级栈语义：
 * 1. 弹窗/浮层组件在「打开」期间调用本 hook，即向模块级注册栈压入一个
 *    ESC 层；关闭（enabled=false）或组件卸载时自动注销。
 * 2. 按 ESC 时从栈顶（最后注册）向下分派：跳过 enabled=false 的层
 *    （视为不存在）；找到的第一个激活层若 gate() 返回 true 则消费
 *    本次 ESC 并执行其 onEscape；若 gate() 返回 false 则本次 ESC
 *    无动作——既不关闭该层，也不向下传递（避免误关被它遮挡的下层）。
 * 3. 消费时会 preventDefault + stopPropagation + stopImmediatePropagation，
 *    避免同一按键同时关闭多层或触发 document 上的其他处理器。
 *
 * 与 useKeyboardShortcuts 引擎的协调（重要）：
 * - 本 hook 的 document 捕获阶段监听器可能在引擎监听器之后注册
 *   （同为 document capture，按注册顺序先后触发），此时引擎先收到
 *   事件，仅靠 stopPropagation/stopImmediatePropagation 拦不住它。
 * - 因此引擎侧额外通过 hasActiveEscapeLayers() 查询：只要有任意
 *   ESC 层打开（enabled），引擎对 cancelSession 动作直接跳过。
 * - 本文件不反向 import useKeyboardShortcuts，依赖保持单向
 *   （useKeyboardShortcuts -> useEscapeKey）。
 *
 * 监听策略：
 * - 栈为空时不挂监听；首个层注册时在 document 上以 capture 挂
 *   keydown，最后一个层注销时移除，空闲时零监听开销。
 * - onEscape / enabled / gate 通过 ref 持有最新值，回调变化不会
 *   触发重新注册，也不会产生闭包过期问题。
 *
 * IME 防护：与引擎一致，isComposing 或 keyCode === 229（部分平台
 * 输入法组合过程）的 Esc 属于输入法操作，不消费、不关闭浮层。
 *
 * 用法示例：
 * ```tsx
 * // 普通弹窗：打开期间注册，关闭即注销
 * useEscapeKey({ onEscape: () => setOpen(false), enabled: open });
 *
 * // ConfirmDialog：确认动作进行中不响应 Esc
 * useEscapeKey({
 *   onEscape: () => onCancel(),
 *   enabled: open,
 *   gate: () => !isConfirming,
 * });
 * ```
 */

/** 单个 ESC 层在注册栈中的条目：统一以 getter 形式持有，事件触发时读取最新值。 */
interface EscapeLayerEntry {
  /** 层是否激活；false 时该层等同未注册，分派时直接跳过。 */
  readonly isEnabled: () => boolean;
  /** 额外放行条件；栈顶激活层返回 false 时本次 ESC 无动作（不向下传递）。 */
  readonly gate: () => boolean;
  /** 本层消费 ESC 时执行的回调。 */
  readonly onEscape: () => void;
}

/** 模块级注册栈：数组末尾为最后注册的层（栈顶），ESC 由栈顶优先消费。 */
const escapeLayerStack: EscapeLayerEntry[] = [];

/** document 捕获阶段 keydown 监听器；仅在栈非空期间存在。 */
let documentListener: ((event: KeyboardEvent) => void) | null = null;

/** 全局 keydown 处理：从栈顶向下分派 ESC。 */
const handleEscapeKeyDown = (event: KeyboardEvent): void => {
  // IME 组合输入期间（候选中，部分平台 keyCode 229）的 Esc 属于输入法
  // 操作，不消费，交由输入法自行处理（如取消候选）。
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  for (let i = escapeLayerStack.length - 1; i >= 0; i -= 1) {
    const layer = escapeLayerStack[i];
    if (!layer) continue;

    // enabled=false 的层视为不存在（等同注销），继续向下查找真实顶层
    if (!layer.isEnabled()) continue;

    // 最顶层拒绝响应（gate=false）：本次 ESC 无动作，也不向下传递，
    // 避免误关被当前浮层遮挡的下层（如确认中误关背后的 Modal）。
    if (!layer.gate()) return;

    // 消费事件：阻止默认行为并阻断后续传播（含同元素上后注册的监听器），
    // 防止同一按键同时关闭多层或触发其他处理器。
    // 注意：若本监听器注册晚于引擎监听器，此处已拦不住引擎——引擎侧
    // 另有 hasActiveEscapeLayers() 兜底（见文件头说明）。
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    layer.onEscape();
    return;
  }
};

/** 确保全局监听器已挂载（首个层注册时调用，幂等）。 */
const ensureDocumentListener = (): void => {
  if (documentListener === null) {
    documentListener = handleEscapeKeyDown;
    document.addEventListener("keydown", documentListener, true);
  }
};

/** 栈已空时移除全局监听器（最后一个层注销后调用，空闲时零监听）。 */
const releaseDocumentListenerIfIdle = (): void => {
  if (escapeLayerStack.length === 0 && documentListener !== null) {
    document.removeEventListener("keydown", documentListener, true);
    documentListener = null;
  }
};

/**
 * 查询当前是否存在任何激活（enabled）的 ESC 层。
 *
 * 供 useKeyboardShortcuts 引擎调用：只要有浮层打开（即使其 gate 暂时
 * 拒绝响应），ESC 语义上属于「浮层上下文」，引擎应跳过 cancelSession，
 * 避免按 Esc 误中断正在运行的会话。注意 gate 不影响本结果——
 * 「浮层是否打开」与「浮层此刻是否愿意响应」是两回事。
 */
export function hasActiveEscapeLayers(): boolean {
  return escapeLayerStack.some((layer) => layer.isEnabled());
}

export interface UseEscapeKeyOptions {
  /** ESC 被本层消费时执行（通常是关闭当前弹窗）。 */
  onEscape: () => void;
  /**
   * 本层是否激活。false 时等同未注册（分派跳过、不计入
   * hasActiveEscapeLayers）。默认 true。
   */
  enabled?: boolean;
  /**
   * 额外放行条件：本层为有效顶层时，gate() 返回 true 才消费 ESC；
   * 返回 false 时本次 ESC 无动作（不执行 onEscape，也不传递给下层）。
   * 典型用法：ConfirmDialog 传入 () => !isConfirming，确认进行中禁止
   * Esc 关闭。不传则视为始终放行。
   */
  gate?: () => boolean;
}

/**
 * 将当前组件注册为一个 ESC 层（层级栈）。
 *
 * 组件在「打开」期间调用；enabled=false 或组件卸载时自动注销。
 * onEscape / gate / enabled 变化通过 ref 同步，不触发重新注册。
 */
export function useEscapeKey(options: UseEscapeKeyOptions): void {
  const { onEscape, enabled = true, gate } = options;

  // ref 持有最新回调/条件：事件触发时读取，避免闭包过期与频繁重挂。
  const onEscapeRef = useRef(onEscape);
  const enabledRef = useRef(enabled);
  const gateRef = useRef(gate);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    gateRef.current = gate;
  }, [gate]);

  useEffect(() => {
    const layer: EscapeLayerEntry = {
      isEnabled: () => enabledRef.current,
      gate: () => gateRef.current?.() ?? true,
      onEscape: () => onEscapeRef.current(),
    };

    escapeLayerStack.push(layer);
    ensureDocumentListener();

    return () => {
      const index = escapeLayerStack.indexOf(layer);
      if (index !== -1) {
        escapeLayerStack.splice(index, 1);
      }
      releaseDocumentListenerIfIdle();
    };
  }, []);
}
