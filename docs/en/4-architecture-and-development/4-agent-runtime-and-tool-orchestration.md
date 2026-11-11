# Agent Runtime and Tool Orchestration

> This document describes the actual runtime boundary from model request through tool-result feedback. The key rule is: **the main agent loop runs in Renderer; provider streaming, MCP execution, and persistence run in Rust.**

## 1. Component View

```mermaid
flowchart LR
    ui["Chat UI"]
    loop["Renderer Agent Loop\nuseAgentLoop"]
    auth["Authorization and Hooks"]
    preload["Preload stream API"]
    ipc["Main chat IPC"]
    stream["Rust conversation stream"]
    providers["Provider adapters"]
    tools["MCP discovery and execution"]
    storage["SQLite services"]
    checkpoint["File checkpoints"]

    ui --> loop
    loop --> auth
    loop --> preload --> ipc --> stream
    stream --> providers
    stream --> tools
    providers --> storage
    loop --> tools
    tools --> checkpoint
    tools --> storage
    storage --> ui
```

Responsibility boundaries:

- `useAgentLoop.ts` owns the per-conversation loop, stream state, tool rounds, pause/abort, and queued input.
- Preload and `chatHandlers.ts` provide only `streamId`-isolated stream transport.
- Rust provider adapters own request formats, stream parsing, and persistence of each model exchange.
- `mcp/tools.rs` owns discovery, mandatory policy, routing, privacy masking, and checkpoint integration.

### 1.1 Master Agent Lifecycle Architecture

From user input dispatch in UI to final persistence and convergence, the macro lifecycle of the Agent Loop progresses across 5 distinct phases:

```mermaid
flowchart TD
    subgraph S1["Phase 1: Session Setup & Domain Binding"]
        A1["User input / preset command"] --> A2["resolveConversationWorkspacePath<br/>Resolve physical root & Git worktree"]
        A2 --> A3["startAgentTask history tracking<br/>Create initial disk Checkpoint snapshot"]
    end

    subgraph S2["Phase 2: Context Assembly & Protocol Dispatch"]
        A3 --> B1["Dynamic prompt injection (ROLE.md + Mode templates)"]
        B1 --> B2["Inject dynamic tool chapters & Sub-Agent lists"]
        B2 --> B3["Extract high-importance Project Memories & paired history"]
        B3 --> B4["Outbound dispatch (Chat/Responses/Anthropic/Gemini/Interactions)"]
    end

    subgraph S3["Phase 3: Bi-directional Streaming & Self-healing Network"]
        B4 --> C1["Real-time SSE chunk pipe (Typewriter rendering)"]
        C1 -.->|On network disconnect / timeout| C2["Native 9-category exponential backoff retry<br/>or PartialThreshold content preservation"]
        C2 -.->|Retry successful| C1
        C1 --> C3["Stream settlement: parse toolCalls & final response"]
    end

    subgraph S4["Phase 4: Mutation Sensing & Tool Orchestration"]
        C3 --> D1{"Tool calls requested?"}
        D1 -- No --> D2{"Pending mid-flight Steering inputs?"}
        D1 -- Yes --> D3["ReadonlyCallGuard physical & Git probe verification"]
        D3 --> D4["Concurrent Partitioner (toolExecution.ts)"]
        D4 --> D5["8-step Tool Execution Micro-Pipeline (Hooks/Sanitization/Diffs)"]
    end

    subgraph S5["Phase 5: History Appending & Self-Recursive Convergence"]
        D5 --> E1["Package toolResultMessage into conversation history"]
        E1 --> E2["Consume and append pending Steering messages"]
        E2 --> E3["Recursive self-invocation await runAgentLoop(...)"]
        E3 --> B4
        D2 -- Yes --> E2
        D2 -- No --> E4["finishAgentTask finalizes session, returns to Idle state"]
    end

    style S1 fill:#f0f7ff,stroke:#2b7fff,stroke-width:2px
    style S2 fill:#f6ffed,stroke:#52c41a,stroke-width:2px
    style S3 fill:#fffbe6,stroke:#faad14,stroke-width:2px
    style S4 fill:#fff0f6,stroke:#eb2f96,stroke-width:2px
    style S5 fill:#f9f0ff,stroke:#722ed1,stroke-width:2px
```

### 1.2 Session Initialization and Git Worktree Isolation Flow

To ensure parallel conversations across different branches or isolated worktrees operate without disk write collisions, session execution domains enforce strict transaction locks and path resolution:

```mermaid
sequenceDiagram
    autonumber
    actor User as User (UI)
    participant Selector as WorktreeSessionSelector
    participant RustWT as native worktrees.rs
    participant DB as SQLite (conversations)
    participant Loop as useAgentLoop

    User->>Selector: Switch session binding to isolated worktree (worktreeId)
    Selector->>RustWT: git:worktrees:set-conversation
    Note over RustWT: Uses with_write_lock & with_write_retry to prevent database locked
    RustWT->>DB: Atomically persist binding

    User->>Loop: Submit message
    Loop->>Loop: resolveConversationWorkspacePath()
    Note over Loop: Resolves relative paths to physical worktree root (e.g. /modules/tasks)
    Loop->>Loop: Injects executionWorkspaceRoot into request contract, anchoring tools & checkpoints
```

## 2. Model Adapter Layer

The unified entry `native/src/api/conversation/stream.rs::create_response_stream` dispatches five streaming protocols by `request_method`:

| request_method | Adapter directory              | Protocol & Endpoint             | Key Capabilities                                                                                           |
| -------------- | ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `chat`         | `native/src/api/chat/`         | OpenAI Chat Completions         | Multi-turn conversation, function calls, typewriter streaming                                              |
| `responses`    | `native/src/api/responses/`    | OpenAI Responses API            | Responses protocol, Fast Mode override, multimodal & reasoning                                             |
| `anthropic`    | `native/src/api/anthropic/`    | Anthropic Messages API          | Claude 3.x/3.7 series, adaptive thinking blocks, tool use                                                  |
| `gemini`       | `native/src/api/gemini/`       | Google Gemini (GenerateContent) | Native Gemini protocol, system instructions, function calls                                                |
| `interactions` | `native/src/api/interactions/` | Google Interactions API         | Next-gen Google Interactions protocol (`alt=sse`), server-side search tool separation, paired tool history |

Adapters share responsibility for provider payloads, normalized-message conversion, SSE or equivalent stream parsing, text/thinking/tool-call/usage accumulation, and `store_chat_exchange`. Tool definitions are generated by `tools_as_openai_chat_json`, `tools_as_openai_responses_json`, `tools_as_anthropic_json`, `tools_as_gemini_json`, and `tools_as_interactions_json`; cross-protocol tool-history conversion is centralized in `api/conversation/tool_messages.rs`. All protocol streams share unified exponential-backoff retries and partial-text recovery via `api/retry.rs`.

