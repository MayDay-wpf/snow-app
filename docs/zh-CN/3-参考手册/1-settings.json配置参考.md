# 1-settings.json配置参考

`~/.snow/settings.json` 是 Snow App 与 Snow CLI 共享的全局配置文件，
包含 MCP 服务器、代码库索引、敏感命令与模式开关等设置。

## 1. 文件位置

| 平台          | 路径                                    |
| ------------- | --------------------------------------- |
| Windows       | `C:\Users\<用户名>\.snow\settings.json` |
| macOS / Linux | `~/.snow/settings.json`                 |

该文件与 Snow CLI 共享。修改后部分设置（如 `mcpServers`）需在
**设置 → MCP 设置 → 同步 Snow CLI MCP 设置** 手动导入。

## 2. 顶层字段一览

| 字段                       | 类型    | 说明                                                                                  |
| -------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `codebase`                 | object  | 代码库语义搜索配置                                                                    |
| `mcpServers`               | object  | 全局 MCP 服务器配置，键为服务器名                                                     |
| `sensitiveCommands`        | array   | 敏感命令拦截规则                                                                      |
| `yoloMode`                 | boolean | 无确认模式                                                                            |
| `vulnerabilityHuntingMode` | boolean | 漏洞狩猎模式                                                                          |
| `toolSearchEnabled`        | boolean | 旧版共享字段；Snow App 的插件工具搜索不再读取此开关，随项目有效启用的工具插件自动生效 |
| `hybridCompressEnabled`    | boolean | 混合压缩开关                                                                          |
| `teamMode`                 | boolean | 团队模式                                                                              |
| `goal`                     | object  | Goal 模式配置                                                                         |
| `ultraTodoEnabled`         | boolean | 超长 TODO 列表开关                                                                    |

## 3. mcpServers 字段

键为服务器名，值为服务器配置对象：

| 字段          | 类型    | 说明                                     |
| ------------- | ------- | ---------------------------------------- |
| `type`        | string  | `stdio`（本地命令）或 `http`（远程服务） |
| `command`     | string  | stdio 模式的可执行文件路径               |
| `args`        | array   | 传给命令的参数                           |
| `env`         | object  | 环境变量键值对                           |
| `headers`     | object  | 请求头键值对（http）                     |
| `enabled`     | boolean | 是否启用                                 |
| `timeoutMs`   | number  | 超时时间（毫秒）                         |
| `alwaysAllow` | array   | 免确认的工具名列表                       |

> **工具级启停不在 settings.json**：MCP 工具级启停（全局/项目）由 MCP 设置面板管理（应用数据库），不写入 settings.json；settings.json 的 `mcpServers` 仅承载服务器级配置。

### stdio 示例

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

### http 示例

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

更多配置方法见 [2-使用指南/1-配置MCP服务器](../2-使用指南/1-配置MCP服务器.md)。

## 4. codebase 字段

| 字段                | 类型    | 说明               |
| ------------------- | ------- | ------------------ |
| `enabled`           | boolean | 是否启用代码库索引 |
| `enableAgentReview` | boolean | Agent 审查开关     |
| `enableReranking`   | boolean | 是否启用重排序     |
| `embedding`         | object  | 嵌入模型配置       |
| `reranking`         | object  | 重排序模型配置     |
| `batch`             | object  | 批量处理配置       |
| `chunking`          | object  | 分块配置           |

**embedding**（嵌入模型）：

| 字段         | 类型   | 说明                                                                         |
| ------------ | ------ | ---------------------------------------------------------------------------- |
| `type`       | string | 嵌入服务类型，如 `jina`                                                      |
| `modelName`  | string | 模型名                                                                       |
| `baseUrl`    | string | 服务端点地址                                                                 |
| `apiKey`     | string | API 密钥                                                                     |
| `dimensions` | number | 向量维度；`0` 或省略表示不传递 `dimensions` 参数（部分嵌入模型不支持该参数） |

**reranking**（重排序模型）：

