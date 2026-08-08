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

#![allow(dead_code)]

mod analyzer;
mod symbol_index;
mod tree_sitter_analyzer;
mod types;

use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "codelens";

/// Maximum source file size we will analyze (512 KB).
const MAX_FILE_SIZE: u64 = 512 * 1024;

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
                description: "Find the definition of a symbol at a given line and column in a source file. Supports TypeScript, JavaScript, Python, Rust, Go, C, C++, Java, C#, Ruby, PHP, Lua, and more. Returns the symbol name, kind, and location of its declaration.".to_string(),
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
                description: "Find all references to a symbol at a given line and column in a source file. Supports TypeScript, JavaScript, Python, Rust, Go, C, C++, Java, C#, Ruby, PHP, Lua, and more. Returns the symbol name, its definition location, and all usage sites within the same file.".to_string(),
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
                description: "Get the symbol outline of a source file. Supports TypeScript, JavaScript, Python, Rust, Go, C, C++, Java, C#, Ruby, PHP, Lua, and more. Returns a flat list of top-level symbols (functions, classes, methods, variables, interfaces, types, enums) with their names, kinds, and locations. Useful for quickly understanding the structure of a file.".to_string(),
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

        let project_id_owned = project_id.map(|s| s.to_string());

        let result = tokio::task::spawn_blocking(move || -> napi::Result<Value> {
            let (path_str, source_text) = read_source_file(&file_path)?;

            // Step 1: find the symbol name at the cursor position in the current file
            let found = if is_js_ts(&path_str) {
                analyzer::find_symbol_at_position(&path_str, &source_text, line, column)
            } else {
                tree_sitter_analyzer::find_symbol_at_position(&path_str, &source_text, line, column)
            };

            let symbol_name = match &found {
                Some((name, _)) => name.clone(),
                None => {
                    return Ok(json!({
                        "found": false,
                        "message": "No symbol found at the given position. The position may be on whitespace, a string literal, or a keyword."
                    }));
                }
            };

            // Step 2: if we have a project root, search across all files
            if let Some(ref pid) = project_id_owned {
                if let Some(project_root) = resolve_project_root(pid)? {
                    let mut index = symbol_index::SymbolIndex::new();
                    index.index_project(&project_root);

                    if let Some(symbol) = index.find_definition_across_project(&symbol_name) {
                        return Ok(json!({
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
                        }));
                    }
                }
            }

            // Fallback: single-file result
            if let Some((name, symbol)) = found {
                Ok(json!({
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
                }))
            } else {
                Ok(json!({
                    "found": false,
                    "message": "No symbol definition found for the symbol at the given position."
                }))
            }
        })
        .await
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Find definition task failed: {e}"),
            )
        })??;

        Ok(result)
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

        let project_id_owned = project_id.map(|s| s.to_string());

        let result = tokio::task::spawn_blocking(move || -> napi::Result<Value> {
            let (path_str, source_text) = read_source_file(&file_path)?;

            // Step 1: find the symbol name at the cursor position in the current file
            let found = if is_js_ts(&path_str) {
                analyzer::find_references_at_position(&path_str, &source_text, line, column)
            } else {
                tree_sitter_analyzer::find_references_at_position(&path_str, &source_text, line, column)
            };

            let (name, local_definition, local_references) = match found {
                Some(t) => t,
                None => {
                    return Ok(json!({
                        "found": false,
                        "message": "No symbol found at the given position. The position may be on whitespace, a string literal, or a keyword."
                    }));
                }
            };

            // Step 2: if we have a project root, search across all files
            if let Some(ref pid) = project_id_owned {
                if let Some(project_root) = resolve_project_root(pid)? {
                    let mut index = symbol_index::SymbolIndex::new();
                    index.index_project(&project_root);

                    let references = index.find_references_across_project(&name);
                    let definition = index
                        .find_definition_across_project(&name)
                        .map(|s| {
                            json!({
                                "filePath": s.location.file_path,
                                "line": s.location.line,
                                "column": s.location.column,
                                "endLine": s.location.end_line,
                                "endColumn": s.location.end_column,
                            })
                        });

                    let refs_json: Vec<Value> = references
                        .iter()
                        .map(|r| {
                            json!({
                                "filePath": r.location.file_path,
                                "line": r.location.line,
                                "column": r.location.column,
                                "endLine": r.location.end_line,
                                "endColumn": r.location.end_column,
                                "access": r.access,
                            })
                        })
                        .collect();

                    return Ok(json!({
                        "found": true,
                        "name": name,
                        "definition": definition,
                        "references": refs_json,
                        "totalReferences": references.len(),
                        "searchScope": "project"
                    }));
                }
            }

            // Fallback: single-file result
            let definition_json = local_definition.map(|d| {
                json!({
                    "filePath": d.file_path,
                    "line": d.line,
                    "column": d.column,
                    "endLine": d.end_line,
                    "endColumn": d.end_column,
                })
            });

            let refs_json: Vec<Value> = local_references
                .iter()
                .map(|r| {
                    json!({
                        "filePath": r.location.file_path,
                        "line": r.location.line,
                        "column": r.location.column,
                        "endLine": r.location.end_line,
                        "endColumn": r.location.end_column,
                        "access": r.access,
                    })
                })
                .collect();

            Ok(json!({
                "found": true,
                "name": name,
                "definition": definition_json,
                "references": refs_json,
                "totalReferences": local_references.len(),
                "searchScope": "file"
            }))
        })
        .await
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Find references task failed: {e}"),
            )
        })??;

        Ok(result)
    }

    /// Execute the file_outline tool asynchronously.
    pub async fn execute_file_outline(&self, args: &Value) -> napi::Result<Value> {
        let file_path = require_string_arg(args, "filePath")?;

        let result = tokio::task::spawn_blocking(move || -> napi::Result<Value> {
            let (path_str, source_text) = read_source_file(&file_path)?;

            let outline = if is_js_ts(&path_str) {
                analyzer::build_file_outline(&path_str, &source_text)
            } else {
                tree_sitter_analyzer::build_file_outline(&path_str, &source_text)
            };

            let entries: Vec<Value> = outline
                .iter()
                .map(|e| {
                    json!({
                        "name": e.name,
                        "kind": e.kind,
                        "line": e.line,
                        "column": e.column,
                        "endLine": e.end_line,
                        "endColumn": e.end_column,
                        "containerName": e.container_name,
                        "isExported": e.is_exported,
                    })
                })
                .collect();

            Ok(json!({
                "filePath": path_str,
                "outline": entries,
                "totalSymbols": entries.len(),
            }))
        })
        .await
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("File outline task failed: {e}"),
            )
        })??;

        Ok(result)
    }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

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
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{key} is required and must be a positive number"),
            )
        })
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

    if metadata.len() > MAX_FILE_SIZE {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "File is too large to analyze ({} bytes, max {} bytes): {file_path}",
                metadata.len(),
                MAX_FILE_SIZE
            ),
        ));
    }

    // Check file extension
    let is_supported = if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_lowercase();
        SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str())
    } else {
        false
    };

    if !is_supported {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("(none)");
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Unsupported file extension '.{ext}'. CodeLens supports: TypeScript, JavaScript, Python, Rust, Go, C, Java, C#, Ruby, PHP, CSS, HTML, JSON, YAML, Bash, Lua."
            ),
        ));
    }

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
