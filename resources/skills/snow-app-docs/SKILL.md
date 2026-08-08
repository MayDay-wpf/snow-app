---
name: snow-app-docs
description: >-
  Guides the agent to read the built-in Snow App documentation
  (~/.snow/docs) before configuring or troubleshooting Snow App. Covers MCP
  servers; installing, managing, creating, and authoring Skills; sub-agents;
  Hooks; API keys/models; image generation; proxy/network; third-party config
  and Plugin runtimes; browser passwords and local-browser data import; app
  updates; security/privacy/tool authorization; personalization, system prompts,
  custom headers, themes, and shortcuts; usage/log diagnostics; project-scoped
  settings; settings.json fields; storage locations; and built-in tools. Use
  this Skill whenever the user asks to configure, inspect, create, author, or
  troubleshoot any of these areas. It covers the config built-in service
  (config-list/get/set/delete; scopes: settings/snowcfg/proxy/app/
  custom-headers/system-prompt/theme/language/permissions/lsp-config/buddy/
  subAgents/hooks/skills/logs/imagegen/personalization), including project-
  scoped mcpServers/sensitiveCommands/subAgents/hooks/skills via `projectId`,
  the read-only logs scope, imagegen multi-channel settings and top-level
  maxConcurrentImages, masked secrets, and app-control-openSettings.
enable: true
allowed-tools:
  - config-list
  - config-get
  - config-set
  - config-delete
  - user-interaction-askUserQuestion
  - app-control-openSettings
  - bash-terminal-execute
  - filesystem-read
  - filesystem-replace_edit
  - filesystem-create
  - websearch-websearch-search
  - websearch-websearch-fetch
---

# Snow App 文档阅读与配置指导（Docs & Configuration Guide）

当用户请求**配置 MCP 服务器、安装与管理 Skills、创建与编写 Skills、配置 Hooks
与子代理、配置 API 密钥与模型、配置图像生成、配置代理与网络、导入第三方配置
与插件、管理浏览器密码/数据、处理应用更新、个性化与自定义请求头、用量/日志诊断、
项目级设置**，或询问 **settings.json 字段 / 内置工具 / 安全边界 / 数据位置**时，
先阅读应用内置文档，再按文档步骤动手配置，而不是凭记忆操作。

## 1. 先读文档（Read the docs first）

