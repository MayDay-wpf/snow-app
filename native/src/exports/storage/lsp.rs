//! LSP 服务器配置的 NAPI 转发（照 mcp.rs 模式）。

use super::*;

#[napi(object)]
pub struct LspCommandProbeResult {
    pub command: String,
    pub installed: bool,
    pub path: Option<String>,
}

impl From<crate::mcp::servers::lsp::ProbeResult> for LspCommandProbeResult {
    fn from(result: crate::mcp::servers::lsp::ProbeResult) -> Self {
        LspCommandProbeResult {
            command: result.command,
            installed: result.installed,
            path: result.path,
        }
    }
}

#[napi(object)]
pub struct ProjectStackDetection {
    /// 相对项目根的目录（"" = 根，或 "frontend"、"packages/web"）。
    pub path: String,
    /// 语言：typescript | rust | go | python | java | csharp | php | ruby | lua | kotlin。
    pub lang: String,
    /// 命中的标志文件名（package.json / Cargo.toml / go.mod ...）。
    pub marker: String,
}

/// 检测项目技术栈：扫描 project_root（递归深度 ≤ 2，支持 monorepo 子目录），
/// 返回 (path, lang) 去重后按 path + lang 字典序排序的结果。project_root
/// 不存在/不可读 → 空数组。纯文件系统扫描，无副作用。
#[napi]
pub async fn detect_project_stack(
    project_root: String,
) -> napi::Result<Vec<ProjectStackDetection>> {
    tokio::task::spawn_blocking(move || {
        crate::mcp::servers::lsp::detect::detect_project_stack(&project_root)
            .into_iter()
            .map(|d| ProjectStackDetection {
                path: d.path,
                lang: d.lang,
                marker: d.marker,
            })
            .collect()
    })
    .await
    .map_err(map_spawn_error)
}

