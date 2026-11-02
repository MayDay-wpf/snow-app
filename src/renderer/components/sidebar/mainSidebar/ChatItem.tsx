import {
  Archive,
  Check,
  ChevronRight,
  GitFork,
  Loader2,
  Pause,
  Pin,
  Snowflake,
  Waypoints,
  Workflow,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useI18n } from "../../../i18n";
import type { ChatConversationRecord } from "../../../../preload";
import { Tooltip } from "../../common/Tooltip";
import { useOverlayOpen } from "../../common/useOverlayOpen";
import { isPendingSessionKey } from "../../mainContent/chatMessages/utils/conversationTypes";
import { ChatItemMenu, type ExportFormat } from "./ChatItemMenu";
import { openConversationInNewWindow } from "./openConversationInNewWindow";
import {
  beginConversationDrag,
  endConversationDrag,
  type ConversationDragPayload,
} from "./conversationDrag";
import { setChatDragData } from "./chatDrag";
import { formatTooltipTimeLabel, parseDbTimestamp } from "./chatTimeGroup";
import { useDirectoryInfo } from "./useDirectoryInfo";
import { getDirectoryIcon } from "./WorkspaceDirectoryRow";

/** 悬浮详情延迟：避免鼠标划过列表时不断弹出卡片。 */
const HOVER_TOOLTIP_DELAY = 120;
/** 相邻会话行之间切换的时间窗：窗内进入新行直接显示卡片，不再等待延迟。 */
const ROW_SWITCH_WINDOW = 400;
let lastRowLeaveAt = 0;

/** 焦点变化后浏览器会补发 hover 事件：先有真实指针移动才允许弹出卡片。 */
let pointerMovedSinceFocus = true;
let pointerMoveTracked = false;
const trackPointerMove = (): void => {
  if (pointerMoveTracked) {
    return;
  }
  pointerMoveTracked = true;
  window.addEventListener(
    "pointermove",
    () => {
      pointerMovedSinceFocus = true;
    },
    { capture: true, passive: true },
  );
};

type ChatItemProps = {
  conversation: ChatConversationRecord;
  isActive?: boolean;
  isAttentionRequired?: boolean;
  isStreaming?: boolean;
  /** 流式会话被用户暂停（agent loop 阻塞等待恢复），图标切换为静态暂停态 */
  isPaused?: boolean;
  isCompleted?: boolean;
  /** 运行中（流式/待确认）：多选模式下不参与选择，不渲染复选框 */
  isRunning?: boolean;
  showPinBadge?: boolean;
  subAgentConversations?: ChatConversationRecord[];
  /** 子代理中待用户确认（提问/工具授权）的会话 id 集合 */
  subAgentAttentionRequiredIds?: Set<string>;
  /** Workflow 主会话（创建了 workflow 节点会话），显示特殊图标与树形展开 */
  isWorkflow?: boolean;
  /** 会话树（Workflow 节点 + 子代理）是否已展开：共用同一个展开按钮 */
  isTreeExpanded?: boolean;
  onToggleTree?: () => void;
  isMultiSelectMode?: boolean;
  isSelected?: boolean;
  /** 允许作为拖拽源（拖到置顶区/普通列表区切换置顶状态） */
  isDraggable?: boolean;
  onPin: () => void;
  onRename: (newTitle: string) => Promise<void>;
  /** 确认删除；deleteImages=true 同时级联删除图库图片，deleteMemories=true 同时删除该会话保存的项目记忆 */
  onDelete: (deleteImages: boolean, deleteMemories: boolean) => void;
  onExport: (format: ExportFormat) => void;
  /** 创建分支会话（复制整个会话到新的分支） */
  onFork?: () => void;
  /** 归档会话（置顶会话不传入，不提供归档入口） */
  onArchive?: () => void;
  /** 归档进行中（含 VACUUM 收缩文件阶段）：菜单按钮显示 loading，防止重复操作 */
  isArchiving?: boolean;
  /** 删除进行中：菜单按钮显示 loading，防止重复操作 */
  isDeleting?: boolean;
  onEnterMultiSelect?: () => void;
  onToggleSelect?: (event: React.MouseEvent | React.KeyboardEvent) => void;
  onSelect?: (event: React.MouseEvent | React.KeyboardEvent) => void;
};

