import type {
  ChatConversationMessage,
  HookExecutionRecord,
  ToolCallInfo,
} from "../utils/conversationTypes";
import type { ToolCallRun } from "../utils/types";
import { needsVisibleToolCard } from "../utils/toolCallInteraction";
import type { MinimalRow, MinimalToolGroupKind } from "./types";

const ASK_TOOL_NAME = "user-interaction-askUserQuestion";
const IMAGE_TOOL_NAME = "imagegen-generate";

type MinimalToolEntry =
  | { type: "single"; toolCall: ToolCallInfo }
  | { type: "sameRun"; toolCalls: ToolCallInfo[] }
  | {
      type: "group";
      groupKind: MinimalToolGroupKind;
      toolCalls: ToolCallInfo[];
    };

const groupMinimalTools = (
  toolCalls: readonly ToolCallInfo[],
): MinimalToolEntry[] => {
  const entries: MinimalToolEntry[] = [];
  for (let index = 0; index < toolCalls.length;) {
    const name = toolCalls[index].name;
    if (name === IMAGE_TOOL_NAME || name === ASK_TOOL_NAME) {
      let end = index;
      while (end < toolCalls.length && toolCalls[end].name === name) {
        end += 1;
      }
      if (end - index >= 2) {
        entries.push({
          type: "group",
          groupKind: name === ASK_TOOL_NAME ? "question" : "gallery",
          toolCalls: toolCalls.slice(index, end),
        });
      } else {
        entries.push({ type: "single", toolCall: toolCalls[index] });
      }
      index = end;
      continue;
    }
    // 归属只按工具名判断，不掺「是否等待用户处理」这类易变状态：否则新工具
    // 会先以单行出现在集合外，状态落定后再被收进集合，记录会当场抖一下。
    // 需要用户处理的成员由所属集合强制展开来保证可见（见 buildToolRows）。
    let end = index + 1;
    while (end < toolCalls.length && toolCalls[end].name === name) {
      end += 1;
    }
    const sameRun = toolCalls.slice(index, end);
    entries.push(
      sameRun.length > 1
        ? { type: "sameRun", toolCalls: sameRun }
        : { type: "single", toolCall: sameRun[0] },
    );
    index = end;
  }
  return entries;
};

export type BuildMinimalRowsInput = {
  messages: readonly ChatConversationMessage[];
  /** renderKey(锚点消息) -> 该正文之后的工具集合。 */
  runs: ReadonlyMap<string, ToolCallRun>;
  /** 整条隐藏的响应 renderKey（内容已并入其他集合）。 */
  hidden: ReadonlySet<string>;
  /** 最后一条 AI 响应被隐藏时，代它承载授权的锚点 renderKey。 */
  tailHost: string | null;
  renderKeyOf: (id: string) => string;
  lastAssistantMessage?: ChatConversationMessage;
  lastAssistantMessageId?: string;
  isStreaming: boolean;
  activeConversationId?: string;
  pendingToolAuthorizations: readonly ToolCallInfo[];
  hiddenMessageId?: string;
  forkDividerIndex: number;
  forkedFromConversationId?: string;
  /** 承载授权弹窗的 renderKey（tailHost 或最后一条响应）。 */
  authorizationHostKey: string | null;
  isRowExpanded: (key: string, fallback: boolean) => boolean;
  /** 用户点击交互过的行 key：同组工具因此默认展开，查看中的内容不被收起。 */
  interactedRowKeys: ReadonlySet<string>;
};

/**
 * 把极简 transcript 展平成可独立测量、可独立卸载的行。
 *
 * 行 key 只依赖消息 / 工具 id，不依赖索引；分页插入更早的历史时已有行
 * 的身份不变，高度缓存可以继续命中。
 */
