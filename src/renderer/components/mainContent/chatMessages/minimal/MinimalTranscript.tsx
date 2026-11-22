import { useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import type {
  ChatConversationMessage,
  ConversationContextValue,
  ToolCallInfo,
} from "../utils/conversationTypes";
import type { ToolCallRun, ChatRunStats } from "../utils/types";
import { MinimalRow } from "./MinimalRow";
import { MinimalRowContent } from "./MinimalRowContent";
import { buildMinimalRows } from "./buildMinimalRows";
import { useMinimalRowVirtualization } from "./useMinimalRowVirtualization";

/** 首次挂载的初始可见窗口：底部这段 + 顶部两条，避免大会话首帧全量渲染。 */
const INITIAL_VISIBLE_TAIL_ROWS = 16;
const INITIAL_VISIBLE_HEAD_ROWS = 2;

type MinimalChatStyle = {
  imMode: boolean;
  aiAvatarPath: string;
  userAvatarPath: string;
};

export type MinimalTranscriptProps = {
  messages: readonly ChatConversationMessage[];
  /** renderKey(锚点消息) -> 该正文之后的工具集合。 */
  runs: ReadonlyMap<string, ToolCallRun>;
  /** 整条隐藏的响应 renderKey。 */
  hidden: ReadonlySet<string>;
  /** 最后一条 AI 响应被隐藏时，代它承载授权的锚点 renderKey。 */
  tailHost: string | null;
  renderKeyOf: (id: string) => string;
  lastAssistantMessage?: ChatConversationMessage;
  lastAssistantMessageId?: string;
  isStreaming: boolean;
  canRollback: boolean;
  rollbackPreparingMessageId: string | null;
  activeConversationId?: string;
  artifactWorkspace?: string;
  pendingToolAuthorizations: readonly ToolCallInfo[];
  updateSessionMessages: ConversationContextValue["updateSessionMessages"];
  runStats: ChatRunStats | null;
  hiddenMessageId?: string;
  forkDividerIndex: number;
  forkedFromConversationId?: string;
  authorizationHostKey: string | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  chatStyle: MinimalChatStyle;
  onRollback: (messageId: string) => void;
  onFork: (conversationId: string, upToResponseId: string) => void;
  onApproveToolAuthorization: (toolCall: ToolCallInfo) => void;
  onApproveToolAuthorizationAlways: (toolCall: ToolCallInfo) => void;
  onRejectToolAuthorization: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
  renderForkDivider: () => React.JSX.Element;
};

/**
 * 极简模式专用 transcript。
 *
 * 独立于经典 / 简洁路径：先展平成行，再做行级虚拟化。工具集合的展开
 * 状态、行高度缓存、占位与滚动锚点全部由极简列表自己管理，不与消息级
 * 虚拟化（useViewportVirtualization）互相耦合。
 */
export const MinimalTranscript = ({
  messages,
  runs,
  hidden,
  tailHost,
  renderKeyOf,
  lastAssistantMessage,
  lastAssistantMessageId,
  isStreaming,
  canRollback,
  rollbackPreparingMessageId,
  activeConversationId,
  artifactWorkspace,
  pendingToolAuthorizations,
  updateSessionMessages,
  runStats,
  hiddenMessageId,
  forkDividerIndex,
  forkedFromConversationId,
  authorizationHostKey,
  scrollContainerRef,
  chatStyle,
  onRollback,
  onFork,
  onApproveToolAuthorization,
  onApproveToolAuthorizationAlways,
  onRejectToolAuthorization,
  renderForkDivider,
}: MinimalTranscriptProps): React.JSX.Element => {
  // 工具集合 / 同名工具组的开合状态：由列表层持有，行被虚拟化卸载后
  // 再回来仍是用户上次的选择。
  const [expandedRows, setExpandedRows] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [interactedKeys, setInteractedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const isRowExpanded = useCallback(
    (key: string, fallback: boolean): boolean =>
      expandedRows.get(key) ?? fallback,
    [expandedRows],
  );

  const toggleRow = useCallback((key: string, fallback: boolean): void => {
    setExpandedRows((previous) => {
      const next = new Map(previous);
      next.set(key, !(previous.get(key) ?? fallback));
      return next;
    });
  }, []);

  const pinRow = useCallback((key: string): void => {
    setInteractedKeys((previous) => {
      if (previous.has(key)) return previous;
      const next = new Set(previous);
      next.add(key);
      return next;
    });
  }, []);

  // 原始 Markdown 开关：按回复 renderKey 记录，正文行显示、尾部行的
  // 操作栏切换，两行共享同一状态。
  const [rawMarkdownKeys, setRawMarkdownKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleRawMarkdown = useCallback((renderKey: string): void => {
    setRawMarkdownKeys((previous) => {
      const next = new Set(previous);
      if (next.has(renderKey)) {
        next.delete(renderKey);
      } else {
        next.add(renderKey);
      }
      return next;
    });
  }, []);

  const rows = useMemo(
    () =>
      buildMinimalRows({
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
      }),
    [
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
    ],
  );

  // 必须常驻挂载的行：授权宿主、最后一条回复的尾部（操作栏 / 统计）、
  // 用户点过的行（工具卡内部展开状态不因虚拟化丢失），以及运行中当前
  // 这条回复的全部行——新工具从流式平滑视口的裁剪边缘逐帧露出，若按
  // 几何判定会在露出的那一帧还是空白占位。
  const pinnedKeys = useMemo(() => {
    const keys = new Set<string>(interactedKeys);
    let lastTailKey: string | null = null;
    for (const row of rows) {
      if (row.kind === "authorization") {
        keys.add(row.key);
      }
      if (row.kind === "response-tail") {
        lastTailKey = row.key;
      }
    }
    if (lastTailKey) {
      keys.add(lastTailKey);
    }
    const activeRenderKey = isStreaming ? rows.at(-1)?.renderKey : undefined;
    if (activeRenderKey) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row.renderKey !== activeRenderKey) break;
        keys.add(row.key);
      }
    }
    return keys;
  }, [rows, interactedKeys, isStreaming]);

  const initialVisibleKeysRef = useRef<ReadonlySet<string> | null>(null);
  if (initialVisibleKeysRef.current === null && rows.length > 0) {
    const keys = new Set<string>();
    for (const row of rows.slice(-INITIAL_VISIBLE_TAIL_ROWS)) {
      keys.add(row.key);
    }
    for (const row of rows.slice(0, INITIAL_VISIBLE_HEAD_ROWS)) {
      keys.add(row.key);
    }
    for (const key of pinnedKeys) {
      keys.add(key);
    }
    initialVisibleKeysRef.current = keys;
  }

  const virtualization = useMinimalRowVirtualization(
    scrollContainerRef,
    rows,
    pinnedKeys,
    initialVisibleKeysRef.current,
  );

  return (
    <div className="minimal-rows">
      {rows.map((row) => {
        const visible =
          row.kind === "divider" || virtualization.isVisible(row.key);
        // IM 风格：用户行带用户头像；每条 AI 回复的第一行（正文，或无正文
        // 时的工具集合标题）带 AI 头像，其余行与正文列对齐。
        const imRole =
          !chatStyle.imMode || row.kind === "divider"
            ? null
            : row.kind === "user"
              ? "user"
              : row.groupStart
                ? "assistant"
                : null;
        const continuation =
          chatStyle.imMode &&
          imRole === null &&
          row.kind !== "user" &&
          row.kind !== "divider";
        return (
          <MinimalRow
            key={row.key}
            row={row}
            visible={visible}
            placeholderHeight={virtualization.getPlaceholderHeight(row)}
            imRole={imRole}
            imAvatarPath={
              imRole === "user"
                ? chatStyle.userAvatarPath
                : imRole === "assistant"
                  ? chatStyle.aiAvatarPath
                  : undefined
            }
            continuation={continuation}
            register={virtualization.register}
            onInteract={pinRow}
          >
            <MinimalRowContent
              row={row}
              isStreaming={isStreaming}
              canRollback={canRollback}
              rollbackPreparingMessageId={rollbackPreparingMessageId}
              activeConversationId={activeConversationId}
              artifactWorkspace={artifactWorkspace}
              pendingToolAuthorizations={pendingToolAuthorizations}
              updateSessionMessages={updateSessionMessages}
              runStats={runStats}
              onRollback={onRollback}
              onFork={onFork}
              onApproveToolAuthorization={onApproveToolAuthorization}
              onApproveToolAuthorizationAlways={
                onApproveToolAuthorizationAlways
              }
              onRejectToolAuthorization={onRejectToolAuthorization}
              onToggleRow={toggleRow}
              rawMarkdown={rawMarkdownKeys.has(row.renderKey)}
              onToggleRawMarkdown={toggleRawMarkdown}
              renderForkDivider={renderForkDivider}
            />
          </MinimalRow>
        );
      })}
    </div>
  );
};
