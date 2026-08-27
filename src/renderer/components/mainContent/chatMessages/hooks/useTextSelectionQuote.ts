import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";

export type SelectionQuoteState = {
  /** 划词原文（已去除首尾空白） */
  text: string;
  /** 浮层 left（视口坐标） */
  x: number;
  /** 浮层 top（视口坐标） */
  y: number;
};

// 少于该字符数的选区不触发浮层，避免双击单词外的误触
const MIN_QUOTE_LENGTH = 2;
const POPUP_WIDTH = 136;
const POPUP_HEIGHT = 32;
const VIEWPORT_MARGIN = 8;
// 浮层与锚点（光标 / 选区末行 / 鼠标）的间距
const ANCHOR_GAP = 8;

/** 判断节点是否位于容器的划词来源区（data-quote-source 标记的元素）内。 */
const isInsideQuoteSource = (
  container: HTMLElement,
  node: Node | null,
): boolean => {
  let cursor: Element | null =
    node instanceof Element ? node : (node?.parentElement ?? null);
  while (cursor && cursor !== container) {
    if (cursor.hasAttribute("data-quote-source")) {
      return true;
    }
    cursor = cursor.parentElement;
  }
  return false;
};

/**
 * 聊天区划词引用：监听容器内选区变化（mouseup），当选区落在
 * data-quote-source 标记的内容区且有效时，提供一枚定位到光标处的
 * 「添加到输入框」浮层状态；滚动 / 点击别处 / Escape 时自动隐藏。
 *
 * 事件统一挂在本容器对应的单实例上，由 ChatContent 挂载，
 * 无需每个消息组件重复注册。
 */
export const useTextSelectionQuote = (
  containerRef: RefObject<HTMLElement | null>,
): {
  quoteState: SelectionQuoteState | null;
  dismissQuote: () => void;
} => {
  const [quoteState, setQuoteState] = useState<SelectionQuoteState | null>(
    null,
  );

  const dismissQuote = useCallback(() => setQuoteState(null), []);

  useEffect(() => {
    // mouseup 后浏览器已确定最终选区：校验来源与长度并计算浮层位置。
    const handleMouseUp = (event: MouseEvent): void => {
      const container = containerRef.current;
      const selection = window.getSelection();
      if (!container || !selection || selection.isCollapsed) {
        setQuoteState(null);
        return;
      }
      if (selection.rangeCount === 0 || !selection.focusNode) {
        setQuoteState(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const text = selection
        .toString()
        .replace(/\u200B/g, "")
        .trim();
      if (
        !text ||
        text.length < MIN_QUOTE_LENGTH ||
        !container.contains(range.commonAncestorContainer) ||
        !isInsideQuoteSource(container, range.startContainer) ||
        !isInsideQuoteSource(container, range.endContainer)
      ) {
        setQuoteState(null);
        return;
      }

      // 定位锚点优先级：光标矩形 > 选区末行矩形 > 鼠标松开坐标。
      // 折叠 Range 在行边界 / 未渲染节点等场景可能返回全零矩形，
      // 必须逐级兜底，保证浮层始终出现在划词结束位置附近。
      let x = event.clientX + ANCHOR_GAP;
      let y = event.clientY + ANCHOR_GAP;
      let flipAnchorY: number | null = null;
      try {
        const caretRange = document.createRange();
        caretRange.setStart(selection.focusNode, selection.focusOffset);
        caretRange.collapse(true);
        let rect = caretRange.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          const lineRects = range.getClientRects();
          if (lineRects.length > 0) {
            rect = lineRects[lineRects.length - 1];
          }
        }
        const hasRect = !(
          rect.width === 0 &&
          rect.height === 0 &&
          rect.top === 0
        );
        if (hasRect) {
          x = rect.left;
          y = rect.bottom + ANCHOR_GAP;
          flipAnchorY = rect.top;
        }
      } catch {
        // 无效选区节点时保留鼠标坐标兜底
      }

      const clampedX = Math.min(
        Math.max(VIEWPORT_MARGIN, x),
        window.innerWidth - POPUP_WIDTH - VIEWPORT_MARGIN,
      );
      let clampedY = Math.max(VIEWPORT_MARGIN, y);
      // 下方放不下时翻到锚点上方显示
      if (clampedY + POPUP_HEIGHT > window.innerHeight - VIEWPORT_MARGIN) {
        clampedY = Math.max(
          VIEWPORT_MARGIN,
          (flipAnchorY ?? event.clientY) - POPUP_HEIGHT - ANCHOR_GAP,
        );
      }
      setQuoteState({ text, x: clampedX, y: clampedY });
    };

    // 捕获阶段的 mousedown：点击浮层以外任何位置即取消。
    const handleMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-quote-popup]")) {
        return;
      }
      setQuoteState(null);
    };

    // 浮层是 fixed 定位：任何滚动（含 Thinking 等嵌套滚动容器）都会错位，
    // 直接隐藏，下次 mouseup 再重新计算。
    const hide = (): void => setQuoteState(null);

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);

    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [containerRef]);

  return { quoteState, dismissQuote };
};
