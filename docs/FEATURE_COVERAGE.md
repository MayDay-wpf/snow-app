# 功能文档覆盖审计 / Feature Documentation Coverage Audit

> **审计日期 / Audit date:** 2026-08-08
> **审计范围 / Audited scope:** `src/`, `native/src/`, `resources/`, `scripts/`, `docs/`
> **权威来源 / Sources of truth:** 可达的产品入口与设置页、preload/IPC 合约、Rust 导出与 MCP 注册表、存储服务，以及随产品发布的双语文档。

## 1. 覆盖边界 / Coverage boundary

**中文。** 本矩阵声明的是**产品功能级**文档覆盖：用户能发现和操作的能力、21 个设置页、固定或按条件暴露的内置工具域，以及平台与基础设施均必须有源码锚点和中英文文档落点。它不声称逐函数、逐参数或逐行解释实现；内部辅助函数、纯样式细节和生成产物只在影响用户行为、兼容性、安全边界或运维方式时单列。表中的源码路径是审计入口，不是唯一实现文件。

**English.** This matrix declares **product-capability-level** documentation coverage. Every discoverable user capability, all 21 settings pages, every fixed or conditionally exposed built-in tool domain, and platform/infrastructure concerns must have source anchors plus Chinese and English documentation destinations. It does not claim function-by-function, parameter-by-parameter, or line-by-line explanation. Internal helpers, styling details, and generated artifacts are listed separately only when they affect user behavior, compatibility, security boundaries, or operations. Source paths are audit entry points, not an exhaustive implementation file list.

### 覆盖状态 / Coverage status

| 状态 / Status | 判定 / Meaning |
| --- | --- |
| **C** | 专题覆盖 / Dedicated coverage — 双语指南或参考手册直接覆盖该能力。 |
| **A** | 聚合覆盖 / Aggregated coverage — 双语上位指南完整说明产品级行为，细节与相邻能力合并维护。 |
| **R** | 参考覆盖 / Reference coverage — 双语架构或参考文档定义边界、入口与约束；不承诺逐步教程。 |

所有三种状态都满足本审计的产品功能级基线。需要逐字段或逐工具参数时，以对应参考手册为准；需要实现细节时，从源码锚点继续追踪。

## 2. 用户功能矩阵 / User capability matrix

