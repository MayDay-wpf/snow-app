import type { SubAgentConfigInput } from "../../../../preload";
import type { SubAgentDraft, SubAgentItem } from "./types";

export const SUB_AGENT_ALL_TOOLS_MARKER = "*";

export const EMPTY_SUB_AGENT_DRAFT: SubAgentDraft = {
  agentId: "",
  name: "",
  description: "",
  systemPrompt: "",
  toolNames: [],
  configProfile: "",
  model: "",
  builtin: false,
  sortOrder: 0,
  source: "manual",
};

const parseStoredToolNames = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return Array.from(
      new Set(parsed.filter((tool): tool is string => typeof tool === "string"))
    );
  } catch {
    return [];
  }
};

export const usesAllTools = (toolNames: readonly string[]): boolean =>
  toolNames.length === 1 && toolNames[0] === SUB_AGENT_ALL_TOOLS_MARKER;

export const itemUsesAllTools = (item: SubAgentItem): boolean =>
  usesAllTools(parseStoredToolNames(item.toolsJson));

export const createDraftFromItem = (item: SubAgentItem): SubAgentDraft => ({
  agentId: item.agentId,
  name: item.name,
  description: item.description,
  systemPrompt: item.systemPrompt,
  toolNames: parseStoredToolNames(item.toolsJson),
  configProfile: item.configProfile,
  model: item.model,
  builtin: item.builtin,
  sortOrder: item.sortOrder,
  source: item.source,
});

export const toSubAgentInput = (draft: SubAgentDraft): SubAgentConfigInput => ({
  agentId: draft.agentId,
  name: draft.name.trim(),
  description: draft.description.trim(),
  systemPrompt: draft.systemPrompt,
  toolsJson: JSON.stringify(Array.from(new Set(draft.toolNames)).sort()),
  configProfile: draft.configProfile.trim(),
  model: draft.model.trim(),
  builtin: draft.builtin,
  sortOrder: draft.sortOrder,
  source: draft.source,
});

export const countTools = (
  item: SubAgentItem,
  availableToolCount = 0
): number => {
  const toolNames = parseStoredToolNames(item.toolsJson);
  return usesAllTools(toolNames) ? availableToolCount : toolNames.length;
};
