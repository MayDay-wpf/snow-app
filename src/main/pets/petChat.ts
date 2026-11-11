/**
 * 宠物聊天（btw 式旁路会话）。
 *
 * 复用主流程的四类请求方案：直接调用 Rust 的统一流式入口
 * `native.createResponseStream`，由所选 API 配置的 `request_method`
 * 自动分派 chat / responses / anthropic / gemini / interactions。
 *
 * 关键约定（与主会话完全隔离）：
 * - `skipContext: true`：Rust 不加载会话历史、不注入内置系统提示词，
 *   且各 provider 适配器仅在 `!skip_context` 时才调用 store_chat_exchange，
 *   因此宠物聊天不会在数据库留下任何会话 / 消息记录。
 *   skipContext 默认同时跳过内联图片解析，所以本模块显式设置
 *   `parseInlineImages: true`，让输入框粘贴的图片与工具结果里的图片
 *   仍以多模态块发出。
 * - `allowedToolsJson`：请求级工具白名单（联网搜索与网页阅读 / 文件搜索 /
 *   文件阅读）。它保持普通请求语义（不是子代理），且在 skipContext 下依然
 *   生效；工具循环由本模块驱动（模型产出 tool calls → 主进程执行 → 回传结果）。
 * - `directoryId`：项目锚点。会话上下文被跳过时没有会话 id，工具的相对
 *   路径与项目级工具开关改由该目录解析（见 Rust `call_mcp_tool`）。
 * - `apiProfile` / `model` 缺省时由 Rust 按「显式值 → 会话绑定 → 当前激活
 *   配置」解析，默认即跟随用户当前使用的配置与高级模型。
 *
 * 上下文分两层（渲染层节流上报实时快照，落库文本仅作兜底）：
 * 1. 实时快照 `PetChatSnapshot`：当前打开的会话在渲染层的活数据 —— 在途助手
 *    正文、每一次工具调用的名称/参数/状态/结果摘要、待办进度、运行状态。
 *    这是「正在进行到哪一步」类问题的唯一可靠来源（落库文本要等本轮结束）。
 * 2. 数据库最近消息（native.listChatMessages）：快照为空时的兜底。
 *
 * 宠物自身的对话历史（`PetChatRunInput.history`）由宠物窗口内存态回传：
 * skipContext 下 Rust 不加载任何历史，若不回传，宠物连自己上一句说过什么
 * 都不记得。历史只含宠物窗口里的 user / assistant 正文，不涉及任何主会话内容。
 * 提示词人设取自宠物设置里的自定义人设（设置页可编辑），未自定义时
 * 回落宠物清单的 `description`。
 */
import type {
  NativeBridge,
  PetManifestRecord,
  ResponsesApiMessage,
  ResponsesApiRequest,
  ResponsesApiStreamChunk,
} from "../native/types";
import type { PetChatHistoryMessage } from "../../preload/types/pets";
import { snowLog } from "../../utils/snowLogger";
import { dispatchRemoteWorkspaceCommand } from "../ssh/remoteWorkspaceCommand";
import { dispatchWebSearchCommand } from "../websearch/webSearchRegistry";
import type { PetActivityState, PetSettings } from "./petSettings";

/** 当前打开的会话（主窗口渲染层上报；null 表示没有打开会话）。 */
export type PetChatContext = {
  conversationId: string | null;
  title: string | null;
  directoryId: string | null;
};

/**
 * 宠物聊天可用的工具白名单（请求级，非子代理语义）：
 * 联网搜索、网页阅读、文件搜索（grep / find）、文件阅读。
 * 均为只读工具，不会写入工作区，因此不需要 checkpoint。
 */
const PET_CHAT_ALLOWED_TOOLS = [
  "websearch-websearch-search",
  "websearch-websearch-fetch",
  "grep-search",
  "grep-find",
  "filesystem-read",
] as const;

