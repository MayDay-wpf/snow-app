import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Ban,
  Check,
  CircleX,
  Clock,
  Hourglass,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { useI18n } from "../../../i18n";
import { isSubmitEnter } from "../../../../shared/imeKeyboard";
import type {
  ApiConfigRecord,
  Model,
  ScheduledTaskWorkflow,
  ScheduledTaskWorkflowEdge,
  ScheduledTaskWorkflowNode,
  ScheduledTaskWorkflowNodeState,
  ScheduledTaskWorkflowRun,
} from "../../../../preload";
import { CustomSelect } from "../../common/CustomSelect";
import { Tooltip } from "../../common/Tooltip";
import { ApiModelCombobox } from "../apiSettings/ApiModelCombobox";

type Translate = ReturnType<typeof useI18n>["t"];

export type ScheduledTaskWorkflowCanvasHandle = {
  /** 关闭画布内浮层；有浮层被关闭时返回 true（供 Esc 优先处理）。 */
  closeOverlay: () => boolean;
};

type ScheduledTaskWorkflowCanvasProps = {
  value: ScheduledTaskWorkflow;
  onChange?: (next: ScheduledTaskWorkflow) => void;
  apiConfigs: ApiConfigRecord[];
  /** 运行状态（详情页展示）。 */
  run?: ScheduledTaskWorkflowRun;
  readOnly?: boolean;
  /** 点击带会话的节点时打开会话。 */
  onOpenConversation?: (conversationId: string) => void;
  /** 画布用途：scheduled = 定时任务画布（默认，含连线延时编辑与展示）；
   *  chat = 聊天输入区手动编排器（隐藏定时任务专属 UI：连线延时入口与展示，
   *  延时恒为 0）。节点增删改、连线与环校验、节点编辑浮层保持一致。 */
  variant?: "scheduled" | "chat";
};

type DelayUnit = "seconds" | "minutes" | "hours" | "days";

const UNIT_MS: Record<DelayUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** 选最大可整除单位。 */
const splitDelay = (ms: number): { value: number; unit: DelayUnit } => {
  for (const unit of ["days", "hours", "minutes"] as DelayUnit[]) {
    if (ms > 0 && ms % UNIT_MS[unit] === 0) {
      return { value: ms / UNIT_MS[unit], unit };
    }
  }
  return { value: Math.round(ms / 1_000), unit: "seconds" };
};

export const formatWorkflowDelay = (ms: number, t: Translate): string => {
  if (!ms) {
    return t("scheduledTask.workflow.delayNone", { defaultValue: "No delay" });
  }
  const { value, unit } = splitDelay(ms);
  return t(`scheduledTask.workflow.delay.${unit}`, {
    values: { value },
    defaultValue: `${value} ${unit}`,
  });
};

