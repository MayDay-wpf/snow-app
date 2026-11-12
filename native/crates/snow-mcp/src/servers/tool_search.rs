//! 工具搜索：按项目与会话保存当前请求的插件工具快照，搜索命中后供下一轮注入。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;
use crate::remote_control::assets::{read_desktop_locale, Locale, DEFAULT_LOCALE};

pub(crate) const SERVER_ID: &str = "toolSearch";
pub(crate) const TOOL_SEARCH: &str = "tool-search";
pub(crate) const TOOL_DISCOVER: &str = "discover";
pub(crate) const NO_ENABLED_PLUGINS: &str = "toolSearch:no_enabled_plugins";
pub(crate) const AUTOMATIC_ONLY: &str =
    "Tool search availability follows enabled tool plugins and cannot be changed manually";
const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 8;
/// 仅用于回收长时间未使用的会话快照，不作为工具授权判断。
const INDEX_TTL: Duration = Duration::from_secs(900);
/// 保留完整的每轮工具快照，限制缓存的会话数。
const MAX_INDEXED_SESSIONS: usize = 512;
// Search availability is derived from effective plugin configuration.

/// 已激活插件的单个服务器发现失败，保留原始错误上下文。
pub use snow_tools::contract::PluginDiscoveryFailure;

/// 工具结果中的自然语言提示；工具名、字段名与 input_schema 保持协议原文。
struct Texts {
    query_required: &'static str,
    invalid_action: &'static str,
    no_active_plugins: &'static str,
    discovery_failed: &'static str,
    no_available_tools: &'static str,
    no_match: &'static str,
    found: &'static str,
    found_with_failures: &'static str,
}

fn texts(locale: Locale) -> Texts {
    match locale {
        Locale::ZhCn => Texts {
            query_required: "搜索时必须提供 query。",
            invalid_action: "action 只能是 list。",
            no_active_plugins: "当前没有启用的工具插件。",
            discovery_failed: "插件工具发现失败，详情见 failures。",
            no_available_tools: "当前没有可用的插件工具。",
            no_match: "没有匹配的工具；server 必须使用返回的精确公开服务器名。",
            found: "命中工具将在下一轮请求中可用。",
            found_with_failures: "命中工具将在下一轮请求中可用，但部分插件工具发现失败，详情见 failures。",
        },
        Locale::ZhTw => Texts {
            query_required: "搜尋時必須提供 query。",
            invalid_action: "action 只能是 list。",
            no_active_plugins: "目前沒有啟用的工具外掛。",
            discovery_failed: "外掛工具探索失敗，詳情見 failures。",
            no_available_tools: "目前沒有可用的外掛工具。",
            no_match: "沒有符合的工具；server 必須使用回傳的精確公開伺服器名稱。",
            found: "符合的工具將在下一輪請求中可用。",
            found_with_failures: "符合的工具將在下一輪請求中可用，但部分外掛工具探索失敗，詳情見 failures。",
        },
        Locale::En => Texts {
            query_required: "query is required for search.",
            invalid_action: "action must be list.",
            no_active_plugins: "No tool plugins are enabled.",
            discovery_failed: "Plugin tool discovery failed; see failures.",
            no_available_tools: "No plugin tools are currently available.",
            no_match: "No matching tool; server must be an exact public server name returned by search.",
            found: "Matched tools will be available in the next request.",
            found_with_failures: "Matched tools will be available in the next request, but some plugin discoveries failed; see failures.",
        },
    }
}

/// 搜索保留工具的完整定义及其真实服务器身份。
#[derive(Clone)]
struct IndexedTool {
    full_name: String,
    server_id: String,
    server_identity: String,
    name: String,
    description: String,
    plugin_metadata: String,
    input_schema: Value,
}

