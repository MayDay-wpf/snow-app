//! 远程 MCP 工具的中转类型。

use serde_json::Value;

/// A tool discovered from a remote MCP server.
///
/// This is a lightweight intermediate representation between the rmcp SDK's
/// `rmcp::model::Tool` and our internal `McpTool`. It exists so the external
/// discovery layer can work with a simple owned struct instead of the
/// `Cow<'static, str>` / `Arc<JsonObject>` types the SDK uses.
#[derive(Clone, Debug)]
pub struct RemoteMcpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}
