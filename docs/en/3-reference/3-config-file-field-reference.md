# 3-Config File Field Reference

This reference lists the field structure of every config file under
`~/.snow/`, for manual editing or for checking values written via the
`config` tools. The `config` tool whitelist matches this document:
file-backed settings generally **require an app restart or a UI re-save**
to take effect (`settings.mcpServers` is the exception — it syncs to the
app database automatically and takes effect immediately).

> Scope names for reading/writing each file with `config-get`/`config-set`
> are listed in [2-builtin-tools-reference](./2-builtin-tools-reference.md)
> under "File-backed scopes".

## 1. settings.json (scope: `settings`)

Global config shared with Snow CLI. Top-level fields are detailed in
[1-settings-json-reference](./1-settings-json-reference.md):

| Field | Type | Description |
| --- | --- | --- |
| `mcpServers` | object | Global MCP servers, keyed by server name |
| `codebase` | object | Codebase semantic-search config |
| `sensitiveCommands` | array | Sensitive-command interception rules |
| `yoloMode` | boolean | No-confirmation mode |
| `planMode` | boolean | Plan mode |
| `vulnerabilityHuntingMode` | boolean | Vulnerability-hunting mode |
| `toolSearchEnabled` | boolean | Tool search toggle |
| `hybridCompressEnabled` | boolean | Hybrid compression toggle |
| `teamMode` | boolean | Team mode |
| `goal` | object | Goal mode config (`defaultTokenBudgetM`: default token budget in millions) |
| `ultraTodoEnabled` | boolean | Ultra-long TODO list toggle |

## 2. config.json (scope: `snowcfg`)

API key and model config, stored under the `snowcfg` object (shared with
Snow CLI).

| Field | Type | Sensitive | Description |
| --- | --- | --- | --- |
| `baseUrl` | string | | Main service endpoint |
| `baseUrlMode` | string | | `auto` / `custom` |
| `apiKey` | string | 🔒 | Main provider key |
| `requestMethod` | string | | Request method, e.g. `chat` |
| `advancedModel` | string | | Profile's default advanced model; ordinary conversations still use their selected model |
| `basicModel` | string | | Model for conversation titles, AI Commit, `@?` file search, and codebase Agent Review |
| `supportsVision` | boolean | | Whether the main model supports vision |
| `visionBaseUrl` | string | | Vision service endpoint |
| `visionBaseUrlMode` | string | | Vision endpoint mode |
| `visionApiKey` | string | 🔒 | Vision service key |
| `visionRequestMethod` | string | | Vision request method |
| `visionModel` | string | | Vision model name |
| `maxContextTokens` | integer | | Max context tokens |
| `maxTokens` | integer | | Max generation tokens per call |
| `showThinking` | boolean | | Show thinking process |
| `streamIdleTimeoutSec` | integer | | Streaming idle timeout (seconds) |
| `maxRetries` | integer | | Max request retries |
| `retryDelayMs` | integer | | Retry delay (ms) |
| `enableAutoCompress` | boolean | | Auto-compress toggle |
| `autoCompressThreshold` | integer | | Auto-compress threshold (percent) |
| `toolResultTokenLimit` | integer | | Token limit for tool results in context |
| `anthropicBeta` | boolean | | Anthropic Beta header toggle |
| `streamingDisplay` | boolean | | Streaming display toggle |
| `systemPromptId` | string | | Active system prompt id |
| `customHeadersSchemeId` | string | | Active custom-header scheme id |
| `anthropicCacheTTL` | string | | Anthropic cache TTL, e.g. `5m` |
| `responsesReasoning` | object | | Responses reasoning config (`{enabled, effort}`) |
| `responsesVerbosity` | string | | Responses verbosity, e.g. `medium` |
| `responsesFastMode` | boolean | | Responses fast mode |
| `chatThinking` | object | | Thinking-strength config (`{enabled, reasoning_effort}`) |

> **Model routing and profile completeness**: Snow App does not switch between
> `basicModel` and `advancedModel` based on prompt complexity. An ordinary
> conversation uses its selected model; `advancedModel` is only the bound profile's
> default advanced model. `basicModel` serves conversation titles, AI Commit, `@?`
> file search, and codebase Agent Review, and the two model classes never fall back
> to each other. Titles use the conversation-bound profile; if it is deleted,
> ordinary-conversation rules fall back to the active profile. An active profile
> requires both `advancedModel` and `basicModel` to be non-empty after trim; an
> inactive draft may leave them empty, and API-key presence is not part of this
> model-completeness check. Vision understanding, image generation, and embedding
> use independent configuration and channels.

## 3. proxy-config.json (scope: `proxy`)

Proxy and browser config.

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | boolean | Proxy toggle |
| `host` | string | Proxy host, e.g. `127.0.0.1` |
| `port` | integer | Proxy port, e.g. `7890` |
| `searchEngine` | string | Search engine, e.g. `bing` / `duckduckgo` |
| `browserPath` | string | Browser executable path |
| `browserDebugPort` | integer | Browser debug port |

