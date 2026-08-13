---
name: snow-app-docs
description: >-
  Snow App 配置与排查向导（中文/English）——配置/管理 API 密钥、模型与档案、
  MCP 服务器、Skills、子代理、Hooks、图像生成、代理与网络、第三方配置导入、
  安全隐私与工具授权、个性化/系统提示词/自定义请求头/主题/快捷键、用量统计与
  系统日志、数据存储位置、settings.json 字段、内置工具等。
  Guides the agent to read the built-in Snow App documentation (~/.snow/docs)
  before configuring or troubleshooting Snow App. Covers MCP servers;
  installing, managing, creating, and authoring Skills; sub-agents; Hooks;
  API keys/models; image generation; proxy/network; third-party config and
  Plugin runtimes; browser passwords and local-browser data import; app updates;
  security/privacy/tool authorization; personalization, system prompts, custom
  headers, themes, and shortcuts; usage/log diagnostics; project-scoped
  settings; settings.json fields; storage locations; and built-in tools. Use
  this Skill whenever the user asks to configure, inspect, create, author, or
  troubleshoot any of these areas. It covers the config built-in service
  (config-list/get/set/delete; scopes: settings/snowcfg/proxy/app/
  custom-headers/system-prompt/theme/language/permissions/lsp-config/buddy/
  subAgents/hooks/skills/logs/imagegen/personalization/apiProfiles), including
  project-scoped mcpServers/sensitiveCommands/subAgents/hooks/skills via
  `projectId`, the read-only logs scope, imagegen multi-channel settings,
  masked secrets, and app-control-openSettings (21 settings pages).
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
**先执行 `config-list scope=language` 读取界面语言**（支持 `en`/`zh-CN`/`zh-TW`；
旧安装可能存兼容值 `zh`，等同简体中文；无法读取时默认中文分支），
再选择对应文档分支（无法读取时默认中文分支）：

- 中文界面 → 读 `~/.snow/docs/zh-CN/`
- English UI → read `~/.snow/docs/en/`

按任务定位文档（路径相对所选语言分支）：

| 任务 | 使用指南（How-to） | 参考手册（Reference） |
| --- | --- | --- |
| 快速开始（安装/首次运行/基础配置） | `1-快速开始.md`（en: `1-getting-started.md`） | — |
| 配置 MCP 服务器 | `2-使用指南/1-配置MCP服务器.md`（en: `2-guides/1-configure-mcp.md`） | `3-参考手册/1-settings.json配置参考.md` |
| 安装与管理 Skills | `2-使用指南/2-安装与管理Skills.md`（en: `2-guides/2-install-and-manage-skills.md`） | — |
| 创建与编写 Skills | `2-使用指南/21-创建与编写Skills.md`（en: `2-guides/21-create-and-author-skills.md`） | — |
| 配置 API 密钥与模型 | `2-使用指南/3-配置API密钥与模型.md#5`（en: `2-guides/3-configure-api-keys.md#5`；§5 为 agent 操作速查） | `3-参考手册/1-settings.json配置参考.md` |
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
| 查询内置工具 / 配置域 / 日志 | — | `3-参考手册/2-内置工具参考.md#config`（en: `3-reference/2-builtin-tools-reference.md#config`；§app-control 有 21 个设置页表格） |
| 查询配置文件字段 | — | `3-参考手册/3-配置文件字段参考.md`（en: `3-reference/3-config-file-field-reference.md`） |
| 架构与开发（构建/故障排查/数据流） | `4-架构与开发/1-架构总览.md`、`2-开发者指南.md`、`3-打包与安装故障排查.md`、`4-Agent运行时与工具编排.md`、`5-存储迁移备份与恢复.md`、`6-功能模块架构与数据流图集.md`（en: `4-architecture-and-development/1-architecture-overview.md` 等，按同名编号对应） | — |

> 若 `~/.snow/docs/` 不存在，说明文档尚未同步，可提示用户重启应用后重试。

## 2. 按文档执行配置（Then apply the configuration）

**通用流程**：先 `config-list scope=<域>` 查看现状（DB 型域响应附 guidance
使用规则），再按文档步骤执行；查看已安装 skill 的元数据（id/path/状态）用
`config-list scope=skills`，文档正文用 `filesystem-read` 读取 `~/.snow/docs/`；
需要 `projectId` 时优先读取任意 `config-list` 响应附带的 `currentProjectId`
字段（即当前会话绑定的项目），项目档案 `~/.snow/projects/index.json` 中按
`knownPaths` 匹配路径后取对应记录的 `projectId` 字段。读取文档时可用
`filesystem-read` 的 `startLine`/`endLine` **只读相关章节**（锚点见第 1 节表格）。

