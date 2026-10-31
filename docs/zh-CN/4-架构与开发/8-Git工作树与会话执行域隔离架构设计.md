# 8-Git 工作树与会话执行域隔离架构设计

## 1. 背景与问题背景

在 Snow App 支持 Git WorkTree 模式与多工作树并行开发后，系统出现了以下三类关键故障与表现失真现象：

1. **会话提示词与环境认知分裂（表里不一）**：
   - 用户在工作树卡片（如 `ui` 目录，对应分支 `feature/ui-performance`）中发起会话，模型调用终端命令 `git status` 真实输出分支为 `feature/ui-performance`；
   - 但模型回复的第一句环境状态却声明“工作目录：`D:/code/snow-app`（主项目根目录）”。
   - **根因**：Rust 后端在拼装 System Prompt 的 `## Working Directory` 时，未感知到当前会话绑定的工作树物理路径，仅依赖项目主标识 `directory_id` 从数据库取到了主仓库根目录。
2. **检查点防跨域校验报警（Checkpoint Belongs To...）**：
   - 前端日志频繁抛出：
     `Error occurred in handler for 'checkpoint:list-diffs-batch': [Error: Checkpoint belongs to '\\?\D:\code\snow-app-modules\ui', not '\\?\D:\code\snow-app']`。
   - **根因**：底层 Checkpoint 机制为了防止不同工作树或不同项目的快照被误还原，在 Rust 侧实施了严格的 `validate_manifest_work_dir` 归属校验；但前端输入框下方的变更统计面板（`ChatInputView.tsx` / `useConversationFileChanges.ts`）在拉取 diff 时，错误地将主项目根目录（`D:\code\snow-app`）当成 `workDir` 传入，触发了底层的安全防御断言。
3. **首轮会话迁移落库时的数据库写锁争抢（Database is locked）**：
   - 前端日志抛出：
     `Error occurred in handler for 'git:worktrees:set-conversation': [Error: Failed to bind conversation worktree Snow App sqlite database at 'C:\Users\zhao\.snowapp\snowapp.db': database is locked]`。
   - **根因**：首轮待定新会话（Pending Session）收到模型首个 chunk 拿到真实 `conversationId` 迁移时，前端在极短时间内并发抛出多个离散 IPC 写入（`setConversationModes`、`setConversationWorktree`），同时后台 Rust 流式任务正在写入消息表，且 Rust 原生侧 `native/src/storage/services/git/worktrees.rs::set_conversation_worktree` 未接入已有的 `database::with_write_lock` 和 `database::with_write_retry` 全局写锁调度队列，直接触发了 SQLite 的锁等待超时。

---

## 2. 架构设计原则与四个维度治理

为了从架构上根治而非仅打零散补丁，本设计从以下四个维度对工作树执行域进行了系统性重构与收敛：

### 2.1 维度一：会话物理工作区单一真实源（Workspace Root SSOT）

- **统一领域抽象**：
  区分**工程逻辑域（Project Directory ID）**与**会话物理执行域（Effective Workspace Root）**。
  - `directoryId`：仅作为工程级配置、MCP 权限、工具审批、代码库索引的主键；
  - `effectiveWorkspaceRoot`：会话内一切文件系统操作的绝对基准（物理工作树路径或主仓库路径）。
- **统一决议协议（`resolveConversationWorkspacePath`）**：
  任何业务消费端（包括系统提示词生成、MCP/Terminal 工具 CWD、Checkpoint 捕获与 Diff 读取、回滚链分析等）统一通过该协议决议工作目录，严禁任何模块直接取 `directoryIdToPath(conversationDirectoryId)` 绕过决议。

### 2.2 维度二：对话请求契约协议演进（Self-Contained Request Contract）

针对首轮待定新会话（Pending Session）数据库尚无关联记录的“生命周期空窗期”，在底层请求契约中提升物理根目录为一等公民：

- **`ResponsesApiRequest`（Rust & TS）** 扩展：
  ```typescript
  export type ResponsesApiRequest = {
    // ...
    /** Explicit effective workspace execution root (e.g. worktree directory path). */
    executionWorkspaceRoot?: string;
    /** Selected or preselected worktree ID for the conversation. */
    worktreeId?: string;
  };
  ```
- **Rust `context.rs` 决议流水线**：
  ```rust
  let working_directory = if let Some(exec_root) = request.execution_workspace_root {
      exec_root.trim().to_string()
  } else if let Some(root) = request.analysis_workspace_root {
      // LSP 临时分析根
      // ...
  } else if request.worktree_mode {
      // 优先从显式 worktree_id 查表，其次从持久化 conversation_id 查表
      // ...
  } else {
      // 兜底回退主项目根目录
  };
  ```
  彻底消除了后端生成系统提示词时的信息盲区，确保模型开场所见 `Working Directory` 与实际工作树物理路径 100% 绝对一致。