impl IndexedTool {
    fn from_tool(tool: &McpTool, server_identity: &str, plugin_metadata: String) -> Self {
        IndexedTool {
            full_name: tool.full_name(),
            server_id: tool.server_id.clone(),
            server_identity: server_identity.to_string(),
            name: tool.name.clone(),
            description: tool.description.clone(),
            plugin_metadata,
            input_schema: tool.input_schema.clone(),
        }
    }
}

struct SessionIndex {
    tools: Vec<IndexedTool>,
    matched: HashMap<String, String>,
    failures: Vec<PluginDiscoveryFailure>,
    no_active_plugins: bool,
    last_seen: Instant,
}

struct RequestSnapshot {
    session: SessionKey,
    allowed_names: Option<HashSet<String>>,
    exposed: HashMap<String, String>,
    returned: HashSet<String>,
}

type SessionKey = (Option<String>, String);
#[derive(Default)]
struct SearchIndex {
    sessions: HashMap<SessionKey, SessionIndex>,
    requests: HashMap<String, RequestSnapshot>,
}

tokio::task_local! {
    static MODEL_REQUEST_ID: String;
}

pub async fn with_model_request<F: std::future::Future>(id: String, future: F) -> F::Output {
    MODEL_REQUEST_ID.scope(id, future).await
}

static INDEX_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn generation() -> u64 {
    INDEX_GENERATION.load(Ordering::SeqCst)
}

/// 配置变更时作废对应项目的快照；全局插件变更影响所有项目的公开命名。
pub fn invalidate(project_id: Option<&str>) -> napi::Result<()> {
    let mut guard = lock_index()?;
    if let Some(project_id) = project_id {
        guard.sessions.retain(|(scope, _), _| scope.as_deref() != Some(project_id));
        guard.requests.retain(|_, snapshot| snapshot.session.0.as_deref() != Some(project_id));
    } else {
        guard.sessions.clear();
        guard.requests.clear();
    }
    INDEX_GENERATION.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

fn index() -> &'static Mutex<SearchIndex> {
    static INDEX: OnceLock<Mutex<SearchIndex>> = OnceLock::new();
    INDEX.get_or_init(|| Mutex::new(SearchIndex::default()))
}

fn lock_index() -> napi::Result<MutexGuard<'static, SearchIndex>> {
    index().lock().map_err(|error| {
        Error::new(Status::GenericFailure, format!("Tool search index lock failed: {error}"))
    })
}

// Session hits are retained independently of individual request lifetimes.

fn session_key(project_id: Option<&str>, conversation_id: Option<&str>) -> napi::Result<SessionKey> {
    let conversation_id = conversation_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::new(Status::InvalidArg, "Tool search requires a conversation ID".to_string()))?;
    let project_id = project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((project_id, conversation_id.to_string()))
}

