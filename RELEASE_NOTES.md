# Release Notes

## v0.1.23

## New Features

- **API Settings Enhancements**: Gemini profiles gain a **Google search** option (`googleSearch` / `visionGoogleSearch`) that injects the Google Search tool for real-time web grounding; Responses profiles gain **Fast Mode** (`responsesFastMode`); the form validates fields per request method so invalid combinations cannot be submitted.
- **Per-Commit Diff Viewing**: The Git commit graph can expand a commit to list its files and show each file's diff **within that commit**; the file context menu opens the diff **in a new right-panel tab** (loading state first, then async fill) or copies the file path. Works for local and `ssh://` remote repositories.
- **Cross-Project Notification Aggregation**: The sidebar aggregates conversations from **other projects** that are streaming, need attention, or completed into a per-project notification block with status badges (including an attention-required indicator); clicking one jumps to that project and conversation.
- **Image Library Upgrades**: Album card wall default view; fuzzy search over file name/prompt/model/provider; batch mode (move into album / batch delete); manual multi-file import; drag-and-drop images onto album cards to classify.
- **Explorer Context Menu**: Right-click files/directories in the project explorer to open a terminal there, reveal in the system file manager, copy the path, or open the directory with an installed IDE (local entries only; SSH entries keep rename/delete/open).
- **Sub-Agent Conversation View**: A sub-agent session's header shows its **stage name** (prompt truncated at activation) and the launching main conversation; an info card above the messages shows the agent name badge, a jump-back-to-parent button, and the full delegated prompt.
- **Unified Terminal Shell Resolution**: One shell-resolution chain now serves the Git panel (WSL scenarios) and the integrated terminal; non-empty `shellPath` is validated at save time and `terminal-open` rejects missing shell paths instead of silently falling back.
- **Bash Execution Timings**: Every `bash` tool execution logs phase timings (argument parse, sensitive check, remote dispatch, shell resolve, spawn, first output, process wait, pipe drain, total) to the app log with the tool execution id.

## Improvements

- **Checkpoint Capture**: Git-driven `git worktree` capture replaces full-tree traversal/copy, eliminating the serial bottleneck; gitignore matching now honors subdirectory rules and `info/exclude`.
- **Main Process ESM**: `__dirname`/`__filename` replaced with `import.meta.dirname`/`import.meta.filename` (constants, mainWindow, nativeBridge, plugin runtime, discovery worker).
- **Sub-Agent Execution Chain**: Optimized activation/cancellation flow and updated docs.
- **Navigation Safety**: Renderer link/path clicks are intercepted on `auxclick` as well as `click`, and the main process blocks out-of-app `will-navigate` — Ctrl/Cmd+clicking a link can no longer reload the whole frontend and kill in-flight generations.

## Bug Fixes

- Ctrl/Cmd+click on a message link no longer navigates the current window (frontend reload) and stops streaming/generation previews; links now open in the app browser panel.
- ImageGen settings toggles were invisible due to a slider class-name mismatch; the class names are aligned.
- Responses API failed terminal events are handled correctly (event/stream/retry paths).
- The Git tab stays visible when it is the only open tab.
- Chat deletion confirmation dialog is reused consistently (single/batch).

## v0.1.22

## New Features

- **Browser Credential Import**: Passwords and Cookies can be imported from Chrome/Edge/Chromium (macOS Keychain + PBKDF2/AES-128-CBC, Windows DPAPI + AES-256-GCM) and Firefox (SHA1 iteration + 3DES-CBC), including Chrome 133+ Cookie hash prefix stripping and SQLite WAL lock read-only fallback.
- **Password Vault**: Passwords are stored in an AES-256-GCM encrypted vault on disk, protected by the OS keychain; autofill IPC validates the sender frame origin to prevent cross-origin reads.
- **Webview Password Assistant**: Login forms are auto-filled and auto-saved via a dedicated preload (webview-browser entry).
- **Webview Popup Windows**: `window.open` / `target=_blank` now open real windows preserving the opener relationship (required for Google OAuth login).
- **Element Selector**: Select page elements to add as chips to the chat input, with notes and real-time style editing preview; elements auto-expand into readable descriptions in messages.
- **Browser Settings Panel**: Configure the start page, manage passwords (search/show-hide/delete), and import passwords/Cookies from local browsers.
- **Model Search**: The model dropdown now supports filtering long model lists by model id or owner.
- **Requested Model Persistence**: The model the user requested is now persisted across Anthropic, Chat Completions, Gemini, and Responses paths — provider-echoed date-stamped or aliased model names no longer overwrite the model shown in the chat input.
- **Dialog Close Button**: Form dialogs get a localized close button in the header; overlay click-to-close was removed to prevent accidental dismissals.

## Improvements

