# Release Notes

## v0.5.10

## New Features

- **User Message Search**: the in-conversation user-message rail filters by keyword - multi-term AND matching over message summaries and chip labels, arrow keys to move, Enter to jump, Esc to clear then close; the separate title and search rows are merged into a single header line.
- **Send Now (Alt+Enter)**: with text in the input it sends immediately; with an empty input it sends the first queued message and soft-interrupts the running sub-agent / WorkFlow so this round continues.
- **Decision Model Providers and Tools**: the decision model gains an OpenAI Decisions provider alongside TypeSafe Jev, each with its own context budget (Jev 48k characters / 50 judgments, OpenAI 200k characters / 50 judgments); a default-off `decision-evaluate` MCP server answers predicate, choice and score questions from text, JSON and local PNG/JPEG evidence.
- **Sensitive Command Risk Levels and Session Context**: confirmation cards show the low/medium/high level and score returned by the model (display and logging only, never part of the verdict); an optional "reference recent session" setting (off by default, 8 messages) attaches already-rendered recent messages and tool-call summaries so the model can tell user-requested actions from AI-initiated ones.
- **Codebase Review Relevance Threshold**: with a threshold configured the model asks a probability question per result and keeps those that meet it instead of using binary verdicts, and the probabilities flow back into the review output and tool cards.
- **Redesigned Theme Settings**: every section is its own card with an accent title bar and a capped reading width, and the AI / user avatars become side-by-side cards with an always-visible Reset button (disabled while the default avatar is in use).

## Improvements

