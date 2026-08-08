import { ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";
import {
  normalizeSystemPromptItem,
  readSnowCliSystemPromptConfig,
} from "../../settings/systemPromptSettings";
import {
  normalizeCustomHeaderScheme,
  readSnowCliCustomHeadersConfig,
} from "../../settings/customHeadersSettings";
import {
  deleteSnowCliMcpServerConfig,
  deleteSnowCliProjectMcpServerConfig,
  normalizeMcpServerConfig,
  normalizeProjectMcpServerConfig,
  readSnowCliMcpConfig,
} from "../../settings/mcpSettings";
import {
  normalizeProjectSensitiveCommandConfig,
  normalizeSensitiveCommandConfig,
  readSnowCliSensitiveCommandConfig,
} from "../../settings/sensitiveCommandSettings";
import { normalizeSubAgentConfig } from "../../settings/subAgentSettings";
import type { HookConfigInput, HookScope } from "../../native/types";

const requireProjectId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Project id is required");
  }
  return value.trim();
};

const normalizeHookConfig = (item: unknown): HookConfigInput => {
  if (!item || typeof item !== "object") {
    throw new Error("Hook config must be an object");
  }
  const raw = item as Record<string, unknown>;
  const hookType = typeof raw.hookType === "string" ? raw.hookType.trim() : "";
  if (!hookType) {
    throw new Error("Hook type is required");
  }
  const scope = typeof raw.scope === "string" ? raw.scope.trim() : "";
  if (scope !== "global" && scope !== "project") {
    throw new Error("Hook scope must be 'global' or 'project'");
  }
  const rulesJson = typeof raw.rulesJson === "string" ? raw.rulesJson : "";
  if (!rulesJson.trim()) {
    throw new Error("Hook rules JSON is required");
  }
  const projectId =
    typeof raw.projectId === "string" && raw.projectId.trim()
      ? raw.projectId.trim()
      : undefined;
  if (scope === "project" && !projectId) {
    throw new Error("Project id is required for project scope hooks");
  }
  return {
    hookType,
    scope: scope as HookScope,
    projectId,
    rulesJson,
  };
};

const validateSubAgentTools = async (
  native: NativeBridge,
  projectId: string | undefined,
  toolsJson: string
): Promise<void> => {
  const parsed: unknown = JSON.parse(toolsJson);
  const toolNames = Array.isArray(parsed)
    ? parsed.filter((tool): tool is string => typeof tool === "string")
    : [];

  if (
    toolNames.length === 0 ||
    (toolNames.length === 1 && toolNames[0] === "*")
  ) {
    return;
  }

  if (!projectId) {
    throw new Error(
      "Project id is required when sub-agent MCP tools are selected"
    );
  }

  const servers = await native.listMcpProjectServers(projectId);
  const availableServers = servers.filter(
    (server) => server.globalEnabled && server.enabled && !server.error
  );
  const toolsByServer = await Promise.all(
    availableServers.map(async (server) =>
      server.source === "system"
        ? server.tools
        : native.listMcpProjectServerTools(projectId, server.id)
    )
  );
  const availableToolNames = new Set(
    toolsByServer.flatMap((tools) =>
      tools.filter((tool) => tool.enabled).map((tool) => tool.name)
    )
  );
  const unavailableTool = toolNames.find(
    (toolName) => !availableToolNames.has(toolName)
  );

  if (unavailableTool) {
    throw new Error(
      `Selected sub-agent MCP tool is not enabled for the current project: ${unavailableTool}`
    );
  }
};

