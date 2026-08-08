import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  McpServerConfigInput,
  McpServerConfigRecord,
  NativeBridge,
} from "../native/types";
import { SNOW_CLI_GLOBAL_SETTINGS_FILE } from "../snowCli/paths";
import { readJsonFile } from "../utils/jsonFile";
import { isRecord, toBoolean, toIntegerOrNull, toText } from "../utils/value";

const MCP_SOURCE_SNOW_CLI = "snow-cli";
const MCP_SOURCE_MANUAL = "manual";
const DEFAULT_SCOPE = "global";
const PROJECT_SCOPE = "snow-cli-project";
const DEFAULT_TRANSPORT_TYPE = "stdio";

type McpScope = string;

type SnowCliMcpServer = {
  name: string;
  type: string;
  url: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  enabled: boolean;
  timeoutMs: number | null;
};

type SnowCliMcpConfig = {
  scope: McpScope;
  servers: SnowCliMcpServer[];
  projectId?: string;
};

const deleteServerFromSettingsFile = (
  filePath: string,
  serverName: string
): void => {
  if (!existsSync(filePath)) {
    return;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to read MCP settings file: ${filePath}`, { cause: error });
  }

  if (!isRecord(settings.mcpServers) || !(serverName in settings.mcpServers)) {
    return;
  }

  const nextServers = { ...settings.mcpServers };
  delete nextServers[serverName];
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ ...settings, mcpServers: nextServers }, null, 2)}\n`,
      "utf8"
    );
    renameSync(temporaryPath, filePath);
  } catch (error) {
    throw new Error(`Failed to update MCP settings file: ${filePath}`, { cause: error });
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
};

export const deleteSnowCliMcpServerConfig = (serverName: string): void => {
  deleteServerFromSettingsFile(SNOW_CLI_GLOBAL_SETTINGS_FILE, serverName);
};

export const deleteSnowCliProjectMcpServerConfig = async (
  native: NativeBridge,
  projectId: string,
  serverName: string
): Promise<void> => {
  const directory = (await native.listWorkspaceDirectories()).find(
    (item) => item.directoryId === projectId
  );
  if (!directory) {
    throw new Error(`Project directory not found: ${projectId}`);
  }
  deleteServerFromSettingsFile(
    join(directory.path, ".snow", "settings.json"),
    serverName
  );
};

const toServerId = (scope: string, name: string): string =>
  `${scope.trim() || DEFAULT_SCOPE}:${name.trim()}`;

const normalizeTransportType = (
  value: unknown,
  server: Record<string, unknown>
): string => {
  if (value === "http") {
    return "http";
  }

  if (value === "stdio" || value === "local") {
    return "stdio";
  }

  return toText(server.url).trim() ? "http" : DEFAULT_TRANSPORT_TYPE;
};

const normalizeStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const trimmedKey = key.trim();
    if (trimmedKey && typeof rawValue === "string") {
      result[trimmedKey] = rawValue.trim();
    }
  }

  return result;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

const normalizeServer = (
  name: string,
  rawServer: unknown
): SnowCliMcpServer | null => {
  if (!name.trim() || !isRecord(rawServer)) {
    return null;
  }

  const transportType = normalizeTransportType(rawServer.type, rawServer);
  const env = {
    ...normalizeStringRecord(rawServer.environment),
    ...normalizeStringRecord(rawServer.env),
  };
  const timeoutMs = toIntegerOrNull(rawServer.timeout);

  return {
    name: name.trim(),
    type: transportType,
    url: toText(rawServer.url).trim(),
    command: toText(rawServer.command).trim(),
    args: normalizeStringArray(rawServer.args),
    env,
    headers: normalizeStringRecord(rawServer.headers),
    enabled: toBoolean(rawServer.enabled, true),
    timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs : null,
  };
};

const readConfigByScope = (
  scope: McpScope,
  filePath: string,
  projectId?: string
): SnowCliMcpConfig => {
  if (!existsSync(filePath)) {
    return { scope, servers: [], projectId };
  }

  const settings = readJsonFile(filePath);
  const rawServers = isRecord(settings?.mcpServers) ? settings.mcpServers : {};
  const servers: SnowCliMcpServer[] = [];

  for (const [name, rawServer] of Object.entries(rawServers)) {
    const server = normalizeServer(name, rawServer);
    if (server) {
      servers.push(server);
    }
  }

  return { scope, servers, projectId };
};

const toNativeInput = (
  scope: McpScope,
  server: SnowCliMcpServer,
  sortOrder: number
): McpServerConfigInput => ({
  serverId: toServerId(scope, server.name),
  name: server.name,
  transportType: server.type,
  url: server.url,
  command: server.command,
  argsJson: JSON.stringify(server.args),
  envJson: JSON.stringify(server.env),
  headersJson: JSON.stringify(server.headers),
  enabled: server.enabled,
  ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
  sortOrder,
  source: MCP_SOURCE_SNOW_CLI,
});