/** 注入上下文的消息条数 / 字符预算上限（保护小窗口下的提示词体积）。 */
const MAX_CONTEXT_MESSAGES = 30;
const MAX_CONTEXT_CHARS = 14000;
const MAX_CONTEXT_MESSAGE_CHARS = 2000;
/** 单条工具行的参数 / 结果摘要上限。 */
const MAX_TOOL_DETAIL_CHARS = 100;
const MAX_TOOL_RESULT_CHARS = 120;
/** 单次工具结果回传给模型的字符上限（宠物场景只读，避免上下文被撑爆）。 */
const MAX_TOOL_RESULT_FOR_MODEL_CHARS = 12000;

/** 宠物自身对话历史（宠物窗口内存态）的条数 / 单条字符上限。 */
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_MESSAGE_CHARS = 2000;

/** 会话里一次工具调用的单行摘要（与 preload 类型保持一致）。 */
export type PetChatToolLine = {
  name: string;
  detail: string;
  status: "pending" | "running" | "completed" | "error";
  result?: string;
};

/** 会话里的一条消息（含在途内容与工具调用）。 */
export type PetChatLiveMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tools?: PetChatToolLine[];
};

/** 当前打开会话的实时快照（渲染层节流上报）。 */
export type PetChatSnapshot = {
  conversationId: string | null;
  title: string | null;
  /** 会话所属项目的 directoryId：宠物工具调用的项目锚点。 */
  directoryId: string | null;
  workspacePath: string | null;
  model: string | null;
  status: "idle" | "streaming" | "paused";
  messages: PetChatLiveMessage[];
  todoSummary: string | null;
  updatedAt: number;
};

const EMPTY_CONTEXT: PetChatContext = {
  conversationId: null,
  title: null,
  directoryId: null,
};

/** 最近一次上报的实时快照（null = 没有打开的会话）。 */
let chatSnapshot: PetChatSnapshot | null = null;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/**
 * 截断工具结果但保持 `@@image:...@@` 标签完整：base64 被截断后 Rust
 * 侧既无法落盘也无法解析，会退化成无意义的长文本。
 */
const truncateToolResult = (result: string, max: number): string => {
  if (result.length <= max) {
    return result;
  }
  const tags: string[] = [];
  const textParts: string[] = [];
  let cursor = 0;
  while (cursor < result.length) {
    const start = result.indexOf("@@image:", cursor);
    const end = start < 0 ? -1 : result.indexOf("@@", start + 8);
    if (start < 0 || end < 0) {
      textParts.push(result.slice(cursor));
      break;
    }
    textParts.push(result.slice(cursor, start));
    tags.push(result.slice(start, end + 2));
    cursor = end + 2;
  }
  const tagText = tags.join("\n");
  const budget = Math.max(0, max - tagText.length - 1);
  const text = textParts.join("").trim();
  const clipped =
    text.length <= budget ? text : `${text.slice(0, budget).trimEnd()}…`;
  return [clipped, tagText].filter(Boolean).join("\n");
};

const normalizeOptional = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 读取当前会话标识（宠物窗口标题栏与请求构建共用）。 */
export const getPetChatContext = (): PetChatContext =>
  chatSnapshot
    ? {
        conversationId: chatSnapshot.conversationId,
        title: chatSnapshot.title,
        directoryId: chatSnapshot.directoryId,
      }
    : { ...EMPTY_CONTEXT };

const normalizeToolStatus = (value: unknown): PetChatToolLine["status"] =>
  value === "running" || value === "completed" || value === "error"
    ? value
    : "pending";

const normalizeToolLines = (value: unknown): PetChatToolLine[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const lines: PetChatToolLine[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = normalizeOptional(item.name);
    if (!name) {
      continue;
    }
    const result = normalizeOptional(item.result);
    lines.push({
      name: truncate(name, 60),
      detail: truncate(
        typeof item.detail === "string" ? item.detail.trim() : "",
        MAX_TOOL_DETAIL_CHARS,
      ),
      status: normalizeToolStatus(item.status),
      ...(result ? { result: truncate(result, MAX_TOOL_RESULT_CHARS) } : {}),
    });
    if (lines.length >= 8) {
      break;
    }
  }
  return lines;
};