### 2.3 维度三：会话状态迁移原子化与写锁基础设施接入

- **前端落库串行化**：
  重构 `useAgentLoop.ts` 中的 `persistConversationSelection` 为顺序 `async/await` 执行，消除多个 IPC 写入同时打向 SQLite 的微并发风暴；清理掉迁移阶段外层多余的重复 `setConversationWorktree` 调用。
- **存储层全面接入进程内写锁队列**：
  将 `native/src/storage/services/git/worktrees.rs` 中的所有写事务（`set_conversation_worktree`、`remove_worktree`）全面包裹入 `database::with_write_lock` 和 `database::with_write_retry`：
  - `with_write_lock`：进程内互斥锁串行化所有 SQLite 写操作，绝不与后台流式消息写入产生争抢；
  - `with_write_retry`：遭遇偶发 `SQLITE_BUSY` 时以递增延迟（250ms -> 500ms -> 1000ms）自动重试，绝不将 `database is locked` 暴露给前端。

### 2.4 维度四：Checkpoint 变更消费与底层快照严格对称

- **变更消费端注入真实物理工作区**：
  `useConversationFileChanges.ts` 在调用底层 `window.snow.listCheckpointSummariesBatch(chainIds, workDir, false)` 前，若处于 `worktreeMode` 或指定了 `worktreeId`，自动通过 `resolveConversationWorkspacePath` 决议出有效的物理工作树路径。
- **防御机制闭环**：
  保证底层 Checkpoint 写入时所记录的 `manifest.work_dir` 与前端展示面板读取时所请求的 `work_dir` 100% 对称，在守住“跨工作树防代码污染”安全红线的同时，根除了路径比对失败的报警。

---

## 3. 端到端数据流与状态流转

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant UI as 前端/输入区 (ChatInputView)
    participant Loop as Agent主循环 (useAgentLoop)
    participant Main as Electron主进程 (chatHandlers)
    participant Rust as Rust Native (context.rs / stream.rs)
    participant DB as SQLite (snowapp.db)

    User->>UI: 点击工作树卡片并发送第一条消息
    UI->>Loop: 携带 pendingWorktreeId 与 worktreeMode
    Loop->>Loop: resolveConversationWorkspacePath 决议真实物理路径
    Loop->>Main: invoke chat:create-response-stream (带 executionWorkspaceRoot & worktreeId)
    Main->>Rust: create_response_stream
    Rust->>Rust: context.rs 依据 executionWorkspaceRoot 装配真实工作树提示词
    Rust-->>Main: 流式下发首个 response chunk (包含真实 conversationId)
    Main-->>Loop: 收到首包，触发会话升级迁移 (Migrate Session)
    Loop->>DB: 顺序 await persistConversationSelection (modes -> worktree 绑定)
    Note over DB: database::with_write_lock 保证排队无锁冲突
    Loop->>UI: 触发变更面板 useConversationFileChanges
    UI->>Rust: listCheckpointSummariesBatch (带决议后的工作树路径)
    Rust->>Rust: validate_manifest_work_dir 校验通过 (requested == recorded)
    Rust-->>UI: 返回文件变更摘要列表（diff 明细查看时按页读取）
```

---

## 4. 关键源码锚点

| 层次 / 职责             | 涉及文件                                                                                             | 核心职责                                                               |
| :---------------------- | :--------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| **存储层写锁与绑定**    | `native/src/storage/services/git/worktrees.rs`                                                       | 接入 `with_write_lock` / `with_write_retry`，导出 `get_worktree_by_id` |
| **协议契约结构**        | `native/src/api/responses/mod.rs`<br>`src/main/native/types.ts`<br>`src/preload/types/api.ts`        | 定义 `executionWorkspaceRoot` 与 `worktreeId` 跨层契约字段             |
| **Prompt 工作目录注入** | `native/src/api/conversation/context.rs`                                                             | 优先采用显式执行根或工作树路径注入 `## Working Directory`              |
| **主进程 IPC 门禁**     | `src/main/ipc/handlers/chatHandlers.ts`                                                              | 白名单放行与规范化 `executionWorkspaceRoot` 和 `worktreeId`            |
| **前端变更面板对称性**  | `src/renderer/components/mainContent/chatInput/useConversationFileChanges.ts`<br>`ChatInputView.tsx` | 消费端自动决议物理工作树路径，消除 Checkpoint 校验报警                 |
| **会话迁移落库收敛**    | `src/renderer/components/mainContent/chatMessages/hooks/useAgentLoop.ts`                             | 顺序持久化会话状态，消除重复与并发写事务碰撞                           |
