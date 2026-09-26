//! Workspace queries keep complete internal results and report incomplete coverage.
use super::{config, detect, manager, types};
use napi::{Error, Status};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Configuration scope remains project_id; workspaceRoot only selects source files.
pub(super) async fn root(args: &Value, project_id: Option<&str>) -> napi::Result<PathBuf> {
    let explicit = match args.get("workspaceRoot") {
        None => None,
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.trim().to_string()),
        Some(_) => {
            return Err(Error::new(
                Status::InvalidArg,
                "workspaceRoot must be a non-empty absolute local directory",
            ))
        }
    };
    let project_id = project_id.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let path = if let Some(value) = explicit {
            if super::is_ssh_path(&value) {
                return Err(types::LspError::RemoteNotSupported.into());
            }
            PathBuf::from(value)
        } else {
            let pid = project_id
                .as_deref()
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "No project context: supply workspaceRoot explicitly",
                    )
                })?;
            let storage = crate::storage::initialize_app_storage()?;
            let value =
                crate::storage::services::workspace_directories::get_workspace_directory_path(
                    Path::new(&storage.database_path),
                    pid,
                )?
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "Project directory unavailable: supply workspaceRoot explicitly",
                    )
                })?;
            if super::is_ssh_path(&value) {
                return Err(types::LspError::RemoteNotSupported.into());
            }
            PathBuf::from(value)
        };
        if !path.is_absolute() || !path.is_dir() {
            return Err(Error::new(
                Status::InvalidArg,
                "workspaceRoot must be an existing absolute local directory",
            ));
        }
        std::fs::canonicalize(path).map_err(|err| {
            Error::new(
                Status::InvalidArg,
                format!("Cannot resolve workspaceRoot: {err}"),
            )
        })
    })
    .await
    .map_err(|err| Error::new(Status::GenericFailure, err.to_string()))?
}

fn state(successful_roots: usize, incomplete: bool) -> &'static str {
    if successful_roots == 0 {
        "failed"
    } else if incomplete {
        "partial"
    } else {
        "complete"
    }
}

