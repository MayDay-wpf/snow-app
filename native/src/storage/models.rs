use napi_derive::napi;

#[napi(object)]
pub struct AppStorageInfo {
    pub directory_path: String,
    pub database_path: String,
    pub archive_database_path: String,
}

/// 数据库修复结果（由「设置 → 存储位置」的修复按钮触发）。
#[napi(object)]
pub struct DatabaseRepairResult {
    /// 是否实际执行了数据恢复（true=检测到损坏并已恢复；false=数据库完好，仅完成压缩）
    pub repaired: bool,
    /// 修复过程描述（英文，供日志与诊断）
    pub message: String,
}

/// 数据库空间优化结果（由「设置 → 资源占用」的优化占用按钮触发）。
#[napi(object)]
pub struct DatabaseOptimizeResult {
    /// 本次 VACUUM + WAL 截断释放的磁盘字节数（无可回收空间时为 0）
    pub bytes_freed: i64,
}

/// 进程内存整理结果（由「设置 → 资源占用」的优化占用按钮触发；
/// bytes_before 由 Node 侧在 V8 GC 之前测量后透传回来）。
#[napi(object)]
pub struct MemoryOptimizeResult {
    /// 本次优化前的常驻内存（字节）
    pub bytes_before: i64,
    /// 本次优化后的常驻内存（字节）
    pub bytes_after: i64,
}

/// 数据清理：单个分类的扫描结果（由「设置 → 存储与资源 → 数据清理」触发）。
#[napi(object)]
pub struct CleanupCategoryStats {
    /// 分类 id：checkpoints / upload / imageLibrary / backgrounds / pets / browserState / appLogs
    pub id: String,
    /// 该分类下的文件总数
    pub files: i64,
    /// 该分类占用的总字节数
    pub bytes: i64,
    /// 与请求的 days_list 顺序一致：早于各天数档位可清理的文件数与字节数
    pub age_buckets: Vec<CleanupAgeBucket>,
}

/// 数据清理：单个时间档位（早于 N 天）可清理的数据量。
#[napi(object)]
pub struct CleanupAgeBucket {
    /// 天数档位（早于该天数之前创建的文件）
    pub days: u32,
    pub files: i64,
    pub bytes: i64,
}

/// 数据清理：一次扫描的完整结果。
#[napi(object)]
pub struct CleanupScanResult {
    pub categories: Vec<CleanupCategoryStats>,
    pub total_files: i64,
    pub total_bytes: i64,
}

/// 数据清理：删除结果。
#[napi(object)]
pub struct CleanupDeleteResult {
    pub deleted_files: i64,
    pub deleted_bytes: i64,
    /// 被整体移除的顶层条目数（文件或目录）
    pub removed_targets: i64,
    /// 删除失败的信息（最多 20 条）
    pub errors: Vec<String>,
}

#[napi(object)]
pub struct ApiConfigInput {
    pub profile_name: String,
    /// 重命名支持:编辑时传原配置名(仅改名时传入,新建/未改名时为 None)。
    /// 若与原配置名不同,upsert 会在同一事务内先改名再更新数据,保证原子性。
    pub previous_profile_name: Option<String>,
    pub display_name: String,
    pub is_active: bool,
    pub base_url: String,
    pub base_url_mode: String,
    pub api_key: String,
    pub request_method: String,
    pub advanced_model: String,
    pub basic_model: String,
    pub supports_vision: bool,
    pub vision_base_url: String,
    pub vision_base_url_mode: String,
    pub vision_api_key: String,
    pub vision_request_method: String,
    pub vision_model: String,
    pub max_context_tokens: Option<i32>,
    pub max_tokens: Option<i32>,
    pub stream_idle_timeout_sec: Option<i32>,
    pub enable_auto_compress: bool,
    pub auto_compress_threshold: Option<i32>,
    pub max_retries: Option<i32>,
    pub retry_base_delay_ms: Option<i32>,
    pub partial_retry_max_chars: Option<i32>,
    pub system_prompt_ids_json: String,
    pub custom_header_scheme_id: String,
    pub config_json: String,
    pub source: String,
}

