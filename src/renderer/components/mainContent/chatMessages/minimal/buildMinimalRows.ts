import type {
  ChatConversationMessage,
  HookExecutionRecord,
  ToolCallInfo,
} from "../utils/conversationTypes";
import type { ToolCallRun } from "../utils/types";
import {
  hasPendingUserInteraction,
  isAwaitingUserAction,
} from "../utils/toolCallInteraction";
import type {
  MinimalRow,
  MinimalToolGroupKind,
} from "./types";

const ASK_TOOL_NAME = "user-interaction-askUserQuestion";
const IMAGE_TOOL_NAME = "imagegen-generate";

type MinimalToolEntry =
  | { type: "single"; toolCall: ToolCallInfo }
  | { type: "sameRun"; toolCalls: ToolCallInfo[] }
  | { type: "group"; groupKind: MinimalToolGroupKind; toolCalls: ToolCallInfo[] };

/** 有独立可见状态的响应必须单独成行，不能被并入工具集合。 */
const needsOwnRow = (message: ChatConversationMessage): boolean => {
  if (message.status === "error" || message.failureReason) return true;
  if (message.isRetrying) return true;
  return Boolean(
    message.incompleteVariant ||
      message.interruptionReason ||
      message.recoveryOutcome,
  );
};

const groupMinimalTools = (
  toolCalls: readonly ToolCallInfo[],
  pendingAuthorizationIds: ReadonlySet<string>,
): MinimalToolEntry[] => {
  const entries: MinimalToolEntry[] = [];
  for (let index = 0; index < toolCalls.length; ) {
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
    // 等待用户处理的交互型工具单独成行，处理完才并入同类折叠列表。
    if (isAwaitingUserAction(toolCalls[index], pendingAuthorizationIds)) {
      entries.push({ type: "single", toolCall: toolCalls[index] });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < toolCalls.length &&
      toolCalls[end].name === name &&
      !isAwaitingUserAction(toolCalls[end], pendingAuthorizationIds)
    ) {
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
}: BuildMinimalRowsInput): MinimalRow[] => {
  const rows: MinimalRow[] = [];
  const pendingAuthorizationIds = new Set(
    pendingToolAuthorizations.map((toolCall) => toolCall.interactionId),
  );
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

    const pushToolRow = (toolCall: ToolCallInfo): void => {
      rows.push({
        kind: "tool",
        key: `minimal-tool:${anchorRenderKey}:${toolCall.interactionId}`,
        messageId: anchorMessageId,
        renderKey: anchorRenderKey,
        toolCall,
        ownerMessageId:
          run.messageIds.get(toolCall.interactionId) ?? anchorMessageId,
        hookExecutions: hooksByInteractionId.get(toolCall.interactionId),
      });
    };

    for (const entry of groupMinimalTools(
      run.toolCalls,
      pendingAuthorizationIds,
    )) {
      if (entry.type === "single") {
        pushToolRow(entry.toolCall);
        continue;
      }
      if (entry.type === "group") {
        rows.push({
          kind: "tool-group",
          key: `minimal-tool-group:${anchorRenderKey}:${entry.toolCalls[0].interactionId}`,
          messageId: anchorMessageId,
          renderKey: anchorRenderKey,
          groupKind: entry.groupKind,
          toolCalls: entry.toolCalls,
        });
        continue;
      }
      const sameRunKey = `minimal-same-run:${anchorRenderKey}:${entry.toolCalls[0].interactionId}`;
      const sameRunExpanded =
        isRowExpanded(sameRunKey, false) ||
        hasPendingUserInteraction(entry.toolCalls);
      rows.push({
        kind: "same-run-header",
        key: sameRunKey,
        messageId: anchorMessageId,
        renderKey: anchorRenderKey,
        toolCalls: entry.toolCalls,
        expanded: sameRunExpanded,
      });
      if (sameRunExpanded) {
        for (const toolCall of entry.toolCalls) {
          pushToolRow(toolCall);
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

    const hasBody = message.content.trim().length > 0;
    if (!hasBody && !needsOwnRow(message)) continue;

    const run = runs.get(renderKey);
    const effectiveToolCalls = run ? run.toolCalls : (message.toolCalls ?? []);
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

    rows.push({
      kind: "response",
      key: `minimal-response:${renderKey}`,
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

    if (authorizationHostKey === renderKey) {
      rows.push({
        kind: "authorization",
        key: `minimal-authorization:${renderKey}`,
        messageId: message.id,
        renderKey,
      });
    }

    if (run && run.toolCalls.length > 0) {
      buildToolRows(renderKey, message.id, run);
    }
  }

  if (forkDividerIndex === messages.length && forkedFromConversationId) {
    pushDivider();
  }

  return rows;
};