const normalizeLiveMessages = (value: unknown): PetChatLiveMessage[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages: PetChatLiveMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const role =
      item.role === "assistant" || item.role === "tool" ? item.role : "user";
    const tools = normalizeToolLines(item.tools);
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content && tools.length === 0) {
      continue;
    }
    messages.push({
      role,
      content: truncate(content, MAX_CONTEXT_MESSAGE_CHARS),
      ...(tools.length > 0 ? { tools } : {}),
    });
  }
  return messages.slice(-MAX_CONTEXT_MESSAGES);
};

/** 由主窗口渲染层上报当前会话的实时快照（非法 / 空载荷视为无会话）。 */
export const setPetChatContext = (value: unknown): PetChatContext => {
  if (!isRecord(value)) {
    chatSnapshot = null;
    return getPetChatContext();
  }
  const conversationId = normalizeOptional(value.conversationId);
  const messages = normalizeLiveMessages(value.messages);
  if (!conversationId && messages.length === 0) {
    chatSnapshot = null;
    return getPetChatContext();
  }
  chatSnapshot = {
    conversationId,
    title: normalizeOptional(value.title),
    directoryId: normalizeOptional(value.directoryId),
    workspacePath: normalizeOptional(value.workspacePath),
    model: normalizeOptional(value.model),
    status:
      value.status === "streaming" || value.status === "paused"
        ? value.status
        : "idle",
    messages,
    todoSummary: normalizeOptional(value.todoSummary),
    updatedAt:
      typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
  };
  return getPetChatContext();
};

/** 主进程当前是否持有快照（渲染层已上报且未清空）。 */
export const hasPetChatSnapshot = (): boolean => chatSnapshot !== null;

/** 工具行文本：`name(detail) [running]` / `name(detail) → result`。 */
const formatToolLine = (tool: PetChatToolLine): string => {
  const head = tool.detail ? `${tool.name}(${tool.detail})` : tool.name;
  if (tool.status === "running" || tool.status === "pending") {
    return `${head} [${tool.status}]`;
  }
  if (tool.status === "error") {
    return `${head} [error]${tool.result ? `: ${tool.result}` : ""}`;
  }
  return tool.result ? `${head} → ${tool.result}` : `${head} → ok`;
};

/** 把实时快照转成请求消息（工具调用折叠为一行文本，随所属消息一起发出）。 */
const buildSnapshotTranscript = (
  snapshot: PetChatSnapshot,
): ResponsesApiMessage[] => {
  const selected: ResponsesApiMessage[] = [];
  let budget = MAX_CONTEXT_CHARS;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    const toolText = (message.tools ?? []).map(formatToolLine).join("\n");
    const content = [message.content, toolText]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!content) {
      continue;
    }
    if (content.length > budget) {
      break;
    }
    budget -= content.length;
    selected.unshift({ role: message.role, content });
  }
  return selected;
};

/**
 * 落库文本兜底：快照缺失（渲染层未挂载 / 会话刚切换）时，取数据库里该会话
 * 最近若干条消息。工具消息与空消息会被过滤。
 */