export const buildMinimalRows = ({
  messages,
  runs,
  hidden,
  tailHost,
  renderKeyOf,
  lastAssistantMessage,
  lastAssistantMessageId,
  isStreaming,
  activeConversationId,
  pendingToolAuthorizations,
  hiddenMessageId,
  forkDividerIndex,
  forkedFromConversationId,
  authorizationHostKey,
  isRowExpanded,
  interactedRowKeys,
}: BuildMinimalRowsInput): MinimalRow[] => {
  const rows: MinimalRow[] = [];
  const pushDivider = (): void => {
    rows.push({
      kind: "divider",
      key: "minimal-fork-divider",
      messageId: "",
      renderKey: "minimal-fork-divider",
    });
  };

  const isEmptyPendingAssistant = (
    message: ChatConversationMessage,
  ): boolean => {
    if (message.role !== "assistant") return false;
    return (
      message.status === "sending" &&
      !message.content &&
      !message.thinking &&
      !message.isRetrying &&
      !message.failureReason &&
      !message.toolCalls?.length &&
      !message.hookExecutions?.length &&
      !(
        message.id === lastAssistantMessageId &&
        pendingToolAuthorizations.some(
          (toolCall) =>
            toolCall.authorizationConversationId === activeConversationId,
        )
      )
    );
  };

  const buildToolRows = (
    anchorRenderKey: string,
    anchorMessageId: string,
    run: ToolCallRun,
  ): void => {
    const headerKey = `minimal-tools:${anchorRenderKey}`;
    const headerExpanded = isRowExpanded(headerKey, true);
    rows.push({
      kind: "tool-run-header",
      key: headerKey,
      messageId: anchorMessageId,
      renderKey: anchorRenderKey,
      toolCalls: run.toolCalls,
      expanded: headerExpanded,
    });
    if (!headerExpanded) return;

    const hooksByInteractionId = new Map<string, HookExecutionRecord[]>();
    for (const record of run.hookExecutions ?? []) {
      if (!record.toolCallInteractionId) continue;
      const list = hooksByInteractionId.get(record.toolCallInteractionId);
      if (list) {
        list.push(record);
      } else {
        hooksByInteractionId.set(record.toolCallInteractionId, [record]);
      }
    }

    // 工具行身份只取 interactionId：新调用导致重新分组或锚点迁移时 key 不变，
    // React 复用原组件实例，用户已展开的卡片内容不会被重置。
    const toolRowKey = (toolCall: ToolCallInfo): string =>
      `minimal-tool:${toolCall.interactionId}`;

    const pushToolRow = (toolCall: ToolCallInfo, depth: 1 | 2): void => {
      rows.push({
        kind: "tool",
        key: toolRowKey(toolCall),
        messageId: anchorMessageId,
        renderKey: anchorRenderKey,
        depth,
        toolCall,
        ownerMessageId:
          run.messageIds.get(toolCall.interactionId) ?? anchorMessageId,
        hookExecutions: hooksByInteractionId.get(toolCall.interactionId),
      });
    };

    for (const entry of groupMinimalTools(run.toolCalls)) {
      if (entry.type === "single") {
        pushToolRow(entry.toolCall, 1);
        continue;
      }
      if (entry.type === "group") {
        rows.push({
          kind: "tool-group",
          key: `minimal-tool-group:${anchorRenderKey}:${entry.toolCalls[0].interactionId}`,
          messageId: anchorMessageId,
          renderKey: anchorRenderKey,
          depth: 1,
          groupKind: entry.groupKind,
          toolCalls: entry.toolCalls,
        });
        continue;
      }
      const sameRunKey = `minimal-same-run:${anchorRenderKey}:${entry.toolCalls[0].interactionId}`;
      // 用户在组内展开查看过工具时，组默认展开：新到的同名调用只会在下方
      // 追加行，不会把正在查看的卡片一起吞进折叠组。用户手动开合仍然优先。
      const viewingInGroup = entry.toolCalls.some((toolCall) =>
        interactedRowKeys.has(toolRowKey(toolCall)),
      );
      // 卡片本身要交互（内联提问 / 共享 / 工作流 / 交互式终端）时强制展开，
      // 折叠不会把等待操作的卡片藏起来；待授权弹窗由授权行承载，不在此列。
      const awaitingUser = entry.toolCalls.some(needsVisibleToolCard);
      const sameRunExpanded =
        isRowExpanded(sameRunKey, viewingInGroup) || awaitingUser;
      rows.push({
        kind: "same-run-header",
        key: sameRunKey,
        messageId: anchorMessageId,
        renderKey: anchorRenderKey,
        depth: 1,
        toolCalls: entry.toolCalls,
        expanded: sameRunExpanded,
      });
      if (sameRunExpanded) {
        for (const toolCall of entry.toolCalls) {
          pushToolRow(toolCall, 2);
        }
      }
    }
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (forkDividerIndex >= 0 && index === forkDividerIndex) {
      pushDivider();
    }
    if (hiddenMessageId && message.id === hiddenMessageId) continue;
    if (message.role === "tool") continue;

    const renderKey = renderKeyOf(message.id);
    if (hidden.has(renderKey)) continue;
    if (isEmptyPendingAssistant(message)) continue;

    if (message.role === "user") {
      rows.push({
        kind: "user",
        key: `minimal-user:${renderKey}`,
        messageId: message.id,
        renderKey,
        message,
      });
      continue;
    }

    // 极简分组里每条未隐藏的 AI 回复都是一个锚点：可能有正文，也可能只有
    // 工具（agent 一轮里直接调工具、不说话）。无正文的锚点同样要输出它的
    // 工具集合与尾部，不能整条跳过。
    const run = runs.get(renderKey);
    const effectiveToolCalls = run ? run.toolCalls : (message.toolCalls ?? []);
    const hasBody = message.content.trim().length > 0;
    const hostsRunTail = tailHost === renderKey;
    const isLastAssistant =
      message.id === lastAssistantMessageId || hostsRunTail;
    const runTailIsSending =
      hostsRunTail && lastAssistantMessage?.status === "sending";
    const isMessageStreaming =
      message.status === "sending" || Boolean(runTailIsSending);
    const hasToolCalls = effectiveToolCalls.length > 0;
    const isActiveRunTail = isLastAssistant && isStreaming;
    const showActions =
      !isMessageStreaming &&
      !isActiveRunTail &&
      (!hasToolCalls || isLastAssistant);

    const boundInteractionIds = new Set(
      effectiveToolCalls.map((toolCall) => toolCall.interactionId),
    );
    const sourceHooks = run ? run.hookExecutions : message.hookExecutions;
    const footerHookExecutions = (sourceHooks ?? []).filter(
      (record) =>
        !record.toolCallInteractionId ||
        !boundInteractionIds.has(record.toolCallInteractionId),
    );

    const anchorStart = rows.length;

    // 1. 正文（含错误提示）
    if (hasBody || message.status === "error") {
      rows.push({
        kind: "response",
        key: `minimal-response:${renderKey}`,
        messageId: message.id,
        renderKey,
        message,
      });
    }

    // 2. 工具集合
    if (run && run.toolCalls.length > 0) {
      buildToolRows(renderKey, message.id, run);
    }

    // 3. 授权弹窗宿主
    if (authorizationHostKey === renderKey) {
      rows.push({
        kind: "authorization",
        key: `minimal-authorization:${renderKey}`,
        messageId: message.id,
        renderKey,
      });
    }

    // 4. 尾部：提示、插件页脚、操作栏
    rows.push({
      kind: "response-tail",
      key: `minimal-response-tail:${renderKey}`,
      messageId: message.id,
      renderKey,
      message,
      isLastAssistant,
      showActions,
      hasToolCalls,
      runTailId: hostsRunTail ? lastAssistantMessage?.id : undefined,
      runTailResponseId: hostsRunTail
        ? lastAssistantMessage?.responseId
        : undefined,
      runTailIsSending,
      footerHookExecutions,
    });

    rows[anchorStart].groupStart = true;
  }

  if (forkDividerIndex === messages.length && forkedFromConversationId) {
    pushDivider();
  }

  return rows;
};
