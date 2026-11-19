/** 子代理运行控制：全局/单会话两层并发设置。
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
