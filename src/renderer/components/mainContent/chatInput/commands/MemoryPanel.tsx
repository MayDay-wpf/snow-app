import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Loader2,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MemoryRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { ConfirmDialog } from "../../../common/ConfirmDialog";
import { Modal } from "../../../common/Modal";
import { useChatConversationContext } from "../../chatMessages/components/ChatConversationContext";
import { requestProjectMemoryPanel } from "../../../sidebar/projectMemoryNavigation";

/** 面板一次取回的记忆条数上限：会话级清单通常很小，够用即可。 */
const PANEL_MEMORY_LIMIT = 200;

/** 会话树向下追溯的最大层数（子代理可能再生成自己的子代理）。 */
const MAX_TREE_DEPTH = 4;

/** 记忆来源：主代理，或某个子代理 / WorkFlow 节点会话。 */
type ConversationMemorySource = {
  conversationId: string;
  agent: "main" | "sub";
  /** 子代理 / 节点显示名；主代理为空串。 */
  name: string;
};

type ConversationMemoryEntry = MemoryRecord & {
  agent: "main" | "sub";
  agentName: string;
};

/**
 * 由根会话出发逐层收集「主会话 + 子代理会话 + WorkFlow 节点会话」，
 * 每层都经主进程查询数据库，因此历史会话重新打开后也能正确重建来源。
 */
const collectConversationSources = async (
  rootConversationId: string,
): Promise<ConversationMemorySource[]> => {
  const sources: ConversationMemorySource[] = [
    { conversationId: rootConversationId, agent: "main", name: "" },
  ];
  const visited = new Set([rootConversationId]);
  let frontier = [rootConversationId];

  for (
    let depth = 0;
    depth < MAX_TREE_DEPTH && frontier.length > 0;
    depth += 1
  ) {
    const nextFrontier: string[] = [];
    for (const parentId of frontier) {
      const [subAgents, workflowNodes] = await Promise.all([
        window.snow.listSubAgentConversations(parentId).catch(() => []),
        window.snow.listWorkflowNodeSessions(parentId).catch(() => []),
      ]);
      for (const record of subAgents) {
        const id = record.conversationId?.trim();
        if (!id || visited.has(id)) continue;
        visited.add(id);
        nextFrontier.push(id);
        sources.push({
          conversationId: id,
          agent: "sub",
          name: record.subAgentName || record.title || "",
        });
      }
      for (const record of workflowNodes) {
        const id = record.conversationId?.trim();
        if (!id || visited.has(id)) continue;
        visited.add(id);
        nextFrontier.push(id);
        sources.push({
          conversationId: id,
          agent: "sub",
          name: record.nodeName || record.nodeId || "",
        });
      }
    }
    frontier = nextFrontier;
  }

  return sources;
};

type MemoryPanelProps = {
  /** Whether the panel is visible. Controlled by the /memory command. */
  open: boolean;
  onClose: () => void;
};

/**
 * Modal listing every project memory the active conversation (and its
 * sub-agent / WorkFlow node conversations) saved or merged, opened via the
 * /memory slash command — the memory counterpart of /changes.
 *
 * Data comes from the persisted `project_memories` rows keyed by
 * `conversation_id`; the conversation tree is resolved through the
 * sub_agent_sessions / workflow_node_sessions tables, so historical
 * conversations rebuild the same list as live ones. `memories:changed`
 * broadcasts refresh the list while the panel is open.
 */
