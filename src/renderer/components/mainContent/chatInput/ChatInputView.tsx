import {
  AlertCircle,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Command,
  Copy,
  ExternalLink,
  File,
  Folder,
  Keyboard,
  Loader2,
  Plug,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Square,
  Target,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import { Modal } from "../../common/Modal";
import { ContextMenu } from "../../common/ContextMenu";
import { Tooltip } from "../../common/Tooltip";
import type { ChatInputViewProps } from "./types";
import { TEXT_SNIPPET_THRESHOLD } from "./constants";
import { ThinkingStrengthMenu } from "./ThinkingStrengthMenu";
import { TokenUsageRing } from "./TokenUsageRing";
import {
  CHIPS_CLIPBOARD_TYPE,
  INSERT_ELEMENT_TAG_EVENT,
  base64ToUtf8,
  buildSegmentsHtml,
  buildTextSnippetSummary,
  createChangeChipHtml,
  createChipHtml,
  createCommitChipHtml,
  createElementChipHtml,
  createImageChipHtml,
  createTextSnippetChipHtml,
  createWebTagChipHtml,
  insertHtmlAtSelection,
  insertLineBreak,
  isEditableContentEmpty,
  parseContentSegments,
  readEditableContent,
  readEditableContentAsPlainText,
  renumberImageChips as renumberImageChipsFn,
  type ChangeTag,
  type CommitTag,
  type ContentSegment,
  type ElementTag,
  type FileTag,
  type ImageTag,
  type TextSnippetTag,
  type WebTag,
} from "./fileTagUtils";
import {
  FileMentionPopup,
  type FileMentionPopupHandle,
} from "./FileMentionPopup";
import { useDropdownDirection } from "./useDropdownDirection";
import { PlusMenu, type PlusMenuSection } from "./PlusMenu";
import { PendingMessages } from "./PendingMessages";
import { ProjectMcpPanel } from "./ProjectMcpPanel";
import { ProjectCodebasePanel } from "./ProjectCodebasePanel";
import { ProjectPermissionsPanel } from "./ProjectPermissionsPanel";
import { ProjectSensitiveCommandsPanel } from "./ProjectSensitiveCommandsPanel";
import { ProjectSkillsPanel } from "./ProjectSkillsPanel";
import { RoleEditorPanel } from "./RoleEditorPanel";
import { StreamMetrics } from "./StreamMetrics";
import { useChatConversationContext } from "../chatMessages";
import { directoryIdToPath } from "../chatMessages/utils/conversationHelpers";
import { collectConversationFileChanges } from "../chatMessages/hooks/fileChangeTracking";
import { useConversationFileChanges } from "./useConversationFileChanges";
import {
  TERMINAL_DRAG_MIME,
  TERMINAL_INSERT_TEXT_EVENT,
  startTerminalMonitor,
  stopTerminalMonitor,
  type TerminalDragPayload,
  type TerminalInsertTextPayload,
} from "../../rightPanel/terminal/terminalMonitor";
import { rightPanelEvents } from "../../rightPanel/rightPanelEvents";
import {
  CONVERSATION_DRAG_MIME,
  conversationContextEvents,
  endConversationDrag,
  readConversationDragPayload,
} from "../../sidebar/mainSidebar/conversationContextEvents";
import {
  WEB_SNAPSHOT_REQUEST_EVENT,
  WEB_SNAPSHOT_RESULT_EVENT,
  WEB_SNAPSHOT_TIMEOUT_MS,
  nextSnapshotRequestId,
  type WebSnapshotRequest,
  type WebSnapshotResult,
} from "../../rightPanel/browserSnapshotEvents";
import { CommandPanel, type CommandPanelHandle } from "./commands/CommandPanel";
import { createChatCommands } from "./commands/commandRegistry";
import { FileChangesPanel } from "./commands/FileChangesPanel";
import { ReviewPanel } from "./commands/ReviewPanel";
import type { ChatCommand } from "./commands/types";

/** 终端监控日志预览保留的最大行数 */
const MAX_MONITORED_LINES = 1000;

/**
 * 在编辑区中定位与（url, title）匹配的 web chip，用于快照结果回填。
 * 同一 URL 可能被拖入多次（chip 多个），优先精确匹配 url+title 的，
 * 否则取最后插入的 url 匹配项（最近一次拖入的 chip）。
 */
const findWebChipByUrl = (
  root: HTMLElement,
  url: string,
  title?: string
): HTMLElement | null => {
  const chips = root.querySelectorAll<HTMLElement>("[data-web-tag='true']");
  let fallback: HTMLElement | null = null;
  let exact: HTMLElement | null = null;
  for (const chip of chips) {
    try {
      const data = JSON.parse(chip.dataset.webData || "{}") as Partial<WebTag>;
      if (data.url !== url) {
        continue;
      }
      fallback = chip;
      if (title && data.title === title) {
        exact = chip;
      }
    } catch {
      // 忽略损坏的 chip 数据
    }
  }
  return exact ?? fallback;
};

export const ChatInputView = ({
  placeholder,
  projectId,
  projectName,
  onNavigateToView,
  value,
  textareaRef,
  apiConfigs,
  selectedApiProfile,
  modelMenuView,
  isSubAgentConversation,
  models,
  selectedModel,
  displayModel,
  isLoadingModels,
  modelError,
  isModelMenuOpen,
  isManualMode,
  manualValue,
  dropdownRef,
  runtimeApiConfig,
  requestMethod,
  thinkingOptions,
  thinkingValue,
  thinkingLabel,
  ActiveThinkingIcon,
  isLoadingApiConfig,
  isSavingThinking,
  thinkingError,
  responsesFastModeEnabled,
  isSavingFastMode,
  fastModeError,
  labels,
  isStreaming,
  isAborting,
  tokenUsage,
  pendingMessages,
  onWithdrawPendingMessage,
  onSendPendingMessageNow,
  onCompactConversation,
  yoloMode,
  isUpdatingYoloMode,
  onYoloModeChange,
  onRefreshYoloMode,
  planMode,
  isUpdatingPlanMode,
  onPlanModeChange,
  onRefreshPlanMode,
  goalMode,
  isUpdatingGoalMode,
  onGoalModeChange,
  onRefreshGoalMode,
  goalModeTokenBudget,
  onGoalModeTokenBudgetChange,
  autoScrollEnabled,
  onAutoScrollChange,
  isCompacting,
  setManualValue,
  setIsManualMode,
  setModelMenuView,
  handleChange,
  handleSend,
  handleAbort,
  handleKeyDown,
  handleSelectModel,
  handleOpenManualMode,
  handleConfirmManualModel,
  handleManualKeyDown,
  handleRetryFetchModels,
  handleToggleModelMenu,
  handleSelectApiProfile,
  handleSelectThinking,
  handleToggleResponsesFastMode,
  restoreContent,
}: ChatInputViewProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    handleNewChat,
    handleSendMessage,
    messages,
    activeConversationId,
    conversationDirectoryId,
    conversationVersion,
    fileChangeStats,
    streamTokenCount,
    streamElapsedMs,
    streamTtftMs,
    baselineCheckpointId,
    streamStartedAt,
    isPaused,
    handlePause,
    handleResume,
  } = useChatConversationContext();
  // 用户发送过的历史消息（终端式 ↑/↓ 回溯用）：按时间正序保留。
  // 过滤压缩摘要（isContextCompaction）等非用户真实输入的系统消息。
  const userHistoryMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.role === "user" &&
          !message.isContextCompaction &&
          message.content.trim().length > 0
      ),
    [messages]
  );
  // 历史回溯游标：-1 = 未回溯（空白输入）；0..n-1 = 从最近一条起算的下标
  const historyIndexRef = useRef(-1);
  const fallbackFileChanges = useMemo(() => {
    if (!activeConversationId) {
      return [];
    }
    return collectConversationFileChanges(
      fileChangeStats,
      activeConversationId
    );
  }, [activeConversationId, fileChangeStats]);
  const conversationWorkDir = directoryIdToPath(conversationDirectoryId);
  const conversationFileChanges = useConversationFileChanges({
    baselineCheckpointId,
    workDir: conversationWorkDir,
    messages,
    conversationVersion,
    fallbackChanges: fallbackFileChanges,
  });
  const isDraggingOverRef = useRef(false);
  // 会话拖拽到输入框的结果反馈徽标（成功/失败），3 秒后自动消失
  const [dragFeedback, setDragFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const dragFeedbackTimerRef = useRef<number | null>(null);
  const showDragFeedback = useCallback(
    (feedback: { type: "success" | "error"; text: string }): void => {
      setDragFeedback(feedback);
      if (dragFeedbackTimerRef.current !== null) {
        window.clearTimeout(dragFeedbackTimerRef.current);
      }
      dragFeedbackTimerRef.current = window.setTimeout(() => {
        setDragFeedback(null);
        dragFeedbackTimerRef.current = null;
      }, 3000);
    },
    []
  );
  // F4 网页快照：待处理请求表（requestId → web chip 定位信息）。拖入标签页
  // 后登记，快照结果按 requestId 匹配取出定位信息，再在编辑区 DOM 中按
  // URL/标题找到对应 web chip 回填（chip 可能已被删除/消息已发送，找不到
  // 则静默丢弃）；5s 超时未收到结果也在此移除（chip 保持纯 URL 引用）。
  const pendingWebSnapshotRef = useRef<
    Map<number, { url: string; title?: string }>
  >(new Map());
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const mentionAnchorRef = useRef<HTMLDivElement>(null);
  const mentionPopupRef = useRef<FileMentionPopupHandle>(null);
  const mentionStartOffsetRef = useRef<number>(-1);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const commandPanelRef = useRef<CommandPanelHandle>(null);
  const commandTriggerRef = useRef<HTMLButtonElement>(null);
  const [isProjectMcpOpen, setIsProjectMcpOpen] = useState(false);
  const [isProjectSensitiveCommandsOpen, setIsProjectSensitiveCommandsOpen] =
    useState(false);
  const [isProjectPermissionsOpen, setIsProjectPermissionsOpen] =
    useState(false);
  const [isProjectSkillsOpen, setIsProjectSkillsOpen] = useState(false);
  const [isProjectCodebaseOpen, setIsProjectCodebaseOpen] = useState(false);
  const [isRoleEditorOpen, setIsRoleEditorOpen] = useState(false);
  const [isFileChangesOpen, setIsFileChangesOpen] = useState(false);
  // 稳定引用：供 StreamMetricsWorkSummary memo 使用，避免父组件重渲染时
  // 传入新的 inline lambda 导致文件统计区域失效重绘（P0-1 性能优化）。
  const handleOpenFileChanges = useCallback(() => {
    setIsFileChangesOpen(true);
  }, []);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  // 模型列表搜索关键词，仅 model 视图生效
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [apiProfileSearchQuery, setApiProfileSearchQuery] = useState("");

  // 关闭菜单或离开对应视图时清空搜索词
  useEffect(() => {
    if (!isModelMenuOpen || modelMenuView !== "model") {
      setModelSearchQuery("");
    }
    if (!isModelMenuOpen || modelMenuView !== "apiProfile") {
      setApiProfileSearchQuery("");
    }
  }, [isModelMenuOpen, modelMenuView]);

  // review 指令只在新建会话（尚未绑定历史会话）时开放，审查对象是
  // 当前项目目录的 Git 状态，而不是某个历史会话绑定的目录。
  const isNewChat = !activeConversationId;
  const reviewWorkDir = directoryIdToPath(projectId);

  const commands = useMemo(
    () =>
      createChatCommands({
        onNewChat: handleNewChat,
        onCompactConversation,
        onOpenFileChangesPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(true);
        },
        onOpenMcpPanel: () => {
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectMcpOpen(true);
        },
        onOpenRolePanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsFileChangesOpen(false);
          setIsRoleEditorOpen(true);
        },
        onOpenPermissionsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectPermissionsOpen(true);
        },
        onOpenSensitiveCommandsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectSensitiveCommandsOpen(true);
        },
        onOpenSkillsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectSkillsOpen(true);
        },
        onOpenCodebasePanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectCodebaseOpen(true);
        },
        onOpenReviewPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsReviewOpen(true);
        },
        model: selectedModel || undefined,
        apiProfile: selectedApiProfile || undefined,
        compactDisabled: messages.length === 0 || isCompacting,
        fileChangesDisabled: !activeConversationId,
        mcpDisabled: !projectId,
        // YOLO 模式下工具自动授权，无需（也不允许）管理授权列表。
        permissionsDisabled: !projectId || yoloMode,
        reviewDisabled: !isNewChat || !reviewWorkDir,
        roleDisabled: !projectId,
        sensitiveCommandsDisabled: !projectId,
        skillsDisabled: !projectId,
        codebaseDisabled: !projectId,
        isRunning: isStreaming,
        labels: {
          clearDescription: t("chatCommand.clearDescription"),
          compactDescription: t("chatCommand.compactDescription"),
          fileChangesDescription: t("chatCommand.fileChangesDescription"),
          mcpDescription: projectId
            ? t("chatCommand.mcpDescription")
            : t("chatCommand.mcpNoProject"),
          roleDescription: t("chatCommand.roleDescription"),
          roleNoProject: t("chatCommand.roleNoProject"),
          // permissions 的禁用描述按原因区分：无项目 / YOLO 模式。
          permissionsDescription: !projectId
            ? t("chatCommand.permissionsNoProject")
            : yoloMode
              ? t("chatCommand.permissionsYoloDisabled")
              : t("chatCommand.permissionsDescription"),
          sensitiveCommandsDescription: projectId
            ? t("chatCommand.sensitiveCommandsDescription")
            : t("chatCommand.sensitiveCommandsNoProject"),
          skillsDescription: projectId
            ? t("chatCommand.skillsDescription")
            : t("chatCommand.skillsNoProject"),
          codebaseDescription: t("chatCommand.codebaseDescription"),
          codebaseNoProject: t("chatCommand.codebaseNoProject"),
          reviewDescription: !isNewChat
            ? t("chatCommand.reviewNewChatOnly")
            : reviewWorkDir
              ? t("chatCommand.reviewDescription")
              : t("chatCommand.reviewNoProject"),
          reviewNoProject: t("chatCommand.reviewNoProject"),
        },
      }),
    [
      activeConversationId,
      handleNewChat,
      isCompacting,
      isNewChat,
      isStreaming,
      messages.length,
      onCompactConversation,
      projectId,
      reviewWorkDir,
      selectedApiProfile,
      selectedModel,
      t,
      yoloMode,
    ]
  );

  const [imagePreview, setImagePreview] = useState<{
    url: string;
    x: number;
    y: number;
  } | null>(null);
  const imagePreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const [imageLightbox, setImageLightbox] = useState<string | null>(null);

  // 文本片段（text-snippet）chip 的悬停预览与模态框编辑状态
  const [textSnippetPreview, setTextSnippetPreview] = useState<{
    content: string;
    summary: string;
    x: number;
    y: number;
  } | null>(null);
  const textSnippetPreviewTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [textSnippetEditor, setTextSnippetEditor] = useState<{
    chip: HTMLElement;
    content: string;
    summary: string;
  } | null>(null);

  // web chip 右键菜单：记录触发位置与目标 chip（url 用于打开/复制，chip 用于移除）
  const [webChipMenu, setWebChipMenu] = useState<{
    x: number;
    y: number;
    chip: HTMLElement;
    url: string;
  } | null>(null);

  // ------------------------------------------------------------------
  // 终端监控模式：拖拽终端到输入框后，实时订阅该终端的日志流
  // ------------------------------------------------------------------

  /** 当前监控的终端（null = 未监控） */
  const [monitoredTerminal, setMonitoredTerminal] = useState<{
    tabId: string;
    cwd: string;
  } | null>(null);
  /** 监控到的日志行（环形保留最近 MAX_MONITORED_LINES 行） */
  const [monitoredLines, setMonitoredLines] = useState<string[]>([]);
  /** 监控条日志预览是否展开 */
  const [monitorExpanded, setMonitorExpanded] = useState(false);
  /** 监控日志预览滚动容器（新行到达时自动滚到底部） */
  const monitorScrollRef = useRef<HTMLDivElement | null>(null);

  /** 停止监控当前终端 */
  const handleStopMonitor = useCallback((): void => {
    setMonitoredTerminal((prev) => {
      if (prev) {
        stopTerminalMonitor(prev.tabId);
      }
      return null;
    });
    setMonitoredLines([]);
    setMonitorExpanded(false);
  }, []);

  /** 监控日志预览展开时自动滚动到底部 */
  useEffect(() => {
    if (!monitorExpanded) {
      return;
    }
    const el = monitorScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [monitoredLines.length, monitorExpanded]);

  // 通用 chip 详情悬停预览（file / commit / change / review / element）
  const [chipDetails, setChipDetails] = useState<{
    rows: { label: string; value: string }[];
    content?: string;
    x: number;
    y: number;
  } | null>(null);
  const chipDetailsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const modelDropdownDir = useDropdownDirection(dropdownRef, isModelMenuOpen);

  // 模型列表模糊过滤：关键词对 id / ownedBy 做不区分大小写的包含匹配
  const filteredModels = useMemo(() => {
    const query = modelSearchQuery.trim().toLowerCase();
    if (!query) {
      return models;
    }
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(query) ||
        model.ownedBy.toLowerCase().includes(query)
    );
  }, [models, modelSearchQuery]);

  // 供应商列表模糊过滤：关键词对显示名 / 配置名 / 模型名做包含匹配
  const filteredApiConfigs = useMemo(() => {
    const query = apiProfileSearchQuery.trim().toLowerCase();
    if (!query) {
      return apiConfigs;
    }
    return apiConfigs.filter(
      (config) =>
        config.displayName.toLowerCase().includes(query) ||
        config.profileName.toLowerCase().includes(query) ||
        (config.advancedModel || "").toLowerCase().includes(query) ||
        (config.basicModel || "").toLowerCase().includes(query)
    );
  }, [apiConfigs, apiProfileSearchQuery]);

  const renumberImageChips = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      renumberImageChipsFn(el);
    }
  }, [textareaRef]);

  const syncContent = useCallback(() => {
    if (textareaRef.current) {
      renumberImageChips();
      const content = readEditableContent(textareaRef.current);
      handleChange(content);
      textareaRef.current.dataset.empty = isEditableContentEmpty(content)
        ? "true"
        : "false";
    }
  }, [handleChange, renumberImageChips, textareaRef]);

  const insertFileTag = useCallback(
    (tag: FileTag) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      insertHtmlAtSelection(createChipHtml(tag));
      syncContent();
    },
    [syncContent, textareaRef]
  );

  /** 终端工具栏「添加到输入框」事件：把日志编码为 text-snippet 小组件（chip）插入输入框 */
  useEffect(() => {
    const onInsertText = (event: Event): void => {
      const detail = (event as CustomEvent<TerminalInsertTextPayload>).detail;
      if (!detail?.text) {
        return;
      }
      const el = textareaRef.current;
      if (!el) {
        return;
      }
      el.focus();
      // 大段终端日志以 chip 形式存入输入框：避免文字铺开占满输入区，
      // 点击 chip 可展开查看完整内容，发送时序列化为摘要文本。
      const summary = buildTextSnippetSummary(detail.text, 36);
      const tag: TextSnippetTag = {
        content: detail.text,
        summary,
        charCount: detail.text.length,
      };
      insertHtmlAtSelection(createTextSnippetChipHtml(tag));
      syncContent();
    };
    window.addEventListener(TERMINAL_INSERT_TEXT_EVENT, onInsertText);
    return () =>
      window.removeEventListener(TERMINAL_INSERT_TEXT_EVENT, onInsertText);
  }, [syncContent, textareaRef]);

  const insertFileTags = useCallback(
    (tags: FileTag[]) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      const html = tags.map((tag) => createChipHtml(tag)).join(" ");
      insertHtmlAtSelection(html);
      syncContent();
    },
    [syncContent, textareaRef]
  );

  // 监听浏览器面板元素选择器派发的 element 标签事件，将选取的页面元素
  // 以 element chip 形式插入编辑区（与 @ 文件 / 拖拽标签同一套编码体系）。
  const insertElementTag = useCallback(
    (tag: ElementTag) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      insertHtmlAtSelection(createElementChipHtml(tag));
      syncContent();
    },
    [syncContent, textareaRef]
  );

  useEffect(() => {
    const handleInsertElementTag = (event: Event) => {
      const tag = (event as CustomEvent<ElementTag>).detail;
      if (!tag) {
        return;
      }
      insertElementTag(tag);
    };
    window.addEventListener(INSERT_ELEMENT_TAG_EVENT, handleInsertElementTag);
    return () => {
      window.removeEventListener(INSERT_ELEMENT_TAG_EVENT, handleInsertElementTag);
    };
  }, [insertElementTag]);

  // 独立浏览器窗口确认的元素选择结果：经主进程转发到本窗口后同样插入
  // element chip（INSERT_ELEMENT_TAG_EVENT 无法跨渲染进程传播）。
  useEffect(() => {
    return window.snow.onElementTagInserted((tag) => {
      insertElementTag({
        url: tag.url,
        tag: tag.tag,
        label: tag.label,
        text: tag.text,
        note: tag.note,
      });
    });
  }, [insertElementTag]);

  // F4 网页快照结果回填：按 requestId 匹配 pending 表，更新对应 web chip
  // 的快照字段（发送时 encodeWebTag 序列化携带，AI 无需再开浏览器），
  // 并把截图作为 image chip 紧随 web chip 插入编辑区。任一环节缺失
  // （结果超时 / 快照失败 / chip 已删除）都静默跳过，不打断现有流程。
  useEffect(() => {
    const handleSnapshotResult = (event: Event): void => {
      const detail = (event as CustomEvent<WebSnapshotResult>).detail;
      if (!detail || typeof detail.requestId !== "number") {
        return;
      }
      const pending = pendingWebSnapshotRef.current.get(detail.requestId);
      if (!pending) {
        return; // 已超时 / 已被处理过
      }
      pendingWebSnapshotRef.current.delete(detail.requestId);
      const snapshot = detail.snapshot;
      if (!snapshot) {
        return; // 抓取失败：chip 保持纯 URL 引用
      }
      const el = textareaRef.current;
      if (!el) {
        return;
      }
      const webChip = findWebChipByUrl(el, pending.url, pending.title);
      if (!webChip) {
        return; // chip 已被删除 / 消息已发送
      }

      // ① 回填快照字段到 web chip 数据（data-web-data），发送时
      //    encodeWebTag 从 dataset 读取并序列化进 @@web:...@@ 标签。
      try {
        const prev = JSON.parse(
          webChip.dataset.webData || "{}"
        ) as Partial<WebTag>;
        webChip.dataset.webData = JSON.stringify({
          url: typeof prev.url === "string" ? prev.url : pending.url,
          title: typeof prev.title === "string" ? prev.title : pending.title,
          text: snapshot.text || undefined,
          elementText: snapshot.elementText,
          elementSelector: snapshot.elementSelector,
        });
      } catch {
        // data-web-data 损坏：跳过回填（chip 保持纯 URL 引用）
      }

      // ② 截图 → image chip 紧随 web chip 插入（复用 createImageChipHtml）。
      //    用 DOM 定位插入而非光标处，避免结果到达时用户已移动光标/失焦
      //    导致截图插到错误位置或插入到编辑区之外。
      if (snapshot.screenshotDataUrl) {
        const imageTag: ImageTag = {
          name: "page-snapshot.png",
          dataUrl: snapshot.screenshotDataUrl,
        };
        webChip.insertAdjacentHTML("afterend", createImageChipHtml(imageTag));
        const inserted = webChip.nextElementSibling;
        if (inserted) {
          // chip 后补空格，保证光标可定位到 chip 之后（对齐 insertHtmlAtSelection 行为）。
          inserted.after(document.createTextNode(" "));
        }
      }
      syncContent();
    };
    window.addEventListener(WEB_SNAPSHOT_RESULT_EVENT, handleSnapshotResult);
    return () => {
      window.removeEventListener(WEB_SNAPSHOT_RESULT_EVENT, handleSnapshotResult);
    };
  }, [syncContent, textareaRef]);

  const deleteMentionQuery = useCallback(() => {
    const el = textareaRef.current;
    if (!el || mentionStartOffsetRef.current < 0) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    const currentNode = range.startContainer;
    const currentOffset = range.startOffset;

    if (currentNode.nodeType !== Node.TEXT_NODE) {
      return;
    }

    const textNode = currentNode as Text;
    const start = mentionStartOffsetRef.current - 1;
    if (start < 0 || currentOffset <= start) {
      return;
    }

    range.setStart(textNode, start);
    range.setEnd(textNode, currentOffset);
    range.deleteContents();
    selection.removeAllRanges();
    selection.addRange(range);

    mentionStartOffsetRef.current = -1;
  }, [textareaRef]);

  const handleMentionSelect = useCallback(
    (tag: FileTag) => {
      deleteMentionQuery();
      insertFileTag(tag);
    },
    [deleteMentionQuery, insertFileTag]
  );

  const handleMentionSelectBatch = useCallback(
    (tags: FileTag[]) => {
      deleteMentionQuery();
      insertFileTags(tags);
    },
    [deleteMentionQuery, insertFileTags]
  );

  const handleCloseMention = useCallback(() => {
    setIsMentionOpen(false);
    setMentionQuery("");
    mentionStartOffsetRef.current = -1;
  }, []);

  const handleCloseCommand = useCallback(() => {
    setIsCommandOpen(false);
    setCommandQuery("");
  }, []);

  const handleToggleCommand = useCallback(() => {
    setIsCommandOpen((prev) => {
      const next = !prev;
      if (!next) {
        setCommandQuery("");
      }
      return next;
    });
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [textareaRef]);

  useEffect(() => {
    if (!isCommandOpen) {
      return;
    }
    const handleDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (commandTriggerRef.current?.contains(target)) {
        return;
      }
      const panelEl = document.querySelector(".chat-command-panel");
      if (panelEl?.contains(target)) {
        return;
      }
      handleCloseCommand();
    };
    document.addEventListener("mousedown", handleDocumentPointerDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentPointerDown);
    };
  }, [isCommandOpen, handleCloseCommand]);

  const handleCommandSelect = useCallback(
    (command: ChatCommand) => {
      if (command.disabled) {
        return;
      }
      handleCloseCommand();
      restoreContent("");
      command.execute();
    },
    [handleCloseCommand, restoreContent]
  );

  /**
   * 将单个图片文件读取为 dataUrl 并插入 image chip。
   * 粘贴与拖入外部图片共用此逻辑，保持行为一致。
   */
  const insertImageFromFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        if (!dataUrl) {
          return;
        }

        const mimeMatch = file.type.match(/^image\/([a-z]+)$/);
        const ext = mimeMatch ? mimeMatch[1] : "png";
        const imageTag: ImageTag = {
          name: `image.${ext}`,
          dataUrl,
        };

        if (textareaRef.current) {
          textareaRef.current.focus();
        }
        insertHtmlAtSelection(createImageChipHtml(imageTag));
        syncContent();
      };
      reader.readAsDataURL(file);
    },
    [syncContent, textareaRef]
  );

  /**
   * 将外部文件（拖入或粘贴，均为 File 对象）解析为真实磁盘路径，
   * 图片文件插入 image chip（读取 dataUrl），其余文件/文件夹插入
   * file chip（携带路径）。contextIsolation 下渲染进程无法直接读取
   * 真实路径，由 preload 的 resolveDroppedFiles 解析。
   */
  const insertExternalFiles = useCallback(
    (files: File[]) => {
      if (!files || files.length === 0) {
        return;
      }
      void window.snow
        .resolveDroppedFiles(files)
        .then((entries) => {
          if (entries.length === 0) {
            return;
          }
          const imageFiles: File[] = [];
          const fileTags: FileTag[] = [];
          // entries 顺序与 files 顺序一一对应；以 File.type 优先判断
          // 图片，路径扩展名兜底（某些系统 File.type 可能为空）。
          entries.forEach((entry, idx) => {
            const matchedFile = files[idx];
            const isImage =
              !entry.isDirectory &&
              ((matchedFile && matchedFile.type.startsWith("image/")) ||
                /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(
                  entry.path
                ));
            if (isImage && matchedFile) {
              imageFiles.push(matchedFile);
            } else {
              const name =
                entry.path.split(/[\\/]/).filter(Boolean).pop() ||
                entry.path;
              fileTags.push({
                path: entry.path,
                name,
                isDirectory: entry.isDirectory,
              });
            }
          });
          if (imageFiles.length > 0) {
            for (const imageFile of imageFiles) {
              insertImageFromFile(imageFile);
            }
          }
          if (fileTags.length > 0) {
            insertFileTags(fileTags);
          }
        })
        .catch(() => {
          // 解析失败时静默处理
        });
    },
    [insertFileTags, insertImageFromFile]
  );

  const handleMentionDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, tag: FileTag) => {
      event.dataTransfer.setData("application/json", JSON.stringify(tag));
      event.dataTransfer.effectAllowed = "copy";
    },
    []
  );

  /**
   * 将图片文件（拖拽 / 粘贴）以 image chip 形式插入编辑区。
   * 通过 FileReader 读取为 dataURL，逐个插入并触发 syncContent
   * （内部会调用 renumberImageChips 统一编号）。
   */
  const insertImageFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      if (textareaRef.current) {
        textareaRef.current.focus();
      }

      for (const file of files) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          if (!dataUrl) {
            return;
          }

          const mimeMatch = file.type.match(/^image\/([a-z]+)$/);
          const ext = mimeMatch ? mimeMatch[1] : "png";
          const imageTag: ImageTag = {
            name: `image.${ext}`,
            dataUrl,
          };

          insertHtmlAtSelection(createImageChipHtml(imageTag));
          syncContent();
        };
        reader.readAsDataURL(file);
      }
    },
    [syncContent, textareaRef]
  );

  /**
   * 页面文本拖入（方案 A）：浏览器 webview 页选中文字直接拖到输入框时，
   * 将 text/plain 内容插入编辑区。短文本直插（浏览器原生 insertText，
   * 不经 HTML 解析、无 XSS 风险，配合 .input-field-editable 的
   * white-space: pre-wrap 保留原文换行与缩进，并接入浏览器撤销栈）；
   * 超阈值长文本折叠为 text-snippet chip（与粘贴逻辑一致，避免
   * contenteditable 渲染海量文本节点导致应用卡死）。
   */
  const insertDroppedPlainText = useCallback(
    (text: string) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      if (text.length > TEXT_SNIPPET_THRESHOLD) {
        const summary = buildTextSnippetSummary(text);
        const tag: TextSnippetTag = {
          content: text,
          summary,
          charCount: text.length,
        };
        insertHtmlAtSelection(createTextSnippetChipHtml(tag));
        syncContent();
        return;
      }
      document.execCommand("insertText", false, text);
      syncContent();
    },
    [syncContent, textareaRef]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      isDraggingOverRef.current = false;
      if (textareaRef.current) {
        textareaRef.current.classList.remove("drag-over");
      }

      // 终端拖拽手柄：拖到输入框 = 进入「监控终端」模式（实时订阅日志流）
      const terminalData = event.dataTransfer.getData(TERMINAL_DRAG_MIME);
      if (terminalData) {
        try {
          const payload = JSON.parse(terminalData) as TerminalDragPayload;
          if (payload && typeof payload.tabId === "string") {
            startTerminalMonitor(payload.tabId, (lines) => {
              setMonitoredLines((prev) =>
                [...prev, ...lines].slice(-MAX_MONITORED_LINES)
              );
            });
            setMonitoredTerminal({
              tabId: payload.tabId,
              cwd: payload.cwd || "",
            });
            setMonitoredLines([]);
            setMonitorExpanded(true);
          }
        } catch {
          // 无效的终端拖拽数据：忽略
        }
        return;
      }

      // 会话上下文注入：拖拽侧边栏会话到输入框 = 附加为当前会话的开头上下文。
      // drop 阶段 DataTransfer 可重新读取；若上游环境仍返回空，则回退 dragstart 缓存。
      const conversationPayload = readConversationDragPayload(event.dataTransfer);
      if (conversationPayload) {
        endConversationDrag();
        if (activeConversationId) {
          void (async () => {
            try {
              await window.snow.addContextAttachment(
                activeConversationId,
                conversationPayload.conversationId
              );
              conversationContextEvents.emit(
                "attachments-changed",
                activeConversationId
              );
              showDragFeedback({
                type: "success",
                text: t("conversationContext.attachSuccess", {
                  defaultValue: "已附加为开头上下文",
                }),
              });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              showDragFeedback({ type: "error", text: message });
            }
          })();
        }
        return;
      }

      // 支持从文件管理器拖入图片（单张或多张），与粘贴图片行为保持一致
      const droppedFiles = Array.from(event.dataTransfer.files);
      const imageFiles = droppedFiles.filter((file) =>
        file.type.startsWith("image/")
      );
      if (imageFiles.length > 0) {
        insertImageFiles(imageFiles);
        return;
      }

      const jsonData = event.dataTransfer.getData("application/json");
      if (!jsonData) {
        // 从文件管理器拖入的外部文件：dataTransfer.files 携带 File 对象。
        // contextIsolation 下渲染进程无法直接读取真实路径，由 preload 的
        // resolveDroppedFiles 解析路径并查询是否为目录。图片文件走 image
        // chip（读取 dataUrl），其余文件/文件夹走 file chip（携带路径）。
        // Files 分支优先于 text/plain：文件拖拽时 text/plain 通常只是
        // 文件名列表，不应作为页面文本插入。
        const droppedFiles = event.dataTransfer.files;
        if (droppedFiles && droppedFiles.length > 0) {
          const files: File[] = [];
          for (let i = 0; i < droppedFiles.length; i++) {
            const file = droppedFiles.item(i);
            if (file) {
              files.push(file);
            }
          }
          insertExternalFiles(files);
          return;
        }

        // 页面文本拖入（方案 A）：浏览器 webview 页选中文字直接拖到输入框。
        // 拖出 guest 后为 OS 级拖拽会话，dataTransfer 仅携带 text/plain
        // （无 application/json、无文件）；非空（trim 后）即作为纯文本插入，
        // 短文本直插、超阈值折叠为 text-snippet chip（见 insertDroppedPlainText）。
        const plainText = event.dataTransfer.getData("text/plain");
        if (plainText && plainText.trim().length > 0) {
          insertDroppedPlainText(plainText);
        }
        return;
      }

      try {
        const parsed = JSON.parse(jsonData) as Record<string, unknown>;

        // 浏览器 tab 拖拽：{ type: "web-tag", url, title, instanceId?, tabId? }
        // → 插入网页引用 chip；若携带实例定位信息则异步请求三层网页快照
        // （正文 / 元素区域 / 截图），结果到达后回填 chip 数据并插入截图。
        if (
          parsed.type === "web-tag" &&
          typeof parsed.url === "string" &&
          parsed.url.length > 0
        ) {
          const tag: WebTag = {
            url: parsed.url,
            title:
              typeof parsed.title === "string" && parsed.title.length > 0
                ? parsed.title
                : undefined,
          };

          if (textareaRef.current) {
            textareaRef.current.focus();
          }

          insertHtmlAtSelection(createWebTagChipHtml(tag));
          syncContent();

          // F4 网页快照：仅内层标签页 / 外层浏览器 tab（携带 instanceId）
          // 触发请求；纯外部 URL 拖入（无 instanceId）保持纯 URL chip。
          const instanceId =
            typeof parsed.instanceId === "string" && parsed.instanceId.length > 0
              ? parsed.instanceId
              : undefined;
          if (instanceId) {
            const requestId = nextSnapshotRequestId();
            pendingWebSnapshotRef.current.set(requestId, {
              url: tag.url,
              title: tag.title,
            });
            // 全链路 5s 超时：未收到结果则放弃，chip 保持纯 URL 引用。
            window.setTimeout(() => {
              pendingWebSnapshotRef.current.delete(requestId);
            }, WEB_SNAPSHOT_TIMEOUT_MS);
            window.dispatchEvent(
              new CustomEvent<WebSnapshotRequest>(
                WEB_SNAPSHOT_REQUEST_EVENT,
                {
                  detail: {
                    requestId,
                    instanceId,
                    tabId:
                      typeof parsed.tabId === "string" ? parsed.tabId : "",
                    url: tag.url,
                  },
                }
              )
            );
          }
          return;
        }

        // 搜索结果组合拖拽：{ type: "file-tags", tags: FileTag[] }
        if (parsed.type === "file-tags" && Array.isArray(parsed.tags)) {
          const tags: FileTag[] = parsed.tags
            .filter(
              (item) =>
                item &&
                typeof item === "object" &&
                typeof (item as Record<string, unknown>).path === "string" &&
                typeof (item as Record<string, unknown>).name === "string"
            )
            .map((item) => {
              const t = item as Record<string, unknown>;
              const rawLines = t.lines;
              const lines = Array.isArray(rawLines)
                ? rawLines
                    .map((n) =>
                      typeof n === "number" ? n : Number.parseInt(String(n), 10)
                    )
                    .filter((n) => Number.isFinite(n) && n > 0)
                : undefined;
              return {
                path: t.path as string,
                name: t.name as string,
                isDirectory: t.isDirectory === true,
                lines: t.isDirectory === true ? undefined : lines,
              };
            });
          if (tags.length > 0) {
            insertFileTags(tags);
          }
          return;
        }

        // Commit tag: has "hash" and "repoPath" fields
        if (
          typeof parsed.hash === "string" &&
          typeof parsed.repoPath === "string" &&
          typeof parsed.shortHash === "string"
        ) {
          const tag: CommitTag = {
            hash: parsed.hash,
            shortHash: parsed.shortHash,
            author: typeof parsed.author === "string" ? parsed.author : "",
            date: typeof parsed.date === "string" ? parsed.date : "",
            message: typeof parsed.message === "string" ? parsed.message : "",
            repoPath: parsed.repoPath,
          };

          if (textareaRef.current) {
            textareaRef.current.focus();
          }

          insertHtmlAtSelection(createCommitChipHtml(tag));
          syncContent();
          return;
        }

        // Change tag: has "section", "path", "repoPath" and "status" fields
        if (
          typeof parsed.section === "string" &&
          (parsed.section === "staged" || parsed.section === "unstaged") &&
          typeof parsed.path === "string" &&
          typeof parsed.repoPath === "string" &&
          typeof parsed.status === "string"
        ) {
          const tag: ChangeTag = {
            repoPath: parsed.repoPath,
            path: parsed.path,
            section: parsed.section,
            status: parsed.status,
          };

          if (textareaRef.current) {
            textareaRef.current.focus();
          }

          insertHtmlAtSelection(createChangeChipHtml(tag));
          syncContent();
          return;
        }

        // File tag: has "path" and "name" fields
        if (
          typeof parsed.path === "string" &&
          typeof parsed.name === "string"
        ) {
          const rawLines = parsed.lines;
          const lines = Array.isArray(rawLines)
            ? rawLines
                .map((n) =>
                  typeof n === "number" ? n : Number.parseInt(String(n), 10)
                )
                .filter((n) => Number.isFinite(n) && n > 0)
            : undefined;
          const tag: FileTag = {
            path: parsed.path,
            name: parsed.name,
            isDirectory: parsed.isDirectory === true,
            lines: parsed.isDirectory === true ? undefined : lines,
          };

          if (textareaRef.current) {
            textareaRef.current.focus();
          }

          insertHtmlAtSelection(createChipHtml(tag));
          syncContent();
        }
      } catch {
        // Ignore invalid drag data
      }
    },
    [
      insertDroppedPlainText,
      insertExternalFiles,
      insertFileTags,
      syncContent,
      textareaRef,
      activeConversationId,
      showDragFeedback,
      t,
    ]
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const types = event.dataTransfer.types;
      // 会话上下文注入：拖拽侧边栏会话到输入框（CONVERSATION_DRAG_MIME）。
      // 前置校验：当前会话存在、非自引用、同工作区目录、当前会话非子代理会话，
      // 不满足则保持禁止光标（不 preventDefault），由 native 侧幂等兜底。
      const hasConversationDrag = types.includes(CONVERSATION_DRAG_MIME);
      if (hasConversationDrag) {
        const payload = readConversationDragPayload(event.dataTransfer);
        const conversationAllowed =
          !!payload &&
          !!activeConversationId &&
          payload.conversationId !== activeConversationId &&
          payload.directoryId === conversationDirectoryId &&
          !isSubAgentConversation;
        if (!conversationAllowed) {
          return;
        }
      }
      // 应用内拖拽（文件/commit/change 标签）走 application/json；
      // 终端监控拖拽走 application/x-snow-terminal（dropEffect: link）；
      // 从文件管理器拖入的外部文件走 Files；
      // 浏览器 webview 页面选中文字拖入走 text/plain（方案 A）。
      // 以上均需 preventDefault 才能允许 drop，否则浏览器默认拒绝
      // （显示禁止光标）。
      const hasTerminal = types.includes(TERMINAL_DRAG_MIME);
      const allowed =
        types.includes("application/json") ||
        types.includes("Files") ||
        types.includes("text/plain") ||
        hasTerminal ||
        hasConversationDrag;
      if (!allowed) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = hasTerminal ? "link" : "copy";
      if (!isDraggingOverRef.current && textareaRef.current) {
        isDraggingOverRef.current = true;
        textareaRef.current.classList.add("drag-over");
      }
    },
    [
      textareaRef,
      activeConversationId,
      conversationDirectoryId,
      isSubAgentConversation,
    ]
  );

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.currentTarget === event.target) {
        isDraggingOverRef.current = false;
        if (textareaRef.current) {
          textareaRef.current.classList.remove("drag-over");
        }
      }
    },
    [textareaRef]
  );

  const checkInputTriggers = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      handleCloseMention();
      handleCloseCommand();
      return;
    }

    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const offset = range.startOffset;

    if (node.nodeType !== Node.TEXT_NODE) {
      handleCloseMention();
      handleCloseCommand();
      return;
    }

    const textBefore = (node.textContent ?? "").slice(0, offset);
    const commandMatch = textBefore.match(/^\/([^\s]*)$/);
    if (commandMatch) {
      handleCloseMention();
      setIsCommandOpen(true);
      setCommandQuery(commandMatch[1]);
      return;
    }

    const mentionMatch = textBefore.match(/(?:^|\s)@([^\s]*)$/);
    if (mentionMatch) {
      const queryText = mentionMatch[1];
      const atOffset = offset - queryText.length - 1;

      setIsMentionOpen(true);
      mentionStartOffsetRef.current = atOffset + 1;
      setMentionQuery(queryText);
      handleCloseCommand();
      return;
    }

    handleCloseMention();
    handleCloseCommand();
  }, [handleCloseCommand, handleCloseMention]);

  /**
   * 将当前选区（鼠标划选、Ctrl/Cmd+A 全选等，含 chip）序列化为剪贴板
   * 数据，无有效选区时返回 null。自定义 MIME 携带完整编码内容（供应用
   * 内粘贴还原 chip），text/plain 为人类可读文本（供粘贴到应用外），
   * text/html 为 chip HTML（供粘贴到富文本编辑器）。
   */
  const serializeSelectionForClipboard = useCallback(() => {
    const el = textareaRef.current;
    const selection = window.getSelection();
    if (
      !el ||
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) {
      return null;
    }
    const container = document.createElement("div");
    container.appendChild(range.cloneContents());
    const encoded = readEditableContent(container);
    if (!encoded) {
      return null;
    }
    return {
      encoded,
      plain: readEditableContentAsPlainText(container),
      html: buildSegmentsHtml(parseContentSegments(encoded)),
    };
  }, [textareaRef]);

  const writeSelectionToClipboard = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>): boolean => {
      const data = serializeSelectionForClipboard();
      if (!data) {
        return false;
      }
      event.preventDefault();
      event.clipboardData.setData(CHIPS_CLIPBOARD_TYPE, data.encoded);
      event.clipboardData.setData("text/plain", data.plain);
      event.clipboardData.setData("text/html", data.html);
      return true;
    },
    [serializeSelectionForClipboard]
  );

  const handleCopy = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      writeSelectionToClipboard(event);
    },
    [writeSelectionToClipboard]
  );

  const handleCut = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!writeSelectionToClipboard(event)) {
        return;
      }
      // preventDefault 后浏览器不会执行默认剪切，手动调用原生 delete
      // 命令删除选区，保持在撤销栈中（Ctrl+Z 可恢复）。
      document.execCommand("delete");
      syncContent();
    },
    [writeSelectionToClipboard, syncContent]
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();

      const items = event.clipboardData.items;
      const imageItems: DataTransferItem[] = [];
      const fileItems: DataTransferItem[] = [];

      for (const item of items) {
        if (item.kind !== "file") {
          continue;
        }
        // 粘贴的图片（截图、从文件管理器复制的图片文件等）走 image chip；
        // 其余文件（kind === "file" 且非图片 MIME）走 file chip。
        if (item.type.startsWith("image/")) {
          imageItems.push(item);
        } else {
          fileItems.push(item);
        }
      }

      if (imageItems.length > 0) {
        for (const imageItem of imageItems) {
          const file = imageItem.getAsFile();
          if (!file) {
            continue;
          }
          insertImageFromFile(file);
        }
      }

      // 粘贴的外部文件（如从文件管理器复制的文件）与拖入共用解析逻辑：
      // 图片插入 image chip，其余文件/文件夹插入 file chip。
      if (fileItems.length > 0) {
        const pastedFiles: File[] = [];
        for (const fileItem of fileItems) {
          const file = fileItem.getAsFile();
          if (file) {
            pastedFiles.push(file);
          }
        }
        if (pastedFiles.length > 0) {
          insertExternalFiles(pastedFiles);
        }
      }

      if (imageItems.length > 0 || fileItems.length > 0) {
        return;
      }

      // 插入“文本 + 编码标签”混合内容，将各标签还原为对应 chip；
      // 超出阈值的文本段折叠为 text-snippet chip，避免渲染海量文本节点。
      const insertSegmentedContent = (segments: ContentSegment[]) => {
        const normalized = segments.map((segment): ContentSegment => {
          if (
            segment.type === "text" &&
            segment.content.length > TEXT_SNIPPET_THRESHOLD
          ) {
            return {
              type: "text-snippet",
              tag: {
                content: segment.content,
                summary: buildTextSnippetSummary(segment.content),
                charCount: segment.content.length,
              },
            };
          }
          return segment;
        });
        if (textareaRef.current) {
          textareaRef.current.focus();
        }
        insertHtmlAtSelection(buildSegmentsHtml(normalized));
        syncContent();
      };

      // 应用内复制/剪切携带自定义 MIME 的完整编码内容，优先解析该格式，
      // 完整还原文件/图片/commit 等 chip。
      const chipsData = event.clipboardData.getData(CHIPS_CLIPBOARD_TYPE);
      if (chipsData) {
        insertSegmentedContent(parseContentSegments(chipsData));
        return;
      }

      const text = event.clipboardData.getData("text/plain");
      if (!text) {
        return;
      }

      // 粘贴的纯文本本身含编码标签时（如从其他输入框或草稿复制），
      // 同样还原为 chip。
      const segments = parseContentSegments(text);
      if (segments.some((segment) => segment.type !== "text")) {
        insertSegmentedContent(segments);
        return;
      }

      // 超出阈值的纯文本粘贴标签化为 text-snippet chip，避免
      // contenteditable 输入框渲染海量文本节点导致应用卡死。
      if (text.length > TEXT_SNIPPET_THRESHOLD) {
        const summary = buildTextSnippetSummary(text);
        const tag: TextSnippetTag = {
          content: text,
          summary,
          charCount: text.length,
        };
        if (textareaRef.current) {
          textareaRef.current.focus();
        }
        insertHtmlAtSelection(createTextSnippetChipHtml(tag));
        syncContent();
        return;
      }
      // 用浏览器原生 insertText 插入纯文本：配合 .input-field-editable 的
      // white-space: pre-wrap，原文的换行与缩进（连续空格）原样保留；
      // 同时接入浏览器撤销栈，Ctrl+Z 可整体撤销本次粘贴。
      document.execCommand("insertText", false, text);
      syncContent();
      checkInputTriggers();
    },
    [syncContent, insertImageFromFile, insertExternalFiles, checkInputTriggers, textareaRef]
  );

  /**
   * 路径@导航：将 @ 后的查询文本替换为相对路径（保留 @ 前缀），
   * 用于 @ 面板"进入文件夹 / 面包屑跳转 / 返回上级"。
   * 替换后重新解析触发词，面板随新路径刷新内容；relPath 为空表示回到根目录。
   */
  const replaceMentionQuery = useCallback(
    (relPath: string) => {
      const el = textareaRef.current;
      if (!el || mentionStartOffsetRef.current < 0) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return;
      }

      const range = selection.getRangeAt(0);
      const currentNode = range.startContainer;
      const currentOffset = range.startOffset;

      if (currentNode.nodeType !== Node.TEXT_NODE) {
        return;
      }

      const textNode = currentNode as Text;
      const start = mentionStartOffsetRef.current;
      // @ 后无文本时（currentOffset === start，如刚输入 @ 就直接点目录）
      // 也允许插入路径；仅当光标在 @ 之前时放弃。
      if (currentOffset < start) {
        return;
      }

      range.setStart(textNode, start);
      range.setEnd(textNode, currentOffset);
      range.deleteContents();
      selection.removeAllRanges();
      selection.addRange(range);

      // 接入浏览器撤销栈，Ctrl+Z 可回退本次导航；空路径（回根）只做删除
      const newText = relPath ? `${relPath}/` : "";
      if (newText) {
        document.execCommand("insertText", false, newText);
      }
      checkInputTriggers();
    },
    [checkInputTriggers, textareaRef]
  );

  const handleMentionNavigateTo = useCallback(
    (relPath: string) => {
      replaceMentionQuery(relPath);
    },
    [replaceMentionQuery]
  );

  const handleInput = useCallback(() => {
    syncContent();
    checkInputTriggers();
  }, [syncContent, checkInputTriggers]);

  /**
   * 终端式历史回溯：↑ 依次向前（最近 → 更早），↓ 反向回退直到空白。
   * 返回 true 表示已消费该方向键（调用方应 preventDefault）。
   * 输入框非空且未处于回溯状态时，↑ 不拦截（保持默认光标移动行为）。
   */
  const recallHistory = useCallback(
    (direction: "up" | "down"): boolean => {
      const count = userHistoryMessages.length;
      if (count === 0) {
        return false;
      }
      const current = historyIndexRef.current;
      if (direction === "up") {
        if (current === -1 && value.trim() !== "") {
          return false;
        }
        const next = current === -1 ? 0 : Math.min(current + 1, count - 1);
        historyIndexRef.current = next;
        restoreContent(userHistoryMessages[count - 1 - next].content);
        return true;
      }
      if (current === -1) {
        return false;
      }
      if (current === 0) {
        // 已回溯到最近一条，↓ 回到空白输入状态
        historyIndexRef.current = -1;
        restoreContent("");
        return true;
      }
      const next = current - 1;
      historyIndexRef.current = next;
      restoreContent(userHistoryMessages[count - 1 - next].content);
      return true;
    },
    [restoreContent, userHistoryMessages, value]
  );

  // 输入框未聚焦（焦点在 body）时，↑/↓ 同样触发历史回溯，实现
  // "未聚焦状态按 ↑ 直接调出最近一条用户消息"。仅当没有任何元素持有
  // 焦点时处理，避免劫持文件树等其它组件的方向键操作。
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
        return;
      }
      const el = textareaRef.current;
      if (!el) {
        return;
      }
      // 输入框聚焦时由 contentEditable 的 onKeyDown 处理，避免重复消费
      if (document.activeElement === el) {
        return;
      }
      if (document.activeElement !== document.body) {
        return;
      }
      if (recallHistory(event.key === "ArrowUp" ? "up" : "down")) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [recallHistory, textareaRef]);

  // 切换会话时重置回溯游标，避免跨会话串味
  useEffect(() => {
    historyIndexRef.current = -1;
  }, [activeConversationId]);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const nativeEvent = event.nativeEvent;
      const isComposing =
        nativeEvent.isComposing ||
        (nativeEvent as unknown as { keyCode?: number }).keyCode === 229;

      if (isComposing) {
        return;
      }

      // 发送后输入框被清空，回溯游标归位（下次 ↑ 从最近一条开始）
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        historyIndexRef.current = -1;
      }

      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        insertLineBreak();
        syncContent();
        return;
      }

      if (isCommandOpen && commandPanelRef.current) {
        const handled = commandPanelRef.current.handleKeyDown(event);
        if (handled) {
          return;
        }
      }

      if (isMentionOpen && mentionPopupRef.current) {
        const handled = mentionPopupRef.current.handleKeyDown(event);
        if (handled) {
          return;
        }
      }

      // ↑/↓ 历史回溯：command/mention 面板打开时方向键已由面板消费
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (recallHistory(event.key === "ArrowUp" ? "up" : "down")) {
          event.preventDefault();
          return;
        }
      }

      handleKeyDown(event);
    },
    [handleKeyDown, isCommandOpen, isMentionOpen, recallHistory, syncContent]
  );

  const showImagePreview = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-image-tag='true']"
      ) as HTMLElement | null;
      if (!chip) {
        if (imagePreviewTimerRef.current) {
          clearTimeout(imagePreviewTimerRef.current);
          imagePreviewTimerRef.current = null;
        }
        setImagePreview(null);
        return;
      }

      const dataUrl = chip.dataset.imageDataUrl;
      if (!dataUrl) {
        if (imagePreviewTimerRef.current) {
          clearTimeout(imagePreviewTimerRef.current);
          imagePreviewTimerRef.current = null;
        }
        setImagePreview(null);
        return;
      }

      if (imagePreviewTimerRef.current) {
        clearTimeout(imagePreviewTimerRef.current);
        imagePreviewTimerRef.current = null;
      }

      const rect = chip.getBoundingClientRect();
      const PREVIEW_MAX_W = 328;
      const halfW = PREVIEW_MAX_W / 2;
      const clampedX = Math.max(
        halfW + 4,
        Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4)
      );
      setImagePreview({
        url: dataUrl,
        x: clampedX,
        y: rect.top,
      });
    },
    []
  );

  const handleChipRemove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const removeBtn = target.closest("[data-chip-remove='true']");
      if (!removeBtn) {
        return;
      }

      const chip = removeBtn.closest(".file-chip");
      if (chip && textareaRef.current?.contains(chip)) {
        chip.remove();
        syncContent();
      }
    },
    [syncContent, textareaRef]
  );

  const scheduleHideImagePreview = useCallback(() => {
    imagePreviewTimerRef.current = setTimeout(() => {
      setImagePreview(null);
    }, 200);
  }, []);

  const cancelHideImagePreview = useCallback(() => {
    if (imagePreviewTimerRef.current) {
      clearTimeout(imagePreviewTimerRef.current);
      imagePreviewTimerRef.current = null;
    }
  }, []);

  const showTextSnippetPreview = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-text-snippet-tag='true']"
      ) as HTMLElement | null;
      if (!chip) {
        if (textSnippetPreviewTimerRef.current) {
          clearTimeout(textSnippetPreviewTimerRef.current);
          textSnippetPreviewTimerRef.current = null;
        }
        setTextSnippetPreview(null);
        return;
      }

      const rawData = chip.dataset.textSnippetData;
      if (!rawData) {
        if (textSnippetPreviewTimerRef.current) {
          clearTimeout(textSnippetPreviewTimerRef.current);
          textSnippetPreviewTimerRef.current = null;
        }
        setTextSnippetPreview(null);
        return;
      }

      let parsed: { content?: string; summary?: string };
      try {
        parsed = JSON.parse(rawData) as { content?: string; summary?: string };
      } catch {
        if (textSnippetPreviewTimerRef.current) {
          clearTimeout(textSnippetPreviewTimerRef.current);
          textSnippetPreviewTimerRef.current = null;
        }
        setTextSnippetPreview(null);
        return;
      }

      if (textSnippetPreviewTimerRef.current) {
        clearTimeout(textSnippetPreviewTimerRef.current);
        textSnippetPreviewTimerRef.current = null;
      }

      const rect = chip.getBoundingClientRect();
      const PREVIEW_MAX_W = 440;
      const halfW = PREVIEW_MAX_W / 2;
      const clampedX = Math.max(
        halfW + 4,
        Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4)
      );
      setTextSnippetPreview({
        content: parsed.content ?? "",
        summary: parsed.summary ?? "text",
        x: clampedX,
        y: rect.top,
      });
    },
    []
  );

  const scheduleHideTextSnippetPreview = useCallback(() => {
    textSnippetPreviewTimerRef.current = setTimeout(() => {
      setTextSnippetPreview(null);
    }, 200);
  }, []);

  const cancelHideTextSnippetPreview = useCallback(() => {
    if (textSnippetPreviewTimerRef.current) {
      clearTimeout(textSnippetPreviewTimerRef.current);
      textSnippetPreviewTimerRef.current = null;
    }
  }, []);

  const handleTextSnippetClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      // 点击 remove 按钮时不触发编辑
      if (target.closest("[data-chip-remove='true']")) {
        return;
      }
      const chip = target.closest(
        "[data-text-snippet-tag='true']"
      ) as HTMLElement | null;
      if (!chip || !textareaRef.current?.contains(chip)) {
        return;
      }
      const rawData = chip.dataset.textSnippetData;
      if (!rawData) {
        return;
      }
      try {
        const parsed = JSON.parse(rawData) as {
          content?: string;
          summary?: string;
        };
        setTextSnippetEditor({
          chip,
          content: parsed.content ?? "",
          summary:
            parsed.summary ?? buildTextSnippetSummary(parsed.content ?? ""),
        });
      } catch {
        // Ignore malformed data
      }
    },
    [textareaRef]
  );

  // 点击 web chip 主体（非 remove 按钮）→ 在右侧面板打开对应网页。
  // 通过 rightPanelEvents 事件总线请求 RightPanel 新建/切换到浏览器 tab。
  const handleWebChipClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      // 点击 remove 按钮时不打开浏览器
      if (target.closest("[data-chip-remove='true']")) {
        return;
      }
      const chip = target.closest(
        "[data-web-tag='true']"
      ) as HTMLElement | null;
      if (!chip || !textareaRef.current?.contains(chip)) {
        return;
      }
      const rawData = chip.dataset.webData;
      if (!rawData) {
        return;
      }
      try {
        const parsed = JSON.parse(rawData) as { url?: string };
        if (parsed.url) {
          rightPanelEvents.emit("open-browser-tab", { url: parsed.url });
        }
      } catch {
        // Ignore malformed data
      }
    },
    [textareaRef]
  );

  // 右键 web chip → 弹出右键菜单（打开页面 / 复制链接 / 移除引用）。
  // contextmenu 与 click 是独立事件（click 仅主键触发），不会干扰 C3 的点击打开。
  const handleWebChipContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      // 右键关闭按钮不弹菜单（保留其关闭语义）
      if (target.closest("[data-chip-remove='true']")) {
        return;
      }
      const chip = target.closest(
        "[data-web-tag='true']"
      ) as HTMLElement | null;
      if (!chip || !textareaRef.current?.contains(chip)) {
        return;
      }
      const rawData = chip.dataset.webData;
      if (!rawData) {
        return;
      }
      try {
        const parsed = JSON.parse(rawData) as { url?: string };
        if (!parsed.url) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setWebChipMenu({
          x: event.clientX,
          y: event.clientY,
          chip,
          url: parsed.url,
        });
      } catch {
        // Ignore malformed data
      }
    },
    [textareaRef]
  );

  const handleTextSnippetEditorSave = useCallback(() => {
    if (!textSnippetEditor) {
      return;
    }
    const { chip, content, summary } = textSnippetEditor;
    const trimmedSummary = summary.trim() || buildTextSnippetSummary(content);
    const tag: TextSnippetTag = {
      content,
      summary: trimmedSummary,
      charCount: content.length,
    };
    const newChipHtml = createTextSnippetChipHtml(tag);
    const fragment = document
      .createRange()
      .createContextualFragment(newChipHtml);
    const newChip = fragment.firstChild as HTMLElement | null;
    if (newChip) {
      chip.replaceWith(newChip);
    }
    setTextSnippetEditor(null);
    syncContent();
  }, [syncContent, textSnippetEditor]);

  const handleTextSnippetEditorDelete = useCallback(() => {
    if (!textSnippetEditor) {
      return;
    }
    const { chip } = textSnippetEditor;
    chip.remove();
    setTextSnippetEditor(null);
    syncContent();
  }, [syncContent, textSnippetEditor]);

  const showChipDetails = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-file-tag='true'],[data-commit-tag='true'],[data-change-tag='true'],[data-review-tag='true'],[data-element-tag='true'],[data-web-tag='true']"
      ) as HTMLElement | null;
      const clear = (): void => {
        if (chipDetailsTimerRef.current) {
          clearTimeout(chipDetailsTimerRef.current);
          chipDetailsTimerRef.current = null;
        }
        setChipDetails(null);
      };
      if (!chip) {
        clear();
        return;
      }

      const rows: { label: string; value: string }[] = [];
      let content: string | undefined;
      try {
        if (chip.dataset.fileTag === "true") {
          const path = chip.dataset.filePath ?? "";
          const isDir = chip.dataset.fileIsDir === "true";
          const lines = chip.dataset.fileLines;
          rows.push({
            label: t(isDir ? "chatInput.chipDetailsFolder" : "chatInput.chipDetailsFile"),
            value: path,
          });
          if (lines) {
            rows.push({ label: t("chatInput.chipDetailsLines"), value: lines });
          }
        } else if (chip.dataset.commitTag === "true") {
          const data = JSON.parse(
            chip.dataset.commitData ?? "{}"
          ) as Partial<CommitTag>;
          rows.push({
            label: t("chatInput.chipDetailsCommit"),
            value: data.shortHash ?? "",
          });
          rows.push({
            label: t("chatInput.chipDetailsAuthor"),
            value: data.author ?? "",
          });
          if (data.date) {
            rows.push({
              label: t("chatInput.chipDetailsDate"),
              value: data.date,
            });
          }
          if (data.repoPath) {
            rows.push({
              label: t("chatInput.chipDetailsRepo"),
              value: data.repoPath,
            });
          }
          if (data.message) {
            content = data.message;
          }
        } else if (chip.dataset.changeTag === "true") {
          const data = JSON.parse(
            chip.dataset.changeData ?? "{}"
          ) as Partial<ChangeTag>;
          const sectionLabel =
            data.section === "staged"
              ? t("chatInput.chipDetailsStaged")
              : t("chatInput.chipDetailsUnstaged");
          rows.push({
            label: t("chatInput.chipDetailsSection"),
            value: data.status ? `${sectionLabel} · ${data.status}` : sectionLabel,
          });
          rows.push({
            label: t("chatInput.chipDetailsPath"),
            value: data.path ?? "",
          });
          if (data.repoPath) {
            rows.push({
              label: t("chatInput.chipDetailsRepo"),
              value: data.repoPath,
            });
          }
        } else if (chip.dataset.reviewTag === "true") {
          const data = JSON.parse(
            chip.dataset.reviewData ?? "{}"
          ) as { prompt?: string; summary?: string; charCount?: number; branch?: string; repoPath?: string };
          rows.push({
            label: t("chatInput.chipDetailsSummary"),
            value: data.summary ?? "",
          });
          if (typeof data.charCount === "number") {
            rows.push({
              label: t("chatInput.chipDetailsChars"),
              value: String(data.charCount),
            });
          }
          if (data.branch) {
            rows.push({
              label: t("chatInput.chipDetailsBranch"),
              value: data.branch,
            });
          }
          if (data.repoPath) {
            rows.push({
              label: t("chatInput.chipDetailsRepo"),
              value: data.repoPath,
            });
          }
          if (data.prompt) {
            content = base64ToUtf8(data.prompt);
          }
        } else if (chip.dataset.elementTag === "true") {
          const data = JSON.parse(
            chip.dataset.elementData ?? "{}"
          ) as { url?: string; tag?: string; label?: string; text?: string; note?: string };
          rows.push({
            label: t("chatInput.chipDetailsTag"),
            value: data.label ?? "",
          });
          if (data.tag) {
            rows.push({
              label: t("chatInput.chipDetailsType"),
              value: data.tag,
            });
          }
          if (data.url) {
            rows.push({
              label: t("chatInput.chipDetailsUrl"),
              value: data.url,
            });
          }
          if (data.note) {
            rows.push({
              label: t("chatInput.chipDetailsNote"),
              value: base64ToUtf8(data.note),
            });
          }
          if (data.text) {
            content = base64ToUtf8(data.text);
          }
        } else if (chip.dataset.webTag === "true") {
          const data = JSON.parse(
            chip.dataset.webData ?? "{}"
          ) as { url?: string; title?: string };
          rows.push({
            label: t("chatInput.chipDetailsUrl"),
            value: data.url ?? "",
          });
          if (data.title) {
            rows.push({
              label: t("chatInput.chipDetailsTitle"),
              value: data.title,
            });
          }
        }
      } catch {
        clear();
        return;
      }
      if (rows.length === 0) {
        clear();
        return;
      }

      if (chipDetailsTimerRef.current) {
        clearTimeout(chipDetailsTimerRef.current);
        chipDetailsTimerRef.current = null;
      }

      const rect = chip.getBoundingClientRect();
      const PREVIEW_MAX_W = 420;
      const halfW = PREVIEW_MAX_W / 2;
      const clampedX = Math.max(
        halfW + 4,
        Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4)
      );
      setChipDetails({
        rows,
        content,
        x: clampedX,
        y: rect.top,
      });
    },
    [t]
  );

  const scheduleHideChipDetails = useCallback(() => {
    chipDetailsTimerRef.current = setTimeout(() => {
      setChipDetails(null);
    }, 200);
  }, []);

  const cancelHideChipDetails = useCallback(() => {
    if (chipDetailsTimerRef.current) {
      clearTimeout(chipDetailsTimerRef.current);
      chipDetailsTimerRef.current = null;
    }
  }, []);

  // Windows 原生对话框无法在同一视图混合多选文件和文件夹，
  // 因此"添加文件"与"添加文件夹"拆分为两个独立入口，
  // 分别调用纯文件 / 纯文件夹选择器，避免文案与行为不一致。
  const handleSelectFiles = useCallback(async () => {
    try {
      const selected = await window.snow.selectFiles(t("plusMenu.selectFilesTitle"));
      if (!selected || selected.length === 0) {
        return;
      }
      const tags: FileTag[] = selected.map((item) => {
        const path = item.path;
        const name = path.split("/").filter(Boolean).pop() || path;
        return { path, name, isDirectory: item.isDirectory };
      });
      insertFileTags(tags);
    } catch {
      // dialog cancelled or error
    }
  }, [insertFileTags, t]);

  const handleSelectFolders = useCallback(async () => {
    try {
      const selected = await window.snow.selectDirectories(
        t("plusMenu.selectFoldersTitle")
      );
      if (!selected || selected.length === 0) {
        return;
      }
      const tags: FileTag[] = selected.map((item) => {
        const path = item.path;
        const name = path.split("/").filter(Boolean).pop() || path;
        return { path, name, isDirectory: item.isDirectory };
      });
      insertFileTags(tags);
    } catch {
      // dialog cancelled or error
    }
  }, [insertFileTags, t]);

  const plusMenuSections = useMemo<PlusMenuSection[]>(
    () => [
      {
        id: "add",
        label: t("plusMenu.sectionAdd"),
        items: [
          {
            id: "files",
            label: t("plusMenu.files"),
            icon: File,
            onSelect: () => void handleSelectFiles(),
          },
          {
            id: "folders",
            label: t("plusMenu.folders"),
            icon: Folder,
            onSelect: () => void handleSelectFolders(),
          },
        ],
      },
    ],
    [t, handleSelectFiles, handleSelectFolders]
  );

  const handleWithdrawPending = useCallback(
    (index: number): string | null => {
      const restored = onWithdrawPendingMessage?.(index);
      if (restored) {
        restoreContent(restored);
      }
      return restored ?? null;
    },
    [onWithdrawPendingMessage, restoreContent]
  );

  const handleSendPendingNow = useCallback(
    (index: number): void => {
      onSendPendingMessageNow?.(index);
    },
    [onSendPendingMessageNow]
  );

  return (
    <div className="input-area">
      <ProjectMcpPanel
        open={isProjectMcpOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsProjectMcpOpen(false)}
      />
      <ProjectSensitiveCommandsPanel
        open={isProjectSensitiveCommandsOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsProjectSensitiveCommandsOpen(false)}
      />
      <ProjectPermissionsPanel
        open={isProjectPermissionsOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsProjectPermissionsOpen(false)}
      />
      <ProjectSkillsPanel
        open={isProjectSkillsOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsProjectSkillsOpen(false)}
      />
      <ProjectCodebasePanel
        open={isProjectCodebaseOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsProjectCodebaseOpen(false)}
      />
      <RoleEditorPanel
        open={isRoleEditorOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsRoleEditorOpen(false)}
      />
      <FileChangesPanel
        open={isFileChangesOpen}
        changesOverride={conversationFileChanges}
        onClose={() => setIsFileChangesOpen(false)}
      />
      <ReviewPanel
        open={isReviewOpen}
        workDir={reviewWorkDir ?? ""}
        onStartReview={(prompt) => {
          handleSendMessage(prompt, {
            model: selectedModel || undefined,
            apiProfile: selectedApiProfile || undefined,
            // review 回合：桌面宠物据此播放 review 专属动画。
            kind: "review",
          });
        }}
        onClose={() => setIsReviewOpen(false)}
      />
      <div className="input-content" ref={mentionAnchorRef}>
        <FileMentionPopup
          ref={mentionPopupRef}
          visible={isMentionOpen}
          query={mentionQuery}
          onClose={handleCloseMention}
          onSelect={handleMentionSelect}
          onSelectBatch={handleMentionSelectBatch}
          textareaRef={textareaRef}
          onDragStart={handleMentionDragStart}
          onNavigateTo={handleMentionNavigateTo}
        />
        <CommandPanel
          ref={commandPanelRef}
          commands={commands}
          query={commandQuery}
          visible={isCommandOpen}
          onClose={handleCloseCommand}
          onSelect={handleCommandSelect}
        />
        <PendingMessages
          messages={pendingMessages}
          onWithdraw={handleWithdrawPending}
          onSendNow={handleSendPendingNow}
        />
        {isStreaming ? (
          <div className="stream-metrics-bar">
            <StreamMetrics
              tokenCount={streamTokenCount}
              elapsedMs={streamElapsedMs}
              ttftMs={streamTtftMs}
              startedAt={streamStartedAt}
              isPaused={isPaused}
              onPause={handlePause}
              onResume={handleResume}
            />
          </div>
        ) : null}
        {/* 终端监控模式：拖拽终端到输入框后出现，实时显示该终端日志 */}
        {monitoredTerminal ? (
          <div
            className={`terminal-monitor-bar${
              monitorExpanded ? " expanded" : ""
            }`}
            role="status"
          >
            <div className="terminal-monitor-main">
              <button
                type="button"
                className="terminal-monitor-head"
                onClick={() => setMonitorExpanded((v) => !v)}
                title={t("chat.terminalMonitorToggle", {
                  defaultValue: "展开 / 收起监控日志",
                })}
              >
                <Radio
                  size={12}
                  strokeWidth={2}
                  className="terminal-monitor-icon"
                  aria-hidden="true"
                />
                <span className="terminal-monitor-label">
                  {t("chat.terminalMonitorLabel", {
                    defaultValue: "监控终端",
                  })}
                </span>
                <span className="terminal-monitor-cwd">
                  {monitoredTerminal.cwd}
                </span>
                <span className="terminal-monitor-count">
                  {t("chat.terminalMonitorLines", {
                    defaultValue: "{{count}} 行",
                    values: { count: monitoredLines.length },
                  })}
                </span>
                <ChevronDown
                  size={13}
                  className={`terminal-monitor-chevron${
                    monitorExpanded ? " open" : ""
                  }`}
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                className="terminal-monitor-stop"
                onClick={handleStopMonitor}
                title={t("chat.terminalMonitorStop", {
                  defaultValue: "停止监控",
                })}
                aria-label={t("chat.terminalMonitorStop", {
                  defaultValue: "停止监控",
                })}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            {monitorExpanded ? (
              <div className="terminal-monitor-log" ref={monitorScrollRef}>
                {monitoredLines.length > 0 ? (
                  monitoredLines.map((line, index) => (
                    <div key={index} className="terminal-monitor-line">
                      {line || "\u00A0"}
                    </div>
                  ))
                ) : (
                  <div className="terminal-monitor-empty">
                    {t("chat.terminalMonitorEmpty", {
                      defaultValue: "等待终端输出…",
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        {apiConfigs.length === 0 && !isSubAgentConversation && !isLoadingApiConfig ? (
          <div className="api-config-empty-banner" role="status">
            <Plug size={14} className="api-config-empty-icon" aria-hidden="true" />
            <span className="api-config-empty-text">
              {t("chat.noApiConfigBanner", {
                defaultValue: "尚未配置 AI API，请先添加 API 配置后再开始对话",
              })}
            </span>
            {onNavigateToView ? (
              <button
                type="button"
                className="api-config-empty-btn"
                onClick={() => onNavigateToView("api-settings")}
              >
                <Settings size={13} aria-hidden="true" />
                {t("chat.configureApi", { defaultValue: "前往设置" })}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="input-box">
          <div
            ref={textareaRef}
            className={`input-field input-field-editable${
              isCompacting ? " is-disabled" : ""
            }`}
            contentEditable={!isCompacting}
            suppressContentEditableWarning
            data-placeholder={placeholder}
            data-empty="true"
            onInput={handleInput}
            onKeyDown={handleInputKeyDown}
            onCopy={handleCopy}
            onCut={handleCut}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onMouseMove={(event) => {
              showImagePreview(event);
              showTextSnippetPreview(event);
              showChipDetails(event);
            }}
            onMouseLeave={() => {
              scheduleHideImagePreview();
              scheduleHideTextSnippetPreview();
              scheduleHideChipDetails();
            }}
            onContextMenu={handleWebChipContextMenu}
            onClick={(event) => {
              handleChipRemove(event);
              handleTextSnippetClick(event);
              handleWebChipClick(event);
            }}
          />
          {dragFeedback && (
            <span
              className={`chat-input-drag-feedback ${
                dragFeedback.type === "success" ? "success" : "error"
              }`}
              role="status"
              aria-live="polite"
            >
              {dragFeedback.type === "success" ? (
                <CheckCircle2 size={12} aria-hidden="true" />
              ) : (
                <XCircle size={12} aria-hidden="true" />
              )}
              <span className="chat-input-drag-feedback-text">
                {dragFeedback.text}
              </span>
            </span>
          )}
          {imagePreview &&
            createPortal(
              <div
                className="image-chip-preview"
                style={{
                  left: imagePreview.x,
                  top: imagePreview.y,
                  transform: "translate(-50%, calc(-100% - 8px))",
                }}
                onMouseEnter={cancelHideImagePreview}
                onMouseLeave={scheduleHideImagePreview}
                onClick={() => {
                  setImageLightbox(imagePreview.url);
                  setImagePreview(null);
                }}
              >
                <img src={imagePreview.url} alt="preview" />
              </div>,
              document.body
            )}
          {imageLightbox &&
            createPortal(
              <div
                className="image-lightbox-overlay"
                onClick={() => setImageLightbox(null)}
              >
                <img src={imageLightbox} alt="fullscreen" />
              </div>,
              document.body
            )}
          {textSnippetPreview &&
            createPortal(
              <div
                className="text-snippet-preview"
                style={{
                  left: textSnippetPreview.x,
                  top: textSnippetPreview.y,
                  transform: "translate(-50%, calc(-100% - 8px))",
                }}
                onMouseEnter={cancelHideTextSnippetPreview}
                onMouseLeave={scheduleHideTextSnippetPreview}
              >
                <pre className="text-snippet-preview-content">
                  {textSnippetPreview.content}
                </pre>
              </div>,
              document.body
            )}
          {chipDetails &&
            createPortal(
              <div
                className="chip-details-preview"
                style={{
                  left: chipDetails.x,
                  top: chipDetails.y,
                  transform: "translate(-50%, calc(-100% - 8px))",
                }}
                onMouseEnter={cancelHideChipDetails}
                onMouseLeave={scheduleHideChipDetails}
              >
                <div className="chip-details-preview-rows">
                  {chipDetails.rows.map((row) => (
                    <div className="chip-details-preview-row" key={row.label}>
                      <span className="chip-details-preview-label">
                        {row.label}
                      </span>
                      <span className="chip-details-preview-value">
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>
                {chipDetails.content && (
                  <pre className="chip-details-preview-content">
                    {chipDetails.content}
                  </pre>
                )}
              </div>,
              document.body
            )}
          {textSnippetEditor &&
            createPortal(
              <Modal
                open={true}
                title={t("chatInput.textSnippetEditorTitle")}
                description={t("chatInput.textSnippetEditorDescription", {
                  values: { count: textSnippetEditor.content.length },
                })}
                closeLabel={t("common.cancel")}
                onClose={() => setTextSnippetEditor(null)}
                size="large"
                footer={
                  <div className="text-snippet-editor-footer">
                    <button
                      type="button"
                      className="text-snippet-editor-btn danger"
                      onClick={handleTextSnippetEditorDelete}
                    >
                      {t("common.delete")}
                    </button>
                    <div className="text-snippet-editor-footer-right">
                      <button
                        type="button"
                        className="text-snippet-editor-btn secondary"
                        onClick={() => setTextSnippetEditor(null)}
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        className="text-snippet-editor-btn primary"
                        onClick={handleTextSnippetEditorSave}
                      >
                        {t("common.confirm")}
                      </button>
                    </div>
                  </div>
                }
              >
                <div className="text-snippet-editor-body">
                  <textarea
                    className="text-snippet-editor-textarea"
                    value={textSnippetEditor.content}
                    onChange={(e) =>
                      setTextSnippetEditor((prev) =>
                        prev ? { ...prev, content: e.target.value } : prev
                      )
                    }
                    rows={16}
                  />
                </div>
              </Modal>,
              document.body
            )}
          {webChipMenu && (
            <ContextMenu
              x={webChipMenu.x}
              y={webChipMenu.y}
              items={[
                {
                  id: "web-chip-open",
                  label: t("chatInput.webChipOpen", {
                    defaultValue: "打开页面",
                  }),
                  icon: <ExternalLink size={13} strokeWidth={1.8} />,
                  onClick: () => {
                    rightPanelEvents.emit("open-browser-tab", {
                      url: webChipMenu.url,
                    });
                    setWebChipMenu(null);
                  },
                },
                {
                  id: "web-chip-copy-link",
                  label: t("chatInput.webChipCopyLink", {
                    defaultValue: "复制链接",
                  }),
                  icon: <Copy size={13} strokeWidth={1.8} />,
                  onClick: () => {
                    // 与项目内其它调用一致：静默失败，避免未处理的 Promise rejection。
                    void window.snow.writeClipboardText(webChipMenu.url).catch(
                      () => {}
                    );
                    setWebChipMenu(null);
                  },
                },
                {
                  id: "web-chip-remove",
                  label: t("chatInput.webChipRemove", {
                    defaultValue: "移除引用",
                  }),
                  icon: <Trash2 size={13} strokeWidth={1.8} />,
                  onClick: () => {
                    webChipMenu.chip.remove();
                    setWebChipMenu(null);
                    syncContent();
                  },
                },
              ]}
              onClose={() => setWebChipMenu(null)}
            />
          )}
          <div className="input-toolbar">
            <div className="toolbar-left">
              <PlusMenu
                sections={plusMenuSections}
                yoloMode={yoloMode}
                isUpdatingYoloMode={isUpdatingYoloMode}
                onYoloModeChange={onYoloModeChange}
                onRefreshYoloMode={onRefreshYoloMode}
                planMode={planMode}
                isUpdatingPlanMode={isUpdatingPlanMode}
                onPlanModeChange={
                  isSubAgentConversation ? undefined : onPlanModeChange
                }
                onRefreshPlanMode={onRefreshPlanMode}
                goalMode={goalMode}
                isUpdatingGoalMode={isUpdatingGoalMode}
                onGoalModeChange={
                  isSubAgentConversation ? undefined : onGoalModeChange
                }
                onRefreshGoalMode={onRefreshGoalMode}
                goalModeTokenBudget={goalModeTokenBudget}
                onGoalModeTokenBudgetChange={
                  isSubAgentConversation
                    ? undefined
                    : onGoalModeTokenBudgetChange
                }
                autoScrollEnabled={autoScrollEnabled}
                onAutoScrollChange={onAutoScrollChange}
              />
              {value.trim() === "" && (
                <button
                  ref={commandTriggerRef}
                  className={`toolbar-btn command-trigger${
                    isCommandOpen ? " is-active" : ""
                  }`}
                  aria-label={t("chatCommand.trigger")}
                  aria-expanded={isCommandOpen}
                  onClick={handleToggleCommand}
                  type="button"
                  title={t("chatCommand.trigger")}
                >
                  <Command size={15} />
                </button>
              )}
              {planMode && (
                <>
                  <span className="toolbar-divider" aria-hidden="true" />
                  <span
                    className="plan-mode-badge"
                    title={t("plusMenu.planModeActive")}
                  >
                    <ClipboardList size={14} />
                  </span>
                </>
              )}
              {goalMode && (
                <>
                  <span className="toolbar-divider" aria-hidden="true" />
                  <span
                    className="plan-mode-badge"
                    title={t("plusMenu.goalModeActive")}
                  >
                    <Target size={14} />
                  </span>
                </>
              )}
              {yoloMode && (
                <>
                  <span className="toolbar-divider" aria-hidden="true" />
                  <Tooltip content={t("plusMenu.yoloModeActive")}>
                    <span
                      className="plan-mode-badge yolo-mode-badge"
                      aria-label={t("plusMenu.yoloModeActive")}
                    >
                      <ShieldAlert size={14} />
                    </span>
                  </Tooltip>
                </>
              )}
            </div>
            <div className="toolbar-right">
              <div className="model-selector" ref={dropdownRef}>
                <button
                  className={`toolbar-btn model ${
                    modelError ? "model-error" : ""
                  }${
                    isStreaming || isSubAgentConversation ? " is-disabled" : ""
                  }`}
                  aria-label={labels.selectModel}
                  aria-expanded={isModelMenuOpen}
                  onClick={handleToggleModelMenu}
                  disabled={
                    isStreaming ||
                    isSubAgentConversation ||
                    apiConfigs.length === 0 ||
                    !runtimeApiConfig
                  }
                  title={
                    isSubAgentConversation
                      ? t("chat.subAgentModelFixed")
                      : apiConfigs.length === 0 || !runtimeApiConfig
                        ? labels.noApiConfig
                        : labels.selectModel
                  }
                  type="button"
                >
                  {modelError ? (
                    <AlertCircle size={14} className="model-icon" />
                  ) : (
                    <Bot size={14} className="model-icon" />
                  )}
                  <span className="model-name" title={displayModel}>
                    {displayModel}
                  </span>
                  <span
                    className="model-trigger-thinking"
                    title={
                      thinkingError ??
                      (isLoadingApiConfig
                        ? t("chat.loadingApiConfig")
                        : t("chat.thinkingStrengthWithValue", {
                            values: { value: thinkingLabel },
                          }))
                    }
                  >
                    {isLoadingApiConfig || isSavingThinking ? (
                      <Loader2 size={12} className="spin" />
                    ) : thinkingError ? (
                      <AlertCircle size={12} />
                    ) : (
                      <ActiveThinkingIcon size={12} />
                    )}
                    <span className="model-trigger-thinking-label">
                      {thinkingLabel}
                    </span>
                  </span>
                  {requestMethod === "responses" &&
                    responsesFastModeEnabled && (
                      <span
                        className="model-trigger-fast"
                        title={fastModeError ?? t("chat.fastModeEnabled")}
                      >
                        {isSavingFastMode ? (
                          <Loader2 size={12} className="spin" />
                        ) : (
                          <Zap size={12} />
                        )}
                        <span>Fast</span>
                      </span>
                    )}
                  <ChevronDown size={12} />
                </button>
                {isModelMenuOpen && (
                    <div
                      className={`model-dropdown drop-${modelDropdownDir}`}
                    >
                    {modelMenuView === "root" && (
                      <div className="model-dropdown-list">
                        <button
                          className="model-dropdown-item"
                          onClick={() => setModelMenuView("model")}
                          type="button"
                        >
                          <span className="model-dropdown-item-name">
                            {t("chat.model")}
                          </span>
                          <span className="model-menu-value">
                            <span
                              className="model-menu-value-text"
                              title={displayModel}
                            >
                              {displayModel}
                            </span>
                            <ChevronRight size={12} />
                          </span>
                        </button>
                        <button
                          className="model-dropdown-item"
                          disabled={
                            !runtimeApiConfig ||
                            isLoadingApiConfig ||
                            isSavingThinking
                          }
                          onClick={() => setModelMenuView("thinking")}
                          type="button"
                        >
                          <span className="model-dropdown-item-name">
                            {t("chat.thinkingStrength")}
                          </span>
                          <span className="model-menu-value">
                            {isSavingThinking ? (
                              <Loader2 size={12} className="spin" />
                            ) : (
                              <span className="model-menu-value-text">
                                {thinkingLabel}
                              </span>
                            )}
                            <ChevronRight size={12} />
                          </span>
                        </button>
                        {requestMethod === "responses" && (
                          <button
                            className={`model-dropdown-item model-fast-mode-toggle ${
                              responsesFastModeEnabled ? "active" : ""
                            }`}
                            role="switch"
                            aria-checked={responsesFastModeEnabled}
                            disabled={
                              !runtimeApiConfig ||
                              isLoadingApiConfig ||
                              isSavingFastMode ||
                              isStreaming ||
                              isSubAgentConversation
                            }
                            onClick={() =>
                              void handleToggleResponsesFastMode()
                            }
                            type="button"
                            title={fastModeError ?? t("chat.fastModeHint")}
                          >
                            <span className="model-dropdown-item-name with-icon">
                              <Zap size={14} className="thinking-option-icon" />
                              <span>{t("chat.fastMode")}</span>
                            </span>
                            <span className="model-menu-value">
                              {isSavingFastMode ? (
                                <Loader2 size={12} className="spin" />
                              ) : (
                                <span className="model-menu-value-text">
                                  {t(
                                    responsesFastModeEnabled
                                      ? "chat.fastModeOn"
                                      : "chat.fastModeOff"
                                  )}
                                </span>
                              )}
                            </span>
                          </button>
                        )}
                        {!isSubAgentConversation && apiConfigs.length > 0 && (
                          <button
                            className="model-dropdown-item"
                            onClick={() => setModelMenuView("apiProfile")}
                            type="button"
                          >
                            <span className="model-dropdown-item-name">
                              {labels.selectApiProfile}
                            </span>
                            <span className="model-menu-value">
                              <span
                                className="model-menu-value-text"
                                title={runtimeApiConfig?.displayName}
                              >
                                {runtimeApiConfig?.displayName ||
                                  labels.selectApiProfile}
                              </span>
                              <ChevronRight size={12} />
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                    {modelMenuView === "apiProfile" && (
                      <>
                        <div className="model-menu-header">
                          <button
                            aria-label={t("common.back")}
                            className="model-menu-back"
                            onClick={() => setModelMenuView("root")}
                            type="button"
                          >
                            <ChevronLeft size={14} />
                          </button>
                          <span>{labels.selectApiProfile}</span>
                        </div>
                        <div className="model-dropdown-search">
                          <Search
                            size={13}
                            className="model-dropdown-search-icon"
                          />
                          <input
                            autoFocus
                            className="model-dropdown-search-input"
                            type="text"
                            value={apiProfileSearchQuery}
                            onChange={(event) =>
                              setApiProfileSearchQuery(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                setApiProfileSearchQuery("");
                              }
                            }}
                            placeholder={labels.searchApiProfiles}
                          />
                          {apiProfileSearchQuery && (
                            <button
                              className="model-dropdown-search-clear"
                              type="button"
                              aria-label={labels.searchApiProfiles}
                              onClick={() => setApiProfileSearchQuery("")}
                            >
                              <X size={12} />
                            </button>
                          )}
                        </div>
                        <div className="model-dropdown-list">
                          {apiConfigs.length > 0 &&
                            filteredApiConfigs.length === 0 && (
                              <div className="model-dropdown-empty">
                                {labels.noMatchingApiProfiles}
                              </div>
                            )}
                          {filteredApiConfigs.map((config) => (
                            <button
                              key={config.profileName}
                              className={`model-dropdown-item ${
                                config.profileName === selectedApiProfile
                                  ? "active"
                                  : ""
                              }`}
                              onClick={() => {
                                void handleSelectApiProfile(config.profileName);
                              }}
                              type="button"
                              title={config.displayName}
                            >
                              <span className="model-dropdown-item-name">
                                {config.displayName}
                              </span>
                              <span className="model-dropdown-item-model">
                                {config.advancedModel ||
                                  config.basicModel ||
                                  "-"}
                              </span>
                              {config.profileName === selectedApiProfile && (
                                <Check
                                  size={14}
                                  className="model-dropdown-check"
                                />
                              )}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {modelMenuView === "model" &&
                      (isManualMode ? (
                        <>
                          <div className="model-menu-header">
                            <button
                              aria-label={t("common.back")}
                              className="model-menu-back"
                              onClick={() => setModelMenuView("root")}
                              type="button"
                            >
                              <ChevronLeft size={14} />
                            </button>
                            <span>{labels.manualModel}</span>
                          </div>
                          <div className="model-manual-input">
                            <input
                              autoFocus
                              value={manualValue}
                              onChange={(event) =>
                                setManualValue(event.target.value)
                              }
                              onKeyDown={handleManualKeyDown}
                              placeholder={labels.manualModelPlaceholder}
                              className="model-manual-field"
                            />
                            <div className="model-manual-actions">
                              <button
                                className="model-manual-btn secondary"
                                onClick={() => setIsManualMode(false)}
                                type="button"
                              >
                                {labels.cancel}
                              </button>
                              <button
                                className="model-manual-btn primary"
                                onClick={() => void handleConfirmManualModel()}
                                disabled={!manualValue.trim()}
                                type="button"
                              >
                                {labels.confirm}
                              </button>
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="model-menu-header">
                            <button
                              aria-label={t("common.back")}
                              className="model-menu-back"
                              onClick={() => setModelMenuView("root")}
                              type="button"
                            >
                              <ChevronLeft size={14} />
                            </button>
                            <span>{labels.selectModel}</span>
                          </div>
                          {isLoadingModels && (
                            <div
                              className="model-dropdown-status"
                              aria-live="polite"
                            >
                              <Loader2 size={14} className="spin" />
                              <span>{labels.loadingModels}</span>
                            </div>
                          )}
                          {modelError && (
                            <div className="model-dropdown-error">
                              <AlertCircle size={14} />
                              <span>{modelError}</span>
                              <button
                                className="model-dropdown-retry"
                                onClick={handleRetryFetchModels}
                                disabled={isLoadingModels}
                                type="button"
                              >
                                {labels.retry}
                              </button>
                            </div>
                          )}
                          <div className="model-dropdown-search">
                            <Search
                              size={13}
                              className="model-dropdown-search-icon"
                            />
                            <input
                              autoFocus
                              className="model-dropdown-search-input"
                              type="text"
                              value={modelSearchQuery}
                              onChange={(event) =>
                                setModelSearchQuery(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  setModelSearchQuery("");
                                }
                              }}
                              placeholder={labels.searchModels}
                            />
                            {modelSearchQuery && (
                              <button
                                className="model-dropdown-search-clear"
                                type="button"
                                aria-label={labels.searchModels}
                                onClick={() => setModelSearchQuery("")}
                              >
                                <X size={12} />
                              </button>
                            )}
                          </div>
                          <div className="model-dropdown-list">
                            {models.length === 0 &&
                              !modelError &&
                              !isLoadingModels && (
                                <div className="model-dropdown-empty">
                                  {labels.noModelsFound}
                                </div>
                              )}
                            {models.length > 0 &&
                              filteredModels.length === 0 && (
                                <div className="model-dropdown-empty">
                                  {labels.noMatchingModels}
                                </div>
                              )}
                            {filteredModels.map((model) => (
                              <button
                                key={model.id}
                                className={`model-dropdown-item ${
                                  selectedModel === model.id ? "active" : ""
                                }`}
                                onClick={() => void handleSelectModel(model.id)}
                                type="button"
                                title={model.id}
                              >
                                <span className="model-dropdown-item-name">
                                  {model.id}
                                </span>
                                {selectedModel === model.id && (
                                  <Check
                                    size={14}
                                    className="model-dropdown-check"
                                  />
                                )}
                              </button>
                            ))}
                          </div>
                          <div className="model-dropdown-footer model-dropdown-footer-actions">
                            <button
                              className="model-dropdown-action"
                              onClick={handleRetryFetchModels}
                              disabled={isLoadingModels}
                              title={labels.refreshModels}
                              type="button"
                            >
                              <RefreshCw size={14} />
                              <span>{labels.refreshModels}</span>
                            </button>
                            <button
                              className="model-dropdown-action"
                              onClick={handleOpenManualMode}
                              type="button"
                            >
                              <Keyboard size={14} />
                              <span>{labels.manualModel}</span>
                            </button>
                          </div>
                        </>
                      ))}
                    {modelMenuView === "thinking" && (
                      <ThinkingStrengthMenu
                        open={isModelMenuOpen}
                        value={thinkingValue}
                        options={thinkingOptions}
                        subtitle={requestMethod}
                        showBack
                        onBack={() => setModelMenuView("root")}
                        onSelect={(value) => void handleSelectThinking(value)}
                        saving={isSavingThinking}
                      />
                    )}
                    </div>
                )}
              </div>
              <TokenUsageRing
                tokenUsage={tokenUsage}
                maxContextTokens={runtimeApiConfig?.maxContextTokens ?? null}
                isLoading={isLoadingApiConfig}
              />
              <div className="input-action-buttons">
                {(isStreaming || isAborting) && (
                  <button
                    className={`abort-btn ${isAborting ? "is-aborting" : ""}`}
                    aria-label={
                      isAborting ? "Stopping generation" : "Stop generating"
                    }
                    title={
                      isAborting ? "Stopping generation" : "Stop generating"
                    }
                    onClick={handleAbort}
                    disabled={isAborting}
                    type="button"
                  >
                    {isAborting ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Square size={14} fill="currentColor" />
                    )}
                  </button>
                )}
                <button
                  className="send-btn"
                  aria-label="Send"
                  title="Send"
                  onClick={handleSend}
                  disabled={
                    !value.trim() ||
                    isCompacting ||
                    apiConfigs.length === 0 ||
                    !runtimeApiConfig
                  }
                  type="button"
                >
                  <ArrowUp size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
