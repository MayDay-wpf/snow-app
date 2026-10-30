import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  Loader2,
  MessageCircleQuestion,
  Plus,
  Send,
  Undo2,
  X,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { keyToDisplay } from "../../../../utils/shortcutUtils";
import { ContentChips } from "../../chatInput/ContentChips";
import { TEXT_SNIPPET_THRESHOLD } from "../../chatInput/constants";
import {
  buildTextSnippetSummary,
  createImageChipHtml,
  createTextSnippetChipHtml,
  insertHtmlAtSelection,
  isEditableContentEmpty,
  parseContentSegments,
  readEditableContent,
  summarizeContentAsPlainText,
  type ImageTag,
  type TextSnippetTag,
} from "../../chatInput/fileTagUtils";
import { TextSnippetOverlay } from "../../chatInput/TextSnippetOverlay";
import { useTextSnippetOverlay } from "../../chatInput/useTextSnippetOverlay";
import { useChatConversationContext } from "../components/ChatConversationContext";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolNameBadge } from "./shared/ToolNameBadge";
import { resolveUserQuestionView } from "./shared/userQuestionView";

type AskUserQuestionToolCallProps = {
  toolCall: ToolCallInfo;
  /** panel：嵌在提问 Tab 组内时省略卡片自身 header（组头已给出工具名与进度）。 */
  variant?: "card" | "panel";
  /** 用户提交回答或拒绝回答后回调（Tab 组据此切到下一个未作答的问题）。 */
  onSettled?: () => void;
};