export const MemoryPanel = ({
  open,
  onClose,
}: MemoryPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const { activeConversationId } = useChatConversationContext();
  const [entries, setEntries] = useState<ConversationMemoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!activeConversationId) {
      setEntries([]);
      return;
    }
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    try {
      const sources = await collectConversationSources(activeConversationId);
      const records = await window.snow.listProjectMemoriesByConversations(
        sources.map((source) => source.conversationId),
        PANEL_MEMORY_LIMIT,
      );
      if (requestId !== requestIdRef.current) return;
      const sourceById = new Map(
        sources.map((source) => [source.conversationId, source]),
      );
      setEntries(
        records.map((record) => {
          const source = sourceById.get(record.conversationId);
          return {
            ...record,
            agent: source?.agent ?? "main",
            agentName: source?.name ?? "",
          };
        }),
      );
    } catch {
      if (requestId === requestIdRef.current) {
        setEntries([]);
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [activeConversationId]);

  // 打开面板或切换会话时加载；关闭时保留上次数据，避免重开闪烁。
  useEffect(() => {
    if (!open) return;
    setExpandedIds(new Set());
    void load();
  }, [open, load]);

  // 记忆写入/更新/删除后主进程广播 memories:changed，面板据此实时刷新。
  useEffect(() => {
    if (!open) return;
    const unsubscribe = window.snow.onMemoriesChanged(() => {
      void load();
    });
    return () => {
      unsubscribe();
    };
  }, [open, load]);

  const summary = useMemo(() => {
    const mainCount = entries.filter((entry) => entry.agent === "main").length;
    const createdCount = entries.filter(
      (entry) => entry.createdAt === entry.updatedAt,
    ).length;
    return {
      total: entries.length,
      mainCount,
      subCount: entries.length - mainCount,
      createdCount,
      updatedCount: entries.length - createdCount,
    };
  }, [entries]);

  const mainEntries = useMemo(
    () => entries.filter((entry) => entry.agent === "main"),
    [entries],
  );
  const subEntries = useMemo(
    () => entries.filter((entry) => entry.agent === "sub"),
    [entries],
  );

  const kindLabel = (kind: string): string =>
    t(`memory.kind.${kind}`, { defaultValue: kind });

  const statusLabel = (status: string): string =>
    status === "pending"
      ? t("memory.statusPending", { defaultValue: "Pending" })
      : status === "archived"
        ? t("memory.statusArchived", { defaultValue: "Archived" })
        : t("memory.statusActive", { defaultValue: "Active" });

  const handleToggleExpand = (memoryId: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(memoryId)) {
        next.delete(memoryId);
      } else {
        next.add(memoryId);
      }
      return next;
    });
  };

  /** 跳转到项目记忆页面并预填该条标题，让用户在完整页面里继续查看/编辑。 */
  const handleLocateInLibrary = useCallback((title: string): void => {
    requestProjectMemoryPanel(title);
  }, []);

  const confirmDelete = async (): Promise<void> => {
    setIsDeleteConfirmOpen(false);
    const memoryIds = entries.map((entry) => entry.memoryId);
    if (isDeleting || memoryIds.length === 0) return;
    setIsDeleting(true);
    try {
      await window.snow.deleteProjectMemoriesByIds(memoryIds);
      // memories:changed 广播会触发刷新，这里先本地清空保证即时反馈。
      setEntries([]);
    } catch {
      // Ignore
    } finally {
      setIsDeleting(false);
    }
  };

  const renderRow = (entry: ConversationMemoryEntry): React.JSX.Element => {
    const isExpanded = expandedIds.has(entry.memoryId);
    const date = (entry.updatedAt || entry.createdAt).slice(0, 10);
    return (
      <li className="memory-panel-row" key={entry.memoryId}>
        <button
          aria-expanded={isExpanded}
          className="memory-panel-row-main"
          onClick={() => handleToggleExpand(entry.memoryId)}
          type="button"
        >
          <span className="memory-panel-row-chevron" aria-hidden="true">
            {isExpanded ? (
              <ChevronDown size={13} strokeWidth={2} />
            ) : (
              <ChevronRight size={13} strokeWidth={2} />
            )}
          </span>
          <span className={`memory-kind-badge ${entry.kind}`}>
            {kindLabel(entry.kind)}
          </span>
          <span className="memory-panel-row-title" title={entry.title}>
            {entry.title}
          </span>
          <span className="memory-panel-row-importance" aria-hidden="true">
            {Array.from({ length: entry.importance }, (_, i) => (
              <Star key={`on-${i}`} size={10} fill="currentColor" />
            ))}
            <span className="memory-importance-dim">
              {Array.from(
                { length: Math.max(0, 5 - entry.importance) },
                (_, i) => (
                  <Star key={`off-${i}`} size={10} />
                ),
              )}
            </span>
          </span>
          {entry.status !== "active" && (
            <span className={`memory-status-badge ${entry.status}`}>
              {statusLabel(entry.status)}
            </span>
          )}
          <span className="memory-panel-row-source" title={entry.agentName}>
            {entry.agent === "sub"
              ? entry.agentName ||
                t("chat.memory.agentSubName", { defaultValue: "Sub-agents" })
              : t("chat.memory.agentMainName", { defaultValue: "Main agent" })}
          </span>
          <span className="memory-panel-row-date">{date}</span>
        </button>
        {isExpanded && (
          <div className="memory-panel-row-detail">
            <p className="memory-panel-row-content">{entry.content}</p>
            {entry.tags.length > 0 && (
              <div className="memory-panel-row-tags">
                {entry.tags.map((tag) => (
                  <span className="memory-panel-tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <button
              className="memory-panel-locate-btn"
              onClick={() => handleLocateInLibrary(entry.title)}
              type="button"
            >
              <ArrowUpRight size={12} strokeWidth={2.2} />
              {t("chat.memory.locateInLibrary", {
                defaultValue: "Locate in project memory",
              })}
            </button>
          </div>
        )}
      </li>
    );
  };

  const renderGroup = (
    title: string,
    groupEntries: ConversationMemoryEntry[],
  ): React.JSX.Element | null =>
    groupEntries.length === 0 ? null : (
      <div className="memory-panel-group">
        <div className="memory-panel-group-title">
          {title}
          <span className="memory-panel-group-count">
            {groupEntries.length}
          </span>
        </div>
        <ul className="memory-panel-list">
          {groupEntries.map((entry) => renderRow(entry))}
        </ul>
      </div>
    );

  return (
    <Modal
      className="memory-panel-modal"
      closeLabel={t("common.close", { defaultValue: "Close" })}
      closeOnEscape
      description={t("chat.memory.description", {
        defaultValue: "Memories saved by this conversation and its sub-agents.",
      })}
      footer={
        entries.length > 0 ? (
          <button
            className="memory-panel-delete-btn"
            disabled={isDeleting}
            onClick={() => setIsDeleteConfirmOpen(true)}
            type="button"
          >
            {isDeleting ? (
              <Loader2 className="spin" size={13} />
            ) : (
              <Trash2 size={13} strokeWidth={2} />
            )}
            {t("chat.memory.deleteAll", {
              defaultValue: "Delete memories from this conversation",
            })}
          </button>
        ) : undefined
      }
      onClose={onClose}
      open={open}
      size="large"
      title={t("chat.memory.title", { defaultValue: "Conversation memories" })}
    >
      {isLoading ? (
        <div className="memory-panel-empty">
          <Loader2 className="spin" size={16} />
        </div>
      ) : entries.length === 0 ? (
        <div className="memory-panel-empty">
          <span className="memory-panel-empty-title">
            {!activeConversationId
              ? t("chat.memory.noConversation", {
                  defaultValue: "Open a conversation to view its memories.",
                })
              : t("chat.memory.emptyTitle", {
                  defaultValue: "No memories saved in this conversation",
                })}
          </span>
          <span className="memory-panel-empty-hint">
            {t("chat.memory.emptyHint", {
              defaultValue:
                "The AI saves what it learns during the conversation; saved entries show up here in real time.",
            })}
          </span>
        </div>
      ) : (
        <div className="memory-panel-body">
          <div className="memory-panel-summary">
            <span className="memory-panel-summary-text">
              {t("chat.memory.summary", {
                defaultValue: "{{count}} memor(y/ies) touched in this session",
                values: { count: summary.total },
              })}
            </span>
            <span className="memory-panel-badges">
              <span className="memory-panel-badge is-created">
                {t("chat.memory.createdBadge", {
                  defaultValue: "New {{count}}",
                  values: { count: summary.createdCount },
                })}
              </span>
              <span className="memory-panel-badge is-updated">
                {t("chat.memory.updatedBadge", {
                  defaultValue: "Updated {{count}}",
                  values: { count: summary.updatedCount },
                })}
              </span>
              <span className="memory-panel-badge is-main">
                {t("chat.memory.agentMainBadge", {
                  defaultValue: "Agent {{count}}",
                  values: { count: summary.mainCount },
                })}
              </span>
              {summary.subCount > 0 && (
                <span className="memory-panel-badge is-sub">
                  {t("chat.memory.agentSubBadge", {
                    defaultValue: "Sub-agents {{count}}",
                    values: { count: summary.subCount },
                  })}
                </span>
              )}
            </span>
          </div>

          {renderGroup(
            t("chat.memory.agentMainName", { defaultValue: "Main agent" }),
            mainEntries,
          )}
          {renderGroup(
            t("chat.memory.agentSubName", { defaultValue: "Sub-agents" }),
            subEntries,
          )}
        </div>
      )}
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("chat.memory.deleteAll", {
          defaultValue: "Delete memories from this conversation",
        })}
        message={t("chat.memory.deleteAllConfirm", {
          defaultValue:
            "Permanently delete the {{count}} memories saved by this conversation and its sub-agents? This cannot be undone.",
          values: { count: entries.length },
        })}
        onCancel={() => setIsDeleteConfirmOpen(false)}
        onConfirm={() => void confirmDelete()}
        open={isDeleteConfirmOpen}
        title={t("memory.deleteTitle", { defaultValue: "Delete memory" })}
        variant="danger"
      />
    </Modal>
  );
};
