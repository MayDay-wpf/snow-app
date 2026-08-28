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
  resetIterationStreamMetrics,
  resetRunStreamMetrics,
} from "../hooks/agentLoopHelpers";

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

/** 节点内禁止的交互式工具：节点后台串行执行，无法也不应请求用户交互。 */
const INTERACTIVE_TOOL_PREFIXES = [
  "user-interaction-",
  "sub-agents-",
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
};

/** workflow 执行器：由 useAgentLoop 在主会话工具调用时创建并注册。 */
export type WorkflowRunExecutor = {
  runWorkflow: (options: RunnerOptions) => Promise<WorkflowRunOutcome>;
};

type WorkflowRunnerDeps = {
  ctx: ConversationContextValue;
  requestToolAuthorizations: (
    toolCalls: ToolCallInfo[],
    conversationId: string,
    projectId?: string,
  ) => Promise<ToolAuthorizationDecision[]>;
  planApprovedSessionKeysRef: { current: Set<string> };
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

// 活跃 run 注册表：key = `父会话:interactionId`。runWorkflow 开始时登记、
// 结束时移除。UI 重挂载恢复状态时据此区分"真在运行"（保留 running +
// 持续接事件）与"重启后残留的 running 记录"（降级为 pending）。
const activeRuns = new Set<string>();

export function isWorkflowRunActive(
  parentConversationId: string,
  interactionId: string,
): boolean {
  return activeRuns.has(runnerRegistryKey(parentConversationId, interactionId));
}

// 活跃节点会话注册表：key = 父会话 id，value = 该父会话正在执行的节点
// 会话 id 集合。主会话中断/删除时据此级联停止所有节点。
const activeNodeSessions = new Map<string, Set<string>>();

/** 父会话当前正在执行的节点会话 id 列表（副本，供级联中止遍历）。 */
export function getActiveWorkflowNodeIds(
  parentConversationId: string,
): string[] {
  return Array.from(activeNodeSessions.get(parentConversationId) ?? []);
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

function topologicalOrder(
  nodes: WorkflowNodeItem[],
  edges: WorkflowEdgeItem[],
): string[] {
  const ids = nodes.map((node) => node.id);
  const inDegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>(
    ids.map((id) => [id, [] as string[]]),
  );
  for (const edge of edges) {
    if (!inDegree.has(edge.source) || !inDegree.has(edge.target)) {
      continue;
    }
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    adjacency.get(edge.source)?.push(edge.target);
  }
  const queue = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const child of adjacency.get(id) ?? []) {
      const next = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, next);
      if (next === 0) {
        queue.push(child);
      }
    }
  }
  if (order.length !== ids.length) {
    // 环：放弃拓扑序，退化为原顺序（执行时按编辑顺序串行）。
    return ids;
  }
  return order;
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
  parts.push(
    "\n\n## 工作流节点执行要求\n当你完成这个节点的全部工作后，必须在回复的最后输出交接文档，格式如下：\n\n<handoff>\n与你之后节点需要的信息，例如：完成了什么、关键文件路径、决策、证据（构建/诊断结果）、下一步建议。\n</handoff>\n\n请直接输出交接文档到 <handoff> 标签中，不要添加额外说明。",
  );
  return parts.join("\n\n");
}

