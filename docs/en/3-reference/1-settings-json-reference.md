# 1-settings-json-reference

`~/.snow/settings.json` is the global configuration file shared by Snow App and Snow CLI, containing settings such as MCP servers, codebase indexing, sensitive commands, and mode switches.

## 1. File Location

| Platform      | Path                                      |
| ------------- | ----------------------------------------- |
| Windows       | `C:\Users\<username>\.snow\settings.json` |
| macOS / Linux | `~/.snow/settings.json`                   |

The file is shared with Snow CLI. After modifying it, some settings (such as `mcpServers`) must be imported manually via **Settings → MCP Settings → Sync Snow CLI MCP Settings**.

## 2. Top-Level Fields Overview

| Field                      | Type    | Description                                                                                                               |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `codebase`                 | object  | Codebase semantic search configuration                                                                                    |
| `mcpServers`               | object  | Global MCP server configuration, keyed by server name                                                                     |
| `sensitiveCommands`        | array   | Sensitive command interception rules                                                                                      |
| `yoloMode`                 | boolean | No-confirmation mode                                                                                                      |
| `vulnerabilityHuntingMode` | boolean | Vulnerability hunting mode                                                                                                |
| `toolSearchEnabled`        | boolean | Legacy shared field; Snow App no longer reads this switch. Plugin tool search follows the project's enabled tool plugins. |
| `hybridCompressEnabled`    | boolean | Hybrid compression toggle                                                                                                 |
| `teamMode`                 | boolean | Team mode                                                                                                                 |
| `goal`                     | object  | Goal mode configuration                                                                                                   |
| `ultraTodoEnabled`         | boolean | Ultra-long TODO list toggle                                                                                               |

## 3. mcpServers Field

Keys are server names, and values are server configuration objects:

| Field         | Type    | Description                                        |
| ------------- | ------- | -------------------------------------------------- |
| `type`        | string  | `stdio` (local command) or `http` (remote service) |
| `command`     | string  | Executable path in stdio mode                      |
| `args`        | array   | Arguments passed to the command                    |
| `env`         | object  | Environment variable key-value pairs               |
| `headers`     | object  | Request header key-value pairs (http)              |
| `enabled`     | boolean | Whether enabled                                    |
| `timeoutMs`   | number  | Timeout in milliseconds                            |
| `alwaysAllow` | array   | List of tool names exempt from confirmation        |

> **Tool-level toggles are not stored in settings.json**: MCP tool-level enable/disable (global/project) is managed in the MCP Settings panel (app database) and is not written to settings.json; the `mcpServers` field in settings.json carries server-level configuration only.

### stdio Example

```json
{
  "mcpServers": {
    "dbx": {
      "type": "stdio",
      "command": "D:\\fnm\\node-versions\\v24.15.0\\installation\\node.exe",
      "args": [
        "D:\\fnm\\node-versions\\v24.15.0\\installation\\node_modules\\@dbx-app\\mcp-server\\bin\\dbx-mcp-server.js"
      ],
      "env": {},
      "enabled": true
    }
  }
}
```

### http Example

```json
{
  "mcpServers": {
    "my-http-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer token" },
      "enabled": true
    }
  }
}
```

For more configuration methods, see [2-guides/1-configure-mcp](../2-guides/1-configure-mcp.md).

## 4. codebase Field

| Field               | Type    | Description                          |
| ------------------- | ------- | ------------------------------------ |
| `enabled`           | boolean | Whether codebase indexing is enabled |
| `enableAgentReview` | boolean | Agent review toggle                  |
| `enableReranking`   | boolean | Whether reranking is enabled         |
| `embedding`         | object  | Embedding model configuration        |
| `reranking`         | object  | Reranking model configuration        |
| `batch`             | object  | Batch processing configuration       |
| `chunking`          | object  | Chunking configuration               |

**embedding** (embedding model):

| Field        | Type   | Description                                                                                                              |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `type`       | string | Embedding service type, e.g. `jina`                                                                                      |
| `modelName`  | string | Model name                                                                                                               |
| `baseUrl`    | string | Service endpoint URL                                                                                                     |
| `apiKey`     | string | API key                                                                                                                  |
| `dimensions` | number | Vector dimensions; `0` or omitted means the `dimensions` parameter is not sent (some embedding models do not support it) |

**reranking** (reranking model):

| Field           | Type   | Description          |
| --------------- | ------ | -------------------- |
| `modelName`     | string | Model name           |
| `baseUrl`       | string | Service endpoint URL |
| `apiKey`        | string | API key              |
| `contextLength` | number | Context length       |
| `topN`          | number | Return top N results |

**batch** (batch processing):

| Field         | Type   | Description         |
| ------------- | ------ | ------------------- |
| `maxLines`    | number | Max lines per batch |
| `concurrency` | number | Concurrency         |

**chunking** (chunking):

| Field              | Type   | Description                      |
| ------------------ | ------ | -------------------------------- |
| `maxLinesPerChunk` | number | Max lines per chunk              |
| `minLinesPerChunk` | number | Min lines per chunk              |
| `minCharsPerChunk` | number | Min chars per chunk              |
| `overlapLines`     | number | Overlapping lines between chunks |

## 5. sensitiveCommands Field

Array elements are used for sensitive command interception (GUI: **Settings → Sensitive Commands**):

