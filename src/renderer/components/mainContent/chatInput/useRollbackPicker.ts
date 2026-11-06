import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { UserMessageSummary } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { isImeComposing } from "../../../../shared/imeKeyboard";
import { useChatConversationContext } from "../chatMessages";
import {
  ensureMessageLoaded,
  type MessageLoadBudget,
} from "../chatMessages/utils/conversationHelpers";
import { stripMarkdown } from "../../../../shared/stripMarkdown";
import {
  getChipDisplayLabel,
  parseContentSegments,
  summarizeContentAsPlainText,
  type ContentSegment,
} from "./fileTagUtils";
import type { RollbackTargetItem } from "./RollbackTargetPopup";

/** 双击判定窗口：两次 ESC 的间隔超过该值即视为两次独立按键。 */
const DOUBLE_ESCAPE_WINDOW_MS = 500;
/** 列表预览保留的最大字符数。 */
const PREVIEW_MAX_LENGTH = 160;
/** 预览里每个 chip 的固定开销（图标、内边距、间距）折算的字符数。 */
const CHIP_PREVIEW_OVERHEAD = 6;
/**
 * 桌面定位历史目标的预算：比跨页默认值宽松——长会话（压缩前上千条）也要能
 * 回滚到很早的一轮。等待期间列表显示行内 loading，Esc 可随时取消。
 */
const TARGET_LOAD_BUDGET: MessageLoadBudget = {
  maxPages: 150,
  timeoutMs: 30_000,
};

/**
 * 单行预览：先把 @@file:...@@ / @@change:...@@ / @@image:...@@ 等 chip 标签
 * 折叠为可读文本（文件名、行号、图片名、摘要等），再剥离 Markdown、折叠
 * 空白并截断。直接消费标签原文会把路径与 base64 编码串暴露在列表里。
 */
const buildPreview = (content: string): string => {
  const plain = stripMarkdown(summarizeContentAsPlainText(content))
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PREVIEW_MAX_LENGTH
    ? `${plain.slice(0, PREVIEW_MAX_LENGTH)}…`
    : plain;
};

/**
 * 预览片段：文本段落剥离 Markdown 并折叠空白；chip 段落保留结构，由
 * RollbackTargetPopup 用共享的 ContentChips 渲染成消息区同款 chip。
 *
 * 累计显示长度超过 PREVIEW_MAX_LENGTH 时截断文本并丢弃其后片段（chip 按显示
 * 名长度 + 固定开销估算），保证列表行内容不会无限增长。
 */
const buildPreviewSegments = (content: string): ContentSegment[] => {
  const segments: ContentSegment[] = [];
  let used = 0;
  for (const segment of parseContentSegments(content)) {
    if (used >= PREVIEW_MAX_LENGTH) {
      break;
    }
    if (segment.type === "text") {
      const text = stripMarkdown(segment.content).replace(/\s+/g, " ").trim();
      if (!text) {
        continue;
      }
      const budget = PREVIEW_MAX_LENGTH - used;
      const clipped = text.length > budget ? `${text.slice(0, budget)}…` : text;
      used += clipped.length;
      segments.push({ type: "text", content: clipped });
    } else {
      used += getChipDisplayLabel(segment).length + CHIP_PREVIEW_OVERHEAD;
      segments.push(segment);
    }
  }
  return segments;
};

/** 某个会话的全量用户消息快照（与快照所属会话 id 绑定，避免跨会话串用）。 */
type UserMessageSnapshot = {
  conversationId: string;
  rows: UserMessageSummary[];
};

type UseRollbackPickerOptions = {
  /** 子代理 / Workflow 节点会话不支持回滚（与 ChatMessageList 的 canRollback 同源）。 */
  enabled: boolean;
  /**
   * 加载更早一页历史消息（保留聊天视口锚点）。会话历史按页加载，目标消息
   * 可能落在已加载窗口之外，此时先把它加载进内存再回滚。
   */
  loadOlderMessages: () => Promise<void>;
};

export type RollbackPicker = {
  isOpen: boolean;
  /** 倒序排列（最新在最上）的可回滚消息列表。 */
  targets: RollbackTargetItem[];
  selectedIndex: number;
  /** 全量列表仍在读取中。 */
  isLoadingTargets: boolean;
  /** 正在把选中的目标加载进内存窗口（显示行内 loading）。 */
  preparingMessageId: string | null;
  /** 目标过旧、无法加载进内存窗口时的提示。 */
  loadError: string | null;
  containerRef: RefObject<HTMLDivElement | null>;
  /** 返回 true 表示事件已被列表消费，调用方不应继续处理。 */
  handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => boolean;
  /** 直接回滚到指定消息（点击列表项）。 */
  select: (messageId: string) => void;
};

