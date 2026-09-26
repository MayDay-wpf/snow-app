import {
  ArrowDown,
  Bubbles,
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../../i18n";
import { MarkdownBlock } from "./markdownRenderer";

/** 思考完成自动收起后，绿色成功勾替代展开箭头的时长（ms）。 */
const SUCCESS_CHECK_DURATION = 1500;

/** 单行预览最大字符数，超出后取尾部。 */
const PREVIEW_MAX_CHARS = 150;

const PREVIEW_SCAN_CHARS = PREVIEW_MAX_CHARS * 4;

const PREVIEW_UPDATE_INTERVAL_MS = 200;

/** 与 CSS .thinking-block-collapse 的 grid-template-rows 过渡时长一致。 */
const COLLAPSE_ANIMATION_MS = 300;

const THINKING_RENDER_INTERVAL_MS = 300;

const THINKING_LONG_TEXT_CHARS = 100_000;
const THINKING_LONG_TEXT_INTERVAL_MS = 600;

const COLLAPSE_ANIMATION_MAX_CHARS = 4000;

/** 思考内容超过该长度时，内容底部追加"收起"按钮，读完即可就地收起。 */
const COLLAPSE_FOOTER_MIN_CHARS = 320;

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

const getPreviewText = (content: string): string => {
  if (!content) return "";
  const hasMore = content.length > PREVIEW_SCAN_CHARS;
  const tail = (hasMore ? content.slice(-PREVIEW_SCAN_CHARS) : content).replace(
    /[\n\r\t]+/g,
    " ",
  );
  if (tail.length <= PREVIEW_MAX_CHARS) {
    return hasMore ? "…" + tail : tail;
  }
  return "…" + tail.slice(-PREVIEW_MAX_CHARS);
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

  // 只有两种状态：收起（仅头部）与全部展开，点击头部切换。
  const [isCollapsed, setIsCollapsed] = useState(true);
  // 思考完成自动收起的瞬间，绿色圆勾短暂替代展开箭头，1.5s 后还原。
  const [showSuccessCheck, setShowSuccessCheck] = useState(false);
  // MarkdownBlock 延迟卸载：展开时立即挂载，收起时等动画播完再卸载，
  // 保住 grid-template-rows 过渡动画的起始高度，同时释放 worker 内存。
  const [contentMounted, setContentMounted] = useState(false);
  const [previewText, setPreviewText] = useState("");
  // 整块离屏期间暂停 MarkdownBlock 的渲染派发：思考内容可能极长，
  // 用户滚走之后继续重渲染纯属浪费；重新可见时会立即渲染最新一版。
  const [contentRenderPaused, setContentRenderPaused] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 用户手动操作过后不再自动收起，避免打断阅读。
  const userInteractedRef = useRef(false);
  // 识别"思考中 → 结束"的真实转变，避免历史消息误判为刚完成。
  const prevThinkingActiveRef = useRef(isThinkingActive);
  const successTimerRef = useRef<number | null>(null);
  const unmountTimerRef = useRef<number | null>(null);
  const previewTextRef = useRef("");
  const pendingPreviewRef = useRef("");
  const previewTimerRef = useRef<number | null>(null);
  const lastPreviewAtRef = useRef(0);

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

  // 内容区延迟卸载：展开立即挂载，收起等动画结束再卸载。
  useEffect(() => {
    if (!isCollapsed) {
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
      setContentMounted(true);
    } else {
      unmountTimerRef.current = window.setTimeout(() => {
        unmountTimerRef.current = null;
        setContentMounted(false);
      }, COLLAPSE_ANIMATION_MS);
    }
    return () => {
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
    };
  }, [isCollapsed]);

  // 整块可见性：完全离开视口后暂停渲染派发（带 300px 余量，避免滚动过程
  // 中来回切换），重新进入视口立即恢复。必须观察根节点（头部始终有高度）：
  // 内容节点在"还没渲染出内容"时高度为 0，零面积永远不算相交，暂停门会把
  // 自己锁死——展开时不再派发渲染，内容也就永远出不来，只剩一个收起按钮。
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) {
          setContentRenderPaused(!entry.isIntersecting);
        }
      },
      { rootMargin: "300px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const flushPreview = useCallback(() => {
    previewTimerRef.current = null;
    lastPreviewAtRef.current = Date.now();
    const next = getPreviewText(pendingPreviewRef.current);
    if (next === previewTextRef.current) {
      return;
    }
    previewTextRef.current = next;
    setPreviewText(next);
  }, []);

  useEffect(() => {
    if (!isThinkingActive) {
      if (previewTimerRef.current !== null) {
        window.clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
      pendingPreviewRef.current = "";
      if (previewTextRef.current !== "") {
        previewTextRef.current = "";
        setPreviewText("");
      }
      return;
    }
    pendingPreviewRef.current = content;
    if (previewTimerRef.current !== null) {
      return;
    }
    previewTimerRef.current = window.setTimeout(
      flushPreview,
      Math.max(
        0,
        PREVIEW_UPDATE_INTERVAL_MS - (Date.now() - lastPreviewAtRef.current),
      ),
    );
  }, [content, isThinkingActive, flushPreview]);

  useEffect(() => {
    return () => {
      if (successTimerRef.current !== null) {
        window.clearTimeout(successTimerRef.current);
      }
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current);
      }
      if (previewTimerRef.current !== null) {
        window.clearTimeout(previewTimerRef.current);
      }
    };
  }, []);

  const handleToggleCollapse = useCallback(() => {
    userInteractedRef.current = true;
    setIsCollapsed((v) => !v);
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

  const bodyRenderIntervalMs =
    content.length >= THINKING_LONG_TEXT_CHARS
      ? THINKING_LONG_TEXT_INTERVAL_MS
      : THINKING_RENDER_INTERVAL_MS;
  const instantCollapse = content.length > COLLAPSE_ANIMATION_MAX_CHARS;
  // 长内容才需要底部收起入口；短内容贴近头部，不必多此一举。
  const showFooterButton = content.length >= COLLAPSE_FOOTER_MIN_CHARS;

  return (
    <div className="thinking-block" ref={rootRef}>
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
        <Bubbles
          className="thinking-block-thinking-icon"
          size={16}
          aria-hidden="true"
        />
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
            <ArrowDown
              size={12}
              className="thinking-block-meta-icon"
              aria-hidden="true"
            />
            <span className="thinking-block-meta-value">
              {formatTokenCount(tokenCount)}
            </span>
            <span className="thinking-block-meta-label">tokens</span>
          </span>
        ) : null}
        {isThinkingActive && previewText ? (
          <span className="thinking-block-preview" aria-hidden="true">
            {previewText}
          </span>
        ) : null}
        {showSuccessCheck ? (
          <CheckCircle2
            className="thinking-block-check"
            size={16}
            aria-hidden="true"
          />
        ) : !isThinkingActive ? (
          <ChevronRight
            className={`thinking-block-chevron${
              !isCollapsed ? " thinking-block-chevron--open" : ""
            }`}
            size={16}
            aria-hidden="true"
          />
        ) : null}
      </div>

      {/* 内容区：展开时挂载 MarkdownBlock，收起时等 grid 动画播完再卸载，
          保住过渡动画起始高度，同时释放 worker 解析内存。 */}
      <div
        className={`thinking-block-collapse${
          isCollapsed ? " is-collapsed" : ""
        }${instantCollapse ? " thinking-block-collapse--instant" : ""}`}
      >
        <div className="thinking-block-collapse-inner">
          <div className="thinking-block-content" data-quote-source="true">
            {contentMounted && (
              <MarkdownBlock
                className="thinking-block-body"
                content={content}
                streaming={isStreaming}
                paused={isStreaming && contentRenderPaused}
                minRenderIntervalMs={
                  isStreaming ? bodyRenderIntervalMs : undefined
                }
              />
            )}
          </div>
          {/* 底部收起入口：长内容读到末尾时不必再滚回头部，就地收起。
              与 MarkdownBlock 同生命周期挂载，避免收起动画中途高度突变。 */}
          {contentMounted && showFooterButton ? (
            <div className="thinking-block-footer">
              <button
                className="thinking-block-footer-btn"
                type="button"
                title={t("chat.collapse")}
                aria-label={t("chat.collapse")}
                onClick={handleToggleCollapse}
              >
                <ChevronUp size={13} aria-hidden="true" />
                <span>{t("chat.collapse")}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
