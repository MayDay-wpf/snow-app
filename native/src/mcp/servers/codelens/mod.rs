//! CodeLens MCP service.
//!
//! Provides code intelligence tools powered by:
//! - **oxc** for deep semantic analysis of TypeScript/JavaScript (scope resolution,
//!   unresolved reference detection, type-level symbol flags)
//! - **tree-sitter** for syntax-level analysis of 18+ other languages
//!   (Python, Rust, Go, C/C++, Java, C#, Ruby, PHP, CSS, HTML, JSON, YAML, Bash,
//!   SQL, Lua, Dockerfile, Make)
//!
//! All tools operate inside `tokio::task::spawn_blocking` so the Node.js event
//! loop is never blocked.
//!
//! Tools:
//! - `codelens-find_definition`: Find the definition of a symbol at a position
//! - `codelens-find_references`: Find all references to a symbol at a position
//! - `codelens-file_outline`: Get the symbol outline of a file
//!
//! LSP 优先（2026-08-15）：当项目启用了匹配文件语言的 LSP 服务器且外部
//! 命令可用时，call.rs 会先把这些工具转发给 `lsp-` 域执行（语义分析更准），
//! 结果归一化为 codelens 输出形状（附加 `"engine": "lsp"`）；LSP 不可用或
//! 失败时回退到本服务的静态分析。

mod analyzer;
mod symbol_index;
mod tree_sitter_analyzer;
mod types;

use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::remote_workspace::{
    execute_remote_workspace_command, RemoteWorkspaceCallback,
};

const SERVER_ID: &str = "codelens";

/// Maximum source file size we will analyze (512 KB).
const MAX_FILE_SIZE: usize = 512 * 1024;
const REMOTE_SCOPE_LIMITATION: &str =
    "Remote SSH CodeLens currently analyzes the requested file only; project-wide indexing is unavailable.";

/// All file extensions CodeLens can handle (oxc + tree-sitter combined).
const SUPPORTED_EXTENSIONS: &[&str] = &[
    // oxc (JS/TS family)
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", // tree-sitter languages
    "py", "pyw", "pyi", "rs", "go", "c", "h", "java", "cs", "rb", "php", "phtml", "css", "scss",
    "sass", "less", "html", "htm", "json", "json5", "jsonc", "yaml", "yml", "sh", "bash", "zsh",
    "fish", "ps1", "psm1", "bat", "cmd", "lua",
];

pub struct CodeLensService;

impl CodeLensService {
    pub fn new() -> Self {
        CodeLensService
    }
}

