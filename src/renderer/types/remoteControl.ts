/** 纠错 Agent 的一次参数修复尝试（与桌面 ToolCorrectionAttempt 同源）。 */
export type SnowRemoteToolCorrectionAttempt = {
  /** 1-based 尝试序号。 */
  index: number;
  status: "running" | "failed" | "succeeded" | "rejected";
  /** 纠错 Agent 修正后的参数（已脱敏）。 */
  arguments: string;
  /** 纠错 Agent 给出的一行修复理由。 */
  reasoning?: string;
  /** 修正调用执行失败时的原始错误。 */
  error?: string;
  /** 修正调用执行成功时的原始结果。 */
  result?: string;
  startedAt: number;
  finishedAt?: number;
};

/** 工具失败后的纠错 Agent 状态（与桌面 ToolCorrectionState 同源）。 */
export type SnowRemoteToolCorrection = {
  status: "running" | "succeeded" | "failed" | "abandoned";
  attempts: SnowRemoteToolCorrectionAttempt[];
  /** 原始失败调用的参数（已脱敏）。 */
  originalArguments: string;
  failureCode?:
    | "max_attempts"
    | "model_error"
    | "not_repairable"
    | "rejected"
    | "cancelled";
  /** 模型 / 传输失败的技术细节。 */
  failureDetail?: string;
};

export type SnowRemoteToolCall = {
  name: string;
  interactionId: string;
  authorizationId?: string;
  status: "pending" | "running" | "completed" | "error";
  arguments?: string;
  result?: string;
  streamingStdout?: string;
  streamingStderr?: string;
  /** 工具失败后由纠错 Agent 修复的过程与结果（仅参与的调用带此字段）。 */
  correction?: SnowRemoteToolCorrection;
  userQuestion?: {
    questionId: string;
    question: string;
    options: string[];
    status: "waiting" | "answered" | "cancelled";
    /** 中断标记：未被作答就被外部结算（会话中断 / 处理器销毁 / 工具异常结束）。 */
    interrupted?: boolean;
    selectedOptions: string[];
    customAnswers: string[];
  };
  /**
   * WorkFlow 卡片快照（仅 workflow-generate / workflow-resume 工具带此字段）：
   * 节点图与运行态由桌面渲染进程按 flow 组装，移动端只读展示 + 执行 / 反馈。
   */
  workflow?: SnowRemoteWorkflow;
};

export type SnowRemoteWorkflowNodeStatus =
  "pending" | "running" | "completed" | "failed";

export type SnowRemoteWorkflowNode = {
  id: string;
  label: string;
  description: string;
  status: SnowRemoteWorkflowNodeStatus;
  /** 节点会话 id：非空表示节点已创建会话，可跳转查看执行详情。 */
  conversationId: string;
  errorMessage: string;
  /** 前置节点 label（画布边推导）：移动端用于节点提示与无障碍描述。 */
  dependsOn: string[];
};

/**
 * WorkFlow 卡片快照。
 * - mode = "generate"：workflow-generate 卡片，挂起时可在手机端执行或提交反馈；
 * - mode = "resume"：workflow-resume 卡片，只读展示续跑节点状态。
 */
export type SnowRemoteWorkflow = {
  /** flow 标识 = workflow-generate 工具调用 id（动作请求按它定位）。 */
  flowId: string;
  mode: "generate" | "resume";
  title: string;
  /** 卡片整体状态：idle = 等待用户操作/尚未运行。 */
  status: "idle" | "running" | "completed" | "failed";
  /** 生成卡片的执行/反馈入口是否可用（挂起中才可操作）。 */
  pending: boolean;
  /** 存在未完成的 run 进度（应用重启/中断/失败）：执行按钮变为「继续执行」。 */
  resumeAvailable: boolean;
  nodes: SnowRemoteWorkflowNode[];
  /** 节点边（source → target）：移动端画布据此绘制箭头并计算分层布局。 */
  edges: { source: string; target: string }[];
  failedNode?: {
    nodeId: string;
    label: string;
    error: string;
    conversationId: string;
  };
};

export type SnowRemoteMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  contentBlocks?: SnowRemoteContentBlock[];
  thinking?: string;
  model?: string;
  isThinkingActive?: boolean;
  thinkingDurationMs?: number;
  toolCalls?: SnowRemoteToolCall[];
  timestamp: string;
  status?: "sending" | "sent" | "incomplete" | "error";
  isContextCompaction?: boolean;
};