API profile resolution prefers an explicit request profile, then the persisted conversation binding, then the globally active profile. A sub-agent always resolves its configured profile and has main-conversation-only Goal Mode forcibly disabled.

### 2.1 Dynamic Context Assembly and System Prompt Injection Pipeline

Before dispatching each model stream request, the native Rust layer (`native/src/api/conversation/context.rs`) dynamically constructs and validates multimodal context according to session mode, tool availability, project memory, and conversation history:

```mermaid
flowchart TD
    Req["ConversationContextRequest arrives"] --> ModeCheck{"Evaluate active session mode"}
    ModeCheck -->|Goal / Worktree / Workflow| ModePrompt["Mode-specific system prompt template<br/>(native/src/prompt/)"]
    ModeCheck -->|Normal Chat| BasePrompt["Base system prompt + user ~/.snow/ROLE.md"]

    ModePrompt --> InjectChapters["Inject dynamic tool guideline chapters"]
    BasePrompt --> InjectChapters

    subgraph PromptInjection["Prompt Injection Pipeline (native/src/prompt/tool_hints.rs)"]
        LSPCheck{"Discovered LSP tools?"} -- Yes --> LSPPrompt["Inject ## Language Servers section"]
        ImgCheck{"Imagegen channels enabled?"} -- Yes --> ImgPrompt["Inject ## Image Generation section"]
        AgentCheck{"Usable sub-agents available?"} -- Yes --> AgentPrompt["Inject project-prioritized Sub-Agents list"]
        TeamCheck{"In a sub-agent session?"} -- Yes --> TeamPrompt["Inject ## Teammate Communication guidelines"]
    end

    InjectChapters --> PromptInjection
    PromptInjection --> MemInject["SQLite Project Memory injection<br/>(extract importance >= 3 Project Memories)"]
    MemInject --> HistoryLoad["Load conversation history (SQLite chat_messages)"]
    HistoryLoad --> ToolPair["Enforce paired tool calls & results (ensure_tool_pairing)"]
    ToolPair --> PayloadGen["Generate provider payload (OpenAI / Anthropic / Gemini / Interactions)"]
```

## 3. Streaming Event Protocol

1. Renderer calls `window.snow.createResponseStream(request, onChunk, onStreamId)`.
2. `apiConfigApi.ts` synchronously creates a `streamId`, registers a `chat:create-response:chunk` listener, then invokes Main.
3. `chatHandlers.ts` validates parameters and calls `native.createResponseStream`.
4. Main receives Rust callbacks and uses `safeSend` to emit `{ streamId, chunk }`.
5. Preload forwards only chunks matching the current `streamId`.
6. `createStreamChunkHandler` updates text, thinking, tool execution IDs, and stream metrics; the invoke Promise returns the final `ResponsesApiResult`.

```mermaid
sequenceDiagram
    participant R as Renderer loop
    participant P as Preload (apiConfigApi)
    participant M as Main (chatHandlers)
    participant N as Rust stream
    participant C as createStreamChunkHandler

    R->>P: createResponseStream(request, onChunk, onStreamId)
    P->>P: create streamId and register chunk listener
    P->>M: invoke chat:create-response
    M->>N: native.createResponseStream
    N-->>M: Rust callback chunk
    M-->>P: safeSend { streamId, chunk }
    P-->>R: only chunks matching streamId
    R->>C: update text / thinking / tool execution ID / metrics
    N-->>R: invoke Promise resolves with final ResponsesApiResult
```

This chain is unrelated to `src/main/app/sessionProxy.ts`, which configures Electron network proxies. Rust-side outbound requests (including the provider adapters on this chain) apply the same proxy configuration centrally in `api/http_client.rs`.

### 3.1 Transport Retry and Partial Content Recovery

Snow App integrates a resilient streaming retry engine at the native Rust layer (`native/src/api/retry.rs`), defending against upstream provider hiccups, network drops, and idle timeouts:

```mermaid
flowchart TD
    A[Streaming exception or transport interruption] --> B{Classify error reason}
    B -- 4xx Client error / Bad credentials --> C[Mark NonRetriable, terminate immediately]
    B -- Network timeout / 5xx / 429 / Socket reset --> D{Has significant content been generated?}

    D -- Yes: User-visible text >= partial_retry_max_chars --> E[PartialThreshold recovery:<br/>Preserve accumulated content, finalize turn,<br/>prevent re-streaming massive token output]
    D -- No: Output is brief or zero tokens --> F{attempt < max_retries?}

    F -- No --> G[RetryExhausted: Mark incomplete, prompt manual retry in UI]
    F -- Yes --> H[Exponential backoff wait_before_retry]

    H --> I[Rust pushes retry notification chunk to Renderer:<br/>retrying=true, retryAttempt, retryError]
    I --> J[Renderer createStreamChunkHandler mounts StreamRetryNotice<br/>displaying spinning indicator & error details]
    J --> K[Initiate new connection attempt]
    K -- Receives first normal content chunk --> L[Clear retry state, resume smooth typewriter streaming]
```

1. **Retry Configuration Parameters** (derived from `api_configs` profiles):
   - `max_retries`: Maximum automated retry attempts per stream request (default 3).
   - `retry_base_delay_ms`: Retry interval. When set to 0, exponential backoff is used (3000ms base, growing as $base \times 2^{attempt}$, capped at 30s); a value above 0 makes every retry wait that fixed interval (no cap).
   - `stream_idle_timeout_sec`: Streaming idle watchdog (default 60s; if the upstream provider ceases sending data chunks for this duration, `idle_timeout` triggers and invokes retry).
   - `partial_retry_max_chars`: Mid-stream partial preservation threshold (default 1000 characters).
2. **Error Classification Matrix (`DEFAULT_RETRY_CATEGORIES`)**:
   - Covers 9 categories: `network` (connection reset/refused, DNS failure), `serverError` (500/502/503/504), `rateLimit` (429), `overloaded` (529), `idleTimeout` (stream idle stall), `stream` (unexpected EOF, truncated chunk), `nonSse`, `unavailable`, and `terminated`.
   - Explicitly rejects retrying unrecoverable 4xx errors (e.g., invalid API key, malformed request) to avoid futile loops.
3. **Mid-stream Partial Threshold Protection (`StreamRecoveryOutcome::PartialThreshold`)**:
   - If an in-flight stream disconnects after emitting substantial content, and **user-visible content reaches `partial_retry_max_chars`**, Snow App preserves the generated partial text as the final turn response rather than restarting from zero. This protects against double billing and runaway context expansion on long outputs.
