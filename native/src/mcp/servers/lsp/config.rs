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
    /// Same discovery/health snapshot used by collect's fallback decision.
    pub codelens_covered: bool,
}

/// 探测结果 TTL 缓存：`collect_all_mcp_tools` 每轮对话都会执行（工具列表
/// 要发给模型），PATH 扫描有真实 stat 成本（Windows 上 PATHEXT × PATH 目录
/// 每命令可达上百次），短 TTL 避免每轮重复全量扫描；配置热更新后最多 10s
/// 内反映新状态，可接受。
const PROBE_TTL: Duration = Duration::from_secs(10);
static PROBE_CACHE: OnceLock<Mutex<HashMap<String, (bool, Instant)>>> = OnceLock::new();

/// 命令安装探测（带 TTL 缓存）。pub(crate)：collect 阶段（tool_exposure）
/// 与系统提示词构建（build_system_prompt_section）复用同一缓存，避免每轮
/// 请求重复全量 PATH 扫描。
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

/// Compatibility entry: configuration scope and the default analysis root.
pub async fn tool_exposure(project_id: Option<&str>) -> napi::Result<LspToolExposure> {
    tool_exposure_for_workspace(project_id, None).await
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
    let root_for_scan = root.clone();
    let profile = tokio::task::spawn_blocking(move || {
        super::detect::detect_project_languages_cached(&root_for_scan.to_string_lossy())
    })
    .await
    .map_err(|error| Error::from_reason(format!("LSP discovery failed: {error}")))?;
    let manager = super::manager::ServerManager::instance();
    let mut exposure = LspToolExposure::default();
    let mut summaries: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> =
        Default::default();
    let mut covered_langs = std::collections::HashSet::new();
    let mut covered_extensions = std::collections::HashSet::new();
    let mut coverage_complete = !profile.incomplete;

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
        coverage_complete &= !discovery.incomplete;
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
        let mut all_roots_covered = true;
        for stack_root in roots {
            let negotiated = if installed {
                manager.tool_availability(config, &stack_root).await
            } else {
                Some(Vec::new())
            };
            let available =
                effective_server_tools(&config.lang, negotiated.as_deref(), vulncheck_installed);
            all_roots_covered &= ["goto", "references", "symbols"]
                .iter()
                .all(|name| available.iter().any(|tool| tool == name));
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
        if all_roots_covered {
            covered_langs.insert(config.lang.as_str());
            covered_extensions.extend(
                config
                    .file_extensions
                    .iter()
                    .map(|ext| ext.trim_start_matches('.').to_ascii_lowercase()),
            );
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
    exposure.codelens_covered = coverage_complete
        && detected_coverage_complete(&profile, &covered_langs, &covered_extensions);
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

/// Compatibility for callers without a request-specific analysis root.
pub async fn lsp_covers_all_project_languages(project_id: Option<&str>) -> bool {
    tool_exposure(project_id)
        .await
        .map(|exposure| exposure.codelens_covered)
        .unwrap_or(false)
}

/// Deliberately conservative: an incomplete scan cannot justify hiding a fallback.
fn detected_coverage_complete(
    profile: &super::detect::ProjectLanguageProfile,
    covered_langs: &std::collections::HashSet<&str>,
    covered_extensions: &std::collections::HashSet<String>,
) -> bool {
    !profile.incomplete
        && !profile.langs.is_empty()
        && !profile.extensions.is_empty()
        && profile
            .langs
            .iter()
            .all(|lang| covered_langs.contains(lang.as_str()))
        && profile
            .extensions
            .iter()
            .all(|ext| covered_extensions.contains(ext))
}

/// Missing/invalid default roots fail closed. An explicit root is validated
/// separately; it never changes the id used for configuration/authorization.
pub(crate) async fn resolve_analysis_workspace_root(
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

#[cfg(test)]
mod coverage_tests {
    use super::*;
    use std::collections::HashSet;

    #[tokio::test]
    async fn unknown_root_has_no_cwd_fallback() {
        assert!(resolve_analysis_workspace_root(None, None)
            .await
            .unwrap()
            .is_none());
        assert!(resolve_analysis_workspace_root(
            Some("configuration-project"),
            Some(Path::new("relative/worktree"))
        )
        .await
        .is_err());
    }

    #[test]
    fn negotiated_capabilities_can_exceed_static_estimates() {
        assert_eq!(
            effective_server_tools("lua", Some(&["call-hierarchy".into()]), false),
            vec!["call-hierarchy"]
        );
    }

    #[test]
    fn negotiated_empty_is_not_replaced_by_static_core_tools() {
        assert!(effective_server_tools("rust", Some(&[]), false).is_empty());
        assert!(effective_server_tools("rust", None, false)
            .iter()
            .any(|name| name == "references"));
        assert_eq!(
            effective_server_tools("rust", Some(&["hover".into()]), false),
            vec!["hover"]
        );
    }

    #[test]
    fn govulncheck_installation_is_independent() {
        assert!(!effective_server_tools("go", None, false)
            .iter()
            .any(|name| name == "vulncheck"));
        assert_eq!(
            effective_server_tools("go", Some(&[]), true),
            vec!["vulncheck"]
        );
        assert!(effective_server_tools("rust", Some(&[]), true).is_empty());
    }

    #[test]
    fn invalid_analysis_roots_never_fall_back_to_cwd() {
        for root in [
            "",
            ".",
            "relative/project",
            "ssh://host/project",
            "https://host/project",
        ] {
            assert!(validate_analysis_root(Path::new(root)).is_err(), "{root}");
        }
    }

    #[test]
    fn uncovered_extensions_and_incomplete_scans_keep_fallbacks() {
        let mut profile = super::super::detect::ProjectLanguageProfile {
            langs: vec!["typescript".to_string()],
            extensions: ["ts".to_string()].into_iter().collect(),
            incomplete: false,
        };
        let langs = HashSet::from(["typescript"]);
        let extensions = HashSet::from(["ts".to_string()]);
        assert!(detected_coverage_complete(&profile, &langs, &extensions));
        profile.extensions.insert("py".to_string());
        assert!(!detected_coverage_complete(&profile, &langs, &extensions));
        profile.extensions.remove("py");
        profile.incomplete = true;
        assert!(!detected_coverage_complete(&profile, &langs, &extensions));
    }

    #[test]
    fn empty_or_uncovered_language_profiles_keep_fallbacks() {
        assert!(!detected_coverage_complete(
            &Default::default(),
            &HashSet::new(),
            &HashSet::new()
        ));
        let profile = super::super::detect::ProjectLanguageProfile {
            langs: vec!["rust".to_string()],
            extensions: ["rs".to_string()].into_iter().collect(),
            incomplete: false,
        };
        assert!(!detected_coverage_complete(
            &profile,
            &HashSet::from(["typescript"]),
            &HashSet::from(["rs".to_string()])
        ));
    }
}