/// 探测有效配置（含项目覆盖）中 enabled 服务器的命令是否已安装（PATH 扫描，
/// 无副作用）。返回按 command 去重后的探测结果。
#[napi]
pub async fn probe_lsp_server_commands(
    project_id: Option<String>,
) -> napi::Result<Vec<LspCommandProbeResult>> {
    tokio::task::spawn_blocking(move || {
        let records = crate::storage::list_effective_lsp_server_configs(project_id)?;
        let commands: Vec<String> = records
            .into_iter()
            .filter(|record| record.enabled)
            .map(|record| record.command)
            .collect();
        Ok(crate::mcp::servers::lsp::probe_commands(&commands)
            .into_iter()
            .map(LspCommandProbeResult::from)
            .collect())
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_lsp_server_configs() -> napi::Result<Vec<LspServerConfigRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_lsp_server_configs)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_lsp_server_config(item: LspServerConfigInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_lsp_server_config(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_lsp_server_config(lang: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_lsp_server_config(lang))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_project_lsp_server_configs(
    project_id: String,
) -> napi::Result<Vec<LspServerConfigRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_project_lsp_server_configs(project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_effective_lsp_server_configs(
    project_id: Option<String>,
) -> napi::Result<Vec<LspServerConfigRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_effective_lsp_server_configs(project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_project_lsp_server_config(
    project_id: String,
    item: LspServerConfigInput,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::upsert_project_lsp_server_config(project_id, item)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_project_lsp_server_config(
    project_id: String,
    lang: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_project_lsp_server_config(project_id, lang)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 语言服务器会话运行时状态（前端状态徽章实时展示用）。
#[napi(object)]
pub struct LspSessionStatus {
    pub lang: String,
    /// 会话项目根目录（绝对路径）。
    pub project_root: String,
    /// `running` | `dead` | `exited`（进程已退出但会话未标记）。
    pub status: String,
    pub restart_count: u32,
    /// 最近使用时间（unix 毫秒）。
    pub last_used_ms: i64,
    /// 异常状态说明（running 时为 null）。
    pub error: Option<String>,
}

fn resolve_project_root_from_id(project_id: &str) -> napi::Result<std::path::PathBuf> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = std::path::PathBuf::from(storage_info.database_path);
    match crate::storage::services::workspace_directories::get_workspace_directory_path(
        &database_path,
        project_id,
    ) {
        Ok(Some(root)) => Ok(std::path::PathBuf::from(root)),
        Ok(None) => Err(Error::new(
            Status::InvalidArg,
            format!("Project directory not found for ID: {project_id}"),
        )),
        Err(err) => Err(err),
    }
}

/// 列出 LSP 会话状态快照（(语言 × 项目根) 粒度）。
/// 仅反映本进程内存态，不触发任何会话创建/回收；查询开销 = 会话数 ×
/// 一次非阻塞 try_wait。
///
/// `project_id`：可选的当前项目。传入时仅返回该项目根下的会话（前端徽章
/// 按当前项目过滤，§10）：project_id → workspace_directories 表解析项目根；
/// 解析失败（项目不存在 / SSH 远程等）返回空列表（本地 LSP 不适用于远程）。
/// 未传则返回全部会话（保持向后兼容）。
#[napi]
pub async fn list_lsp_session_statuses(
    project_id: Option<String>,
) -> napi::Result<Vec<LspSessionStatus>> {
    let manager = crate::mcp::servers::lsp::manager::ServerManager::instance();
    let filter_root = match project_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(pid) => match resolve_project_root_from_id(pid) {
            Ok(root) => Some(root),
            Err(_) => return Ok(Vec::new()),
        },
    };
    Ok(manager
        .session_statuses(filter_root.as_deref())
        .await
        .into_iter()
        .map(|status| LspSessionStatus {
            lang: status.lang,
            project_root: status.project_root,
            status: status.status,
            restart_count: status.restart_count,
            last_used_ms: status.last_used_ms as i64,
            error: status.error,
        })
        .collect())
}

/// 手动启动（预热）指定项目和语言的 LSP 会话。
#[napi]
pub async fn start_lsp_session(
    project_id: String,
    lang: String,
) -> napi::Result<LspSessionStatus> {
    let project_root = resolve_project_root_from_id(&project_id)?;
    let manager = crate::mcp::servers::lsp::manager::ServerManager::instance();
    let status = manager
        .start_session(&lang, &project_root, Some(&project_id))
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e:?}")))?;
    Ok(LspSessionStatus {
        lang: status.lang,
        project_root: status.project_root,
        status: status.status,
        restart_count: status.restart_count,
        last_used_ms: status.last_used_ms as i64,
        error: status.error,
    })
}

/// 手动停止指定项目和语言的 LSP 会话（释放进程与内存）。
#[napi]
pub async fn stop_lsp_session(
    project_id: String,
    lang: String,
) -> napi::Result<bool> {
    let project_root = resolve_project_root_from_id(&project_id)?;
    let manager = crate::mcp::servers::lsp::manager::ServerManager::instance();
    let stopped_count = manager.stop_session(&lang, &project_root).await;
    Ok(stopped_count > 0)
}

/// 手动重启指定项目和语言的 LSP 会话，可选清理持久化诊断缓存以强制全新索引。
#[napi]
pub async fn restart_lsp_session(
    project_id: String,
    lang: String,
    clear_cache: Option<bool>,
) -> napi::Result<LspSessionStatus> {
    let project_root = resolve_project_root_from_id(&project_id)?;
    let manager = crate::mcp::servers::lsp::manager::ServerManager::instance();
    let status = manager
        .restart_session(
            &lang,
            &project_root,
            Some(&project_id),
            clear_cache.unwrap_or(true),
        )
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e:?}")))?;
    Ok(LspSessionStatus {
        lang: status.lang,
        project_root: status.project_root,
        status: status.status,
        restart_count: status.restart_count,
        last_used_ms: status.last_used_ms as i64,
        error: status.error,
    })
}