4. **Renderer UI Retry Awareness (`StreamRetryNotice`)**:
   - When Rust enters a retry attempt, it dispatches `{ retrying: true, retryAttempt: N, retryError: string }` chunks;
   - `createStreamChunkHandler` flags the message as `isRetrying` and renders the `StreamRetryNotice` component (with spinner, attempt counter, and collapsible error details);
   - Once the new connection streams its first payload chunk, the retry banner smoothly disappears and normal typing resumes.
5. **Terminal Disposition and Cancellation**:
   - The `empty_response` / `retry_exhausted` terminal is only attached when the provider finished normally (`status=completed`) with zero payload; `cancelled` (user stop) and `failed` (explicit provider failure) pass through unchanged, with `status` carrying the meaning (the same rule as the cancelled exemption in `classify_final_stream_warning`).
   - `src/renderer/components/mainContent/chatMessages/utils/responseDisposition.ts` is the single disposition entry point for both live responses and reloaded rows: `error` / `failed` take the error branch, `cancelled` settles silently, `incomplete` / `length` / `max_tokens` show the interruption notice, and unknown values with zero payload fall back to incomplete (never a silent blank bubble).
   - Cancellation settlement is idempotent (`utils/messageSettlement.ts::settleInterruptedMessages`): the stop button, cascading sub-agent / workflow-node aborts and the agent loop's cancellation branches share one implementation, so a message never stays stuck in "sending" / "retrying".

## 4. Renderer Main Loop

Each conversation has independent session state, `runId`, `streamId`, AbortController, pause state, and queued input, so switching conversations does not stop background runs.

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Preparing: user message
    Preparing --> Streaming: checkpoint and onUserMessage passed
    Streaming --> Paused: pause requested
    Paused --> Streaming: resume
    Streaming --> Authorizing: tool calls returned
    Authorizing --> Executing: approved
    Authorizing --> NextRound: denied result
    Executing --> NextRound: tool results ready
    NextRound --> Streaming: recurse with toolResultsJson
    Streaming --> Compacting: threshold reached
    Compacting --> Streaming: resumeAfterCompaction
    Streaming --> Completed: no tool calls
    Streaming --> Aborted: abort or fatal error
    Executing --> Aborted: abort propagated
    Completed --> Idle
    Aborted --> Idle
```

### 4.1 Core Invocation Chain and Execution Sequence

The Agent Loop is located at `src/renderer/components/mainContent/chatMessages/hooks/useAgentLoop.ts`, structured as an event-driven, self-recursing state machine (`runAgentLoop`).

```mermaid
sequenceDiagram
    autonumber
    actor User as User (UI)
    participant Loop as useAgentLoop (Renderer)
    participant Guard as ReadonlyCallGuard
    participant IPC as Electron IPC (Preload/Main)
    participant Native as Rust Runtime
    participant Model as LLM Provider
    participant MCP as MCP Tool Runtime

    User->>Loop: handleSendMessage(message, options)
    Note over Loop: 1. Initialize session, file checkpoint, and TaskHistory
    Loop->>Loop: Launch initial recursion runAgentLoop()

    loop Recursive Agent Loop Iterations
        Loop->>IPC: window.snow.createResponseStream()
        IPC->>Native: native.createResponseStreamWithContext()
        Native->>Model: Outbound streaming request (SSE / HTTP stream)

        par Real-time streaming chunks
            Model-->>Native: Text / thinking / tool call chunks
            Native-->>IPC: chat:stream:chunk
            IPC-->>Loop: createStreamChunkHandler() updates UI state
        end

        Model-->>Native: Stream finished
        Native-->>Loop: Promise resolve (full response & toolCalls)

        alt Branch A: Model returns final content (no tool calls)
            Loop->>Loop: Check pending mid-flight inputs via consumeSteering()
            alt Steering inputs pending
                Loop->>Loop: Append user steering message, recurse runAgentLoop()
            else No steering
                Note over Loop: finishAgentTask(), exit loop, return to Idle
            end

        else Branch B: Model invokes tools (toolCalls.length > 0)
            Loop->>Guard: await readonlyGuard.filterToolCalls()
            Note over Guard: Actively inspects physical file fingerprints & Git status!<br/>Allows call if modified; deduplicates only when fully unchanged

            Loop->>Loop: requestToolAuthorizations() (YOLO / user prompt)
            Loop->>MCP: toolExecutor() executes tools
            MCP-->>Loop: Structured tool results

            Loop->>Guard: await readonlyGuard.recordToolExecutions()
            Note over Guard: Capture physical/Git snapshots; invalidate read cache on mutating calls

            Loop->>Loop: Format toolResultMessage and append to session history
            Loop->>Loop: Allocate next Assistant placeholder message
            Note over Loop: Self-recurse: await runAgentLoop(nextAssistantId, ...)
        end
    end
```

The execution flow comprises 7 key stages:

1. **Input Preparation (`handleSendMessage`)**: Validates text, parses tags, binds workspace root and worktree/branch, creates initial file checkpoint, and begins task history (`startAgentTask`).
2. **Environment & Stream Dispatch (`runAgentLoop`)**: Checks `isRunCancelled`, connects to `pauseController` for interactive pauses, and sends outbound request via `createResponseStream`.
3. **Bi-directional Streaming**: Rust parses SSE chunks per provider, IPC routes chunks by `streamId`, and `createStreamChunkHandler` renders streaming text and reasoning.
4. **Response Disposition & Steering**: Resolves final response. If no tools are called, checks `consumeSteering` for pending mid-flight messages; if none, concludes the run.
5. **Readonly Guard & Mutation Sensing (`ReadonlyCallGuard`)**: Prevents unbounded repetitive read loops while eliminating false positives through physical and Git status inspection (see Section 4.2).
6. **Tool Authorization & Execution**: Evaluates permissions (YOLO mode / user approval dialog) and executes MCP tools, terminals, or sub-agents.
7. **History Appending & Self-Recursion**: Formats `role: "tool"` messages and recurses into `runAgentLoop` with `toolResultsJson` until convergence.

### 4.2 Readonly Call Guard and Mutation Perception Algorithm

#### 4.2.1 Motivation

LLMs executing multi-step tasks can occasionally hallucinate or enter repetitive read loops with identical arguments (e.g., repeatedly reading the same unchanged file).
However, a rigid tool-name whitelist or call-history check fails whenever external factors (external editor edits, Git checkouts, sub-agent modifications, or compiler outputs) change files on disk without explicit parent tool calls, causing stale cached results to be reused as if they were current.

Snow App addresses this via **`ReadonlyCallGuard` (`readonlyCallGuard.ts`)**, providing adaptive mutation perception:

#### 4.2.2 Dual-layer Inspection Mechanism

When an identical read-only call is detected, the guard actively checks environmental state:

```mermaid
flowchart TD
    A[Read-only tool call received] --> B{Matches recorded call arguments?}
    B -- No --> C[Allow execution]
    B -- Yes --> D{Tool category}

    D -- filesystem-read (file) --> E[Layer 1: Physical file fingerprint<br/>exists / size / contentLength / preview]
    E -- Fingerprint changed --> C
    E -- Fingerprint identical --> F[Layer 2: Git status inspection<br/>gitStatus file staged/modified/untracked]
    F -- Git status changed --> C
    F -- Git status unchanged --> G[Verified genuine duplicate]

    D -- grep-search / codebase-search (repo) --> H[Git repository dirty state inspection<br/>branch / ahead / behind / dirty file digest]
    H -- Repository modified/committed --> C
    H -- Repository completely unchanged --> G

    G --> I[Reuse the prior real result (cache hit), without re-executing]
