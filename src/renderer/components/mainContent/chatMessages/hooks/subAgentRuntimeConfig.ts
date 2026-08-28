import type {
  ApiConfigRecord,
  SubAgentConfigRecord,
} from "../../../../../preload";
import {
  getResponsesFastModeFromConfig,
  getThinkingValueFromConfig,
} from "../../chatInput/configThinking";

export type SubAgentRuntimeConfig = {
  agentId: string;
  agentName: string;
  apiSource: "parent" | "agent";
  apiProfile: string;
  model: string;
  /** Inherited from the parent conversation's captured request. Undefined =
   *  let the selected profile use its own default. Explicit false is retained. */
  responsesFastMode?: boolean;
  /** Effective thinking snapshot captured at sub-agent creation. Resolved
   *  from the thinking configured on the resolved API profile; the parent
   *  run's per-send override never applies. Not a Profile write. */
  effectiveThinkingStrength: string;
  /** Effective Fast Mode snapshot captured at sub-agent creation. */
  effectiveResponsesFastMode: boolean;
  systemPrompt: string;
  toolsJson: string;
};

export type ResolveSubAgentRuntimeConfigInput = {
  config: SubAgentConfigRecord;
  apiConfigs: readonly ApiConfigRecord[];
  parentApiProfile?: string;
  parentModel?: string;
  /** Effective Fast Mode captured by the parent run; false is meaningful. */
  parentResponsesFastMode?: boolean | null;
};

const normalizeNonEmpty = (value: string | undefined): string =>
  value?.trim() ?? "";

export const parseSubAgentTools = (toolsJson: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolsJson);
  } catch {
    throw new Error("Sub-agent toolsJson must be valid JSON");
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((tool) => typeof tool !== "string" || !tool.trim())
  ) {
    throw new Error(
      "Sub-agent toolsJson must be an array of non-empty strings",
    );
  }

  return Array.from(new Set(parsed.map((tool) => tool.trim())));
};

export const resolveSubAgentRuntimeConfig = ({
  config,
  apiConfigs,
  parentApiProfile,
  parentModel,
  parentResponsesFastMode,
}: ResolveSubAgentRuntimeConfigInput): SubAgentRuntimeConfig => {
  const agentId = normalizeNonEmpty(config.agentId);
  const agentName = normalizeNonEmpty(config.name);
  if (!agentId || !agentName) {
    throw new Error("Sub-agent configuration requires a valid id and name");
  }

  parseSubAgentTools(config.toolsJson);

  const configuredProfile = normalizeNonEmpty(config.configProfile);
  const inheritedProfile = normalizeNonEmpty(parentApiProfile);
  const apiSource = configuredProfile ? "agent" : "parent";
  const requestedProfile = configuredProfile || inheritedProfile;
  const apiConfig = requestedProfile
    ? apiConfigs.find((item) => item.profileName.trim() === requestedProfile)
    : apiConfigs.find((item) => item.isActive);

  if (!apiConfig) {
    if (configuredProfile) {
      throw new Error(
        `Sub-agent API profile is unavailable: ${configuredProfile}`,
      );
    }
    if (inheritedProfile) {
      throw new Error(`Parent API profile is unavailable: ${inheritedProfile}`);
    }
    throw new Error("No active API profile is available for the sub-agent");
  }

  const apiProfile = normalizeNonEmpty(apiConfig.profileName);
  if (!apiProfile) {
    throw new Error("Sub-agent API profile name is empty");
  }

  const configuredModel = normalizeNonEmpty(config.model);
  const inheritedModel = normalizeNonEmpty(parentModel);
  const model =
    apiSource === "agent"
      ? configuredModel || normalizeNonEmpty(apiConfig.advancedModel)
      : inheritedModel || normalizeNonEmpty(apiConfig.advancedModel);
  if (!model) {
    throw new Error(`No model is configured for API profile: ${apiProfile}`);
  }

  // 思考强度始终跟随解析后 Profile 的配置值，不继承父会话的发送覆盖
  //（父覆盖未必适用于该 Profile 的模型）。
  const effectiveThinkingStrength = getThinkingValueFromConfig(apiConfig);
  // Resolve effective values exactly once when this sub-agent runtime is built.
  // These are request snapshots, never mutations of the API Profile.
  const effectiveResponsesFastMode =
    parentResponsesFastMode ?? getResponsesFastModeFromConfig(apiConfig);

  return {
    agentId,
    agentName,
    apiSource,
    apiProfile,
    model,
    responsesFastMode: parentResponsesFastMode ?? undefined,
    effectiveThinkingStrength,
    effectiveResponsesFastMode,
    systemPrompt: config.systemPrompt.trim(),
    toolsJson: config.toolsJson,
  };
};
