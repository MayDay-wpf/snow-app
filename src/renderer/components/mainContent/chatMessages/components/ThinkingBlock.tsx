import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../../i18n";
import { MarkdownBlock } from "./markdownRenderer";

/** Fixed height (px) for the collapsed thinking content area. */
const THINKING_FIXED_HEIGHT = 200;

type ThinkingBlockProps = {
  content: string;
  isStreaming?: boolean;
};

export const ThinkingBlock = ({
  content,
  isStreaming = false,
}: ThinkingBlockProps): React.JSX.Element => {
  const { t } = useI18n();

  // Whether the entire thinking section is collapsed (header-only)
  const [isCollapsed, setIsCollapsed] = useState(false);
  // Whether the content is fully expanded (no height limit)
  const [isExpanded, setIsExpanded] = useState(false);
  // Whether content overflows the fixed height (controls mask visibility)
  const [isOverflow, setIsOverflow] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The inner element whose size changes as the async-rendered markdown HTML
  // arrives. ResizeObserver on this element replaces the previous per-chunk
  // useLayoutEffect([content]) that forced a synchronous layout read on every
  // streamed token — a major source of jank for long thinking blocks.
  const bodyRef = useRef<HTMLDivElement>(null);
  // Tracks whether auto-scroll should be active (user hasn't scrolled away)
  const autoScrollRef = useRef(true);
  // Mirror isExpanded into a ref so the ResizeObserver callback can read the
  // latest value without re-creating the observer on every toggle. In the
  // collapsed (fixed-height) view we always pin to the newest content,
  // regardless of whether the user scrolled up.
  const isExpandedRef = useRef(isExpanded);
  useEffect(() => {
    isExpandedRef.current = isExpanded;
  }, [isExpanded]);

  // Check if content overflows the fixed height, and if auto-scroll is active,
  // keep the thinking view pinned to the newest content. Both concerns are
  // driven by the same trigger — a change in rendered content size — so they
  // are handled together inside the ResizeObserver callback to avoid
  // duplicated layout reads.
  const handleContentSizeChange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setIsOverflow(el.scrollHeight > THINKING_FIXED_HEIGHT);
    // In the collapsed (fixed-height) view, always pin to the newest content.
    // In the expanded view, respect the user's scroll position.
    if (!isExpandedRef.current || autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Observe the rendered markdown body for size changes. This fires:
  //   - When the worker returns new HTML and React commits it to the DOM
  //   - When the container width changes (panel resize, expand/collapse toggle)
  // Because markdown rendering is now async (worker + rAF throttle), the old
  // approach of reading scrollHeight in a useLayoutEffect([content]) would
  // measure stale DOM (the worker round-trip hasn't landed yet) and force a
  // layout thrash on every chunk. ResizeObserver is passive and fires only
  // when the browser has actually laid out new content.
  useEffect(() => {
    const body = bodyRef.current;
    const scroll = scrollRef.current;
    if (!body || !scroll) return;

    const resizeObserver = new ResizeObserver(() => {
      handleContentSizeChange();
    });
    // Observe the body (content growth) and the scroll container (width
    // changes from panel resize / expand toggle that affect wrapping).
    resizeObserver.observe(body);
    resizeObserver.observe(scroll);

    return () => resizeObserver.disconnect();
  }, [handleContentSizeChange]);

  // Reset auto-scroll when streaming starts
  useEffect(() => {
    if (isStreaming) {
      autoScrollRef.current = true;
    }
  }, [isStreaming]);

  // Keep auto-scroll pinned while streaming. Content changes no longer drive
  // scrolling directly (the ResizeObserver handles that), but we still need
  // to reactivate auto-scroll on resume when the user hasn't scrolled away
  // and isStreaming flips true.
  useEffect(() => {
    if (!isStreaming) return;
    const el = scrollRef.current;
    if (!el) return;
    if (autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [isStreaming]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    autoScrollRef.current = isNearBottom;
  }, []);

  const handleToggleCollapse = useCallback(() => {
    setIsCollapsed((v) => !v);
  }, []);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((v) => !v);
  }, []);

  const handleHeaderKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setIsCollapsed((v) => !v);
    }
  }, []);

  return (
    <div className="thinking-block">
      <div
        className="thinking-block-header"
        onClick={handleToggleCollapse}
        onKeyDown={handleHeaderKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
      >
        <ChevronRight
          className={`thinking-block-chevron${
            !isCollapsed ? " thinking-block-chevron--open" : ""
          }`}
          size={16}
          aria-hidden="true"
        />
        <span>{t("chat.thinkingProcess")}</span>
      </div>

      {/* 内容区常挂载（收起时由 .thinking-block-collapse 折叠为 0 高度），
          使折叠/展开都能走 grid-rows 高度过渡动画，而非瞬间闪现。 */}
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
            >
              {/* data-quote-source：思考过程文本同样支持划词引用 */}
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
