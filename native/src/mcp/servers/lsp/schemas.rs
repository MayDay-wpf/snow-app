//! Tool contracts describe capabilities without promising complete coverage or referencing hidden tools.
use super::McpTool;
use serde_json::{json, Value};

fn text(description: &str) -> Value {
    json!({"type":"string","description":description})
}
fn position_properties() -> Value {
    json!({
        "filePath":text("Absolute source-file path. Omit only for symbol-only workspace resolution."),
        "line":{"type":"integer","minimum":1,"description":"1-indexed line; supply together with column and filePath when not using symbol."},
        "column":{"type":"integer","minimum":1,"description":"1-indexed UTF-16 column; supply together with line and filePath when not using symbol."},
        "symbol":text("Symbol name to resolve instead of coordinates. Prefer filePath when known; incomplete or ambiguous matches require explicit verified coordinates."),
        "workspaceRoot":text("Optional existing absolute local workspace/worktree root for symbol-only resolution. Does not change project configuration or permissions.")
    })
}
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> McpTool {
    McpTool {
        server_id: super::SERVER_ID.into(),
        name: name.into(),
        description: description.into(),
        input_schema: json!({"type":"object","properties":properties,"required":required}),
    }
}
pub(super) fn tools() -> Vec<McpTool> {
    let addressing = " Address using filePath plus positive line/column, filePath plus symbol, or symbol plus optional workspaceRoot. Inspect partial, truncated and ambiguity metadata; returned ranges are not always identifier selection ranges. Local workspaces only.";
    let mut tools = vec![
        tool("diagnostics", "Diagnose one source file or a batch of up to 30 files using the configured language servers. Use after changes to supported source files; language-server diagnostics do not replace builds or tests. Supply either filePath OR filePaths, never both non-empty. Invalid batches and more than 30 entries are rejected, not clipped. Duplicate physical paths run once, preserving first-occurrence order. Batch files run with bounded concurrency; a per-file failure does not cancel other files. Inspect per-file status/warnings and batch summary: complete means the query completed, not that code has no errors. Local absolute file paths only.",json!({
            "filePath":{"type":"string","minLength":1,"description":"Absolute path for a single file. Omit this field when using filePaths."},
            "filePaths":{"type":"array","minItems":1,"maxItems":30,"items":{"type":"string","minLength":1},"description":"1..30 absolute source-file paths in one batch. Include every desired file here; omit filePath. Different configured languages are supported; per-file failures remain visible."}
        }),&[]),
        tool("hover","Inspect the type, signature and documentation of a symbol. Prefer this when only semantic type information is needed, rather than reading an entire implementation. Empty output is not proof that the symbol does not exist.",position_properties(),&[]),
        tool("goto","Navigate to a symbol's definition, type definition or implementation using kind. Prefer semantic navigation for supported code instead of textual name matches. Results are limited to what the server can resolve; unsupported kinds fail explicitly.",position_properties(),&[]),
        tool("references","Find references resolved by the language server. Before modifying/removing a shared symbol or public signature, inspect supported-language references to assess impact. Dynamic/runtime uses may not be discoverable. The result includes count/total/truncated; a clipped list is not exhaustive.",position_properties(),&[]),
        tool("symbols","Read a file's semantic symbol outline, including nested declarations, kinds, ranges and available documentation/detail. Use to understand structure; do not treat a declaration range start as a verified identifier position.",json!({"filePath":text("Absolute source-file path.")}),&["filePath"]),
        tool("rename","Preview or apply a semantic symbol rename. First call with dryRun=true (default), inspect affected files/edits, and obtain authorization. Applying requires dryRun=false and the returned previewId, valid for 5 minutes and one use. The server applies only the frozen preview; changed files/configuration/target or expired previews require a new preview. Unsupported file operations cannot be applied. Multi-file I/O failures can partially apply: inspect appliedFiles and failedFile; do not assume rollback.",position_properties(),&["newName"]),
        tool("call-hierarchy","Inspect statically resolved callers and callees of a function or method. Prefer this for call-impact questions. This is not a runtime trace or a guarantee of a complete graph; dynamic dispatch and unsupported targets may be absent.",position_properties(),&[]),
        tool("type-hierarchy","Inspect parent types and child types/implementations supported by the language server. Use when assessing changes to a type hierarchy. Unsupported language-server capabilities fail explicitly; do not infer absence of implementations from a failed query.",position_properties(),&[]),
        tool("workspace-symbols","Search symbols by name across the selected workspace and its detected language roots. Matching behavior is provided by each server. Returns up to 50 display items, with total and partial/truncated/warnings metadata. Use for symbol discovery; no results from failed or incomplete coverage do not prove absence. Local workspaces only.",json!({"query":text("Non-empty symbol name or search fragment."),"workspaceRoot":text("Optional existing absolute local workspace/worktree root; defaults to the request project.")}),&["query"]),
        tool("workspace-diagnostics","Query workspace diagnostics from capable language servers, grouped by file. Use after broad changes when wider coverage is needed. Unsupported languages, incomplete root scans and truncation are reported, not silently treated as clean. This is not a full build/test replacement. For a known set of changed files, use the available file-diagnostics operation instead. Local workspaces only.",json!({"maxFiles":{"type":"integer","minimum":1,"maximum":200,"description":"Maximum displayed files (default 100, max 200), each limited to 200 diagnostics."},"workspaceRoot":text("Optional existing absolute local workspace/worktree root; defaults to the request project.")}),&[]),
        tool("vulncheck","Scan Go module dependencies for known vulnerabilities with the separately installed govulncheck executable. Use after relevant dependency changes when available. This is not an LSP protocol request or proof that all security issues are absent. Missing scanner or module is an explicit error; do not install tools without authorization.",json!({"dir":text("Optional Go module directory; defaults to the project root."),"pattern":text("Optional package pattern, default ./...")}),&[]),
    ];
    for item in &mut tools {
        if item.input_schema["properties"].get("symbol").is_some() {
            item.description.push_str(addressing);
        }
        match item.name.as_str() {
            "goto" => {
                item.input_schema["properties"]["kind"] = json!({"type":"string","enum":["definition","type-definition","implementation"],"description":"Navigation kind (default definition)."});
            }
            "references" => {
                item.input_schema["properties"]["includeDeclaration"] = json!({"type":"boolean","description":"Include the declaration itself (default true)."});
            }
            "rename" => {
                item.input_schema["properties"]["newName"] = text("The requested new symbol name.");
                item.input_schema["properties"]["dryRun"] = json!({"type":"boolean","default":true,"description":"Preview only by default; false requires a valid previewId and authorization."});
                item.input_schema["properties"]["previewId"]=text("One-use identifier returned by an unchanged, unexpired dryRun preview. Required for dryRun=false; never invent it.");
            }
            _ => {}
        }
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_contract_has_explicit_batch_limit() {
        let tools = tools();
        let t = tools.iter().find(|t| t.name == "diagnostics").unwrap();
        assert_eq!(t.input_schema["properties"]["filePaths"]["maxItems"], 30);
        assert!(t.description.contains("never both"));
    }
    #[test]
    fn rename_contract_exposes_preview_requirement() {
        let tools = tools();
        let t = tools.iter().find(|t| t.name == "rename").unwrap();
        assert!(t.input_schema["properties"].get("previewId").is_some());
        assert!(!t.description.contains("lsp-references"));
    }
}
