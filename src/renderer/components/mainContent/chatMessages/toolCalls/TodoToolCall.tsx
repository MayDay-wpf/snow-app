import { useMemo } from "react";
import {
  AlertCircle,
  Circle,
  CircleDot,
  CheckCircle2,
  ExternalLink,
  ListChecks,
  Loader2,
  Plus,
  Trash2,
  Pencil,
  Eye,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { shortcutEvents } from "../../../shortcutEvents";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type TodoToolCallProps = {
  toolCall: ToolCallInfo;
};

type TodoAction = "get" | "add" | "update" | "delete";
type TodoStatus = "pending" | "inProgress" | "completed";

type ParsedTodoArgs = {
  action: TodoAction;
  content?: string | string[];
  parentId?: string;
  todoId?: string | string[];
  status?: TodoStatus;
};

type ParsedTodoResult =
  | { type: "success"; todoCount: number; completedCount: number }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidAction = (value: unknown): value is TodoAction =>
  typeof value === "string" &&
  ["get", "add", "update", "delete"].includes(value);

const isValidStatus = (value: unknown): value is TodoStatus =>
  typeof value === "string" &&
  ["pending", "inProgress", "completed"].includes(value);

const parseArgs = (args: string): ParsedTodoArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed) || !isValidAction(parsed.action)) {
      return null;
    }

    const result: ParsedTodoArgs = { action: parsed.action };

    if (typeof parsed.content === "string") {
      result.content = parsed.content;
    } else if (Array.isArray(parsed.content)) {
      result.content = parsed.content.filter(
        (c): c is string => typeof c === "string",
      );
    }

    if (typeof parsed.parentId === "string") {
      result.parentId = parsed.parentId;
    }

    if (typeof parsed.todoId === "string") {
      result.todoId = parsed.todoId;
    } else if (Array.isArray(parsed.todoId)) {
      result.todoId = parsed.todoId.filter(
        (t): t is string => typeof t === "string",
      );
    }

    if (isValidStatus(parsed.status)) {
      result.status = parsed.status;
    }

    return result;
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedTodoResult => {
  if (!result) {
    return { type: "empty" };
  }

  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }

    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }

    if (typeof parsed.sessionId === "string" && Array.isArray(parsed.todos)) {
      const todos = parsed.todos.filter(isRecord);
      const completedCount = todos.filter(
        (t) => isValidStatus(t.status) && t.status === "completed",
      ).length;
      return {
        type: "success",
        todoCount: todos.length,
        completedCount,
      };
    }

    if (typeof parsed.message === "string") {
      return { type: "error", message: parsed.message };
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

const formatContent = (content: string | string[] | undefined): string => {
  if (!content) return "";
  if (Array.isArray(content)) return content.join("\n");
  return content;
};

const formatTodoId = (todoId: string | string[] | undefined): string => {
  if (!todoId) return "";
  if (Array.isArray(todoId)) return todoId.join(", ");
  return todoId;
};

const ACTION_ICON_MAP: Record<TodoAction, typeof Eye> = {
  get: Eye,
  add: Plus,
  update: Pencil,
  delete: Trash2,
};

const STATUS_ICON_MAP: Record<TodoStatus, typeof Circle> = {
  pending: Circle,
  inProgress: CircleDot,
  completed: CheckCircle2,
};

export const TodoToolCall = ({
  toolCall,
}: TodoToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  const isRunning = toolCall.status === "running";

  const action = parsedArgs?.action ?? "get";
  const ActionIcon = ACTION_ICON_MAP[action] ?? ListChecks;
  const actionLabel = t(`toolCall.todo.action.${action}`);

  const effectiveStatus =
    parsedResult.type === "error" ? "error" : toolCall.status;

  const contentText = formatContent(parsedArgs?.content);
  const todoIdText = formatTodoId(parsedArgs?.todoId);

  const hasError = parsedResult.type === "error";

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.todo.name")}
      category="todo"
      displayName={actionLabel}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" ? (
          <span className="tool-call-todo-count">
            {t("toolCall.todo.itemCount", {
              values: {
                total: parsedResult.todoCount,
                completed: parsedResult.completedCount,
              },
            })}
          </span>
        ) : null
      }
      className="tool-call-todo"
    >
      <div className="tool-call-body tool-call-todo-body">
        {/* Action badge */}
        <div className="tool-call-todo-action-row">
          <span className="tool-call-todo-action-badge">
            <ActionIcon size={12} aria-hidden="true" />
            {actionLabel}
          </span>
          {parsedResult.type === "success" ? (
            parsedResult.todoCount === 0 ? (
              <span className="tool-call-todo-hint">
                {t("toolCall.todo.empty")}
              </span>
            ) : (
              <button
                type="button"
                className="tool-call-todo-hint tool-call-todo-hint-link"
                onClick={() => shortcutEvents.emit("open-todo")}
              >
                <span>{t("toolCall.todo.viewInTopBar")}</span>
                <ExternalLink size={11} aria-hidden="true" />
              </button>
            )
          ) : null}
        </div>

        {/* Arguments */}
        {parsedArgs ? (
          <div className="tool-call-todo-args">
            {contentText ? (
              <div className="tool-call-todo-arg-item">
                <span className="tool-call-todo-arg-label">
                  {t("toolCall.todo.content")}
                </span>
                <pre className="tool-call-todo-arg-value">{contentText}</pre>
              </div>
            ) : null}

            {todoIdText ? (
              <div className="tool-call-todo-arg-item">
                <span className="tool-call-todo-arg-label">
                  {t("toolCall.todo.todoId")}
                </span>
                <code className="tool-call-todo-arg-code">{todoIdText}</code>
              </div>
            ) : null}

            {parsedArgs.status ? (
              <div className="tool-call-todo-arg-item">
                <span className="tool-call-todo-arg-label">
                  {t("toolCall.todo.statusLabel")}
                </span>
                <span
                  className={`tool-call-todo-status-badge tool-call-todo-status-${parsedArgs.status}`}
                >
                  {t(`toolCall.todo.statusValue.${parsedArgs.status}`)}
                </span>
              </div>
            ) : null}

            {parsedArgs.parentId ? (
              <div className="tool-call-todo-arg-item">
                <span className="tool-call-todo-arg-label">
                  {t("toolCall.todo.parentId")}
                </span>
                <code className="tool-call-todo-arg-code">
                  {parsedArgs.parentId}
                </code>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Error */}
        {hasError ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {/* Raw result fallback */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.todo.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* Pending state */}
        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-todo-pending ${
              isRunning ? "tool-call-todo-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <Circle size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.todo.running")
                : t("toolCall.todo.waiting")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
