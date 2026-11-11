import { useSyncExternalStore } from "react";

/** 子代理运行控制：全局/单会话两层并发设置与失败挂起决策（重试/放弃）。
 *  仅存在于渲染进程内存；上限持久化在 system_settings，0 表示该层不限制。 */

const SUB_AGENT_GLOBAL_MAX_CONCURRENCY_SETTING =
  "sub_agent_global_max_concurrency";
export const SUB_AGENT_GLOBAL_MAX_CONCURRENCY_DEFAULT = 0;
export const SUB_AGENT_GLOBAL_MAX_CONCURRENCY_MIN = 0;
export const SUB_AGENT_GLOBAL_MAX_CONCURRENCY_MAX = 2000;
const SUB_AGENT_SESSION_MAX_CONCURRENCY_SETTING = "sub_agent_max_concurrency";
export const SUB_AGENT_SESSION_MAX_CONCURRENCY_DEFAULT = 0;
export const SUB_AGENT_SESSION_MAX_CONCURRENCY_MIN = 0;
export const SUB_AGENT_SESSION_MAX_CONCURRENCY_MAX = 2000;

export type SubAgentConcurrencyLimits = {
  /** 所有会话合计上限；0 表示不限制。 */
  global: number;
  /** 单会话上限；0 表示不限制，否则恒不大于全局上限。 */
  session: number;
};

const parseLimit = (value: unknown, fallback: number): number => {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
};

export const clampSubAgentGlobalMaxConcurrency = (value: unknown): number =>
  Math.min(
    SUB_AGENT_GLOBAL_MAX_CONCURRENCY_MAX,
    Math.max(
      SUB_AGENT_GLOBAL_MAX_CONCURRENCY_MIN,
      parseLimit(value, SUB_AGENT_GLOBAL_MAX_CONCURRENCY_DEFAULT),
    ),
  );

/** 单会话上限的可填上界：全局不限制（0）时只受最大值约束，否则不得超过全局上限。
 *  0（不限制）恒在范围内，不受该上界影响。 */
export const sessionConcurrencyUpperBound = (globalMax: number): number =>
  globalMax > 0
    ? Math.min(SUB_AGENT_SESSION_MAX_CONCURRENCY_MAX, globalMax)
    : SUB_AGENT_SESSION_MAX_CONCURRENCY_MAX;

/** 单会话上限：0 表示不限制；非 0 时收敛到 [1, 上界]。 */
export const clampSubAgentSessionMaxConcurrency = (
  value: unknown,
  globalMax: number,
): number =>
  Math.min(
    sessionConcurrencyUpperBound(globalMax),
    Math.max(
      SUB_AGENT_SESSION_MAX_CONCURRENCY_MIN,
      parseLimit(value, SUB_AGENT_SESSION_MAX_CONCURRENCY_DEFAULT),
    ),
  );

let limits: SubAgentConcurrencyLimits = {
  global: SUB_AGENT_GLOBAL_MAX_CONCURRENCY_DEFAULT,
  session: SUB_AGENT_SESSION_MAX_CONCURRENCY_DEFAULT,
};
let loading: Promise<void> | null = null;

const ensureLoaded = (): Promise<void> => {
  if (!loading) {
    loading = Promise.all([
      window.snow.getSystemSettingValue(
        SUB_AGENT_GLOBAL_MAX_CONCURRENCY_SETTING,
      ),
      window.snow.getSystemSettingValue(
        SUB_AGENT_SESSION_MAX_CONCURRENCY_SETTING,
      ),
    ]).then(([global, session]) => {
      const global_max =
        global != null && global.trim()
          ? clampSubAgentGlobalMaxConcurrency(global)
          : SUB_AGENT_GLOBAL_MAX_CONCURRENCY_DEFAULT;
      limits = {
        global: global_max,
        session:
          session != null && session.trim()
            ? clampSubAgentSessionMaxConcurrency(session, global_max)
            : clampSubAgentSessionMaxConcurrency(
                SUB_AGENT_SESSION_MAX_CONCURRENCY_DEFAULT,
                global_max,
              ),
      };
    });
  }
  return loading;
};

export const loadSubAgentConcurrencyLimits =
  async (): Promise<SubAgentConcurrencyLimits> => {
    await ensureLoaded();
    return { ...limits };
  };

