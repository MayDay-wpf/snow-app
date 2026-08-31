# Snow App

> [!WARNING] > **macOS 用户注意：** 如果安装后打开时提示"已损坏"或"无法打开"，请在终端执行以下命令：
>
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/Snow\ App.app
> ```
>
> 执行后按回车输入锁屏密码，以解除隔离属性。

> 基于 Electron、React、TypeScript 和 Rust 构建的高性能跨平台桌面应用。

[English](./README.md)

## 项目简介

Snow App 是一款面向开发者的桌面应用，将 AI 对话、终端模拟、SSH 远程管理、Git 工具和内置浏览器面板整合到统一的工作空间中。它通过 Rust 原生模块处理性能关键型操作，包括 SQLite 存储、AI 流式传输、文件监控和 HTTP 请求。

<img width="1525" height="1058" alt="image" src="https://github.com/user-attachments/assets/48410803-4cde-41a6-a99b-26c446f86740" />


## 功能特性

- **AI 对话** - 流式 AI 助手，支持 Markdown 渲染、语法高亮和可配置的系统提示词
- **集成终端** - 基于 node-pty 和 xterm.js 的全功能 PTY 终端模拟
- **SSH 管理** - 通过 SSH 连接并管理远程服务器，支持凭据持久化
- **Git 面板** - 可视化 Git 差异查看器和仓库管理
- **浏览器面板** - 内置浏览器，支持代理、网络检查与登录态管理，可供 AI 自动化操作
- **MCP 支持** - 模型上下文协议（Model Context Protocol）集成，可扩展 AI 工具
- **AI 图像生成** - 内置文生图/图生图编辑（OpenAI / Gemini 多渠道），生成图片自动存入图像库
- **Skills 技能系统** - 安装/启用/管理 AI 技能（Skill），动态扩展 agent 能力
- **Hooks 生命周期钩子** - 在请求、压缩等事件前后执行自定义命令或提示词
- **子代理** - 独立 AI 执行循环，并行处理复杂多步任务
- **代码库语义搜索** - 基于嵌入索引的代码搜索与多语言代码符号定位（codelens）
- **Plan / Goal 模式** - 计划先行（Plan）与自主长任务执行（Goal）两种工作模式
- **终端交互会话** - AI 可驱动持久 PTY 会话，运行长驻进程与交互式命令
- **代码库浏览器** - 项目文件树，支持工作区目录管理
- **配置导入** - 从 Codex / WSL / SSH 等环境导入 MCP、Skills、插件与提示词
- **国际化** - 多语言支持，内置语言包系统
- **设置管理** - 细粒度配置，涵盖 API 密钥、自定义请求头、代理、敏感命令等
- **跨平台** - 支持 macOS、Windows 和 Linux

## 技术栈

| 层级     | 技术                                          |
| -------- | --------------------------------------------- |
| 外壳     | Electron 37                                   |
| 前端     | React 19, TypeScript 5.9                      |
| 打包器   | electron-vite 4 (Vite 7)                       |
| 原生模块 | Rust 2021 Edition (napi-rs 3)                 |
| 应用打包 | electron-builder 26                           |
| 终端     | node-pty, xterm.js 6                          |
| SSH      | ssh2                                          |
| 存储     | rusqlite (SQLite, 内置)                       |
| AI/HTTP  | reqwest（多供应商协议适配与流式 HTTP）        |
| Markdown | markdown-it, streaming-markdown, highlight.js |
| 图标     | lucide-react                                  |

## 项目结构

```
snow-app/
├── src/
│   ├── main/            # Electron 主进程
│   │   ├── app/         # 应用引导与窗口管理
│   │   ├── codex/       # Codex 兼容层
│   │   │   └── importer.ts # 设置页手动导入 MCP、Skills、Plugins 与提示词
│   │   ├── importConfig/ # 第三方配置导入（可逆事务 + 环境发现）
│   │   ├── ipc/         # IPC 处理器注册
│   │   ├── native/      # Rust 原生桥接（storageReady 门控）
│   │   ├── notification/ # 系统通知
│   │   ├── plugins/     # 插件运行时（worker 隔离）
│   │   ├── pty/         # PTY 与终端管理
│   │   ├── settings/    # 配置存储
│   │   ├── snowCli/     # CLI 路径与配置文件管理
│   │   ├── ssh/         # SSH 连接管理
│   │   ├── types/       # 共享类型
│   │   ├── updater/     # 应用更新
│   │   └── utils/       # 共享工具函数
│   ├── preload/         # Electron 预加载脚本（window.snow.* 白名单）
│   ├── renderer/        # React 前端
│   │   ├── components/  # UI 组件（侧边栏、主内容区、右侧面板）
│   │   ├── hooks/       # 自定义 React Hooks
│   │   ├── i18n/        # 国际化
│   │   └── utils/       # 前端工具函数
│   └── shared/          # 前后端共享代码
├── native/              # Rust 原生模块
│   └── src/
│       ├── api/         # AI API 集成
│       ├── exports/     # napi-rs 导出绑定
│       ├── hooks/       # 生命周期钩子执行
│       ├── mcp/         # MCP 协议实现（内置服务器 + 外部客户端）
│       ├── prompt/      # 系统提示词处理（含 Plan/Goal 模式）
│       └── storage/     # SQLite 持久化
├── scripts/             # 构建与工具脚本
├── resources/           # 应用图标与静态资源
└── electron.vite.config.ts
```

Codex 兼容层只能从设置页手动执行导入，应用启动时不会自动同步 Codex 文件。

## 环境要求

- **Node.js** >= 18
- **Rust**（stable 工具链）- 用于构建原生模块
- **Cargo** - 随 Rust 一起安装

### 平台特定要求

- **macOS**: Xcode Command Line Tools
- **Windows**: Visual Studio Build Tools（C++ 工作负载）
- **Linux**: `build-essential`、`pkg-config` 和系统级 SQLite（或使用内置版本）

## 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

以开发模式启动 Electron 应用，支持热模块替换（HMR）。

### 构建

```bash
npm run build
```

编译 Rust 原生模块并通过 electron-vite 打包 Electron 应用。

### 打包

```bash
npm run build:app
```

构建应用并通过 electron-builder 生成可分发包，输出目录为 `release/`。

### 类型检查

```bash
npm run check
```

同时执行 TypeScript 类型检查（`tsc --noEmit`）和 Rust 检查（`cargo check`）。

## 可用脚本

| 脚本                 | 说明                           |
| -------------------- | ------------------------------ |
| `npm run dev`        | 启动开发服务器（支持 HMR）     |
| `npm run build`      | 构建 Rust 原生模块 + Vite 打包 |
| `npm run build:app`  | 构建 + 生成可分发包            |
| `npm run build:rust` | 仅构建 Rust 原生模块           |
| `npm run check`      | TypeScript + Rust 类型检查     |
| `npm run check:ts`   | 仅 TypeScript 类型检查         |
| `npm run preview`    | 预览生产构建                   |

## 原生模块

Rust 原生模块（`snow_native`）通过 napi-rs 编译为 Node 插件（`.node`），提供以下能力：

- **AI API 流式传输** - 通过 reqwest 和供应商协议适配层实现异步流式响应，统一支持 OpenAI Chat/Responses、Anthropic 与 Gemini 协议
- **SQLite 存储** - 通过 rusqlite 嵌入式数据库，用于存储设置和聊天记录
- **文件监控** - 通过 `notify` crate 实现文件系统监听
- **HTTP 客户端** - 通过 reqwest 实现全功能 HTTP 客户端，支持压缩
- **MCP 协议** - 模型上下文协议实现

## 友情链接

* [Linux DO](https://linux.do)

## 开源协议

[MIT](./LICENSE) - Copyright (c) 2026 MayMay
