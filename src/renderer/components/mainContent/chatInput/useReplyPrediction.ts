import { useCallback, useEffect, useRef, useState } from "react";
import { useReplyPredictionPreference } from "../../../hooks/useReplyPredictionPreference";
import {
  dropPrediction,
  readPrediction,
  subscribePrediction,
} from "./replyPredictionStore";

type UseReplyPredictionOptions = {
  conversationId: string | null;
  isStreaming: boolean;
  /** 子代理会话等不支持预测的场景。 */
  disabled: boolean;
  value: string;
};

/**
 * 展示会话池中的回复预测；预测由回合结束统一调度（见 replyPredictionStore），
 * 后台会话的预测在切回时恢复。用户输入即清除，Tab 由调用方采用。
 */
export const useReplyPrediction = ({
  conversationId,
  isStreaming,
  disabled,
  value,
}: UseReplyPredictionOptions): {
  prediction: string | null;
  consumePrediction: () => string | null;
} => {
  const { replyPredictionEnabled } = useReplyPredictionPreference();
  // 初始为空：恢复放在 effect 里，与输入草稿的恢复同批提交，避免有草稿的
  // 会话切回时先闪一帧预测再被草稿盖住。
  const [prediction, setPrediction] = useState<string | null>(null);
  const isEmpty = value.trim().length === 0;
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const active =
    replyPredictionEnabled && !disabled && !isStreaming && !!conversationId;
  const activeRef = useRef(active);
  activeRef.current = active;

  /** 丢弃当前会话的预测：内存态与池同时清除。 */
  const clearPrediction = useCallback((): void => {
    setPrediction(null);
    dropPrediction(conversationIdRef.current);
  }, []);

  // 挂载或会话标识变化而实例未重建时（pending 槽位迁移为真实 ID），
  // 恢复目标会话留存的预测。
  useEffect(() => {
    setPrediction(readPrediction(conversationId));
  }, [conversationId]);

  useEffect(() => {
    if (!active) {
      clearPrediction();
    }
  }, [active, clearPrediction]);

  useEffect(() => {
    if (!isEmpty) {
      clearPrediction();
    }
  }, [isEmpty, clearPrediction]);

  // 当前会话的预测在挂载期间产出时直接显示。
  useEffect(
    () =>
      subscribePrediction((id, text) => {
        if (id !== conversationIdRef.current) {
          return;
        }
        setPrediction(
          text && activeRef.current && isEmptyRef.current ? text : null,
        );
      }),
    [],
  );

  const consumePrediction = useCallback((): string | null => {
    const text = prediction;
    clearPrediction();
    return text;
  }, [prediction, clearPrediction]);

  return { prediction: isEmpty ? prediction : null, consumePrediction };
};
