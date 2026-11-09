/**
 * 消息区高度平滑增长控制器。
 *
 * 流式期间内容按「行 / 工具卡 / 新消息」离散增长，即时钉底会让整片视口
 * 按步瞬移；而让 scrollTop 滞后追赶又会令底部元素先下沉再回弹。这里换一个
 * 位置做平滑：视口元素（viewport）以显式高度包住内容轨道（track），轨道
 * 的自然高度变化不立即反映到视口，而由 rAF 把视口高度平滑过渡到目标值，
 * 超出部分在视口底边被裁剪。滚动容器的 ResizeObserver 在每一帧的视口高度
 * 变化后（paint 前）同帧钉底——内容整体平滑上移，新内容从裁剪边缘逐帧
 * 露出，视口下方的元素（流式指示槽）始终纹丝不动。
 *
 * 状态：
 *   - 未武装（displayed === null）：视口高度为 auto，与内容同步，零干预；
 *   - 武装：视口持有显式高度，轨道增长时启动过渡，收敛后保持武装待命。
 *
 * 武装与释放的时机由 canAnimate 决定（跟随中、无翻页恢复等），见
 * useChatScrollFollow。ResizeObserver 回调里只做「不改变视口尺寸」的操作
 * （武装时显式高度等于当前自然高度），需要改变尺寸的释放
 * 推迟到下一帧，避免在同一轮观察里改动祖先尺寸造成通知丢失。
 *
 * 唯一例外是宽度变化（展开/收起侧边面板、窗口缩放）引起的重排：那不是
 * 内容增长，必须同帧对齐自然高度，否则缩窄时新增高度被逐帧放出、拉宽时
 * 视口底部留出空白再塌回，整片会话随之弹跳。此时滚动容器本身也在本轮被
 * 观察到尺寸变化，消息列表（容器直接子元素）属于更深层级，对齐后的高度
 * 会在同一帧内再次投递给钉底逻辑。
 */

/** 过渡时间常数（ms）：一阶指数趋近，约 3 倍时间常数基本到位。 */
const GROWTH_TIME_CONSTANT_MS = 55;
/** 最低推进速度（px/ms）：消除指数趋近的长尾，末端几像素干脆利落地收敛。 */
const GROWTH_MIN_SPEED_PX_PER_MS = 0.3;
/** 最大滞后（px）：一次性涌入大块内容时只过渡最后这一段，不拖沓。 */
const GROWTH_MAX_LAG_PX = 360;
/** 单帧时间步上限（ms）：窗口失焦恢复等长间隔不应一步跨完。 */
const GROWTH_MAX_FRAME_MS = 48;
/** 静止武装态的空闲巡检间隔（ms）。 */
const GROWTH_IDLE_CHECK_MS = 1500;

const GROWING_CLASS = "is-growing";

export type StreamGrowthSmoother = {
  /** 立即武装（显式高度 = 当前自然高度，无视觉变化）；条件不满足时忽略。 */
  arm: () => void;
  /** 立即释放：视口恢复 auto 高度，停止过渡。 */
  release: () => void;
  /** 销毁：释放并断开观察。 */
  dispose: () => void;
};

