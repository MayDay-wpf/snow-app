//! 应用存储初始化与系统级设置（yolo / 请求日志）。

use super::*;

#[napi]
pub async fn initialize_app_storage() -> napi::Result<AppStorageInfo> {
    tokio::task::spawn_blocking(crate::storage::initialize_app_storage)
        .await
        .map_err(map_spawn_error)?
}

/// 修复数据库（"runtime" = 运行库 | "archive" = 归档库）：
/// 完整性检查 + 损坏恢复 + VACUUM 压缩。全程在 spawn_blocking 中执行，
/// 不阻塞 Node.js 主线程。
#[napi]
pub async fn repair_database(kind: String) -> napi::Result<DatabaseRepairResult> {
    tokio::task::spawn_blocking(move || crate::storage::repair_database(kind))
        .await
        .map_err(map_spawn_error)?
}

/// 优化数据库磁盘占用（"runtime" = 运行库 | "archive" = 归档库）：
/// VACUUM 回收空闲页并截断 WAL，返回释放的字节数。全程在 spawn_blocking 中执行，
/// 不阻塞 Node.js 主线程。
#[napi]
pub async fn optimize_database(kind: String) -> napi::Result<DatabaseOptimizeResult> {
    tokio::task::spawn_blocking(move || crate::storage::optimize_database(kind))
        .await
        .map_err(map_spawn_error)?
}

/// 采集以 `root_pid` 为根的应用进程树快照（任务管理器面板）。
/// 系统调用 + CPU 采样缓存，置于 spawn_blocking，不阻塞 Node.js 主线程。
#[napi]
pub async fn list_process_tree(root_pid: u32) -> napi::Result<Vec<ProcessSnapshotEntry>> {
    tokio::task::spawn_blocking(move || crate::storage::list_process_tree(root_pid))
        .await
        .map_err(map_spawn_error)?
}

/// 进程日志采样专用的进程树快照（独立 CPU 基线，不影响任务管理器面板）。
#[napi]
pub async fn list_process_tree_for_log(
    root_pid: u32,
) -> napi::Result<Vec<ProcessSnapshotEntry>> {
    tokio::task::spawn_blocking(move || crate::storage::list_process_tree_for_log(root_pid))
        .await
        .map_err(map_spawn_error)?
}

/// 追加一行进程采样日志（JSONL），超过单文件上限时轮转并保留最近 max_files 个文件。
/// 文件 IO 置于 spawn_blocking，不阻塞 Node.js 主线程。
#[napi]
pub async fn append_process_sampling_log(
    dir: String,
    line: String,
    max_bytes: u32,
    max_files: u32,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::append_sampling_line(
            std::path::Path::new(&dir),
            &line,
            u64::from(max_bytes),
            max_files,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

/// 结束指定进程树（任务管理器面板的「结束进程」）。
/// Windows 用 taskkill /T /F 连同后代一起结束，Unix 走进程组 kill。
#[napi]
pub async fn kill_process_tree(pid: u32) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::kill_process_tree(pid))
        .await
        .map_err(map_spawn_error)?
}

/// 本进程内存整理（「优化占用」的内存部分）：仅 Windows 支持——Node 侧的
/// V8 GC 在调用前完成，Rust 侧收缩工作集把不活跃页换出物理内存。
/// 非 Windows 平台返回错误（macOS/Linux 的堆整理接口存在崩溃风险）。
/// 全程在 spawn_blocking 中执行，不阻塞 Node.js 主线程。
#[napi]
pub async fn optimize_memory() -> napi::Result<MemoryOptimizeResult> {
    tokio::task::spawn_blocking(crate::storage::optimize_memory)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_system_setting_value(setting_code: String) -> napi::Result<Option<String>> {
    tokio::task::spawn_blocking(move || crate::storage::get_system_setting_value(setting_code))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_system_setting(
    setting_name: String,
    setting_code: String,
    setting_value: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_system_setting(setting_name, setting_code, setting_value)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_system_setting(setting_code: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_system_setting(setting_code))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_yolo_mode() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_yolo_mode)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_yolo_mode(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_yolo_mode(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_lite_mode() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_lite_mode)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_lite_mode(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_lite_mode(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_always_approved_tools() -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(crate::storage::get_always_approved_tools)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_always_approved_tools(tools: Vec<String>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_always_approved_tools(tools))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_tool_approval_project_tools_approved(
    project_id: String,
    tool_names: Vec<String>,
    approved: bool,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_tool_approval_project_tools_approved(
            project_id,
            tool_names,
            approved,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_auto_format() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_auto_format)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_auto_format(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_auto_format(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_tool_correction() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_tool_correction)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_tool_correction(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_tool_correction(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_context_fold() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_context_fold)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_context_fold(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_context_fold(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_request_logging() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_request_logging)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_request_logging(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_request_logging(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_request_logging_expiry() -> napi::Result<i64> {
    tokio::task::spawn_blocking(crate::storage::get_request_logging_expiry)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_request_logging_expiry(expires_at_ms: i64) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_request_logging_expiry(expires_at_ms))
        .await
        .map_err(map_spawn_error)?
}