const buildDatabaseTranscript = async (
  native: NativeBridge,
  context: PetChatContext,
): Promise<ResponsesApiMessage[]> => {
  if (!context.conversationId) {
    return [];
  }
  let records: Awaited<ReturnType<NativeBridge["listChatMessages"]>>;
  try {
    records = await native.listChatMessages(context.conversationId);
  } catch (error) {
    snowLog.warn({
      module: "pets/petChat",
      func: "buildDatabaseTranscript",
      message: "Failed to load conversation context for pet chat",
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const candidates = records
    .filter((record) => record.role === "user" || record.role === "assistant")
    .map((record) => ({
      role: record.role as ResponsesApiMessage["role"],
      content: record.content.trim(),
    }))
    .filter((record) => record.content.length > 0)
    .slice(-MAX_CONTEXT_MESSAGES);

  const selected: ResponsesApiMessage[] = [];
  let budget = MAX_CONTEXT_CHARS;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const content = truncate(candidate.content, MAX_CONTEXT_MESSAGE_CHARS);
    if (content.length > budget) {
      break;
    }
    budget -= content.length;
    selected.unshift({ role: candidate.role, content });
  }
  return selected;
};

/**
 * 规整宠物窗口回传的自身对话历史：只保留 user / assistant 的非空正文，
 * 单条截断到上限，并按字符预算从最近一条往前取。
 */
export const normalizePetChatHistory = (
  value: unknown,
): PetChatHistoryMessage[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const candidates: PetChatHistoryMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.role !== "user" && item.role !== "assistant") {
      continue;
    }
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) {
      continue;
    }
    candidates.push({
      role: item.role,
      content: truncate(content, MAX_HISTORY_MESSAGE_CHARS),
    });
  }

  const selected: PetChatHistoryMessage[] = [];
  let budget = MAX_CONTEXT_CHARS;
  for (
    let index = candidates.length - 1;
    index >= Math.max(0, candidates.length - MAX_HISTORY_MESSAGES);
    index -= 1
  ) {
    const candidate = candidates[index];
    if (candidate.content.length > budget) {
      break;
    }
    budget -= candidate.content.length;
    selected.unshift(candidate);
  }
  return selected;
};

/**
 * 把主会话转录渲染成一段纯文本背景资料。它写进系统提示词而不是对话流，
 * 以免与宠物自身的对话历史相邻同角色时被合并（那会让宠物把主会话里
 * 助手说的话当成自己说过的）。
 */
const formatTranscript = (messages: ResponsesApiMessage[]): string =>
  messages
    .map(
      (message) =>
        `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`,
    )
    .join("\n\n");

/** 运行状态文案（结合渲染层状态与主进程的活动状态）。 */
const describeRunStatus = (
  snapshot: PetChatSnapshot,
  activity: PetActivityState,
): string => {
  if (activity === "waiting") {
    return "waiting for the user to answer an AI question (the run is paused on that question)";
  }
  if (activity === "review") {
    return "running a code review";
  }
  if (snapshot.status === "streaming") {
    return "running right now (the AI is streaming output or executing tools)";
  }
  if (snapshot.status === "paused") {
    return "paused by the user (the run is suspended and can be resumed)";
  }
  if (activity === "busy") {
    return "a run is in progress";
  }
  if (activity === "error") {
    return "the last run ended with an error";
  }
  if (activity === "completed") {
    return "the last run just completed";
  }
  return "idle — no run in progress";
};

/**
 * 实时运行状态段落（写进系统提示词）：这是宠物回答「进行到哪一步」时的事实
 * 依据 —— 当前步骤、最近工具活动、待办进度、运行状态。
 */
