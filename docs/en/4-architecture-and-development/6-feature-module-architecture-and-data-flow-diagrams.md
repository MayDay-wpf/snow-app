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
    stream --> provider["Chat Responses Anthropic Gemini Interactions"]
    provider --> db["chat_conversations chat_messages usage_records"]
    stream -. "streamId chunks" .-> loop
    loop --> view["Message rendering and run metrics"]
```

**Agent Iteration and Mutation-Sensing Data Flow**:

```mermaid
flowchart TD
    UserMsg["User input / Mid-flight Steering"] --> AgentLoop["useAgentLoop scheduler"]
    AgentLoop --> StreamReq["createResponseStream (IPC / Rust)"]
    StreamReq --> Model["Provider (Chat / Responses / Anthropic / Gemini / Interactions)"]
    Model -. "SSE Chunks (with StreamRetryNotice)" .-> AgentLoop
    Model --> ResSettled["Response settlement: parse toolCalls"]
    ResSettled -- "No tool calls" --> SteeringCheck{"Pending steering inputs?"}
    SteeringCheck -- Yes --> AgentLoop
    SteeringCheck -- No --> TaskDone["finishAgentTask concludes run"]

    ResSettled -- "Tool calls present" --> Guard["ReadonlyCallGuard"]
    Guard --> Probe{"Physical file & Git status probe"}
    Probe -- "Modified / First call" --> Auth["Tool authorization (YOLO / Dialog)"]
    Probe -- "Unchanged duplicate read" --> Dedupe["Deduplication notice, isolate tool"]
    Auth --> Exec["Tool execution (MCP / Terminal / Sub-agent / LSP)"]
    Exec --> CacheUpdate["Guard snapshot update (Mutating invalidates / Read caches)"]
    Dedupe --> LoopNext["Append toolResultMessage"]
    CacheUpdate --> LoopNext
    LoopNext --> AgentLoop
```

**Maintenance**: Do not draw `sessionProxy.ts` into the AI stream. Renderer builds `toolResultsJson`, which enters the next model round. Read-only tool calls are filtered by `ReadonlyCallGuard` using active physical and Git repository probes.

**Source anchors**: `src/renderer/components/mainContent/chatMessages/hooks/useAgentLoop.ts`, `src/renderer/components/mainContent/chatMessages/hooks/readonlyCallGuard.ts`, `src/preload/modules/apiConfigApi.ts`, `src/main/ipc/handlers/chatHandlers.ts`, `native/src/api/conversation/stream.rs`, `native/src/api/interactions/`, `native/src/storage/services/chat_conversations.rs`.

## 2. MCP Tool Discovery and Calls

**Purpose and boundary**: Rust builds the model-visible tool set and executes tools. Renderer owns user authorization and invocation rounds but cannot bypass Rust policy.

```mermaid
flowchart TD
    request["Model request scope"] --> discover["collect_all_mcp_tools"]
    builtin["14 fixed-order built-in services"] --> discover
    skills["Dynamic Skills tool"] --> discover
    external["External MCP stdio and HTTP discovery"] --> discover
    flags["Project enablement codebase index imagegen config"] --> discover
    discover --> model["Provider-specific tool JSON"]
    model --> callNode["call_mcp_tool"]
    callNode --> policy["Sub-agent and authorization checks"]
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
    config["config-manage skills scope"] --> store["SkillsConfigService"]
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
    S->>DB: accept durable run, create child conversation
    S->>C: start with profile tools and parent checkpoints
    loop Child model and tools
        C->>C: independent stream and allowed-tools checks
    end
    C->>DB: settle terminal state, async also writes the run event
    C->>H: onSubAgentComplete
    C-->>P: sync mode returns the unified result
    DB-->>P: async mode delivers the event and wakes the parent
```

**Maintenance**: Tool Hook order is `toolConfirmation` → authorization → `beforeToolCall` → MCP → `afterToolCall`. Parent abort propagates to children; startup marks leftover non-terminal runs `interrupted` without replaying them. Asynchronous result delivery and parent wake-up are covered in §9.4 of [Agent Runtime and Tool Orchestration](4-agent-runtime-and-tool-orchestration.md).

**Source anchors**: `src/renderer/components/mainContent/chatMessages/hooks/subAgentActivation.ts`, `subAgentParentInbox.ts`, `subAgentRunRegistry.ts`, `toolExecution.ts`, `useToolAuthorization.ts`, `hookOutcome.ts`, `native/src/hooks/`, `native/src/mcp/servers/sub_agents.rs`, `native/src/storage/services/chat_conversations/sub_agent_runs.rs`.

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
    chunks --> search["codebase MCP tools"]
    search --> agent["Agent context"]
```

**Maintenance**: Git UI operations and model tool authorization are separate entry points. Codebase tools require a valid project, project enablement, and existing chunks; hide them before indexing instead of advertising an empty capability.

**Source anchors**: `src/main/ipc/handlers/gitHandlers.ts`, `src/main/ssh/remoteGit.ts`, `native/src/exports/git.rs`, `native/src/exports/codebase.rs`, `native/src/mcp/servers/codebase.rs`, `native/src/storage/services/codebase_embed_sessions.rs`.

