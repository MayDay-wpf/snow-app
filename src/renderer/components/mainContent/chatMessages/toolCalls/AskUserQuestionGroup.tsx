import { useCallback, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleX,
  X,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { AskUserQuestionToolCall } from "./AskUserQuestionToolCall";
import { ToolNameBadge } from "./shared/ToolNameBadge";
import {
  resolveUserQuestionView,
  type UserQuestionStatus,
  type UserQuestionView,
} from "./shared/userQuestionView";
import type { ToolCallInfo } from "../utils/conversationTypes";

type AskUserQuestionGroupProps = {
  toolCalls: ToolCallInfo[];
};

type QuestionEntry = {
  /** questionId 为主键；题目尚未下发时退化为 interactionId。 */
  key: string;
  toolCall: ToolCallInfo;
  view: UserQuestionView;
};

/** Tab 状态标记：已回答 / 已取消 / 已中断 / 失败用图标，等待中用脉冲点。 */
const statusMark = (status: UserQuestionStatus): React.JSX.Element => {
  switch (status) {
    case "answered":
      return <Check size={12} aria-hidden="true" />;
    case "cancelled":
      return <X size={12} aria-hidden="true" />;
    case "interrupted":
      return <CircleAlert size={12} aria-hidden="true" />;
    case "error":
      return <CircleX size={12} aria-hidden="true" />;
    default:
      return <span className="auqg-tab-pulse" aria-hidden="true" />;
  }
};

/**
 * 同一轮内相邻的多个提问合并为一个 Tab 容器：一次只显示一个问题面板，
 * 作答 / 草稿 / 取消 / 中断全部复用 AskUserQuestionToolCall（variant="panel"）。
 */
export const AskUserQuestionGroup = ({
  toolCalls,
}: AskUserQuestionGroupProps): React.JSX.Element => {
  const { t } = useI18n();
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const questions = useMemo<QuestionEntry[]>(
    () =>
      toolCalls.map((toolCall) => {
        const view = resolveUserQuestionView(toolCall);
        return {
          key: view.questionId ?? toolCall.interactionId,
          toolCall,
          view,
        };
      }),
    [toolCalls],
  );

  // null = 自动跟随（停在第一个未回答的问题）：新问题到达只更新 Tab 状态，
  // 不抢走用户当前作答 / 阅读的位置。
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const firstWaitingIndex = questions.findIndex(
    (entry) => entry.view.status === "waiting",
  );
  const selectedIndex = activeKey
    ? questions.findIndex((entry) => entry.key === activeKey)
    : -1;
  const activeIndex =
    selectedIndex >= 0 ? selectedIndex : Math.max(0, firstWaitingIndex);
  const isAllSettled = firstWaitingIndex < 0;

  const activate = useCallback(
    (index: number, focus = false): void => {
      const entry = questions[index];
      if (!entry) {
        return;
      }
      setActiveKey(entry.key);
      if (focus) {
        tabRefs.current[index]?.focus();
      }
    },
    [questions],
  );

  const step = useCallback(
    (delta: number): void => {
      const count = questions.length;
      if (count === 0) {
        return;
      }
      activate((activeIndex + delta + count) % count, true);
    },
    [activate, activeIndex, questions.length],
  );

  const handleTabsKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    }
  };

  // 回答与拒答都算结算：切到下一个待作答的问题（其后没有则回到组内第一个
  // 待作答的）；全组已无待作答时停在当前题的终态以便回看。
  const handleSettled = useCallback(
    (key: string): void => {
      const currentIndex = questions.findIndex((entry) => entry.key === key);
      const nextIndex = questions.findIndex(
        (entry, index) =>
          index > currentIndex && entry.view.status === "waiting",
      );
      const firstWaitingIndex = questions.findIndex(
        (entry) => entry.view.status === "waiting",
      );
      const targetIndex = nextIndex >= 0 ? nextIndex : firstWaitingIndex;
      const target = questions[targetIndex >= 0 ? targetIndex : currentIndex];
      setActiveKey(target ? target.key : null);
    },
    [questions],
  );

  const previousLabel = t("toolCall.userQuestion.group.previous");
  const nextLabel = t("toolCall.userQuestion.group.next");

  return (
    <div className="tool-call-item tool-call-user-question-group">
      <div className="auqg-head">
        <ToolNameBadge
          name={t("toolCall.userQuestion.name")}
          category="interaction"
        />
        <span className="auqg-progress">
          {t("toolCall.userQuestion.group.progress", {
            values: { current: activeIndex + 1, total: questions.length },
          })}
        </span>
        {isAllSettled ? (
          <span className="auqg-settled">
            <Check size={12} aria-hidden="true" />
            <span>{t("toolCall.userQuestion.group.allSettled")}</span>
          </span>
        ) : null}
      </div>

      <div className="auqg-tabs">
        <div
          className="auqg-tabstrip"
          role="tablist"
          aria-label={t("toolCall.userQuestion.group.tabsLabel")}
          onKeyDown={handleTabsKeyDown}
        >
          {questions.map((entry, index) => {
            const isActive = index === activeIndex;
            const label =
              entry.view.question ||
              t("toolCall.userQuestion.group.fallbackLabel", {
                values: { index: index + 1 },
              });
            const statusLabel = t(
              `toolCall.userQuestion.status.${entry.view.status}`,
            );
            return (
              <button
                type="button"
                role="tab"
                key={entry.key}
                id={`${baseId}-tab-${index}`}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                className={`auqg-tab${isActive ? " is-active" : ""}`}
                aria-selected={isActive}
                aria-controls={`${baseId}-panel-${index}`}
                tabIndex={isActive ? 0 : -1}
                title={`${label} — ${statusLabel}`}
                onClick={() => activate(index)}
              >
                <span className="auqg-tab-index">
                  {t("toolCall.userQuestion.group.tabIndex", {
                    values: { index: index + 1 },
                  })}
                </span>
                <span className="auqg-tab-label">{label}</span>
                <span
                  className={`auqg-tab-status auqg-tab-status--${entry.view.status}`}
                  title={statusLabel}
                  aria-label={statusLabel}
                >
                  {statusMark(entry.view.status)}
                </span>
              </button>
            );
          })}
        </div>
        <span className="auqg-nav">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label={previousLabel}
            title={previousLabel}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label={nextLabel}
            title={nextLabel}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </span>
      </div>

      <div className="auqg-panels">
        {questions.map((entry, index) => (
          <div
            key={entry.key}
            id={`${baseId}-panel-${index}`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-${index}`}
            className="auqg-panel"
            hidden={index !== activeIndex}
          >
            <AskUserQuestionToolCall
              toolCall={entry.toolCall}
              variant="panel"
              onSettled={() => handleSettled(entry.key)}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

AskUserQuestionGroup.displayName = "AskUserQuestionGroup";