const buildLiveStateSection = (
  snapshot: PetChatSnapshot,
  activity: PetActivityState,
): string => {
  const lines: string[] = [];
  if (snapshot.title) {
    lines.push(`Session: "${truncate(snapshot.title, 100)}"`);
  }
  if (snapshot.workspacePath) {
    lines.push(`Workspace: ${snapshot.workspacePath}`);
  }
  if (snapshot.model) {
    lines.push(`Model: ${snapshot.model}`);
  }
  lines.push(`Run status: ${describeRunStatus(snapshot, activity)}`);

  // 当前步骤：最后一条仍在 running / pending 的工具调用。
  const allTools = snapshot.messages.flatMap((message) => message.tools ?? []);
  const activeTool = [...allTools]
    .reverse()
    .find((tool) => tool.status === "running" || tool.status === "pending");
  if (activeTool) {
    lines.push(`Current step: ${formatToolLine(activeTool)}`);
  }

  const recentTools = allTools.slice(-8);
  if (recentTools.length > 0) {
    lines.push(
      `Recent tool activity (oldest first):\n${recentTools
        .map((tool) => `- ${formatToolLine(tool)}`)
        .join("\n")}`,
    );
  }

  if (snapshot.todoSummary) {
    lines.push(`Todo progress: ${snapshot.todoSummary}`);
  }
  if (snapshot.status === "streaming") {
    lines.push(
      "The transcript below ends with the still-streaming turn, so its last message may be incomplete.",
    );
  }
  return lines.join("\n");
};

/**
 * 规整对话消息，满足各 provider 的共同约束：
 * - Anthropic 要求 user / assistant 严格交替，历史里的空回复或连续同角色
 *   会被上游 400 拒绝，这里把相邻同角色消息合并；
 * - 首条消息必须是 user（Anthropic），因此丢弃开头的 assistant 残段。
 */
const normalizeTurnMessages = (
  messages: ResponsesApiMessage[],
): ResponsesApiMessage[] => {
  const merged: ResponsesApiMessage[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      last.content = `${last.content}\n\n${message.content}`;
      continue;
    }
    merged.push({ ...message });
  }
  while (merged.length > 0 && merged[0].role !== "user") {
    merged.shift();
  }
  return merged;
};

/**
 * 宠物内置提示词：人设优先取用户为该宠物自定义的 personas（设置页可编辑），
 * 缺省回落宠物清单的 description。`liveState` 为实时运行状态段落（见
 * buildLiveStateSection），`transcript` 为主会话转录的纯文本背景资料
 * （见 formatTranscript）—— 它作为资料写在这里，而不是混进对话流。
 */
const buildPetSystemPrompt = (
  manifest: PetManifestRecord | null,
  context: PetChatContext,
  transcript: string,
  liveState: string,
  customPersona: string,
): string => {
  const name = manifest?.displayName.trim() || "Snow Pet";
  const description = (customPersona || manifest?.description || "").trim();
  const hasContext = Boolean(transcript || liveState);
  const lines = [
    `You are "${name}", the user's desktop pet companion who lives on their desktop.`,
    description ? `\nPersona:\n${description}` : "",
    `\nYou are talking with the user in a tiny pet bubble — a casual "by the way" side chat.`,
    `Rules:`,
    `- Reply in the user's language, stay in character, and keep it short and warm (usually 1-3 sentences).`,
    `- This is casual conversation, not a task: never output long plans or code blocks, and never claim to have changed files or run commands yourself.`,
    `- The conversation above is your own chat with the user — remember what you two just said.`,
    hasContext
      ? `- The user also has a session open right now${
          context.title ? `, titled "${truncate(context.title, 80)}"` : ""
        }. The reference material below is what you can see of it${
          liveState ? " (already up to date with the user's screen)" : ""
        }. Answer questions about it with those concrete facts. If something truly is not in there, say so briefly instead of guessing.`
      : `- The user has no session open right now, so just chat freely.`,
    `\nTools you may call when the user asks for something you cannot answer from the state above:`,
    `- \`websearch-websearch-search\`: search the web for current information (news, docs, releases, anything after your training data).`,
    `- \`websearch-websearch-fetch\`: read a web page found by a search (pick the most credible result).`,
    `- \`grep-search\`: search the user's project files for text or symbols.`,
    `- \`grep-find\`: locate files by glob pattern when only the path is needed.`,
    `- \`filesystem-read\`: read a file's content (code, config, docs).`,
    `Rules for tools:`,
    `- Call a tool only when it genuinely helps; casual chat needs no tools at all.`,
    `- Search once, read at most one page, then answer. Do not chain many searches.`,
    `- After tool results arrive, answer the user in your own voice and keep it short — the user only sees the final reply.`,
  ];
  if (liveState) {
    lines.push(
      `\n## Live session state (real time — this is the ground truth about what is happening right now)`,
      liveState,
      `\nWhen the user asks what is happening / which step it is on / the progress: answer with these concrete facts (current step, the tool or file involved, recent tool results, todo progress, run status). Never claim you have no record of it while this state or the transcript is available, and never invent steps that are not listed.`,
    );
  }
  if (transcript) {
    lines.push(
      `\n## Session transcript (the user's open session — reference material, NOT your own words)`,
      transcript,
    );
  }
  return lines.filter(Boolean).join("\n");
};

