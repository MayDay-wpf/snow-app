import { useCallback, useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
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
import { localizeToolError } from "./shared/toolErrorDisplay";

type MemoryToolCallProps = {
  toolCall: ToolCallInfo;
};

type MemoryAction = "save" | "search" | "list" | "update" | "delete";
type MemoryKind = "fact" | "decision" | "preference" | "pitfall" | "task_state";

type ParsedMemoryArgs = {
  action?: MemoryAction;
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

/** 记忆条目（action=search 的 results / action=list 的 items 元素）。 */
type MemoryListItem = {
  /** memory_id，用作列表与展开状态 key；缺失时退回「索引-标题」组合。 */
  key: string;
  title: string;
  kind: MemoryKind | null;
  importance: number | null;
  tags: string[];
  content: string;
};

type ParsedMemoryResult =
  | {
      type: "success";
      items: MemoryListItem[];
      deleted: boolean;
      saved: boolean;
      /** save / update 返回的记忆标题。 */
      memoryTitle?: string;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

/** 展开条目时内容摘要的字符上限，超出部分截断。 */
const CONTENT_PREVIEW_LIMIT = 240;

const previewContent = (content: string): string =>
  content.length > CONTENT_PREVIEW_LIMIT
    ? `${content.slice(0, CONTENT_PREVIEW_LIMIT)}…`
    : content;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidAction = (value: unknown): value is MemoryAction =>
  typeof value === "string" &&
  ["save", "search", "list", "update", "delete"].includes(value);

const isValidKind = (value: unknown): value is MemoryKind =>
  typeof value === "string" &&
  ["fact", "decision", "preference", "pitfall", "task_state"].includes(value);

const parseArgs = (args: string): ParsedMemoryArgs => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) {
      return {};
    }

    const result: ParsedMemoryArgs = {};

    // memory-manage 统一工具：action 是必填参数（save/search/list/update/delete），
    // 其余字段按动作使用。
    if (isValidAction(parsed.action)) result.action = parsed.action;
    if (typeof parsed.title === "string") result.title = parsed.title;
    if (typeof parsed.content === "string") result.content = parsed.content;
    if (typeof parsed.query === "string") result.query = parsed.query;
    if (isValidKind(parsed.kind)) result.kind = parsed.kind;
    if (typeof parsed.importance === "number")
      result.importance = parsed.importance;
    if (Array.isArray(parsed.tags)) {
      result.tags = parsed.tags.filter(
        (x): x is string => typeof x === "string",
      );
    }
    if (typeof parsed.memoryId === "string") result.memoryId = parsed.memoryId;
    if (typeof parsed.limit === "number") result.limit = parsed.limit;
    if (typeof parsed.status === "string") result.status = parsed.status;

    return result;
  } catch {
    return {};
  }
};

// 兼容旧会话记录：memory-save -> save；统一工具的 memory-manage 无后缀动作。
const actionFromName = (name: string): MemoryAction | null => {
  const suffix = name.replace(/^memory-/, "");
  return isValidAction(suffix) ? suffix : null;
};

