pub(crate) use napi::bindgen_prelude::*;
pub(crate) use napi_derive::napi;

pub(crate) use crate::hooks::{HookExecuteInput, HookExecuteResult};
pub(crate) use crate::storage::services::fs_explorer::{DirectoryEntry, FileContentResult, FileSearchResult};
pub(crate) use crate::storage::services::privacy_settings::{
    PrivacyApiConfig, PrivacySettings, PrivacyToolResultsConfig,
};
pub(crate) use crate::storage::services::theme_settings::{
    CustomTheme, ThemeBackground, ThemePalette, ThemeSettings, ThemeStreamCursor,
};
pub(crate) use crate::storage::{
    ApiConfigInput, ApiConfigRecord, AppStorageInfo, ChatConversationPage, ChatConversationRecord,
    ChatMessagePage, ChatMessageRecord, CodebaseProjectScopeSettings,
    ConversationSearchResult, CustomHeaderSchemeInput, CustomHeaderSchemeRecord,
    DatabaseOptimizeResult, DatabaseRepairResult,
    HookConfigInput, HookConfigRecord, ImportDatabaseTransactionInput, ImportResourceInput, ImportResourceRecord,
    ImportResourceRelease, ImportResourceReleaseInput, LspServerConfigInput, LspServerConfigRecord,
    McpServerConfigInput, McpServerConfigRecord,
    MemoryOptimizeResult,
    MemoCountSummary, MemoPage, MemoRecord, PluginInput, PluginMarketplaceInput,
    PluginMarketplaceRecord, PluginRecord, ProjectCollectionRecord, ProjectMcpServerConfigRecord,
    ProjectSensitiveCommandConfigInput, ProjectSensitiveCommandConfigRecord,
    RemoteDraftInput, RemoteDraftRecord,
    ScheduledTaskRecord, ScheduledTaskRecordInput,
    SensitiveCommandConfigInput, SensitiveCommandConfigRecord, SensitiveCommandMatchResult,
    SubAgentConfigInput, SubAgentConfigRecord, SystemPromptItemInput, SystemPromptItemRecord,
    UserMessageSummary, WorkflowNodeSessionRecord, WorkspaceDirectoryInput, WorkspaceDirectoryRecord,
};

mod agents;
mod api_configs;
mod app;
mod conversations;
mod hooks;
mod imports;
mod logs;
mod lsp;
mod mcp;
mod memos;
mod plugins;
mod privacy;
mod projects;
mod scheduled_tasks;
mod shortcuts;
mod storage_locations;
mod theme;

// 保留 crate::exports::storage::* 原有公共路径的重导出
#[allow(unused_imports)]
pub use {
    agents::*, api_configs::*, app::*, conversations::*, hooks::*, imports::*, logs::*, lsp::*,
    mcp::*,
    memos::*, plugins::*, privacy::*, projects::*, scheduled_tasks::*, shortcuts::*,
    storage_locations::*, theme::*,
};

// ============================================================================
// 所有 storage NAPI 函数均使用 async + spawn_blocking 模式，
// 确保 SQLite I/O 和文件系统操作不会阻塞 Node.js 主线程。
// ============================================================================

/// 将 tokio JoinError 转换为 napi Error
pub(crate) fn map_spawn_error(e: tokio::task::JoinError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Spawned blocking task failed: {}", e),
    )
}