const createNodeId = (): string =>
  `stn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const edgeKey = (edge: { source: string; target: string }): string =>
  `${edge.source}->${edge.target}`;

/** 加边是否成环（含自环）。 */
const wouldCreateCycle = (
  edges: ScheduledTaskWorkflowEdge[],
  source: string,
  target: string,
): boolean => {
  if (source === target) return true;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.source, [
      ...(adjacency.get(edge.source) ?? []),
      edge.target,
    ]);
  }
  const queue = [target];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === source) return true;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// 节点与连线渲染
// ---------------------------------------------------------------------------

type CardData = {
  node: ScheduledTaskWorkflowNode;
  state?: ScheduledTaskWorkflowNodeState;
  statusText?: string;
  isStart: boolean;
  startLabel: string;
  /** 提示词为空时的编辑引导（只读不传）。 */
  editHint?: string;
  /** 只读时悬停显示节点详情。 */
  readOnly: boolean;
  /** 节点 API 配置的展示名。 */
  profileLabel?: string;
};

type CardNode = Node<CardData>;

const StatusIcon = ({
  status,
}: {
  status?: ScheduledTaskWorkflowNodeState["status"];
}): React.JSX.Element | null => {
  switch (status) {
    case "running":
      return (
        <span className="spin-layer">
          <Loader2 size={13} />
        </span>
      );
    case "completed":
      return <Check size={13} className="workflow-node-icon-completed" />;
    case "failed":
      return <CircleX size={13} className="workflow-node-icon-failed" />;
    case "scheduled":
      return <Hourglass size={13} className="st-workflow-icon-muted" />;
    case "cancelled":
      return <Ban size={13} className="st-workflow-icon-muted" />;
    default:
      return null;
  }
};

const WorkflowCardTip = ({ data }: { data: CardData }): React.JSX.Element => {
  const { t } = useI18n();
  const { node, state, statusText, profileLabel } = data;
  return (
    <div className="st-workflow-node-tip">
      <div className="st-workflow-node-tip-title">
        <span>{node.label}</span>
        {statusText && (
          <span className="st-workflow-node-tip-status">
            <StatusIcon status={state?.status} />
            {statusText}
          </span>
        )}
      </div>
      <div className="st-workflow-node-tip-field">
        <span className="st-workflow-node-tip-label">
          {t("scheduledTask.workflow.nodePrompt", { defaultValue: "Prompt" })}
        </span>
        <div className="st-workflow-node-tip-prompt">{node.prompt}</div>
      </div>
      <div className="st-workflow-node-tip-field">
        <span className="st-workflow-node-tip-label">
          {t("scheduledTask.apiProfile", { defaultValue: "API config" })}
        </span>
        <span>
          {profileLabel ??
            t("scheduledTask.workflow.inheritTaskConfig", {
              defaultValue: "Inherit task run config",
            })}
        </span>
      </div>
      {node.model && (
        <div className="st-workflow-node-tip-field">
          <span className="st-workflow-node-tip-label">
            {t("scheduledTask.advancedModel", {
              defaultValue: "Advanced model",
            })}
          </span>
          <span>{node.model}</span>
        </div>
      )}
      {state?.error && (
        <div className="st-workflow-node-tip-error">{state.error}</div>
      )}
      {state?.conversationId && (
        <div className="st-workflow-node-tip-hint">
          {t("scheduledTask.workflow.openConversationHint", {
            defaultValue: "Click to open the node conversation",
          })}
        </div>
      )}
    </div>
  );
};

const WorkflowCard = memo(function WorkflowCard({
  data,
  selected,
}: NodeProps<CardNode>): React.JSX.Element {
  const { node, state, statusText, isStart, startLabel, editHint, readOnly } =
    data;
  const card = (
    <div
      className={`workflow-node st-workflow-node${selected ? " is-selected" : ""}${
        state?.status === "running" ? " is-running" : ""
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="workflow-node-header">
        <span className="workflow-node-title">{node.label}</span>
        <StatusIcon status={state?.status} />
      </div>
      {node.prompt ? (
        <div className="workflow-node-description">{node.prompt}</div>
      ) : (
        editHint && <div className="st-workflow-node-hint">{editHint}</div>
      )}
      <div className="st-workflow-node-meta">
        {isStart && <span className="st-workflow-node-tag">{startLabel}</span>}
        {node.apiProfile && (
          <span className="st-workflow-node-tag">
            {node.model || node.apiProfile}
          </span>
        )}
        {statusText && (
          <span className="st-workflow-node-status">{statusText}</span>
        )}
      </div>
      {state?.status === "failed" && state.error && (
        <div className="workflow-node-error">{state.error}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
  return readOnly ? (
    <Tooltip content={<WorkflowCardTip data={data} />}>{card}</Tooltip>
  ) : (
    card
  );
});

type DelayEdgeData = {
  delayMs: number;
  label: string;
  readOnly: boolean;
  /** 是否展示延时标签（同时是延时编辑入口）：chat 变体隐藏。 */
  showDelay: boolean;
  onEdit: (edgeId: string, clientX: number, clientY: number) => void;
};

type DelayEdgeType = Edge<DelayEdgeData>;

const DelayEdge = memo(function DelayEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<DelayEdgeType>): React.JSX.Element {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {data?.showDelay && (
        <EdgeLabelRenderer>
          <button
            className={`st-workflow-edge-label nodrag nopan${
              data?.delayMs ? " has-delay" : ""
            }`}
            disabled={data?.readOnly}
            onClick={(event) => {
              event.stopPropagation();
              data?.onEdit(id, event.clientX, event.clientY);
            }}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            type="button"
          >
            <Timer size={11} />
            <span>{data?.label}</span>
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

// 必须定义在组件外，避免每次渲染重建导致节点重挂载
const NODE_TYPES = { stWorkflowCard: WorkflowCard };
const EDGE_TYPES = { stDelay: DelayEdge };

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

type ContextMenuState = {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  nodeId: string | null;
  edgeId: string | null;
};

type Anchor = { x: number; y: number };

type CanvasInnerProps = ScheduledTaskWorkflowCanvasProps & {
  expanded: boolean;
  onToggleExpand: () => void;
};

const CanvasInner = forwardRef<
  ScheduledTaskWorkflowCanvasHandle,
  CanvasInnerProps
>(function CanvasInner(
  {
    value,
    onChange,
    apiConfigs,
    run,
    readOnly = false,
    onOpenConversation,
    variant = "scheduled",
    expanded,
    onToggleExpand,
  },
  ref,
): React.JSX.Element {
  const { locale, t } = useI18n();
  /** chat 变体（输入区手动编排器）：隐藏定时任务专属 UI。 */
  const isChatVariant = variant === "chat";
  const { screenToFlowPosition } = useReactFlow();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // 画布获得焦点（点击过内部）后才响应滚轮缩放，避免干扰页面滚动
  const [focused, setFocused] = useState(false);
  const wheelActive = expanded || focused;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const wrap = wrapRef.current;
      setFocused(
        !!wrap && wrap.contains(event.target as globalThis.Node | null),
      );
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<Anchor>({ x: 12, y: 12 });
  const [delayDraft, setDelayDraft] = useState<{
    value: string;
    unit: DelayUnit;
  }>({ value: "0", unit: "minutes" });

  // 节点模型目录（按所选 API 配置拉取）
  const [models, setModels] = useState<Model[]>([]);
  const [modelsFor, setModelsFor] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelRequestRef = useRef(0);

  const emit = useCallback(
    (next: ScheduledTaskWorkflow): void => {
      if (!readOnly) onChange?.(next);
    },
    [onChange, readOnly],
  );

  useImperativeHandle(
    ref,
    () => ({
      closeOverlay: () => {
        if (menu || editingNodeId || editingEdgeId) {
          setMenu(null);
          setEditingNodeId(null);
          setEditingEdgeId(null);
          return true;
        }
        return false;
      },
    }),
    [editingEdgeId, editingNodeId, menu],
  );

  const placeOverlay = useCallback(
    (x: number, y: number, width: number, height: number): Anchor => {
      const wrap = wrapRef.current;
      if (!wrap) return { x, y };
      return {
        x: Math.min(Math.max(8, x), Math.max(8, wrap.clientWidth - width - 8)),
        y: Math.min(
          Math.max(8, y),
          Math.max(8, wrap.clientHeight - height - 8),
        ),
      };
    },
    [],
  );

  const toLocal = useCallback((clientX: number, clientY: number): Anchor => {
    const rect = wrapRef.current?.getBoundingClientRect();
    return rect
      ? { x: clientX - rect.left, y: clientY - rect.top }
      : { x: 12, y: 12 };
  }, []);

  // ---- 节点状态文案 ----
  const statusTextFor = useCallback(
    (state?: ScheduledTaskWorkflowNodeState): string | undefined => {
      if (!state) return undefined;
      if (state.status === "scheduled" && state.dueAt) {
        const due = Date.parse(state.dueAt);
        if (!Number.isNaN(due) && due > Date.now()) {
          const time = new Intl.DateTimeFormat(locale, {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(due));
          return t("scheduledTask.workflow.waitUntil", {
            values: { time },
            defaultValue: `Waiting until ${time}`,
          });
        }
      }
      return t(`scheduledTask.workflow.nodeStatus.${state.status}`, {
        defaultValue: state.status,
      });
    },
    [locale, t],
  );

  const startIds = useMemo(() => {
    const targets = new Set(value.edges.map((edge) => edge.target));
    return new Set(
      value.nodes.filter((node) => !targets.has(node.id)).map((n) => n.id),
    );
  }, [value.edges, value.nodes]);

  // 内部节点状态：拖拽逐帧本地更新，结束时回写位置
  const buildFlowNodes = useCallback(
    (prev: CardNode[]): CardNode[] => {
      const selected = new Set(
        prev.filter((item) => item.selected).map((item) => item.id),
      );
      return value.nodes.map((node) => {
        const state = run?.nodes[node.id];
        return {
          id: node.id,
          type: "stWorkflowCard",
          position: node.position,
          selected: selected.has(node.id),
          data: {
            node,
            state,
            statusText: statusTextFor(state),
            isStart: startIds.has(node.id),
            startLabel: t("scheduledTask.workflow.startTag", {
              defaultValue: "Start",
            }),
            editHint: readOnly
              ? undefined
              : t("scheduledTask.workflow.nodeEditHint", {
                  defaultValue: "Right-click or click to edit",
                }),
            readOnly,
            profileLabel: node.apiProfile
              ? apiConfigs
                  .find((config) => config.profileName === node.apiProfile)
                  ?.displayName.trim() || node.apiProfile
              : undefined,
          },
        };
      });
    },
    [apiConfigs, readOnly, run, startIds, statusTextFor, t, value.nodes],
  );

  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<CardNode>(
    buildFlowNodes([]),
  );

  useEffect(() => {
    setFlowNodes((prev) => buildFlowNodes(prev));
  }, [buildFlowNodes, setFlowNodes]);

  const openEdgeEditor = useCallback(
    (edgeId: string, clientX: number, clientY: number): void => {
      if (readOnly) return;
      const edge = valueRef.current.edges.find(
        (item) => `st-edge-${edgeKey(item)}` === edgeId,
      );
      if (!edge) return;
      const split = splitDelay(edge.delayMs);
      setDelayDraft({ value: String(split.value), unit: split.unit });
      const local = toLocal(clientX, clientY);
      setAnchor(placeOverlay(local.x, local.y, 240, 150));
      setEditingNodeId(null);
      setMenu(null);
      setEditingEdgeId(edgeId);
    },
    [placeOverlay, readOnly, toLocal],
  );

  const flowEdges: DelayEdgeType[] = useMemo(
    () =>
      value.edges.map((edge) => {
        const sourceState = run?.nodes[edge.source]?.status;
        const targetState = run?.nodes[edge.target]?.status;
        return {
          id: `st-edge-${edgeKey(edge)}`,
          source: edge.source,
          target: edge.target,
          type: "stDelay",
          markerEnd: { type: MarkerType.ArrowClosed },
          animated:
            sourceState === "completed" &&
            (targetState === "scheduled" || targetState === "running"),
          data: {
            delayMs: edge.delayMs,
            label: isChatVariant ? "" : formatWorkflowDelay(edge.delayMs, t),
            readOnly,
            showDelay: !isChatVariant,
            onEdit: openEdgeEditor,
          },
        };
      }),
    [isChatVariant, openEdgeEditor, readOnly, run, t, value.edges],
  );

  // ---- 编辑操作 ----
  // 只添加节点，不弹编辑框；工具栏连续添加时错开位置避免重叠
  const addNode = useCallback(
    (clientX?: number, clientY?: number): void => {
      const current = valueRef.current;
      const rect = wrapRef.current?.getBoundingClientRect();
      const offset = (current.nodes.length % 6) * 24;
      const position = screenToFlowPosition({
        x: clientX ?? (rect ? rect.left + rect.width / 2 - 80 + offset : 0),
        y: clientY ?? (rect ? rect.top + rect.height / 2 - 30 + offset : 0),
      });
      const id = createNodeId();
      const label = t("scheduledTask.workflow.newNodeName", {
        values: { index: current.nodes.length + 1 },
        defaultValue: `Step ${current.nodes.length + 1}`,
      });
      emit({
        ...current,
        nodes: [...current.nodes, { id, label, prompt: "", position }],
      });
      setMenu(null);
    },
    [emit, screenToFlowPosition, t],
  );

  const removeNodes = useCallback(
    (ids: string[]): void => {
      if (ids.length === 0) return;
      const current = valueRef.current;
      const set = new Set(ids);
      emit({
        ...current,
        nodes: current.nodes.filter((node) => !set.has(node.id)),
        edges: current.edges.filter(
          (edge) => !set.has(edge.source) && !set.has(edge.target),
        ),
      });
      setEditingNodeId((id) => (id && set.has(id) ? null : id));
      setMenu(null);
    },
    [emit],
  );

  const removeEdges = useCallback(
    (edgeIds: string[]): void => {
      if (edgeIds.length === 0) return;
      const current = valueRef.current;
      const set = new Set(edgeIds);
      emit({
        ...current,
        edges: current.edges.filter(
          (edge) => !set.has(`st-edge-${edgeKey(edge)}`),
        ),
      });
      setEditingEdgeId((id) => (id && set.has(id) ? null : id));
      setMenu(null);
    },
    [emit],
  );

  const updateNode = useCallback(
    (nodeId: string, patch: Partial<ScheduledTaskWorkflowNode>): void => {
      const current = valueRef.current;
      emit({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId ? { ...node, ...patch } : node,
        ),
      });
    },
    [emit],
  );

  const applyDelay = useCallback((): void => {
    if (!editingEdgeId) return;
    const amount = Number.parseFloat(delayDraft.value);
    const delayMs =
      Number.isFinite(amount) && amount > 0
        ? Math.round(amount * UNIT_MS[delayDraft.unit])
        : 0;
    const current = valueRef.current;
    emit({
      ...current,
      edges: current.edges.map((edge) =>
        `st-edge-${edgeKey(edge)}` === editingEdgeId
          ? { ...edge, delayMs }
          : edge,
      ),
    });
    setEditingEdgeId(null);
  }, [delayDraft, editingEdgeId, emit]);

  const isConnectionAllowed = useCallback(
    (source?: string | null, target?: string | null): boolean => {
      if (readOnly || !source || !target) return false;
      const edges = valueRef.current.edges;
      if (
        edges.some((edge) => edge.source === source && edge.target === target)
      )
        return false;
      return !wouldCreateCycle(edges, source, target);
    },
    [readOnly],
  );

  const handleConnect = useCallback(
    (connection: Connection): void => {
      const { source, target } = connection;
      if (!isConnectionAllowed(source, target)) return;
      const current = valueRef.current;
      emit({
        ...current,
        edges: [...current.edges, { source, target, delayMs: 0 }],
      });
    },
    [emit, isConnectionAllowed],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]): void => {
      const removed = changes
        .filter((change) => change.type === "remove")
        .map((change) => change.id);
      if (!readOnly) removeNodes(removed);
      onFlowNodesChange(changes.filter((change) => change.type !== "remove"));
    },
    [onFlowNodesChange, readOnly, removeNodes],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]): void => {
      if (readOnly) return;
      removeEdges(
        changes
          .filter((change) => change.type === "remove")
          .map((change) => change.id),
      );
    },
    [readOnly, removeEdges],
  );

  const handleDragStop = useCallback(
    (_event: unknown, _node: CardNode, dragged: CardNode[]): void => {
      if (readOnly) return;
      const positions = new Map(
        dragged.map((item) => [item.id, item.position] as const),
      );
      const current = valueRef.current;
      emit({
        ...current,
        nodes: current.nodes.map((node) => {
          const position = positions.get(node.id);
          return position ? { ...node, position: { ...position } } : node;
        }),
      });
    },
    [emit, readOnly],
  );

  const openMenu = useCallback(
    (
      event: React.MouseEvent | MouseEvent,
      nodeId: string | null,
      edgeId: string | null,
    ): void => {
      event.preventDefault();
      if (readOnly) return;
      const local = toLocal(event.clientX, event.clientY);
      setMenu({
        ...placeOverlay(local.x, local.y, 160, 90),
        clientX: event.clientX,
        clientY: event.clientY,
        nodeId,
        edgeId,
      });
    },
    [placeOverlay, readOnly, toLocal],
  );

  const openNodeEditor = useCallback(
    (nodeId: string, at?: Anchor): void => {
      if (readOnly) return;
      setAnchor(placeOverlay(at?.x ?? 12, at?.y ?? 12, 300, 360));
      setMenu(null);
      setEditingEdgeId(null);
      setEditingNodeId(nodeId);
    },
    [placeOverlay, readOnly],
  );

  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: CardNode): void => {
      setMenu(null);
      if (readOnly) {
        const conversationId = run?.nodes[node.id]?.conversationId;
        if (conversationId) onOpenConversation?.(conversationId);
        return;
      }
      openNodeEditor(node.id, toLocal(event.clientX, event.clientY));
    },
    [onOpenConversation, openNodeEditor, readOnly, run, toLocal],
  );

  // ---- 节点编辑器的模型目录 ----
  const editingNode = value.nodes.find((node) => node.id === editingNodeId);
  const editingConfig = useMemo(
    () =>
      editingNode?.apiProfile
        ? (apiConfigs.find(
            (config) => config.profileName === editingNode.apiProfile,
          ) ?? null)
        : null,
    [apiConfigs, editingNode?.apiProfile],
  );

  useEffect(() => {
    modelRequestRef.current += 1;
    setModels([]);
    setModelsFor(null);
    setModelsError(null);
    setModelsLoading(false);
  }, [editingConfig?.profileName]);

  const loadModels = useCallback(
    async (force = false): Promise<void> => {
      if (!editingConfig) return;
      if (modelsLoading || (!force && modelsFor === editingConfig.profileName))
        return;
      const requestId = ++modelRequestRef.current;
      setModelsLoading(true);
      setModelsError(null);
      try {
        const available = await window.snow.fetchAvailableModelsForConfig({
          baseUrl: editingConfig.baseUrl,
          baseUrlMode: editingConfig.baseUrlMode,
          apiKey: editingConfig.apiKey,
          requestMethod: editingConfig.requestMethod,
          customHeaderSchemeId: editingConfig.customHeaderSchemeId,
          configJson: editingConfig.configJson.trim() || undefined,
        });
        if (modelRequestRef.current !== requestId) return;
        setModels(available);
        setModelsFor(editingConfig.profileName);
      } catch (error) {
        if (modelRequestRef.current !== requestId) return;
        setModelsError(
          error instanceof Error
            ? error.message
            : t("chat.loadModelsError", {
                defaultValue: "Failed to load models",
              }),
        );
      } finally {
        if (modelRequestRef.current === requestId) setModelsLoading(false);
      }
    },
    [editingConfig, modelsFor, modelsLoading, t],
  );

  const profileOptions = useMemo(
    () => [
      {
        value: "",
        label: t("scheduledTask.workflow.inheritTaskConfig", {
          defaultValue: "Inherit task run config",
        }),
      },
      ...apiConfigs.map((config) => ({
        value: config.profileName,
        label: config.displayName.trim() || config.profileName,
      })),
    ],
    [apiConfigs, t],
  );

  const unitOptions = useMemo(
    () =>
      (["seconds", "minutes", "hours", "days"] as DelayUnit[]).map((unit) => ({
        value: unit,
        label: t(`scheduledTask.workflow.unit.${unit}`, { defaultValue: unit }),
      })),
    [t],
  );

  const stopKeys = (event: React.KeyboardEvent): void => {
    // 输入框内的 Backspace/Delete 不应删除画布选中项；Esc 只关浮层
    event.stopPropagation();
    if (event.key === "Escape") {
      setEditingNodeId(null);
      setEditingEdgeId(null);
    }
  };

  return (
    <div className="workflow-canvas-wrap st-workflow-canvas-wrap" ref={wrapRef}>
      <div className="st-workflow-toolbar">
        {!readOnly && (
          <button
            className="scheduled-tasks-new-btn st-workflow-toolbar-btn"
            onClick={() => addNode()}
            type="button"
          >
            <Plus size={13} strokeWidth={2.2} />
            {t("scheduledTask.workflow.addNode", {
              defaultValue: "Add node",
            })}
          </button>
        )}
        <button
          className="scheduled-tasks-new-btn st-workflow-toolbar-btn st-workflow-expand-btn"
          onClick={onToggleExpand}
          type="button"
        >
          {expanded ? (
            <Minimize2 size={13} strokeWidth={2.2} />
          ) : (
            <Maximize2 size={13} strokeWidth={2.2} />
          )}
          {expanded
            ? t("scheduledTask.workflow.collapseCanvas", {
                defaultValue: "Collapse",
              })
            : t("scheduledTask.workflow.expandCanvas", {
                defaultValue: "Enlarge canvas",
              })}
        </button>
      </div>
      <div
        className={`workflow-canvas st-workflow-canvas${focused && !expanded ? " is-focused" : ""}`}
      >
        <ReactFlow<CardNode, DelayEdgeType>
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          edgeTypes={EDGE_TYPES}
          edges={flowEdges}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
          isValidConnection={(edge) =>
            isConnectionAllowed(edge.source, edge.target)
          }
          nodeTypes={NODE_TYPES}
          nodes={flowNodes}
          nodesConnectable={!readOnly}
          nodesDraggable={!readOnly}
          onConnect={handleConnect}
          onEdgeContextMenu={(event, edge) => openMenu(event, null, edge.id)}
          onEdgesChange={handleEdgesChange}
          onMoveStart={() => setMenu(null)}
          onNodeClick={handleNodeClick}
          onNodeContextMenu={(event, node) => openMenu(event, node.id, null)}
          onNodeDragStop={handleDragStop}
          onNodesChange={handleNodesChange}
          onPaneClick={() => setMenu(null)}
          onPaneContextMenu={(event) => openMenu(event, null, null)}
          preventScrolling={wheelActive}
          proOptions={{ hideAttribution: true }}
          zoomOnPinch={wheelActive}
          zoomOnScroll={wheelActive}
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {value.nodes.length === 0 && (
          <div className="st-workflow-empty">
            {t("scheduledTask.workflow.emptyCanvas", {
              defaultValue: "Right-click the canvas or use Add node to start.",
            })}
          </div>
        )}
      </div>

      {menu && (
        <div
          className="workflow-context-menu"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.edgeId ? (
            <>
              {!isChatVariant && (
                <button
                  onClick={() =>
                    openEdgeEditor(
                      menu.edgeId ?? "",
                      menu.clientX,
                      menu.clientY,
                    )
                  }
                  type="button"
                >
                  <Clock size={13} />
                  <span>
                    {t("scheduledTask.workflow.editDelay", {
                      defaultValue: "Set delay",
                    })}
                  </span>
                </button>
              )}
              <button
                onClick={() => removeEdges([menu.edgeId ?? ""])}
                type="button"
              >
                <Trash2 size={13} />
                <span>
                  {t("scheduledTask.workflow.deleteEdge", {
                    defaultValue: "Delete connection",
                  })}
                </span>
              </button>
            </>
          ) : menu.nodeId ? (
            <>
              <button
                onClick={() =>
                  openNodeEditor(menu.nodeId ?? "", { x: menu.x, y: menu.y })
                }
                type="button"
              >
                <Pencil size={13} />
                <span>
                  {t("scheduledTask.workflow.editNode", {
                    defaultValue: "Edit node",
                  })}
                </span>
              </button>
              <button
                onClick={() => removeNodes([menu.nodeId ?? ""])}
                type="button"
              >
                <Trash2 size={13} />
                <span>
                  {t("scheduledTask.workflow.deleteNode", {
                    defaultValue: "Delete node",
                  })}
                </span>
              </button>
            </>
          ) : (
            <button
              onClick={() => addNode(menu.clientX, menu.clientY)}
              type="button"
            >
              <Plus size={13} />
              <span>
                {t("scheduledTask.workflow.addNode", {
                  defaultValue: "Add node",
                })}
              </span>
            </button>
          )}
        </div>
      )}

      {editingNode && !readOnly && (
        <div
          className="workflow-editor workflow-editor-overlay st-workflow-editor"
          onKeyDown={stopKeys}
          style={{ left: anchor.x, top: anchor.y }}
        >
          <div className="workflow-editor-header">
            <span>
              <Pencil size={13} />
              {editingNode.label}
            </span>
            <button
              aria-label={t("common.close", { defaultValue: "Close" })}
              className="workflow-editor-close"
              onClick={() => setEditingNodeId(null)}
              type="button"
            >
              <X size={14} />
            </button>
          </div>
          <label className="workflow-editor-field">
            <span>
              {t("scheduledTask.workflow.nodeName", {
                defaultValue: "Node name",
              })}
            </span>
            <input
              onChange={(event) =>
                updateNode(editingNode.id, { label: event.target.value })
              }
              type="text"
              value={editingNode.label}
            />
          </label>
          <label className="workflow-editor-field">
            <span>
              {t("scheduledTask.workflow.nodePrompt", {
                defaultValue: "Prompt",
              })}
            </span>
            <textarea
              onChange={(event) =>
                updateNode(editingNode.id, { prompt: event.target.value })
              }
              placeholder={t("scheduledTask.workflow.nodePromptPlaceholder", {
                defaultValue: "What this step should do",
              })}
              rows={6}
              value={editingNode.prompt}
            />
          </label>
          <div className="workflow-editor-field">
            <span>
              {t("scheduledTask.apiProfile", { defaultValue: "API config" })}
            </span>
            <CustomSelect
              onChange={(profile) =>
                updateNode(editingNode.id, {
                  apiProfile: profile || undefined,
                  model: undefined,
                })
              }
              options={profileOptions}
              value={editingNode.apiProfile ?? ""}
            />
          </div>
          {editingConfig && (
            <ApiModelCombobox
              disabled={false}
              error={modelsError}
              hasLoaded={modelsFor === editingConfig.profileName}
              isLoading={modelsLoading}
              label={t("scheduledTask.advancedModel", {
                defaultValue: "Advanced model",
              })}
              loadingText={t("settings.loadingModels", {
                defaultValue: "Loading models...",
              })}
              models={models}
              noModelsText={t("chat.noModelsFound", {
                defaultValue: "No models found",
              })}
              onChange={(model) =>
                updateNode(editingNode.id, { model: model.trim() || undefined })
              }
              onRequestModels={() => void loadModels()}
              onRetry={() => void loadModels(true)}
              placeholder={editingConfig.advancedModel}
              retryText={t("common.retry", { defaultValue: "Retry" })}
              value={editingNode.model ?? ""}
            />
          )}
          <div className="workflow-editor-footer">
            <button
              className="st-workflow-danger-btn"
              onClick={() => removeNodes([editingNode.id])}
              type="button"
            >
              <Trash2 size={12} />
              {t("scheduledTask.workflow.deleteNode", {
                defaultValue: "Delete node",
              })}
            </button>
            <button
              className="tool-call-plan-approval-continue"
              onClick={() => setEditingNodeId(null)}
              type="button"
            >
              <Check size={13} />
              <span>
                {t("scheduledTask.workflow.done", { defaultValue: "Done" })}
              </span>
            </button>
          </div>
        </div>
      )}

      {editingEdgeId && !readOnly && !isChatVariant && (
        <div
          className="workflow-editor workflow-editor-overlay st-workflow-delay-editor"
          onKeyDown={(event) => {
            stopKeys(event);
            if (isSubmitEnter(event)) {
              event.preventDefault();
              applyDelay();
            }
          }}
          style={{ left: anchor.x, top: anchor.y }}
        >
          <div className="workflow-editor-header">
            <span>
              <Timer size={13} />
              {t("scheduledTask.workflow.editDelay", {
                defaultValue: "Set delay",
              })}
            </span>
            <button
              aria-label={t("common.close", { defaultValue: "Close" })}
              className="workflow-editor-close"
              onClick={() => setEditingEdgeId(null)}
              type="button"
            >
              <X size={14} />
            </button>
          </div>
          <div className="st-workflow-delay-row">
            <input
              min="0"
              onChange={(event) =>
                setDelayDraft((draft) => ({
                  ...draft,
                  value: event.target.value,
                }))
              }
              type="number"
              value={delayDraft.value}
            />
            <CustomSelect
              onChange={(unit) =>
                setDelayDraft((draft) => ({
                  ...draft,
                  unit: unit as DelayUnit,
                }))
              }
              options={unitOptions}
              value={delayDraft.unit}
            />
          </div>
          <small className="workflow-editor-hint">
            {t("scheduledTask.workflow.delayHint", {
              defaultValue:
                "Wait this long after the upstream node finishes. 0 = start immediately.",
            })}
          </small>
          <div className="workflow-editor-footer">
            <button
              className="tool-call-plan-approval-continue"
              onClick={applyDelay}
              type="button"
            >
              <Check size={13} />
              <span>
                {t("scheduledTask.workflow.done", { defaultValue: "Done" })}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

export const ScheduledTaskWorkflowCanvas = forwardRef<
  ScheduledTaskWorkflowCanvasHandle,
  ScheduledTaskWorkflowCanvasProps
>(function ScheduledTaskWorkflowCanvas(props, ref): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const innerRef = useRef<ScheduledTaskWorkflowCanvasHandle>(null);

  // Esc 先关画布内浮层，再关放大弹窗
  useImperativeHandle(
    ref,
    () => ({
      closeOverlay: () => {
        if (innerRef.current?.closeOverlay()) return true;
        if (expanded) {
          setExpanded(false);
          return true;
        }
        return false;
      },
    }),
    [expanded],
  );

  const canvas = (
    <ReactFlowProvider>
      <CanvasInner
        {...props}
        expanded={expanded}
        onToggleExpand={() => setExpanded((value) => !value)}
        ref={innerRef}
      />
    </ReactFlowProvider>
  );

  if (!expanded) return canvas;

  return (
    <>
      <div className="workflow-canvas-collapsed">
        <span>
          {t("scheduledTask.workflow.expandedHint", {
            defaultValue: "The canvas is open in an enlarged window.",
          })}
        </span>
        <button onClick={() => setExpanded(false)} type="button">
          <Minimize2 size={12} />
          {t("scheduledTask.workflow.collapseCanvas", {
            defaultValue: "Collapse",
          })}
        </button>
      </div>
      {createPortal(
        <div
          className="form-dialog-overlay st-workflow-modal-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setExpanded(false);
          }}
        >
          <div aria-modal="true" className="st-workflow-modal" role="dialog">
            {canvas}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
});
