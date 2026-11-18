import type { ApiConfigRecord } from "../../../../../preload";
import { tokenUsageFromMessageRecords } from "./conversationHelpers";
import {
  CHAT_MESSAGE_PAGE_SIZE,
  isPendingSessionKey,
  type CompactionResult,
  type ConversationContextValue,
  type TokenUsage,
} from "./conversationTypes";

/** 下一次模型请求的消息（主循环 / 子代理 / Workflow 节点共用同一形状）。 */
export type AutoCompactionRequestMessage = {
  role: "user" | "assistant" | "system" | "developer" | "tool";
  content: string;
  origin?: "user" | "internal" | "unknown";
  toolResultsJson?: string;
};

export type AutoCompactionGateParams = {
  /** 目标会话 id。pending 会话（尚无持久化上下文）不参与压缩。 */
  conversationId: string;
  /**
   * 本次待发送的消息。压缩成功后必须原样跟在 handoff 之后发送：压缩交接只
   * 读取已落库的上下文，这些消息要等 store_chat_exchange 才落库，丢掉它们
   * 就等于丢掉本次续跑输入（用户消息 / 插话 / Goal 续跑提示）。
   */
  requestMessages: AutoCompactionRequestMessage[];
  model?: string;
  /** 会话/节点实际绑定的 API Profile（绝不借用全局活动档案）。 */
  apiProfile?: string;
  thinkingStrength?: string | null;
  responsesFastMode?: string | null;
  /** 子代理压缩交接需要与子代理一致的工具集 / 系统提示词。 */
  subAgentToolsJson?: string;
  subAgentSystemPrompt?: string;
  /** 子代理严格绑定自身 Profile：找不到时不做压缩，不回落全局活动档案。 */
  strictProfile?: boolean;
  /** 触发判断用的用量；省略时读取会话当前记录的 tokenUsage。 */
  tokenUsage?: TokenUsage | null;
  /** 压缩边界续跑（resumeAfterCompaction=true）不再重复压缩。 */
  resumeAfterCompaction?: boolean;
  /** 压缩确定要发生、真正开始之前调用（调用方用它固化本轮消息）。 */
  beforeCompaction?: () => void;
  /**
   * 响应后、工具执行前的检查点：工具结果尚未产生。异步压缩不在这里发起，
   * 而是等下一次携带工具结果的请求入口，把结果一并交给摘要。
   */
  pendingToolCalls?: boolean;
};

/** 自动压缩阈值下限（占最大上下文的比例）。 */
const AUTO_COMPRESS_MIN_RATIO = 0.3;

type RunningBackgroundCompaction = {
  status: "running";
  streamId?: string;
  cancelled?: boolean;
};

type BackgroundCompactionState =
  RunningBackgroundCompaction | { status: "done"; contextTokens?: number };

/** 按会话记录后台压缩：进行中不重复发起，完成后由下一个请求边界消费。 */
const backgroundCompactions = new Map<string, BackgroundCompactionState>();

export const isBackgroundCompactionRunning = (
  conversationId: string,
): boolean => backgroundCompactions.get(conversationId)?.status === "running";

/** 会话中断时停止其后台压缩；之后若会话继续，闸门会按上下文重新判断。 */
export const abortBackgroundCompaction = (conversationId: string): void => {
  const state = backgroundCompactions.get(conversationId);
  if (state?.status !== "running") return;
  state.cancelled = true;
  backgroundCompactions.delete(conversationId);
  if (state.streamId) void window.snow.abortResponseStream(state.streamId);
};

const readAsyncCompress = (configJson: string | undefined): boolean => {
  try {
    const parsed = JSON.parse(configJson || "{}") as {
      snowcfg?: { asyncCompress?: unknown };
    };
    return parsed?.snowcfg?.asyncCompress === true;
  } catch {
    return false;
  }
};