export type SnowRemoteContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; name: string; source: string }
  | { type: "file"; name: string; isDirectory: boolean }
  | {
      type: "reference";
      kind:
        | "commit"
        | "change"
        | "text-snippet"
        | "review"
        | "element"
        | "web"
        | "conversation"
        | "quote"
        | "command"
        | "skill"
        | "annotation"
        | "file-selection"
        | "workflow";
      label: string;
      detail?: string;
    };

/**
 * 待发送（Pending）消息：运行中的会话被排队的消息，仅属于当前激活会话
 * （会话隔离：随 activeConversationId 一起切换，不跨会话展示）。
 * 只含展示用分段（文本 + 附件 chips），撤回原文通过 withdrawPending 返回。
 */
export type SnowRemotePendingMessage = {
  blocks: SnowRemoteContentBlock[];
};

/**
 * 会话列表条目（移动端会话选择器）。
 *
 * 运行态字段（isStreaming / isPaused / attentionRequired / isCompleted）与桌面
 * 侧边栏同源，由渲染进程的会话上下文实时计算，随 /api/state 轮询变化。
 * children 承载树形子层：Workflow 节点会话与其派生的子代理会话，
 * 形成「主会话 → 节点会话 → 子代理」层级（与桌面侧边栏一致）。
 */
export type SnowRemoteConversation = {
  conversationId: string;
  title: string;
  summary: string;
  lastMessagePreview: string;
  status: string;
  directoryId: string;
  workspaceName: string;
  updatedAt: string;
  /** 会话类型：main / sub_agent / workflow_node。 */
  conversationType: string;
  /** 分支会话（由 forkedFromConversationId 派生）：桌面侧边栏显示 GitFork 图标。 */
  isForked: boolean;
  /** 子代理名或 Workflow 节点名；主会话为空串，移动端优先展示它。 */
  subAgentName: string;
  /** 子代理 / 节点运行状态（running、completed、failed、pending）；主会话为空串。 */
  runStatus: string;
  /** 正在流式输出（桌面显示旋转 loading）。 */
  isStreaming: boolean;
  /** 流式被用户暂停（agent loop 阻塞等待恢复）。 */
  isPaused: boolean;
  /** 需要用户操作（提问或工具授权）。 */
  attentionRequired: boolean;
  /** 本轮运行已完成（桌面显示对勾）。 */
  isCompleted: boolean;
  /** 树形子层：Workflow 节点会话 + 直接派生的子代理会话（节点下再挂其子代理）。 */
  children: SnowRemoteConversation[];
};

export type SnowRemoteTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export type SnowRemoteChatCommandInfo = {
  id: string;
  label: string;
  description: string;
  disabled: boolean;
};

export type SnowRemoteThinkingOption = {
  value: string;
  label: string;
};

export type SnowRemoteSkill = {
  id: string;
  name: string;
  description: string;
  location: "project" | "global";
  source: "snow" | "agents";
  allowedTools: string[];
  enabled: boolean;
};

export type SnowRemoteMcpServer = {
  id: string;
  name: string;
  source: "system" | "external" | "project";
  globalEnabled: boolean;
  enabled: boolean;
  available: boolean;
  tools: Array<{ name: string; description: string; enabled: boolean }>;
};

export type SnowRemoteChange = {
  path: string;
  kind: "create" | "edit" | "delete";
  agent: "main" | "sub";
  /** 子代理名称（agent 为 sub 时下发；缺失回退到通用文案）。 */
  subAgentName?: string;
  /** 新增行数 / 删除行数（无 diff 时均为 0）。 */
  additions: number;
  deletions: number;
};

export type SnowRemoteTodoStatus = "pending" | "inProgress" | "completed";

/**
 * 会话待办项：与桌面顶部待办面板同源（todo-todo-manage 工具的展示子集）。
 * 只保留移动端渲染需要的字段，content 由桥截断后下发。
 */
export type SnowRemoteTodoItem = {
  id: string;
  content: string;
  status: SnowRemoteTodoStatus;
};

/** 回滚确认清单里的单条文件变更（与桌面 RollbackConfirmDialog 同源）。 */
export type SnowRemoteRollbackChange = {
  path: string;
  changeType: "added" | "modified" | "deleted";
};

