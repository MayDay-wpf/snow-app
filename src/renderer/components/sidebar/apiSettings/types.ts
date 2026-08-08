import type { ApiConfigRecord } from "../../../../preload";

export type ApiSettingsPanelProps = {
  onClose?: () => void;
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
  maxRetries: string;
  retryBaseDelayMs: string;
  systemPromptIdsJson: string;
  customHeaderSchemeId: string;
  thinkingValue: string;
  responsesVerbosity: string;
  responsesFastMode: boolean;
  googleSearch: boolean;
  visionGoogleSearch: boolean;
  visionThinkingEnabled: boolean;
  visionThinkingEffort: string;
  visionMaxTokens: string;
  configJson: string;
};

export type ApiConfigItem = ApiConfigRecord;
