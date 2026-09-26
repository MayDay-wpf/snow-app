//! Single/batch diagnostics: strict input, physical-file deduplication, bounded work and honest summaries.
use super::{manager, types::ServerConfig, LspService, Prepared};
use futures::{stream, StreamExt};
use napi::{Error, Status};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub(super) const MAX_FILES: usize = 30;
const CONCURRENCY: usize = 3;

#[derive(Debug, PartialEq)]
struct Request {
    paths: Vec<String>,
    batch: bool,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}
fn validate_path(value: &Value) -> napi::Result<String> {
    let path = value
        .as_str()
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| invalid("Every diagnostic file path must be a non-empty string"))?;
    if super::is_ssh_path(path) || !Path::new(path).is_absolute() {
        return Err(invalid(
            "Diagnostic paths must be absolute local file paths",
        ));
    }
    Ok(path.to_owned())
}
fn parse(args: &Value) -> napi::Result<Request> {
    if !args.is_object() {
        return Err(invalid("Diagnostic arguments must be an object"));
    }
    // Accept the old empty single-path placeholder only when a real batch is supplied.
    let single = match args.get("filePath") {
        None | Some(Value::Null) => None,
        Some(Value::String(path)) if path.trim().is_empty() => None,
        Some(value) => Some(validate_path(value)?),
    };
    let batch = match args.get("filePaths") {
        None => None,
        Some(Value::Array(paths)) => {
            if paths.is_empty() || paths.len() > MAX_FILES {
                return Err(invalid(format!("filePaths must contain 1..={MAX_FILES} paths; split larger requests into batches (nothing was diagnosed)")));
            }
            Some(
                paths
                    .iter()
                    .map(validate_path)
                    .collect::<napi::Result<Vec<_>>>()?,
            )
        }
        Some(_) => {
            return Err(invalid(
                "filePaths must be an array of absolute local paths",
            ))
        }
    };
    match (single, batch) {
        (Some(_), Some(_)) => Err(invalid(
            "filePath and filePaths are mutually exclusive; place all files in filePaths",
        )),
        (Some(path), None) => Ok(Request {
            paths: vec![path],
            batch: false,
        }),
        (None, Some(paths)) => Ok(Request { paths, batch: true }),
        _ => Err(invalid(
            "Provide filePath for one file or filePaths for 1..=30 files",
        )),
    }
}

fn identity(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}
fn has_error(value: &Value) -> bool {
    value["error"]
        .as_str()
        .is_some_and(|message| !message.trim().is_empty())
}
fn file_state(value: &Value) -> &'static str {
    if value["status"] == "partial" {
        return "partial";
    }
    if value["status"] == "failed" || has_error(value) {
        return "failed";
    }
    if value["partial"].as_bool() == Some(true)
        || value["truncated"].as_bool() == Some(true)
        || value["warnings"]
            .as_array()
            .is_some_and(|warnings| !warnings.is_empty())
    {
        "partial"
    } else {
        "complete"
    }
}

fn envelope(files: Vec<Value>, requested_count: usize, duplicate_count: usize) -> Value {
    let mut completed = 0;
    let mut partial = 0;
    let mut failed = 0;
    let mut errors = 0;
    let mut warnings = 0;
    let mut query_warnings = Vec::new();
    let truncated = files
        .iter()
        .any(|file| file["truncated"].as_bool() == Some(true));
    for file in &files {
        match file_state(file) {
            "complete" => completed += 1,
            "partial" => partial += 1,
            _ => failed += 1,
        }
        if let Some(items) = file["diagnostics"].as_array() {
            for item in items {
                match item["severity"].as_str() {
                    Some("error") => errors += 1,
                    Some("warning") => warnings += 1,
                    _ => {}
                }
            }
        }
        if let Some(items) = file["warnings"].as_array() {
            for item in items {
                query_warnings.push(
                    json!({"filePath":file["filePath"], "language":file["language"],
                    "error":item.get("error").or_else(|| item.get("message")).unwrap_or(item)}),
                );
            }
        }
    }
    let state = if failed == files.len() {
        "failed"
    } else if failed > 0 || partial > 0 {
        "partial"
    } else {
        "complete"
    };
    json!({"batch":true, "fileCount":files.len(), "requestedCount":requested_count,
        "duplicateCount":duplicate_count, "status":state, "partial":state=="partial", "truncated":truncated,
        "summaryCountsPartial":truncated || state!="complete",
        "summary":{"completedFiles":completed,"partialFiles":partial,"failedFiles":failed,"errorCount":errors,"warningCount":warnings},
        "warnings":query_warnings,"files":files})
}

