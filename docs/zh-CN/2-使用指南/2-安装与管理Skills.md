# 2-安装与管理 Skills

Skill 是一个以 `SKILL.md` 为入口的指令包。Snow App 会扫描技能目录，把已启用 Skill 的名称和描述动态注册到 `skills-skill-execute`，Agent 选中后再加载正文、目录树与工具限制。

本文介绍扫描规则、安装、开关、Agent 管理和卸载。若要从零编写 Skill，请继续阅读[创建与编写 Skills](21-创建与编写Skills.md)。

## 1. 扫描目录与覆盖优先级

当存在项目上下文时，Snow App 按下列顺序扫描；**后扫描的同 ID Skill 覆盖先扫描的 Skill**：

| 扫描顺序 | 目录 | 作用域 | 同 ID 优先级 |
| --- | --- | --- | --- |
| 1 | `~/.agents/skills/` | 全局用户级 | 最低 |
| 2 | `~/.snow/skills/` | 全局用户级；GitHub 全局安装位置 | 高于 1 |
| 3 | `<项目>/.agents/skills/` | 项目级 | 高于全局目录 |
| 4 | `<项目>/.snow/skills/` | 项目级；GitHub 项目安装位置 | 最高 |

没有项目上下文时只扫描两个全局目录。扫描是递归的：每个 `SKILL.md` 所在目录都是一个 Skill，**技能 ID 是它相对扫描根目录的路径**，并统一使用 `/`。例如：

```text
<项目>/.snow/skills/
└── team/
    └── release/
        ├── SKILL.md
        └── checklist.md
```

该 Skill 的 ID 是 `team/release`，不是 frontmatter 中的 `name`。以 `.` 开头的目录以及 `templates`、`examples`、`node_modules` 目录不会被递归扫描。

> 同 ID 覆盖会替换整份 Skill（元数据、正文、路径和工具限制），不会合并文件或字段。排错时应先查看实际返回的 `path`、`location` 和 `source`。

## 2. 从 GitHub 安装

### 2.1 设置面板

1. 打开 **设置 → Skills 设置**；
2. 在“从 GitHub 安装”中输入来源；
3. 选择 **全局** 或 **项目**。项目安装需要当前项目；
4. 安装后检查列表中的 ID、路径和开关。

支持的来源格式：

- `https://github.com/owner/repo`
- `owner/repo`
- `owner/repo@branch`
- `owner/repo@branch:sub/dir`
- `https://github.com/owner/repo/tree/branch/sub/dir`

未指定分支时使用仓库默认分支。安装器先检查目标目录本身是否有 `SKILL.md`；若没有，只发现其**直接子目录**中的 `SKILL.md`，以支持多 Skill 仓库。若 Skill 藏在更深层级，请在 URL 中明确指定子目录。

GitHub 安装会：

1. 下载并解压仓库归档；
2. 从 frontmatter `name` 派生安全的安装 ID，缺失时回退为仓库名；
3. 把完整 Skill 目录安装到 `~/.snow/skills/<id>/` 或 `<项目>/.snow/skills/<id>/`；
4. 记录到 `~/.snow/skills-registry.json`，供以后识别和卸载；
5. 同 ID 目标已存在时先暂存旧目录，再替换；注册表写入失败会尝试回滚。

新内容会在下一次技能列表刷新或调用时被重新扫描，无需重启应用。

## 3. 真实 `SKILL.md` frontmatter

Snow App 当前识别的字段名是 **`enable`** 和 **`allowed-tools`**：

```markdown
---
name: release-checker
description: Validate a release package and produce a concise checklist.
enable: true
allowed-tools:
  - filesystem-read
  - grep-search
---

# Release checker

Follow the repository release policy, inspect the requested artifacts, and report
blocking problems before suggestions.
```

| 字段 | 必填 | 解析语义 |
| --- | --- | --- |
| `name` | 否 | 展示名称；缺省时使用技能 ID 的最后一段。GitHub 安装时也用于派生安装 ID。 |
| `description` | 否 | 注册到技能工具描述中，帮助 Agent 判断何时加载。建议写清触发场景与产出。 |
| `enable` | 否 | 布尔值，默认 `true`。`false` 时默认不注册和不可执行。 |
| `allowed-tools` | 否 | YAML 字符串数组或逗号分隔字符串。非空时，加载正文会附加“只能使用这些工具”的限制；空列表等同未限制。 |