/**
 * 双击 ESC 打开「回滚到历史消息」列表，↑/↓ 选择 + Enter 确认。
 *
 * 列表数据源是数据库里的全量用户消息（含压缩摘要边界），与 UserMessageRail
 * 同一条轻量查询（仅 id/content/created_at/status），按会话 id + 会话版本号
 * 预取——而不是用内存消息窗口：分页加载让窗口只覆盖最新一页，窗口里甚至可能
 * 一条用户消息都没有，用它既列不全也会让列表在历史未加载时打不开。
 *
 * 选中目标若仍在窗口之外，先沿 loadOlderMessages 把它加载进内存（带视口锚点
 * 恢复），再走既有的 handleRollback（检查点清单与截断边界都以内存窗口为基准）。
 *
 * 与全局快捷键的关系：
 * - 首次 ESC 不被消费，保持既有的「中断会话」语义（cancelSession）。
 * - 有 Pending 时 ESC 先收回待发送消息（ChatInputView 接管），同样不计入双击判定。
 * - 列表打开时挂 `data-esc-panel`，快捷键引擎据此跳过 ESC 的中断动作；
 *   列表自身接管 ↑/↓/Enter/Esc。
 * - 其它 ESC 面板（@ 提及 / 命令面板）打开时，ESC 属于它们，不计入双击判定。
 * - 运行中（流式 / 中止中）或已有待确认回滚时不打开列表。
 */
