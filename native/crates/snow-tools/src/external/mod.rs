pub mod api;
mod http;
mod stdio;

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures::{stream, StreamExt};

use napi::{Error, Result};
use serde_json::Value;

use snow_storage_core::models::McpServerConfigRecord;
use snow_storage_core::system_settings::McpProjectScopeSettings;

use crate::protocol::RemoteMcpTool;

use crate::contract::{McpTool, PluginDiscoveryFailure};

const DISCOVERY_CONCURRENCY: usize = 4;
const SERVER_NAME_MAX_LEN: usize = 18;
const TOOL_NAME_MAX_LEN: usize = 24;

/// 外部工具发现结果：公开短名用于模型协议，原始名用于精确的插件归属与展示。
#[derive(Clone)]
pub struct DiscoveredExternalTool {
    pub tool: McpTool,
    pub original_name: String,
}

/// 外部 MCP 服务器工具发现的进程内 TTL 缓存。
///
/// 子代理编辑器、项目 MCP 面板、会话上下文收集等场景会频繁请求
/// 外部服务器的工具列表，而每次发现都要 spawn 子进程或建立 HTTP
/// 连接并完成握手，成本很高（慢服务器可达数秒乃至超时）。缓存使
/// 重复请求直接命中，避免反复连接。
///
/// 约定：
/// - 仅缓存**成功**结果；失败不缓存，下次调用自动重试（避免把
///   瞬时故障（网络抖动、进程启动失败）缓存成固定错误）。
/// - 配置写入路径（MCP 服务器新增/修改/删除）只失效**被改动的那台
///   服务器**（见 `invalidate_server_discovery_cache`），不牵连其他
///   服务器的缓存；TTL 作为兜底保证最长 5 分钟内自然刷新（issue #172：
///   外部服务器工具列表极少变化，延长 TTL 减少重复握手；需要立刻看到
///   远端变更时用 MCP 设置页的「刷新工具」force 请求）。服务器与
///   工具的启停是 scope 黑名单，读取时才应用（见
///   `to_project_tool_statuses` / `tool_is_enabled`），与缓存内容无关，
///   因此启停不失效缓存，避免无关服务器被重新连接。
/// - 缓存条目绑定**公开服务器名**：公开名由全部服务器配置共同决定
///   （重名时追加稳定短哈希），命中时校验公开名，避免其他服务器改名
///   后复用带旧前缀的工具列表。
/// - `force` 请求（MCP 设置页手动「刷新工具」）绕过缓存直接实时发现，
///   结果不写回缓存（保留原条目，由 TTL 自然刷新）。
/// 外部服务器工具列表极少变化，TTL 取 5 分钟减少重复握手（issue #172）。
const DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(300);
/// 缓存条目数上限，超过后整体清空（与项目内其他 TTL 缓存一致）。
const DISCOVERY_CACHE_MAX_ENTRIES: usize = 256;

struct CachedDiscovery {
    fetched_at: Instant,
    /// 写入时的公开服务器名（工具全名前缀），命中时校验。
    public_server_name: String,
    tools: Vec<DiscoveredExternalTool>,
}

static DISCOVERY_CACHE: OnceLock<Mutex<HashMap<String, CachedDiscovery>>> = OnceLock::new();

fn discovery_cache() -> &'static Mutex<HashMap<String, CachedDiscovery>> {
    DISCOVERY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn discovery_cache_key(project_id: Option<&str>, config_server_id: &str) -> String {
    format!("{}:{}", project_id.unwrap_or(""), config_server_id)
}

/// 读取一台服务器的新鲜缓存条目；条目缺失、已过期或公开名与当前
/// 配置不一致时返回 None。
fn read_discovery_cache(
    cache_key: &str,
    public_server_name: &str,
) -> Option<Vec<DiscoveredExternalTool>> {
    let guard = discovery_cache().lock().ok()?;
    let entry = guard.get(cache_key)?;
    if entry.fetched_at.elapsed() >= DISCOVERY_CACHE_TTL
        || entry.public_server_name != public_server_name
    {
        return None;
    }

    Some(entry.tools.clone())
}

/// 只读缓存的工具查询（不连接服务器）：命中新鲜条目时返回工具列表，
/// 未命中返回 None —— 调用方据此把该服务器标记为「待发现」，由前端在
/// 后台补发现。保存/启停/删除配置后的列表刷新走这条路径，不会被慢
/// 服务器的 connect + tools/list 阻塞。
pub fn cached_discovery_tools(
    project_id: Option<&str>,
    config_server_id: &str,
    public_server_name: &str,
) -> Option<Vec<McpTool>> {
    read_discovery_cache(
        &discovery_cache_key(project_id, config_server_id),
        public_server_name,
    )
    .map(|tools| tools.into_iter().map(|entry| entry.tool).collect())
}

/// 只失效指定服务器的发现缓存（含各项目 scope 下同 id 的条目），其他
/// 服务器的缓存保持不变。MCP 配置写入（新增/修改/删除服务器）成功后
/// 调用；新建服务器的 id 尚无缓存条目，调用方可直接跳过。
pub fn invalidate_server_discovery_cache(config_server_id: &str) {
    let suffix = format!(":{config_server_id}");
    if let Some(cache) = DISCOVERY_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            guard.retain(|key, _| !key.ends_with(&suffix));
        }
    }
}