## 9. Git Worktrees and Session Execution Isolation

**Purpose and boundary**: Enables running parallel conversations on separate branches or isolated worktrees within the same Git repository. The front-end selector binds session execution domains, the storage layer uses SQLite write locks for concurrency safety, and the request contract forwards `executionWorkspaceRoot` and `worktreeId` to tools and file checkpoints.

```mermaid
flowchart TD
    UI["WorktreeSessionSelector (UI)"] --> BindIPC["git:worktrees:set-conversation"]
    BindIPC --> RustStorage["native worktrees.rs storage service"]
    RustStorage --> WriteLock["with_write_lock & with_write_retry"]
    WriteLock --> DB[("SQLite conversations table")]

    AgentRun["useAgentLoop dispatches request"] --> PathResolver["resolveConversationWorkspacePath"]
    PathResolver --> RequestContract["Request Payload:\nexecutionWorkspaceRoot & worktreeId"]
    RequestContract --> NativeStream["native create_response_stream"]
    NativeStream --> ToolContext["MCP tool routing & Checkpoint directory binding"]
    ToolContext --> IsolatedDir["Isolated worktree physical root (e.g. /modules/tasks)"]
```

**Maintenance**: When in worktree mode, the working directory in system prompts must strictly match `executionWorkspaceRoot`. The file change panel and checkpoint rollback directory (`manifest.work_dir`) must remain 100% symmetric with physical execution roots.

**Source anchors**: `native/src/storage/services/git/worktrees.rs`, `src/renderer/components/mainContent/chatInput/WorktreeSessionSelector.tsx`, `src/renderer/components/mainContent/chatMessages/utils/conversationHelpers.ts`, `src/main/ipc/handlers/gitHandlers.ts`.

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

## 12. LSP Language Servers and Semantic Code Intelligence

**Purpose and boundary**: Manages multi-language server processes (Rust `rust-analyzer`, TypeScript `typescript-language-server`, Go `gopls`, etc.), definition navigation, hover docs, reference tracking, and batch diagnostics; push-based diagnostics cache provides sub-millisecond responses to models and UI.

```mermaid
flowchart LR
    AgentTools["Agent LSP Tools\n(goto / hover / references / symbols)"] --> LspServer["mcp/servers/lsp/"]
    LspServer --> ClientMgr["LspClient process manager"]
    ClientMgr --> Subprocess["Language Server subprocess\n(rust-analyzer / node / gopls)"]
    Subprocess -. "JSON-RPC (stdio)" .-> ClientMgr
    Subprocess -. "textDocument/publishDiagnostics" .-> PushCache["Push Diagnostic Cache"]
    PushCache --> DiagTools["lsp-diagnostics / workspace-diagnostics"]
    DiagTools --> AgentContext["Model context feedback & verification"]
```

**Maintenance**: LSP tools dynamically register based on server readiness and language coverage. If an LSP server enters backoff or is uninstalled, the corresponding `lsp-*` tools are not exposed; use literal search instead. Diagnostic tools require `filePaths` array arguments.

**Source anchors**: `native/src/mcp/servers/lsp/`, `native/src/mcp/servers/lsp/client.rs`, `native/src/mcp/servers/lsp/prompt_context.rs`, `src/renderer/components/mainContent/chatInput/LspStatusBadge.tsx`.

## 13. Scheduled Tasks and Visual Workflow Engine

**Purpose and boundary**: Scheduled tasks provide headless agent execution with cron/interval timers. The visual workflow engine decomposes complex pipelines into directed acyclic graphs (DAGs), supporting user review, manual resume, and step-by-step node execution.

```mermaid
flowchart TD
    ScheduleTimer["Renderer Task Scheduler (Cron / Interval)"] --> TaskRun["config-manage action=set scope=scheduledTasks"]
    TaskRun --> TaskStore[("SQLite scheduled_tasks table")]
    TaskRun --> HookTrigger["Lifecycle Hook (onSessionStart)"]
    HookTrigger --> HeadlessLoop["Headless useAgentLoop automated session"]

    WorkflowCall["Model invokes workflow-generate\n(outputs DAG node graph JSON)"] --> WFRunner["WorkflowRunner (workflowRunner.ts)"]
    WFRunner --> DAGCheck["parseWorkflowGraph dependency validation"]
    DAGCheck --> UINotify["UI graph render & user confirmation"]
    UINotify --> NodeExec["Sub-agent & tool execution per node"]
    NodeExec --> NodeStatus{"Node execution succeeded?"}
    NodeStatus -- Success --> NextNodes["Unlock downstream dependencies"]
    NodeStatus -- Failure --> PauseFlow["Pause flow, await user edits or workflow-resume"]
```

**Maintenance**: Scheduled tasks run on persistent timers in the renderer but record complete execution history in SQLite. Workflow graphs validate against cyclic dependencies; failure recovery links previous context via `workflow-resume`.

**Source anchors**: `src/renderer/components/mainContent/chatMessages/workflow/workflowRunner.ts`, `src/renderer/components/mainContent/chatMessages/toolCalls/WorkflowToolCall.tsx`, `src/preload/modules/scheduledTaskApi.ts`, `native/src/storage/services/scheduled_tasks.rs`.
