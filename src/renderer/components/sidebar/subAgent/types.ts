import type {
  SubAgentConfigRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";

export type SubAgentDraft = {
  agentId: string;
  name: string;
  description: string;
  systemPrompt: string;
  toolNames: string[];
  configProfile: string;
  model: string;
  builtin: boolean;
  sortOrder: number;
  source: string;
};

export type SubAgentToolOption = {
  name: string;
  description: string;
  serverId: string;
  serverName: string;
};

export type SubAgentItem = SubAgentConfigRecord;

export type SubAgentSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onClose?: () => void;
};