- **Chat Scrolling**: The chat stays pinned to the bottom during async rendering of historical messages and no longer auto-snaps after the session ends; chip hover detail preview added; cancelling a project add returns to the parent level.
- **Metric Breakpoints**: Container query breakpoints recalibrated to measured widths so metrics are neither hidden early nor overflow.
- **Cookie Restore**: Domain Cookies explicitly pass their domain so subdomains share login state; SameSite=None non-Secure cookies are downgraded to ensure they can be written.

## Bug Fixes

- **Stream Disconnect Retry**: When a streaming response disconnects mid-stream with zero output, the request is now automatically retried with exponential backoff (3s→30s, up to 5 times) across all four protocols (chat/anthropic/responses/gemini) with a visible retry indicator; exhausted retries return an explicit error instead of a silent empty reply. Streams with partial output stay `incomplete` to avoid duplicated content.
- **MCP Handshake**: Added a discover probe timeout and fallback to the legacy `initialize` handshake for silent old-SDK servers.
- **Sensitive Command Rule**: The preset `rm` rule now uses word boundaries so substrings like `arm64`, `warm`, or `--rm` are no longer flagged; existing preset rows are migrated.
- **ImageGen Compile Fix**: Fixed missing commas in three `json!` macros in `imagegen.rs`.
- **Native Bridge Fallback**: Missing `browserImport*` methods added to the fallback native bridge so non-Rust runtimes fail with a clear error.

## v0.1.21

## New Features

- **AI Code Review (`/review`)**: Review selected Git changes (staged, unstaged, or commits) with a read-only prompt. The prompt is base64-tagged (`@@review:...@@`) and rendered as a chip; Rust expands it for generation and session titles. Added `git:commit-diff` IPC backed by Rust and SSH.
- **Workspace Directory Management**: Right-click a workspace directory to rename or set it as the active directory (inline rename with Enter/Esc/on-blur commit). Directory add and project creation now use a generic FormDialog with drag-and-drop folder support.
- **IDE Detection**: Installed IDEs are detected on Windows/Linux/macOS and offered in an "Open with" submenu with real brand icons (VS Code, Cursor, JetBrains, …) and a lucide fallback.
- **SSH Improvements**: Connection errors are classified (network/timeout/auth/sftp/invalid/unknown) and localized; hosts can be imported from `~/.ssh/config` (with `~`/`%d` expansion) to prefill the connect wizard.
- **Terminal Session Identity**: Local processes (one-shot commands and persistent tabs) inherit the Snow session identity via `SNOW_SESSION_ID`, `TRELLIS_CONTEXT_ID`, `SNOW_CWD`, `SNOW_PLATFORM`, without overriding inherited values.
- **Tool Call Rendering**: Dedicated cards for skill / config / app-control / dbx tool calls; tool-name badges use stable category-based lucide icons and localized names (46 new i18n keys); DBX double-prefix normalization; ImageGen gallery drops columns in narrow containers.
- **Markdown Image Lightbox**: Clicking an image in a markdown reply opens a zoomed lightbox with download.
- **Database Recovery**: Corrupted SQLite databases are detected and automatically recovered at startup.
- **MCP**: JSON draft editing refactored to single-entry `{name: {...}}` mapping with lenient parsing (container + legacy formats); external tool calls retry once via a legacy initialize handshake on "Transport closed"; stdio stderr is forwarded to app logs.
- **Config Server**: New `personalization` scope for `~/.snow/ROLE.md`; config writes are pre-backed up and cleaned after success; `config-delete` requires explicit user confirmation.
- **Session Isolation**: Plan/Goal mode is strictly per-session — the global mode settings chain was removed entirely.
- **Agent Loop**: Compaction only runs when the loop will continue; `resume_after_compaction` prevents duplicate handoff after compaction; codelens refocused on symbol navigation (diagnose tool and semantic analyzers removed).
- **Hooks**: Sub-agent lifecycle hooks are bound to the tool card; execution results fill the chat width with structured action details and localized labels.

## Improvements

- **ImageGen**: Remote-URL results are downloaded and persisted to the image library; `n` accepts 1-8 via internal fan-out; per-request `prompts` / `requestImages`; gallery migration is staged (prepare/chunk/commit) with crash recovery and rollback.
- **Browser Automation**: Accessibility-tree snapshots (`action=ax`), network debugging (`networkDetails` / `networkState` / `route`), encrypted login-state save/restore, performance traces, and new interaction tools (`wait`, `press_key`, `select_option`, `hover`, `upload-file`, back/forward).
- **Browser**: MCP tool names unified with upstream style (`press_key`, `select_option`); `browser-wait` gains `selector`/`selectorGone`; `ref` targeting auto scrolls into view; click uses a real 50 ms press interval; webview context menu; detached DevTools windows are branded with the Snow icon and lifecycle-managed.
- Token tooltips show compact K/M/B units; Mermaid rendering recovers from import failures and retries on the next batch; conversation summaries follow the chat thinking configuration for reasoning effort; checkpoint diffs are cached to avoid repeated file reads.

## Bug Fixes