/// 只失效某个插件派生出的全部服务器缓存（key 形如 `{project}:plugin:{id}:{server}`）。
/// 插件安装 / 更新 / rescan / 启停 / 卸载后调用，避免最长 5 分钟的旧工具清单。
pub fn invalidate_plugin_discovery_cache(plugin_id: &str) -> Result<()> {
    let needle = format!(":plugin:{plugin_id}:");
    if let Some(cache) = DISCOVERY_CACHE.get() {
        let mut guard = cache.lock().map_err(|error| {
            Error::from_reason(format!("Plugin discovery cache lock failed: {error}"))
        })?;
        guard.retain(|key, _| !key.contains(&needle));
        crate::tool_search_port::invalidate(None)?;
    } else {
        crate::tool_search_port::invalidate(None)?;
    }
    Ok(())
}

/// 插件工具发现失败写入应用日志：请求路径此前只有 stderr，用户无法自查。
pub fn log_discovery_failure(project_id: Option<&str>, source: &str, error: &str) {
    let project_id = project_id.unwrap_or_default().to_string();
    let source = source.to_string();
    let error = error.to_string();
    tokio::task::spawn_blocking(move || {
        let Ok(database_path) = snow_storage_core::bootstrap::ensure_database_file() else {
            return;
        };
        let input = snow_storage_core::app_logs::AppLogInput {
            level: "WARN".to_string(),
            module: "mcp_plugin".to_string(),
            func: "discover_tools".to_string(),
            line: None,
            message: format!("Plugin MCP tool discovery failed: {source}"),
            input: None,
            output: None,
            duration: None,
            context: Some(
                serde_json::json!({ "projectId": project_id, "source": source }).to_string(),
            ),
            error: Some(error),
            source: "main".to_string(),
        };
        let _ = snow_storage_core::app_logs::insert_app_log(&database_path, &input);
    });
}

/// 外部 MCP 服务器的默认超时（毫秒）：覆盖连接、工具发现与单次工具调用。
/// 服务器配置中显式设置了 timeout_ms（>0）时优先使用配置值。
const DEFAULT_SERVER_TIMEOUT_MS: u64 = 120_000;

fn server_timeout_ms(config: &McpServerConfigRecord) -> u64 {
    config
        .timeout_ms
        .filter(|value| *value > 0)
        .map(|value| value as u64)
        .unwrap_or(DEFAULT_SERVER_TIMEOUT_MS)
}

fn tool_timeout_error(tool_full_name: &str, timeout_ms: u64) -> Error {
    Error::from_reason(format!(
        "External MCP tool {tool_full_name} timed out after {timeout_ms}ms"
    ))
}

// Built-in MCP server names, used to exclude external tools with the same name.
// Kept in sync with `tools::BUILTIN_SERVER_IDS`.
const BUILTIN_SERVER_NAMES: &[&str] = crate::contract::BUILTIN_SERVER_IDS;

pub struct ExternalMcpProjectServer {
    pub config_server_id: String,
    pub name: String,
    /// 处理重名冲突后的公开服务器名（工具全名前缀），用于只读缓存查询。
    pub public_name: String,
    pub source: String,
    pub global_enabled: bool,
    pub enabled: bool,
}

pub struct ExternalMcpProjectToolServer {
    pub scope_server_id: String,
    pub project_owned: bool,
}

pub fn project_scope_server_id(config_server_id: &str) -> String {
    format!("external:{config_server_id}")
}

/// 项目自有服务器的 enabled 是项目级开关；子代理显式白名单可豁免，
/// 全局服务器自身禁用不可豁免。发现与执行共用此判定，不修改持久化配置。
fn server_is_enabled(config: &McpServerConfigRecord, project_override: bool) -> bool {
    config.enabled || (project_override && config.source == "project")
}

