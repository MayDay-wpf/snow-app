import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { TEXT_SNIPPET_THRESHOLD } from "./constants";
import {
  CHIPS_CLIPBOARD_TYPE,
  buildSegmentsHtml,
  buildTextSnippetSummary,
  createChangeChipHtml,
  createChipHtml,
  createCommitChipHtml,
  createConversationChipHtml,
  createTextSnippetChipHtml,
  insertHtmlAtSelection,
  insertLineBreak,
  parseContentSegments,
  readEditableContent,
  readEditableContentAsPlainText,
  type ChangeTag,
  type CommitTag,
  type ContentSegment,
  type ConversationTag,
  type FileTag,
  type TextSnippetTag,
  type WebTag,
} from "./fileTagUtils";
import type { FileMentionPopupHandle } from "./FileMentionPopup";
import type { CommandPanelHandle } from "./commands/CommandPanel";
import type { ChatCommand } from "./commands/types";
import {
  TERMINAL_DRAG_MIME,
  type TerminalDragPayload,
} from "../../rightPanel/terminal/terminalMonitor";
import {
  CONVERSATION_DRAG_MIME,
  endConversationDrag,
  readConversationDragPayload,
} from "../../sidebar/mainSidebar/conversationDrag";
import type { InputFileOperationsResult } from "./useInputFileOperations";
import type { SendKeyMode } from "./types";

type HistoryMessage = {
  content: string;
};

type UseContentEditableInteractionsOptions = {
  textareaRef: RefObject<HTMLDivElement | null>;
  value: string;
  restoreContent: (content: string) => void;
  handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  sendKeyMode: SendKeyMode;
  userHistoryMessages: HistoryMessage[];
  activeConversationId?: string | null;
  conversationDirectoryId?: string | null;
  projectId?: string;
  isSubAgentConversation: boolean;
  commands: ChatCommand[];
  onStartTerminalMonitor: (payload: TerminalDragPayload) => void;
  fileOperations: Pick<
    InputFileOperationsResult,
    | "syncContent"
    | "insertFileTag"
    | "insertFileTags"
    | "insertImageFromFile"
    | "insertImageFiles"
    | "insertExternalFiles"
    | "insertDroppedPlainText"
    | "insertWebTag"
  >;
};

export type ContentEditableInteractionsResult = {
  mentionAnchorRef: RefObject<HTMLDivElement | null>;
  mentionPopupRef: RefObject<FileMentionPopupHandle | null>;
  isMentionOpen: boolean;
  mentionQuery: string;
  handleCloseMention: () => void;
  handleMentionSelect: (tag: FileTag) => void;
  handleMentionSelectBatch: (tags: FileTag[]) => void;
  handleMentionDragStart: (
    event: React.DragEvent<HTMLDivElement>,
    tag: FileTag,
  ) => void;
  handleMentionNavigateTo: (relPath: string) => void;
  commandPanelRef: RefObject<CommandPanelHandle | null>;
  commandTriggerRef: RefObject<HTMLButtonElement | null>;
  isCommandOpen: boolean;
  commandQuery: string;
  handleCloseCommand: () => void;
  handleToggleCommand: () => void;
  handleCommandSelect: (command: ChatCommand) => void;
  handleInput: () => void;
  handleInputKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleCopy: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  handleCut: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  handlePaste: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  handleDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  handleDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
};

