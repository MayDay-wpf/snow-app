# 8-Git Worktree and Session Execution Domain Isolation Architecture Design

## 1. Background and problem statement

After Snow App gained Git WorkTree mode and parallel multi-worktree development, three classes of critical failures and misleading symptoms appeared:

1. **Split between the session prompt and environment awareness (words vs. reality)**:
   - A user starts a conversation from a worktree card (for example the `ui` directory, branch `feature/ui-performance`). The model runs `git status` in the terminal and the real output reports branch `feature/ui-performance`;
   - yet the first line of the model's reply declares "Working directory: `D:/code/snow-app`" (the main project root).
   - **Root cause**: when the Rust backend assembled the `## Working Directory` section of the system prompt, it was unaware of the physical worktree path bound to the current conversation and resolved the main repository root from the project-level identifier `directory_id` only.
2. **Cross-domain checkpoint validation alarm (Checkpoint Belongs To...)**:
   - The frontend log repeatedly threw:
     `Error occurred in handler for 'checkpoint:list-diffs-batch': [Error: Checkpoint belongs to '\\?\D:\code\snow-app-modules\ui', not '\\?\D:\code\snow-app']`.
   - **Root cause**: to prevent snapshots from different worktrees or different projects from being restored into the wrong place, the low-level checkpoint mechanism enforces a strict `validate_manifest_work_dir` ownership check on the Rust side. However, when fetching diffs, the change-summary panel under the composer (`ChatInputView.tsx` / `useConversationFileChanges.ts`) incorrectly passed the main project root (`D:\code\snow-app`) as `workDir`, tripping the low-level safety assertion.
3. **Database write-lock contention while persisting the first-round session migration (Database is locked)**:
   - The frontend log threw:
     `Error occurred in handler for 'git:worktrees:set-conversation': [Error: Failed to bind conversation worktree Snow App sqlite database at 'C:\Users\zhao\.snowapp\snowapp.db': database is locked]`.
   - **Root cause**: when a pending new conversation received its first model chunk and migrated to a real `conversationId`, the frontend fired several discrete IPC writes (`setConversationModes`, `setConversationWorktree`) within a very short window while the background Rust streaming task was writing the message table. In addition, `native/src/storage/services/git/worktrees.rs::set_conversation_worktree` was not wired into the existing `database::with_write_lock` and `database::with_write_retry` global write-lock scheduling queue, so it hit the SQLite lock-wait timeout directly.

---

## 2. Architecture design principles and four governance dimensions

To fix the problem at the architectural level instead of scattering patches, this design systematically refactors and converges the worktree execution domain along the following four dimensions:

### 2.1 Dimension one: single source of truth for the session physical workspace (Workspace Root SSOT)

- **Unified domain abstraction**:
  Distinguish the **engineering logical domain (Project Directory ID)** from the **session physical execution domain (Effective Workspace Root)**.
  - `directoryId`: used only as the primary key for project-level configuration, MCP permissions, tool approvals, and the codebase index;
  - `effectiveWorkspaceRoot`: the absolute baseline for every filesystem operation inside the conversation (the physical worktree path or the main repository path).
- **Unified resolution protocol (`resolveConversationWorkspacePath`)**:
  Every consumer (system prompt generation, MCP/Terminal tool CWD, checkpoint capture and diff reading, rollback chain analysis, and so on) resolves the working directory through this protocol only. No module may call `directoryIdToPath(conversationDirectoryId)` directly to bypass the resolution.

### 2.2 Dimension two: request contract evolution (Self-Contained Request Contract)

For the "lifecycle gap" in which a pending new conversation has no associated database record yet, the physical root directory is promoted to a first-class citizen in the low-level request contract:

- **`ResponsesApiRequest` (Rust & TS)** extension:
  ```typescript
  export type ResponsesApiRequest = {
    // ...
    /** Explicit effective workspace execution root (e.g. worktree directory path). */
    executionWorkspaceRoot?: string;
    /** Selected or preselected worktree ID for the conversation. */
    worktreeId?: string;
  };
  ```
- **Rust `context.rs` resolution pipeline**:
  ```rust
  let working_directory = if let Some(exec_root) = request.execution_workspace_root {
      exec_root.trim().to_string()
  } else if let Some(root) = request.analysis_workspace_root {
      // LSP temporary analysis root
      // ...
  } else if request.worktree_mode {
      // Prefer the explicit worktree_id lookup, then the persisted conversation_id lookup
      // ...
  } else {
      // Fall back to the main project root
  };
  ```
  This eliminates the backend's information blind spot when generating the system prompt and guarantees that the `Working Directory` the model sees at the start matches the physical worktree path 100%.

