import { useEffect, useRef } from "react";
import type {
  ChatConversationRecord,
  TokenUsage,
  WorkspaceDirectoryRecord,
} from "../../preload";
import type { MainContentView } from "./mainContent/types";
import {
  useChatConversationContext,
  useChatConversationSessions,
} from "./mainContent/chatMessages";
import { parseTodoResult } from "./mainContent/chatMessages/hooks/useTodoPanel";
import {
  collectConversationFileChanges,
  countFileChangeLines,
} from "./mainContent/chatMessages/hooks/fileChangeTracking";
import { resolveConversationChangeChain } from "./mainContent/chatMessages/hooks/conversationChangeChain";
import {
  buildConversationMessages,
  directoryIdToPath,
  ensureMessageLoaded,
  type MessageLoadBudget,
} from "./mainContent/chatMessages/utils/conversationHelpers";
import type {
  ChatConversationMessage,
  ToolCallInfo,
} from "./mainContent/chatMessages/utils/conversationTypes";
import {
  ensureToolCorrectionPreference,
  setToolCorrectionPreference,
} from "./mainContent/chatMessages/utils/toolCorrectionPreference";
import {
  readLiveRemoteControlChatInput,
  readRemoteControlChatInput,
  type SnowRemoteChatInputPublication,
} from "./mainContent/chatInput/remoteControlChatInputRegistry";
import type { ChatInputSendOptions } from "./mainContent/chatInput/types";
import { notifyMcpServerStateChanged } from "./mainContent/chatInput/mcpServerEvents";
import { redactSensitiveToolText } from "./remoteControlRedaction";
import { readThemeCache } from "./sidebar/themeSettings/themeSettingsUtils";
import { useBusySendBehavior } from "../constants/busySendBehavior";
import {
  replyRemoteWorkflow,
  resolveWorkflowSnapshot,
  runRemoteWorkflow,
  type WorkflowRemoteContext,
} from "./remoteControlWorkflow";
import {
  formatAnnotationLabel,
  formatFileLinesLabel,
  formatWorkflowTagLabel,
  parseContentSegments,
} from "./mainContent/chatInput/fileTagUtils";
import type {
  SnowRemoteChatInputState,
  SnowRemoteContentBlock,
  SnowRemoteControlApi,
  SnowRemoteChange,
  SnowRemoteConversation,
  SnowRemoteGitBranches,
  SnowRemoteGitDiff,
  SnowRemoteGitStatus,
  SnowRemoteGitSummary,
  SnowRemoteMessage,
  SnowRemoteRollbackChange,
  SnowRemoteRollbackMode,
  SnowRemoteRollbackState,
  SnowRemoteRunStats,
  SnowRemoteState,
  SnowRemoteStreamCursor,
  SnowRemoteTodoItem,
  SnowRemoteTodoStatus,
  SnowRemoteToolCall,
  SnowRemoteToolCorrection,
  SnowRemoteTokenUsage,
} from "../types/remoteControl";

type RemoteControlBridgeProps = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  onActiveDirectoryChange: (directory: WorkspaceDirectoryRecord | null) => void;
  onSelectMainView: (view: MainContentView) => void;
};

const MAX_MESSAGES = 50;
/** 会话选择器的分页步长（首屏每工作区一页，「加载更多」按同一页长追加）。 */
const REMOTE_CONVERSATION_PAGE_SIZE = 30;
const MAX_MESSAGE_LENGTH = 40_000;
const MAX_SEND_LENGTH = 8_000;
const MAX_COMMANDS = 40;
const MAX_THINKING_OPTIONS = 20;
const MAX_THINKING_LENGTH = 100;
const MAX_IDENTIFIER_LENGTH = 200;
/** 会话待办：单次下发的最大条目数与单条内容长度上限。 */
const MAX_TODOS = 200;
const MAX_TODO_CONTENT_LENGTH = 500;
/**
 * 回滚预览下发上限：文件变更清单（含总数）、检查点数、TODO 与记忆条目。
 * 手机端只需展示摘要 + 前若干条，避免把超大清单塞进一次响应。
 */
const MAX_ROLLBACK_CHANGES = 200;
const MAX_ROLLBACK_CHECKPOINTS = 300;
const MAX_ROLLBACK_TODOS = 100;
const MAX_ROLLBACK_MEMORIES = 100;
const MAX_ROLLBACK_PATH_LENGTH = 400;
const MAX_ROLLBACK_MEMORY_TITLE_LENGTH = 200;
/**
 * 跨页回滚的目标定位预算：手机端可沿数据库分页看到比桌面内存窗口更早的历史
 * （见 getConversationMessages 的第 2 条路径），回滚这些目标需要按页
 * （每页 CHAT_MESSAGE_PAGE_SIZE 条）把它们加载进桌面内存，页数因此放宽。
 * 时长必须严格压在 Rust 桥的 12s（remote_control::bridge 的 BRIDGE_TIMEOUT）
 * 之内：桥侧超时后手机会先收到失败，而桌面仍在继续加载并弹出回滚预览，
 * 造成两端状态割裂。
 */
const ROLLBACK_TARGET_BUDGET: MessageLoadBudget = {
  maxPages: 80,
  timeoutMs: 8_000,
};
const CHAT_INPUT_MOUNT_POLL_MS = 100;
const CHAT_INPUT_MOUNT_TIMEOUT_MS = 8_000;
/**
 * 待办快照缓存时长。/api/state 由手机端高频轮询，而待办需要调用
 * MCP 工具读取（一次 IPC + SQLite 查询）：命中缓存时直接复用，
 * 变更（mutateTodos）与切换会话时立即失效。
 */
const TODO_CACHE_TTL_MS = 3_000;
/**
 * 会话子树（Workflow 节点会话 + 子代理会话）缓存时长。
 * 子树不随主列表变化（节点/子代理会在主列表不动的前提下创建并更新状态），
 * 因此单独按同一时间窗刷新；查询是两次批量 IPC（按父会话 id 查询），
 * 不进入 /api/state 的同步路径。
 */
const CONVERSATION_CHILDREN_TTL_MS = 5_000;
/**
 * 激活会话身份（会话类型 / 运行状态 / 父会话）缓存时长。
 * 主会话的会话类型不会变化，落终态也不影响只读判定，可以长缓存；
 * 子会话（子代理 / Workflow 节点）的运行状态随时可能落终态，必须短缓存，
 * 否则手机端会在子代理结束后仍停留在输入区。
 */
const ACTIVE_CONVERSATION_TTL_MS = 10_000;
const ACTIVE_CHILD_CONVERSATION_TTL_MS = 1_000;

/** 移动端 Git 面板的输入 / 输出上限（手机端一次性渲染，需限制体积）。 */
const MAX_GIT_PATHS = 100;
const MAX_GIT_PATH_LENGTH = 1024;
const MAX_GIT_PATHS_TOTAL = 30_000;
const MAX_GIT_COMMIT_MESSAGE = 4_000;
const MAX_GIT_DIFF_CHARS = 300_000;
const MAX_GIT_FILE_ROWS = 1_000;
const MAX_GIT_UNTRACKED_LINES = 4_000;

/** git 分支名非法字符（与桌面 BranchSelector 的校验一致）。 */
const INVALID_GIT_REF_CHAR = /[\x00-\x20\x7f~^:?*[\\]/;

const isValidGitBranchName = (branch: string): boolean => {
  if (
    branch.length === 0 ||
    branch.trim() !== branch ||
    branch === "@" ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("//") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    INVALID_GIT_REF_CHAR.test(branch)
  ) {
    return false;
  }
  return branch
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
    );
};

/** 工作树末级目录名（手机端只展示它）。 */
const gitFolderName = (path: string): string => {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
};

/** 纯截断：用于展示字段，不追加提示文案。 */
const capText = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

/** 变更工作树 / 分支后通知桌面其余界面刷新（与桌面 BranchSelector 同源事件）。 */
const dispatchGitBranchesChanged = (repoPath: string): void => {
  window.dispatchEvent(
    new CustomEvent("snow:branches-changed", { detail: repoPath }),
  );
};

const dispatchGitWorktreesChanged = (): void => {
  window.dispatchEvent(new Event("snow:worktrees-changed"));
};

/**
 * 子会话类型（子代理 / Workflow 节点）：运行态会变，非只读主会话。
 */
const isChildConversationType = (conversationType: string): boolean =>
  conversationType === "sub_agent" || conversationType === "workflow_node";

/** 激活会话身份快照（移动端只读判定与「返回主会话」跳转用）。 */
type ActiveConversationMeta = {
  conversationType: string;
  runStatus: string;
  parentConversationId: string;
};

const EMPTY_ACTIVE_CONVERSATION_META: ActiveConversationMeta = {
  conversationType: "",
  runStatus: "",
  parentConversationId: "",
};

/** 父会话 id → 其树形子层（Workflow 节点会话 + 直接派生的子代理会话）。 */
type RemoteConversationChildren = Record<string, SnowRemoteConversation[]>;

/** 会话运行态来源：渲染进程会话上下文里与「会话是否在跑/是否需关注」相关集合。 */
type ConversationRuntimeSets = {
  streamingIds: Set<string>;
  pausedIds: Set<string>;
  attentionIds: Set<string>;
  completedIds: Set<string>;
};

