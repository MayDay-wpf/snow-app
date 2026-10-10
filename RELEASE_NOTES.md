# Release Notes

## v0.4.21

## New Features

- **Sidebar Plugin Update Badge**: When an installed panel plugin or script plugin has a newer version in the market, the sidebar plugin entry (and the collapsed "More" entry) shows an upward-arrow badge, so pending updates are visible without opening the page.
- **Manual Load More in the Tree Session List**: The sidebar's tree project session list replaces infinite scroll with a "Load more chats" button; the infinite-scroll sentinel now rebinds to the node via a callback ref, so it is observed again after the list is remounted and pagination keeps working across view switches.

## Bug Fixes

- Fixed the unified Tooltip staying on screen: a pointer-down now dismisses it (including the click that a modal mask intercepts), since a masked trigger never fires `mouseleave` and a hover-only exit left the hint permanently visible.
- Fixed the run summary reappearing while a generation is still in progress: a thinking state alone no longer counts as an active generation — only pending or running tool calls keep the summary hidden.

## v0.4.20

## New Features

- **Browser Agent Authorization and Tab Sharing**: Agent access to the built-in browser is now opt-in — only tabs you explicitly share (or tabs the Agent opens itself in an isolated, memory-only session) can be driven, and commands aimed at other tabs fail with an explicit error. A new `browser-request_share` tool asks for permission through an in-app Allow / Reject bar (auto-rejected after 60 seconds), the toolbar gains a share button and badge, the tab bar a shared dot, the menu a "Send to Agent" group (page body / console logs / network requests into the input box), and Browser settings gain an Agent authorization page (global switch, isolation session, domain allow / block list).
- **Sidebar Project Tree View**: The sidebar switches between the flat list and a project tree that nests collections, projects and conversations; running sessions and pinned chats are marked, and the chosen view is remembered.

## Improvements

- A unified Tooltip component replaces the scattered native hints across the chat input toolbar, stream metrics, message actions, Git control and session list, with consistent placement and theming.
- Session list: hovering an overflowing conversation title scrolls it as a marquee, quick actions appear on hover, multi-select batch archive / delete is supported, and an LSP status badge is added to the chat input toolbar.
- The file reader's review panel switches to a top / bottom layout on narrow widths, and the drag handle follows that direction (width or height).

## Bug Fixes

- Fixed the built-in log tool being rejected as a whole request: the `level` enum no longer contains an empty string (Gemini-compatible gateways answered HTTP 400).
- Fixed the run summary reappearing while a generation is still in progress.
- Fixed the collection actions permanently occupying the sidebar row — they are hidden by default and shown on hover / focus.

## v0.4.19

## New Features

- **ChatGPT Subscription Sign-In**: OAuth sign-in gains a ChatGPT (subscription plan) provider — the official Sign in with ChatGPT flow authorizes in the browser, the local callback returns automatically, and the channel calls the official Responses API with the subscription quota.
- **Goal Mode Auto-Continuation**: When Goal Mode is on and the run stops with unfinished TODO items, the agent is automatically sent a continuation prompt listing the outstanding items and the remaining token budget, and keeps going until every item is completed.

## Improvements

- Full three-language localization (Simplified Chinese / Traditional Chinese / English): a shared renderer translation entry (`tGlobal`) covers module-level code, injected scripts and event callbacks; the chat area, tool cards and built-in tool badges, the right panel and sidebar, the team collaboration module, the mobile remote control, and the main-process native UI (tray menu, download dialogs and notifications, webview context menu, pet menu) are all localized; dates and times follow the app language, and switching the language updates the tray and mobile copy immediately.

## Bug Fixes

- Fixed empty responses (the upstream ends normally with zero output): the terminal state is now marked and persisted (`empty_response` / `retry_exhausted`), each retry is logged with its cause, the attempt count and upstream error are stored on the message and refilled after reload, and the reply shows the shared "retries exhausted" card instead of a blank bubble.
- Fixed user-initiated cancellation being misrecorded as an upstream empty response — cancelled and failed runs keep their own terminal state, and a migration cleans the historical dirty rows.
- Fixed the chat message query column-index shift introduced by the retry columns, which broke history pagination and left the message area blank when a conversation was opened; the archive database gained the same columns.
- Fixed conversation history losing its raw Markdown / copy / fork buttons as soon as a new prompt was sent — only the tail message of the active run is masked now.
- Fixed the pending-message mode chip being truncated and image thumbnails being stretched.

## v0.4.18

## New Features

- **Memo Multi-Select Batch Delete**: The memo panel gains a multi-select mode with select-all / deselect-all and a selected count, deleting the chosen memos in one confirmed action.
- **Three-Tier Responses Fast Mode**: Fast Mode is no longer a boolean — off sends nothing, Fast sends `service_tier: priority` and UltraFast sends `ultrafast`; the API settings and the chat input picker both switch it.
- **System Log Retention**: System logs are pruned automatically (once at startup, then every 6 hours), with a retention setting of 7 / 30 / 90 days or never (default 7 days) that reports how many expired entries were deleted.

## Improvements

