import {
  AlertCircle,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Command,
  Target,
  Keyboard,
  Loader2,
  Paperclip,
  RefreshCw,
  Search,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useI18n } from "../../../i18n";
import {
  appleSurfaceTransition,
  useAppleThemeMotion,
} from "../../../hooks/useAppleThemeMotion";
import { Modal } from "../../common/Modal";
import type { ChatInputViewProps } from "./types";
import { TEXT_SNIPPET_THRESHOLD } from "./constants";
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
  insertHtmlAtSelection,
  insertLineBreak,
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
import { ProjectSensitiveCommandsPanel } from "./ProjectSensitiveCommandsPanel";
import { ProjectSkillsPanel } from "./ProjectSkillsPanel";
import { RoleEditorPanel } from "./RoleEditorPanel";
import { StreamMetrics } from "./StreamMetrics";
import { useChatConversationContext } from "../chatMessages";
import { directoryIdToPath } from "../chatMessages/utils/conversationHelpers";
import { collectConversationFileChanges } from "../chatMessages/hooks/fileChangeTracking";
import { useConversationFileChanges } from "./useConversationFileChanges";
import { CommandPanel, type CommandPanelHandle } from "./commands/CommandPanel";
import { createChatCommands } from "./commands/commandRegistry";
import { FileChangesPanel } from "./commands/FileChangesPanel";
import { ReviewPanel } from "./commands/ReviewPanel";
import type { ChatCommand } from "./commands/types";