export const AskUserQuestionToolCall = ({
  toolCall,
  variant = "card",
  onSettled,
}: AskUserQuestionToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    answerUserQuestion,
    cancelUserQuestion,
    revertUserQuestion,
    getUserQuestionDraft,
    saveUserQuestionDraft,
    clearUserQuestionDraft,
  } = useChatConversationContext();
  // 展示态判定与提问 Tab 组共用同一份逻辑（见 shared/userQuestionView）。
  const {
    question,
    options,
    questionId,
    questionState,
    parsedResult,
    status,
    isWaitingForRequest,
    isInteractive,
    isRevertable,
  } = useMemo(() => resolveUserQuestionView(toolCall), [toolCall]);
  const isAnswered = status === "answered";
  const isCancelled = status === "cancelled";
  const isInterrupted = status === "interrupted";
  const isPanel = variant === "panel";

  // 交互状态优先从草稿恢复（卡片因会话切换等重挂载后，本地 state 会丢失，
  // 草稿按 questionId 保存在 context 中，由 useEffect 同步兜底恢复）。
  const [selectedOptions, setSelectedOptions] = useState<string[]>(() =>
    questionId ? (getUserQuestionDraft(questionId)?.selectedOptions ?? []) : [],
  );
  const [customAnswers, setCustomAnswers] = useState<string[]>(() =>
    questionId ? (getUserQuestionDraft(questionId)?.customAnswers ?? []) : [],
  );
  // 自定义答案输入框是可编辑富文本：粘贴的图片以 @@image:...@@ chip 与文字
  // 一起提交，序列化结果保存在 customDraft（同时用于提交按钮可用性判定）。
  const [customDraft, setCustomDraft] = useState("");
  const customInputRef = useRef<HTMLDivElement | null>(null);

  const syncCustomDraft = useCallback((): void => {
    const el = customInputRef.current;
    if (!el) {
      return;
    }
    const encoded = readEditableContent(el);
    setCustomDraft(encoded);
    el.dataset.empty = isEditableContentEmpty(encoded) ? "true" : "false";
  }, []);

  // 片段 chip 的悬停预览与点击编辑复用聊天输入框那套能力（同一个 hook 与
  // 浮层组件）；编辑保存 / 删除后回写序列化结果，草稿与提交内容随之更新。
  const snippetOverlay = useTextSnippetOverlay({
    containerRef: customInputRef,
    onChange: syncCustomDraft,
  });

  useEffect(() => {
    const draft = questionId ? getUserQuestionDraft(questionId) : undefined;
    setSelectedOptions(
      draft?.selectedOptions ??
        questionState?.selectedOptions ??
        parsedResult?.selectedOptions ??
        [],
    );
    setCustomAnswers(
      draft?.customAnswers ??
        questionState?.customAnswers ??
        parsedResult?.customAnswers ??
        [],
    );
    if (customInputRef.current) {
      customInputRef.current.innerHTML = "";
      customInputRef.current.dataset.empty = "true";
    }
    setCustomDraft("");
  }, [
    parsedResult?.customAnswers,
    parsedResult?.selectedOptions,
    questionId,
    questionState?.customAnswers,
    questionState?.selectedOptions,
  ]);

  const toggleOption = (option: string): void => {
    if (!isInteractive || !questionId) {
      return;
    }

    const next = selectedOptions.includes(option)
      ? selectedOptions.filter((item) => item !== option)
      : [...selectedOptions, option];
    setSelectedOptions(next);
    saveUserQuestionDraft(questionId, {
      selectedOptions: next,
      customAnswers,
    });
  };

  /**
   * 把光标收进自定义答案输入框末尾：读取图片是异步的、粘贴也可能发生在
   * 编辑区失焦时，selection 此时不在编辑区内，需重置避免 chip 插到别处。
   */
  const focusCustomInputAtEnd = useCallback((): HTMLDivElement | null => {
    const el = customInputRef.current;
    if (!el) {
      return null;
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
    return el;
  }, []);

  /** 把粘贴的图片文件插入自定义答案输入框（chip 与文字一起提交）。 */
  const insertCustomImage = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        if (!dataUrl) {
          return;
        }
        const mimeMatch = file.type.match(/^image\/([a-z0-9+.-]+)$/i);
        const imageTag: ImageTag = {
          name: `image.${mimeMatch ? mimeMatch[1].split("+")[0] : "png"}`,
          dataUrl,
        };
        if (!focusCustomInputAtEnd()) {
          return;
        }
        insertHtmlAtSelection(createImageChipHtml(imageTag));
        syncCustomDraft();
      };
      reader.readAsDataURL(file);
    },
    [focusCustomInputAtEnd, syncCustomDraft],
  );

  const handleCustomPaste = (
    event: React.ClipboardEvent<HTMLDivElement>,
  ): void => {
    if (!isInteractive) {
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
        insertCustomImage(file);
      }
      return;
    }
    // 超长文本粘贴折叠为 text-snippet chip（阈值与聊天输入框一致），
    // 避免 contenteditable 塞入海量文本节点导致渲染卡顿；chip 内容仍会
    // 随自定义答案一起提交给 AI。
    const text = event.clipboardData.getData("text/plain");
    if (text.length <= TEXT_SNIPPET_THRESHOLD) {
      return;
    }
    event.preventDefault();
    if (!focusCustomInputAtEnd()) {
      return;
    }
    const snippetTag: TextSnippetTag = {
      content: text,
      summary: buildTextSnippetSummary(text),
      charCount: text.length,
    };
    insertHtmlAtSelection(createTextSnippetChipHtml(snippetTag));
    syncCustomDraft();
  };

  /**
   * chip 的移除按钮位于编辑区内，需手动摘除并同步序列化结果；点击片段 chip
   * 则打开片段编辑浮层（改内容 / 改摘要 / 删除）。
   */
  const handleCustomClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!isInteractive) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const removeBtn = target?.closest("[data-chip-remove='true']");
    if (removeBtn) {
      event.preventDefault();
      removeBtn.closest(".file-chip")?.remove();
      syncCustomDraft();
      return;
    }
    snippetOverlay.handleChipClick(event);
  };

  const clearCustomInput = (): void => {
    if (customInputRef.current) {
      customInputRef.current.innerHTML = "";
      customInputRef.current.dataset.empty = "true";
    }
    setCustomDraft("");
  };

  const addCustomAnswer = (): void => {
    if (!isInteractive || !questionId) {
      return;
    }

    const value = customDraft.trim();
    if (!value) {
      return;
    }

    const next = customAnswers.includes(value)
      ? customAnswers
      : [...customAnswers, value];
    setCustomAnswers(next);
    clearCustomInput();
    saveUserQuestionDraft(questionId, {
      selectedOptions,
      customAnswers: next,
    });
  };

  const removeCustomAnswer = (answer: string): void => {
    if (!isInteractive || !questionId) {
      return;
    }
    const next = customAnswers.filter((item) => item !== answer);
    setCustomAnswers(next);
    saveUserQuestionDraft(questionId, {
      selectedOptions,
      customAnswers: next,
    });
  };

  const hasPendingCustomAnswer = !isEditableContentEmpty(customDraft);
  const canSubmit =
    isInteractive &&
    (selectedOptions.length + customAnswers.length > 0 ||
      hasPendingCustomAnswer);

  const submitAnswer = (): void => {
    if (!questionState || !canSubmit) {
      return;
    }
    if (questionId) {
      clearUserQuestionDraft(questionId);
    }
    const pending = customDraft.trim();
    answerUserQuestion(
      questionState.questionId,
      selectedOptions,
      pending &&
        !isEditableContentEmpty(customDraft) &&
        !customAnswers.includes(pending)
        ? [...customAnswers, pending]
        : customAnswers,
    );
    onSettled?.();
  };

  /**
   * 自定义答案输入框的 Ctrl/Cmd + Enter：草稿非空时先加入自定义答案列表，
   * 草稿已清空（第二次按下）则直接提交回答，全程无需移动鼠标。
   */
  const handleCustomKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) {
      return;
    }
    const nativeEvent = event.nativeEvent;
    if (
      nativeEvent.isComposing ||
      (nativeEvent as unknown as { keyCode?: number }).keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    if (hasPendingCustomAnswer) {
      addCustomAnswer();
    } else {
      submitAnswer();
    }
  };

  const cancelAnswer = (): void => {
    if (!questionState || !isInteractive) {
      return;
    }
    if (questionId) {
      clearUserQuestionDraft(questionId);
    }
    cancelUserQuestion(questionState.questionId);
    // 拒答与回答同样算结算：Tab 组据此切到下一个未作答的问题，保持操作连贯。
    onSettled?.();
  };

  /**
   * 撤销已提交的回答 / 拒答：仅在结算仍暂存（同一批还有提问未作答、agent loop
   * 尚未续上）时可用，撤销后卡片回到待作答状态，已提交的答案回到草稿中。
   */
  const revertAnswer = (): void => {
    if (!questionState || !isRevertable) {
      return;
    }
    revertUserQuestion(questionState.questionId);
  };

  const statusLabel =
    status === "interrupted"
      ? t("toolCall.userQuestion.status.interrupted")
      : status === "cancelled"
        ? t("toolCall.userQuestion.status.cancelled")
        : status === "answered"
          ? t("toolCall.userQuestion.status.answered")
          : status === "error"
            ? t("toolCall.userQuestion.status.error")
            : t("toolCall.userQuestion.status.waiting");

  return (
    <div
      className={`tool-call-item tool-call-user-question${
        isPanel ? " tool-call-user-question--panel" : ""
      }`}
    >
      {isPanel ? null : (
        <div className="tool-call-header">
          <ToolNameBadge
            name={t("toolCall.userQuestion.name")}
            category="interaction"
          />
          {isInterrupted ? (
            <CircleAlert size={14} aria-hidden="true" />
          ) : isCancelled ? (
            <X size={14} aria-hidden="true" />
          ) : isAnswered ? (
            <Check size={14} aria-hidden="true" />
          ) : isWaitingForRequest || toolCall.status === "running" ? (
            <Loader2
              className="tool-call-icon-spinning"
              size={14}
              aria-hidden="true"
            />
          ) : (
            <MessageCircleQuestion size={14} aria-hidden="true" />
          )}
          <span className="tool-call-name">
            {t("toolCall.userQuestion.action")}
          </span>
          <span
            className={`tool-call-status tool-call-status-${
              isInterrupted || toolCall.status === "error"
                ? "error"
                : isCancelled
                  ? "cancelled"
                  : isAnswered
                    ? "completed"
                    : "running"
            }`}
            role="status"
            aria-live="polite"
          >
            {statusLabel}
          </span>
        </div>
      )}

      <div className="tool-call-body tool-call-user-question-body">
        {question ? (
          <div className="tool-call-user-question-heading">
            <MessageCircleQuestion size={16} aria-hidden="true" />
            <strong>{question}</strong>
          </div>
        ) : null}

        {options.length > 0 ? (
          <div
            className="tool-call-user-question-options"
            aria-label={t("toolCall.userQuestion.optionsLabel")}
          >
            {options.map((option) => {
              const isSelected = selectedOptions.includes(option);
              return (
                <label
                  className={`tool-call-user-question-option ${
                    isSelected ? "is-selected" : ""
                  }`}
                  key={option}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={!isInteractive}
                    onChange={() => toggleOption(option)}
                  />
                  <span>{option}</span>
                </label>
              );
            })}
          </div>
        ) : null}

        <div className="tool-call-user-question-custom">
          <span className="tool-call-user-question-label">
            {t("toolCall.userQuestion.customLabel")}
          </span>
          <div className="tool-call-user-question-custom-form">
            <div
              ref={customInputRef}
              className="tool-call-user-question-custom-input"
              contentEditable={isInteractive}
              role="textbox"
              aria-multiline="true"
              aria-label={t("toolCall.userQuestion.customLabel")}
              data-empty="true"
              data-placeholder={t("toolCall.userQuestion.customPlaceholder")}
              onInput={syncCustomDraft}
              onPaste={handleCustomPaste}
              onClick={handleCustomClick}
              onKeyDown={handleCustomKeyDown}
              onMouseMove={snippetOverlay.showPreview}
              onMouseLeave={snippetOverlay.scheduleHidePreview}
            />
            <button
              type="button"
              disabled={!isInteractive || !hasPendingCustomAnswer}
              aria-label={t("toolCall.userQuestion.addCustom")}
              title={t("toolCall.userQuestion.addCustom")}
              onClick={addCustomAnswer}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>

          {isInteractive ? (
            <span className="tool-call-user-question-hint">
              {t("toolCall.userQuestion.customShortcutHint", {
                values: { keys: keyToDisplay("mod+enter") },
              })}
            </span>
          ) : null}

          {customAnswers.length > 0 ? (
            <div className="tool-call-user-question-custom-list">
              {customAnswers.map((answer) => (
                <span
                  className="tool-call-user-question-custom-item"
                  key={answer}
                >
                  <span className="tool-call-user-question-custom-item-body">
                    <ContentChips segments={parseContentSegments(answer)} />
                  </span>
                  {isInteractive ? (
                    <button
                      type="button"
                      onClick={() => removeCustomAnswer(answer)}
                      aria-label={t("toolCall.userQuestion.removeCustom", {
                        values: { answer: summarizeContentAsPlainText(answer) },
                      })}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {isWaitingForRequest ? (
          <div className="tool-call-user-question-waiting">
            <Loader2
              className="tool-call-icon-spinning"
              size={14}
              aria-hidden="true"
            />
            <span>{t("toolCall.userQuestion.preparing")}</span>
          </div>
        ) : null}

        {toolCall.status === "error" && toolCall.result ? (
          <div className="tool-call-error">
            <span>{toolCall.result}</span>
          </div>
        ) : null}

        <div className="tool-call-user-question-footer">
          <span>
            {isInterrupted
              ? t("toolCall.userQuestion.interruptedHint")
              : isRevertable
                ? t("toolCall.userQuestion.revertHint")
                : isCancelled
                  ? t("toolCall.userQuestion.cancelledHint")
                  : t("toolCall.userQuestion.multiSelectHint")}
          </span>
          <div className="tool-call-user-question-actions">
            {isRevertable ? (
              <button
                type="button"
                className="tool-call-user-question-revert"
                title={t("toolCall.userQuestion.revertHint")}
                onClick={revertAnswer}
              >
                <Undo2 size={14} aria-hidden="true" />
                <span>{t("toolCall.userQuestion.revert")}</span>
              </button>
            ) : null}
            {isInteractive ? (
              <button
                type="button"
                className="tool-call-user-question-cancel"
                onClick={cancelAnswer}
              >
                <X size={14} aria-hidden="true" />
                <span>{t("toolCall.userQuestion.cancel")}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="tool-call-user-question-submit"
              disabled={!canSubmit}
              onClick={submitAnswer}
            >
              {isInterrupted ? (
                <CircleAlert size={14} aria-hidden="true" />
              ) : isCancelled ? (
                <X size={14} aria-hidden="true" />
              ) : isAnswered ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Send size={14} aria-hidden="true" />
              )}
              <span>
                {isInterrupted
                  ? t("toolCall.userQuestion.interrupted")
                  : isCancelled
                    ? t("toolCall.userQuestion.cancelled")
                    : isAnswered
                      ? t("toolCall.userQuestion.submitted")
                      : t("toolCall.userQuestion.submit")}
              </span>
            </button>
          </div>
        </div>
      </div>
      <TextSnippetOverlay overlay={snippetOverlay} />
    </div>
  );
};