/// `allowed_names` 为请求白名单时只发现白名单涉及的服务器；`project_override`
/// （子代理显式白名单）跳过项目级服务器/工具开关（含项目自有服务器的 enabled）。
/// `active_plugin_ids` 为会话级插件门控（`@@plugin` 激活集合），`None` 表示不按会话过滤。
/// `defer_plugin_tools` 为 true 时把插件来源的工具单独返回（不进请求 tools，
/// 由 tool_search 按需检索）；另返回插件服务器的发现失败和工具来源身份。
pub async fn discover_tools(
    project_id: Option<&str>,
    scope: Option<&McpProjectScopeSettings>,
    allowed_names: Option<&HashSet<String>>,
    project_override: bool,
    active_plugin_ids: Option<&HashSet<String>>,
    defer_plugin_tools: bool,
    plugins_only: bool,
    cache_only: bool,
) -> Result<(Vec<McpTool>, Vec<McpTool>, Vec<PluginDiscoveryFailure>, HashMap<String, String>, HashSet<String>)> {
    let configs = load_configs_with_plugins(project_id).await?;
    let server_names = public_server_names(&configs);
    let scope = if project_override { None } else { scope };
    let disabled_server_ids = scope
        .map(|settings| settings.disabled_server_ids.clone())
        .unwrap_or_default();
    let disabled_tool_names = scope
        .map(|settings| settings.disabled_tool_names.clone())
        .unwrap_or_default();
    // async 块内使用，避免借用与 stream::iter 的迭代器生命周期冲突。
    let project_id = project_id.map(str::to_string);
    let discoveries = stream::iter(
        configs
            .into_iter()
            .filter_map(|config| {
                let server_name = server_names
                    .get(&config.server_id)
                    .cloned()
                    .unwrap_or_else(|| sanitize_name(&config.name, SERVER_NAME_MAX_LEN, "external"));
                let is_plugin = config.source.starts_with("plugin:");
                if (plugins_only && !is_plugin) || (defer_plugin_tools && !plugins_only && is_plugin) {
                    return None;
                }
                let enabled = server_is_enabled(&config, project_override)
                    && plugin_source_active(&config.source, active_plugin_ids)
                    && (config.source == "project"
                        || !disabled_server_ids
                            .contains(&project_scope_server_id(&config.server_id)));
                let prefix = format!("{server_name}-");
                let requested = allowed_names
                    .is_none_or(|names| names.iter().any(|name| name.starts_with(&prefix)));
                (enabled && requested).then_some((config, server_name))
            })
            .map(|(config, server_name)| {
                let project_id = project_id.clone();
                let source = config.source.clone();
                let identity = config.server_id.clone();
                async move {
                    let discovered = if cache_only {
                        read_discovery_cache(
                            &discovery_cache_key(project_id.as_deref(), &identity),
                            &server_name,
                        )
                        .map(Ok)
                    } else {
                        Some(discover_config_tools(project_id.as_deref(), config, server_name.clone(), false).await)
                    };
                    (source, server_name, identity, discovered)
                }
            }),
    )
    .buffered(DISCOVERY_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    let mut tools = Vec::new();
    let mut deferred_tools = Vec::new();
    let mut plugin_failures = Vec::new();
    let mut plugin_tool_identities = HashMap::new();
    let mut names = HashSet::new();
    let mut pending_names = HashSet::new();
    for (source, server_name, identity, discovered) in discoveries {
        let Some(discovered) = discovered else {
            if let Some(allowed_names) = allowed_names {
                let prefix = format!("{server_name}-");
                pending_names.extend(allowed_names.iter()
                    .filter(|name| name.starts_with(&prefix) && !disabled_tool_names.contains(*name))
                    .cloned());
            }
            continue;
        };
        match discovered {
            Ok(discovered_tools) => {
                for discovered in discovered_tools {
                    let tool = discovered.tool;
                    let full_name = tool.full_name();
                    if disabled_tool_names.contains(&full_name) || !names.insert(full_name.clone()) {
                        continue;
                    }
                    if source.starts_with("plugin:") {
                        plugin_tool_identities.insert(full_name, identity.clone());
                        if defer_plugin_tools {
                            deferred_tools.push(tool);
                            continue;
                        }
                    }
                    tools.push(tool);
                }
            }
            Err(error) => {
                log_discovery_failure(project_id.as_deref(), &source, &error.to_string());
                if let Some(plugin_id) = source.strip_prefix("plugin:") {
                    plugin_failures.push(PluginDiscoveryFailure {
                        plugin_id: plugin_id.to_string(),
                        server: server_name,
                        error: error.to_string(),
                    });
                }
                eprintln!("Failed to discover an external MCP server: {error}");
            }
        }
    }

    Ok((tools, deferred_tools, plugin_failures, plugin_tool_identities, pending_names))
}

/// Effective plugin server identities, obtained from configuration without connecting.
pub async fn available_plugin_servers(
    project_id: Option<&str>,
    scope: Option<&McpProjectScopeSettings>,
) -> Result<HashMap<String, (String, String)>> {
    let configs = load_configs_with_plugins(project_id).await?;
    let names = public_server_names(&configs);
    Ok(configs
        .into_iter()
        .filter_map(|config| {
            let plugin_id = config.source.strip_prefix("plugin:")?;
            if !config.enabled
                || scope.is_some_and(|scope| {
                    !scope.is_server_enabled(&project_scope_server_id(&config.server_id))
                })
            {
                return None;
            }
            let public_name = names.get(&config.server_id)?.clone();
            Some((public_name, (config.server_id.clone(), plugin_id.to_string())))
        })
        .collect())
}

/// Resolve plugin ownership before any connection or process launch.
pub async fn plugin_tool_identity(
    project_id: Option<&str>,
    tool_full_name: &str,
) -> Result<Option<String>> {
    let Some((server_name, _)) = parse_external_tool_name(tool_full_name) else {
        return Ok(None);
    };
    let configs = load_configs_with_plugins(project_id).await?;
    let names = public_server_names(&configs);
    Ok(configs.into_iter().find_map(|config| {
        (config.source.starts_with("plugin:")
            && names.get(&config.server_id).map(String::as_str) == Some(server_name))
            .then_some(config.server_id)
    }))
}

/// 一个工具插件服务器的发现结果（供插件页面与 `@` 面板展示）。
pub struct PluginToolServer {
    pub plugin_id: String,
    pub server_name: String,
    pub public_server_name: String,
    pub tools: Vec<DiscoveredExternalTool>,
    pub error: Option<String>,
}

/// `server_id`（`plugin:<pluginId>:<serverName>`）解析出插件 id 与清单内服务器名。
fn plugin_server_identity(config: &McpServerConfigRecord) -> Option<(String, String)> {
    let plugin_id = config.source.strip_prefix("plugin:")?.to_string();
    let server_name = config.server_id.rsplitn(2, ':').next()?.to_string();
    Some((plugin_id, server_name))
}

/// 发现全部已启用工具插件的服务器与工具清单。
///
/// 与请求路径不同：这里按项目作用域展示（不受会话 `@` 门控），失败按服务器返回
/// `error` 而不是整体失败，插件页面据此展示「工具 n 个」与失败原因。
pub async fn discover_plugin_servers(project_id: Option<&str>) -> Result<Vec<PluginToolServer>> {
    let plugin_configs = load_configs_with_plugins(project_id)
        .await?
        .into_iter()
        .filter(|config| config.source.starts_with("plugin:"))
        .collect::<Vec<_>>();
    let server_names = public_server_names(&plugin_configs);

    let mut servers = Vec::new();
    for config in plugin_configs {
        let Some((plugin_id, server_name)) = plugin_server_identity(&config) else {
            continue;
        };
        let public_server_name = server_names
            .get(&config.server_id)
            .cloned()
            .unwrap_or_else(|| sanitize_name(&config.name, SERVER_NAME_MAX_LEN, "external"));
        let outcome = discover_config_tools(
            project_id,
            config,
            public_server_name.clone(),
            false,
        )
        .await;
        match outcome {
            Ok(tools) => servers.push(PluginToolServer {
                plugin_id,
                server_name,
                public_server_name,
                tools,
                error: None,
            }),
            Err(error) => servers.push(PluginToolServer {
                plugin_id,
                server_name,
                public_server_name,
                tools: Vec::new(),
                error: Some(error.to_string()),
            }),
        }
    }
    Ok(servers)
}

/// `project_id` 为 None 时只返回全局服务器（不含项目专属服务器）。
pub async fn discover_project_servers(project_id: Option<&str>) -> Result<Vec<ExternalMcpProjectServer>> {
    let configs = load_configs(project_id).await?;
    let server_names = public_server_names(&configs);
    Ok(configs
        .into_iter()
        .map(|config| {
            let is_project_server = config.source == "project";
            let public_name = server_names
                .get(&config.server_id)
                .cloned()
                .unwrap_or_else(|| sanitize_name(&config.name, SERVER_NAME_MAX_LEN, "external"));
            ExternalMcpProjectServer {
                config_server_id: config.server_id,
                name: config.name,
                public_name,
                source: if is_project_server {
                    "project".to_string()
                } else {
                    "external".to_string()
                },
                global_enabled: is_project_server || config.enabled,
                enabled: config.enabled,
            }
        })
        .collect())
}

pub async fn discover_server_tools(
    project_id: Option<&str>,
    config_server_id: &str,
    force: bool,
) -> Result<Vec<McpTool>> {
    let configs = load_configs(project_id).await?;
    let server_names = public_server_names(&configs);
    let config = configs
        .into_iter()
        .find(|config| config.server_id == config_server_id)
        .ok_or_else(|| {
            Error::from_reason(format!(
                "External MCP server {config_server_id} is no longer configured"
            ))
        })?;
    let server_name = server_names
        .get(config_server_id)
        .cloned()
        .unwrap_or_else(|| sanitize_name(&config.name, SERVER_NAME_MAX_LEN, "external"));

    discover_config_tools(project_id, config, server_name, force)
        .await
        .map(|tools| tools.into_iter().map(|entry| entry.tool).collect())
}

pub async fn resolve_project_scope_server(
    project_id: Option<&str>,
    tool_full_name: &str,
) -> Result<Option<ExternalMcpProjectToolServer>> {
    let Some((server_name, public_tool_name)) = parse_external_tool_name(tool_full_name) else {
        return Ok(None);
    };
    let configs = load_configs_with_plugins(project_id).await?;
    let server_names = public_server_names(&configs);
    let Some(config) = configs.into_iter().find(|config| {
        server_names.get(&config.server_id).map(String::as_str) == Some(server_name)
    }) else {
        return Ok(None);
    };
    if !config.enabled {
        return Err(Error::from_reason(format!(
            "External MCP server for tool {tool_full_name} is disabled or no longer configured"
        )));
    }

    let project_server = ExternalMcpProjectToolServer {
        scope_server_id: project_scope_server_id(&config.server_id),
        project_owned: config.source == "project",
    };
    let timeout_ms = server_timeout_ms(&config);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let client =
        match tokio::time::timeout_at(deadline, ExternalMcpClient::connect(&config)).await {
            Ok(client) => client?,
            Err(_) => return Err(tool_timeout_error(tool_full_name, timeout_ms)),
        };
    let tools_result = tokio::time::timeout_at(deadline, client.list_all_tools()).await;
    client.close().await;
    let tools = match tools_result {
        Ok(tools) => tools?,
        Err(_) => return Err(tool_timeout_error(tool_full_name, timeout_ms)),
    };
    let tool_names = public_tool_names(&tools);
    let tool_exists = tools
        .iter()
        .any(|tool| tool_names.get(&tool.name).map(String::as_str) == Some(public_tool_name));
    if !tool_exists {
        return Err(Error::from_reason(format!(
            "External MCP tool {tool_full_name} is no longer available"
        )));
    }

    Ok(Some(project_server))
}

/// 调用外部工具：连接、工具列表与调用共用 timeoutMs 截止时间，超时返回错误。
/// `project_override` 由调用方的精确工具白名单授权，仅豁免项目级启停。
pub async fn call_tool(
    project_id: Option<&str>,
    tool_full_name: &str,
    arguments: &Value,
    project_override: bool,
) -> Result<Option<Value>> {
    let Some((server_name, public_tool_name)) = parse_external_tool_name(tool_full_name) else {
        return Ok(None);
    };

    let configs = load_configs_with_plugins(project_id).await?;
    let server_names = public_server_names(&configs);
    let Some(config) = configs.into_iter().find(|config| {
        server_names.get(&config.server_id).map(String::as_str) == Some(server_name)
    }) else {
        return Ok(None);
    };
    if !server_is_enabled(&config, project_override) {
        return Err(Error::from_reason(format!(
            "External MCP server for tool {tool_full_name} is disabled or no longer configured"
        )));
    }

    let timeout_ms = server_timeout_ms(&config);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let client =
        match tokio::time::timeout_at(deadline, ExternalMcpClient::connect(&config)).await {
            Ok(client) => client?,
            Err(_) => return Err(tool_timeout_error(tool_full_name, timeout_ms)),
        };
    let result = tokio::time::timeout_at(
        deadline,
        call_tool_with_client(&client, &public_tool_name, arguments),
    )
    .await;
    client.close().await;

    let result = match result {
        Ok(result) => result,
        Err(_) => return Err(tool_timeout_error(tool_full_name, timeout_ms)),
    };
    match result {
        Ok(result) => Ok(Some(result)),
        // 旧版本回退：Auto 协商降级后的连接可能在调用时被关闭
        // （Transport closed，如 issue #51 的 mysql-mcp-server 场景）。
        // 按 http 的 legacy 回退做法，重建连接（Initialize 握手）
        // 并重试一次；重试失败时保留原始错误（含 Transport closed
        // 诊断信息），避免掩盖根因。
        Err(error) if is_transport_closed(&error) => {
            match tokio::time::timeout_at(
                deadline,
                retry_call_tool_legacy(&config, &public_tool_name, arguments),
            )
            .await
            {
                Ok(retry) => retry.map(Some).or_else(|_| Err(error)),
                Err(_) => Err(tool_timeout_error(tool_full_name, timeout_ms)),
            }
        }
        Err(error) => Err(error),
    }
}

/// 旧版本回退：以 legacy initialize 握手重连并重试一次调用。
async fn retry_call_tool_legacy(
    config: &McpServerConfigRecord,
    public_tool_name: &str,
    arguments: &Value,
) -> Result<Value> {
    let client = ExternalMcpClient::connect_legacy(config).await?;
    let result = call_tool_with_client(&client, public_tool_name, arguments).await;
    client.close().await;
    result
}

/// 在已连接的客户端上解析工具名并调用，返回服务器原始结果。
async fn call_tool_with_client(
    client: &ExternalMcpClient,
    public_tool_name: &str,
    arguments: &Value,
) -> Result<Value> {
    let tools = client.list_all_tools().await?;
    let tool_names = public_tool_names(&tools);
    let remote_tool = tools
        .into_iter()
        .find(|tool| tool_names.get(&tool.name).map(String::as_str) == Some(public_tool_name))
        .ok_or_else(|| {
            Error::from_reason(format!(
                "External MCP tool {public_tool_name} is no longer available"
            ))
        })?;
    client.call_tool(&remote_tool.name, arguments).await
}

/// 判断错误是否为 MCP 传输层关闭（Transport closed）。
/// 传输关闭意味着子进程已退出或管道已断开，重建连接重试有机会恢复；
/// 其他协议/业务错误重试无意义，应直接返回。
fn is_transport_closed(error: &napi::Error) -> bool {
    error.reason.contains("Transport closed")
}

/// 带 TTL 缓存的外部 MCP 服务器工具发现。
///
/// - 命中且未过期、公开名一致：直接返回缓存工具列表（避免重复 spawn
///   子进程 / 建立 HTTP 连接，这是子代理编辑器等场景加载慢的主因）。
/// - miss / 过期 / 公开名变化 / `force`：实时连接发现；成功结果写入
///   缓存，失败不缓存（下次自动重试）。
/// - 配置写入路径只失效被改动的那台服务器
///   （见 `invalidate_server_discovery_cache`），这里不做全量清理。
async fn discover_config_tools(
    project_id: Option<&str>,
    config: McpServerConfigRecord,
    server_name: String,
    force: bool,
) -> Result<Vec<DiscoveredExternalTool>> {
    let cache_key = discovery_cache_key(project_id, &config.server_id);
    let search_generation = crate::tool_search_port::generation();

    if !force {
        if let Some(cached) = read_discovery_cache(&cache_key, &server_name) {
            return Ok(cached);
        }
    }

    let tools = discover_config_tools_inner(config, server_name.clone()).await?;

    if !force {
        if let Ok(mut guard) = discovery_cache().lock() {
            if search_generation == crate::tool_search_port::generation() {
                if guard.len() >= DISCOVERY_CACHE_MAX_ENTRIES {
                    guard.clear();
                }
                guard.insert(
                    cache_key,
                    CachedDiscovery {
                        fetched_at: Instant::now(),
                        public_server_name: server_name,
                        tools: tools.clone(),
                    },
                );
            }
        }
    }

    Ok(tools)
}

/// 无缓存的实时发现：连接服务器、握手、列出工具后关闭连接。
/// 由 `discover_config_tools` 包装缓存。
async fn discover_config_tools_inner(
    config: McpServerConfigRecord,
    server_name: String,
) -> Result<Vec<DiscoveredExternalTool>> {
    let timeout_ms = server_timeout_ms(&config);
    // 连接与工具列表共享同一个截止时间，保证整个获取流程有总预算；
    // 超时后仍显式 close，避免 stdio 子进程 / HTTP 连接残留。
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let server_label = config.name.clone();

    let client = match tokio::time::timeout_at(deadline, ExternalMcpClient::connect(&config)).await
    {
        Ok(client) => client?,
        Err(_) => {
            return Err(Error::from_reason(format!(
                "External MCP server {server_label} timed out after {timeout_ms}ms while connecting"
            )))
        }
    };

    let result = tokio::time::timeout_at(deadline, client.list_all_tools()).await;
    client.close().await;

    let tools = match result {
        Ok(tools) => tools?,
        Err(_) => {
            return Err(Error::from_reason(format!(
            "External MCP server {server_label} timed out after {timeout_ms}ms while listing tools"
        )))
        }
    };

    let tool_names = public_tool_names(&tools);
    Ok(tools
        .into_iter()
        .map(|tool| {
            let original_name = tool.name.clone();
            let tool_name = tool_names
                .get(&tool.name)
                .cloned()
                .unwrap_or_else(|| sanitize_name(&tool.name, TOOL_NAME_MAX_LEN, "tool"));
            DiscoveredExternalTool {
                tool: to_public_tool(&config, &server_name, tool_name, tool),
                original_name,
            }
        })
        .collect())
}

fn to_public_tool(
    config: &McpServerConfigRecord,
    server_name: &str,
    tool_name: String,
    tool: RemoteMcpTool,
) -> McpTool {
    let description = if tool.description.trim().is_empty() {
        format!("External MCP tool provided by {}", config.name)
    } else {
        format!("[External MCP: {}] {}", config.name, tool.description)
    };

    McpTool {
        server_id: server_name.to_string(),
        name: tool_name,
        description,
        input_schema: tool.input_schema,
    }
}

async fn load_configs(project_id: Option<&str>) -> Result<Vec<McpServerConfigRecord>> {
    let project_id = project_id.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let database_path = snow_storage_core::bootstrap::ensure_database_file()?;
        snow_storage::project_mcp_server_configs::list_effective_mcp_server_configs(
            &database_path,
            project_id.as_deref(),
        )
    })
    .await
    .map_err(|error| {
        Error::from_reason(format!(
            "Failed to load external MCP server configs: {error}"
        ))
    })?
}