/** 局部更新两层上限；任一层变化都会重新收敛单会话上限（0 表示不限制，非 0 不超过全局上限）。 */
export const saveSubAgentConcurrencyLimits = async (patch: {
  global?: unknown;
  session?: unknown;
}): Promise<SubAgentConcurrencyLimits> => {
  await ensureLoaded();
  const global =
    patch.global === undefined
      ? limits.global
      : clampSubAgentGlobalMaxConcurrency(patch.global);
  const session =
    patch.session === undefined
      ? clampSubAgentSessionMaxConcurrency(limits.session, global)
      : clampSubAgentSessionMaxConcurrency(patch.session, global);
  try {
    if (global !== limits.global) {
      await window.snow.setSystemSetting(
        "子代理全局最大并发数",
        SUB_AGENT_GLOBAL_MAX_CONCURRENCY_SETTING,
        String(global),
      );
    }
    if (session !== limits.session) {
      await window.snow.setSystemSetting(
        "子代理单会话最大并发数",
        SUB_AGENT_SESSION_MAX_CONCURRENCY_SETTING,
        String(session),
      );
    }
  } catch (error) {
    // 写入可能只成功一半：丢弃缓存，下次读取回源数据库。
    loading = null;
    throw error;
  }
  limits = { global, session };
  return { ...limits };
};

// ---------------------------------------------------------------------------
// 订阅（排队集合 / 待决策集合）
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
const ownerConversations = new Map<string, string>();
export const registerSubAgentRunControl = (
  ownerId: string,
  conversationId: string,
): void => {
  ownerConversations.set(ownerId, conversationId);
};
export const unregisterSubAgentRunControl = (ownerId: string): void => {
  ownerConversations.delete(ownerId);
  if (abandonedOwners.delete(ownerId)) emit();
};
const uiKey = (ownerId: string): string =>
  ownerConversations.get(ownerId) ?? ownerId;
const ownerKey = (key: string): string =>
  Array.from(ownerConversations).find(
    ([, conversationId]) => conversationId === key,
  )?.[0] ?? key;
let pendingDecisionSnapshot: ReadonlySet<string> = new Set();
let abandonedSnapshot: ReadonlySet<string> = new Set();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const emit = (): void => {
  pendingDecisionSnapshot = new Set(
    Array.from(decisionResolvers.keys()).flatMap((key) => [key, uiKey(key)]),
  );
  abandonedSnapshot = new Set(
    Array.from(abandonedOwners).flatMap((key) => [key, uiKey(key)]),
  );
  listeners.forEach((listener) => listener());
};

// ---------------------------------------------------------------------------
// 失败挂起决策
// ---------------------------------------------------------------------------

export type SubAgentFailureDecision = "retry" | "abandon";

const decisionResolvers = new Map<
  string,
  (decision: SubAgentFailureDecision) => void
>();
/** 用户已选择放弃、运行尚未收尾的 owner：期间输入区保持只读，收尾注销时清除。 */
const abandonedOwners = new Set<string>();

/** 挂起直到用户选择重试或放弃。 */
export const awaitSubAgentFailureDecision = (
  key: string,
): Promise<SubAgentFailureDecision> =>
  new Promise<SubAgentFailureDecision>((resolve) => {
    decisionResolvers.get(key)?.("abandon");
    decisionResolvers.set(key, resolve);
    emit();
  });

const settleSubAgentFailureDecision = (
  key: string,
  decision: SubAgentFailureDecision,
  userChoice: boolean,
): void => {
  key = ownerKey(key);
  const resolve = decisionResolvers.get(key);
  if (!resolve) return;
  decisionResolvers.delete(key);
  if (userChoice && decision === "abandon") abandonedOwners.add(key);
  emit();
  resolve(decision);
};

export const resolveSubAgentFailureDecision = (
  key: string,
  decision: SubAgentFailureDecision,
): void => settleSubAgentFailureDecision(key, decision, true);

/** 中止时唤醒该子代理的排队与待决策等待。 */
export const cancelSubAgentRunWaits = (key: string): void => {
  settleSubAgentFailureDecision(key, "abandon", false);
};

export const useSubAgentFailurePending = (key: string | undefined): boolean => {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => pendingDecisionSnapshot,
  );
  return Boolean(key && snapshot.has(key));
};

/** 已放弃但运行仍在收尾（尚未落终态）。 */
export const useSubAgentFailureAbandoned = (
  key: string | undefined,
): boolean => {
  const snapshot = useSyncExternalStore(subscribe, () => abandonedSnapshot);
  return Boolean(key && snapshot.has(key));
};
