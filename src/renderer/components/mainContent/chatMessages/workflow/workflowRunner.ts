// WorkFlow 运行时：阻塞式工具挂起/结算注册表 + 节点执行引擎。
// 节点执行与子代理同构：每个节点创建一个真实主会话（createWorkflowNodeSession），
// 在 ctx 上注册内存会话并走增量消息 agent loop（流式渲染/工具授权/中止检查），
// 节点完成后提取 handoff 交接给下一个节点的新会话。

import type {
  ChatConversationMessage,
  ConversationContextValue,
  ToolAuthorizationDecision,
  ToolCallInfo,
} from "../utils/conversationTypes";
import {
  createMessageId,
  deleteCheckpoints,
  directoryIdToPath,
  formatMessageTime,
  formatToolResultsContent,
  getErrorMessage,
  parseToolCalls,
  updateFirstMatchingToolCall,
} from "../utils/conversationHelpers";
import { resolveResponseDisposition } from "../utils/responseDisposition";
import { injectSessionIdIntoToolArgs } from "../utils/toolSessionMetadata";
import {
  accumulateRunTokenUsage,
  createStreamChunkHandler,
  createStreamIdHandler,
  remapPersistedUserMessageIds,
  resetIterationStreamMetrics,
  resetRunStreamMetrics,
} from "../hooks/agentLoopHelpers";
import { SUB_AGENT_MAIN_TOOL_NAMES } from "../hooks/subAgentActivation";

export type WorkflowNodeData = {
  id: string;
  name: string;
  label: string;
  prompt: string;
  description: string;
  apiProfile: string;
  model: string;
};

export type WorkflowEdgeItem = { source: string; target: string };

export type WorkflowGraph = {
  title: string;
  nodes: WorkflowNodeData[];
  edges: WorkflowEdgeItem[];
};

export type WorkflowNodeItem = WorkflowNodeData & {
  runStatus: NodeRunStatus;
  errorMessage: string;
  conversationId: string;
  handoffContent: string;
};

export type NodeRunStatus = "pending" | "running" | "completed" | "failed";

export type WorkflowRunnerStatus = "idle" | "running" | "completed" | "failed";

export const WORKFLOW_RUNNER_EVENT = "workflow-runner:progress";
export const WORKFLOW_READY_EVENT = "workflow-runner:ready";

type RunnerEventDetail = {
  parentConversationId: string;
  /** 触发执行的 workflow-generate 工具调用 id：同一会话多个 flow 卡片
   *  的事件隔离键（节点 id 在不同 flow 间可能重名，不能只按会话过滤）。 */
  interactionId: string;
  /** run 来源："run" = generate 卡片执行；"resume" = workflow-resume 续跑。
   *  同 flow 的多张卡片据此做画布宿主切换（非本次 run 的卡片收起画布）。 */
  origin?: "run" | "resume";
  /** 发起本次 run 的工具调用 id（run = generate 卡片 id；resume = 续跑
   *  卡片 id）：卡片判断「事件是否属于自己」的依据。 */
  originInteractionId?: string;
  status: WorkflowRunnerStatus;
  nodeId?: string;
  /** 节点自身状态：与整体 status 解耦——节点完成时整体仍在 running，
   *  观测中的卡片靠它即时把节点 icon 从 loading 切到完成/失败。 */
  nodeStatus?: NodeRunStatus;
  conversationId?: string;
  error?: string;
};

type ReadyEventDetail = {
  parentConversationId: string;
  interactionId: string;
};

type PendingWorkflow = {
  interactionId: string;
  parentConversationId: string;
  directoryId: string;
  graph: WorkflowGraph;
  resolve: (result: string) => void;
  settled: boolean;
};

const pendingWorkflows = new Map<string, PendingWorkflow>();

// ---------------------------------------------------------------------------
// 事件广播
// ---------------------------------------------------------------------------

export function emitWorkflowReady(detail: ReadyEventDetail): void {
  window.dispatchEvent(
    new CustomEvent<ReadyEventDetail>(WORKFLOW_READY_EVENT, { detail }),
  );
}

export function subscribeWorkflowReady(
  handler: (detail: ReadyEventDetail) => void,
): () => void {
  const listener = (event: Event): void => {
    handler((event as CustomEvent<ReadyEventDetail>).detail);
  };
  window.addEventListener(WORKFLOW_READY_EVENT, listener);
  return () => window.removeEventListener(WORKFLOW_READY_EVENT, listener);
}

function emitProgress(detail: RunnerEventDetail): void {
  window.dispatchEvent(
    new CustomEvent<RunnerEventDetail>(WORKFLOW_RUNNER_EVENT, { detail }),
  );
}

export function subscribeWorkflowRunner(
  parentConversationId: string,
  interactionId: string,
  handler: (detail: RunnerEventDetail) => void,
): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<RunnerEventDetail>).detail;
    if (
      detail.parentConversationId !== parentConversationId ||
      detail.interactionId !== interactionId
    ) {
      return;
    }
    handler(detail);
  };
  window.addEventListener(WORKFLOW_RUNNER_EVENT, listener);
  return () => window.removeEventListener(WORKFLOW_RUNNER_EVENT, listener);
}

// ---------------------------------------------------------------------------
// 阻塞式工具入口（与 sub-agents-activate 同语义：工具调用挂起直到用户确认）
// ---------------------------------------------------------------------------

export function parseWorkflowGraph(argsJson: string): WorkflowGraph {
  try {
    const parsed = JSON.parse(argsJson) as {
      title?: string;
      nodes?: Partial<WorkflowNodeData>[];
      edges?: { source?: string; target?: string }[];
    };
    const nodes: WorkflowNodeData[] = (parsed.nodes ?? []).map((node) => ({
      id: node.id ?? "",
      name: node.name ?? "",
      label: node.label ?? node.name ?? "",
      prompt: node.prompt ?? "",
      description: node.description ?? "",
      apiProfile: node.apiProfile ?? "",
      model: node.model ?? "",
    }));
    const edges: WorkflowEdgeItem[] = (parsed.edges ?? []).map((edge) => ({
      source: edge.source ?? "",
      target: edge.target ?? "",
    }));
    return { title: parsed.title ?? "", nodes, edges };
  } catch {
    return { title: "", nodes: [], edges: [] };
  }
}

/**
 * 阻塞式执行 workflow-generate：注册结算句柄并挂起，直到用户
 * - 确认执行（结算为节点执行汇总），或
 * - 不满意而输入回复（结算为用户文本，模型据此重新设计）。
 */
export function executeWorkflowGenerate(
  argsJson: string,
  parentConversationId: string,
  directoryId: string,
  interactionId: string,
): Promise<string> {
  const graph = parseWorkflowGraph(argsJson);
  if (graph.nodes.length === 0) {
    return Promise.resolve(
      JSON.stringify({
        success: false,
        error:
          "workflow-generate received no nodes; re-design the graph and try again",
      }),
    );
  }
  pendingWorkflows.delete(interactionId);
  const entry: PendingWorkflow = {
    interactionId,
    parentConversationId,
    directoryId,
    graph,
    resolve: () => {},
    settled: false,
  };
  const promise = new Promise<string>((resolve) => {
    entry.resolve = (result: string): void => {
      if (entry.settled) {
        return;
      }
      entry.settled = true;
      resolve(result);
      pendingWorkflows.delete(interactionId);
    };
  });
  pendingWorkflows.set(interactionId, entry);
  emitWorkflowReady({
    parentConversationId,
    interactionId,
  });
  return promise;
}

/**
 * 结算一个挂起的 workflow-generate 工具调用（幂等：重复调用被忽略）。
 * `result` 是回传给模型 JSON 字符串。
 */
export function settleWorkflow(interactionId: string, result: string): boolean {
  const entry = pendingWorkflows.get(interactionId);
  if (!entry || entry.settled) {
    return false;
  }
  entry.resolve(result);
  return true;
}

export function getPendingWorkflow(
  interactionId: string,
): PendingWorkflow | undefined {
  return pendingWorkflows.get(interactionId);
}

/** workflow-generate 工具调用是否挂起中（供 UI 判断）。 */
export function isWorkflowPending(interactionId: string): boolean {
  return pendingWorkflows.has(interactionId);
}