**各域操作要点**（完整命令示例见对应文档）：
- **API 档案**：`apiProfiles` 域，写 DB `api_configs`、与 UI 同源、立即生效。
  空/省略 `apiKey` 一律保留旧值（支持"无密钥建档→用户后补密钥"）；未提供字段
  保留现值；`isActive:true` 切换（**新会话生效**，已有会话绑定创建时档案——
  会话隔离）；删除先 `askUserQuestion` 再 `confirmed=true`；密钥读取一律脱敏
  （如 `sk-****abcd`），**不索要/展示明文**。→ `3-配置API密钥与模型.md#5`
- **MCP 服务器**：`settings.mcpServers`（全局自动同步 DB 立即生效；项目级传
  `projectId` 全量替换，value 为 `{name: {type,url,command,args,env,headers,enabled,timeoutMs}}`）。
  → `1-配置MCP服务器.md`
- **敏感命令（项目级）**：`settings.sensitiveCommands` 传 `projectId` 全量替换
  （元素 `{commandId, pattern, description, enabled}`）。→ `16-安全隐私与工具授权.md`
- **子代理**：`subAgents` 域（key=agentId，写 DB 立即生效）。显式 `toolsJson`
  工具名列表须传 `projectId`（全局仅空/`["*"]`）；`configProfile` 须是已存在
  档案名；`systemPrompt` 须完全自包含；内置 `agent_general` 不可改删；项目级
  优先于同名全局。→ `5-配置Hooks与子代理.md#2`
- **Hooks**：`hooks` 域（key=hookType，value 含 `rules` 数组；传 `projectId`
  为项目级）。**每个要执行的 action 必须显式 `enabled: true`**。
  → `5-配置Hooks与子代理.md`
- **Skills 管理**：`skills` 域。同 ID 覆盖优先级 `<项目>/.snow/skills` >
  `<项目>/.agents/skills` > `~/.snow/skills` > `~/.agents/skills`；开关参数名
  `enabled`（全局实际改写 frontmatter 的 `enable`）；GitHub 安装
  `{url, location}`；delete 仅卸载 registry 已登记的 GitHub Skill（需确认）。
  → `2-安装与管理Skills.md`
- **创建/编写 Skills**：frontmatter 是 **`enable` 与 `allowed-tools`**；技能 ID
  来自 SKILL.md 相对扫描根的路径；创建后核对 id/path/enabled 并只读测试。
  → `21-创建与编写Skills.md`
- **图像生成**：`imagegen` 域（`{channels:[...]}` 全量替换或 `{<channelId>: {...}}`
  按 id 合并，未提供字段保留原值；顶层 `maxConcurrentImages` 1-8/`timeoutSecs`
  60-3600；渠道需 `enabled`+`apiKey`+`model` 齐备，全未配置时 `imagegen-generate`
  隐藏；apiKey 脱敏）。→ `9-图像生成.md`
- **全局规则**：`personalization` 域 `key=role`（`~/.snow/ROLE.md` 纯文本非
  JSON；get 全文/set 整体替换/delete 需确认，写后下一对话生效）。
  → `19-个性化主题与快捷键.md`
- **代理/主题等文件域**：`snowcfg`/`proxy`/`app`/`custom-headers`/`system-prompt`/
  `theme`/`language`/`permissions`/`lsp-config`/`buddy`，写后**可能需重启或 UI
  重存生效**（`settings.mcpServers` 除外——自动同步应用数据库立即生效）。
  → `3-参考手册/3-配置文件字段参考.md`
- **日志（只读）**：`logs` 域（list 列文件、get 读尾部 `limit` 默认 200 最大
  2000、delete 仅接受精确文件名）。→ `20-用量统计与系统日志.md`

**安全约束（所有域通用）**：config 工具仅读写白名单域，写前类型/结构校验 +
自动备份到 `~/.snow/.config-backups/`（成功写入后清理）；`apiKey`/`visionApiKey`/
自定义请求头/系统提示词读取一律脱敏，**不索要或展示明文**；**`config-delete`
必须先经 `user-interaction` 的 `askUserQuestion` 获得用户明确同意，再带
`confirmed: true` 调用**（`imagegen` 清空全部渠道、`skills` 卸载、`logs` 删文件）。

**打开设置页**：`app-control-openSettings page=<id>`——21 个页面 id 及
"agent 可配置 vs UI-only"标注见 `3-参考手册/2-内置工具参考.md#app-control`
表格。UI-only 页面（导入/终端/快捷键/隐私/用量/图片库/浏览器密码等）agent
只能打开页面引导用户操作，不能直接改配置。

**编辑 ~/.snow JSON**：用 filesystem 工具；Windows 路径反斜杠必须写成
`\`（JSON 转义），否则 `\f`/`\n`/`\v` 被解析为转义序列导致配置失效。

## 3. 完成确认（Confirm with the user）

配置完成后，向用户确认结果，并主动询问是否需要进一步验证
（例如获取 MCP 工具列表验证连通性、读取日志确认异常已消失）。
