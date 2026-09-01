import { Archive, Check, Loader2, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { CustomSelect } from "../common/CustomSelect";
import { Modal } from "../common/Modal";
import type {
  MemoryKind,
  MemoryPage,
  MemoryRecord,
  MemoryStats,
  MemoryStatus,
} from "../../../preload";

const PAGE_SIZE = 30;

const KIND_KEYS: MemoryKind[] = [
  "fact",
  "decision",
  "preference",
  "pitfall",
  "task_state",
];

const STATUS_KEYS: MemoryStatus[] = ["active", "pending", "archived"];

const IMPORTANCE_LEVELS = [1, 2, 3, 4, 5];

type MemoryFilterStatus = "all" | MemoryStatus;
type MemoryFilterKind = "all" | MemoryKind;

/** 编辑表单的字段值（新建与编辑共用）。 */
type MemoryDraft = {
  title: string;
  content: string;
  kind: MemoryKind;
  importance: number;
  status: MemoryStatus;
  tags: string;
};

type MemoryModalProps = {
  open: boolean;
  directoryId: string;
  onClose: () => void;
};

const draftFromRecord = (record: MemoryRecord): MemoryDraft => ({
  title: record.title,
  content: record.content,
  kind: (record.kind as MemoryKind) ?? "fact",
  importance: record.importance,
  status: (record.status as MemoryStatus) ?? "active",
  tags: record.tags.join(", "),
});

const emptyDraft = (): MemoryDraft => ({
  title: "",
  content: "",
  kind: "fact",
  importance: 2,
  status: "active",
  tags: "",
});

/** 当前正在编辑/查看的条目（来自列表）。 */
type Selection =
  | { mode: "none" }
  | { mode: "create" }
  | { mode: "edit"; record: MemoryRecord };

/**
 * 项目记忆管理弹窗：双栏布局（左侧筛选 + 列表，右侧详情编辑），
 * 参照 MemoModal 的成熟交互。浏览/新建/编辑/删除当前项目的持久记忆。
 */
export function MemoryModal({
  open,
  directoryId,
  onClose,
}: MemoryModalProps): React.JSX.Element {
  const { t } = useI18n();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filterStatus, setFilterStatus] = useState<MemoryFilterStatus>("all");
  const [filterKind, setFilterKind] = useState<MemoryFilterKind>("all");
  const [selection, setSelection] = useState<Selection>({ mode: "none" });
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft());
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MemoryRecord | null>(null);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);

  const requestIdRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const listScrollRef = useRef<HTMLDivElement>(null);

  const refreshStats = useCallback(() => {
    if (!directoryId) return;
    window.snow
      .getProjectMemoryStats(directoryId)
      .then(setStats)
      .catch(() => undefined);
  }, [directoryId]);

  const loadPage = useCallback(
    (offset: number, append: boolean) => {
      if (!directoryId) return;
      const requestId = ++requestIdRef.current;
      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }
      window.snow
        .listProjectMemories(
          directoryId,
          PAGE_SIZE,
          offset,
          filterStatus === "all" ? undefined : filterStatus,
          filterKind === "all" ? undefined : filterKind,
        )
        .then((page: MemoryPage) => {
          if (requestId !== requestIdRef.current) return;
          setMemories((prev) => {
            if (!append) return page.items;
            // 极端时序下同一页可能被请求两次，按 memoryId 去重防止重复条目
            const known = new Set(prev.map((item) => item.memoryId));
            return [
              ...prev,
              ...page.items.filter((item) => !known.has(item.memoryId)),
            ];
          });
          setHasMore(page.hasMore);
        })
        .catch(() => {
          if (requestId === requestIdRef.current && !append) {
            setMemories([]);
            setHasMore(false);
          }
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setIsLoading(false);
            setIsLoadingMore(false);
          }
          // 被竞态丢弃的旧请求也要释放加载锁，否则滚动加载会永久卡死
          loadingMoreRef.current = false;
        });
    },
    [directoryId, filterStatus, filterKind],
  );

  // 打开或筛选变化时重新加载第一页
  useEffect(() => {
    if (!open) return;
    setSelection({ mode: "none" });
    loadPage(0, false);
    refreshStats();
  }, [open, loadPage, refreshStats]);

  const handleListScroll = () => {
    const el = listScrollRef.current;
    if (!el || !hasMore || isLoadingMore || loadingMoreRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 60) return;
    loadingMoreRef.current = true;
    loadPage(memories.length, true);
  };

  const handleStartCreate = () => {
    setSelection({ mode: "create" });
    setDraft(emptyDraft());
  };

  const handleSelect = (record: MemoryRecord) => {
    if (
      selection.mode === "edit" &&
      selection.record.memoryId === record.memoryId
    ) {
      setSelection({ mode: "none" });
      return;
    }
    setSelection({ mode: "edit", record });
    setDraft(draftFromRecord(record));
  };

  const handleCancelEdit = () => setSelection({ mode: "none" });

  const handleSave = async () => {
    const title = draft.title.trim();
    const content = draft.content.trim();
    if (!title || !content || isSaving) return;
    const tags = draft.tags
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);

    setIsSaving(true);
    try {
      if (selection.mode === "create") {
        await window.snow.createProjectMemory(
          directoryId,
          draft.kind,
          title,
          content,
          draft.importance,
          tags,
        );
      } else if (selection.mode === "edit") {
        await window.snow.updateProjectMemory(selection.record.memoryId, {
          kind: draft.kind,
          title,
          content,
          importance: draft.importance,
          status: draft.status,
          tags,
        });
      }
      setSelection({ mode: "none" });
      loadPage(0, false);
      refreshStats();
    } catch {
      // 保持编辑状态，用户可重试
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = async () => {
    const record = deleteTarget;
    setDeleteTarget(null);
    if (!record) return;
    try {
      await window.snow.deleteProjectMemory(record.memoryId);
      if (
        selection.mode === "edit" &&
        selection.record.memoryId === record.memoryId
      ) {
        setSelection({ mode: "none" });
      }
      loadPage(0, false);
      refreshStats();
    } catch {
      // Ignore
    }
  };

  const confirmClear = async () => {
    setIsClearConfirmOpen(false);
    if (!directoryId) return;
    try {
      await window.snow.clearProjectMemories(directoryId);
      setSelection({ mode: "none" });
      loadPage(0, false);
      refreshStats();
    } catch {
      // Ignore
    }
  };

  const kindLabel = (kind: string) =>
    t(`memory.kind.${kind}`, {
      defaultValue:
        kind === "fact"
          ? "Fact"
          : kind === "decision"
            ? "Decision"
            : kind === "preference"
              ? "Preference"
              : kind === "pitfall"
                ? "Pitfall"
                : "Task State",
    });

  const statusLabel = (status: string) =>
    status === "pending"
      ? t("memory.statusPending", { defaultValue: "Pending" })
      : status === "archived"
        ? t("memory.statusArchived", { defaultValue: "Archived" })
        : t("memory.statusActive", { defaultValue: "Active" });

  // ---------------------------------------------------------------------
  // 左栏：筛选 + 统计 + 列表
  // ---------------------------------------------------------------------
  const renderSidebar = () => (
    <div className="memo-sidebar memory-sidebar">
      <div className="memo-sidebar-header">
        <div className="memo-filter-tabs">
          {(["all", ...STATUS_KEYS] as MemoryFilterStatus[]).map((key) => (
            <button
              className={`memo-filter-tab${
                filterStatus === key ? " active" : ""
              }`}
              key={key}
              onClick={() => setFilterStatus(key)}
              type="button"
            >
              {key === "all"
                ? t("memory.filterAllStatuses", { defaultValue: "All" })
                : statusLabel(key)}
            </button>
          ))}
        </div>
        <button
          aria-label={t("memory.new", { defaultValue: "New" })}
          className="memo-new-btn compact"
          disabled={selection.mode === "create"}
          onClick={handleStartCreate}
          title={t("memory.new", { defaultValue: "New" })}
          type="button"
        >
          <Plus size={15} strokeWidth={2.2} />
        </button>
      </div>
      <div className="memory-sidebar-subrow">
        <CustomSelect
          onChange={(value) => setFilterKind(value as MemoryFilterKind)}
          options={[
            {
              label: t("memory.filterAllKinds", { defaultValue: "All kinds" }),
              value: "all",
            },
            ...KIND_KEYS.map((kind) => ({
              label: kindLabel(kind),
              value: kind,
            })),
          ]}
          portal
          title={t("memory.filterKind", { defaultValue: "Kind" })}
          value={filterKind}
        />
        <span className="memory-sidebar-stats">
          {stats
            ? t("memory.statsCompact", {
                defaultValue: "{{total}} entries",
                values: { total: stats.total },
              })
            : ""}
        </span>
        <button
          className="memory-clear-btn"
          disabled={(stats?.total ?? 0) === 0}
          onClick={() => setIsClearConfirmOpen(true)}
          title={t("memory.clearAll", { defaultValue: "Clear all" })}
          type="button"
        >
          <Trash2 size={13} strokeWidth={1.9} />
        </button>
      </div>
      <div
        className="memo-list-scroll"
        onScroll={handleListScroll}
        ref={listScrollRef}
      >
        {isLoading ? (
          <div className="memory-list-empty">
            <Loader2 className="spin" size={16} />
          </div>
        ) : memories.length === 0 ? (
          <div className="memory-list-empty">
            {stats?.total === 0
              ? t("memory.emptyHint", {
                  defaultValue:
                    "No memories yet. The AI saves what it learns via memory-save, or add one manually.",
                })
              : t("memory.emptyFilterHint", {
                  defaultValue: "No memories match the current filter.",
                })}
          </div>
        ) : (
          memories.map((record) => {
            const isSelected =
              selection.mode === "edit" &&
              selection.record.memoryId === record.memoryId;
            const date = (record.updatedAt || record.createdAt).slice(0, 10);
            return (
              <div
                className={`memo-list-item memory-list-item${isSelected ? " selected" : ""}${
                  record.status === "archived" ? " archived" : ""
                }`}
                key={record.memoryId}
                onClick={() => handleSelect(record)}
                role="button"
                tabIndex={0}
              >
                <div className="memory-list-item-main">
                  <div className="memory-list-item-title-row">
                    <span className={`memory-kind-badge ${record.kind}`}>
                      {kindLabel(record.kind)}
                    </span>
                    <span className="memory-list-item-title">
                      {record.title}
                    </span>
                  </div>
                  <div className="memory-list-item-meta">
                    <span className="memory-list-item-importance">
                      {"★".repeat(record.importance)}
                      <span className="memory-importance-dim">
                        {"★".repeat(5 - record.importance)}
                      </span>
                    </span>
                    <span>{date}</span>
                    {record.status !== "active" && (
                      <span className={`memory-status-badge ${record.status}`}>
                        {record.status === "archived" ? (
                          <Archive size={10} strokeWidth={2} />
                        ) : null}
                        {statusLabel(record.status)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        {isLoadingMore && (
          <div className="memory-list-empty">
            <Loader2 className="spin" size={14} />
          </div>
        )}
        {!hasMore && !isLoading && memories.length > 0 && (
          <div className="memo-all-loaded">
            {t("memory.allLoaded", { defaultValue: "All memories loaded" })}
          </div>
        )}
      </div>
    </div>
  );

  // ---------------------------------------------------------------------
  // 右栏：详情编辑表单
  // ---------------------------------------------------------------------
  const renderContent = () => {
    if (selection.mode === "none") {
      return (
        <div className="memory-content-empty">
          <span>
            {t("memory.selectHint", {
              defaultValue:
                "Select a memory to view and edit it, or create a new one.",
            })}
          </span>
        </div>
      );
    }

    const isCreate = selection.mode === "create";
    const editingRecord = selection.mode === "edit" ? selection.record : null;
    const date = editingRecord
      ? (editingRecord.updatedAt || editingRecord.createdAt).slice(0, 10)
      : "";

    return (
      <div className="memory-editor">
        <div className="memory-editor-header">
          <div className="memory-editor-meta">
            {isCreate ? (
              <span className="memory-kind-badge fact">
                {t("memory.new", { defaultValue: "New" })}
              </span>
            ) : (
              <>
                <span className={`memory-kind-badge ${draft.kind}`}>
                  {kindLabel(draft.kind)}
                </span>
                <span className="memory-editor-source">
                  {editingRecord?.source} · {date}
                </span>
                {editingRecord && editingRecord.conversationId && (
                  <span
                    className="memory-editor-conversation"
                    title={editingRecord.conversationId}
                  >
                    {t("memory.fromConversation", {
                      defaultValue: "from conversation",
                    })}
                  </span>
                )}
              </>
            )}
          </div>
          <div className="memory-editor-header-actions">
            {editingRecord && (
              <button
                aria-label={t("memory.delete", { defaultValue: "Delete" })}
                className="memo-icon-btn danger"
                disabled={isSaving}
                onClick={() => setDeleteTarget(editingRecord)}
                title={t("memory.delete", { defaultValue: "Delete" })}
                type="button"
              >
                <Trash2 size={15} strokeWidth={1.9} />
              </button>
            )}
            <button
              aria-label={t("common.cancel", { defaultValue: "Cancel" })}
              className="memo-icon-btn"
              disabled={isSaving}
              onClick={handleCancelEdit}
              title={t("common.cancel", { defaultValue: "Cancel" })}
              type="button"
            >
              <X size={15} strokeWidth={1.9} />
            </button>
          </div>
        </div>

        <input
          className="memory-editor-title"
          onChange={(event) =>
            setDraft((prev) => ({ ...prev, title: event.target.value }))
          }
          placeholder={t("memory.titlePlaceholder", {
            defaultValue: "Title (dedup key)",
          })}
          type="text"
          value={draft.title}
        />

        <div className="memory-editor-row">
          <CustomSelect
            onChange={(value) =>
              setDraft((prev) => ({
                ...prev,
                kind: value as MemoryKind,
              }))
            }
            options={KIND_KEYS.map((kind) => ({
              label: kindLabel(kind),
              value: kind,
            }))}
            portal
            title={t("memory.kindLabel", { defaultValue: "Kind" })}
            value={draft.kind}
          />
          <CustomSelect
            onChange={(value) =>
              setDraft((prev) => ({
                ...prev,
                importance: Number.parseInt(value, 10) || 2,
              }))
            }
            options={IMPORTANCE_LEVELS.map((level) => ({
              label: t("memory.importanceOption", {
                defaultValue: "Level {{level}} · {{name}}",
                values: {
                  level,
                  name: t(`memory.importance.name.${level}`, {
                    defaultValue: "",
                  }),
                },
              }),
              value: String(level),
            }))}
            portal
            renderOption={(option) => (
              <span className="memory-importance-option">
                <span className="memory-importance-option-name">
                  {option.label}
                </span>
                <span className="memory-importance-option-desc">
                  {t(`memory.importance.desc.${Number(option.value)}`, {
                    defaultValue: "",
                  })}
                </span>
              </span>
            )}
            title={t("memory.importanceLabel", {
              defaultValue: "Importance level",
            })}
            value={String(draft.importance)}
          />
          <CustomSelect
            onChange={(value) =>
              setDraft((prev) => ({
                ...prev,
                status: value as MemoryStatus,
              }))
            }
            options={STATUS_KEYS.map((status) => ({
              label: statusLabel(status),
              value: status,
            }))}
            portal
            title={t("memory.statusLabel", { defaultValue: "Status" })}
            value={draft.status}
          />
        </div>

        <textarea
          className="memory-editor-content"
          onChange={(event) =>
            setDraft((prev) => ({ ...prev, content: event.target.value }))
          }
          placeholder={t("memory.contentPlaceholder", {
            defaultValue: "Details (paths, commands, reasons...)",
          })}
          value={draft.content}
        />

        <input
          className="memory-editor-tags"
          onChange={(event) =>
            setDraft((prev) => ({ ...prev, tags: event.target.value }))
          }
          placeholder={t("memory.tagsPlaceholder", {
            defaultValue: "Tags (comma separated)",
          })}
          type="text"
          value={draft.tags}
        />

        <div className="memory-editor-actions">
          <button
            className="memory-editor-btn primary"
            disabled={isSaving || !draft.title.trim() || !draft.content.trim()}
            onClick={() => void handleSave()}
            type="button"
          >
            {isSaving ? (
              <Loader2 className="spin" size={14} />
            ) : (
              <Check size={14} strokeWidth={2.2} />
            )}
            <span>{t("memory.save", { defaultValue: "Save" })}</span>
          </button>
        </div>
      </div>
    );
  };

  return (
    <Modal
      className="memo-modal"
      closeLabel={t("common.close", { defaultValue: "Close" })}
      onClose={onClose}
      open={open}
      size="large"
      title={t("memory.modalTitle", { defaultValue: "Project Memory" })}
    >
      <div className="memo-modal-layout">
        {renderSidebar()}
        <div className="memory-content">{renderContent()}</div>
      </div>
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("memory.delete", { defaultValue: "Delete" })}
        message={t("memory.deleteConfirm", {
          defaultValue: 'Delete the memory "{{title}}"?',
          values: { title: deleteTarget?.title ?? "" },
        })}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        open={deleteTarget !== null}
        title={t("memory.deleteTitle", { defaultValue: "Delete memory" })}
        variant="danger"
      />
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("memory.clearAll", { defaultValue: "Clear all" })}
        message={t("memory.clearConfirm", {
          defaultValue:
            "Permanently delete ALL {{count}} memories of this project? This cannot be undone.",
          values: { count: stats?.total ?? 0 },
        })}
        onCancel={() => setIsClearConfirmOpen(false)}
        onConfirm={() => void confirmClear()}
        open={isClearConfirmOpen}
        title={t("memory.clearTitle", { defaultValue: "Clear memory bank" })}
        variant="danger"
      />
    </Modal>
  );
}
