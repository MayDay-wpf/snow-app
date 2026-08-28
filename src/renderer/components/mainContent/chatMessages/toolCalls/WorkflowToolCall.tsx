import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
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
  const graph = useMemo(
    () => parseWorkflowGraph(toolCall.arguments ?? "{}"),
    [toolCall],
  );
  // React Flow 官方受控模式（useNodesState + onNodesChange）：拖拽由
  // applyNodeChanges 逐帧驱动，只替换被拖节点对象，其余节点引用稳定；
  // 业务数据挂在 data.node，更新时同样只替换目标节点。
  const [flowNodes, setFlowNodes, onFlowNodesChange] =
    useNodesState<WorkflowFlowNode>(
      graph.nodes.map((node, index) => ({
        id: node.id,
        type: "workflowCard",
        position: {
          x: (index % 3) * 300,
          y: Math.floor(index / 3) * 170,
        },
        data: {
          node: {
            ...node,
            runStatus: "pending",
            errorMessage: "",
            conversationId: "",
            handoffContent: "",
          },
        },
      })),
    );
  const [edges, setEdges] = useState(graph.edges);
  const [runnerStatus, setRunnerStatus] =
    useState<WorkflowRunnerStatus>("idle");
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [userReply, setUserReply] = useState("");
  const [hasReplied, setHasReplied] = useState(false);
  // 已提交的反馈内容：AI 收到 userResponse 重新设计流程，组件上同步
  // 展示这条反馈，让"流程为何重新生成"在卡片内可追溯。
  const [submittedReply, setSubmittedReply] = useState("");
  const [isRestoring, setIsRestoring] = useState(false);
  const flowNodesRef = useRef(flowNodes);
  flowNodesRef.current = flowNodes;
  // 画布容器（右键菜单/编辑浮层的定位基准）。
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  // 画布右键菜单与节点编辑浮层锚点（相对画布容器）。
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(
    null,
  );
  const [editorAnchor, setEditorAnchor] = useState<{ x: number; y: number }>(
    () => ({ x: 16, y: 16 }),
  );
  const parentConversationId = conversationId ?? "";
  const directoryId = contextDirectoryId ?? "";
  const runnerStatusRef = useRef<WorkflowRunnerStatus>("idle");
  // 工具调用是否仍挂起等待用户操作（未结算）。历史 replay 的已完成
  // 工具调用初始即视为非挂起。
  const pendingRef = useRef<boolean>(toolCall.status !== "completed");

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

  // 恢复历史运行状态：挂载时从 DB 读取本 flow 的节点运行记录。
  // 记录按 flowId（= toolCall.interactionId）隔离，避免同会话多 flow 的
  // 重名节点互串；旧数据（无 flowId）回退按 nodeId 匹配。
  // runner 仍在活跃执行时保留 running 状态（后续事件继续驱动更新）；
  // 应用重启后残留的 running 记录无人驱动，降级为 pending。
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
      if (records.length > 0) {
        const runActive = isWorkflowRunActive(
          parentConversationId,
          toolCall.interactionId,
        );
        setIsRestoring(true);
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
    } finally {
      setIsRestoring(false);
    }
  }, [parentConversationId, toolCall.interactionId]);

  useEffect(() => {
    void restoreRuns();
  }, [restoreRuns]);

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
        .map((edge, index) => ({
          id: `edge-${edge.source}-${edge.target}-${index}`,
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

  // 编辑类操作仅在工具挂起且未运行时开放。
  const canEditCanvas =
    pendingRef.current && runnerStatusRef.current !== "running";

  const openCanvasContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent, nodeId: string | null): void => {
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
                onNodesChange={onFlowNodesChange}
                fitView
                nodesConnectable={false}
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
                {contextMenu.nodeId ? (
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
            {/* 执行按钮只在待确认时出现：提交反馈或执行后进入终态即隐藏。 */}
            {isInteractive ? (
              <button
                type="button"
                className="tool-call-plan-approval-continue"
                onClick={() => handleExecute()}
              >
                <Play size={14} aria-hidden="true" />
                <span>{t("toolCall.workflow.execute")}</span>
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