export const useRollbackPicker = ({
  enabled,
  loadOlderMessages,
}: UseRollbackPickerOptions): RollbackPicker => {
  const { t } = useI18n();
  const {
    messages,
    activeConversationId,
    conversationVersion,
    hasMoreMessages,
    handleRollback,
    rollbackPreparingMessageId,
    rollbackPreview,
    isStreaming,
    isAborting,
    pendingMessages,
  } = useChatConversationContext();

  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [snapshot, setSnapshot] = useState<UserMessageSnapshot | null>(null);
  const [isLoadingTargets, setIsLoadingTargets] = useState(false);
  const [preparingMessageId, setPreparingMessageId] = useState<string | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // -Infinity：页面刚打开时也不会把第一次 ESC 误判成「第二次」。
  const lastEscapeAtRef = useRef(Number.NEGATIVE_INFINITY);
  /** 跨页加载中的目标：防止 Enter 连点重复发起。 */
  const preparingRef = useRef(false);
  /** 面板关闭 / 用户取消后，正在进行的跨页加载立即作废。 */
  const cancelledRef = useRef(false);
  // 加载循环与判定逻辑要读最新值，但不必为它们重建回调闭包。
  const messagesRef = useRef(messages);
  const hasMoreMessagesRef = useRef(hasMoreMessages);
  messagesRef.current = messages;
  hasMoreMessagesRef.current = hasMoreMessages;
  /** 已取到快照的会话 id：判断是否需要显示首次加载态（避免把 ref 依赖塞进 effect）。 */
  const snapshotConversationIdRef = useRef<string | null>(null);

  // 与 UserMessageRail 相同的数据源与刷新时机：会话切换、每次会话版本变化
  // （发送 / 回滚 / 压缩 / 翻页）都重取一次全量用户消息。查询只读四列且按
  // role 过滤，长会话也足够轻；这样列表在打开前就已就绪，打开动作本身不再
  // 依赖内存窗口里是否恰好有用户消息。
  useEffect(() => {
    if (!activeConversationId) {
      snapshotConversationIdRef.current = null;
      setSnapshot(null);
      setIsLoadingTargets(false);
      return;
    }

    let cancelled = false;
    // 已有该会话的快照时不闪 loading（版本刷新是静默的）。
    if (snapshotConversationIdRef.current !== activeConversationId) {
      setIsLoadingTargets(true);
    }

    window.snow
      .listUserMessages(activeConversationId)
      .then((rows) => {
        if (!cancelled) {
          snapshotConversationIdRef.current = activeConversationId;
          setSnapshot({ conversationId: activeConversationId, rows });
        }
      })
      .catch(() => {
        // 读取失败：保留内存窗口兜底，不阻塞打开列表。
        if (!cancelled) {
          setSnapshot((current) =>
            current?.conversationId === activeConversationId ? current : null,
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingTargets(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId, conversationVersion]);

  // 可回滚目标：全量用户消息（含压缩摘要边界）+ 内存窗口里尚未落库的消息
  // （新建会话的首条消息、刚发送还未持久化的消息）。正序编号后倒序展示，
  // 默认选中最新一条，向上翻阅更早的历史。
  const targets = useMemo<RollbackTargetItem[]>(() => {
    const seen = new Set<string>();
    const items: RollbackTargetItem[] = [];
    const push = (
      id: string,
      content: string,
      isContextCompaction: boolean,
    ): void => {
      if (!id || seen.has(id)) {
        return;
      }
      seen.add(id);
      items.push({
        id,
        ordinal: items.length + 1,
        segments: buildPreviewSegments(content),
        preview: buildPreview(content),
        isContextCompaction,
      });
    };

    const rows =
      snapshot && snapshot.conversationId === activeConversationId
        ? snapshot.rows
        : null;
    if (rows) {
      for (const row of rows) {
        push(row.id, row.content, row.isContextCompaction);
      }
    }
    for (const message of messages) {
      if (message.role !== "user") {
        continue;
      }
      const isContextCompaction = message.isContextCompaction === true;
      if (!isContextCompaction && message.content.trim().length === 0) {
        continue;
      }
      push(message.id, message.content, isContextCompaction);
    }

    return items.reverse();
  }, [activeConversationId, messages, snapshot]);

  // 打开条件只看「能不能回滚」，不看列表长度：历史尚未加载完时也要能打开，
  // 打开后列表会随全量查询返回自动填充。
  const canOpen =
    enabled &&
    !isStreaming &&
    !isAborting &&
    !rollbackPreparingMessageId &&
    !rollbackPreview;

  const close = useCallback((): void => {
    lastEscapeAtRef.current = Number.NEGATIVE_INFINITY;
    cancelledRef.current = true;
    setLoadError(null);
    setIsOpen(false);
  }, []);

  const select = useCallback(
    (messageId: string): void => {
      if (preparingRef.current) {
        return;
      }
      preparingRef.current = true;
      cancelledRef.current = false;
      setLoadError(null);
      setPreparingMessageId(messageId);

      void (async () => {
        try {
          // 目标可能仍在分页窗口之外：先加载进内存窗口，否则 handleRollback
          // 找不到它而静默失败（截断边界与回滚后的消息列表都以内存窗口为准）。
          const isReady = await ensureMessageLoaded(
            messageId,
            {
              isLoaded: (targetId) =>
                messagesRef.current.some((message) => message.id === targetId),
              hasMoreMessages: () => hasMoreMessagesRef.current,
              getLoadedCount: () => messagesRef.current.length,
              loadOlderMessages,
              isCancelled: () => cancelledRef.current,
            },
            TARGET_LOAD_BUDGET,
          );
          if (cancelledRef.current) {
            return;
          }
          if (!isReady) {
            setLoadError(t("rollbackPicker.loadFailed"));
            return;
          }
          lastEscapeAtRef.current = Number.NEGATIVE_INFINITY;
          setIsOpen(false);
          handleRollback(messageId);
        } finally {
          preparingRef.current = false;
          setPreparingMessageId((current) =>
            current === messageId ? null : current,
          );
        }
      })();
    },
    [handleRollback, loadOlderMessages, t],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): boolean => {
      if (isImeComposing(event)) {
        return false;
      }

      if (isOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          return true;
        }
        // 跨页加载期间吞掉导航按键：此时选中项已提交，方向键/回车均无意义。
        if (preparingRef.current) {
          return true;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, targets.length - 1));
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          return true;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const target = targets[selectedIndex];
          if (target) {
            select(target.id);
          }
          return true;
        }
        return false;
      }

      if (event.key !== "Escape") {
        return false;
      }

      // ESC 两侧的其它语义先于清单：运行中属于「中断会话」，其它 ESC 面板
      // （@ 提及 / 命令面板）属于它们自己，都不计入双击判定。
      if (isStreaming || isAborting) {
        lastEscapeAtRef.current = Number.NEGATIVE_INFINITY;
        return false;
      }
      // 有 Pending 时 ESC 属于「收回待发送消息」，不计入双击判定。
      if (pendingMessages.length > 0) {
        lastEscapeAtRef.current = Number.NEGATIVE_INFINITY;
        return false;
      }
      if (document.querySelector("[data-esc-panel]") !== null) {
        lastEscapeAtRef.current = Number.NEGATIVE_INFINITY;
        return false;
      }

      const now = performance.now();
      const isDoublePress =
        now - lastEscapeAtRef.current <= DOUBLE_ESCAPE_WINDOW_MS;
      lastEscapeAtRef.current = isDoublePress ? Number.NEGATIVE_INFINITY : now;
      if (!isDoublePress || !canOpen) {
        return false;
      }

      event.preventDefault();
      cancelledRef.current = false;
      setLoadError(null);
      setSelectedIndex(0);
      setIsOpen(true);
      return true;
    },
    [
      canOpen,
      close,
      isAborting,
      isOpen,
      isStreaming,
      pendingMessages.length,
      select,
      selectedIndex,
      targets,
    ],
  );

  // 列表打开后运行状态 / 会话身份变化（例如远控发起新一轮）时强制收起，
  // 避免停留在已失效的目标列表上。
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (
      isStreaming ||
      isAborting ||
      !enabled ||
      rollbackPreparingMessageId ||
      rollbackPreview
    ) {
      close();
    }
  }, [
    close,
    enabled,
    isAborting,
    isOpen,
    isStreaming,
    rollbackPreview,
    rollbackPreparingMessageId,
  ]);

  // 点击列表外部收起（与 @ 提及面板同一交互约定）。
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleDocumentMouseDown = (event: MouseEvent): void => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        close();
      }
    };
    document.addEventListener("mousedown", handleDocumentMouseDown);
    return () =>
      document.removeEventListener("mousedown", handleDocumentMouseDown);
  }, [close, isOpen]);

  return {
    isOpen,
    targets,
    selectedIndex,
    isLoadingTargets,
    preparingMessageId,
    loadError,
    containerRef,
    handleKeyDown,
    select,
  };
};