```

1. **Physical File Inspection (`captureFileSnapshot`)**:
   - Inspects file existence, byte `size`, character `contentLength`, and content prefix `preview`;
   - Any difference between current state and snapshot immediately invalidates the cached read and allows execution.
2. **Git Repository Status Inspection (`captureGitSnapshot`)**:
   - Locates the Git repository via `window.snow.gitIdentity` and queries `window.snow.gitStatus`;
   - For file reads: verifies whether the specific file is modified, staged, or untracked in Git;
   - For search tools (`grep-search`, `codebase-search`): verifies overall repository dirty digest and commit/branch changes.
3. **Broadened Mutating Tools**:
   - Expands `mayMutateWorkspace` beyond basic file writes to include `terminal-send`, `terminal-open`, `sub-agents-activate`, `sub-agents-continue`, `lsp-rename`, `workflow-generate`, and external MCP write tools.

### 4.3 Mid-flight Steering

When users send additional messages while the agent is streaming or executing tools, the main loop does not abort the in-progress run. Instead, inputs are queued as **Steering items (`takePendingSteering`)**:

1. After the current tool execution turn settles, `consumeSteering` extracts pending inputs;
2. Appends user instructions to `nextMessages`;
3. Passes them into the next recursive `runAgentLoop` invocation, allowing the agent to adapt dynamically to user guidance without losing prior tool results.

```mermaid
sequenceDiagram
    autonumber
    actor User as User (UI)
    participant Input as ChatInput
    participant Loop as useAgentLoop
    participant Tools as ToolExecutor
    participant DB as SQLite Storage

    Note over Loop,Tools: Agent executing long-running tools or commands...
    User->>Input: Submit steering correction (e.g. "Don't edit file A, edit B instead")
    Input->>Loop: Queue in pendingSteering (does not abort in-flight process)

    Tools-->>Loop: Turn tools complete, generate toolResultMessage

    Loop->>Loop: consumeSteering(effectiveKey)
    Note over Loop: Extract steering inputs, append as role: "user" right after tool results

    alt Needs further recursion
        Loop->>Loop: Allocate next Assistant placeholder card
        Loop->>Loop: await runAgentLoop(nextAssistantId, nextMessages)
        Note over Loop: Model perceives both previous tool results and fresh user corrections!
    else Reached final answer (model produces text without tool calls)
        Loop->>DB: store_chat_exchange (atomically save assistant message & token usage)
        Loop->>DB: finishAgentTask (finalize task changes and metrics)
        Loop->>User: Render completed state, return input box to ready
    end
```

### 4.4 Agent Business-level Retries and Self-Healing

Beyond transport-level network and timeout retries, the Agent Loop supports three tiers of business-level self-healing:

1. **Continuable Authorization Rejection (`rejectionKeepsAiFlow`)**:
   - When a user rejects a sensitive tool execution but provides feedback, or when security policies block sensitive commands;
   - The refusal reasoning is embedded as a `role: "tool"` response. The loop continues, enabling the model to adapt its strategy and choose an approved path.
2. **Readonly Result Reuse**:
   - Read-only calls whose arguments and workspace state are unchanged reuse the prior real result without re-executing, and never interrupt the session;
   - No tool-round or duplicate-count limit exists; the loop ends on model convergence, user cancellation, or request timeout.
3. **Sub-agent and Workflow Execution Recovery**:
   - Sub-agent or workflow node failures return structured `{ success: false, error }` summaries rather than crashing the primary session, allowing the parent agent to formulate alternative approaches.

### 4.5 Parallel Tool Orchestration and Execution Pipeline

When the model returns multiple concurrent tool calls within a single round, the renderer-side tool executor (`src/renderer/components/mainContent/chatMessages/hooks/toolExecution.ts`) routes them through a concurrent partitioner and per-tool lifecycle pipeline:

```mermaid
flowchart TD
    ToolBatch["Turn tool calls (toolCalls)"] --> Partition{"Concurrent Partitioner<br/>(toolExecution.ts)"}

    Partition -- "Read-only tools (filesystem-read, grep)" --> ParallelRead["Concurrent Pipeline: Parallel multi-task execution"]
    Partition -- "Sub-agents (activate / continue)" --> ParallelSubAgent["Async Pre-start: Concurrent independent sessions"]
    Partition -- "Image generation (imagegen-generate)" --> ImageQueue["Concurrency Queue: maxConcurrentImages sliding window"]
    Partition -- "Multiple questions (askUserQuestion)" --> MergeDialog["Interactive Merging: Aggregate into single prompt dialog"]
    Partition -- "Mutating tools (edit / copy / rename)" --> SerialExec["Serial Pipeline: Ordered execution prevents write races"]

    subgraph MicroPipeline["Per-Tool Execution Micro-Pipeline"]
        Step1["1. Argument validation (validateToolCall)"]
        Step2["2. beforeToolCall hook evaluation"]
        Step3["3. Pre-execution Checkpoint disk capture"]
        Step4["4. Tool dispatch (Rust Native / Bash / SSH / MCP)"]
        Step5["5. Credential & key sanitization (privacy_mask.rs)"]
        Step6["6. File diff extraction (fileChangeTracking.ts)"]
        Step7["7. afterToolCall hook evaluation"]
        Step8["8. Commit Checkpoint & generate structured JSON"]

        Step1 --> Step2 --> Step3 --> Step4 --> Step5 --> Step6 --> Step7 --> Step8
    end

    ParallelRead --> MicroPipeline
    ParallelSubAgent --> MicroPipeline
    ImageQueue --> MicroPipeline
    MergeDialog --> MicroPipeline
    SerialExec --> MicroPipeline

    MicroPipeline --> MergeResult["Aggregate all tool results -> toolResultMessage into next loop turn"]
