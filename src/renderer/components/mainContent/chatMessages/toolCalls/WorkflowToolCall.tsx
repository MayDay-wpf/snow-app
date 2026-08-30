import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Check,
  CircleX,
  Loader2,
  Pencil,
  Play,
  Plus,
  Send,
  Trash2,
  Workflow,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../../i18n";
import { CustomSelect } from "../../../common/CustomSelect";
import type { ApiConfigRecord, Model } from "../../../../../preload";
import { useChatConversationContext } from "../components/ChatConversationContext";
import type { ToolCallInfo } from "../utils/conversationTypes";
import {
  getWorkflowRunner,
  isWorkflowRunActive,
  parseWorkflowGraph,
  settleWorkflow,
  subscribeWorkflowRunner,
  subscribeWorkflowReady,
  type NodeRunStatus,
  type WorkflowEdgeItem,
  type WorkflowGraph,
  type WorkflowNodeData,
  type WorkflowNodeItem,
  type WorkflowRunnerStatus,
} from "../workflow/workflowRunner";
import { ToolNameBadge } from "./shared/ToolNameBadge";

type WorkflowToolCallProps = {
  toolCall: ToolCallInfo;
  /** Conversation this tool call belongs to; workflow node sessions are
   *  created under it (parent conversation). */
  conversationId?: string;
};

// ---------------------------------------------------------------------------
// React Flow 节点渲染
// ---------------------------------------------------------------------------

type WorkflowFlowNodeData = {
  node: WorkflowNodeItem;
};

type WorkflowFlowNode = Node<WorkflowFlowNodeData>;