| 功能 / Capability | 主要源码锚点 / Primary source anchors | 中文文档 / Chinese docs | English docs | 状态 |
| --- | --- | --- | --- | --- |
| 安装、首次启动与 API 初始配置 / Install, first launch, initial API setup | `src/main/app/bootstrap.ts`; `src/renderer/App.tsx` | [快速开始](zh-CN/1-快速开始.md) | [Getting started](en/1-getting-started.md) | C |
| 本地项目创建，以及工作区添加、激活、排序、重命名、移除与资源管理器入口 / Local project creation plus workspace add, activate, reorder, rename, remove, and explorer entry | `src/renderer/components/sidebar/mainSidebar/ProjectsSection.tsx`; `src/renderer/components/sidebar/mainSidebar/WorkspaceDirectoryMenu.tsx`; `src/preload/modules/workspaceApi.ts`; `src/main/ipc/handlers/workspaceHandlers.ts` | [聊天与 AI 助手](zh-CN/2-使用指南/10-使用聊天与AI助手.md) | [Chat and AI assistant](en/2-guides/10-using-chat-and-ai.md) | A |
| 已安装 IDE 探测与在 IDE 中打开本地工作区 / Installed-IDE detection and opening a local workspace in an IDE | `src/renderer/components/sidebar/mainSidebar/WorkspaceDirectoryMenu.tsx`; `src/preload/modules/ideApi.ts`; `src/main/ipc/handlers/ideHandlers.ts`; `native/src/exports/ide.rs` | [Git 与代码浏览](zh-CN/2-使用指南/12-Git面板与代码浏览.md) | [Git and code browsing](en/2-guides/12-git-and-code-browsing.md) | A |
| SSH 工作区、凭据、远程文件与远程命令 / SSH workspaces, credentials, remote files and commands | `src/main/ssh/`; `src/renderer/components/sidebar/mainSidebar/SshConnectWizard.tsx` | [终端与 SSH](zh-CN/2-使用指南/11-终端与SSH远程管理.md) | [Terminal and SSH](en/2-guides/11-terminal-and-ssh.md) | C |
| 会话创建、搜索、置顶、重命名、分叉、导出与批量删除 / Conversation create, search, pin, rename, fork, export, and bulk delete | `src/preload/modules/conversationApi.ts`; `native/src/storage/services/chat_conversations.rs` | [聊天与 AI 助手](zh-CN/2-使用指南/10-使用聊天与AI助手.md) | [Chat and AI assistant](en/2-guides/10-using-chat-and-ai.md) | C |
| 跨项目通知聚合与会话关注状态指示 / Cross-project notification aggregation and conversation attention indicators | `src/renderer/components/sidebar/mainSidebar/useCrossProjectNotifications.ts`; `src/renderer/components/sidebar/mainSidebar/ChatsSection.tsx` | [聊天与 AI 助手](zh-CN/2-使用指南/10-使用聊天与AI助手.md) | [Chat and AI assistant](en/2-guides/10-using-chat-and-ai.md) | C |
| 聊天输入、文件提及、附件、排队消息与斜杠命令 / Composer, file mentions, attachments, queued messages, slash commands | `src/renderer/components/mainContent/chatInput/`; `src/renderer/components/mainContent/ChatInput.tsx` | [聊天与 AI 助手](zh-CN/2-使用指南/10-使用聊天与AI助手.md) | [Chat and AI assistant](en/2-guides/10-using-chat-and-ai.md) | C |
| 多供应商流式聊天、模型档案、思考与用量指标 / Multi-provider streaming chat, model profiles, reasoning, usage metrics | `native/src/api/`; `src/renderer/components/mainContent/chatMessages/hooks/useAgentLoop.ts` | [API 密钥与模型](zh-CN/2-使用指南/3-配置API密钥与模型.md) | [API keys and models](en/2-guides/3-configure-api-keys.md) | C |
| API 档案表单：Gemini Google 搜索联网、Responses Fast Mode 与按请求方法校验 / Profile form: Gemini Google search grounding, Responses Fast Mode, per-method validation | `src/renderer/components/sidebar/apiSettings/ApiSettingsFormFields.tsx`; `native/src/api/gemini/payload.rs`; `native/src/api/responses/payload.rs` | [API 密钥与模型](zh-CN/2-使用指南/3-配置API密钥与模型.md) | [API keys and models](en/2-guides/3-configure-api-keys.md) | C |
| Markdown、代码、KaTeX 与 Mermaid 消息渲染 / Markdown, code, KaTeX, and Mermaid rendering | `src/renderer/components/mainContent/chatMessages/components/markdownRenderer.tsx`; `mermaidRenderer.ts` | [聊天与 AI 助手](zh-CN/2-使用指南/10-使用聊天与AI助手.md) | [Chat and AI assistant](en/2-guides/10-using-chat-and-ai.md) | A |
| Agent 循环、工具调用卡片、取消与文件变更追踪 / Agent loop, tool-call cards, cancellation, file-change tracking | `src/renderer/components/mainContent/chatMessages/hooks/`; `native/src/exports/engine.rs` | [聊天与 AI 助手](zh-CN/2-使用指南/10-使用聊天与AI助手.md) | [Chat and AI assistant](en/2-guides/10-using-chat-and-ai.md) | C |
| Plan Mode 与 Goal Mode / Plan Mode and Goal Mode | `native/src/prompt/plan_mode_system_prompt.rs`; `native/src/prompt/goal_mode_system_prompt.rs`; `src/renderer/hooks/useAppControl.ts` | [聊天与 AI 助手](zh-CN/2-使用指南/10-使用聊天与AI助手.md) | [Chat and AI assistant](en/2-guides/10-using-chat-and-ai.md) | A |
| 工具授权、敏感命令确认与项目级工具开关 / Tool authorization, sensitive-command confirmation, project tool toggles | `src/renderer/components/mainContent/chatMessages/hooks/useToolAuthorization.ts`; `native/src/mcp/tools.rs` | [安全、隐私与工具授权](zh-CN/2-使用指南/16-安全隐私与工具授权.md) | [Security, privacy, and tool authorization](en/2-guides/16-security-privacy-and-tool-authorization.md) | C |
| 检查点、差异预览与会话回滚 / Checkpoints, diff preview, conversation rollback | `native/src/exports/checkpoint.rs`; `src/renderer/components/mainContent/chatMessages/hooks/useRollback.ts` | [Git 与代码浏览](zh-CN/2-使用指南/12-Git面板与代码浏览.md) | [Git and code browsing](en/2-guides/12-git-and-code-browsing.md) | A |
| MCP 服务器配置、发现与外部工具调用 / MCP server configuration, discovery, external tool calls | `src/renderer/components/sidebar/McpSettingsPanel.tsx`; `native/src/mcp/external/` | [配置 MCP](zh-CN/2-使用指南/1-配置MCP服务器.md) | [Configure MCP](en/2-guides/1-configure-mcp.md) | C |
| Skills 安装、启停、项目覆盖与执行 / Skill install, enablement, project override, execution | `src/renderer/components/sidebar/SkillsSettingsPanel.tsx`; `native/src/mcp/servers/skills.rs` | [Skills 指南](zh-CN/2-使用指南/2-安装与管理Skills.md) | [Skills guide](en/2-guides/2-install-and-manage-skills.md) | C |
| Skill 创建、编写、目录优先级、frontmatter 与注册验证 / Skill authoring, directory precedence, frontmatter, and registration verification | `native/src/mcp/servers/skills.rs::load_available_skills`; `native/src/mcp/servers/skills.rs::parse_skill_metadata`; `native/src/mcp/tools.rs::collect_all_mcp_tools` | [创建与编写 Skills](zh-CN/2-使用指南/21-创建与编写Skills.md) | [Create and author Skills](en/2-guides/21-create-and-author-skills.md) | C |
| 子代理配置、独立执行与会话展示 / Sub-agent configuration, isolated execution, session display | `src/renderer/components/sidebar/SubAgentSettingsPanel.tsx`; `native/src/mcp/servers/sub_agents.rs` | [Hooks 与子代理](zh-CN/2-使用指南/5-配置Hooks与子代理.md) | [Hooks and sub-agents](en/2-guides/5-configure-hooks-and-subagents.md) | C |
| 生命周期 Hooks / Lifecycle hooks | `src/renderer/components/sidebar/HooksSettingsPanel.tsx`; `native/src/hooks/mod.rs` | [Hooks 与子代理](zh-CN/2-使用指南/5-配置Hooks与子代理.md) | [Hooks and sub-agents](en/2-guides/5-configure-hooks-and-subagents.md) | C |
| 会话 TODO 面板 / Session TODO panel | `src/renderer/components/TopBar/TodoPanelButton.tsx`; `native/src/mcp/servers/todo.rs` | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | R |
| 备忘录与状态管理 / Memos and status management | `src/renderer/components/sidebar/MemoModal.tsx`; `native/src/storage/services/memos.rs` | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | R |
| 单次与周期定时任务 / One-off and recurring scheduled tasks | `src/renderer/components/sidebar/ScheduledTasksModal.tsx`; `src/renderer/hooks/scheduledTasksStore.ts` | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | R |
| 文生图、图生图、流式预览与并行画廊 / Text-to-image, image editing, streaming preview, parallel gallery | `native/src/mcp/servers/imagegen.rs`; `src/renderer/components/mainContent/chatMessages/toolCalls/ImageGenGallery.tsx` | [图像生成](zh-CN/2-使用指南/9-图像生成.md) | [Image generation](en/2-guides/9-image-generation.md) | C |
| 图像库浏览/筛选、相册归类、搜索、批量操作、手动导入、下载、删除、保存位置与迁移 / Image library browse/filter, album organization, search, batch operations, manual import, download, delete, save location, and migration | `src/renderer/components/sidebar/ImageLibraryPanel.tsx`; `src/preload/modules/imageLibraryApi.ts`; `src/main/ipc/handlers/imageLibraryHandlers.ts`; `native/src/storage/services/image_library.rs` | [图像生成](zh-CN/2-使用指南/9-图像生成.md) | [Image generation](en/2-guides/9-image-generation.md) | A |
| 内嵌浏览器、多标签、自动化、DevTools 与登录态 / Embedded browser, tabs, automation, DevTools, login state | `src/renderer/components/rightPanel/browser/`; `src/main/ipc/browserCommandBroker.ts` | [浏览器自动化](zh-CN/2-使用指南/6-浏览器自动化.md) | [Browser automation](en/2-guides/6-browser-automation.md) | C |
| 浏览器密码保险库、自动保存/填充及本机浏览器密码与 Cookie 导入 / Browser password vault, autofill, and local-browser password/Cookie import | `src/renderer/components/sidebar/browserSettings/BrowserSettingsPanel.tsx`; `src/preload/webviewBrowserPreload.ts`; `src/main/ipc/handlers/browserPasswordManager.ts`; `src/main/ipc/handlers/browserPasswordHandlers.ts`; `native/src/api/browser_import.rs` | [浏览器设置、密码与数据导入](zh-CN/2-使用指南/17-浏览器设置密码与数据导入.md) | [Browser settings, passwords, and import](en/2-guides/17-browser-settings-passwords-and-import.md) | C |
| 本地与 SSH 持久 PTY 终端 / Local and SSH persistent PTY terminals | `src/main/pty/`; `src/renderer/components/rightPanel/TerminalPanelContent.tsx` | [终端与 SSH](zh-CN/2-使用指南/11-终端与SSH远程管理.md) | [Terminal and SSH](en/2-guides/11-terminal-and-ssh.md) | C |
| Git 状态、分支、提交图、提交内文件差异、暂存/丢弃、Diff、AI 提交信息与远程同步 / Git status, branches, graph, per-commit file diffs, staging/discard, diffs, AI commit messages, and remote sync | `src/renderer/components/rightPanel/git/BranchSelector.tsx`; `src/renderer/components/rightPanel/git/GitControl.tsx`; `src/renderer/components/rightPanel/git/GitGraph.tsx`; `src/preload/modules/gitApi.ts`; `native/src/exports/git.rs` | [Git 与代码浏览](zh-CN/2-使用指南/12-Git面板与代码浏览.md) | [Git and code browsing](en/2-guides/12-git-and-code-browsing.md) | C |
| 本地/SSH 项目树、重命名/删除、本地文件名与内容搜索、文本编辑/保存、文内搜索与全局搜索 / Local/SSH project trees, rename/delete, local name/content search, text edit/save, in-file search, and global search | `src/renderer/components/sidebar/ProjectExplorerContent.tsx`; `src/renderer/components/sidebar/GlobalSearchModal.tsx`; `src/renderer/components/rightPanel/FileViewerContent.tsx` | [Git 与代码浏览](zh-CN/2-使用指南/12-Git面板与代码浏览.md) | [Git and code browsing](en/2-guides/12-git-and-code-browsing.md) | A |
| 代码库扫描、向量索引、语义搜索、符号诊断与球面图 / Code scanning, vector index, semantic search, symbol diagnostics, sphere view | `native/src/storage/services/codebase_index.rs`; `native/src/mcp/servers/codelens/`; `src/renderer/components/rightPanel/CodebaseSphereView.tsx` | [代码库索引与诊断](zh-CN/2-使用指南/7-代码库索引与代码诊断.md) | [Codebase index and diagnostics](en/2-guides/7-codebase-index-and-diagnostics.md) | C |
| Claude Code、Codex 与 OpenCode 配置发现、选择导入和可逆目录事务 / Claude Code, Codex, and OpenCode discovery, selected import, and reversible directory transactions | `src/renderer/components/sidebar/ImportSettingsPanel.tsx`; `src/main/importConfig/`; `src/preload/modules/importConfigApi.ts` | [第三方配置导入](zh-CN/2-使用指南/8-第三方配置导入.md) | [Third-party config import](en/2-guides/8-third-party-configuration-import.md) | C |
| 插件市场、安装审批、启停/更新/卸载、声明组件、runtime 权限与隔离生命周期 / Plugin marketplaces, install approval, lifecycle, declarative components, runtime permissions, and isolation | `src/renderer/components/sidebar/PluginsSettingsPanel.tsx`; `src/shared/plugins.ts`; `src/main/importConfig/pluginManager.ts`; `src/main/plugins/pluginRuntimeManager.ts`; `src/main/plugins/plugin-runtime-worker.ts` | [第三方配置导入](zh-CN/2-使用指南/8-第三方配置导入.md) | [Third-party config import](en/2-guides/8-third-party-configuration-import.md) | C |
| 全局/项目 ROLE 与个性化规则 / Global/project ROLE and personalization rules | `src/renderer/components/sidebar/personalization/PersonalizationSettingsPanel.tsx`; `src/renderer/components/sidebar/personalization/GlobalRoleEditor.tsx`; `src/renderer/components/sidebar/personalization/ProjectRoleEditor.tsx`; `src/preload/modules/personalizationApi.ts` | [个性化、主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md) | [Personalization, theme, and shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md) | C |
| 系统提示词、作用域、API profile 绑定与供应商请求组装 / System prompts, scopes, API-profile binding, and provider request assembly | `src/renderer/components/sidebar/SystemPromptSettingsPanel.tsx`; `native/src/storage/services/system_prompts.rs`; `native/src/api/chat/payload.rs`; `native/src/api/responses/payload.rs`; `native/src/api/anthropic/payload.rs`; `native/src/api/gemini/payload.rs` | [个性化、主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md) | [Personalization, theme, and shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md) | C |
| 自定义请求头方案、API profile 绑定与供应商注入 / Custom-header schemes, API-profile binding, and provider injection | `src/renderer/components/sidebar/CustomHeadersSettingsPanel.tsx`; `native/src/storage/services/custom_header_schemes.rs`; `native/src/api/common.rs::inject_custom_headers` | [个性化、主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md) | [Personalization, theme, and shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md) | C |
| 主题、背景、字体、流光标与界面语言 / Theme, background, font, stream cursor, UI language | `src/renderer/components/sidebar/themeSettings/`; `src/renderer/i18n/` | [个性化、主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md) | [Personalization, theme, and shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md) | C |
| 可配置键盘快捷键 / Configurable keyboard shortcuts | `src/renderer/components/KeyboardShortcutsProvider.tsx`; `native/src/storage/services/keyboard_shortcuts.rs` | [个性化、主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md) | [Personalization, theme, and shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md) | C |
| 用量统计、系统日志与隐私掩码 / Usage statistics, system logs, privacy masking | `src/renderer/components/sidebar/usageSettings/`; `src/renderer/components/sidebar/systemLogs/`; `native/src/mcp/privacy_mask.rs` | [用量统计与系统日志](zh-CN/2-使用指南/20-用量统计与系统日志.md)；[安全、隐私与工具授权](zh-CN/2-使用指南/16-安全隐私与工具授权.md) | [Usage statistics and system logs](en/2-guides/20-usage-statistics-and-system-logs.md); [Security, privacy, and tool authorization](en/2-guides/16-security-privacy-and-tool-authorization.md) | C |
| 面板折叠/缩放/全屏、系统通知、托盘、窗口状态与关闭确认 / Panel collapse/resize/fullscreen, notifications, tray, window state, and close confirmation | `src/renderer/App.tsx`; `src/renderer/components/NotificationNavigationBridge.tsx`; `src/main/notification/`; `src/main/app/mainWindow.ts`; `src/main/app/tray.ts`; `src/main/app/windowState.ts` | [聊天与 AI 助手](zh-CN/2-使用指南/10-使用聊天与AI助手.md) | [Chat and AI assistant](en/2-guides/10-using-chat-and-ai.md) | C |
| 应用更新、下载与安装 / App update, download, installation | `src/main/updater/`; `native/src/exports/updater.rs` | [应用更新](zh-CN/2-使用指南/18-应用更新.md) | [App updates](en/2-guides/18-app-updates.md) | C |

