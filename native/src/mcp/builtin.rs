use std::collections::HashMap;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::servers::app_control::AppControlService;
use super::servers::bash::BashService;
use super::servers::browser::BrowserService;
use super::servers::codebase::CodebaseService;
use super::servers::computer_use::ComputerUseService;
use super::servers::config::ConfigService;
use super::servers::decision::DecisionService;
use super::servers::filesystem::FilesystemService;
use super::servers::grep::GrepService;
use super::servers::html_render::HtmlRenderService;
use super::servers::imagegen::ImageGenService;
use super::servers::lsp::LspService;
use super::servers::memory::MemoryService;
use super::servers::sub_agents::SubAgentsService;
use super::servers::terminal::TerminalService;
use super::servers::todo::TodoService;
use super::servers::tool_search::ToolSearchService;
use super::servers::user_interaction::UserInteractionService;
use super::servers::websearch::WebSearchService;
use super::servers::workflow::WorkflowService;
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
        Arc::new(AppControlService::new()),
        Arc::new(ConfigService::new()),
        Arc::new(TerminalService::new()),
        Arc::new(ImageGenService::new()),
        Arc::new(LspService::new()),
        Arc::new(WorkflowService::new()),
        Arc::new(MemoryService::new()),
        Arc::new(ComputerUseService::new()),
        Arc::new(HtmlRenderService::new()),
        Arc::new(DecisionService::new()),
        // 工具搜索：插件工具默认不进请求，由它按需返完整定义（追加在末尾以
        // 保持既有工具顺序稳定，prompt cache 不受影响）。
        Arc::new(ToolSearchService::new()),
        // Snow App logs are read through config-manage (action=logs); no separate MCP server.
        // NOTE: new services must be appended to the END of this list to keep
        // the tool order stable (prompt cache); never insert in the middle.
        //
        // SkillsConfigService 已从内置服务注册中移除（硬删除）：技能配置
        // 统一收敛到 config 服务器的 skills scope（action=set/list/delete，
        // 内部委托 SkillsConfigService 实现），skills-config-* 工具不复存在。
        //
        // computer-use：纯 Rust 实现（xcap 截屏 + enigo 输入模拟），无需
        // Electron 桥接，经默认分发路径 spawn_blocking 执行；默认关闭
        // （system_settings DEFAULT_DISABLED_BUILTIN_SERVERS + collect.rs
        // DEFAULT_DISABLED_SERVER_IDS，与 terminal/lsp 同一白名单机制），
        // 需在 MCP 面板按项目显式启用。键鼠控制工具天然高危，全部走用户
        // 审批，仅 screen-info 列入 READONLY_TOOL_NAMES。
        //
        // html：HTML 渲染器（会话内实时预览），纯 Rust 规范化 + 内容寻址落盘，
        // 经默认分发路径 spawn_blocking 执行；默认关闭（同上白名单机制），
        // 无工作区副作用，render 列入 READONLY_TOOL_NAMES。
        //
        // decision：决策模型判定（decision-evaluate），经 call.rs 异步分支执行；
        // 默认关闭；会把本地图片发往外部 API，不列入只读免审批。
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

/// 只读工具全名（无副作用的查询类内置工具）。UI 权限面板将它们默认
/// 添加为项目级免审批授权；新增只读工具时在此追加即可，无需改前端。
pub const READONLY_TOOL_NAMES: &[&str] = &[
    "filesystem-read",
    "grep-search",
    "grep-find",
    "websearch-websearch-search",
    "websearch-websearch-fetch",
    // 单工具 + action：config 的 list/get/logs 才免审批（见 tool_readonly_actions）。
    "config-manage",
    "imagegen-image-describe",
    "codebase-search",
    "todo-todo-manage",
    // 统一工具整名列入：memory 的写动作由前端按 action 判定只读、删除仍需 confirmed。
    "memory-manage",
    "sub-agents-getResult",
    "sub-agents-wait",
    "computer-use-screen-info",
    "html-render",
    "toolSearch-tool-search",
];

/// 返回仍注册在案的只读工具全名（过滤掉已删除/改名工具的过期条目）。
pub fn list_readonly_tools() -> Vec<String> {
    let available: std::collections::HashSet<String> = get_builtin_tools()
        .into_iter()
        .map(|tool| tool.full_name())
        .collect();
    READONLY_TOOL_NAMES
        .iter()
        .filter(|name| available.contains(**name))
        .map(|name| name.to_string())
        .collect()
}

/// 统一工具按 action 细分的只读动作表：整名列入 READONLY_TOOL_NAMES 的工具
/// 只在这些 action 下真正只读（免审批、可并行、可缓存）；其余动作按写操作处理。
pub fn tool_readonly_actions() -> Value {
    serde_json::json!({
        "todo-todo-manage": ["get"],
        "memory-manage": ["search", "list"],
        "config-manage": ["list", "get", "logs"],
    })
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