文档随应用安装到 `~/.snow/docs/`（Windows 为 `C:\Users\<用户名>\.snow\docs\`）。
根据用户界面语言选择分支：

- 中文界面 → 读 `~/.snow/docs/zh-CN/`
- English UI → read `~/.snow/docs/en/`

按任务定位文档（路径相对所选语言分支）：

| 任务 | 使用指南（How-to） | 参考手册（Reference） |
| --- | --- | --- |
| 配置 MCP 服务器 | `2-使用指南/1-配置MCP服务器.md`（en: `2-guides/1-configure-mcp.md`） | `3-参考手册/1-settings.json配置参考.md` |
| 安装与管理 Skills | `2-使用指南/2-安装与管理Skills.md`（en: `2-guides/2-install-and-manage-skills.md`） | — |
| 创建与编写 Skills | `2-使用指南/21-创建与编写Skills.md`（en: `2-guides/21-create-and-author-skills.md`） | — |
| 配置 API 密钥与模型 | `2-使用指南/3-配置API密钥与模型.md`（en: `2-guides/3-configure-api-keys.md`） | `3-参考手册/1-settings.json配置参考.md` |
| 配置图像生成 | `2-使用指南/9-图像生成.md`（en: `2-guides/9-image-generation.md`） | `3-参考手册/2-内置工具参考.md`（imagegen 章节与 config 的 imagegen scope） |
| 使用聊天与 AI 助手（界面/对话/命令/回滚/压缩） | `2-使用指南/10-使用聊天与AI助手.md`（en: `2-guides/10-using-chat-and-ai.md`） | — |
| 终端与 SSH 远程管理 | `2-使用指南/11-终端与SSH远程管理.md`（en: `2-guides/11-terminal-and-ssh.md`） | — |
| Git 面板与代码浏览 | `2-使用指南/12-Git面板与代码浏览.md`（en: `2-guides/12-git-and-code-browsing.md`） | — |
| 配置代理与网络 | `2-使用指南/4-配置代理与网络.md`（en: `2-guides/4-configure-proxy.md`） | — |
| 配置 Hooks 与子代理 | `2-使用指南/5-配置Hooks与子代理.md`（en: `2-guides/5-configure-hooks-and-subagents.md`） | — |
| 浏览器自动化 | `2-使用指南/6-浏览器自动化.md`（en: `2-guides/6-browser-automation.md`） | — |
| 代码库索引与代码诊断 | `2-使用指南/7-代码库索引与代码诊断.md`（en: `2-guides/7-codebase-index-and-diagnostics.md`） | — |
| 第三方配置导入与插件 runtime | `2-使用指南/8-第三方配置导入.md`（en: `2-guides/8-third-party-configuration-import.md`） | `3-参考手册/5-安全与信任边界.md` |
| AI 开发协作、经验与前端美化工作流 | `2-使用指南/13-AI开发协作.md`、`2-使用指南/14-AI开发经验与教训.md`、`2-使用指南/15-前端设计与美化工作流.md`（en: `2-guides/13-ai-development-collaboration.md`、`2-guides/14-ai-development-lessons.md`、`2-guides/15-frontend-design-and-beautification-workflow.md`） | `4-架构与开发/2-开发者指南.md` |
| 安全、隐私与工具授权 | `2-使用指南/16-安全隐私与工具授权.md`（en: `2-guides/16-security-privacy-and-tool-authorization.md`） | `3-参考手册/5-安全与信任边界.md` |
| 浏览器设置、密码保险库与本机导入 | `2-使用指南/17-浏览器设置密码与数据导入.md`（en: `2-guides/17-browser-settings-passwords-and-import.md`） | `3-参考手册/4-数据存储位置.md` |
| 应用更新 | `2-使用指南/18-应用更新.md`（en: `2-guides/18-app-updates.md`） | `3-参考手册/5-安全与信任边界.md` |
| 系统提示词、个性化、请求头、主题与快捷键 | `2-使用指南/19-个性化主题与快捷键.md`（en: `2-guides/19-personalization-theme-and-shortcuts.md`） | `3-参考手册/3-配置文件字段参考.md` |
| 用量统计与系统日志 | `2-使用指南/20-用量统计与系统日志.md`（en: `2-guides/20-usage-statistics-and-system-logs.md`） | `3-参考手册/4-数据存储位置.md` |
| 查询内置工具 / 配置域 / 日志 | — | `3-参考手册/2-内置工具参考.md`（en: `3-reference/2-builtin-tools-reference.md`） |
| 查询配置文件字段 | — | `3-参考手册/3-配置文件字段参考.md`（en: `3-reference/3-config-file-field-reference.md`） |

> 若 `~/.snow/docs/` 不存在，说明文档尚未同步，可提示用户重启应用后重试。

## 2. 按文档执行配置（Then apply the configuration）

**通用流程**：任何配置任务，先 `config-list scope=<域>` 查看现状——DB 型域
（subAgents / hooks / imagegen）的响应会附带 **guidance 使用规则引导**（如
创建子代理的关键规则、hook 退出码约定），再按本文与文档步骤执行；需要
`projectId` 时（项目级配置），在 `~/.snow/projects/index.json` 中按项目路径
查 `projectId`（即 directoryId），或直接问用户从界面获取。

通读对应文档后按步骤执行：

- **MCP 服务器（全局）**：用 `config-set` 写 `settings` 域的 `mcpServers` 键
  （value 为服务器名到配置对象的映射，Windows 路径用 `\\` 转义）；
  写入会自动按差集同步到应用数据库，**立即生效**，无需手动同步；
  也可先 `config-get`/`config-list` 查看现状。
- **MCP 服务器（项目级）**：给 `config-set settings mcpServers` 传
  `projectId` 可**全量替换**该项目级 MCP 服务器（value 同样为
  `{name: {type,url,command,args,env,headers,enabled,timeoutMs}}`，写入应用
  数据库立即生效）；`config-get`/`config-delete` 传 `projectId` 读取/清空
  项目级 MCP 服务器。
- **敏感命令（项目级）**：`config-set settings sensitiveCommands [数组]`
  传 `projectId` 全量替换项目级敏感命令（元素 `{commandId, pattern,
  description, enabled}`；commandId 匹配全局规则时为 enabled 覆盖，其余为
  项目自定义规则）；`config-get`/`config-delete` 传 `projectId` 读取/清空。
- **API / 代理 / 主题等配置**：通过 `config` 工具读写白名单域——`snowcfg`
  （config.json：baseUrl/apiKey/advancedModel/chatThinking 等）、`proxy`
  （proxy-config.json）、`app`（active-profile.json）、`custom-headers`、
  `system-prompt`、`theme`、`language`、`permissions`、`lsp-config`、`buddy`。
  文件型配置写后**可能需要重启应用或 UI 重存生效**。
- **子代理**：先 `config-list scope=subAgents` 查看现有代理与响应中的
  **创建规则 guidance**；`config-set scope=subAgents key=<agentId> value={name,
  description, systemPrompt, toolsJson, configProfile}` 创建/更新；
  `config-delete scope=subAgents key=<agentId>` 删除；写入应用数据库**立即生效**。
  关键规则：
  - `toolsJson` 接受 JSON 字符串或工具名数组；**显式工具名列表必须传
    `projectId`（项目级）**——全局代理只能用 `"*"`（全部工具）或空列表；
    每个工具名必须是该项目已启用的工具全名
  - `configProfile` 必须是已存在的 API 配置档名，留空 = 跟随全局生效配置
  - `systemPrompt` 必须**完全自包含**（子代理无会话历史：使命/原则/流程/工具用法/输出格式）
  - 项目级代理激活时优先于同名全局代理；内置 `agent_general` 不可修改/删除
  - 详细规则见文档 `2-使用指南/5-配置Hooks与子代理.md` 第 2 节
- **Hooks**：`config-list scope=hooks` 查看；`config-set scope=hooks
  key=<hookType> value={rules:[{description, matcher?, hooks:[{type,
  command?|prompt?|content?, timeout?, enabled:true}]}]}` 配置；传 `projectId`
  为项目级。**每个需要执行的 action 都必须显式写 `enabled: true`；缺省、
  null 或 false 均不会执行。**写入应用数据库立即生效。
- **全局规则（personalization）**：`~/.snow/ROLE.md` 是全局角色/规则文件
  （纯文本 markdown，非 JSON）。`config-list scope=personalization` 返回
  键规格 + 长度/预览；`config-get scope=personalization key=role` 返回规则
  全文（文件不存在时返回 null）；`config-set scope=personalization key=role
  value=<字符串>` 整体替换规则全文（写前自动备份，写后下一个对话生效）；
  `config-delete scope=personalization key=role` 删除 ROLE.md（恢复默认，
  需用户确认）。修改后提示用户到「设置 → 个人化设置」或重启应用生效。
- **管理 Skills**：先读安装管理指南。扫描同 ID 覆盖优先级为
  `<project>/.snow/skills` > `<project>/.agents/skills` > `~/.snow/skills` >
  `~/.agents/skills`。用 `config-list scope=skills` 查看有效 `path`、状态与
  GitHub 已装记录；用 `config-set scope=skills key=<skillId>
  value={enabled: true|false}` 切换开关——config API 参数名是 `enabled`，
  但不传 `projectId` 时实际改写 SKILL.md frontmatter 的 **`enable`** 字段；
  传 `projectId` 时写入项目数据库覆盖，且优先于 frontmatter。GitHub 安装用
  `value={url, location}`，`location` 为 `global` 或 `project`（项目安装需
  `projectId`）。`config-delete scope=skills key=<skillId>` 仅卸载
  `~/.snow/skills-registry.json` 已登记的 GitHub Skill，且删除前必须确认；
  手动放置或应用自带 Skill 不在此卸载边界内。
- **创建 / 编写 Skills**：必须先完整阅读
  `2-使用指南/21-创建与编写Skills.md`（en:
  `2-guides/21-create-and-author-skills.md`）。真实 frontmatter 字段是
  **`enable` 与 `allowed-tools`**，不是 `enabled` / `allowed_tools`；技能 ID
  来自 `SKILL.md` 相对扫描根目录的路径，不来自 `name`。创建前检查四个扫描
  根目录的同 ID 覆盖，使用最小权限工具列表，创建后用 config list/get 核对
  `id`、`path`、`defaultEnabled`、`enabled` 与 `allowedTools`，再运行只读测试。
- **图像生成（多渠道）**：用 `config-list scope=imagegen` 查看各渠道状态
  （enabled/model/configured）与全局 `maxConcurrentImages`（最大并发生成数
  1-8，默认 4，AI 一次请求多张时最多同时生成的张数）；写入用 `config-set
  scope=imagegen value={channels:[...]}` 全量替换，或 `{<channelId>: {...}}`
  按渠道合并（**未提供的字段保留原值**，`maxConcurrentImages` 也会保留除非
  显式提供），或 `{maxConcurrentImages: 6}` 单独调整并发数（自动收敛 1-8）；
  `config-get scope=imagegen key=<channelId|openai|gemini|maxConcurrentImages>`
  读取（省略 key 返回完整设置）；`config-delete scope=imagegen` 清空。写入
  应用数据库 `system_settings` 表（code=`imagegen_settings`）**立即生效**，
  与设置面板同源；图形界面为**设置 → 图像生成**
  （`app-control-openSettings page=imagegen-settings`）。注意：渠道需
  `enabled`+`apiKey`+`model` 三者齐备才可用，所有渠道均未配置时
  `imagegen-generate` 工具对模型隐藏；`apiKey` 读取一律脱敏
  （如 `sk-e****7890`），**不要索要或展示明文密钥**。
- **日志诊断（只读）**：应用异常时用 `config-list scope=logs` 列出
  `~/.snow/log` 下的日志文件（含最近 error 文件摘要），用 `config-get
  scope=logs key=<文件名>` 或级别简写（`error`/`warn`/`info`/`debug`，读取
  今天的对应文件）读取日志尾部（可选 `limit` 控制行数，默认 200、最大
  2000）定位异常；`config-delete scope=logs key=<精确文件名>` 清理日志。
  日志路径也可在 **设置 → 系统日志**（`app-control-openSettings page=system-logs`）
  查看。
- **安全须知**：`config` 工具只能读写白名单内的配置域与键，写前有类型与
  嵌套结构校验（`codebase`/`custom-headers.schemes`/`system-prompt.prompts`/
  `lsp-config.servers` 深度校验，防止写坏内部字段）；`config-get` 对
  `apiKey`/`visionApiKey`/自定义请求头/系统提示词等敏感键强制脱敏
  （如 `sk-****abcd`），**不要向用户索要或试图获取明文密钥**；每次写入前
  自动备份到 `~/.snow/.config-backups/`，写入为原子替换，**写入成功后清理
  本次备份**（临时安全网）。
- **删除必须二次确认**：`config-delete` 是破坏性操作，**调用前必须先通过
  `user-interaction` 的 `askUserQuestion` 向用户展示将要删除的 scope/key 与
  影响，获得明确同意后携带 `confirmed: true` 调用**，否则会被拒绝。特别
  注意：`imagegen` 域的 delete 是**清空全部图像生成渠道**（不是只删命名
  键）；`skills` 域 delete 卸载技能；`logs` 域 delete 删除日志文件。任何
  delete 前都先 `config-get`/`config-list` 确认现状。
- **打开设置页**：用 `app-control-openSettings`，`page` 参数取值见文档
  （如 `mcp-settings`、`api-settings`、`imagegen-settings`、
  `proxy-browser-settings`、`sub-agent-settings`、`hooks-settings`、
  `theme-settings`、`system-logs`）。
- **编辑配置文件**：需要读写 `~/.snow/` 下的 JSON 时使用 filesystem 工具，
  注意 **Windows 路径中的反斜杠必须写成 `\\`**（JSON 转义），否则
  `\f`/`\n`/`\v` 会被解析为转义序列导致配置失效。

## 3. 完成确认（Confirm with the user）

配置完成后，向用户确认结果，并主动询问是否需要进一步验证
（例如获取 MCP 工具列表验证连通性、读取日志确认异常已消失）。
