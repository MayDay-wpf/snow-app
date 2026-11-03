import { ADMIN_WRITE_ACTIONS } from "./domains/admin";
import { CONFIG_WRITE_ACTIONS } from "./domains/config";
import { CONTENT_WRITE_ACTIONS } from "./domains/content";
import { DRAFT_WRITE_ACTIONS } from "./domains/draft";
import { INTERACTION_WRITE_ACTIONS } from "./domains/interactions";
import { SYSTEM_WRITE_ACTIONS } from "./domains/system";
import type { PluginWriteActionDefinition } from "./types";

export const WRITE_ACTIONS: PluginWriteActionDefinition[] = [
  ...CONTENT_WRITE_ACTIONS,
  ...SYSTEM_WRITE_ACTIONS,
  ...DRAFT_WRITE_ACTIONS,
  ...INTERACTION_WRITE_ACTIONS,
  ...CONFIG_WRITE_ACTIONS,
  ...ADMIN_WRITE_ACTIONS,
];
