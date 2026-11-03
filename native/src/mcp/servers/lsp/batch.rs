//! Batch execution helpers for LSP read-only queries: symbols, hover, goto, references.
//!
//! Provides array-first parameters, physical path deduplication, bounded concurrency (3),
//! and consistent response envelopes with execution summaries.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use futures::{stream, StreamExt};
use napi::{Error, Status};
use serde_json::{json, Value};

use super::LspService;

pub(super) const MAX_SYMBOLS_FILES: usize = 10;
pub(super) const MAX_HOVER_ITEMS: usize = 10;
pub(super) const MAX_GOTO_ITEMS: usize = 10;
pub(super) const MAX_REFERENCES_ITEMS: usize = 5;
const CONCURRENCY: usize = 3;

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn identity(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn validate_local_path(path_str: &str, field_name: &str) -> napi::Result<String> {
    let trimmed = path_str.trim();
    if trimmed.is_empty() {
        return Err(invalid(format!("{field_name} must not be empty")));
    }
    if super::super::remote_workspace::is_ssh_path(trimmed) || !Path::new(trimmed).is_absolute() {
        return Err(invalid(format!(
            "{field_name} must be an absolute local path"
        )));
    }
    Ok(trimmed.to_string())
}

// ---------------------------------------------------------------------------
// 1. symbols: filePaths: string[] (1..=10)
// ---------------------------------------------------------------------------

struct SymbolsRequest {
    paths: Vec<String>,
}

fn parse_symbols_request(args: &Value) -> napi::Result<SymbolsRequest> {
    if !args.is_object() {
        return Err(invalid("Symbols arguments must be an object"));
    }
    let val = args
        .get("filePaths")
        .ok_or_else(|| invalid("filePaths is required and must be an array of absolute local paths (pass [\"/path/to/file\"] for a single file)"))?;
    let arr = val
        .as_array()
        .ok_or_else(|| invalid("filePaths must be an array of absolute local paths"))?;
    if arr.is_empty() || arr.len() > MAX_SYMBOLS_FILES {
        return Err(invalid(format!(
            "filePaths must contain 1..={MAX_SYMBOLS_FILES} paths (pass [path] for a single file)"
        )));
    }
    let mut paths = Vec::with_capacity(arr.len());
    for item in arr {
        let path_str = item
            .as_str()
            .ok_or_else(|| invalid("Each file path must be a non-empty string"))?;
        paths.push(validate_local_path(path_str, "filePaths entry")?);
    }
    Ok(SymbolsRequest { paths })
}

pub(super) async fn execute_symbols(
    _service: &LspService,
    args: &Value,
    project_id: Option<&str>,
) -> napi::Result<Value> {
    let request = parse_symbols_request(args)?;
    let requested_count = request.paths.len();

    let mut seen = HashSet::new();
    let mut deduplicated_paths = Vec::new();
    for path in request.paths {
        let physical = tokio::fs::canonicalize(&path)
            .await
            .unwrap_or_else(|_| PathBuf::from(&path));
        if seen.insert(identity(&physical)) {
            deduplicated_paths.push((path, physical));
        }
    }
    let duplicate_count = requested_count - deduplicated_paths.len();

    let mut jobs: Vec<futures::future::BoxFuture<'static, (usize, Value)>> = Vec::new();
    for (index, (display, _physical)) in deduplicated_paths.into_iter().enumerate() {
        let project_id_owned = project_id.map(str::to_string);
        jobs.push(Box::pin(async move {
            let svc = LspService::new();
            let res = svc
                .execute_symbols_single(&display, project_id_owned.as_deref())
                .await;
            let val = match res {
                Ok(mut out) => {
                    if let Value::Object(ref mut map) = out {
                        map.insert("filePath".to_string(), json!(display));
                    }
                    set_default_status(&mut out);
                    out
                }
                Err(err) => json!({
                    "filePath": display,
                    "status": "failed",
                    "error": err.to_string(),
                    "symbols": []
                }),
            };
            (index, val)
        }));
    }

    let mut files = stream::iter(jobs)
        .buffer_unordered(CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    files.sort_by_key(|(index, _)| *index);
    let files: Vec<Value> = files.into_iter().map(|(_, val)| val).collect();

    let mut completed = 0;
    let mut partial = 0;
    let mut failed = 0;
    let mut total_symbols = 0;
    for file in &files {
        match result_status(file) {
            "complete" => {
                completed += 1;
                if let Some(syms) = file.get("symbols").and_then(Value::as_array) {
                    total_symbols += syms.len();
                }
            }
            "partial" => partial += 1,
            _ => failed += 1,
        }
    }

    let overall_status = if failed == files.len() {
        "failed"
    } else if failed > 0 || partial > 0 {
        "partial"
    } else {
        "complete"
    };

    Ok(json!({
        "batch": true,
        "fileCount": files.len(),
        "requestedCount": requested_count,
        "duplicateCount": duplicate_count,
        "status": overall_status,
        "summary": {
            "completedFiles": completed,
            "partialFiles": partial,
            "failedFiles": failed,
            "symbolCount": total_symbols
        },
        "files": files
    }))
}

// ---------------------------------------------------------------------------
// 2. 通用 Items 批次解析（hover, goto, references）
// ---------------------------------------------------------------------------

fn result_status(value: &Value) -> &'static str {
    match value.get("status").and_then(Value::as_str) {
        Some("failed") => "failed",
        Some("complete") => "complete",
        Some("partial" | "ambiguous" | "partial_symbol_search") => "partial",
        Some(_) => "partial",
        None if value.get("error").and_then(Value::as_str).is_some() => "failed",
        None if value.get("incomplete").and_then(Value::as_bool) == Some(true)
            || value.get("truncated").and_then(Value::as_bool) == Some(true)
            || value
                .get("warnings")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty()) =>
        {
            "partial"
        }
        None => "complete",
    }
}