```

A round streams the model, parses `toolCallsJson`, creates an executor from the authorization result, executes tools, builds structured `toolResultsJson`, and recurses into the next round. It stops when no tool call remains or first consumes queued user input. A local file checkpoint is created before the loop; `onUserMessage` runs before the first round and `onStop` runs during final cleanup.

## 5. Tool Discovery

`collect_all_mcp_tools` filters and merges tools in this order:

1. Resolve global and project scope.
2. Expose codebase tools only when a project exists, codebase is enabled, and vector chunks exist.
3. Expose imagegen only when at least one channel is enabled.
4. Read 14 built-in services in fixed order.
5. Apply global and project server/tool enable states (global disable wins); terminal is disabled by default and requires explicit project enablement.
6. Inject the Skills tool dynamically.
7. Discover external stdio/HTTP MCP tools in parallel; one server failure is logged without failing all discovery.

```mermaid
flowchart TD
    A[Resolve global and project scope] --> B{Project exists, codebase enabled, and vector chunks exist?}
    B -- yes --> C[Expose codebase tools]
    B -- no --> D
    C --> D{At least one imagegen channel enabled?}
    D -- yes --> E[Expose imagegen]
    D -- no --> F
    E --> F[Read 14 built-in services in fixed order]
    F --> G[Apply global and project enable states<br/>global disable wins, terminal disabled by default]
    G --> H[Inject Skills tool dynamically]
    H --> I[Discover external MCP stdio/HTTP tools in parallel<br/>one failure is logged, not fatal]
```

Sub-agents use `collect_allowed_mcp_tools_for_workspace`. Their `tools_json` must be a string array; `*` expands to every tool available in the current project. Configured tools that are globally or project-disabled, unavailable, or missing are skipped with a log entry, without expanding authority. External MCP supports `server/discover` with a legacy initialize fallback.

**Tool-domain system-prompt injection**: beyond tool visibility, system-prompt construction (`native/src/api/conversation/context.rs`) dynamically appends per-domain guidance sections, with **injection conditions kept consistent with tool visibility** — a disabled domain is never injected, so the prompt never steers the model toward invisible tools:

- **`## Language Servers`**: all five providers collect final `allowed_tools` first, then reuse that same list for `ConversationContextRequest` and payload serialization. `native/src/mcp/servers/lsp/prompt_context.rs::ToolSnapshot` renders each actual name after global/project switches, capabilities and sub-agent whitelist filtering; it neither uses four representative tools as a domain gate nor independently rediscovers tools. Grep descriptions are generated after the final list is formed; result hints intersect call-time scope/allowed-tools. Available does not mean running, and running does not mean index-ready. Prompts promise neither completed prewarming, instantaneous responses nor diagnostics equivalent to a successful build.
- **`## Image Generation`** (imagegen domain, `build_system_prompt_section` in `native/src/mcp/servers/imagegen/mod.rs`): injected when at least one usable image-generation channel is configured and the domain scope allows it. It lists the usable channels (id / name / protocol, non-sensitive summary) and mandates that multiple images MUST be produced by parallel `imagegen-generate` calls (one call per image; legacy `prompts` / `n>1` are NOT the multi-image path); ≥2 consecutive parallel calls are merged into a single `ImageGenGallery` grid by the UI.
- **Investigation-phase tool list**: `native/src/prompt/tool_hints.rs` reads that same request-local snapshot to replace `__ANALYSIS_TOOLS_LINES__` in Goal / WorkFlow templates. LSP, codebase, grep and filesystem-read are checked individually; disabled baseline tools disappear and empty tools produce an empty list. Uncovered languages/extensions/operations have no extra static-analysis service; use the visible search/read tools.
- The LSP section is appended to the prompt tail with stable ordering to avoid unnecessary prefix changes. Tool-collection failure preserves the request's tool-less result rather than re-querying and expanding authority. Main and sub-agent requests share pure routing generation without a cross-session visibility cache.

Document synchronization and result trust form a separate LSP boundary: `ensure_open` compares actual disk text and synchronizes didOpen/didChange; diagnostics no longer read/write persistent result caches (old data is not deleted). Workspace searches may use `workspaceRoot` to name an explicit absolute local directory. Complete candidates and metadata such as `partial_symbol_search` constrain automatic addressing; UI partial/warnings and running badges must not be interpreted as complete verification. See [current LSP behavior and pending acceptance matrix](7-lsp-external-language-server-design.md).

### 5.1 LSP conditional MUST and execution boundaries

Semantic tasks **MUST** use LSP when the corresponding tool is visible and supports the target language/operation. Explain disabled, unauthorized, uncovered, backed-off or unhealthy cases and use visible fallbacks. Evaluate language coverage, negotiated capabilities and health per tool; a global language union or running process is not proof of every capability. Failed startup enters backoff instead of repeated spawn during cooldown; grep remains for literal search. The 11 semantic labels and both i18n key families match the [tool reference](../3-reference/2-builtin-tools-reference.md), preserving IDs and historical keys.

Diagnostics use a `filePaths` array (1..30); other read-only batch tools also use arrays: symbols `filePaths` (1..10), hover/goto `items` (1..10 each), and references `items` (1..5). Even one target must use an array; single-target fields are not compatible. Reject missing/invalid arrays, empty arrays/paths and oversized batches; deduplicate physical paths while preserving order. Report each file/target status and aggregate batch status/summary; ambiguous, partial or failed results are not complete. Read-only batch concurrency is capped at 3.

Rename apply consumes a content-bound `previewId` (5-minute TTL, at most 32 per session, single-use) and still needs write authorization; changed contents require another preview. The UI does not display raw capabilities or apply automatically. Multi-file application is not transactional: retain `appliedFiles/error/requiresNewPreview` for the model and UI, never claim rollback. Read-only batches are capped at concurrency 3 and preserve input order. Rust LSP module tests verified the batch contract; live language-server runtime acceptance was outside this validation scope. See [LSP design §0.6–0.8](7-lsp-external-language-server-design.md).

## 6. Tool Calls and Checkpoints

`call_mcp_tool` sanitizes polluted names, checks global and project enable state, checks the sub-agent allowlist, resolves local/SSH workspace context, anchors local relative paths to the project root, augments pre-tool checkpoint capture, routes by tool type, privacy-masks output, and updates the post-tool checkpoint.

```mermaid
flowchart TD
    A[Sanitize polluted tool names] --> B[Check global and project enable state]
    B --> C[Check sub-agent allowlist]
    C --> D[Resolve local/SSH workspace context]
    D --> E[Anchor local relative paths to project root]
    E --> F[Augment pre-tool checkpoint capture]
    F --> G[Route by tool type]
    G --> H[Privacy-mask output]
    H --> I[Update post-tool checkpoint]
```

Routes include bash, grep, remote filesystem, browser, user interaction, app control, terminal, imagegen, external MCP, and ordinary built-ins. Cancellable remote execution returns an execution ID through a `tool_execution` chunk. Checkpoint capture lets parent and sub-agent file changes share one preview and restoration boundary.

## 7. Authorization and Mandatory Policy

