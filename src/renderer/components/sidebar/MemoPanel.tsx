import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  CheckCircle2,
  CheckSquare,
  Circle,
  ListChecks,
  Loader2,
  Plus,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEscapeClose } from "../../hooks/useEscapeClose";
import { useSplitResize } from "../../hooks/useSplitResize";
import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { CustomSelect } from "../common/CustomSelect";
import { HighlightedText } from "../common/HighlightedText";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { encodePluginTag, type PluginTag } from "../../plugins/pluginMentions";
import {
  createMentionChipHtml,
  encodeFileTag,
  encodeImageTag,
  encodeSkillTag,
  insertHtmlAtSelection,
  parseLinesStr,
  type MentionTag,
  type SkillTag,
} from "../mainContent/chatInput/fileTagUtils";
import {
  FileMentionPopup,
  type FileMentionPopupHandle,
} from "../mainContent/chatInput/FileMentionPopup";
import { formatTimeLabel, parseDbTimestamp } from "./mainSidebar/chatTimeGroup";
import {
  MEMOS_AI_CHANGED_EVENT,
  notifyMemosChanged,
  type MemosAiChangedDetail,
} from "./memoEvents";
import type {
  MemoPage,
  MemoRecord,
  MemoSortField,
  MemoStatus,
} from "../../../preload";

const PAGE_SIZE = 20;
const SAVE_DEBOUNCE_MS = 600;
/** 与样式表中 .file-mention-popup 的 max-height 保持一致。 */
const MENTION_POPUP_MAX_HEIGHT = 340;
const SEARCH_DEBOUNCE_MS = 300;
const PREVIEW_MAX_LEN = 120;
/** 命中关键词时预览片段在命中位置前后各保留的字符数。 */
const PREVIEW_MATCH_CONTEXT = 40;

type MemoFilter = "all" | MemoStatus;

type MemoSortOrder = "asc" | "desc";

type MemoPanelProps = {
  directoryId: string;
  onClose: () => void;
};

const clipPreview = (text: string): string =>
  text.length <= PREVIEW_MAX_LEN
    ? text
    : `${text.slice(0, PREVIEW_MAX_LEN)}...`;

/** 去掉富文本标签与多余空白，得到列表预览用的纯文本。 */
const toPlainPreviewText = (content: string): string =>
  content
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * 列表预览文本。命中关键词时围绕命中位置截取一段，让命中落在正文深处
 * （超过 120 字）的备忘录也能一眼看到关键词高亮。
 */
const buildLocalPreview = (content: string, keyword: string): string => {
  const plain = toPlainPreviewText(content);
  if (!keyword) return clipPreview(plain);
  const hitIndex = plain.toLowerCase().indexOf(keyword.toLowerCase());
  if (hitIndex < 0) return clipPreview(plain);
  const start = Math.max(0, hitIndex - PREVIEW_MATCH_CONTEXT);
  const end = Math.min(
    plain.length,
    hitIndex + keyword.length + PREVIEW_MATCH_CONTEXT,
  );
  const snippet = plain.slice(start, end);
  return `${start > 0 ? "..." : ""}${snippet}${end < plain.length ? "..." : ""}`;
};

/**
 * 将编辑器中的引用 chip 还原为聊天输入的标签格式，让「生成任务」把
 * memo 内的文件/目录/技能/工具插件/图片引用一并发给 AI。
 */
const chipHtmlToChatTag = (el: HTMLElement): string | null => {
  if (el.dataset.fileTag === "true") {
    const path = el.dataset.filePath ?? "";
    if (!path) return null;
    const isDirectory = el.dataset.fileIsDir === "true";
    const linesRaw = isDirectory ? undefined : el.dataset.fileLines;
    return encodeFileTag({
      path,
      name: el.dataset.fileName || path,
      isDirectory,
      lines: linesRaw ? parseLinesStr(linesRaw) : undefined,
    });
  }

  if (el.dataset.skillTag === "true") {
    try {
      const data = JSON.parse(
        el.dataset.skillData ?? "{}",
      ) as Partial<SkillTag>;
      if (!data.skillId) return null;
      return encodeSkillTag({
        skillId: data.skillId,
        name: data.name || data.skillId,
        description: data.description ?? "",
        location: data.location === "project" ? "project" : "global",
      });
    } catch {
      return null;
    }
  }

  if (el.dataset.pluginTag === "true") {
    try {
      const data = JSON.parse(
        el.dataset.pluginData ?? "{}",
      ) as Partial<PluginTag>;
      if (!data.pluginId) return null;
      return encodePluginTag({
        pluginId: data.pluginId,
        name: data.name || data.pluginId,
      });
    } catch {
      return null;
    }
  }

  if (el.dataset.imageTag === "true") {
    const dataUrl = el.dataset.imageDataUrl ?? "";
    if (!dataUrl) return null;
    return encodeImageTag({
      name: el.dataset.imageName || "image.png",
      dataUrl,
    });
  }

  return null;
};

/**
 * Converts the rich-text editor HTML into the chat input's tagged format:
 *  - <img src="data:..."> becomes @@image:data:...@@
 *  - reference chips become @@file/@@dir/@@skill/@@plugin/@@image tags
 *  - <br> / </p> / </div> become newlines
 *  - remaining HTML tags are stripped to plain text
 * This mirrors how ChatInput serialises content (readEditableContent + encodeImageTag).
 */