- `safeSend` IPC avoids renderer frame-release races; the window self-heals after a renderer crash.
- ESC no longer accidentally cancels the session when a command/file panel is open.
- Fixed `browser-type` selector syntax error; `openSettings` now accepts `imagegen-settings` / `image-library` pages.
- Completed 63 missing i18n keys across all locales.

## v0.1.20

## New Features

- **Browser MCP Tools**: Added `wait`, `press_key`, `hover`, `navigate_back`, `navigate_forward`, and `select_option` tools. DevTools extended with `network_detail` and `network_clear` actions, plus optional static resource filtering for network listings.
- **Multi-Environment Import Discovery**: Configuration and skill discovery now works across WSL distributions and SSH remote hosts. Unsupported stdio MCP servers are surfaced as candidates with reasons, remote skills are downloaded via SFTP, and per-environment source details are shown in the import settings UI.

## Improvements

- **Git Graph**: Commit graph now shows full decoration with ref badges and a visual HEAD marker with glow effect. Branch creation dropdown restructured.
- **Bash Kill Safety**: Cancellation and timeout branches now use `biased` select to guarantee stop requests aren't lost; Windows `taskkill` is bounded with immediate stream draining. UI guards against duplicate kill IPC calls and adds a renderer-side timeout watchdog.
- **Chat Auto-Scroll**: Scroll-state decoupled from geometric pinning to maintain follow mode during rapid content growth; wheel events intercepted early to honor user intent.
- **max_tokens Handling**: Updated `max_tokens` handling in Anthropic payload and file search agent; added hints in API settings.

## v0.1.19

## Bug Fixes

- Responses Request to resend the request repeatedly.

## v0.1.18

## New Features

- Added image generation feature
- Significantly reduced database usage
- Optimized first launch speed
- Scheduled tasks project isolation
- Input box supports dragging and dropping images and files from external sources
- Added copy function to configuration file
- Optimized UI display of some components

## v0.1.17

## New Features

- **Image-to-Image Editing with Reference Images**: Attached images are always
  used as references for image-to-image editing (OpenAI `/images/edits`
  multipart / Gemini `inlineData`). When the main model does not support
  vision, the textification pass (`api/vision.rs`) injects a
  `[Reference image #N for imagegen-generate: {"path": ..., "mimeType": ...}]`
  block per image — a small relative path under the upload/ directory instead
  of a huge base64 blob — plus an explicit guidance line telling the model to
  edit the attached images rather than regenerate from the description alone.
  `imagegen-generate` resolves `path` references itself (restricted to the
  upload/ directory, traversal rejected; server limit 14 images / ≤20MB each,
  tool description guides the model to ≤5). Reference thumbnails on the
  generation card show real images for both inline base64 and `path`
  references (read from disk via a new `images:resolve-upload-image` IPC
  channel, cached per session).
- **Imagegen Model Capability Validation & 400 Protection**: `imagegen-generate`
  now validates model capabilities before sending the request, so the most
  common provider 400 errors are prevented or self-healed: `dall-e-3` is
  text-to-image only (reference images are rejected with a clear
  switch-model hint) and always generates exactly 1 image (`n>1` is clamped);
  `imagen-*` models are text-to-image only as well. Upstream 400 responses are
  annotated with a concrete fix hint (image count / image input / size /
  quality), letting the agent retry correctly in one step, and the tool's
  `model` parameter description now documents the capability rules up front.
- **Max Concurrent Generations**: A global `maxConcurrentImages` setting
  (1–8, default 4, in Settings → Image generation and the `imagegen` config
  scope) caps how many generation requests run in parallel when the agent
  requests several images at once; the rest wait in a queue and a new one
  starts as soon as one finishes.
- **Per-Conversation Input Draft Persistence**: Draft text (including image
  chips) is saved per conversation and restored when switching back or
  creating a new chat, so input is never lost while the chat view reloads.
- **Image Library (Generated Image Management)**: Every generated image is
  now persisted to an `image/` folder next to the app installation directory
  (falls back to the storage directory when the install dir is read-only) and
  indexed in a new `image_library` table (model / provider / prompt / mime /
  size / dimensions / timestamp). Chat messages store the small `image/...`
  path reference instead of the huge base64 blob, so the database stops
  bloating. A new **Image library** panel (Settings sidebar) offers a
  filterable grid (ratio landscape/square/portrait, time range, provider,
  model) with click-to-zoom lightbox, per-image download, and delete —
  deleting an image physically removes the file, its index row, **and
  rewrites the referencing chat messages** (both `content` and `raw_json`) so
  conversations stay consistent. Historical base64 images keep rendering
  unchanged; if persistence fails the inline base64 fallback still works.
  When deleting a conversation, a dedicated **delete-confirmation modal**
  (single and batch delete alike) shows an **"also delete generated images"**
  checkbox when the selected conversations reference library images — ticking
  it cascade-deletes every library image referenced by those conversations
  (files + index rows) before the conversation goes away, while the note
  "uncheck to keep generated images in the image library" makes the default
  keep-behavior explicit.

