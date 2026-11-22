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
import { MinimalTranscript } from "../minimal/MinimalTranscript";
import type { ChatConversationMessage } from "../utils/conversationTypes";
import type { ChatRunStats, ToolCallRun } from "../utils/types";
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
  /** 不渲染的消息 id（子代理首条提示词已由信息头展示）。 */
  hiddenMessageId?: string;
};

// 初始可见窗口大小:挂载时(切换会话)只渲染「顶部几条 + 底部窗口」的
// 真实内容,避免首帧同步全量渲染大会话阻塞主线程。窗口按可见消息计数
// (跳过 tool 消息),数值取小足够覆盖首屏 + 初始定位到底部后的视口。
const INITIAL_VIRTUAL_HEAD_COUNT = 3;
const INITIAL_VIRTUAL_WINDOW_SIZE = 24;

/** 极简分支在 layout 尚未就绪时的空集合（保持引用稳定）。 */
const EMPTY_TOOL_RUNS: ReadonlyMap<string, ToolCallRun> = new Map();
const EMPTY_HIDDEN_KEYS: ReadonlySet<string> = new Set();

type MinimalLayout = {
  /** renderKey(锚点消息) -> 该正文之后的工具集合。 */
  runs: Map<string, ToolCallRun>;
  /** 整条隐藏的响应 renderKey（没有正文，内容已并入其他集合）。 */
  hidden: Set<string>;
  /** 最后一条 AI 响应被隐藏时，代它承载授权弹窗的锚点 renderKey。 */
  tailHost: string | null;
};

type RunCacheEntry = {
  sources: ChatConversationMessage[];
  run: ToolCallRun;
};

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

