# Snow App 文档

> 基于 Electron、React、TypeScript 和 Rust 构建的高性能跨平台桌面应用。

欢迎阅读 Snow App 文档。本目录按 [Diátaxis](https://diataxis.fr/) 框架组织：
**快速开始**（Tutorial）带你上手，**使用指南**（How-to）解决具体任务，
**参考手册**（Reference）提供权威信息。

## 文档导航 / Documentation

| 中文 (zh-CN)                                                                       | English (en)                                                                                                                   | 说明 / Description                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| [1-快速开始](zh-CN/1-快速开始.md)                                                  | [1-getting-started](en/1-getting-started.md)                                                                                   | 安装与首次运行 / Install & first run                |
| [2-使用指南/1-配置 MCP 服务器](zh-CN/2-使用指南/1-配置MCP服务器.md)                | [2-guides/1-configure-mcp](en/2-guides/1-configure-mcp.md)                                                                     | MCP 服务器配置 / Configure MCP servers              |
| [2-使用指南/2-安装与管理 Skills](zh-CN/2-使用指南/2-安装与管理Skills.md)           | [2-guides/2-install-and-manage-skills](en/2-guides/2-install-and-manage-skills.md)                                             | Skills 安装与管理 / Install & manage skills         |
| [2-使用指南/3-配置 API 密钥与模型](zh-CN/2-使用指南/3-配置API密钥与模型.md)        | [2-guides/3-configure-api-keys](en/2-guides/3-configure-api-keys.md)                                                           | API 与模型配置 / Configure API & models             |
| [2-使用指南/4-配置代理与网络](zh-CN/2-使用指南/4-配置代理与网络.md)                | [2-guides/4-configure-proxy](en/2-guides/4-configure-proxy.md)                                                                 | 代理与网络 / Proxy & network                        |
| [2-使用指南/5-配置 Hooks 与子代理](zh-CN/2-使用指南/5-配置Hooks与子代理.md)        | [2-guides/5-configure-hooks-and-subagents](en/2-guides/5-configure-hooks-and-subagents.md)                                     | Hooks 与子代理配置 / Configure hooks & sub-agents   |
| [2-使用指南/6-浏览器自动化](zh-CN/2-使用指南/6-浏览器自动化.md)                    | [2-guides/6-browser-automation](en/2-guides/6-browser-automation.md)                                                           | 浏览器自动化 / Browser automation                   |
| [2-使用指南/7-代码库索引与代码诊断](zh-CN/2-使用指南/7-代码库索引与代码诊断.md)    | [2-guides/7-codebase-index-and-diagnostics](en/2-guides/7-codebase-index-and-diagnostics.md)                                   | 代码库索引与代码诊断 / Codebase index & diagnostics |
| [2-使用指南/8-第三方配置导入](zh-CN/2-使用指南/8-第三方配置导入.md)                | [2-guides/8-third-party-configuration-import](en/2-guides/8-third-party-configuration-import.md)                               | 第三方配置导入 / Import third-party configuration   |
| [2-使用指南/9-图像生成](zh-CN/2-使用指南/9-图像生成.md)                            | [2-guides/9-image-generation](en/2-guides/9-image-generation.md)                                                               | 图像生成与编辑 / Image generation                   |
| [2-使用指南/10-使用聊天与 AI 助手](zh-CN/2-使用指南/10-使用聊天与AI助手.md)        | [2-guides/10-using-chat-and-ai](en/2-guides/10-using-chat-and-ai.md)                                                           | 聊天与 AI 助手使用 / Using chat & AI assistant      |
| [2-使用指南/11-终端与 SSH 远程管理](zh-CN/2-使用指南/11-终端与SSH远程管理.md)      | [2-guides/11-terminal-and-ssh](en/2-guides/11-terminal-and-ssh.md)                                                             | 终端与 SSH 远程管理 / Terminal & SSH                |
| [2-使用指南/12-Git 面板与代码浏览](zh-CN/2-使用指南/12-Git面板与代码浏览.md)       | [2-guides/12-git-and-code-browsing](en/2-guides/12-git-and-code-browsing.md)                                                   | Git 面板与代码浏览 / Git panel & code browsing      |
| [2-使用指南/13-AI 开发协作](zh-CN/2-使用指南/13-AI开发协作.md)                    | [2-guides/13-ai-development-collaboration](en/2-guides/13-ai-development-collaboration.md)                                     | AI 开发协作（服务管理/debug/像素优化/新工具）/ AI dev collaboration |
| [2-使用指南/14-AI 开发经验与教训](zh-CN/2-使用指南/14-AI开发经验与教训.md)        | [2-guides/14-ai-development-lessons](en/2-guides/14-ai-development-lessons.md)                                                   | AI 开发经验与教训（需求/debug/测试/上线/运维）/ AI dev lessons |
| [2-使用指南/15-前端设计与美化工作流](zh-CN/2-使用指南/15-前端设计与美化工作流.md) | [2-guides/15-frontend-design-and-beautification-workflow](en/2-guides/15-frontend-design-and-beautification-workflow.md)         | 前端设计与美化工作流（UI/UX 设计、设计稿还原、页面美化）/ Frontend design & beautification workflow |
| [2-使用指南/16-安全隐私与工具授权](zh-CN/2-使用指南/16-安全隐私与工具授权.md)     | [2-guides/16-security-privacy-and-tool-authorization](en/2-guides/16-security-privacy-and-tool-authorization.md)               | 安全、隐私与授权 / Security, privacy & authorization |
| [2-使用指南/17-浏览器设置密码与数据导入](zh-CN/2-使用指南/17-浏览器设置密码与数据导入.md) | [2-guides/17-browser-settings-passwords-and-import](en/2-guides/17-browser-settings-passwords-and-import.md)                   | 浏览器数据与密码 / Browser data & passwords         |
| [2-使用指南/18-应用更新](zh-CN/2-使用指南/18-应用更新.md)                         | [2-guides/18-app-updates](en/2-guides/18-app-updates.md)                                                                       | 应用更新 / App updates                              |
| [2-使用指南/19-个性化主题与快捷键](zh-CN/2-使用指南/19-个性化主题与快捷键.md)     | [2-guides/19-personalization-theme-and-shortcuts](en/2-guides/19-personalization-theme-and-shortcuts.md)                       | 个性化与快捷键 / Personalization & shortcuts        |
| [2-使用指南/20-用量统计与系统日志](zh-CN/2-使用指南/20-用量统计与系统日志.md)      | [2-guides/20-usage-statistics-and-system-logs](en/2-guides/20-usage-statistics-and-system-logs.md)                             | 用量与日志 / Usage & logs                           |
| [2-使用指南/21-创建与编写 Skills](zh-CN/2-使用指南/21-创建与编写Skills.md)         | [2-guides/21-create-and-author-skills](en/2-guides/21-create-and-author-skills.md)                                             | Skills 创建与编写 / Create & author Skills          |
| [3-参考手册/1-settings.json 配置参考](zh-CN/3-参考手册/1-settings.json配置参考.md) | [3-reference/1-settings-json-reference](en/3-reference/1-settings-json-reference.md)                                           | settings.json 字段参考 / settings.json reference    |
| [3-参考手册/2-内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md)                    | [3-reference/2-builtin-tools-reference](en/3-reference/2-builtin-tools-reference.md)                                           | 内置工具参考 / Built-in tools reference             |
| [3-参考手册/3-配置文件字段参考](zh-CN/3-参考手册/3-配置文件字段参考.md)            | [3-reference/3-config-file-field-reference](en/3-reference/3-config-file-field-reference.md)                                   | 全部配置文件字段 / All config file fields           |
| [3-参考手册/4-数据存储位置](zh-CN/3-参考手册/4-数据存储位置.md)                    | [3-reference/4-data-storage-locations](en/3-reference/4-data-storage-locations.md)                                             | 数据存储位置 / Data storage locations               |
| [3-参考手册/5-安全与信任边界](zh-CN/3-参考手册/5-安全与信任边界.md)                | [3-reference/5-security-and-trust-boundaries](en/3-reference/5-security-and-trust-boundaries.md)                               | 安全与信任边界 / Security & trust boundaries        |
| [4-架构与开发/1-架构总览](zh-CN/4-架构与开发/1-架构总览.md)                        | [4-architecture-and-development/1-architecture-overview](en/4-architecture-and-development/1-architecture-overview.md)         | 架构总览 / Architecture overview                    |
| [4-架构与开发/2-开发者指南](zh-CN/4-架构与开发/2-开发者指南.md)                    | [4-architecture-and-development/2-developer-guide](en/4-architecture-and-development/2-developer-guide.md)                     | 开发者指南 / Developer guide                        |
| [4-架构与开发/3-打包与安装故障排查](zh-CN/4-架构与开发/3-打包与安装故障排查.md)    | [4-architecture-and-development/3-packaging-troubleshooting](en/4-architecture-and-development/3-packaging-troubleshooting.md) | 打包与安装故障排查 / Packaging troubleshooting      |
| [4-架构与开发/4-Agent 运行时与工具编排](zh-CN/4-架构与开发/4-Agent运行时与工具编排.md) | [4-architecture-and-development/4-agent-runtime-and-tool-orchestration](en/4-architecture-and-development/4-agent-runtime-and-tool-orchestration.md) | Agent 运行时 / Agent runtime                         |
| [4-架构与开发/5-存储迁移备份与恢复](zh-CN/4-架构与开发/5-存储迁移备份与恢复.md)    | [4-architecture-and-development/5-storage-migration-backup-and-recovery](en/4-architecture-and-development/5-storage-migration-backup-and-recovery.md) | 存储可靠性 / Storage reliability                     |
| [4-架构与开发/6-功能模块架构与数据流图集](zh-CN/4-架构与开发/6-功能模块架构与数据流图集.md) | [4-architecture-and-development/6-feature-module-architecture-and-data-flow-diagrams](en/4-architecture-and-development/6-feature-module-architecture-and-data-flow-diagrams.md) | Mermaid 架构与数据流图 / Mermaid diagram atlas      |

## 文档覆盖与维护 / Coverage & Maintenance

- [功能文档覆盖审计 / Feature Documentation Coverage Audit](FEATURE_COVERAGE.md)：功能、21 个设置页、工具域、平台能力到代码和双语文档的覆盖矩阵。
- [文档治理指南 / Documentation Governance Guide](DOCUMENTATION_GUIDE.md)：信息架构、双语同步、代码锚点、Mermaid 规范与功能变更完成标准。
- 任何产品功能变更都必须同步更新对应中英文文档、覆盖矩阵与本索引，并运行 `npm run check:docs`。

## 给 AI Agent 的说明

本目录同时服务于 Snow App 内置的 **snow-app-docs** 技能。当你需要配置
MCP 服务器、安装 Skills、调整 API 或代理设置时：

1. 根据用户界面语言选择 `zh-CN/` 或 `en/` 分支；
2. 从 **使用指南（2-使用指南 / 2-guides）** 中找到对应任务文档并通读；
3. 不确定字段含义时查阅 **参考手册（3-参考手册 / 3-reference）**；
4. 按照文档步骤执行配置，完成后再向用户确认。

> 文档随应用版本同步更新。若某主题未覆盖，可查阅
> [GitHub 仓库](https://github.com/MayDay-wpf/snow-app) 的 README 或提交 issue。
