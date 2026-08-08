# Feature Module Architecture and Data-Flow Diagrams

> This atlas splits maintainable Mermaid sources by feature. Diagrams retain stable boundaries only. When implementation changes, update both the maintenance note and source anchors instead of packing every internal function into one oversized graph.

## 1. Chat and Conversations

**Purpose and boundary**: Renderer owns message UI, each conversation's agent loop, and stream state. Rust normalizes provider requests, parses streams, and persists model exchanges.

```mermaid
flowchart LR
    input["Chat input"] --> loop["Renderer useAgentLoop"]
    loop --> preload["Preload createResponseStream"]
    preload --> ipc["Main chatHandlers"]
    ipc --> stream["Rust conversation stream"]
    stream --> provider["Chat Responses Anthropic Gemini"]
    provider --> db["chat_conversations chat_messages usage_records"]
    stream -. "streamId chunks" .-> loop
    loop --> view["Message rendering and run metrics"]
```

**Maintenance**: Do not draw `sessionProxy.ts` into the AI stream. Renderer builds `toolResultsJson`, which enters the next model round.

**Source anchors**: `src/renderer/components/mainContent/chatMessages/hooks/useAgentLoop.ts`, `src/preload/modules/apiConfigApi.ts`, `src/main/ipc/handlers/chatHandlers.ts`, `native/src/api/conversation/stream.rs`, `native/src/storage/services/chat_conversations.rs`.

## 2. MCP Tool Discovery and Calls

**Purpose and boundary**: Rust builds the model-visible tool set and executes tools. Renderer owns user authorization and invocation rounds but cannot bypass Rust policy.

```mermaid
flowchart TD
    request["Model request scope"] --> discover["collect_all_mcp_tools"]
    builtin["14 fixed-order built-in services"] --> discover
    skills["Dynamic Skills tool"] --> discover
    external["External MCP stdio and HTTP discovery"] --> discover
    flags["Project enablement codebase index imagegen config Plan Mode"] --> discover
    discover --> model["Provider-specific tool JSON"]
    model --> callNode["call_mcp_tool"]
    callNode --> policy["Plan project and sub-agent checks"]
    policy --> route["Built-in remote external or special route"]
    route --> mask["Privacy-masked result"]
```

**Maintenance**: Append fixed services to the end of `builtin_services_in_order` to preserve prompt caching. Skills and remote workspace are not counted among the 14 fixed services.

**Source anchors**: `native/src/mcp/builtin.rs`, `native/src/mcp/tools.rs`, `native/src/mcp/service.rs`, `native/src/mcp/external/`, `native/src/mcp/privacy_mask.rs`.

## 3. Skills

**Purpose and boundary**: Skills config is global- or project-scoped, while the model-side tool is injected per request. Built-in Skills and docs are idempotently synced into `~/.snow/` at startup.

```mermaid
flowchart LR
    startup["Main bootstrap"] --> sync["ensureBuiltinSkills and docs"]
    sync --> home["~/.snow skills and docs"]
    config["config service skills scope"] --> store["SkillsConfigService"]
    project["Active project scope"] --> tool["SkillsService dynamic tool"]
    home --> tool
    store --> tool
    tool --> prompt["Model-visible skill executor"]
    prompt --> load["Load selected skill instructions"]
```

**Maintenance**: `skills_config` is the delegated implementation behind config's skills scope, not a separately registered MCP service. Dynamic availability depends on scope and usable configuration.

**Source anchors**: `src/main/app/ensureBuiltinSkills.ts`, `native/src/mcp/servers/skills.rs`, `native/src/mcp/servers/skills_config.rs`, `native/src/mcp/servers/config.rs`, `native/src/mcp/tools.rs`.

## 4. Hooks and Sub-agents

**Purpose and boundary**: Hooks add configured decision points to user-message, tool, compaction, and sub-agent lifecycles. A sub-agent has an independent conversation and Renderer loop but remains constrained by parent permissions and checkpoints.

```mermaid
sequenceDiagram
    participant P as Parent agent loop
    participant H as Hooks
    participant S as Sub-agent service
    participant C as Child renderer loop
    participant DB as SQLite

    P->>H: beforeSubAgentStart
    H-->>P: pass or abort
    P->>S: activate configured agent
    S->>DB: create child conversation and running session
    S->>C: start with profile tools and parent checkpoints
    loop Child model and tools
        C->>C: independent stream and allowed-tools checks
    end
    C->>DB: completed or failed
    C->>H: onSubAgentComplete
    C-->>P: final result
```