Renderer `useToolAuthorization.ts` composes these policies:

- YOLO Mode can auto-approve ordinary tools.
- The global `permissions.alwaysApprovedTools` (`~/.snow/permissions.json`) is merged with project-level approvals into the no-confirmation list; choosing “always allow” persists a project approval. The Project tool permissions panel can add/remove project-level approvals and shows the global list read-only.
- Bash checks sensitive-command patterns first; sensitive commands cannot be bypassed by “approve all.”
- Interactive bash relies on the interactive terminal UI and does not show a duplicate sensitive-command dialog.
- The `toolConfirmation` Hook may approve or deny before ordinary user confirmation.
- Pending confirmations suspend on a Promise until the user decides.

Rust is the second boundary: `bash.rs` verifies short-lived one-use authorization tokens for sensitive commands, while `call_mcp_tool` enforces the sub-agent allowlist. Frontend convenience policy never replaces backend enforcement.

```mermaid
flowchart TD
    A[Tool call] --> B{toolConfirmation Hook}
    B -- approve --> G[Execute tool]
    B -- deny --> K[Denial result back to model]
    B -- continue --> C{Sensitive command?}
    C -- yes --> D[Rust verifies short-lived one-use token<br/>sensitive commands bypassed by no approve-all]
    D -- passed --> G
    C -- no --> E{Interactive bash?}
    E -- yes --> F[Interactive terminal UI confirms]
    F --> G
    E -- no --> H{YOLO Mode or project alwaysApprovedTools?}
    H -- yes --> G
    H -- no --> I[Suspend on Promise until user decides]
    I -- approved --> G
    I -- denied --> K
    G --> L[Rust second boundary<br/>sub-agent allowlist]
```

## 8. Hooks

Supported Hook types are `onUserMessage`, `beforeToolCall`, `toolConfirmation`, `afterToolCall`, `onSubAgentComplete`, `beforeSubAgentStart`, `beforeCompress`, `onSessionStart`, and `onStop`.

Command Hook exit code 0 passes and can inject stdout as Hook Context; 1 is a soft warning and specific decision JSON may open a user-decision UI; 2 or greater aborts. Blocking outcomes are normalized by `hookOutcome.ts`; fire-and-forget Hooks such as `onStop` never block final cleanup.

The tool lifecycle is:

```mermaid
sequenceDiagram
    participant L as Agent loop
    participant C as toolConfirmation Hook
    participant U as User policy
    participant B as beforeToolCall Hook
    participant M as MCP tool
    participant A as afterToolCall Hook

    L->>C: evaluate tool call
    C-->>L: allow, deny, or continue
    L->>U: request authorization when needed
    U-->>L: decision
    L->>B: pre-execution context
    B-->>L: pass or abort
    L->>M: call_mcp_tool
    M-->>L: masked result
    L->>A: result context
    A-->>L: final hook outcome
```

Parallel image generation and parallel sub-agents have batch-specific handling. Their Hook lifecycle remains, but invocation must not be assumed universally serial.

## 9. Sub-agents

After the model calls `sub-agents-activate`, Renderer runs `beforeSubAgentStart`, creates an independent conversation/session, and persists `running`. The sub-agent loads its own system prompt, `tools_json`, and API profile and streams in an independent Renderer loop.

While building the main session's system prompt, Snow queries `sub_agent_configs` and **dynamically injects the available sub-agent list** (with `agentId`, name, and purpose) together with a selection rule — the main agent picks the best-matching `agentId` instead of defaulting to the built-in `agent_general`. The list resolves like activation: **project-scoped sub-agents of the current project (`directory_id`) take priority** and override the global one on the same `agentId`; sub-agents of other projects are not injected.

A sub-agent inherits parent checkpoint IDs so its file changes remain inside the parent's rollback boundary. Rust also enforces allowed-tools. Completion persists a terminal state (`completed`, `failed`, `cancelled`, or `interrupted`), runs `onSubAgentComplete`, and makes the conversation read-only; the child session keeps its own pending queue instead of forwarding it to the parent. Parent abort propagates to active sub-agents, and startup marks leftover non-terminal runs as `interrupted` (`OWNER_LOST`) without replaying them.

Activation runs in parallel with the main agent (pre-started by the Renderer). In synchronous mode it returns a structured JSON tool result when it ends; the main agent never auto-retries — the model decides the next step from the result. Normal completion returns `{success: true, conversationId, agentName, summary}` (`onSubAgentComplete` may append context on pass, append a warning on warn, or replace the summary on abort). An API stream failure returns the failure content as the final output and marks the message as error. An exception returns `{success: false, error}` and persists `failed`. A user interrupt returns "Sub-agent interrupted by user". There is no global sub-agent timeout (only per-tool timeouts); stopping the main agent recursively cancels the whole descendant tree via `childSubAgentIds` (aborting streams, rejecting pending authorizations, killing bash child processes). Asynchronous mode does not return through that tool result; it wakes the parent conversation through the event delivery in §9.4.

### 9.1 Run Model and State Machine

Both execution modes (Settings → Sub-agent settings → Run limits, synchronous by default) share one durable run: `accept` admission, `transition` state changes, `settle` terminal commit, and result paging. They differ only in whether the parent tool waits for a terminal state — **synchronous** waits for the terminal state and returns the unified result payload, while **asynchronous** waits only for the `accepted` receipt, releases the main flow immediately, and delivers the result back to the parent conversation through durable events (see §9.4). The mode comes from each dispatch's `executionMode` argument and falls back to the default from settings when omitted (the host reads it once per tool batch). Workflow nodes acting as parents are sync-only: the Rust tool policy narrows the node's `executionMode` enum to `sync`, the renderer's `requireSubAgentParent` rejects `async` by parent type, and each node turn opens its own parent task and closes it on settle. A `continue` against a busy target returns `message_queued` without changing that run's mode. Both modes require a real project/workspace binding, and runs do not continue after the application exits.

Run state is persisted by `native/src/storage/services/chat_conversations/sub_agent_runs.rs`; the terminal set is `completed | failed | cancelled | interrupted` (`sub_agent_runs.rs::terminal`).

```mermaid
stateDiagram-v2
    [*] --> queued: accept
    queued --> running: transition
    running --> waiting_input: needs decision
    waiting_input --> running: decision done
    running --> finalizing: finalize
    waiting_input --> finalizing: finalize
    running --> cancelling: cancel
    waiting_input --> cancelling: cancel
    queued --> cancelled: cancel
    finalizing --> completed: settle
    finalizing --> failed: settle
    cancelling --> cancelled: settle
    queued --> failed: settle
    running --> failed: settle
    waiting_input --> failed: settle
    queued --> interrupted: recover
    running --> interrupted: recover
    waiting_input --> interrupted: recover
    finalizing --> interrupted: recover
    cancelling --> interrupted: recover
```

