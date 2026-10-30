import { useCallback, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  buildTextSnippetSummary,
  createTextSnippetChipHtml,
  type TextSnippetTag,
} from "./fileTagUtils";

/** 片段 chip 悬停预览浮层状态（x/y 为浮层锚点，按 chip 位置居中并做视口钳制）。 */
export type TextSnippetPreviewState = {
  content: string;
  summary: string;
  x: number;
  y: number;
};

/** 片段 chip 编辑浮层状态；chip 为保存后要替换回去的编辑区节点。 */
export type TextSnippetEditorState = {
  chip: HTMLElement;
  content: string;
  summary: string;
};

/** 预览浮层宽度（与 styles.css 的 .text-snippet-preview max-width 一致），用于水平定位钳制。 */
const PREVIEW_MAX_WIDTH = 440;
/** 预览隐藏延迟：给鼠标从 chip 移入浮层留缓冲。 */
const PREVIEW_HIDE_DELAY_MS = 200;

type UseTextSnippetOverlayOptions = {
  /** 承载片段 chip 的可编辑区；只有落在其中的 chip 才响应点击编辑。 */
  containerRef: RefObject<HTMLElement | null>;
  /** chip 内容变化（编辑保存 / 删除）后同步编辑区的序列化内容。 */
  onChange: () => void;
};

export type TextSnippetOverlayApi = {
  preview: TextSnippetPreviewState | null;
  editor: TextSnippetEditorState | null;
  setEditor: Dispatch<SetStateAction<TextSnippetEditorState | null>>;
  /** 悬停移动：命中片段 chip 时展示原文预览，否则延迟收起（留出移入浮层的时间）。 */
  showPreview: (event: React.MouseEvent<HTMLElement>) => void;
  /** 指针离开编辑区：延迟收起预览（留出移入浮层的时间）。 */
  scheduleHidePreview: () => void;
  /** 指针移入浮层：取消待执行的收起。 */
  cancelHidePreview: () => void;
  /** 点击：命中片段 chip 时打开片段编辑弹窗。 */
  handleChipClick: (event: React.MouseEvent<HTMLElement>) => void;
  /** 保存编辑内容并回写 chip。 */
  saveEditor: () => void;
  /** 删除 chip 并关闭编辑弹窗。 */
  deleteEditor: () => void;
};

/**
 * 片段（text-snippet）chip 的悬停预览与点击编辑能力。
 *
 * 与具体输入框解耦：调用方给出承载 chip 的可编辑区与「内容变化后如何同步」
 * 的回调，即可获得悬停预览原文、点击打开编辑弹窗（改内容 / 改摘要 / 删除）
 * 的完整交互；浮层 UI 由 TextSnippetOverlay 渲染。
 */
export const useTextSnippetOverlay = ({
  containerRef,
  onChange,
}: UseTextSnippetOverlayOptions): TextSnippetOverlayApi => {
  const [preview, setPreview] = useState<TextSnippetPreviewState | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editor, setEditor] = useState<TextSnippetEditorState | null>(null);

  /** 清掉待执行的收起并立即隐藏预览（数据异常时使用）。 */
  const clearPreview = useCallback(() => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    setPreview(null);
  }, []);

  /**
   * 延迟收起预览：给鼠标从 chip 移入浮层留出缓冲（移入后由浮层的
   * onMouseEnter 取消）。重复调用只保留最后一个计时器 —— 否则「离开 chip →
   * 移入浮层」途中的多次 mousemove 会留下多个计时器，取消时只清得掉最后一个，
   * 旧的仍会到点把浮层收掉。
   */
  const scheduleHidePreview = useCallback(() => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
    }
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null;
      setPreview(null);
    }, PREVIEW_HIDE_DELAY_MS);
  }, []);

  const cancelHidePreview = useCallback(() => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }, []);

  const showPreview = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-text-snippet-tag='true']",
      ) as HTMLElement | null;
      if (!chip) {
        // 悬停点不在片段 chip 上（含从 chip 移向浮层时经过的编辑区空白）：
        // 走延迟收起，给鼠标留出移入浮层继续滚动阅读的缓冲，而不是立即收起。
        scheduleHidePreview();
        return;
      }
      const rawData = chip.dataset.textSnippetData;
      if (!rawData) {
        clearPreview();
        return;
      }
      let parsed: { content?: string; summary?: string };
      try {
        parsed = JSON.parse(rawData) as { content?: string; summary?: string };
      } catch {
        clearPreview();
        return;
      }
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
      const rect = chip.getBoundingClientRect();
      const halfW = PREVIEW_MAX_WIDTH / 2;
      const clampedX = Math.max(
        halfW + 4,
        Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4),
      );
      setPreview({
        content: parsed.content ?? "",
        summary: parsed.summary ?? "text",
        x: clampedX,
        y: rect.top,
      });
    },
    [clearPreview, scheduleHidePreview],
  );

  const handleChipClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-chip-remove='true']")) {
        return;
      }
      const chip = target.closest(
        "[data-text-snippet-tag='true']",
      ) as HTMLElement | null;
      if (!chip || !containerRef.current?.contains(chip)) {
        return;
      }
      const rawData = chip.dataset.textSnippetData;
      if (!rawData) {
        return;
      }
      try {
        const parsed = JSON.parse(rawData) as {
          content?: string;
          summary?: string;
        };
        setEditor({
          chip,
          content: parsed.content ?? "",
          summary:
            parsed.summary ?? buildTextSnippetSummary(parsed.content ?? ""),
        });
      } catch {
        // Ignore malformed data
      }
    },
    [containerRef],
  );

  const saveEditor = useCallback(() => {
    if (!editor) {
      return;
    }
    const { chip, content, summary } = editor;
    const trimmedSummary = summary.trim() || buildTextSnippetSummary(content);
    const tag: TextSnippetTag = {
      content,
      summary: trimmedSummary,
      charCount: content.length,
    };
    const fragment = document
      .createRange()
      .createContextualFragment(createTextSnippetChipHtml(tag));
    const newChip = fragment.firstChild as HTMLElement | null;
    if (newChip) {
      chip.replaceWith(newChip);
    }
    setEditor(null);
    onChange();
  }, [editor, onChange]);

  const deleteEditor = useCallback(() => {
    if (!editor) {
      return;
    }
    editor.chip.remove();
    setEditor(null);
    onChange();
  }, [editor, onChange]);

  return {
    preview,
    editor,
    setEditor,
    showPreview,
    scheduleHidePreview,
    cancelHidePreview,
    handleChipClick,
    saveEditor,
    deleteEditor,
  };
};