## 3. 21 个设置页 / All 21 settings pages

此清单以 `src/renderer/components/sidebar/settingsItems.ts` 的 `SETTINGS_ITEMS` 为准；`MainContentView` 由 `src/renderer/components/mainContent/types.ts` 交叉核验。

| # | 设置页 / Settings page | UI 源码 / UI source | 中文文档 | English docs | 状态 |
| ---: | --- | --- | --- | --- | --- |
| 1 | API 设置 / API settings | `src/renderer/components/sidebar/ApiSettingsTreePanel.tsx` | [API 密钥与模型](zh-CN/2-使用指南/3-配置API密钥与模型.md) | [API keys and models](en/2-guides/3-configure-api-keys.md) | C |
| 2 | 图像生成 / Image generation | `src/renderer/components/sidebar/ImageGenSettingsPanel.tsx` | [图像生成](zh-CN/2-使用指南/9-图像生成.md) | [Image generation](en/2-guides/9-image-generation.md) | C |
| 3 | 图像库 / Image library | `src/renderer/components/sidebar/ImageLibraryPanel.tsx` | [图像生成](zh-CN/2-使用指南/9-图像生成.md) | [Image generation](en/2-guides/9-image-generation.md) | A |
| 4 | 代理设置 / Proxy settings | `src/renderer/components/sidebar/ProxyBrowserSettingsPanel.tsx` | [代理与网络](zh-CN/2-使用指南/4-配置代理与网络.md) | [Proxy and network](en/2-guides/4-configure-proxy.md) | C |
| 5 | 代码库设置 / Codebase settings | `src/renderer/components/sidebar/CodebaseSettingsPanel.tsx` | [代码库索引与诊断](zh-CN/2-使用指南/7-代码库索引与代码诊断.md) | [Codebase index and diagnostics](en/2-guides/7-codebase-index-and-diagnostics.md) | C |
| 6 | 系统提示词 / System prompt | `src/renderer/components/sidebar/SystemPromptSettingsPanel.tsx` | [个性化、主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md) | [Personalization, theme, and shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md) | C |
| 7 | 个性化 / Personalization | `src/renderer/components/sidebar/personalization/PersonalizationSettingsPanel.tsx` | [个性化、主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md) | [Personalization, theme, and shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md) | C |
| 8 | 自定义请求头 / Custom headers | `src/renderer/components/sidebar/CustomHeadersSettingsPanel.tsx` | [个性化、主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md) | [Personalization, theme, and shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md) | C |
| 9 | MCP 设置 / MCP settings | `src/renderer/components/sidebar/McpSettingsPanel.tsx` | [配置 MCP](zh-CN/2-使用指南/1-配置MCP服务器.md) | [Configure MCP](en/2-guides/1-configure-mcp.md) | C |
| 10 | Skills 设置 / Skills settings | `src/renderer/components/sidebar/SkillsSettingsPanel.tsx` | [Skills 指南](zh-CN/2-使用指南/2-安装与管理Skills.md) | [Skills guide](en/2-guides/2-install-and-manage-skills.md) | C |
| 11 | 第三方配置 / Third-party configuration | `src/renderer/components/sidebar/ImportSettingsPanel.tsx` | [第三方配置导入](zh-CN/2-使用指南/8-第三方配置导入.md) | [Third-party config import](en/2-guides/8-third-party-configuration-import.md) | C |
| 12 | 子代理设置 / Sub-agent settings | `src/renderer/components/sidebar/SubAgentSettingsPanel.tsx` | [Hooks 与子代理](zh-CN/2-使用指南/5-配置Hooks与子代理.md) | [Hooks and sub-agents](en/2-guides/5-configure-hooks-and-subagents.md) | C |
| 13 | 敏感命令 / Sensitive commands | `src/renderer/components/sidebar/SensitiveCommandsPanel.tsx` | [安全、隐私与工具授权](zh-CN/2-使用指南/16-安全隐私与工具授权.md) | [Security, privacy, and tool authorization](en/2-guides/16-security-privacy-and-tool-authorization.md) | C |
| 14 | Hooks 设置 / Hooks settings | `src/renderer/components/sidebar/HooksSettingsPanel.tsx` | [Hooks 与子代理](zh-CN/2-使用指南/5-配置Hooks与子代理.md) | [Hooks and sub-agents](en/2-guides/5-configure-hooks-and-subagents.md) | C |
| 15 | 主题设置 / Theme settings | `src/renderer/components/sidebar/ThemeSettingsPanel.tsx` | [个性化、主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md) | [Personalization, theme, and shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md) | C |
| 16 | 终端设置 / Terminal settings | `src/renderer/components/sidebar/TerminalSettingsPanel.tsx` | [终端与 SSH](zh-CN/2-使用指南/11-终端与SSH远程管理.md) | [Terminal and SSH](en/2-guides/11-terminal-and-ssh.md) | C |
| 17 | 浏览器设置 / Browser settings | `src/renderer/components/sidebar/browserSettings/BrowserSettingsPanel.tsx` | [浏览器设置、密码与数据导入](zh-CN/2-使用指南/17-浏览器设置密码与数据导入.md) | [Browser settings, passwords, and import](en/2-guides/17-browser-settings-passwords-and-import.md) | C |
| 18 | 键盘快捷键 / Keyboard shortcuts | `src/renderer/components/sidebar/KeyboardShortcutsSettingsPanel.tsx` | [个性化、主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md) | [Personalization, theme, and shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md) | C |
| 19 | 隐私设置 / Privacy settings | `src/renderer/components/sidebar/PrivacySettingsPanel.tsx` | [安全、隐私与工具授权](zh-CN/2-使用指南/16-安全隐私与工具授权.md) | [Security, privacy, and tool authorization](en/2-guides/16-security-privacy-and-tool-authorization.md) | C |
| 20 | 用量统计 / Usage statistics | `src/renderer/components/sidebar/usageSettings/UsageSettingsPanel.tsx` | [用量统计与系统日志](zh-CN/2-使用指南/20-用量统计与系统日志.md) | [Usage statistics and system logs](en/2-guides/20-usage-statistics-and-system-logs.md) | C |
| 21 | 系统日志 / System logs | `src/renderer/components/sidebar/systemLogs/SystemLogsPanel.tsx` | [用量统计与系统日志](zh-CN/2-使用指南/20-用量统计与系统日志.md) | [Usage statistics and system logs](en/2-guides/20-usage-statistics-and-system-logs.md) | C |