## Improvements

- **Unified Delete-Confirmation Modal**: Conversation deletion now uses a
  dedicated modal (`ChatDeleteConfirmModal`) shared by single and batch
  delete — the inline confirmation view inside the item context menu and the
  batch-confirm bar were removed. When opened, the modal queries how many
  library images the selected conversations reference and, if any, shows an
  **"also delete generated images"** checkbox (default unchecked, with an
  explicit "uncheck to keep images in the library" note). Confirming runs a
  single unified path: optional cascade image deletion first, then
  conversation deletion (single delete keeps the sub-agent cascade abort /
  draft cleanup; batch stays one native transaction). Deleting is guarded by
  an in-flight state so the dialog cannot be dismissed or double-submitted.
- **Unified Gallery Layout for Parallel Image Generations**: Images from a
  single `imagegen-generate` call now share one row width — the gallery grid
  sizes its columns to the batch so it reads as one cohesive block that fills
  the message width instead of ragged auto-fill columns: 2–4 images share a
  single row, 5–6 use three columns over two rows, 7–8 use four columns over
  two rows (no lone tail image). Card aspect ratio follows the real
  generated-image ratio (median of the batch): ultra-wide images span the
  full row and ultra-tall ones are height-capped so extreme aspect ratios
  stay pleasant. The per-card frame and download/label chrome was removed in
  favor of a clean image with a subtle index badge and click-to-zoom; the
  download action now lives in the lightbox only.
- **Image Generation Settings Panel (aligned with the API settings panel)**:
  channel rows no longer show redundant provider icons, the provider dropdown
  uses the shared `CustomSelect` component, and the inline enable toggle
  refuses to enable a channel that has no API key or model (with a
  localized hint) — matching the backend rule that only fully configured
  channels expose the generation tool to the agent.
- **Composer Drag-and-Drop Images**: The input box now accepts images dragged
  in from the file manager (single or multiple at once), inserting them as
  image chips exactly like pasting — previously the drop handlers only
  understood the app-internal `application/json` drag payloads (file / commit
  / change tags) and silently ignored external files (no drop cursor, no
  insertion).
- **Path-Aware `@` File Mentions**: The `@` file panel now supports browsing
  into folders like a file manager — clicking a folder entry (or `→` / `Enter`)
  navigates into it and rewrites the `@` query to the relative path; a
  breadcrumb bar (workspace root → path segments) lets you jump back, `←` goes
  up one level, and typing paths directly (`src/`, `src/renderer/App`) browses
  or filters inside the target directory.

## Bug Fixes

- **Markdown Images with Local Paths**: When the model referenced generated
  images by local relative paths (`image/...` library paths or `upload/...`
  paths) inside the Markdown reply body, the renderer tried to load them as
  relative URLs and showed broken-image icons. Local paths (backslash /
  URL-encoded variants normalized, `..` traversal and absolute paths
  rejected) are now rewritten to `img-proxy://` protocol URLs together with
  external images, and the main process serves them straight from disk —
  no IPC round-trips or data-URL caches in the renderer.
- **i18n Placeholder Syntax**: `settings.imagegenChannelCount` and
  `settings.imageLibraryCount` used the single-brace `{count}` placeholder
  format, so the channel count and image-library count rendered literally
  instead of interpolated; both now use the `{{count}}` syntax.
- Remove temperature parameter
- Anthropic thinking.effort is discarded after being read

## v0.1.16

## New Features

- **Native Image Generation MCP Server**: A new built-in `imagegen` MCP server
  exposes the `imagegen-generate` tool with dual-channel support —
  OpenAI-compatible Images API (`/v1/images/generations` and
  `/v1/images/edits`, supporting `b64_json`/`url` response formats, quality,
  output format/compression, up to 4 images per call, and streaming
  partial-image previews) and Google Gemini (Nano Banana 2+ models via the
  Interactions API with aspect ratios, image sizes up to 4K, thinking levels,
  and Google Search grounding). The tool is only visible to the model when at
  least one channel is configured and enabled. A DB-backed `imagegen` config
  scope handles channel persistence with legacy format migration, and
  streaming preview images survive conversation reloads.
- **Image Generation Settings Panel**: A graphical multi-channel management
  panel with table + modal editing, inline enable toggles (instant save),
  model capability linked dropdowns (Gemini size × aspect ratio combos like
  16:9@2K, GPT image recommended resolution tables), alias and
  deprecated/preview badges, and automatic correction of unsupported
  size/quality combinations when switching models.
- **Image Generation Gallery**: Generated images in chat are rendered as a
  Polaroid-style framed photo gallery with layered shadows and hover lift
  effects. A portaled lightbox with frosted backdrop supports full-screen
  viewing and download. Streaming previews display inside the same frame with
  a frame counter.
- **Terminal MCP Server**: A new built-in terminal MCP server exposes `open`,
  `send`, `read`, `resize`, `wait`, `close`, `focus`, and `list` tools for
  interactive terminal tabs. Commands are bridged from the native core through
  Electron IPC to xterm.js PTY instances. The server is disabled by default
  and only exposed when a project explicitly enables it, keeping optional
  tools out of the model context to save tokens.
