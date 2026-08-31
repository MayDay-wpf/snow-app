# Snow App

> [!WARNING] > **macOS Users:** If the app shows "damaged" or "cannot be opened" after installation, run the following command in Terminal:
>
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/Snow\ App.app
> ```
>
> You will be prompted to enter your login password to remove the quarantine attribute.

> High-performance cross-platform desktop application powered by Electron, React, TypeScript, and Rust.

[中文文档](./README_zh.md)

## Overview

Snow App is a developer-focused desktop application that integrates AI-powered chat, terminal emulation, SSH remote management, Git tooling, and a built-in browser panel into a single unified workspace. It leverages a Rust native module for performance-critical operations such as SQLite storage, AI streaming, file watching, and HTTP requests.

<img width="1525" height="1058" alt="image" src="https://github.com/user-attachments/assets/343e09f8-e085-4a2b-99ca-011e244460f0" />


## Features

- **AI Chat** - Streaming AI assistant with markdown rendering, syntax highlighting, and configurable system prompts
- **Integrated Terminal** - Full PTY-based terminal emulation powered by node-pty and xterm.js
- **SSH Management** - Connect to and manage remote servers via SSH with credential persistence
- **Git Panel** - Visual Git diff viewer and repository management
- **Browser Panel** - Built-in browser with proxy support, network inspection, login-state management, and AI-driven automation
- **MCP Support** - Model Context Protocol integration for extensible AI tooling
- **AI Image Generation** - Built-in text-to-image / image editing (OpenAI / Gemini multi-channel); generated images are persisted into an image library
- **Skills System** - Install / enable / manage AI skills (SKILL.md) that dynamically extend the agent
- **Hooks** - Lifecycle hooks that run custom commands or prompts before/after events like requests and compression
- **Sub-Agents** - Independent AI execution loops for parallel, complex multi-step tasks
- **Codebase Semantic Search** - Embedding-index-based code search plus multi-language code symbol location (codelens)
- **Plan / Goal Modes** - Plan-first and autonomous long-running task execution modes
- **Interactive Terminal Sessions** - The AI can drive persistent PTY sessions for long-running and interactive commands
- **Codebase Explorer** - Project file tree with workspace directory management
- **Config Import** - Import MCP servers, skills, plugins, and prompts from Codex / WSL / SSH environments
- **i18n** - Multi-language support with a locale system
- **Settings Management** - Granular configuration for API keys, custom headers, proxy, sensitive commands, and more
- **Cross-Platform** - Runs on macOS, Windows, and Linux

## Tech Stack

| Layer     | Technology                                    |
| --------- | --------------------------------------------- |
| Shell     | Electron 37                                   |
| Frontend  | React 19, TypeScript 5.9                      |
| Bundler   | electron-vite 4 (Vite 7)                        |
| Native    | Rust 2021 Edition (napi-rs 3)                 |
| Packaging | electron-builder 26                           |
| Terminal  | node-pty, xterm.js 6                          |
| SSH       | ssh2                                          |
| Storage   | rusqlite (SQLite, bundled)                    |
| AI/HTTP   | reqwest (multi-provider protocol adapters and streaming HTTP) |
| Markdown  | markdown-it, streaming-markdown, highlight.js |
| Icons     | lucide-react                                  |

## Project Structure

```
snow-app/
├── src/
│   ├── main/            # Electron main process
│   │   ├── app/         # Application bootstrap & window management
│   │   ├── codex/       # Codex compatibility import layer
│   │   │   └── importer.ts # Manual settings import for MCP, Skills, Plugins, and prompts
│   │   ├── importConfig/ # Third-party config import (reversible transaction + environment discovery)
│   │   ├── ipc/         # IPC handler registration
│   │   ├── native/      # Rust native bridge (storageReady gate)
│   │   ├── notification/ # System notifications
│   │   ├── plugins/     # Plugin runtime (isolated workers)
│   │   ├── pty/         # PTY & terminal management
│   │   ├── settings/    # Configuration stores
│   │   ├── snowCli/     # CLI path & profile management
│   │   ├── ssh/         # SSH connection management
│   │   ├── types/       # Shared types
│   │   ├── updater/     # App updates
│   │   └── utils/       # Shared utilities
│   ├── preload/         # Electron preload script (window.snow.* allowlist)
│   ├── renderer/        # React frontend
│   │   ├── components/  # UI components (sidebar, main content, right panel)
│   │   ├── hooks/       # Custom React hooks
│   │   ├── i18n/        # Internationalization
│   │   └── utils/       # Frontend utilities
│   └── shared/          # Code shared between main & renderer
├── native/              # Rust native module
│   └── src/
│       ├── api/         # AI API integration
│       ├── exports/     # napi-rs export bindings
│       ├── hooks/       # Lifecycle hook execution
│       ├── mcp/         # MCP protocol implementation (built-in servers + external client)
│       ├── prompt/      # System prompt handling (incl. Plan/Goal modes)
│       └── storage/     # SQLite persistence
├── scripts/             # Build & utility scripts
├── resources/           # App icons & static assets
└── electron.vite.config.ts
```

Codex compatibility imports are started manually from the Codex compatibility
entry in Settings; the app does not synchronize Codex files during startup.

## Prerequisites

- **Node.js** >= 18
- **Rust** (stable toolchain) - required for building the native module
- **Cargo** - comes with Rust

### Platform-Specific

- **macOS**: Xcode Command Line Tools
- **Windows**: Visual Studio Build Tools (C++ workload)
- **Linux**: `build-essential`, `pkg-config`, and system SQLite (or use bundled)

## Getting Started

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

This starts the Electron app in development mode with hot module replacement.

### Build

```bash
npm run build
```

This compiles the Rust native module and bundles the Electron application via electron-vite.

### Package

```bash
npm run build:app
```

This builds the app and produces a distributable package via electron-builder. Output is written to `release/`.

### Type Checking

```bash
npm run check
```

Runs both TypeScript type checking (`tsc --noEmit`) and Rust checking (`cargo check`).

## Available Scripts

| Script               | Description                            |
| -------------------- | -------------------------------------- |
| `npm run dev`        | Start development server with HMR      |
| `npm run build`      | Build Rust native module + Vite bundle |
| `npm run build:app`  | Build + create distributable package   |
| `npm run build:rust` | Build only the Rust native module      |
| `npm run check`      | TypeScript + Rust type checking        |
| `npm run check:ts`   | TypeScript type checking only          |
| `npm run preview`    | Preview the production build           |

## Native Module

The Rust native module (`snow_native`) is compiled to a Node addon (`.node`) via napi-rs. It provides:

- **AI API streaming** - Async streaming via reqwest and provider adapters for OpenAI Chat/Responses, Anthropic, and Gemini protocols
- **SQLite storage** - Embedded database via rusqlite for settings and chat history
- **File watching** - File system monitoring via the `notify` crate
- **HTTP client** - Full-featured HTTP client via reqwest with compression support
- **MCP protocol** - Model Context Protocol implementation

## Friendly links

* [Linux DO](https://linux.do)

## License

[MIT](./LICENSE) - Copyright (c) 2026 MayMay