impl McpService for CodeLensService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "find_definition".to_string(),
                description: "Find the definition of a symbol at a given line and column in a source file. Supports TypeScript, JavaScript, Python, Rust, Go, C, C++, Java, C#, Ruby, PHP, Lua, and more. Returns the symbol name, kind, and location of its declaration. When the project has an enabled & available LSP server for the file's language, execution runs through the LSP server (semantic, more accurate) and the result keeps this shape with an extra \"engine\": \"lsp\" field (plus language / count / full definitions list); otherwise it falls back to the built-in tree-sitter/oxc static analysis. Kept available as the fallback for languages that no enabled LSP server covers (mixed-stack projects).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path to the source file."
                        },
                        "line": {
                            "type": "number",
                            "description": "The 1-indexed line number of the position to find the definition for."
                        },
                        "column": {
                            "type": "number",
                            "description": "The 1-indexed column number (character offset within the line) of the position."
                        }
                    },
                    "required": ["filePath", "line", "column"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "find_references".to_string(),
                description: "Find all references to a symbol at a given line and column in a source file. Supports TypeScript, JavaScript, Python, Rust, Go, C, C++, Java, C#, Ruby, PHP, Lua, and more. Returns the symbol name, its definition location, and all usage sites within the same file. When the project has an enabled & available LSP server for the file's language, execution runs through the LSP server (semantic, more accurate, cross-file with code context per reference) and the result keeps this shape with an extra \"engine\": \"lsp\" field (plus language); otherwise it falls back to the built-in tree-sitter/oxc static analysis. Kept available as the fallback for languages that no enabled LSP server covers (mixed-stack projects).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path to the source file."
                        },
                        "line": {
                            "type": "number",
                            "description": "The 1-indexed line number of the position."
                        },
                        "column": {
                            "type": "number",
                            "description": "The 1-indexed column number of the position."
                        }
                    },
                    "required": ["filePath", "line", "column"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "file_outline".to_string(),
                description: "Get the symbol outline of a source file. Supports TypeScript, JavaScript, Python, Rust, Go, C, C++, Java, C#, Ruby, PHP, Lua, and more. Returns a flat list of top-level symbols (functions, classes, methods, variables, interfaces, types, enums) with their names, kinds, and locations. Useful for quickly understanding the structure of a file. When the project has an enabled & available LSP server for the file's language, execution runs through the LSP server (semantic — includes nested children flattened parent-first, plus detail) and the result keeps this shape with an extra \"engine\": \"lsp\" field (plus language); otherwise it falls back to the built-in tree-sitter/oxc static analysis. Kept available as the fallback for languages that no enabled LSP server covers (mixed-stack projects).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path to the source file."
                        }
                    },
                    "required": ["filePath"]
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "find_definition" | "find_references" | "file_outline" => Err(Error::new(
                Status::GenericFailure,
                "CodeLens tools must be executed through the asynchronous executor".to_string(),
            )),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{}\" for MCP server \"codelens\". Available tools: [codelens-find_definition, codelens-find_references, codelens-file_outline]",
                    tool_name
                ),
            )),
        }
    }
}

/// Determine whether a file should be analyzed by oxc (JS/TS) or tree-sitter.
fn is_js_ts(file_path: &str) -> bool {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts"
    )
}