/// Refresh request permissions using only configuration and previously discovered matches.
pub(crate) fn prepare_session(
    project_id: Option<&str>,
    conversation_id: Option<&str>,
    servers: &HashMap<String, (String, String)>,
    allowed_names: Option<&HashSet<String>>,
    scope: Option<&crate::storage::services::system_settings::McpProjectScopeSettings>,
    global: Option<&crate::storage::services::system_settings::McpGlobalScopeSettings>,
    search_generation: u64,
) -> napi::Result<Vec<McpTool>> {
    let key = session_key(project_id, conversation_id)?;
    let mut guard = lock_index()?;
    if search_generation != generation() {
        return Err(Error::from_reason("Plugin configuration changed during request collection"));
    }
    let request_id = MODEL_REQUEST_ID.try_with(Clone::clone).map_err(|_| {
        Error::from_reason("PERMISSION_DENIED: model request identity is required for plugin discovery")
    })?;
    let active_sessions = guard.requests.values().map(|request| request.session.clone()).collect::<HashSet<_>>();
    guard.sessions.retain(|key, value| active_sessions.contains(key) || value.last_seen.elapsed() < INDEX_TTL);
    if !guard.sessions.contains_key(&key) && guard.sessions.len() >= MAX_INDEXED_SESSIONS {
        if let Some(oldest) = guard.sessions.iter().filter(|(key, _)| !active_sessions.contains(*key))
            .min_by_key(|(_, value)| value.last_seen).map(|(key, _)| key.clone()) {
            guard.sessions.remove(&oldest);
        }
    }
    let snapshot = guard.sessions.entry(key.clone()).or_insert_with(|| SessionIndex {
        tools: Vec::new(),
        matched: HashMap::new(),
        failures: Vec::new(),
        no_active_plugins: false,
        last_seen: Instant::now(),
    });
    snapshot.last_seen = Instant::now();
    let selected = snapshot.tools.iter().filter(|tool| {
        snapshot.matched.get(&tool.full_name) == Some(&tool.server_identity)
            && servers.get(&tool.server_id).is_some_and(|(identity, _)| identity == &tool.server_identity)
            && allowed_names.is_none_or(|names| names.contains(&tool.full_name))
            && !global.is_some_and(|global| global.is_tool_disabled(&tool.full_name))
            && scope.is_none_or(|scope| scope.is_tool_enabled(&tool.full_name))
    }).collect::<Vec<_>>();
    let exposed = selected.iter().map(|tool| (tool.full_name.clone(), tool.server_identity.clone())).collect();
    let matched = selected.iter().map(|tool| McpTool {
        server_id: tool.server_id.clone(),
        name: tool.name.clone(),
        description: tool.description.clone(),
        input_schema: tool.input_schema.clone(),
    }).collect();
    if guard.requests.contains_key(&request_id) {
        return Err(Error::from_reason("Duplicate model request identity"));
    }
    guard.requests.insert(request_id, RequestSnapshot {
        session: key,
        allowed_names: allowed_names.cloned(),
        exposed,
        returned: HashSet::new(),
    });
    Ok(matched)
}

/// Read the same call-name shapes as the renderer, including id-less Gemini calls.
fn returned_tool_name(call: &Value) -> Option<&str> {
    fn read_name(value: &Value) -> Option<&str> {
        value.get("name").and_then(Value::as_str)
            .map(str::trim).filter(|name| !name.is_empty())
    }
    let name = read_name(call)
        .or_else(|| call.get("function").and_then(read_name))
        .or_else(|| call.get("functionCall").filter(|value| !value.is_null())
            .or_else(|| call.get("function_call")).and_then(read_name))?;
    if name.chars().any(|c| matches!(c, '<' | '>' | '[' | ']' | '#' | '"' | '\'' | '`') || c.is_whitespace()) {
        static NAME: OnceLock<regex::Regex> = OnceLock::new();
        if let Some(found) = NAME.get_or_init(|| regex::Regex::new(r"[A-Za-z0-9_-]+-[A-Za-z0-9_-]+").expect("valid tool name pattern")).find(name) {
            return Some(found.as_str());
        }
    }
    Some(name)
}

/// Commit only calls actually returned by this model response. Failed streams cannot authorize tools.
pub fn finish_model_request(request_id: &str, response: Option<&crate::api::responses::ResponsesApiResult>) -> napi::Result<()> {
    let mut guard = lock_index()?;
    if !guard.requests.contains_key(request_id) { return Ok(()); }
    let Some(response) = response.filter(|response| {
        !matches!(response.status.as_str(), "error" | "failed" | "cancelled" | "canceled" | "incomplete" | "length" | "max_tokens")
            && response.interruption_reason.as_deref() != Some("empty_response")
    }) else {
        guard.requests.remove(request_id);
        return Ok(());
    };
    let calls = match serde_json::from_str::<Vec<Value>>(&response.tool_calls_json) {
        Ok(calls) => calls,
        Err(error) => {
            guard.requests.remove(request_id);
            return Err(Error::from_reason(format!("Invalid model response tool calls: {error}")));
        }
    };
    let snapshot = guard.requests.get_mut(request_id).expect("request checked above");
    snapshot.returned = calls.iter().filter_map(returned_tool_name).filter(|name| {
        *name == "toolSearch-discover" || snapshot.exposed.contains_key(*name)
    }).map(str::to_owned).collect();
    if snapshot.returned.is_empty() {
        guard.requests.remove(request_id);
    }
    Ok(())
}

