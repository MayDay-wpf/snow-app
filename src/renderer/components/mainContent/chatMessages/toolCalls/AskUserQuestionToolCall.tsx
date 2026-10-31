import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  isEditableContentEmpty,
  parseContentSegments,
  summarizeContentAsPlainText,
} from "../../chatInput/fileTagUtils";
import {
  RichContentInput,
  type RichContentInputHandle,
} from "../../chatInput/RichContentInput";
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
  // 自定义答案输入框是可编辑富文本（RichContentInput）：粘贴的图片以
  // @@image:...@@ chip、超长文本折叠为 @@text-snippet:...@@ chip，与文字一起
  // 提交；序列化结果保存在 customDraft（同时用于提交按钮可用性判定）。
  const [customDraft, setCustomDraft] = useState("");
  const customInputRef = useRef<RichContentInputHandle | null>(null);

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
    // clear 会按空内容回调，customDraft 随之复位。
    customInputRef.current?.clear();
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
    customInputRef.current?.clear();
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
            <RichContentInput
              ref={customInputRef}
              className="tool-call-user-question-custom-input"
              placeholder={t("toolCall.userQuestion.customPlaceholder")}
              ariaLabel={t("toolCall.userQuestion.customLabel")}
              disabled={!isInteractive}
              onChange={setCustomDraft}
              onKeyDown={handleCustomKeyDown}
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
    </div>
  );
};
