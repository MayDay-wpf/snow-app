import {
  CheckCircle2,
  Circle,
  CircleDot,
  ListChecks,
  Pin,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useI18n } from "../../i18n";
import {
  appleSurfaceTransition,
  useAppleThemeMotion,
} from "../../hooks/useAppleThemeMotion";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { shortcutEvents } from "../shortcutEvents";
import type { ChatConversationMessage } from "../mainContent/chatMessages/utils/conversationTypes";
import { useTodoPanel } from "../mainContent/chatMessages/hooks/useTodoPanel";
import type {
  TodoItem,
  TodoStatus,
} from "../mainContent/chatMessages/hooks/useTodoPanel";
type TodoPanelButtonProps = {
  messages: ChatConversationMessage[];
  conversationId?: string;
  projectId?: string;
  isRunning?: boolean;
  onOpenChange?: (open: boolean) => void;
  onPinnedChange?: (pinned: boolean) => void;
};

const todoStatusIcon = (status: TodoStatus): typeof Circle => {
  switch (status) {
    case "completed":
      return CheckCircle2;
    case "inProgress":
      return CircleDot;
    default:
      return Circle;
  }
};

// 点击状态图标时循环切换：待完成 → 进行中 → 已完成 → 待完成
const nextTodoStatus = (status: TodoStatus): TodoStatus => {
  switch (status) {
    case "completed":
      return "pending";
    case "inProgress":
      return "completed";
    default:
      return "inProgress";
  }
};

const isTodoStatus = (value: unknown): value is TodoStatus =>
  value === "pending" || value === "inProgress" || value === "completed";

const parseTodos = (result: string): TodoItem[] | null => {
  const parsed = JSON.parse(result) as { todos?: unknown[] };
  if (!Array.isArray(parsed.todos)) {
    return null;
  }

  return parsed.todos
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null
    )
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      content: typeof item.content === "string" ? item.content : "",
      status: isTodoStatus(item.status) ? item.status : "pending",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      parentId: typeof item.parentId === "string" ? item.parentId : undefined,
    }))
    .filter((item) => item.id);
};