export const createStreamGrowthSmoother = (
  viewport: HTMLElement,
  track: HTMLElement,
  canAnimate: () => boolean,
): StreamGrowthSmoother => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let displayed: number | null = null;
  const initialRect = track.getBoundingClientRect();
  let target = initialRect.height;
  let trackWidth = initialRect.width;
  let rafId = 0;
  let lastFrameAt = 0;
  let releaseRafId = 0;
  let idleTimerId = 0;

  const isAllowed = (): boolean => !reducedMotion.matches && canAnimate();

  const applyHeight = (height: number): void => {
    viewport.style.height = `${height}px`;
  };

  const cancelFrames = (): void => {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (releaseRafId !== 0) {
      cancelAnimationFrame(releaseRafId);
      releaseRafId = 0;
    }
    if (idleTimerId !== 0) {
      window.clearTimeout(idleTimerId);
      idleTimerId = 0;
    }
  };

  const release = (): void => {
    cancelFrames();
    if (displayed === null) {
      return;
    }
    displayed = null;
    viewport.style.height = "";
    viewport.classList.remove(GROWING_CLASS);
  };

  // 收敛后保持武装待命；跟随结束（run 收尾宽限过期、用户离开底部）后由
  // 空闲巡检交还自然高度，不让显式高度与裁剪长期滞留在静止的视口上。
  const scheduleIdleCheck = (): void => {
    if (idleTimerId !== 0) {
      return;
    }
    idleTimerId = window.setTimeout(() => {
      idleTimerId = 0;
      if (displayed === null || rafId !== 0) {
        return;
      }
      if (isAllowed()) {
        scheduleIdleCheck();
      } else {
        release();
      }
    }, GROWTH_IDLE_CHECK_MS);
  };

  const armAt = (height: number): void => {
    displayed = height;
    applyHeight(height);
    viewport.classList.add(GROWING_CLASS);
    scheduleIdleCheck();
  };

  const tick = (now: number): void => {
    rafId = 0;
    if (displayed === null) {
      return;
    }
    if (!isAllowed()) {
      release();
      return;
    }
    const elapsed =
      lastFrameAt === 0
        ? 16
        : Math.min(GROWTH_MAX_FRAME_MS, Math.max(0, now - lastFrameAt));
    lastFrameAt = now;

    const gap = target - displayed;
    const direction = Math.sign(gap);
    const eased = gap * (1 - Math.exp(-elapsed / GROWTH_TIME_CONSTANT_MS));
    const minimum = GROWTH_MIN_SPEED_PX_PER_MS * elapsed * direction;
    let next =
      displayed + (Math.abs(eased) > Math.abs(minimum) ? eased : minimum);
    if (
      (direction > 0 && next >= target) ||
      (direction < 0 && next <= target)
    ) {
      next = target;
    }
    if (target - next > GROWTH_MAX_LAG_PX) {
      next = target - GROWTH_MAX_LAG_PX;
    } else if (next - target > GROWTH_MAX_LAG_PX) {
      next = target + GROWTH_MAX_LAG_PX;
    }

    displayed = next;
    applyHeight(next);
    if (next !== target) {
      rafId = requestAnimationFrame(tick);
    } else {
      scheduleIdleCheck();
    }
  };

  const startTransition = (): void => {
    if (rafId !== 0) {
      return;
    }
    lastFrameAt = 0;
    rafId = requestAnimationFrame(tick);
  };

  const scheduleRelease = (): void => {
    if (releaseRafId !== 0) {
      return;
    }
    releaseRafId = requestAnimationFrame(() => {
      releaseRafId = 0;
      if (!isAllowed()) {
        release();
      }
    });
  };

  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    const box = entry?.borderBoxSize?.[0];
    const nextHeight = box?.blockSize ?? entry?.contentRect.height;
    const nextWidth = box?.inlineSize ?? entry?.contentRect.width;
    if (nextHeight === undefined || nextWidth === undefined) {
      return;
    }
    const isReflow = Math.abs(nextWidth - trackWidth) > 0.5;
    trackWidth = nextWidth;
    target = nextHeight;
    if (displayed === null) {
      // 未武装：本次增长已按自然高度生效。条件满足时就地武装（显式高度
      // 恰为当前自然高度，视口尺寸不变），之后的增长都走平滑过渡。
      if (isAllowed()) {
        armAt(nextHeight);
      }
      return;
    }
    if (isReflow) {
      // 宽度重排：中止在途过渡，视口高度同帧对齐自然高度（见文件头说明）。
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      displayed = target;
      applyHeight(target);
      scheduleIdleCheck();
    }
    if (!isAllowed()) {
      scheduleRelease();
      return;
    }
    if (displayed !== target) {
      startTransition();
    }
  });
  observer.observe(track);

  return {
    arm: (): void => {
      if (displayed !== null || !isAllowed()) {
        return;
      }
      target = track.getBoundingClientRect().height;
      armAt(target);
    },
    release,
    dispose: (): void => {
      observer.disconnect();
      release();
    },
  };
};