/// 有效外部配置 + 工具插件派生的服务器配置（发现与执行共用）。
///
/// 插件配置不落 `mcp_server_configs` 表，因此 MCP 面板不会出现插件条目；
/// 启停与项目作用域分别由 `app_plugins.enabled` 与 `project_plugins_scope_*` 决定。
async fn load_configs_with_plugins(
    project_id: Option<&str>,
) -> Result<Vec<McpServerConfigRecord>> {
    let mut configs = load_configs(project_id).await?;
    let project_id = project_id.map(str::to_string);
    let plugin_configs = tokio::task::spawn_blocking(move || {
        let database_path = snow_storage_core::bootstrap::ensure_database_file()?;
        snow_storage::tool_plugin_configs::list_tool_plugin_server_configs(
            &database_path,
            project_id.as_deref(),
        )
    })
    .await
    .map_err(|error| {
        Error::from_reason(format!(
            "Failed to load plugin MCP server configs: {error}"
        ))
    })??;
    configs.extend(plugin_configs);
    Ok(configs)
}

/// 插件来源的会话级门控：未被 `@` 激活的插件不参与发现，避免拉起其服务器进程。
/// `None` 表示非请求路径（诊断 / 描述收集），此时不按会话过滤。
fn plugin_source_active(source: &str, active_plugin_ids: Option<&HashSet<String>>) -> bool {
    match source.strip_prefix("plugin:") {
        None => true,
        Some(plugin_id) => match active_plugin_ids {
            None => true,
            Some(ids) => ids.contains(plugin_id),
        },
    }
}

