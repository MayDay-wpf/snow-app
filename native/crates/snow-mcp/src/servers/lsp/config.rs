//! 配置加载：从 lsp_server_configs 表读取并解析。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::super::remote_workspace::is_ssh_path;
use super::types::ServerConfig;
use crate::storage::services::workspace_directories::get_workspace_directory_path;

/// collect 阶段工具暴露与 description 摘要（一次配置读取 + 一次探测循环）。
#[derive(Default)]
pub struct LspToolExposure {
    pub tools: Vec<String>,
    /// Per-tool applicable languages; never advertise every server on every tool.
    pub tool_summaries: HashMap<String, String>,
}

/// 探测结果 TTL 缓存：`collect_all_mcp_tools` 每轮对话都会执行（工具列表
/// 要发给模型），PATH 扫描有真实 stat 成本（Windows 上 PATHEXT × PATH 目录
/// 每命令可达上百次），短 TTL 避免每轮重复全量扫描；配置热更新后最多 10s
/// 内反映新状态，可接受。
const PROBE_TTL: Duration = Duration::from_secs(10);
static PROBE_CACHE: OnceLock<Mutex<HashMap<String, (bool, Instant)>>> = OnceLock::new();

/// 命令安装探测（带 TTL 缓存）。pub(crate)：collect 阶段
/// （tool_exposure_for_workspace）与工作区查询复用同一缓存，避免每轮请求
/// 重复全量 PATH 扫描。
pub(crate) fn is_command_installed_cached(command: &str) -> bool {
    let cache = PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let now = Instant::now();
    {
        let guard = cache.lock().expect("probe cache poisoned");
        if let Some((installed, at)) = guard.get(command) {
            if now.duration_since(*at) < PROBE_TTL {
                return *installed;
            }
        }
    }
    let installed = super::probe::is_command_installed(command);
    cache
        .lock()
        .expect("probe cache poisoned")
        .insert(command.to_string(), (installed, now));
    installed
}

/// 从表加载有效语言服务器配置（项目配置覆盖全局同 lang，§8.5；
/// spawn_blocking 包裹，不阻塞 Node 主线程）。
pub async fn load_configs(project_id: Option<&str>) -> napi::Result<Vec<ServerConfig>> {
    let project_id = project_id.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let records = crate::storage::list_effective_lsp_server_configs(project_id)?;
        Ok(records
            .into_iter()
            .filter_map(|record| parse_record(record).ok())
            .collect())
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to load LSP server configs: {error}"),
        )
    })?
}

/// Discover without starting servers. Explicit analysis roots never change the
/// project id used to resolve effective configuration or authorization.
pub(crate) async fn tool_exposure_for_workspace(
    project_id: Option<&str>,
    analysis_root: Option<&Path>,
) -> napi::Result<LspToolExposure> {
    let Some(root) = resolve_analysis_workspace_root(project_id, analysis_root).await? else {
        return Ok(LspToolExposure::default());
    };
    let configs = load_configs(project_id).await?;
    let manager = super::manager::ServerManager::instance();
    let mut exposure = LspToolExposure::default();
    let mut summaries: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> =
        Default::default();

    for config in configs
        .iter()
        .filter(|config| config.enabled && !config.file_extensions.is_empty())
    {
        let scan_root = root.clone();
        let scan_lang = config.lang.clone();
        let discovery = tokio::task::spawn_blocking(move || {
            super::detect::discover_lang_roots(&scan_root, &scan_lang)
        })
        .await
        .map_err(|error| Error::from_reason(format!("LSP stack discovery failed: {error}")))?;
        let mut roots = discovery.roots;
        if roots.is_empty()
            && super::detect::markers_for_lang(&config.lang).is_empty()
            && super::server_matches_project(config, &root)
        {
            roots.push(root.clone());
        }
        if roots.is_empty() {
            continue;
        }
        let installed = is_command_installed_cached(&config.command);
        // govulncheck is a separate executable, not a gopls capability.
        let vulncheck_installed = config.lang == "go" && is_command_installed_cached("govulncheck");
        for stack_root in roots {
            let negotiated = if installed {
                manager.tool_availability(config, &stack_root).await
            } else {
                Some(Vec::new())
            };
            let available =
                effective_server_tools(&config.lang, negotiated.as_deref(), vulncheck_installed);
            let goto_kinds = std::iter::once("definition")
                .chain(
                    ["type-definition", "implementation"]
                        .into_iter()
                        .filter(|kind| available.iter().any(|name| name == kind)),
                )
                .collect::<Vec<_>>()
                .join("/");
            for tool in available {
                let full = format!("lsp-{tool}");
                if !exposure.tools.contains(&full) {
                    exposure.tools.push(full.clone());
                }
                let source = if tool == "vulncheck" {
                    "govulncheck"
                } else {
                    config.command.as_str()
                };
                let basis = if tool == "vulncheck" {
                    "separate executable installed"
                } else if negotiated.is_some() {
                    "negotiated capability; readiness checked on use"
                } else {
                    "static cold-start capability; runtime negotiation required"
                };
                let extensions = config
                    .file_extensions
                    .iter()
                    .map(|ext| format!(".{}", ext.trim_start_matches('.')))
                    .collect::<Vec<_>>()
                    .join(", ");
                let operation = if tool == "goto" {
                    format!("; kinds: {goto_kinds}")
                } else {
                    String::new()
                };
                summaries.entry(full).or_default().insert(format!(
                    "{} ({source}; {extensions}; {basis}{operation})",
                    config.lang
                ));
            }
        }
    }
    exposure.tool_summaries = summaries
        .into_iter()
        .map(|(tool, descriptions)| {
            (
                tool,
                format!(
                    "Applicable server configurations: {}",
                    descriptions.into_iter().collect::<Vec<_>>().join("; ")
                ),
            )
        })
        .collect();
    Ok(exposure)
}