struct DiagnosticWait(tokio::task::JoinHandle<Result<Value, super::types::LspError>>);
impl Drop for DiagnosticWait {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn one(
    service: &LspService,
    path: &str,
    configs: &[ServerConfig],
    project_id: Option<&str>,
) -> Value {
    let result: napi::Result<Value> = async {
        match service
            .prepare_single_with_configs(path, project_id, configs)
            .await?
        {
            Prepared::Cached(value) => Ok(value),
            Prepared::Pending { session, pending } => {
                let mut wait = DiagnosticWait(session.lock().await.spawn_await_task(&pending));
                let value = (&mut wait.0)
                    .await
                    .map_err(|err| {
                        Error::new(
                            Status::GenericFailure,
                            format!("Diagnostic task failed: {err}"),
                        )
                    })?
                    .map_err(napi::Error::from)?;
                session.lock().await.touch();
                Ok(value)
            }
        }
    }
    .await;
    let mut value = match result {
        Ok(value) => value,
        Err(error) => json!({"status":"failed","error":error.to_string(),"diagnostics":[]}),
    };
    value["filePath"] = json!(path);
    value["status"] = json!(file_state(&value));
    value
}

pub(super) async fn execute(
    _service: &LspService,
    args: &Value,
    project_id: Option<&str>,
) -> napi::Result<Value> {
    let request = parse(args)?;
    let requested_count = request.paths.len();
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for path in request.paths {
        let physical = tokio::fs::canonicalize(&path)
            .await
            .unwrap_or_else(|_| PathBuf::from(&path));
        if seen.insert(identity(&physical)) {
            paths.push((path, physical));
        }
    }
    let duplicate_count = requested_count - paths.len();
    let manager = manager::ServerManager::instance();
    manager.reload_configs(project_id).await?;
    let configs = std::sync::Arc::new(manager.configs(project_id).await);
    let mut jobs: Vec<futures::future::BoxFuture<'static, (usize, Value)>> = Vec::new();
    for (index, (display, path)) in paths.into_iter().enumerate() {
        let configs = configs.clone();
        let project_id = project_id.map(str::to_string);
        jobs.push(Box::pin(async move {
            let service = LspService::new();
            let path = path.to_string_lossy().into_owned();
            let mut value = one(&service, &path, &configs, project_id.as_deref()).await;
            value["filePath"] = json!(display);
            (index, value)
        }));
    }
    let mut files = stream::iter(jobs)
        .buffer_unordered(CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    files.sort_by_key(|(index, _)| *index);
    let mut files = files
        .into_iter()
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    if request.batch {
        Ok(envelope(files, requested_count, duplicate_count))
    } else {
        Ok(files.remove(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path(name: &str) -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(name)
            .to_string_lossy()
            .into_owned()
    }
    #[test]
    fn single_and_batch_are_supported() {
        assert!(!parse(&json!({"filePath":path("a.rs")})).unwrap().batch);
        assert!(
            parse(&json!({"filePaths":[path("a.rs"),path("b.rs")]}))
                .unwrap()
                .batch
        );
    }
    #[test]
    fn both_nonempty_inputs_are_rejected() {
        assert!(parse(&json!({"filePath":path("a.rs"),"filePaths":[path("b.rs")]})).is_err());
        assert!(parse(&json!({"filePath":"","filePaths":[path("b.rs")]})).is_ok());
    }
    #[test]
    fn invalid_batches_are_not_silently_filtered_or_clipped() {
        for value in [
            json!([]),
            json!([path("a.rs"), 5]),
            json!([""]),
            json!(null),
            json!(["relative.rs"]),
            json!(vec![path("a.rs"); 31]),
        ] {
            assert!(parse(&json!({"filePaths":value})).is_err());
        }
        assert!(parse(&json!({"filePaths":vec![path("a.rs");30]})).is_ok());
    }
    #[test]
    fn summary_preserves_partial_and_errors() {
        let files = vec![
            json!({"filePath":"a","error":null,"diagnostics":[]}),
            json!({"filePath":"b","status":"partial","diagnostics":[{"severity":"error"}],"warnings":[{"error":"unverified"}]}),
            json!({"filePath":"c","error":"missing"}),
        ];
        let result = envelope(files, 4, 1);
        assert_eq!(result["status"], "partial");
        assert_eq!(result["summary"]["completedFiles"], 1);
        assert_eq!(result["summary"]["partialFiles"], 1);
        assert_eq!(result["summary"]["failedFiles"], 1);
        assert_eq!(result["summary"]["errorCount"], 1);
        assert_eq!(result["duplicateCount"], 1);
        assert_eq!(result["files"][1]["filePath"], "b");
    }
    #[test]
    fn complete_with_errors_is_not_transport_failure() {
        let result = envelope(vec![json!({"diagnostics":[{"severity":"error"}]})], 1, 0);
        assert_eq!(result["status"], "complete");
        assert_eq!(result["summary"]["errorCount"], 1);
    }
    #[test]
    fn total_failure_is_never_empty_success() {
        assert_eq!(
            envelope(vec![json!({"error":"timeout"})], 1, 0)["status"],
            "failed"
        );
    }
}
