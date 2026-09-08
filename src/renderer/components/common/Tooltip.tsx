import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

export type TooltipProps = {
  content: ReactNode;
  children: ReactNode;
  /** 浮层方向：top（默认，向上弹出）/ bottom（向下弹出）；对侧空间更充裕时自动反向。 */
  placement?: "top" | "bottom";
  /** 受控显示：传入时忽略内部 hover 状态（供 DOM 注入内容外部驱动）。 */
  visible?: boolean;
};

/** Tooltip 与触发元素之间的间距（同时是箭头的活动空间）。 */
const GAP = 8;
/** Tooltip 距视口边缘的最小安全间距（防止被窗口边缘裁剪）。 */
const VIEWPORT_MARGIN = 8;
/** 箭头距 Tooltip 左右边缘的最小距离（避免落在圆角之外）。 */
const ARROW_INSET = 12;

type TooltipPos = {
  left: number;
  top: number;
  placement: "top" | "bottom";
  arrowX: number;
};

/**
 * 由触发元素与 Tooltip 的视口矩形计算 fixed 坐标：
 * - 垂直方向按 placement，空间不足且对侧更宽裕时反向，保证完整可见；
 * - 水平方向以触发元素中心对齐，并夹紧到视口安全区内；
 * - 箭头（--tooltip-arrow-x）在夹紧后仍指向触发元素中心。
 */
const computePosition = (
  trigger: DOMRect,
  tooltip: DOMRect,
  placement: "top" | "bottom",
): TooltipPos => {
  const roomAbove = trigger.top - GAP;
  const roomBelow = window.innerHeight - trigger.bottom - GAP;
  let resolved = placement;
  if (
    (resolved === "top" &&
      tooltip.height > roomAbove &&
      roomBelow > roomAbove) ||
    (resolved === "bottom" &&
      tooltip.height > roomBelow &&
      roomAbove > roomBelow)
  ) {
    resolved = resolved === "top" ? "bottom" : "top";
  }

  const centerX = trigger.left + trigger.width / 2;
  const maxLeft = Math.max(
    VIEWPORT_MARGIN,
    window.innerWidth - VIEWPORT_MARGIN - tooltip.width,
  );
  const left = Math.min(
    Math.max(centerX - tooltip.width / 2, VIEWPORT_MARGIN),
    maxLeft,
  );
  const arrowX = Math.min(
    Math.max(centerX - left, ARROW_INSET),
    Math.max(ARROW_INSET, tooltip.width - ARROW_INSET),
  );

  const top =
    resolved === "top"
      ? trigger.top - GAP - tooltip.height
      : trigger.bottom + GAP;
  return { left, top, placement: resolved, arrowX };
};

/**
 * 全局悬浮提示。经 Portal 渲染到 document.body 并以 position: fixed 定位，
 * 彻底脱离任何祖先容器的 overflow / z-index 裁剪（否则会被侧边栏、
 * 聊天滚动区、工具栏等容器遮挡或截断）。显示期间逐帧同步触发元素位置，
 * 滚动、窗口缩放、宿主位移都能实时跟随；静止时不产生额外渲染。
 */
export const Tooltip = ({
  content,
  children,
  placement = "top",
  visible,
}: TooltipProps): React.JSX.Element => {
  const [internalVisible, setInternalVisible] = useState(false);
  const isVisible = visible ?? internalVisible;
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<TooltipPos | null>(null);

  const handleMouseEnter = useCallback(
    (event: ReactMouseEvent<HTMLSpanElement>) => {
      // CSS 可按环境在 wrapper 上声明 --tooltip-suppressed: 1 来禁用提示
      // （如多选操作栏容器足够宽、按钮文字已可见时，由容器查询声明该变量）。
      const suppressed = window
        .getComputedStyle(event.currentTarget)
        .getPropertyValue("--tooltip-suppressed")
        .trim();
      if (suppressed === "1") {
        return;
      }
      setInternalVisible(true);
    },
    [],
  );

  const handleMouseLeave = useCallback(() => {
    setInternalVisible(false);
  }, []);

  // 首帧测量定位 + 显示期间持续跟随。Portal 内容挂载后 ref 即可用，
  // layout effect 中的 setPos 在浏览器绘制前完成，不会出现位置闪烁。
  useLayoutEffect(() => {
    if (!isVisible) {
      setPos(null);
      return;
    }
    const sync = (): void => {
      const trigger = wrapperRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) {
        return;
      }
      const next = computePosition(
        trigger.getBoundingClientRect(),
        tooltip.getBoundingClientRect(),
        placement,
      );
      setPos((prev) =>
        prev &&
        Math.abs(prev.left - next.left) < 0.5 &&
        Math.abs(prev.top - next.top) < 0.5 &&
        prev.placement === next.placement &&
        Math.abs(prev.arrowX - next.arrowX) < 0.5
          ? prev
          : next,
      );
    };
    sync();
    let rafId = window.requestAnimationFrame(function tick() {
      sync();
      rafId = window.requestAnimationFrame(tick);
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [isVisible, placement]);

  return (
    <span
      ref={wrapperRef}
      className="tooltip-wrapper"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {isVisible &&
        createPortal(
          <div
            ref={tooltipRef}
            className={`tooltip tooltip-${pos?.placement ?? placement}`}
            role="tooltip"
            style={
              pos
                ? ({
                    left: pos.left,
                    top: pos.top,
                    "--tooltip-arrow-x": `${pos.arrowX}px`,
                  } as CSSProperties)
                : // 首帧离屏占位仅供测量，同帧内即被 layout effect 校正。
                  { left: -99999, top: 0, visibility: "hidden" }
            }
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
};