- **Embedded Terminal UX Polish**: The default Windows shell now prefers pwsh
  (PowerShell 7) over cmd.exe. Terminal keybindings include Ctrl+C
  copy-selection, Ctrl+V / Shift+Insert / Ctrl+Shift+C paste-or-copy, and
  Ctrl+Insert copy. A right-click context menu (copy/paste/select all/clear)
  uses main-process clipboard IPC. Clickable links open in the embedded
  browser, full ANSI 16-color palettes are applied for light/dark themes,
  terminal tabs auto-close on clean exit (code 0), and orphaned PTY sessions
  are killed on renderer navigation.
- **Bash Detached Background Execution**: Bash tool calls now support detached
  background execution with run-level stream metrics, enabling long-running
  commands without blocking the agent loop.
- **Third-Party Configuration Import**: Unified import discovery and import
  workflows for Claude Code, OpenCode, and Codex configurations. A settings
  page provides a graphical import interface with transactional semantics
  (all-or-nothing on failure) and project-scoped system prompt import.
- **Plugin Marketplaces & Google Theme**: Added plugin marketplace support
  with a management UI, plus a new Google theme preset.
- **Config Server Full Coverage**: The built-in `config` server now manages
  every config file under `~/.snow/` — 11 file scopes (`settings`, `snowcfg`
  with all 30 keys, `proxy`, `app`, `custom-headers`, `system-prompt`,
  `theme`, `language`, `permissions`, `lsp-config`, `buddy`) plus the
  existing DB-backed scopes (`subAgents`/`hooks`/`skills`) and a new
  read-only `logs` scope for agent-driven diagnostics (`~/.snow/log`
  listing, tail reads with `limit`, level shortcuts). A new `ValueType::Number`
  supports float values (e.g. `theme.diffOpacity`).
- **Project-Scoped mcpServers & sensitiveCommands**: Passing `projectId` to
  `settings.mcpServers` / `settings.sensitiveCommands` now reads/writes
  project-level config in the app database (full-replace semantics;
  sensitive-command ids matching global rules become enabled overrides,
  others become project custom rules).
- **Deep Structural Validation**: `settings.codebase`, `custom-header
schemes`, `system-prompt prompts` and `lsp-config servers` are deeply
  validated on write (known fields type-checked, unknown fields allowed for
  forward compatibility), so an agent cannot corrupt nested config.
- **Per-Conversation Plan/Goal Mode Isolation**: Plan Mode, Goal Mode, and
  Goal token budget are now persisted per conversation (NULL = unset, follows
  the global default). The session ref is the single runtime authority —
  agent loop, tool execution, compaction, and sub-agents all read the owning
  session's mode snapshot, so a background conversation can no longer be
  hijacked by another session's toggles. Conversation switches no longer
  write global settings; Plan Mode approvals are invalidated per session only.
- **Browser MCP Enhancements**: Added `browser-evaluate` for executing page
  JavaScript with JSON-safe results, `browser-type` with fill, key-by-key
  delay, empty-value clearing and optional submit, and extended
  `browser-devtools` with console level filtering, per-webview network
  records, and dialog (alert/confirm/prompt) handling via CDP with debugger
  recovery after DevTools closes.
- **Multi-Select Batch Delete Conversations**: The sidebar chat list now
  supports multi-select mode for batch deleting conversations, with
  collapsible pinned and chat sections to keep long lists manageable.
- **User Interaction Tool — Manual Action Wait**: The `user_interaction` tool
  now supports waiting for the user to complete a manual action the agent
  cannot perform itself, broadening its purpose beyond clarification
  questions.
- **Git Panel Context Menus**: Right-clicking a commit row in the git graph
  now opens a context menu to copy the full/short hash or commit message, and
  to expand/collapse commit details. The top-bar project label card also
  responds to right-click (previously swallowed by the window drag region).
- **Content Tag Chips in Message Rail**: The user message rail popover now
  renders file, image, commit, change, and text-snippet tags as inline chips
  instead of stripping them to plain text, with capped chip widths and
  pending-message preview theming for Cream and Google presets.
- **Tab Cleanup & Ctrl-Click Navigation**: Added tab cleanup and Ctrl+click
  file navigation in the right panel.

## Improvements

- **Database Migration Refactor**: Refactored the database migration logic
  with pre- and post-migration hooks, updated API configuration default
  values, enhanced thinking option support, and updated internationalization
  texts.
- **Design Token Extraction**: Extracted theme tokens, highlight.js styles,
  theme settings panel styles, and Cream/Google preset styles out of
  `styles.css` into dedicated files under `src/renderer/themes/`. Added the
  `accentColor` field to `ThemePalette` across native, preload, and renderer
  layers. The main `styles.css` was reduced by ~3,400 lines.