fn set_default_status(value: &mut Value) {
    let status = result_status(value);
    if let Value::Object(map) = value {
        map.entry("status".to_string())
            .or_insert_with(|| json!(status));
    }
}

fn batch_summary(results: &[Value]) -> (usize, usize, usize, &'static str) {
    let mut completed = 0;
    let mut partial = 0;
    let mut failed = 0;
    for result in results {
        match result_status(result) {
            "complete" => completed += 1,
            "partial" => partial += 1,
            _ => failed += 1,
        }
    }
    let overall = if failed == results.len() {
        "failed"
    } else if failed > 0 || partial > 0 {
        "partial"
    } else {
        "complete"
    };
    (completed, partial, failed, overall)
}

fn parse_items_request(
    args: &Value,
    tool_name: &str,
    max_items: usize,
) -> napi::Result<Vec<Value>> {
    if !args.is_object() {
        return Err(invalid(format!("{tool_name} arguments must be an object")));
    }
    let val = args
        .get("items")
        .ok_or_else(|| invalid(format!("items is required and must be an array of query targets (pass [target] for a single item)")))?;
    let arr = val
        .as_array()
        .ok_or_else(|| invalid("items must be an array of query targets"))?;
    if arr.is_empty() || arr.len() > max_items {
        return Err(invalid(format!(
            "items must contain 1..={max_items} query targets (pass [target] for a single item)"
        )));
    }
    for (i, item) in arr.iter().enumerate() {
        if !item.is_object() {
            return Err(invalid(format!("items[{i}] must be an object")));
        }
    }
    Ok(arr.clone())
}

// ---------------------------------------------------------------------------
// 3. hover: items: Array<PositionArgs> (1..=10)
// ---------------------------------------------------------------------------

