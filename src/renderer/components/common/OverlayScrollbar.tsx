import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

type OverlayScrollbarProps = {
  children: ReactNode;
  /** 挂在滚动元素上的业务类名（如 right-panel-tab-list） */
  className?: string;
  /** 滚动方向，默认 horizontal */
  orientation?: "horizontal" | "vertical";
  /** 转发滚动容器的 scroll 事件 */
  onScroll?: () => void;
  /** 转发滚动容器的 contextMenu 事件 */
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
};

const MIN_THUMB_SIZE = 32;

// 自绘悬浮滚动条：隐藏原生滚动条，thumb 按内容比例绝对定位在
// 容器边缘，细且可拖动，避免原生滚动条过粗、出现时撑动布局。
export const OverlayScrollbar = forwardRef<
  HTMLDivElement,
  OverlayScrollbarProps
>(
  (
    {
      children,
      className,
      orientation = "horizontal",
      onScroll,
      onContextMenu,
    },
    forwardedRef,
  ) => {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef(0);
    const isHorizontal = orientation === "horizontal";

    const scheduleUpdate = useCallback(() => {
      if (rafRef.current) {
        return;
      }
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;
        const el = scrollerRef.current;
        const thumb = thumbRef.current;
        if (!el || !thumb) {
          return;
        }
        const scrollable = isHorizontal
          ? el.scrollWidth - el.clientWidth
          : el.scrollHeight - el.clientHeight;
        const track = isHorizontal ? el.clientWidth : el.clientHeight;
        const content = isHorizontal ? el.scrollWidth : el.scrollHeight;
        if (scrollable <= 0 || track <= 0) {
          thumb.style.opacity = "0";
          thumb.style.pointerEvents = "none";
          return;
        }
        const size = Math.max(MIN_THUMB_SIZE, (track / content) * track);
        const maxOffset = track - size;
        const pos = isHorizontal ? el.scrollLeft : el.scrollTop;
        const offset = (pos / scrollable) * maxOffset;
        thumb.style.opacity = "1";
        thumb.style.pointerEvents = "auto";
        if (isHorizontal) {
          thumb.style.width = `${size}px`;
          thumb.style.transform = `translateX(${offset}px)`;
        } else {
          thumb.style.height = `${size}px`;
          thumb.style.transform = `translateY(${offset}px)`;
        }
      });
    }, [isHorizontal]);

    // 滚动、容器尺寸与内容结构变化时重算 thumb（rAF 节流）。
    useEffect(() => {
      const el = scrollerRef.current;
      if (!el) {
        return;
      }
      const ro = new ResizeObserver(scheduleUpdate);
      ro.observe(el);
      const mo = new MutationObserver(scheduleUpdate);
      mo.observe(el, { childList: true, subtree: true });
      // 滚动本身不触发 RO/MO，必须单独监听 scroll 才能跟随移动 thumb。
      el.addEventListener("scroll", scheduleUpdate, { passive: true });
      scheduleUpdate();
      return () => {
        ro.disconnect();
        mo.disconnect();
        el.removeEventListener("scroll", scheduleUpdate);
        if (rafRef.current) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
      };
    }, [scheduleUpdate]);

    const setScrollerRef = useCallback(
      (node: HTMLDivElement | null) => {
        scrollerRef.current = node;
        if (typeof forwardedRef === "function") {
          forwardedRef(node);
        } else if (forwardedRef) {
          forwardedRef.current = node;
        }
      },
      [forwardedRef],
    );

    // 拖动 thumb：指针位移按轨道比例换算为滚动距离。
    const handleThumbPointerDown = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const el = scrollerRef.current;
        const thumb = thumbRef.current;
        if (!el || !thumb || event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const startPos = isHorizontal ? event.clientX : event.clientY;
        const startScroll = isHorizontal ? el.scrollLeft : el.scrollTop;
        const thumbSize = isHorizontal ? thumb.offsetWidth : thumb.offsetHeight;
        thumb.setPointerCapture(event.pointerId);
        const handleMove = (moveEvent: PointerEvent) => {
          const delta =
            (isHorizontal ? moveEvent.clientX : moveEvent.clientY) - startPos;
          const scrollable = isHorizontal
            ? el.scrollWidth - el.clientWidth
            : el.scrollHeight - el.clientHeight;
          const maxOffset =
            (isHorizontal ? el.clientWidth : el.clientHeight) - thumbSize;
          if (scrollable <= 0 || maxOffset <= 0) {
            return;
          }
          const next = startScroll + (delta / maxOffset) * scrollable;
          if (isHorizontal) {
            el.scrollLeft = next;
          } else {
            el.scrollTop = next;
          }
        };
        const handleUp = () => {
          thumb.removeEventListener("pointermove", handleMove);
          thumb.removeEventListener("pointerup", handleUp);
          thumb.removeEventListener("pointercancel", handleUp);
        };
        thumb.addEventListener("pointermove", handleMove);
        thumb.addEventListener("pointerup", handleUp);
        thumb.addEventListener("pointercancel", handleUp);
      },
      [isHorizontal],
    );

    return (
      <div className="overlay-scrollbar" data-orientation={orientation}>
        <div
          ref={setScrollerRef}
          className={`overlay-scrollbar-scroller${
            className ? ` ${className}` : ""
          }`}
          onScroll={onScroll}
          onContextMenu={onContextMenu}
        >
          {children}
        </div>
        <div
          ref={thumbRef}
          className="overlay-scrollbar-thumb"
          onPointerDown={handleThumbPointerDown}
          aria-hidden="true"
        />
      </div>
    );
  },
);

OverlayScrollbar.displayName = "OverlayScrollbar";
