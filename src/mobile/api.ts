import type {
  SnowRemoteControlApi,
  SnowRemoteModeId,
  SnowRemoteRollbackDiff,
  SnowRemoteRollbackFile,
  SnowRemoteRollbackMode,
  SnowRemoteState,
  SnowRemoteTodoStatus,
} from "../renderer/types/remoteControl";
import { t } from "./i18n";

/**
 * 远控 HTTP 接口封装。
 *
 * 请求/响应形状与桌面 Renderer 的 SnowRemoteControlApi 桥一致
 * （主进程只是转发并校验），因此面板类返回值直接从桥的类型推导，避免重复定义。
 */
type SkillsResponse = Awaited<ReturnType<SnowRemoteControlApi["getSkills"]>>;
type McpResponse = Awaited<ReturnType<SnowRemoteControlApi["getMcpServers"]>>;
type ChangesResponse = Awaited<ReturnType<SnowRemoteControlApi["getChanges"]>>;
type PermissionsSummary = Awaited<
  ReturnType<SnowRemoteControlApi["getPermissions"]>
>;
type RoleSummary = Awaited<ReturnType<SnowRemoteControlApi["getRole"]>>;
type SensitiveCommandsSummary = Awaited<
  ReturnType<SnowRemoteControlApi["getSensitiveCommands"]>
>;
type CodebaseSummary = Awaited<ReturnType<SnowRemoteControlApi["getCodebase"]>>;
type ReviewSummary = Awaited<ReturnType<SnowRemoteControlApi["getReview"]>>;
type OlderMessagesResponse = Awaited<
  ReturnType<SnowRemoteControlApi["getMessages"]>
>;
type ConversationsPageResponse = Awaited<
  ReturnType<SnowRemoteControlApi["getConversations"]>
>;
type RollbackStateResponse = Awaited<
  ReturnType<SnowRemoteControlApi["getRollbackState"]>
>;
type RollbackFilesResponse = { files: SnowRemoteRollbackFile[] };

export class RemoteHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteHttpError";
    this.status = status;
  }
}

export const isUnauthorizedError = (error: unknown): boolean =>
  error instanceof RemoteHttpError && error.status === 401;

type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** 超时上限（毫秒，缺省 12 秒）：SSH 场景下的文件遍历需要放宽。 */
  timeoutMs?: number;
};