| Field         | Type    | Description                          |
| ------------- | ------- | ------------------------------------ |
| `id`          | string  | Unique rule identifier               |
| `pattern`     | string  | Matching pattern                     |
| `description` | string  | Rule description                     |
| `enabled`     | boolean | Whether enabled                      |
| `isPreset`    | boolean | Whether it is a built-in preset rule |

```json
{
  "sensitiveCommands": [
    {
      "id": "rm",
      "pattern": "*rm*",
      "description": "Delete files or directories (rm, rm -rf, etc.)",
      "enabled": false,
      "isPreset": true
    }
  ]
}
```

## 6. Mode Switch Fields

| Field                      | Type    | Description                                                                    |
| -------------------------- | ------- | ------------------------------------------------------------------------------ |
| `yoloMode`                 | boolean | No-confirmation mode, skips dangerous operation confirmations                  |
| `vulnerabilityHuntingMode` | boolean | Vulnerability hunting mode                                                     |
| `toolSearchEnabled`        | boolean | Legacy shared field; Snow App no longer uses it to control plugin tool search. |
| `hybridCompressEnabled`    | boolean | Hybrid compression toggle                                                      |
| `teamMode`                 | boolean | Team mode                                                                      |
| `ultraTodoEnabled`         | boolean | Ultra-long TODO list toggle                                                    |
| `goal.defaultTokenBudgetM` | number  | Default token budget for Goal mode, in millions                                |

## 7. Companion Configuration Files

The following files are also located in the `~/.snow/` directory:

| File                             | Description                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                    | API key and model configuration (`snowcfg` field; a CLI-compatible mirror of the **currently active profile** — the authoritative store for all profiles is the `api_configs` table in the app database)                                                                              |
| `active-profile.json`            | Currently active API profile name (`activeProfile` field; CLI compatibility layer — at runtime the app database's `api_configs.is_active` is authoritative)                                                                                                                           |
| App database `api_configs` table | **Authoritative store for API profiles** (`~/.snowapp/snowapp.db`, one row per profile, `profile_name` unique); agents can read/write it via `config-manage` (`action=set`, scope `apiProfiles`) (see [2-guides/3-configure-api-keys](../2-guides/3-configure-api-keys.md) section 5) |
| `proxy-config.json`              | Proxy and browser configuration                                                                                                                                                                                                                                                       |
| `custom-headers.json`            | Custom request header schemes                                                                                                                                                                                                                                                         |
| `system-prompt.json`             | System prompts                                                                                                                                                                                                                                                                        |
| `theme.json`                     | Theme configuration                                                                                                                                                                                                                                                                   |
| `language.json`                  | UI language                                                                                                                                                                                                                                                                           |
| `permissions.json`               | Permission configuration                                                                                                                                                                                                                                                              |
| `lsp-config.json`                | LSP configuration                                                                                                                                                                                                                                                                     |

## 8. Windows Path Notes

Backslashes in JSON must be written as `\\`, otherwise `\f`, `\n`, `\v` are treated as escape sequences, causing command parse errors and server startup failures. For example:

```json
{
  "mcpServers": {
    "dbx": {
      "type": "stdio",
      "command": "D:\\fnm\\node-versions\\v24.15.0\\installation\\node.exe"
    }
  }
}
```

## 9. Complete Example

The following is a combined example containing `mcpServers`, `codebase`, `sensitiveCommands`, and mode switches:

```json
{
  "mcpServers": {
    "dbx": {
      "type": "stdio",
      "command": "D:\\fnm\\node-versions\\v24.15.0\\installation\\node.exe",
      "args": [
        "D:\\fnm\\node-versions\\v24.15.0\\installation\\node_modules\\@dbx-app\\mcp-server\\bin\\dbx-mcp-server.js"
      ],
      "env": {},
      "enabled": true
    },
    "my-http-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer token" },
      "enabled": true
    }
  },
  "codebase": {
    "enabled": true,
    "enableAgentReview": true,
    "enableReranking": false,
    "embedding": {
      "type": "jina",
      "modelName": "Qwen/Qwen3-Embedding-8B",
      "baseUrl": "https://api.snowcli.com/embeddings/v1",
      "apiKey": "sk-...",
      "dimensions": 4096
    },
    "reranking": {
      "modelName": "",
      "baseUrl": "",
      "apiKey": "",
      "contextLength": 4096,
      "topN": 5
    },
    "batch": {
      "maxLines": 10,
      "concurrency": 3
    },
    "chunking": {
      "maxLinesPerChunk": 200,
      "minLinesPerChunk": 10,
      "minCharsPerChunk": 20,
      "overlapLines": 20
    }
  },
  "sensitiveCommands": [
    {
      "id": "rm",
      "pattern": "*rm*",
      "description": "Delete files or directories (rm, rm -rf, etc.)",
      "enabled": false,
      "isPreset": true
    },
    {
      "id": "git-force-push",
      "pattern": "*git push*--force*",
      "description": "Force push to remote repository (destructive)",
      "enabled": false,
      "isPreset": true
    }
  ],
  "yoloMode": false,
  "vulnerabilityHuntingMode": false,
  "toolSearchEnabled": false,
  "hybridCompressEnabled": false,
  "teamMode": false,
  "goal": {
    "defaultTokenBudgetM": 2
  },
  "ultraTodoEnabled": false
}
```

> **Note**: the `apiKey` values in the example are placeholders; replace them with your own keys.