impl CodeLensService {
    /// Execute the find_definition tool asynchronously.
    ///
    /// If `project_id` is provided, the search is performed across the entire
    /// project: first the symbol at the cursor position is resolved in the
    /// current file, then the definition is searched across all source files
    /// in the project via `SymbolIndex`. When `project_id` is not available,
    /// the search falls back to single-file mode.
    pub async fn execute_find_definition(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        let file_path = require_string_arg(args, "filePath")?;
        let line = require_u32_arg(args, "line")?;
        let column = require_u32_arg(args, "column")?;
        let project_id = project_id.map(str::to_string);

        tokio::task::spawn_blocking(move || {
            let (path_str, source_text) = read_source_file(&file_path)?;
            let project_root = match project_id.as_deref() {
                Some(project_id) => resolve_project_root(project_id)?,
                None => None,
            };
            Ok(analyze_definition_from_source(
                &path_str,
                &source_text,
                line,
                column,
                project_root.as_deref(),
            ))
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Find definition task failed: {error}"),
            )
        })?
    }

    /// Execute the find_references tool asynchronously.
    ///
    /// If `project_id` is provided, references are searched across all source
    /// files in the project. When `project_id` is not available, the search
    /// is limited to the single file.
    pub async fn execute_find_references(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        let file_path = require_string_arg(args, "filePath")?;
        let line = require_u32_arg(args, "line")?;
        let column = require_u32_arg(args, "column")?;
        let project_id = project_id.map(str::to_string);

        tokio::task::spawn_blocking(move || {
            let (path_str, source_text) = read_source_file(&file_path)?;
            let project_root = match project_id.as_deref() {
                Some(project_id) => resolve_project_root(project_id)?,
                None => None,
            };
            Ok(analyze_references_from_source(
                &path_str,
                &source_text,
                line,
                column,
                project_root.as_deref(),
            ))
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Find references task failed: {error}"),
            )
        })?
    }

    /// Execute the file_outline tool asynchronously.
    pub async fn execute_file_outline(&self, args: &Value) -> napi::Result<Value> {
        let file_path = require_string_arg(args, "filePath")?;

        tokio::task::spawn_blocking(move || {
            let (path_str, source_text) = read_source_file(&file_path)?;
            Ok(analyze_outline_from_source(&path_str, &source_text))
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("File outline task failed: {error}"),
            )
        })?
    }

    /// Read source through Electron's cancellable SSH bridge, then perform the
    /// CPU-bound analysis on Tokio's blocking pool. Definition/reference
    /// searches intentionally remain file-scoped until a bounded remote index
    /// protocol is available.
    pub async fn execute_remote(
        &self,
        tool_name: &str,
        args: &Value,
        on_remote_workspace_command: &RemoteWorkspaceCallback,
        cancel_token: Option<&CancellationToken>,
    ) -> napi::Result<Value> {
        if !matches!(
            tool_name,
            "find_definition" | "find_references" | "file_outline"
        ) {
            return Err(unknown_tool_error(tool_name));
        }

        let requested_path = require_string_arg(args, "filePath")?;
        let position = match tool_name {
            "find_definition" | "find_references" => Some((
                require_u32_arg(args, "line")?,
                require_u32_arg(args, "column")?,
            )),
            "file_outline" => None,
            _ => unreachable!("tool name validated above"),
        };

        let response = execute_remote_workspace_command(
            on_remote_workspace_command,
            "codelens-read-source",
            args,
            cancel_token,
        )
        .await?;
        let (path_str, source_text) = parse_remote_source_response(response, &requested_path)?;
        let adds_scope_metadata = matches!(tool_name, "find_definition" | "find_references");
        let tool_name = tool_name.to_string();

        let mut result = tokio::task::spawn_blocking(move || match tool_name.as_str() {
            "find_definition" => {
                let (line, column) = position.expect("position validated above");
                analyze_definition_from_source(
                    &path_str,
                    &source_text,
                    line,
                    column,
                    None,
                )
            }
            "find_references" => {
                let (line, column) = position.expect("position validated above");
                analyze_references_from_source(
                    &path_str,
                    &source_text,
                    line,
                    column,
                    None,
                )
            }
            "file_outline" => analyze_outline_from_source(&path_str, &source_text),
            _ => unreachable!("tool name validated above"),
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Remote CodeLens analysis task failed: {error}"),
            )
        })?;

        if adds_scope_metadata {
            add_remote_scope_metadata(&mut result);
        }
        Ok(result)
    }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

fn analyze_definition_from_source(
    path_str: &str,
    source_text: &str,
    line: u32,
    column: u32,
    project_root: Option<&Path>,
) -> Value {
    let found = if is_js_ts(path_str) {
        analyzer::find_symbol_at_position(path_str, source_text, line, column)
    } else {
        tree_sitter_analyzer::find_symbol_at_position(path_str, source_text, line, column)
    };

    let symbol_name = match &found {
        Some((name, _)) => name.clone(),
        None => {
            return json!({
                "found": false,
                "message": "No symbol found at the given position. The position may be on whitespace, a string literal, or a keyword."
            });
        }
    };

    if let Some(project_root) = project_root {
        let mut index = symbol_index::SymbolIndex::new();
        index.index_project(project_root);
        if let Some(symbol) = index.find_definition_across_project(Some(project_root), &symbol_name) {
            return json!({
                "found": true,
                "name": symbol.name,
                "kind": symbol.kind,
                "location": {
                    "filePath": symbol.location.file_path,
                    "line": symbol.location.line,
                    "column": symbol.location.column,
                    "endLine": symbol.location.end_line,
                    "endColumn": symbol.location.end_column,
                },
                "containerName": symbol.container_name,
                "isExported": symbol.is_exported,
                "searchScope": "project"
            });
        }
    }

    let (name, symbol) = found.expect("symbol presence checked above");
    json!({
        "found": true,
        "name": name,
        "kind": symbol.kind,
        "location": {
            "filePath": symbol.location.file_path,
            "line": symbol.location.line,
            "column": symbol.location.column,
            "endLine": symbol.location.end_line,
            "endColumn": symbol.location.end_column,
        },
        "containerName": symbol.container_name,
        "isExported": symbol.is_exported,
        "searchScope": "file"
    })
}

