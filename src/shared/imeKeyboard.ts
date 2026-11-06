/**
 * 输入法（IME）键盘守卫，桌面渲染层与手机远控页共用。
 *
 * 两重保障，避免 Enter 提交被输入法确认键误触发：
 * 1) 入口调用 installImeKeyboardGuard()：捕获阶段吞掉输入法处理中的 keydown，
 *    组件即便漏判 isComposing 也不会误提交（含表单隐式提交）；
 * 2) 显式提交判断统一用 isSubmitEnter()，不再各处手写 isComposing。
 */

/** compositionend 与随后 keydown 视为同一次按键的最大间隔（人手无法这么快再按一次）。 */
const IME_CONFIRM_GRACE_MS = 40;

/** 兼容 React 合成事件与原生事件的结构化按键类型。 */
export type KeyboardEventLike = {
  key?: string;
  keyCode?: number;
  shiftKey?: boolean;
  isComposing?: boolean;
  target?: EventTarget | null;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
    target?: EventTarget | null;
  } | null;
};

let guardInstalled = false;
/** composition 嵌套计数，失焦时归零防止残留。 */
let compositionDepth = 0;
let lastCompositionEndAt = Number.NEGATIVE_INFINITY;

const nativeOf = (event: KeyboardEventLike): KeyboardEvent | null =>
  event instanceof KeyboardEvent
    ? event
    : ((event.nativeEvent as KeyboardEvent | null | undefined) ?? null);

const readKeyCode = (event: KeyboardEventLike): number =>
  nativeOf(event)?.keyCode ?? event.keyCode ?? 0;

const readIsComposing = (event: KeyboardEventLike): boolean =>
  Boolean(nativeOf(event)?.isComposing ?? event.isComposing);

/** 事件本身是否处于合成中（部分平台只报 keyCode 229）。 */
export const isImeComposing = (event?: KeyboardEventLike): boolean => {
  if (!event) return compositionDepth > 0;
  return readIsComposing(event) || readKeyCode(event) === 229;
};

/** 合成刚结束时的 Enter：isComposing 已为 false，但仍是输入法确认键。 */
const isCompositionConfirmEnter = (event: KeyboardEventLike): boolean => {
  if (performance.now() - lastCompositionEndAt > IME_CONFIRM_GRACE_MS) {
    return false;
  }
  return event.key === "Enter" || readKeyCode(event) === 13;
};

/** keydown 是否属于输入法：组件不应响应。 */
export const isImeManagedKey = (event: KeyboardEventLike): boolean =>
  isImeComposing(event) || isCompositionConfirmEnter(event);

/**
 * 标准 Enter 提交判定：排除输入法确认键，默认排除 Shift+Enter 换行。
 * 例：onKeyDown={(e) => { if (isSubmitEnter(e)) submit(); }}
 */
export const isSubmitEnter = (
  event: KeyboardEventLike,
  options?: { allowShift?: boolean },
): boolean => {
  if (event.key !== "Enter" && readKeyCode(event) !== 13) return false;
  if (!options?.allowShift && event.shiftKey) return false;
  return !isImeManagedKey(event);
};

/** 可编辑载体：合成中的 Enter 需挡住表单隐式提交与换行。 */
const isTextEntryTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA")
    return true;
  return element.isContentEditable === true;
};

/**
 * 安装全局守卫（幂等）。须在应用监听器之前调用，capture 阶段先于 React 事件委托。
 */
export const installImeKeyboardGuard = (): void => {
  if (guardInstalled || typeof window === "undefined") return;
  guardInstalled = true;

  window.addEventListener(
    "compositionstart",
    () => {
      compositionDepth += 1;
    },
    true,
  );

  window.addEventListener(
    "compositionend",
    () => {
      compositionDepth = Math.max(0, compositionDepth - 1);
      lastCompositionEndAt = performance.now();
    },
    true,
  );

  // 失焦可能丢失 compositionend，归零避免后续所有按键被吞。
  window.addEventListener(
    "blur",
    () => {
      compositionDepth = 0;
    },
    true,
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (!isImeComposing(event) && !isCompositionConfirmEnter(event)) return;
      const enter =
        event.key === "Enter" || event.keyCode === 13 || event.keyCode === 229;
      // 只截断组件逻辑，不干扰输入法上屏；Enter 顺带阻止隐式提交。
      event.stopImmediatePropagation();
      if (enter && isTextEntryTarget(event.target)) {
        event.preventDefault();
      }
    },
    true,
  );
};