| 字段            | 类型   | 说明         |
| --------------- | ------ | ------------ |
| `modelName`     | string | 模型名       |
| `baseUrl`       | string | 服务端点地址 |
| `apiKey`        | string | API 密钥     |
| `contextLength` | number | 上下文长度   |
| `topN`          | number | 返回前 N 条  |

**batch**（批量处理）：

| 字段          | 类型   | 说明         |
| ------------- | ------ | ------------ |
| `maxLines`    | number | 每批最大行数 |
| `concurrency` | number | 并发数       |

**chunking**（分块）：

| 字段               | 类型   | 说明           |
| ------------------ | ------ | -------------- |
| `maxLinesPerChunk` | number | 每块最大行数   |
| `minLinesPerChunk` | number | 每块最小行数   |
| `minCharsPerChunk` | number | 每块最小字符数 |
| `overlapLines`     | number | 块间重叠行数   |

## 5. sensitiveCommands 字段

数组元素用于敏感命令拦截（图形界面：**设置 → 敏感命令**）：

| 字段          | 类型    | 说明               |
| ------------- | ------- | ------------------ |
| `id`          | string  | 规则唯一标识       |
| `pattern`     | string  | 匹配模式           |
| `description` | string  | 规则描述           |
| `enabled`     | boolean | 是否启用           |
| `isPreset`    | boolean | 是否为内置预设规则 |

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

## 6. 模式开关字段

| 字段                       | 类型    | 说明                                            |
| -------------------------- | ------- | ----------------------------------------------- |
| `yoloMode`                 | boolean | 无确认模式，跳过危险操作确认                    |
| `vulnerabilityHuntingMode` | boolean | 漏洞狩猎模式                                    |
| `toolSearchEnabled`        | boolean | 旧版共享字段；Snow App 不再以此控制插件工具搜索 |
| `hybridCompressEnabled`    | boolean | 混合压缩开关                                    |
| `teamMode`                 | boolean | 团队模式                                        |
| `ultraTodoEnabled`         | boolean | 超长 TODO 列表开关                              |
| `goal.defaultTokenBudgetM` | number  | Goal 模式默认 token 预算，单位：百万            |

## 7. 兄弟配置文件一览

以下文件同样位于 `~/.snow/` 目录下：

| 文件                        | 说明                                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`               | API 密钥与模型配置（`snowcfg` 字段，为**当前生效档案**的 CLI 兼容镜像；多档案权威存储在应用数据库 `api_configs` 表）                                                                                                                      |
| `active-profile.json`       | 当前生效的 API 档案名（`activeProfile` 字段，CLI 兼容层；运行时以应用数据库 `api_configs.is_active` 为准）                                                                                                                                |
| 应用数据库 `api_configs` 表 | **多档案的权威存储**（`~/.snowapp/snowapp.db`，每行一个档案，`profile_name` 唯一）；agent 可用 `config-manage action=set scope=apiProfiles ...` 读写（见 [2-使用指南/3-配置API密钥与模型](../2-使用指南/3-配置API密钥与模型.md) 第 5 节） |
| `proxy-config.json`         | 代理与浏览器配置                                                                                                                                                                                                                          |
| `custom-headers.json`       | 自定义请求头方案                                                                                                                                                                                                                          |
| `system-prompt.json`        | 系统提示词                                                                                                                                                                                                                                |
| `theme.json`                | 主题配置                                                                                                                                                                                                                                  |
| `language.json`             | 界面语言                                                                                                                                                                                                                                  |
| `permissions.json`          | 权限配置                                                                                                                                                                                                                                  |
| `lsp-config.json`           | LSP 配置                                                                                                                                                                                                                                  |

## 8. Windows 路径注意

JSON 中的反斜杠必须写成 `\\`，否则 `\f`、`\n`、`\v` 会被当作转义序列，
导致命令解析错误、服务器启动失败。例如：

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

## 9. 完整示例

以下是一个包含 `mcpServers`、`codebase`、`sensitiveCommands` 与模式开关的
合并示例：

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

> **注意**：示例中的 `apiKey` 为占位符，请替换为你自己的密钥。