/** 默认请求超时：12 秒。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

/** 统一请求：超时 + JSON 解析，非 2xx 抛出携带状态码的错误。 */
const request = async <T>(
  path: string,
  options?: RequestOptions,
): Promise<T> => {
  const { timeoutMs, ...init } = options ?? {};
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      ...init,
    });
    const body = (await response
      .json()
      .catch(() => ({ error: t("remote.error.badResponse") }))) as {
      error?: string;
    };
    if (!response.ok) {
      throw new RemoteHttpError(
        body.error || `HTTP ${response.status}`,
        response.status,
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(t("remote.error.timeout"));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const fetchState = (): Promise<SnowRemoteState> => request("/api/state");

/** 向前分页加载更早的聊天记录（beforeMessageId 为空串时取最新一页）。 */
export const fetchOlderMessages = (
  conversationId: string,
  beforeMessageId: string,
  limit: number,
): Promise<OlderMessagesResponse> =>
  request(
    `/api/messages?conversationId=${encodeURIComponent(conversationId)}&beforeMessageId=${encodeURIComponent(beforeMessageId)}&limit=${limit}`,
  );

/** 分页加载某个工作区的会话列表（offset 为已加载的条目数）。 */
export const fetchMoreConversations = (
  directoryId: string,
  offset: number,
  limit: number,
): Promise<ConversationsPageResponse> =>
  request(
    `/api/conversations?directoryId=${encodeURIComponent(directoryId)}&offset=${offset}&limit=${limit}`,
  );
export const fetchSkills = (): Promise<SkillsResponse> =>
  request("/api/skills");

export const setSkillEnabled = (
  skillId: string,
  enabled: boolean,
  directoryId: string | null,
): Promise<{ ok: true }> =>
  request("/api/skills", {
    method: "POST",
    body: JSON.stringify({ skillId, enabled, directoryId }),
  });

export const fetchMcpServers = (): Promise<McpResponse> => request("/api/mcp");

export const setMcpEnabled = (
  target: "server" | "tool",
  id: string,
  enabled: boolean,
  directoryId: string,
): Promise<{ ok: true }> =>
  request("/api/mcp", {
    method: "POST",
    body: JSON.stringify({ target, id, enabled, directoryId }),
  });

/** 会话文件变更（/changes 面板）：diff 由 Rust 检查点服务计算，SSH 下放宽超时。 */
export const fetchChanges = (
  conversationId: string,
): Promise<ChangesResponse> =>
  request(`/api/changes?conversationId=${encodeURIComponent(conversationId)}`, {
    timeoutMs: 60_000,
  });

export const fetchPermissions = (): Promise<PermissionsSummary> =>
  request("/api/permissions");

export const fetchRole = (): Promise<RoleSummary> => request("/api/role");

export const fetchSensitiveCommands = (): Promise<SensitiveCommandsSummary> =>
  request("/api/sensitive-commands");

export const fetchCodebase = (): Promise<CodebaseSummary> =>
  request("/api/codebase");

export const fetchReview = (): Promise<ReviewSummary> => request("/api/review");

export const sendMessage = (
  text: string,
  attachmentIds: string[],
  requestId: string,
): Promise<{ ok: true }> =>
  request("/api/send", {
    method: "POST",
    body: JSON.stringify({ text, attachmentIds, requestId }),
  });

export const abortRun = (): Promise<{ ok: true }> =>
  request("/api/abort", { method: "POST", body: "{}" });

/**
 * 立即发送某条待发送消息（中断其所属会话的运行并直接发出该条）。
 * queueKey 为移动端所见的队列定位键（SnowRemoteState.pendingQueueKey，
 * 不透明标记，原样回传），桌面端据此解析队列真实位置后执行（会话隔离）。
 */
export const sendPendingNow = (
  index: number,
  queueKey: string | null,
): Promise<{ ok: true }> =>
  request("/api/pending", {
    method: "POST",
    body: JSON.stringify({ action: "send-now", index, queueKey }),
  });

/** 撤回某条待发送消息（从队列移除）；返回原始文本供恢复到输入区。 */
export const withdrawPending = (
  index: number,
  queueKey: string | null,
): Promise<{ ok: true; text: string }> =>
  request("/api/pending", {
    method: "POST",
    body: JSON.stringify({ action: "withdraw", index, queueKey }),
  });

export const startNewChat = (): Promise<{ ok: true }> =>
  request("/api/new-chat", { method: "POST", body: "{}" });

export const setMode = (
  mode: SnowRemoteModeId,
  enabled: boolean,
): Promise<{ ok: true }> =>
  request("/api/mode", {
    method: "POST",
    body: JSON.stringify({ mode, enabled }),
  });

/** 切换「工具失败自动纠错」应用级开关（与桌面 PlusMenu 同一偏好）。 */
export const setToolCorrection = (enabled: boolean): Promise<{ ok: true }> =>
  request("/api/tool-correction", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });

/**
 * 会话待办变更（add / update / delete）：复用桌面真实 todo-todo-manage 工具。
 * 变更后的最新列表随 /api/state 的 todos 字段回传，调用方刷新快照即可。
 */
export const mutateTodos = (
  action: "add" | "update" | "delete",
  payload: { content?: string; todoId?: string; status?: SnowRemoteTodoStatus },
): Promise<{ ok: true }> =>
  request("/api/todos", {
    method: "POST",
    body: JSON.stringify({ action, ...payload }),
  });

/**
 * 执行挂起的 WorkFlow（等价桌面卡片的「执行」按钮）：桌面校验后在后台启动
 * 执行器并立即返回，节点进度随 /api/state 的 workflow 快照轮询更新。
 */
export const runWorkflow = (flowId: string): Promise<{ ok: true }> =>
  request("/api/workflow", {
    method: "POST",
    body: JSON.stringify({ action: "run", flowId }),
  });

/** 提交对流程的修改意见：结算挂起的 workflow-generate，模型据此重新设计。 */
export const replyWorkflow = (
  flowId: string,
  message: string,
): Promise<{ ok: true }> =>
  request("/api/workflow", {
    method: "POST",
    body: JSON.stringify({ action: "reply", flowId, message }),
  });

export const selectConversation = (
  conversationId: string,
  directoryId: string,
): Promise<{ ok: true }> =>
  request("/api/select", {
    method: "POST",
    body: JSON.stringify({ conversationId, directoryId }),
  });

export const approveAuthorization = (
  authorizationId: string,
): Promise<{ ok: true }> =>
  request("/api/authorization", {
    method: "POST",
    body: JSON.stringify({ authorizationId, decision: "approve" }),
  });

export const rejectAuthorization = (
  authorizationId: string,
  reason: string | undefined,
): Promise<{ ok: true }> =>
  request("/api/authorization", {
    method: "POST",
    body: JSON.stringify({
      authorizationId,
      decision: "reject",
      reason: reason || undefined,
    }),
  });

export const answerQuestion = (
  questionId: string,
  selectedOptions: string[],
  customAnswers: string[],
): Promise<{ ok: true }> =>
  request("/api/question", {
    method: "POST",
    body: JSON.stringify({
      questionId,
      action: "answer",
      selectedOptions,
      customAnswers,
    }),
  });

export const cancelQuestion = (questionId: string): Promise<{ ok: true }> =>
  request("/api/question", {
    method: "POST",
    body: JSON.stringify({
      questionId,
      action: "cancel",
      selectedOptions: [],
      customAnswers: [],
    }),
  });

export const setModel = (modelId: string): Promise<{ ok: true }> =>
  request("/api/model", {
    method: "POST",
    body: JSON.stringify({ model: modelId }),
  });

export const setApiProfile = (profile: string): Promise<{ ok: true }> =>
  request("/api/model", {
    method: "POST",
    body: JSON.stringify({ profile }),
  });

export const setThinking = (value: string): Promise<{ ok: true }> =>
  request("/api/model", {
    method: "POST",
    body: JSON.stringify({ thinkingStrength: value }),
  });

export const setResponsesFastMode = (tier: string): Promise<{ ok: true }> =>
  request("/api/model", {
    method: "POST",
    body: JSON.stringify({ responsesFastMode: tier }),
  });

export const runCommand = (commandId: string): Promise<{ ok: true }> =>
  request("/api/command", {
    method: "POST",
    body: JSON.stringify({ commandId }),
  });

/** 手机端可用的解锁方式：totp 为 true 表示桌面端已绑定身份验证器并允许动态码解锁。 */
export type RemoteUnlockMethods = { totp: boolean };

export const fetchUnlockMethods = (): Promise<RemoteUnlockMethods> =>
  request("/api/unlock-methods");

/** 令牌填写页提交访问令牌或身份验证器动态码；校验通过后服务端写入会话 Cookie。 */
export const unlock = (
  credential:
    | {
        token: string;
      }
    | {
        code: string;
      },
): Promise<{ ok: true }> =>
  request("/api/unlock", {
    method: "POST",
    body: JSON.stringify(credential),
  });

export const uploadAttachment = (
  file: File,
  kind: "image" | "file",
): Promise<{ id: string }> =>
  request("/api/attachments", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "x-snow-attachment-kind": kind,
      "x-snow-file-name": encodeURIComponent(file.name),
    },
    body: file,
  });