const truncateTo = (
  value: string | undefined,
  maxLength: number,
): string | undefined => {
  if (value === undefined || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n…（手机端已截断）`;
};

const truncate = (value: string | undefined): string | undefined =>
  truncateTo(value, MAX_MESSAGE_LENGTH);

/**
 * 桌面当前生效的主题色：--accent-color 经浏览器原生 var() 解析后的计算值，
 * 规范化为 #rrggbb 供手机端复用。probe 元素的 color 由浏览器解析，
 * 无需自己递归展开 CSS 变量；解析失败（如非常规色彩空间）返回空串，
 * 手机端保持自身默认强调色。
 */
const resolveThemeAccentColor = (): string => {
  try {
    const probe = document.createElement("div");
    probe.style.color = "var(--accent-color)";
    probe.style.display = "none";
    document.body.appendChild(probe);
    const computed = window.getComputedStyle(probe).color;
    probe.remove();
    const match = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(computed);
    if (!match) return "";
    return (
      "#" +
      [match[1], match[2], match[3]]
        .map((channel) => Number(channel).toString(16).padStart(2, "0"))
        .join("")
    );
  } catch {
    return "";
  }
};

/** 桌面当前界面字体族（--app-font-family 的计算值）；未设置时为空串。 */
const resolveThemeFontFamily = (): string => {
  try {
    return window
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--app-font-family")
      .trim();
  } catch {
    return "";
  }
};

/**
 * 桌面流式光标配置：读取主题缓存，资源类形态只取文件名下发。
 * 主题缓存由设置面板与启动流程写入，缺失时回退默认脉冲圆点。
 */
const resolveThemeStreamCursor = (): SnowRemoteStreamCursor => {
  const cursor = readThemeCache()?.streamCursor;
  if (!cursor) {
    return { iconType: "dot", lucideName: "", iconSize: 14, assetName: "" };
  }
  const needsAsset =
    cursor.iconType === "custom" ||
    cursor.iconType === "image" ||
    cursor.iconType === "canvas";
  const segments = cursor.svgPath.trim().split(/[\\/]/);
  const assetName = needsAsset ? (segments[segments.length - 1] ?? "") : "";
  return {
    iconType: cursor.iconType,
    lucideName: cursor.lucideName,
    iconSize: cursor.iconSize,
    assetName,
  };
};

const toRemoteContentBlocks = (
  messageId: string,
  content: string,
): SnowRemoteContentBlock[] => {
  let imageIndex = 0;
  return parseContentSegments(content).flatMap(
    (segment): SnowRemoteContentBlock[] => {
      if (segment.type === "text") {
        const text = truncate(segment.content) ?? "";
        return text.trim() ? [{ type: "text", text }] : [];
      }
      if (segment.type === "image") {
        // 无消息 id（待发送消息等尚未落库的内容）时没有取图端点：
        // source 置空，移动端按附件 chip 降级展示。
        const source = messageId
          ? `/api/message-images/${encodeURIComponent(messageId)}/${imageIndex}`
          : "";
        imageIndex += 1;
        return [{ type: "image", name: segment.tag.name, source }];
      }
      if (segment.type === "file") {
        return [
          {
            type: "file",
            name: segment.tag.name,
            isDirectory: segment.tag.isDirectory,
          },
        ];
      }
      if (segment.type === "plugin") {
        return [
          {
            type: "reference",
            kind: "plugin",
            label: segment.tag.name,
            detail: segment.tag.pluginId,
          },
        ];
      }
      const label =
        segment.type === "commit"
          ? segment.tag.shortHash || "Commit"
          : segment.type === "change"
            ? segment.tag.path.split(/[\\/]/).pop() || "代码改动"
            : segment.type === "text-snippet"
              ? segment.tag.summary || "文本片段"
              : segment.type === "review"
                ? segment.tag.summary || "代码审查"
                : segment.type === "element"
                  ? segment.tag.label || segment.tag.tag || "网页元素"
                  : segment.type === "web"
                    ? segment.tag.title || segment.tag.url || "网页"
                    : segment.type === "conversation"
                      ? segment.tag.title || "会话"
                      : segment.type === "quote"
                        ? segment.tag.summary || "引用"
                        : segment.type === "command"
                          ? `/${segment.tag.name}`
                          : segment.type === "annotation"
                            ? formatAnnotationLabel(segment.tag)
                            : segment.type === "file-selection"
                              ? formatFileLinesLabel(
                                  segment.tag.path,
                                  segment.tag.startLine,
                                  segment.tag.endLine,
                                )
                              : segment.type === "workflow"
                                ? formatWorkflowTagLabel(segment.tag)
                                : segment.tag.name || "Skill";
      const detail =
        segment.type === "text-snippet" ||
        segment.type === "quote" ||
        segment.type === "command"
          ? `${segment.tag.charCount} 个字符`
          : segment.type === "web"
            ? segment.tag.url
            : segment.type === "skill"
              ? segment.tag.description
              : segment.type === "annotation"
                ? segment.tag.content
                : segment.type === "file-selection"
                  ? segment.tag.content
                  : segment.type === "workflow"
                    ? segment.tag.outline
                    : undefined;
      return [
        {
          type: "reference",
          kind: segment.type,
          label: truncateTo(label, 240) ?? "附件",
          detail: truncateTo(detail, 500),
          // 文件片段带原始文件名：移动端据扩展名取文件类型图标。
          name:
            segment.type === "file-selection" ? segment.tag.name : undefined,
        },
      ];
    },
  );
};

const toRemotePreview = (content: string | undefined): string => {
  if (!content) return "";
  // Conversation titles/previews may be truncated by persistence in the
  // middle of an attachment tag. A truncated tag cannot be parsed normally,
  // so remove these two sensitive formats before the shared parser runs.
  const safeContent = content
    .replace(/@@(image|file|dir):[\s\S]*?(?:@@|$)/g, (_match, kind: string) =>
      kind === "image" ? "[图片]" : kind === "dir" ? "[文件夹]" : "[文件]",
    )
    .replace(/data:image\/[^\s]*/gi, "[图片]");
  const preview = parseContentSegments(safeContent)
    .map((segment) => {
      if (segment.type === "text") return segment.content;
      if (segment.type === "image") return `[图片 ${segment.tag.name}]`;
      if (segment.type === "file") {
        return `[${segment.tag.isDirectory ? "文件夹" : "文件"} ${segment.tag.name}]`;
      }
      if (segment.type === "commit") return `[Commit ${segment.tag.shortHash}]`;
      if (segment.type === "change") {
        return `[代码改动 ${segment.tag.path.split(/[\\/]/).pop() || ""}]`;
      }
      if (segment.type === "skill") return `[Skill ${segment.tag.name}]`;
      if (segment.type === "conversation") return `[会话 ${segment.tag.title}]`;
      if (segment.type === "web") return `[网页 ${segment.tag.title || ""}]`;
      if (segment.type === "element") return `[网页元素 ${segment.tag.label}]`;
      if (segment.type === "review") return `[代码审查 ${segment.tag.summary}]`;
      if (segment.type === "quote") return `[引用 ${segment.tag.summary}]`;
      if (segment.type === "command") return `[指令 /${segment.tag.name}]`;
      if (segment.type === "annotation") {
        return `[标注 ${formatAnnotationLabel(segment.tag)}]`;
      }
      if (segment.type === "file-selection") {
        return `[文件选区 ${formatFileLinesLabel(
          segment.tag.path,
          segment.tag.startLine,
          segment.tag.endLine,
        )}]`;
      }
      if (segment.type === "plugin") return `[插件 ${segment.tag.name}]`;
      if (segment.type === "workflow") {
        return `[${formatWorkflowTagLabel(segment.tag)}]`;
      }
      return `[文本片段 ${segment.tag.summary}]`;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return truncateTo(preview, 500) ?? "";
};

/**
 * 纠错状态 → 远程 DTO：与工具参数 / 结果同一脱敏规则，修正参数、理由、
 * 错误与结果都要过一遍 redactSensitiveToolText 才能跨远控边界。
 */
const toRemoteCorrection = (
  correction: ToolCallInfo["correction"],
): SnowRemoteToolCorrection | undefined => {
  if (!correction) return undefined;
  return {
    status: correction.status,
    originalArguments:
      redactSensitiveToolText(correction.originalArguments) ?? "",
    failureCode: correction.failureCode,
    failureDetail: redactSensitiveToolText(correction.failureDetail),
    attempts: correction.attempts.map((attempt) => ({
      index: attempt.index,
      status: attempt.status,
      arguments: redactSensitiveToolText(attempt.arguments) ?? "",
      reasoning: redactSensitiveToolText(attempt.reasoning),
      error: redactSensitiveToolText(attempt.error),
      result: redactSensitiveToolText(attempt.result),
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
    })),
  };
};

const toRemoteToolCall = (toolCall: ToolCallInfo): SnowRemoteToolCall => ({
  name: toolCall.name,
  interactionId: toolCall.interactionId,
  authorizationId: toolCall.authorizationId,
  sensitive:
    (toolCall.sensitiveCommandMatches?.length ?? 0) > 0 ||
    toolCall.sensitiveOperation !== undefined,
  status: toolCall.status,
  // 工具参数 / 结果 / 流式输出与 PC 端一致：全量下发（不做长度截断），
  // 只过一遍脱敏（redactSensitiveToolText 留在无依赖模块里，安全契约
  // 不挂载 React 桥也能被直接验证）。
  arguments: redactSensitiveToolText(toolCall.arguments),
  result: redactSensitiveToolText(toolCall.result),
  streamingStdout: redactSensitiveToolText(toolCall.streamingStdout),
  streamingStderr: redactSensitiveToolText(toolCall.streamingStderr),
  correction: toRemoteCorrection(toolCall.correction),
  userQuestion: toolCall.userQuestion
    ? {
        questionId: toolCall.userQuestion.questionId,
        question: truncateTo(toolCall.userQuestion.question, 2_000) ?? "",
        options: toolCall.userQuestion.options
          .slice(0, 20)
          .map((option) => truncateTo(option, 500) ?? ""),
        status: toolCall.userQuestion.status,
        interrupted: toolCall.userQuestion.interrupted,
        selectedOptions: toolCall.userQuestion.selectedOptions.slice(0, 20),
        customAnswers: toolCall.userQuestion.customAnswers.slice(0, 20),
      }
    : undefined,
});

/** 用户消息纯文本（剥离附件标签）：消息正文与回滚输入框回填共用。 */
const toRemoteUserText = (content: string): string =>
  truncate(
    parseContentSegments(content)
      .filter((segment) => segment.type === "text")
      .map((segment) => segment.content)
      .join("")
      .trim(),
  ) ?? "";

const toRemoteMessage = (
  message: ChatConversationMessage,
): SnowRemoteMessage => ({
  id: message.id,
  role: message.role,
  content:
    message.role === "user"
      ? toRemoteUserText(message.content)
      : (truncate(message.content) ?? ""),
  contentBlocks:
    message.role === "user" && !message.isContextCompaction
      ? toRemoteContentBlocks(message.id, message.content)
      : undefined,
  thinking: truncate(message.thinking),
  model: truncateTo(message.model, 120),
  responseId: message.responseId,
  isThinkingActive: message.isThinkingActive,
  thinkingDurationMs: message.thinkingDurationMs,
  toolCalls: message.toolCalls?.map(toRemoteToolCall),
  timestamp: message.timestamp,
  status: message.status,
  isContextCompaction: message.isContextCompaction || undefined,
});

// 会话列表条目 → 远程 DTO：preview 先剥离附件标记再截断（见 toRemotePreview）。
// 只填充不受运行状态影响的静态字段；运行态与树形子层由 withConversationRuntime
// 在每次响应时补齐（缓存因此可以安全复用）。
const toRemoteConversation = (
  item: ChatConversationRecord,
  workspaceName: string,
): SnowRemoteConversation => ({
  conversationId: item.conversationId,
  title: toRemotePreview(item.title),
  summary: toRemotePreview(item.summary),
  lastMessagePreview: toRemotePreview(item.lastMessagePreview),
  status: item.status,
  directoryId: item.directoryId,
  workspaceName,
  updatedAt: item.updatedAt,
  conversationType: item.conversationType,
  isForked: item.forkedFromConversationId !== "",
  subAgentName: item.subAgentName,
  runStatus: item.subAgentStatus,
  isStreaming: false,
  isPaused: false,
  attentionRequired: false,
  isCompleted: false,
  children: [],
});

/**
 * 挂载运行态与树形子层：运行态来自渲染进程会话上下文（每次响应实时计算，
 * 不进入缓存），子层来自子树缓存；主会话与其所有后代使用同一套集合判断，
 * 因此子代理/节点会话在手机端也能显示「运行中 / 需处理 / 已完成」。
 */
const withConversationRuntime = (
  item: SnowRemoteConversation,
  runtime: ConversationRuntimeSets,
  children: RemoteConversationChildren,
): SnowRemoteConversation => ({
  ...item,
  isStreaming: runtime.streamingIds.has(item.conversationId),
  isPaused: runtime.pausedIds.has(item.conversationId),
  attentionRequired: runtime.attentionIds.has(item.conversationId),
  isCompleted: runtime.completedIds.has(item.conversationId),
  children: (children[item.conversationId] ?? []).map((child) =>
    withConversationRuntime(child, runtime, children),
  ),
});

// 真实 Token Usage 直传（来源：会话 session，由 Main/Rust 归一化）。
// Renderer 不重新计算任何 Token 算法，只做非负整数防御性清洗。
const toRemoteTokenUsage = (
  tokenUsage: TokenUsage | null | undefined,
): SnowRemoteTokenUsage | null => {
  if (!tokenUsage) {
    return null;
  }
  const safeCount = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : 0;
  return {
    inputTokens: safeCount(tokenUsage.inputTokens),
    outputTokens: safeCount(tokenUsage.outputTokens),
    cacheCreationInputTokens: safeCount(tokenUsage.cacheCreationInputTokens),
    cacheReadInputTokens: safeCount(tokenUsage.cacheReadInputTokens),
  };
};

/** 非负整数的防御性清洗（统计字段）。 */
const safeDuration = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

/**
 * 会话累计运行统计：与桌面 ChatMessageList 的 runStats 判定一致 ——
 * 流程完全结束（无流式 / 停止中 / 活跃生成）后才有值，且旧会话缺少统计时
 * 宁可不展示。移动端把它作为最后一条 AI 消息操作栏的统计入口。
 */
const toRemoteRunStats = (
  conversation: ReturnType<typeof useChatConversationContext>,
): SnowRemoteRunStats | null => {
  if (conversation.isStreaming || conversation.isAborting) return null;
  const messages = conversation.messages;
  const hasActiveGeneration = messages.some(
    (message) =>
      message.status === "sending" ||
      (message.role === "assistant" &&
        message.toolCalls?.some(
          (toolCall) =>
            toolCall.status === "pending" || toolCall.status === "running",
        )),
  );
  if (hasActiveGeneration) return null;
  if (!messages.some((message) => message.role === "assistant")) return null;
  const usage = toRemoteTokenUsage(conversation.conversationTokenUsage);
  const durationMs = safeDuration(conversation.lastRunDurationMs);
  const ttftSumMs = safeDuration(conversation.conversationTtftSumMs);
  const requestCount = safeDuration(conversation.conversationRequestCount);
  const hasStats =
    durationMs > 0 ||
    (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) > 0 ||
    (usage?.cacheReadInputTokens ?? 0) > 0 ||
    (usage?.cacheCreationInputTokens ?? 0) > 0 ||
    requestCount > 0;
  if (!hasStats) return null;
  let model: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant" && messages[index].model) {
      model = truncateTo(messages[index].model, 120);
      break;
    }
  }
  return { durationMs, ttftSumMs, requestCount, tokenUsage: usage, model };
};

const normalizeRemoteIdentifier = (value: string): string =>
  typeof value === "string" ? value.trim() : "";

/** 回滚变更类型归一化（检查点服务只会给出 added / modified / deleted）。 */
const toRollbackChangeType = (
  value: string,
): SnowRemoteRollbackChange["changeType"] =>
  value === "added" || value === "deleted" ? value : "modified";

/** 待办状态归一化（桌面清单里的 status 为字符串）。 */
const toTodoStatus = (value: string): SnowRemoteTodoStatus =>
  value === "completed" || value === "inProgress" ? value : "pending";

/**
 * 待发送队列操作失败时的现场摘要（诊断：请求 key / 当前视图 key / 存活队列 /
 * 迁移映射 / 队列索引 / 显示镜像长度）。随错误信息返回给移动端，便于定位
 * “队列定位失败”的真实原因。
 */
const pendingOperationFailureDetail = (
  conversation: ReturnType<typeof useChatConversationContext>,
  expectedQueueKey: string | null,
  index: number,
): string => {
  const queueKeys = Array.from(conversation.pendingQueueRef.current.keys());
  const migrationMapping = Array.from(
    conversation.pendingToRealConversationIdRef.current.entries(),
  ).map(([from, to]) => `${from}->${to}`);
  return (
    `（key=${expectedQueueKey ?? "null"}；视图=${conversation.activeSessionKeyRef.current ?? "null"}；` +
    `队列=[${queueKeys.join(",")}]；迁移=[${migrationMapping.join(",")}]；` +
    `idx=${index}；镜像=${conversation.pendingMessages.length}）`
  );
};

/**
 * 回滚可用性：与桌面 ChatContent 的 canRollback 同源——子代理会话与 Workflow
 * 节点会话的消息由父会话 / 节点流程管理，桌面端不给回滚按钮（回滚下传后还会
 * 连带删除对应节点会话），手机端同样隐藏，桥侧方法也会拒绝（双保险）。
 * 身份取 resolveActiveConversationMeta（live 子代理事件 + 会话记录）：
 * 不再依赖侧边栏 upsert 事件那条可能属于别的会话的旧记录，否则从列表点开
 * 一个旧的子代理会话时会被误判为可回滚。没有活动会话（新会话视图）时不可回滚。
 */
const isRollbackAvailable = (
  conversation: ReturnType<typeof useChatConversationContext>,
  meta: ActiveConversationMeta,
): boolean => {
  const activeId = conversation.activeConversationId ?? null;
  if (!activeId) return false;
  if (conversation.subAgentSessionEvents[activeId]) return false;
  return !isChildConversationType(meta.conversationType);
};

export const RemoteControlBridge = ({
  activeDirectory,
  onActiveDirectoryChange,
  onSelectMainView,
}: RemoteControlBridgeProps): null => {
  const conversation = useChatConversationContext();
  // 会话内存态表每个流式帧都会更换引用：单独订阅，并与 conversation 一起放进
  // 状态镜像，供异步的远控快照 / 翻页逻辑读取最新值。
  const sessions = useChatConversationSessions();
  const stateRef = useRef({
    activeDirectory,
    onActiveDirectoryChange,
    onSelectMainView,
    conversation,
    sessions,
  });

  stateRef.current = {
    activeDirectory,
    onActiveDirectoryChange,
    onSelectMainView,
    conversation,
    sessions,
  };

  // 忙时发送的投递方式（桌面设置，默认插话）。api 对象常驻闭包，必须用 ref
  // 保持最新值，否则远控发送永远用注册那一刻的偏好。
  const { behavior: busySendBehavior } = useBusySendBehavior();
  const busySendBehaviorRef = useRef(busySendBehavior);
  busySendBehaviorRef.current = busySendBehavior;

  // 远控 Phase A：读取输入区快照并做会话绑定二次校验。
  // 快照绑定会话与活动会话不一致（切换瞬间的陈旧快照）时视为不可用。
  const matchChatInputConversation = (
    publication: SnowRemoteChatInputPublication,
  ): SnowRemoteChatInputPublication | null => {
    const activeConversationId =
      stateRef.current.conversation.activeConversationId ?? null;
    return (publication.conversationId ?? null) === activeConversationId
      ? publication
      : null;
  };

  /** 实时快照：变更与指令执行要求输入区挂载中（真实 setter 链仍存活）。 */
  const resolveChatInput = (): SnowRemoteChatInputPublication | null => {
    const publication = readLiveRemoteControlChatInput();
    return publication ? matchChatInputConversation(publication) : null;
  };

  /**
   * 展示快照：输入区卸载（桌面停留在设置页等）时回退到最后一次快照，
   * 手机端仍能显示当前模型 / Profile / 思考强度，而不是退化成「未选择」。
   */
  const resolveChatInputForDisplay =
    (): SnowRemoteChatInputPublication | null => {
      const publication = readRemoteControlChatInput();
      return publication ? matchChatInputConversation(publication) : null;
    };

  const isChatInputReadyForMutation = (
    publication: SnowRemoteChatInputPublication,
  ): boolean => !publication.isLoadingApiConfig;

  const waitForChatInputReady =
    (): Promise<SnowRemoteChatInputPublication | null> =>
      new Promise((resolve) => {
        const startedAt = Date.now();
        const check = (): void => {
          const publication = resolveChatInput();
          if (publication && isChatInputReadyForMutation(publication)) {
            resolve(publication);
            return;
          }
          if (Date.now() - startedAt >= CHAT_INPUT_MOUNT_TIMEOUT_MS) {
            resolve(null);
            return;
          }
          setTimeout(check, CHAT_INPUT_MOUNT_POLL_MS);
        };
        check();
      });

  const guardChatInputForMutation = (
    publication: SnowRemoteChatInputPublication,
  ): SnowRemoteChatInputPublication => {
    if (stateRef.current.conversation.isStreaming) {
      throw new Error("请先停止当前运行");
    }
    if (publication.isSubAgentConversation) {
      throw new Error("子代理会话的输入配置由子代理配置决定，无法远程修改");
    }
    return publication;
  };

  const ensureChatInputForMutation =
    async (): Promise<SnowRemoteChatInputPublication> => {
      const current = stateRef.current.conversation;
      const activeId = current.activeConversationId;
      const record = current.upsertedConversation?.record ?? null;
      const isChildSession =
        Boolean(activeId && current.subAgentSessionEvents[activeId]) ||
        Boolean(
          activeId &&
          record &&
          record.conversationId === activeId &&
          (record.conversationType === "sub_agent" ||
            record.conversationType === "workflow_node"),
        );
      if (isChildSession) {
        throw new Error(
          "电脑端当前是子代理/工作流会话，输入配置不可远程修改（请切换到普通对话）",
        );
      }
      const live = resolveChatInput();
      if (live && isChatInputReadyForMutation(live)) {
        return guardChatInputForMutation(live);
      }
      stateRef.current.onSelectMainView("chat");
      const publication = await waitForChatInputReady();
      if (!publication) {
        throw new Error(
          resolveChatInputForDisplay()
            ? "电脑端输入区尚未就绪，请稍后重试"
            : "电脑端尚未就绪，请确认电脑端已打开对话",
        );
      }
      return guardChatInputForMutation(publication);
    };

  /**
   * 回滚类操作的前置校验：必须有活动会话，且不是子代理 / 节点会话。
   * 每次从 stateRef 取最新快照，身份同样按当前会话重新解析（命中缓存时无查询），
   * 因此拿到的始终是当前渲染的会话上下文。
   */
  const requireRollbackConversation = async (): Promise<
    ReturnType<typeof useChatConversationContext>
  > => {
    const conversation = stateRef.current.conversation;
    const activeId = conversation.activeConversationId ?? null;
    if (!activeId) {
      throw new Error("当前没有进行中的会话，暂时无法回滚");
    }
    const meta = await resolveActiveConversationMeta(activeId);
    if (!isRollbackAvailable(conversation, meta)) {
      throw new Error("子代理 / 工作流节点会话不支持回滚，请切换到普通对话");
    }
    return conversation;
  };

  /** 目标用户消息是否已在桌面会话的消息窗口内。 */
  const hasRollbackTarget = (
    conversation: ReturnType<typeof useChatConversationContext>,
    messageId: string,
  ): boolean =>
    conversation.messages.some(
      (message) => message.id === messageId && message.role === "user",
    );

  /** 当前激活会话已加载的消息条数（翻页写回判定用）。 */
  const activeMessageCount = (): number => {
    const conversation = stateRef.current.conversation;
    const activeId = conversation.activeConversationId;
    return activeId
      ? (stateRef.current.sessions[activeId]?.messages.length ?? 0)
      : 0;
  };

  /**
   * 确保回滚目标已加载进桌面会话内存：手机端「加载更早」取回的历史消息可能
   * 超出桌面已加载的分页窗口，此时沿桌面同一条 loadOlderMessages 通道向前
   * 翻页并等待渲染写回，直到目标进入窗口。返回是否已就绪。
   */
  const ensureRollbackTargetLoaded = async (
    messageId: string,
  ): Promise<boolean> =>
    ensureMessageLoaded(
      messageId,
      {
        isLoaded: (targetId) =>
          hasRollbackTarget(stateRef.current.conversation, targetId),
        hasMoreMessages: () => {
          const conversation = stateRef.current.conversation;
          const activeId = conversation.activeConversationId;
          return Boolean(
            activeId && stateRef.current.sessions[activeId]?.hasMoreMessages,
          );
        },
        getLoadedCount: activeMessageCount,
        loadOlderMessages: () =>
          stateRef.current.conversation.loadOlderMessages(),
      },
      ROLLBACK_TARGET_BUDGET,
    );

  // 输入区快照 → 安全 DTO：只含展示层数据，字符串一律限长。
  const toRemoteChatInput = (
    publication: SnowRemoteChatInputPublication,
  ): SnowRemoteChatInputState => ({
    conversationId: publication.conversationId,
    isSubAgentConversation: publication.isSubAgentConversation,
    isLoadingApiConfig: publication.isLoadingApiConfig,
    selectedModel:
      truncateTo(publication.selectedModel, MAX_IDENTIFIER_LENGTH) ?? "",
    displayModel:
      truncateTo(publication.displayModel, MAX_IDENTIFIER_LENGTH) ?? "",
    modelIds: publication.modelIds
      .slice(0, 500)
      .map((modelId) => truncateTo(modelId, MAX_IDENTIFIER_LENGTH) ?? "")
      .filter(Boolean),
    selectedApiProfile:
      truncateTo(publication.selectedApiProfile, MAX_IDENTIFIER_LENGTH) ?? "",
    apiProfileNames: publication.apiProfileNames
      .slice(0, 100)
      .map((name) => truncateTo(name, MAX_IDENTIFIER_LENGTH) ?? "")
      .filter(Boolean),
    requestMethod: publication.requestMethod,
    effectiveThinkingValue:
      truncateTo(publication.effectiveThinkingValue, MAX_THINKING_LENGTH) ?? "",
    thinkingOptions: publication.thinkingOptions
      .slice(0, MAX_THINKING_OPTIONS)
      .map((option) => ({
        value: truncateTo(option.value, MAX_THINKING_LENGTH) ?? "",
        label: truncateTo(option.label, MAX_THINKING_LENGTH) ?? "",
      })),
    responsesFastMode: publication.responsesFastMode,
    maxContextTokens:
      typeof publication.maxContextTokens === "number" &&
      Number.isFinite(publication.maxContextTokens) &&
      publication.maxContextTokens > 0
        ? Math.floor(publication.maxContextTokens)
        : null,
    tokenUsage: toRemoteTokenUsage(stateRef.current.conversation.tokenUsage),
    commands: publication.commands.slice(0, MAX_COMMANDS).map((command) => ({
      id: command.id,
      label: truncateTo(command.label, 200) ?? "",
      description: truncateTo(command.description, 500) ?? "",
      disabled: Boolean(command.disabled),
    })),
  });

  const conversationCacheRef = useRef<{
    expiresAt: number;
    conversations: SnowRemoteState["conversations"];
    totals: SnowRemoteState["conversationTotals"];
  }>({
    expiresAt: 0,
    conversations: [],
    totals: {},
  });

  /** 子树缓存（见 CONVERSATION_CHILDREN_TTL_MS）：列表条目的静态字段之外的部分。 */
  const conversationChildrenRef = useRef<{
    expiresAt: number;
    byParent: RemoteConversationChildren;
  }>({
    expiresAt: 0,
    byParent: {},
  });

  /**
   * 会话运行态集合：与桌面侧边栏同源（同一份会话上下文），
   * 覆盖主会话、Workflow 节点会话与子代理会话。
   */
  const conversationRuntimeSets = (): ConversationRuntimeSets => {
    const current = stateRef.current.conversation;
    return {
      streamingIds: current.streamingConversationIds,
      pausedIds: new Set(
        Object.entries(stateRef.current.sessions)
          .filter(([, session]) => session.isPaused)
          .map(([conversationId]) => conversationId),
      ),
      attentionIds: current.attentionRequiredConversationIds,
      completedIds: current.completedConversationIds,
    };
  };

  /**
   * 拉取会话的树形子层，层级与桌面侧边栏一致：
   * 主会话 → Workflow 节点会话 → 节点派生的子代理，另有主会话直接派生的子代理。
   * 两次批量查询（节点按主会话、子代理按「主会话 + 节点会话」）避免 N+1；
   * 子条目的 workspaceName 按 directoryId 回填（列表分组只用主会话，缺省为空串）。
   */
  const fetchConversationChildren = async (
    parents: SnowRemoteConversation[],
  ): Promise<RemoteConversationChildren> => {
    if (parents.length === 0) {
      return {};
    }
    const workspaceNames = new Map(
      parents.map((parent) => [parent.directoryId, parent.workspaceName]),
    );
    const toChild = (item: ChatConversationRecord): SnowRemoteConversation =>
      toRemoteConversation(item, workspaceNames.get(item.directoryId) ?? "");
    const parentIds = parents.map((parent) => parent.conversationId);
    const nodeMap =
      await window.snow.listWorkflowNodeSessionsByParents(parentIds);
    const nodes = Object.values(nodeMap).flat();
    const subAgentMap = await window.snow.listSubAgentConversationsByParents([
      ...parentIds,
      ...nodes.map((node) => node.conversationId),
    ]);

    // 平铺成「父会话 id → 子层」一张表：节点会话的 id 同样作为父级出现，
    // 由 withConversationRuntime 递归展开，形成三层结构。
    // 同一父会话既有节点又有直接子代理时两者合并（节点在前）。
    const byParent: RemoteConversationChildren = {};
    const append = (
      parentId: string,
      items: SnowRemoteConversation[],
    ): void => {
      byParent[parentId] = [...(byParent[parentId] ?? []), ...items];
    };
    for (const [parentId, items] of Object.entries(nodeMap)) {
      append(parentId, items.map(toChild));
    }
    for (const [parentId, items] of Object.entries(subAgentMap)) {
      append(parentId, items.map(toChild));
    }
    return byParent;
  };

  const todosCacheRef = useRef<{
    conversationId: string;
    expiresAt: number;
    items: SnowRemoteTodoItem[];
  } | null>(null);

  /**
   * 会话待办快照：命中缓存（见 TODO_CACHE_TTL_MS）时直接复用，否则按会话
   * 调用真实 todo-todo-manage 工具读取——与桌面顶部待办面板同一数据源，
   * 因此手机端看到的完成度与桌面完全一致。会话隔离：读取按会话 ID 进行，
   * 无活动会话或读取失败时返回 null（移动端隐藏待办入口）。
   */
  const resolveTodos = async (
    conversationId: string | null,
  ): Promise<SnowRemoteTodoItem[] | null> => {
    if (!conversationId) {
      todosCacheRef.current = null;
      return null;
    }
    const cached = todosCacheRef.current;
    if (
      cached &&
      cached.conversationId === conversationId &&
      cached.expiresAt > Date.now()
    ) {
      return cached.items;
    }

    try {
      const result = await window.snow.callMcpTool(
        "todo-todo-manage",
        JSON.stringify({ action: "get" }),
        stateRef.current.activeDirectory?.directoryId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        conversationId,
      );
      const items = (parseTodoResult(result)?.todos ?? [])
        .slice(0, MAX_TODOS)
        .map((todo) => ({
          id: todo.id,
          content: truncateTo(todo.content, MAX_TODO_CONTENT_LENGTH) ?? "",
          status: todo.status,
        }));
      todosCacheRef.current = {
        conversationId,
        expiresAt: Date.now() + TODO_CACHE_TTL_MS,
        items,
      };
      return items;
    } catch {
      // 读取失败（工具暂不可用等）：本轮不下发待办，也不缓存，
      // 由下一次轮询重试；把失败当成空列表会让手机端误以为列表被清空。
      return null;
    }
  };

  /** 激活会话身份缓存（见 ACTIVE_CONVERSATION_TTL_MS / 子会话短 TTL）。 */
  const activeConversationMetaRef = useRef<{
    conversationId: string;
    expiresAt: number;
    meta: ActiveConversationMeta;
  } | null>(null);

  /**
   * 激活会话身份快照：判据与桌面 ChatContent 的 activeConversationMeta 同源
   * ——本次运行内激活过的子代理以 live 事件为准（状态变化即时可见），其余读
   * 会话记录（历史子代理 / Workflow 节点会话只有落盘状态）。记录按会话 id
   * 缓存并区分主 / 子会话 TTL；读不到记录（会话刚创建等）时不写缓存，
   * 交给下一轮轮询重试，避免空快照把「已结束的子代理」钉成可输入。
   */
  const resolveActiveConversationMeta = async (
    activeId: string | null,
  ): Promise<ActiveConversationMeta> => {
    if (!activeId) {
      activeConversationMetaRef.current = null;
      return EMPTY_ACTIVE_CONVERSATION_META;
    }
    const cached = activeConversationMetaRef.current;
    if (
      !cached ||
      cached.conversationId !== activeId ||
      cached.expiresAt <= Date.now()
    ) {
      const record = await window.snow
        .getChatConversation(activeId)
        .catch(() => null);
      activeConversationMetaRef.current = record
        ? {
            conversationId: activeId,
            expiresAt:
              Date.now() +
              (isChildConversationType(record.conversationType)
                ? ACTIVE_CHILD_CONVERSATION_TTL_MS
                : ACTIVE_CONVERSATION_TTL_MS),
            meta: {
              conversationType: record.conversationType,
              runStatus: record.subAgentStatus,
              parentConversationId: record.parentConversationId,
            },
          }
        : null;
    }
    const meta =
      activeConversationMetaRef.current?.conversationId === activeId
        ? activeConversationMetaRef.current.meta
        : EMPTY_ACTIVE_CONVERSATION_META;
    const live = stateRef.current.conversation.subAgentSessionEvents[activeId];
    return live
      ? {
          conversationType: "sub_agent",
          runStatus: live.status,
          parentConversationId:
            live.parentConversationId || meta.parentConversationId,
        }
      : meta;
  };

  /** workflow 动作的执行上下文（执行 / 反馈按当前激活会话定位 flow）。 */
  const workflowRemoteContext = (
    current: typeof stateRef.current,
    conversationId: string,
  ): WorkflowRemoteContext => ({
    conversation: current.conversation,
    conversationId,
    directoryId: current.activeDirectory?.directoryId ?? "",
  });

  /**
   * 为 workflow 工具调用附加卡片快照：节点图与运行态由 renderer 侧的
   * remoteControlWorkflow 按 flow 组装（挂起 / 活跃 run 读内存，其余读 DB，
   * 带缓存）。arguments 取源消息的完整原文——下发给手机的工具参数经过脱敏，
   * 不能用于解析图数据。
   */
  const attachWorkflowSnapshots = async (
    sourceMessages: ChatConversationMessage[],
    messages: SnowRemoteMessage[],
    conversationId: string | null,
  ): Promise<SnowRemoteMessage[]> => {
    if (!conversationId) {
      return messages;
    }
    const sourceById = new Map(
      sourceMessages.map((message) => [message.id, message]),
    );
    return Promise.all(
      messages.map(async (message) => {
        const toolCalls = message.toolCalls;
        if (!toolCalls?.length) {
          return message;
        }
        const sourceToolCalls = sourceById.get(message.id)?.toolCalls ?? [];
        const nextToolCalls = await Promise.all(
          toolCalls.map(async (toolCall) => {
            const origin = sourceToolCalls.find(
              (item) => item.interactionId === toolCall.interactionId,
            );
            if (!origin) {
              return toolCall;
            }
            const workflow = await resolveWorkflowSnapshot(
              conversationId,
              origin,
            );
            return workflow ? { ...toolCall, workflow } : toolCall;
          }),
        );
        return { ...message, toolCalls: nextToolCalls };
      }),
    );
  };

  // ── Git 面板（移动端） ──────────────────────────────────────────────────

  /** 当前 Git 仓库：与桌面顶栏 BranchSelector 一致，取工作区主目录。 */
  const resolveGitRepo = (): { directoryId: string; repoPath: string } => {
    const directory = stateRef.current.activeDirectory;
    if (!directory) throw new Error("请先选择项目");
    return { directoryId: directory.directoryId, repoPath: directory.path };
  };

  /**
   * 拉取 / 推送目标：与桌面 GitControl 的 selectedRemote 规则一致——
   * upstream 跟踪的远端优先，其次 origin，最后第一个远端。
   */
  const resolveGitSyncTarget = async (
    repoPath: string,
  ): Promise<{ branch: string; remote: string; setUpstream: boolean }> => {
    const status = await window.snow.gitStatus(repoPath);
    if (!status.isRepo) throw new Error("当前项目不是 Git 仓库");
    const branch = (status.currentBranch || "").trim();
    if (!branch) throw new Error("当前处于游离 HEAD，无法拉取或推送");
    const remotes = await window.snow.gitRemotes(repoPath).catch(() => []);
    const upstream = status.upstream ?? "";
    const tracking = upstream
      ? remotes
          .filter((item) => upstream.startsWith(`${item.name}/`))
          .sort((left, right) => right.name.length - left.name.length)[0]
      : undefined;
    const remoteName =
      tracking?.name ??
      remotes.find((item) => item.name === "origin")?.name ??
      remotes[0]?.name ??
      "";
    if (!remoteName) throw new Error("当前仓库未配置远端");
    return {
      branch,
      remote: remoteName,
      setUpstream: !upstream || !upstream.startsWith(`${remoteName}/`),
    };
  };

  /** 会话运行中（流式 / 停止中 / 压缩中）：分支与工作树操作被锁定。 */
  const isGitSessionRunning = (): boolean => {
    const conversation = stateRef.current.conversation;
    return Boolean(
      conversation.isStreaming ||
      conversation.isAborting ||
      conversation.isCompacting,
    );
  };

  /** 当前会话绑定的工作树（无会话时取新会话的预绑定值）。 */
  const resolveBoundWorktreeId = async (): Promise<string | null> => {
    const conversation = stateRef.current.conversation;
    if (conversation.activeConversationId) {
      const bound = await window.snow
        .getConversationWorktree(conversation.activeConversationId)
        .catch(() => null);
      return bound?.worktreeId ?? null;
    }
    return conversation.pendingWorktreeId;
  };

  const assertGitWorktreeMutationAllowed = (): void => {
    if (isGitSessionRunning()) {
      throw new Error("会话运行中，暂不可修改分支或工作树");
    }
  };

  /** 校验并去重来自当前 status 的路径；staged 决定匹配暂存区还是工作区。 */
  const resolveGitPaths = async (
    paths: unknown,
    staged: boolean,
  ): Promise<{ repoPath: string; unique: string[] }> => {
    const { repoPath } = resolveGitRepo();
    if (!Array.isArray(paths)) throw new Error("文件列表无效");
    const unique = Array.from(
      new Set(paths.map((item) => (typeof item === "string" ? item : ""))),
    ).filter(Boolean);
    const totalChars = unique.reduce((sum, item) => sum + item.length, 0);
    if (
      unique.length === 0 ||
      unique.length > MAX_GIT_PATHS ||
      totalChars > MAX_GIT_PATHS_TOTAL ||
      unique.some(
        (item) =>
          item.length > MAX_GIT_PATH_LENGTH ||
          item.startsWith("/") ||
          item.startsWith("\\"),
      )
    ) {
      throw new Error("文件列表无效");
    }
    const status = await window.snow.gitStatus(repoPath);
    if (!status.isRepo) throw new Error("当前项目不是 Git 仓库");
    const eligible = new Set(
      status.files
        .filter((file) =>
          staged
            ? file.indexStatus !== " " &&
              file.indexStatus !== "?" &&
              file.indexStatus !== ""
            : file.workdirStatus === "?" ||
              (file.workdirStatus !== " " && file.workdirStatus !== ""),
        )
        .map((file) => file.path),
    );
    if (unique.some((path) => !eligible.has(path))) {
      throw new Error("文件状态已变化，请刷新后重试");
    }
    return { repoPath, unique };
  };

  /** 暂存 / 取消暂存：路径必须来自当前 status，拒绝过期或伪造路径。 */
  const runGitStageAction = async (
    paths: unknown,
    staged: boolean,
  ): Promise<{ ok: true }> => {
    const { repoPath, unique } = await resolveGitPaths(paths, staged);
    const result = staged
      ? await window.snow.gitUnstage(repoPath, unique)
      : await window.snow.gitStage(repoPath, unique);
    if (!result.success) {
      throw new Error(result.message || (staged ? "取消暂存失败" : "暂存失败"));
    }
    return { ok: true };
  };

  /** 放弃未暂存修改：与桌面「放弃修改」走同一条 gitDiscardChanges 链路。 */
  const runGitDiscardAction = async (paths: unknown): Promise<{ ok: true }> => {
    const { repoPath, unique } = await resolveGitPaths(paths, false);
    const result = await window.snow.gitDiscardChanges(repoPath, unique);
    if (!result.success) {
      throw new Error(result.message || "放弃修改失败");
    }
    return { ok: true };
  };

  useEffect(() => {
    const api: SnowRemoteControlApi = {
      getMessageImage: async (messageId, imageIndex) => {
        if (!messageId || !Number.isInteger(imageIndex) || imageIndex < 0) {
          throw new Error("图片标识无效");
        }
        const message = stateRef.current.conversation.messages.find(
          (item) => item.id === messageId && item.role === "user",
        );
        if (!message) throw new Error("图片不可用");
        const image = parseContentSegments(message.content).filter(
          (segment) => segment.type === "image",
        )[imageIndex];
        if (!image || image.type !== "image") throw new Error("图片不可用");
        // 已落盘消息的标签值是 upload/ 路径，不在渲染进程持有图片数据：
        // 抛错交由 Rust 取图接口按消息 id 从数据库 + 磁盘读取。
        const match = image.tag.dataUrl.match(
          /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/,
        );
        if (!match) throw new Error("图片未驻留内存");
        return { mimeType: match[1], base64: match[2] };
      },
      getSkills: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        const skills = await window.snow.listAvailableSkills(
          directoryId ?? undefined,
        );
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        ) {
          throw new Error("项目已切换，请重新打开 Skills");
        }
        return {
          directoryId,
          skills: skills
            .slice(0, 500)
            .map((skill) => ({
              id: truncateTo(skill.id, MAX_IDENTIFIER_LENGTH) ?? "",
              name: truncateTo(skill.name, 240) ?? "",
              description: truncateTo(skill.description, 1_000) ?? "",
              location: skill.location,
              source: skill.source,
              allowedTools: (skill.allowedTools ?? [])
                .slice(0, 50)
                .map((tool) => truncateTo(tool, MAX_IDENTIFIER_LENGTH) ?? "")
                .filter(Boolean),
              enabled: Boolean(skill.enabled),
            }))
            .filter((skill) => skill.id),
        };
      },
      setSkillEnabled: async (skillId, enabled, expectedDirectoryId) => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        if (directoryId !== expectedDirectoryId) {
          throw new Error("项目已切换，请重新打开 Skills");
        }
        const normalizedId = normalizeRemoteIdentifier(skillId);
        const skills = await window.snow.listAvailableSkills(
          directoryId ?? undefined,
        );
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        ) {
          throw new Error("项目已切换，请重试");
        }
        const skill = skills.find((item) => item.id === normalizedId);
        if (!skill) throw new Error("Skill 不存在或已不可用");
        await window.snow.setSkillEnabled(
          skill.location === "project" ? (directoryId ?? undefined) : undefined,
          skill.id,
          enabled,
        );
        return { ok: true };
      },
      getMcpServers: async () => {
        const directoryId = stateRef.current.activeDirectory?.directoryId;
        if (!directoryId) throw new Error("请先选择项目");
        const servers = await window.snow.listMcpProjectServers(directoryId);
        if (stateRef.current.activeDirectory?.directoryId !== directoryId) {
          throw new Error("项目已切换，请重新打开 MCP");
        }
        return {
          directoryId,
          servers: servers
            .slice(0, 100)
            .map((server) => ({
              id: truncateTo(server.id, MAX_IDENTIFIER_LENGTH) ?? "",
              name: truncateTo(server.name, 240) ?? "",
              source: server.source,
              globalEnabled: Boolean(server.globalEnabled),
              enabled: Boolean(server.enabled),
              available: !server.error,
              tools: server.tools
                .slice(0, 500)
                .map((tool) => ({
                  name: truncateTo(tool.name, MAX_IDENTIFIER_LENGTH) ?? "",
                  description: truncateTo(tool.description, 500) ?? "",
                  enabled: Boolean(tool.enabled),
                }))
                .filter((tool) => tool.name),
            }))
            .filter((server) => server.id),
        };
      },
      setMcpEnabled: async (target, id, enabled, expectedDirectoryId) => {
        const directoryId = stateRef.current.activeDirectory?.directoryId;
        if (!directoryId || directoryId !== expectedDirectoryId) {
          throw new Error("项目已切换，请重新打开 MCP");
        }
        const servers = await window.snow.listMcpProjectServers(directoryId);
        if (stateRef.current.activeDirectory?.directoryId !== directoryId) {
          throw new Error("项目已切换，请重试");
        }
        if (target === "server") {
          const server = servers.find((item) => item.id === id);
          if (!server || !server.globalEnabled)
            throw new Error("MCP 服务不可修改");
          await window.snow.setMcpProjectServerEnabled(
            directoryId,
            server.id,
            enabled,
          );
          notifyMcpServerStateChanged();
          if (
            enabled &&
            [
              "builtin:browser",
              "builtin:app-control",
              "builtin:terminal",
            ].includes(server.id)
          ) {
            window.dispatchEvent(new CustomEvent("lite-mode:changed"));
          }
        } else {
          const server = servers.find(
            (item) =>
              item.enabled &&
              item.globalEnabled &&
              item.tools.some((tool) => tool.name === id),
          );
          if (!server) throw new Error("MCP 工具不可修改");
          await window.snow.setMcpProjectToolEnabled(directoryId, id, enabled);
        }
        return { ok: true };
      },
      /**
       * 变更面板（/changes）数据：与桌面 FileChangesPanel 同源 —— 回滚链才是
       * 「本会话修改了哪些文件」的权威口径，工具记录只用于补齐代理归属（链
       * 不可用时回退成完整清单，与桌面同一兜底）。这里只下发链路描述（检查点
       * + 工作目录）与归属数据；逐文件 diff 与 +/- 统计由 Rust 原生检查点服务
       * 直接计算（含 SSH/SFTP 通道），避免慢遍历卡在桥的 12 秒超时上。
       */
      getChanges: async (expectedConversationId = null) => {
        const conversation = stateRef.current.conversation;
        const conversationId = conversation.activeConversationId ?? null;
        if (
          expectedConversationId !== null &&
          expectedConversationId !== conversationId
        ) {
          throw new Error("会话已切换，请重新打开变更");
        }
        if (!conversationId) {
          return {
            conversationId: null,
            checkpointIds: [],
            workDir: "",
            changes: [],
          };
        }
        const changes: SnowRemoteChange[] = collectConversationFileChanges(
          conversation.fileChangeStats,
          conversationId,
        ).map((record) => ({
          path: truncateTo(record.filePath, MAX_ROLLBACK_PATH_LENGTH) ?? "",
          kind: record.kind,
          agent: record.agent,
          subAgentName: record.subAgentName
            ? (truncateTo(record.subAgentName, MAX_IDENTIFIER_LENGTH) ??
              undefined)
            : undefined,
          ...countFileChangeLines([record]),
        }));
        const chain = await resolveConversationChangeChain({
          conversationId,
          checkpointIds: conversation.checkpointIds,
          baselineCheckpointId: conversation.baselineCheckpointId,
          workDir: directoryIdToPath(conversation.conversationDirectoryId),
          messages: conversation.messages,
          worktreeMode: conversation.worktreeMode,
          worktreeId: conversation.pendingWorktreeId,
          directoryId: conversation.conversationDirectoryId,
        });
        if (
          stateRef.current.conversation.activeConversationId !== conversationId
        ) {
          throw new Error("会话已切换，请重新打开变更");
        }
        return {
          conversationId,
          checkpointIds: chain?.checkpointIds ?? [],
          workDir: chain?.workDir ?? "",
          changes: changes.filter((change) => change.path),
        };
      },
      /**
       * 会话待办变更：复用桌面真实 todo-todo-manage 工具（add / update /
       * delete），会话 ID 由桥注入，移动端无法跨会话读写。变更后立即失效
       * 快照缓存，调用方随后刷新 /api/state 即可拿到最新列表。
       * 与桌面顶部待办面板一致：会话运行中待办由 AI 管理，不接受手动变更。
       */
      mutateTodos: async (
        action: "add" | "update" | "delete",
        payload:
          | { content?: string; todoId?: string; status?: SnowRemoteTodoStatus }
          | undefined,
      ): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        const conversationId = current.activeConversationId ?? null;
        if (!conversationId) {
          throw new Error("当前没有进行中的会话，暂时无法管理待办");
        }
        if (current.isStreaming) {
          throw new Error("会话运行中，待办由 AI 管理，请稍后再试");
        }

        const args: Record<string, string> = {};
        if (action === "add") {
          const content =
            typeof payload?.content === "string" ? payload.content.trim() : "";
          if (!content) throw new Error("待办内容不能为空");
          if (content.length > MAX_TODO_CONTENT_LENGTH) {
            throw new Error(
              `待办内容不能超过 ${MAX_TODO_CONTENT_LENGTH} 个字符`,
            );
          }
          args.action = "add";
          args.content = content;
        } else if (action === "update" || action === "delete") {
          const todoId = normalizeRemoteIdentifier(payload?.todoId ?? "");
          if (!todoId) throw new Error("待办条目不存在或已过期");
          args.action = action;
          args.todoId = todoId;
          if (action === "update") {
            const status = payload?.status;
            if (
              status !== "pending" &&
              status !== "inProgress" &&
              status !== "completed"
            ) {
              throw new Error("待办状态无效");
            }
            args.status = status;
          }
        } else {
          throw new Error("不支持的待办操作");
        }

        await window.snow.callMcpTool(
          "todo-todo-manage",
          JSON.stringify(args),
          stateRef.current.activeDirectory?.directoryId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          conversationId,
        );
        todosCacheRef.current = null;
        return { ok: true };
      },
      /**
       * 执行挂起的 WorkFlow：与桌面卡片「执行」按钮共用同一渲染进程执行器
       * （含断点续跑：已完成节点自动跳过），任务在后台运行并立即返回，移动端
       * 通过 /api/state 的 workflow 快照轮询进度；完成后按卡片同一载荷结算
       * 挂起的工具调用（模型侧可见执行汇总）。
       */
      runWorkflow: async (flowId: string): Promise<{ ok: true }> => {
        const current = stateRef.current;
        const conversationId = current.conversation.activeConversationId ?? "";
        if (!conversationId) {
          throw new Error("当前没有进行中的会话，暂时无法执行工作流");
        }
        await runRemoteWorkflow(
          workflowRemoteContext(current, conversationId),
          flowId,
        );
        return { ok: true };
      },
      /**
       * 提交对流程的修改意见：结算挂起的 workflow-generate（模型据此重新
       * 设计流程），与桌面卡片反馈入口同语义。
       */
      replyWorkflow: async (
        flowId: string,
        message: string,
      ): Promise<{ ok: true }> => {
        const current = stateRef.current;
        const conversationId = current.conversation.activeConversationId ?? "";
        if (!conversationId) {
          throw new Error("当前没有进行中的会话，暂时无法提交反馈");
        }
        await replyRemoteWorkflow(
          workflowRemoteContext(current, conversationId),
          flowId,
          message,
        );
        return { ok: true };
      },
      /**
       * 派生分支会话：与桌面 AiResponseActions 的分支按钮走同一条
       * handleForkConversation 链路（新建会话 → 侧栏 upsert → 切换到新会话）。
       * 目标必须是当前激活会话；responseId 由消息自带（缺失时派生整段会话）。
       */
      forkConversation: async (
        conversationId: string,
        upToResponseId: string,
      ): Promise<{ ok: true; conversationId: string }> => {
        const current = stateRef.current.conversation;
        const activeId = current.activeConversationId ?? "";
        const targetId = normalizeRemoteIdentifier(conversationId);
        if (!activeId || targetId !== activeId) {
          throw new Error("会话已切换，请重试");
        }
        const responseId = normalizeRemoteIdentifier(upToResponseId);
        if (responseId.length > MAX_IDENTIFIER_LENGTH) {
          throw new Error("分支目标无效");
        }
        const forked = await window.snow.forkConversation(targetId, responseId);
        current.refreshConversations();
        // 切换会话会加载历史；不阻塞本次桥调用，避免手机端等满桥超时。
        void current
          .handleSelectConversation(
            forked.conversationId,
            forked.summary || forked.title,
            {
              inputTokens: forked.inputTokens,
              outputTokens: forked.outputTokens,
              cacheCreationInputTokens: forked.cacheCreationInputTokens,
              cacheReadInputTokens: forked.cacheReadInputTokens,
            },
            forked.directoryId,
          )
          .catch(() => {});
        return { ok: true, conversationId: forked.conversationId };
      },
      /**
       * 回滚状态：手机端弹窗期间轮询。preparing 表示桌面正在中止运行并计算文件
       * 变更（SSH 下经 SFTP 遍历可能较慢）；preview 就绪后下发与电脑端
       * RollbackConfirmDialog 同源的完整清单，手机端只做展示与确认。
       */
      getRollbackState: async (): Promise<SnowRemoteRollbackState> => {
        const conversation = stateRef.current.conversation;
        const preview = conversation.rollbackPreview;
        return {
          conversationId: conversation.activeConversationId ?? null,
          preparingMessageId: conversation.rollbackPreparingMessageId ?? null,
          preview: preview
            ? {
                messageId: preview.messageId,
                changes: preview.changes
                  .slice(0, MAX_ROLLBACK_CHANGES)
                  .map((change) => ({
                    path:
                      truncateTo(change.path, MAX_ROLLBACK_PATH_LENGTH) ?? "",
                    changeType: toRollbackChangeType(change.changeType),
                  })),
                changeTotals: preview.changes.reduce(
                  (totals, change) => {
                    totals[toRollbackChangeType(change.changeType)] += 1;
                    return totals;
                  },
                  { added: 0, modified: 0, deleted: 0 },
                ),
                checkpointIds: [
                  ...preview.checkpointIds,
                  ...preview.flowCheckpointIds,
                ].slice(0, MAX_ROLLBACK_CHECKPOINTS),
                workDir: preview.workDir ?? "",
                isFirstMessage: preview.isFirstMessage,
                // 回填文本与桌面 draftToRestore 同源：手机端拿不到已随截断
                // 消失的消息正文（首条消息回滚还会整会话删除）。
                messageContent: preview.isContextCompaction
                  ? ""
                  : toRemoteUserText(preview.messageContent),
                todoItems: preview.todoItems
                  .slice(0, MAX_ROLLBACK_TODOS)
                  .map((todo) => ({
                    id: normalizeRemoteIdentifier(todo.id),
                    content:
                      truncateTo(todo.content, MAX_TODO_CONTENT_LENGTH) ?? "",
                    status: toTodoStatus(todo.status),
                  }))
                  .filter((todo) => todo.id),
                memoryItems: preview.memoryItems
                  .slice(0, MAX_ROLLBACK_MEMORIES)
                  .map((memory) => ({
                    memoryId: normalizeRemoteIdentifier(memory.memoryId),
                    title:
                      truncateTo(
                        memory.title,
                        MAX_ROLLBACK_MEMORY_TITLE_LENGTH,
                      ) ?? "",
                    kind: truncateTo(memory.kind, MAX_IDENTIFIER_LENGTH) ?? "",
                  }))
                  .filter((memory) => memory.memoryId),
                workflowFlowCount: Math.max(0, preview.workflowFlowCount),
                error: preview.error
                  ? truncateTo(preview.error, 500)
                  : undefined,
              }
            : null,
        };
      },
      /**
       * 发起回滚：直接复用桌面 handleRollback —— 它在中止流 / 终止 WorkFlow
       * 节点后异步计算文件变更并写入会话上下文（电脑端弹窗同时弹出，用户在
       * 电脑端取消同样会结束手机端这次预览）。这里立即返回，手机端轮询
       * getRollbackState 获取结果。
       *
       * 目标消息不在桌面会话窗口内时（手机端「加载更早」取回的历史消息）先沿
       * 桌面同一条 loadOlderMessages 通道把它加载进内存：检查点清单与截断边界
       * 都取自完整数据库历史，因此结果与在电脑端滚动到该消息后回滚完全一致。
       */
      startRollback: async (messageId: string): Promise<{ ok: true }> => {
        const conversation = await requireRollbackConversation();
        const target = normalizeRemoteIdentifier(messageId);
        if (!target) {
          throw new Error("回滚目标无效");
        }
        if (conversation.rollbackPreparingMessageId) {
          throw new Error("正在计算回滚变更，请稍候");
        }
        // 与桌面一致：运行中不提供回滚入口（桌面在流式期间隐藏该按钮）。
        if (conversation.isStreaming) {
          throw new Error("会话正在运行，请先停止后再回滚");
        }
        if (!(await ensureRollbackTargetLoaded(target))) {
          throw new Error(
            "这条消息太早，电脑端暂时无法加载，请在电脑端打开该会话并滚动到这条消息后重试",
          );
        }
        // 重新读取最新上下文：翻页加载会刷新会话消息窗口。
        stateRef.current.conversation.handleRollback(target);
        return { ok: true };
      },
      /**
       * 确认回滚：复用桌面 confirmRollback（文件恢复 → 会话截断 / 首条消息
       * 删除 → 清理检查点，可选清理项目记忆）。messageId 用于确认预览仍是
       * 当前这次，避免手机端拿旧弹窗提交已失效的回滚。
       */
      confirmRollback: async (
        messageId: string,
        mode: SnowRemoteRollbackMode,
        deleteMemories: boolean,
      ): Promise<{ ok: true }> => {
        const conversation = await requireRollbackConversation();
        const target = normalizeRemoteIdentifier(messageId);
        if (mode !== "conversation-only" && mode !== "conversation-and-files") {
          throw new Error("回滚方式无效");
        }
        if (!target || conversation.rollbackPreview?.messageId !== target) {
          throw new Error("回滚预览已失效，请重新发起回滚");
        }
        await conversation.confirmRollback(mode, deleteMemories === true);
        return { ok: true };
      },
      /** 取消回滚预览（含正在计算中的请求）；桌面同一次预览一并关闭。 */
      cancelRollback: async (messageId: string): Promise<{ ok: true }> => {
        const conversation = stateRef.current.conversation;
        const target = normalizeRemoteIdentifier(messageId);
        const preview = conversation.rollbackPreview;
        if (
          !target ||
          (preview?.messageId !== target &&
            conversation.rollbackPreparingMessageId !== target)
        ) {
          throw new Error("回滚已结束或已取消");
        }
        conversation.cancelRollback();
        return { ok: true };
      },
      getPermissions: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        const [project, global, readonly] = await Promise.all([
          directoryId
            ? window.snow.listToolApprovalProjectApprovedTools(directoryId)
            : Promise.resolve([] as string[]),
          window.snow.getAlwaysApprovedTools().catch(() => [] as string[]),
          window.snow.listReadonlyTools().catch(() => [] as string[]),
        ]);
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        )
          throw new Error("项目已切换，请重新打开权限");
        const sanitize = (items: string[]) =>
          Array.from(new Set(items))
            .slice(0, 500)
            .map((item) => truncateTo(item, MAX_IDENTIFIER_LENGTH) ?? "")
            .filter(Boolean);
        return {
          directoryId,
          projectApprovedTools: sanitize(project),
          globalApprovedTools: sanitize(global),
          readonlyToolCount: Math.min(1000, readonly.length),
          yolo: Boolean(stateRef.current.conversation.yoloMode),
        };
      },
      getRole: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        const workspace = directoryId
          ? (await window.snow.listWorkspaceDirectories()).find(
              (item) => item.directoryId === directoryId,
            )
          : null;
        if (!workspace) {
          const global = await window.snow
            .getGlobalRole()
            .catch(() => ({ content: "" }));
          const content =
            typeof global.content === "string" ? global.content : "";
          return {
            directoryId,
            source: content ? ("global" as const) : ("none" as const),
            exists: Boolean(content),
            characterCount: content.length,
            preview: truncateTo(content, 1200) ?? "",
            editable: false,
            reason: "请先在桌面选择项目以查看项目角色",
          };
        }
        if (workspace.path.startsWith("ssh://"))
          return {
            directoryId,
            source: "ssh" as const,
            exists: false,
            characterCount: 0,
            preview: "",
            editable: false,
            reason:
              "SSH 项目的 ROLE.md 需要桌面凭据与工作区会话，手机仅显示状态",
          };
        const filePath = workspace.path + "/ROLE.md";
        let content = "";
        try {
          const result = await window.snow.readFileContent(filePath);
          if (!result.isBinary) content = result.content;
        } catch {
          content = "";
        }
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        )
          throw new Error("项目已切换，请重新打开角色");
        return {
          directoryId,
          source: content ? ("project" as const) : ("none" as const),
          exists: Boolean(content),
          characterCount: content.length,
          preview: truncateTo(content, 1200) ?? "",
          editable: false,
          reason: content
            ? "手机仅提供只读摘要，编辑请在桌面完成"
            : "当前项目未找到 ROLE.md",
        };
      },
      getSensitiveCommands: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        const [global, project] = await Promise.all([
          window.snow.listSensitiveCommandConfigs().catch(() => []),
          directoryId
            ? window.snow
                .listProjectSensitiveCommandConfigs(directoryId)
                .catch(() => [])
            : Promise.resolve([]),
        ]);
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        )
          throw new Error("项目已切换，请重新打开敏感指令");
        const normalize = (items: Array<any>, scope: "global" | "project") =>
          items
            .slice(0, 300)
            .map((item) => ({
              commandId:
                truncateTo(
                  typeof item.commandId === "string" ? item.commandId : "",
                  MAX_IDENTIFIER_LENGTH,
                ) ?? "",
              pattern:
                truncateTo(
                  typeof item.pattern === "string" ? item.pattern : "",
                  240,
                ) ?? "",
              description:
                truncateTo(
                  typeof item.description === "string" ? item.description : "",
                  500,
                ) ?? "",
              enabled: Boolean(item.enabled),
              scope,
              inherited: Boolean(item.inherited),
              isPreset: Boolean(item.isPreset),
            }))
            .filter((item) => item.commandId && item.pattern);
        return {
          directoryId,
          commands: [
            ...normalize(global, "global"),
            ...normalize(project, "project"),
          ].slice(0, 500),
        };
      },
      getCodebase: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        if (!directoryId)
          return {
            directoryId,
            enabled: false,
            agentReview: false,
            reranking: false,
            indexed: false,
            totalFiles: 0,
            totalChunks: 0,
            totalSizeBytes: 0,
            remote: false,
            reason: "请先选择项目",
          };
        const [scope, stats, remote] = await Promise.all([
          window.snow
            .getCodebaseProjectScopeSettings(directoryId)
            .catch(() => ({
              projectId: directoryId,
              enabled: false,
              enableAgentReview: false,
              enableReranking: false,
            })),
          window.snow.getCodebaseIndexStats(directoryId).catch(() => ({
            totalFiles: 0,
            totalChunks: 0,
            totalSizeBytes: 0,
            isIndexed: false,
          })),
          window.snow.checkProjectIsRemote(directoryId).catch(() => false),
        ]);
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        )
          throw new Error("项目已切换，请重新打开代码库");
        return {
          directoryId,
          enabled: Boolean(scope.enabled),
          agentReview: Boolean(scope.enableAgentReview),
          reranking: Boolean(scope.enableReranking),
          indexed: Boolean(stats.isIndexed),
          totalFiles: Math.min(1000000, Math.max(0, stats.totalFiles || 0)),
          totalChunks: Math.min(5000000, Math.max(0, stats.totalChunks || 0)),
          totalSizeBytes: Math.min(
            1e15,
            Math.max(0, stats.totalSizeBytes || 0),
          ),
          remote: Boolean(remote),
          reason: remote ? "远程项目的扫描与路径操作请在桌面完成" : undefined,
        };
      },
      getReview: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        if (!directoryId)
          return {
            directoryId,
            available: false,
            currentBranch: "",
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            statusLimitHit: false,
            remote: false,
            reason: "请先选择项目",
          };
        const workspace = (await window.snow.listWorkspaceDirectories()).find(
          (item) => item.directoryId === directoryId,
        );
        if (!workspace)
          return {
            directoryId,
            available: false,
            currentBranch: "",
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            statusLimitHit: false,
            remote: false,
            reason: "项目工作区不可用",
          };
        if (workspace.path.startsWith("ssh://"))
          return {
            directoryId,
            available: false,
            currentBranch: "",
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            statusLimitHit: false,
            remote: true,
            reason: "SSH 项目审查需要桌面 Git 会话",
          };
        try {
          const status = await window.snow.gitStatus(workspace.path);
          if (
            (stateRef.current.activeDirectory?.directoryId ?? null) !==
            directoryId
          )
            throw new Error("项目已切换，请重新打开审查");
          return {
            directoryId,
            available: Boolean(status.isRepo),
            currentBranch: truncateTo(status.currentBranch, 240) ?? "",
            stagedCount: Math.min(100000, status.stagedCount || 0),
            unstagedCount: Math.min(100000, status.unstagedCount || 0),
            untrackedCount: Math.min(100000, status.untrackedCount || 0),
            statusLimitHit: Boolean(status.statusLimitHit),
            remote: false,
            reason: status.isRepo
              ? "手机仅显示审查状态，启动审查请在桌面确认"
              : "当前项目不是 Git 仓库",
          };
        } catch {
          return {
            directoryId,
            available: false,
            currentBranch: "",
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            statusLimitHit: false,
            remote: false,
            reason: "Git 状态暂时不可用，请在桌面重试",
          };
        }
      },
      getState: async (): Promise<SnowRemoteState> => {
        const current = stateRef.current;
        const directory = current.activeDirectory;
        const activeConversationId =
          current.conversation.activeConversationId ?? null;
        const now = Date.now();
        const conversations = conversationCacheRef.current.conversations;
        if (conversationCacheRef.current.expiresAt <= now) {
          // The current conversation must reach the phone immediately. A slow
          // workspace/database listing is secondary data for the thread picker
          // and must never block the first /api/state response.
          conversationCacheRef.current.expiresAt = now + 5_000;
          void (async () => {
            const directories = await window.snow.listWorkspaceDirectories();
            const pages = await Promise.all(
              directories.map(async (workspace) => {
                const page = await window.snow.listChatConversationsPaginated(
                  workspace.directoryId,
                  REMOTE_CONVERSATION_PAGE_SIZE,
                  0,
                );
                return { workspace, page };
              }),
            );
            conversationCacheRef.current = {
              expiresAt: Date.now() + 5_000,
              conversations: pages
                .flatMap(({ workspace, page }) =>
                  page.items.map((item) =>
                    toRemoteConversation(item, workspace.name),
                  ),
                )
                .sort((left, right) =>
                  right.updatedAt.localeCompare(left.updatedAt),
                ),
              totals: Object.fromEntries(
                pages.map(({ workspace, page }) => [
                  workspace.directoryId,
                  page.total,
                ]),
              ),
            };
          })().catch(() => {
            conversationCacheRef.current.expiresAt = Date.now() + 1_000;
          });
        }
        if (
          conversations.length > 0 &&
          conversationChildrenRef.current.expiresAt <= now
        ) {
          // 子树（Workflow 节点会话 / 子代理会话）独立刷新：节点或子代理会在
          // 主列表不变的前提下创建并更新状态。列表为空（首轮尚未抓到会话）
          // 时不写 TTL，避免把首次查询推迟到下一个时间窗。
          conversationChildrenRef.current.expiresAt =
            now + CONVERSATION_CHILDREN_TTL_MS;
          void fetchConversationChildren(conversations)
            .then((byParent) => {
              conversationChildrenRef.current = {
                expiresAt: Date.now() + CONVERSATION_CHILDREN_TTL_MS,
                byParent,
              };
            })
            .catch(() => {
              // 查询失败：保留上一轮子树，缩短重试间隔
              conversationChildrenRef.current.expiresAt = Date.now() + 1_000;
            });
        }

        const conversationMessages = current.conversation.messages;
        const remoteMessages = await attachWorkflowSnapshots(
          conversationMessages,
          conversationMessages.slice(-MAX_MESSAGES).map(toRemoteMessage),
          activeConversationId,
        );
        const pendingAuthorizations =
          current.conversation.pendingToolAuthorizations
            .filter(
              (toolCall) =>
                Boolean(toolCall.authorizationId) &&
                toolCall.authorizationConversationId === activeConversationId,
            )
            .map(toRemoteToolCall);
        const pendingQuestions = remoteMessages.flatMap((message) =>
          (message.toolCalls ?? []).flatMap((toolCall) => {
            const question = toolCall.userQuestion;
            if (!question || question.status !== "waiting") {
              return [];
            }
            return [
              {
                questionId: question.questionId,
                question: question.question,
                options: question.options,
              },
            ];
          }),
        );

        // 展示用快照：桌面停留在设置页（输入区已卸载）时仍提供模型 /
        // Profile / 思考强度，手机端不因桌面视图切换而退化显示。
        const chatInputPublication = resolveChatInputForDisplay();
        // 运行态集合每轮只构建一次，供全部列表条目（含树形子层）复用。
        const runtimeSets = conversationRuntimeSets();
        // 激活会话身份（会话类型 / 运行态 / 父会话）：命中缓存时无额外查询。
        const activeConversationMeta =
          await resolveActiveConversationMeta(activeConversationId);

        return {
          workspace: directory
            ? {
                directoryId: directory.directoryId,
                name: directory.name,
                path: directory.path,
              }
            : null,
          activeConversationId,
          isStreaming: current.conversation.isStreaming,
          isAborting: current.conversation.isAborting,
          isCompacting:
            Boolean(current.conversation.isCompacting) &&
            activeConversationId !== null &&
            activeConversationId ===
              current.conversation.compactingConversationId,
          busySendBehavior: busySendBehaviorRef.current,
          compactionError:
            activeConversationId !== null &&
            activeConversationId ===
              current.conversation.compactingConversationId
              ? (current.conversation.compactionError ?? null)
              : null,
          compactionPreview:
            activeConversationId !== null &&
            activeConversationId ===
              current.conversation.compactingConversationId
              ? (current.conversation.compactionPreview ?? "")
              : "",
          attentionRequired:
            activeConversationId !== null &&
            current.conversation.attentionRequiredConversationIds.has(
              activeConversationId,
            ),
          messages: remoteMessages,
          // 待发送队列（会话隔离）：只输出当前激活会话的排队消息，且只含
          // 展示用分段；撤回原文由 withdrawPending 按需返回。
          pendingMessages: current.conversation.pendingMessages.map((text) => ({
            blocks: toRemoteContentBlocks("", text),
          })),
          // 上述队列的定位键（不透明标记）：移动端操作时原样回传，桌面端
          // 按“直接命中 → 槽位迁移映射”解析队列真实位置（新会话迁移到
          // 真实 id 后同样可定位），操作不因会话切换/迁移而失效。
          pendingQueueKey:
            current.conversation.activeSessionKeyRef.current ?? null,
          pendingAuthorizations,
          pendingQuestions,
          // 会话列表：静态字段来自缓存，运行态与树形子层在每次响应实时挂载。
          conversations: conversations.map((item) =>
            withConversationRuntime(
              item,
              runtimeSets,
              conversationChildrenRef.current.byParent,
            ),
          ),
          conversationTotals: conversationCacheRef.current.totals,
          // 无活动会话（如 /clear 后的新建会话视图）没有更早记录；
          // 会话状态尚未建立（undefined）时不下结论，移动端默认隐藏入口、
          // 待状态就绪后跟随更新。
          // 除了桌面会话自己的 DB 分页状态，还必须计入「下发给手机的消息窗口
          // 被截断」：本进程内累积的消息全部在内存里（hasMoreMessages 为
          // false），但手机只拿到最后 MAX_MESSAGES 条，更早的部分仍可沿会话
          // 内存继续翻页——否则手机端会误判为没有更早记录，入口隐藏且滚动
          // 也无法触发加载。
          hasOlderMessages: activeConversationId
            ? Boolean(
                current.sessions[activeConversationId]?.hasMoreMessages,
              ) || conversationMessages.length > MAX_MESSAGES
            : false,
          // 回滚入口可见性：与桌面 canRollback 同源（子代理 / 节点会话不可回滚，
          // 因此手机端用户消息上也不出现回滚按钮）。
          rollbackAvailable: isRollbackAvailable(
            current.conversation,
            activeConversationMeta,
          ),
          // 激活会话身份：移动端据此把已结束的子代理 / Workflow 节点会话切为
          // 只读（输入区替换为收尾栏），并定位「返回主会话」的目标。
          activeConversationType: activeConversationMeta.conversationType,
          activeConversationRunStatus: activeConversationMeta.runStatus,
          activeConversationParentId:
            activeConversationMeta.parentConversationId,
          // 会话待办（会话隔离）：按激活会话读取，切换会话后随快照一起切换。
          todos: await resolveTodos(activeConversationId),
          // 累计运行统计：与桌面最后一条 AI 消息的统计入口同源。
          runStats: toRemoteRunStats(current.conversation),
          modes: {
            goal: current.conversation.goalMode,
            worktree: current.conversation.worktreeMode,
            workflow: current.conversation.workflowMode,
            yolo: current.conversation.yoloMode,
            lite: current.conversation.liteMode,
            // Goal 模式的 Token 预算（0 = 无上限）：与桌面 PlusMenu 的预算
            // 输入同源，手机端动作面板据此回显与调整。
            goalTokenBudget: current.conversation.goalModeTokenBudget,
          },
          // 应用级开关：与桌面 PlusMenu 的自动纠错同源（模块级缓存，
          // 桌面或手机任一侧切换后都即时可见）。
          toolCorrection: await ensureToolCorrectionPreference(),
          theme: {
            accentColor: resolveThemeAccentColor(),
            fontFamily: resolveThemeFontFamily(),
            streamCursor: resolveThemeStreamCursor(),
          },
          chatInput: chatInputPublication
            ? toRemoteChatInput(chatInputPublication)
            : null,
        };
      },

      getMessages: async (conversationId, beforeMessageId, limit) => {
        const current = stateRef.current;
        const activeConversationId =
          current.conversation.activeConversationId ?? null;
        if (!activeConversationId || conversationId !== activeConversationId) {
          throw new Error("会话已切换，请重新加载");
        }
        const anchor =
          typeof beforeMessageId === "string" ? beforeMessageId.trim() : "";
        const session = current.sessions[conversationId];
        // 1. 锚点命中桌面会话内存：本进程内产生的消息只活在内存里（assistant
        //    / tool 消息的 id 是前端临时串，数据库没有对应行，按 id 无法翻页），
        //    直接从内存向前切片——翻页内容与桌面所见完全一致，也不受数据库
        //    分页窗口是否已加载过影响。
        const memoryMessages = current.conversation.messages;
        const memoryIndex = anchor
          ? memoryMessages.findIndex((message) => message.id === anchor)
          : -1;
        if (memoryIndex > 0) {
          const start = Math.max(0, memoryIndex - limit);
          const slice = memoryMessages.slice(start, memoryIndex);
          return {
            conversationId,
            // 内存里还有更早的消息，或者桌面会话本身还有更早的数据库分页。
            hasMore: start > 0 || Boolean(session?.hasMoreMessages),
            items: await attachWorkflowSnapshots(
              memoryMessages,
              slice.map(toRemoteMessage),
              conversationId,
            ),
          };
        }
        // 2. 锚点不在内存（已翻到内存窗口之外）：沿数据库分页。锚点必须是
        //    数据库消息 id（snowflake 纯数字）。渲染进程的临时消息 id
        //    （`role-时间-随机串`，如 assistant/tool 消息）在数据库中没有
        //    对应行，直接传入会让 `id < ?` 的字符串比较命中最新的行而不是更早
        //    的行。此时退回到「已加载的数据库记录中最早的一条」，从它继续向前
        //    翻页；没有任何记录时用空锚取最新页，由移动端按 id 去重收敛。
        let dbAnchor = anchor;
        if (dbAnchor && !/^\d+$/.test(dbAnchor)) {
          const records = session?.messageRecords ?? [];
          if (!records.some((record) => record.id === dbAnchor)) {
            dbAnchor = records[0]?.id ?? "";
          }
        }
        const page = await window.snow.listChatMessagesPaginated(
          conversationId,
          dbAnchor,
          limit,
        );
        if (
          (stateRef.current.conversation.activeConversationId ?? null) !==
          conversationId
        ) {
          throw new Error("会话已切换，请重新加载");
        }
        // 与桌面端历史回放共用同一转换：tool 结果按 name#callId 关联回
        // assistant 消息的 toolCalls；role=tool 的原始记录不再单独推送。
        const sourceMessages = buildConversationMessages(page.items);
        return {
          conversationId,
          hasMore: page.hasMore,
          items: await attachWorkflowSnapshots(
            sourceMessages,
            sourceMessages.map(toRemoteMessage),
            conversationId,
          ),
        };
      },

      getConversations: async (directoryId, limit, offset) => {
        const directories = await window.snow.listWorkspaceDirectories();
        const workspace = directories.find(
          (item) => item.directoryId === directoryId,
        );
        if (!workspace) {
          throw new Error("目标工作区不可用");
        }
        const page = await window.snow.listChatConversationsPaginated(
          directoryId,
          limit,
          offset,
        );
        const items = page.items.map((item) =>
          toRemoteConversation(item, workspace.name),
        );
        // 翻页是用户操作：子树现取（不写 5 秒缓存，实时性优先），
        // 失败时降级为无子树，不阻断列表本身。
        const children = await fetchConversationChildren(items).catch(
          (): RemoteConversationChildren => ({}),
        );
        const runtimeSets = conversationRuntimeSets();
        return {
          directoryId,
          total: page.total,
          items: items.map((item) =>
            withConversationRuntime(item, runtimeSets, children),
          ),
        };
      },

      send: async (
        text,
        attachmentIds = [],
        _requestId,
        expectedContext,
        pairingGeneration,
      ): Promise<{ ok: true }> => {
        const normalized = text.trim();
        if (!normalized && attachmentIds.length === 0) {
          throw new Error("消息不能为空");
        }
        if (normalized.length > MAX_SEND_LENGTH) {
          throw new Error(`消息不能超过 ${MAX_SEND_LENGTH} 个字符`);
        }
        if (
          !expectedContext ||
          typeof pairingGeneration !== "number" ||
          attachmentIds.length > 4
        ) {
          throw new Error("附件上下文无效");
        }
        const currentContext = (): typeof expectedContext => ({
          directoryId: stateRef.current.activeDirectory?.directoryId ?? null,
          conversationId:
            stateRef.current.conversation.activeConversationId ?? null,
        });
        const contextMatches = (): boolean => {
          const current = currentContext();
          return (
            current.directoryId === expectedContext.directoryId &&
            current.conversationId === expectedContext.conversationId
          );
        };
        if (!contextMatches()) throw new Error("会话已切换，请重新发送");
        const attachments = await window.snow.resolveRemoteAttachments(
          attachmentIds,
          expectedContext,
          pairingGeneration,
        );
        if (!contextMatches()) throw new Error("会话已切换，请重新发送");
        const encodedAttachments = attachments.map((attachment) => {
          if (attachment.kind === "image" && attachment.dataUrl) {
            return `@@image:${attachment.dataUrl}@@`;
          }
          if (attachment.kind === "file" && attachment.path) {
            return `@@file:${attachment.path}@@`;
          }
          throw new Error("附件内容无效");
        });
        const message = [normalized, ...encodedAttachments]
          .filter(Boolean)
          .join("\n");
        stateRef.current.onSelectMainView("chat");
        const chatInput = resolveChatInputForDisplay();
        const sendOptions: ChatInputSendOptions = { origin: "user" };
        if (chatInput) {
          sendOptions.model = chatInput.selectedModel || undefined;
          sendOptions.apiProfile = chatInput.selectedApiProfile || undefined;
          sendOptions.thinkingStrength =
            chatInput.effectiveThinkingValue || undefined;
          if (chatInput.requestMethod === "responses") {
            sendOptions.responsesFastMode = chatInput.responsesFastMode;
          }
          sendOptions.conversationRuntimeConfigOverride = {
            thinkingStrength: chatInput.thinkingOverride || null,
            responsesFastMode: chatInput.responsesFastModeOverride,
          };
        }
        // 会话忙（流式 / 停止中）时跟随桌面「繁忙时的发送行为」设置：插话在
        // 下一个安全边界追加要求，排队等本轮结束后再发；空闲时不传
        // deliveryMode（直接开始新回合）。判定与桌面 handleSend 一致。
        const active = stateRef.current.conversation;
        if (active.isStreaming || active.isAborting) {
          sendOptions.deliveryMode = busySendBehaviorRef.current;
        }
        active.handleSendMessage(message, sendOptions);
        return { ok: true };
      },

      abort: async (): Promise<{ ok: true }> => {
        stateRef.current.conversation.handleAbort();
        return { ok: true };
      },

      // 待发送队列操作：移动端原样回传“所见队列”的定位键
      // （pendingQueueKey：不透明标记，新会话槽位 key 或真实会话 id）。
      // useConversationManagement 侧按“直接命中 → 槽位迁移映射”解析出
      // 队列的真实位置并从该队列执行（会话隔离）——无论桌面当前视图在
      // 哪个会话、新会话是否已迁移到真实 id，只要条目仍在队列中就能
      // 撤回/立即发送；条目已被回合边界自动消费时统一报“待发送消息不存在”。
      sendPendingNow: async (
        index,
        expectedQueueKey,
      ): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        if (!Number.isInteger(index) || index < 0) {
          throw new Error("待发送消息不存在");
        }
        const dispatched = current.sendPendingMessageNow(
          index,
          expectedQueueKey ?? undefined,
        );
        if (!dispatched) {
          throw new Error(
            `待发送消息不存在${pendingOperationFailureDetail(current, expectedQueueKey, index)}`,
          );
        }
        return { ok: true };
      },

      withdrawPending: async (
        index,
        expectedQueueKey,
      ): Promise<{ ok: true; text: string }> => {
        const current = stateRef.current.conversation;
        if (!Number.isInteger(index) || index < 0) {
          throw new Error("待发送消息不存在");
        }
        const text = current.withdrawPendingMessage(
          index,
          expectedQueueKey ?? undefined,
        );
        if (text === null) {
          throw new Error(
            `待发送消息不存在${pendingOperationFailureDetail(current, expectedQueueKey, index)}`,
          );
        }
        return { ok: true, text };
      },

      newChat: async (): Promise<{ ok: true }> => {
        // 与桌面顶栏 / 侧边栏的「新建会话」一致：Snow 支持多会话并行，
        // 正在运行的会话留在后台继续跑，不要求先停止。
        const current = stateRef.current.conversation;
        stateRef.current.onSelectMainView("chat");
        current.handleNewChat();
        return { ok: true };
      },

      // 真实模式 setter 链：toolAuthApi.setGoalMode /
      // setWorktreeMode / setWorkflowMode / setYoloMode / setLiteMode。
      // 语义与桌面 PlusMenu 完全一致（布尔开关，可关闭）；
      // Goal/Worktree/Workflow 的互斥由这些 setter 自身保证。
      // 与桌面一致：没有活动会话（新会话视图）时切换同样合法——
      // 会话级模式写入 pending session、应用级设置直接落库，
      // 都随首次发送 / 立即生效，因此这里不要求 activeConversationId。
      // 安全边界：YOLO 只自动批准“普通 pending 工具授权”，
      // 敏感命令仍走桌面端独立确认，YOLO 不是远控鉴权手段。
      setMode: async (mode, enabled): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        // 二次校验：Main 层已做枚举+布尔校验，这里再独立校验一次。
        if (typeof enabled !== "boolean") {
          throw new Error("模式开关必须是布尔值");
        }
        // 与桌面 PlusMenu 的 modesLocked 一致：会话运行中（流式 / 正在停止 /
        // 正在压缩）不允许启停模式（YOLO 不受限）。手机端快照可能滞后，
        // 这里按实时状态兜底拒绝，错误消息由手机端直接展示。
        if (
          mode !== "yolo" &&
          (current.isStreaming ||
            current.isAborting ||
            Boolean(current.isCompacting))
        ) {
          throw new Error("会话进行中，暂不可切换模式");
        }
        switch (mode) {
          case "goal":
            await current.setGoalMode(enabled);
            break;
          case "worktree":
            await current.setWorktreeMode(enabled);
            break;
          case "workflow":
            await current.setWorkflowMode(enabled);
            break;
          case "yolo":
            await current.setYoloMode(enabled);
            break;
          case "lite":
            await current.setLiteMode(enabled);
            break;
          default:
            throw new Error("不支持的模式");
        }
        return { ok: true };
      },

      // Goal 模式的 Token 预算（与桌面 PlusMenu 的预算输入同源）：
      // 0 = 无上限；只写入当前会话的覆盖（随下一次发送落库），
      // 全局默认值不受影响。与桌面一致：会话运行中预算输入被禁用，
      // 这里按实时状态兜底拒绝（手机端快照可能滞后）。
      setGoalTokenBudget: async (budget): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        if (
          typeof budget !== "number" ||
          !Number.isInteger(budget) ||
          budget < 0
        ) {
          throw new Error("Token 预算必须是非负整数");
        }
        if (
          current.isStreaming ||
          current.isAborting ||
          Boolean(current.isCompacting)
        ) {
          throw new Error("会话进行中，暂不可调整 Token 预算");
        }
        await current.setGoalModeTokenBudget(budget);
        return { ok: true };
      },

      // 工具失败自动纠错：应用级设置，复用桌面 PlusMenu 的偏好写入链路
      // （toolCorrectionPreference 同步缓存 + appSettings 持久化）。
      setToolCorrection: async (enabled): Promise<{ ok: true }> => {
        if (typeof enabled !== "boolean") {
          throw new Error("自动纠错开关必须是布尔值");
        }
        await setToolCorrectionPreference(enabled);
        return { ok: true };
      },

      // 复用真实 handleSelectModel setter 链（会话级模型选择）。
      setModel: async (modelId: string): Promise<{ ok: true }> => {
        const normalized = normalizeRemoteIdentifier(modelId);
        if (!normalized) {
          throw new Error("模型 ID 不能为空");
        }
        if (normalized.length > MAX_IDENTIFIER_LENGTH) {
          throw new Error("模型 ID 过长");
        }
        const publication = await ensureChatInputForMutation();
        if (!publication.modelIds.includes(normalized)) {
          throw new Error("模型不存在或尚未加载模型列表");
        }
        await publication.actions.handleSelectModel(normalized);
        return { ok: true };
      },

      // 复用真实 handleSelectApiProfile setter 链（会话级 Profile 绑定）。
      setApiProfile: async (profileName: string): Promise<{ ok: true }> => {
        const normalized = normalizeRemoteIdentifier(profileName);
        if (!normalized) {
          throw new Error("Profile 名称不能为空");
        }
        if (normalized.length > MAX_IDENTIFIER_LENGTH) {
          throw new Error("Profile 名称过长");
        }
        const publication = await ensureChatInputForMutation();
        if (!publication.apiProfileNames.includes(normalized)) {
          throw new Error("Profile 不存在或不可用");
        }
        await publication.actions.handleSelectApiProfile(normalized);
        return { ok: true };
      },

      // 复用真实 handleSelectThinking setter 链；"" = 继承 Profile 默认，
      // 非空为自定义强度（与桌面 ThinkingStrengthMenu 自定义输入一致）。
      setThinking: async (value: string): Promise<{ ok: true }> => {
        const publication = await ensureChatInputForMutation();
        const nextValue = typeof value === "string" ? value.trim() : "";
        if (nextValue.length > MAX_THINKING_LENGTH) {
          throw new Error(`思考强度值不能超过 ${MAX_THINKING_LENGTH} 个字符`);
        }
        await publication.actions.handleSelectThinking(nextValue);
        return { ok: true };
      },

      // 复用真实 handleSelectResponsesFastMode setter 链。
      // desired 与当前档位一致时做幂等处理，避免手机端与桌面端并发点击。
      toggleResponsesFastMode: async (desired): Promise<{ ok: true }> => {
        const publication = await ensureChatInputForMutation();
        if (publication.requestMethod !== "responses") {
          throw new Error("当前请求方式不支持 Responses Fast Mode");
        }
        const tier = typeof desired === "string" ? desired.trim() : "";
        if (tier !== "off" && tier !== "fast" && tier !== "ultrafast") {
          throw new Error("Fast Mode 档位必须是 off / fast / ultrafast");
        }
        if (tier === publication.responsesFastMode) {
          return { ok: true };
        }
        await publication.actions.handleSelectResponsesFastMode(tier);
        return { ok: true };
      },

      // 按真实 createChatCommands 产物执行指令：找不到或不满足桌面禁用
      // 条件（isRunning 等）时拒绝。不阻塞流式：面板类指令在桌面同样可用，
      // 受限指令的禁用状态由命令注册表自己声明。
      runCommand: async (id: string): Promise<{ ok: true }> => {
        const commandId = normalizeRemoteIdentifier(id);
        if (!commandId) {
          throw new Error("指令 ID 不能为空");
        }
        if (commandId.length > MAX_IDENTIFIER_LENGTH) {
          throw new Error("指令 ID 过长");
        }
        const publication = resolveChatInput();
        if (!publication) {
          // 同 requireChatInputForMutation：桌面不在对话页时指令不可执行。
          throw new Error(
            resolveChatInputForDisplay()
              ? "电脑端不在对话页，暂时无法执行"
              : "聊天输入区未就绪或会话不匹配",
          );
        }
        const command = publication.commands.find(
          (item) => item.id === commandId,
        );
        if (!command) {
          throw new Error("指令不存在");
        }
        if (command.disabled) {
          throw new Error("指令当前不可用");
        }
        command.execute();
        return { ok: true };
      },

      approve: async (authorizationId: string): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        const toolCall = current.pendingToolAuthorizations.find(
          (item) =>
            item.authorizationId === authorizationId &&
            item.authorizationConversationId === current.activeConversationId,
        );
        if (!toolCall) throw new Error("授权请求不存在或已过期");
        current.approveToolAuthorization(toolCall);
        return { ok: true };
      },

      reject: async (
        authorizationId: string,
        reason?: string,
      ): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        const toolCall = current.pendingToolAuthorizations.find(
          (item) =>
            item.authorizationId === authorizationId &&
            item.authorizationConversationId === current.activeConversationId,
        );
        if (!toolCall) throw new Error("授权请求不存在或已过期");
        current.rejectToolAuthorization(
          toolCall,
          reason?.trim() || "User declined tool execution from Snow Remote",
        );
        return { ok: true };
      },

      answer: async (
        questionId: string,
        selectedOptions: string[],
        customAnswers: string[],
      ): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        const pending = current.messages.some((message) =>
          message.toolCalls?.some(
            (toolCall) =>
              toolCall.userQuestion?.questionId === questionId &&
              toolCall.userQuestion.status === "waiting",
          ),
        );
        if (!pending || !current.activeConversationId) {
          throw new Error("问题不存在、已过期或不属于当前会话");
        }
        if (
          ![...selectedOptions, ...customAnswers].some((value) => value.trim())
        ) {
          throw new Error("回答不能为空");
        }
        current.answerUserQuestion(questionId, selectedOptions, customAnswers);
        return { ok: true };
      },

      cancelQuestion: async (questionId: string): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        const pending = current.messages.some((message) =>
          message.toolCalls?.some(
            (toolCall) =>
              toolCall.userQuestion?.questionId === questionId &&
              toolCall.userQuestion.status === "waiting",
          ),
        );
        if (!pending || !current.activeConversationId) {
          throw new Error("问题不存在、已过期或不属于当前会话");
        }
        current.cancelUserQuestion(questionId);
        return { ok: true };
      },

      select: async (
        rawConversationId: string,
        requestedDirectoryId?: string,
      ): Promise<{ ok: true }> => {
        const conversationId = rawConversationId.trim();
        if (!conversationId) {
          throw new Error("会话 ID 不能为空");
        }

        const target: ChatConversationRecord | null =
          await window.snow.getChatConversation(conversationId);
        if (!target) {
          throw new Error("目标会话不存在");
        }

        const directoryId = target.directoryId.trim();
        if (
          requestedDirectoryId?.trim() &&
          requestedDirectoryId.trim() !== directoryId
        ) {
          throw new Error("会话与工作区不匹配");
        }

        if (
          stateRef.current.activeDirectory?.directoryId.trim() !== directoryId
        ) {
          const directories =
            await window.snow.activateWorkspaceDirectory(directoryId);
          const nextDirectory =
            directories.find(
              (directory) =>
                directory.directoryId.trim() === directoryId &&
                directory.isActive,
            ) ??
            directories.find(
              (directory) => directory.directoryId.trim() === directoryId,
            );
          if (!nextDirectory) {
            throw new Error("目标工作区不可用");
          }
          stateRef.current.activeDirectory = nextDirectory;
          stateRef.current.onActiveDirectoryChange(nextDirectory);
        }

        stateRef.current.onSelectMainView("chat");
        await stateRef.current.conversation.handleSelectConversation(
          conversationId,
          target.summary || target.title,
          {
            inputTokens: target.inputTokens,
            outputTokens: target.outputTokens,
            cacheCreationInputTokens: target.cacheCreationInputTokens,
            cacheReadInputTokens: target.cacheReadInputTokens,
          },
          directoryId,
        );
        return { ok: true };
      },

      // ── Git 面板（分支 / 工作树 / 变更） ─────────────────────────────────

      getGitSummary: async (): Promise<SnowRemoteGitSummary> => {
        const { directoryId, repoPath } = resolveGitRepo();
        const status = await window.snow.gitStatus(repoPath);
        return {
          directoryId,
          isRepo: Boolean(status.isRepo),
          currentBranch: status.currentBranch || "",
          upstream: status.upstream ?? null,
          ahead: Math.max(0, status.ahead),
          behind: Math.max(0, status.behind),
          stagedCount: Math.max(0, status.stagedCount),
          unstagedCount: Math.max(0, status.unstagedCount),
          untrackedCount: Math.max(0, status.untrackedCount),
          changesCount: status.files.length,
          statusLimitHit: Boolean(status.statusLimitHit),
        };
      },

      getGitBranches: async (): Promise<SnowRemoteGitBranches> => {
        const { directoryId, repoPath } = resolveGitRepo();
        const conversation = stateRef.current.conversation;
        const [branches, worktrees] = await Promise.all([
          window.snow.gitBranches(repoPath),
          window.snow.gitListWorktrees(directoryId).catch(() => []),
        ]);
        const boundWorktreeId = await resolveBoundWorktreeId();
        const localNames = branches
          .filter((branch) => !branch.isRemote)
          .map((branch) => branch.name);
        return {
          directoryId,
          branches: branches.slice(0, 2_000).map((branch) => ({
            name: branch.name,
            isCurrent: Boolean(branch.isCurrent),
            isRemote: Boolean(branch.isRemote),
            remoteName: branch.remoteName ?? null,
            upstream: branch.upstream ?? null,
            ahead: Math.max(0, branch.ahead ?? 0),
            behind: Math.max(0, branch.behind ?? 0),
            isGone: Boolean(branch.isGone),
            worktreePath: branch.worktreePath ?? null,
          })),
          worktrees: worktrees.slice(0, 100).map((worktree) => ({
            worktreeId: worktree.worktreeId,
            worktreePath: worktree.worktreePath,
            worktreeName: capText(gitFolderName(worktree.worktreePath), 120),
            branchName: worktree.branchName ?? null,
            isDirty: Boolean(worktree.isDirty),
            bound: worktree.worktreeId === boundWorktreeId,
          })),
          worktreeMode: Boolean(conversation.worktreeMode),
          boundWorktreeId,
          sessionRunning: isGitSessionRunning(),
          defaultMainBranch: localNames.includes("main")
            ? "main"
            : localNames.includes("master")
              ? "master"
              : null,
        };
      },

      getGitStatus: async (): Promise<SnowRemoteGitStatus> => {
        const { repoPath } = resolveGitRepo();
        const status = await window.snow.gitStatus(repoPath);
        return {
          isRepo: Boolean(status.isRepo),
          currentBranch: status.currentBranch || "",
          upstream: status.upstream ?? null,
          ahead: Math.max(0, status.ahead),
          behind: Math.max(0, status.behind),
          stagedCount: Math.max(0, status.stagedCount),
          unstagedCount: Math.max(0, status.unstagedCount),
          untrackedCount: Math.max(0, status.untrackedCount),
          statusLimitHit: Boolean(status.statusLimitHit),
          files: status.files.slice(0, MAX_GIT_FILE_ROWS).map((file) => ({
            path: file.path,
            oldPath: file.oldPath ?? null,
            indexStatus: file.indexStatus,
            workdirStatus: file.workdirStatus,
            status: file.status,
          })),
        };
      },

      getGitDiff: async (filePath, staged): Promise<SnowRemoteGitDiff> => {
        const { repoPath } = resolveGitRepo();
        const path = typeof filePath === "string" ? filePath : "";
        if (!path || path.length > MAX_GIT_PATH_LENGTH) {
          throw new Error("文件路径无效");
        }
        const status = await window.snow.gitStatus(repoPath);
        if (!status.isRepo) throw new Error("当前项目不是 Git 仓库");
        const file = status.files.find((item) => item.path === path);
        if (!file) throw new Error("文件已变更，请刷新后重试");
        const untracked =
          file.workdirStatus === "?" || file.indexStatus === "?";
        if (staged && untracked) throw new Error("该文件尚未暂存");
        const result = await window.snow.gitFileDiff(repoPath, path, staged);
        let content = typeof result.content === "string" ? result.content : "";
        let isBinary = Boolean(result.isBinary);
        let truncated = false;
        if (!staged && untracked && !content && !isBinary) {
          // git diff 不展示未跟踪文件：本地仓库按「全新增」渲染工作区内容。
          try {
            const fileContent = await window.snow.gitFileContent(
              repoPath,
              path,
              null,
            );
            if (fileContent.isBinary || fileContent.isImage) {
              isBinary = true;
            } else {
              const lines = fileContent.content
                .replace(/\r\n/g, "\n")
                .split("\n");
              if (lines.length > 0 && lines[lines.length - 1] === "") {
                lines.pop();
              }
              const shown = lines.slice(0, MAX_GIT_UNTRACKED_LINES);
              content = [
                `@@ -0,0 +1,${shown.length} @@`,
                ...shown.map((line) => `+${line}`),
              ].join("\n");
              truncated = shown.length < lines.length;
            }
          } catch {
            // SSH 仓库不支持读取文件内容：保留空 diff，由手机端提示。
          }
        }
        if (content.length > MAX_GIT_DIFF_CHARS) {
          content = content.slice(0, MAX_GIT_DIFF_CHARS);
          truncated = true;
        }
        return {
          content,
          isBinary,
          error: typeof result.error === "string" ? result.error : "",
          truncated,
          untracked,
        };
      },

      gitCheckout: async (branch, remote): Promise<{ ok: true }> => {
        const { repoPath } = resolveGitRepo();
        const name = typeof branch === "string" ? branch.trim() : "";
        if (!isValidGitBranchName(name)) throw new Error("分支名称无效");
        assertGitWorktreeMutationAllowed();
        const branches = await window.snow.gitBranches(repoPath);
        const target = branches.find(
          (item) => item.name === name && item.isRemote === Boolean(remote),
        );
        if (!target) throw new Error("分支已不存在，请刷新");
        if (target.isCurrent) return { ok: true };
        if (target.worktreePath) {
          throw new Error("该分支已在其他工作树检出");
        }
        let checkoutName = target.name;
        if (target.isRemote) {
          const remoteName = target.remoteName;
          if (!remoteName) throw new Error("远程分支信息缺失");
          const localName = target.name.startsWith(`${remoteName}/`)
            ? target.name.slice(remoteName.length + 1)
            : target.name;
          const local = branches.find(
            (item) => !item.isRemote && item.name === localName,
          );
          if (local && (local.worktreePath || local.upstream !== target.name)) {
            throw new Error("同名本地分支的跟踪关系冲突");
          }
          checkoutName = local?.name ?? target.name;
        }
        const result = await window.snow.gitCheckout(repoPath, checkoutName);
        if (!result.success) {
          throw new Error(result.message || "切换分支失败");
        }
        dispatchGitBranchesChanged(repoPath);
        return { ok: true };
      },

      gitCreateBranch: async (branch): Promise<{ ok: true }> => {
        const { repoPath } = resolveGitRepo();
        const name = typeof branch === "string" ? branch.trim() : "";
        if (!isValidGitBranchName(name)) throw new Error("分支名称无效");
        assertGitWorktreeMutationAllowed();
        const branches = await window.snow.gitBranches(repoPath);
        if (branches.some((item) => !item.isRemote && item.name === name)) {
          throw new Error("该分支在本地已存在");
        }
        const result = await window.snow.gitCreateBranch(repoPath, name);
        if (!result.success) {
          throw new Error(result.message || "创建分支失败");
        }
        dispatchGitBranchesChanged(repoPath);
        return { ok: true };
      },

      gitStage: async (paths): Promise<{ ok: true }> =>
        runGitStageAction(paths, false),

      gitUnstage: async (paths): Promise<{ ok: true }> =>
        runGitStageAction(paths, true),

      gitDiscard: async (paths): Promise<{ ok: true }> =>
        runGitDiscardAction(paths),

      gitStageAll: async (): Promise<{ ok: true }> => {
        const { repoPath } = resolveGitRepo();
        const result = await window.snow.gitStageAll(repoPath);
        if (!result.success) {
          throw new Error(result.message || "暂存失败");
        }
        return { ok: true };
      },

      gitUnstageAll: async (): Promise<{ ok: true }> => {
        const { repoPath } = resolveGitRepo();
        const result = await window.snow.gitUnstageAll(repoPath);
        if (!result.success) {
          throw new Error(result.message || "取消暂存失败");
        }
        return { ok: true };
      },

      gitCommit: async (
        message,
      ): Promise<{ ok: true; hash: string | null }> => {
        const { repoPath } = resolveGitRepo();
        const text = typeof message === "string" ? message : "";
        if (!text.trim()) throw new Error("提交信息不能为空");
        if (text.length > MAX_GIT_COMMIT_MESSAGE) {
          throw new Error(`提交信息不能超过 ${MAX_GIT_COMMIT_MESSAGE} 个字符`);
        }
        const status = await window.snow.gitStatus(repoPath);
        if (!status.isRepo) throw new Error("当前项目不是 Git 仓库");
        if (status.stagedCount <= 0) throw new Error("没有已暂存的变更");
        const result = await window.snow.gitCommit(repoPath, text);
        if (!result.success) {
          throw new Error(result.message || "提交失败");
        }
        dispatchGitBranchesChanged(repoPath);
        return { ok: true, hash: result.hash ?? null };
      },

      gitPull: async (): Promise<{ ok: true; message: string }> => {
        const { repoPath } = resolveGitRepo();
        const { remote, branch } = await resolveGitSyncTarget(repoPath);
        const result = await window.snow.gitPull(repoPath, remote, branch);
        if (!result.success) {
          throw new Error(result.message || "拉取失败");
        }
        dispatchGitBranchesChanged(repoPath);
        return { ok: true, message: result.message };
      },

      gitPush: async (): Promise<{ ok: true; message: string }> => {
        const { repoPath } = resolveGitRepo();
        const { remote, branch, setUpstream } =
          await resolveGitSyncTarget(repoPath);
        const result = await window.snow.gitPush(
          repoPath,
          remote,
          branch,
          setUpstream,
        );
        if (!result.success) {
          throw new Error(result.message || "推送失败");
        }
        dispatchGitBranchesChanged(repoPath);
        return { ok: true, message: result.message };
      },

      gitGenerateCommitMessage: async (
        hint?: string,
      ): Promise<{ message: string }> => {
        const { repoPath } = resolveGitRepo();
        const status = await window.snow.gitStatus(repoPath);
        if (!status.isRepo) throw new Error("当前项目不是 Git 仓库");
        if (status.stagedCount <= 0) throw new Error("没有已暂存的变更");
        // 手机端提交框内容作为生成偏好（如语种）或草稿交给模型。
        const note = typeof hint === "string" ? hint.trim() : "";
        const result = await window.snow.generateCommitMessage(repoPath, note);
        if (result.status === "error") {
          throw new Error(result.failureReason?.trim() || "生成提交信息失败");
        }
        const message = result.content.trim();
        if (!message) throw new Error("生成结果为空，请重试");
        return { message: capText(message, MAX_GIT_COMMIT_MESSAGE) };
      },

      gitCreateWorktree: async (
        branch,
        baseRef,
      ): Promise<{ ok: true; worktreeId: string }> => {
        const { directoryId, repoPath } = resolveGitRepo();
        const name = typeof branch === "string" ? branch.trim() : "";
        const base = typeof baseRef === "string" ? baseRef.trim() : "";
        if (!isValidGitBranchName(name)) throw new Error("分支名称无效");
        if (!isValidGitBranchName(base)) throw new Error("起始基线无效");
        assertGitWorktreeMutationAllowed();
        const [branches, worktrees] = await Promise.all([
          window.snow.gitBranches(repoPath),
          window.snow.gitListWorktrees(directoryId).catch(() => []),
        ]);
        if (branches.some((item) => !item.isRemote && item.name === name)) {
          throw new Error("该分支在本地已存在，工作树需指定新分支");
        }
        if (worktrees.some((item) => item.branchName === name)) {
          throw new Error("该分支已在其他工作树检出");
        }
        const created = await window.snow.gitCreateWorktree(
          directoryId,
          name,
          base,
        );
        dispatchGitWorktreesChanged();
        dispatchGitBranchesChanged(repoPath);
        return { ok: true, worktreeId: created.worktreeId };
      },

      gitRemoveWorktree: async (worktreeId): Promise<{ ok: true }> => {
        const { directoryId, repoPath } = resolveGitRepo();
        const id = typeof worktreeId === "string" ? worktreeId.trim() : "";
        if (!id || id.length > MAX_IDENTIFIER_LENGTH) {
          throw new Error("工作树标识无效");
        }
        assertGitWorktreeMutationAllowed();
        const worktrees = await window.snow.gitListWorktrees(directoryId);
        if (!worktrees.some((item) => item.worktreeId === id)) {
          throw new Error("工作树已不存在，请刷新");
        }
        if ((await resolveBoundWorktreeId()) === id) {
          throw new Error("当前会话正在使用该工作树，暂不可移除");
        }
        await window.snow.gitRemoveWorktree(directoryId, id);
        dispatchGitWorktreesChanged();
        dispatchGitBranchesChanged(repoPath);
        return { ok: true };
      },

      gitBindWorktree: async (
        worktreeId,
      ): Promise<{ ok: true; boundWorktreeId: string | null }> => {
        const conversation = stateRef.current.conversation;
        assertGitWorktreeMutationAllowed();
        let id: string | null = null;
        if (worktreeId !== null) {
          const normalized =
            typeof worktreeId === "string" ? worktreeId.trim() : "";
          if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) {
            throw new Error("工作树标识无效");
          }
          const { directoryId } = resolveGitRepo();
          const worktrees = await window.snow.gitListWorktrees(directoryId);
          if (!worktrees.some((item) => item.worktreeId === normalized)) {
            throw new Error("工作树已不存在，请刷新");
          }
          id = normalized;
        }
        if (conversation.activeConversationId) {
          await window.snow.setConversationWorktree(
            conversation.activeConversationId,
            id,
          );
        } else {
          conversation.setPendingWorktreeId(id);
        }
        return { ok: true, boundWorktreeId: id };
      },
    };

    window.__snowRemoteControl = api;
    return () => {
      if (window.__snowRemoteControl === api) {
        delete window.__snowRemoteControl;
      }
    };
  }, []);

  return null;
};