## 4. 内置工具域 / Built-in tool domains

**中文。** “固定注册”只表示服务进入 `native/src/mcp/builtin.rs::builtin_services_in_order`，**不表示其工具始终对模型可见**。`native/src/mcp/tools.rs::collect_all_mcp_tools` 会把固定内置工具和动态 Skills 都交给 `tool_is_enabled`，按当前项目的 server/tool 开关过滤；此外，`codebase` 需要非空项目、项目 codebase 设置启用且索引 `total_chunks > 0`，`imagegen` 需要可用渠道，`app-control-requestApproval` 只在 Plan Mode 请求中加入，`terminal` 默认需项目显式启用，`skills` 仅在存在已启用 Skill 时动态追加。外部 MCP 不是内置服务器，由 `native/src/mcp/external/mod.rs` 动态发现；它会结合服务器配置来源/启用状态与当前项目 scope 的 server/tool 禁用集合过滤后，才并入最终模型工具集。

**English.** **Fixed registration does not mean permanently model-visible.** `collect_all_mcp_tools` passes fixed built-ins and the dynamically created Skills tool through `tool_is_enabled`, which applies the current project's server and tool toggles. Additional gates require a non-empty project plus enabled codebase settings and `total_chunks > 0` for `codebase`, a usable channel for `imagegen`, a Plan Mode request for `app-control-requestApproval`, explicit project opt-in for `terminal`, and at least one enabled Skill before `skills` is appended. External MCP servers are discovered separately rather than registered as built-ins; `native/src/mcp/external/mod.rs` combines each configuration's source/enabled state with project-scoped server/tool disable sets before adding discovered tools to the model-visible collection.

