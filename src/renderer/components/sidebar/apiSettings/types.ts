import type { ApiConfigRecord } from "../../../../preload";

/** API 配置页标签页：LLM 对话模型 / 图像生成 / 决策模型 / 嵌入模型 / 重排模型 / 重试策略。 */
export type ApiSettingsTab =
  "llm" | "decision" | "embedding" | "reranking" | "retry" | "imagegen";

export type ApiSettingsPanelProps = {
  /** 初始选中的标签页（绘图面板等外部入口直达指定 tab）。 */
  initialTab?: ApiSettingsTab;
};

export type ApiConfigFormData = {
  profileName: string;
  displayName: string;
  baseUrl: string;
  baseUrlMode: string;
  apiKey: string;
  requestMethod: string;
  advancedModel: string;
  basicModel: string;
  isActive: boolean;
  supportsVision: boolean;
  visionBaseUrl: string;
  visionApiKey: string;
  visionRequestMethod: string;
  visionModel: string;
  maxContextTokens: string;
  maxTokens: string;
  streamIdleTimeoutSec: string;
  enableAutoCompress: boolean;
  autoCompressThreshold: string;
  toolResultTokenLimit: string;
  maxRetries: string;
  retryBaseDelayMs: string;
  partialRetryMaxChars: string;
  systemPromptIdsJson: string;
  customHeaderSchemeId: string;
  thinkingValue: string;
  /** 1M 上下文开关（anthropic 请求方式）。独立存储于 snowcfg.enable1mContext，
   *  开启后所有 anthropic 请求都会携带 context-1m beta 头，不依赖模型名标记。 */
  oneMContext: boolean;
  /** Anthropic prompt 缓存 TTL（snowcfg.anthropicCacheTtl）："5m" | "1h"。 */
  anthropicCacheTtl: string;
  responsesVerbosity: string;
  /** Responses Fast Mode 档位："" = 关闭，"fast" = priority，"ultrafast"。 */
  responsesServiceTier: string;
  /** Responses WebSocket 开关（snowcfg.responsesWebSocket）。开启后 Responses
   *  请求改用 WebSocket 传输，并在多轮之间复用同一条连接。 */
  responsesWebSocket: boolean;
  googleSearch: boolean;
  visionGoogleSearch: boolean;
  visionThinkingEnabled: boolean;
  visionThinkingEffort: string;
  visionMaxTokens: string;
  visionMaxConcurrency: string;
  configJson: string;
};

export type ApiConfigItem = ApiConfigRecord;