/** 解析记忆条目数组：字段名沿用 Rust 侧 serde 序列化结果（snake_case）。 */
const parseMemoryItems = (raw: unknown[]): MemoryListItem[] => {
  const items: MemoryListItem[] = [];

  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    const title = typeof entry.title === "string" ? entry.title : "";
    const content = typeof entry.content === "string" ? entry.content : "";
    if (!title && !content) {
      continue;
    }

    const memoryId = typeof entry.memory_id === "string" ? entry.memory_id : "";
    items.push({
      key: memoryId || `${index}-${title}`,
      title,
      kind: isValidKind(entry.kind) ? entry.kind : null,
      importance:
        typeof entry.importance === "number" ? entry.importance : null,
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      content,
    });
  }

  return items;
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

    // 注意：message 是成功响应也带有的提示文案（save/update/delete/search），
    // 不能据此判定为错误；真实错误统一走 error 字段或 MCP 错误通道。

    // search 返回 results，list 返回 items，两者元素同为 MemoryRecord。
    const rawList = Array.isArray(parsed.results)
      ? parsed.results
      : Array.isArray(parsed.items)
        ? parsed.items
        : null;

    if (rawList) {
      return {
        type: "success",
        items: parseMemoryItems(rawList),
        deleted: false,
        saved: false,
      };
    }

    if (parsed.deleted === true) {
      return { type: "success", items: [], deleted: true, saved: false };
    }

    // save / update 返回单个 memory 对象。
    if (isRecord(parsed.memory)) {
      const { title } = parsed.memory;
      return {
        type: "success",
        items: [],
        deleted: false,
        saved: true,
        memoryTitle: typeof title === "string" ? title : undefined,
      };
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
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  // 结果列表（action=search / action=list）中已展开条目的 key。
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleExpanded = useCallback((key: string): void => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }, []);

  const isRunning = toolCall.status === "running";

  const action = parsedArgs.action ?? actionFromName(toolCall.name) ?? "list";
  const ActionIcon = ACTION_ICON_MAP[action] ?? List;
  const actionLabel = t(`toolCall.memory.action.${action}`);

  const resultItems = parsedResult.type === "success" ? parsedResult.items : [];

  // 结果提示：删除/保存/更新为单条动作反馈；列表为空时提示无匹配。
  const hintText =
    parsedResult.type !== "success"
      ? null
      : parsedResult.deleted
        ? t("toolCall.memory.deleted")
        : parsedResult.saved
          ? action === "update"
            ? t("toolCall.memory.updated")
            : t("toolCall.memory.saved")
          : resultItems.length === 0
            ? t("toolCall.memory.empty")
            : null;

  const effectiveStatus =
    parsedResult.type === "error" ? "error" : toolCall.status;

  const hasError = parsedResult.type === "error";

  // 结果回填的记忆标题（update 返回的最新记录）。
  const resultTitle =
    parsedResult.type === "success" ? parsedResult.memoryTitle : undefined;

  // Header：save 显示标题，search 显示查询词，update/delete 显示动作名（不展示 ID）。
  const summary =
    action === "update" || action === "delete"
      ? [actionLabel, parsedArgs.title ?? resultTitle]
          .filter(Boolean)
          .join(" · ")
      : (parsedArgs.title ?? parsedArgs.query);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.memory.name")}
      category="generic"
      displayName={summary}
      status={effectiveStatus}
      meta={
        resultItems.length > 0 ? (
          <span className="tool-call-memory-count">
            {t("toolCall.memory.itemCount", {
              values: { count: resultItems.length },
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
          {hintText ? (
            <span className="tool-call-memory-hint">{hintText}</span>
          ) : null}
        </div>

        {/* Arguments */}
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

        {/* Result list (action=search / action=list) */}
        {resultItems.length > 0 ? (
          <ul className="tool-call-memory-list">
            {resultItems.map((item) => {
              const isExpanded = expandedKeys.has(item.key);
              return (
                <li className="tool-call-memory-list-item" key={item.key}>
                  <button
                    type="button"
                    className="tool-call-memory-list-head"
                    aria-expanded={isExpanded}
                    onClick={() => toggleExpanded(item.key)}
                  >
                    {isExpanded ? (
                      <ChevronDown size={12} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={12} aria-hidden="true" />
                    )}
                    {item.kind ? (
                      <span className="tool-call-memory-kind-badge">
                        {t(`toolCall.memory.kindValue.${item.kind}`)}
                      </span>
                    ) : null}
                    <span
                      className="tool-call-memory-list-title"
                      title={item.title}
                    >
                      {item.title}
                    </span>
                    {item.importance ? (
                      <span className="tool-call-memory-importance-badge">
                        {item.importance}
                      </span>
                    ) : null}
                    {item.tags.length > 0 ? (
                      <span className="tool-call-memory-tags">
                        {item.tags.map((tag) => (
                          <code className="tool-call-memory-tag" key={tag}>
                            {tag}
                          </code>
                        ))}
                      </span>
                    ) : null}
                  </button>
                  {isExpanded && item.content ? (
                    <p className="tool-call-memory-list-content">
                      {previewContent(item.content)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {/* Error */}
        {hasError ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, parsedResult.message)}</span>
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