export const useContentEditableInteractions = ({
  textareaRef,
  value,
  restoreContent,
  handleKeyDown,
  sendKeyMode,
  userHistoryMessages,
  activeConversationId,
  conversationDirectoryId,
  projectId,
  isSubAgentConversation,
  commands,
  onStartTerminalMonitor,
  fileOperations,
}: UseContentEditableInteractionsOptions): ContentEditableInteractionsResult => {
  const {
    syncContent,
    insertFileTag,
    insertFileTags,
    insertImageFromFile,
    insertImageFiles,
    insertExternalFiles,
    insertDroppedPlainText,
    insertWebTag,
  } = fileOperations;
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const mentionAnchorRef = useRef<HTMLDivElement>(null);
  const mentionPopupRef = useRef<FileMentionPopupHandle>(null);
  const mentionStartOffsetRef = useRef<number>(-1);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const commandPanelRef = useRef<CommandPanelHandle>(null);
  const commandTriggerRef = useRef<HTMLButtonElement>(null);
  const isDraggingOverRef = useRef(false);
  const historyIndexRef = useRef(-1);

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
    [deleteMentionQuery, insertFileTag],
  );

  const handleMentionSelectBatch = useCallback(
    (tags: FileTag[]) => {
      deleteMentionQuery();
      insertFileTags(tags);
    },
    [deleteMentionQuery, insertFileTags],
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
    [handleCloseCommand, restoreContent],
  );

  const handleMentionDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, tag: FileTag) => {
      event.dataTransfer.setData("application/json", JSON.stringify(tag));
      event.dataTransfer.effectAllowed = "copy";
    },
    [],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      isDraggingOverRef.current = false;
      textareaRef.current?.classList.remove("drag-over");

      const terminalData = event.dataTransfer.getData(TERMINAL_DRAG_MIME);
      if (terminalData) {
        try {
          const payload = JSON.parse(terminalData) as TerminalDragPayload;
          if (payload && typeof payload.tabId === "string") {
            onStartTerminalMonitor(payload);
          }
        } catch {
          // Ignore malformed terminal drag data
        }
        return;
      }

      const conversationPayload = readConversationDragPayload(
        event.dataTransfer,
      );
      if (conversationPayload) {
        endConversationDrag();
        // 会话引用统一作为 chip 插入编辑区（与文件/提交等标签同一套机制），
        // 发送时由 useAgentLoop 提取并转为真实的上下文附件。
        const conversationTag: ConversationTag = {
          conversationId: conversationPayload.conversationId,
          directoryId: conversationPayload.directoryId,
          title: conversationPayload.title,
          emoji: conversationPayload.emoji,
        };
        textareaRef.current?.focus();
        insertHtmlAtSelection(createConversationChipHtml(conversationTag));
        syncContent();
        return;
      }

      const droppedFiles = Array.from(event.dataTransfer.files);
      const imageFiles = droppedFiles.filter((file) =>
        file.type.startsWith("image/"),
      );
      if (imageFiles.length > 0) {
        insertImageFiles(imageFiles);
        return;
      }

      const jsonData = event.dataTransfer.getData("application/json");
      if (!jsonData) {
        const externalFiles = event.dataTransfer.files;
        if (externalFiles && externalFiles.length > 0) {
          const files: File[] = [];
          for (let i = 0; i < externalFiles.length; i++) {
            const file = externalFiles.item(i);
            if (file) {
              files.push(file);
            }
          }
          insertExternalFiles(files);
          return;
        }
        const plainText = event.dataTransfer.getData("text/plain");
        if (plainText && plainText.trim().length > 0) {
          insertDroppedPlainText(plainText);
        }
        return;
      }

      try {
        const parsed = JSON.parse(jsonData) as Record<string, unknown>;
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
          insertWebTag(tag, {
            instanceId:
              typeof parsed.instanceId === "string" &&
              parsed.instanceId.length > 0
                ? parsed.instanceId
                : undefined,
            tabId: typeof parsed.tabId === "string" ? parsed.tabId : "",
          });
          return;
        }

        if (parsed.type === "file-tags" && Array.isArray(parsed.tags)) {
          const tags: FileTag[] = parsed.tags
            .filter(
              (item) =>
                item &&
                typeof item === "object" &&
                typeof (item as Record<string, unknown>).path === "string" &&
                typeof (item as Record<string, unknown>).name === "string",
            )
            .map((item) => {
              const data = item as Record<string, unknown>;
              const rawLines = data.lines;
              const lines = Array.isArray(rawLines)
                ? rawLines
                    .map((line) =>
                      typeof line === "number"
                        ? line
                        : Number.parseInt(String(line), 10),
                    )
                    .filter((line) => Number.isFinite(line) && line > 0)
                : undefined;
              return {
                path: data.path as string,
                name: data.name as string,
                isDirectory: data.isDirectory === true,
                lines: data.isDirectory === true ? undefined : lines,
              };
            });
          if (tags.length > 0) {
            insertFileTags(tags);
          }
          return;
        }

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
          textareaRef.current?.focus();
          insertHtmlAtSelection(createCommitChipHtml(tag));
          syncContent();
          return;
        }

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
          textareaRef.current?.focus();
          insertHtmlAtSelection(createChangeChipHtml(tag));
          syncContent();
          return;
        }

        if (
          typeof parsed.path === "string" &&
          typeof parsed.name === "string"
        ) {
          const rawLines = parsed.lines;
          const lines = Array.isArray(rawLines)
            ? rawLines
                .map((line) =>
                  typeof line === "number"
                    ? line
                    : Number.parseInt(String(line), 10),
                )
                .filter((line) => Number.isFinite(line) && line > 0)
            : undefined;
          const tag: FileTag = {
            path: parsed.path,
            name: parsed.name,
            isDirectory: parsed.isDirectory === true,
            lines: parsed.isDirectory === true ? undefined : lines,
          };
          textareaRef.current?.focus();
          insertHtmlAtSelection(createChipHtml(tag));
          syncContent();
        }
      } catch {
        // Ignore invalid drag data
      }
    },
    [
      endConversationDrag,
      insertDroppedPlainText,
      insertExternalFiles,
      insertFileTags,
      insertImageFiles,
      insertWebTag,
      onStartTerminalMonitor,
      readConversationDragPayload,
      syncContent,
      textareaRef,
    ],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const types = event.dataTransfer.types;
      const hasConversationDrag = types.includes(CONVERSATION_DRAG_MIME);
      if (hasConversationDrag) {
        const payload = readConversationDragPayload(event.dataTransfer);
        const effectiveDirectoryId = conversationDirectoryId || projectId;
        const hasTarget = !!activeConversationId;
        const conversationAllowed =
          !!payload &&
          !isSubAgentConversation &&
          payload.directoryId === effectiveDirectoryId &&
          (!hasTarget || payload.conversationId !== activeConversationId);
        if (!conversationAllowed) {
          return;
        }
      }

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
      activeConversationId,
      conversationDirectoryId,
      isSubAgentConversation,
      projectId,
      textareaRef,
    ],
  );

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.currentTarget === event.target) {
        isDraggingOverRef.current = false;
        textareaRef.current?.classList.remove("drag-over");
      }
    },
    [textareaRef],
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
    [serializeSelectionForClipboard],
  );

  const handleCopy = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      writeSelectionToClipboard(event);
    },
    [writeSelectionToClipboard],
  );

  const handleCut = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!writeSelectionToClipboard(event)) {
        return;
      }
      document.execCommand("delete");
      syncContent();
    },
    [writeSelectionToClipboard, syncContent],
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
        if (item.type.startsWith("image/")) {
          imageItems.push(item);
        } else {
          fileItems.push(item);
        }
      }
      if (imageItems.length > 0) {
        for (const imageItem of imageItems) {
          const file = imageItem.getAsFile();
          if (file) {
            insertImageFromFile(file);
          }
        }
      }
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
        textareaRef.current?.focus();
        insertHtmlAtSelection(buildSegmentsHtml(normalized));
        syncContent();
      };

      const chipsData = event.clipboardData.getData(CHIPS_CLIPBOARD_TYPE);
      if (chipsData) {
        insertSegmentedContent(parseContentSegments(chipsData));
        return;
      }
      const text = event.clipboardData.getData("text/plain");
      if (!text) {
        return;
      }
      const segments = parseContentSegments(text);
      if (segments.some((segment) => segment.type !== "text")) {
        insertSegmentedContent(segments);
        return;
      }
      if (text.length > TEXT_SNIPPET_THRESHOLD) {
        const tag: TextSnippetTag = {
          content: text,
          summary: buildTextSnippetSummary(text),
          charCount: text.length,
        };
        textareaRef.current?.focus();
        insertHtmlAtSelection(createTextSnippetChipHtml(tag));
        syncContent();
        return;
      }
      document.execCommand("insertText", false, text);
      syncContent();
      checkInputTriggers();
    },
    [
      checkInputTriggers,
      insertExternalFiles,
      insertImageFromFile,
      syncContent,
      textareaRef,
    ],
  );

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
      if (currentOffset < start) {
        return;
      }
      range.setStart(textNode, start);
      range.setEnd(textNode, currentOffset);
      range.deleteContents();
      selection.removeAllRanges();
      selection.addRange(range);
      const newText = relPath ? `${relPath}/` : "";
      if (newText) {
        document.execCommand("insertText", false, newText);
      }
      checkInputTriggers();
    },
    [checkInputTriggers, textareaRef],
  );

  const handleMentionNavigateTo = useCallback(
    (relPath: string) => {
      replaceMentionQuery(relPath);
    },
    [replaceMentionQuery],
  );

  const handleInput = useCallback(() => {
    syncContent();
    checkInputTriggers();
  }, [syncContent, checkInputTriggers]);

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
        historyIndexRef.current = -1;
        restoreContent("");
        return true;
      }
      const next = current - 1;
      historyIndexRef.current = next;
      restoreContent(userHistoryMessages[count - 1 - next].content);
      return true;
    },
    [restoreContent, userHistoryMessages, value],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
        return;
      }
      const el = textareaRef.current;
      if (!el || document.activeElement === el) {
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
      if (event.key === "Enter") {
        const hasMod = event.ctrlKey || event.metaKey;
        const isSendCombo =
          sendKeyMode === "ctrlEnter"
            ? hasMod && !event.shiftKey && !event.altKey
            : !hasMod && !event.shiftKey && !event.altKey;
        if (isSendCombo) {
          historyIndexRef.current = -1;
        } else if (hasMod) {
          // 不构成发送组合键的修饰回车（如 Enter 模式下的 Ctrl+Enter）换行。
          event.preventDefault();
          insertLineBreak();
          syncContent();
          return;
        }
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
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (recallHistory(event.key === "ArrowUp" ? "up" : "down")) {
          event.preventDefault();
          return;
        }
      }
      if (
        event.key === "Enter" &&
        sendKeyMode === "ctrlEnter" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        // Ctrl+Enter 模式下的裸 Enter：插入换行而不是发送。
        event.preventDefault();
        insertLineBreak();
        syncContent();
        return;
      }
      handleKeyDown(event);
    },
    [
      handleKeyDown,
      isCommandOpen,
      isMentionOpen,
      recallHistory,
      sendKeyMode,
      syncContent,
    ],
  );

  return {
    mentionAnchorRef,
    mentionPopupRef,
    isMentionOpen,
    mentionQuery,
    handleCloseMention,
    handleMentionSelect,
    handleMentionSelectBatch,
    handleMentionDragStart,
    handleMentionNavigateTo,
    commandPanelRef,
    commandTriggerRef,
    isCommandOpen,
    commandQuery,
    handleCloseCommand,
    handleToggleCommand,
    handleCommandSelect,
    handleInput,
    handleInputKeyDown,
    handleCopy,
    handleCut,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragLeave,
  };
};
