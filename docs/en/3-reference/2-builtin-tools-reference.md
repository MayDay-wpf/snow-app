# 2-builtin-tools-reference

Snow App ships with a set of built-in MCP tools that let the AI agent perform file operations, terminal commands, web search, browser automation, and more. This article lists all built-in servers and tools.

## 1. Tool Naming Convention

Built-in tool full names follow the pattern `{server-id}-{tool-name}`, e.g. `filesystem-read`. Some server IDs contain `-` (e.g. `user-interaction`); when resolving the tool name, the built-in server list is used for **longest-prefix matching** to disambiguate.

## 2. Server Overview

Listed in registration order:

| Server ID          | Description                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filesystem`       | Local file read/write (read / replace_edit / create)                                                                                                                                                                                               |
| `bash`             | Terminal command execution                                                                                                                                                                                                                         |
| `todo`             | Session task list management                                                                                                                                                                                                                       |
| `grep`             | File content search (ripgrep)                                                                                                                                                                                                                      |
| `websearch`        | Web search and page fetching                                                                                                                                                                                                                       |
| `browser`          | Built-in browser automation (embedded Electron browser)                                                                                                                                                                                            |
| `user-interaction` | Ask the user questions (blocking interaction)                                                                                                                                                                                                      |
| `sub-agents`       | Activate sub-agents to run tasks independently                                                                                                                                                                                                     |
| `codebase`         | Codebase semantic search (embedding index; **only exposed when the project has codebase indexing enabled and an index has been built**)                                                                                                             |
| `codelens`         | Code diagnostics and symbol location                                                                                                                                                                                                               |
| `app-control`      | App control (memos / modes / settings pages / scheduled tasks / projects)                                                                                                                                                                          |
| `config`           | Read/write global config (files: settings/snowcfg/proxy/app/custom-headers/system-prompt/theme/language/permissions/lsp-config/buddy/personalization; database: subAgents/hooks/imagegen; delegated: skills; read-only: logs)                     |
| `terminal`         | Terminal automation (persistent PTY session tabs, unlike bash's one-shot commands)                                                                                                                                                                 |
| `imagegen`         | AI image generation & editing (OpenAI / Gemini multiple channels; **hidden on demand when no channel is configured**)                                                                                                                              |
| `skills`           | Skill loading and execution (**dynamically registered**: hidden from the tool list when no enabled skill exists)                                                                                                                                   |

## 3. Tool Details

### filesystem

| Full tool name            | Purpose                                                     | Key parameters                                              |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `filesystem-read`         | Read file content (supports text, images, Office documents) | `filePath`, `startLine`, `endLine`                          |
| `filesystem-replace_edit` | Fuzzy search-and-replace editing                            | `filePath`, `searchContent`, `replaceContent`, `occurrence` |
| `filesystem-create`       | Create a new file (auto-creates parent directories)         | `filePath`, `content`, `overwrite`, `encoding`                          |

### bash

| Full tool name          | Purpose                                                           | Key parameters                                                                                    |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `bash-terminal-execute` | Execute terminal commands (build, test, package management, etc.) | `command`, `description`, `workingDirectory`, `timeout`, `detach`, `isInteractive`, `sessionId`   |

> **Shell source**: Commands ALWAYS run in the shell configured in Terminal
> settings; when unset, the auto-detected default terminal is used (Windows:
> PowerShell → CMD → Git Bash → COMSPEC). This tool does not accept a
> `shellPath` parameter — use `terminal-open` to open an interactive
> terminal with a specific shell.

### todo

| Full tool name     | Purpose                             | Key parameters                                                   |
| ------------------ | ----------------------------------- | ---------------------------------------------------------------- |
| `todo-todo-manage` | Session task list management (CRUD) | `action`, `content`, `sessionId`, `status`, `todoId`, `parentId` |

### grep

| Full tool name | Purpose                           | Key parameters                                                          |
| -------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `grep-search`  | Search file contents with ripgrep | `pattern`, `path`, `fileGlob`, `caseSensitive`, `isRegex`, `maxResults` |

### websearch

| Full tool name               | Purpose                                                   | Key parameters                                    |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `websearch-websearch-search` | Web search, returns a list of results                     | `query`, `maxResults`                             |
| `websearch-websearch-fetch`  | Fetch and read the full content of a web page or an image | `url`, `maxLength`, `isUserProvided`, `enableAiSummary`, `userQuery` |

### browser

| Full tool name       | Purpose                                                                                                  | Key parameters                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `browser-create`     | Create an embedded browser instance                                                                      | `url`                                                                |
| `browser-navigate`   | Navigate to the specified URL                                                                            | `url`, `timeoutMs`, `instanceId`                                     |
| `browser-click`      | Click page elements with real mouse events (CSS selector / visible text / accessibility ref)            | `selector`, `text`, `ref`, `exact`, `instanceId`                     |
| `browser-evaluate`   | Evaluate arbitrary JavaScript in the page and return the result                                          | `expression`, `instanceId`                                           |
| `browser-type`       | Type text into an element (set at once or key by key; ref targeting supported)                           | `selector`/`text`/`ref`, `value`, `submit`, `delayMs`, `instanceId`  |
| `browser-wait`       | Wait for text/element to appear or disappear, or a fixed duration (essential for SPA async rendering)                | `text`, `textGone`, `selector`, `selectorGone`, `time` (ms, 100-30000), `timeoutMs`, `instanceId` |
| `browser-press_key`  | Press a keyboard key or combination (Enter/Tab/Escape/arrows, `Ctrl+A`-style)                             | `key`, `instanceId`                                                   |
| `browser-select_option` | Select option(s) in a dropdown (match by value or label; exact text matching supported)               | `selector`/`text`, `values`, `exact`, `instanceId`                    |
| `browser-hover`      | Hover an element (real mouse move, triggers hover overlays)                                               | `selector`/`text`, `exact`, `instanceId`                              |
| `browser-upload-file` | Upload file(s) to a file input (CDP injection, no file chooser dialog)                                  | `selector`/`text`/`ref`, `files`, `instanceId`                       |
| `browser-back`       | Go back in browser history and wait for navigation                                                        | `instanceId`                                                         |
| `browser-forward`    | Go forward in browser history and wait for navigation                                                     | `instanceId`                                                         |
| `browser-navigate_back` | Go back to the previous page in the browser history (no navigation wait)                               | `instanceId`                                                         |
| `browser-navigate_forward` | Go forward to the next page in the browser history (no navigation wait)                             | `instanceId`                                                         |
| `browser-screenshot` | Capture the page as PNG                                                                                  | `fullPage`, `instanceId`                                             |
| `browser-devtools`   | Text/accessibility-tree snapshot (ax, ref-addressable) / performance trace / console messages / network requests & details / offline simulation / route mocking / encrypted login-state save & restore / cookie management / dialog handling / open DevTools | `action`, `verbose`, `maxNodes`, `durationMs`, `level`, `filter`, `limit`, `requestId`, `state`, `pattern`, `fileName`, `domain`, `showValues`, `name`, `dialogResponse`, `instanceId` |
| `browser-close`      | Close a browser tab                                                                                      | `instanceId`                                                         |
| `browser-focus`      | Switch to the specified tab                                                                              | `instanceId`                                                         |
| `browser-list`       | List all open tabs                                                                                       | —                                                                    |

### user-interaction

| Full tool name                     | Purpose                                                              | Key parameters        |
| ---------------------------------- | -------------------------------------------------------------------- | --------------------- |
| `user-interaction-askUserQuestion` | Ask the user a question (blocking interaction; must be called alone) | `question`, `options` |

### sub-agents

| Full tool name        | Purpose                                          | Key parameters      |
| --------------------- | ------------------------------------------------ | ------------------- |
| `sub-agents-activate` | Activate a sub-agent to run a task independently | `agentId`, `prompt` |

### codebase

| Full tool name    | Purpose                                                                                                                                       | Key parameters                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `codebase-search` | Codebase semantic search (embedding index based); **only exposed when the project has codebase indexing enabled and an index has been built** | `query` (required), `topN` (default 10, max 50) |

### codelens

| Full tool name             | Purpose                                              | Key parameters               |
| -------------------------- | ---------------------------------------------------- | ---------------------------- |
| `codelens-find_definition` | Find a symbol's definition location                  | `filePath`, `line`, `column` |
| `codelens-find_references` | Find a symbol's reference locations                  | `filePath`, `line`, `column` |
| `codelens-file_outline`    | Get a file's symbol outline                          | `filePath`                   |

### app-control

| Full tool name                    | Purpose                                                               | Key parameters               |
| --------------------------------- | --------------------------------------------------------------------- | ---------------------------- |
| `app-control-createMemo`          | Create a memo (note)                                                  | `content`                    |
| `app-control-setMode`             | Enable/disable Plan Mode or Goal Mode                                 | `mode`, `enabled`            |
| `app-control-openSettings`        | Open the specified settings page                                      | `page`                       |
| `app-control-createScheduledTask` | Create a scheduled task                                               | `name`, `prompt`, `schedule` |
| `app-control-createProject`       | Create a project (workspace directory)                                | `name`, `parentPath`         |
| `app-control-requestApproval`     | Request user approval of the plan summary (only exposed in Plan Mode) | `planSummary`                |

### config

| Full tool name  | Purpose                                                                                                                                                                                                                                                              | Key parameters                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `config-list`   | List manageable scopes (settings/snowcfg/proxy/app/custom-headers/system-prompt/theme/language/permissions/lsp-config/buddy/subAgents/hooks/skills/logs/imagegen/personalization) and their keys; pass `scope` to inspect a single scope with current values (sensitive keys masked) | `scope`, `projectId`                 |
| `config-get`    | Read a key's value; sensitive keys (`apiKey`, `visionApiKey`, custom-header schemes, system-prompt prompts) are always masked; `subAgents`/`hooks` scopes read directly from the app database; `personalization` with `key=role` returns the full ~/.snow/ROLE.md rules text (null when the file does not exist)                                                                        | `scope`, `key`, `projectId`          |
| `config-set`    | Write a key (whitelist + type check + pre-write auto backup + atomic write, **the temporary backup is removed after a successful write**); `settings.mcpServers` auto-syncs to the app database and takes effect immediately; `subAgents`/`hooks`/`imagegen` scopes write directly to the app database and take effect immediately (same backup-then-cleanup behavior); `personalization` with `key=role` replaces the whole ~/.snow/ROLE.md file (value must be a string, takes effect in the next conversation) | `scope`, `key`, `value`, `projectId` |
| `config-delete` | Delete a key; **DESTRUCTIVE — requires `confirmed: true`, which may only be set after the caller has obtained explicit user approval via the `user-interaction` `askUserQuestion` tool; calls without it are rejected**; pre-write backup with cleanup after success. **`imagegen` delete clears ALL image generation channels (not just the named key)**; `skills` delete uninstalls the skill; `logs` delete removes a log file; `subAgents`/`hooks` scopes delete database records directly; `personalization` delete removes ~/.snow/ROLE.md (restores default rules) | `scope`, `key`, `confirmed`, `projectId` |

> **Safety mechanism (config-change protection)**: to prevent AI from
> accidentally modifying/deleting user configuration, the config tool
> enforces the following constraints —
> - **Delete confirmation**: `config-delete` must first be confirmed by the
>   user (`askUserQuestion`) and then called with `confirmed: true`; anything
>   else is rejected. `imagegen` delete **clears all channels** (not a single
>   key), so extra care is required.
> - **Pre-write backup**: `config-set` / `config-delete` automatically back up
>   the current value to `~/.snow/.config-backups/` before writing (both
>   file-backed and DB-backed scopes), as a temporary safety net during the
>   write; **the backup is removed after a successful verified write**, with a
>   per-file cap of 10 backups as a fallback for leftovers.
>
> **Structural validation**: `settings.codebase`, `custom-headers.schemes`,
> `system-prompt.prompts` and `lsp-config.servers` are deeply validated on
> write (known fields are type-checked one by one, e.g.
> `codebase.embedding.dimensions` must be a number) so an agent cannot corrupt
> nested fields; unknown fields are allowed through for forward compatibility.
>
> **Project-scoped settings**: passing `projectId` to the `settings` scope's
> `mcpServers` / `sensitiveCommands` reads/writes **project-level** config
> (app database, takes effect immediately, same source as the UI project
> settings): `mcpServers` is a full replace (value is
> `{name: {type,url,command,args,env,headers,enabled,timeoutMs}}`);
> `sensitiveCommands` is a full replace (value is an array of
> `{commandId, pattern, description, enabled}`; a commandId matching a global
> rule becomes an enabled override, others become project custom rules);
> all other keys reject `projectId` with a clear error.

File-backed scopes:

| Scope            | File                                     | Main keys                                                                                                                       |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `settings`       | `~/.snow/settings.json`                  | `mcpServers`, `codebase`, `sensitiveCommands`, `yoloMode`, `planMode`, ...                                                      |
| `snowcfg`        | `~/.snow/config.json` (`snowcfg` object) | `baseUrl`, `apiKey` (sensitive), `advancedModel`, `chatThinking`, `responsesReasoning`, `maxTokens`, ...                        |
| `proxy`          | `~/.snow/proxy-config.json`              | `enabled`, `host`, `port`, `searchEngine`, `browserPath`, `browserDebugPort`                                                    |
| `app`            | `~/.snow/active-profile.json`            | `activeProfile`                                                                                                                 |
| `custom-headers` | `~/.snow/custom-headers.json`            | `active`, `schemes` (sensitive — may contain Authorization headers)                                                             |
| `system-prompt`  | `~/.snow/system-prompt.json`             | `active`, `prompts` (sensitive — prompt body)                                                                                   |
| `theme`          | `~/.snow/theme.json`                     | `theme`, `simpleMode`, `diffOpacity`, `toolDisplayMode`, `thinkDisplayMode`, `subAgentDisplayMode`, `toolIcons`, `customColors` |
| `language`       | `~/.snow/language.json`                  | `language`                                                                                                                      |
| `permissions`    | `~/.snow/permissions.json`               | `alwaysApprovedTools`                                                                                                           |
| `lsp-config`     | `~/.snow/lsp-config.json`                | `schemaVersion`, `servers`                                                                                                      |
| `buddy`          | `~/.snow/buddy.json`                     | `version`, `companion`, `muted`                                                                                                 |
| `personalization` | `~/.snow/ROLE.md` (plain markdown, non-JSON) | `role` (global rules text; list returns length + preview, get returns the full text, set replaces the whole file, delete removes it to restore defaults) |

Database-backed scopes (write to the app SQLite database, same source as the UI settings panels, take effect immediately):

| Scope       | key                                                                                                                            | value                                                                                                                                                                                                                                                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subAgents` | `agentId`                                                                                                                      | `{name, description?, systemPrompt?, toolsJson?, configProfile?, model?}`                                                                                                                                                                                                                                     | Create/update a sub-agent; `toolsJson` accepts a JSON string or an array of tool names; the built-in `agent_general` cannot be modified/deleted; omit `projectId` for global, provide it for project-scoped                                                                                                                                                                                                             |
| `hooks`     | `hookType`                                                                                                                     | `{rules: [{description, matcher?, hooks: [{type, command?, prompt?, content?, timeout?, enabled?}]}]}`                                                                                                                                                                                                | Configure lifecycle hooks; omit `projectId` for global, provide it for project-scoped (project overrides global)                                                                                                                                                                                                                                                                                                        |
| `imagegen`  | `openai` / `gemini` (omit key for all; without a key returns the full `{channels, maxConcurrentImages, timeoutSecs}` settings) | Channel fields: `{enabled, baseUrl?, apiKey?, model?, defaultSize?, defaultQuality?, outputFormat?, webSearch?, defaultStream?}`; top-level global fields `maxConcurrentImages` (max concurrent generations, 1–8) and `timeoutSecs` (per-request generation timeout in seconds, 60–3600, default 300) | Image-generation multi-channel settings (app database `system_settings` table, same source as the settings panel); `config-set` merges partial updates (omitted fields keep their previous values, and `maxConcurrentImages` / `timeoutSecs` are preserved unless explicitly provided); `apiKey` is always returned masked (e.g. `sk-e****7890`); `config-delete` hides the generation tool from the AI tool list again |