/** 回滚将删除的 TODO 项。 */
export type SnowRemoteRollbackTodoItem = {
  id: string;
  content: string;
  status: SnowRemoteTodoStatus;
};

/** 回滚将删除（可选）的项目记忆条目。 */
export type SnowRemoteRollbackMemoryItem = {
  memoryId: string;
  title: string;
  kind: string;
};

/** 回滚方式：conversation-only 只回滚会话，conversation-and-files 同时恢复文件。 */
export type SnowRemoteRollbackMode =
  "conversation-only" | "conversation-and-files";

/**
 * 回滚预览（数据来自桌面会话上下文的 rollbackPreview，与电脑端弹窗完全一致）：
 * 手机端只读展示并据此确认；checkpointIds / workDir 用于按需拉取文件 diff。
 */
export type SnowRemoteRollbackPreview = {
  /** 回滚目标用户消息 id。 */
  messageId: string;
  /** 文件变更清单（已按上限截断，总数见 changeTotals）。 */
  changes: SnowRemoteRollbackChange[];
  changeTotals: { added: number; modified: number; deleted: number };
  /** 消息级 + flow 级检查点（交给 Rust 计算 diff）。 */
  checkpointIds: string[];
  workDir: string;
  /** 回滚首条消息 = 整个对话被删除。 */
  isFirstMessage: boolean;
  todoItems: SnowRemoteRollbackTodoItem[];
  memoryItems: SnowRemoteRollbackMemoryItem[];
  /** 被回滚轮次关联的 WorkFlow 数量（>0 时提示级联中止并删除）。 */
  workflowFlowCount: number;
  /** 截断 / 删除失败时的错误文案；手机端展示并允许重试。 */
  error?: string;
};

/**
 * 回滚实时状态（GET /api/rollback）：preparingMessageId 表示桌面正在中止运行并
 * 计算文件变更（SSH 下经 SFTP 遍历可能较慢），preview 就绪后手机端渲染确认弹窗。
 */
export type SnowRemoteRollbackState = {
  conversationId: string | null;
  preparingMessageId: string | null;
  preview: SnowRemoteRollbackPreview | null;
};

/** 回滚预览中单个文件的变更摘要（由 Rust 检查点服务直接计算，不含 diff 正文）。 */
export type SnowRemoteRollbackFile = {
  path: string;
  changeType: "added" | "modified" | "deleted";
  isBinary: boolean;
  /** SSH 工作区中超过传输上限、未读取内容的文件：无行数统计、不提供明细。 */
  tooLarge: boolean;
  additions: number;
  deletions: number;
};

/** 回滚预览中单个文件 diff 的首页（选中文件时按需拉取）。 */
export type SnowRemoteRollbackDiff = {
  content: string;
  isBinary: boolean;
  tooLarge: boolean;
  /** 内容超过手机端下发上限被截断（截断提示展示用）。 */
  truncated: boolean;
};

/**
 * 远控 Phase A：聊天输入区安全快照。
 * 数据来自 ChatInputView 发布的真实能力（见
 * mainContent/chatInput/remoteControlChatInputRegistry.ts）。
 * 输入区卸载（桌面停留在设置页等非对话视图）时保留最后一次快照用于展示，
 * 手机端不会退化为「未选择」；模型 / Profile 等变更仍要求桌面处于对话页。
 * 只含展示层安全数据：不含 ApiConfigRecord、baseUrl、apiKey、configJson。
 */
export type SnowRemoteChatInputState = {
  /** 快照绑定的会话；null = 尚未绑定真实会话（新会话输入区）。 */
  conversationId: string | null;
  isSubAgentConversation: boolean;
  isLoadingApiConfig: boolean;
  selectedModel: string;
  displayModel: string;
  modelIds: string[];
  selectedApiProfile: string;
  apiProfileNames: string[];
  requestMethod: string;
  /** 会话生效的思考强度值（会话覆盖已解析，回退 Profile 默认）。 */
  effectiveThinkingValue: string;
  thinkingOptions: SnowRemoteThinkingOption[];
  /** 会话生效的 Fast Mode 档位（"off" | "fast" | "ultrafast"）。 */
  responsesFastMode: string;
  maxContextTokens: number | null;
  /** 真实 Token Usage（来自当前会话 session，未在 Renderer 重新计算）。 */
  tokenUsage: SnowRemoteTokenUsage | null;
  commands: SnowRemoteChatCommandInfo[];
};

