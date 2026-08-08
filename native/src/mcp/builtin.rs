use std::collections::HashMap;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::servers::app_control::AppControlService;
use super::servers::bash::BashService;
use super::servers::browser::BrowserService;
use super::servers::codebase::CodebaseService;
use super::servers::codelens::CodeLensService;
use super::servers::config::ConfigService;
use super::servers::filesystem::FilesystemService;
use super::servers::grep::GrepService;
use super::servers::imagegen::ImageGenService;
use super::servers::sub_agents::SubAgentsService;
use super::servers::terminal::TerminalService;
use super::servers::todo::TodoService;
use super::servers::user_interaction::UserInteractionService;
use super::servers::websearch::WebSearchService;
use super::service::McpService;
use super::tools::McpTool;

/// 按固定注册顺序构造内置 MCP 服务。
///
/// 工具定义会直接出现在模型请求体中；因此绝不能通过 HashMap 迭代来
/// 生成工具数组，否则每个进程的随机哈希种子都可能改变请求体顺序并使
/// prompt cache 失效。新增内置服务必须追加到列表末尾。
fn builtin_services_in_order() -> Vec<Arc<dyn McpService>> {
    vec![
        Arc::new(FilesystemService::new()),
        Arc::new(BashService::new()),
        Arc::new(TodoService::new()),
        Arc::new(GrepService::new()),
        Arc::new(WebSearchService::new()),
        Arc::new(BrowserService::new()),
        Arc::new(UserInteractionService::new()),
        Arc::new(SubAgentsService::new()),
        Arc::new(CodebaseService::new()),
        Arc::new(CodeLensService::new()),
        Arc::new(AppControlService::new()),
        Arc::new(ConfigService::new()),
        Arc::new(TerminalService::new()),
        Arc::new(ImageGenService::new()),
        // NOTE: new services must be appended to the END of this list to keep
        // the tool order stable (prompt cache); never insert in the middle.
        //
        // SkillsConfigService 已从内置服务注册中移除（硬删除）：技能配置
        // 统一收敛到 config 服务器的 skills scope（config-set/list/delete，
        // 内部委托 SkillsConfigService 实现），skills-config-* 工具不复存在。
    ]
}

/// 注册所有内置 MCP 服务，返回 server_id -> service 的映射。
pub fn builtin_services() -> HashMap<String, Arc<dyn McpService>> {
    builtin_services_in_order()
        .into_iter()
        .map(|service| (service.id().to_string(), service))
        .collect()
}

/// 返回所有内置服务及其工具定义，保持与注册列表一致的固定顺序。
pub fn get_builtin_servers_with_tools() -> Vec<(String, Vec<McpTool>)> {
    builtin_services_in_order()
        .into_iter()
        .map(|service| (service.id().to_string(), service.tools()))
        .collect()
}

/// 返回所有内置服务的工具定义，保持与注册列表一致的固定顺序。
pub fn get_builtin_tools() -> Vec<McpTool> {
    get_builtin_servers_with_tools()
        .into_iter()
        .flat_map(|(_, tools)| tools)
        .collect()
}

/// 根据完整工具名（如 `filesystem-read`）执行对应的内置工具。
///
/// 格式: `{server_id}-{tool_name}`
pub fn execute_builtin_tool(full_name: &str, args: &Value) -> napi::Result<Value> {
    // Sanitize: AI may copy "[Tool: server-tool#callId]" from conversation history
    // or leak internal XML tags into the tool name. Extract a valid
    // {server}-{tool} pattern before splitting.
    let sanitized = sanitize_tool_full_name(full_name);
    let Some((server_id, tool_name)) = super::tools::split_tool_full_name(&sanitized) else {
        // List available tools to help the AI self-correct
        let tools = get_builtin_tools();
        let available: Vec<String> = tools.iter().map(|t| t.full_name()).collect();
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Invalid tool name format: \"{}\". Expected format: {{server}}-{{tool}}. Available tools: [{}]",
                full_name,
                available.join(", ")
            ),
        ));
    };

    let services = builtin_services();
    let service = services.get(server_id).ok_or_else(|| {
        let available_servers: Vec<String> = services.keys().cloned().collect();
        Error::new(
            Status::GenericFailure,
            format!(
                "Unknown MCP server: \"{}\". Available servers: [{}]",
                server_id,
                available_servers.join(", ")
            ),
        )
    })?;

    service.execute(tool_name, args)
}

/// Extract a valid `{server_id}-{tool_name}` name from a possibly polluted
/// string. AI may copy the "[Tool: server-tool#callId]" format from conversation
/// history or leak internal XML tags (e.g. `</arg_value>`) into the tool name.
/// If a valid pattern is found, return it; otherwise return the original
/// string so the caller can produce a descriptive error.
///
/// A valid name consists of characters `[A-Za-z0-9_-]` and contains at least
/// one `-` (the server/tool separator). When pollution is present, the longest
/// such fragment is extracted.
pub fn sanitize_tool_full_name(raw: &str) -> String {
    // Fast path: already a clean name containing the `-` separator and no
    // pollution characters.
    if !raw.is_empty()
        && raw.contains('-')
        && !raw.contains(['<', '>', '[', ']', '#', ' ', '\t', '\n', '\r', '"', '\''])
    {
        return raw.to_string();
    }

    // Scan for the longest fragment of [A-Za-z0-9_-]+ that contains at least
    // one `-` (the separator). This recovers tool names buried inside polluted
    // strings such as "[Tool: filesystem-read#call_123]" or
    // "</arg_value>filesystem-read".
    let bytes = raw.as_bytes();
    let mut best_start = 0usize;
    let mut best_len = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        let is_name_char = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
        if is_name_char(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_name_char(bytes[i]) {
                i += 1;
            }
            let len = i - start;
            // Must contain at least one `-` to be a valid {server}-{tool} name.
            if len > best_len && raw[start..i].contains('-') {
                best_start = start;
                best_len = len;
            }
        } else {
            i += 1;
        }
    }

    if best_len > 0 {
        raw[best_start..best_start + best_len].to_string()
    } else {
        raw.to_string()
    }
}
