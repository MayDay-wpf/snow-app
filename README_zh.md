<p align="center">
  <img src="./assets/readme/zh/hero.png" width="100%" alt="Snow App：桌面编码 Agent，能读代码、改文件、执行命令并验证结果">
</p>

<p align="center">
  <a href="https://github.com/MayDay-wpf/snow-app/releases"><img src="https://img.shields.io/github/v/release/MayDay-wpf/snow-app?label=release&color=3b82f6" alt="最新版本"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-73afd1" alt="支持平台">
  <img src="https://img.shields.io/badge/license-MIT-111827" alt="MIT license">
</p>

<p align="center">
  QQ 群：<a href="https://qm.qq.com/q/avnZQ7gw0M">910298558</a>
  &nbsp;·&nbsp;
  友情链接：<a href="https://linux.do">Linux DO</a>
</p>

Snow App 是一个桌面编码 Agent：你描述任务，它自己读代码、改文件、执行命令、查看诊断并验证结果。它使用的终端、Git、SSH、浏览器和文件树都摆在同一个窗口里，每一处改动都能当场审阅、授权和回滚。

[English](./README.md)

## 安装后长什么样

<p align="center">
  <img src="./assets/readme/screenshots/desktop-annotated.png" width="100%" alt="Snow App 三栏结构标注：侧边栏用于会话与项目，中间是编码 Agent 的会话与工具调用，右侧面板是 Agent 使用的浏览器、终端与 Git">
</p>

## 从搬运上下文到 Agent 自己动手

<p align="center">
  <img src="./assets/readme/zh/before-after.svg" width="100%" alt="使用前在终端、SSH 客户端、Git GUI、浏览器与网页版 AI 对话之间搬运上下文；使用后编码 Agent 在同一个窗口里读代码、改文件、执行命令">
</p>

## 一个编码 Agent 的工作台

<p align="center">
  <img src="./assets/readme/zh/features-workspace.svg" width="100%" alt="Snow App 编码 Agent 工作台：编码会话、文件读写、集成终端、代码库检索、LSP 诊断、Git 面板、SSH 远程工作区与内置浏览器">
</p>

这些面板不是并排的工具，而是 Agent 的感官和手脚：终端输出、浏览器页面、Git 状态与代码诊断都在同一份会话上下文里，不需要你在几个工具之间复制粘贴。

## 编码能力与扩展

<p align="center">
  <img src="./assets/readme/zh/features-agent.svg" width="100%" alt="Snow App 编码 Agent 的能力与扩展：编码循环、Skills 技能、MCP 服务器、子代理、Goal 模式、定时任务与工作流、项目记忆、团队协作">
</p>

编码循环之外，技能、MCP 服务器与子代理都可以按需接入；定时任务支持多节点工作流，项目记忆按项目持久保存并自动注入。

## 扩展 Agent，也承接内容

<p align="center">
  <img src="./assets/readme/zh/features-extend.svg" width="100%" alt="Snow App 扩展与内容：插件与市场、用户脚本、自定义命令、请求代理层、Hooks、仓库 Wiki、绘图工作台、图像库">
</p>

插件、用户脚本和请求代理层能改写 Agent 的界面与请求本身；仓库 Wiki、绘图工作台和图像库让内容产出也留在同一个会话里。

## 安全与体验

<p align="center">
  <img src="./assets/readme/zh/features-security.svg" width="100%" alt="Snow App 安全与体验：应用锁、工具授权、隐私脱敏、检查点与回滚、用量与日志、主题与个性化、手机远控、桌面宠物">
</p>

工具授权与隐私脱敏决定 AI 能做什么、能看到什么；应用锁默认关闭，只遮盖界面而不加密磁盘数据，PIN 仅保存加盐哈希。

## 手机上继续

<p align="center">
  <img src="./assets/readme/screenshots/mobile-pair.png" width="640" alt="Snow App 手机远控：左侧为对话与流式输出，右侧为操作、模式与授权">
</p>

在「设置 → 手机远控」完成配对后，可以用手机浏览器继续当前会话：切换工作区与模型、审批工具、回答问题、发送图片与文件。局域网模式不依赖云服务；可选的公网模式使用自建的 TLS 鉴权隧道，支持一次性配对、会话撤销与敏感输出脱敏。详见[手机远控指南](docs/zh-CN/2-使用指南/23-手机公网远控.md)。

## 环境与启动

- **Node.js** >= 18
- **Rust** stable 工具链（构建原生模块）
- **macOS**：Xcode Command Line Tools ｜ **Windows**：Visual Studio Build Tools（C++ 工作负载）｜ **Linux**：`build-essential`、`pkg-config`

```bash
npm install
npm run dev        # 开发模式启动，带热更新
npm run build:app  # 打包可分发安装包，输出到 release/
```

> **macOS 用户注意**：如果安装后打开提示「已损坏」或「无法打开」，在终端执行：
>
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/Snow\ App.app
> ```

## 更多

- 完整文档：[docs/](./docs/README.md)
- 开源协议：[MIT](./LICENSE) · Copyright (c) 2026 MayMay
