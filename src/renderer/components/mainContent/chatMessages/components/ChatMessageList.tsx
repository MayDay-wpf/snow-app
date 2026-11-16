import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GitFork, Zap } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { ChatStreamIndicator } from "./ChatStreamIndicator";
import { VirtualizedMessage } from "./VirtualizedMessage";
import { TurnWorkBlock } from "./TurnWorkBlock";
import type { ChatConversationMessage } from "../utils/conversationTypes";
import type { ChatRunStats } from "../utils/types";
import { parseMessageTime } from "../utils/toolActivitySummary";
import { useToolCardStyle } from "../../../../utils/toolCardStyle";
import { useViewportVirtualization } from "../hooks/useViewportVirtualization";
import { useChatConversationContext } from "./ChatConversationContext";
import {
  directoryIdToPath,
  resolveConversationWorkspacePath,
} from "../utils/conversationHelpers";
import { openHtmlArtifact } from "./openHtmlArtifact";
import {
  HtmlArtifactOpenProvider,
  type HtmlArtifactOpenHandler,
} from "./HtmlArtifactOpenContext";
import { useChatStyle } from "../../../sidebar/themeSettings/chatStyleStore";

type ChatMessageListProps = {
  messages: ChatConversationMessage[];
  isStreaming: boolean;
  isAborting: boolean;
  isRunActive: boolean;
  canRollback: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** 平滑增长视口的回调 ref（由滚动跟随控制器持有平滑器）。 */
  streamViewportRef: (node: HTMLDivElement | null) => void;
};

// 初始可见窗口大小:挂载时(切换会话)只渲染「顶部几条 + 底部窗口」的
// 真实内容,避免首帧同步全量渲染大会话阻塞主线程。窗口按可见消息计数
// (跳过 tool 消息),数值取小足够覆盖首屏 + 初始定位到底部后的视口。
const INITIAL_VIRTUAL_HEAD_COUNT = 3;
const INITIAL_VIRTUAL_WINDOW_SIZE = 24;

type TurnWorkItem = {
  message: ChatConversationMessage;
  index: number;
};

type TurnWork = {
  /** 本轮仍在生成：标题显示进行中，内容保持展开。 */
  live: boolean;
  durationMs: number | null;
  toolCount: number;
  hasError: boolean;
  /** 本轮的中间响应（不含最终回答）。 */
  items: TurnWorkItem[];
  /** 中间响应里有待授权工具：强制展开，避免授权卡片被折叠。 */
  forceOpen: boolean;
};

type TurnFolding = {
  /** 中间响应的 renderKey -> 所属轮次 key（轮次 key 即首条中间响应的 renderKey） */
  workKeys: Map<string, string>;
  /** 轮次 key -> 折叠块数据 */
  blocks: Map<string, TurnWork>;
};