export const registerConfigHandlers = (native: NativeBridge): void => {
  // ===== System Prompts =====
  ipcMain.handle("system-prompts:list", () => native.listSystemPrompts());
  ipcMain.handle("system-prompts:upsert", async (_event, item: unknown) => {
    await native.upsertSystemPrompt(normalizeSystemPromptItem(item));
    return native.listSystemPrompts();
  });
  ipcMain.handle("system-prompts:delete", async (_event, promptId: unknown) => {
    if (typeof promptId !== "string" || !promptId.trim()) {
      throw new Error("Prompt ID is required");
    }
    await native.deleteSystemPrompt(promptId.trim());
    return native.listSystemPrompts();
  });
  ipcMain.handle("system-prompts:import-snow-cli", () =>
    readSnowCliSystemPromptConfig(native)
  );

  // ===== Custom Header Schemes =====
  ipcMain.handle("custom-header-schemes:list", () =>
    native.listCustomHeaderSchemes()
  );
  ipcMain.handle(
    "custom-header-schemes:upsert",
    async (_event, item: unknown) => {
      await native.upsertCustomHeaderScheme(normalizeCustomHeaderScheme(item));
      return native.listCustomHeaderSchemes();
    }
  );
  ipcMain.handle(
    "custom-header-schemes:delete",
    async (_event, schemeId: unknown) => {
      if (typeof schemeId !== "string" || !schemeId.trim()) {
        throw new Error("Custom header scheme ID is required");
      }
      await native.deleteCustomHeaderScheme(schemeId.trim());
      return native.listCustomHeaderSchemes();
    }
  );
  ipcMain.handle("custom-header-schemes:import-snow-cli", () =>
    readSnowCliCustomHeadersConfig(native)
  );

  // ===== MCP Server Configs =====
  ipcMain.handle("mcp-server-configs:list", () =>
    native.listMcpServerConfigs()
  );
  ipcMain.handle("mcp-server-configs:upsert", async (_event, item: unknown) => {
    await native.upsertMcpServerConfig(normalizeMcpServerConfig(item));
    return native.listMcpServerConfigs();
  });
  ipcMain.handle(
    "mcp-server-configs:delete",
    async (_event, serverId: unknown) => {
      if (typeof serverId !== "string" || !serverId.trim()) {
        throw new Error("MCP server ID is required");
      }
      const normalizedServerId = serverId.trim();
      const existing = (await native.listMcpServerConfigs()).find(
        (item) => item.serverId === normalizedServerId
      );
      if (existing?.source === "snow-cli") {
        deleteSnowCliMcpServerConfig(existing.name);
      }
      await native.deleteMcpServerConfig(normalizedServerId);
      return native.listMcpServerConfigs();
    }
  );
  ipcMain.handle("mcp-server-configs:import-snow-cli", () =>
    readSnowCliMcpConfig(native)
  );
  ipcMain.handle("project-mcp-server-configs:list", (_event, projectId) => {
    const normalizedProjectId = requireProjectId(projectId);
    return native.listProjectMcpServerConfigs(normalizedProjectId);
  });
  ipcMain.handle(
    "project-mcp-server-configs:upsert",
    async (_event, projectId, item) => {
      const normalizedProjectId = requireProjectId(projectId);
      await native.upsertProjectMcpServerConfig(
        normalizedProjectId,
        normalizeProjectMcpServerConfig(item)
      );
      return native.listProjectMcpServerConfigs(normalizedProjectId);
    }
  );
  ipcMain.handle(
    "project-mcp-server-configs:delete",
    async (_event, projectId, serverId) => {
      const normalizedProjectId = requireProjectId(projectId);
      if (typeof serverId !== "string" || !serverId.trim()) {
        throw new Error("MCP server ID is required");
      }
      const normalizedServerId = serverId.trim();
      const existing = (await native.listProjectMcpServerConfigs(
        normalizedProjectId
      )).find((item) => item.serverId === normalizedServerId);
      if (existing?.source === "snow-cli") {
        await deleteSnowCliProjectMcpServerConfig(
          native,
          normalizedProjectId,
          existing.name
        );
      }
      await native.deleteProjectMcpServerConfig(
        normalizedProjectId,
        normalizedServerId
      );
      return native.listProjectMcpServerConfigs(normalizedProjectId);
    }
  );

  // ===== Sub-agent Configs =====
  const normalizeOptionalProjectId = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  ipcMain.handle("sub-agent-configs:list", (_event, projectId: unknown) =>
    native.listSubAgentConfigs(normalizeOptionalProjectId(projectId))
  );
  ipcMain.handle(
    "sub-agent-configs:get",
    async (_event, agentId: unknown, projectId: unknown) => {
      if (typeof agentId !== "string" || !agentId.trim()) {
        throw new Error("Agent ID is required to get sub-agent config");
      }
      return native.getSubAgentConfig(
        agentId.trim(),
        normalizeOptionalProjectId(projectId)
      );
    }
  );
  ipcMain.handle(
    "sub-agent-configs:upsert",
    async (_event, projectId: unknown, item: unknown) => {
      const normalizedProjectId = normalizeOptionalProjectId(projectId);
      const normalized = normalizeSubAgentConfig({
        ...(typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {}),
        projectId: normalizedProjectId,
      });
      const apiConfigs = await native.listApiConfigs();
      if (
        normalized.configProfile &&
        !apiConfigs.some(
          (config) => config.profileName === normalized.configProfile
        )
      ) {
        throw new Error("Selected sub-agent API profile does not exist");
      }
      await validateSubAgentTools(
        native,
        normalizedProjectId,
        normalized.toolsJson
      );
      await native.upsertSubAgentConfig(normalized);
      return native.listSubAgentConfigs(normalizedProjectId);
    }
  );
  ipcMain.handle(
    "sub-agent-configs:delete",
    async (_event, agentId: unknown, projectId: unknown) => {
      if (typeof agentId !== "string" || !agentId.trim()) {
        throw new Error("Sub-agent ID is required");
      }

      const normalizedAgentId = agentId.trim();
      const normalizedProjectId = normalizeOptionalProjectId(projectId);
      const existing = await native.listSubAgentConfigs(normalizedProjectId);
      if (
        existing.some(
          (item) => item.agentId === normalizedAgentId && item.builtin
        )
      ) {
        throw new Error("Built-in sub-agents cannot be deleted");
      }

      await native.deleteSubAgentConfig(
        normalizedAgentId,
        normalizedProjectId
      );
      return native.listSubAgentConfigs(normalizedProjectId);
    }
  );

  // ===== Sensitive Command Configs =====
  ipcMain.handle("sensitive-command-configs:list", () =>
    native.listSensitiveCommandConfigs()
  );
  ipcMain.handle(
    "sensitive-command-configs:upsert",
    async (_event, item: unknown) => {
      await native.upsertSensitiveCommandConfig(
        normalizeSensitiveCommandConfig(item)
      );
      return native.listSensitiveCommandConfigs();
    }
  );
  ipcMain.handle(
    "sensitive-command-configs:delete",
    async (_event, commandId: unknown) => {
      if (typeof commandId !== "string" || !commandId.trim()) {
        throw new Error("Sensitive command ID is required");
      }

      await native.deleteSensitiveCommandConfig(commandId.trim());
      return native.listSensitiveCommandConfigs();
    }
  );
  ipcMain.handle("sensitive-command-configs:import-snow-cli", () =>
    readSnowCliSensitiveCommandConfig(native)
  );

  ipcMain.handle(
    "project-sensitive-command-configs:list",
    (_event, projectId) => {
      const normalizedProjectId = requireProjectId(projectId);
      return native.listProjectSensitiveCommandConfigs(normalizedProjectId);
    }
  );
  ipcMain.handle(
    "project-sensitive-command-configs:set-enabled",
    async (_event, projectId, commandId, enabled) => {
      const normalizedProjectId = requireProjectId(projectId);
      if (typeof commandId !== "string" || !commandId.trim()) {
        throw new Error("Sensitive command ID is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("Sensitive command enabled state must be a boolean");
      }

      await native.setProjectSensitiveCommandEnabled(
        normalizedProjectId,
        commandId.trim(),
        enabled
      );
      return native.listProjectSensitiveCommandConfigs(normalizedProjectId);
    }
  );
  ipcMain.handle(
    "project-sensitive-command-configs:upsert",
    async (_event, projectId, item) => {
      const normalizedProjectId = requireProjectId(projectId);
      await native.upsertProjectSensitiveCommandConfig(
        normalizedProjectId,
        normalizeProjectSensitiveCommandConfig(item)
      );
      return native.listProjectSensitiveCommandConfigs(normalizedProjectId);
    }
  );
  ipcMain.handle(
    "project-sensitive-command-configs:delete",
    async (_event, projectId, commandId) => {
      const normalizedProjectId = requireProjectId(projectId);
      if (typeof commandId !== "string" || !commandId.trim()) {
        throw new Error("Sensitive command ID is required");
      }

      await native.deleteProjectSensitiveCommandConfig(
        normalizedProjectId,
        commandId.trim()
      );
      return native.listProjectSensitiveCommandConfigs(normalizedProjectId);
    }
  );

  ipcMain.handle(
    "sensitive-command-configs:check-match",
    async (_event, command: unknown, projectId: unknown) => {
      if (typeof command !== "string" || !command.trim()) {
        return [];
      }
      const normalizedProjectId =
        typeof projectId === "string" && projectId.trim()
          ? projectId.trim()
          : undefined;
      return native.checkSensitiveCommandMatch(command, normalizedProjectId);
    }
  );

  // ===== Hook Configs =====
  ipcMain.handle(
    "hook-configs:list",
    (_event, scope: unknown, projectId: unknown) => {
      if (
        typeof scope !== "string" ||
        (scope !== "global" && scope !== "project")
      ) {
        throw new Error("Hook scope must be 'global' or 'project'");
      }
      const normalizedProjectId =
        typeof projectId === "string" && projectId.trim()
          ? projectId.trim()
          : undefined;
      if (scope === "project" && !normalizedProjectId) {
        throw new Error("Project id is required for project scope hooks");
      }
      return native.listHookConfigs(scope, normalizedProjectId);
    }
  );
  ipcMain.handle("hook-configs:upsert", async (_event, item: unknown) => {
    await native.upsertHookConfig(normalizeHookConfig(item));
    return;
  });
  ipcMain.handle(
    "hook-configs:delete",
    async (_event, hookType: unknown, scope: unknown, projectId: unknown) => {
      if (typeof hookType !== "string" || !hookType.trim()) {
        throw new Error("Hook type is required");
      }
      if (
        typeof scope !== "string" ||
        (scope !== "global" && scope !== "project")
      ) {
        throw new Error("Hook scope must be 'global' or 'project'");
      }
      const normalizedProjectId =
        typeof projectId === "string" && projectId.trim()
          ? projectId.trim()
          : undefined;
      if (scope === "project" && !normalizedProjectId) {
        throw new Error("Project id is required for project scope hooks");
      }
      await native.deleteHookConfig(
        hookType.trim(),
        scope,
        normalizedProjectId
      );
      return;
    }
  );

  ipcMain.handle("hooks:execute", async (_event, input: unknown) => {
    if (!input || typeof input !== "object") {
      throw new Error("Hook execute input must be an object");
    }
    const raw = input as Record<string, unknown>;
    const hookType =
      typeof raw.hookType === "string" ? raw.hookType.trim() : "";
    if (!hookType) {
      throw new Error("Hook type is required");
    }
    const projectId =
      typeof raw.projectId === "string" && raw.projectId.trim()
        ? raw.projectId.trim()
        : undefined;
    const contextJson =
      typeof raw.contextJson === "string" ? raw.contextJson : "{}";
    return native.executeHooks({ hookType, projectId, contextJson });
  });
};
