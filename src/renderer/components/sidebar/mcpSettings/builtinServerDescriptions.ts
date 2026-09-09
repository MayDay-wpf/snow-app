/**
 * 内置 MCP 服务说明映射：内置服务固定不变，说明文案硬编码在各语言文件。
 * 键为项目 scope 中的服务 id（Rust 侧 builtin_scope_server_id 生成）。
 */
const BUILTIN_SERVER_DESCRIPTION_KEYS: Record<string, string> = {
  "builtin:filesystem": "mcpBuiltinServer.desc.filesystem",
  "builtin:bash": "mcpBuiltinServer.desc.bash",
  "builtin:todo": "mcpBuiltinServer.desc.todo",
  "builtin:grep": "mcpBuiltinServer.desc.grep",
  "builtin:websearch": "mcpBuiltinServer.desc.websearch",
  "builtin:browser": "mcpBuiltinServer.desc.browser",
  "builtin:user-interaction": "mcpBuiltinServer.desc.userInteraction",
  "builtin:sub-agents": "mcpBuiltinServer.desc.subAgents",
  "builtin:codebase": "mcpBuiltinServer.desc.codebase",
  "builtin:codelens": "mcpBuiltinServer.desc.codelens",
  "builtin:app-control": "mcpBuiltinServer.desc.appControl",
  "builtin:config": "mcpBuiltinServer.desc.config",
  "builtin:terminal": "mcpBuiltinServer.desc.terminal",
  "builtin:imagegen": "mcpBuiltinServer.desc.imagegen",
  "builtin:lsp": "mcpBuiltinServer.desc.lsp",
  "builtin:workflow": "mcpBuiltinServer.desc.workflow",
  "builtin:memory": "mcpBuiltinServer.desc.memory",
  "builtin:computer-use": "mcpBuiltinServer.desc.computerUse",
};

/** 返回内置服务的 i18n 说明 key；非内置服务返回 undefined。 */
export const builtinServerDescriptionKey = (
  serverId: string,
): string | undefined => BUILTIN_SERVER_DESCRIPTION_KEYS[serverId];