### 9.2 Activation and Asynchronous Dispatch

`sub-agents-activate` and `sub-agents-continue` first pass through `prepareLogicalSubAgentRequest` for request-identity deduplication: the same `requestId` with identical logical input reuses one Promise, a different input raises `REQUEST_CONFLICT`, and an existing durable receipt is replayed instead of re-executed. `dispatchPreparedSubAgentRun` then submits `accept`; in asynchronous mode the `accepted` receipt returns to the parent model as soon as the local owner is registered, without waiting for the child run to finish.

```mermaid
flowchart TD
    A[Model calls activate or continue] --> B[Run beforeSubAgentStart]
    B -->|Hook blocks| B1[Return the block message, no admission]
    B --> C[Request-identity deduplication]
    C -->|input differs| C1[REQUEST_CONFLICT]
    C -->|durable receipt exists| C2[Replay the receipt, no re-execution]
    C -->|first attempt| D[Submit accept]
    D -->|continue on a busy target| D1[message_queued into the durable queue and return]
    D -->|not created| D2[Replay the receipt]
    D -->|created| E[Register the local owner and child ownership]
    E --> F{Execution mode}
    F -->|async| F1[Return the accepted receipt immediately, parent released]
    F -->|sync| F2[Wait for the terminal state, return the unified result]
```

### 9.3 Child Run Execution and Finalization

After owner registration the run is read back: an already terminal run is published and ends immediately. Otherwise the child session is initialized, the run moves to `running` subject to capacity (`waitingForCapacity` is not an error; it waits for a durable change or cancellation), a running event is published, and the independent loop starts. A user decision or authorization enters `waiting_input` through `withWaiting` and returns to `running` once decided. When the loop ends, the finalizer wins `finalizing` ownership, runs `onSubAgentComplete`, and `settle` commits the terminal state. Failures record `SUB_AGENT_EXECUTION_FAILED`; a failed settlement records `PERSISTENCE_ERROR` and marks the child session read-only. The child session keeps its own pending queue; it is never transferred to the parent.

The diagram below covers exit conditions and result return; asynchronous mode returns through the event delivery in §9.4 instead.

```mermaid
flowchart TD
    A[Main agent calls sub-agents-activate] --> B[Renderer runs beforeSubAgentStart]
    B --> C{Blocked by Hook?}
    C -->|yes| X[Return block message, no session created]
    C -->|no| D[Create independent session, persist running]
    D --> E[Independent sub-agent loop: streaming request + tool execution]
    E --> F{Exit condition}
    F -->|normal completion, no tool calls| G[Run onSubAgentComplete, persist completed]
    F -->|API stream failure| H[Failure content as final output, message marked error]
    F -->|exception| I[Persist failed and broadcast failure]
    F -->|user interrupt| J[Return Sub-agent interrupted by user]
    G --> L[Structured JSON tool result to main agent]
    H --> L
    I --> L
    J --> L
    L --> M[Main agent model decides next step, no auto-retry]
```

### 9.4 Result Delivery and Parent Wake-up

On an asynchronous terminal commit, Rust records the event as `pending` or `revoked` inside `finish`, depending on whether the parent task is open and whether a rollback or deletion gate applies; `interrupted` is committed by `recover` without an event, so it produces no delivery. On the Renderer side `src/renderer/components/mainContent/chatMessages/hooks/subAgentParentInbox.ts` orchestrates delivery and picks the timing from the parent conversation's current state:

| Priority | Condition                             | Behavior                                                                     |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| 1        | Parent conversation is running        | Use the tool boundary `flushSubAgentToolBoundary`, no wake-up                |
| 2        | User queue is not empty               | Yield to user-queued messages                                                |
| 3        | A wake-up is already in flight        | Set `wakeAgain` and run once more afterwards                                 |
| 4        | Parent task open with a pending event | `receive` writes the receipt, then wakes the parent with the internal marker |
| 5        | Parent run failed or was cancelled    | Do not close the parent task or wake it; the event is retained               |

`receive` inserts a synthetic `sub-agents-getResult` message pair into the parent conversation (the body is truncated to 16000 characters) and sets `wake_pending` to 1 on the receipt; only after the parent conversation actually accepts the continuation turn does `acknowledge_wake` verify that the tool message exists and clear the flag. A rejected wake-up is never retried indefinitely — it is rescheduled on the next durable change, parent run end, or window remount.

```mermaid
flowchart TD
    A[Event produced or run change] --> B{Parent conversation running}
    I[Parent run ends or window remounts] --> B
    B -->|yes| C[Tool boundary flushSubAgentToolBoundary]
    B -->|no| D{Parent task open and user queue empty}
    D -->|no| D1[Yield, wait for the next opportunity]
    D -->|yes| E[receive writes the receipt, wake_pending set to 1]
    C --> E
    E --> F[Submit the parent continuation with the internal marker]
    F -->|rejected| F1[Report an error message, no unbounded retry]
    F -->|accepted| G[Parent acknowledges the wake, then continues]
    G -->|tool message missing| G1[PERSISTENCE_ERROR, event stays pending]
    G -->|verified| H[wake_pending cleared, delivery closed]
```

### 9.5 Failures, Gates, and Recovery

Delivery and wake-up must first pass the gates: a conversation closing for deletion raises `CONVERSATION_DELETING`, a prepared rollback range raises `ROLLBACK_PENDING`, a non-open parent task raises `INVALID_TRANSITION`, a revoked event raises `INVALID_TRANSITION: event was revoked`, and a cross-scope event raises `PERMISSION_DENIED`. Re-delivering the same event is idempotent, and concurrent races are stopped by the event-status CAS. Archiving requires every run in the tree to be terminal (`RUN_BUSY`), and physical deletion requires a prepared deletion gate (`DELETE_PENDING`, `CONVERSATION_DELETING`).

Events are produced only by asynchronous terminal commits, along these branches:

| Terminal path                                                     | Writes a delivery event (async)               |
| ----------------------------------------------------------------- | --------------------------------------------- |
| `completed` / `failed` (settle)                                   | Yes; the gate decides `pending` or `revoked`  |
| `cancelled` (cancellation hits `queued`)                          | Yes                                           |
| `cancelled` (settled from `cancelling`)                           | Yes                                           |
| Repeated cancellation of a terminal run, or `finalizing` too late | No                                            |
| Cancellation on the deletion-preparation path                     | Yes, but always `revoked`                     |
| `interrupted` (restart recovery)                                  | No                                            |
| Terminal-commit CAS miss                                          | No; the receipt reports an uncommitted result |