pub fn release_model_request(request_id: &str) -> napi::Result<()> {
    lock_index()?.requests.remove(request_id);
    Ok(())
}

/// A call must come from the request which received the definition and returned the call.
pub(crate) fn ensure_matched(
    project_id: Option<&str>,
    conversation_id: Option<&str>,
    request_id: Option<&str>,
    name: &str,
    identity: Option<&str>,
) -> napi::Result<()> {
    let key = session_key(project_id, conversation_id)?;
    let guard = lock_index()?;
    let allowed = request_id.and_then(|id| guard.requests.get(id)).is_some_and(|snapshot| {
        snapshot.session == key
            && snapshot.returned.contains(name)
            && identity.is_none_or(|identity| snapshot.exposed.get(name).is_some_and(|value| value == identity))
    });
    if !allowed {
        return Err(Error::from_reason(format!("PERMISSION_DENIED: tool was not exposed and returned by this model request: {name}")));
    }
    Ok(())
}

/// Bind discovery and execution to the persisted host conversation and project.
pub(crate) async fn validate_session(
    project_id: Option<&str>,
    conversation_id: Option<&str>,
    require_existing: bool,
) -> napi::Result<()> {
    let (project_id, conversation_id) = session_key(project_id, conversation_id)?;
    super::super::tools::with_database_path(move |path| {
        use crate::storage::services::chat_conversations::{conversation_exists, get_conversation_directory_id};
        let exists = conversation_exists(&path, &conversation_id)?;
        if (!exists && require_existing)
            || (exists && get_conversation_directory_id(&path, &conversation_id)? != project_id)
        {
            return Err(Error::from_reason("PERMISSION_DENIED: tool search conversation/project mismatch"));
        }
        Ok(())
    }).await
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

fn tokenize(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let push = |token: String, tokens: &mut Vec<String>, seen: &mut HashSet<String>| {
        if !token.is_empty() && seen.insert(token.clone()) {
            tokens.push(token);
        }
    };

    for raw in query.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
        if raw.is_empty() {
            continue;
        }
        push(raw.to_string(), &mut tokens, &mut seen);
        // 中文没有空格分词：按 2-gram 展开，避免整段变成一个 token。
        // 跨语言映射交给模型（描述里要求用英文关键词），宿主不维护词表。
        let chars: Vec<char> = raw.chars().collect();
        if chars.len() > 1 && chars.iter().any(|c| is_cjk(*c)) {
            for window in chars.windows(2) {
                push(window.iter().collect(), &mut tokens, &mut seen);
            }
        }
    }
    tokens
}

fn score(entry: &IndexedTool, tokens: &[String], query: &str) -> i32 {
    let mut score = 0;
    let full_name = entry.full_name.to_lowercase();
    let name = entry.name.to_lowercase();
    let description = entry.description.to_lowercase();
    let plugin_metadata = entry.plugin_metadata.to_lowercase();
    if !query.is_empty() && (full_name.contains(query) || description.contains(query) || plugin_metadata.contains(query)) {
        score += 2;
    }
    for token in tokens {
        if full_name.contains(token) {
            score += 4;
        } else if name.contains(token) {
            score += 3;
        } else if description.contains(token) || plugin_metadata.contains(token) {
            score += 1;
        }
    }
    score
}