- The file reader was reworked for performance: in-file search locates lines by binary search on the line index (545x faster), code folding resolves in O(log K), column estimation samples in strides (8.1x), lines over 10,000 characters are truncated with a badge, search highlighting is scheduled via requestAnimationFrame, and the syntax-highlight cache grows to 128 entries with LRU refresh.
- Rust text reading compares UTF-8 buffers without a second copy and caps raw reads at 64 MiB.
- Read-only call protection is now mutation-aware: duplicate calls probe the file fingerprint and Git dirty / commit state so legitimate re-reads pass, mutating-tool detection covers terminals, sub-agents and LSP renames, and duplicate-recovery rounds emit a fallback notice instead of a stream cutoff.
- Tool errors are localized: 30 error render points across 23 tool cards show translated messages in all three languages, while protocol and audit fields in tool results keep their original text.
- The compact theme gained a full native form-dialog style set (card, header, footer, drop zone, input, buttons) with unified read-only and disabled states; form dialogs now focus the choose button instead of a read-only path field.
- Plugin message-footer eligibility is decided precisely, keeping ordinary footers and task-history footers mutually exclusive.

## Bug Fixes

- Fixed file viewer search positioning in edit mode: the editor textarea does not scroll itself, so scrolling is driven by the outer container.
- Fixed MCP settings JSON mode needing two clicks to save (stale draft closure); parse and save errors are localized and no longer hidden behind the modal overlay.
- Fixed the file-change tracking memory peak: Git output and file contents are read in chunks with checked allocation, so an allocation failure degrades coverage instead of aborting the app.

## v0.4.17

## New Features

- **OAuth Subscription Sign-In**: API settings gain an OAuth sign-in entry that turns a subscription account directly into an LLM channel — Codex (ChatGPT subscription), Anthropic (Claude subscription), Antigravity (Google subscription) and xAI (Grok subscription) are supported; authorization happens in the browser and the local callback returns automatically (pasting the callback URL by hand also works), the channel is created and enabled for you, models are fetched from the provider's own endpoint, and tokens refresh before they expire.
- **File Review Annotations**: The file reader gains a review panel — annotate the selected text from the toolbar or the context menu, then save, edit, copy, highlight-locate or delete (with confirmation) an annotation, and send one or all of them into the chat draft without sending automatically; annotations persist independently of the source file (SSH annotations stay local), anchored by UTF-16 offset, selected text, surrounding context and a body SHA-256, so they relocate only on a unique context match after edits and remain listed but unlocatable otherwise.
- **Selections and Annotations as Conversation References**: "Add to conversation" in the file reader encodes the selected text together with its file path and line range as a reference tag, and the explorer's "Add to input" context action accepts files and folders (Ctrl / Shift multi-select); on send the tags expand into readable "file:lines + quoted text + annotation body" content, so the model sees exactly what the user selected instead of re-reading whole lines; the mobile remote control renders the same references.
- **Local Document Text Preview**: The file reader can extract and show the body text of PDF, Word, Excel / ODS and PPT files (20 MiB input and 2 MiB text limits, with explicit errors when exceeded); the original encoding and BOM round-trip is verified on read, and documents plus text that cannot be written back losslessly are marked as read-only previews, re-checked on save so a preview can never overwrite the source file.
- **Plugin Reader Navigation and Task-History Slot**: Plugins gain the `panels.openFile` and `panels.openFileDiff` navigation actions, and message footers receive lifecycle-scoped reader and read-only diff navigation; `contributions.messageFooters` may declare `taskHistory`, associating a persisted task-end reply with its original assistant / tool records so reopening the conversation rebuilds a read-only snapshot while earlier cards stay during the next task.
- **Busy Send: Task Queueing and Safe Steering**: While an Agent runs, sends are split into queueing (handled FIFO once the whole run finishes) and steering (appended at a safe boundary without interrupting tools or starting a parallel loop); general settings choose the default (steering), the send menu and a shortcut override it for a single message, and the pending area scrolls within a capped height.

## Improvements

