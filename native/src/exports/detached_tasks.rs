//! 后台（detach）任务：任务管理器面板的查询、终止与记录清理。
//!
//! 登记表本身在 `mcp::servers::bash::detached`（由 detach 分支写入），这里只做
//! napi 适配，并把系统调用放到 blocking 线程池，避免阻塞 Node.js 主线程。

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::mcp::servers::bash::detached;

/// 一个后台任务的当前状态；`alive` 每次查询时实时探测。
#[napi(object)]
pub struct DetachedTaskInfo {
    /// 任务 id（bash 工具结果里的 taskId，用于 UI 定位）
    pub id: String,
    pub pid: u32,
    pub command: String,
    /// 模型写的命令说明（用户语言），可为空串
    pub description: String,
    pub working_directory: String,
    /// 任务所属项目根；无法解析时为空串（任务管理器按此过滤）
    pub project_root: String,
    /// 输出日志绝对路径（正斜杠形式）
    pub log_path: String,
    /// 启动时刻（RFC3339）
    pub started_at: String,
    /// 退出时刻（RFC3339）；仍在运行时为 null，已退出时运行时长按此定格
    pub ended_at: Option<String>,
    /// 发起该命令的会话 id；非会话内启动时为 null
    pub session_id: Option<String>,
    pub alive: bool,
}

impl From<detached::DetachedTask> for DetachedTaskInfo {
    fn from(task: detached::DetachedTask) -> Self {
        Self {
            id: task.id,
            pid: task.pid,
            command: task.command,
            description: task.description,
            working_directory: task.working_directory,
            project_root: task.project_root,
            log_path: task.log_path,
            started_at: task.started_at,
            ended_at: task.ended_at,
            session_id: task.session_id,
            alive: task.alive,
        }
    }
}

/// 列出全部后台任务（存活状态实时探测）。
#[napi]
pub async fn list_detached_tasks() -> napi::Result<Vec<DetachedTaskInfo>> {
    tokio::task::spawn_blocking(|| {
        detached::list()
            .into_iter()
            .map(DetachedTaskInfo::from)
            .collect()
    })
    .await
    .map_err(|error| Error::from_reason(format!("Background task listing failed: {error}")))
}

/// 终止后台任务的整棵进程树；返回 false 表示进程已自行退出。
#[napi]
pub async fn kill_detached_task(id: String) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || detached::kill(&id))
        .await
        .map_err(|error| Error::from_reason(format!("Background task kill failed: {error}")))?
        .map_err(Error::from_reason)
}

/// 移除已完成任务的记录并删除其日志文件；仍在运行的任务会被拒绝（返回 false）。
#[napi]
pub async fn forget_detached_task(id: String) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || detached::forget(&id))
        .await
        .map_err(|error| Error::from_reason(format!("Background task cleanup failed: {error}")))
}