fn search(
    snapshot: &mut SessionIndex,
    query: &str,
    server: Option<&str>,
    limit: usize,
) -> Vec<IndexedTool> {
    let query = query.trim().to_lowercase();
    let tokens = tokenize(&query);
    let mut matched = snapshot
        .tools
        .iter()
        .filter(|entry| server.is_none_or(|server| entry.server_id == server))
        .filter_map(|entry| {
            let score = score(entry, &tokens, &query);
            (score > 0).then_some((score, entry))
        })
        .collect::<Vec<_>>();
    matched.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.full_name.cmp(&right.1.full_name))
    });
    let matched: Vec<IndexedTool> = matched
        .into_iter()
        .take(limit)
        .map(|(_, entry)| entry.clone())
        .collect();
    snapshot.matched.extend(matched.iter().map(|entry| {
        (entry.full_name.clone(), entry.server_identity.clone())
    }));
    snapshot.last_seen = Instant::now();
    matched
}

fn available_servers(snapshot: &SessionIndex) -> Vec<String> {
    let mut servers = snapshot
        .tools
        .iter()
        .map(|entry| entry.server_id.clone())
        .collect::<Vec<_>>();
    servers.sort();
    servers.dedup();
    servers
}

/// 列举已安装工具插件的元数据，不发现或启动插件服务器。
async fn list_plugins(project_id: Option<&str>) -> napi::Result<Value> {
    let project_id = project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    super::super::tools::with_database_path(move |database_path| {
        let scope = project_id
            .as_deref()
            .map(|id| {
                crate::storage::services::system_settings::get_plugins_project_scope_settings(
                    &database_path,
                    id,
                )
            })
            .transpose()?;
        let mut plugins = Vec::new();
        for plugin in crate::storage::list_plugins(&database_path)? {
            if plugin.kind != "tool" {
                continue;
            }
            let name: Value = serde_json::from_str(&plugin.name).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to parse name for plugin {}: {error}", plugin.plugin_id),
                )
            })?;
            let description: Value = serde_json::from_str(&plugin.description).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to parse description for plugin {}: {error}", plugin.plugin_id),
                )
            })?;
            let project_enabled = scope
                .as_ref()
                .map(|scope| scope.effective_enabled(&plugin.plugin_id, false));
            let enabled = plugin.enabled && project_enabled.unwrap_or(true);
            plugins.push(json!({
                "pluginId": plugin.plugin_id,
                "name": name,
                "description": description,
                "globalEnabled": plugin.enabled,
                "projectEnabled": project_enabled,
                "enabled": enabled,
            }));
        }
        Ok(json!({
            "success": true,
            "action": "list",
            "plugins": plugins,
        }))
    })
    .await
}

/// Read only names and descriptions of plugins represented by effective servers.
async fn plugin_metadata(
    project_id: Option<&str>,
    servers: &HashMap<String, (String, String)>,
) -> napi::Result<Vec<(String, String, String)>> {
    let ids = servers.values().map(|(_, plugin_id)| plugin_id.as_str()).collect::<HashSet<_>>();
    let directory = list_plugins(project_id).await?;
    let plugins = directory.get("plugins").and_then(Value::as_array).ok_or_else(|| {
        Error::from_reason("Invalid plugin directory result")
    })?;
    let mut metadata = Vec::new();
    for plugin in plugins {
        let id = plugin.get("pluginId").and_then(Value::as_str).ok_or_else(|| {
            Error::from_reason("Plugin directory entry is missing its identity")
        })?;
        if ids.contains(id) {
            let name = plugin.get("name").and_then(|value| value.get("default")).and_then(Value::as_str)
                .ok_or_else(|| Error::from_reason("Plugin default name is missing"))?;
            let description = plugin.get("description").and_then(|value| value.get("default")).and_then(Value::as_str)
                .ok_or_else(|| Error::from_reason("Plugin default description is missing"))?;
            metadata.push((id.to_string(), name.to_string(), description.to_string()));
        }
    }
    Ok(metadata)
}

