import type {
  ChatConversationMessage,
  HookExecutionRecord,
  ToolCallInfo,
} from "../utils/conversationTypes";

/**
 * 极简模式的展示行（独立于经典 / 简洁两条路径）。
 *
 * 极简模式会把「一条有正文的 AI 回复 + 其后所有无正文回复的工具」合并成
 * 一个集合。若仍以「一条消息」为虚拟化单元，集合会变成几千像素的不可测
 * 巨块，分页插入时高度无法预测。这里把极简 transcript 展平成行：
 * 用户消息、正文、工具集合标题、同名工具组标题、单个工具、授权宿主、分叉线
 * 各自成行，每行独立测量与占位。
 */
export type MinimalToolGroupKind = "gallery" | "question";

type MinimalRowBase = {
  /** 虚拟化与 React key（稳定，不随分页变化）。 */
  key: string;
  /** 滚动锚点依赖的 DOM data-message-id（divider 行为空串）。 */
  messageId: string;
  /** 消息渲染 key（临时 id 迁移后保持不变）。 */
  renderKey: string;
};

export type MinimalUserRow = MinimalRowBase & {
  kind: "user";
  message: ChatConversationMessage;
};

export type MinimalResponseRow = MinimalRowBase & {
  kind: "response";
  message: ChatConversationMessage;
  isLastAssistant: boolean;
  showActions: boolean;
  /** 本条响应之后是否存在工具集合（决定是否单独显示完成时间）。 */
  hasToolCalls: boolean;
  /** 极简模式：本条代管的、被隐藏的最后一条响应。 */
  runTailId?: string;
  runTailResponseId?: string;
  runTailIsSending?: boolean;
  /** 未绑定到具体工具卡的 hook 记录，渲染在正文之后。 */
  footerHookExecutions: HookExecutionRecord[];
};

export type MinimalToolRunHeaderRow = MinimalRowBase & {
  kind: "tool-run-header";
  toolCalls: ToolCallInfo[];
  expanded: boolean;
};

export type MinimalSameRunHeaderRow = MinimalRowBase & {
  kind: "same-run-header";
  toolCalls: ToolCallInfo[];
  expanded: boolean;
};

export type MinimalToolGroupRow = MinimalRowBase & {
  kind: "tool-group";
  groupKind: MinimalToolGroupKind;
  toolCalls: ToolCallInfo[];
};

export type MinimalToolRow = MinimalRowBase & {
  kind: "tool";
  toolCall: ToolCallInfo;
  /** 工具调用原本所属的消息 id（合并集合时可能不是锚点消息）。 */
  ownerMessageId?: string;
  hookExecutions?: HookExecutionRecord[];
};

export type MinimalAuthorizationRow = MinimalRowBase & {
  kind: "authorization";
};

export type MinimalDividerRow = MinimalRowBase & {
  kind: "divider";
};

export type MinimalRow =
  | MinimalUserRow
  | MinimalResponseRow
  | MinimalToolRunHeaderRow
  | MinimalSameRunHeaderRow
  | MinimalToolGroupRow
  | MinimalToolRow
  | MinimalAuthorizationRow
  | MinimalDividerRow;