```mermaid
flowchart TD
    A[Delivery or wake-up request] --> B{Gate and scope checks}
    B -->|conversation deleting| B1[CONVERSATION_DELETING]
    B -->|rollback range prepared| B2[ROLLBACK_PENDING]
    B -->|child outside scope| B3[PERMISSION_DENIED]
    B -->|parent task not open| B4[INVALID_TRANSITION]
    B -->|pass| C{Event status}
    C -->|revoked| C1[Delivery refused, the result stays readable]
    C -->|received with a receipt| C2[Idempotent reuse, no duplicate insert]
    C -->|pending| D[Insert the message pair and mark it received]
    D -->|CAS lost| D1[INVALID_TRANSITION, transaction rolled back]
    D -->|succeeded| E[Parent confirms and wake_pending is cleared]
    F[Application exit or renderer rebuild] --> G[recover marks non-terminal runs interrupted, no event]
```

## 10. Context Compaction

Compaction is manual or automatic when total tokens reach `autoCompressThreshold`:

1. A local workspace attempts a temporary checkpoint; SSH skips local file checkpoints.
2. Run `beforeCompress`.
3. Stream a request with `contextCompaction: true` and `checkpointId`; compaction exposes no tools.
4. Rust generates a handoff from the complete valid context and persists a `status = 'context_compaction'` boundary with real usage and checkpoint ID.
5. Renderer reloads database messages; automatic compaction resumes the original loop with `resumeAfterCompaction`.
6. Failure deletes the temporary checkpoint.

```mermaid
flowchart TD
    A[Manual trigger or tokens reach autoCompressThreshold] --> B{Local workspace?}
    B -- yes --> C[Create temporary checkpoint]
    B -- no --> D[SSH skips local file checkpoints]
    C --> E[Run beforeCompress]
    D --> E
    E --> F[Stream contextCompaction request<br/>compaction exposes no tools]
    F --> G[Rust generates handoff from complete valid context<br/>persists boundary: real usage + checkpoint ID]
    G --> H[Renderer reloads database messages]
    H --> I{Compaction succeeded?}
    I -- yes --> J[Resume original loop with resumeAfterCompaction]
    I -- no --> K[Delete the temporary checkpoint]
```

## 11. Rollback

`useRollback.ts` aborts the current stream, cancels summary generation, computes the checkpoint diff and TODOs to remove, and shows a preview. After confirmation it waits for stream and summary Promises to finish, avoiding races with SQLite write transactions. The user may truncate conversation only or also call `restoreCheckpoint` for files.

Rolling back the first message may delete the conversation; other cases call `truncateConversation` and clean obsolete checkpoints. A `context_compaction` boundary must be truncated using that boundary's own `responseId`, not misclassified as a first message.

```mermaid
flowchart TD
    A[Start rollback] --> B[Abort current stream and cancel summary generation]
    B --> C[Compute checkpoint diff and TODOs to remove]
    C --> D[Show preview]
    D --> E{User confirms?}
    E -- no --> F[Cancel rollback]
    E -- yes --> G[Wait for stream and summary Promises to finish<br/>avoid races with SQLite write transactions]
    G --> H{First message?}
    H -- yes --> I[Delete the whole conversation]
    H -- no --> J[truncateConversation and clean obsolete checkpoints]
    I --> K{Restore files too?}
    J --> K
    K -- yes --> L[restoreCheckpoint restores files]
    K -- no --> M{Rolling back a compaction boundary?}
    L --> M
    M -- yes --> N[Truncate with the boundary's own responseId<br/>do not misclassify as first message]
    M -- no --> O[Done]
```

## 12. Persistence

At the end of a model stream, each provider adapter calls `store_chat_exchange` with the user message, assistant content, thinking, `tool_calls_json`, response/checkpoint IDs, token usage, and compaction state. Renderer then executes tools. The next round carries `toolResultsJson` in a tool-role message, which is persisted with the next model exchange. `usage_records` accounts for successful, failed, and compaction requests.

## 13. End-to-End Sequence

```mermaid
sequenceDiagram
    participant U as User
    participant R as Renderer loop
    participant P as Preload and Main
    participant A as Rust provider
    participant DB as SQLite
    participant X as Authorization and Hooks
    participant M as MCP runtime

    U->>R: submit message
    R->>R: checkpoint and session hooks
    loop Until final answer
        R->>P: createResponseStream with streamId
        P->>A: native create_response_stream
        A-->>R: isolated streaming chunks
        A->>DB: store_chat_exchange and usage
        alt tool calls
            R->>X: confirmation and beforeToolCall
            X-->>R: decision
            R->>M: call_mcp_tool
            M->>M: policy checks and checkpoint capture
            M-->>R: privacy-masked result
            R->>X: afterToolCall
            R->>R: append toolResultsJson
        else final content
            R->>R: finish run
        end
    end
    R->>R: onStop and cleanup
```

## 14. State Invariants

- Chunks must be filtered by `streamId`; listeners are removed after completion or abort.
- A conversation accepts updates only from its current `runId`; an old Promise must not overwrite a newer run.
- Sub-agent authority cannot exceed explicit allowed-tools and project enablement.
- The model exchange is persisted first; tool results enter the next round as structured tool-role history.
- Rollback waits for asynchronous work that may still write to the database.

## 15. Source Anchors

| Topic                            | Files                                                                                                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main loop and stream state       | `src/renderer/components/mainContent/chatMessages/hooks/useAgentLoop.ts`, `agentLoopHelpers.ts`                                                                                                                                                       |
| Tool execution and authorization | `toolExecution.ts`, `useToolAuthorization.ts`                                                                                                                                                                                                         |
| Hooks                            | `hooks/hookOutcome.ts`, `useToolAuthorization.ts`, `native/src/hooks/`                                                                                                                                                                                |
| Sub-agents                       | `hooks/subAgentActivation.ts`, `hooks/subAgentParentInbox.ts`, `hooks/subAgentRunRegistry.ts`, `native/src/api/conversation/sub_agent.rs`, `native/src/mcp/servers/sub_agents.rs`, `native/src/storage/services/chat_conversations/sub_agent_runs.rs` |
| Compaction and rollback          | `hooks/useCompaction.ts`, `hooks/useRollback.ts`, `native/src/exports/checkpoint.rs`                                                                                                                                                                  |
| Stream IPC                       | `src/preload/modules/apiConfigApi.ts`, `src/main/ipc/handlers/chatHandlers.ts`, `src/main/utils/safeSend.ts`                                                                                                                                          |
| Provider dispatch                | `native/src/api/conversation/stream.rs`, `tool_messages.rs`                                                                                                                                                                                           |
| MCP discovery and call           | `native/src/mcp/builtin.rs`, `native/src/mcp/tools.rs`, `native/src/mcp/external/`                                                                                                                                                                    |
| Conversation and usage storage   | `native/src/storage/services/chat_conversations.rs`, `usage_records.rs`                                                                                                                                                                               |
