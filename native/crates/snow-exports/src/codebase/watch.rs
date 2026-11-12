//! 项目目录的文件监听（增量同步触发源）。

use super::*;

/// Start watching a project directory for codebase-relevant file changes.
///
/// This delegates to `codebase_watcher::start_codebase_watch`. Events are
/// filtered (gitignore + extension whitelist + binary detection) and
/// debounced for 3 seconds before the JS callback is invoked with the
/// project_id string.
///
/// The watcher runs on a background thread and never blocks the Node.js
/// main thread.
#[napi(
    ts_args_type = "projectId: string, projectPath: string, onChange: (projectId: string) => void",
    ts_return_type = "void"
)]
pub fn start_codebase_watch(
    project_id: String,
    project_path: String,
    on_change: CodebaseChangeCallback,
) -> Result<()> {
    codebase_watcher::start_codebase_watch(project_id, project_path, on_change)
        .map_err(|e| Error::from_reason(e.to_string()))
}

/// Stop watching a project directory for codebase file changes.
#[napi]
pub fn stop_codebase_watch(project_id: String) -> Result<()> {
    codebase_watcher::stop_codebase_watch(project_id).map_err(|e| Error::from_reason(e.to_string()))
}