export type PetChatRunInput = {
  settings: PetSettings;
  manifest: PetManifestRecord | null;
  /** 渲染层生成的请求 id，用于把 chunk / 中止关联到同一次提问。 */
  requestId: string;
  text: string;
  /**
   * 本次提问之前宠物窗口里的对话（内存态回传）。
   * skipContext 下 Rust 不加载任何历史，缺了它宠物就记不住自己说过什么。
   */
  history: PetChatHistoryMessage[];
  /** 主进程侧的宠物活动状态（判断是否正在等待用户回答等）。 */
  activity: PetActivityState;
};

export type PetChatResult = {
  content: string;
};

/** 宠物工具活动（渲染层据此显示「正在搜索…」等状态行）。 */
export type PetChatToolActivity = {
  name: string;
  detail: string;
  status: "running" | "completed" | "error";
};

export type PetChatRunCallbacks = {
  onChunk: (chunk: ResponsesApiStreamChunk) => void;
  onToolActivity: (activity: PetChatToolActivity) => void;
};

/** 在途请求的中止句柄：每轮迭代更新 streamId，aborted 一旦置位即停止循环。 */
type ActivePetRun = { streamId: string; aborted: boolean };

/** 在途宠物聊天流：requestId → 中止句柄（含当前迭代的 Rust streamId）。 */
const activeRuns = new Map<string, ActivePetRun>();