- Decision-model calls are recorded in the usage page (`request_method=decisions`, grouped by model and request method with a new type column), covering codebase review, the `decision-evaluate` tool and sensitive-command judgment.
- Embedded ultra-long input is sliced by a conservative token budget instead, splitting in batches and retrying by halves when the endpoint reports the input as too long, skipping unprocessable blocks with a WARN log carrying the failed file and the progress before the failure; file reading and token counting move off the async runtime.
- Browser screenshots use frame subscriptions, so capturing a minimized or occluded tab no longer hangs; OpenAI requests send structured data as JSON text uniformly.
- Failed tool calls can be corrected and retried and `askUserQuestion` answers can be undone and re-answered; sidebar items and collection members are unloaded once the collapse animation ends, LSP and task paths drop the Windows extended-length prefix (`\\?\`) for display, and the picture library menu, log-clearing confirmation, panel widths and skeleton animation were polished.

## Bug Fixes

- Remote deletion failures report the original SFTP reason, a missing entry counts as deleted and rollback stays idempotent; the "cannot cancel" prompt during recovery is idempotent as well and no longer re-triggers the spinner.
- `git status` parses with `porcelain -z`, so staging or discarding files whose names contain quotes or backslashes no longer misaligns; discarding changes verifies that `git clean` really removed untracked files and returns the git output on leftovers, and the front end refreshes on both success and failure while showing git's original message.

## v0.5.9

## New Features

- **SSH Remote Skills**: scan, install, uninstall and start/stop project-level skills in an SSH remote workspace; installation is uploaded to the remote `.snow/skills` atomically over the SSH channel, a failed remote scan reports an error instead of silently coming back empty, and the tool chain falls back to global skills.
- **IM Chat Style and Custom Avatars**: theme settings gain an IM style switch with AI and user avatar slots; pick your own images (kept in `~/.snowapp/chat-avatars`) or fall back to the built-in pet head and default icon.
- **Message Windowing**: long conversations (running ones included) keep only a tail window in the renderer and unload older messages back to the database, where paging fetches them by cursor; trimming is paused while you scroll back, while a page restore is in flight or during first-screen positioning.
- **Archived Conversation Search**: the archived list filters by title, summary and last-message preview.
- **Storage Overview**: the Storage & resources tab shows a usage overview with a per-category legend, a used total and a refresh action; each storage item becomes a collapsible card and "Optimization & cache" is grouped into one.
- **Bundled Fonts**: ZCOOL XiaoWei and Jost Light (SIL OFL 1.1) ship with the app and are selectable as built-in font presets.
- **Grouped Tool Selector for Sub-Agents**: MCP tools are grouped by server with expandable groups, bulk selection of search matches and per-server selection counts.
- **Right Panel Width per Content Type**: every content type (browser, terminal, file viewer, explorer, ...) remembers its own dragged width and gets a tailored default and drag range.

## Improvements

- **Bounded Bash Output**: bash tools and resident sessions capture head and tail windows only and report `truncatedBytes`; streaming forwarding stops with a prompt past the limit, sentinel detection uses a sliding window instead of rescanning the whole output, Windows binds the command process tree to a Job Object (other platforms use an independent process group), and background tab screenshots use layered timeout retries gated by a main-process rAF probe.
- **SSH Connection Held by the Active Workspace**: the command-session connection pool and implicit connections are gone, unconnected calls return a unified `SSH_WORKSPACE_NOT_CONNECTED`, the project list and tree show localized connection-state icons, "new session" on a disconnected SSH project triggers an explicit reconnect, and background channels (checkpoints, repo wiki) hold the connection through workspace leases.
- **Unified Window and Terminal Appearance**: the Windows 11 window border no longer follows the system accent color, and the terminal canvas takes its background from `--terminal-bg` so theme presets and layout styles restyle it together with the panel.
- Read-only tool results are cached with an entry and character cap (48 entries / 2M characters), so a long run no longer keeps every result in memory.

## Breaking Changes

- The FRP tunnel is removed: public mobile remote control now uses the in-process SSH2 reverse tunnel only. Config storage moves to schema v3 (v2 migrates automatically) and legacy FRP bundles are rejected, so deployment needs a single `snow` A record plus the SSH2 tunnel port.
- The Midnight Blue, Forest Green, Rose Pink and Solarized presets are removed; their legacy ids alias to snow.

## Bug Fixes

- Background ahead/behind polling no longer stacks `git fetch` processes when the remote is unreachable: the renderer single-flights and backs off (60s -> 600s, reset on success), the main process shares the in-flight fetch per repository, and the native fetch is killed after 45s.
- Compaction errors can be dismissed, and the input toolbar toggle no longer fires twice.

## v0.5.8

## New Features

- **Sidebar Conversation Hover Card**: hovering a conversation opens a card with its full title, pin state, relative time and project, replacing the title marquee; the card hides while any modal is open. Titles of running conversations get a shimmer, and sidebar badges stay visible when the sidebar is collapsed.
- **Resizable Input Composer**: drag the handle above the input to set its height, and keep dragging up to expand it into a large-screen composer (drag the handle down or press Esc to collapse).
- **Structured Read-Only File Previews**: spreadsheets (calamine) and SQLite databases preview with their real structure - windowed rows, column types and merge regions - PPTX extracts titles and text blocks in slide order, and DOCX is rendered from its original bytes; files that cannot be previewed show a localized reason with "open with system app" / "show in folder" exits, while the extract-text view stays available.
- **Sensitive Command Denial Review**: with decision-model hosting on, a new "let me confirm when denied" option turns a model denial into a manual confirmation instead of an automatic rejection; the card marks that you are overriding the model's verdict and the outcome is written to the system log.

## Improvements

- **WorkFlow Composer runs without an AI hop**: sending from the composer no longer asks the model to forward the graph. The app writes the user message and a `workflow-workflow-generate` tool call directly (no authorization prompt), so the workflow card appears immediately and you just press "Run"; the execution result is still returned to the AI for summary or resume. The user message is now a collapsed WorkFlow chip (flow name plus node/edge counts, hover to see the node list) followed by your note, instead of the instruction text and JSON payload. The conversation title is generated once the real reply after the workflow finishes arrives, and the summary input collapses chip tags instead of feeding base64 payloads to the title model. Rolling back a composer submission no longer injects an unreadable tag into the input box: the WorkFlow composer reopens with the canvas, flow name and note restored from the graph snapshot.

## Bug Fixes

- Fixed the Responses channel's default / off tier not taking effect: the backend deep-merges `config_json`, so verbosity and fast mode are now written explicitly instead of being omitted.

## v0.5.7

## New Features

- **WorkFlow Composer**: with WorkFlow mode on, the input toolbar opens a composer where you draw nodes and edges and fill in node prompts; the graph is sent as a JSON payload in your message, the turn is forced into WorkFlow mode and forwarded verbatim to `workflow-workflow-generate`, reusing the existing workflow card and execution pipeline.
- **Sub-Agent Concurrency Limits**: a global cap across all conversations (0 = unlimited) plus a per-conversation cap that never exceeds it; capacity checks count both the conversation's own occupancy and the total running runs, and the settings panel exposes both.
- **Browser History Pagination**: browser history switches from "load more" to page pagination - the list fills the available height and scrolls internally, deleting the last item of a page steps back one page, and clearing resets to the first page. Auto-scroll is now enabled by default.
- **Checkpoint Snapshot Reclaim**: deleted checkpoints log their object references for background recycling instead of retaining every content object, and write leases avoid competing with snapshot capture; a full cleanup runs at startup and only removes unused objects past the retention period, while newer content is still reused as cache. The remote checkpoint scan timeout and the snapshot retention days are now editable settings.
- **Plugin Conversation API Profile Binding (restored)**: `conversations.setApiProfile` and the `apiProfile` option of `conversations.create` return after their removal in v0.5.6 (write actions 210 -> 212). `create` can bind a new conversation to a profile name and rejects an unknown profile before any conversation exists; `setApiProfile` re-binds an existing top-level conversation (an empty string unbinds it, the change applies from the next request, and sub-agent / WorkFlow node conversations are rejected).

## Improvements

- The HTML file preview button now reflects the card's expanded state.
- Spin animations are composited on an inline-flex wrapper instead of the SVG element, so loaders stay smooth at DPR > 1.
- Sub-agent built-in prompts are demoted when configured prompts are present, and the sub-agent failure bar stays visible while an abandoned run winds down.
- The input area plugin slot (`chat.input.actions`) moves into the chat input view with a layered stack style.

## Breaking Changes

- Plan Mode is removed: its system prompt, approval tool, per-conversation storage column and write gate are gone, along with the related UI, i18n, docs and remote-control entries.

## Bug Fixes

- Pause controller: the session-key migration is synchronized so the button no longer gets stuck in the paused state, and the paused display state is cleared when the controller is missing during recovery.
- WorkTree: sending with WorkTree enabled but no valid binding now fails closed with a prompt instead of falling back to dirty mode; execution failures keep a readable `WorktreeBindingError` reason, rollback takes the first persistent boundary after an uncommitted target and refuses to descend to the project root when checkpoints exist, and a local rollback re-checks whether saving moved the boundary to avoid truncation misalignment.
- Anthropic tool call IDs now satisfy the provider's charset.

## v0.5.6

## New Features

- **Durable Sub-Agent Runs**: dispatch, resume, cancel and completion now go through a persisted run record (runs, parent tasks, request receipts and the parent inbox live in SQLite), so runs survive a restart and stay visible in the sidebar; rollback and deletion pass an explicit gate.
- **Per-Dispatch Execution Mode**: the user execution-mode setting is only the default - `activate` / `continue` accept an optional `executionMode` argument that overrides it, and Workflow nodes may dispatch sub-agents synchronously only.
- **Multi-Engine Web Search**: the single search engine setting becomes a multi-select list; the selected engines run in parallel and their results are de-duplicated and re-ranked by a local relevance score, with new options for site restriction, time range, language and per-call engines, plus Brave, Google, Startpage, Seznam, Yahoo and Yep engines.
- **Plugin Sign-In Panel**: an OAuth provider can declare a `panel` that takes over the sign-in UI inside the OAuth dialog instead of opening the browser, driven by the new `api.oauth` API; `authorize` becomes optional.
- **Repo Wiki over SSH**: repo wiki generation works in SSH remote workspaces through read-only views (file tree snapshot, fingerprint, git metadata).
- **Browser Panel Shortcuts**: `mod+shift+a` shares the current browser tab with the agent and `mod+shift+e` picks an element while the browser panel is focused; `Ctrl/Cmd+D` now toggles the project explorer.
- **Unified Edit Context Menu**: all windows (main, pet, detached panels) share one right-click edit menu for input boxes.
- **Image Describe Lightbox**: described image thumbnails open a full-size overlay, dismissed with Esc, the close button or a backdrop click.

## Improvements

- Volatile host facts and request-only instructions move to a trailing user message, so the cached prompt prefix survives run-status notifications and sub-agent wakeups; the sub-agent tool set stays stable and the host ledger section is omitted when there is no delegation history.
- The model selector returns to a flat list (brand grouping is removed).
- Layered and flush theme header and sidebar spacing is tightened, and the image preview window becomes display-only - clicking the image chip opens the large image.
- Mobile remote control aligns sub-agent tool results and sync/async semantics with the desktop contract.

## Breaking Changes

- Plugins can no longer bind a conversation to an API profile: `conversations.setApiProfile` and the `apiProfile` option of `conversations.create` are removed (212 -> 210 write actions). Conversation profile binding is owned solely by the runtime conversation-identity check, so the plugin write domain no longer exposes a second, unvalidated entry point for it.

## Bug Fixes

- File links starting with `~/` expand the home directory before the absolute-path check, so home-directory references resolve again.
- A failing app log write no longer interrupts committed work (synchronous native throws are caught).
- LSP shutdown is ordered as shutdown, exit, wait, then kill.
- Mobile authorization and question cards collapse to a 44px bar by default so they no longer cover the transcript.

## v0.5.5

## New Features

- **Conversation API Profile Binding**: plugins can bind a conversation to a specific API profile through the new `conversations.setApiProfile` write action and the `apiProfile` option of `conversations.create`; background sends keep the bound profile, so sub-agents inherit it.
- **Edit Area Context Menu**: the editor gains a right-click menu for cut / copy / paste / select all, executed by the main process with unavailable items greyed out.
- **Use Guide Floating Menu**: the sidebar Use Guide button opens a floating menu linking straight to the shortcut guide and the update log.
- **Model Selector Grouping**: the collapsed model list is grouped by brand.
- **Extra High Thinking Level**: supported models gain an "Extra High" thinking option.
- **Reply Prediction Polish**: prediction requests now record token usage against the conversation, and predictions are cached per conversation so they survive session switches.
- **OAuth Plugin Response Hooks**: OAuth plugins can now rewrite responses - `transformResponse` rewrites a whole non-SSE body before parsing and may override response headers, `onResponseChunk` translates each upstream event (SSE and WebSocket), and `fetch` lets the plugin take over the transport while the native layer keeps parsing, usage accounting and cancellation; providers that take over the transport are marked "Custom transport" in the provider list and sign-in dialog.

## Improvements

- Tool error correction is extracted into a shared executor, giving sub-agents and Workflow nodes the same automatic correction as the main session, with corrected calls going through their own authorization flow again.
- Auto-compaction is unified behind a shared gate at every request entry point (main loop, sub-agent loop, Workflow nodes); failures now surface as a dedicated notice and stay visible.
- The plus menu stays next to the expand button when the right panel is collapsed, and terminal scrollbar styling is aligned with the rest of the app.

## Bug Fixes

- Empty pending assistant messages render as hidden placeholders, removing an extra flex gap.
- Task history saves use an IMMEDIATE transaction and a write lock.
- Derived path caches are cleared after the checkpoint root changes, and inherited read-only attributes are stripped when publishing content-addressed objects.
- File snapshots resolve the entry type first, skipping directories and missing paths to avoid noisy handler errors.
- Windows process trees verify parent-child relations by creation time, so pid reuse no longer merges unrelated subtrees.

## v0.5.4

## New Features

- **Reply Prediction**: an opt-in ghost hint in the chat input predicts your next message from recent history and saved user memories, accepted with Tab.
- **Cross-Project User Memory**: memory tools gain `scope=user` - global entries are injected into every project and ranked first.
- **Repo Wiki**: the AI reads the codebase with read-only tools and generates an architecture guide stored under `~/.snowapp/repo-wiki`, with token usage tracking and the wiki path injected into the system prompt.
- **File Lookup Tool**: `grep-find` finds files by glob (ripgrep `--files` with a native fallback and SSH remote dispatch), reports per-root stats and searches linked projects.
- **Image Path Annotation**: vision-capable models now receive the resolved absolute path and MIME type of attached images, so they can pass them straight to `imagegen-generate`.
- **Copy Generated Images**: generated images can be copied to the clipboard from the tool card, lightbox, drawing studio history and image library.

## Improvements

- The plus menu hides toggles in a secondary panel, grouping auto-scroll, auto-format, reply prediction and tool correction under Preferences.
- Workspace symbols and LSP result notices get a reworked view: symbol category icons, scope splitting, copy path / copy list, and severity-graded status, description and warnings.
- Global MCP server and Skill switches now ask for confirmation, explain the impact and offer to keep them enabled for the current project.
- Tool card display names are resolved by a shared helper, including readable fallbacks for external MCP tools; sub-agent `sendMessage` cards parse incomplete streamed arguments safely, work after a restart and map error codes.
- External MCP tools no longer participate in the checkpoint execution lock.
- Session state is split into separate contexts with stable sidebar projections and incremental scroll following, reducing re-renders while streaming and switching sessions.
- The plugin market gains a "Hide installed" toggle with an installed count.

## Breaking Changes

- The built-in CodeLens service and tools are removed; code navigation is covered solely by the `lsp` server, with grep/read as fallback.

## v0.5.3

## New Features

- **System Log Export**: export system logs as plain text or JSON - the current filter, split by day into a chosen folder, or individually selected entries. Rust queries and formats, the main process owns save dialogs and file writes.
- **Built-in MCP Master Switch**: the MCP settings panel gains a Built-in category with a global master switch; a globally disabled built-in server can no longer be enabled per project.
- **Sub-Agent Retry & Concurrency**: a failed sub-agent request suspends the main session until the user retries or abandons it, truncating the failed exchange and revoking its message id remapping before the retry; a new global sub-agent concurrency limit (1-16, default 3) queues excess requests, and throttling is classified apart from transport failures.
- **Sub-Agent Message Delivery**: pending messages carry a source chip (user / teammate / main agent) with session-isolated jump, the new `sub-agents-sendMessage` card shows sender to recipient, queue time and pending / delivered / withdrawn status, teammate prefixes in user bubbles become a source badge, and prompts share a preview component with expand/collapse, word and line counts plus copy.
- **Browser Scroll Tool**: a new `browser-scroll` tool scrolls the document or an inner scroll container and reports whether it moved plus before/after position; accessibility refs are scoped per tab and document generation so stale refs are rejected after navigation, and commands without `instanceId` target an agent working tab instead of the user's active tab.
- **Classified Computer-Use Errors**: computer-use failures are classified with actionable guidance and an environment snapshot, and action results report `landedOnTarget` / `focusedWindow`.
- **Plugin OAuth Header Schemes**: OAuth plugin hooks gain `ctx.headerSchemes` to create, update, bind and delete custom header schemes (the ones the app actually sends); account hooks bind the current profile by default and can only bind the plugin's own OAuth profiles.

## Improvements

- **Smoother Streaming**: a session-level streaming indicator slot stays pinned to the end of the message for the whole run, content growth is smoothed inside the clipped viewport, and markdown reveals adaptively at about 25fps.
- Oversized tool results keep their head (about 2/3 of the budget) and tail (about 1/3) with an omitted-character marker, so trailing errors and conclusions are no longer cut off.
- WebSocket connection expiry (including `websocket_connection_limit_reached`) now shares the failure classifier, retry policy and replay-safety gate of SSE, with per-connection ids for log correlation and a forced fresh connection after a pooled socket fails or the server declares expiry.
- Sub-agent tool whitelists override project-level tool toggles (the global blacklist and Lite mode still apply), `*` is restricted to the built-in `agent_general`, and unavailable whitelist tools are reported with reasons.
- Tool input schemas inline pure `$ref` nodes so stricter gateways (xAI) no longer reject combinator branches.
- Sharing a browser tab manually now auto-approves pending share requests.

## Bug Fixes

- Fixed the Git branch dropdown not closing on the first click outside.

## v0.5.2

## New Features

- **Plugin OAuth Providers**: a plugin declaring `oauth.entry` in `plugin.json` registers extra OAuth sign-in providers without an app release. Sessions, PKCE, callback listening, persistence, refresh scheduling and locking stay in the Rust core; the plugin (main process) only supplies `authorize`, `exchange`, `poll`, `refresh`, `models`, `quota` and `transformRequest` hooks.
- **Provider Picker Split**: the OAuth provider picker groups built-in providers and plugin providers separately, and device-code flow is supported.
- **Collection Reordering**: sidebar collections can be dragged to reorder in both list and tree views, with insertion lines while dragging.
- **Collapsible Panels & Changes Tab**: the panel divider can be dragged past its limit to collapse the panel and pulled back to expand it; with the right panel collapsed, the top bar gains a Changes tab (branch dropdown plus Git changes) that opens file diffs in the panel.

## Improvements

- Installing, enabling, rescanning or deleting a plugin re-syncs the provider registry immediately; the plugin list and market are grouped into Panel, OAuth and Script.
- Hovering the sidebar's More entry shows per-panel count badges that open the panel on click.
- Streamlined scheduled-task footer spacing and the load-more button style.

## Bug Fixes

- Fixed the tool-call timestamp layout broken by its tooltip wrapper.

## v0.5.1

## New Features

- **Model Connection Tests**: the decision, embedding and reranking model pages gain a "Test connection" button with a persisted status column (latency, HTTP status, embedding dimension).
- **Tool Card Chips Style**: tool calls can render in a compact chips style via `Ctrl/Cmd+Shift+U`, remembered across restarts and listed in the shortcut help.
- **Native Browser UA**: the built-in browser sends a standard Chrome/Edge UA matching the detected local browser version instead of an Electron token.

## Improvements

- Model failures are no longer silent: reranking falls back to vector ranking, and an unusable decision model reports why LLM review or manual confirmation took over.
- The last failed codebase indexing run is kept per project, and the system log panel gains a module filter.
- Storage and image-library migrations show a non-closable progress dialog with the target path and a cancel-and-rollback action.
- Copying a user message keeps in-app chips, while pasted external plain text stays unchanged.
- Removed the Tesseract preset (existing selections fall back to Horizon); Horizon now uses emerald green with neutral grays and warm porcelain-white light surfaces.

## Bug Fixes

- Fixed the Flush layout top bar column layout and separators.
- Dropped `anyOf`/`oneOf` from browser MCP tool schemas for stricter providers.

## v0.5.0

## New Features

- **Workflow Scheduled Tasks**: scheduled tasks can run as a workflow, a DAG of AI nodes with per-edge delays edited on a canvas, with run-state tracking that survives restarts.
- **Custom API MCP Transport**: map Web API endpoints to MCP tools (one tool per endpoint), with placeholders in path, query, headers and body, shared cookies and headers, and test requests sent straight from the unsaved draft.
- **Layout Styles**: a new global layout style with Island, Layered and Flush modes.
- **Sub-Agent Acceptance Checklists**: sub-agent activations can carry an acceptance checklist, and each item is validated against real tool-call evidence.
- **Browser Action Receipts**: click, type, form-fill, select and key actions return a receipt that separates dispatch from the observed result; the network list gains method and header filters plus per-request details.
- **Mobile Tool Correction**: the mobile remote control gains the tool-call auto-correction switch and correction panel.

## Improvements

- Every field of a scheduled task is editable, and the agent can create, update, run, cancel, pause and delete tasks.
- Memos, blocked site patterns and scheduled task creation move into the config service.
- The MCP list gains search, HTML preview gains a toggle, and `config-logs-read` is disabled by default per project.
- Plus menu plugin tabs are grouped with labeled dividers; privacy switches are grouped and collapsible.
- Plugin scripts with updates can be updated in batch with one click.
- Faster rollback and parallel data loading; context handoff prompts for Goal and Plan modes are more precise.

## Bug Fixes

- Fixed `{{session_id}}` not being expanded in custom headers of tool-correction requests.
- Fixed the image-description cache ignoring the prompt.
- Fixed sidebar padding and the user-message rail layering in the Layered layout.

## v0.4.29

## New Features

- **Clickable File Paths**: file paths in chat messages open local or SSH remote files directly in the right panel.
- **Isolated HTML Preview**: HTML code fences and file artifacts preview in isolation, with zoom controls, shared syntax highlighting and responsive panels.
- **Image / Canvas Stream Cursor**: the streaming indicator now supports any image (including GIF) and JavaScript Canvas drawing scripts besides dots and icons.
- **Scheduled Tasks After App Closed**: the system scheduler can wake the app in the background to run a task, and missed runs are caught up on the next launch.
- **Privacy Masking Enhancements**: built-in rules can be switched off individually, custom regex rules are supported, and a new database connection string rule is included.
- **Orphaned Data Cleanup**: scan and remove sessions, archives, snapshots and memories left behind by removed projects.
- **Launch at Startup**: a new switch in General settings.

## Improvements

- Mobile remote control adds an `/api/live` real-time channel that pushes incremental state.
- History requests are slimmed before reaching the model: the oldest images are dropped when over budget, and TODO results lose timestamps and fold completed items (local data is unchanged).
- Hardened browser MCP contracts and debugger lifecycles.
- The custom window frame now extends to Linux.
- Deleted or archived sessions get tombstones so late persistence cannot rebuild them.

## Bug Fixes

- Fixed click-through in the file mention popup and truncated model names on wrapped lines.
- Fixed the lost start point of run timing.
- Fixed image generation not falling back to the URL when `b64_json` is empty.
- Fixed a default API config being seeded when the config list is empty.

## v0.4.28

## New Features

- **Automatic Tool-Call Correction**: when a tool call fails, the basic model proposes fixed arguments and the same call is retried (up to 3 attempts, re-authorized each time), shown in an expandable correction tree that survives restarts; enabled by default with a Plus menu toggle.
- **ROLE Prompt Override**: the global and project ROLE editors gain an "Override built-in prompt" switch that replaces the whole built-in template (Plan / Goal / WorkFlow / WorkTree modes keep their guidance).
- **Developer Tools**: a Plus menu entry opens the current window's DevTools.
- **Search Favicons**: web search results show each site's favicon.
- **Quick Default Profile**: the model dropdown has a pin button to enable any API profile as the default.

## Improvements

- Pending messages are restyled as a tab-like card attached to the input box.
- Context menus and dropdowns gain grouped separators, and mention popup keyboard/mouse interactions are smoother.
- Globally disabled MCP tools are read-only at the project level; the imagegen execution-mode select uses CustomSelect.

## Bug Fixes

- Fixed stream timeouts with large image attachments: images are downsampled to 1568px and the first-byte window scales with request size (default idle timeout is now 60s).
- Fixed OAuth model-list fetching not retrying like API-key providers.

## v0.4.27

## New Features

- **Remote File Transfer**: SSH remote files can be uploaded and downloaded, with a transfer panel and conflict handling; the remote file preview gains a refresh button.
- **Explorer Upload**: local files can be uploaded into any folder.
- **Live HTML Preview**: a new HTML render tool previews pages live within a conversation.
- **Multi-Image Theme Background**: theme backgrounds can rotate through several images with a crossfade, remembering the current image.
- **Conversation Control in App Control**: App Control can create, send to, activate and abort conversations.
- **Batch Memory Management**: the memo panel supports AI-driven memory deletion and batch operations.
- **Userscript Request Rewriting**: the dialog request proxy layer lets userscripts rewrite requests and responses.

## Improvements

- Clicking the scroll-to-bottom button now plays an animation; the sidebar guide becomes a pure icon button with hints.
- Built-in pets can no longer be installed or used to override other pets.
- OAuth subscription identity headers are now managed through header schemes.

## Bug Fixes

- Fixed SSH repositories reading files from local paths when opened from the changes area.
- Fixed the settings sidebar content not closing when creating a new conversation.

## v0.4.26

## New Features

- **Async Image Generation**: image-generation batches and tasks persist in storage; async mode returns a pending receipt right away and wakes the session with one batch summary when all tasks finish, with new execution-mode settings (auto / sync / async) and real Rust-side upstream concurrency limits.
- **Remote-Control SSH2 Tunnel**: phone remote control can connect through an optional SSH2 tunnel.
- **Plugin Network Scope**: plugin outbound requests require a `network` privacy authorization (the market shows a warning when it is missing), and plugins can open WebSocket / HTTP connections directly.
- **Plugin Conversation Actions**: plugins can send user messages to conversations, create empty conversations and switch the app to a given conversation.
- **Session-Aware Visual Requests**: image recognition and imagegen image reading now resolve the session-bound API document, custom request headers and system prompts, consistent with the main flow.
- **Custom System Prompts Everywhere**: user-configured system prompts now apply across API modules.
- **Standalone Panel Polish**: independent windows remember their last size, and closing the last tab of an independent panel asks for a second confirmation.

## Bug Fixes

- Fixed saving an OAuth archive overwriting the library's latest token with an older snapshot.
- Fixed `~` in local workspace parameters not being expanded to the home directory.
- Fixed SSH paths missing the authority prefix when opening a terminal from the explorer.
- Invalid and orphaned Git work-tree records are now cleaned up.
- Fixed plugin tool-call cards falling back to the built-in card after a plugin list refresh (the renderer match cache could return a stale plugin view, so already-mounted cards never recovered).

## v0.4.25

## New Features

- **Separate Windows**: Right-panel tabs and sessions can open in their own windows, kept in sync with the main window, with new shortcuts.
- **OAuth Quota Panel**: Subscription channels show their remaining quota in API settings; the panel collapses and remembers its state.
- **System App Open**: Files in the explorer can be opened with the system default application.
- **`/help` Command**: A new `/help` guide for built-in commands and features.
- **Tool-Call Watchdog**: Tool calls are monitored for stalls, and the decision model's verdict appears on the card.
- **API Key Visibility Toggle**: The API key field can be shown or hidden.

## Improvements

- Every MCP call is bound by a per-call timeout.
- Codebase embedding dimensions can be left empty.
- Plugin input-bar Actions drop the persistent diff and preview buttons; Restore moves into the more menu.
- Drawing models and their capabilities are driven by each channel's model configuration.
- Connection establishment has an idle timeout, and retry parameters are capped.

## Bug Fixes

- Fixed the Linux install script being packaged with CRLF line endings in Windows builds.

## v0.4.24

## New Features

- **Task Manager Performance Panel**: Processes, performance trends, LSP services and alerts are split into tabs, with 60-second trends and exact LSP session stop / restart.
- **Plugin Tool-Call Renderers**: ESM plugins can supply cards for matching tool calls, falling back to the generic card on failure; the Anysearch desktop card is now provided by its own plugin.
- **MCP Access Banner**: Browser and terminal panels show a banner when MCP is off, with a jump-to-open action; "don't ask again" applies app-wide.
- **Pet Theme Background**: Desktop pet animations can serve as the theme background.
- **Plugin Binary Responses**: `api.net.fetch` accepts `responseType: "arraybuffer"` and returns the raw bytes as base64.

## Improvements

- Repeated read-only calls with unchanged arguments and targets reuse the earlier result; a loop is only stopped after three consecutive repeats.
- Tool authorization and question cards submit with Ctrl/Cmd+Enter, and the Bash tool card can send a bare Enter to interactive programs.
- LSP sessions reuse eligible gopls workspaces and reclaim idle sessions periodically, within session and cold-start budgets.
- Plugin input-bar actions keep running across floating-panel and session switches, and drafts persist in background sessions.
- Plugin metadata adds a `processes` domain (task manager process tree); `app.processMemoryBytes` is removed.
- Compact theme refines hover, selection, disabled and focus feedback; the top bar adapts to macOS native full-screen.

## Bug Fixes

- Fixed Anthropic subscription login endpoints, request headers and thought-chain display.
- Fixed the daily usage trend chart's hover position and selected point being misaligned.
- Fixed screenshots of background browser tabs hanging.

## v0.4.23

## New Features

- **App Task Manager**: a new right-panel tab lists the app's processes (main, renderer, GPU, utility, child) with CPU, memory and thread counts refreshed every second, plus search, sorting and an "end process" action behind a confirmation.
- **Search File Contents with `@@`**: `@@keyword` in the chat input searches file contents instead of names, and a picked reference carries the matched line ranges.
- **Input-Bar Plugin Submenu**: a panel can contribute up to 8 submenu items to its chat-input Action, opened by right-click, the "more" button or the keyboard (Shift+F10 / ContextMenu / Alt+ArrowDown) with full keyboard navigation.
- **Custom Commands Config Domain**: custom slash commands gain a `config` domain (list / get / set / delete) for plugins, with the `/` menu and the settings panel refreshing immediately.
- **Plugin Market Download Counts**: market entries show their download count, with a clear notice when the GitHub API quota is exhausted.
- **Tool Rejection Notice**: a rejected tool call keeps a persistent bar on its card showing the rejection reason (or that the user gave none).

## Improvements

- The retry interval can be a fixed duration per API profile; leaving it 0 keeps the exponential backoff (capped at 30s).
- Prompt optimization can optionally use the current project's code as context — opt-in, bounded, sources reviewed before rewriting, never sent automatically.
- Sub-agents and Workflow nodes inherit the thinking strength chosen in the parent conversation's input bar, falling back to the profile default when the tier is unsupported.
- Responses: recognizable transient upstream stream errors are safely recovered, and auth headers are fully redacted from diagnostics.
- Global crash capture covers main-process uncaught errors, renderer rejections and Rust panics (with backtrace) written to disk, and pending logs are flushed on exit.
- Plugins can be updated in bulk from the plugins panel, and the non-destructive confirmation button no longer uses the danger color.
- Image generation settings: unified model labels and checkboxes, theme-following colors, no duplicated labels or column misalignment.

## Bug Fixes

- Fixed Gemini tool history dropping calls without an ID, which lost their parameter cleanup and result retention.
- Fixed the web-search headless browser staying resident forever: it now closes after 3 minutes idle, releasing its memory and the whole child process tree.
- Fixed image generation styles referencing undefined CSS variables (hover feedback and warning banners could be invisible).
- Fixed the send button staying disabled while a compaction is running.

## v0.4.22

## New Features

- **Multiple Drawing Models per Channel**: a channel can host several drawing models, each with its own size, quality, thinking level, aspect ratios, resolutions and custom prompt; generation resolves explicit parameters first, then the matched model, then the channel defaults.
- **Desktop Pet Chat**: the pet window gains a chat with conversation history, uses the conversation transcript as its background, and ships built-in pet characters plus an animation-speed setting.
- **Prompt Optimization in the Drawing Workbench**: optimize the prompt in place, cancel mid-run, and restore the previous prompt in one click; generation is never triggered automatically.
- **Commit Detail Card**: adds the changed-file count, links to the commit on GitHub / GitLab, and can record the commit into a memo.

## Improvements

- Retry observability: every API path (chat, anthropic, gemini, interactions, responses, vision, model list) now logs retries through one entry point with a consistent context, and the server-error keywords cover the Cloudflare 5xx family.
- The retry notice shows a live "retrying in N seconds" countdown instead of up to 30 seconds of blind waiting.
- Auxiliary requests (summary, commit message, prompt optimization, theme palette, code review) use a fixed retry count of 3, so background tasks fail fast.
- Sidebar session tree: the sub-agent and Workflow expand toggles are unified into one, and tree refreshes are decoupled from the main conversation list.
- Decorative emoji are replaced with lucide icons in the drawing gallery, tool cards and settings panels.

## Bug Fixes

- Fixed permanent 400 parameter errors being retried forever: numeric keywords are matched on digit boundaries, so random digits inside a conversation id no longer look like a 5xx status code.
- Fixed flickering and stale states of the input-bar plugin Action: it now stays silent, keeping only the spinner and the restore button.
- Fixed task-history persistence and message-footer snapshot identity: transient write failures are retried, and a footer snapshot is bound to its own response.
- Fixed file-tracking false conflicts with concurrent terminal commands: the conflict window no longer blocks file writes and marks a contaminated lease instead.
- Restored Chromium's default occlusion throttling (removed `backgroundThrottling: false`), fixing alt+tab stutter while a session is streaming.

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