const persistMcpConfigs = async (
  native: NativeBridge,
  configs: SnowCliMcpConfig[]
): Promise<void> => {
  const nextIds = new Set<string>();

  for (const config of configs) {
    for (const [index, server] of config.servers.entries()) {
      const input = toNativeInput(config.scope, server, index);
      nextIds.add(input.serverId);
      await native.upsertMcpServerConfig(input);
    }
  }

  const existing = await native.listMcpServerConfigs();
  for (const item of existing) {
    if (item.source === MCP_SOURCE_SNOW_CLI && !nextIds.has(item.serverId)) {
      await native.deleteMcpServerConfig(item.serverId);
    }
  }
};

const persistProjectMcpConfigs = async (
  native: NativeBridge,
  configs: SnowCliMcpConfig[]
): Promise<void> => {
  for (const config of configs) {
    if (!config.projectId) {
      continue;
    }

    const projectId = config.projectId;
    const nextIds = new Set<string>();

    for (const [index, server] of config.servers.entries()) {
      const input: McpServerConfigInput = {
        serverId: toServerId(`${PROJECT_SCOPE}:${projectId}`, server.name),
        name: server.name,
        transportType: server.type,
        url: server.url,
        command: server.command,
        argsJson: JSON.stringify(server.args),
        envJson: JSON.stringify(server.env),
        headersJson: JSON.stringify(server.headers),
        enabled: server.enabled,
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
        sortOrder: index,
        source: MCP_SOURCE_SNOW_CLI,
      };
      nextIds.add(input.serverId);
      await native.upsertProjectMcpServerConfig(projectId, input);
    }

    const existing = await native.listProjectMcpServerConfigs(projectId);
    const scopePrefix = `${PROJECT_SCOPE}:${projectId}:`;
    for (const item of existing) {
      if (
        item.serverId.startsWith(scopePrefix) &&
        !nextIds.has(item.serverId)
      ) {
        await native.deleteProjectMcpServerConfig(projectId, item.serverId);
      }
    }
  }
};

export const readSnowCliMcpConfig = async (
  native: NativeBridge
): Promise<McpServerConfigRecord[]> => {
  const configs = [readConfigByScope("global", SNOW_CLI_GLOBAL_SETTINGS_FILE)];

  const directories = await native.listWorkspaceDirectories();
  const projectConfigs: SnowCliMcpConfig[] = [];
  for (const directory of directories) {
    const projectFilePath = join(directory.path, ".snow", "settings.json");
    const projectConfig = readConfigByScope(
      PROJECT_SCOPE,
      projectFilePath,
      directory.directoryId
    );
    if (projectConfig.servers.length > 0) {
      projectConfigs.push(projectConfig);
    }
  }

  await persistMcpConfigs(native, configs);
  await persistProjectMcpConfigs(native, projectConfigs);

  return native.listMcpServerConfigs();
};

const assertJsonArray = (value: string, fieldName: string): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error(`${fieldName} must be a JSON string array`);
  }
};

const assertJsonObject = (value: string, fieldName: string): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }

  for (const [key, item] of Object.entries(parsed)) {
    if (!key.trim()) {
      throw new Error(`${fieldName} key is required`);
    }
    if (typeof item !== "string") {
      throw new Error(`${fieldName} values must be strings`);
    }
  }
};

export const normalizeMcpServerConfig = (
  value: unknown
): McpServerConfigInput => {
  const source = isRecord(value) ? value : {};
  const name = toText(source.name).trim();
  const transportType = normalizeTransportType(source.transportType, source);
  const argsJson = toText(source.argsJson, "[]");
  const envJson = toText(source.envJson, "{}");
  const headersJson = toText(source.headersJson, "{}");
  const timeoutMs = toIntegerOrNull(source.timeoutMs);
  const rawSortOrder = Number(source.sortOrder ?? 0);

  if (!name) {
    throw new Error("MCP server name is required");
  }

  assertJsonArray(argsJson, "Args");
  assertJsonObject(envJson, "Environment");
  assertJsonObject(headersJson, "Headers");

  const url = toText(source.url).trim();
  const command = toText(source.command).trim();
  if (transportType === "http" && !url) {
    throw new Error("HTTP MCP server URL is required");
  }
  if (transportType === "stdio" && !command) {
    throw new Error("Stdio MCP server command is required");
  }

  return {
    serverId: toText(source.serverId).trim() || toServerId(DEFAULT_SCOPE, name),
    name,
    transportType,
    url,
    command,
    argsJson,
    envJson,
    headersJson,
    enabled: source.enabled !== false,
    ...(timeoutMs && timeoutMs > 0 ? { timeoutMs } : {}),
    sortOrder: Number.isInteger(rawSortOrder) ? rawSortOrder : 0,
    source: toText(source.source).trim() || MCP_SOURCE_MANUAL,
  };
};

export const normalizeProjectMcpServerConfig = (
  value: unknown
): McpServerConfigInput => {
  const normalized = normalizeMcpServerConfig(value);
  const source = isRecord(value) ? value : {};
  return {
    ...normalized,
    serverId: toText(source.serverId).trim(),
    source: "project",
  };
};