const WorkflowCardNode = memo(function WorkflowCardNode({
  data,
  selected,
}: NodeProps<WorkflowFlowNode>): React.JSX.Element {
  const { node } = data;
  return (
    <div className={`workflow-node ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="workflow-node-header">
        <span className="workflow-node-title">{node.label || node.name}</span>
        {node.runStatus === "running" ? (
          <Loader2 size={13} className="tool-call-icon-spinning" />
        ) : node.runStatus === "completed" ? (
          <Check size={13} className="workflow-node-icon-completed" />
        ) : node.runStatus === "failed" ? (
          <CircleX size={13} className="workflow-node-icon-failed" />
        ) : null}
      </div>
      {node.description && (
        <div className="workflow-node-description">{node.description}</div>
      )}
      {node.runStatus === "failed" && node.errorMessage && (
        <div className="workflow-node-error">{node.errorMessage}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

// nodeTypes 必须定义在组件外：内联对象每次渲染重建身份，会让全部节点
// 在每帧重渲染时卸载重挂载（拖拽时表现为画布严重闪烁）。
const WORKFLOW_NODE_TYPES = { workflowCard: WorkflowCardNode };

// ---------------------------------------------------------------------------
// 画布持久化（DB 替代 localStorage）
// ---------------------------------------------------------------------------

/** 持久化 payload 中的节点：只含配置字段与位置。运行态字段
 *  （runStatus/errorMessage/conversationId/handoffContent）绝不落盘，
 *  由 restoreRuns 从 DB 恢复；字段缺省表示 payload 未提供（损坏数据）。 */
type PersistedCanvasNode = {
  id: string;
  name?: string;
  label?: string;
  prompt?: string;
  description?: string;
  apiProfile?: string;
  model?: string;
  position?: { x: number; y: number };
};

type PersistedCanvasPayload = {
  version: number;
  nodes: PersistedCanvasNode[];
  edges: { source: string; target: string }[];
};

/** 初始画布计算结果：flow 节点（含位置）+ 业务边列表。 */
type InitialCanvas = {
  nodes: WorkflowFlowNode[];
  edges: WorkflowEdgeItem[];
};

// 默认网格布局（3 列）：与无持久化数据时的初始布局保持一致。
const defaultNodePosition = (index: number): { x: number; y: number } => ({
  x: (index % 3) * 300,
  y: Math.floor(index / 3) * 170,
});

function toFlowNode(
  node: WorkflowNodeData,
  position: { x: number; y: number },
): WorkflowFlowNode {
  return {
    id: node.id,
    type: "workflowCard",
    position,
    data: {
      node: {
        ...node,
        runStatus: "pending",
        errorMessage: "",
        conversationId: "",
        handoffContent: "",
      },
    },
  };
}

/** 防御性解析 DB 画布 payload：JSON 损坏/结构不符都静默返回 null，
 *  让组件回退到 args 解析图，绝不能因坏数据崩溃。 */
function parseCanvasPayload(raw: string): PersistedCanvasPayload | null {
  try {
    const parsed = JSON.parse(raw) as PersistedCanvasPayload | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.edges)
    ) {
      return null;
    }
    const nodes = parsed.nodes
      .filter(
        (node): node is PersistedCanvasNode =>
          Boolean(node) && typeof node.id === "string" && node.id.length > 0,
      )
      .map((node) => ({
        id: node.id,
        name: typeof node.name === "string" ? node.name : undefined,
        label: typeof node.label === "string" ? node.label : undefined,
        prompt: typeof node.prompt === "string" ? node.prompt : undefined,
        description:
          typeof node.description === "string" ? node.description : undefined,
        apiProfile:
          typeof node.apiProfile === "string" ? node.apiProfile : undefined,
        model: typeof node.model === "string" ? node.model : undefined,
        position:
          node.position &&
          typeof node.position.x === "number" &&
          Number.isFinite(node.position.x) &&
          typeof node.position.y === "number" &&
          Number.isFinite(node.position.y)
            ? { x: node.position.x, y: node.position.y }
            : undefined,
      }));
    const edges = parsed.edges
      .filter(
        (edge): edge is { source: string; target: string } =>
          Boolean(edge) &&
          typeof edge.source === "string" &&
          edge.source.length > 0 &&
          typeof edge.target === "string" &&
          edge.target.length > 0,
      )
      .map((edge) => ({ source: edge.source, target: edge.target }));
    return { version: parsed.version, nodes, edges };
  } catch {
    // JSON 损坏：静默回退，画布功能不受影响。
    return null;
  }
}

/** 确定性边 id（重复边被禁止，端点即可唯一确定一条边）：派生/删除/过滤
 *  全部按此 id 对齐，不会像旧版带 index 的 id 那样在删掉中间边后整体
 *  漂移导致删除命中错误边。 */
function buildEdgeId(edge: { source: string; target: string }): string {
  return `wf-edge-${edge.source}->${edge.target}`;
}

/** 从 target 出发沿现有边 BFS，若能到达 source 则「加入 source→target」
 *  会成环。runner 的 topologicalOrder 遇环会退化为原顺序执行，提前拒绝
 *  成环连线可保证新边一定参与正确的执行拓扑。source === target（自环）
 *  同样视为成环。 */
function wouldCreateCycle(
  edges: WorkflowEdgeItem[],
  source: string,
  target: string,
): boolean {
  if (source === target) {
    return true;
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const nexts = adjacency.get(edge.source);
    if (nexts) {
      nexts.push(edge.target);
    } else {
      adjacency.set(edge.source, [edge.target]);
    }
  }
  const queue: string[] = [target];
  const visited = new Set<string>([target]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === source) {
      return true;
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

type CanvasContextMenu = {
  /** 相对画布容器的坐标（浮层定位用）。 */
  x: number;
  y: number;
  /** 视口坐标（换算 flow 坐标用）。 */
  clientX: number;
  clientY: number;
  nodeId: string | null;
  /** 右键命中的连线 id（确定性边 id）；节点/画布右键时为 null。 */
  edgeId: string | null;
};

const WorkflowToolCallInner = ({
  toolCall,
  conversationId,
}: WorkflowToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    handleSelectConversation,
    refreshConversations,
    conversationDirectoryId: contextDirectoryId,
  } = useChatConversationContext();
  const { screenToFlowPosition } = useReactFlow();
  const parentConversationId = conversationId ?? "";
  const directoryId = contextDirectoryId ?? "";
  const graph = useMemo(
    () => parseWorkflowGraph(toolCall.arguments ?? "{}"),
    [toolCall],
  );
  // 初始画布仅计算一次（useRef 兜住整个生命周期）：先用 args 解析图做
  // 同步基线，随后由 effect 异步加载 DB 持久化的画布定制覆盖（DB 是
  // 异步 API，不能像旧版 localStorage 那样同步合并）。
  const initialCanvasRef = useRef<InitialCanvas | null>(null);
  if (initialCanvasRef.current === null) {
    initialCanvasRef.current = {
      nodes: graph.nodes.map((node, index) =>
        toFlowNode(node, defaultNodePosition(index)),
      ),
      edges: graph.edges,
    };
  }
  const initialCanvas = initialCanvasRef.current;
  // React Flow 官方受控模式（useNodesState + onNodesChange）：拖拽由
  // applyNodeChanges 逐帧驱动，只替换被拖节点对象，其余节点引用稳定；
  // 业务数据挂在 data.node，更新时同样只替换目标节点。
  const [flowNodes, setFlowNodes, onFlowNodesChange] =
    useNodesState<WorkflowFlowNode>(initialCanvas.nodes);
  const [edges, setEdges] = useState<WorkflowEdgeItem[]>(initialCanvas.edges);
  const [runnerStatus, setRunnerStatus] =
    useState<WorkflowRunnerStatus>("idle");
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [userReply, setUserReply] = useState("");
  const [hasReplied, setHasReplied] = useState(false);
  // 已提交的反馈内容：AI 收到 userResponse 重新设计流程，组件上同步
  // 展示这条反馈，让"流程为何重新生成"在卡片内可追溯。
  const [submittedReply, setSubmittedReply] = useState("");
  const flowNodesRef = useRef(flowNodes);
  flowNodesRef.current = flowNodes;
  // 连线校验（isValidConnection 在拖拽中高频触发）走 ref 读最新边，
  // 避免回调闭包捕获过期的 edges。
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  // 画布容器（右键菜单/编辑浮层的定位基准）。
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  // 画布右键菜单与节点编辑浮层锚点（相对画布容器）。
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(
    null,
  );
  const [editorAnchor, setEditorAnchor] = useState<{ x: number; y: number }>(
    () => ({ x: 16, y: 16 }),
  );
  const runnerStatusRef = useRef<WorkflowRunnerStatus>("idle");
  // 工具调用是否仍挂起等待用户操作（未结算）。历史 replay 的已完成
  // 工具调用初始即视为非挂起。
  const pendingRef = useRef<boolean>(toolCall.status !== "completed");
  // 断点续跑状态：workflow_runs 中记录了未完成的执行进度（应用重启/
  // 中断/失败后），卡片据此显示"继续执行"并跳过已完成节点。
  const [resumeState, setResumeState] = useState<{
    resumeIndex: number;
    handoff: string;
    tokens: number;
  } | null>(null);

  // 编辑类操作仅在工具挂起且未运行时开放（渲染期读 ref）。
  const canEditCanvas =
    pendingRef.current && runnerStatusRef.current !== "running";
  // 事件回调内判断可编辑性走 ref：useCallback 缓存的回调若读渲染期值
  // 会闭包过期（运行状态变化不一定触发相关回调重建）。
  const canEditCanvasRef = useRef(canEditCanvas);
  canEditCanvasRef.current = canEditCanvas;

  // 节点配置下拉数据源：API 配置列表 + 按所选配置拉取的模型目录
  // （对齐子代理编辑器：配置决定模型候选，切换配置清空模型）。
  const [apiConfigs, setApiConfigs] = useState<ApiConfigRecord[]>([]);
  const [modelOptions, setModelOptions] = useState<Model[]>([]);
  const [isModelCatalogLoading, setIsModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState("");
  const modelCatalogGenerationRef = useRef(0);

  useEffect(() => {
    void window.snow
      .listApiConfigs()
      .then(setApiConfigs)
      .catch(() => {
        // 配置列表加载失败时下拉仅剩"跟随会话"选项
      });
  }, []);

  // 工具挂起状态与 runner 状态同步：工具完成（结算）后视为非挂起。
  useEffect(() => {
    if (toolCall.status === "error") {
      pendingRef.current = false;
    }
    if (toolCall.status === "completed") {
      pendingRef.current = false;
      setRunnerStatus((current) =>
        current === "running" ? current : "completed",
      );
    }
  }, [toolCall.status]);

  // 恢复历史运行状态：挂载时从 DB 读取本 flow 的节点运行记录与 run 级
  // 进度。记录按 flowId（= toolCall.interactionId）隔离，避免同会话多
  // flow 的重名节点互串；旧数据（无 flowId）回退按 nodeId 匹配。
  // runner 仍在活跃执行时保留 running 状态（后续事件继续驱动更新）；
  // 应用重启后残留的 running 记录无人驱动，降级为 pending。workflow_runs
  // 里存在未完成进度（重启/失败/中断）时记录 resumeState，让执行按钮
  // 变为"继续执行"并跳过已完成节点。
  const restoreRuns = useCallback(async (): Promise<void> => {
    if (!parentConversationId) {
      return;
    }
    try {
      const allRecords =
        await window.snow.listWorkflowNodeSessions(parentConversationId);
      const ownRecords = allRecords.filter(
        (record) => record.flowId === toolCall.interactionId,
      );
      const records =
        ownRecords.length > 0
          ? ownRecords
          : allRecords.filter((record) => !record.flowId);
      const runActive = isWorkflowRunActive(
        parentConversationId,
        toolCall.interactionId,
      );
      // run 级进度：存在未完成的 run 且当前没有活跃 runner（应用重启/
      // 失败/中断）时，可继续执行跳过已完成节点。仅当工具仍挂起（未结算，
      // 执行按钮可用）时展示"继续执行"，避免结算后出现误导性提示。
      let resume: {
        resumeIndex: number;
        handoff: string;
        tokens: number;
      } | null = null;
      if (!runActive && pendingRef.current) {
        try {
          const run = await window.snow.getWorkflowRun(
            parentConversationId,
            toolCall.interactionId,
          );
          if (
            run &&
            run.runStatus !== "completed" &&
            run.currentNodeIndex > 0
          ) {
            resume = {
              resumeIndex: run.currentNodeIndex,
              handoff: run.lastHandoff,
              tokens: run.totalTokens,
            };
          }
        } catch {
          // 读取失败：不启用续跑，仅展示节点状态
        }
      }
      setResumeState(resume);
      if (records.length > 0) {
        setFlowNodes((current) =>
          current.map((flowNode) => {
            const record = records.find((item) => item.nodeId === flowNode.id);
            if (!record) {
              return flowNode;
            }
            const runStatus = (
              ["pending", "running", "completed", "failed"] as const
            ).includes(record.runStatus as NodeRunStatus)
              ? (record.runStatus as NodeRunStatus)
              : "pending";
            return {
              ...flowNode,
              data: {
                ...flowNode.data,
                node: {
                  ...flowNode.data.node,
                  runStatus:
                    !runActive && runStatus === "running"
                      ? "pending"
                      : runStatus,
                  errorMessage: record.errorMessage,
                  conversationId: record.conversationId,
                  handoffContent: record.handoffContent,
                },
              },
            };
          }),
        );
        if (runActive) {
          setRunnerStatus("running");
          runnerStatusRef.current = "running";
        } else {
          const anyCompleted = records.some((record) =>
            ["completed", "failed"].includes(record.runStatus),
          );
          if (anyCompleted && !pendingRef.current) {
            const hasRunning = records.some(
              (record) => record.runStatus === "running",
            );
            setRunnerStatus(hasRunning ? "running" : "completed");
            runnerStatusRef.current = hasRunning ? "running" : "completed";
          }
        }
      }
    } catch {
      // 恢复失败不影响展示
    }
  }, [parentConversationId, toolCall.interactionId]);

  // 订阅 Runner 事件更新节点运行状态（按 interactionId 隔离，多 flow 互不串扰）。
  useEffect(() => {
    const unsubscribe = subscribeWorkflowRunner(
      parentConversationId,
      toolCall.interactionId,
      (detail) => {
        setRunnerStatus(detail.status);
        runnerStatusRef.current = detail.status;
        const { nodeId } = detail;
        if (nodeId) {
          // 节点自身状态优先：节点完成时整体仍在 running，靠 nodeStatus
          // 即时把该节点从 loading 切到完成/失败，无需切出再切回。
          const nodeRunStatus: NodeRunStatus = detail.nodeStatus
            ? detail.nodeStatus
            : detail.status === "completed"
              ? "completed"
              : detail.status === "failed"
                ? "failed"
                : "running";
          setFlowNodes((current) =>
            current.map((flowNode) => {
              if (flowNode.id !== nodeId) {
                return flowNode;
              }
              return {
                ...flowNode,
                data: {
                  ...flowNode.data,
                  node: {
                    ...flowNode.data.node,
                    runStatus: nodeRunStatus,
                    conversationId:
                      detail.conversationId ||
                      flowNode.data.node.conversationId,
                    errorMessage:
                      detail.error || flowNode.data.node.errorMessage,
                  },
                },
              };
            }),
          );
        }
      },
    );
    return unsubscribe;
  }, [parentConversationId, toolCall.interactionId]);

  // 工具挂起就绪通知：注册表建立后刷新交互状态（重置为等待用户操作）。
  // 仅处理属于当前会话与当前工具调用的就绪事件，避免跨会话串扰。
  useEffect(() => {
    const unsubscribe = subscribeWorkflowReady((detail) => {
      if (
        detail.parentConversationId !== parentConversationId ||
        detail.interactionId !== toolCall.interactionId
      ) {
        return;
      }
      setRunnerStatus("idle");
      runnerStatusRef.current = "idle";
      setHasReplied(false);
    });
    return unsubscribe;
  }, [parentConversationId, toolCall.interactionId]);

  // 连线动画只取决于节点运行状态；用状态摘要做 memo 依赖（而非 flowNodes
  // 引用），拖拽逐帧更新节点时连线数组保持稳定。
  const runStatusKey = flowNodes
    .map((flowNode) => `${flowNode.id}:${flowNode.data.node.runStatus}`)
    .join("|");
  const flowEdges: Edge[] = useMemo(
    () =>
      edges
        .filter(
          (edge) =>
            flowNodesRef.current.some(
              (flowNode) => flowNode.id === edge.source,
            ) &&
            flowNodesRef.current.some(
              (flowNode) => flowNode.id === edge.target,
            ),
        )
        .map((edge) => ({
          id: buildEdgeId(edge),
          source: edge.source,
          target: edge.target,
          animated:
            flowNodesRef.current.find((flowNode) => flowNode.id === edge.source)
              ?.data.node.runStatus === "completed" ||
            flowNodesRef.current.find((flowNode) => flowNode.id === edge.target)
              ?.data.node.runStatus === "running",
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges, runStatusKey],
  );

  // 画布定制持久化：防抖整体写回 DB（拖拽/连线/输入逐帧变化时只落最后一次）。
  // 运行态字段变化也会触发本 effect，但写入内容已剥离运行态字段，幂等无害；
  // interactionId 缺失时不写（无法定位存储键）。DB 替代旧版 localStorage：
  // 无 5MB 容量限制、随会话归档/导出、跨重启持久。
  useEffect(() => {
    if (!toolCall.interactionId) {
      return;
    }
    const timer = window.setTimeout(() => {
      const payload: PersistedCanvasPayload = {
        version: 1,
        nodes: flowNodes.map((flowNode) => ({
          id: flowNode.id,
          name: flowNode.data.node.name,
          label: flowNode.data.node.label,
          prompt: flowNode.data.node.prompt,
          description: flowNode.data.node.description,
          apiProfile: flowNode.data.node.apiProfile,
          model: flowNode.data.node.model,
          position: { x: flowNode.position.x, y: flowNode.position.y },
        })),
        edges: edges.map((edge) => ({
          source: edge.source,
          target: edge.target,
        })),
      };
      void window.snow
        .upsertWorkflowCanvas(
          parentConversationId,
          toolCall.interactionId,
          JSON.stringify(payload),
        )
        .catch(() => {
          // DB 写入失败：静默降级，画布功能不受影响
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [flowNodes, edges, parentConversationId, toolCall.interactionId]);

  // 挂载后恢复流程串行化：先异步加载 DB 持久化的画布定制（节点集合取
  // 持久化节点、位置与边），再恢复节点运行态。两个恢复源不能并发——画布
  // 恢复用 toFlowNode 构造节点会把 runStatus 重置为 pending，若与
  // restoreRuns 并发且晚完成，会覆盖掉已恢复的完成/失败状态（表现为切换
  // 会话后节点 icon 丢失）。串行保证 restoreRuns 是最后的写入者，节点
  // 运行态必然收敛正确。DB 是异步 API，因此放在 effect 中。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 第一步：画布定制恢复（interactionId 缺失时跳过，保持 args 基线）。
      if (toolCall.interactionId) {
        try {
          const record = await window.snow.getWorkflowCanvas(
            parentConversationId,
            toolCall.interactionId,
          );
          if (!cancelled && record) {
            const persisted = parseCanvasPayload(record.canvasJson);
            if (persisted) {
              const parsedNodeById = new Map(
                graph.nodes.map((node) => [node.id, node] as const),
              );
              const restoredNodes = persisted.nodes.map(
                (persistedNode, index) => {
                  const base = parsedNodeById.get(persistedNode.id);
                  return toFlowNode(
                    {
                      id: persistedNode.id,
                      name: persistedNode.name ?? base?.name ?? "",
                      label:
                        persistedNode.label ?? base?.label ?? base?.name ?? "",
                      prompt: persistedNode.prompt ?? base?.prompt ?? "",
                      description:
                        persistedNode.description ?? base?.description ?? "",
                      apiProfile:
                        persistedNode.apiProfile ?? base?.apiProfile ?? "",
                      model: persistedNode.model ?? base?.model ?? "",
                    },
                    persistedNode.position ?? defaultNodePosition(index),
                  );
                },
              );
              const nodeIdSet = new Set(restoredNodes.map((node) => node.id));
              const seenEdgeIds = new Set<string>();
              const restoredEdges = persisted.edges.filter((edge) => {
                if (
                  edge.source === edge.target ||
                  !nodeIdSet.has(edge.source) ||
                  !nodeIdSet.has(edge.target)
                ) {
                  return false;
                }
                const edgeId = buildEdgeId(edge);
                if (seenEdgeIds.has(edgeId)) {
                  return false;
                }
                seenEdgeIds.add(edgeId);
                return true;
              });
              setFlowNodes(restoredNodes);
              setEdges(restoredEdges);
            }
          }
        } catch {
          // DB 读取失败：保持 args 解析基线
        }
      }
      // 第二步：画布落地后恢复节点运行态（最后的写入者，icon 状态必正确）。
      if (!cancelled) {
        await restoreRuns();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentConversationId, toolCall.interactionId, restoreRuns]);

  const openCanvasContextMenu = useCallback(
    (
      event: React.MouseEvent | MouseEvent,
      nodeId: string | null,
      // 右键命中的连线 id（确定性边 id）；节点/画布右键时保持 null。
      edgeId: string | null = null,
    ): void => {
      event.preventDefault();
      if (runnerStatusRef.current === "running" || !pendingRef.current) {
        return;
      }
      const rect = canvasWrapRef.current?.getBoundingClientRect();
      setContextMenu({
        x: rect ? event.clientX - rect.left : 0,
        y: rect ? event.clientY - rect.top : 0,
        clientX: event.clientX,
        clientY: event.clientY,
        nodeId,
        edgeId,
      });
    },
    [],
  );

  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: WorkflowFlowNode): void => {
      openCanvasContextMenu(event, node.id);
    },
    [openCanvasContextMenu],
  );

  // 连线右键：与节点右键共用浮层定位，菜单项按 edgeId 区分。
  const handleEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge): void => {
      openCanvasContextMenu(event, null, edge.id);
    },
    [openCanvasContextMenu],
  );

  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: WorkflowFlowNode): void => {
      setContextMenu(null);
      const target = flowNodesRef.current.find(
        (flowNode) => flowNode.id === node.id,
      );
      if (target?.data.node.conversationId) {
        // 跳到节点会话：刷新会话列表后选中（节点状态/结果在会话中查看）。
        void refreshConversations();
        handleSelectConversation(target.data.node.conversationId);
      }
    },
    [handleSelectConversation, refreshConversations],
  );

  // 在画布内打开节点编辑浮层（锚点按画布尺寸收拢，防止溢出）。
  const openNodeEditor = useCallback(
    (nodeId: string, at?: { x: number; y: number }): void => {
      const wrap = canvasWrapRef.current;
      let x = at?.x ?? 16;
      let y = at?.y ?? 16;
      if (wrap) {
        x = Math.min(Math.max(8, x), Math.max(8, wrap.clientWidth - 296));
        y = Math.min(Math.max(8, y), Math.max(8, wrap.clientHeight - 320));
      }
      setEditorAnchor({ x, y });
      setEditingNodeId(nodeId);
      setContextMenu(null);
    },
    [],
  );

  const handleAddNode = useCallback(
    (menu: CanvasContextMenu): void => {
      const flowPosition = screenToFlowPosition({
        x: menu.clientX,
        y: menu.clientY,
      });
      const newNodeId = `wf-node-${Date.now().toString(36)}-${Math.floor(
        Math.random() * 10000,
      )}`;
      const label = t("toolCall.workflow.newNodeName");
      const newNode: WorkflowNodeItem = {
        id: newNodeId,
        name: label,
        label,
        prompt: "",
        description: "",
        apiProfile: "",
        model: "",
        runStatus: "pending",
        errorMessage: "",
        conversationId: "",
        handoffContent: "",
      };
      setFlowNodes((current) => [
        ...current,
        {
          id: newNodeId,
          type: "workflowCard",
          position: flowPosition,
          data: { node: newNode },
        },
      ]);
      openNodeEditor(newNodeId, { x: menu.x, y: menu.y });
    },
    [openNodeEditor, screenToFlowPosition, t],
  );

  const handleDeleteNode = useCallback((nodeId: string): void => {
    setFlowNodes((current) =>
      current.filter((flowNode) => flowNode.id !== nodeId),
    );
    setEdges((current) =>
      current.filter(
        (edge) => edge.source !== nodeId && edge.target !== nodeId,
      ),
    );
    setEditingNodeId((current) => (current === nodeId ? null : current));
    setContextMenu(null);
  }, []);

  const handleDeleteEdge = useCallback((edgeId: string): void => {
    // 按确定性 id 过滤：与 flowEdges 派生 id、右键命中的 edge.id 严格对齐。
    setEdges((current) =>
      current.filter((edge) => buildEdgeId(edge) !== edgeId),
    );
    setContextMenu(null);
  }, []);

  // 连线合法性统一入口（handleConnect 与 isValidConnection 同源复用）：
  // 端点非空、非自环、不与现有边重复、加边不成环（wouldCreateCycle）。
  const isConnectionAllowed = useCallback(
    (
      source: string | null | undefined,
      target: string | null | undefined,
    ): boolean => {
      if (!source || !target) {
        return false;
      }
      if (
        edgesRef.current.some(
          (edge) => edge.source === source && edge.target === target,
        )
      ) {
        return false;
      }
      return !wouldCreateCycle(edgesRef.current, source, target);
    },
    [],
  );

  // 拖拽连线完成：校验通过后写入 edges state。runner 按 edges 做拓扑排序
  // 消费，新边自动参与执行顺序，无需额外同步。
  const handleConnect = useCallback(
    (connection: Connection): void => {
      const { source, target } = connection;
      if (!source || !target || !canEditCanvasRef.current) {
        return;
      }
      if (!isConnectionAllowed(source, target)) {
        return;
      }
      setEdges((current) => [...current, { source, target }]);
    },
    [isConnectionAllowed],
  );

  // 拖拽过程中的即时可连性反馈（v12 签名：Edge | Connection）。
  const handleIsValidConnection = useCallback(
    (edge: Edge | Connection): boolean =>
      isConnectionAllowed(edge.source, edge.target),
    [isConnectionAllowed],
  );

  // React Flow 内置删除路径（键盘 Backspace 删选中等）通过 onEdgesChange
  // 下发 remove change：按确定性 id 同步清理 edges state 兜底。不可编辑
  // （运行中/已结算）时忽略 remove change，与 handleNodesChange 的节点
  // remove 过滤同一口径——否则键盘删除选中节点时节点 remove change 被
  // 过滤保留，而相连边会被级联 remove，出现「节点在、边被删」的不一致。
  const handleEdgesChange = useCallback((changes: EdgeChange[]): void => {
    if (!canEditCanvasRef.current) {
      return;
    }
    const removedIds = new Set(
      changes
        .filter((change) => change.type === "remove")
        .map((change) => change.id),
    );
    if (removedIds.size === 0) {
      return;
    }
    setEdges((current) =>
      current.filter((edge) => !removedIds.has(buildEdgeId(edge))),
    );
  }, []);

  // 包装节点变更：键盘删除选中节点（默认 Backspace）时同步清掉引用这些
  // 节点的边，避免死边留在 state（并随之进入持久化数据）；canEditCanvas
  // 为 false 时过滤 remove change 防运行中误删，其余 change（拖拽/
  // select/dimensions）照常透传，不影响受控拖拽逐帧更新。
  const handleNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]): void => {
      const next = canEditCanvasRef.current
        ? changes
        : changes.filter((change) => change.type !== "remove");
      const removedIds = new Set(
        next
          .filter((change) => change.type === "remove")
          .map((change) => change.id),
      );
      if (removedIds.size > 0) {
        setEdges((current) =>
          current.filter(
            (edge) =>
              !removedIds.has(edge.source) && !removedIds.has(edge.target),
          ),
        );
      }
      onFlowNodesChange(next);
    },
    [onFlowNodesChange],
  );

  const editingNode =
    flowNodes.find((flowNode) => flowNode.id === editingNodeId)?.data.node ??
    null;

  const updateEditingNode = useCallback(
    (patch: Partial<WorkflowNodeItem>): void => {
      if (!editingNodeId) {
        return;
      }
      // 配置编辑只影响节点配置本身（图结构通过画布右键菜单维护）。
      setFlowNodes((current) =>
        current.map((flowNode) =>
          flowNode.id === editingNodeId
            ? {
                ...flowNode,
                data: {
                  ...flowNode.data,
                  node: { ...flowNode.data.node, ...patch },
                },
              }
            : flowNode,
        ),
      );
    },
    [editingNodeId],
  );

  // 编辑浮层选中配置变化时拉取该配置的模型目录（generation 防竞态，
  // 与子代理编辑器同一模式）。
  useEffect(() => {
    const generation = modelCatalogGenerationRef.current + 1;
    modelCatalogGenerationRef.current = generation;
    setModelOptions([]);
    setModelCatalogError("");

    const profileName = editingNode?.apiProfile.trim() ?? "";
    if (!profileName) {
      setIsModelCatalogLoading(false);
      return;
    }
    const apiConfig = apiConfigs.find(
      (config) => config.profileName === profileName,
    );
    if (!apiConfig) {
      setIsModelCatalogLoading(false);
      return;
    }

    setIsModelCatalogLoading(true);
    void window.snow
      .fetchAvailableModelsForConfig({
        baseUrl: apiConfig.baseUrl,
        baseUrlMode: apiConfig.baseUrlMode,
        apiKey: apiConfig.apiKey,
        requestMethod: apiConfig.requestMethod,
        customHeaderSchemeId: apiConfig.customHeaderSchemeId,
      })
      .then((models) => {
        if (modelCatalogGenerationRef.current === generation) {
          setModelOptions(models);
        }
      })
      .catch((modelError: unknown) => {
        if (modelCatalogGenerationRef.current === generation) {
          setModelCatalogError(
            modelError instanceof Error
              ? modelError.message
              : t("toolCall.workflow.modelsLoadError", {
                  defaultValue: "Failed to load models for this API profile",
                }),
          );
        }
      })
      .finally(() => {
        if (modelCatalogGenerationRef.current === generation) {
          setIsModelCatalogLoading(false);
        }
      });
  }, [apiConfigs, editingNode?.apiProfile, t]);

  // API 配置下拉：默认"跟随会话配置"；已存配置不可用时保留原值并标记。
  const editingApiProfileOptions = useMemo(() => {
    const currentProfile = editingNode?.apiProfile.trim() ?? "";
    return [
      {
        value: "",
        label: t("toolCall.workflow.followSession", {
          defaultValue: "Follow the parent conversation",
        }),
      },
      ...(currentProfile &&
      !apiConfigs.some((config) => config.profileName === currentProfile)
        ? [
            {
              value: currentProfile,
              label: `${currentProfile} · ${t(
                "toolCall.workflow.profileUnavailable",
                { defaultValue: "No longer available" },
              )}`,
            },
          ]
        : []),
      ...apiConfigs.map((config) => ({
        value: config.profileName,
        label: `${config.displayName || config.profileName} · ${
          config.advancedModel
        }`,
      })),
    ];
  }, [apiConfigs, editingNode?.apiProfile, t]);

  // 模型下拉候选 = 配置高级模型 + 远端目录 + 已存值（去重）。
  const editingModelOptions = useMemo(() => {
    const selectedApiConfig = apiConfigs.find(
      (config) => config.profileName === editingNode?.apiProfile,
    );
    const availableModelIds = Array.from(
      new Set(
        [
          selectedApiConfig?.advancedModel,
          editingNode?.model,
          ...modelOptions.map((model) => model.id),
        ].filter((modelId): modelId is string => Boolean(modelId?.trim())),
      ),
    );
    return availableModelIds.map((modelId) => ({
      value: modelId,
      label: modelId,
    }));
  }, [apiConfigs, editingNode?.apiProfile, editingNode?.model, modelOptions]);

  const handleExecute = useCallback((): void => {
    if (runnerStatusRef.current === "running" || !pendingRef.current) {
      return;
    }
    const workableNodes = flowNodesRef.current
      .map((flowNode) => flowNode.data.node)
      .filter((node) => node.id && node.prompt.trim());
    if (workableNodes.length === 0 || !parentConversationId) {
      return;
    }
    // 执行器由主会话处理 workflow-generate 工具调用时注册（持有新鲜的
    // 会话上下文与授权入口）；不可用时（应用重启等）直接结算失败。
    const executor = getWorkflowRunner(
      parentConversationId,
      toolCall.interactionId,
    );
    if (!executor) {
      pendingRef.current = false;
      settleWorkflow(
        toolCall.interactionId,
        JSON.stringify({
          success: false,
          error:
            "Workflow executor is no longer available. Ask the AI to regenerate the workflow and run it again.",
        }),
      );
      return;
    }
    // 进入执行即锁定：立即置为 running，防止异步解析目录期间重复点击
    // （并发 runner 会造成节点会话重复创建与消息连发）。
    runnerStatusRef.current = "running";
    setRunnerStatus("running");
    setContextMenu(null);
    const executeRun = async (): Promise<void> => {
      // 优先从会话记录解析目录（历史消息中的 tool call 可能不属于当前活动会话）。
      // 空节点配置跟随会话自身的 API 配置/模型（会话可独立更改配置），
      // 而非全局 active 配置；会话也未设置时由 Rust 端回落全局默认。
      const record = await window.snow
        .getChatConversation(parentConversationId)
        .catch(() => null);
      const targetDirectoryId = record?.directoryId ?? directoryId;
      const outcome = await executor.runWorkflow({
        parentConversationId,
        interactionId: toolCall.interactionId,
        directoryId: targetDirectoryId,
        sessionApiProfile: record?.apiProfileName ?? "",
        sessionModel: record?.model ?? "",
        nodes: workableNodes,
        edges,
        onNodeConversationCreated: () => {
          // 节点会话写入 DB 后立即刷新侧边栏会话列表。
          void refreshConversations();
        },
      });
      settleWorkflow(
        toolCall.interactionId,
        JSON.stringify({
          success: outcome.success,
          summary: outcome.summary,
          ...(outcome.totalTokens ? { totalTokens: outcome.totalTokens } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        }),
      );
    };
    void executeRun();
  }, [
    parentConversationId,
    directoryId,
    edges,
    refreshConversations,
    toolCall.interactionId,
  ]);

  const handleReply = useCallback((): void => {
    const text = userReply.trim();
    if (!text || !pendingRef.current || runnerStatusRef.current === "running") {
      return;
    }
    pendingRef.current = false;
    setHasReplied(true);
    setSubmittedReply(text);
    settleWorkflow(
      toolCall.interactionId,
      JSON.stringify({
        userResponse: text,
      }),
    );
  }, [userReply, toolCall.interactionId]);

  const isWaitingUser = pendingRef.current && runnerStatus === "idle";
  const isRunning = runnerStatus === "running";
  const isInteractive = isWaitingUser && !hasReplied;
  // 空图（JSON 截断/解析失败/节点被删光）时收掉画布与执行区，
  // 只保留轻提示 + 反馈入口（反馈是挂起工具的结算出口）。
  const hasCanvas = flowNodes.length > 0;

  return (
    <div className="tool-call-item tool-call-workflow">
      <div className="tool-call-header">
        <ToolNameBadge name={t("toolCall.workflow.name")} category="agent" />
        {isRunning ? (
          <Loader2
            className="tool-call-icon-spinning"
            size={14}
            aria-hidden="true"
          />
        ) : runnerStatus === "completed" ? (
          <Check size={14} aria-hidden="true" />
        ) : runnerStatus === "failed" ? (
          <CircleX size={14} aria-hidden="true" />
        ) : (
          <Workflow size={14} aria-hidden="true" />
        )}
        <span className="tool-call-name">{t("toolCall.workflow.action")}</span>
        <span
          className={`tool-call-status tool-call-status-${
            isRunning
              ? "running"
              : runnerStatus === "completed"
                ? "completed"
                : runnerStatus === "failed"
                  ? "error"
                  : "pending"
          }`}
          role="status"
          aria-live="polite"
        >
          {isRunning
            ? t("toolCall.workflow.status.running")
            : runnerStatus === "completed"
              ? t("toolCall.workflow.status.completed")
              : runnerStatus === "failed"
                ? t("toolCall.workflow.status.failed")
                : t("toolCall.workflow.status.idle")}
        </span>
      </div>

      <div className="tool-call-body tool-call-workflow-body">
        {graph.title && <div className="workflow-title">{graph.title}</div>}

        {!hasCanvas && (
          <div className="workflow-canvas-empty">
            {t("toolCall.workflow.emptyCanvas")}
          </div>
        )}
        {hasCanvas && (
          <div className="workflow-canvas-wrap" ref={canvasWrapRef}>
            <div className="workflow-canvas">
              {/* 仅挂起且未运行时开放连线，与右键编辑同一可编辑性口径。 */}
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={WORKFLOW_NODE_TYPES}
                onNodeContextMenu={handleNodeContextMenu}
                onPaneContextMenu={(event) =>
                  openCanvasContextMenu(event, null)
                }
                onPaneClick={() => setContextMenu(null)}
                onMoveStart={() => setContextMenu(null)}
                onNodeClick={handleNodeClick}
                onEdgeContextMenu={handleEdgeContextMenu}
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
                onConnect={handleConnect}
                isValidConnection={handleIsValidConnection}
                fitView
                nodesConnectable={canEditCanvas}
                nodesDraggable
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={16} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>

            {contextMenu && canEditCanvas && (
              <div
                className="workflow-context-menu"
                style={{ left: contextMenu.x, top: contextMenu.y }}
              >
                {contextMenu.edgeId ? (
                  <button
                    type="button"
                    onClick={() => handleDeleteEdge(contextMenu.edgeId ?? "")}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    <span>{t("toolCall.workflow.deleteEdge")}</span>
                  </button>
                ) : contextMenu.nodeId ? (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        openNodeEditor(contextMenu.nodeId ?? "", {
                          x: contextMenu.x,
                          y: contextMenu.y,
                        })
                      }
                    >
                      <Pencil size={13} aria-hidden="true" />
                      <span>{t("toolCall.workflow.editNode")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteNode(contextMenu.nodeId ?? "")}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      <span>{t("toolCall.workflow.deleteNode")}</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleAddNode(contextMenu)}
                  >
                    <Plus size={13} aria-hidden="true" />
                    <span>{t("toolCall.workflow.addNode")}</span>
                  </button>
                )}
              </div>
            )}

            {editingNode && canEditCanvas && (
              <div
                className="workflow-editor workflow-editor-overlay"
                style={{ left: editorAnchor.x, top: editorAnchor.y }}
              >
                <div className="workflow-editor-header">
                  <span>
                    <Pencil size={13} aria-hidden="true" />
                    {editingNode.label || editingNode.id}
                  </span>
                  <button
                    type="button"
                    className="workflow-editor-close"
                    onClick={() => setEditingNodeId(null)}
                    aria-label={t("toolCall.workflow.closeEditor")}
                  >
                    <CircleX size={14} aria-hidden="true" />
                  </button>
                </div>
                <label className="workflow-editor-field">
                  <span>{t("toolCall.workflow.nodeName")}</span>
                  <input
                    type="text"
                    value={editingNode.label}
                    disabled={isRunning}
                    onChange={(event) =>
                      updateEditingNode({ label: event.target.value })
                    }
                  />
                </label>
                <label className="workflow-editor-field">
                  <span>{t("toolCall.workflow.nodeApiProfile")}</span>
                  <CustomSelect
                    value={editingNode.apiProfile}
                    options={editingApiProfileOptions}
                    onChange={(value) =>
                      updateEditingNode({
                        apiProfile: value,
                        model:
                          apiConfigs.find(
                            (config) => config.profileName === value,
                          )?.advancedModel ?? "",
                      })
                    }
                    disabled={isRunning}
                  />
                </label>
                {editingNode.apiProfile ? (
                  <label className="workflow-editor-field">
                    <span>{t("toolCall.workflow.nodeModel")}</span>
                    <CustomSelect
                      value={
                        editingNode.model ||
                        apiConfigs.find(
                          (config) =>
                            config.profileName === editingNode.apiProfile,
                        )?.advancedModel ||
                        ""
                      }
                      options={editingModelOptions}
                      onChange={(value) => updateEditingNode({ model: value })}
                      disabled={isRunning || isModelCatalogLoading}
                    />
                    {isModelCatalogLoading ? (
                      <small className="workflow-editor-hint">
                        {t("toolCall.workflow.modelsLoading", {
                          defaultValue: "Loading models...",
                        })}
                      </small>
                    ) : null}
                    {modelCatalogError ? (
                      <small className="workflow-editor-hint">
                        {modelCatalogError}
                      </small>
                    ) : null}
                  </label>
                ) : null}
                <label className="workflow-editor-field">
                  <span>{t("toolCall.workflow.nodePrompt")}</span>
                  <textarea
                    rows={6}
                    value={editingNode.prompt}
                    disabled={isRunning}
                    onChange={(event) =>
                      updateEditingNode({ prompt: event.target.value })
                    }
                  />
                </label>
                <div className="workflow-editor-footer">
                  <button
                    type="button"
                    className="tool-call-plan-approval-continue"
                    onClick={() => setEditingNodeId(null)}
                  >
                    <Check size={13} aria-hidden="true" />
                    <span>{t("toolCall.workflow.done")}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {hasCanvas && (
          <div className="workflow-actions">
            {/* 执行按钮只在待确认时出现：提交反馈或执行后进入终态即隐藏。
                存在未完成的 workflow_runs 进度（应用重启/失败/中断）时，
                按钮变为"继续执行"，runner 自动跳过已完成节点。 */}
            {isInteractive ? (
              <button
                type="button"
                className="tool-call-plan-approval-continue"
                onClick={() => handleExecute()}
              >
                <Play size={14} aria-hidden="true" />
                <span>
                  {resumeState
                    ? t("toolCall.workflow.resume")
                    : t("toolCall.workflow.execute")}
                </span>
              </button>
            ) : null}
            {isRunning ? (
              <span className="workflow-execute-hint">
                {t("toolCall.workflow.runningHint")}
              </span>
            ) : runnerStatus === "completed" ? (
              <span className="workflow-execute-hint">
                {t("toolCall.workflow.completedHint")}
              </span>
            ) : resumeState ? (
              <span className="workflow-execute-hint">
                {t("toolCall.workflow.resumedHint")}
              </span>
            ) : hasReplied ? (
              <span className="workflow-execute-hint">
                {t("toolCall.workflow.repliedHint")}
              </span>
            ) : (
              <span className="workflow-execute-hint">
                {t("toolCall.workflow.idleHint")}
              </span>
            )}
          </div>
        )}

        {isInteractive && (
          <div className="workflow-reply">
            <span className="workflow-reply-label">
              {t("toolCall.workflow.replyLabel")}
            </span>
            <textarea
              rows={2}
              value={userReply}
              onChange={(event) => setUserReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleReply();
                }
              }}
              placeholder={t("toolCall.workflow.replyPlaceholder")}
            />
            <button
              type="button"
              className="tool-call-plan-approval-approve"
              onClick={() => handleReply()}
              disabled={!userReply.trim()}
            >
              <Send size={13} aria-hidden="true" />
              <span>{t("toolCall.workflow.replySubmit")}</span>
            </button>
          </div>
        )}

        {hasReplied && submittedReply ? (
          <div className="workflow-reply-record">
            <span className="workflow-reply-record-label">
              {t("toolCall.workflow.repliedFeedback")}
            </span>
            <p className="workflow-reply-record-content">{submittedReply}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const WorkflowToolCall = (
  props: WorkflowToolCallProps,
): React.JSX.Element => (
  <ReactFlowProvider>
    <WorkflowToolCallInner {...props} />
  </ReactFlowProvider>
);