/**
 * 可远程切换的代理行为模式。
 * 与桌面 PlusMenu 的开关一一对应：Goal / YOLO / WorkTree / WorkFlow /
 * Lite 全部由手机端直接启停，复用同一套真实 setter。
 * Goal/Worktree/Workflow 为会话级；YOLO / Lite 为应用级设置。
 * 安全边界：YOLO 只影响“普通 pending 工具授权自动批准”，
 * 敏感命令仍需桌面端独立确认；YOLO 与远控鉴权无关。
 */
export type SnowRemoteModeId =
  "goal" | "worktree" | "workflow" | "yolo" | "lite";

export type SnowRemoteModesState = {
  goal: boolean;
  worktree: boolean;
  workflow: boolean;
  yolo: boolean;
  lite: boolean;
};

export type SnowRemoteState = {
  workspace: {
    directoryId: string;
    name: string;
    path: string;
  } | null;
  activeConversationId: string | null;
  isStreaming: boolean;
  isAborting: boolean;
  isCompacting: boolean;
  compactionError: string | null;
  compactionPreview: string;
  attentionRequired: boolean;
  messages: SnowRemoteMessage[];
  /**
   * 当前激活会话的待发送（Pending）队列（会话隔离：切换会话后此字段与
   * activeConversationId 一起切换，绝不展示其他会话的排队消息）。
   */
  pendingMessages: SnowRemotePendingMessage[];
  /**
   * 待发送队列的定位键（不透明标记）：当前视图会话的 key（新会话槽位
   * key 或真实会话 id）。移动端操作时原样回传（见 sendPendingNow /
   * withdrawPending），桌面端据此解析队列真实位置——含新会话槽位迁移
   * 到真实 id 的映射，因此操作不会因会话迁移/切换而失效。
   */
  pendingQueueKey: string | null;
  pendingAuthorizations: SnowRemoteToolCall[];
  pendingQuestions: Array<{
    questionId: string;
    question: string;
    options: string[];
  }>;
  conversations: SnowRemoteConversation[];
  /** directoryId → 该工作区会话总数；移动端会话列表「加载更多」用。 */
  conversationTotals: Record<string, number>;
  /**
   * 当前会话是否还有更早的持久化记录（来自桌面会话的 hasMoreMessages，
   * 即 DB 分页 hasMore）。会话状态未知时缺省。
   */
  hasOlderMessages?: boolean;
  /**
   * 当前激活会话是否可回滚（与桌面 ChatMessageList 的 canRollback 同源：
   * 子代理 / 工作流节点会话不支持回滚）。移动端据此决定用户消息的回滚入口。
   */
  rollbackAvailable: boolean;
  /**
   * 激活会话身份快照（会话类型 / 运行状态 / 父会话 id），与桌面 ChatContent 的
   * activeConversationMeta 判定同源。子代理 / Workflow 节点会话结束后桌面把
   * 输入区替换为只读收尾栏，移动端据此做同样处理（隐藏输入区 + 展示收尾栏，
   * 「返回主会话」指向 activeConversationParentId）。无活动会话时均为空串。
   */
  activeConversationType: string;
  activeConversationRunStatus: string;
  activeConversationParentId: string;
  /**
   * 当前激活会话的待办列表（与桌面顶部待办面板同源，会话隔离）。
   * null = 待办不可用（无活动会话或工具读取失败），移动端隐藏待办入口。
   */
  todos: SnowRemoteTodoItem[] | null;
  modes: SnowRemoteModesState;
  /**
   * 「工具失败自动纠错」应用级开关（system_settings.tool_correction）。
   * 与桌面 PlusMenu 的自动纠错开关同源，移动端动作面板可直接切换。
   */
  toolCorrection: boolean;
  /**
   * 桌面当前生效的主题色（--accent-color 的计算值，规范化为 #rrggbb）。
   * 手机端把它应用到开关 / 选中态等强调色上，跟随 Snow APP 主题；
   * 解析失败时为空串，手机端保持自身默认。
   */
  theme: { accentColor: string };
  chatInput: SnowRemoteChatInputState | null;
};