- **Third-Party Settings Refinement**: Refined the third-party settings UI
  and import configuration formatting; removed obsolete test files.
- **Preset Themes Update**: Updated preset themes for memo, scheduled task,
  and git commit buttons.
- **Context Menu States & Responsive Layout**: Added context menu item
  disabled/hover states and narrow-window responsive layout adjustments.
- **Docs Coverage**: Added a config-file field reference (every file's fields
  with types and sensitive markers), browser-automation and codebase/diagnostics
  guides (zh/en), data storage locations and architecture overview guides,
  image generation guides with resolution tables, and chat/terminal/Git panel
  guides. Aligned the `snow-app-docs` skill with the full config coverage.

## Bug Fixes

- **Sub-Agent Plan/Goal Mode Isolation**: Plan/Goal/Goal-budget toggles are
  disabled in sub-agent conversations so toggling can no longer pollute the
  global mode defaults; the terminal sub-agent status event is broadcast
  immediately after the read-only flag to shrink the input-visible-but-sends-
  dropped window; `isSubAgentFinished` now uses a terminal-status whitelist
  and `subAgentStatus` is null-guarded. Three additional session-mode
  isolation race holes were closed.
- **Browser Network Recorder Startup Block**: Fixed the browser network
  recorder from blocking application startup.
- **Third-Party Import Hardening**: Made third-party imports transactional
  (all-or-nothing on failure), hardened the import workflows, corrected import
  discovery type inference, and resolved TypeScript errors in plugin imports.
- **Imported System Prompts Scope**: Imported system prompts are now
  correctly scoped to projects instead of leaking globally.
- **Reader Relative Links**: Relative markdown links in the reader now open in
  a new reader tab instead of triggering a blank navigation.
- **Chat Completions Tool Calls**: Normalized tool calls for Chat Completions
  and fixed conversation mode handling.

## v0.1.15

## New Features

- **User Message Rail**: Added a right-edge hover rail for quick chat navigation. A portaled popover lists user messages with paginated loading and virtualization, scrolling to the corresponding message on click. Visible messages are highlighted in the rail as you scroll, and a custom animation-frame tween replaces native smooth scroll for streaming content.
- **Text Snippet Chip**: Pasted text exceeding 2000 characters is automatically converted into a collapsible chip, preventing performance issues from rendering large text nodes in the contenteditable input. Chips support hover preview, click-to-edit modal, and automatic summary generation.
- **`/changes` Panel**: The file-change stats summary has been moved from the message list into a `/changes` slash-command modal with per-file diff previews. Repeated edits to a file are collapsed into a single latest record, and stats are re-hydrated from persisted history when reopening a conversation. Sub-agent changes are merged into the parent conversation.
- **Non-UTF-8 File Support**: Filesystem read/create/edit now auto-detects encoding (BOM + chardetng), preserving the original encoding and BOM on write-back. CSV files are decoded with the detected encoding.
- **Cancellable Remote SSH Tool Calls**: Per-tool execution cancellation is now supported for SSH-backed tools (bash, grep, filesystem). Rust registers a cancel token and Electron maps `tool_execution` IDs to `AbortControllers` that close the SSH exec channel on stop. All running tool executions are killed on session stop, not just bash.
- **Native Multimodal Tool Images**: Screenshots in tool results are now split from `@@image:@@` tags and emitted as provider-native image content blocks (image_url, input_image, inlineData) across Chat Completions, Responses, Anthropic, and Gemini payloads, instead of leaking base64 into plain text tool fields.
- **Codebase Embedding Error States**: Added error states and a retry flow for codebase embedding failures.
- **Git Graph Commit Tooltip**: Hovering a commit row in the git graph now shows a floating tooltip with full commit info (hash, author, date, refs, parents, message). The tooltip renders in a portal with fixed positioning and flips sides near viewport edges.
- **Sub-Agent Read-Only State**: Once a sub-agent run ends (completed, failed, or cancelled), the conversation becomes read-only — the input box is replaced by a status notice with a shortcut back to the parent conversation. Queued user insertions from the sub-agent are forwarded to the parent's pending queue so they are never lost.

## Improvements

- **Sidebar List Refresh Decoupling**: The sidebar conversation list no longer re-renders on every message version bump. A separate `conversationListVersion` triggers full redraws only after explicit actions (top/delete/rename/truncate), while AI responses use incremental upserts. Unchanged upsert content keeps the original reference to avoid meaningless re-renders.
- **User Message ID Sync**: `store_chat_exchange` now returns the snowflake IDs of persisted user messages, propagated through all API result handlers. The frontend replaces temporary IDs with real database IDs after persistence, keeping in-memory state in sync with the DB.
- **Pending Message Tag Rendering**: Pending queued messages now render file/submit tags and other chips properly. Shortcut key matching has been fixed by merging `mod` and `ctrl` checksums for non-macOS platforms while keeping exact matches on macOS.
- **Chat Input Copy/Cut with Chips**: Copying or cutting a selection from the chat input now serializes chip content via a custom clipboard MIME type (`application/x-snow-chat-chips`), enabling full chip restoration on paste within the app. Plain text and HTML formats are also written for external use.
- **Proxy Sync for Auto-Updater**: Proxy configuration is now synchronized to the electron-updater's partitioned session before update checks and downloads, since the updater uses a separate session that doesn't inherit `defaultSession` proxy settings.
- **Thinking Content Filtering**: Added `extract_chat_content` to strip thinking/reasoning content from Chat Completions responses, including inline `[think]`/`<thinking>` markers, for models that return thinking content even when `reasoning_effort=none` is requested.
- **Sub-Agent Pending Queue Forwarding**: When a sub-agent run ends, its pending user message queue is forwarded to the parent conversation's queue, ensuring messages inserted mid-run are picked up by the parent loop.

