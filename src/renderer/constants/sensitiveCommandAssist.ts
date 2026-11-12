/**
 * 敏感命令的决策模型辅助配置。
 *
 * 真源是 system_settings 的 `sensitive_command_assist`，JSON 形如
 * `{ enabled, modelId, delegate, askOnDeny }`。Rust 侧（native/src/api/decision_model.rs +
 * native/src/exports/api.rs）按同一份 JSON 解析，字段名必须保持 camelCase 一致。
 *
 * - enabled：总开关，默认关闭。关闭时不请求决策模型，敏感命令照常弹确认。
 * - modelId：参与判定的决策模型 id（「API 配置 → 决策模型」中已启用的条目）；
 *   空串表示跟随该面板设置的默认模型（`decision_tool_model`）。
 * - delegate：托管，默认关闭。开启后判定直接生效（允许则放行、拒绝则拒绝）；
 *   关闭时判定只在敏感命令拦截提示中作为建议展示。
 * - askOnDeny：拒绝时仍让我确认，默认关闭，仅在托管开启时生效。开启后允许
 *   仍直接放行，拒绝则转为人工确认，由用户决定是否执行。
 * - useConversationContext：判定时附带最近会话片段，默认关闭（会把会话内容发给
 *   决策模型）。OpenAI 走多轮 input，TypeSafe Jev 放进 state。
 * - contextMessageCount：附带的最近消息条数，默认 8，范围 1-50。渲染层按上限
 *   构建片段，Rust 按该值保留最新的若干条。
 * - learnPreferences：自动学习用户偏好，默认关闭。开启后记录用户在拦截提示中
 *   的同意 / 拒绝（含模型拒绝但用户同意），建议与托管判定都附带相似记录。
 */

export const SENSITIVE_COMMAND_ASSIST_SETTING_NAME =
  "Sensitive command decision assist";
export const SENSITIVE_COMMAND_ASSIST_SETTING_CODE = "sensitive_command_assist";

/** 会话上下文条数：默认值与可配置范围（上限与 Rust MAX_CONTEXT_MESSAGES 一致）。 */
export const DEFAULT_SENSITIVE_COMMAND_CONTEXT_MESSAGES = 8;
export const MIN_SENSITIVE_COMMAND_CONTEXT_MESSAGES = 1;
export const MAX_SENSITIVE_COMMAND_CONTEXT_MESSAGES = 50;

/** 把任意输入规整为合法条数（非数字回落默认值，越界钳制）。 */
export const normalizeContextMessageCount = (value: unknown): number => {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SENSITIVE_COMMAND_CONTEXT_MESSAGES;
  }
  return Math.min(
    MAX_SENSITIVE_COMMAND_CONTEXT_MESSAGES,
    Math.max(MIN_SENSITIVE_COMMAND_CONTEXT_MESSAGES, Math.round(parsed)),
  );
};

/** 单个敏感命令辅助配置。 */
export type SensitiveCommandAssistSettings = {
  enabled: boolean;
  modelId: string;
  delegate: boolean;
  askOnDeny: boolean;
  useConversationContext: boolean;
  contextMessageCount: number;
  learnPreferences: boolean;
};

export const DEFAULT_SENSITIVE_COMMAND_ASSIST_SETTINGS: SensitiveCommandAssistSettings =
  {
    enabled: false,
    modelId: "",
    delegate: false,
    askOnDeny: false,
    useConversationContext: false,
    contextMessageCount: DEFAULT_SENSITIVE_COMMAND_CONTEXT_MESSAGES,
    learnPreferences: false,
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 读取系统设置里的辅助配置（未配置 / 解析失败返回默认值）。 */
export const readSensitiveCommandAssistSettings = (
  value: string | null,
): SensitiveCommandAssistSettings => {
  if (!value) {
    return { ...DEFAULT_SENSITIVE_COMMAND_ASSIST_SETTINGS };
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return { ...DEFAULT_SENSITIVE_COMMAND_ASSIST_SETTINGS };
    }

    return {
      // 缺省一律视为关闭：手写配置时无需显式写 false。
      enabled: parsed.enabled === true,
      modelId: typeof parsed.modelId === "string" ? parsed.modelId.trim() : "",
      delegate: parsed.delegate === true,
      askOnDeny: parsed.askOnDeny === true,
      useConversationContext: parsed.useConversationContext === true,
      contextMessageCount:
        parsed.contextMessageCount === undefined
          ? DEFAULT_SENSITIVE_COMMAND_CONTEXT_MESSAGES
          : normalizeContextMessageCount(parsed.contextMessageCount),
      learnPreferences: parsed.learnPreferences === true,
    };
  } catch {
    return { ...DEFAULT_SENSITIVE_COMMAND_ASSIST_SETTINGS };
  }
};

/** 序列化为系统设置存储格式（去除模型 id 首尾空白）。 */
export const toSensitiveCommandAssistJson = (
  settings: SensitiveCommandAssistSettings,
): string =>
  JSON.stringify({
    enabled: settings.enabled,
    modelId: settings.modelId.trim(),
    delegate: settings.delegate,
    askOnDeny: settings.askOnDeny,
    useConversationContext: settings.useConversationContext,
    contextMessageCount: normalizeContextMessageCount(
      settings.contextMessageCount,
    ),
    learnPreferences: settings.learnPreferences,
  });