function createNodeConversationId(): string {
  return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 创建 workflow 执行器。与 createSubAgentActivation 同构：闭包持有 ctx 与
 * 工具授权入口，节点会话在 ctx 上以真实主会话身份运行增量消息 agent loop。
 */
export function createWorkflowRunner(
  deps: WorkflowRunnerDeps,
): WorkflowRunExecutor {
  const { ctx, requestToolAuthorizations, planApprovedSessionKeysRef } = deps;
  // 同一父会话只允许一个执行中的 runner（防止重复点击/并发启动）。
  const runners = new Map<string, Promise<WorkflowRunOutcome>>();

  const runWorkflow = (options: RunnerOptions): Promise<WorkflowRunOutcome> => {
    const key = options.parentConversationId;
    const flowKey = runnerRegistryKey(key, options.interactionId);
    // 并发守卫：同一 flow 已有 runner 时直接复用其结果，绝不并发执行。
    const existing = runners.get(flowKey);
    if (existing) {
      return existing;
    }
    const emit = (detail: {
      status: WorkflowRunnerStatus;
      nodeId?: string;
      nodeStatus?: NodeRunStatus;
      conversationId?: string;
      error?: string;
    }): void => {
      emitProgress({
        parentConversationId: key,
        interactionId: options.interactionId,
        ...detail,
      });
    };
    const nodesById = new Map(options.nodes.map((node) => [node.id, node]));
    const order = topologicalOrder(options.nodes, options.edges);
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
      let handoff = "";
      let overallFailed = false;
      let totalTokens = 0;
      const summary: WorkflowRunOutcome["summary"] = [];

      for (const nodeId of order) {
        const node = nodesById.get(nodeId);
        if (!node) {
          continue;
        }
        node.runStatus = "running";
        emit({ status: "running", nodeId });
        try {
          const result = await executeNode(
            options,
            node,
            handoff,
            flowCheckpointId,
          );
          node.conversationId = result.conversationId;
          node.handoffContent = result.failed ? "" : result.handoff;
          node.runStatus = result.failed ? "failed" : "completed";
          node.errorMessage = result.failed
            ? (result.error ?? "Node failed")
            : "";
          await window.snow.updateWorkflowNodeSession(
            result.conversationId,
            node.runStatus === "completed" ? "completed" : "failed",
            node.errorMessage,
            node.handoffContent,
          );
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
          if (result.failed) {
            overallFailed = true;
            break;
          }
          handoff = node.handoffContent;
        } catch (error) {
          node.runStatus = "failed";
          node.errorMessage = getErrorMessage(error);
          overallFailed = true;
          emit({
            status: "running",
            nodeId,
            nodeStatus: "failed",
            error: node.errorMessage,
          });
          break;
        }
      }
      emit({ status: overallFailed ? "failed" : "completed" });
      return {
        success: !overallFailed,
        summary,
        totalTokens,
        ...(overallFailed ? { error: "One or more nodes failed" } : {}),
      };
    })().finally(() => {
      activeRuns.delete(flowKey);
      runners.delete(flowKey);
    });
    runners.set(flowKey, runner);
    activeRuns.add(flowKey);
    return runner;
  };

  /** 单节点执行：建主会话 → 注册内存会话 → 增量消息 agent loop → 收尾。 */
  const executeNode = async (
    options: RunnerOptions,
    node: WorkflowNodeItem,
    handoff: string,
    flowCheckpointId: string,
  ): Promise<{
    conversationId: string;
    handoff: string;
    failed: boolean;
    error?: string;
    tokenCount: number;
  }> => {
    const parentConversationId = options.parentConversationId;
    const dirId = options.directoryId;
    const conversationId = createNodeConversationId();
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
    await window.snow.updateWorkflowNodeSession(
      conversationId,
      "running",
      "",
      "",
    );
    // 侧边栏立即出现节点会话（主会话身份，点击可进入查看实时内容）。
    try {
      const record = await window.snow.getChatConversation(conversationId);
      if (record) {
        ctx.setUpsertedConversation({ record, timestamp: Date.now() });
      }
    } catch {
      // 侧边栏 upsert 失败不阻塞节点执行
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

    try {
      // 首条 user 消息（节点需求 + 上一个节点的交接文档）。
      const prompt = buildNodePrompt(node, handoff);
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

      const runLoop = async (requestMessages: {
        role: "user" | "assistant" | "tool";
        content: string;
        toolResultsJson?: string;
      }): Promise<{ content: string; failed: boolean; error?: string }> => {
        if (isNodeCancelled()) {
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
              messages: [requestMessages],
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
            return {
              content: "",
              failed: true,
              error: "Workflow node was interrupted by the user",
            };
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

        // 工具授权：与子代理一致，授权气泡挂在节点会话上。
        const decisions = await requestToolAuthorizations(
          toolCalls,
          conversationId,
          dirId,
        );
        if (isNodeCancelled()) {
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
            // 第三参 projectId 必须传目录 id：工具执行的工作目录上下文。
            // 第四参 checkpointIds 传 flow checkpoint：文件工具 before 阶段
            // 把被改文件的原始状态捕获进该 checkpoint（lazy capture），
            // 回滚时恢复它即可撤销节点的文件改动。
            // onChunk 把 tool_execution id 记录到工具卡片：会话级联中止时
            // killRunningToolExecutions 据此杀掉节点仍在运行的子进程。
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
            );
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

        return runLoop({
          role: "tool",
          content: formatToolResultsContent(structuredResults),
          toolResultsJson: JSON.stringify(structuredResults),
        });
      };

      const loopResult = await runLoop({ role: "user", content: prompt });
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
      }
      ctx.updateSessionField(conversationId, "isStreaming", false);
      ctx.updateSessionField(conversationId, "isAborting", false);
      ctx.removeStreamingId(conversationId);
    }
  };

  return { runWorkflow };
}