export const ChatMessageList = ({
  messages,
  isStreaming,
  isAborting,
  isRunActive,
  canRollback,
  scrollContainerRef,
  streamViewportRef,
  hiddenMessageId,
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

  // 极简模式：按「消息 -> AI 正文 -> 工具集合 -> AI 正文 -> 工具集合」排列。
  // 一条正文之后、下一条正文出现之前的所有工具（可能跨多条无正文的响应）
  // 合并成一个集合，挂在正文所在消息上；无正文的响应整条隐藏。
  const isMinimalTranscript = useToolCardStyle() === "minimal";
  // 历史轮的集合缓存：来源消息引用不变时复用同一个集合对象，避免流式期间
  // 击穿历史消息的 memo。
  const runCacheRef = useRef(new Map<string, RunCacheEntry>());
  // 极简模式的分组边界：本窗口首次渲染时的最早一条消息。加载更早的历史时
  // 边界之后（已渲染部分）的分组必须保持不变——否则窗口顶部那段没有正文的
  // 工具集合会被并入新页的正文块，从视口里整段搬走：总高度几乎不变（滚动
  // 锚定无从补偿），视口内容却一下跳过一整个集合的高度，观感就是「记录跳了
  // 一大段」。边界只在窗口重置（会话切换、头部裁剪、消息被删）时重建。
  const minimalBoundaryRef = useRef<{
    headId: string | null;
    boundaryId: string | null;
  }>({ headId: null, boundaryId: null });
  useEffect(() => {
    runCacheRef.current = new Map();
    minimalBoundaryRef.current = { headId: null, boundaryId: null };
  }, [activeConversationId]);

  const minimalLayout = useMemo<MinimalLayout | null>(() => {
    if (!isMinimalTranscript) {
      return null;
    }
    const boundaryState = minimalBoundaryRef.current;
    const headId = messages[0]?.id ?? null;
    if (headId !== boundaryState.headId) {
      const previousHeadIndex = boundaryState.headId
        ? messages.findIndex((message) => message.id === boundaryState.headId)
        : -1;
      // 旧首条仍在列表中部 = 顶部插入（翻页）；沿用既有边界。旧边界已被裁剪
      // 时退回到旧首条——它正是本轮新页的上一个起点。其余情况（首条未变、
      // 窗口整体重建）都以当前首条重建边界。
      if (previousHeadIndex > 0) {
        const boundaryStillPresent =
          boundaryState.boundaryId !== null &&
          messages.some((message) => message.id === boundaryState.boundaryId);
        if (!boundaryStillPresent) {
          boundaryState.boundaryId = boundaryState.headId;
        }
      } else {
        boundaryState.boundaryId = headId;
      }
      boundaryState.headId = headId;
    }
    const boundaryId = boundaryState.boundaryId;
    const runs = new Map<string, ToolCallRun>();
    const hidden = new Set<string>();
    const cache = runCacheRef.current;
    const nextCache = new Map<string, RunCacheEntry>();

    let anchorKey: string | null = null;
    let sources: ChatConversationMessage[] = [];
    let current: ToolCallRun | null = null;

    const collectTools = (
      message: ChatConversationMessage,
      run: ToolCallRun,
    ): void => {
      for (const toolCall of message.toolCalls ?? []) {
        run.toolCalls.push(toolCall);
        run.messageIds.set(toolCall.interactionId, message.id);
      }
      if (message.hookExecutions?.length) {
        run.hookExecutions = [
          ...(run.hookExecutions ?? []),
          ...message.hookExecutions,
        ];
      }
    };

    // 结算当前集合；来源消息引用未变时复用缓存里的集合对象。
    const flush = (): void => {
      if (anchorKey && current) {
        const cached = cache.get(anchorKey);
        const reused =
          cached &&
          cached.sources.length === sources.length &&
          cached.sources.every((source, index) => source === sources[index])
            ? cached.run
            : current;
        runs.set(anchorKey, reused);
        nextCache.set(anchorKey, { sources, run: reused });
      }
      anchorKey = null;
      sources = [];
      current = null;
    };

    // 开一个新集合，并把本条响应的工具挂上去。
    const openRun = (message: ChatConversationMessage): void => {
      flush();
      anchorKey = renderKeyOf(message.id);
      sources = [message];
      current = { toolCalls: [], messageIds: new Map<string, string>() };
      collectTools(message, current);
    };

    // 无正文的响应：整条隐藏，工具并入当前集合。
    const mergeIntoRun = (message: ChatConversationMessage): void => {
      hidden.add(renderKeyOf(message.id));
      if (!current) return;
      if (sources[sources.length - 1] !== message) {
        sources.push(message);
      }
      collectTools(message, current);
    };

    let tailHost: string | null = null;
    for (const message of messages) {
      // 窗口边界：更早的历史（翻页新插入的部分）在这里结算，边界及之后的
      // 现场重新从零分组，于是它与上一轮渲染完全一致；不这样切断，边界之前
      // 的工具会被并入边界消息所属的集合，边界消息整条变隐藏、DOM 连同它
      // 承载的工具集合一起从视口搬走。
      if (message.id === boundaryId) {
        flush();
      }
      if (message.role === "user") {
        flush();
        continue;
      }
      if (message.role !== "assistant") {
        continue;
      }
      const hasBody = message.content.trim().length > 0;
      const hasTools = (message.toolCalls?.length ?? 0) > 0;
      if (hasBody || needsOwnRow(message)) {
        openRun(message);
        continue;
      }
      if (!hasTools) {
        // 没有正文也没有工具：极简模式下没有任何可见内容。
        hidden.add(renderKeyOf(message.id));
      } else if (current) {
        mergeIntoRun(message);
      } else {
        openRun(message);
        continue;
      }
      // 最后一条响应被隐藏：授权弹窗改挂到当前集合的锚点上。
      if (message.id === lastAssistantMessageId) {
        tailHost = anchorKey;
      }
    }
    flush();

    runCacheRef.current = nextCache;
    return { runs, hidden, tailHost };
  }, [isMinimalTranscript, messages, lastAssistantMessageId, renderKeyOf]);

  // 授权弹窗宿主：默认是最后一条 AI 响应，极简模式下它被隐藏时由锚点代管。
  const authorizationHostKey =
    minimalLayout?.tailHost ??
    (lastAssistantMessageId ? renderKeyOf(lastAssistantMessageId) : null);

  // 最后一条 AI 响应（流式输出）与授权弹窗宿主必须常驻挂载，
  // 避免等待用户处理期间被虚拟化卸载。
  const pinnedIds = useMemo(() => {
    const pinned = new Set<string>();
    if (lastAssistantMessageId) {
      pinned.add(renderKeyOf(lastAssistantMessageId));
    }
    if (authorizationHostKey) {
      pinned.add(authorizationHostKey);
    }
    return pinned;
  }, [authorizationHostKey, lastAssistantMessageId, renderKeyOf]);

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

  // 单条消息的渲染（虚拟化包裹 + 消息内容）。
  const renderMessageNode = (
    message: ChatConversationMessage,
    index: number,
    toolRun?: ToolCallRun,
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

    const renderKey = renderKeyOf(message.id);
    // 代管被隐藏的最后一条响应：只往下传派生标量，流式期间引用不变，
    // 锚点消息的 memo 才不会被逐 token 击穿。
    const hostsRunTail = minimalLayout?.tailHost === renderKey;
    return (
      <VirtualizedMessage
        id={renderKey}
        itemIndex={index}
        itemClassName={className}
        visible={
          virtualization.visibleIds === null ||
          virtualization.visibleIds.has(renderKey)
        }
        heights={virtualization.heights}
        register={virtualization.register}
        imAvatarPath={imAvatarPath}
        message={message}
        toolRun={toolRun}
        artifactWorkspace={artifactWorkspace}
        runStats={runStats}
        isStreaming={isStreaming}
        lastAssistantMessageId={lastAssistantMessageId}
        activeConversationId={activeConversationId}
        updateSessionMessages={updateSessionMessages}
        canRollback={canRollback}
        rollbackPreparingMessageId={rollbackPreparingMessageId}
        pendingToolAuthorizations={pendingToolAuthorizations}
        hostsPendingAuthorizations={renderKey === authorizationHostKey}
        runTailId={hostsRunTail ? lastAssistantMessage?.id : undefined}
        runTailResponseId={
          hostsRunTail ? lastAssistantMessage?.responseId : undefined
        }
        runTailIsSending={
          hostsRunTail && lastAssistantMessage?.status === "sending"
        }
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
    if (hiddenMessageId && message.id === hiddenMessageId) {
      return null;
    }
    // 极简模式：无正文的响应已并入相邻的工具集合，不再单独占位。
    if (minimalLayout?.hidden.has(renderKey)) {
      return null;
    }
    return (
      <Fragment key={renderKey}>
        {renderMessageNode(message, index, minimalLayout?.runs.get(renderKey))}
      </Fragment>
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
            {isMinimalTranscript ? (
              <MinimalTranscript
                messages={messages}
                runs={minimalLayout?.runs ?? EMPTY_TOOL_RUNS}
                hidden={minimalLayout?.hidden ?? EMPTY_HIDDEN_KEYS}
                tailHost={minimalLayout?.tailHost ?? null}
                renderKeyOf={renderKeyOf}
                lastAssistantMessage={lastAssistantMessage}
                lastAssistantMessageId={lastAssistantMessageId}
                isStreaming={isStreaming}
                canRollback={canRollback}
                rollbackPreparingMessageId={rollbackPreparingMessageId}
                activeConversationId={activeConversationId}
                artifactWorkspace={artifactWorkspace}
                pendingToolAuthorizations={pendingToolAuthorizations}
                updateSessionMessages={updateSessionMessages}
                runStats={runStats}
                hiddenMessageId={hiddenMessageId}
                forkDividerIndex={forkDividerIndex}
                forkedFromConversationId={forkedFromConversationId}
                authorizationHostKey={authorizationHostKey}
                scrollContainerRef={scrollContainerRef}
                chatStyle={chatStyle}
                onRollback={handleRollback}
                onFork={handleFork}
                onApproveToolAuthorization={approveToolAuthorization}
                onApproveToolAuthorizationAlways={
                  approveToolAuthorizationAlways
                }
                onRejectToolAuthorization={rejectToolAuthorization}
                renderForkDivider={renderForkDivider}
              />
            ) : showForkDivider ? (
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