| 工具域 / Tool domain | 注册与实现 / Registration and implementation | 暴露方式 / Exposure | 中文文档 | English docs | 状态 |
| --- | --- | --- | --- | --- | --- |
| `filesystem` | `native/src/mcp/servers/filesystem/` | 固定注册 / fixed | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `bash` | `native/src/mcp/servers/bash.rs` | 固定注册 / fixed | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `todo` | `native/src/mcp/servers/todo.rs` | 固定注册 / fixed | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `grep` | `native/src/mcp/servers/grep.rs` | 固定注册 / fixed | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `websearch` | `native/src/mcp/servers/websearch.rs` | 固定注册 / fixed | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `browser` | `native/src/mcp/servers/browser.rs`; `src/main/ipc/browserCommandBroker.ts` | 固定注册、异步桥 / fixed, async bridge | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `user-interaction` | `native/src/mcp/servers/user_interaction.rs`; `src/main/ipc/userQuestionBroker.ts` | 固定注册、阻塞交互 / fixed, blocking interaction | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `sub-agents` | `native/src/mcp/servers/sub_agents.rs` | 固定注册 / fixed | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `codebase` | `native/src/mcp/servers/codebase.rs`; `native/src/mcp/tools.rs::is_codebase_available` | 非空项目 + 项目 codebase 启用 + `total_chunks > 0` / non-empty project + codebase enabled + `total_chunks > 0` | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `codelens` | `native/src/mcp/servers/codelens/` | 固定注册 / fixed | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `app-control` | `native/src/mcp/servers/app_control.rs`; `src/main/ipc/appControlBroker.ts` | 固定注册；审批工具按请求 / fixed; approval request-scoped | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `config` | `native/src/mcp/servers/config.rs` | 固定注册 / fixed | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `terminal` | `native/src/mcp/servers/terminal.rs`; `src/main/ipc/terminalCommandBroker.ts` | 固定注册、项目默认关闭 / fixed, project opt-in | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `imagegen` | `native/src/mcp/servers/imagegen.rs` | 有可用渠道 / usable channel required | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| `skills` | `native/src/mcp/servers/skills.rs`; `native/src/mcp/tools.rs` | 动态追加 / dynamically appended | [内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [Built-in tools reference](en/3-reference/2-builtin-tools-reference.md) | C |
| 外部 MCP / External MCP | `native/src/mcp/external/` | 配置发现后动态追加，非内置 / dynamically discovered, not built-in | [配置 MCP](zh-CN/2-使用指南/1-配置MCP服务器.md) | [Configure MCP](en/2-guides/1-configure-mcp.md) | C |

> `remote_workspace` 是 SSH 工作区异步桥实现（`native/src/mcp/servers/remote_workspace.rs` 与 `src/main/ssh/remoteWorkspaceCommand.ts`），不在固定内置服务器注册表中，因此归入平台能力而不是伪列为模型可见的独立工具域。

## 5. 平台与基础设施 / Platform and infrastructure

| 范围 / Area | 源码或资产锚点 / Source or asset anchors | 中文文档 | English docs | 状态 |
| --- | --- | --- | --- | --- |
| Renderer → preload → main → Rust 安全分层 | `src/renderer/`; `src/preload/`; `src/main/ipc/`; `native/src/exports/` | [架构总览](zh-CN/4-架构与开发/1-架构总览.md) | [Architecture overview](en/4-architecture-and-development/1-architecture-overview.md) | C |
| Native bridge 与 storage-ready 门控 | `src/main/native/nativeBridge.ts`; `src/main/app/storageReady.ts` | [架构总览](zh-CN/4-架构与开发/1-架构总览.md) | [Architecture overview](en/4-architecture-and-development/1-architecture-overview.md) | C |
| SQLite schema、幂等迁移、WAL 与领域服务 | `native/src/storage/database.rs`; `native/src/storage/migrations.rs`; `native/src/storage/services/` | [数据存储位置](zh-CN/3-参考手册/4-数据存储位置.md) | [Data storage locations](en/3-reference/4-data-storage-locations.md) | C |
| AI 协议适配、SSE、重试、摘要、视觉与 token 计数 | `native/src/api/` | [架构总览](zh-CN/4-架构与开发/1-架构总览.md) | [Architecture overview](en/4-architecture-and-development/1-architecture-overview.md) | R |
| 外部 MCP HTTP/stdio 与项目作用域 | `native/src/mcp/external/` | [配置 MCP](zh-CN/2-使用指南/1-配置MCP服务器.md) | [Configure MCP](en/2-guides/1-configure-mcp.md) | C |
| Windows、macOS、Linux 构建与 native 产物 | `scripts/build-native.cjs`; `scripts/ensure-conpty-dll.cjs` | [开发者指南](zh-CN/4-架构与开发/2-开发者指南.md) | [Developer guide](en/4-architecture-and-development/2-developer-guide.md) | C |
| 打包、发布元数据与安装排障 | `scripts/generate-latest-json.cjs`; `scripts/merge-mac-yml.cjs`; `resources/` | [打包与安装排障](zh-CN/4-架构与开发/3-打包与安装故障排查.md) | [Packaging troubleshooting](en/4-architecture-and-development/3-packaging-troubleshooting.md) | C |
| 应用图标与 Web 静态资产 | `resources/icon.*`; `resources/web/`; `src/renderer/*.png` | [打包与安装排障](zh-CN/4-架构与开发/3-打包与安装故障排查.md) | [Packaging troubleshooting](en/4-architecture-and-development/3-packaging-troubleshooting.md) | R |
| 内置文档 Skill 的同步与消费 | `resources/skills/snow-app-docs/SKILL.md`; `src/main/app/ensureBuiltinSkills.ts` | [开发者指南](zh-CN/4-架构与开发/2-开发者指南.md) | [Developer guide](en/4-architecture-and-development/2-developer-guide.md) | R |
| 配置文件、应用数据库、图片与日志位置 | `native/src/storage/paths.rs`; `src/main/snowCli/paths.ts` | [数据存储位置](zh-CN/3-参考手册/4-数据存储位置.md) | [Data storage locations](en/3-reference/4-data-storage-locations.md) | C |
| 文档治理与自动审计 | `scripts/check-docs.cjs`; `docs/DOCUMENTATION_GUIDE.md` | [文档治理指南](DOCUMENTATION_GUIDE.md#中文规范) | [Documentation guide](DOCUMENTATION_GUIDE.md#english-guidelines) | C |

## 6. 审计维护 / Audit maintenance

- 功能入口、`SETTINGS_ITEMS`、`builtin_services_in_order`、条件暴露逻辑或双语文档路径变化时，必须在同一变更中更新本矩阵。
- 文档覆盖以可验证的用户行为为粒度；一个能力可以由专题、聚合或参考文档覆盖，但必须同时存在中文和英文落点。
- 运行 `node scripts/check-docs.cjs` 检查链接、双语映射、索引、英文正文、Mermaid 和本矩阵状态。
- 审计日期表示最后一次与源码和文档树交叉核验的日期，不等同于应用版本号。

---

- Changes to feature entry points, `SETTINGS_ITEMS`, `builtin_services_in_order`, conditional exposure, or bilingual document paths must update this matrix in the same change.
- Coverage is measured at verifiable user-behavior granularity. Dedicated, aggregated, and reference coverage are all valid, but every capability needs both Chinese and English destinations.
- Run `node scripts/check-docs.cjs` to validate links, locale pairing, index coverage, English prose, Mermaid sources, and matrix statuses.
- The audit date is the last source-and-document-tree reconciliation date; it is not the application version.