fn parse_external_tool_name(full_name: &str) -> Option<(&str, &str)> {
    let (server_name, tool_name) = crate::contract::split_tool_full_name(full_name)?;
    if server_name.is_empty() || tool_name.is_empty() || BUILTIN_SERVER_NAMES.contains(&server_name)
    {
        return None;
    }
    Some((server_name, tool_name))
}

fn public_server_names(configs: &[McpServerConfigRecord]) -> HashMap<String, String> {
    let candidates = configs
        .iter()
        .map(|config| {
            (
                config.server_id.clone(),
                sanitize_name(&config.name, SERVER_NAME_MAX_LEN, "external"),
            )
        })
        .collect::<Vec<_>>();
    assign_unique_names(candidates, BUILTIN_SERVER_NAMES)
}

/// 返回全部 MCP 服务器配置的公开名映射（server_id -> public_name），
/// 已处理 sanitize 冲突与内置名保留，与 `discover_tools` 的命名一致。
/// 供 config 服务器静态校验子代理 toolsJson 中的外部工具名前缀
/// （不实际连接服务器，因此只校验服务器归属与启用状态）。
pub fn public_server_name_map(configs: &[McpServerConfigRecord]) -> HashMap<String, String> {
    public_server_names(configs)
}

fn public_tool_names(tools: &[RemoteMcpTool]) -> HashMap<String, String> {
    let candidates = tools
        .iter()
        .map(|tool| {
            (
                tool.name.clone(),
                sanitize_name(&tool.name, TOOL_NAME_MAX_LEN, "tool"),
            )
        })
        .collect::<Vec<_>>();
    assign_unique_names(candidates, &[])
}