export const ChatMessageList = ({
  messages,
  isStreaming,
  isAborting,
  isRunActive,
  canRollback,
  scrollContainerRef,
  streamViewportRef,
}: ChatMessageListProps): React.JSX.Element => {
  const { locale, t } = useI18n();
  const {
    activeConversationId,
    conversationDirectoryId,
    conversationWorktreeMode,
    conversationWorktreeId,
    isLoadingInitialHistory,
    sessionViewKey,
    handleForkConversation,
    handleSelectConversation,
    handleRollback,
    rollbackPreparingMessageId,
    forkedFromConversationId,
    forkMessageCount,
    pendingToolAuthorizations,
    approveToolAuthorization,
    approveToolAuthorizationAlways,
    rejectToolAuthorization,
    updateSessionMessages,
    visionAnalysis,
    triggeredByTask,
    conversationTokenUsage,
    lastRunDurationMs,
    conversationTtftSumMs,
    conversationRequestCount,
  } = useChatConversationContext();

  const artifactBinding = useMemo(
    () => ({
      conversationId: activeConversationId,
      directoryId: conversationDirectoryId,
      worktreeMode: conversationWorktreeMode,
      worktreeId: conversationWorktreeId,
      ready:
        Boolean(activeConversationId && conversationDirectoryId) &&
        conversationWorktreeMode !== undefined &&
        !isLoadingInitialHistory,
    }),
    [
      activeConversationId,
      conversationDirectoryId,
      conversationWorktreeMode,
      conversationWorktreeId,
      isLoadingInitialHistory,
      sessionViewKey,
    ],
  );
  const [resolvedArtifactWorkspace, setResolvedArtifactWorkspace] = useState<{
    binding: typeof artifactBinding;
    path: string | undefined;
  }>();
  useEffect(() => {
    if (!artifactBinding.ready || !artifactBinding.conversationId) return;
    let cancelled = false;
    void resolveConversationWorkspacePath(
      artifactBinding.conversationId,
      artifactBinding.directoryId,
      directoryIdToPath(artifactBinding.directoryId),
      artifactBinding.worktreeMode,
      artifactBinding.worktreeId,
    ).then(
      (path) => {
        if (!cancelled)
          setResolvedArtifactWorkspace({ binding: artifactBinding, path });
      },
      () => {
        // Invalid/missing WorkTree bindings must never fall back to the project root.
        if (!cancelled)
          setResolvedArtifactWorkspace({
            binding: artifactBinding,
            path: undefined,
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [artifactBinding]);
  // Invalidate synchronously on a switch, before passive effects can read an old file.
  const artifactWorkspace =
    resolvedArtifactWorkspace?.binding === artifactBinding
      ? resolvedArtifactWorkspace.path
      : undefined;
  // HTML 文件统一交给内置浏览器打开，会话流里不再渲染预览卡片。
  const artifactOpen = useCallback<HtmlArtifactOpenHandler>(
    (rawPath) => openHtmlArtifact(rawPath, artifactWorkspace),
    [artifactWorkspace],
  );
  const artifactOpenValue = useMemo(
    () => ({ open: artifactOpen }),
    [artifactOpen],
  );

  const lastAssistantMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return messages[i];
      }
    }
    return undefined;
  }, [messages]);
  const lastAssistantMessageId = lastAssistantMessage?.id;
  const isLastAssistantRetrying = Boolean(lastAssistantMessage?.isRetrying);

  // IM 风格：每条用户 / AI 消息（含每轮 loop）都显示头像
  const chatStyle = useChatStyle();

  // The fork divider should appear after the fork point (the messages
  // copied from the source conversation), not after all messages.
  // forkMessageCount records how many messages were copied at fork time.
  // Rendered messages exclude tool-role messages, so we need to count
  // visible messages up to that point.
  const forkDividerIndex = useMemo(() => {
    if (
      !forkedFromConversationId ||
      forkMessageCount === undefined ||
      forkMessageCount <= 0
    ) {
      return -1;
    }
    // Count visible (non-tool) messages. forkMessageCount counts all
    // DB messages including tool messages, but tool messages are filtered
    // out during rendering. We iterate the messages array and find the
    // index after the Nth visible message.
    let visibleCount = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") continue;
      visibleCount++;
      if (visibleCount === forkMessageCount) {
        return i + 1; // divider goes after this message
      }
    }
    // If there are fewer visible messages than forkMessageCount (e.g.
    // tool messages reduced the count), place divider at the end.
    return messages.length;
  }, [forkedFromConversationId, forkMessageCount, messages]);

  const showForkDivider =
    forkDividerIndex >= 0 && forkDividerIndex < messages.length;

  // Stable callback: MessageContent is memoized, so every prop must keep a
  // stable reference or the memo bail-out never triggers.
  const handleFork = useCallback(
    (conversationId: string, upToResponseId: string): void => {
      void handleForkConversation(conversationId, upToResponseId);
    },
    [handleForkConversation],
  );

  const handleForkLinkClick = (): void => {
    if (forkedFromConversationId) {
      void handleSelectConversation(forkedFromConversationId);
    }
  };

  const renderForkDivider = (): React.JSX.Element => (
    <div className="chat-fork-divider">
      <span className="chat-fork-divider-line" />
      <button
        type="button"
        className="chat-fork-divider-link"
        onClick={handleForkLinkClick}
      >
        <GitFork size={13} strokeWidth={1.8} />
        <span>
          {t("chat.forkedFromConversation", {
            defaultValue: "Forked from conversation",
          })}
        </span>
      </button>
      <span className="chat-fork-divider-line" />
    </div>
  );

  // 渲染 key：消息的 React key 与虚拟化身份。id 迁移（首轮响应落库后用户
  // 消息的临时 id 被替换为数据库 id，见 remapPersistedUserMessageIds）不得
  // 改变它——否则整条消息卸载重挂，Markdown 重新异步渲染、图片重新解码，
  // 表现为该消息在响应结束时闪一下。这里把迁移后的 id 映射回首次出现时的
  // id，并跨渲染累积（后续消息对象即使不再携带 idRemappedFrom 也保持不变）。
  // DOM 上的 data-message-id 仍为真实消息 id（UserMessageRail 按库 id 定位）。
  const renderKeysRef = useRef(new Map<string, string>());
  const renderKeys = useMemo(() => {
    const keys = renderKeysRef.current;
    for (const message of messages) {
      const from = message.idRemappedFrom;
      if (from && !keys.has(message.id)) {
        keys.set(message.id, keys.get(from) ?? from);
      }
    }
    return keys;
  }, [messages]);
  const renderKeyOf = useCallback(
    (id: string): string => renderKeys.get(id) ?? id,
    [renderKeys],
  );

  // Pinned message ids: the streaming (last assistant) message must always be
  // rendered so the live output is never unmounted, and any message carrying a
  // pending tool authorization must stay mounted so the approval dialog is not
  // unmounted while waiting for the user.
  const pinnedIds = useMemo(() => {
    const pinned = new Set<string>();
    if (lastAssistantMessageId) {
      pinned.add(renderKeyOf(lastAssistantMessageId));
    }
    for (const msg of messages) {
      const hasPendingAuth =
        msg.role === "assistant" &&
        msg.toolCalls?.some(
          (tc) => tc.authorizationConversationId === activeConversationId,
        );
      if (hasPendingAuth) {
        pinned.add(renderKeyOf(msg.id));
      }
    }
    return pinned;
  }, [activeConversationId, lastAssistantMessageId, messages, renderKeyOf]);

  // 极简模式：每轮除最终回答外的中间响应收进一个折叠块，
  // 标题行常驻（生成中显示进行中），结束后只把内容以高度过渡收起。
  const isMinimalTranscript = useToolCardStyle() === "minimal";
  const [turnOpenOverrides, setTurnOpenOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map<string, boolean>());
  const toggleTurn = useCallback((turnKey: string, next: boolean): void => {
    setTurnOpenOverrides((prev) => {
      const map = new Map(prev);
      map.set(turnKey, next);
      return map;
    });
  }, []);

  const turnFolding = useMemo<TurnFolding | null>(() => {
    if (!isMinimalTranscript) {
      return null;
    }
    const runActive = isStreaming || isRunActive || isAborting;
    const workKeys = new Map<string, string>();
    const blocks = new Map<string, TurnWork>();
    const collect = (
      start: number,
      end: number,
      userTime: number | null,
      isLastTurn: boolean,
    ): void => {
      const assistants: TurnWorkItem[] = [];
      for (let i = start; i < end; i++) {
        if (messages[i].role === "assistant") {
          assistants.push({ message: messages[i], index: i });
        }
      }
      if (assistants.length < 2) {
        return;
      }
      const turnKey = renderKeyOf(assistants[0].message.id);
      const live = isLastTurn && runActive;

      // 待授权工具必须露出来，不能被折叠挡住。
      let forceOpen = false;
      for (const { message } of assistants) {
        for (const toolCall of message.toolCalls ?? []) {
          if (toolCall.authorizationConversationId === activeConversationId) {
            forceOpen = true;
          }
        }
      }

      // 生成中被用户手动收起：后续追加的输出也一并收进折叠块（含正在流式的
      // 这条），否则收起后新的步骤仍会冒在块外面。
      const collapsedLive =
        live && !forceOpen && turnOpenOverrides.get(turnKey) === false;
      const work = collapsedLive ? assistants : assistants.slice(0, -1);
      for (const item of work) {
        workKeys.set(renderKeyOf(item.message.id), turnKey);
      }

      let toolCount = 0;
      let hasError = false;
      for (const { message } of work) {
        if (message.status === "error") {
          hasError = true;
        }
        for (const toolCall of message.toolCalls ?? []) {
          toolCount++;
          if (toolCall.status === "error") {
            hasError = true;
          }
        }
      }
      const endTime = parseMessageTime(
        assistants[assistants.length - 1].message.timestamp,
      );
      blocks.set(turnKey, {
        live,
        durationMs:
          live || userTime === null || endTime === null || endTime <= userTime
            ? null
            : endTime - userTime,
        toolCount,
        hasError,
        items: work,
        forceOpen,
      });
    };
    let start = 0;
    let userTime: number | null = null;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "user") {
        continue;
      }
      // 首条用户消息之前的前缀是翻页裁切出的半轮，保持展开不折叠
      if (i > 0) {
        collect(start, i, userTime, false);
      }
      start = i + 1;
      userTime = parseMessageTime(messages[i].timestamp);
    }
    collect(start, messages.length, userTime, true);
    return { workKeys, blocks };
  }, [
    isMinimalTranscript,
    isStreaming,
    isRunActive,
    isAborting,
    messages,
    renderKeyOf,
    activeConversationId,
    turnOpenOverrides,
  ]);

  // 挂载时的初始可见窗口(仅当列表大到窗口无法覆盖全部时才起作用):
  // 切换会话后 chat-area 整体重建,新 ChatMessageList 挂载时若以
  // visibleIds === null 起步,首次提交会同步全量渲染整个消息列表
  // (运行中的大会话可达数百毫秒),阻塞渲染进程主线程,期间 loading
  // 旋转与骨架屏脉冲等 CSS 动画全部冻结。这里直接以「顶部几条 + 底部
  // 窗口 + 固定消息」作为起始可见集,其余消息首帧即为占位符;
  // IntersectionObserver 的首次报告会把估算集合替换为真实相交集合。
  //
  // 该集合只被 useViewportVirtualization 的 useState 初始化读取一次，
  // 因此按首帧快照计算，避免每个流式帧做一次 O(消息数) 的无用重建。
  const initialVisibleIdsRef = useRef<ReadonlySet<string> | null | undefined>(
    undefined,
  );
  if (initialVisibleIdsRef.current === undefined) {
    initialVisibleIdsRef.current = (() => {
      if (messages.length === 0) {
        return null;
      }
      const ids = new Set<string>();
      let headCount = 0;
      for (
        let i = 0;
        i < messages.length && headCount < INITIAL_VIRTUAL_HEAD_COUNT;
        i++
      ) {
        if (messages[i].role === "tool") continue;
        headCount++;
        ids.add(renderKeyOf(messages[i].id));
      }
      let tailCount = 0;
      for (
        let i = messages.length - 1;
        i >= 0 && tailCount < INITIAL_VIRTUAL_WINDOW_SIZE;
        i--
      ) {
        if (messages[i].role === "tool") continue;
        tailCount++;
        ids.add(renderKeyOf(messages[i].id));
      }
      for (const id of pinnedIds) {
        ids.add(id);
      }
      return ids;
    })();
  }
  const initialVisibleIds = initialVisibleIdsRef.current;

  // eager 可见集：传给虚拟化 hook，让翻页（loadOlder）往顶部插入的新消息
  // 前缀在 IntersectionObserver 首批报告前就以真实内容挂载（见
  // useViewportVirtualization 的 forceVisible 机制）——若新页先以 80px
  // 占位符存在，ChatContent 的翻页滚动恢复按占位符几何校正必然偏小，新内容
  // 涌入后再把视口内容往下挤，观感就是「被挤下去」。
  // 判定基准是「与上一轮渲染 key 集合的差集」中的顶部连续新增段；id 迁移的
  // 消息渲染 key 不变，不会被误判为新增。
  const [eagerVisibleIds, setEagerVisibleIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const prevRenderKeysRef = useRef<ReadonlySet<string> | null>(null);
  useLayoutEffect(() => {
    if (messages.length === 0) {
      return;
    }
    const prevRenderKeys = prevRenderKeysRef.current;
    prevRenderKeysRef.current = new Set(
      messages.map((message) => renderKeyOf(message.id)),
    );
    // 首次挂载不产出 eager 集合：初始窗口由 initialVisibleIds 控制，
    // 全量 eager 会废掉大会话首帧的虚拟化优化。
    if (prevRenderKeys === null) {
      return;
    }
    const eager = new Set<string>();
    for (const message of messages) {
      const key = renderKeyOf(message.id);
      if (prevRenderKeys.has(key)) {
        break;
      }
      eager.add(key);
    }
    if (eager.size > 0) {
      setEagerVisibleIds(eager);
    }
  }, [messages, renderKeyOf]);

  const virtualization = useViewportVirtualization(
    scrollContainerRef,
    pinnedIds,
    initialVisibleIds,
    eagerVisibleIds,
  );

  // Intermediate status card shown while the backend describes user images
  // with the external vision model (textify pass). Lives at the end of the
  // message list, above the input area; disappears on the final done/error
  // event. Fixed min-height keeps the virtualization scrollbar stable.
  const renderVisionStatusCard = (): React.JSX.Element | null => {
    if (
      !visionAnalysis ||
      (visionAnalysis.phase !== "describing" &&
        visionAnalysis.phase !== "cached")
    ) {
      return null;
    }
    return (
      <div className="chat-vision-status" role="status">
        <span className="chat-vision-status-spinner" aria-hidden="true" />
        <span className="chat-vision-status-text">
          {t("chat.visionAnalyzing", {
            defaultValue: "Analyzing images with vision model…",
          })}
        </span>
        <span className="chat-vision-status-progress">
          {visionAnalysis.index}/{visionAnalysis.total}
        </span>
        {visionAnalysis.model ? (
          <span
            className="chat-vision-status-model"
            title={visionAnalysis.model}
          >
            {visionAnalysis.model}
          </span>
        ) : null}
      </div>
    );
  };

  // Informational banner shown when the active conversation was created by a
  // scheduled task firing: which task triggered it and when. Rendered above
  // the first message so the origin of the conversation is always visible.
  const renderTriggeredByTaskBanner = (): React.JSX.Element | null => {
    if (!triggeredByTask) {
      return null;
    }
    let timeLabel = "";
    const ms = Date.parse(triggeredByTask.triggeredAt);
    if (!Number.isNaN(ms)) {
      timeLabel = new Date(ms).toLocaleTimeString(locale);
    }
    return (
      <div className="chat-task-triggered-banner" role="note">
        <Zap size={12} strokeWidth={1.9} aria-hidden="true" />
        <span className="chat-task-triggered-text">
          {t("chat.triggeredByTask", {
            defaultValue: "Triggered by scheduled task: {{name}}",
            values: { name: triggeredByTask.name },
          })}
        </span>
        {timeLabel && (
          <span className="chat-task-triggered-time">{timeLabel}</span>
        )}
      </div>
    );
  };

  // 单条消息的渲染（虚拟化包裹 + 消息内容）；极简模式的轮次折叠块复用同一份。
  const renderMessageNode = (
    message: ChatConversationMessage,
    index: number,
  ): React.JSX.Element | null => {
    // Tool messages return null; render an empty placeholder so React keeps
    // stable keys across renders.
    if (message.role === "tool") {
      return <div className="chat-message-hidden" />;
    }

    // 新一轮回复刚挂上、尚未收到任何内容的 assistant 占位：真实渲染只是一个
    // 零高度节点，却仍占轨道的 flex gap，把视口下方的流式指示槽提前顶下一截。
    // 收到首个内容前同样以隐藏占位渲染（display: none 不参与 gap），内容到达后
    // 才挂载真实消息。任何一项可见内容存在时都照常渲染，不做隐藏。
    const isEmptyPendingAssistant =
      message.role === "assistant" &&
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
      );
    if (isEmptyPendingAssistant) {
      return <div className="chat-message-hidden" />;
    }

    const className = `chat-message-group ${
      message.status ? `is-${message.status}` : ""
    }`.trim();

    const imAvatarPath =
      chatStyle.imMode && !message.isContextCompaction
        ? message.role === "user"
          ? chatStyle.userAvatarPath
          : chatStyle.aiAvatarPath
        : undefined;

    return (
      <VirtualizedMessage
        id={renderKeyOf(message.id)}
        itemIndex={index}
        itemClassName={className}
        virtualization={virtualization}
        imAvatarPath={imAvatarPath}
        message={message}
        artifactWorkspace={artifactWorkspace}
        runStats={runStats}
        isStreaming={isStreaming}
        lastAssistantMessageId={lastAssistantMessageId}
        activeConversationId={activeConversationId}
        updateSessionMessages={updateSessionMessages}
        canRollback={canRollback}
        rollbackPreparingMessageId={rollbackPreparingMessageId}
        pendingToolAuthorizations={pendingToolAuthorizations}
        onRollback={handleRollback}
        onFork={handleFork}
        onApproveToolAuthorization={approveToolAuthorization}
        onApproveToolAuthorizationAlways={approveToolAuthorizationAlways}
        onRejectToolAuthorization={rejectToolAuthorization}
      />
    );
  };

  // Keep the fork divider outside virtualization so it is always present when
  // visible (it is a single small node and never needs height preservation).
  const renderItem = (
    message: ChatConversationMessage,
    index: number,
  ): React.JSX.Element | null => {
    const renderKey = renderKeyOf(message.id);
    const turnKey = turnFolding?.workKeys.get(renderKey);
    const block = turnKey ? turnFolding?.blocks.get(turnKey) : undefined;

    // 轮次折叠块：首条中间响应位置渲染整块（标题行 + 中间过程），
    // 其余中间响应不再单独占位。
    if (block && turnKey) {
      if (turnKey !== renderKey) {
        return null;
      }
      // 手动开合优先；未手动时进行中的轮次展开，其余收起。
      const override = turnOpenOverrides.get(turnKey);
      const expanded = block.forceOpen || (override ?? block.live);
      return (
        <TurnWorkBlock
          key={renderKey}
          live={block.live}
          durationMs={block.durationMs}
          stepCount={block.items.length}
          toolCount={block.toolCount}
          hasError={block.hasError}
          expanded={expanded}
          onToggle={() => toggleTurn(turnKey, !expanded)}
        >
          {block.items.map((item) => (
            <Fragment key={renderKeyOf(item.message.id)}>
              {renderMessageNode(item.message, item.index)}
            </Fragment>
          ))}
        </TurnWorkBlock>
      );
    }

    if (turnKey) {
      return null;
    }

    return (
      <Fragment key={renderKey}>{renderMessageNode(message, index)}</Fragment>
    );
  };

  // 会话累计运行统计：只在流程完全结束后计算，挂到最后一条 AI 响应的操作栏。
  const runStats = useMemo<ChatRunStats | null>(() => {
    if (isStreaming || isAborting || isRunActive) {
      return null;
    }
    const hasActiveGeneration = messages.some(
      (message) =>
        message.status === "sending" ||
        (message.role === "assistant" &&
          message.toolCalls?.some(
            (toolCall) =>
              toolCall.status === "pending" || toolCall.status === "running",
          )),
    );
    if (hasActiveGeneration) {
      return null;
    }
    if (!messages.some((message) => message.role === "assistant")) {
      return null;
    }
    // 旧版本会话没有统计数据，宁可不展示也不显示不完整的值。
    const usage = conversationTokenUsage;
    const hasStats =
      lastRunDurationMs > 0 ||
      (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) > 0 ||
      (usage?.cacheReadInputTokens ?? 0) > 0 ||
      (usage?.cacheCreationInputTokens ?? 0) > 0 ||
      conversationRequestCount > 0;
    if (!hasStats) {
      return null;
    }
    let model: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].model) {
        model = messages[i].model;
        break;
      }
    }
    return {
      durationMs: lastRunDurationMs,
      ttftSumMs: conversationTtftSumMs,
      requestCount: conversationRequestCount,
      tokenUsage: usage,
      model,
    };
  }, [
    messages,
    isStreaming,
    isAborting,
    isRunActive,
    conversationTokenUsage,
    lastRunDurationMs,
    conversationTtftSumMs,
    conversationRequestCount,
  ]);

  // 消息区分两层：平滑视口（轨道内是全部消息流内容，高度由
  // streamGrowthSmoother 平滑过渡）+ 视口之外的会话级流式指示槽。
  // 指示槽不随内容增长移动，始终停在可视底部。
  return (
    <HtmlArtifactOpenProvider value={artifactOpenValue}>
      <div className="chat-message-list">
        <div className="chat-message-viewport" ref={streamViewportRef}>
          <div className="chat-message-track">
            {renderTriggeredByTaskBanner()}
            {showForkDivider ? (
              <>
                {messages
                  .slice(0, forkDividerIndex)
                  .map((message, index) => renderItem(message, index))}
                {renderForkDivider()}
                {messages
                  .slice(forkDividerIndex)
                  .map((message, index) =>
                    renderItem(message, forkDividerIndex + index),
                  )}
              </>
            ) : (
              <>
                {messages.map((message, index) => renderItem(message, index))}
                {forkDividerIndex === messages.length &&
                forkedFromConversationId
                  ? renderForkDivider()
                  : null}
              </>
            )}
            {renderVisionStatusCard()}
          </div>
        </div>
        <ChatStreamIndicator
          active={isStreaming}
          isAborting={isAborting}
          isRetrying={isLastAssistantRetrying}
        />
      </div>
    </HtmlArtifactOpenProvider>
  );
};