**Maintenance**: Tool Hook order is `toolConfirmation` → authorization → `beforeToolCall` → MCP → `afterToolCall`. Parent abort propagates to children; stale running sessions are cancelled at startup.

**Source anchors**: `src/renderer/components/mainContent/chatMessages/hooks/subAgentActivation.ts`, `toolExecution.ts`, `useToolAuthorization.ts`, `hookOutcome.ts`, `native/src/hooks/`, `native/src/mcp/servers/sub_agents.rs`.

## 5. Image Generation and Library

**Purpose and boundary**: The imagegen MCP service calls providers using independent channel configuration. Results are written to files and indexed in the library; Renderer merges consecutive parallel calls into a gallery.

```mermaid
flowchart TD
    model["Agent tool calls"] --> executor["Renderer tool executor"]
    executor --> imagegen["Rust imagegen MCP service"]
    channels["Enabled image generation channels"] --> imagegen
    imagegen --> provider["OpenAI-compatible or Gemini backend"]
    provider --> files["Image files under default or custom root"]
    files --> index["image_library SQLite index"]
    index --> ipc["Image library IPC"]
    ipc --> ui["Library UI and chat image references"]
    executor --> gallery["ImageGenGallery for consecutive parallel calls"]
```

**Maintenance**: The tool is discoverable only when at least one channel is enabled. Parallel multi-image output is multiple tool calls unified by the Renderer gallery. Image-root changes use the prepare/chunk/commit/rollback journal flow.

**Source anchors**: `native/src/mcp/servers/imagegen.rs`, `src/main/ipc/handlers/imageHandlers.ts`, `native/src/storage/services/image_library.rs`, `native/src/exports/images.rs`, `src/main/ipc/handlers/imageLibraryHandlers.ts`.

## 6. Browser

**Purpose and boundary**: A Renderer webview provides the visible page. Main manages Electron network recording, popups, passwords, and context menus. The Rust MCP browser service exposes model tools.

```mermaid
flowchart LR
    agent["Browser MCP calls"] --> rust["native browser service"]
    rust --> main["Main browser support"]
    ui["Renderer browser panel and webview"] --> main
    main --> webview["Electron webview session"]
    webview --> network["Network recorder and trace"]
    webview --> dialogs["JS dialogs and popup windows"]
    webview --> storage["Cookies storage state passwords"]
    proxy["Electron session proxy"] --> webview
```

**Maintenance**: `browserNetworkRecorder`, storage state, and trace are support modules, not separate IPC registration groups. OAuth popups must retain `window.opener`; `sessionProxy.ts` applies network proxy policy to Electron sessions.

**Source anchors**: `native/src/mcp/servers/browser.rs`, `src/main/ipc/handlers/browserNetworkRecorder.ts`, `browserStorageState.ts`, `browserTrace.ts`, `browserPasswordHandlers.ts`, `src/main/browser/browserPopupWindow.ts`, `src/main/app/sessionProxy.ts`.

## 7. Terminal and SSH

**Purpose and boundary**: Local PTY and persistent terminal tools use local process management. SSH manager, remote commands, and remote-workspace adapters handle remote files, commands, and Git.

```mermaid
flowchart TD
    ui["Terminal and SSH UI"] --> preload["ptyApi and sshApi"]
    preload --> main["PTY handlers and SSH handlers"]
    main --> local["Local PTY sessions"]
    main --> ssh["SSH manager and credential resolution"]
    ssh --> remote["Remote command workspace and Git"]
    agent["bash filesystem grep terminal tools"] --> tools["Rust MCP routing"]
    tools --> local
    tools --> remote
    remote --> execution["Cancellable remote execution ID"]
```

**Maintenance**: The terminal MCP service is disabled by default and must be explicitly enabled per project. Remote workspace supports execution and is not a duplicate fixed built-in service. Windows/local and SSH paths must be resolved before routing.

**Source anchors**: `src/main/pty/registerPtyHandlers.ts`, `src/main/ipc/handlers/sshHandlers.ts`, `src/main/ssh/sshManager.ts`, `remoteWorkspaceCommand.ts`, `remoteGit.ts`, `native/src/mcp/servers/terminal.rs`, `remote_workspace.rs`.

## 8. Git and Codebase Indexing

**Purpose and boundary**: UI Git calls Main and native exports for local or remote Git. Rust creates embeddings/chunks for codebase indexing and exposes search tools only when an index is usable.

