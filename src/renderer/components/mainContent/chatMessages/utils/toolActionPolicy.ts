import type { ToolCallInfo } from "./conversationTypes";

/**
 * 单工具 + action 的只读动作策略（由 Rust 的 listToolReadonlyActions 提供）：
 * 工具名 -> 真正只读的 action 列表。表外的工具不受 action 约束，整名即只读。
 */
type ToolReadonlyActionPolicy = Record<string, readonly string[]>;

let policy: ToolReadonlyActionPolicy = {};
let loaded = false;
let loading: Promise<void> | null = null;

/** 解析工具参数里的 action（非法 JSON 或缺失时返回 null）。 */
export const parseToolAction = (
  argumentsJson: string | undefined,
): string | null => {
  if (!argumentsJson) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const action = (parsed as { action?: unknown }).action;
    return typeof action === "string" && action.trim() ? action.trim() : null;
  } catch {
    return null;
  }
};

/** 拉取一次只读动作策略并缓存；失败时下次调用重试。 */
export const ensureToolActionPolicy = async (): Promise<void> => {
  if (loaded) {
    return;
  }
  if (loading) {
    return loading;
  }
  const loader = window.snow?.listToolReadonlyActions;
  if (!loader) {
    return;
  }
  loading = loader()
    .then((value) => {
      const next: ToolReadonlyActionPolicy = {};
      if (value && typeof value === "object") {
        for (const [name, actions] of Object.entries(value)) {
          if (Array.isArray(actions)) {
            next[name] = actions.filter(
              (action): action is string => typeof action === "string",
            );
          }
        }
      }
      policy = next;
      loaded = true;
    })
    .catch(() => {
      policy = {};
    })
    .finally(() => {
      loading = null;
    });
  return loading;
};

export const getToolReadonlyActions = (
  toolName: string,
): readonly string[] | undefined => policy[toolName];

/** 该工具名是否受 action 约束（统一 manage 类工具）。 */
export const hasActionPolicy = (toolName: string): boolean =>
  policy[toolName] !== undefined;

/**
 * 判断一次调用是否只读。表外工具返回 true；表内工具只有列出的 action 只读，
 * action 缺失或无法解析时按写操作处理（保守）。
 */
export const isActionReadonly = (
  toolName: string,
  action: string | null,
): boolean => {
  const allowed = policy[toolName];
  if (!allowed) {
    return true;
  }
  return action !== null && allowed.includes(action);
};

export const isReadonlyActionCall = (toolCall: ToolCallInfo): boolean =>
  isActionReadonly(toolCall.name, parseToolAction(toolCall.arguments));

/**
 * 审批键：受 action 约束的工具在写动作上使用 `工具名:action`（例如
 * `config-manage:set`），这样「始终允许」只放行该动作；只读动作与表外工具
 * 仍用工具全名。
 */
export const toolApprovalKeys = (toolCall: ToolCallInfo): string[] => {
  const allowed = policy[toolCall.name];
  const action = parseToolAction(toolCall.arguments);
  if (!allowed || !action || allowed.includes(action)) {
    return [toolCall.name];
  }
  return [`${toolCall.name}:${action}`];
};
