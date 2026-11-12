import { isReplyPredictionEnabled } from "../../../hooks/useReplyPredictionPreference";

/** 回合结束后等待落库再请求，避免读到不完整历史。 */
const PREDICTION_DELAY_MS = 800;
/** 会话级预测池上限：只保留最近若干会话，长期运行也不会无限增长。 */
const PREDICTION_POOL_LIMIT = 64;

/**
 * 会话级预测缓存（conversationId -> 预测文本）。调度与会话是否在前台无关：
 * 后台会话跑完同样预测并存入池，切回且输入框为空时由输入区恢复显示。
 */
const predictionPool = new Map<string, string>();

type PredictionListener = (conversationId: string, text: string | null) => void;
const listeners = new Set<PredictionListener>();

type PendingTask = { timer: number | null; requestId: string | null };
const pendingTasks = new Map<string, PendingTask>();

export const readPrediction = (conversationId: string | null): string | null =>
  conversationId ? (predictionPool.get(conversationId) ?? null) : null;

const writePrediction = (conversationId: string, text: string): void => {
  predictionPool.delete(conversationId);
  predictionPool.set(conversationId, text);
  while (predictionPool.size > PREDICTION_POOL_LIMIT) {
    const oldest = predictionPool.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    predictionPool.delete(oldest);
  }
};

export const dropPrediction = (conversationId: string | null): void => {
  if (conversationId) {
    predictionPool.delete(conversationId);
  }
};

const emit = (conversationId: string, text: string | null): void => {
  listeners.forEach((listener) => listener(conversationId, text));
};

/** 订阅预测结果（text 为 null 表示该会话预测已作废）。 */
export const subscribePrediction = (
  listener: PredictionListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const cancelPending = (conversationId: string): void => {
  const task = pendingTasks.get(conversationId);
  if (!task) {
    return;
  }
  pendingTasks.delete(conversationId);
  if (task.timer !== null) {
    window.clearTimeout(task.timer);
  }
  if (task.requestId) {
    void window.snow.abortReplyPrediction(task.requestId).catch(() => {});
  }
};

/** 新一轮开始：取消进行中的预测并清除旧预测。 */
export const discardReplyPrediction = (conversationId: string): void => {
  cancelPending(conversationId);
  if (predictionPool.delete(conversationId)) {
    emit(conversationId, null);
  }
};

type ScheduleReplyPredictionOptions = {
  conversationId: string;
  apiProfile?: string;
  /** 请求前与结果返回时各校验一次：会话空闲、末条为正常助手回复、输入框为空。 */
  canPredict: () => boolean;
};

/** 回合结束后调度一次预测，结果写入会话池并广播。 */
export const scheduleReplyPrediction = ({
  conversationId,
  apiProfile,
  canPredict,
}: ScheduleReplyPredictionOptions): void => {
  cancelPending(conversationId);
  if (!isReplyPredictionEnabled()) {
    return;
  }
  const task: PendingTask = { timer: null, requestId: null };
  const isCurrent = (): boolean => pendingTasks.get(conversationId) === task;
  pendingTasks.set(conversationId, task);
  task.timer = window.setTimeout(() => {
    task.timer = null;
    if (!isCurrent()) {
      return;
    }
    if (!isReplyPredictionEnabled() || !canPredict()) {
      pendingTasks.delete(conversationId);
      return;
    }
    const requestId = `reply-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    task.requestId = requestId;
    window.snow
      .predictReply({ requestId, conversationId, apiProfile })
      .then((result) => {
        if (!isCurrent()) {
          return;
        }
        pendingTasks.delete(conversationId);
        const text = result.content.trim();
        if (text && isReplyPredictionEnabled() && canPredict()) {
          writePrediction(conversationId, text);
          emit(conversationId, text);
        }
      })
      .catch(() => {
        if (isCurrent()) {
          pendingTasks.delete(conversationId);
        }
      });
  }, PREDICTION_DELAY_MS);
};