### 2.3 Dimension three: atomic session state migration and write-lock infrastructure adoption

- **Serialized persistence on the frontend**:
  `persistConversationSelection` in `useAgentLoop.ts` was refactored into sequential `async/await` execution, removing the micro-concurrency storm of several IPC writes hitting SQLite at the same moment; the redundant duplicate `setConversationWorktree` call in the migration stage was removed.
- **Full adoption of the in-process write-lock queue in the storage layer**:
  All write transactions in `native/src/storage/services/git/worktrees.rs` (`set_conversation_worktree`, `remove_worktree`) are wrapped in `database::with_write_lock` and `database::with_write_retry`:
  - `with_write_lock`: an in-process mutex serializes all SQLite writes so they never contend with background streaming message writes;
  - `with_write_retry`: retries occasional `SQLITE_BUSY` with increasing delays (250ms -> 500ms -> 1000ms) and never surfaces `database is locked` to the frontend.

### 2.4 Dimension four: checkpoint change consumption strictly symmetric with low-level snapshots

- **Change consumers inject the real physical workspace**:
  Before calling `window.snow.listCheckpointSummariesBatch(chainIds, workDir, false)`, `useConversationFileChanges.ts` resolves the effective physical worktree path through `resolveConversationWorkspacePath` whenever `worktreeMode` is on or a `worktreeId` is specified.
- **Closed defensive loop**:
  The `manifest.work_dir` recorded when the checkpoint is written and the `work_dir` requested when the frontend panel reads are guaranteed to be 100% symmetric, which eradicates the path-comparison alarms while preserving the "no cross-worktree code pollution" safety red line.

---

## 3. End-to-end data flow and state transitions

```mermaid
sequenceDiagram
    autonumber
    actor User as User
    participant UI as Renderer / composer (ChatInputView)
    participant Loop as Agent loop (useAgentLoop)
    participant Main as Electron main process (chatHandlers)
    participant Rust as Rust Native (context.rs / stream.rs)
    participant DB as SQLite (snowapp.db)

    User->>UI: Click a worktree card and send the first message
    UI->>Loop: Carry pendingWorktreeId and worktreeMode
    Loop->>Loop: resolveConversationWorkspacePath resolves the real physical path
    Loop->>Main: invoke chat:create-response-stream (with executionWorkspaceRoot & worktreeId)
    Main->>Rust: create_response_stream
    Rust->>Rust: context.rs assembles the real worktree prompt from executionWorkspaceRoot
    Rust-->>Main: Stream the first response chunk (containing the real conversationId)
    Main-->>Loop: First packet received, trigger session upgrade migration (Migrate Session)
    Loop->>DB: Sequentially await persistConversationSelection (modes -> worktree binding)
    Note over DB: database::with_write_lock guarantees queued writes with no lock conflict
    Loop->>UI: Trigger the change panel useConversationFileChanges
    UI->>Rust: listCheckpointSummariesBatch (with the resolved worktree path)
    Rust->>Rust: validate_manifest_work_dir passes (requested == recorded)
    Rust-->>UI: Return the file change summaries (diff details are paged on demand)
```

---

## 4. Key source anchors

| Layer / responsibility                        | Files involved                                                                                       | Core responsibility                                                                                   |
| :-------------------------------------------- | :--------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| **Storage write lock and binding**            | `native/src/storage/services/git/worktrees.rs`                                                       | Wired into `with_write_lock` / `with_write_retry`, exports `get_worktree_by_id`                       |
| **Protocol contract structures**              | `native/src/api/responses/mod.rs`<br>`src/main/native/types.ts`<br>`src/preload/types/api.ts`        | Define the `executionWorkspaceRoot` and `worktreeId` cross-layer contract fields                      |
| **Prompt working-directory injection**        | `native/src/api/conversation/context.rs`                                                             | Prefer the explicit execution root or the worktree path when injecting `## Working Directory`         |
| **Main-process IPC gate**                     | `src/main/ipc/handlers/chatHandlers.ts`                                                              | Whitelist and normalize `executionWorkspaceRoot` and `worktreeId`                                     |
| **Frontend change-panel symmetry**            | `src/renderer/components/mainContent/chatInput/useConversationFileChanges.ts`<br>`ChatInputView.tsx` | Consumers resolve the physical worktree path automatically, removing the checkpoint validation alarms |
| **Session migration persistence convergence** | `src/renderer/components/mainContent/chatMessages/hooks/useAgentLoop.ts`                             | Persist conversation state sequentially, eliminating duplicate and concurrent write collisions        |