export function ChatItem({
  conversation,
  isActive = false,
  isAttentionRequired = false,
  isStreaming = false,
  isPaused = false,
  isCompleted = false,
  isRunning = false,
  showPinBadge = false,
  subAgentConversations = [],
  subAgentAttentionRequiredIds = new Set<string>(),
  isWorkflow = false,
  isTreeExpanded = false,
  isMultiSelectMode = false,
  isSelected = false,
  isDraggable = false,
  onPin,
  onRename,
  onDelete,
  onExport,
  onFork,
  onArchive,
  isArchiving = false,
  isDeleting = false,
  onEnterMultiSelect,
  onToggleSelect,
  onSelect,
  onToggleTree,
}: ChatItemProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [editingValue, setEditingValue] = useState("");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const tooltipTimerRef = useRef<number | null>(null);
  const isSubmittingRef = useRef(false);
  const cancelledRef = useRef(false);
  const [isDragSource, setIsDragSource] = useState(false);
  const directoryInfo = useDirectoryInfo(conversation.directoryId);
  const overlayOpen = useOverlayOpen();

  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [isEditing]);

  const hasSubAgents = subAgentConversations.length > 0;

  const handleRenameStart = (): void => {
    setEditingValue(conversation.summary || conversation.title || "");
    isSubmittingRef.current = false;
    cancelledRef.current = false;
    setIsEditing(true);
  };

  const handleRenameSubmit = async (): Promise<void> => {
    if (isSubmittingRef.current || cancelledRef.current) {
      return;
    }
    isSubmittingRef.current = true;

    const trimmed = editingValue.trim();
    const original = conversation.summary || conversation.title || "";

    if (!trimmed) {
      setEditingValue(original);
      setIsEditing(false);
      isSubmittingRef.current = false;
      return;
    }

    if (trimmed === original) {
      setIsEditing(false);
      isSubmittingRef.current = false;
      return;
    }

    try {
      await onRename(trimmed);
    } finally {
      setIsEditing(false);
      isSubmittingRef.current = false;
    }
  };

  const handleRenameCancel = (): void => {
    cancelledRef.current = true;
    setIsEditing(false);
  };

  const handleRenameKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    // 输入法组合输入中（如中文候选区上屏的 Enter）不触发保存/取消
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void handleRenameSubmit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      handleRenameCancel();
    }
  };

  const isPinned = conversation.status === "pin";
  const hasAttentionRequiredSubAgent = subAgentConversations.some((sub) =>
    subAgentAttentionRequiredIds.has(sub.conversationId),
  );
  const isForked = conversation.forkedFromConversationId !== "";
  const displayName =
    conversation.summary ||
    conversation.title ||
    t("sidebar.untitledChat", { defaultValue: "Untitled" });
  const showAttentionStatus =
    !isMultiSelectMode && (isAttentionRequired || hasAttentionRequiredSubAgent);
  const showStreamingStatus =
    !isMultiSelectMode && !showAttentionStatus && isStreaming;
  // 正在输出（未暂停）的会话标题走流光，与雪花指示器状态一致
  const showTitleShimmer = showStreamingStatus && !isPaused;
  const showCompletedStatus =
    !isMultiSelectMode &&
    !showAttentionStatus &&
    !showStreamingStatus &&
    isCompleted;
  const statusLabel = showAttentionStatus
    ? t("sidebar.chatStatusNeedsAction", { defaultValue: "Needs action" })
    : showCompletedStatus
      ? t("sidebar.chatStatusCompleted", { defaultValue: "Completed" })
      : null;
  const statusDescription = showAttentionStatus
    ? t("sidebar.chatStatusWaitingForReviewOrInput", {
        defaultValue: "Waiting for review or input",
      })
    : (statusLabel ?? "");
  const runningDescription = isPaused
    ? t("sidebar.chatStatusPaused", { defaultValue: "Paused" })
    : t("sidebar.chatStatusRunning", { defaultValue: "Running" });

  const relativeTimeLabel = formatTooltipTimeLabel(
    parseDbTimestamp(conversation.updatedAt),
    locale,
    t,
  );
  // 拖拽、编辑、多选、弹窗和菜单打开期间不显示悬浮详情，避免遮挡操作
  const showHoverTooltip =
    isHovered &&
    !overlayOpen &&
    !isEditing &&
    !isMultiSelectMode &&
    !isDragSource &&
    !isMenuOpen &&
    contextMenuAnchor === null;

  const handleTitleHover = (): void => {
    // 遮罩打开期间不安排显示，否则关闭弹窗后卡片会残留在行旁；
    // 焦点刚变化时浏览器补发的 hover 也不可信，等真实指针移动后再显示。
    if (overlayOpen || !pointerMovedSinceFocus) {
      return;
    }
    if (tooltipTimerRef.current !== null) {
      return;
    }
    // 刚从相邻会话行离开：直接显示，避免行间切换时反复等待延迟
    if (Date.now() - lastRowLeaveAt <= ROW_SWITCH_WINDOW) {
      setIsHovered(true);
      return;
    }
    tooltipTimerRef.current = window.setTimeout(() => {
      tooltipTimerRef.current = null;
      setIsHovered(true);
    }, HOVER_TOOLTIP_DELAY);
  };

  const handleTitleLeave = (): void => {
    lastRowLeaveAt = Date.now();
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
    setIsHovered(false);
  };

  useEffect(
    () => () => {
      if (tooltipTimerRef.current !== null) {
        window.clearTimeout(tooltipTimerRef.current);
      }
    },
    [],
  );

  // 窗口失焦（如会话在独立窗口打开、之后关闭）后指针位置已失效：
  // 收起卡片，并要求先有真实指针移动才允许再次弹出，避免卡片残留在行旁。
  useEffect(() => {
    trackPointerMove();
    const handleFocusChange = (): void => {
      pointerMovedSinceFocus = false;
      if (tooltipTimerRef.current !== null) {
        window.clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = null;
      }
      setIsHovered(false);
    };
    window.addEventListener("blur", handleFocusChange);
    window.addEventListener("focus", handleFocusChange);
    return () => {
      window.removeEventListener("blur", handleFocusChange);
      window.removeEventListener("focus", handleFocusChange);
    };
  }, []);

  // 遮罩打开或关闭都重置：关闭后必须重新悬停才会再显示，避免取消弹窗后卡片残留
  // 用 layout effect 保证在绘制前收起，关闭弹窗时不会闪一帧卡片
  useLayoutEffect(() => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
    setIsHovered(false);
  }, [overlayOpen]);

  const isSelectionBlocked =
    isRunning || isPendingSessionKey(conversation.conversationId);
  const handleSelectClick = (
    event: React.MouseEvent | React.KeyboardEvent,
  ): void => {
    if (isEditing) {
      return;
    }
    if (isMultiSelectMode || event.shiftKey || event.ctrlKey || event.metaKey) {
      // 鼠标、复选框和键盘共享资格保护，不允许选择或导航运行中的行。
      if (!isSelectionBlocked) {
        onToggleSelect?.(event);
      }
      return;
    }
    onSelect?.(event);
  };

  // 右键 == 三点按钮菜单：在光标位置弹出同一份操作菜单
  const handleContextMenu = (event: React.MouseEvent): void => {
    // 编辑/多选/运行中模式下不拦截右键，保留系统菜单（输入框复制粘贴等）
    if (isEditing || isMultiSelectMode || isRunning) {
      return;
    }
    event.preventDefault();
    setContextMenuAnchor({ x: event.clientX, y: event.clientY });
  };

  // ===== 会话拖拽源（双协议）：拖到聊天输入框 = 注入为目标会话的开头上下文；
  // 拖到置顶区/普通列表区 = 切换置顶状态（上游 chatDrag 协议）=====
  // 编辑/多选/运行中的会话不可拖拽，避免与重命名、勾选及运行状态冲突
  //（isDraggable 由调用方控制：PENDING 会话等不作为拖拽源）
  const canDrag = isDraggable && !isEditing && !isMultiSelectMode && !isRunning;
  const showQuickActions = !isEditing && !isMultiSelectMode && !isRunning;

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!canDrag) {
      event.preventDefault();
      return;
    }
    // 同时写入两种 MIME 协议，两个 drop 端（输入框 / 列表区）都能识别；
    // copyMove 同时兼容输入框的 copy 和侧边栏分组的 move。
    const payload: ConversationDragPayload = {
      conversationId: conversation.conversationId,
      directoryId: conversation.directoryId,
      title: displayName,
    };
    beginConversationDrag(event.dataTransfer, payload);
    setChatDragData(event, {
      conversationId: conversation.conversationId,
      status: conversation.status,
    });
    setIsDragSource(true);
  };

  const handleDragEnd = (): void => {
    endConversationDrag();
    setIsDragSource(false);
  };

  const handleToggleExpand = (event: React.MouseEvent): void => {
    event.stopPropagation();
    onToggleTree?.();
  };

  const hasTreeChildren = hasSubAgents || isWorkflow;

  const handleOpenInNewWindow = (): void => {
    openConversationInNewWindow(conversation, displayName).catch(
      (error: unknown) => {
        console.error("Failed to open conversation in new window", error);
      },
    );
  };

  const attentionRequiredSubAgentCount = subAgentConversations.filter((sub) =>
    subAgentAttentionRequiredIds.has(sub.conversationId),
  ).length;
  const runningSubAgentCount = subAgentConversations.filter(
    (sub) =>
      (sub.subAgentStatus === "queued" ||
        sub.subAgentStatus === "running" ||
        sub.subAgentStatus === "finalizing" ||
        sub.subAgentStatus === "cancelling") &&
      !subAgentAttentionRequiredIds.has(sub.conversationId),
  ).length;

  return (
    <div
      className={`chat-item${isMenuOpen ? " menu-open" : ""}${
        isActive ? " active" : ""
      }${isMultiSelectMode && !isRunning ? " multi-select" : ""}${
        isSelected ? " selected" : ""
      }${isDragSource ? " dragging" : ""}${
        showQuickActions ? " has-quick-actions" : ""
      }`}
      draggable={canDrag}
      onMouseDown={(event) => {
        if (event.shiftKey && !isEditing) {
          event.preventDefault();
        }
      }}
      onMouseEnter={handleTitleHover}
      onMouseLeave={handleTitleLeave}
      onDragStart={canDrag ? handleDragStart : undefined}
      onDragEnd={handleDragEnd}
      onClick={handleSelectClick}
      onContextMenu={handleContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (isEditing) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleSelectClick(event);
        }
      }}
    >
      {isMultiSelectMode && !isSelectionBlocked ? (
        <span
          className={`chat-item-checkbox${isSelected ? " checked" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            handleSelectClick(event);
          }}
          role="checkbox"
          aria-checked={isSelected}
          tabIndex={-1}
        >
          {isSelected ? <Check size={12} strokeWidth={3} /> : null}
        </span>
      ) : null}
      <div className="chat-item-content">
        {isEditing ? (
          <input
            ref={editInputRef}
            className="chat-item-rename-input"
            type="text"
            value={editingValue}
            onChange={(event) => setEditingValue(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => void handleRenameSubmit()}
            placeholder={t("sidebar.chatRenamePlaceholder", {
              defaultValue: "Enter new name",
            })}
          />
        ) : (
          <>
            <div className="chat-item-title-row">
              {isWorkflow || hasSubAgents || isForked ? (
                <span className="chat-item-kind-icons" aria-hidden="true">
                  {isWorkflow ? (
                    <Workflow
                      size={11}
                      className="chat-item-kind-icon workflow"
                    />
                  ) : null}
                  {hasSubAgents ? (
                    <Waypoints
                      size={11}
                      className="chat-item-kind-icon sub-agent"
                    />
                  ) : null}
                  {isForked ? (
                    <GitFork size={11} className="chat-item-kind-icon forked" />
                  ) : null}
                </span>
              ) : null}
              {hasTreeChildren && (
                <span
                  className="chat-item-expand-toggle"
                  onClick={handleToggleExpand}
                  role="button"
                  tabIndex={-1}
                  aria-expanded={isTreeExpanded}
                >
                  <ChevronRight
                    size={12}
                    className={isTreeExpanded ? "expanded" : ""}
                  />
                </span>
              )}
              <span
                className="chat-item-title"
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (
                    isMultiSelectMode ||
                    event.shiftKey ||
                    event.ctrlKey ||
                    event.metaKey
                  ) {
                    return;
                  }
                  handleRenameStart();
                }}
              >
                <span
                  className={`chat-item-title-text${
                    showTitleShimmer ? " chat-item-title-text--shimmer" : ""
                  }`}
                >
                  {displayName}
                  {/* 亮色副本 + 柔边裁切窗口：只有 transform 动画，走合成器，
                      切换会话时不会像 background-position 那样停转 */}
                  {showTitleShimmer ? (
                    <span
                      className="chat-item-title-shimmer-window"
                      aria-hidden="true"
                    >
                      <span className="chat-item-title-shimmer-text">
                        {displayName}
                      </span>
                    </span>
                  ) : null}
                </span>
              </span>
              {statusLabel && (
                <span
                  className={`chat-item-status-label ${
                    showAttentionStatus ? "attention-required" : "completed"
                  }`}
                  title={statusDescription}
                  aria-label={statusDescription}
                >
                  {statusLabel}
                </span>
              )}
              {showPinBadge && isPinned ? (
                <span
                  className="chat-item-pin-badge"
                  aria-label={t("sidebar.chatPinnedBadge", {
                    defaultValue: "Pinned",
                  })}
                >
                  <Pin size={11} />
                </span>
              ) : null}
              {hasSubAgents && runningSubAgentCount > 0 && (
                <span className="chat-item-sub-agent-count">
                  {runningSubAgentCount}
                </span>
              )}
              {hasSubAgents && attentionRequiredSubAgentCount > 0 && (
                <span
                  className="chat-item-sub-agent-count attention"
                  title={statusDescription}
                  aria-label={statusDescription}
                >
                  {attentionRequiredSubAgentCount}
                </span>
              )}
              {showStreamingStatus ? (
                <span
                  className={`chat-item-time chat-item-time-loading${
                    isPaused ? " paused" : ""
                  }`}
                  title={runningDescription}
                  aria-label={runningDescription}
                >
                  {isPaused ? (
                    <Pause size={11} aria-hidden="true" />
                  ) : (
                    <span className="snowflake-spin">
                      <Snowflake size={11} aria-hidden="true" />
                    </span>
                  )}
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
      {showQuickActions && (
        <span
          className="chat-item-menu-wrapper"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {isArchiving ? (
            <span className="spin-layer">
              <Loader2
                size={14}
                aria-label={t("sidebar.chatActionArchiving", {
                  defaultValue: "Archiving...",
                })}
              />
            </span>
          ) : (
            <>
              {onArchive ? (
                <Tooltip
                  content={t("sidebar.chatActionArchive", {
                    defaultValue: "Archive",
                  })}
                  placement="top"
                >
                  <span
                    className="chat-item-quick-action"
                    role="button"
                    tabIndex={0}
                    aria-label={t("sidebar.chatActionArchive", {
                      defaultValue: "Archive",
                    })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onArchive();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        onArchive();
                      }
                    }}
                  >
                    <Archive size={14} />
                  </span>
                </Tooltip>
              ) : null}
              <ChatItemMenu
                conversationId={conversation.conversationId}
                isPinned={isPinned}
                onPin={onPin}
                onRename={handleRenameStart}
                onDelete={onDelete}
                isDeleting={isDeleting}
                onExport={onExport}
                onFork={onFork}
                onOpenInNewWindow={handleOpenInNewWindow}
                onArchive={onArchive}
                onEnterMultiSelect={onEnterMultiSelect}
                onOpenChange={setIsMenuOpen}
                contextMenuAnchor={contextMenuAnchor}
                onContextMenuClose={() => setContextMenuAnchor(null)}
              />
            </>
          )}
        </span>
      )}
      {!isEditing && !isMultiSelectMode ? (
        <Tooltip
          placement="right"
          visible={showHoverTooltip}
          content={
            <div className="chat-item-tooltip">
              <div className="chat-item-tooltip-head">
                <span className="chat-item-tooltip-title">{displayName}</span>
                {isPinned ? (
                  <span className="chat-item-tooltip-pin">
                    <Pin size={11} />
                  </span>
                ) : null}
                {relativeTimeLabel ? (
                  <span className="chat-item-tooltip-time">
                    {relativeTimeLabel}
                  </span>
                ) : null}
              </div>
              {directoryInfo ? (
                <div className="chat-item-tooltip-project">
                  {getDirectoryIcon(directoryInfo.record)}
                  <span className="chat-item-tooltip-project-name">
                    {directoryInfo.name}
                  </span>
                </div>
              ) : null}
              {isWorkflow || hasSubAgents ? (
                <div className="chat-item-tooltip-kinds">
                  {isWorkflow ? (
                    <span className="chat-item-tooltip-kind workflow">
                      <Workflow size={11} aria-hidden="true" />
                      {t("sidebar.workflowMode", {
                        defaultValue: "Workflow mode",
                      })}
                    </span>
                  ) : null}
                  {hasSubAgents ? (
                    <span className="chat-item-tooltip-kind sub-agent">
                      <Waypoints size={11} aria-hidden="true" />
                      {t("sidebar.subAgent", { defaultValue: "Sub-agent" })}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          }
        >
          <span className="chat-item-tooltip-anchor" />
        </Tooltip>
      ) : null}
    </div>
  );
}