/** 移除服务端附件；失败无需提示（附件只在本机内存与桌面侧登记）。 */
export const discardAttachment = (id: string): void => {
  void fetch(`/api/attachments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  }).catch(() => {});
};

/**
 * 回滚实时状态：桌面计算文件变更期间 preparingMessageId 非空；preview 就绪后
 * 携带与电脑端弹窗同源的清单（文件变更 / TODO / 记忆 / WorkFlow 提示）。
 */
export const fetchRollbackState = (): Promise<RollbackStateResponse> =>
  request("/api/rollback");

/**
 * 发起回滚预览：复用桌面回滚逻辑（中止运行中的流、终止 WorkFlow 节点后计算
 * 文件变更），立即返回；结果由调用方轮询 fetchRollbackState 获取。
 */
export const startRollback = (messageId: string): Promise<{ ok: true }> =>
  request("/api/rollback", {
    method: "POST",
    body: JSON.stringify({ action: "preview", messageId }),
  });

/**
 * 确认回滚：conversation-only 只回滚会话；conversation-and-files 同时恢复文件。
 * deleteMemories 决定是否一并清理被回滚轮次保存的项目记忆。
 */
export const confirmRollback = (
  messageId: string,
  mode: SnowRemoteRollbackMode,
  deleteMemories: boolean,
): Promise<{ ok: true }> =>
  request("/api/rollback", {
    method: "POST",
    body: JSON.stringify({
      action: "confirm",
      messageId,
      mode,
      deleteMemories,
    }),
  });

/** 取消回滚预览（桌面端同一次预览一并关闭）。 */
export const cancelRollback = (messageId: string): Promise<{ ok: true }> =>
  request("/api/rollback", {
    method: "POST",
    body: JSON.stringify({ action: "cancel", messageId }),
  });

/**
 * 拉取回滚预览的文件变更摘要（类型 + 增删行数）：由 Rust 检查点服务直接计算
 * （含 SSH/SFTP 通道），范围与确认回滚时实际恢复的文件一致，最多返回 50 个文件。
 */
export const fetchRollbackFiles = (
  checkpointIds: string[],
  workDir: string,
): Promise<RollbackFilesResponse> =>
  request("/api/rollback", {
    method: "POST",
    body: JSON.stringify({ action: "diff", checkpointIds, workDir }),
    // 大仓库 / SSH 工作区的逐文件统计需要更宽松的超时。
    timeoutMs: 60_000,
  });

/** 按需拉取单个文件 diff 的首页（选中文件时才计算）。 */
export const fetchRollbackFileDiff = (
  checkpointIds: string[],
  workDir: string,
  path: string,
): Promise<SnowRemoteRollbackDiff> =>
  request("/api/rollback", {
    method: "POST",
    body: JSON.stringify({ action: "diff-page", checkpointIds, workDir, path }),
    timeoutMs: 60_000,
  });