`enabled` 和 `allowed_tools` **不是 Skill frontmatter 字段**，不会产生预期效果。注意：下文 config API 的 `value.enabled` 是合法 API 参数，它最终写回的 frontmatter 字段仍是 `enable`。

`allowed-tools` 应填写 Snow App 暴露的完整工具名，例如 `filesystem-read`、`config-list`。它是随 Skill 提示词加载的 Agent 工具白名单约束，不是操作系统沙箱；仍应遵循最小权限原则，不要加入不需要的写入、命令或网络工具。

## 4. 开关与项目级覆盖

### 4.1 设置面板

在 **设置 → Skills 设置** 中切换：

- 全局视图：改写实际命中的 `SKILL.md` 顶层 `enable`；
- 项目视图：把项目覆盖写入应用数据库，不改 Skill 文件；
- 有项目覆盖时，有效状态为“项目数据库覆盖 > 当前命中 Skill 的 `enable`”。

### 4.2 Agent 通过 `config` 管理

Skills 不是一个可任意写对象的配置文件域。`config` 服务把 `skills` scope 委托给与 UI 相同的 Skills 服务：

```text
config-list scope=skills projectId=<projectId>
config-get  scope=skills key=team/release projectId=<projectId>
config-set  scope=skills key=team/release projectId=<projectId> value={"enabled":false}
```

关键语义：

- `config-list` 返回 `skills` 与 `githubInstalled`；项目视图中的 `defaultEnabled` 来自 frontmatter，`enabled` 是叠加数据库覆盖后的有效值；
- 全局切换也使用 `value={"enabled":...}`，但服务会改写 Skill 文件中的 **`enable`**；
- 传 `projectId` 时只写项目数据库覆盖，立即生效；
- 当前会话的 config 工具可能自动注入活动项目 ID；响应中的 `currentProjectId` 可用于确认上下文，需要明确操作全局配置时传空 `projectId`；
- 安装使用 `value={"url":"owner/repo","location":"global"}`，项目安装使用 `location:"project"` 并传 `projectId`；`key` 是 config API 的必填路由参数，实际安装 ID仍由安装内容派生；
- 修改后重新 `config-get` 或 `config-list`，核对 `path` 与有效状态。

## 5. 卸载边界

### 5.1 GitHub 安装的 Skill

设置面板的卸载按钮以及：

```text
config-delete scope=skills key=<skillId> projectId=<projectId> confirmed=true
```

只适用于 `~/.snow/skills-registry.json` 中有记录的 GitHub 安装。Agent 调用 `config-delete` 前必须先展示 scope、key、projectId 与影响，并取得用户明确确认。

卸载会删除注册记录所指向的 `~/.snow/skills/<id>` 或 `<项目>/.snow/skills/<id>` 目录，然后移除注册记录。为避免注册表按 ID 查找时产生歧义，不要在全局和项目范围安装两个同 ID 的 GitHub Skill；先用 `config-list scope=skills` 核对 `githubInstalled`。

### 5.2 手动放置或应用附带的 Skill

没有 GitHub 注册记录的 Skill 不可通过 config/UI GitHub 卸载流程删除：

- 手动放置的 Skill：由用户确认后删除对应目录；
- 应用附带或部署时复制的 Skill：不要假设可卸载，优先使用开关；
- 被更高优先级同 ID Skill 覆盖的低优先级目录仍然存在，删除覆盖层后它会再次显现。

删除目录是文件系统破坏性操作。Agent 必须先确认精确路径、来源和影响，不得只根据展示名称猜测目录。

## 6. 常见问题

| 症状 | 原因与处理 |
| --- | --- |
| Skill 未出现 | 确认文件名严格为 `SKILL.md`；检查目录是否被跳过；修复未闭合的 `---` 或非法 YAML。 |
| 开关看似无效 | frontmatter 应为 `enable`；再检查是否存在项目数据库覆盖或更高优先级同 ID Skill。 |
| Agent 选不中 Skill | 补充具体 `description`，确认 `enable: true`，并刷新技能列表。 |
| 工具被拒绝 | 检查 `allowed-tools` 是否包含精确完整工具名；下划线字段 `allowed_tools` 无效。 |
| GitHub 仓库提示找不到 Skill | 根目录没有 `SKILL.md` 且直接子目录也没有；用带子目录的 URL 指向正确层级。 |
| 卸载返回“not installed from GitHub” | 该 Skill 没有注册记录；核对来源后按手动目录流程处理。 |
| 修改的 Skill 没有生效 | 从 `config-list` 查看实际 `path`，排除同 ID 覆盖，再在下一轮重新加载。 |