fn assign_unique_names(
    candidates: Vec<(String, String)>,
    reserved_names: &[&str],
) -> HashMap<String, String> {
    let mut base_name_counts = HashMap::<String, usize>::new();
    for (_, base_name) in &candidates {
        *base_name_counts.entry(base_name.clone()).or_default() += 1;
    }

    let mut used_names = reserved_names
        .iter()
        .map(|name| (*name).to_string())
        .collect::<HashSet<_>>();
    let mut assigned_names = HashMap::new();
    for (identity, base_name) in candidates {
        let is_conflicting = base_name_counts
            .get(&base_name)
            .copied()
            .unwrap_or_default()
            > 1
            || used_names.contains(&base_name);
        let mut public_name = if is_conflicting {
            format!("{base_name}_{}", short_hash(&identity))
        } else {
            base_name.clone()
        };
        let mut suffix = 2;
        while used_names.contains(&public_name) {
            public_name = format!("{base_name}_{}_{suffix}", short_hash(&identity));
            suffix += 1;
        }
        used_names.insert(public_name.clone());
        assigned_names.insert(identity, public_name);
    }
    assigned_names
}

fn sanitize_name(value: &str, max_len: usize, fallback: &str) -> String {
    let mut result = String::new();
    let mut previous_underscore = false;
    for character in value.chars() {
        let normalized = if character.is_ascii_alphanumeric() {
            character.to_ascii_lowercase()
        } else {
            '_'
        };
        if normalized == '_' && previous_underscore {
            continue;
        }
        result.push(normalized);
        previous_underscore = normalized == '_';
        if result.len() >= max_len {
            break;
        }
    }

    let trimmed = result.trim_matches('_');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn short_hash(value: &str) -> String {
    blake3::hash(value.as_bytes()).to_hex()[..6].to_string()
}

/// Trait abstracting the operations all transport-specific MCP clients must
/// provide. Implemented by both `StdioMcpClient` and `HttpMcpClient`.
pub(super) trait ClientHandle: Send + Sync {
    fn list_all_tools(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<RemoteMcpTool>>> + Send + '_>>;
    fn call_tool<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>>;
    fn close(self: Box<Self>);
}

/// Adapter so `StdioMcpClient` / `HttpMcpClient` (which own a
/// `RunningService`) can be stored behind a single `Box<dyn ClientHandle>`.
macro_rules! impl_client_handle {
    ($ty:ty) => {
        impl ClientHandle for $ty {
            fn list_all_tools(
                &self,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<Vec<RemoteMcpTool>>> + Send + '_>,
            > {
                Box::pin(<$ty>::list_all_tools(self))
            }

            fn call_tool<'a>(
                &'a self,
                name: &'a str,
                arguments: &'a Value,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>>
            {
                Box::pin(<$ty>::call_tool(self, name, arguments))
            }

            fn close(self: Box<Self>) {
                // We need to consume `self` inside an async context. Spawn a
                // detached task so the child process / HTTP connection is
                // gracefully shut down without blocking the caller.
                tokio::spawn(async move {
                    let inner = *self;
                    inner.close().await;
                });
            }
        }
    };
}

impl_client_handle!(stdio::StdioMcpClient);
impl_client_handle!(http::HttpMcpClient);
impl_client_handle!(api::ApiMcpClient);

/// 服务器协商结果记忆：key -> 该服务器不支持 server/discover、只支持
/// legacy initialize 握手（HTTP 的 key 为 URL，stdio 为命令指纹）。
/// 部分旧服务器对探测返回 id 为 null 的 JSON-RPC 错误，rmcp 无法把该
/// 回复路由给等待中的请求，探测只能等到超时（如 Exa，issue #172）；另
/// 一些服务器则静默不响应。探测失败回退 legacy 成功后记录，后续连接
/// 直接走 legacy 握手，省下每次连接的探测等待。仅进程内记忆，应用
/// 重启后重新探测一次。
static LEGACY_HANDSHAKE_SERVERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn legacy_handshake_servers() -> &'static Mutex<HashSet<String>> {
    LEGACY_HANDSHAKE_SERVERS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(super) fn requires_legacy_handshake(key: &str) -> bool {
    legacy_handshake_servers()
        .lock()
        .map(|servers| servers.contains(key))
        .unwrap_or(false)
}

pub(super) fn remember_legacy_handshake(key: &str) {
    if let Ok(mut servers) = legacy_handshake_servers().lock() {
        servers.insert(key.to_string());
    }
}

/// Returns true when an `Auto`-mode negotiation failed in a way that a retry
/// with the legacy `initialize` handshake is worthwhile:
/// - JSON-RPC errors the rmcp SDK could not negotiate around on its own
///   (anything other than -32601 Method Not Found / -32022 Unsupported
///   Protocol Version, which the SDK already handles internally by falling
///   back or retrying versions). Legacy servers such as deepwiki reply
///   -32600 "Unsupported protocol version" here.
/// - A connection closed during the `discover` phase. Legacy servers built
///   with pre-2026 SDKs (e.g. DBX 0.4.51) exit the process on `discover`
///   instead of replying with a JSON-RPC error, so a closed connection is a
///   strong signal that the server only understands the legacy handshake.
/// - A transport failure while sending the `server/discover` probe (the rmcp
///   context mentions `discover`). Session-style servers that only speak
///   the 2024-11-05 protocol (e.g. Chat2DB's embedded Spring MCP server)
///   answer `server/discover` with a non-2xx HTTP status whose body is not a
///   valid JSON-RPC error, so the SDK can only surface it as a transport
///   error (issue #119). That still means "no stateless discovery support",
///   so the legacy handshake is retried. Transport errors raised during the
///   SDK-internal legacy fallback (context "send initialize request" etc.)
///   are excluded: that handshake was already attempted and failed.
pub(super) fn should_retry_with_legacy_handshake(
    error: &rmcp::service::ClientInitializeError,
) -> bool {
    match error {
        rmcp::service::ClientInitializeError::JsonRpcError(error_data) => {
            error_data.code != rmcp::model::ErrorCode::METHOD_NOT_FOUND
                && error_data.code != rmcp::model::ErrorCode::UNSUPPORTED_PROTOCOL_VERSION
        }
        rmcp::service::ClientInitializeError::ConnectionClosed(_) => true,
        rmcp::service::ClientInitializeError::TransportError { context, .. } => {
            context.contains("discover")
        }
        _ => false,
    }
}

/// A transport-agnostic external MCP client. The underlying connection is
/// managed by the rmcp SDK and automatically negotiated using the
/// `ClientLifecycleMode::Auto` strategy, which prefers the 2026-07-28
/// stateless protocol and falls back to the legacy initialize handshake when
/// the remote server does not support `server/discover`.
pub(super) struct ExternalMcpClient {
    inner: Box<dyn ClientHandle>,
}

impl ExternalMcpClient {
    pub(super) async fn connect(config: &McpServerConfigRecord) -> Result<Self> {
        let inner: Box<dyn ClientHandle> = match config.transport_type.as_str() {
            "stdio" | "local" => {
                let client = stdio::StdioMcpClient::connect(config).await?;
                Box::new(client)
            }
            "http" => {
                let client = http::HttpMcpClient::connect(config).await?;
                Box::new(client)
            }
            "api" => {
                let client = api::ApiMcpClient::connect(config).await?;
                Box::new(client)
            }
            transport => {
                return Err(Error::from_reason(format!(
                    "Unsupported external MCP transport: {transport}"
                )))
            }
        };
        Ok(Self { inner })
    }

    /// 旧版本回退：直接以 legacy `initialize` 握手建立连接，跳过
    /// Auto 模式对 2026-07-28 无状态协议的 `server/discover` 探测。
    /// 当 Auto 协商降级后的连接不稳定（如旧 SDK 服务器调用时报
    /// Transport closed）时，用本方法重连可绕过协商探测路径。
    pub(super) async fn connect_legacy(config: &McpServerConfigRecord) -> Result<Self> {
        let inner: Box<dyn ClientHandle> = match config.transport_type.as_str() {
            "stdio" | "local" => {
                let client = stdio::StdioMcpClient::connect_legacy(config).await?;
                Box::new(client)
            }
            "http" => {
                let client = http::HttpMcpClient::connect_legacy(config).await?;
                Box::new(client)
            }
            "api" => {
                let client = api::ApiMcpClient::connect(config).await?;
                Box::new(client)
            }
            transport => {
                return Err(Error::from_reason(format!(
                    "Unsupported external MCP transport: {transport}"
                )))
            }
        };
        Ok(Self { inner })
    }

    pub(super) async fn list_all_tools(&self) -> Result<Vec<RemoteMcpTool>> {
        self.inner.list_all_tools().await
    }

    pub(super) async fn call_tool(&self, name: &str, arguments: &Value) -> Result<Value> {
        self.inner.call_tool(name, arguments).await
    }

    pub(super) async fn close(self) {
        self.inner.close();
    }
}