- The streaming request path is unified: conversation summaries and codebase review reuse the main conversation's Responses path, OAuth profile protocol headers now apply to helper requests such as summary generation, and transport proxy resolution covers environment variables and the system proxy.
- The terminal's floating "Add to input" button follows the mouse release point and is clamped to the panel edges instead of staying pinned in a corner.
- File-change tracking lease waits are bounded: a terminal command window is never waited on by other sessions, so long-running commands no longer stall another session's capture.
- Compact theme contrast and interaction states were improved (#183).
- Plugins can declare `panels[].chatInputSettings` to control the settings gear's default visibility and store the right-panel switch under their own key.

## Bug Fixes

- Fixed Responses WebSocket connection-multiplexing crosstalk: late events belonging to another response on a reused connection are dropped instead of leaking into the current stream, and the context usage snapshot is now persisted on user messages so it can be restored when a conversation is reopened.
- Fixed terminal tool cards permanently stuck in "executing": the command-write stage now races the deadline and the cancellation token like the wait loop, so a full pipe or a stuck previous command resolves as timed out / cancelled / failed and terminates the session.

## v0.4.16

## New Features

- **Session File Change Tracking**: Real files changed by a conversation are captured at tool-execution boundaries — dedicated file tools record the actual physical paths, and terminal commands are diffed with content fingerprints (including re-edits of already-modified files and non-zero exits); the file-changes panel annotates capture source, coverage, root and gap reasons, and the data is exposed to plugins through the v1 contract (`fileChangeTrackingVersion` / `fileChangeCoverage`).
- **Plugin Message Footer Slot**: Plugins can mount custom cards between a reply's body and its action buttons (`contributions.messageFooters`, ESM-only, with a lifecycle-scoped read-only API and automatic cleanup); session file statistics and similar displays now come from plugins.
- **One-Click Prompt Optimization for Plugins**: A host-side prompt-optimization channel (streaming in Rust, cancelled independently of ordinary chat, honoring an explicitly selected model service or profile) lets plugins optimize the draft in one click from the chat input toolbar, write the result back safely and undo it, without sending a message.
- **Changelog Tab**: Settings gain a Changelog tab to browse release notes version by version, with Simplified Chinese / Traditional Chinese / English switching; Traditional Chinese release notes are new, and the update dialog supports them as well.
- **Stream Retry and Error Cards**: Streaming retries show the attempt number and error details (expandable, copyable), and failed requests now render as a structured error notice card.

## Improvements

- Browser element picking returns the DOM hierarchy tree (ancestor chain plus a summary of direct children), helping the model place an element in the page structure.
- Installed plugins and scripts show update badges inline and update in one click, without opening the Market tab.
- The plugin market index is fetched by commit-SHA content addressing, bypassing the CDN's long-lived cache of branch references.
- The right-panel tab context menu lists the declared panels of enabled plugins.

## v0.4.15

## New Features

- **Dockable Explorer**: The project explorer can move between the sidebar and a right-panel tab (one click from its toolbar, plus a + menu entry while docked right); the placement is remembered and the current directory is kept when moving.
- **Directory-Scoped File Mentions**: `@:directory/` first picks a workspace directory — members of the linked project group included, the active one flagged — then searches inside it; results from sibling projects carry a project-name badge.
- **Configurable Session Cache TTL**: General settings gain a Sessions section where the conversation message cache TTL is adjustable (default 60 minutes, range 1-10080); a timed sweep releases conversations unviewed for longer than that, while conversations being viewed or actively running are never evicted.
- **Snow Bot Streaming Cursor**: The streaming indicator gains a "Snow Bot" animated flow style.
- **About GitHub Repository Entry**: The About section now links the GitHub repository.

## Improvements

- The default terminal font stack includes Nerd Fonts (Maple Mono, JetBrainsMono, MesloLGS, ...), so Oh My Posh / starship prompts render out of the box; terminal settings offer a font preset dropdown (#178).
- Branch listing now uses `git for-each-ref` (1129ms → 112ms on a repository with 12 worktrees) (#177).
- Plugin market force-refresh purges the jsDelivr mirror cache first, so refreshing is no longer defeated by stale CDN copies.
- The built-in browser MCP server is disabled by default and enabled per project, keeping its tools out of the model context until opted in.
- The built-in general subagent's defaults (system prompt and tool list) refresh automatically.
- Compaction summary messages use a compact divider-bar style, with copy and rollback inline.

## Bug Fixes

- Fixed Git branch dropdown interactions: clicking the trigger twice no longer closes and immediately reopens it, the popup width follows the space actually available to the right of the trigger (no clipping in narrow windows or under display scaling), and worktree rows keep their action buttons.

## v0.4.14

## New Features

- **Plugin Market**: The plugins page gains a Market tab to browse, install and update plugins and userscripts online — the index comes from the snow-plugin-store repository (GitHub raw + jsDelivr dual source), installs are SHA-256 verified, and version updates are detected.
- **Cross-Origin iframes**: The built-in browser gains `browser-frames`, returning opaque frameIds bound to the document lifecycle; reading, evaluating, waiting, clicking, typing, hovering, selecting, uploading and snapshots / AX can all target a frame, with output and errors redacted and unsupported operations failing loudly instead of falling back onto the main frame (#175).
- **Browser Debugging Toolset**: New browser MCP capabilities include device emulation and viewport resizing, performance traces with insight analysis, CSS cascade inspection, accessibility audits (axe-core), JS heap snapshots with comparison, page screencast recording, form filling and dragging, and page-registered tool invocation.
- **SSH Single-Hop ProxyJump**: SSH connections support a single-hop ProxyJump, configurable from the connection wizard.
- **Linked Project Groups**: Project collections upgrade to "linked project groups" — members can be included at creation, carry a link toggle (kept in the group but excluded from resolution once unlinked), and support unified search across the group plus color identity; the collection dialog gains a custom color picker.

## Improvements

- Git commit graph rework: merging lanes sweep into the dot with a full-row arc, and branch colors stay consistent from fork to merge point.

## v0.4.13

## New Features

- **Conversation Worktrees**: A conversation can run inside a dedicated Git worktree — tool calls, file-change watching, checkpoints and rollback, diff tracking, and sub-agent / workflow cascades all stay isolated inside it, so parallel conversations no longer clobber each other; the Git panel gains a worktree manager card (create, delete, dirty-state badges, open in terminal or file manager), the chat input footer switches the binding at any time, and the branch selector searches branches and worktrees together.
- **Multi-Remote and Branch Management**: Push / pull can pick the target remote and set upstream (-u); branches show ahead / behind counters and gone markers; a unified branch context menu covers copy, checkout, create-from-branch, rename and safe delete (the current branch and any branch checked out in a worktree are protected).
- **Tool Card Overhaul**: Bash cards render real ANSI colors, database query results become an interactive table (filter, sort, CSV export), file read-write cards highlight code, LSP result cards support batch semantics, symbol outlines and hover tooltips, and image description gains a dedicated card; external MCP tools get a generic enhanced card (table / JSON-tree / markdown views, smart classification and one-click copy).
- **System Log Viewer**: A dedicated system-log tool card and the read-only `config-logs-read` tool filter logs by level, module, time and conversation, with an app-level summary and secret redaction; the conversation menu can copy the conversation ID.
- **Built-in Browser History**: The built-in browser records visit history and powers address-bar completion; browser settings add a History panel (search, delete one, clear all, reopen).
- **LSP Batch Semantic Queries**: Semantic tools can query many symbols / files in one call, with complete argument contracts for all 11 tools and dynamic prompt injection, plus better Go receiver-method resolution and workspace TypeScript resolution.

## Improvements

- Mobile remote control computes file changes from native checkpoints (SSH included) and shows a summary with additions / deletions and main / sub-agent attribution; a guide appears when antivirus software blocks the built-in frpc tunnel component.
- Sidebar icons play a stroke animation on hover and streaming scroll-follow is steadier; chip tags (files, images, commits, quotes, ...) in conversation titles and lists collapse into readable text.
- Feature pages (memos, project memory, scheduled tasks) accept a drag-resizable dual-column layout; disabled MCP servers can still have their tools inspected.
- The Git commit graph and tooltips show full commit messages and file-read line numbers render better; the confirm bubble uses the custom select.
- A shared message copy button supports Markdown / plain text and compaction summaries; the file-mention popup hints "AI search starts when you stop typing", and API profiles show a provider icon for the request method.

## Bug Fixes

- Fixed external MCP servers repeating handshakes and probe waits: the discovery cache now lasts 5 minutes, legacy-only servers are remembered and connect via the legacy handshake, and duplicate discovery scans are skipped (#172).
- Fixed Windows packaging failing with electron-builder EPERM (new patch script); the Electron build version is now pinned.
- Fixed worktree edge cases: deleting a worktree bound to a conversation cascade-unbinds it, a running conversation cannot be rebound, and storage write locks were hardened.
- Fixed terminal behavior: opening with an empty command only creates a tab, xterm shortcuts no longer fire copy / paste twice, and the Linux desktop name is unified.

## v0.4.12

## New Features

- **Plugin Network Requests (`api.net.fetch`)**: The plugin runtime gains external HTTP requests issued from the main process — they follow the app proxy settings, bypass CORS and send no cookies — returning status, headers and body, with network failures reported through the `error` field instead of throwing; available to ESM and iframe plugins alike, and the metadata catalog gains a Network sub-tab.
- **Privacy Scope Dialog**: Privacy declarations on plugins and scripts become clickable amber badges that open a "Privacy scopes" dialog explaining each scope's purpose, the metadata domains it unlocks (field-level declarations name the exact fields) and its writable capabilities, plus where it is declared.
- **Client Script Icons**: Script metadata supports `@icon` / `@iconURL` (`@icon64` / `@icon64URL` as fallback) with `lucide:IconName`, an http(s) URL or a data URI, shown in the script list.

## Improvements

- The Rococo theme gives form dialogs the same framed ornament: a gilded inner frame, header rosettes and crest, and a footer swag.
- Plugin `git` metadata now comes from a dedicated repo identity API (reading the repo's `git config` and origin remote) instead of the local team identity.

## Bug Fixes

- Fixed Gemini function calls losing their arguments: histories storing a functionCall with a top-level `args` object are restored correctly, and signed parts are replayed without overwriting complete arguments with empty ones (#170).

## v0.4.11

## New Features

- **Rose Rococo Theme**: A new Rococo-style theme preset (light and dark palettes) with scrollwork, swag and crest ornaments, a serif display face and a matching pixel-logo animation.
- **Inline Diff Comments**: Comment on individual diff lines (old / new side) with edit, delete, copy, send one or all comments to the chat input and clear all; comments whose line content changed are flagged, unmatched ones are listed, and very large diffs turn commenting off; comments persist per project and file.
- **Diff View Preferences**: Switch between unified / split / wrap-lines, shared between the right panel and in-chat diffs and remembered.
- **Authenticator Unlock for Mobile Remote Control**: Once Google Authenticator is bound to the app lock, the mobile LAN and public remote pages unlock with a 6-digit code instead of the pairing token (switch under Settings → Privacy → App lock).
- **Project Grid Drag-and-Drop Grouping**: Drag projects into a collection or back to the ungrouped area directly in the project grid view.

## Improvements

- LSP install-state reconciliation runs once on the first LSP probe from the settings page instead of at startup; seeded servers default to enabled only when their command exists on PATH, and Windows probes no longer flash a console window.
- In-chat diff view-toggle buttons stay pinned to the top-right of the visible area while scrolling horizontally.
- Skill tool cards render structured details: skill ID, name, location, path, allowed tools and skill content, with a loading state.

## v0.4.10

## New Features

- **Typography and UI Zoom**: Theme settings gain typography controls (interface font size, weight, chat font size / line height, code font size); the interface font size uses full-page zoom, with new `mod+=` / `mod+-` / `mod+0` shortcuts to zoom in, out and reset.
- **Project Grid View and Switch Targeting**: A grid view dialog in the sidebar project area (search, browse by collection group); switching projects jumps to the project's running session, creating a new one when none is running.
- **Script Data APIs and CORS-Free Requests**: Client scripts support the `@snow-privacy` declaration and reuse panel-plugin metadata and write capabilities via `snow.metadata` / `snow.write`; new `snow.fetch` sends CORS-free requests from the main process, and sandboxed scripts get it as their global `fetch`.
- **Language-Server Symbol Addressing and Runtime Controls**: LSP tools resolve targets directly from symbol names (hover, definition, references, rename, call/type hierarchy need no file coordinates; omitting the path resolves across the workspace with ambiguity candidates); the LSP settings panel shows per-server status with start / stop / restart.
- **Mac Platinum Theme**: A new macOS-style theme preset (light and dark palettes).

## Improvements

- Git panel refactor: the commit graph is permanent, walks only the current branch and marks unpushed commits; diffs open in a new tab.
- Settings pages move their title and actions to the top bar.
- LSP semantic tooling hardened: the advertised tool list follows the final tool snapshot (permissions, workspace, server capabilities, health); diagnostics accept 1–30 files (deduplicated, concurrency 3, per-file outcomes and totals); renames require a preview plus a single-use previewId; the persistent diagnostic cache is gone, and result cards show complete / partial / failed counts with truncation warnings.
- AI commit messages use the Conventional Commits format and strip code fences automatically.
- Faster startup: the storage-ready gate is released earlier, so window, workspace and Git IPC no longer wait.
- Plugin and script creation entries share one AI prompt box.

## Bug Fixes

- Fixed Git branch parsing: local branches containing `/` are no longer misread as remotes, and the symbolic `refs/remotes/*/HEAD` no longer appears as a branch.
- Fixed the macOS traffic-light alignment offset when the sidebar is collapsed.

## v0.4.9

## New Features

- **Top Bar and Git Panel Refactor**: The top bar is rearranged and gains a branch selector (branch switching moves out of the Git panel header); the Git panel header becomes the commit area (message input, AI commit-message generation and commit button), and both share one repo watcher (reference-counted).
- **Persistent PowerShell Sessions**: Consecutive PowerShell commands reuse one warm session, cutting a trivial command from ~400ms to ~40ms; the working directory still resets per command while process-level state (environment variables, `$global:` variables) persists, and idle sessions are reclaimed automatically.
- **Client Scripts**: The plugin list gains a "Script plugins" tab to create from a template, generate with AI, import, edit in a full-screen editor, delete, and enable/disable client scripts injected into the desktop UI.
- **Team Avatar Colors and Top Bar Team Info**: Team avatars accept a custom color (mailbox-hash default); the team name, remote address, sync status and identity actions move to the top bar, avoiding duplicate team-data fetches.
- **Built-in MCP Server Icons**: Built-in MCP servers show dedicated icons in the MCP panel.

## Improvements

- LSP-first routing: prompts hard-bind scenarios to tools — with a language server available, definitions, references, types and impact start from semantic tools while grep handles literal text and annotates results with semantic-tool hints; the investigation-phase tool list in Plan / Goal / WorkFlow modes is injected from the tools actually callable in the project.
- Stack-aware language servers: LSP sessions start from each language's stack root (Cargo.toml / go.mod / tsconfig.json, ...), resolving mixed-stack projects accurately; languages without a stack marker are no longer started.

## Bug Fixes

- Fixed individually disabled tools still appearing in injected prompts.
- Fixed codelens tools being hidden wholesale in mixed-stack projects: languages without language-server coverage keep the static-analysis fallback.
- Fixed duplicate LSP client logs and long lines split at the read-buffer boundary.
- Fixed skills settings and project memory lists rebuilding after refresh or actions and jumping back to the top.

## v0.4.8

## New Features

- **Plugin Write Capabilities**: The plugin runtime gains `api.write` — 201 write actions covering memos, project memory, scheduled tasks, image-library albums, conversations, projects and collections, system interactions (notifications, clipboard, reveal in folder), plus browser data, SSH, remote control and settings domains; each action requires its privacy scope to be declared, and the metadata catalog shows writable capabilities with their grant state.
- **Settings Search**: A search box in the settings sidebar finds any setting and walks through nested tabs to reach it, flashing the matched entry; the global search drops its duplicate settings group.
- **Shortcut Enhancements**: A searchable shortcut help overlay (default `mod+/`) and inline shortcut badges on UI buttons; actions with "foreground only" off are registered globally in the main process so they fire while the window is unfocused; a new `mod+shift+y` toggles message timestamps.
- **Horizon and Tesseract Themes**: Two edge-to-edge compact themes (light and dark palettes each) with micro-interactions and signature header stripes.
- **Terminal Font Zoom and Path Drop**: Resize the terminal font from the settings panel or with Ctrl/Cmd + wheel, and drop files onto the terminal to insert their paths at the cursor, quoted per shell.
- **Grouped Question Cards**: `askUserQuestion` calls in one batch merge into a single grouped card with per-question answers and state; mirrored on mobile.
- **Message Timestamps**: User messages, AI replies, thinking blocks and tool cards can show their creation time (clock icon with a full-timestamp tooltip).

## Improvements

- Markdown rendering is now chunk-incremental: the worker only splits at safe boundaries (closed code fences, paired `$$`, balanced handoff tags) and the main thread rebuilds only the changed chunks — the tail chunk appends in place — so long streaming replies are no longer re-rendered wholesale.
- Streaming auto-follow now pins to the bottom in the same frame as content growth instead of animating; the run summary bar became its own component.
- Panel resizing writes DOM variables and commits state once on release, so dragging no longer re-renders the UI every frame.
- Sidebar collapse panels (sub-agents, workflow nodes) load lazily: collapsing unmounts the content and expanding shows a skeleton first.
- Memos, project memory, scheduled tasks and plugins turn from modals into standalone lazy-loaded pages.
- `grep-search` gains a timeout and cancellation: a timed-out search stops its background thread and returns promptly.
- Outbound request tail guard: Gemini rejects requests ending on a model turn, so payloads drop text-less model turns and append a "Continue." user turn when needed.

## Bug Fixes

- Fixed `/clear` command argument passing and the handling of an empty `projectId` in the pending state.
- Checkpoint fault tolerance: a single unreadable file no longer breaks a whole diff or rollback batch, missing objects are skipped gracefully, and Windows reserved device names are skipped.

## v0.4.7

## New Features

- **New Theme Presets**: "Cyberpunk" and "Notion" join the theme gallery, each with light and dark palettes; the Google and cream presets were fine-tuned alongside.
- **Image Generation Moves into API Settings**: The former "Image generation" settings page becomes the "Image models" tab of API settings; the image panel and `openSettings` still jump straight to it (the sidebar highlights API settings).
- **Per-File Diffs in the File-Changes Panel**: The change list shows each file's added/removed line counts (+N / -N) and clicking a row opens that file's diff directly; a "View all diffs" entry in the header keeps the merged view.
- **Sub-Agent Activation Summary**: `sub-agents-activate` gains a required `summary` argument (a short label for this activation) that becomes the sub-agent conversation's title and summary — it shows up in the sidebar sub-agent list, the chat header and the tool card header, falling back to the agent name when missing.

## Improvements

- Large diffs render incrementally: the unified diff view mounts rows in batches (200 per batch) and appends the next batch as you scroll near the bottom — full content, no truncation, so very large diffs open smoothly; DiffFile instances are prebuilt instead of cloning the data again.
- The streaming render pipeline was reworked: a memoized `MessageContent` component means only the last message re-renders while streaming, and stream chunks are merged per frame and force-flushed when the stream ends so the final batch is never lost.
- Stream chunks are dispatched through a single IPC listener plus a streamId registry, so parallel streams no longer wake every in-flight callback for every chunk.
- Plugin runtime snapshots are broadcast at a minimum interval (idle state pushes immediately) and the paused-conversation set is reused while unchanged, so the sidebar and plugin panels stop recomputing wholesale during streaming.
- The user-message rail builds one DOM index per pass and enforces a minimum compute interval, keeping long conversations smooth.
- `grep-search` caches the ripgrep availability probe, stops reading and kills the child process as soon as output exceeds the limit, and truncates on UTF-8 boundaries.
- Fuzzy file-edit matching was rewritten (whitespace normalization plus token-distance line comparison with a first-line gate) for more accurate and faster matches.
- After the delayed Prettier pass rewrites a file, the checkpoint records the formatted content as `expected`, so rollback gating no longer treats auto-formatted files as changed by someone else.
- The API adapters no longer accumulate unused raw stream events, lowering memory use on long streams.
- The custom-command type selector now uses the shared `CustomSelect` component.

## Bug Fixes

- Fixed new files disappearing from the rollback preview (and not being deleted on rollback) after the delayed Prettier pass had rewritten them.
- Fixed the "Web fetch" entry in privacy settings showing the "Web search" label.

## v0.4.6

## New Features

- **Custom Commands**: The `/` command panel supports custom commands — global or project scope, an `$ARGUMENTS` placeholder, description and enable/disable management; project-level commands can shadow same-named global ones.
- **Retry Policy Settings**: A new "Retry" page in API settings toggles retries per error category (rate limit, 5xx, network, stream errors, …), appends extra match keywords, or enables retry-on-any-error in one switch; it applies to all API profiles.
- **Link Open Menu**: Links in chat replies can be opened in the app browser or the system browser via an open-with menu.
- **Manual Password Management**: Saved passwords can be added, searched, and deleted manually in browser settings.

## Improvements

- The file viewer gains syntax highlighting and virtual row rendering, so large files open smoothly.
- Dropdown popovers (file mentions, model selector, command panel, etc.) share unified animation and visibility handling.
- When every question in a batch of `askUserQuestion` calls is refused, the turn aborts instead of running the remaining tools.
- The archive database gains schema version management, making database initialization during archiving and restore more robust.

## Bug Fixes

- Fixed the context token snapshot being zeroed after rollback truncation: per-request token usage is persisted on every message and the snapshot is restored from the remaining messages after a rollback.

## v0.4.5

## New Features

- **Plugin Metadata Catalog**: The plugins panel gains a "Metadata catalog" that browses every metadata domain a plugin may read — fields, parameters, privacy scope, and live vs. polled — and shows how many domains each plugin is currently granted; plugin rows open the same detail view.
- **Jump to a Memory's Source Conversation**: Memory entries show a source-conversation badge; clicking it opens that conversation directly (switching projects when needed). When the source conversation was deleted the badge degrades to a non-clickable hint and the memory is kept.
- **Memo Search and Sorting**: The memo panel supports keyword search (debounced, matches highlighted, preview snippet centred on the match so hits deep in the body stay visible) plus sorting by created/updated time in either direction; `/` or Ctrl/Cmd+K focuses the search box. Filtering, sorting and paging all run in the Rust layer.
- **Unified Range Slider**: Sliders across API settings (tool result limit, auto-compress threshold), theme (background opacity/blur, stream cursor icon size), request-logging duration, and pet size now share one component — the value updates live while dragging and commits on release, and theme presets only override CSS variables (cream / Google / Win95 each ship their own look).
- **Clones Continue in the Background**: The clone dialog can be dismissed while the clone keeps running; progress, an abort entry and failure reasons move to placeholder rows in the sidebar project list. Aborting kills the whole git process tree and cleans up the partial directory, failures clean up too, and retries are no longer blocked by leftovers.

## Improvements

- Auto-formatting is now delayed and batched: a write only registers the file, and Prettier runs once that file has gone quiet with no write tool in flight — formatting can no longer land between two edits of the same batch and make the later one miss its match. Reads and app shutdown force a flush (new `flushPendingFileFormats`).
- Writes to the same file hold a file lock for the whole read → compute → write cycle and register an in-flight write, so parallel edits can no longer overwrite each other.
- Chat scroll restoration during paging gained a watchdog: it keeps compensating the anchor for every push from the newly loaded page, never rolls back scrolling the user did meanwhile, and stops as soon as it converges.
- `grep-search` gained a required `description` argument: the model states in the user's language what the search is looking for, the card shows that instead of the raw regex (the regex moves to the tooltip), and the search still runs when the model omits it.
- `bash-terminal-execute` no longer requires `workingDirectory` — it defaults to the current project workspace (resolved to the remote path for SSH projects) and only errors when the session has no workspace bound.
- Child-process reaping is unified in the Rust process module: waiting for exit on Windows now polls instead of relying on the OS wait-thread pool (which could stall under load), and bash and git clone share one process-tree kill path.
- Tool results no longer echo `editedContent` (the review block already shows the real layout), saving context.
- The edit/copy result field `formatted` became `formatPending`, mirrored in chat cards and on mobile.
- API profiles can be opened for editing by clicking the profile name; the global search modal closes with ESC; the pending-message withdraw icon became an undo arrow.

## Bug Fixes

- Fixed Prettier formatting landing between two edits of the same batch and making the later edit report "content not found".
- Fixed failed git clones leaving a partial directory behind, which blocked retries with "Target directory is not empty".
- Fixed child-process waits on Windows stalling when many tool processes ran at once (the OS wait-thread-pool callback could be delayed indefinitely).

## v0.4.4

## New Features

- **Plugins**: Install plugins from a local folder to add custom panels to the right panel (each plugin panel reuses a single tab); plugins run in an isolated iframe, and the install view lists the permission scopes they declare (API keys, system prompts, conversations, logs, and more), with enable/disable, manifest rescan, reveal-in-folder, and uninstall. With no plugin installed you can simply describe what you want and the AI reads the plugin docs to build and install it.
- **Decision Models (TypeSafe / Jev)**: A new "Decision models" page in API settings manages judgment-only models (auto / custom base URL, model, API key, enable/disable). Codebase agent review can use one to judge each search result's relevance, and sensitive commands gain an optional decision-model assist that first decides whether a matched command may run without confirmation, with delegation support.
- **App Lock**: Lock the app with a 4-8 digit PIN (stored as a salted hash); verification is required at startup and after the window loses focus (configurable delay, or lock immediately). A bound Google Authenticator code works as a fallback unlock, with attempt limits and a cooldown. Locking only covers the UI — sessions keep running in the background.
- **Pinned Conversations**: Pinned conversations now sit inline at the top of the conversation list and can be reordered by dragging.
- **filesystem-copy Tool**: The AI can copy (or cut) a line range and insert or overwrite it at a target position, works in SSH remote projects as well, and comes with dedicated tool cards in chat and on mobile.
- **Responses WebSocket Mode**: A new API settings toggle switches Responses requests from SSE to WebSocket, reusing one connection across turns.
- **Misc**: Browser tabs in the right panel can be opened in the system browser from the context menu; the About page gains open-source license, privacy notice, and disclaimer sections; API profiles support deleting selected entries.

## Improvements

- Rollback merges the checkpoint chain: a file that was created and then edited is deleted on rollback instead of being reverted to its previous content.
- Memory tool cards can be expanded to preview each entry.
- Chat history loading shows a skeleton, and the scroll-follow logic was reworked.
- The file-changes panel now includes edits made by filesystem-copy.

## Removals

- Third-party config import (Codex / Claude Code / OpenCode) and its settings page are removed; the old plugin marketplace is replaced by the new plugin system.

## v0.4.3

## New Features

- **Local Data Cleanup**: A new "Data Cleanup" section in settings scans local usage by category (checkpoint snapshots, uploads, image library, theme backgrounds, pet resources, browser state, app logs) and deletes the selected ones by age (7 / 15 / 30 / 90 days, or all time). Scanning and deletion run in the Rust layer, so the UI stays responsive.
- **Rollback Target List**: Double-press ESC to open a list of past messages and roll back to any turn (context-compaction summaries included); targets older than the loaded page window are fetched on demand.

## Improvements

- While a commit message is being generated, the git commit input is read-only and follows the latest streaming chunk; its height now auto-fits the content via CSS.
- The conversation import button is hidden in the archive list.

## Bug Fixes

- Fixed ESC bubbling out of nested dialogs and closing the outer one (dialogs now opt in to ESC closing individually).
- Fixed HTTP 400 rejections when a tool schema omitted `required` (e.g. `browser-create`).
- Fixed Linux AppImage update 404s caused by artifact name drift: the AppImage file name is now pinned at packaging time, and update manifests are verified against the packaged files before publishing.

## v0.4.2

## New Features

- **API Profile Import/Export**: Batch import and export API profiles, with drag-and-drop reordering.
- **Conversation Import**: Import conversation JSON files, including batch import into a chosen project.
- **Memory Panel and Search**: New `/memory` session memory panel, plus keyword search in the memory bank.
- **Win95 Theme**: New Win95 theme preset, with cream / google presets filled in as well.
- **Message and Memo Editing**: User messages can be written back into the input box for further editing; the memo editor supports `@` references.
- **Usage Filtering**: Usage statistics can be filtered by API profile.
- **Session Stats and Mobile**: Average TTFT is now tracked per session; the mobile page gains a token paste button.
- **Git Panel**: Changed files can be viewed as a tree and keywords copied; push/pull now requires double confirmation with a toggle.
- **Misc**: A "Clear App Cache" action in settings; a right-click menu on the pet window that can close pets; double confirmation for the Bash stop button.

## Improvements

- Empty AI responses are retried automatically.
- Digest generation now uses a non-streaming request.
- The sidebar conversation and project areas were refactored into standalone components and hooks.
- The command trigger stays visible and the typed input is preserved when running a command.
- Local-folder icons in the project list reuse the Explorer color scheme and have a hover state.
- Long thinking-block content gets a collapse entry at the bottom.

## Bug Fixes

- Fixed a deadlock when earlier records spanned less than one screen and the continuation page could not load.
- Fixed a scroll race condition in message pagination.
- Fixed the scroll position being reset when switching entries.
- Fixed the Win95 theme close-button hover color.

## v0.4.1

## New Features

- **Codebase Sync Cancellation**: In-flight codebase incremental sync can now be cancelled — turning the switch off or switching projects actually stops the embedding work running in Rust.
- **Project MCP Mode Indicators**: The project MCP panel shows status indicators for disabled modes (WorkFlow / codebase index / Plan), explaining why the tools are not added to the model request.
- **Mobile Compaction Visualization**: The mobile remote control page now shows context compaction progress and summary cards.

## Improvements

- Removed field truncation from the remote control bridge, sending full tool parameters and results to the mobile side.
- image-describe now prefers the main model when it supports vision.
- The user message rail now includes context-compaction messages.
- Duplicate directory names in the sidebar are disambiguated.

## Bug Fixes

- Fixed the no-confirmation whitelist silently missing historical tool names (terminal-execute).
- Sensitive fields (env/headers) are now masked when reading MCP server configs.
- Fixed the "Project MCP scope setting identity does not match" error after workspace relocation (self-healing write-back on read).
- Fixed https MCP server connection failures (rmcp now has TLS enabled).
- Fixed remote input-config changes failing while the chat input was not ready yet.
- Fixed the duplicated prefix in the image-describe tool registration name.

## v0.4.0

## New Features

- **Phone Remote Control**: Drive the current session from a phone browser — live conversation and streaming, workspace/model switching, tool approvals, question answering, image and file attachments, and session rollback, plus dedicated tool cards and workflow canvas cards. The remote HTTP service now runs in the Rust native layer, the public entry uses long-term tokens (one-time pairing codes and credential rotation removed), and the bundled frpc extends to macOS/Linux with multi-distribution Linux deployment and custom ports.
- **Workspace Relocation**: Project directory health is verified (missing location, unmounted volume, no permission) and can be relocated — conversations, memories, memos, scheduled tasks, and project-level settings migrate together, with merge support, a migration history, and undo.
- **Markdown Table Export**: Tables in replies can be exported as CSV or XLSX.
- **Header Session Variable**: custom header values support the `{{session_id}}` placeholder, expanded to the session ID of the conversation that sends the request; requests without a session context omit the header instead of sending the literal template.
- **Five new config scopes**: live MCP servers (with tool-level switches), request logging (expiry required), scheduled tasks (read-only; writes point to the renderer channel), tool approval allow-list (project-level), and usage statistics (read-only).
- **Five more config scopes**: centralized switches (`appSettings`, `yoloMode` read-only), privacy filtering (`privacy`), codebase index configuration (`codebase`, with project-level overrides), keyboard shortcuts (`keyboardShortcuts`, with conflict detection), and workspaces/project groups (`workspace`).

## Improvements

- Outbound requests now go through the Rust-side proxy uniformly (with no_proxy direct connections for local networks), shared by the MCP HTTP transport.
- MCP server lists return immediately while tool discovery happens on demand or in the background, so slow servers no longer block the MCP settings panel or the project MCP panel.
- Memory injection is frozen per session: memories added or changed mid-session no longer disturb the session's prompt-prefix cache.
- Faster fuzzy matching for indentation-sensitive files.

## Bug Fixes

- Images no longer trust the declared MIME — the real format is sniffed; inline images in tool results are persisted to disk so base64 no longer bloats the database and request context.
- Fixed 400s from strict Chat Completions providers when tool results carry images: images are emitted as one synthetic user message after the turn's tool replies.
- Added a pre-send context window guard that rejects oversized requests locally (images billed as vision), instead of letting the provider return an error.
- Fixed the status leak when a question card is unanswered or interrupted.
- Fixed the mobile history paging entry point.

## v0.3.1

## Improvements

- Computer Use screenshots now mark the mouse cursor position and include its coordinates; macOS cursor coordinate reading is fixed.
- The image proxy supports disk absolute paths, so images referenced by absolute path in replies now render.

## Bug Fixes

- Fixed image-bearing tool messages breaking tool-call pairing on Chat Completions: images are now attached to the tool message itself instead of a synthetic user message.

## v0.3.0

## New Features

- **Brand Icons**: Model and search-engine selectors now show brand icons in their options and labels.

## Improvements

- Optimized tool-result throttling and thinking-block rendering performance.
- Projects with running sessions can no longer be deleted.
- Mode toggles in the plus menu are locked while a session is running to prevent accidental switches.
- The memory modal gains a delete action.
- The stream-cursor icon set is expanded with more spinner-style icons.

## Bug Fixes

- Fixed the bookmark folder menu spilling outside the viewport; it now flips direction and clamps its height when space is tight, and repositions as the window resizes.