pub(crate) async fn plugin_summary(
    project_id: Option<&str>,
    servers: &HashMap<String, (String, String)>,
) -> napi::Result<String> {
    Ok(plugin_metadata(project_id, servers).await?.into_iter()
        .map(|(_, name, description)| json!({ "name": name, "description": description }).to_string())
        .collect::<Vec<_>>().join("\n"))
}

/// 工具搜索服务。
pub struct ToolSearchService;

impl ToolSearchService {
    pub fn new() -> Self {
        ToolSearchService
    }

    /// 项目和会话由调用链注入，工具参数不能指定搜索范围。
    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        project_id: Option<&str>,
        conversation_id: Option<&str>,
        request_id: Option<&str>,
    ) -> napi::Result<Value> {
        let text = texts(read_desktop_locale().await.unwrap_or(DEFAULT_LOCALE));
        if tool_name == TOOL_SEARCH {
            return match args.get("action") {
                Some(Value::String(action)) if action == "list" => list_plugins(project_id).await,
                None | Some(Value::String(_)) => Err(Error::from_reason(
                    "Plugin discovery requires toolSearch-discover and its own approval",
                )),
                _ => Err(Error::new(Status::InvalidArg, text.invalid_action.to_string())),
            };
        }
        if tool_name != TOOL_DISCOVER {
            return Err(Error::new(Status::InvalidArg, format!("Unknown tool search operation: {tool_name}")));
        }

        let query = args
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| Error::new(Status::InvalidArg, text.query_required.to_string()))?;
        let server = args
            .get("server")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map(|value| match usize::try_from(value) {
                Ok(value) => value.clamp(1, MAX_LIMIT),
                Err(_) => MAX_LIMIT,
            })
            .unwrap_or(DEFAULT_LIMIT);

        let key = session_key(project_id, conversation_id)?;
        ensure_matched(project_id, conversation_id, request_id, "toolSearch-discover", None)?;
        let search_generation = generation();
        let allowed_names = {
            let guard = lock_index()?;
            let snapshot = request_id.and_then(|id| guard.requests.get(id)).ok_or_else(|| {
                Error::from_reason("PERMISSION_DENIED: tool discovery request is no longer available")
            })?;
            snapshot.allowed_names.clone()
        };
        let scope = super::super::tools::load_project_scope(project_id).await?;
        let global = super::super::tools::load_global_scope().await?;
        let servers = super::super::external::available_plugin_servers(project_id, scope.as_ref()).await?;
        if servers.is_empty() {
            return Err(Error::from_reason(NO_ENABLED_PLUGINS));
        }
        let metadata = plugin_metadata(project_id, &servers).await?.into_iter()
            .map(|(id, name, description)| (id, format!("{name} {description}")))
            .collect::<HashMap<_, _>>();
        let discover_names = allowed_names.as_ref().map(|names| {
            names.iter().filter(|name| {
                !global.as_ref().is_some_and(|global| global.is_tool_disabled(name))
                    && scope.as_ref().is_none_or(|scope| scope.is_tool_enabled(name))
            }).cloned().collect::<HashSet<_>>()
        });
        let (_, discovered, failures, identities, _) = super::super::external::discover_tools(
            project_id, scope.as_ref(), discover_names.as_ref(), false, None, true, true, false,
        ).await?;
        let indexed = discovered.into_iter()
            .filter(|tool| {
                let name = tool.full_name();
                allowed_names.as_ref().is_none_or(|names| names.contains(&name))
                    && !global.as_ref().is_some_and(|global| global.is_tool_disabled(&name))
                    && scope.as_ref().is_none_or(|scope| scope.is_tool_enabled(&name))
            })
            .map(|tool| {
                let name = tool.full_name();
                let identity = identities.get(&name).ok_or_else(|| {
                    Error::from_reason(format!("Missing server identity for plugin tool {name}"))
                })?;
                let (configured_identity, plugin_id) = servers.get(&tool.server_id).ok_or_else(|| {
                    Error::from_reason(format!("Plugin server changed during discovery: {name}"))
                })?;
                if configured_identity != identity {
                    return Err(Error::from_reason(format!("Plugin server identity changed during discovery: {name}")));
                }
                let plugin_text = metadata.get(plugin_id).ok_or_else(|| {
                    Error::from_reason(format!("Missing metadata for plugin {plugin_id}"))
                })?;
                Ok(IndexedTool::from_tool(&tool, identity, plugin_text.clone()))
            })
            .collect::<napi::Result<Vec<_>>>()?;
        let mut guard = lock_index()?;
        if search_generation != generation() {
            return Err(Error::from_reason("Plugin configuration changed during tool discovery"));
        }
        let request = request_id.and_then(|id| guard.requests.get(id)).ok_or_else(|| {
            Error::from_reason("PERMISSION_DENIED: tool discovery request is no longer available")
        })?;
        if request.session != key || !request.returned.contains("toolSearch-discover") || request.allowed_names != allowed_names {
            return Err(Error::from_reason("PERMISSION_DENIED: tool discovery request changed"));
        }
        let mut discovery = SessionIndex {
            tools: indexed,
            matched: HashMap::new(),
            failures,
            no_active_plugins: false,
            last_seen: Instant::now(),
        };
        let matches = search(&mut discovery, query, server, limit);
        let snapshot = guard.sessions.entry(key).or_insert_with(|| SessionIndex {
            tools: Vec::new(),
            matched: HashMap::new(),
            failures: Vec::new(),
            no_active_plugins: false,
            last_seen: Instant::now(),
        });
        for tool in &matches {
            snapshot.tools.retain(|existing| existing.full_name != tool.full_name);
            snapshot.tools.push(tool.clone());
            snapshot.matched.insert(tool.full_name.clone(), tool.server_identity.clone());
        }
        snapshot.last_seen = Instant::now();
        let snapshot = &discovery;
        let (status, hint) = if !matches.is_empty() {
            if snapshot.failures.is_empty() {
                ("found", text.found)
            } else {
                ("partial_failure", text.found_with_failures)
            }
        } else if snapshot.no_active_plugins {
            ("no_active_plugins", text.no_active_plugins)
        } else if !snapshot.failures.is_empty() {
            ("discovery_failed", text.discovery_failed)
        } else if snapshot.tools.is_empty() {
            ("no_available_tools", text.no_available_tools)
        } else {
            ("no_match", text.no_match)
        };
        let tools = matches
            .iter()
            .map(|entry| {
                json!({
                    "name": entry.full_name,
                    "server": entry.server_id,
                    "description": entry.description,
                })
            })
            .collect::<Vec<_>>();
        let failures = snapshot
            .failures
            .iter()
            .map(|failure| {
                json!({
                    "pluginId": failure.plugin_id,
                    "server": failure.server,
                    "error": failure.error,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "success": status != "discovery_failed",
            "status": status,
            "tools": tools,
            "availableServers": available_servers(snapshot),
            "failures": failures,
            "hint": hint,
        }))
    }
}

impl McpService for ToolSearchService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_SEARCH.to_string(),
            description: "List installed tool plugin metadata without starting servers.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list"] }
                },
                "required": ["action"]
            }),
        }, McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_DISCOVER.to_string(),
            description: "Search enabled tool plugins. This may start plugin servers and requires approval. Matched tools become available in the next request. Check failures for discovery errors.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1, "description": "Keywords describing the tool capability." },
                    "server": { "type": "string", "description": "Optional exact public server name from a previous search." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT }
                },
                "required": ["query"]
            }),
        }]
    }

    /// 同步入口拿不到调用链注入的项目上下文，直接引导走异步分发。
    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        Err(Error::new(
            Status::GenericFailure,
            format!(
                "Tool \"{tool_name}\" of server \"{SERVER_ID}\" requires the async call_mcp_tool path (project context)."
            ),
        ))
    }
}