/// None means a cold server, not a failed one. A negotiated empty list must
/// remain empty; only the independent Go scanner can be added separately.
fn effective_server_tools(
    lang: &str,
    negotiated: Option<&[String]>,
    vulncheck_installed: bool,
) -> Vec<String> {
    let mut tools = match negotiated {
        Some(tools) => tools.to_vec(),
        None => super::capabilities::supported_tools_for_lang(lang)
            .into_iter()
            .map(str::to_string)
            .collect(),
    };
    tools.retain(|tool| tool != "vulncheck");
    if lang == "go" && vulncheck_installed {
        tools.push("vulncheck".to_string());
    }
    tools.sort();
    tools.dedup();
    tools
}

/// Missing/invalid default roots fail closed. An explicit root is validated
/// separately; it never changes the id used for configuration/authorization.
pub async fn resolve_analysis_workspace_root(
    project_id: Option<&str>,
    explicit_root: Option<&Path>,
) -> napi::Result<Option<PathBuf>> {
    let explicit = explicit_root.map(Path::to_path_buf);
    let project_id = project_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    tokio::task::spawn_blocking(move || {
        if let Some(root) = explicit {
            return validate_analysis_root(&root).map(Some);
        }
        let Some(project_id) = project_id else {
            return Ok(None);
        };
        let Ok(storage) = crate::storage::initialize_app_storage() else {
            return Ok(None);
        };
        let Some(root) =
            get_workspace_directory_path(&PathBuf::from(storage.database_path), &project_id)
                .ok()
                .flatten()
        else {
            return Ok(None);
        };
        Ok(validate_analysis_root(Path::new(&root)).ok())
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to resolve analysis workspace: {error}")))?
}

fn validate_analysis_root(root: &Path) -> napi::Result<PathBuf> {
    if !root.is_absolute()
        || is_ssh_path(&root.to_string_lossy())
        || root.to_string_lossy().contains("://")
    {
        return Err(Error::from_reason(
            "analysisWorkspaceRoot must be an existing absolute local directory",
        ));
    }
    let physical = std::fs::canonicalize(root).map_err(|_| {
        Error::from_reason("analysisWorkspaceRoot does not exist or is inaccessible")
    })?;
    if !physical.is_dir() {
        return Err(Error::from_reason(
            "analysisWorkspaceRoot must be a directory",
        ));
    }
    Ok(physical)
}

/// 按文件扩展名匹配语言配置。
pub fn match_config<'a>(
    configs: &'a [ServerConfig],
    file_path: &Path,
) -> Option<(&'a ServerConfig, &'a str)> {
    let ext = file_path.extension()?.to_str()?.to_ascii_lowercase();
    configs
        .iter()
        .find(|config| {
            config.enabled
                && config
                    .file_extensions
                    .iter()
                    .any(|e| e.trim_start_matches('.').to_ascii_lowercase() == ext)
        })
        .map(|config| (config, config.lang.as_str()))
}

/// 解析表记录为 ServerConfig（JSON 字段解析失败时回退默认值）。
fn parse_record(record: crate::storage::LspServerConfigRecord) -> napi::Result<ServerConfig> {
    let args: Vec<String> = serde_json::from_str(&record.args_json).unwrap_or_default();
    let file_extensions: Vec<String> =
        serde_json::from_str(&record.file_extensions_json).unwrap_or_default();
    let initialization_options: Option<Value> = record
        .initialization_options_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    Ok(ServerConfig {
        lang: record.lang,
        command: record.command,
        args,
        file_extensions,
        install_command: record.install_command,
        initialization_options,
        enabled: record.enabled,
    })
}
