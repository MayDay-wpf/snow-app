import { useMemo } from "react";
import {
  AlertCircle,
  Circle,
  List,
  Loader2,
  Pencil,
  Save,
  Search,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type MemoryToolCallProps = {
  toolCall: ToolCallInfo;
};

type MemoryAction = "save" | "search" | "list" | "update" | "delete";
type MemoryKind = "fact" | "decision" | "preference" | "pitfall" | "task_state";

type ParsedMemoryArgs = {
  action: MemoryAction;
  title?: string;
  content?: string;
  query?: string;
  kind?: MemoryKind;
  importance?: number;
  tags?: string[];
  memoryId?: string;
  limit?: number;
  status?: string;
};

type ParsedMemoryResult =
  | { type: "success"; itemCount: number; deleted: boolean }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidAction = (value: unknown): value is MemoryAction =>
  typeof value === "string" &&
  ["save", "search", "list", "update", "delete"].includes(value);

const isValidKind = (value: unknown): value is MemoryKind =>
  typeof value === "string" &&
  ["fact", "decision", "preference", "pitfall", "task_state"].includes(value);

const parseArgs = (args: string): ParsedMemoryArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed) || !isValidAction(parsed.action)) {
      return null;
    }

    const result: ParsedMemoryArgs = { action: parsed.action };

    if (typeof parsed.title === "string") result.title = parsed.title;
    if (typeof parsed.content === "string") result.content = parsed.content;
    if (typeof parsed.query === "string") result.query = parsed.query;
    if (isValidKind(parsed.kind)) result.kind = parsed.kind;
    if (typeof parsed.importance === "number") result.importance = parsed.importance;
    if (Array.isArray(parsed.tags)) {
      result.tags = parsed.tags.filter((x): x is string => typeof x === "string");
    }
    if (typeof parsed.memoryId === "string") result.memoryId = parsed.memoryId;
    if (typeof parsed.limit === "number") result.limit = parsed.limit;
    if (typeof parsed.status === "string") result.status = parsed.status;

    return result;
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedMemoryResult => {
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

    if (typeof parsed.message === "string") {
      return { type: "error", message: parsed.message };
    }

    const deleted = parsed.deleted === true;
    let itemCount = 0;
    if (Array.isArray(parsed.items)) {
      itemCount = parsed.items.length;
    } else if (typeof parsed.todos === "number") {
      itemCount = parsed.todos;
    }

    if (deleted || itemCount > 0 || typeof parsed.memoryId === "string") {
      return { type: "success", itemCount, deleted };
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

const ACTION_ICON_MAP: Record<MemoryAction, LucideIcon> = {
  save: Save,
  search: Search,
  list: List,
  update: Pencil,
  delete: Trash2,
};

export const MemoryToolCall = ({
  toolCall,
}: MemoryToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result]
  );

  const isRunning = toolCall.status === "running";

  const action = parsedArgs?.action ?? "list";
  const ActionIcon = ACTION_ICON_MAP[action] ?? List;
  const actionLabel = t(`toolCall.memory.action.${action}`);

  const effectiveStatus =
    parsedResult.type === "error" ? "error" : toolCall.status;

  const hasError = parsedResult.type === "error";

  // Header 摘要：save/update 显示标题，search 显示查询词，delete 显示 memoryId。
  const summary =
    parsedArgs?.title ??
    parsedArgs?.query ??
    (parsedArgs?.action === "delete" || parsedArgs?.action === "update"
      ? parsedArgs?.memoryId
      : undefined);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.memory.name")}
      category="generic"
      displayName={summary}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" && parsedResult.itemCount > 0 ? (
          <span className="tool-call-memory-count">
            {t("toolCall.memory.itemCount", {
              values: { count: parsedResult.itemCount },
            })}
          </span>
        ) : null
      }
      className="tool-call-memory"
    >
      <div className="tool-call-body tool-call-memory-body">
        {/* Action badge */}
        <div className="tool-call-memory-action-row">
          <span className="tool-call-memory-action-badge">
            <ActionIcon size={12} aria-hidden="true" />
            {actionLabel}
          </span>
          {parsedResult.type === "success" ? (
            <span className="tool-call-memory-hint">
              {parsedResult.deleted
                ? t("toolCall.memory.deleted")
                : parsedResult.itemCount === 0
                  ? t("toolCall.memory.empty")
                  : t("toolCall.memory.viewInSidebar")}
            </span>
          ) : null}
        </div>

        {/* Arguments */}
        {parsedArgs ? (
          <div className="tool-call-memory-args">
            {parsedArgs.title ? (
              <div className="tool-call-memory-arg-item">
                <span className="tool-call-memory-arg-label">
                  {t("toolCall.memory.title")}
                </span>
                <pre className="tool-call-memory-arg-value">
                  {parsedArgs.title}
                </pre>
              </div>
            ) : null}

            {parsedArgs.query ? (
              <div className="tool-call-memory-arg-item">
                <span className="tool-call-memory-arg-label">
                  {t("toolCall.memory.query")}
                </span>
                <pre className="tool-call-memory-arg-value">
                  {parsedArgs.query}
                </pre>
              </div>
            ) : null}

            {parsedArgs.content ? (
              <div className="tool-call-memory-arg-item">
                <span className="tool-call-memory-arg-label">
                  {t("toolCall.memory.content")}
                </span>
                <pre className="tool-call-memory-arg-value">
                  {parsedArgs.content}
                </pre>
              </div>
            ) : null}

            {parsedArgs.memoryId ? (
              <div className="tool-call-memory-arg-item">
                <span className="tool-call-memory-arg-label">
                  {t("toolCall.memory.memoryId")}
                </span>
                <code className="tool-call-memory-arg-code">
                  {parsedArgs.memoryId}
                </code>
              </div>
            ) : null}

            {parsedArgs.kind ? (
              <div className="tool-call-memory-arg-item">
                <span className="tool-call-memory-arg-label">
                  {t("toolCall.memory.kind")}
                </span>
                <span className="tool-call-memory-kind-badge">
                  {t(`toolCall.memory.kindValue.${parsedArgs.kind}`)}
                </span>
              </div>
            ) : null}

            {parsedArgs.importance ? (
              <div className="tool-call-memory-arg-item">
                <span className="tool-call-memory-arg-label">
                  {t("toolCall.memory.importance")}
                </span>
                <span className="tool-call-memory-importance-badge">
                  {parsedArgs.importance}
                </span>
              </div>
            ) : null}

            {parsedArgs.tags && parsedArgs.tags.length > 0 ? (
              <div className="tool-call-memory-arg-item">
                <span className="tool-call-memory-arg-label">
                  {t("toolCall.memory.tags")}
                </span>
                <span className="tool-call-memory-tags">
                  {parsedArgs.tags.map((tag) => (
                    <code className="tool-call-memory-tag" key={tag}>
                      {tag}
                    </code>
                  ))}
                </span>
              </div>
            ) : null}

            {parsedArgs.status ? (
              <div className="tool-call-memory-arg-item">
                <span className="tool-call-memory-arg-label">
                  {t("toolCall.memory.statusLabel")}
                </span>
                <code className="tool-call-memory-arg-code">
                  {parsedArgs.status}
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
              {t("toolCall.memory.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* Pending state */}
        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-memory-pending ${
              isRunning ? "tool-call-memory-pending-running" : ""
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
                ? t("toolCall.memory.running")
                : t("toolCall.memory.waiting")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