Delegated scope (reuses the skill-management service SkillsConfigService; storage semantics identical to the UI):

| Scope    | key       | value                                                        | Notes                                                                                                                                                                                                                                         |
| -------- | --------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills` | `skillId` | `{enabled}` toggles / `{url, location}` installs from GitHub | Global toggle rewrites the `enable` field in SKILL.md frontmatter; project toggle writes a DB `skill_overrides` record; install/uninstall operate on `~/.snow/skills` directories and `skills-registry.json`; `projectId` scopes to a project |

Read-only log scope (lets the agent self-diagnose app anomalies without a human reading logs):

| Scope  | key                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `logs` | Log file name (e.g. `2026-08-03-error.log`) or a level shortcut (`error`/`warn`/`info`/`debug` for today's file) | `config-list logs` lists all log files under `~/.snow/log` (newest first, with size/level) plus the latest error-file summary; `config-get logs` reads the file tail (optional `limit`, default 200, max 2000, ring-buffer avoids loading large files); `config-set logs` is read-only; `config-delete logs` only accepts an exact file name (path-traversal safe) |

> Configuration examples: see [2-guides/5-configure-hooks-and-subagents](../2-guides/5-configure-hooks-and-subagents.md).

### terminal

Manages terminal tabs in the right panel (persistent interactive PTY sessions
that stay alive across multiple calls), complementary to `bash-terminal-execute`
(single one-shot commands). Omitting `tabId` targets the most recently focused tab.

| Full tool name      | Purpose                                                                                                                  | Key parameters                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `terminal-open`     | Open a new terminal tab (persistent login-shell session; `cwd` defaults to the active project directory; `shellPath` defaults to the terminal settings or the system default)                 | `cwd`, `shellPath`                                            |
| `terminal-send`     | Send input to the terminal PTY (as if typed; a trailing newline is appended automatically if omitted)                    | `input` (required), `tabId`                                   |
| `terminal-read`     | Read the currently visible text of the terminal screen buffer (ANSI stripped; not the full scrollback)                   | `tabId`, `waitMs` (0-60000)                                   |
| `terminal-resize`   | Resize the terminal PTY dimensions (updates both the PTY process and the display)                                        | `cols` (1-500), `rows` (1-200), `tabId`                       |
| `terminal-wait`     | Wait for the terminal to become idle (no new output for a quiet period); detects long-running command completion         | `tabId`, `timeoutMs` (≥1000, default 30000), `idleMs` (100-5000) |
| `terminal-close`    | Close a terminal tab and kill its PTY process                                                                            | `tabId`                                                       |
| `terminal-focus`    | Switch to (activate) the specified terminal tab                                                                          | `tabId` (required)                                            |
| `terminal-list`     | List all open terminal tabs (id, title, working directory, active state)                                                 | —                                                             |

### imagegen

| Full tool name      | Purpose                                                                                                                                                                                                         | Key parameters                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `imagegen-generate` | Text-to-image / image-to-image editing (OpenAI + Gemini Nano Banana multiple channels, independent from the conversation API config; **hidden from the AI tool list when no channel is configured**) | see the 20-parameter table below |

`imagegen-generate` full parameters:

| Param               | Type              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`            | string (required) | Generation description, or the edit instruction when reference images are provided (**one call = one image**; for several images fire multiple parallel calls)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `prompts`           | array             | **Legacy, not recommended**: a different prompt per image `["prompt 1", "prompt 2", ...]` (1-8 items; overrides `n`). To generate a whole set of DIFFERENT designs, fire **multiple parallel calls** (one call per image with its own single `prompt`) instead of packing prompts into one call                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `images`            | array             | Reference images `[{data, mimeType}]` (base64 without the `data:` prefix; prefixed data URLs are accepted) or `[{path, mimeType}]`. A `path` may be a trusted absolute disk path or a safe `upload/...` relative path from a `[Reference image #N for imagegen-generate: ...]` block. Relative paths must start with `upload/` and may not traverse with `..`; the server reads and encodes the file, so no large base64 copy is needed. Used for editing; the runtime limit is **14 images per group** with about 20 MiB of encoded data per image (the tool description recommends ≤5 only for stricter provider compatibility); OpenAI uses `/images/edits`, Gemini uses `inlineData`; ignored when `requestImages` is present |
| `requestImages`     | array             | **Legacy, not recommended**: a different reference-image group per request `[[group 1...], [group 2...], ...]` (each group shaped like `images`), group count must equal the request count (= `prompts` length or `n`, 1-8). To restyle several source images, fire **multiple parallel calls** (one call per source image with its own `images` group) instead; omitted → all requests share the top-level `images` group                                                                                                                                                                                                                                                                                                                                                                |
| `model`             | string            | Override the configured model; OpenAI: `gpt-image-1`/`gpt-image-2`/`dall-e-3`; Gemini: `gemini-3.1-flash-image` (Nano Banana 2)/`gemini-3.1-flash-lite-image` (Lite)/`gemini-3-pro-image` (Pro)/`gemini-2.5-flash-image` (legacy). **Capability rules (a 400 is returned for unsupported requests)**: `dall-e-3` is text-to-image only (no reference images) and always generates exactly 1 image; `imagen-*` models are text-to-image only too                                                                                                                                                                                                                                                     |
| `provider`          | enum              | `auto` (default, derived from config) / `openai` / `gemini`, backend override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `size`              | string            | OpenAI: `1024x1024`, `1024x1536`, `1536x1024`, etc.; Gemini: `1K`/`2K`/`4K` (imageSize) or `16:9`, `1:1`, `9:16`, etc. (aspectRatio)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `quality`           | enum              | `low` / `medium` / `high` / `auto`; OpenAI gpt-image models only, Gemini accepts `low`/`medium`/`high` only (`auto` is ignored)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `outputFormat`      | enum              | OpenAI: `png` (default) / `jpeg` / `webp`; ignored for dall-e and Gemini                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `outputCompression` | number            | OpenAI JPEG/WebP compression 0-100                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `n`                 | number            | **Legacy, not recommended** for multiple images: 1-8 (default 1). To generate several images, fire **multiple parallel calls** (one call per image) instead of raising `n`; kept for backward compatibility only — n>1 fans out to n **concurrent sub-requests** of the SAME prompt (one image each — relays/upstreams reject n>1 in a single request), returns the whole batch at once and persists every image into the image library; streaming preview is disabled when n>1; `dall-e-3` always returns 1; passing `prompts` sets the request count from its length |
| `personGeneration`  | enum              | Gemini: `dont_allow` (default) / `allow_all` / `allow_adult`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `webSearch`         | boolean           | Gemini Google Search grounding, defaults to the setting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `stream`            | boolean           | Streaming preview (OpenAI `partial_images` SSE / Gemini `streamGenerateContent`), defaults to the setting; ignored for dall-e and image edits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `inputFidelity`     | enum              | OpenAI edit fidelity: `low` / `high` / `auto` (default); not supported by `gpt-image-2` (always high)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `background`        | enum              | OpenAI: `opaque` (default) / `transparent` / `auto`; transparency needs model support (automatically falls back to `opaque` on models like `gpt-image-2` that lack it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `moderation`        | enum              | OpenAI: `auto` (default) / `low` (less restrictive filtering)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `seed`              | number            | Deterministic seed for reproducible results                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `thinkingLevel`     | enum              | Gemini 3.1 Flash Image: `minimal` (default, faster) / `high` (better quality, slower)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `imageSearch`       | boolean           | Gemini 3.1 Flash Image: Google Image Search grounding (requires displaying search suggestions)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

> **Configuration & exposure rules**: a channel is usable only when
> `enabled` + `apiKey` + `model` are all present; any number of channels can
> be enabled at once and the AI picks one per request (when unspecified, the
> first usable channel in order is used; pass `provider` to pick explicitly);
> when none is configured, `imagegen-generate` is hidden from the model tool
> list. Unsupported model capabilities are validated **before** the request is
> sent (`dall-e-3`/`imagen-*` reference images are rejected locally with a
> switch-model hint; `dall-e-3` `n` is clamped to 1), and any provider 400 that
> still occurs is annotated with a concrete fix hint (image count / image
> input / size / quality). Multiple-image generation is done via **parallel
> separate calls** (one call = one image), bounded by **Max concurrent
> generations** in the settings (1–8, default 4); excess requests queue up
> and start as one finishes. The `n` / `prompts` / `requestImages` parameters
> are kept for backward compatibility only and are not recommended.
> GUI configuration: [2-guides/9-image-generation](../2-guides/9-image-generation.md);
> the `config` tool's `imagegen` scope reads/writes the same settings (apiKey masked).
> **Imagen deprecated**: `imagen-*` models shut down 2026-08-17 — use the Nano
> Banana family.

### skills

| Full tool name         | Purpose                              | Key parameters |
| ---------------------- | ------------------------------------ | -------------- |
| `skills-skill-execute` | Load and execute the specified skill | `skill`        |

> Note: the frontmatter field that controls the toggle is `enable` (not `enabled`).
> The former `skills-config-*` tools (list/setEnabled/installGithub/uninstall)
> have been removed; skill management now uses the `config` server's `skills`
> scope exclusively (see above).
>
> The `skills` server is **dynamically registered**: `skills-skill-execute`
> appears in the tool list only when at least one enabled skill exists under
> `~/.snow/skills` or the project's `.snow/skills`; it disappears automatically
> when all skills are disabled/uninstalled.

## 4. Special Notes

**Valid values for the `page` parameter of `app-control-openSettings`:**

| page value                    | Corresponding settings page |
| ----------------------------- | --------------------------- |
| `api-settings`                | API Settings                |
| `imagegen-settings`           | Image Generation            |
| `image-library`               | Image Library               |
| `proxy-browser-settings`      | Proxy & Browser             |
| `codebase-settings`           | Codebase Settings           |
| `system-prompt-settings`      | System Prompts              |
| `personalization-settings`    | Personalization             |
| `custom-headers-settings`     | Custom Headers              |
| `mcp-settings`                | MCP Settings                |
| `import-settings`             | Import                      |
| `skills-settings`             | Skills Settings             |
| `sub-agent-settings`          | Sub-Agent Settings          |
| `sensitive-command-settings`  | Sensitive Commands          |
| `hooks-settings`              | Hooks Settings              |
| `theme-settings`              | Theme Settings              |
| `terminal-settings`           | Terminal Settings           |
| `keyboard-shortcuts-settings` | Keyboard Shortcuts          |
| `privacy-settings`            | Privacy Settings            |
| `usage-settings`              | Usage Settings              |
| `system-logs`                 | System Logs                 |

**Other notes:**

- `app-control-requestApproval` is only exposed when Plan Mode is enabled;
- `skills-skill-execute` dynamically loads enabled skills from `~/.snow/skills` and the project's `.snow/skills`.

## 5. Difference from External MCP Tools

External MCP server tools are added by the user in **MCP Settings** (see [2-guides/1-configure-mcp](../2-guides/1-configure-mcp.md)); their tool names are prefixed with the server name (e.g. `dbx-search_context`), distinguishing them from built-in tools via prefix matching against the built-in server list.