```mermaid
flowchart LR
    gitui["Git UI"] --> gitipc["gitHandlers"]
    gitipc --> localgit["native git export"]
    gitipc --> remotegit["SSH remoteGit"]
    workspace["Workspace source files"] --> index["Rust codebase indexing"]
    index --> chunks["Vector chunks and embed sessions"]
    chunks --> search["codebase and codelens MCP tools"]
    search --> agent["Agent context"]
```

**Maintenance**: Git UI operations and model tool authorization are separate entry points. Codebase tools require a valid project, project enablement, and existing chunks; hide them before indexing instead of advertising an empty capability.

**Source anchors**: `src/main/ipc/handlers/gitHandlers.ts`, `src/main/ssh/remoteGit.ts`, `native/src/exports/git.rs`, `native/src/exports/codebase.rs`, `native/src/mcp/servers/codebase.rs`, `native/src/mcp/servers/codelens/`, `native/src/storage/services/codebase_embed_sessions.rs`.

## 9. Third-Party Import and Plugins

**Purpose and boundary**: Codex, Claude Code, and OpenCode can be discovered and selectively imported from local, WSL, or SSH environments. Directory changes coordinate rollback with a SQLite import transaction. Plugin runtimes use restricted utility processes.

```mermaid
flowchart TD
    sources["Codex Claude Code OpenCode"] --> env["Local WSL SSH environments"]
    env --> discover["Discovery worker scanning and hashes"]
    discover --> select["Selective import plan"]
    select --> dirs["Staged directory commits"]
    dirs --> dbtx["Atomic native DB import transaction"]
    dbtx --> finalize["Finalize and remove directory backups"]
    dbtx -. "failure" .-> rollback["Reverse committed directories"]
    finalize --> plugins["Plugin records and components"]
    plugins --> verify["Verify source content hash and entry boundary"]
    verify --> worker["utilityProcess with Node permissions"]
    worker --> private["userData plugins hash directory"]
```

**Maintenance**: `ImportExecutionPlan.commit` commits staged directories first, then one native DB transaction; DB failure rolls directories back in reverse. Plugins receive only declared storage/network/child-process permissions, require rescan after source hash changes, and stop through `stopAll()` on exit.

**Source anchors**: `src/main/codex/importer.ts`, `src/main/importConfig/importEnvironments.ts`, `discovery.ts`, `selectedImport.ts`, `directoryCommit.ts`, `importTransaction.ts`, `pluginManager.ts`, `src/main/plugins/pluginRuntimeManager.ts`, `plugin-runtime-worker.ts`.

## 10. Configuration

**Purpose and boundary**: Configuration spans file-backed, DB-backed, global, and project scopes. Renderer uses config APIs and the model can use config MCP tools; Rust centralizes validation, masking, backup, and writes.

```mermaid
flowchart TD
    ui["Settings UI"] --> api["Preload config API"]
    agent["config MCP tools"] --> service["Rust ConfigService"]
    api --> main["Main configHandlers"] --> service
    service --> files["~/.snow JSON and ROLE.md"]
    service --> db["SQLite-backed config"]
    service --> project["Project-scoped configuration"]
    service --> backup["Temporary config backups"]
    service --> mask["Masked sensitive reads"]
```

**Maintenance**: File writes use same-directory tmp plus rename; temporary backups are removed after success. Deletion must identify target and impact. Sensitive reads remain masked. The skills scope delegates to SkillsConfigService.

**Source anchors**: `native/src/mcp/servers/config.rs`, `native/src/mcp/servers/skills_config.rs`, `src/preload/modules/configApi.ts`, `src/main/ipc/handlers/configHandlers.ts`, `src/main/settings/`.

## 11. Application Updates

**Purpose and boundary**: The updater branches by platform. Non-macOS uses an explicit electron-updater download/install state machine; macOS has a separate check and download implementation. Update networking follows the dedicated Electron updater-session proxy.

```mermaid
stateDiagram-v2
    [*] --> Checking
    Checking --> NotAvailable: no update
    Checking --> Available: update found
    Checking --> Failed: check error
    Available --> Downloading: user starts download
    Downloading --> Downloaded: package ready
    Downloading --> Failed: download error
    Downloaded --> Installing: user confirms install
    Installing --> [*]
    NotAvailable --> [*]
    Failed --> [*]
```

**Maintenance**: Non-macOS disables automatic download and install-on-quit; state must retain user-triggered download and install. macOS download cache is under the relevant userData updates directory. Both default session and updater partition receive `applySessionProxy`.

**Source anchors**: `src/main/updater/autoUpdater.ts`, `electronUpdater.ts`, `macUpdater.ts`, `updateStatus.ts`, `src/main/app/mainWindow.ts`, `src/main/app/sessionProxy.ts`.