## Bug Fixes

- **Mermaid Image Viewer**: Fixed the Mermaid image viewer background in light theme.
- **macOS Tray Activity Icon**: The tray active-status icon previously used a template image that ignored RGB colors, making the green dot invisible. It now pre-renders black/white snowflake lines based on system appearance to simulate template inversion, with the dot uniformly green, and listens for `nativeTheme` changes.
- **Cream Theme Layout Gap**: Removed the app-layout gap in the Cream theme, including padding when the right panel is fullscreen.
- **Search Box Focus Style**: Replaced the separate border color change with a focus ring for the search modal input.
- **Icon Resource Paths**: Updated resource path handling to ensure icons load correctly after packaging.
- **Grep Output Parsing**: Fixed grep output parsing to split on the first `:<digits>:` pair so matched content containing colons is no longer dropped.
- **Tool Parse Error Truncation**: Tool parse errors are now truncated on UTF-8 boundaries to prevent invalid character sequences.
- **CSS Position Anchoring**: Added explicit `position: relative` anchors to `.main-content` and `.chat-content` to prevent child elements from drifting when the theme disables `backdrop-filter`.

## v0.1.14

## New Features

- **Agent-Managed Sub-Agents & Hooks**: The built-in `config` MCP server now exposes three new scopes — `subAgents` (create/update/delete sub-agents, global or project-scoped via `projectId`), `hooks` (configure all 9 lifecycle hooks, global or project-scoped) and `skills` (toggle/install/uninstall skills, delegating to the skill manager). Sub-agent and hook configs are written directly to the app database, identical to the UI settings panels, and take effect immediately. The former `skills-config-*` tools have been removed in favor of the `config` server's `skills` scope.
- **Project-Scoped Sub-Agents**: The `sub_agent_configs` table gains a `project_id` column (composite unique key, automatic migration for existing databases). The sub-agent settings panel adds Global/Project scope tabs, and sub-agent activation resolves project-scoped agents first, falling back to the global one with the same id.
- **App Error Boundary**: Added an application-level error boundary that automatically refreshes and self-heals when dynamic sub-package loading fails. Refresh attempts are limited via `sessionStorage` to prevent infinite refresh loops when build artifacts are missing.
- **Direct Sub-Agent Interaction**: Sub-agent sessions are no longer read-only — they now use the regular `ChatInput` for direct interaction, and the separate monitor UI has been removed. The sub-agent model is fixed to its own `advancedModel` to prevent misleading model memorization by the parent session.
- **Collapsible Projects Section**: The Projects section in the sidebar is now collapsible, with its expand/collapse state persisted to `localStorage`.

## Improvements

- **Sub-Agent Sidebar Refactoring**: The sidebar sub-agent list has been moved to a separate panel with its own surface background to avoid visual conflict with the parent session's selected state. Activating a sub-agent automatically expands its parent session, and deleting a parent session cascades to abort all child agent streams and clears the chat area.
- **Session Compression API Profile**: Compressed sessions now use the session-level `apiProfile` instead of the global active configuration, ensuring consistency with the API configuration actually used in the conversation.
- **Project Rule Editor**: The rule editor now follows the currently active project item, and the project dropdown selector has been removed to keep rule settings in sync with the current context.
- **Localized Time Labels**: Weekday names in chat timestamps are now localized (en, zh-CN, zh-TW) by passing the i18n `t` function to `formatTimeLabel`.
- **TokenUsageRing Placeholder**: Displays a placeholder ring during API configuration loading to avoid false alarms about token capacity being full.
- **MCP & Skill Settings**: Removed the MCP JSON batch import feature; JSON editor errors now use `AutoDismissNotice`. The skill installation panel now shows an example repository address.
- **Simplified Conversation Types**: Removed the `conversationType` status to streamline conversation type management.

## v0.1.13

## New Features