pub(super) async fn execute_hover(
    _service: &LspService,
    args: &Value,
    project_id: Option<&str>,
) -> napi::Result<Value> {
    let items = parse_items_request(args, "hover", MAX_HOVER_ITEMS)?;
    let requested_count = items.len();

    let mut jobs: Vec<futures::future::BoxFuture<'static, (usize, Value)>> = Vec::new();
    for (index, item) in items.into_iter().enumerate() {
        let project_id_owned = project_id.map(str::to_string);
        jobs.push(Box::pin(async move {
            let svc = LspService::new();
            let res = svc
                .execute_hover_single(&item, project_id_owned.as_deref())
                .await;
            let val = match res {
                Ok(mut out) => {
                    if let Value::Object(ref mut map) = out {
                        map.insert("target".to_string(), item.clone());
                    }
                    set_default_status(&mut out);
                    out
                }
                Err(err) => json!({
                    "target": item,
                    "status": "failed",
                    "error": err.to_string(),
                }),
            };
            (index, val)
        }));
    }

    let mut results = stream::iter(jobs)
        .buffer_unordered(CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    results.sort_by_key(|(index, _)| *index);
    let results: Vec<Value> = results.into_iter().map(|(_, val)| val).collect();

    let (completed, partial, failed, overall_status) = batch_summary(&results);

    Ok(json!({
        "batch": true,
        "itemCount": results.len(),
        "requestedCount": requested_count,
        "status": overall_status,
        "summary": {
            "completedItems": completed,
            "partialItems": partial,
            "failedItems": failed
        },
        "items": results
    }))
}

// ---------------------------------------------------------------------------
// 4. goto: items: Array<PositionArgs + kind> (1..=10)
// ---------------------------------------------------------------------------

pub(super) async fn execute_goto(
    _service: &LspService,
    args: &Value,
    project_id: Option<&str>,
) -> napi::Result<Value> {
    let items = parse_items_request(args, "goto", MAX_GOTO_ITEMS)?;
    let requested_count = items.len();

    let mut jobs: Vec<futures::future::BoxFuture<'static, (usize, Value)>> = Vec::new();
    for (index, item) in items.into_iter().enumerate() {
        let project_id_owned = project_id.map(str::to_string);
        jobs.push(Box::pin(async move {
            let svc = LspService::new();
            let res = svc
                .execute_goto_single(&item, project_id_owned.as_deref())
                .await;
            let val = match res {
                Ok(mut out) => {
                    if let Value::Object(ref mut map) = out {
                        map.insert("target".to_string(), item.clone());
                    }
                    set_default_status(&mut out);
                    out
                }
                Err(err) => json!({
                    "target": item,
                    "status": "failed",
                    "error": err.to_string(),
                }),
            };
            (index, val)
        }));
    }

    let mut results = stream::iter(jobs)
        .buffer_unordered(CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    results.sort_by_key(|(index, _)| *index);
    let results: Vec<Value> = results.into_iter().map(|(_, val)| val).collect();

    let (completed, partial, failed, overall_status) = batch_summary(&results);

    Ok(json!({
        "batch": true,
        "itemCount": results.len(),
        "requestedCount": requested_count,
        "status": overall_status,
        "summary": {
            "completedItems": completed,
            "partialItems": partial,
            "failedItems": failed
        },
        "items": results
    }))
}

// ---------------------------------------------------------------------------
// 5. references: items: Array<PositionArgs + includeDeclaration> (1..=5)
// ---------------------------------------------------------------------------

pub(super) async fn execute_references(
    _service: &LspService,
    args: &Value,
    project_id: Option<&str>,
) -> napi::Result<Value> {
    let items = parse_items_request(args, "references", MAX_REFERENCES_ITEMS)?;
    let requested_count = items.len();

    let mut jobs: Vec<futures::future::BoxFuture<'static, (usize, Value)>> = Vec::new();
    for (index, item) in items.into_iter().enumerate() {
        let project_id_owned = project_id.map(str::to_string);
        jobs.push(Box::pin(async move {
            let svc = LspService::new();
            let res = svc
                .execute_references_single(&item, project_id_owned.as_deref())
                .await;
            let val = match res {
                Ok(mut out) => {
                    if let Value::Object(ref mut map) = out {
                        map.insert("target".to_string(), item.clone());
                    }
                    set_default_status(&mut out);
                    out
                }
                Err(err) => json!({
                    "target": item,
                    "status": "failed",
                    "error": err.to_string(),
                }),
            };
            (index, val)
        }));
    }

    let mut results = stream::iter(jobs)
        .buffer_unordered(CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    results.sort_by_key(|(index, _)| *index);
    let results: Vec<Value> = results.into_iter().map(|(_, val)| val).collect();

    let mut total_references = 0;
    for result in &results {
        if result_status(result) != "failed" {
            if let Some(count) = result.get("count").and_then(Value::as_u64) {
                total_references += count;
            } else if let Some(references) = result.get("references").and_then(Value::as_array) {
                total_references += references.len() as u64;
            }
        }
    }
    let (completed, partial, failed, overall_status) = batch_summary(&results);

    Ok(json!({
        "batch": true,
        "itemCount": results.len(),
        "requestedCount": requested_count,
        "status": overall_status,
        "summary": {
            "completedItems": completed,
            "partialItems": partial,
            "failedItems": failed,
            "totalReferences": total_references
        },
        "items": results
    }))
}