/** 发起后台压缩：等到压缩请求真正发出（压缩快照与边界 id 已确定）即返回。 */
const startBackgroundCompaction = async (
  ctx: ConversationContextValue,
  params: AutoCompactionGateParams,
): Promise<void> => {
  const { conversationId } = params;
  const state: RunningBackgroundCompaction = { status: "running" };
  backgroundCompactions.set(conversationId, state);
  await new Promise<void>((resolve) => {
    void ctx.performCompactionRef
      .current(
        conversationId,
        params.model,
        true,
        undefined,
        params.apiProfile,
        params.subAgentToolsJson,
        params.subAgentSystemPrompt,
        params.thinkingStrength ?? undefined,
        params.responsesFastMode,
        {
          requestMessages: params.requestMessages.map((message) => ({
            ...message,
          })),
          onStarted: resolve,
          onStreamId: (streamId) => {
            state.streamId = streamId;
            if (state.cancelled) void window.snow.abortResponseStream(streamId);
          },
          isCancelled: () => state.cancelled === true,
        },
      )
      .then((result) => {
        if (backgroundCompactions.get(conversationId) !== state) return;
        if (result) {
          backgroundCompactions.set(conversationId, {
            status: "done",
            contextTokens: result.contextTokens,
          });
        } else {
          backgroundCompactions.delete(conversationId);
        }
      })
      .catch(() => {
        if (backgroundCompactions.get(conversationId) === state) {
          backgroundCompactions.delete(conversationId);
        }
      })
      .finally(resolve);
  });
};

/**
 * 压缩成功后续跑请求的消息序列：handoff 占位 + 压缩前任务原文 + 本次待发送消息。
 * Rust 端 resumeAfterCompaction 会跳过首位占位消息（handoff 已作为压缩边界
 * 落库），其余消息注入请求并持久化，因此续跑输入不会因压缩而丢失，handoff
 * 也不会被重复注入。
 *
 * 压缩前捕获的任务原文（activeTaskMessages）可能已经包含在本次待发送消息里
 * （插话 / 排队 / 强行发送在压缩前就已并入任务原文），这类重复项直接丢弃：
 * 同一条用户消息既不能重复注入，更不能在库里落成两行。
 */
export const buildCompactionResumeMessages = <
  Message extends AutoCompactionRequestMessage,
>(
  result: CompactionResult,
  requestMessages: Message[],
): (
  | Message
  | { role: "user"; content: string; origin?: "user" | "internal" | "unknown" }
)[] => {
  const protectedMessages = (result.protectedMessages ?? []).filter(
    (protectedMessage) =>
      !protectedMessage.content ||
      !requestMessages.some(
        (message) =>
          message.role === "user" &&
          message.origin === protectedMessage.origin &&
          message.content === protectedMessage.content,
      ),
  );
  return [
    { role: "user", origin: "internal", content: result.content },
    ...protectedMessages,
    ...requestMessages,
  ];
};

/** 严格绑定的 Profile：按名字精确查找，找不到即视为未配置自动压缩。 */
const resolveStrictProfileApiConfig = async (
  profileName: string | undefined,
): Promise<ApiConfigRecord | null> => {
  const name = profileName?.trim();
  if (!name) return null;
  const configs = await window.snow.listApiConfigs();
  return configs.find((item) => item.profileName.trim() === name) ?? null;
};

/**
 * 会话内存里没有用量记录时（应用重启后恢复旧子代理 / 旧 Workflow 节点，
 * 或会话历史刚加载），从持久化消息还原最后一条 assistant 行的上下文快照
 * 作为阈值判断依据。只在内存用量为空时查询：一次成功响应后即由内存值接管。
 */
const loadPersistedContextUsage = async (
  conversationId: string,
): Promise<TokenUsage | null> => {
  try {
    const page = await window.snow.listChatMessagesPaginated(
      conversationId,
      "",
      CHAT_MESSAGE_PAGE_SIZE,
    );
    return tokenUsageFromMessageRecords(page.items);
  } catch {
    return null;
  }
};