#[napi(object)]
pub struct ApiConfigRecord {
    pub id: String,
    pub profile_name: String,
    pub display_name: String,
    pub is_active: bool,
    pub base_url: String,
    pub base_url_mode: String,
    pub api_key: String,
    pub request_method: String,
    pub advanced_model: String,
    pub basic_model: String,
    pub supports_vision: bool,
    pub vision_base_url: String,
    pub vision_base_url_mode: String,
    pub vision_api_key: String,
    pub vision_request_method: String,
    pub vision_model: String,
    pub max_context_tokens: Option<i32>,
    pub max_tokens: Option<i32>,
    pub stream_idle_timeout_sec: Option<i32>,
    pub enable_auto_compress: bool,
    pub auto_compress_threshold: Option<i32>,
    pub max_retries: Option<i32>,
    pub retry_base_delay_ms: Option<i32>,
    pub partial_retry_max_chars: Option<i32>,
    pub system_prompt_ids_json: String,
    pub custom_header_scheme_id: String,
    pub config_json: String,
    pub source: String,
    /// 列表展示顺序号（越小越靠前，由拖拽/上移下移维护）；新建档案自动取当前最大值 +1。
    pub sort_order: i32,
    pub updated_at: String,
}

#[napi(object)]
pub struct SystemPromptItemInput {
    pub prompt_id: String,
    pub name: String,
    pub content: String,
    pub is_active: bool,
    pub sort_order: i32,
    pub scope: Option<String>,
    pub project_id: Option<String>,
}

#[napi(object)]
pub struct SystemPromptItemRecord {
    pub id: String,
    pub prompt_id: String,
    pub name: String,
    pub content: String,
    pub is_active: bool,
    pub sort_order: i32,
    pub scope: String,
    pub project_id: Option<String>,
    pub updated_at: String,
}

#[napi(object)]
pub struct CustomHeaderSchemeInput {
    pub scheme_id: String,
    pub name: String,
    pub headers_json: String,
    pub is_active: bool,
    pub sort_order: i32,
}

#[napi(object)]
pub struct CustomHeaderSchemeRecord {
    pub id: String,
    pub scheme_id: String,
    pub name: String,
    pub headers_json: String,
    pub is_active: bool,
    pub sort_order: i32,
    pub updated_at: String,
}

#[napi(object)]
pub struct CustomCommandInput {
    pub command_id: String,
    pub scope: String,
    pub project_id: String,
    pub name: String,
    pub command_type: String,
    pub content: String,
    pub description: String,
    pub enabled: bool,
    pub sort_order: i32,
}

#[napi(object)]
pub struct CustomCommandRecord {
    pub command_id: String,
    pub scope: String,
    pub project_id: String,
    pub name: String,
    pub command_type: String,
    pub content: String,
    pub description: String,
    pub enabled: bool,
    pub sort_order: i32,
    pub shadowed: bool,
    pub updated_at: String,
}

#[napi(object)]
pub struct WorkspaceDirectoryInput {
    pub directory_id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub is_active: bool,
    pub sort_order: i32,
    pub source: String,
}