- **Session-Scoped API Profiles**: Each conversation session now remembers its own API provider and model selection. A new `apiProfile` pipeline routes through Rust with graceful fallback, per-session storage binding, and an `Alt+P` shortcut to cycle providers. The provider selector has been moved into the model menu's secondary view for a cleaner header.
- **System Tray (macOS)**: Added full system tray support with template icons, hover statistics, and hide-to-tray. Active status dots are now parameterized instead of using app logos, and the 16 px shrink/solid-block rendering issue is fixed.
- **Personalization Settings**: A dedicated settings page for editing global and project-level `ROLE.md` files with a priority explainer. Global and project rules are composed automatically, and SSH workspaces are supported.
- **Built-in Documentation System**: Introduced an internal documentation framework with the `snow-app-docs` skill, allowing the agent to read bundled docs and assist with MCP, skills, and API configuration.
- **MCP Settings UI Enhancements**: Added a JSON edit mode, batch import, and localized error messages. Built-in `config` and `skills-config` services now support GitHub token and codeload fallback for skill installation.
- **File-Change Stats Panel**: Conversation sessions now display a file-change statistics panel summarizing additions, deletions, and modified files.
- **Right-Panel Context Menus**: Tabs and the terminal now support right-click context menus, including paste-in-terminal.
- **Bash Session Context Injection**: Bash tool execution now injects session context as environment variables, making session-scoped information available to subprocesses.
- **Project Creation & Raw Markdown Toggle**: Projects can now be created directly from the UI, and a raw markdown toggle is available for note editing.
- **Sub-Agent Read-Only View**: Optimized the sub-agent panel as a read-only view for clearer separation from the main conversation.

## Improvements

- **Network Error Handling & Retry**: Enhanced network error classification with exponential backoff retry at the Rust level. Visual (image) request failures now include diagnostic messages and base64 validity checks.
- **Cream Theme**: Introduced the Cream theme (formerly Anthropic theme) with refined personalization UI styling.
- **Git Graph & Refresh**: Added a manual git refresh button and improved graph lane rendering for better readability.
- **Session Icon Selector**: Migrated the session icon emoji selector to a context menu for a less cluttered sidebar.
- **Line-Ending Normalization**: Added `.gitattributes` to enforce LF line endings, preventing CRLF false diffs on Windows.

## Bug Fixes

- **MCP Discover Fallback**: When the modern `discover` handshake fails, the client automatically falls back to the legacy `initialize` flow (issue #19).
- **Plan Mode Approval Persistence**: Plan approval state is now preserved across session switches and migrated alongside pending requests.
- **SSH Browse Path History**: SSH directory browsing no longer loses path history when navigating back and forth.
- **macOS Tray Icon Rendering**: Fixed the tray icon shrinking to 16 px and becoming a solid block on macOS.
- **i18n Completeness**: Filled in missing translations for shortcuts and provider dropdown labels in both English and Chinese.
- **Copilot Review Feedback**: Addressed four review comments from Copilot covering code quality and correctness.

## v0.1.12

## New Features

- **macOS Unsigned Update Flow**: Implemented a full update pipeline for unsigned macOS builds — generates a `latest-mac.json` manifest with SHA-256 checksums per architecture, fetches and verifies updates in Rust before applying, and falls back to ad-hoc identity signing so unsigned builds can auto-update without a Developer ID certificate.
- **On-Demand Bash Subprocess Cancellation**: Every bash command now streams a `tool_execution` ID, enabling a Stop button in the UI and allowing session abort/rollback to kill the entire process tree of a running command.
- **WSL Git Support**: Git commands now run through `wsl.exe` when the configured terminal shell is WSL, with proper argument quoting and UNC path conversion.

## Improvements

- **Non-SSE Stream Retries Moved to Rust**: The entire Gemini/Responses request+stream cycle is wrapped in a single retry loop so non-SSE responses (HTTP 200 JSON errors or empty streams) are retried at the Rust level instead of being returned to the JS agent loop.
- **Git Commands Offloaded to Blocking Pool**: NAPI git exports now use `spawn_blocking`, preventing repo operations from blocking the async runtime.
- **Conversation History Load Deduplication**: Switching away and back while a conversation's initial history is still loading no longer discards the in-flight result or issues a duplicate re-fetch — selections share a single load promise and cache the result for instant reuse.
- **Session-Scoped Working Directories**: Tool execution, checkpoint creation, and hook cwd are now bound to the session's own directory rather than the runtime active directory, keeping checkpoints consistent even after switching projects.
- **Plan Mode Approval Migration**: Migrated Plan Mode approval from the standalone plan-mode server to the unified `app-control` request-approval flow.
- **TODO Panel Rework**: Replaced checkbox multi-select with inline add and click-to-cycle status for a cleaner, faster workflow.
- **File Type Icons**: Added file type icons in right-panel tabs and the diff viewer.
- **Release Notes Automation**: GitHub Releases now automatically extracts version-specific changelog content from `RELEASE_NOTES.md` instead of relying on manual input that was lost on tag-triggered builds.

## Bug Fixes

- **Reasoning Item Round-Tripping**: Added `collect_reasoning_items` to properly preserve reasoning output items across requests when `store: false`, preventing reasoning context loss in multi-turn conversations.
