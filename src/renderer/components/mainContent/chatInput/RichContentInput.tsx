import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { TEXT_SNIPPET_THRESHOLD } from "./constants";
import {
  buildTextSnippetSummary,
  createImageChipHtml,
  createTextSnippetChipHtml,
  insertHtmlAtSelection,
  isEditableContentEmpty,
  readEditableContent,
  type ImageTag,
  type TextSnippetTag,
} from "./fileTagUtils";
import { TextSnippetOverlay } from "./TextSnippetOverlay";
import { useTextSnippetOverlay } from "./useTextSnippetOverlay";

/** 富文本输入框的命令式句柄（读取 / 清空 / 聚焦编辑区）。 */
export type RichContentInputHandle = {
  /** 读取编辑区当前的序列化内容（含 chip 标签）。 */
  getContent: () => string;
  /** 清空编辑区（含空态标记复位），并按空内容回调 onChange。 */
  clear: () => void;
  /** 聚焦编辑区并把光标收到末尾（粘贴图片等异步插入前调用）。 */
  focusAtEnd: () => void;
};

type RichContentInputProps = {
  /** 编辑区样式类：各调用方的输入框外观不同（边框、背景、字号）。 */
  className: string;
  /** 空态占位文本（经 data-placeholder 由样式渲染）。 */
  placeholder: string;
  /** 无障碍名称。 */
  ariaLabel: string;
  /** 只读态：不可编辑，也不响应粘贴与 chip 交互。 */
  disabled?: boolean;
  /** 序列化内容变化（输入、粘贴、chip 移除 / 片段编辑保存）。 */
  onChange: (content: string) => void;
  /** 键盘事件（如 Ctrl/Cmd + Enter 提交），语义由调用方决定。 */
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
};

/**
 * 支持粘贴图片与超长文本的轻量富文本输入框。
 *
 * 与聊天输入框共用同一套 chip 能力：粘贴的图片以 `@@image:...@@` chip 承载，
 * 超过阈值的长文本折叠为 `@@text-snippet:...@@` chip（避免 contenteditable
 * 塞入海量文本节点导致渲染卡顿），chip 可移除、片段 chip 可悬停预览与点击编辑。
 * 编辑区内容始终以序列化字符串回调给调用方，提交时连同 chip 一起交给下游
 * （消息内容 / 工具结果）。
 */
export const RichContentInput = forwardRef<
  RichContentInputHandle,
  RichContentInputProps
>(function RichContentInput(
  { className, placeholder, ariaLabel, disabled = false, onChange, onKeyDown },
  ref,
): React.JSX.Element {
  const inputRef = useRef<HTMLDivElement | null>(null);

  const syncContent = useCallback((): void => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    const encoded = readEditableContent(el);
    el.dataset.empty = isEditableContentEmpty(encoded) ? "true" : "false";
    onChange(encoded);
  }, [onChange]);

  // 片段 chip 的悬停预览与点击编辑复用聊天输入框那套能力（同一个 hook 与浮层组件）；
  // 编辑保存 / 删除后回写序列化内容，调用方的草稿与提交内容随之更新。
  const snippetOverlay = useTextSnippetOverlay({
    containerRef: inputRef,
    onChange: syncContent,
  });

  /**
   * 把光标收进编辑区末尾：读取图片是异步的、粘贴也可能发生在编辑区失焦时，
   * selection 此时不在编辑区内，需重置避免 chip 插到别处。
   */
  const focusAtEnd = useCallback((): void => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.focus();
    const selection = window.getSelection();
    const anchor = selection?.rangeCount
      ? selection.getRangeAt(0).startContainer
      : null;
    if (selection && (!anchor || !el.contains(anchor))) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, []);

  const clear = useCallback((): void => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.innerHTML = "";
    el.dataset.empty = "true";
    onChange("");
  }, [onChange]);

  useImperativeHandle(
    ref,
    () => ({
      getContent: () =>
        inputRef.current ? readEditableContent(inputRef.current) : "",
      clear,
      focusAtEnd,
    }),
    [clear, focusAtEnd],
  );

  /** 把粘贴的图片文件插入编辑区（chip 与文字一起提交）。 */
  const insertImage = useCallback(
    (file: File): void => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        if (!dataUrl || !inputRef.current) {
          return;
        }
        const mimeMatch = file.type.match(/^image\/([a-z0-9+.-]+)$/i);
        const imageTag: ImageTag = {
          name: `image.${mimeMatch ? mimeMatch[1].split("+")[0] : "png"}`,
          dataUrl,
        };
        focusAtEnd();
        insertHtmlAtSelection(createImageChipHtml(imageTag));
        syncContent();
      };
      reader.readAsDataURL(file);
    },
    [focusAtEnd, syncContent],
  );

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    if (disabled) {
      return;
    }
    const imageFiles: File[] = [];
    for (const item of event.clipboardData.items) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) {
        continue;
      }
      const file = item.getAsFile();
      if (file) {
        imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      event.preventDefault();
      for (const file of imageFiles) {
        insertImage(file);
      }
      return;
    }
    // 超长文本粘贴折叠为 text-snippet chip（阈值与聊天输入框一致）；chip 内容
    // 仍会随序列化结果一起提交，只是编辑区不再渲染海量文本节点。
    const text = event.clipboardData.getData("text/plain");
    if (text.length <= TEXT_SNIPPET_THRESHOLD) {
      return;
    }
    event.preventDefault();
    if (!inputRef.current) {
      return;
    }
    focusAtEnd();
    const snippetTag: TextSnippetTag = {
      content: text,
      summary: buildTextSnippetSummary(text),
      charCount: text.length,
    };
    insertHtmlAtSelection(createTextSnippetChipHtml(snippetTag));
    syncContent();
  };

  /**
   * chip 的移除按钮位于编辑区内，需手动摘除并同步序列化结果；点击片段 chip
   * 则打开片段编辑浮层（改内容 / 改摘要 / 删除）。
   */
  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (disabled) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const removeBtn = target?.closest("[data-chip-remove='true']");
    if (removeBtn) {
      event.preventDefault();
      removeBtn.closest(".file-chip")?.remove();
      syncContent();
      return;
    }
    snippetOverlay.handleChipClick(event);
  };

  return (
    <>
      <div
        ref={inputRef}
        className={className}
        contentEditable={!disabled}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-empty="true"
        data-placeholder={placeholder}
        onInput={syncContent}
        onPaste={handlePaste}
        onClick={handleClick}
        onKeyDown={onKeyDown}
        onMouseMove={snippetOverlay.showPreview}
        onMouseLeave={snippetOverlay.scheduleHidePreview}
      />
      <TextSnippetOverlay overlay={snippetOverlay} />
    </>
  );
});
