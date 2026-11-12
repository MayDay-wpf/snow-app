//! MCP 工具契约：类型定义、内置服务器 ID 与工具名解析。

use napi_derive::napi;
use serde_json::Value;

/// 每个 MCP 服务实现的 trait，包含工具定义和工具执行。
pub trait McpService: Send + Sync {
    /// 服务唯一标识，如 "filesystem"
    fn id(&self) -> &str;

    /// 返回该服务下所有工具的定义
    fn tools(&self) -> Vec<McpTool>;

    /// 执行指定工具，返回 JSON 结果
    fn execute(&self, tool_name: &str, args: &Value) -> napi::Result<Value>;
}

#[napi(object)]
pub struct McpToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema_json: String,
}

#[napi(object)]
pub struct McpProjectToolStatus {
    pub name: String,
    pub description: String,
    pub input_schema_json: String,
    /// 有效启用态：全局未禁用 且 项目未禁用（与 collect 注册到模型上下文的条件一致）。
    pub enabled: bool,
    /// 全局层是否启用该工具；为 false 时项目层开关无法覆盖，前端应只读展示。
    pub global_enabled: bool,
}

#[napi(object)]
pub struct McpToolStatus {
    pub name: String,
    pub description: String,
    pub input_schema_json: String,
    pub enabled: bool,
}

/// 子代理白名单中当前不可用的工具。
#[napi(object)]
pub struct SubAgentUnavailableTool {
    pub name: String,
    /// reserved | global_disabled | lite_mode | not_ready | superseded |
    /// server_disabled | server_unavailable | not_found
    pub reason: String,
}

/// 插件携带的 MCP 服务器发现失败明细。
#[derive(Clone, Debug)]
pub struct PluginDiscoveryFailure {
    pub plugin_id: String,
    pub server: String,
    pub error: String,
}

#[napi(object)]
pub struct McpProjectServerStatus {
    pub id: String,
    pub name: String,
    pub source: String,
    pub global_enabled: bool,
    pub enabled: bool,
    pub tools: Vec<McpProjectToolStatus>,
    /// 工具尚未从进程内缓存获得（需要后台发现）。保存/启停/删除配置后的
    /// 快速列表用它标记待发现的服务器，由前端后台补发现，避免阻塞保存；
    /// 全量发现模式（`list_mcp_project_servers`）下恒为 false。
    pub tools_pending: bool,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct McpTool {
    pub server_id: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl McpTool {
    pub fn full_name(&self) -> String {
        format!("{}-{}", self.server_id, self.name)
    }
}

/// 所有内置 MCP 服务器 ID（含动态注册的 skills），按长度降序排列，
/// 用于工具名最长前缀匹配。新格式 `{server_id}-{tool_name}` 中，server_id
/// 可能含 `-`（如 `user-interaction`），需通过此列表消除歧义；外部工具的
/// server_name 经 `sanitize_name` 后不含 `-`，可安全用第一个 `-` 分割。
pub const BUILTIN_SERVER_IDS: &[&str] = &[
    "user-interaction",
    "computer-use",
    // Snow App logs are read through config-manage (action=logs).
    "app-control",
    "filesystem",
    "sub-agents",
    "toolSearch",
    "websearch",
    "imagegen",
    "codebase",
    "context",
    "browser",
    "config",
    "skills",
    "bash",
    "todo",
    "grep",
    "terminal",
    "memory",
    "html",
    "decision",
];

/// 精简模式（Lite Mode）禁用的内置服务器 ID。启用精简模式后，这些服务器的
/// 工具整体从模型请求上下文移除（节约 token，适用于上下文窗口较短的模型）；
/// 用户在 MCP 面板手动重新启用任一服务器时，精简模式自动关闭
/// （见 set_mcp_project_server_enabled）。
pub const LITE_MODE_DISABLED_SERVER_IDS: &[&str] =
    &["browser", "app-control", "terminal", "computer-use"];

/// 将工具全名 `{server_id}-{tool_name}` 拆分为 `(server_id, tool_name)`。
/// 先匹配已知内置 server_id 前缀（最长优先），再回退到首个 `-` 分割
/// （适用于外部工具，其 server_name 不含 `-`）。
/// 工具检索服务器与发现工具名。
pub const TOOL_SEARCH_SERVER_ID: &str = "toolSearch";
pub const TOOL_DISCOVER: &str = "discover";

pub fn split_tool_full_name(full_name: &str) -> Option<(&str, &str)> {
    for &server_id in BUILTIN_SERVER_IDS {
        if let Some(rest) = full_name.strip_prefix(server_id) {
            if let Some(tool_name) = rest.strip_prefix('-') {
                if !tool_name.is_empty() {
                    return Some((server_id, tool_name));
                }
            }
        }
    }
    let (server_id, tool_name) = full_name.split_once('-')?;
    if server_id.is_empty() || tool_name.is_empty() {
        return None;
    }
    Some((server_id, tool_name))
}