/** 会话中止时清理挂起的工作流（避免僵尸 promise）。 */
export function abandonWorkflow(interactionId: string): void {
  const entry = pendingWorkflows.get(interactionId);
  if (entry && !entry.settled) {
    entry.resolve(
      JSON.stringify({
        success: false,
        error: "Workflow was aborted by the user",
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// 执行引擎（子代理同构：节点 = 主会话，ctx 驱动增量消息循环）
// ---------------------------------------------------------------------------

/** 节点内禁止的交互式工具：节点后台串行执行，无法也不应请求用户交互。
 *  子代理（sub-agents-）除外：节点是真实主会话，允许派生子代理，
 *  其交互在子代理会话内处理，侧边栏以 节点 → 子代理 树形展示。 */
const INTERACTIVE_TOOL_PREFIXES = [
  "user-interaction-",
  "workflow-",
  "app-control-requestApproval",
];

type RunnerOptions = {
  parentConversationId: string;
  /** 触发执行的 workflow-generate 工具调用 id：多 flow 卡片隔离键。 */
  interactionId: string;
  directoryId: string;
  /** 父会话自身使用的 API 配置/模型：节点未单独选择时的兜底（会话可独立
   *  改配置，因此跟随会话而非全局 active 配置；均空则回落全局默认）。 */
  sessionApiProfile?: string;
  sessionModel?: string;
  nodes: WorkflowNodeItem[];
  edges: WorkflowEdgeItem[];
  /** 每个节点会话创建后回调（侧边栏刷新 / 会话列表更新）。 */
  onNodeConversationCreated?: (conversationId: string) => void;
};

export type WorkflowRunOutcome = {
  success: boolean;
  summary: {
    nodeId: string;
    label: string;
    status: string;
    conversationId: string;
    handoff: string;
    tokens: number;
  }[];
  totalTokens?: number;
  error?: string;
  /** 失败节点详情：主流程据此向用户说明失败点，并决定是否续跑。 */
  failedNode?: {
    /** flow 标识 = workflow-generate 工具调用 id，续跑工具的入参。 */
    flowId: string;
    nodeId: string;
    label: string;
    conversationId: string;
    error: string;
  };
  /** 失败节点是否可通过 workflow-resume 续跑（失败上下文仍在内存）。 */
  resumable?: boolean;
};

/** 失败 flow 的续跑上下文：run 失败时登记，workflow-resume 据此原会话续跑。 */
type FailedFlowEntry = {
  directoryId: string;
  sessionApiProfile: string;
  sessionModel: string;
  nodes: WorkflowNodeItem[];
  edges: WorkflowEdgeItem[];
  onNodeConversationCreated?: (conversationId: string) => void;
  /** flow 级文件检查点：续跑复用原 checkpoint，保证回滚语义完整。 */
  flowCheckpointId: string;
  failedNodeId: string;
  failedConversationId: string;
};

// 失败 flow 注册表：key = `父会话:interactionId`（与 runnerRegistry 同键）。
// 节点失败即写入，续跑成功或 flow 完成时清除；内存生命周期与 runner 一致
// （应用重启后模型侧无续跑上下文，走卡片"继续执行"的断点重跑路径）。
const failedFlows = new Map<string, FailedFlowEntry>();

/** workflow 执行器：由 useAgentLoop 在主会话工具调用时创建并注册。 */
export type WorkflowRunExecutor = {
  runWorkflow: (options: RunnerOptions) => Promise<WorkflowRunOutcome>;
  /** 从失败节点原会话续跑：发送继续提示词，完成后继续后续节点。 */
  resumeWorkflow: (params: {
    parentConversationId: string;
    interactionId: string;
    /** 触发续跑的 workflow-resume 工具调用 id（画布宿主切换依据）。 */
    originInteractionId: string;
    continuePrompt?: string;
  }) => Promise<WorkflowRunOutcome>;
};

/** runner 事件与进度持久化的参数形态（runWorkflow / resumeWorkflow 共用）。 */
type FlowEmitDetail = {
  status: WorkflowRunnerStatus;
  nodeId?: string;
  nodeStatus?: NodeRunStatus;
  conversationId?: string;
  error?: string;
};
type FlowEmit = (detail: FlowEmitDetail) => void;
type FlowPersistRun = (
  runStatus: "running" | "completed" | "failed",
  currentIndex: number,
  lastHandoff: string,
  tokens: number,
  flowCheckpointId: string,
  errorMessage?: string,
) => void;

type WorkflowRunnerDeps = {
  ctx: ConversationContextValue;
  requestToolAuthorizations: (
    toolCalls: ToolCallInfo[],
    conversationId: string,
    projectId?: string,
  ) => Promise<ToolAuthorizationDecision[]>;
  planApprovedSessionKeysRef: { current: Set<string> };
  /** 子代理激活执行器（渲染进程异步运行时）：节点内允许派生子代理，
   *  子代理在节点会话下运行，交互与授权在子代理会话内处理。 */
  executeSubAgentActivation: (
    argsJson: string,
    parentConversationId: string,
    dirId: string,
    toolCallInteractionId: string | undefined,
    checkpointIds: string[],
  ) => Promise<string>;
  /** 主会话子代理管理工具（listSubAgents/continue）执行器 */
  executeSubAgentMainTool: (
    toolName: string,
    argsJson: string,
    parentConversationId: string,
    checkpointIds: string[],
  ) => Promise<string>;
};

// runner 注册表：key = `父会话:interactionId`。useAgentLoop 处理
// workflow-generate 工具调用时注册（闭包持有新鲜的 ctx），对应的
// WorkflowToolCall 卡片执行时按自己的 interactionId 取用。主 loop 的
// await 保证注册方闭包始终存活。
const runnerRegistry = new Map<string, WorkflowRunExecutor>();

const runnerRegistryKey = (
  parentConversationId: string,
  interactionId: string,
): string => `${parentConversationId}:${interactionId}`;

export function registerWorkflowRunner(
  parentConversationId: string,
  interactionId: string,
  executor: WorkflowRunExecutor,
): void {
  runnerRegistry.set(
    runnerRegistryKey(parentConversationId, interactionId),
    executor,
  );
}

export function getWorkflowRunner(
  parentConversationId: string,
  interactionId: string,
): WorkflowRunExecutor | undefined {
  return runnerRegistry.get(
    runnerRegistryKey(parentConversationId, interactionId),
  );
}

// 活跃 run 注册表：key = `父会话:interactionId`。runWorkflow/resumeWorkflow
// 开始时登记、结束时移除。UI 重挂载恢复状态时据此区分"真在运行"（保留
// running + 持续接事件）与"重启后残留的 running 记录"（降级为 pending）；
// value 记录 run 来源，卡片据此判断画布宿主（自己的 run 展开画布，
// 他人接管的 run 收起画布）。
type ActiveWorkflowRun = {
  origin: "run" | "resume";
  /** 发起本次 run 的工具调用 id（卡片归属判断依据）。 */
  originInteractionId: string;
};
const activeRuns = new Map<string, ActiveWorkflowRun>();

export function isWorkflowRunActive(
  parentConversationId: string,
  interactionId: string,
): boolean {
  return activeRuns.has(runnerRegistryKey(parentConversationId, interactionId));
}

/** 活跃 run 的来源信息：无活跃 run 时返回 undefined。 */
export function getActiveWorkflowRun(
  parentConversationId: string,
  interactionId: string,
): ActiveWorkflowRun | undefined {
  return activeRuns.get(runnerRegistryKey(parentConversationId, interactionId));
}

// 活跃 run 的实时节点状态：事件瞬发，挂载中的卡片可能错过（画布异步
// 恢复完成前，事件更新作用于空节点数组），而 DB 写入又滞后于 runner
// 内存状态。卡片挂载恢复完成后据此对齐最新节点状态，避免"节点实际已
// 在续跑、卡片仍显示上次失败"的冻结画面。
const activeRunNodeStates = new Map<string, Map<string, NodeRunStatus>>();

/** 读取活跃 run 的实时节点状态（无活跃 run 时 undefined）。 */
export function getActiveRunNodeStates(
  parentConversationId: string,
  interactionId: string,
): Map<string, NodeRunStatus> | undefined {
  return activeRunNodeStates.get(
    runnerRegistryKey(parentConversationId, interactionId),
  );
}

/** 记录活跃 run 中节点的最新状态（runFlowNodes 各状态变化点调用）。 */
const setActiveNodeRunState = (
  flowKey: string,
  nodeId: string,
  status: NodeRunStatus,
): void => {
  let nodeStates = activeRunNodeStates.get(flowKey);
  if (!nodeStates) {
    nodeStates = new Map();
    activeRunNodeStates.set(flowKey, nodeStates);
  }
  nodeStates.set(nodeId, status);
};

// 活跃节点会话注册表：key = 父会话 id，value = 该父会话正在执行的节点
// 会话 id 集合。主会话中断/删除时据此级联停止所有节点。
const activeNodeSessions = new Map<string, Set<string>>();

/** 父会话当前正在执行的节点会话 id 列表（副本，供级联中止遍历）。 */
export function getActiveWorkflowNodeIds(
  parentConversationId: string,
): string[] {
  return Array.from(activeNodeSessions.get(parentConversationId) ?? []);
}

/** 会话是否为正在执行的 WorkFlow 节点会话。sendPendingMessageNow 据此把
 *  "立即发送"路由到节点的 force-send 路径（与子代理分支同语义）。 */
export function isActiveWorkflowNodeSession(conversationId: string): boolean {
  for (const nodeIds of activeNodeSessions.values()) {
    if (nodeIds.has(conversationId)) {
      return true;
    }
  }
  return false;
}

/** 会话中断时结算其所有挂起的 workflow-generate（避免僵尸 promise）。 */
export function abandonWorkflowsForConversation(
  parentConversationId: string,
): void {
  for (const [interactionId, entry] of pendingWorkflows) {
    if (entry.parentConversationId === parentConversationId && !entry.settled) {
      abandonWorkflow(interactionId);
    }
  }
}

/**
 * 计算执行顺序：委托 Rust 端 validateWorkflowGraph（与 workflow-generate
 * MCP 工具共用同一 Kahn 拓扑排序 + 环检测实现），前端不再重复实现拓扑
 * 逻辑。校验失败或桥不可用时回退为输入顺序（与原 topologicalOrder 的
 * 环退化行为一致）。
 */
async function resolveExecutionOrder(
  nodes: WorkflowNodeItem[],
  edges: WorkflowEdgeItem[],
): Promise<string[]> {
  try {
    const nodesPayload = nodes.map((node) => ({
      id: node.id,
      name: node.name,
      label: node.label,
      prompt: node.prompt,
      description: node.description,
      apiProfile: node.apiProfile,
      model: node.model,
    }));
    const edgesPayload = edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
    }));
    const result = await window.snow.validateWorkflowGraph(
      JSON.stringify(nodesPayload),
      JSON.stringify(edgesPayload),
    );
    if (result.errors.length === 0 && result.order.length === nodes.length) {
      return result.order;
    }
  } catch {
    // 桥不可用：回退输入顺序，执行不阻塞
  }
  return nodes.map((node) => node.id);
}

// readonly 工具集合缓存（模块级）：workflow 节点内只读工具自动放行，
// 避免每个节点每轮都重新查询工具清单。
let cachedReadonlyToolNames: Set<string> | null = null;

async function getReadonlyToolNames(): Promise<Set<string>> {
  if (cachedReadonlyToolNames === null) {
    cachedReadonlyToolNames = new Set(
      await window.snow.listReadonlyTools().catch(() => []),
    );
  }
  return cachedReadonlyToolNames;
}

function extractHandoff(content: string): string {
  const match = content.match(/<handoff>([\s\S]*?)<\/handoff>/i);
  const raw = match?.[1]?.trim() ?? "";
  if (raw) {
    return raw;
  }
  // 兜底：模型没有输出标签时，取最后一个非空段落作为交接文档。
  const paragraphs = content
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.trim().length > 0);
  return paragraphs.at(-1)?.trim() ?? "";
}

function buildNodePrompt(node: WorkflowNodeItem, handoff: string): string {
  const parts: string[] = [];
  parts.push(`# ${node.label || node.name}`.trim());
  if (node.description.trim()) {
    parts.push(node.description.trim());
  }
  parts.push(node.prompt.trim());
  if (handoff.trim()) {
    parts.push(`\n\n## 上一个节点的交接文档\n\n${handoff.trim()}`);
  }
  parts.push(NODE_HANDOFF_REQUIREMENT);
  return parts.join("\n\n");
}

function createNodeConversationId(): string {
  return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 节点失败后的交接要求（续跑提示词与首跑提示词共用同一段要求）。 */
const NODE_HANDOFF_REQUIREMENT =
  "\n\n## 工作流节点执行要求\n当你完成这个节点的全部工作后，必须在回复的最后输出交接文档，格式如下：\n\n<handoff>\n与你之后节点需要的信息，例如：完成了什么、关键文件路径、决策、证据（构建/诊断结果）、下一步建议。\n</handoff>\n\n请直接输出交接文档到 <handoff> 标签中，不要添加额外说明。";

/** 续跑提示词：发送到失败节点的原会话，让节点带着已有上下文继续完成工作。 */
function buildResumePrompt(
  node: WorkflowNodeItem,
  continuePrompt: string,
): string {
  const parts: string[] = [
    `你之前执行的节点「${node.label || node.name}」未能完成，工作流已在此暂停，现在请求你继续。`,
  ];
  if (continuePrompt.trim()) {
    parts.push(`## 继续要求\n\n${continuePrompt.trim()}`);
  } else {
    parts.push(
      "请从上次中断的地方继续完成本节点的全部工作，不要重做已完成的步骤。",
    );
  }
  parts.push(NODE_HANDOFF_REQUIREMENT.trim());
  return parts.join("\n\n");
}

/**
 * 创建 workflow 执行器。与 createSubAgentActivation 同构：闭包持有 ctx 与
 * 工具授权入口，节点会话在 ctx 上以真实主会话身份运行增量消息 agent loop。
 */
export function createWorkflowRunner(
  deps: WorkflowRunnerDeps,
): WorkflowRunExecutor {
  const {
    ctx,
    requestToolAuthorizations,
    planApprovedSessionKeysRef,
    executeSubAgentActivation,
    executeSubAgentMainTool,
  } = deps;
  // 同一父会话只允许一个执行中的 runner（防止重复点击/并发启动）。
  const runners = new Map<string, Promise<WorkflowRunOutcome>>();

  // Flow 事件与 run 进度持久化工厂：runWorkflow / resumeWorkflow 共用。
  // origin/originInteractionId 标记本次 run 的发起者：同 flow 的多张卡片
  // （generate 卡片 + 若干 resume 卡片）据此做画布宿主切换。
  const createFlowEmit =
    (
      parentConversationId: string,
      interactionId: string,
      origin: "run" | "resume",
      originInteractionId: string,
    ): FlowEmit =>
    (detail) => {
      emitProgress({
        parentConversationId,
        interactionId,
        origin,
        originInteractionId,
        ...detail,
      });
    };

  /** 将 run 级进度持久化到 workflow_runs（跨重启恢复 + 断点续跑依据）。 */
  const createFlowPersistRun =
    (options: RunnerOptions): FlowPersistRun =>
    (
      runStatus,
      currentIndex,
      lastHandoff,
      tokens,
      flowCheckpointId,
      errorMessage = "",
    ) => {
      void window.snow
        .upsertWorkflowRun(
          options.parentConversationId,
          options.interactionId,
          runStatus,
          currentIndex,
          lastHandoff,
          tokens,
          flowCheckpointId,
          options.directoryId,
          errorMessage,
        )
        .catch(() => {
          // 持久化失败不阻断执行：run 状态仍可从节点会话记录部分恢复
        });
    };

  // 断点续跑：读取本 flow 的 workflow_runs 记录，恢复上次执行进度。
  // 已完成的节点（workflow_node_sessions 中 run_status = completed）直接
  // 跳过，从上次中断/失败的节点继续；lastHandoff 与 token 累计一并恢复。
  const loadResumeState = async (
    key: string,
    interactionId: string,
  ): Promise<{
    handoff: string;
    tokens: number;
    completedByNode: Map<string, string>;
  }> => {
    try {
      const run = await window.snow.getWorkflowRun(key, interactionId);
      if (!run || run.runStatus === "completed" || run.currentNodeIndex <= 0) {
        return {
          handoff: "",
          tokens: 0,
          completedByNode: new Map(),
        };
      }
      const records = await window.snow.listWorkflowNodeSessions(key);
      const flowRecords = records.filter(
        (record) => record.flowId === interactionId,
      );
      const completedByNode = new Map<string, string>();
      for (const record of flowRecords) {
        if (record.runStatus === "completed" && record.nodeId) {
          completedByNode.set(record.nodeId, record.handoffContent);
        }
      }
      return {
        handoff: run.lastHandoff,
        tokens: run.totalTokens,
        completedByNode,
      };
    } catch {
      return {
        handoff: "",
        tokens: 0,
        completedByNode: new Map(),
      };
    }
  };

  /** 节点失败时登记续跑上下文（workflow-resume 原会话续跑的依据）。 */
  const registerFailedFlow = (
    flowKey: string,
    options: RunnerOptions,
    node: WorkflowNodeItem,
    flowCheckpointId: string,
    conversationId: string,
  ): void => {
    if (!conversationId) {
      return;
    }
    failedFlows.set(flowKey, {
      directoryId: options.directoryId,
      sessionApiProfile: options.sessionApiProfile ?? "",
      sessionModel: options.sessionModel ?? "",
      nodes: options.nodes,
      edges: options.edges,
      onNodeConversationCreated: options.onNodeConversationCreated,
      flowCheckpointId,
      failedNodeId: node.id,
      failedConversationId: conversationId,
    });
  };

  const runWorkflow = (options: RunnerOptions): Promise<WorkflowRunOutcome> => {
    const key = options.parentConversationId;
    const flowKey = runnerRegistryKey(key, options.interactionId);
    // 并发守卫：同一 flow 已有 runner 时直接复用其结果，绝不并发执行。
    const existing = runners.get(flowKey);
    if (existing) {
      return existing;
    }
    const emit = createFlowEmit(
      key,
      options.interactionId,
      "run",
      options.interactionId,
    );
    const persistRun = createFlowPersistRun(options);
    // 运行前重置节点状态为 pending。
    for (const node of options.nodes) {
      node.runStatus = "pending";
      node.errorMessage = "";
      node.conversationId = "";
      node.handoffContent = "";
    }
    emit({ status: "running" });

    // Flow 级文件检查点：flow 首节点执行前拍摄（空 manifest），节点工具经
    // callMcpTool 的 checkpointIds 参数在此 checkpoint 上做 before 捕获。
    // 回滚父会话时恢复它即可撤销节点的全部文件改动；创建失败降级为无
    // checkpoint（回滚仅清理会话数据，不影响文件）。
    const createFlowCheckpoint = async (): Promise<string> => {
      try {
        const workDir = directoryIdToPath(options.directoryId);
        if (!workDir) {
          return "";
        }
        return await window.snow.createCheckpoint(workDir);
      } catch {
        return "";
      }
    };

    const runner: Promise<WorkflowRunOutcome> = (async () => {
      const flowCheckpointId = await createFlowCheckpoint();
      // checkpoint 创建期间 run 可能已被取消（用户中止/回滚）：清理后直接退出。
      if (ctx.sessionsRefData.current.get(key)?.isSending === false) {
        if (flowCheckpointId) {
          deleteCheckpoints([flowCheckpointId]);
        }
        emit({
          status: "failed",
          error: "Workflow was cancelled before start",
        });
        return {
          success: false,
          summary: [],
          error: "Workflow was cancelled before start",
        };
      }
      // 执行顺序由 Rust 端校验（拓扑收敛的唯一实现）：环/非法图时
      // resolveExecutionOrder 已回退为输入顺序，前端不再自行实现拓扑排序。
      const order = await resolveExecutionOrder(options.nodes, options.edges);
      const resume = await loadResumeState(key, options.interactionId);
      return runFlowNodes({
        flowKey,
        options,
        emit,
        persistRun,
        flowCheckpointId,
        order,
        nodesById: new Map(options.nodes.map((node) => [node.id, node])),
        completedByNode: resume.completedByNode,
        resumeByNode: new Map(),
        handoff: resume.handoff,
        totalTokens: resume.tokens,
      });
    })().finally(() => {
      activeRuns.delete(flowKey);
      activeRunNodeStates.delete(flowKey);
      runners.delete(flowKey);
    });
    runners.set(flowKey, runner);
    activeRuns.set(flowKey, {
      origin: "run",
      originInteractionId: options.interactionId,
    });
    return runner;
  };

  /** 从失败节点原会话续跑：发送继续提示词到原会话，完成后继续后续节点。 */
  const resumeWorkflow = (params: {
    parentConversationId: string;
    interactionId: string;
    /** 触发续跑的 workflow-resume 工具调用 id（画布宿主切换依据）。 */
    originInteractionId: string;
    continuePrompt?: string;
  }): Promise<WorkflowRunOutcome> => {
    const key = params.parentConversationId;
    const flowKey = runnerRegistryKey(key, params.interactionId);
    const failed = failedFlows.get(flowKey);
    if (!failed) {
      return Promise.resolve({
        success: false,
        summary: [],
        error:
          "No resumable failed node for this flowId. The failed-node context only lives until the app restarts; ask the user to press Continue on the workflow card (breakpoint re-run) or re-run the workflow.",
      });
    }
    const existing = runners.get(flowKey);
    if (existing) {
      return existing;
    }
    const resumeNode = failed.nodes.find(
      (item) => item.id === failed.failedNodeId,
    );
    if (!resumeNode) {
      return Promise.resolve({
        success: false,
        summary: [],
        error: "The failed node no longer exists in this workflow graph",
      });
    }
    // failedFlows 持有执行时的节点对象引用：已完成节点的 runStatus/handoff
    // 仍然准确，据此重建 RunnerOptions。
    const options: RunnerOptions = {
      parentConversationId: key,
      interactionId: params.interactionId,
      directoryId: failed.directoryId,
      sessionApiProfile: failed.sessionApiProfile,
      sessionModel: failed.sessionModel,
      nodes: failed.nodes,
      edges: failed.edges,
      onNodeConversationCreated: failed.onNodeConversationCreated,
    };
    const emit = createFlowEmit(
      key,
      params.interactionId,
      "resume",
      params.originInteractionId,
    );
    const persistRun = createFlowPersistRun(options);
    const runner: Promise<WorkflowRunOutcome> = (async () => {
      emit({ status: "running" });
      const order = await resolveExecutionOrder(failed.nodes, failed.edges);
      const completedByNode = new Map<string, string>();
      for (const item of failed.nodes) {
        if (item.runStatus === "completed") {
          completedByNode.set(item.id, item.handoffContent);
        }
      }
      // 续跑注入：失败节点复用原会话，继续提示词沿用其全部上下文；
      // resume 模式不消费 handoff（节点已带着原始需求与执行历史）。
      const resumeByNode = new Map<
        string,
        { conversationId: string; prompt: string }
      >([
        [
          failed.failedNodeId,
          {
            conversationId: failed.failedConversationId,
            prompt: buildResumePrompt(resumeNode, params.continuePrompt ?? ""),
          },
        ],
      ]);
      return runFlowNodes({
        flowKey,
        options,
        emit,
        persistRun,
        // 复用原 flow checkpoint：节点已做的文件改动捕获在它上面，续跑的
        // 新改动继续捕获进去，回滚语义保持完整。
        flowCheckpointId: failed.flowCheckpointId,
        order,
        nodesById: new Map(failed.nodes.map((node) => [node.id, node])),
        completedByNode,
        resumeByNode,
        handoff: "",
        totalTokens: 0,
      });
    })().finally(() => {
      activeRuns.delete(flowKey);
      activeRunNodeStates.delete(flowKey);
      runners.delete(flowKey);
    });
    runners.set(flowKey, runner);
    activeRuns.set(flowKey, {
      origin: "resume",
      originInteractionId: params.originInteractionId,
    });
    return runner;
  };

  /** 共用执行核心：按拓扑序执行未完成节点，失败即暂停并登记续跑上下文。 */
  const runFlowNodes = async (params: {
    flowKey: string;
    options: RunnerOptions;
    emit: FlowEmit;
    persistRun: FlowPersistRun;
    flowCheckpointId: string;
    order: string[];
    nodesById: Map<string, WorkflowNodeItem>;
    /** 已完成节点（跳过执行）：nodeId -> handoff。 */
    completedByNode: Map<string, string>;
    /** 复用原会话续跑的节点：nodeId -> { conversationId, prompt }。 */
    resumeByNode: Map<string, { conversationId: string; prompt: string }>;
    handoff: string;
    totalTokens: number;
  }): Promise<WorkflowRunOutcome> => {
    const { flowKey, options, emit, persistRun, flowCheckpointId } = params;
    let handoff = params.handoff;
    let overallFailed = false;
    let totalTokens = params.totalTokens;
    const summary: WorkflowRunOutcome["summary"] = [];
    // 跳过已完成节点：按「已完成节点 id」匹配（不按 index——用户可能增删
    // 节点导致顺序变化）。completedCount 表示「累计已完成节点数」，作为
    // run 进度（currentNodeIndex）持久化，供下次断点续跑定位。
    const skipped = new Set<string>();
    for (const nodeId of params.order) {
      const node = params.nodesById.get(nodeId);
      if (!node) {
        continue;
      }
      const handoffContent = params.completedByNode.get(nodeId);
      if (handoffContent === undefined) {
        continue;
      }
      node.runStatus = "completed";
      node.errorMessage = "";
      node.handoffContent = handoffContent;
      skipped.add(nodeId);
      setActiveNodeRunState(flowKey, nodeId, "completed");
      summary.push({
        nodeId: node.id,
        label: node.label || node.name,
        status: "completed",
        conversationId: node.conversationId,
        handoff: handoffContent,
        tokens: 0,
      });
    }
    let completedCount = skipped.size;
    if (completedCount > 0) {
      emit({ status: "running" });
    }

    for (const nodeId of params.order) {
      if (skipped.has(nodeId)) {
        continue;
      }
      const node = params.nodesById.get(nodeId);
      if (!node) {
        continue;
      }
      node.runStatus = "running";
      setActiveNodeRunState(flowKey, nodeId, "running");
      emit({ status: "running", nodeId });
      try {
        const result = await executeNode(
          options,
          node,
          handoff,
          flowCheckpointId,
          params.resumeByNode.get(nodeId),
          // 会话就绪回调：节点会话 id 在 executeNode 内确定（新节点生成/
          // 续跑复用原会话），此处补发携带 conversationId 的 running 事件，
          // 画布节点点击跳会话即时可用（否则运行中节点要等完成事件才能
          // 拿到会话 id），并写回 runner 侧节点对象供失败登记等使用。
          (conversationId) => {
            node.conversationId = conversationId;
            emit({ status: "running", nodeId, conversationId });
          },
        );
        node.conversationId = result.conversationId;
        node.handoffContent = result.failed ? "" : result.handoff;
        node.runStatus = result.failed ? "failed" : "completed";
        node.errorMessage = result.failed
          ? (result.error ?? "Node failed")
          : "";
        setActiveNodeRunState(flowKey, nodeId, node.runStatus);
        await window.snow.updateWorkflowNodeSession(
          result.conversationId,
          node.runStatus === "completed" ? "completed" : "failed",
          node.errorMessage,
          node.handoffContent,
        );
        // 节点状态落盘后立即刷新侧边栏（workflowNodeMap 重查）。
        // updateWorkflowNodeSession 只写 bookkeeping 表，不会触发会话
        // upsert/版本递增，若不主动刷新，用户手动中止后节点树会
        // 停留在旧的 running（loading）状态。
        ctx.setConversationListVersion((version) => version + 1);
        summary.push({
          nodeId: node.id,
          label: node.label || node.name,
          status: node.runStatus,
          conversationId: result.conversationId,
          handoff: node.handoffContent,
          tokens: result.tokenCount,
        });
        totalTokens += result.tokenCount;
        emit({
          status: "running",
          nodeId,
          nodeStatus: result.failed ? "failed" : "completed",
          conversationId: result.conversationId,
          ...(result.failed ? { error: node.errorMessage } : {}),
        });
        // 每完成一个节点就持久化一次 run 进度：应用重启/中断后
        // workflow_runs 记录的是「已完成到第几个节点」，支持断点续跑。
        // 失败节点不计入完成数（failure 分支单独落 failed 状态），
        // 否则续跑会把失败节点误跳过。
        if (result.failed) {
          overallFailed = true;
          persistRun(
            "failed",
            completedCount,
            handoff,
            totalTokens,
            flowCheckpointId,
            node.errorMessage,
          );
          registerFailedFlow(
            flowKey,
            options,
            node,
            flowCheckpointId,
            result.conversationId,
          );
          break;
        }
        completedCount += 1;
        persistRun(
          "running",
          completedCount,
          node.handoffContent,
          totalTokens,
          flowCheckpointId,
        );
        handoff = node.handoffContent;
      } catch (error) {
        node.runStatus = "failed";
        node.errorMessage = getErrorMessage(error);
        overallFailed = true;
        setActiveNodeRunState(flowKey, nodeId, "failed");
        // 节点会话已创建（执行中途抛错）：将失败状态落盘并刷新侧边栏，
        // 避免节点树停留在 running（loading）状态。
        if (node.conversationId) {
          await window.snow
            .updateWorkflowNodeSession(
              node.conversationId,
              "failed",
              node.errorMessage,
              "",
            )
            .catch(() => {
              // 落盘失败不阻断 workflow 收尾
            });
          ctx.setConversationListVersion((version) => version + 1);
        }
        emit({
          status: "running",
          nodeId,
          nodeStatus: "failed",
          error: node.errorMessage,
        });
        persistRun(
          "failed",
          completedCount,
          handoff,
          totalTokens,
          flowCheckpointId,
          node.errorMessage,
        );
        // 会话已存在才有续跑价值（resume 节点抛错时 conversationId
        // 仍是原会话；全新节点执行前抛错则无上下文可续）。
        registerFailedFlow(
          flowKey,
          options,
          node,
          flowCheckpointId,
          node.conversationId,
        );
        break;
      }
    }
    emit({ status: overallFailed ? "failed" : "completed" });
    persistRun(
      overallFailed ? "failed" : "completed",
      completedCount,
      handoff,
      totalTokens,
      flowCheckpointId,
      overallFailed ? "One or more nodes failed" : "",
    );
    // 失败详情回传主流程：主流程据此向用户说明失败点，并可通过
    // workflow-resume 原会话续跑；flow 跑完时清除续跑上下文。
    const failedEntry = overallFailed ? failedFlows.get(flowKey) : undefined;
    const failedNodeItem = failedEntry
      ? params.nodesById.get(failedEntry.failedNodeId)
      : undefined;
    if (!overallFailed) {
      failedFlows.delete(flowKey);
    }
    const failedNodeDetail =
      overallFailed && failedEntry
        ? {
            flowId: options.interactionId,
            nodeId: failedEntry.failedNodeId,
            label:
              failedNodeItem?.label ||
              failedNodeItem?.name ||
              failedEntry.failedNodeId,
            conversationId: failedEntry.failedConversationId,
            error: failedNodeItem?.errorMessage || "Node failed",
          }
        : undefined;
    return {
      success: !overallFailed,
      summary,
      totalTokens,
      ...(overallFailed
        ? {
            error: failedNodeDetail?.error || "One or more nodes failed",
            ...(failedNodeDetail
              ? { failedNode: failedNodeDetail, resumable: true }
              : {}),
          }
        : {}),
    };
  };

  /** 单节点执行：建主会话 → 注册内存会话 → 增量消息 agent loop → 收尾。 */
  const executeNode = async (
    options: RunnerOptions,
    node: WorkflowNodeItem,
    handoff: string,
    flowCheckpointId: string,
    /** 续跑注入：复用失败节点的原会话，改发继续提示词。 */
    resume?: { conversationId: string; prompt: string },
    /** 会话就绪回调（已创建/复用并落 running 后触发）。 */
    onSessionReady?: (conversationId: string) => void,
  ): Promise<{
    conversationId: string;
    handoff: string;
    failed: boolean;
    error?: string;
    tokenCount: number;
  }> => {
    const parentConversationId = options.parentConversationId;
    const dirId = options.directoryId;
    const conversationId = resume?.conversationId ?? createNodeConversationId();
    // 登记活跃节点：主会话中断/删除时据此级联停止本节点。
    let set = activeNodeSessions.get(parentConversationId);
    if (!set) {
      set = new Set<string>();
      activeNodeSessions.set(parentConversationId, set);
    }
    set.add(conversationId);
    // 节点未单独选择配置时跟随父会话自身的配置（会话可独立改配置）；
    // 会话也没有时留空，由 Rust 端回落全局 active 配置。
    const effectiveApiProfile =
      node.apiProfile.trim() || options.sessionApiProfile?.trim() || "";
    // 节点选了配置时空模型用该配置的高级模型，不回落父会话
    const effectiveModel = node.apiProfile.trim()
      ? node.model.trim()
      : node.model.trim() || options.sessionModel?.trim() || "";

    // 节点会话是真实主会话：DB 记录 + bookkeeping 行一次建好。
    // flow_id = interactionId，多 flow 卡片的恢复数据按它隔离；
    // flow_checkpoint_id = flow 级文件检查点，回滚恢复时撤销节点文件改动。
    // 续跑模式跳过创建：复用失败节点的原会话（完整上下文仍在其中）。
    if (!resume) {
      await window.snow.createWorkflowNodeSession(
        conversationId,
        parentConversationId,
        options.interactionId,
        flowCheckpointId,
        node.id,
        node.label || node.name,
        dirId,
        effectiveApiProfile,
        effectiveModel,
      );
      options.onNodeConversationCreated?.(conversationId);
    }
    await window.snow.updateWorkflowNodeSession(
      conversationId,
      "running",
      "",
      "",
    );
    // 节点转 running 后立即刷新侧边栏（workflowNodeMap 重查最新
    // run_status）：节点图标进入 loading。续跑复用原会话没有"新建会话"
    // 的刷新回调（onNodeConversationCreated），不 bump 会停留在上轮
    // 终态（如失败图标），看起来节点没有恢复执行。
    ctx.setConversationListVersion((version) => version + 1);
    // 会话就绪（新节点已创建 / 续跑复用原会话）：通知调用方补发携带
    // conversationId 的 running 事件，画布节点点击跳会话即时可用。
    onSessionReady?.(conversationId);
    if (!resume) {
      try {
        const record = await window.snow.getChatConversation(conversationId);
        if (record) {
          ctx.setUpsertedConversation({ record, timestamp: Date.now() });
        }
      } catch {
        // 侧边栏 upsert 失败不阻塞节点执行
      }
    }

    // 注册内存会话并进入发送状态（与子代理激活一致）。
    ctx.ensureSession(conversationId, dirId || undefined);
    const sessionRef = ctx.sessionsRefData.current.get(conversationId);
    if (sessionRef) {
      sessionRef.isSending = true;
      sessionRef.isAbortRequested = false;
    }
    ctx.updateSessionField(conversationId, "isStreaming", true);
    resetRunStreamMetrics(ctx, conversationId);
    ctx.updateSessionField(conversationId, "streamStartedAt", Date.now());
    ctx.addStreamingId(conversationId);

    let tokenCount = 0;

    // 取消检查：节点自身被用户中止，或父会话 run 已结束/被中止。
    const isNodeCancelled = (): boolean => {
      const nodeRef = ctx.sessionsRefData.current.get(conversationId);
      if (nodeRef?.isAbortRequested) {
        return true;
      }
      const parentRef = ctx.sessionsRefData.current.get(parentConversationId);
      return !parentRef?.isSending || parentRef.isAbortRequested;
    };

    // 用户强行发送（sendPendingMessageNow 暂存 forceSendMessages 后 handleAbort）
    // 触发的中止：与普通中止不同，节点不据此失败——软结束当前回合，由下方
    // force-send 循环在本节点会话内以新回合继续（与子代理 subAgentRunLoop 的
    // forceSendAbort 处理同构）。
    const isNodeForceSendAborted = (): boolean => {
      const nodeRef = ctx.sessionsRefData.current.get(conversationId);
      return (
        nodeRef?.isAbortRequested === true && nodeRef?.forceSendAbort === true
      );
    };

    // 消费本节点会话的 Pending 队列（用户在节点运行期间排队的消息）：全部合并
    // 为一条 user 文本追加进会话；仅当节点会话是当前激活视图时清空待发面板
    // （activePendingMessages 只镜像激活会话的队列）。队列空返回 null。
    const consumeNodePendingQueue = (): string | null => {
      const pendingItems =
        ctx.pendingQueueRef.current.get(conversationId) ?? [];
      if (pendingItems.length === 0) {
        return null;
      }
      ctx.pendingQueueRef.current.delete(conversationId);
      const pendingText = pendingItems.map((item) => item.text).join("\n\n");
      if (ctx.activeConversationIdRef.current === conversationId) {
        ctx.setActivePendingMessages([]);
      }
      ctx.updateSessionMessages(conversationId, (currentMessages) => [
        ...currentMessages,
        {
          id: createMessageId("user"),
          role: "user",
          content: pendingText,
          timestamp: formatMessageTime(),
          status: "sent",
        },
      ]);
      return pendingText;
    };

    const finalizeMessage = (
      messageId: string,
      patch: Partial<ChatConversationMessage>,
    ): void => {
      ctx.updateSessionMessages(conversationId, (currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === messageId
            ? { ...currentMessage, ...patch }
            : currentMessage,
        ),
      );
    };

    // 工具卡片状态更新必须在 setSessions 的 updater 内部基于最新消息
    // 完成：工具串行循环中 sessionsRef.current 尚未随渲染同步，从它读
    // 旧数组整体替换会让后续更新覆盖前面已完成的工具状态。
    const updateAssistantToolCalls = (
      assistantMessageId: string,
      toolCall: ToolCallInfo,
      matchStatus: "pending" | "running" | ("pending" | "running")[],
      patch: (currentToolCall: ToolCallInfo) => ToolCallInfo,
    ): void => {
      ctx.updateSessionMessages(conversationId, (currentMessages) =>
        currentMessages.map((currentMessage) => {
          if (currentMessage.id !== assistantMessageId) {
            return currentMessage;
          }
          return {
            ...currentMessage,
            toolCalls: updateFirstMatchingToolCall(
              currentMessage.toolCalls,
              toolCall,
              matchStatus,
              patch,
            ),
          };
        }),
      );
    };

    // 节点收尾时的 Pending 队列转交（与子代理 createForwardSubPendingQueue
    // 同构）：节点结束后未消费的排队消息与强行发送暂存不能悬空丢失，转交
    // 父会话 pending 队列，由父循环在 run 结束的冲刷点消费（或用户处理）。
    const forwardNodePendingQueue = (): void => {
      const forwardRef = ctx.sessionsRefData.current.get(conversationId);
      const leftover = [
        ...(ctx.pendingQueueRef.current.get(conversationId) ?? []),
        ...(forwardRef?.forceSendMessages ?? []),
      ];
      if (leftover.length === 0) {
        return;
      }
      ctx.pendingQueueRef.current.delete(conversationId);
      if (forwardRef) {
        forwardRef.forceSendMessages = undefined;
      }
      const parentQueue =
        ctx.pendingQueueRef.current.get(parentConversationId) ?? [];
      parentQueue.push(...leftover);
      ctx.pendingQueueRef.current.set(parentConversationId, parentQueue);
      if (ctx.activeConversationIdRef.current === parentConversationId) {
        ctx.setActivePendingMessages(parentQueue.map((item) => item.text));
      } else if (ctx.activeConversationIdRef.current === conversationId) {
        ctx.setActivePendingMessages([]);
      }
    };

    try {
      // 首条 user 消息：新节点发节点需求 + 上一个节点的交接文档；
      // 续跑节点改发继续提示词（原会话已带完整上下文）。
      const prompt = resume?.prompt ?? buildNodePrompt(node, handoff);
      ctx.updateSessionMessages(conversationId, (currentMessages) => [
        ...currentMessages,
        {
          id: createMessageId("user"),
          role: "user",
          content: prompt,
          timestamp: formatMessageTime(),
          status: "sent",
        },
      ]);

      const runLoop = async (
        requestMessages: {
          role: "user" | "assistant" | "tool";
          content: string;
          toolResultsJson?: string;
        }[],
      ): Promise<{ content: string; failed: boolean; error?: string }> => {
        if (isNodeCancelled()) {
          if (isNodeForceSendAborted()) {
            return { content: "", failed: false };
          }
          return {
            content: "",
            failed: true,
            error: "Workflow node was interrupted by the user",
          };
        }

        resetIterationStreamMetrics(ctx, conversationId);
        const assistantMessageId = createMessageId("assistant");
        ctx.updateSessionMessages(conversationId, (currentMessages) => [
          ...currentMessages,
          {
            id: assistantMessageId,
            role: "assistant",
            content: "",
            timestamp: formatMessageTime(),
            status: "sending",
            model: effectiveModel || undefined,
          },
        ]);

        let response: Awaited<
          ReturnType<typeof window.snow.createResponseStream>
        >;
        try {
          response = await window.snow.createResponseStream(
            {
              // 增量消息：Rust 端按 conversationId 重建上下文并只持久化本批新消息。
              messages: requestMessages,
              conversationId,
              directoryId: dirId || undefined,
              apiProfile: effectiveApiProfile || undefined,
              model: effectiveModel || undefined,
              planMode: false,
              goalMode: false,
              worktreeMode: false,
              workflowMode: false,
            },
            createStreamChunkHandler(
              ctx,
              conversationId,
              assistantMessageId,
              isNodeCancelled,
            ),
            createStreamIdHandler(ctx, conversationId, isNodeCancelled),
          );
        } catch (error) {
          finalizeMessage(assistantMessageId, {
            content: getErrorMessage(error),
            status: "error",
            isRetrying: false,
          });
          return { content: "", failed: true, error: getErrorMessage(error) };
        }

        // 与主会话一致：store_chat_exchange 已把本批 user 消息持久化并返回
        // DB snowflake id，这里把前端临时 id 替换为 DB id，让 DOM 的
        // data-message-id 与 DB 一致（UserMessageRail 的可见性高亮与点击
        // 跳转都按 DB id 在 DOM 中定位消息）。
        if (
          response.persistedUserMessageIds &&
          response.persistedUserMessageIds.length > 0
        ) {
          remapPersistedUserMessageIds(
            ctx,
            conversationId,
            response.persistedUserMessageIds,
          );
        }
        // 节点会话消息已持久化：bump conversationVersion 让 UserMessageRail
        // 重新拉取用户消息列表。节点运行期间没有其它 bump 来源，否则运行中
        // 打开节点会话时 rail 只显示打开时刻的陈旧快照。
        ctx.setConversationVersion((version) => version + 1);

        // 强行发送触发的中止：保留已流式内容软结束当前回合（handleAbort 已把
        // 消息固化为 sent，这里补内容），交给 executeNode 的 force-send 循环继续
        // 新回合。普通中止不在此拦截，维持原有 disposition 语义。
        if (isNodeForceSendAborted()) {
          const currentAssistant = ctx.sessionsRef.current?.[
            conversationId
          ]?.messages.find((message) => message.id === assistantMessageId);
          const partialContent =
            currentAssistant?.content || response.content || "";
          finalizeMessage(assistantMessageId, {
            content: partialContent,
            status: "sent",
            isRetrying: false,
          });
          return { content: partialContent, failed: false };
        }

        const disposition = resolveResponseDisposition(response);
        if (disposition.kind === "error") {
          finalizeMessage(assistantMessageId, {
            content: response.content || "Node request failed.",
            thinking: response.thinking || undefined,
            status: "error",
            responseId: response.id || undefined,
            model: response.model || undefined,
            isRetrying: false,
          });
          return {
            content: "",
            failed: true,
            error: response.content || "Node request failed.",
          };
        }
        if (disposition.kind === "incomplete") {
          finalizeMessage(assistantMessageId, {
            content: response.content || "",
            thinking: response.thinking || undefined,
            status: "incomplete",
            incompleteVariant: disposition.variant,
            interruptionReason: disposition.reason,
            recoveryOutcome: disposition.recoveryOutcome,
            responseId: response.id || undefined,
            model: response.model || undefined,
            toolCalls: undefined,
            isRetrying: false,
          });
          return {
            content: "",
            failed: true,
            error: "Node response ended before completion",
          };
        }

        if (response.tokenUsage) {
          tokenCount +=
            response.tokenUsage.inputTokens + response.tokenUsage.outputTokens;
          ctx.updateSessionField(
            conversationId,
            "tokenUsage",
            response.tokenUsage,
          );
          accumulateRunTokenUsage(ctx, conversationId, response.tokenUsage);
        }

        const toolCalls = parseToolCalls(response.toolCallsJson);
        if (toolCalls.length === 0) {
          finalizeMessage(assistantMessageId, {
            content: response.content || "",
            thinking: response.thinking || undefined,
            status: "sent",
            responseId: response.id || undefined,
            model: response.model || undefined,
            isRetrying: false,
          });
          // 响应在中断竞态下正常完成时，也必须按失败返回，
          // 否则 runWorkflow 会误判成功并激活下一个节点。
          if (isNodeCancelled()) {
            if (isNodeForceSendAborted()) {
              return { content: response.content || "", failed: false };
            }
            return {
              content: "",
              failed: true,
              error: "Workflow node was interrupted by the user",
            };
          }
          // 自动发送：节点回合结束（无后续工具调用）时消费 Pending 队列——用户
          // 在节点运行期间排队的消息作为新 user 回合在本节点会话处理，绝不悬空
          // 在队列里（与主循环在无工具调用边界冲刷队列同语义）。
          const finalPendingText = consumeNodePendingQueue();
          if (finalPendingText) {
            return runLoop([{ role: "user", content: finalPendingText }]);
          }
          return { content: response.content || "", failed: false };
        }

        finalizeMessage(assistantMessageId, {
          content: response.content || "",
          thinking: response.thinking || undefined,
          status: "sent",
          responseId: response.id || undefined,
          model: response.model || undefined,
          toolCalls: toolCalls.map((toolCall) => ({
            ...toolCall,
            status: "pending",
          })),
          isRetrying: false,
        });

        // 工具授权：readonly 工具自动放行（workflow 节点后台串行执行，
        // 不应让只读操作打断自动化流程），非只读工具仍走授权气泡。
        // 这解决"workflow 声称自动执行却每个只读工具都要点确认"的矛盾。
        const readonlyToolNames = await getReadonlyToolNames();
        const toolsNeedingAuth = toolCalls.filter(
          (toolCall) => !readonlyToolNames.has(toolCall.name),
        );
        const readonlyDecisions: ToolAuthorizationDecision[] = toolCalls
          .filter((toolCall) => readonlyToolNames.has(toolCall.name))
          .map(() => ({ status: "approved" as const }));
        const authDecisions =
          toolsNeedingAuth.length > 0
            ? await requestToolAuthorizations(
                toolsNeedingAuth,
                conversationId,
                dirId,
              )
            : [];
        // 合并：按 toolCalls 原始顺序组装决策数组，保证与后续
        // structuredResults 循环的 index 对齐。
        const decisions: ToolAuthorizationDecision[] = [];
        let readonlyIndex = 0;
        let authIndex = 0;
        for (const toolCall of toolCalls) {
          if (readonlyToolNames.has(toolCall.name)) {
            decisions.push(
              readonlyDecisions[readonlyIndex] ?? { status: "approved" },
            );
            readonlyIndex += 1;
          } else {
            decisions.push(authDecisions[authIndex] ?? { status: "approved" });
            authIndex += 1;
          }
        }
        if (isNodeCancelled()) {
          if (isNodeForceSendAborted()) {
            return { content: "", failed: false };
          }
          return {
            content: "",
            failed: true,
            error: "Workflow node was interrupted by the user",
          };
        }

        const allRejected =
          toolCalls.length > 0 &&
          decisions.every((decision) => decision.status === "rejected");
        const hasUserProvidedRejectionReason = decisions.some(
          (decision) =>
            decision.status === "rejected" &&
            decision.userProvidedReason === true,
        );

        const structuredResults: {
          name: string;
          callId: string;
          result: string;
        }[] = [];
        for (let index = 0; index < toolCalls.length; index++) {
          const toolCall = toolCalls[index];
          const decision = decisions[index];
          if (isNodeCancelled()) {
            if (isNodeForceSendAborted()) {
              return { content: "", failed: false };
            }
            return {
              content: "",
              failed: true,
              error: "Workflow node was interrupted by the user",
            };
          }

          // 拒绝结果回传模型，让模型据此调整。
          if (decision.status === "rejected") {
            const rejectResult = JSON.stringify({
              success: false,
              error: "TOOL_EXECUTION_DENIED_BY_USER",
              reason: decision.reason || "User declined tool execution",
            });
            structuredResults.push({
              name: toolCall.name,
              callId: toolCall.callId || "",
              result: rejectResult,
            });
            updateAssistantToolCalls(
              assistantMessageId,
              toolCall,
              "pending",
              (currentToolCall) => ({
                ...currentToolCall,
                status: "completed",
                result: rejectResult,
              }),
            );
            continue;
          }

          updateAssistantToolCalls(
            assistantMessageId,
            toolCall,
            "pending",
            (currentToolCall) => ({
              ...currentToolCall,
              status: "running",
              startedAt: Date.now(),
            }),
          );

          // 交互式工具在节点内不可用：直接拒绝并继续。
          if (
            INTERACTIVE_TOOL_PREFIXES.some((prefix) =>
              toolCall.name.startsWith(prefix),
            )
          ) {
            const blockedResult = JSON.stringify({
              success: false,
              error: `${toolCall.name} is an interactive tool and cannot run inside a WorkFlow node. Execute the step directly and continue without it.`,
            });
            structuredResults.push({
              name: toolCall.name,
              callId: toolCall.callId || "",
              result: blockedResult,
            });
            updateAssistantToolCalls(
              assistantMessageId,
              toolCall,
              "running",
              (currentToolCall) => ({
                ...currentToolCall,
                status: "error",
                result: blockedResult,
              }),
            );
            continue;
          }

          const toolArgs = injectSessionIdIntoToolArgs(
            toolCall.name,
            toolCall.arguments,
            conversationId,
          );
          // 敏感命令确认后签发授权 token（与子代理一致）。
          let sensitiveAuthorizationToken: string | undefined;
          if (
            toolCall.name === "bash-terminal-execute" &&
            decision.sensitiveCommandConfirmed === true
          ) {
            try {
              const parsedArgs = JSON.parse(toolArgs) as Record<
                string,
                unknown
              >;
              if (typeof parsedArgs.command === "string") {
                sensitiveAuthorizationToken =
                  await window.snow.issueSensitiveCommandAuthorization(
                    parsedArgs.command,
                  );
              }
            } catch {
              // 签发失败时让工具自然失败
            }
          }

          let result: string;
          let toolErrored = false;
          // flow checkpoint 存在时必须同步传工作目录：checkpoint 捕获按
          // (checkpointIds, workDir) 定位，缺 workDir 会让文件工具直接
          // 报错、bash 类工具降级为无快照并刷"缺少工作目录"日志。
          const flowCheckpointWorkDir = flowCheckpointId
            ? directoryIdToPath(dirId)
            : undefined;
          try {
            // 子代理工具必须走渲染进程异步运行时：Rust callMcpTool 端
            // 会拒绝并报 "must be executed through the asynchronous
            // Electron interaction bridge"。节点内与主会话一致，允许
            // 激活子代理（在节点会话下运行）与 listSubAgents/continue
            // 管理工具，侧边栏以 节点 → 子代理 树形展示。
            if (toolCall.name === "sub-agents-activate") {
              result = await executeSubAgentActivation(
                toolArgs,
                conversationId,
                dirId,
                toolCall.interactionId,
                flowCheckpointId ? [flowCheckpointId] : [],
              );
            } else if (SUB_AGENT_MAIN_TOOL_NAMES.has(toolCall.name)) {
              result = await executeSubAgentMainTool(
                toolCall.name,
                toolArgs,
                conversationId,
                flowCheckpointId ? [flowCheckpointId] : [],
              );
            } else {
              // 第三参 projectId 必须传目录 id：工具执行的工作目录上下文。
              // 第四参 checkpointIds 传 flow checkpoint：文件工具 before
              // 阶段把被改文件的原始状态捕获进该 checkpoint（lazy
              // capture），回滚时恢复它即可撤销节点的文件改动。
              // onChunk 把 tool_execution id 记录到工具卡片：会话级联
              // 中止时 killRunningToolExecutions 据此杀掉节点仍在运行
              // 的子进程。
              result = await window.snow.callMcpTool(
                toolCall.name,
                toolArgs,
                dirId,
                flowCheckpointId ? [flowCheckpointId] : [],
                flowCheckpointWorkDir,
                sensitiveAuthorizationToken,
                (chunk) => {
                  if (!chunk.data) {
                    return;
                  }
                  if (
                    chunk.stream === "interactive_session" ||
                    chunk.stream === "tool_execution"
                  ) {
                    updateAssistantToolCalls(
                      assistantMessageId,
                      toolCall,
                      ["pending", "running"],
                      (currentToolCall) => ({
                        ...currentToolCall,
                        interactiveSessionId:
                          chunk.stream === "interactive_session"
                            ? chunk.data
                            : currentToolCall.interactiveSessionId,
                        toolExecutionId:
                          chunk.stream === "tool_execution"
                            ? chunk.data
                            : currentToolCall.toolExecutionId,
                      }),
                    );
                    return;
                  }
                  updateAssistantToolCalls(
                    assistantMessageId,
                    toolCall,
                    ["pending", "running"],
                    (currentToolCall) => ({
                      ...currentToolCall,
                      streamingStdout:
                        chunk.stream === "stdout"
                          ? `${currentToolCall.streamingStdout ?? ""}${chunk.data}`
                          : currentToolCall.streamingStdout,
                      streamingStderr:
                        chunk.stream === "stderr"
                          ? `${currentToolCall.streamingStderr ?? ""}${chunk.data}`
                          : currentToolCall.streamingStderr,
                    }),
                  );
                },
                toolCall.interactionId,
                undefined,
                false,
                planApprovedSessionKeysRef.current.has(parentConversationId),
                // 会话溯源：节点内 memory-save 由 Rust 分发层注入节点会话 ID。
                conversationId,
              );
            }
          } catch (error) {
            toolErrored = true;
            result = JSON.stringify({ error: getErrorMessage(error) });
          }

          updateAssistantToolCalls(
            assistantMessageId,
            toolCall,
            "running",
            (currentToolCall) => ({
              ...currentToolCall,
              status: toolErrored ? "error" : "completed",
              result,
            }),
          );
          structuredResults.push({
            name: toolCall.name,
            callId: toolCall.callId || "",
            result,
          });
        }

        // 工具结果作为 tool 消息进入内存会话（下一轮增量请求持久化它）。
        ctx.updateSessionMessages(conversationId, (currentMessages) => [
          ...currentMessages,
          {
            id: createMessageId("tool"),
            role: "tool",
            content: formatToolResultsContent(structuredResults),
            timestamp: formatMessageTime(),
            status: "sent",
            toolName: toolCalls.map((tc) => tc.name).join(", "),
          },
        ]);

        if (allRejected && !hasUserProvidedRejectionReason) {
          return {
            content: "",
            failed: true,
            error: "All tool calls were denied by the user",
          };
        }

        // 自动发送：本回合工具执行完毕，消费 Pending 队列中用户排队的消息，与
        // 工具结果一起进入下一轮（与子代理 subPendingForTools 同构：节点运行
        // 期间插入的消息在回合边界切入本节点会话）。
        const toolPendingText = consumeNodePendingQueue();
        const toolRequest = {
          role: "tool" as const,
          content: formatToolResultsContent(structuredResults),
          toolResultsJson: JSON.stringify(structuredResults),
        };
        return runLoop(
          toolPendingText
            ? [toolRequest, { role: "user" as const, content: toolPendingText }]
            : [toolRequest],
        );
      };

      let loopResult = await runLoop([{ role: "user", content: prompt }]);
      // 强行发送循环：用户在节点运行中点击"立即发送"（sendPendingMessageNow
      // 已把消息暂存到 forceSendMessages 并 handleAbort 中断当前回合）时，在
      // 本节点会话内以新回合继续处理暂存消息（与子代理 runForceSendLoop 同构），
      // 而不是停掉节点、也绝不转交主流程 handleSendMessage。直到没有新的强行
      // 发送为止；节点的最终产出由最后一轮回合决定。
      while (true) {
        const forceRef = ctx.sessionsRefData.current.get(conversationId);
        const forceSends = forceRef?.forceSendMessages;
        if (!forceRef || !forceSends || forceSends.length === 0) {
          break;
        }
        forceRef.forceSendMessages = undefined;
        const forceText = forceSends.map((item) => item.text).join("\n\n");
        ctx.updateSessionMessages(conversationId, (currentMessages) => [
          ...currentMessages,
          {
            id: createMessageId("user"),
            role: "user",
            content: forceText,
            timestamp: formatMessageTime(),
            status: "sent",
          },
        ]);
        // handleAbort 已复位运行状态：新回合必须恢复 isSending/isAbortRequested/
        // 流式标记（与子代理 runForceSendLoop 一致），中止检查才能正常工作。
        forceRef.isSending = true;
        forceRef.isAbortRequested = false;
        forceRef.forceSendAbort = false;
        ctx.updateSessionField(conversationId, "isStreaming", true);
        resetRunStreamMetrics(ctx, conversationId);
        ctx.updateSessionField(conversationId, "streamStartedAt", Date.now());
        ctx.addStreamingId(conversationId);
        loopResult = await runLoop([{ role: "user", content: forceText }]);
      }
      return {
        conversationId,
        handoff: loopResult.failed ? "" : extractHandoff(loopResult.content),
        failed: loopResult.failed,
        ...(loopResult.error ? { error: loopResult.error } : {}),
        tokenCount,
      };
    } finally {
      // 节点收尾：无论成败都退出发送状态（会话保持可继续手动对话）。
      const nodeSet = activeNodeSessions.get(parentConversationId);
      if (nodeSet) {
        nodeSet.delete(conversationId);
        if (nodeSet.size === 0) {
          activeNodeSessions.delete(parentConversationId);
        }
      }
      const ref = ctx.sessionsRefData.current.get(conversationId);
      if (ref) {
        ref.isSending = false;
        ref.isAbortRequested = false;
        // 复位软中断标记：异常退出路径（如授权等待被 handleAbort reject 抛出）
        // 会残留 true，续跑复用本会话时会把真实停止误判为强行发送软中断。
        ref.forceSendAbort = false;
      }
      ctx.updateSessionField(conversationId, "isStreaming", false);
      ctx.updateSessionField(conversationId, "isAborting", false);
      ctx.removeStreamingId(conversationId);
      // 节点收尾转交：未消费的排队消息与强行发送暂存交给父会话队列。
      forwardNodePendingQueue();
    }
  };

  return { runWorkflow, resumeWorkflow };
}