fn incomplete(value: &Value) -> bool {
    ["partial", "truncated", "incomplete"]
        .iter()
        .any(|key| value[*key].as_bool() == Some(true))
        || matches!(value["status"].as_str(), Some("partial" | "failed"))
        || value["warnings"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
}

fn location_key(item: &Value) -> String {
    let mut path = item["filePath"]
        .as_str()
        .unwrap_or_default()
        .replace('\\', "/");
    if cfg!(windows) {
        path.make_ascii_lowercase();
    }
    format!(
        "{}:{}:{}:{}",
        path, item["line"], item["column"], item["name"]
    )
}

async fn query(args: &Value, project_id: Option<&str>, diagnostics: bool) -> napi::Result<Value> {
    let root = root(args, project_id).await?;
    // The initialized session validates the selected operation.
    let query = if diagnostics {
        String::new()
    } else {
        super::required_string(args, "query")?
    };
    if !diagnostics && query.trim().is_empty() {
        return Err(Error::new(Status::InvalidArg, "query must not be empty"));
    }
    let limit = if diagnostics {
        match args.get("maxFiles") {
            None => 100,
            Some(value) => value
                .as_u64()
                .filter(|n| *n > 0)
                .map(|n| n.min(200) as usize)
                .ok_or_else(|| {
                    Error::new(Status::InvalidArg, "maxFiles must be a positive integer")
                })?,
        }
    } else {
        50
    };
    let manager = manager::ServerManager::instance();
    manager.reload_configs(project_id).await?;
    let configs = manager.configs(project_id).await;
    let mut warnings = Vec::new();
    let mut languages = BTreeSet::new();
    let mut items: BTreeMap<String, Value> = BTreeMap::new();
    let mut successful_roots = 0;
    let mut clipped = false;
    for server in configs
        .into_iter()
        .filter(|server| server.enabled && !server.file_extensions.is_empty())
    {
        let scan_root = root.clone();
        let lang = server.lang.clone();
        let discovery =
            tokio::task::spawn_blocking(move || detect::discover_lang_roots(&scan_root, &lang))
                .await
                .map_err(|err| Error::new(Status::GenericFailure, err.to_string()))?;
        if discovery.incomplete {
            warnings.push(json!({"language":server.lang,"error":"Technology-stack discovery was incomplete; coverage is not guaranteed"}));
        }
        if discovery.roots.is_empty() {
            continue;
        }
        // Capability is checked on the actual initialized session below. Static
        // estimates must not reject capabilities advertised by a custom server.
        let command = server.command.clone();
        let installed =
            tokio::task::spawn_blocking(move || config::is_command_installed_cached(&command))
                .await
                .unwrap_or(false);
        if !installed {
            warnings.push(json!({"language":server.lang,"error":"Configured language-server command is not installed"}));
            continue;
        }
        for lang_root in discovery.roots {
            let result = async {
                let session = manager
                    .get_or_start(&server.lang, &lang_root, project_id)
                    .await?;
                let mut guard = session.lock().await;
                if diagnostics {
                    guard.workspace_diagnostics(limit).await
                } else {
                    guard.workspace_symbols(&query).await
                }
            }
            .await;
            match result {
                Ok(value) => {
                    successful_roots += 1;
                    languages.insert(server.lang.clone());
                    if incomplete(&value) {
                        clipped |= value["truncated"].as_bool() == Some(true);
                        warnings.push(json!({"language":server.lang,"workspaceRoot":lang_root,"error":"Server returned an incomplete or truncated result"}));
                    }
                    if let Some(inner) = value["warnings"].as_array() { warnings.extend(inner.iter().cloned()); }
                    let key = if diagnostics { "files" } else { "symbols" };
                    if let Some(values) = value[key].as_array() {
                        for item in values {
                            let key = if diagnostics { item["filePath"].as_str().unwrap_or_default().replace('\\', "/") } else { location_key(item) };
                            if diagnostics {
                                if let Some(previous) = items.get_mut(&key) {
                                    merge_file(previous, item);
                                } else { items.insert(key, item.clone()); }
                            } else { items.entry(key).or_insert_with(|| item.clone()); }
                        }
                    }
                }
                Err(error) => warnings.push(json!({"language":server.lang,"workspaceRoot":lang_root,"error":format!("{error:?}")})),
            }
        }
    }
    if successful_roots == 0 && warnings.is_empty() {
        warnings.push(
            json!({"error":"No matching enabled language server completed this workspace query"}),
        );
    }
    let mut results: Vec<Value> = items.into_values().collect();
    if !diagnostics {
        results.sort_by_key(|item| !item["inProject"].as_bool().unwrap_or(false));
    }
    clipped |= results.iter().any(incomplete);
    let total = results.len();
    clipped |= total > limit;
    results.truncate(limit);
    let incomplete = !warnings.is_empty() || clipped;
    let languages: Vec<String> = languages.into_iter().collect();
    let mut output = json!({
        "language": if languages.len() == 1 { languages[0].as_str() } else { "multiple" },
        "languages": languages, "workspaceRoot":root, "status":state(successful_roots,incomplete),
        "warnings": warnings, "truncated":clipped, "incomplete":incomplete,
        "count":results.len(), "total":total,
    });
    if diagnostics {
        output["files"] = json!(results);
    } else {
        output["projectSymbols"] = json!(results
            .iter()
            .filter(|item| item["inProject"].as_bool() == Some(true))
            .count());
        output["query"] = json!(query);
        output["symbols"] = json!(results);
    }
    Ok(output)
}

fn merge_file(previous: &mut Value, next: &Value) {
    let mut diagnostics = previous["diagnostics"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut seen: BTreeSet<String> = diagnostics.iter().map(Value::to_string).collect();
    if let Some(items) = next["diagnostics"].as_array() {
        for item in items {
            if seen.insert(item.to_string()) {
                diagnostics.push(item.clone());
            }
        }
    }
    let total = diagnostics
        .len()
        .max(previous["diagnosticTotal"].as_u64().unwrap_or(0) as usize)
        .max(next["diagnosticTotal"].as_u64().unwrap_or(0) as usize);
    let truncated = total > 200 || incomplete(previous) || incomplete(next);
    diagnostics.truncate(200);
    previous["diagnostics"] = json!(diagnostics);
    previous["diagnosticTotal"] = json!(total);
    previous["truncated"] = json!(truncated);
    if let Some(error) = next.get("error") {
        previous["error"] = error.clone();
    }
    // Do not retain a summary calculated before merging reports from overlapping roots.
    if let Some(map) = previous.as_object_mut() {
        map.remove("summary");
    }
}

pub(super) async fn symbols(args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
    query(args, project_id, false).await
}
pub(super) async fn diagnostics(args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
    query(args, project_id, true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_success_is_not_failed_but_zero_success_is() {
        assert_eq!(state(0, true), "failed");
        assert_eq!(state(1, false), "complete");
        assert_eq!(state(1, true), "partial");
    }
    #[test]
    fn overlapping_roots_merge_diagnostics_without_duplicates() {
        let mut a = json!({"diagnostics":[{"line":1,"message":"one"}],"summary":"stale"});
        merge_file(
            &mut a,
            &json!({"diagnostics":[{"line":1,"message":"one"},{"line":2,"message":"two"}]}),
        );
        assert_eq!(a["diagnostics"].as_array().unwrap().len(), 2);
        assert!(a.get("summary").is_none());
    }
}
