import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  CheckCircle2,
  Circle,
  Loader2,
  Plus,
  Trash2,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { formatTimeLabel, parseDbTimestamp } from "./mainSidebar/chatTimeGroup";
import type { MemoPage, MemoRecord, MemoStatus } from "../../../preload";

const PAGE_SIZE = 20;
const SAVE_DEBOUNCE_MS = 600;
const PREVIEW_MAX_LEN = 120;

type MemoFilter = "all" | MemoStatus;

type MemoSortOrder = "asc" | "desc";

type MemoModalProps = {
  open: boolean;
  directoryId: string;
  onClose: () => void;
  onPendingCountChange?: (count: number) => void;
};

const isMemoStatus = (value: string): value is MemoStatus =>
  value === "pending" || value === "done";

const buildLocalPreview = (content: string): string => {
  const plain = content
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= PREVIEW_MAX_LEN) return plain;
  return plain.slice(0, PREVIEW_MAX_LEN) + "...";
};

/**
 * Converts the rich-text editor HTML into the chat input's tagged format:
 *  - <img src="data:..."> becomes @@image:data:...@@
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
      result.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

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

export function MemoModal({
  open,
  directoryId,
  onClose,
  onPendingCountChange,
}: MemoModalProps): React.JSX.Element {
  const { t } = useI18n();
  const { buildFromContent } = useChatConversationContext();
  const [memos, setMemos] = useState<MemoRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filter, setFilter] = useState<MemoFilter>("all");
  const [sortOrder, setSortOrder] = useState<MemoSortOrder>("desc");
  const [selectedMemoId, setSelectedMemoId] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MemoRecord | null>(null);
  const [buildTarget, setBuildTarget] = useState<MemoRecord | null>(null);

  const listScrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingMoreRef = useRef(false);
  const requestIdRef = useRef(0);
  const editorFocusedRef = useRef(false);
  const lastSavedContentRef = useRef("");

  // Refs that always hold the latest values, so async save handlers can read
  // them without being trapped by stale useCallback closures. This is the key
  // fix for content not being persisted: previously flushSave captured
  // selectedMemoId via useCallback deps, but when called from
  // handleSelectMemo/handleCreate it would reference an outdated memo id or a
  // stale lastSavedContentRef that the "sync editor" effect had already reset.
  const selectedMemoIdRef = useRef<string | null>(null);
  const memosRef = useRef<MemoRecord[]>([]);
  // Cache of the editor's current innerHTML. The contentEditable editor is
  // unmounted when the modal closes (Modal returns null), so by the time the
  // close-triggered flushSave runs, editorRef.current is null. Reading from
  // this cache instead guarantees we persist the last-typed content instead
  // of an empty string that would wipe the database row.
  const editorHtmlRef = useRef("");

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
    async (currentFilter: MemoFilter, currentSortOrder: MemoSortOrder) => {
      const currentRequestId = ++requestIdRef.current;
      setIsLoading(true);
      try {
        const statusParam = currentFilter === "all" ? undefined : currentFilter;
        const page = await window.snow.listMemos(
          directoryId,
          PAGE_SIZE,
          0,
          statusParam,
          currentSortOrder,
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

  const refreshPendingCount = useCallback(async () => {
    try {
      const summary = await window.snow.getMemoCountSummary(directoryId);
      onPendingCountChange?.(summary.pending);
    } catch {
      // Silent: badge is non-critical
    }
  }, [directoryId, onPendingCountChange]);

  useEffect(() => {
    if (!open) return;
    void loadFirstPage(filter, sortOrder);
    void refreshPendingCount();
  }, [open, filter, sortOrder, loadFirstPage, refreshPendingCount]);

  // When the active project (directoryId) changes while the modal is open,
  // reset the selection and editor so stale content from another project is
  // never shown. The list/editor will be repopulated by the loadFirstPage
  // effect above.
  useEffect(() => {
    if (!open) return;
    setSelectedMemoId(null);
    setEditorContent("");
    lastSavedContentRef.current = "";
    if (editorRef.current) editorRef.current.textContent = "";
  }, [directoryId, open]);

  // Auto-select the first memo when opening (or after creating the first one)
  useEffect(() => {
    if (!open) return;
    if (selectedMemoId) return;
    if (memos.length > 0) {
      setSelectedMemoId(memos[0].memoId);
    } else {
      setSelectedMemoId(null);
      setEditorContent("");
      lastSavedContentRef.current = "";
      if (editorRef.current) editorRef.current.textContent = "";
    }
  }, [open, memos, selectedMemoId]);

  // 仅依赖 memoId 同步编辑器:自动保存会把同 id 的新对象刷进 memos,
  // 若依赖整个对象会重写 DOM 导致光标跳回文档开头
  const selectedMemoKey = selectedMemo?.memoId ?? null;
  useEffect(() => {
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
  }, [selectedMemoKey]);

  // Stop the close-triggered flushSave effect from running after the editor
  // has already been unmounted. The actual flush happens synchronously inside
  // handleClose before `open` flips to false, so the editorRef is still alive
  // at that moment. The effect is kept only as a safety net for unmount without
  // an explicit close (e.g. directoryId change), where editorHtmlRef already
  // holds the latest content.
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
    // Prefer the cached innerHTML: the contentEditable editor is unmounted
    // when the modal closes, so editorRef.current may be null at that point.
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
      void refreshPendingCount();
    } catch {
      // Keep content in editor so user can retry
    } finally {
      setIsSaving(false);
    }
  }, [refreshPendingCount]);

  // handleClose runs BEFORE the modal unmounts the contentEditable editor.
  // It snapshots the live editor HTML into editorHtmlRef, then flushes the
  // pending save synchronously while editorRef.current is still attached to
  // the DOM. This prevents the close-effect flushSave from reading a null
  // editor (Modal returns null when open=false) and wiping the DB content
  // with an empty string.
  const handleClose = useCallback(() => {
    editorHtmlRef.current =
      editorRef.current?.innerHTML ?? editorHtmlRef.current;
    void flushSave();
    onClose();
  }, [flushSave, onClose]);

  // Flush pending save when modal closes. This runs AFTER open has flipped
  // to false, so the editor may already be unmounted — editorHtmlRef holds
  // the snapshot captured by handleClose (or the last input) as a fallback.
  useEffect(() => {
    if (!open) {
      void flushSave();
    }
  }, [open, flushSave]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

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

  const handleEditorInput = () => {
    editorHtmlRef.current = editorRef.current?.innerHTML ?? "";
    scheduleSave();
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
  };

  const handleCreate = async () => {
    // Flush any pending save first so we don't lose edits
    await flushSave();
    setIsCreating(true);
    try {
      const created = await window.snow.createMemo(directoryId, "");
      setMemos((prev) =>
        sortOrder === "asc" ? [...prev, created] : [created, ...prev],
      );
      setTotalCount((prev) => prev + 1);
      setSelectedMemoId(created.memoId);
      lastSavedContentRef.current = "";
      setEditorContent("");
      if (editorRef.current) editorRef.current.innerHTML = "";
      void refreshPendingCount();
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
      void refreshPendingCount();
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
      void refreshPendingCount();
    } catch {
      // Ignore
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
    window.snow
      .listMemos(directoryId, PAGE_SIZE, currentLength, statusParam, sortOrder)
      .then((page: MemoPage) => {
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
  };

  const handleEditorBlur = () => {
    editorFocusedRef.current = false;
    void flushSave();
  };

  const renderMemoItem = (memo: MemoRecord) => {
    const isSelected = memo.memoId === selectedMemoId;
    const preview = buildLocalPreview(memo.content);
    const parsedDate = parseDbTimestamp(memo.updatedAt || memo.createdAt);
    const timeLabel = formatTimeLabel(parsedDate, new Date(), t);
    const isDone = memo.status === "done";

    return (
      <div
        key={memo.memoId}
        className={`memo-list-item${isSelected ? " selected" : ""}${
          isDone ? " done" : ""
        }`}
        onClick={() => void handleSelectMemo(memo)}
        role="button"
        tabIndex={0}
      >
        <div className="memo-list-item-main">
          <div className="memo-list-item-preview">
            {preview || t("memo.untitled")}
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
        <div className="memo-list-item-actions">
          <button
            aria-label={isDone ? t("memo.togglePending") : t("memo.toggleDone")}
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
          <span>{t("memo.emptyHint")}</span>
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
        <div
          aria-label={t("memo.editorLabel")}
          className="memo-editor"
          contentEditable
          data-placeholder={t("memo.richTextPlaceholder")}
          onBlur={handleEditorBlur}
          onFocus={handleEditorFocus}
          onInput={handleEditorInput}
          onKeyDown={handleEditorKeyDown}
          onPaste={handleEditorPaste}
          ref={editorRef}
          role="textbox"
          suppressContentEditableWarning
        />
      </div>
    );
  };

  return (
    <Modal
      className="memo-modal"
      closeLabel={t("memo.close")}
      onClose={handleClose}
      open={open}
      size="large"
      title={t("memo.title")}
    >
      <div className="memo-modal-layout">
        <div className="memo-sidebar">
          <div className="memo-sidebar-header">
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
            <button
              className="memo-new-btn compact"
              disabled={isCreating}
              onClick={() => void handleCreate()}
              title={t("memo.newMemo")}
              type="button"
            >
              <Plus size={15} strokeWidth={2.2} />
            </button>
          </div>
          {totalCount > 0 && (
            <div className="memo-sidebar-count">
              {t("memo.pendingCount", {
                values: { count: totalCount },
                defaultValue: `${totalCount}`,
              })}
            </div>
          )}
          {renderBody()}
        </div>
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
    </Modal>
  );
}