## 4. active-profile.json (scope: `app`)

The active API profile.

| Field | Type | Description |
| --- | --- | --- |
| `activeProfile` | string | The active profile name |

## 5. custom-headers.json (scope: `custom-headers`)

Custom request-header schemes (🔒 masked on read).

| Field | Type | Sensitive | Description |
| --- | --- | --- | --- |
| `active` | string | | Active scheme id |
| `schemes` | array | 🔒 | Scheme array, items: `{id, name, headers, createdAt}`; `headers` is a `{header: value}` map (may contain sensitive headers such as `Authorization`) |

## 6. system-prompt.json (scope: `system-prompt`)

System-prompt library (🔒 masked on read).

| Field | Type | Sensitive | Description |
| --- | --- | --- | --- |
| `active` | array | | List of active prompt ids |
| `prompts` | array | 🔒 | Prompt array, items: `{id, name, content, createdAt}` |

## 7. theme.json (scope: `theme`)

UI theme config.

| Field | Type | Description |
| --- | --- | --- |
| `theme` | string | Theme name, e.g. `custom` |
| `simpleMode` | boolean | Simple mode |
| `diffOpacity` | number | Diff-view opacity (float, e.g. `0.62`) |
| `toolDisplayMode` | string | Tool-call display mode, e.g. `full` |
| `thinkDisplayMode` | string | Thinking display mode |
| `subAgentDisplayMode` | string | Sub-agent display mode, e.g. `slots` |
| `toolIcons` | object | Tool icon mapping (`{toolName: iconChar}`) |
| `customColors` | object | Custom color scheme |

## 8. language.json (scope: `language`)

UI language.

| Field | Type | Description |
| --- | --- | --- |
| `language` | string | Language code; supports `en` / `zh-CN` / `zh-TW`. Older installs may store the legacy value `zh` (equivalent to Simplified Chinese) |

## 9. permissions.json (scope: `permissions`)

Tool authorization config.

| Field | Type | Description |
| --- | --- | --- |
| `alwaysApprovedTools` | array | Always-approved tool names (e.g. `["terminal-execute", "filesystem-read"]`) |

## 10. lsp-config.json (scope: `lsp-config`)

LSP (Language Server Protocol) server configuration: declares the external
language servers Snow App can launch per language, with their launch
arguments.

> **Current status: reserved config scope.** The `config` tools can fully
> read/write and validate this file, but the app does not yet wire up an LSP
> client runtime, so writing it **does not change any current behavior**.
> Symbol location is provided by the built-in `codelens` static analysis,
> which does not depend on this file (see
> [2-guides/7-codebase-index-and-diagnostics](../2-guides/7-codebase-index-and-diagnostics.md)).

| Field | Type | Description |
| --- | --- | --- |
| `schemaVersion` | integer | Schema version |
| `servers` | object | Language-server map, keyed by language (e.g. `typescript`); value structure below |

`servers.<language>` value structure (deeply validated on write per the rules
below; unknown fields are allowed for forward compatibility):

| Field | Type | Description |
| --- | --- | --- |
| `command` | string | Executable that launches the language server (e.g. `typescript-language-server`) |
| `args` | array\<string\> | Launch arguments (e.g. `["--stdio"]`) |
| `fileExtensions` | array\<string\> | File extensions this server handles (e.g. `[".ts", ".tsx"]`) |
| `installCommand` | string | Install command used when the server is missing (e.g. `npm install -g typescript-language-server`) |
| `initializationOptions` | object | Initialization options sent with the LSP `initialize` request |

Example:

```json
{
  "schemaVersion": 1,
  "servers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "fileExtensions": [".ts", ".tsx", ".js", ".jsx"],
      "installCommand": "npm install -g typescript-language-server typescript",
      "initializationOptions": {}
    }
  }
}
```

Read/write via the `config` tools (key-level replace, deep validation before
write, automatic backup and atomic write):

```text
config-get  scope="lsp-config" key="servers"              # read current config
config-list scope="lsp-config"                             # list keys and current values
config-set  scope="lsp-config" key="servers" value={...}   # write (field types validated)
config-delete scope="lsp-config" key="servers"             # delete (requires confirmation)
```

> As with other file-backed scopes, changes may need an app restart or a UI
> re-save to take effect (see the note at the top of this document);
> `lsp-config` is not project-scoped (no `projectId` semantics).

## 11. buddy.json (scope: `buddy`)

App companion (mascot) config.

| Field | Type | Description |
| --- | --- | --- |
| `version` | integer | Schema version |
| `companion` | object | Companion appearance/personality config (`{rarity, species, name, personality, stats, ...}`) |
| `muted` | boolean | Whether muted |