fn analyze_references_from_source(
    path_str: &str,
    source_text: &str,
    line: u32,
    column: u32,
    project_root: Option<&Path>,
) -> Value {
    let found = if is_js_ts(path_str) {
        analyzer::find_references_at_position(path_str, source_text, line, column)
    } else {
        tree_sitter_analyzer::find_references_at_position(path_str, source_text, line, column)
    };

    let (name, local_definition, local_references) = match found {
        Some(found) => found,
        None => {
            return json!({
                "found": false,
                "message": "No symbol found at the given position. The position may be on whitespace, a string literal, or a keyword."
            });
        }
    };

    if let Some(project_root) = project_root {
        let mut index = symbol_index::SymbolIndex::new();
        index.index_project(project_root);
        let references = index.find_references_across_project(Some(project_root), &name);
        let definition = index.find_definition_across_project(Some(project_root), &name).map(|symbol| {
            json!({
                "filePath": symbol.location.file_path,
                "line": symbol.location.line,
                "column": symbol.location.column,
                "endLine": symbol.location.end_line,
                "endColumn": symbol.location.end_column,
            })
        });
        let references_json: Vec<Value> = references
            .iter()
            .map(|reference| {
                json!({
                    "filePath": reference.location.file_path,
                    "line": reference.location.line,
                    "column": reference.location.column,
                    "endLine": reference.location.end_line,
                    "endColumn": reference.location.end_column,
                    "access": reference.access,
                })
            })
            .collect();

        return json!({
            "found": true,
            "name": name,
            "definition": definition,
            "references": references_json,
            "totalReferences": references.len(),
            "searchScope": "project"
        });
    }

    let definition = local_definition.map(|location| {
        json!({
            "filePath": location.file_path,
            "line": location.line,
            "column": location.column,
            "endLine": location.end_line,
            "endColumn": location.end_column,
        })
    });
    let references_json: Vec<Value> = local_references
        .iter()
        .map(|reference| {
            json!({
                "filePath": reference.location.file_path,
                "line": reference.location.line,
                "column": reference.location.column,
                "endLine": reference.location.end_line,
                "endColumn": reference.location.end_column,
                "access": reference.access,
            })
        })
        .collect();

    json!({
        "found": true,
        "name": name,
        "definition": definition,
        "references": references_json,
        "totalReferences": local_references.len(),
        "searchScope": "file"
    })
}

fn analyze_outline_from_source(path_str: &str, source_text: &str) -> Value {
    let outline = if is_js_ts(path_str) {
        analyzer::build_file_outline(path_str, source_text)
    } else {
        tree_sitter_analyzer::build_file_outline(path_str, source_text)
    };
    let entries: Vec<Value> = outline
        .iter()
        .map(|entry| {
            json!({
                "name": entry.name,
                "kind": entry.kind,
                "line": entry.line,
                "column": entry.column,
                "endLine": entry.end_line,
                "endColumn": entry.end_column,
                "containerName": entry.container_name,
                "isExported": entry.is_exported,
            })
        })
        .collect();

    json!({
        "filePath": path_str,
        "outline": entries,
        "totalSymbols": entries.len(),
    })
}

