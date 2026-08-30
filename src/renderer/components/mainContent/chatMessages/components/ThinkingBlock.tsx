import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../../i18n";
import { MarkdownBlock } from "./markdownRenderer";

/** 收起状态下思考内容区的固定高度（px）。 */
const THINKING_FIXED_HEIGHT = 200;

/** 思考完成自动收起后，绿色成功勾替代展开箭头的时长（ms）。 */
const SUCCESS_CHECK_DURATION = 1500;

const formatTokenCount = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);

const formatThinkingDuration = (ms: number): string => {
  if (ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
};

type ThinkingBlockProps = {
  content: string;
  isStreaming?: boolean;
  /** 思考流是否仍在进行；结束时自动收起，除非用户已手动操作过。 */
  isThinkingActive?: boolean;
  /** Rust 后端测量的思考阶段时长（ms）。 */
  durationMs?: number;
  /** Rust 后端统计的思考阶段 token 数。 */
  tokenCount?: number;
};

export const ThinkingBlock = ({
  content,
  isStreaming = false,
  isThinkingActive = false,
  durationMs = 0,
  tokenCount = 0,
}: ThinkingBlockProps): React.JSX.Element => {
  const { t } = useI18n();

  // 思考中默认展开以便观察推理流，其余情况默认收起保持对话紧凑。
  const [isCollapsed, setIsCollapsed] = useState(() => !isThinkingActive);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflow, setIsOverflow] = useState(false);
  // 思考完成自动收起的瞬间，绿色圆勾短暂替代展开箭头，1.5s 后还原。
  const [showSuccessCheck, setShowSuccessCheck] = useState(false);

  // 用户手动操作过后不再自动收起，避免打断阅读。
  const userInteractedRef = useRef(false);
  // 识别"思考中 → 结束"的真实转变，避免历史消息误判为刚完成。
  const prevThinkingActiveRef = useRef(isThinkingActive);
  const successTimerRef = useRef<number | null>(null);
  // 滚轮闪现滚动条计时器：半展开预览窗的滚动条默认隐藏，滚轮滚动时
  // 短暂显示 1s（与 ChatContent 的 is-wheelscrolling 方案一致）。
  const wheelScrollbarTimerRef = useRef(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  // 异步渲染的 markdown 内容会随时增长，用 ResizeObserver 监听它代替旧的
  // 每 chunk 一次 useLayoutEffect 同步读布局，避免长思考块卡顿。
  const bodyRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  // 平滑跟随滚动（rAF + 指数趋近）：流式内容离散到达，逐帧向底部 lerp
  // 追平而非硬跳；由 ResizeObserver 唤醒，追平后自动休眠，零开销。
  const followRafRef = useRef<number | null>(null);
  // 程序滚动豁免窗口：lerp 写入 scrollTop 的 scroll 事件不算用户滚动。
  const programmaticScrollUntilRef = useRef(0);
  // 上一次 scrollTop，用于识别用户向上滚动（内容单调增长，scrollTop 减小
  // 只可能来自用户）。
  const lastScrollTopRef = useRef(0);
  // 供 ResizeObserver 回调读取最新 isExpanded，避免每次切换重建 observer。
  const isExpandedRef = useRef(isExpanded);
  useEffect(() => {
    isExpandedRef.current = isExpanded;
  }, [isExpanded]);
  // 自动滚动只服务于正在思考的块；同步最新 isThinkingActive 供回调读取，
  // 已完成的块不再跟随内容增长滚动。
  const isThinkingActiveRef = useRef(isThinkingActive);
  useEffect(() => {
    isThinkingActiveRef.current = isThinkingActive;
  }, [isThinkingActive]);

  const stopFollowLoop = useCallback(() => {
    if (followRafRef.current !== null) {
      cancelAnimationFrame(followRafRef.current);
      followRafRef.current = null;
    }
  }, []);

  // 唤醒跟随滚动循环：每帧向底部 lerp 追平（<0.5px 后休眠），幂等。
  const startFollowLoop = useCallback(() => {
    if (followRafRef.current !== null) return;
    const step = (): void => {
      const node = scrollRef.current;
      if (!node) {
        followRafRef.current = null;
        return;
      }
      // 思考完成即退出：已完成块无论何种入口都不再自动滚动。
      if (!isThinkingActiveRef.current) {
        followRafRef.current = null;
        return;
      }
      // 收起视图始终贴最新内容；展开视图尊重用户滚动位置，滚离时退出。
      if (isExpandedRef.current && !autoScrollRef.current) {
        followRafRef.current = null;
        return;
      }
      const target = node.scrollHeight - node.clientHeight;
      const distance = target - node.scrollTop;
      if (Math.abs(distance) < 0.5) {
        node.scrollTop = target;
        followRafRef.current = null;
        return;
      }
      programmaticScrollUntilRef.current = performance.now() + 100;
      node.scrollTop += distance * 0.3;
      followRafRef.current = requestAnimationFrame(step);
    };
    followRafRef.current = requestAnimationFrame(step);
  }, []);

  // 思考结束自动收起，保持对话紧凑；用户手动操作过则跳过。触发瞬间用
  // 绿色圆勾替代展开箭头提示成功，1.5s 后还原（SUCCESS_CHECK_DURATION）。
  useEffect(() => {
    const wasActive = prevThinkingActiveRef.current;
    prevThinkingActiveRef.current = isThinkingActive;
    if (isThinkingActive || !wasActive) {
      return;
    }
    if (userInteractedRef.current) {
      return;
    }
    setIsCollapsed(true);
    setShowSuccessCheck(true);
    if (successTimerRef.current !== null) {
      window.clearTimeout(successTimerRef.current);
    }
    successTimerRef.current = window.setTimeout(() => {
      successTimerRef.current = null;
      setShowSuccessCheck(false);
    }, SUCCESS_CHECK_DURATION);
  }, [isThinkingActive]);

  useEffect(() => {
    return () => {
      if (successTimerRef.current !== null) {
        window.clearTimeout(successTimerRef.current);
      }
      if (wheelScrollbarTimerRef.current !== 0) {
        window.clearTimeout(wheelScrollbarTimerRef.current);
        wheelScrollbarTimerRef.current = 0;
      }
      stopFollowLoop();
    };
  }, [stopFollowLoop]);

  // 溢出检测与跟随滚动由同一触发（内容尺寸变化）驱动，合并处理避免重复读布局。
  const handleContentSizeChange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setIsOverflow(el.scrollHeight > THINKING_FIXED_HEIGHT);
    // 已完成的思考块保持用户当前阅读位置，不再自动跟随滚动。
    if (!isThinkingActiveRef.current) return;
    // 收起视图始终贴最新内容；展开视图尊重用户滚动位置。
    if (!isExpandedRef.current || autoScrollRef.current) {
      startFollowLoop();
    }
  }, [startFollowLoop]);

  // markdown 渲染已异步化（worker + rAF 节流），旧方案在 useLayoutEffect
  // 里同步读 scrollHeight 会量到过期 DOM 并反复触发重排；ResizeObserver
  // 被动触发，仅在浏览器真正完成新内容布局后回调。
  useEffect(() => {
    const body = bodyRef.current;
    const scroll = scrollRef.current;
    if (!body || !scroll) return;

    const resizeObserver = new ResizeObserver(() => {
      handleContentSizeChange();
    });
    resizeObserver.observe(body);
    resizeObserver.observe(scroll);

    return () => resizeObserver.disconnect();
  }, [handleContentSizeChange]);

  useEffect(() => {
    if (isStreaming && isThinkingActive) {
      autoScrollRef.current = true;
    }
  }, [isStreaming, isThinkingActive]);

  // 恢复流式时若用户仍在底部，唤醒平滑跟随追平存量差距；仅限正在思考的块。
  useEffect(() => {
    if (!isStreaming) return;
    if (!isThinkingActive) return;
    if (!autoScrollRef.current) return;
    startFollowLoop();
  }, [isStreaming, isThinkingActive, startFollowLoop]);

  // 思考完成立即停止自动跟随并复位标记，已完成的块保持用户滚动位置，
  // 不再因内容重排或展开操作而跳动。
  useEffect(() => {
    if (isThinkingActive) return;
    autoScrollRef.current = false;
    stopFollowLoop();
  }, [isThinkingActive, stopFollowLoop]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    // scrollTop 减小只可能来自用户向上滚动，立即尊重用户意图。
    if (el.scrollTop < prev - 0.5) {
      const isNearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      autoScrollRef.current = isNearBottom;
      return;
    }
    // lerp 追赶写入触发的 scroll 事件不算用户滚动，避免误判为滚离底部。
    if (performance.now() < programmaticScrollUntilRef.current) {
      return;
    }
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    // 用户滚回底部时立即续上跟随；已完成块不再参与自动滚动。
    if (isNearBottom && !autoScrollRef.current && isThinkingActiveRef.current) {
      startFollowLoop();
    }
    autoScrollRef.current = isNearBottom;
  }, [startFollowLoop]);

  // 半展开预览窗的滚动条默认透明隐藏，滚轮滚动可被本容器消费时闪现 1s
  //（与 ChatContent 的 is-wheelscrolling 方案一致）。
  const flashScrollbar = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.classList.add("is-wheelscrolling");
    if (wheelScrollbarTimerRef.current !== 0) {
      window.clearTimeout(wheelScrollbarTimerRef.current);
    }
    wheelScrollbarTimerRef.current = window.setTimeout(() => {
      wheelScrollbarTimerRef.current = 0;
      el.classList.remove("is-wheelscrolling");
    }, 1000);
  }, []);

  // 鼠标悬停在滚动条轨道（右侧 gutter）时显示 thumb：内容未溢出时不做处理。
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const el = event.currentTarget;
      if (el.scrollHeight <= el.clientHeight) {
        el.classList.remove("is-hovering-scrollbar");
        return;
      }
      const scrollbarStartX = el.getBoundingClientRect().left + el.clientWidth;
      el.classList.toggle(
        "is-hovering-scrollbar",
        event.clientX >= scrollbarStartX,
      );
    },
    [],
  );

  const handlePointerLeave = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.currentTarget.classList.remove("is-hovering-scrollbar");
    },
    [],
  );

  // 滚轮可被本容器消费时闪现滚动条；已滚到底/顶时手势交由外层容器处理。
  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>): void => {
      const el = event.currentTarget;
      if (el.scrollHeight <= el.clientHeight + 1) return;
      const deltaY = event.deltaY;
      if (deltaY === 0) return;
      const maxScrollTop = el.scrollHeight - el.clientHeight;
      const canConsume =
        (deltaY < 0 && el.scrollTop > 0) ||
        (deltaY > 0 && el.scrollTop < maxScrollTop - 1);
      if (canConsume) flashScrollbar();
    },
    [flashScrollbar],
  );

  const handleToggleCollapse = useCallback(() => {
    userInteractedRef.current = true;
    setIsCollapsed((v) => !v);
  }, []);

  const handleToggleExpand = useCallback(() => {
    userInteractedRef.current = true;
    setIsExpanded((v) => !v);
  }, []);

  const handleHeaderKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      userInteractedRef.current = true;
      setIsCollapsed((v) => !v);
    }
  }, []);

  // 标题随阶段切换：思考中 / 已完成（收起）/ 思考内容（展开）。
  const headerTitle = isThinkingActive
    ? t("chat.thinkingProcess")
    : isCollapsed
      ? t("chat.thinkingDone")
      : t("chat.thinkingContent");
  const hasStats = durationMs > 0 || tokenCount > 0;

  return (
    <div className="thinking-block">
      <div
        className={`thinking-block-header${
          isCollapsed ? " thinking-block-header--collapsed" : ""
        }`}
        onClick={handleToggleCollapse}
        onKeyDown={handleHeaderKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
      >
        {showSuccessCheck ? (
          <CheckCircle2
            className="thinking-block-check"
            size={16}
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className={`thinking-block-chevron${
              !isCollapsed ? " thinking-block-chevron--open" : ""
            }`}
            size={16}
            aria-hidden="true"
          />
        )}
        <span
          className={
            isThinkingActive ? "thinking-block-title--shimmer" : undefined
          }
        >
          {headerTitle}
        </span>
        {hasStats ? (
          <span className="thinking-block-meta" title="tokens">
            <Timer
              size={12}
              className="thinking-block-meta-icon"
              aria-hidden="true"
            />
            <span className="thinking-block-meta-value">
              {formatThinkingDuration(durationMs)}
            </span>
            <span className="thinking-block-meta-sep" aria-hidden="true">
              ·
            </span>
            <span className="thinking-block-meta-value">
              {formatTokenCount(tokenCount)}
            </span>
            <span className="thinking-block-meta-label">tokens</span>
          </span>
        ) : null}
      </div>

      {/* 内容区常挂载，收起时折叠为 0 高度，让折叠/展开能走高度过渡动画。 */}
      <div
        className={`thinking-block-collapse${
          isCollapsed ? " is-collapsed" : ""
        }`}
      >
        <div className="thinking-block-collapse-inner">
          <div className="thinking-block-content-wrapper">
            <div
              className={`thinking-block-scroll${
                isExpanded ? " thinking-block-scroll--expanded" : ""
              }`}
              ref={scrollRef}
              onScroll={handleScroll}
              onPointerMove={handlePointerMove}
              onPointerLeave={handlePointerLeave}
              onWheel={handleWheel}
            >
              {/* 思考过程文本同样支持划词引用（data-quote-source）。 */}
              <div ref={bodyRef} data-quote-source="true">
                <MarkdownBlock
                  className="thinking-block-body"
                  content={content}
                  streaming={isStreaming}
                />
              </div>
            </div>

            {isOverflow && !isExpanded ? (
              <div className="thinking-block-mask">
                <button
                  type="button"
                  className="thinking-block-expand-btn"
                  onClick={handleToggleExpand}
                >
                  <ChevronDown size={14} aria-hidden="true" />
                  <span>{t("chat.expandAll")}</span>
                </button>
              </div>
            ) : null}

            {isExpanded ? (
              <button
                type="button"
                className="thinking-block-collapse-btn"
                onClick={handleToggleExpand}
              >
                <ChevronUp size={14} aria-hidden="true" />
                <span>{t("chat.collapse")}</span>
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
