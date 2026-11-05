pub(crate) use napi::bindgen_prelude::*;
pub(crate) use napi_derive::napi;

pub(crate) use crate::hooks::{HookExecuteInput, HookExecuteResult};
pub(crate) use crate::storage::services::fs_explorer::{
    DirectoryEntry, FileContentResult, FilePreviewResult, FileSearchResult,
};
pub(crate) use crate::storage::services::app_lock::{
    AppLockState, AppLockTotpBinding, AppLockVerifyResult,
};
pub(crate) use crate::storage::services::api_config_transfer::{
    ApiConfigExportResult, ApiConfigImportOutcome, ApiConfigImportPreview,
};
pub(crate) use crate::storage::services::privacy_settings::{
    PrivacyApiConfig, PrivacyCustomRule, PrivacySettings, PrivacyToolResultsConfig,
};
pub(crate) use crate::storage::services::theme_settings::{
    CustomTheme, ThemeBackground, ThemeChatStyle, ThemePalette, ThemeSettings, ThemeStreamCursor,
    ThemeTypography,
};
pub(crate) use crate::storage::{
    ApiConfigInput, ApiConfigRecord, AppStorageInfo, ChatConversationPage, ChatConversationRecord,
    ChatMessageImage,
    ChatMessagePage, ChatMessageRecord, CodebaseProjectScopeSettings,
    ConversationSearchResult, CustomCommandInput, CustomCommandRecord,
    CustomHeaderSchemeInput, CustomHeaderSchemeRecord,
    DatabaseOptimizeResult, DatabaseRepairResult,
    DiffReviewCommentRecord, FileReviewAnnotationRecord,
    HookConfigInput, HookConfigRecord, LspServerConfigInput, LspServerConfigRecord,
    McpServerConfigInput, McpServerConfigRecord,
    MemoryOptimizeResult,
    MemoryPage, MemoryRecord, MemoryStats,
    MemoCountSummary, MemoPage, MemoRecord, PluginRecord, PluginStorageValue,
    ProcessSnapshotEntry,
    ProjectCollectionRecord, ProjectMcpServerConfigRecord,
    ProjectSensitiveCommandConfigInput, ProjectSensitiveCommandConfigRecord,
    RemoteDraftInput, RemoteDraftRecord,
    ScheduledTaskRecord, ScheduledTaskRecordInput,
    SensitiveCommandConfigInput, SensitiveCommandConfigRecord,
    SubAgentConfigInput, SubAgentConfigRecord, SystemPromptItemInput, SystemPromptItemRecord,
UserMessageSummary, UserscriptRecord, UserscriptValue,
    WorkflowCanvasRecord, WorkflowNodeSessionRecord, WorkflowRunRecord, WorkspaceDirectoryInput, WorkspaceDirectoryRecord,
    WorkspaceDirectoryVerifyReport, WorkspaceRelinkRecord, WorkspaceRelinkReport,
};

mod agents;
mod api_configs;
mod app;
mod app_lock;
mod backup;
mod cleanup;
mod conversations;
mod custom_commands;
mod diff_comments;
mod file_review_annotations;
mod hooks;
mod logs;
mod lsp;
mod mcp;
mod memos;
mod memory;
mod plugins;
mod privacy;
mod projects;
mod scheduled_tasks;
mod shortcuts;
mod storage_locations;
mod theme;
mod userscripts;

// 保留 crate::exports::storage::* 原有公共路径的重导出
#[allow(unused_imports)]
pub use {
    agents::*, api_configs::*, app::*, app_lock::*, backup::*, cleanup::*, conversations::*, custom_commands::*,
    diff_comments::*, file_review_annotations::*,
    hooks::*, logs::*,
    lsp::*,
    mcp::*,
    memos::*, memory::*, plugins::*, privacy::*, projects::*, scheduled_tasks::*, shortcuts::*,
    storage_locations::*, theme::*, userscripts::*,
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