/** 生成一次流式迭代的 streamId。 */
const createStreamId = (): string =>
  `pet-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 工具参数里提取一句「在做什么」的摘要（与快照摘要口径一致）。 */
const summarizeToolArguments = (argsJson: string): string => {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (!isRecord(parsed)) {
      return "";
    }
    for (const key of ["query", "pattern", "filePath", "url", "path"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return truncate(
          value.replace(/\s+/g, " ").trim(),
          MAX_TOOL_DETAIL_CHARS,
        );
      }
    }
  } catch {
    // 参数非法 JSON 时不做摘要
  }
  return "";
};

/**
 * 规整模型返回的工具调用数组：仅保留 name 非空的条目，并为每条调用补齐
 * callId（部分 provider —— 如 Gemini 原生 functionCall —— 不返回 id，
 * 缺失时回放会被上游按「孤儿调用」处理）。执行结果按该 id 回填。
 */
type PetToolCall = { name: string; argsJson: string; callId: string };

const parsePetToolCalls = (toolCallsJson: string): PetToolCall[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCallsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const calls: PetToolCall[] = [];
  for (const [index, item] of parsed.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    const nested = isRecord(item.function)
      ? item.function
      : isRecord(item.functionCall)
        ? item.functionCall
        : null;
    const name =
      normalizeOptional(item.name) ?? normalizeOptional(nested?.name) ?? "";
    if (!name) {
      continue;
    }
    const rawArgs =
      item.arguments ??
      item.args ??
      item.input ??
      nested?.arguments ??
      nested?.args;
    const argsJson =
      typeof rawArgs === "string"
        ? rawArgs
        : isRecord(rawArgs)
          ? JSON.stringify(rawArgs)
          : "{}";
    const callId =
      normalizeOptional(item.call_id) ??
      normalizeOptional(item.callId) ??
      normalizeOptional(item.id) ??
      normalizeOptional(nested?.id) ??
      `pet-call-${index}-${Math.random().toString(36).slice(2, 8)}`;
    calls.push({ name, argsJson, callId });
  }
  return calls;
};

/**
 * 以 provider 中立的形态重建回放的助手工具调用 JSON
 * （`[{id, name, arguments}]`）。Rust 侧各 provider 的归一化器都接受该形态，
 * 且每条调用都带 id，避免 Gemini 这类不带 id 的上游造成配对断裂。
 */
const buildReplayedToolCallsJson = (calls: PetToolCall[]): string =>
  JSON.stringify(
    calls.map((call) => ({
      id: call.callId,
      name: call.name,
      arguments: call.argsJson,
    })),
  );

/**
 * 执行一次宠物聊天：构建提示词与上下文 → 调用 Rust 统一流式入口。
 * 模型请求工具时由本模块驱动工具循环（联网搜索 / 文件搜索 / 文件阅读），
 * 把结果回传后继续请求，直到模型给出最终回复或达到轮数上限。
 * 抛出的错误由调用方转换为窗口提示。
 */
export const runPetChat = async (
  native: NativeBridge,
  input: PetChatRunInput,
  callbacks: PetChatRunCallbacks,
): Promise<PetChatResult> => {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Pet chat message is empty");
  }

  const context = getPetChatContext();
  const snapshot = chatSnapshot;
  const liveState = snapshot
    ? buildLiveStateSection(snapshot, input.activity)
    : "";
  // 快照优先（含在途内容与工具活动），缺失时才回落到落库文本。
  // 主会话转录作为系统提示词里的背景资料，不混进对话流。
  const contextMessages =
    snapshot && snapshot.messages.length > 0
      ? buildSnapshotTranscript(snapshot)
      : await buildDatabaseTranscript(native, context);
  const transcript = formatTranscript(contextMessages);

  // 对话流只含宠物自身的对话历史（内存态回传）与本次提问：
  // 规整时相邻同角色会被合并、开头的 assistant 残段会被丢弃。
  const turnMessages = normalizeTurnMessages([
    ...input.history,
    { role: "user", content: text },
  ]);

  // 自定义人设按宠物 id 取（设置已在 petSettings 归一化，含长度上限）。
  const customPersona = input.manifest
    ? (input.settings.personas[input.manifest.id] ?? "")
    : "";
  const messages: ResponsesApiMessage[] = [
    {
      role: "system",
      content: buildPetSystemPrompt(
        input.manifest,
        context,
        transcript,
        liveState,
        customPersona,
      ),
    },
    ...turnMessages,
  ];

  const run: ActivePetRun = { streamId: createStreamId(), aborted: false };
  activeRuns.set(input.requestId, run);

  try {
    let content = "";
    for (;;) {
      if (run.aborted) {
        break;
      }
      const request: ResponsesApiRequest = {
        messages,
        // 缺省即跟随：Rust 解析「显式 → 会话绑定 → 当前激活配置」，
        // model 缺省时取该配置的高级模型。
        ...(input.settings.apiProfile
          ? { apiProfile: input.settings.apiProfile }
          : {}),
        ...(input.settings.model ? { model: input.settings.model } : {}),
        // 项目锚点：会话上下文被跳过时没有会话 id，工具的相对路径与
        // 项目级开关改由该目录解析。
        ...(context.directoryId ? { directoryId: context.directoryId } : {}),
        skipContext: true,
        // 旁路请求默认不解析内联图片：宠物需要粘贴的图片与工具结果里的
        // 图片仍然生效，显式开启。
        parseInlineImages: true,
        allowedToolsJson: JSON.stringify(PET_CHAT_ALLOWED_TOOLS),
      };
      const result = await native.createResponseStream(
        request,
        callbacks.onChunk,
        run.streamId,
      );
      if (run.aborted) {
        break;
      }
      content = result.content ?? "";

      const toolCalls = parsePetToolCalls(result.toolCallsJson);
      if (toolCalls.length === 0) {
        break;
      }

      // 助手轮（含工具调用）→ 工具结果轮：两者必须成对回放，否则上游会
      // 以「孤儿 tool 调用」拒绝请求。
      messages.push({
        role: "assistant",
        content,
        toolCallsJson: buildReplayedToolCallsJson(toolCalls),
      });
      const toolResults = await executePetToolCalls(
        native,
        context,
        toolCalls,
        callbacks.onToolActivity,
      );
      if (run.aborted) {
        break;
      }
      messages.push({
        role: "tool",
        content: toolResults.map((entry) => entry.result).join("\n\n"),
        toolResultsJson: JSON.stringify(toolResults),
      });
      // 下一轮重新生成 streamId：中止按最新一次迭代生效。
      run.streamId = createStreamId();
      content = "";
    }
    return { content };
  } finally {
    activeRuns.delete(input.requestId);
  }
};

/**
 * 顺序执行本轮的宠物工具调用：每个调用先上报 running 状态（渲染层显示
 * 「正在搜索…」），完成后上报 completed / error 与结果摘要。
 *
 * 只读工具不传 checkpoint；SSH 工作区的文件工具经远程工作区通道执行
 * （与主流程同一分发器），其余需要渲染层配合的交互类工具在宠物场景
 * 一律拒绝 —— 宠物白名单里也不包含它们。
 */
const executePetToolCalls = async (
  native: NativeBridge,
  context: PetChatContext,
  toolCalls: PetToolCall[],
  onToolActivity: (activity: PetChatToolActivity) => void,
): Promise<{ name: string; callId: string; result: string }[]> => {
  const results: { name: string; callId: string; result: string }[] = [];
  const unsupported = (toolName: string): Promise<string> =>
    Promise.reject(new Error(`${toolName} is not available in pet chat`));

  for (const call of toolCalls) {
    const detail = summarizeToolArguments(call.argsJson);
    onToolActivity({ name: call.name, detail, status: "running" });
    let result: string;
    let failed = false;
    try {
      result = await native.callMcpTool(
        call.name,
        call.argsJson,
        context.directoryId ?? undefined,
        undefined,
        undefined,
        undefined,
        () => {},
        (command) => unsupported(`browser-${command.operation}`),
        (command) => dispatchWebSearchCommand(native, command),
        (question) => unsupported(`user-interaction: ${question.question}`),
        (command) => unsupported(`app-control-${command.action}`),
        (command) => dispatchRemoteWorkspaceCommand(command),
        (command) => unsupported(`terminal-${command.operation}`),
        undefined,
        // 无会话上下文：工具的项目/路径解析由 directoryId 承担。
        undefined,
      );
      failed = isToolErrorResult(result);
    } catch (error) {
      failed = true;
      result = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    onToolActivity({
      name: call.name,
      detail,
      status: failed ? "error" : "completed",
    });
    results.push({
      name: call.name,
      callId: call.callId,
      result: truncateToolResult(result, MAX_TOOL_RESULT_FOR_MODEL_CHARS),
    });
  }
  return results;
};

/** 工具结果 JSON 中带 error / success=false 时视为失败（驱动状态行）。 */
const isToolErrorResult = (result: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return false;
    }
    return (
      typeof parsed.error === "string" ||
      parsed.success === false ||
      parsed.isError === true
    );
  } catch {
    return false;
  }
};

/** 中止一次在途宠物聊天；返回是否命中在途请求。 */
export const abortPetChat = (
  native: NativeBridge,
  requestId: string,
): boolean => {
  const run = activeRuns.get(requestId);
  if (!run) {
    return false;
  }
  run.aborted = true;
  native.abortResponseStream(run.streamId);
  return true;
};
