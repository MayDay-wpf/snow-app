import { useCallback, useEffect } from "react";
import type {
  ConversationContextValue,
  UserQuestionRequest,
} from "../utils/conversationTypes";

/**
 * 用户问题交互逻辑：注册 handler、回答/取消问题、拒绝待处理问题。
 * askUserQuestion 以 ToolCallInfo.interactionId 贯通 renderer/preload/main/Rust。
 */
export const useUserQuestion = (ctx: ConversationContextValue) => {
  const {
    directoryId,
    notifyUserInteractionRequired,
    pendingUserQuestionRef,
    sessionsRefData,
    setPendingUserQuestionConversationIds,
    updateSessionMessages,
    userQuestionTargetRef,
  } = ctx;

  const reconcilePendingUserQuestionConversationIds = useCallback((): void => {
    const conversationIds = new Set<string>();
    for (const pending of pendingUserQuestionRef.current.values()) {
      conversationIds.add(pending.sessionKey);
    }
    setPendingUserQuestionConversationIds(conversationIds);
  }, [pendingUserQuestionRef, setPendingUserQuestionConversationIds]);

  // 注册全局 UserQuestion handler，将问题挂到对应工具卡片
  useEffect(() => {
    const unregister = window.snow.registerUserQuestionHandler(
      (request: UserQuestionRequest): Promise<string> => {
        const target = userQuestionTargetRef.current.get(request.interactionId);
        if (!target) {
          return Promise.reject(
            new Error("No active tool call matches this user question")
          );
        }

        updateSessionMessages(target.sessionKey, (currentMessages) =>
          currentMessages.map((message) => {
            if (message.id !== target.assistantMessageId) {
              return message;
            }

            return {
              ...message,
              toolCalls: message.toolCalls?.map((toolCall) =>
                toolCall.interactionId === request.interactionId
                  ? {
                      ...toolCall,
                      userQuestion: {
                        questionId: request.questionId,
                        question: request.question,
                        options: request.options,
                        status: "waiting" as const,
                        selectedOptions: [],
                        customAnswers: [],
                      },
                    }
                  : toolCall
              ),
            };
          })
        );

        // 通知系统：用户交互工具需要用户回答时触发系统通知
        notifyUserInteractionRequired({
          conversationId: target.sessionKey,
          directoryId:
            sessionsRefData.current.get(target.sessionKey)?.directoryId ??
            directoryId,
          reason: request.question,
        });

        return new Promise<string>((resolve, reject) => {
          pendingUserQuestionRef.current.set(request.questionId, {
            sessionKey: target.sessionKey,
            interactionId: request.interactionId,
            resolve,
            reject,
          });
          reconcilePendingUserQuestionConversationIds();
        });
      }
    );

    return () => {
      unregister();
      for (const pending of pendingUserQuestionRef.current.values()) {
        pending.reject(new Error("User question handler was disposed"));
      }
      pendingUserQuestionRef.current.clear();
      reconcilePendingUserQuestionConversationIds();
      userQuestionTargetRef.current.clear();
    };
  }, [
    directoryId,
    notifyUserInteractionRequired,
    pendingUserQuestionRef,
    reconcilePendingUserQuestionConversationIds,
    sessionsRefData,
    updateSessionMessages,
    userQuestionTargetRef,
  ]);

  const settleUserQuestion = useCallback(
    (
      questionId: string,
      cancelled: boolean,
      selectedOptions: string[],
      customAnswers: string[]
    ): void => {
      const pending = pendingUserQuestionRef.current.get(questionId);
      if (!pending) {
        return;
      }

      const normalizeAnswers = (values: string[]): string[] =>
        Array.from(
          new Set(values.map((value) => value.trim()).filter(Boolean))
        );
      const normalizedSelected = cancelled
        ? []
        : normalizeAnswers(selectedOptions);
      const normalizedCustom = cancelled ? [] : normalizeAnswers(customAnswers);
      const answers = normalizeAnswers([
        ...normalizedSelected,
        ...normalizedCustom,
      ]);
      if (!cancelled && answers.length === 0) {
        return;
      }

      const target = userQuestionTargetRef.current.get(pending.interactionId);
      if (target) {
        updateSessionMessages(target.sessionKey, (currentMessages) =>
          currentMessages.map((message) => {
            if (message.id !== target.assistantMessageId) {
              return message;
            }

            return {
              ...message,
              toolCalls: message.toolCalls?.map((toolCall) =>
                toolCall.interactionId === pending.interactionId &&
                toolCall.userQuestion?.questionId === questionId
                  ? {
                      ...toolCall,
                      userQuestion: {
                        ...toolCall.userQuestion,
                        status: cancelled
                          ? ("cancelled" as const)
                          : ("answered" as const),
                        selectedOptions: normalizedSelected,
                        customAnswers: normalizedCustom,
                      },
                    }
                  : toolCall
              ),
            };
          })
        );
      }

      pendingUserQuestionRef.current.delete(questionId);
      reconcilePendingUserQuestionConversationIds();
      userQuestionTargetRef.current.delete(pending.interactionId);
      pending.resolve(
        JSON.stringify({
          cancelled,
          answers,
          selectedOptions: normalizedSelected,
          customAnswers: normalizedCustom,
        })
      );
    },
    [
      pendingUserQuestionRef,
      reconcilePendingUserQuestionConversationIds,
      updateSessionMessages,
      userQuestionTargetRef,
    ]
  );

  const answerUserQuestion = useCallback(
    (
      questionId: string,
      selectedOptions: string[],
      customAnswers: string[]
    ): void => {
      settleUserQuestion(questionId, false, selectedOptions, customAnswers);
    },
    [settleUserQuestion]
  );

  const cancelUserQuestion = useCallback(
    (questionId: string): void => {
      settleUserQuestion(questionId, true, [], []);
    },
    [settleUserQuestion]
  );

  const rejectPendingUserQuestions = useCallback(
    (sessionKey?: string): void => {
      for (const [questionId, pending] of pendingUserQuestionRef.current) {
        if (sessionKey && pending.sessionKey !== sessionKey) {
          continue;
        }

        pending.reject(new Error("User question interrupted"));
        pendingUserQuestionRef.current.delete(questionId);
        userQuestionTargetRef.current.delete(pending.interactionId);
      }
      reconcilePendingUserQuestionConversationIds();
    },
    [
      pendingUserQuestionRef,
      reconcilePendingUserQuestionConversationIds,
      userQuestionTargetRef,
    ]
  );

  return {
    settleUserQuestion,
    answerUserQuestion,
    cancelUserQuestion,
    rejectPendingUserQuestions,
  };
};
