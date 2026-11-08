import { DragGesture } from "@use-gesture/vanilla";
import { animate, type AnimationPlaybackControls } from "motion";

/** 翻页方向：1 为下一页（手指向左滑），-1 为上一页（手指向右滑）。 */
export type SwipeStep = 1 | -1;

export type SwipePagerOptions = {
  /** 手势承载节点，包住当前页与预览页。 */
  track: HTMLElement;
  /** 当前页，会随手指横向平移。 */
  page: HTMLElement;
  /** 相邻页预览节点，仅在滑动过程中显示。 */
  peek: HTMLElement;
  /** 纵向滚动容器，切换完成时平滑回到顶部。 */
  scroller: HTMLElement;
  /** 返回 false 时不响应滑动（例如差异视图打开时）。 */
  enabled: () => boolean;
  /** 指定方向相邻页的 HTML；返回 null 表示该方向没有页面，只做边缘阻尼回弹。 */
  renderNeighbour: (step: SwipeStep) => string | null;
  /** 切换动画到位后调用：由调用方更新状态并重绘当前页。 */
  onCommit: (step: SwipeStep) => void;
};

export type SwipePager = {
  /** 以动画切换到相邻页（用于点击 Tab）。 */
  go: (step: SwipeStep) => void;
  /** 立即终止手势与动画并复位。 */
  reset: () => void;
};

/** 拖动距离超过轨道宽度的该比例即视为切换。 */
const COMMIT_RATIO = 0.3;
/** 快速甩动的速度阈值（px/ms）与最小位移，同时满足即切换。 */
const FLING_SPEED = 0.4;
const FLING_MIN_DISTANCE = 16;
/** 没有相邻页时的拖动阻尼系数。 */
const EDGE_RESISTANCE = 0.3;
/** 横向手势开始前需要超过的像素，用于区分点击与滑动。 */
const AXIS_THRESHOLD = 10;
/** 弹簧参数：阻尼略高于临界值，到位过程无回弹。 */
const SETTLE = {
  type: "spring",
  stiffness: 420,
  damping: 44,
  restDelta: 0.5,
} as const;

/**
 * 通用的左右翻页控制器：手指拖动时当前页与相邻预览页同步平移，
 * 松手后结合拖动距离与释放速度，由弹簧动画决定切换或回弹。
 */
export const createSwipePager = (options: SwipePagerOptions): SwipePager => {
  const { track, page, peek, scroller, enabled, renderNeighbour, onCommit } =
    options;

  /** 当前页的横向偏移（px）。 */
  let offset = 0;
  /** 预览页当前对应的方向；为 null 表示尚未渲染。 */
  let peekStep: SwipeStep | null = null;
  let dragging = false;
  /** 手势开始时的偏移基准：动画中按下时从当前位置接管。 */
  let dragBase = 0;
  let animation: AnimationPlaybackControls | null = null;
  let scrollAnimation: AnimationPlaybackControls | null = null;

  const setOffset = (value: number): void => {
    offset = value;
    page.style.transform = value === 0 ? "" : `translate3d(${value}px, 0, 0)`;
    if (!peek.hidden && peekStep !== null) {
      const peekX = value + peekStep * track.clientWidth;
      peek.style.transform = `translate3d(${peekX}px, 0, 0)`;
    }
  };

  /** 切换预览页方向；返回该方向是否存在相邻页。 */
  const showPeek = (step: SwipeStep): boolean => {
    if (step !== peekStep) {
      peekStep = step;
      const html = renderNeighbour(step);
      peek.innerHTML = html ?? "";
      peek.hidden = html === null;
    }
    return !peek.hidden;
  };

  const clearVisual = (): void => {
    peekStep = null;
    peek.hidden = true;
    peek.innerHTML = "";
    setOffset(0);
  };

  const scrollToTop = (): void => {
    scrollAnimation?.stop();
    scrollAnimation = null;
    const start = scroller.scrollTop;
    if (start <= 0) return;
    scrollAnimation = animate(start, 0, {
      ...SETTLE,
      onUpdate: (value) => {
        scroller.scrollTop = value;
      },
    });
  };

  /** 弹簧动画到目标偏移；速度为释放时的 px/ms，动画库内部使用 px/s。 */
  const settleTo = (
    target: number,
    velocity: number,
    done: () => void,
  ): void => {
    animation?.stop();
    animation = animate(offset, target, {
      ...SETTLE,
      velocity: velocity * 1000,
      onUpdate: (value) => setOffset(value),
      onComplete: () => {
        animation = null;
        done();
      },
    });
  };

  /** 松手时判定要切换到的方向；不满足切换条件返回 null。 */
  const resolveCommit = (
    velocity: number,
    canceled: boolean,
  ): SwipeStep | null => {
    if (canceled || offset === 0) return null;
    const step: SwipeStep = offset < 0 ? 1 : -1;
    if (peekStep !== step || peek.hidden) return null;
    const distance = Math.abs(offset);
    const flung =
      Math.abs(velocity) > FLING_SPEED &&
      (velocity < 0 ? 1 : -1) === step &&
      distance > FLING_MIN_DISTANCE;
    return distance > track.clientWidth * COMMIT_RATIO || flung ? step : null;
  };

  const release = (velocity: number, canceled: boolean): void => {
    const step = resolveCommit(velocity, canceled);
    if (step === null) {
      settleTo(0, velocity, clearVisual);
      return;
    }
    scrollToTop();
    settleTo(-step * track.clientWidth, velocity, () => {
      onCommit(step);
      clearVisual();
    });
  };

  const go = (step: SwipeStep): void => {
    if (dragging || !enabled() || !showPeek(step)) return;
    setOffset(offset);
    scrollToTop();
    settleTo(-step * track.clientWidth, 0, () => {
      onCommit(step);
      clearVisual();
    });
  };

  const reset = (): void => {
    dragging = false;
    animation?.stop();
    animation = null;
    scrollAnimation?.stop();
    scrollAnimation = null;
    clearVisual();
  };

  new DragGesture(
    track,
    (state) => {
      if (state.first) {
        const origin = state.event.target;
        if (
          !enabled() ||
          (origin instanceof Element &&
            origin.closest("textarea, input, select"))
        ) {
          dragging = false;
          state.cancel();
          return;
        }
        animation?.stop();
        animation = null;
        scrollAnimation?.stop();
        scrollAnimation = null;
        dragBase = offset;
        dragging = true;
      }
      if (!dragging) return;
      if (state.last) {
        dragging = false;
        release(state.velocity[0] * state.direction[0], state.canceled);
        return;
      }
      const raw = dragBase + state.movement[0];
      // 手指向左（raw < 0）时预览下一页；静止时沿用上一次的方向。
      const step: SwipeStep = raw === 0 ? (peekStep ?? 1) : raw < 0 ? 1 : -1;
      const hasNeighbour = showPeek(step);
      setOffset(hasNeighbour ? raw : raw * EDGE_RESISTANCE);
    },
    {
      axis: "x",
      axisThreshold: { touch: AXIS_THRESHOLD },
      filterTaps: true,
      // 不占用 pointer capture：保证面板内按钮的 click 仍落在原目标上。
      pointer: { touch: true, capture: false },
    },
  );

  return { go, reset };
};