#[napi(object)]
pub struct WorkspaceDirectoryRecord {
    pub id: String,
    pub directory_id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub is_active: bool,
    pub sort_order: i32,
    pub source: String,
    pub path_state: String,
    pub last_known_path: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct WorkspaceDirectoryVerifyReport {
    pub directory_id: String,
    pub path: String,
    pub kind: String,
    pub state: String,
    pub last_known_path: String,
}

#[napi(object)]
pub struct WorkspaceRelinkRecord {
    pub relink_id: String,
    pub old_directory_id: String,
    pub new_directory_id: String,
    pub old_path: String,
    pub new_path: String,
    pub moved_by: String,
    pub created_at: String,
    pub undone_at: Option<String>,
}

#[napi(object)]
pub struct WorkspaceRelinkReport {
    pub relink_id: String,
    pub old_directory_id: String,
    pub new_directory_id: String,
    pub old_path: String,
    pub new_path: String,
    pub dry_run: bool,
    pub merged: bool,
    pub conversations: i32,
    pub archived_conversations: i32,
    pub memories: i32,
    pub memos: i32,
    pub scheduled_tasks: i32,
    pub collections_touched: i32,
    pub settings_keys_moved: i32,
    pub paths_rewritten: i32,
    pub checkpoints_rewritten: i32,
    pub codebase_reindex_required: bool,
    pub archive_updated: bool,
    pub notes: Vec<String>,
}

#[napi(object)]
pub struct ProjectCollectionRecord {
    pub id: String,
    pub collection_id: String,
    pub name: String,
    pub sort_order: i32,
    /// 收纳的项目 directory_id 列表（按加入顺序）。
    pub member_directory_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ===== 用户脚本（油猴兼容）=====

/// 用户脚本的解析后元数据（`// ==UserScript==` 头）。
#[napi(object)]
pub struct UserscriptMeta {
    pub name: String,
    pub version: String,
    pub description: String,
    pub namespace: String,
    pub author: String,
    pub run_at: String,
    pub noframes: bool,
    pub grant: Vec<String>,
    pub matches: Vec<String>,
    pub includes: Vec<String>,
    pub excludes: Vec<String>,
    pub requires: Vec<String>,
    /// 作用域：`browser`（内置浏览器，默认）/ `client`（桌面客户端 UI）/ `all`。
    pub target: String,
    /// 客户端脚本生效的主内容视图（空 = 全部视图；`*` 已在解析阶段归一化）。
    pub views: Vec<String>,
    /// 客户端脚本生效的界面区域（chat / sidebar / topbar / right-panel / settings…）。
    pub surfaces: Vec<String>,
    /// 生命周期作用域：`global` = 应用启动即常驻，随视图切换不重载。
    pub scope: String,
    /// 是否在隔离世界（沙箱档）执行；false = 主世界（完全权限档）。
    pub sandbox: bool,
}

/// 用户脚本完整记录（管理 UI 使用）。
#[napi(object)]
pub struct UserscriptRecord {
    pub script_id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub namespace: String,
    pub author: String,
    pub enabled: bool,
    pub run_at: String,
    pub noframes: bool,
    pub grant: Vec<String>,
    pub matches: Vec<String>,
    pub includes: Vec<String>,
    pub excludes: Vec<String>,
    pub requires: Vec<String>,
    /// 作用域：`browser`（内置浏览器，默认）/ `client`（桌面客户端 UI）/ `all`。
    pub target: String,
    /// 客户端脚本生效的主内容视图（空 = 全部视图）。
    pub views: Vec<String>,
    /// 客户端脚本生效的界面区域。
    pub surfaces: Vec<String>,
    /// 生命周期作用域：`global` = 应用启动即常驻。
    pub scope: String,
    /// 是否在隔离世界（沙箱档）执行；false = 主世界（完全权限档）。
    pub sandbox: bool,
    /// 脚本文件在磁盘上的绝对路径（~/.snowapp/browser-script/{script_id}.user.js）。
    pub file_path: String,
    pub created_at: String,
    pub updated_at: String,
}

/// GM_* API 的持久化值条目。
#[napi(object)]
pub struct UserscriptValue {
    pub key: String,
    pub value: String,
}

#[napi(object)]
pub struct RemoteDraftInput {
    pub profile_id: String,
    pub workspace_id: String,
    pub remote_path: String,
    pub base_version_json: String,
    pub content: String,
    pub status: String,
}

#[napi(object)]
pub struct RemoteDraftRecord {
    pub id: String,
    pub profile_id: String,
    pub workspace_id: String,
    pub remote_path: String,
    pub base_version_json: String,
    pub content: String,
    pub status: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct McpServerConfigInput {
    pub server_id: String,
    pub name: String,
    pub transport_type: String,
    pub url: String,
    pub command: String,
    pub args_json: String,
    pub env_json: String,
    pub headers_json: String,
    pub enabled: bool,
    pub timeout_ms: Option<i32>,
    pub sort_order: i32,
    pub source: String,
}

#[napi(object)]
pub struct McpServerConfigRecord {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub transport_type: String,
    pub url: String,
    pub command: String,
    pub args_json: String,
    pub env_json: String,
    pub headers_json: String,
    pub enabled: bool,
    pub timeout_ms: Option<i32>,
    pub sort_order: i32,
    pub source: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct LspServerConfigInput {
    pub lang: String,
    pub command: String,
    pub args_json: String,
    pub file_extensions_json: String,
    pub install_command: Option<String>,
    pub initialization_options_json: Option<String>,
    pub enabled: bool,
    pub sort_order: i32,
    pub source: String,
}

#[napi(object)]
pub struct LspServerConfigRecord {
    pub id: String,
    pub lang: String,
    pub command: String,
    pub args_json: String,
    pub file_extensions_json: String,
    pub install_command: Option<String>,
    pub initialization_options_json: Option<String>,
    pub enabled: bool,
    pub sort_order: i32,
    pub source: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct ProjectMcpServerConfigRecord {
    pub server_id: String,
    pub name: String,
    pub transport_type: String,
    pub url: String,
    pub command: String,
    pub args_json: String,
    pub env_json: String,
    pub headers_json: String,
    pub enabled: bool,
    pub timeout_ms: Option<i32>,
    pub sort_order: i32,
    pub source: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct SubAgentConfigInput {
    pub agent_id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub tools_json: String,
    pub config_profile: String,
    pub model: String,
    pub builtin: bool,
    pub sort_order: i32,
    pub source: String,
    /// 项目 ID。空/缺省表示全局子代理；指定后为项目级子代理
    /// （项目级与全局同 agent_id 时，项目级优先）。
    pub project_id: Option<String>,
}

#[napi(object)]
pub struct SubAgentConfigRecord {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub tools_json: String,
    pub config_profile: String,
    pub model: String,
    pub builtin: bool,
    pub sort_order: i32,
    pub source: String,
    pub updated_at: String,
    /// 项目 ID，空字符串表示全局子代理。
    pub project_id: String,
}

#[napi(object)]
pub struct SensitiveCommandConfigInput {
    pub command_id: String,
    pub pattern: String,
    pub description: String,
    pub enabled: bool,
    pub is_preset: bool,
    pub sort_order: i32,
    pub source: String,
}

#[napi(object)]
pub struct SensitiveCommandConfigRecord {
    pub id: String,
    pub command_id: String,
    pub pattern: String,
    pub description: String,
    pub enabled: bool,
    pub is_preset: bool,
    pub sort_order: i32,
    pub source: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct ProjectSensitiveCommandConfigInput {
    pub command_id: String,
    pub pattern: String,
    pub description: String,
    pub enabled: bool,
    pub sort_order: i32,
}

#[napi(object)]
pub struct ProjectSensitiveCommandConfigRecord {
    pub command_id: String,
    pub pattern: String,
    pub description: String,
    pub enabled: bool,
    pub inherited: bool,
    pub global_enabled: bool,
    pub is_preset: bool,
    pub sort_order: i32,
    pub source: String,
}

#[napi(object)]
pub struct SensitiveCommandMatchResult {
    pub command_id: String,
    pub pattern: String,
    pub description: String,
}

/// 决策模型对一条命中敏感规则的命令的判定结果。
#[napi(object)]
pub struct SensitiveCommandDecisionRecord {
    /// true = 判定可以直接放行。
    pub allow: bool,
    /// 判定理由的分类 key，由前端本地化展示
    /// （`sensitiveCommand.decision.reason.<key>`）。
    pub reason: String,
    /// 模型对判定的置信度（0-1）。
    pub confidence: f64,
    /// 决策模型托管：判定直接生效（放行 / 拒绝），不再弹拦截提示。
    pub delegate: bool,
    /// 参与判定的决策模型名称（用于展示）。
    pub model_name: String,
}

#[napi(object)]
pub struct HookConfigInput {
    pub hook_type: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub rules_json: String,
}

#[napi(object)]
pub struct HookConfigRecord {
    pub hook_type: String,
    pub scope: String,
    pub project_id: String,
    pub rules_json: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct CodebaseProjectScopeSettings {
    pub project_id: String,
    pub enabled: Option<bool>,
    pub enable_agent_review: Option<bool>,
    pub enable_reranking: Option<bool>,
}

#[napi(object)]
pub struct WorkflowNodeSessionRecord {
    pub conversation_id: String,
    pub parent_conversation_id: String,
    pub flow_id: String,
    /// Flow-level file checkpoint taken before the flow's first node runs;
    /// rollback restores it to undo file changes made by workflow nodes.
    pub flow_checkpoint_id: String,
    pub node_id: String,
    pub node_name: String,
    pub run_status: String,
    pub error_message: String,
    pub handoff_content: String,
    pub created_at: String,
    pub updated_at: String,
}

/// WorkFlow run-level state (one row per parent conversation + flow id).
/// Persists across app restarts so a flow can be resumed from the last
/// executed node instead of losing all progress.
#[napi(object)]
pub struct WorkflowRunRecord {
    pub parent_conversation_id: String,
    pub flow_id: String,
    pub run_status: String,
    pub current_node_index: i64,
    pub last_handoff: String,
    pub total_tokens: i64,
    pub flow_checkpoint_id: String,
    pub directory_id: String,
    pub error_message: String,
    pub created_at: String,
    pub updated_at: String,
}

/// WorkFlow canvas persistence payload (replaces localStorage).
#[napi(object)]
pub struct WorkflowCanvasRecord {
    pub parent_conversation_id: String,
    pub interaction_id: String,
    pub canvas_json: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct ChatConversationRecord {
    pub conversation_id: String,
    pub title: String,
    pub summary: String,
    pub last_message_preview: String,
    pub message_count: i32,
    pub model: String,
    pub api_profile_name: String,
    pub status: String,
    pub directory_id: String,
    pub forked_from_conversation_id: String,
    pub fork_message_count: i32,
    pub conversation_type: String,
    pub parent_conversation_id: String,
    pub sub_agent_id: String,
    pub sub_agent_name: String,
    pub sub_agent_status: String,
    pub sub_agent_error: String,
    pub created_at: String,
    pub updated_at: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub total_duration_ms: i64,
    /// 最近一次 AI run 的累计用量与墙钟总耗时（run 摘要条回显用）。
    pub run_input_tokens: i64,
    pub run_output_tokens: i64,
    pub run_cache_creation_input_tokens: i64,
    pub run_cache_read_input_tokens: i64,
    pub last_run_duration_ms: i64,
    pub run_ttft_sum_ms: i64,
    pub run_request_count: i64,
    pub emoji: String,
}

#[napi(object)]
pub struct ChatConversationPage {
    pub items: Vec<ChatConversationRecord>,
    pub total: i32,
}

#[napi(object)]
pub struct ConversationSearchResult {
    pub conversation_id: String,
    pub title: String,
    pub summary: String,
    pub last_message_preview: String,
    pub message_count: i32,
    pub model: String,
    pub status: String,
    pub directory_id: String,
    pub forked_from_conversation_id: String,
    pub fork_message_count: i32,
    pub created_at: String,
    pub updated_at: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub matched_content: String,
}

#[napi(object)]
pub struct ChatMessageRecord {
    pub id: String,
    pub role: String,
    pub content: String,
    pub thinking: String,
    /// Thinking-phase duration (ms) recorded for this assistant message.
    pub thinking_duration_ms: i64,
    /// Thinking-only token count recorded for this assistant message.
    pub thinking_token_count: i64,
    pub status: String,
    pub model: String,
    pub response_id: String,
    pub checkpoint_id: String,
    pub tool_calls_json: String,
    pub interruption_reason: Option<String>,
    pub recovery_outcome: Option<String>,
    /// Token usage of the API request that produced this assistant message
    /// (zero for user/tool rows and rows persisted before v46).
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub created_at: String,
}

#[napi(object)]
pub struct ChatMessagePage {
    pub items: Vec<ChatMessageRecord>,
    pub total: i32,
    pub has_more: bool,
    pub checkpoint_ids: Vec<String>,
}

#[napi(object)]
pub struct MemoRecord {
    pub id: String,
    pub memo_id: String,
    pub directory_id: String,
    pub content: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct MemoPage {
    pub items: Vec<MemoRecord>,
    pub total: i32,
    pub has_more: bool,
}

#[napi(object)]
pub struct MemoCountSummary {
    pub total: i32,
    pub pending: i32,
    pub done: i32,
}

/// 项目级持久记忆条目（project_memories 表）。按 `directory_id` 做项目
/// 隔离；`kind` 为 fact | decision | preference | pitfall | task_state，
/// `source` 为 agent（AI 工具写入）| auto（蒸馏）| user（手动），
/// `status` 为 active | pending（待确认）| archived。
#[napi(object)]
#[derive(serde::Serialize)]
pub struct MemoryRecord {
    pub id: String,
    pub memory_id: String,
    pub directory_id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub source: String,
    pub status: String,
    pub importance: i32,
    pub conversation_id: String,
    pub response_id: String,
    pub tags: Vec<String>,
    pub last_recalled_at: Option<String>,
    pub recall_count: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct MemoryPage {
    pub items: Vec<MemoryRecord>,
    pub total: i32,
    pub has_more: bool,
}

/// 项目记忆库统计（面板徽标与注入章节尾部汇总用）。
#[napi(object)]
pub struct MemoryStats {
    pub total: i32,
    pub active: i32,
    pub pending: i32,
    pub archived: i32,
}

#[napi(object)]
#[derive(Clone)]
pub struct ScheduledTaskRunRecord {
    /// ISO 8601 timestamp (UTC) when this run started.
    pub run_at: String,
    /// "running" | "completed" | "error".
    pub status: String,
    /// Elapsed milliseconds of the finished run.
    pub duration_ms: Option<i64>,
    /// Error message when status == "error".
    pub error: Option<String>,
}

/// Full task record persisted in SQLite. `schedule_json` holds the
/// serialized `ScheduledTaskSchedule`; timestamps are ISO 8601 strings
/// generated by the renderer (the scheduling semantics live there).
#[napi(object)]
pub struct ScheduledTaskRecord {
    pub id: String,
    pub directory_id: String,
    pub name: String,
    pub prompt: String,
    pub schedule_json: String,
    pub api_profile: Option<String>,
    pub basic_model: Option<String>,
    pub model: Option<String>,
    pub thinking_strength: Option<String>,
    pub status: String,
    pub paused: bool,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub run_count: i32,
    pub last_error: Option<String>,
    /// Optional pre-script shell command executed before the AI Loop.
    pub pre_script: Option<String>,
    /// Pre-script timeout in ms (default 60000, range 1000-300000).
    pub pre_script_timeout_ms: Option<i64>,
    /// When true, a pre-script failure still proceeds to the AI Loop.
    pub run_on_script_error: Option<bool>,
    /// How many times the pre-script skipped the AI Loop.
    pub skip_count: i32,
    /// ISO timestamp of the last skip, if any.
    pub last_skipped_at: Option<String>,
    /// Reason from the last skip.
    pub last_skip_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Latest run history entries (newest last, max 20), populated when read
    /// from the database; ignored on write.
    pub history: Vec<ScheduledTaskRunRecord>,
}

/// Write-side shape of a scheduled task (same fields as `ScheduledTaskRecord`
/// minus `history`, which lives in the separate runs table).
#[napi(object)]
pub struct ScheduledTaskRecordInput {
    pub id: String,
    pub directory_id: String,
    pub name: String,
    pub prompt: String,
    pub schedule_json: String,
    pub api_profile: Option<String>,
    pub basic_model: Option<String>,
    pub model: Option<String>,
    pub thinking_strength: Option<String>,
    pub status: String,
    pub paused: bool,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub run_count: i32,
    pub last_error: Option<String>,
    /// Optional pre-script shell command executed before the AI Loop.
    pub pre_script: Option<String>,
    /// Pre-script timeout in ms (default 60000, range 1000-300000).
    pub pre_script_timeout_ms: Option<i64>,
    /// When true, a pre-script failure still proceeds to the AI Loop.
    pub run_on_script_error: Option<bool>,
    /// How many times the pre-script skipped the AI Loop.
    pub skip_count: i32,
    /// ISO timestamp of the last skip, if any.
    pub last_skipped_at: Option<String>,
    /// Reason from the last skip.
    pub last_skip_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct PluginRecord {
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub homepage: String,
    pub license: String,
    pub icon: String,
    pub render_mode: String,
    pub entry: String,
    pub enabled: bool,
    pub install_path: String,
    pub source_path: String,
    pub manifest_json: String,
    pub panels: String,
    pub locales: String,
    pub styles: String,
    pub privacy: Vec<String>,
    pub privacy_note: String,
    pub min_app_version: String,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct PluginStorageValue {
    pub key: String,
    pub value: String,
}