fn parse_remote_source_response(
    response: Value,
    requested_path: &str,
) -> napi::Result<(String, String)> {
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        let message = response
            .get("error")
            .map(remote_error_message)
            .unwrap_or_else(|| "Unknown remote SSH error".to_string());
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to read remote CodeLens source: {message}"),
        ));
    }

    let file_path = response
        .get("filePath")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "Remote CodeLens source response is missing filePath".to_string(),
            )
        })?;
    if file_path != requested_path {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Remote CodeLens source path mismatch: requested {requested_path}, received {file_path}"
            ),
        ));
    }
    validate_supported_extension(file_path)?;

    let source_text = response
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "Remote CodeLens source response is missing raw text content".to_string(),
            )
        })?;
    let reported_bytes = response
        .get("bytes")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "Remote CodeLens source response is missing byte length".to_string(),
            )
        })?;
    let actual_bytes = source_text.len() as u64;
    if reported_bytes > MAX_FILE_SIZE as u64 || actual_bytes > MAX_FILE_SIZE as u64 {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Remote file is too large to analyze ({} bytes, max {} bytes): {file_path}",
                reported_bytes.max(actual_bytes),
                MAX_FILE_SIZE
            ),
        ));
    }
    if reported_bytes != actual_bytes {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Remote CodeLens source byte length mismatch: reported {reported_bytes}, decoded {actual_bytes}"
            ),
        ));
    }

    Ok((file_path.to_string(), source_text.to_string()))
}

fn remote_error_message(error: &Value) -> String {
    error
        .as_str()
        .or_else(|| error.get("message").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string())
}

fn add_remote_scope_metadata(result: &mut Value) {
    if let Some(object) = result.as_object_mut() {
        object.insert("searchScope".to_string(), Value::String("file".to_string()));
        object.insert(
            "scopeLimitation".to_string(),
            Value::String(REMOTE_SCOPE_LIMITATION.to_string()),
        );
    }
}

fn unknown_tool_error(tool_name: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "Unknown codelens tool: \"{tool_name}\". Available tools: [find_definition, find_references, file_outline]"
        ),
    )
}

fn require_string_arg(args: &Value, key: &str) -> napi::Result<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{key} is required and must be a non-empty string"),
            )
        })
}

fn require_u32_arg(args: &Value, key: &str) -> napi::Result<u32> {
    args.get(key)
        .and_then(Value::as_u64)
        .filter(|value| (1..=u32::MAX as u64).contains(value))
        .map(|value| value as u32)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{key} is required and must be a positive 32-bit integer"),
            )
        })
}

fn validate_supported_extension(file_path: &str) -> napi::Result<()> {
    let extension = Path::new(file_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_lowercase);
    if extension
        .as_deref()
        .is_some_and(|extension| SUPPORTED_EXTENSIONS.contains(&extension))
    {
        return Ok(());
    }

    Err(Error::new(
        Status::InvalidArg,
        format!(
            "Unsupported file extension '.{}'. CodeLens supports: TypeScript, JavaScript, Python, Rust, Go, C, Java, C#, Ruby, PHP, CSS, HTML, JSON, YAML, Bash, Lua.",
            extension.as_deref().unwrap_or("(none)")
        ),
    ))
}

/// Read a source file and return (normalized_path, source_text).
/// Returns an error if the file doesn't exist, is too large, or cannot be read.
fn read_source_file(file_path: &str) -> napi::Result<(String, String)> {
    let path = Path::new(file_path);

    if !path.exists() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("File does not exist: {file_path}"),
        ));
    }

    if !path.is_file() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Path is not a file: {file_path}"),
        ));
    }

    // Check file size
    let metadata = std::fs::metadata(path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read file metadata: {e}"),
        )
    })?;

    if metadata.len() > MAX_FILE_SIZE as u64 {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "File is too large to analyze ({} bytes, max {} bytes): {file_path}",
                metadata.len(),
                MAX_FILE_SIZE
            ),
        ));
    }

    validate_supported_extension(file_path)?;

    let source_text = std::fs::read_to_string(path)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to read file: {e}")))?;

    // Return the canonical path if possible, otherwise the original
    let canonical = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| file_path.to_string());

    Ok((canonical, source_text))
}

/// Resolve the project root directory from a project_id by looking up the
/// workspace directory in the app database. Returns None if the project_id
/// is not available or the directory cannot be resolved.
fn resolve_project_root(project_id: &str) -> napi::Result<Option<PathBuf>> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    let project_path =
        crate::storage::services::workspace_directories::get_workspace_directory_path(
            &database_path,
            project_id,
        )?;
    Ok(project_path.map(PathBuf::from))
}