const memoHtmlToChatContent = (html: string): string => {
  const container = document.createElement("div");
  container.innerHTML = html;

  const result: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      result.push((node.textContent ?? "").replace(/\u200B/g, ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    const chatTag = chipHtmlToChatTag(el);
    if (chatTag) {
      result.push(chatTag);
      return;
    }

    if (tag === "img") {
      const src = el.getAttribute("src") ?? "";
      if (src) {
        result.push(`@@image:${src}@@`);
      }
      return;
    }

    const children = Array.from(el.childNodes);
    if (tag === "br" || tag === "p" || tag === "div") {
      children.forEach(walk);
      result.push("\n");
      return;
    }

    children.forEach(walk);
  };

  Array.from(container.childNodes).forEach(walk);
  return result
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

export function MemoPanel({
  directoryId,
  onClose,
}: MemoPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const { buildFromContent } = useChatConversationContext();
  const {
    containerRef: layoutRef,
    width: sidebarWidth,
    onResizeStart: handleResizeStart,
  } = useSplitResize({
    variableName: "--memo-split-width",
    storageKey: "snow:memo:sidebar-width",
    defaultWidth: 340,
  });
  const [memos, setMemos] = useState<MemoRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filter, setFilter] = useState<MemoFilter>("all");
  const [sortField, setSortField] = useState<MemoSortField>("updated");
  const [sortOrder, setSortOrder] = useState<MemoSortOrder>("desc");
  // 搜索框的原始输入与防抖后真正下发的关键词（后者驱动查询与高亮）
  const [searchInput, setSearchInput] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [selectedMemoId, setSelectedMemoId] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MemoRecord | null>(null);
  const [buildTarget, setBuildTarget] = useState<MemoRecord | null>(null);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedMemoIds, setSelectedMemoIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isBatchDeleteConfirmOpen, setIsBatchDeleteConfirmOpen] =
    useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  // @ 引用面板：查询文本以 @ 之后的输入为准
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  // 首帧先隐藏，等定位计算完成后再显示，避免弹窗闪到视口外
  const [mentionPopupStyle, setMentionPopupStyle] =
    useState<React.CSSProperties>({ visibility: "hidden" });
  const listScrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingMoreRef = useRef(false);
  const requestIdRef = useRef(0);
  const editorFocusedRef = useRef(false);
  const lastSavedContentRef = useRef("");
  const mentionPopupRef = useRef<FileMentionPopupHandle>(null);
  // @ 在编辑器纯文本中的位置（@ 之后的下标）
  const mentionStartOffsetRef = useRef<number>(-1);
  // 编辑器内的最后一段光标区间。点击 @ 面板时浏览器可能清空选区，
  // 需要靠它把光标还原回编辑器再插入 chip。
  const editorRangeRef = useRef<Range | null>(null);

  // Refs that always hold the latest values, so async save handlers can read
  // them without being trapped by stale useCallback closures. This is the key
  // fix for content not being persisted: previously flushSave captured
  // selectedMemoId via useCallback deps, but when called from
  // handleSelectMemo/handleCreate it would reference an outdated memo id or a
  // stale lastSavedContentRef that the "sync editor" effect had already reset.
  const selectedMemoIdRef = useRef<string | null>(null);
  const memosRef = useRef<MemoRecord[]>([]);
  // Cache of the editor's current innerHTML (refreshed on every input). The
  // contentEditable editor is gone by the time the unmount flush runs, so
  // editorRef.current is null there — reading from this cache guarantees we
  // persist the last-typed content instead of an empty string that would wipe
  // the database row.
  const editorHtmlRef = useRef("");

  const closeMention = useCallback(() => {
    setIsMentionOpen(false);
    setMentionQuery("");
    mentionStartOffsetRef.current = -1;
  }, []);

  const captureEditorRange = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return;
    editorRangeRef.current = range.cloneRange();
  }, []);

  /**
   * @ 引用操作（删除查询词 / 插入 chip / 路径导航）使用的锚点区间。
   * 点击面板时浏览器会清空编辑器选区，因此以 @ 触发时记录的光标为准；
   * 点击面板不会走 here，仅当记录失效时才回退当前选区。
   */
  const getMentionAnchorRange = useCallback((): Range | null => {
    const editor = editorRef.current;
    if (!editor) return null;
    const saved = editorRangeRef.current;
    if (saved && editor.contains(saved.startContainer)) {
      return saved;
    }
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const live = selection.getRangeAt(0);
      if (editor.contains(live.startContainer)) return live;
    }
    return null;
  }, []);

  const placeEditorCaret = useCallback((range: Range) => {
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  useEffect(() => {
    selectedMemoIdRef.current = selectedMemoId;
  }, [selectedMemoId]);

  useEffect(() => {
    memosRef.current = memos;
  }, [memos]);

  const selectedMemo = useMemo(
    () => memos.find((memo) => memo.memoId === selectedMemoId) ?? null,
    [memos, selectedMemoId],
  );

  const loadFirstPage = useCallback(
    async (
      currentFilter: MemoFilter,
      currentSortField: MemoSortField,
      currentSortOrder: MemoSortOrder,
      currentKeyword: string,
    ) => {
      const currentRequestId = ++requestIdRef.current;
      setIsLoading(true);
      try {
        const statusParam = currentFilter === "all" ? undefined : currentFilter;
        const page = await window.snow.listMemos(
          directoryId,
          PAGE_SIZE,
          0,
          statusParam,
          currentSortField,
          currentSortOrder,
          currentKeyword || undefined,
        );
        if (currentRequestId !== requestIdRef.current) return;
        setMemos(page.items);
        setTotalCount(page.total);
        setHasMore(page.hasMore);
      } catch {
        if (currentRequestId === requestIdRef.current) {
          setMemos([]);
          setTotalCount(0);
          setHasMore(false);
        }
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    },
    [directoryId],
  );

  useEffect(() => {
    void loadFirstPage(filter, sortField, sortOrder, searchKeyword);
  }, [filter, sortField, sortOrder, searchKeyword, loadFirstPage]);

  // AI（app-control）改动备忘后重新拉取列表。被删除的选中项需等列表刷新完成
  // 再回退：若先清空选中，「自动选中首条」effect 会读到旧列表而选回已删条目。
  useEffect(() => {
    const handleAiChanged = (event: Event) => {
      const deletedIds = new Set(
        (event as CustomEvent<MemosAiChangedDetail>).detail?.deletedIds ?? [],
      );
      void (async () => {
        await loadFirstPage(filter, sortField, sortOrder, searchKeyword);
        if (deletedIds.size === 0) return;
        setSelectedMemoIds((prev) => {
          const next = new Set([...prev].filter((id) => !deletedIds.has(id)));
          return next.size === prev.size ? prev : next;
        });
        if (
          selectedMemoIdRef.current &&
          deletedIds.has(selectedMemoIdRef.current)
        ) {
          setSelectedMemoId(null);
        }
      })();
    };
    window.addEventListener(MEMOS_AI_CHANGED_EVENT, handleAiChanged);
    return () => {
      window.removeEventListener(MEMOS_AI_CHANGED_EVENT, handleAiChanged);
    };
  }, [filter, sortField, sortOrder, searchKeyword, loadFirstPage]);

  // 关键词防抖：输入停顿后才重新查询；清空立即恢复完整列表。
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === searchKeyword) return;
    const timer = window.setTimeout(
      () => setSearchKeyword(trimmed),
      trimmed === "" ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [searchInput, searchKeyword]);

  // 面板内快捷键：`/` 或 Ctrl/Cmd+K 聚焦搜索框。
  // 编辑器/输入框里输入 "/" 保持原样，只有 Ctrl/Cmd+K 会强制聚焦。
  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const withModifier = event.ctrlKey || event.metaKey;
      const isFocusShortcut = withModifier && event.key.toLowerCase() === "k";
      const isSlashShortcut =
        event.key === "/" && !withModifier && !event.altKey;
      if (!isFocusShortcut && !isSlashShortcut) return;

      const active = document.activeElement as HTMLElement | null;
      const isEditing =
        active?.isContentEditable === true ||
        active?.tagName === "INPUT" ||
        active?.tagName === "TEXTAREA";
      if (!isFocusShortcut && isEditing) return;

      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, []);

  // When the active project (directoryId) changes, reset the selection and
  // editor so stale content from another project is never shown. The
  // list/editor will be repopulated by the loadFirstPage effect above.
  // 检索词同样清空：备忘按项目隔离，旧关键词在新项目里无意义。
  useEffect(() => {
    setSelectedMemoId(null);
    setSearchInput("");
    setSearchKeyword("");
    setEditorContent("");
    setIsMultiSelectMode(false);
    setSelectedMemoIds(new Set());
    lastSavedContentRef.current = "";
    closeMention();
    editorRangeRef.current = null;
    if (editorRef.current) editorRef.current.textContent = "";
  }, [directoryId, closeMention]);

  // Auto-select the first memo on mount (or after creating the first one)
  useEffect(() => {
    if (selectedMemoId) return;
    if (memos.length > 0) {
      setSelectedMemoId(memos[0].memoId);
    } else {
      setSelectedMemoId(null);
      setEditorContent("");
      lastSavedContentRef.current = "";
      if (editorRef.current) editorRef.current.textContent = "";
    }
  }, [memos, selectedMemoId]);

  // 仅依赖 memoId 同步编辑器:自动保存会把同 id 的新对象刷进 memos,
  // 若依赖整个对象会重写 DOM 导致光标跳回文档开头
  const selectedMemoKey = selectedMemo?.memoId ?? null;
  useEffect(() => {
    closeMention();
    editorRangeRef.current = null;
    if (!selectedMemoKey) return;
    const current = memosRef.current.find(
      (memo) => memo.memoId === selectedMemoKey,
    );
    if (!current) return;
    const content = current.content;
    lastSavedContentRef.current = content;
    editorHtmlRef.current = content;
    setEditorContent(content);
    if (editorRef.current && editorRef.current.innerHTML !== content) {
      editorRef.current.innerHTML = content;
    }
  }, [selectedMemoKey, closeMention]);

  // Stop the close-triggered flushSave from reading an unmounted editor.
  // flushSave reads the latest selected memo id and editor content from refs,
  // NOT from useCallback closure variables. This is critical: when the user
  // switches memos, handleSelectMemo awaits flushSave() and only then updates
  // selectedMemoId. If flushSave captured selectedMemoId via deps, the closure
  // would still hold the OLD id (correct for saving the old memo), but the
  // "sync editor" effect would have already reset lastSavedContentRef to the
  // new memo's content, causing the save to be skipped. By reading from refs
  // we always save the memo that is currently bound to the editor.
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const currentMemoId = selectedMemoIdRef.current;
    if (!currentMemoId) return;
    // Prefer the live innerHTML; on unmount editorRef.current is already null,
    // so editorHtmlRef (refreshed on every input) is the fallback.
    const content = editorRef.current?.innerHTML ?? editorHtmlRef.current;
    if (content === lastSavedContentRef.current) {
      setIsSaving(false);
      return;
    }
    setIsSaving(true);
    try {
      const updated = await window.snow.updateMemoContent(
        currentMemoId,
        content,
      );
      lastSavedContentRef.current = content;
      setMemos((prev) =>
        prev.map((memo) => (memo.memoId === currentMemoId ? updated : memo)),
      );
      notifyMemosChanged();
    } catch {
      // Keep content in editor so user can retry
    } finally {
      setIsSaving(false);
    }
  }, []);

  // 关闭页面（顶部关闭/新建会话）会先卸载本组件：先把编辑器里的最新内容
  // 快照进 editorHtmlRef 再落库，避免卸载后 flushSave 读到空内容覆盖数据库。
  const handleClose = useCallback(() => {
    editorHtmlRef.current =
      editorRef.current?.innerHTML ?? editorHtmlRef.current;
    closeMention();
    void flushSave();
    onClose();
  }, [closeMention, flushSave, onClose]);

  useEscapeClose(() => {
    if (deleteTarget) {
      setDeleteTarget(null);
      return;
    }
    if (buildTarget) {
      setBuildTarget(null);
      return;
    }
    if (isBatchDeleteConfirmOpen) {
      setIsBatchDeleteConfirmOpen(false);
      return;
    }
    if (isMultiSelectMode) {
      setIsMultiSelectMode(false);
      setSelectedMemoIds(new Set());
      return;
    }
    if (searchInput !== "") {
      setSearchInput("");
      return;
    }
    handleClose();
  });

  // 卸载兜底：页面以任何方式消失（关闭、切换项目、退出应用）都补一次落库
  // 并清掉待触发的自动保存定时器。
  useEffect(() => {
    return () => {
      void flushSave();
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [flushSave]);

  const scheduleSave = useCallback(() => {
    if (!selectedMemoId) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    setIsSaving(true);
    saveTimerRef.current = setTimeout(() => {
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }, [selectedMemoId, flushSave]);

  /** 光标前若为 `@xxx`（@ 前必须是行首或空白）则打开引用面板。 */
  const checkMentionTrigger = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      closeMention();
      return;
    }
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (
      !editor.contains(node) ||
      node.nodeType !== Node.TEXT_NODE ||
      !range.collapsed
    ) {
      closeMention();
      return;
    }
    const textBefore = (node.textContent ?? "").slice(0, range.startOffset);
    const match = textBefore.match(/(?:^|\s)@([^\s]*)$/);
    if (!match) {
      closeMention();
      return;
    }
    const queryText = match[1];
    // 记录 @ 触发时的光标：点击面板会清空编辑器选区，后续插入靠它定位
    editorRangeRef.current = range.cloneRange();
    setIsMentionOpen(true);
    setMentionQuery(queryText);
    mentionStartOffsetRef.current = range.startOffset - queryText.length;
  }, [closeMention]);

  const handleEditorInput = useCallback(() => {
    editorHtmlRef.current = editorRef.current?.innerHTML ?? "";
    scheduleSave();
    checkMentionTrigger();
  }, [checkMentionTrigger, scheduleSave]);

  /** 选中引用项后删除输入框中的 `@查询词` 并保留插入点。 */
  const deleteMentionQuery = useCallback(() => {
    if (mentionStartOffsetRef.current < 0) return;
    const anchor = editorRangeRef.current;
    if (!anchor) return;
    const editor = editorRef.current;
    if (!editor || !editor.contains(anchor.startContainer)) return;
    if (anchor.startContainer.nodeType !== Node.TEXT_NODE) return;
    const range = anchor.cloneRange();
    const node = range.startContainer;
    const start = mentionStartOffsetRef.current - 1;
    const end = range.startOffset;
    if (start < 0 || end <= start) return;
    range.setStart(node, start);
    range.setEnd(node, end);
    range.deleteContents();
    mentionStartOffsetRef.current = -1;
    editorRangeRef.current = range.cloneRange();
  }, []);

  const insertEditorTag = useCallback(
    (tag: MentionTag) => {
      const editor = editorRef.current;
      if (!editor) return;
      const anchor = editorRangeRef.current;
      editor.focus();
      if (anchor && editor.contains(anchor.startContainer)) {
        placeEditorCaret(anchor.cloneRange());
      }
      insertHtmlAtSelection(createMentionChipHtml(tag));
      captureEditorRange();
      handleEditorInput();
    },
    [captureEditorRange, handleEditorInput, placeEditorCaret],
  );

  const handleMentionSelect = useCallback(
    (tag: MentionTag) => {
      deleteMentionQuery();
      insertEditorTag(tag);
    },
    [deleteMentionQuery, insertEditorTag],
  );

  const handleMentionSelectBatch = useCallback(
    (tags: MentionTag[]) => {
      deleteMentionQuery();
      tags.forEach(insertEditorTag);
    },
    [deleteMentionQuery, insertEditorTag],
  );

  /** 路径导航：把 `@src/ren` 替换为 `@src/renderer/` 后继续浏览。 */
  const replaceMentionQuery = useCallback(
    (relativePath: string) => {
      if (mentionStartOffsetRef.current < 0) return;
      const anchor = editorRangeRef.current;
      const editor = editorRef.current;
      if (!anchor || !editor || !editor.contains(anchor.startContainer)) return;
      if (anchor.startContainer.nodeType !== Node.TEXT_NODE) return;
      const range = anchor.cloneRange();
      const node = range.startContainer;
      const start = mentionStartOffsetRef.current;
      const end = range.startOffset;
      if (end < start) return;
      range.setStart(node, start);
      range.setEnd(node, end);
      range.deleteContents();
      editorRangeRef.current = range.cloneRange();
      editor.focus();
      placeEditorCaret(range);
      if (relativePath) {
        document.execCommand("insertText", false, `${relativePath}/`);
        captureEditorRange();
      }
      checkMentionTrigger();
    },
    [captureEditorRange, checkMentionTrigger, placeEditorCaret],
  );

  // 引用面板以光标所在行为锚点：默认贴在输入行下方展开，下方空间放不下
  // 面板时翻到输入行上方；水平方向与编辑器对齐。
  useEffect(() => {
    if (!isMentionOpen) return;

    const updateMentionPopupStyle = (): void => {
      const editor = editorRef.current;
      if (!editor) return;
      const editorRect = editor.getBoundingClientRect();
      const selection = window.getSelection();
      const liveRange =
        selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const caretRange =
        liveRange && editor.contains(liveRange.startContainer)
          ? liveRange
          : editorRangeRef.current;
      const caretRects = caretRange?.getClientRects();
      const caretRect =
        caretRects && caretRects.length > 0
          ? caretRects[caretRects.length - 1]
          : editorRect;
      const gap = 4;
      const viewportMargin = 8;
      const spaceBelow =
        window.innerHeight - caretRect.bottom - gap - viewportMargin;
      const spaceAbove = caretRect.top - gap - viewportMargin;
      const placeAbove =
        spaceBelow < MENTION_POPUP_MAX_HEIGHT && spaceAbove > spaceBelow;
      setMentionPopupStyle({
        position: "fixed",
        left: editorRect.left,
        right: "auto",
        top: placeAbove ? "auto" : caretRect.bottom + gap,
        bottom: placeAbove ? window.innerHeight - caretRect.top + gap : "auto",
        width: editorRect.width,
        maxHeight: Math.min(
          MENTION_POPUP_MAX_HEIGHT,
          placeAbove ? spaceAbove : spaceBelow,
        ),
        marginTop: 0,
        marginBottom: 0,
        transformOrigin: placeAbove ? "center bottom" : "center top",
        zIndex: 10000,
      });
    };

    updateMentionPopupStyle();
    window.addEventListener("resize", updateMentionPopupStyle);
    const editor = editorRef.current;
    editor?.addEventListener("scroll", updateMentionPopupStyle, true);
    return () => {
      window.removeEventListener("resize", updateMentionPopupStyle);
      editor?.removeEventListener("scroll", updateMentionPopupStyle, true);
    };
  }, [isMentionOpen, mentionQuery]);

  /** 点击 chip 的关闭按钮时移除引用，并记录光标用于后续插入。 */
  const handleEditorClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element) {
      const removeButton = target.closest("[data-chip-remove='true']");
      if (removeButton) {
        removeButton.parentElement?.remove();
        handleEditorInput();
        return;
      }
    }
    captureEditorRange();
  };

  const handleEditorPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          if (typeof dataUrl !== "string") return;
          const selection = window.getSelection();
          if (!selection || !selection.rangeCount) return;
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const img = document.createElement("img");
          img.src = dataUrl;
          img.style.maxWidth = "100%";
          img.alt = "pasted";
          range.insertNode(img);
          range.collapse(false);
          editorHtmlRef.current = editorRef.current?.innerHTML ?? "";
          scheduleSave();
        };
        reader.readAsDataURL(file);
        return;
      }
    }
    // @ 引用面板打开时粘贴的是查询词：按纯文本插入（去掉首尾空白/换行），
    // 默认的富文本粘贴会生成新节点把光标移出 @ 所在文本节点，导致不触发搜索。
    if (!isMentionOpen) return;
    const text = event.clipboardData.getData("text/plain").trim();
    if (!text) return;
    event.preventDefault();
    document.execCommand("insertText", false, text);
  };

  const handleCreate = async () => {
    // Flush any pending save first so we don't lose edits
    await flushSave();
    setIsCreating(true);
    try {
      const created = await window.snow.createMemo(directoryId, "");
      // 新建的备忘一定是 pending 且不含检索词：退出筛选/检索视图，
      // 否则它会被当前条件过滤掉，刚创建就"消失"。
      if (filter !== "all") setFilter("all");
      if (searchInput) setSearchInput("");
      setMemos((prev) =>
        sortOrder === "asc" ? [...prev, created] : [created, ...prev],
      );
      setTotalCount((prev) => prev + 1);
      setSelectedMemoId(created.memoId);
      lastSavedContentRef.current = "";
      setEditorContent("");
      if (editorRef.current) editorRef.current.innerHTML = "";
      notifyMemosChanged();
      // Focus editor after render
      setTimeout(() => editorRef.current?.focus(), 50);
    } catch {
      // Ignore
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggleStatus = async (memo: MemoRecord) => {
    // Flush pending save for the currently edited memo before switching ops
    if (memo.memoId === selectedMemoId) {
      await flushSave();
    }
    const nextStatus: MemoStatus = memo.status === "done" ? "pending" : "done";
    try {
      const updated = await window.snow.updateMemoStatus(
        memo.memoId,
        nextStatus,
      );
      setMemos((prev) =>
        prev.map((m) => (m.memoId === memo.memoId ? updated : m)),
      );
      notifyMemosChanged();
    } catch {
      // Ignore
    }
  };

  const handleDelete = (memo: MemoRecord) => {
    setDeleteTarget(memo);
  };

  const confirmDelete = async () => {
    const memo = deleteTarget;
    setDeleteTarget(null);
    if (!memo) return;
    if (memo.memoId === selectedMemoId) {
      await flushSave();
    }
    try {
      await window.snow.deleteMemo(memo.memoId);
      const remaining = memos.filter((m) => m.memoId !== memo.memoId);
      setMemos(remaining);
      setTotalCount((prev) => Math.max(0, prev - 1));
      if (selectedMemoId === memo.memoId) {
        setSelectedMemoId(remaining[0]?.memoId ?? null);
      }
      notifyMemosChanged();
    } catch {
      // Ignore
    }
  };

  const handleEnterMultiSelect = () => {
    setIsMultiSelectMode(true);
    setSelectedMemoIds(new Set());
  };

  const handleExitMultiSelect = () => {
    setIsMultiSelectMode(false);
    setSelectedMemoIds(new Set());
  };

  const handleToggleSelect = (memoId: string) => {
    setSelectedMemoIds((prev) => {
      const next = new Set(prev);
      if (next.has(memoId)) {
        next.delete(memoId);
      } else {
        next.add(memoId);
      }
      return next;
    });
  };

  // 全选只覆盖当前已加载条目，滚动加载的新条目需再次点击纳入选择。
  const isAllSelected =
    memos.length > 0 && memos.every((memo) => selectedMemoIds.has(memo.memoId));

  const handleToggleSelectAll = () => {
    setSelectedMemoIds(
      isAllSelected ? new Set() : new Set(memos.map((memo) => memo.memoId)),
    );
  };

  const confirmBatchDelete = async () => {
    setIsBatchDeleteConfirmOpen(false);
    if (isBatchDeleting || selectedMemoIds.size === 0) return;
    const ids = [...selectedMemoIds];
    const removed = new Set(ids);
    setIsBatchDeleting(true);
    try {
      // 先落库并清掉待触发的自动保存，避免删除后旧内容写回新选中的备忘。
      await flushSave();
      await window.snow.deleteMemos(ids);
      const remaining = memosRef.current.filter(
        (memo) => !removed.has(memo.memoId),
      );
      setMemos(remaining);
      setTotalCount((prev) =>
        Math.max(0, prev - (memosRef.current.length - remaining.length)),
      );
      setSelectedMemoIds(new Set());
      setIsMultiSelectMode(false);
      if (selectedMemoIdRef.current && removed.has(selectedMemoIdRef.current)) {
        setSelectedMemoId(remaining[0]?.memoId ?? null);
      }
      notifyMemosChanged();
    } catch {
      // Ignore
    } finally {
      setIsBatchDeleting(false);
    }
  };

  const handleSelectMemo = async (memo: MemoRecord) => {
    if (memo.memoId === selectedMemoId) return;
    await flushSave();
    setSelectedMemoId(memo.memoId);
  };

  const handleBuild = (memo: MemoRecord) => {
    setBuildTarget(memo);
  };

  const confirmBuild = async () => {
    const memo = buildTarget;
    setBuildTarget(null);
    if (!memo) return;
    // Flush the editor so the latest content is persisted before we read it.
    if (memo.memoId === selectedMemoId) {
      await flushSave();
    }
    const html =
      memo.memoId === selectedMemoId
        ? (editorRef.current?.innerHTML ??
          editorHtmlRef.current ??
          memo.content)
        : memo.content;
    const chatContent = memoHtmlToChatContent(html);
    if (!chatContent.trim()) return;
    // Close the modal first so the chat input is visible underneath, then
    // trigger the build flow which creates a new chat and auto-sends.
    handleClose();
    buildFromContent(chatContent);
  };

  const handleListScroll = () => {
    const el = listScrollRef.current;
    if (!el || !hasMore || isLoadingMore || loadingMoreRef.current) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (!nearBottom) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    const statusParam = filter === "all" ? undefined : filter;
    const currentLength = memos.length;
    // 记录请求序号：期间若筛选/检索条件变化触发重新加载，丢弃这次追加以免混入旧结果。
    const currentRequestId = requestIdRef.current;
    window.snow
      .listMemos(
        directoryId,
        PAGE_SIZE,
        currentLength,
        statusParam,
        sortField,
        sortOrder,
        searchKeyword || undefined,
      )
      .then((page: MemoPage) => {
        if (currentRequestId !== requestIdRef.current) return;
        setMemos((prev) => [...prev, ...page.items]);
        setHasMore(page.hasMore);
      })
      .catch(() => {
        // Ignore
      })
      .finally(() => {
        setIsLoadingMore(false);
        loadingMoreRef.current = false;
      });
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // @ 引用面板打开时优先由面板处理上下选择/回车确认/ESC
    if (isMentionOpen && mentionPopupRef.current?.handleKeyDown(event)) {
      return;
    }
    // Ctrl/Cmd + Backspace on empty editor deletes the memo
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "Backspace" &&
      selectedMemo &&
      (editorRef.current?.textContent ?? "").trim() === ""
    ) {
      event.preventDefault();
      void handleDelete(selectedMemo);
    }
  };

  const handleEditorFocus = () => {
    editorFocusedRef.current = true;
    captureEditorRange();
  };

  const handleEditorBlur = () => {
    editorFocusedRef.current = false;
    void flushSave();
  };

  const renderMemoItem = (memo: MemoRecord) => {
    const isSelected = memo.memoId === selectedMemoId;
    const isChecked = selectedMemoIds.has(memo.memoId);
    const preview = buildLocalPreview(memo.content, searchKeyword);
    const parsedDate = parseDbTimestamp(memo.updatedAt || memo.createdAt);
    const timeLabel = formatTimeLabel(parsedDate, new Date(), t);
    const isDone = memo.status === "done";

    return (
      <div
        key={memo.memoId}
        className={`memo-list-item${isSelected ? " selected" : ""}${
          isDone ? " done" : ""
        }${isMultiSelectMode ? " multi-select" : ""}${
          isMultiSelectMode && isChecked ? " checked" : ""
        }`}
        onClick={
          isMultiSelectMode
            ? () => handleToggleSelect(memo.memoId)
            : () => void handleSelectMemo(memo)
        }
        role="button"
        tabIndex={0}
      >
        {isMultiSelectMode && (
          <span className={`memo-item-checkbox${isChecked ? " checked" : ""}`}>
            {isChecked ? <Check size={11} strokeWidth={3} /> : null}
          </span>
        )}
        <div className="memo-list-item-main">
          <div className="memo-list-item-preview">
            {preview ? (
              <HighlightedText query={searchKeyword} text={preview} />
            ) : (
              t("memo.untitled")
            )}
          </div>
          <div className="memo-list-item-meta">
            <span className="memo-list-item-time">{timeLabel}</span>
            {isDone && (
              <span className="memo-list-item-status">
                <Check size={11} strokeWidth={2.5} />
              </span>
            )}
          </div>
        </div>
        {!isMultiSelectMode && (
          <div className="memo-list-item-actions">
            <button
              aria-label={
                isDone ? t("memo.togglePending") : t("memo.toggleDone")
              }
              className={`memo-icon-btn${isDone ? " done-toggle" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                void handleToggleStatus(memo);
              }}
              title={isDone ? t("memo.togglePending") : t("memo.toggleDone")}
              type="button"
            >
              {isDone ? (
                <CheckCircle2 size={15} strokeWidth={2} />
              ) : (
                <Circle size={15} strokeWidth={1.8} />
              )}
            </button>
            <button
              aria-label={t("memo.delete")}
              className="memo-icon-btn danger"
              onClick={(e) => {
                e.stopPropagation();
                void handleDelete(memo);
              }}
              title={t("memo.delete")}
              type="button"
            >
              <Trash2 size={14} strokeWidth={2} />
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderBody = () => {
    if (isLoading && memos.length === 0) {
      return (
        <div className="memo-loading">
          <Loader2 className="spin" size={18} />
          <span>{t("memo.loadingHint")}</span>
        </div>
      );
    }

    if (memos.length === 0) {
      return (
        <div className="memo-empty">
          <span>
            {searchKeyword
              ? t("memo.searchEmpty", {
                  values: { query: searchKeyword },
                  defaultValue: `No memos match "${searchKeyword}".`,
                })
              : t("memo.emptyHint")}
          </span>
        </div>
      );
    }

    return (
      <div
        className="memo-list-scroll"
        onScroll={handleListScroll}
        ref={listScrollRef}
      >
        {memos.map(renderMemoItem)}
        {isLoadingMore && (
          <div className="memo-loading-more">
            <Loader2 className="spin" size={14} />
            <span>{t("memo.loadingMore")}</span>
          </div>
        )}
        {!hasMore && memos.length > 0 && (
          <div className="memo-all-loaded">{t("memo.allLoaded")}</div>
        )}
      </div>
    );
  };

  const renderEditor = () => {
    if (!selectedMemo) {
      return (
        <div className="memo-editor-empty">
          <StickyNote
            aria-hidden="true"
            className="feature-empty-icon"
            size={28}
            strokeWidth={1.5}
          />
          <span>{t("memo.emptyHint")}</span>
        </div>
      );
    }

    return (
      <div className="memo-editor-wrapper">
        <div className="memo-editor-toolbar">
          <div className="memo-editor-meta">
            <span
              className={`memo-editor-status-badge${
                selectedMemo.status === "done" ? " done" : " pending"
              }`}
            >
              {selectedMemo.status === "done"
                ? t("memo.statusDone")
                : t("memo.statusPending")}
            </span>
            <span className="memo-editor-time">
              {formatTimeLabel(
                parseDbTimestamp(selectedMemo.updatedAt),
                new Date(),
                t,
              )}
            </span>
          </div>
          <div className="memo-editor-actions">
            {isSaving && (
              <span className="memo-saving">
                <Loader2 className="spin" size={12} />
              </span>
            )}
            {selectedMemo.status === "pending" && (
              <button
                className="memo-build-btn"
                onClick={() => handleBuild(selectedMemo)}
                title={t("memo.build")}
                type="button"
              >
                <Sparkles size={14} strokeWidth={2.2} />
                {t("memo.build")}
              </button>
            )}
            <button
              className={`memo-icon-btn${
                selectedMemo.status === "done" ? " done-toggle" : ""
              }`}
              onClick={() => void handleToggleStatus(selectedMemo)}
              title={
                selectedMemo.status === "done"
                  ? t("memo.togglePending")
                  : t("memo.toggleDone")
              }
              type="button"
            >
              {selectedMemo.status === "done" ? (
                <CheckCircle2 size={16} strokeWidth={2} />
              ) : (
                <Circle size={16} strokeWidth={1.8} />
              )}
            </button>
            <button
              className="memo-icon-btn danger"
              onClick={() => void handleDelete(selectedMemo)}
              title={t("memo.delete")}
              type="button"
            >
              <Trash2 size={15} strokeWidth={2} />
            </button>
          </div>
        </div>
        <div className="memo-editor-area">
          <FileMentionPopup
            ref={mentionPopupRef}
            visible={isMentionOpen}
            query={mentionQuery}
            onClose={closeMention}
            onSelect={handleMentionSelect}
            onSelectBatch={handleMentionSelectBatch}
            textareaRef={editorRef}
            onNavigateTo={replaceMentionQuery}
            projectId={directoryId}
            style={mentionPopupStyle}
            portal
          />
          <div
            aria-label={t("memo.editorLabel")}
            className="memo-editor"
            contentEditable
            data-placeholder={t("memo.richTextPlaceholder")}
            onBlur={handleEditorBlur}
            onClick={handleEditorClick}
            onFocus={handleEditorFocus}
            onInput={handleEditorInput}
            onKeyDown={handleEditorKeyDown}
            onKeyUp={captureEditorRange}
            onMouseUp={captureEditorRange}
            onPaste={handleEditorPaste}
            ref={editorRef}
            role="textbox"
            suppressContentEditableWarning
          />
        </div>
      </div>
    );
  };

  return (
    <div className="feature-page">
      <div
        className="memo-panel-layout"
        ref={layoutRef}
        style={
          { "--memo-split-width": `${sidebarWidth}px` } as React.CSSProperties
        }
      >
        <div className="memo-sidebar">
          <div className="memo-sidebar-header">
            {isMultiSelectMode ? (
              <>
                <button
                  className="memo-multi-select-exit-btn"
                  disabled={isBatchDeleting}
                  onClick={handleExitMultiSelect}
                  title={t("memo.multiSelectExit", {
                    defaultValue: "Exit multi-select",
                  })}
                  type="button"
                >
                  <X size={14} strokeWidth={2} />
                </button>
                <span className="memo-multi-select-count">
                  {t("memo.multiSelectCount", {
                    defaultValue: "{{count}} selected",
                    values: { count: selectedMemoIds.size },
                  })}
                </span>
                <div className="memo-multi-select-actions">
                  <button
                    className="memo-multi-select-action-btn"
                    disabled={isBatchDeleting}
                    onClick={handleToggleSelectAll}
                    title={t("memo.multiSelectAll", {
                      defaultValue: "Select all",
                    })}
                    type="button"
                  >
                    <CheckSquare size={13} />
                    <span>
                      {isAllSelected
                        ? t("memo.multiSelectDeselectAll", {
                            defaultValue: "Deselect all",
                          })
                        : t("memo.multiSelectAll", {
                            defaultValue: "Select all",
                          })}
                    </span>
                  </button>
                  <button
                    className="memo-multi-select-action-btn danger"
                    disabled={isBatchDeleting || selectedMemoIds.size === 0}
                    onClick={() => setIsBatchDeleteConfirmOpen(true)}
                    title={t("memo.multiSelectDelete", {
                      defaultValue: "Delete selected",
                    })}
                    type="button"
                  >
                    {isBatchDeleting ? (
                      <Loader2 className="spin" size={13} />
                    ) : (
                      <Trash2 size={13} />
                    )}
                    <span>
                      {isBatchDeleting
                        ? t("memo.multiSelectDeleting", {
                            defaultValue: "Deleting...",
                          })
                        : t("memo.multiSelectDelete", {
                            defaultValue: "Delete selected",
                          })}
                    </span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="memo-filter-tabs">
                  {(["all", "pending", "done"] as const).map((key) => (
                    <button
                      className={`memo-filter-tab${
                        filter === key ? " active" : ""
                      }`}
                      key={key}
                      onClick={() => setFilter(key)}
                      type="button"
                    >
                      {key === "all"
                        ? t("memo.filterAll")
                        : key === "pending"
                          ? t("memo.filterPending")
                          : t("memo.filterDone")}
                    </button>
                  ))}
                </div>
                <button
                  className="memo-new-btn compact"
                  disabled={memos.length === 0}
                  onClick={handleEnterMultiSelect}
                  title={t("memo.multiSelectEnter", {
                    defaultValue: "Select multiple",
                  })}
                  type="button"
                >
                  <ListChecks size={15} strokeWidth={2.2} />
                </button>
                <button
                  className="memo-new-btn compact"
                  disabled={isCreating}
                  onClick={() => void handleCreate()}
                  title={t("memo.newMemo")}
                  type="button"
                >
                  <Plus size={15} strokeWidth={2.2} />
                </button>
              </>
            )}
          </div>
          <div className="memo-search-row">
            <Search
              aria-hidden="true"
              className="memo-search-icon"
              size={13}
              strokeWidth={2}
            />
            <input
              aria-label={t("memo.searchPlaceholder", {
                defaultValue: "Search memos",
              })}
              className="memo-search-input"
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && searchInput !== "") {
                  // 有关键词时 ESC 只清空检索并吞掉事件（关闭弹窗留给下一次 ESC）
                  event.preventDefault();
                  event.stopPropagation();
                  setSearchInput("");
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  setSearchKeyword(searchInput.trim());
                }
              }}
              placeholder={t("memo.searchPlaceholder", {
                defaultValue: "Search memos",
              })}
              ref={searchInputRef}
              title={t("memo.searchShortcut", {
                defaultValue: "Press / or Ctrl+K to focus search",
              })}
              type="text"
              value={searchInput}
            />
            {searchInput !== "" && (
              <button
                aria-label={t("memo.searchClear", {
                  defaultValue: "Clear search",
                })}
                className="memo-search-clear"
                onClick={() => setSearchInput("")}
                title={t("memo.searchClear", {
                  defaultValue: "Clear search",
                })}
                type="button"
              >
                <X size={12} strokeWidth={2.2} />
              </button>
            )}
          </div>
          <div className="memo-sidebar-subrow">
            <CustomSelect
              onChange={(value) => setSortField(value as MemoSortField)}
              options={[
                {
                  label: t("memo.sortFieldUpdated", {
                    defaultValue: "Updated time",
                  }),
                  value: "updated",
                },
                {
                  label: t("memo.sortFieldCreated", {
                    defaultValue: "Created time",
                  }),
                  value: "created",
                },
              ]}
              portal
              title={t("memo.sortField", { defaultValue: "Sort by" })}
              value={sortField}
            />
            <button
              aria-label={t("memo.sortToggle")}
              className="memo-sort-btn"
              onClick={() =>
                setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"))
              }
              title={
                sortOrder === "desc" ? t("memo.sortDesc") : t("memo.sortAsc")
              }
              type="button"
            >
              {sortOrder === "desc" ? (
                <ArrowDownWideNarrow size={15} strokeWidth={2} />
              ) : (
                <ArrowUpNarrowWide size={15} strokeWidth={2} />
              )}
            </button>
            {totalCount > 0 && (
              <span className="memo-sidebar-count">
                {searchKeyword
                  ? t("memo.searchHits", {
                      values: { count: totalCount },
                      defaultValue: `${totalCount} matches`,
                    })
                  : t("memo.totalCount", {
                      values: { count: totalCount },
                      defaultValue: `${totalCount}`,
                    })}
              </span>
            )}
          </div>
          {renderBody()}
        </div>
        <div
          className="panel-resizer layout-resizer split-resizer"
          role="separator"
          aria-label={t("memo.resizeSidebar", {
            defaultValue: "Resize list panel",
          })}
          aria-orientation="vertical"
          onPointerDown={handleResizeStart}
        />
        <div className="memo-content">{renderEditor()}</div>
      </div>
      <ConfirmDialog
        cancelLabel={t("memo.cancelDelete", { defaultValue: "Cancel" })}
        confirmLabel={t("memo.delete", { defaultValue: "Delete" })}
        message={t("memo.confirmDelete", { defaultValue: "Delete this memo?" })}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        open={deleteTarget !== null}
        title={t("memo.delete", { defaultValue: "Delete" })}
        variant="danger"
      />
      <ConfirmDialog
        cancelLabel={t("memo.cancelDelete", { defaultValue: "Cancel" })}
        confirmLabel={t("memo.build", { defaultValue: "Build" })}
        message={t("memo.buildConfirm", {
          defaultValue: "Start a new chat with this memo?",
        })}
        onCancel={() => setBuildTarget(null)}
        onConfirm={() => void confirmBuild()}
        open={buildTarget !== null}
        title={t("memo.buildTitle", { defaultValue: "Build from memo" })}
        variant="default"
      />
      <ConfirmDialog
        cancelLabel={t("memo.cancelDelete", { defaultValue: "Cancel" })}
        confirmLabel={t("memo.multiSelectDelete", {
          defaultValue: "Delete selected",
        })}
        message={t("memo.multiSelectDeleteConfirm", {
          defaultValue:
            "Permanently delete the {{count}} selected memos? This cannot be undone.",
          values: { count: selectedMemoIds.size },
        })}
        onCancel={() => setIsBatchDeleteConfirmOpen(false)}
        onConfirm={() => void confirmBatchDelete()}
        open={isBatchDeleteConfirmOpen}
        title={t("memo.delete", { defaultValue: "Delete" })}
        variant="danger"
      />
    </div>
  );
}