export type SnowRemoteControlApi = {
  getState: () => Promise<SnowRemoteState>;
  getMessageImage: (
    messageId: string,
    imageIndex: number,
  ) => Promise<{ mimeType: string; base64: string }>;
  /** 按时间倒序向前分页加载更早的消息（移动端聊天记录分页）。 */
  getMessages: (
    conversationId: string,
    beforeMessageId: string,
    limit: number,
  ) => Promise<{
    conversationId: string;
    hasMore: boolean;
    items: SnowRemoteMessage[];
  }>;
  /** 分页加载某个工作区的会话列表（移动端会话选择器分页）。 */
  getConversations: (
    directoryId: string,
    limit: number,
    offset: number,
  ) => Promise<{
    directoryId: string;
    total: number;
    items: SnowRemoteConversation[];
  }>;
  getSkills: () => Promise<{
    directoryId: string | null;
    skills: SnowRemoteSkill[];
  }>;
  setSkillEnabled: (
    skillId: string,
    enabled: boolean,
    expectedDirectoryId: string | null,
  ) => Promise<{ ok: true }>;
  getMcpServers: () => Promise<{
    directoryId: string;
    servers: SnowRemoteMcpServer[];
  }>;
  setMcpEnabled: (
    target: "server" | "tool",
    id: string,
    enabled: boolean,
    expectedDirectoryId: string,
  ) => Promise<{ ok: true }>;
  /**
   * 会话文件变更（/changes 面板）：与桌面 FileChangesPanel 同源的回滚链
   * 描述 + 工具记录兜底。检查点 diff 由 Rust 侧原生计算（含 SSH 通道），
   * 这里只回链路描述与归属数据，避免慢遍历卡在桥超时上。
   */
  getChanges: (expectedConversationId?: string | null) => Promise<{
    conversationId: string | null;
    /** 回滚链检查点（消息级 + WorkFlow flow 级）。 */
    checkpointIds: string[];
    /** 检查点 diff 的基准目录（worktree 模式为实际工作树路径）。 */
    workDir: string;
    /** 工具记录的变更：代理归属兜底；检查点不可用时为完整清单。 */
    changes: SnowRemoteChange[];
  }>;
  /**
   * 会话待办变更：复用桌面真实 todo-todo-manage 工具（add / update / delete）。
   * 会话隔离：会话 ID 由桥注入，移动端无法跨会话读写；变更结果通过
   * /api/state 的 todos 字段回传，调用方随后刷新快照即可。
   */
  mutateTodos: (
    action: "add" | "update" | "delete",
    payload: {
      content?: string;
      todoId?: string;
      status?: SnowRemoteTodoStatus;
    },
  ) => Promise<{ ok: true }>;
  /**
   * 执行挂起的 WorkFlow（等价桌面卡片的「执行」按钮，含断点续跑）：
   * 校验通过后在后台启动渲染进程执行器并立即返回，进度通过 /api/state 的
   * workflow 快照轮询；执行完成后桌面按卡片同一路径结算工具调用。
   */
  runWorkflow: (flowId: string) => Promise<{ ok: true }>;
  /**
   * 提交对流程的修改意见：结算挂起的 workflow-generate 工具调用
   * （模型据此重新设计流程），与桌面卡片反馈入口同语义。
   */
  replyWorkflow: (flowId: string, message: string) => Promise<{ ok: true }>;
  /**
   * 回滚实时状态：桌面计算文件变更期间 preparingMessageId 非空，预览就绪后
   * preview 就位（与电脑端 RollbackConfirmDialog 同一份数据）。
   */
  getRollbackState: () => Promise<SnowRemoteRollbackState>;
  /**
   * 发起回滚预览：复用桌面 handleRollback（中止流 / 终止 WorkFlow 节点后计算
   * 文件变更），立即返回；结果由调用方轮询 getRollbackState 获取。桌面弹窗会
   * 同步弹出，用户在电脑端取消同样会结束手机端这次预览。
   */
  startRollback: (messageId: string) => Promise<{ ok: true }>;
  /**
   * 确认回滚：复用桌面 confirmRollback（文件恢复 → 会话截断 / 删除 → 清理
   * 检查点与记忆）。messageId 用于校验预览仍是当前这次。
   */
  confirmRollback: (
    messageId: string,
    mode: SnowRemoteRollbackMode,
    deleteMemories: boolean,
  ) => Promise<{ ok: true }>;
  /** 取消回滚预览（桌面同一次预览一并关闭）。 */
  cancelRollback: (messageId: string) => Promise<{ ok: true }>;
  getPermissions: () => Promise<{
    directoryId: string | null;
    projectApprovedTools: string[];
    globalApprovedTools: string[];
    readonlyToolCount: number;
    yolo: boolean;
  }>;
  getRole: () => Promise<{
    directoryId: string | null;
    source: "project" | "ssh" | "global" | "none";
    exists: boolean;
    characterCount: number;
    preview: string;
    editable: boolean;
    reason?: string;
  }>;
  getSensitiveCommands: () => Promise<{
    directoryId: string | null;
    commands: Array<{
      commandId: string;
      pattern: string;
      description: string;
      enabled: boolean;
      scope: "global" | "project";
      inherited: boolean;
      isPreset: boolean;
    }>;
  }>;
  getCodebase: () => Promise<{
    directoryId: string | null;
    enabled: boolean;
    agentReview: boolean;
    reranking: boolean;
    indexed: boolean;
    totalFiles: number;
    totalChunks: number;
    totalSizeBytes: number;
    remote: boolean;
    reason?: string;
  }>;
  getReview: () => Promise<{
    directoryId: string | null;
    available: boolean;
    currentBranch: string;
    stagedCount: number;
    unstagedCount: number;
    untrackedCount: number;
    statusLimitHit: boolean;
    remote: boolean;
    reason?: string;
  }>;
  send: (
    text: string,
    attachmentIds?: string[],
    requestId?: string,
    expectedContext?: {
      directoryId: string | null;
      conversationId: string | null;
    },
    pairingGeneration?: number,
  ) => Promise<{ ok: true }>;
  abort: () => Promise<{ ok: true }>;
  /**
   * 立即发送一条待发送消息（中断其所属会话的运行并直接发出该条）。
   * index 为队列位置；expectedQueueKey 为移动端所见的队列定位键
   * （SnowRemoteState.pendingQueueKey，原样回传），桌面端按“直接命中 →
   * 槽位迁移映射”解析队列真实位置并从该队列执行（会话隔离）。
   */
  sendPendingNow: (
    index: number,
    expectedQueueKey: string | null,
  ) => Promise<{ ok: true }>;
  /**
   * 撤回一条待发送消息（从队列移除）。index 为队列位置；
   * expectedQueueKey 语义同 sendPendingNow。返回原始编码文本，
   * 供调用端恢复到输入区。
   */
  withdrawPending: (
    index: number,
    expectedQueueKey: string | null,
  ) => Promise<{ ok: true; text: string }>;
  newChat: () => Promise<{ ok: true }>;
  /** 复用真实模式 setter 链；enabled=false 时关闭该模式。 */
  setMode: (mode: SnowRemoteModeId, enabled: boolean) => Promise<{ ok: true }>;
  /**
   * 切换「工具失败自动纠错」应用级开关：复用桌面 PlusMenu 的同一偏好
   * （toolCorrectionPreference），写入 appSettings 并同步渲染层缓存。
   */
  setToolCorrection: (enabled: boolean) => Promise<{ ok: true }>;
  select: (
    conversationId: string,
    directoryId?: string,
  ) => Promise<{ ok: true }>;
  approve: (authorizationId: string) => Promise<{ ok: true }>;
  reject: (authorizationId: string, reason?: string) => Promise<{ ok: true }>;
  answer: (
    questionId: string,
    selectedOptions: string[],
    customAnswers: string[],
  ) => Promise<{ ok: true }>;
  cancelQuestion: (questionId: string) => Promise<{ ok: true }>;
  /** 复用真实 handleSelectModel setter 链（会话级模型选择）。 */
  setModel: (modelId: string) => Promise<{ ok: true }>;
  /** 复用真实 handleSelectApiProfile setter 链（会话级 Profile 绑定）。 */
  setApiProfile: (profileName: string) => Promise<{ ok: true }>;
  /** 复用真实 handleSelectThinking setter 链；"" = 继承 Profile 默认。 */
  setThinking: (value: string) => Promise<{ ok: true }>;
  /**
   * 复用真实 handleSelectResponsesFastMode setter 链。
   * desired 为 "off" | "fast" | "ultrafast" 时按目标档位幂等处理
   * （已一致则不再切换）。
   */
  toggleResponsesFastMode: (desired: string) => Promise<{ ok: true }>;
  /** 按真实 createChatCommands 产物执行指令（含禁用状态校验）。 */
  runCommand: (id: string) => Promise<{ ok: true }>;
};