export const ChatInputView = ({
  placeholder,
  projectId,
  projectName,
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
  restoreContent,
}: ChatInputViewProps): React.JSX.Element => {
  const { t } = useI18n();
  const { enabled: appleMotionEnabled, reducedMotion } = useAppleThemeMotion();
  const popoverTransition = appleSurfaceTransition(reducedMotion);
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
  const [isCustomThinkingMode, setIsCustomThinkingMode] = useState(false);
  const [customThinkingValue, setCustomThinkingValue] = useState("");
  // 模型列表搜索关键词，仅 model 视图生效
  const [modelSearchQuery, setModelSearchQuery] = useState("");

  // 菜单关闭时退出自定义思考强度输入
  useEffect(() => {
    if (!isModelMenuOpen) {
      setIsCustomThinkingMode(false);
    }
  }, [isModelMenuOpen]);

  // 关闭菜单或离开模型列表视图时清空搜索词
  useEffect(() => {
    if (!isModelMenuOpen || modelMenuView !== "model") {
      setModelSearchQuery("");
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
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(true);
        },
        onOpenMcpPanel: () => {
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectMcpOpen(true);
        },
        onOpenRolePanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsFileChangesOpen(false);
          setIsRoleEditorOpen(true);
        },
        onOpenSensitiveCommandsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectSensitiveCommandsOpen(true);
        },
        onOpenSkillsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectSkillsOpen(true);
        },
        onOpenCodebasePanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectCodebaseOpen(true);
        },
        onOpenReviewPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
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
  const isCustomThinkingValue = !thinkingOptions.some(
    (option) => option.value === thinkingValue
  );

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
      textareaRef.current.dataset.empty =
        content.trim() === "" ? "true" : "false";
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
  useEffect(() => {
    const handleInsertElementTag = (event: Event) => {
      const tag = (event as CustomEvent<ElementTag>).detail;
      if (!tag) {
        return;
      }
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      insertHtmlAtSelection(createElementChipHtml(tag));
      syncContent();
    };
    window.addEventListener(INSERT_ELEMENT_TAG_EVENT, handleInsertElementTag);
    return () => {
      window.removeEventListener(INSERT_ELEMENT_TAG_EVENT, handleInsertElementTag);
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

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      isDraggingOverRef.current = false;
      if (textareaRef.current) {
        textareaRef.current.classList.remove("drag-over");
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
        }
        return;
      }

      try {
        const parsed = JSON.parse(jsonData) as Record<string, unknown>;

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
    [insertExternalFiles, insertFileTags, syncContent, textareaRef]
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const types = event.dataTransfer.types;
      // 应用内拖拽（文件/commit/change 标签）走 application/json；
      // 从文件管理器拖入的外部文件走 Files。两者均需 preventDefault
      // 才能允许 drop，否则浏览器默认拒绝（显示禁止光标）。
      const allowed =
        types.includes("application/json") || types.includes("Files");
      if (!allowed) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!isDraggingOverRef.current && textareaRef.current) {
        isDraggingOverRef.current = true;
        textareaRef.current.classList.add("drag-over");
      }
    },
    [textareaRef]
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

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const nativeEvent = event.nativeEvent;
      const isComposing =
        nativeEvent.isComposing ||
        (nativeEvent as unknown as { keyCode?: number }).keyCode === 229;

      if (isComposing) {
        return;
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

      handleKeyDown(event);
    },
    [handleKeyDown, isCommandOpen, isMentionOpen, syncContent]
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
        "[data-file-tag='true'],[data-commit-tag='true'],[data-change-tag='true'],[data-review-tag='true'],[data-element-tag='true']"
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

  const handleSelectFilesAndFolders = useCallback(async () => {
    try {
      const selected = await window.snow.selectFiles(
        t("plusMenu.selectFilesTitle")
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
            id: "files-and-folders",
            label: t("plusMenu.filesAndFolders"),
            icon: Paperclip,
            onSelect: () => void handleSelectFilesAndFolders(),
          },
        ],
      },
    ],
    [t, handleSelectFilesAndFolders]
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

  const handleOpenCustomThinking = useCallback(() => {
    setCustomThinkingValue(isCustomThinkingValue ? thinkingValue : "");
    setIsCustomThinkingMode(true);
  }, [isCustomThinkingValue, thinkingValue]);

  const handleConfirmCustomThinking = useCallback(async () => {
    const nextValue = customThinkingValue.trim();
    if (!nextValue || isSavingThinking) {
      return;
    }

    await handleSelectThinking(nextValue);
    setIsCustomThinkingMode(false);
  }, [customThinkingValue, handleSelectThinking, isSavingThinking]);

  const handleCustomThinkingKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (event.nativeEvent.isComposing) {
          return;
        }

        event.preventDefault();
        void handleConfirmCustomThinking();
      } else if (event.key === "Escape") {
        setIsCustomThinkingMode(false);
      }
    },
    [handleConfirmCustomThinking]
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
            onClick={(event) => {
              handleChipRemove(event);
              handleTextSnippetClick(event);
            }}
          />
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
                  disabled={isStreaming || isSubAgentConversation}
                  title={
                    isSubAgentConversation
                      ? t("chat.subAgentModelFixed")
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
                  <ChevronDown size={12} />
                </button>
                <AnimatePresence initial={false}>
                  {isModelMenuOpen && (
                    <motion.div
                      animate={
                        appleMotionEnabled
                          ? reducedMotion
                            ? { opacity: 1 }
                            : { opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }
                          : undefined
                      }
                      className={`model-dropdown drop-${modelDropdownDir}`}
                      exit={
                        appleMotionEnabled
                          ? reducedMotion
                            ? { opacity: 0 }
                            : { opacity: 0, scale: 0.98, y: -4, filter: "blur(1px)" }
                          : undefined
                      }
                      initial={
                        appleMotionEnabled
                          ? reducedMotion
                            ? { opacity: 0 }
                            : { opacity: 0, scale: 0.98, y: -4, filter: "blur(1px)" }
                          : false
                      }
                      transition={appleMotionEnabled ? popoverTransition : undefined}
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
                        <div className="model-dropdown-list">
                          {apiConfigs.map((config) => (
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
                    {modelMenuView === "thinking" &&
                      (isCustomThinkingMode ? (
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
                            <span>{t("chat.customThinkingStrength")}</span>
                          </div>
                          <div className="model-manual-input thinking-custom-input">
                            <input
                              autoFocus
                              value={customThinkingValue}
                              onChange={(event) =>
                                setCustomThinkingValue(event.target.value)
                              }
                              onKeyDown={handleCustomThinkingKeyDown}
                              placeholder={t("chat.customThinkingPlaceholder")}
                              className="model-manual-field thinking-custom-field"
                              maxLength={64}
                            />
                            <div className="model-manual-actions thinking-custom-actions">
                              <button
                                className="model-manual-btn thinking-custom-btn secondary"
                                onClick={() => setIsCustomThinkingMode(false)}
                                type="button"
                              >
                                {labels.cancel}
                              </button>
                              <button
                                className="model-manual-btn thinking-custom-btn primary"
                                onClick={() =>
                                  void handleConfirmCustomThinking()
                                }
                                disabled={
                                  !customThinkingValue.trim() ||
                                  isSavingThinking
                                }
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
                            <span>{t("chat.thinkingStrength")}</span>
                            <small>{requestMethod}</small>
                          </div>
                          <div className="model-dropdown-list">
                            {thinkingOptions.map((option) => {
                              const ThinkingOptionIcon = option.icon;

                              return (
                                <button
                                  key={option.value}
                                  className={`model-dropdown-item ${
                                    thinkingValue === option.value
                                      ? "active"
                                      : ""
                                  }`}
                                  onClick={() =>
                                    void handleSelectThinking(option.value)
                                  }
                                  type="button"
                                >
                                  <span className="model-dropdown-item-name with-icon">
                                    <ThinkingOptionIcon
                                      size={14}
                                      className="thinking-option-icon"
                                    />
                                    <span>{option.label}</span>
                                  </span>
                                  {thinkingValue === option.value && (
                                    <Check
                                      size={14}
                                      className="model-dropdown-check"
                                    />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                          <div className="model-dropdown-footer">
                            <button
                              className={`model-dropdown-action ${
                                isCustomThinkingValue ? "active" : ""
                              }`}
                              onClick={handleOpenCustomThinking}
                              type="button"
                            >
                              <Keyboard size={14} />
                              <span>{t("chat.customThinking")}</span>
                              {isCustomThinkingValue && (
                                <Check
                                  size={14}
                                  className="model-dropdown-check"
                                />
                              )}
                            </button>
                          </div>
                        </>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
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
                  disabled={!value.trim() || isCompacting}
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