/**
 * 统一的自动压缩闸门：只在「已经确认要发起下一次模型请求」的边界调用。
 *
 * 主循环、子代理回合循环、Workflow 节点循环都在各自的请求入口调用它，因此
 * 工具续跑、插话续跑、Goal 自动续跑、旧会话恢复、内部排队、强行发送走的是
 * 同一套阈值判断与续跑语义，不再依赖各分支自己的「循环是否继续」推断。
 *
 * 返回非 null 表示已完成压缩：调用方必须改用 buildCompactionResumeMessages
 * 组装的 handoff 上下文并以 resumeAfterCompaction=true 续跑。返回 null 表示
 * 无需压缩（未开启 / 未配置阈值 / 用量未达阈值 / 该边界不允许压缩）或压缩
 * 失败，调用方按原消息继续，不做重试。
 *
 * 三类边界不压缩：
 * - 压缩边界续跑：handoff 已是最新上下文，再压缩只会重复注入。
 * - pending 会话：没有可压缩的持久化上下文。
 * - 携带工具结果的请求：工具结果此时只在内存里、尚未落库，压缩交接看不到
 *   它们，压缩后必然丢失；这类请求由响应后的检查点（工具执行之前）压缩。
 *
 * 异步压缩（档案开启 asyncCompress）：压缩在后台进行，闸门恒返回 null，AI 循环
 * 不等待。边界 id 在压缩发起时预留，完成后上下文从压缩节点切换为「交接文档 +
 * 期间新增消息」。它反过来在携带工具结果的请求入口发起（结果随压缩交给摘要），
 * 不在工具执行前的检查点发起。
 */
export const runAutoCompactionGate = async (
  ctx: ConversationContextValue,
  params: AutoCompactionGateParams,
): Promise<CompactionResult | null> => {
  if (params.resumeAfterCompaction) return null;
  if (isPendingSessionKey(params.conversationId)) return null;

  // 后台压缩：进行中不重复发起；已完成则本边界消费结果。Rust 上下文视图已从
  // 压缩节点切换，无需改写本次请求；手头用量来自切换前发出的请求，已过期，
  // 换成压缩后的估算值并跳过本次阈值判断。
  const background = backgroundCompactions.get(params.conversationId);
  if (background?.status === "running") return null;
  if (background?.status === "done") {
    backgroundCompactions.delete(params.conversationId);
    if (background.contextTokens != null) {
      ctx.updateSessionField(params.conversationId, "tokenUsage", {
        inputTokens: background.contextTokens,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      });
    }
    return null;
  }

  const hasToolMessages = params.requestMessages.some(
    (message) => message.role === "tool",
  );

  const apiConfig = params.strictProfile
    ? await resolveStrictProfileApiConfig(params.apiProfile)
    : await ctx.getActiveApiConfig(params.apiProfile);
  if (!apiConfig?.enableAutoCompress) return null;
  const asyncCompress = readAsyncCompress(apiConfig.configJson);
  if (asyncCompress ? params.pendingToolCalls : hasToolMessages) return null;
  // autoCompressThreshold 存的是 token 数（保存配置时按百分比换算），
  // 直接与会话用量比较 —— 不要再走 calculateAutoCompressThresholdTokens。
  // 旧配置可能低于 30% 下限，这里兜底。
  const storedThreshold = apiConfig.autoCompressThreshold;
  if (storedThreshold == null || storedThreshold <= 0) return null;
  const maxContextTokens = apiConfig.maxContextTokens ?? 0;
  const thresholdTokens =
    maxContextTokens > 0
      ? Math.max(
          storedThreshold,
          Math.ceil(maxContextTokens * AUTO_COMPRESS_MIN_RATIO),
        )
      : storedThreshold;

  const usage =
    params.tokenUsage ??
    ctx.sessionsRef.current?.[params.conversationId]?.tokenUsage ??
    (await loadPersistedContextUsage(params.conversationId));
  if (!usage) return null;
  if (usage.inputTokens + usage.outputTokens < thresholdTokens) return null;

  if (asyncCompress) {
    await startBackgroundCompaction(ctx, params);
    return null;
  }

  params.beforeCompaction?.();

  const result = await ctx.performCompactionRef.current(
    params.conversationId,
    params.model,
    true,
    undefined,
    params.apiProfile,
    params.subAgentToolsJson,
    params.subAgentSystemPrompt,
    params.thinkingStrength ?? undefined,
    params.responsesFastMode,
  );
  if (!result) return null;

  // performCompaction 的 finally 会复位 isSending；调用方随后还要继续发
  // 请求，恢复发送状态，压缩期间的中止检查才不会误判成已结束。
  const ref = ctx.sessionsRefData.current.get(params.conversationId);
  if (ref) {
    ref.isSending = true;
    ref.isAbortRequested = false;
  }
  return result;
};
