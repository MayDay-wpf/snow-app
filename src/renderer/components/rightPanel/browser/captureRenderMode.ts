/**
 * 非激活浏览器 tab 的 pane 是 display:none，webview 不产帧，CDP 截图
 * （Page.captureScreenshot）会一直挂起。截图期间把目标 pane 临时切到
 * 「仍在视口内绘制 + 置顶 + 全透明 + 不吃指针事件」的渲染态（见
 * styles.css 的 .right-panel-tab-pane.capture-render），用户看不到切换，
 * 结束后立即恢复 display:none。
 *
 * 就绪只等布局 + 两帧：产帧由主进程在截图期间持有帧订阅保证，避免盲等
 * 固定时长既慢又不保证首帧已就绪。
 */

const CAPTURE_RENDER_CLASS = "capture-render";
const LAYOUT_POLL_TIMEOUT_MS = 600;
const LAYOUT_POLL_INTERVAL_MS = 40;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    let frame: number | undefined;
    const finish = (): void => {
      window.clearTimeout(timer);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      resolve();
    };
    // 隐藏窗口可能暂停 rAF；租约就绪不能无限等待。
    const timer = window.setTimeout(finish, LAYOUT_POLL_INTERVAL_MS);
    frame = window.requestAnimationFrame(finish);
  });

const findBrowserPane = (instanceId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `.right-panel-tab-pane[data-browser-instance-id="${CSS.escape(instanceId)}"]`,
  );

const waitForPaneLayout = async (pane: HTMLElement): Promise<void> => {
  const deadline = Date.now() + LAYOUT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rect = pane.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1) {
      return;
    }
    await delay(LAYOUT_POLL_INTERVAL_MS);
  }
};

export type CaptureRenderLease = {
  ready: Promise<void>;
  release: () => void;
};

type PaneLeaseState = {
  references: number;
  ready: Promise<void>;
  background: boolean;
  hadCaptureClass: boolean;
};
const paneLeases = new WeakMap<HTMLElement, PaneLeaseState>();

/** 同一 pane 的截图/录屏共享渲染态；激活时也持有，切后台后仍可产帧。 */
export const acquireCaptureRenderLease = (
  instanceId: string,
): CaptureRenderLease => {
  const pane = findBrowserPane(instanceId);
  if (!pane) return { ready: Promise.resolve(), release: () => {} };
  let state = paneLeases.get(pane);
  if (!state) {
    const background = !pane.classList.contains("active");
    state = {
      references: 0,
      ready: Promise.resolve(),
      background,
      hadCaptureClass: pane.classList.contains(CAPTURE_RENDER_CLASS),
    };
    paneLeases.set(pane, state);
    pane.classList.add(CAPTURE_RENDER_CLASS);
    if (background) {
      state.ready = (async () => {
        await waitForPaneLayout(pane);
        await nextFrame();
        await nextFrame();
      })();
    }
  }
  state.references++;
  const leaseState = state;
  let released = false;
  return {
    ready: leaseState.ready,
    release: () => {
      if (released) return;
      released = true;
      if (--leaseState.references === 0) {
        paneLeases.delete(pane);
        if (!leaseState.hadCaptureClass)
          pane.classList.remove(CAPTURE_RENDER_CLASS);
      }
    },
  };
};

export const withCaptureRenderMode = async <T>(
  instanceId: string,
  run: () => Promise<T>,
): Promise<T> => {
  const lease = acquireCaptureRenderLease(instanceId);
  try {
    await lease.ready;
    return await run();
  } finally {
    lease.release();
  }
};