export const TodoPanelButton = ({
  messages,
  conversationId,
  projectId,
  isRunning = false,
  onOpenChange,
  onPinnedChange,
}: TodoPanelButtonProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const { enabled: appleMotionEnabled, reducedMotion } = useAppleThemeMotion();
  const popoverTransition = appleSurfaceTransition(reducedMotion);
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(
    null
  );
  const [localTodos, setLocalTodos] = useState<TodoItem[] | null>(null);
  const [fallbackTodos, setFallbackTodos] = useState<TodoItem[] | null>(null);
  const [fallbackSessionId, setFallbackSessionId] = useState<string | null>(
    null
  );
  const [newTodoContent, setNewTodoContent] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  const panel = useTodoPanel(messages);
  const panelSessionId = panel.sessionId;
  const panelTodos = panel.todos;

  // When the paginated history loader hasn't loaded the messages containing
  // the todo tool call (sessionId is null), fall back to a lightweight backend
  // query that searches the entire conversation for the latest todo-manage
  // tool result. This keeps the TopBar TODO button visible without forcing
  // the user to scroll up and trigger pagination.
  useEffect(() => {
    if (panelSessionId || !conversationId) {
      setFallbackTodos(null);
      setFallbackSessionId(null);
      return;
    }

    let cancelled = false;
    void window.snow
      .findLatestToolResult(conversationId, "todo-todo-manage")
      .then((result) => {
        if (cancelled || !result) {
          return;
        }
        const parsed = parseTodos(result);
        if (parsed) {
          // Extract sessionId from the raw result for subsequent MCP calls.
          try {
            const raw = JSON.parse(result) as { sessionId?: unknown };
            if (typeof raw.sessionId === "string") {
              setFallbackSessionId(raw.sessionId);
            }
          } catch {
            // Ignore parse errors — sessionId stays null
          }
          setFallbackTodos(parsed);
        }
      })
      .catch(() => {
        // Silent fail
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, panelSessionId]);

  const sessionId = panelSessionId ?? fallbackSessionId;
  // Priority: user-initiated localTodos > panelTodos (from loaded messages)
  // > fallbackTodos (from backend query). When sessionId exists, localTodos
  // takes precedence so user operations are reflected immediately.
  const todos = sessionId
    ? localTodos ?? (panelSessionId ? panelTodos : fallbackTodos ?? [])
    : [];
  const totalCount = todos.length;
  const completedCount = todos.filter(
    (todo) => todo.status === "completed"
  ).length;
  const incompleteCount = totalCount - completedCount;

  useEffect(() => {
    if (!sessionId) {
      setLocalTodos(null);
      return;
    }

    let cancelled = false;
    void window.snow
      .callMcpTool(
        "todo-todo-manage",
        JSON.stringify({ action: "get", sessionId }),
        projectId,
        undefined,
        undefined,
        undefined
      )
      .then((result) => {
        if (!cancelled) {
          const fetchedTodos = parseTodos(result);
          if (fetchedTodos) {
            setLocalTodos(fetchedTodos);
          }
        }
      })
      .catch(() => {
        // Silent fail
      });

    return () => {
      cancelled = true;
    };
  }, [messages, projectId, sessionId]);

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  // 订阅快捷键事件：Ctrl/Cmd+T 切换待办面板。
  useEffect(() => {
    return shortcutEvents.on("toggle-todo", () => {
      setIsOpen((prev) => !prev);
    });
  }, []);

  useEffect(() => {
    onPinnedChange?.(isPinned);
  }, [isPinned, onPinnedChange]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (isPinned) {
        return;
      }
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handleClickOutside, true);
    return () => {
      document.removeEventListener("pointerdown", handleClickOutside, true);
    };
  }, [isOpen, isPinned]);

  const todoStatusLabel = (status: TodoStatus): string => {
    switch (status) {
      case "completed":
        return t("topBar.todo.statusCompleted");
      case "inProgress":
        return t("topBar.todo.statusInProgress");
      default:
        return t("topBar.todo.statusPending");
    }
  };

  const handleAdd = useCallback(async (): Promise<void> => {
    const content = newTodoContent.trim();
    if (!content || !sessionId) {
      return;
    }

    setIsMutating(true);
    try {
      const result = await window.snow.callMcpTool(
        "todo-todo-manage",
        JSON.stringify({ action: "add", sessionId, content }),
        projectId,
        undefined,
        undefined,
        undefined
      );
      const newTodos = parseTodos(result);
      if (newTodos) {
        setLocalTodos(newTodos);
        setNewTodoContent("");
      }
    } catch {
      // Silent fail
    } finally {
      setIsMutating(false);
    }
  }, [newTodoContent, projectId, sessionId]);

  const handleStatusChange = useCallback(
    async (todo: TodoItem): Promise<void> => {
      if (!sessionId) {
        return;
      }

      setIsMutating(true);
      try {
        const result = await window.snow.callMcpTool(
          "todo-todo-manage",
          JSON.stringify({
            action: "update",
            sessionId,
            todoId: todo.id,
            status: nextTodoStatus(todo.status),
          }),
          projectId,
          undefined,
          undefined,
          undefined
        );
        const newTodos = parseTodos(result);
        if (newTodos) {
          setLocalTodos(newTodos);
        }
      } catch {
        // Silent fail
      } finally {
        setIsMutating(false);
      }
    },
    [projectId, sessionId]
  );

  const handleDelete = useCallback(
    async (todoIds: string[]): Promise<void> => {
      if (!sessionId || todoIds.length === 0) {
        return;
      }

      setIsMutating(true);
      try {
        const result = await window.snow.callMcpTool(
          "todo-todo-manage",
          JSON.stringify({ action: "delete", sessionId, todoId: todoIds }),
          projectId,
          undefined,
          undefined,
          undefined
        );
        const newTodos = parseTodos(result);
        if (newTodos) {
          setLocalTodos(newTodos);
        }
      } catch {
        // Silent fail
      } finally {
        setIsMutating(false);
      }
    },
    [projectId, sessionId]
  );

  // 无 TODO 会话时（AI 尚未在会话中使用过待办工具）不渲染按钮。
  if (!sessionId) {
    return null;
  }

  return (
    <div className="top-bar-todo-menu" ref={panelRef}>
      <button
        className={`icon-btn ghost top-bar-todo-btn${isOpen ? " active" : ""}`}
        type="button"
        aria-label={t("topBar.todo.title")}
        title={t("topBar.todo.title")}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <ListChecks size={16} strokeWidth={1.8} />
        {incompleteCount > 0 ? (
          <span className="top-bar-todo-badge">{incompleteCount}</span>
        ) : null}
      </button>
      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            animate={
              appleMotionEnabled
                ? reducedMotion
                  ? { opacity: 1 }
                  : { opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }
                : undefined
            }
            className="top-bar-todo-dropdown"
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
          <div className="top-bar-todo-dropdown-header">
            <span className="top-bar-todo-dropdown-title">
              {t("topBar.todo.title")}
            </span>
            <div className="top-bar-todo-dropdown-header-actions">
              <span className="top-bar-todo-dropdown-count">
                {t("topBar.todo.progress", {
                  values: { completed: completedCount, total: totalCount },
                })}
              </span>
              <button
                className={`top-bar-todo-pin-btn${isPinned ? " active" : ""}`}
                type="button"
                aria-label={t("topBar.todo.pin")}
                title={t("topBar.todo.pin")}
                aria-pressed={isPinned}
                onClick={() => setIsPinned((pinned) => !pinned)}
              >
                <Pin size={13} strokeWidth={1.8} />
              </button>
            </div>
          </div>
          <ul className="top-bar-todo-list">
            {todos.map((todo) => {
              const StatusIcon = todoStatusIcon(todo.status);
              const nextStatusLabel = todoStatusLabel(nextTodoStatus(todo.status));
              return (
                <li
                  key={todo.id}
                  className={`top-bar-todo-item top-bar-todo-item-${todo.status}`}
                >
                  <button
                    className="top-bar-todo-item-status"
                    type="button"
                    aria-label={t("topBar.todo.cycleStatus", {
                      values: { status: nextStatusLabel },
                    })}
                    title={t("topBar.todo.cycleStatus", {
                      values: { status: nextStatusLabel },
                    })}
                    disabled={isMutating || isRunning}
                    onClick={() => void handleStatusChange(todo)}
                  >
                    <StatusIcon
                      size={13}
                      className="top-bar-todo-item-icon"
                      aria-hidden="true"
                    />
                  </button>
                  <span className="top-bar-todo-item-content">
                    {todo.content}
                  </span>
                  {!isRunning ? (
                    <button
                      className="top-bar-todo-item-delete"
                      type="button"
                      aria-label={t("topBar.todo.confirmDelete")}
                      title={t("topBar.todo.confirmDelete")}
                      disabled={isMutating}
                      onClick={() => setConfirmDeleteIds([todo.id])}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!isRunning ? (
            <div className="top-bar-todo-add-bar">
              <input
                className="top-bar-todo-add-input"
                type="text"
                value={newTodoContent}
                placeholder={t("topBar.todo.addPlaceholder")}
                disabled={isMutating}
                onChange={(event) => setNewTodoContent(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleAdd();
                  }
                }}
              />
              <button
                className="top-bar-todo-add-btn"
                type="button"
                aria-label={t("topBar.todo.add")}
                title={t("topBar.todo.add")}
                disabled={isMutating || !newTodoContent.trim()}
                onClick={() => void handleAdd()}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
      <ConfirmDialog
        open={confirmDeleteIds !== null}
        variant="danger"
        title={t("topBar.todo.confirmDeleteTitle")}
        message={t("topBar.todo.confirmDeleteMessage")}
        confirmLabel={t("topBar.todo.confirmDelete")}
        cancelLabel={t("topBar.todo.cancelDelete")}
        onConfirm={() => {
          if (confirmDeleteIds) {
            void handleDelete(confirmDeleteIds);
          }
          setConfirmDeleteIds(null);
        }}
        onCancel={() => setConfirmDeleteIds(null)}
      />
    </div>
  );
};
