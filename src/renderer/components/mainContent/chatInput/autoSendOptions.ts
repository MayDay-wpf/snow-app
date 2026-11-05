import type {
  ApiConfigRecord,
  ScheduledTaskRunOptions,
} from "../../../../preload";
import { getResponsesFastModeFromConfig } from "./configThinking";
import type { ChatInputSendOptions } from "./types";

type AutoSendChatInputSendOptions = ChatInputSendOptions & {
  /** One-shot effective Fast Mode resolved from the scheduled profile. */
  responsesFastMode?: string | null;
};

type AutoSendRunOverride = ScheduledTaskRunOptions & {
  /** Optional future/bridge-provided one-shot Fast Mode override. */
  responsesFastMode?: string | null;
};

type AutoSendApiConfig = Pick<
  ApiConfigRecord,
  "profileName" | "advancedModel"
> &
  Partial<Pick<ApiConfigRecord, "requestMethod" | "configJson" | "isActive">>;

export type ResolveAutoSendOptionsInput = {
  autoSendOverride?: ScheduledTaskRunOptions | null;
  apiConfigs: readonly AutoSendApiConfig[];
  selectedModel?: string;
  selectedApiProfile?: string;
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

/**
 * Resolves the one-shot options used by buildFromContent auto-sends.
 * A task-bound profile may only use that same profile's advanced model; when
 * the profile is unavailable, the model stays omitted for Native fallback.
 */
export const resolveAutoSendOptions = ({
  autoSendOverride,
  apiConfigs,
  selectedModel,
  selectedApiProfile,
}: ResolveAutoSendOptionsInput): ChatInputSendOptions => {
  const taskApiProfile = nonEmpty(autoSendOverride?.apiProfile);
  const explicitTaskModel = nonEmpty(autoSendOverride?.model);
  let model = explicitTaskModel;

  if (!model) {
    if (taskApiProfile) {
      const taskApiConfig = apiConfigs.find(
        (config) => config.profileName.trim() === taskApiProfile,
      );
      model = nonEmpty(taskApiConfig?.advancedModel);
    } else {
      model = nonEmpty(selectedModel);
    }
  }

  const apiProfile = taskApiProfile ?? nonEmpty(selectedApiProfile);
  const selectedProfileConfig = apiProfile
    ? apiConfigs.find((config) => config.profileName.trim() === apiProfile)
    : (apiConfigs.find((config) => config.isActive) ?? apiConfigs[0]);
  const explicitFastMode = (autoSendOverride as AutoSendRunOverride | null)
    ?.responsesFastMode;
  // Scheduled sends keep an empty thinkingStrength as "follow this profile".
  // Fast Mode follows the same one-shot rule: resolve an explicit task value
  // when present, otherwise read the selected profile's current config now;
  // neither path creates a durable conversation override.
  const responsesFastMode =
    typeof explicitFastMode === "string"
      ? explicitFastMode
      : typeof selectedProfileConfig?.configJson === "string"
        ? getResponsesFastModeFromConfig(
            selectedProfileConfig as ApiConfigRecord,
          )
        : undefined;
  const basicModel = nonEmpty(autoSendOverride?.basicModel);
  const thinkingStrength = nonEmpty(autoSendOverride?.thinkingStrength);
  const options: AutoSendChatInputSendOptions = { origin: "internal" };

  if (model) options.model = model;
  if (apiProfile) options.apiProfile = apiProfile;
  if (basicModel) options.basicModel = basicModel;
  if (thinkingStrength) options.thinkingStrength = thinkingStrength;
  if (responsesFastMode !== undefined) {
    options.responsesFastMode = responsesFastMode;
  }

  return options;
};
