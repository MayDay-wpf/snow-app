//! Workspace queries keep complete internal results and report incomplete coverage.
use super::{config, detect, manager, types};
use napi::{Error, Status};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static NEXT_QUERY_TRACE: AtomicU64 = AtomicU64::new(1);

/// Log off the query's critical path: SQLite writes must not become part of
/// the LSP response time we are trying to measure.
fn queue_query_log(level: &'static str, func: &'static str, message: String) {
    let _ = tokio::spawn(async move {
        super::lsp_app_log(level, func, &message, None).await;
    });
}

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

/// Return false only after a bounded scan proves that a parent tsconfig can see
/// every relevant file. Ignore build output and dependencies just as stack
/// discovery does; any unreadable entry, symlink, or budget limit is uncertain.
fn child_covered_by_tsconfig(child: &Path, allow_js: bool) -> bool {
    let mut directories = vec![child.to_path_buf()];
    let mut visited = 0;
    while let Some(directory) = directories.pop() {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return false;
        };
        for entry in entries {
            visited += 1;
            if visited > 3000 {
                return false;
            }
            let Ok(entry) = entry else { return false };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.')
                || matches!(
                    name.as_ref(),
                    "node_modules" | "dist" | "out" | "build" | "target" | "vendor" | "venv"
                )
            {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                return false;
            };
            if kind.is_symlink() {
                return false;
            }
            if kind.is_dir() {
                directories.push(entry.path());
            } else if kind.is_file()
                && (matches!(name.as_ref(), "tsconfig.json" | "jsconfig.json")
                    || (!allow_js
                        && matches!(
                            entry.path().extension().and_then(|ext| ext.to_str()),
                            Some("js" | "jsx" | "mjs" | "cjs")
                        )))
            {
                return false;
            }
        }
    }
    true
}

/// Only coalesce a child package when a parent tsconfig explicitly includes its
/// entire directory. Ambiguous JSONC, references, extends and excludes retain
/// independent roots so a symbol cannot silently disappear from the search.
fn coalesce_typescript_roots(roots: Vec<PathBuf>) -> (Vec<PathBuf>, usize) {
    let mut retained: Vec<PathBuf> = Vec::new();
    let mut covered = 0;
    for child in roots {
        let included_by_parent = retained.iter().any(|parent| {
            if !child.starts_with(parent) || child == *parent {
                return false;
            }
            let Ok(relative) = child.strip_prefix(parent) else {
                return false;
            };
            // A child tsconfig/jsconfig can define a separate TypeScript project.
            if child.join("tsconfig.json").exists() || child.join("jsconfig.json").exists() {
                return false;
            }
            let Ok(text) = std::fs::read_to_string(parent.join("tsconfig.json")) else {
                return false;
            };
            let Ok(tsconfig) = serde_json::from_str::<Value>(&text) else {
                return false;
            };
            if tsconfig.get("extends").is_some()
                || tsconfig.get("references").is_some()
                || tsconfig.get("exclude").is_some()
                || tsconfig["compilerOptions"].get("outDir").is_some()
            {
                return false;
            }
            tsconfig["include"].as_array().is_some_and(|includes| {
                includes.iter().filter_map(Value::as_str).any(|include| {
                    // Glob patterns and parent traversal need TypeScript's own
                    // glob/config semantics; do not guess their coverage here.
                    let prefix = Path::new(include);
                    !include.contains('*')
                        && !prefix.is_absolute()
                        && prefix
                            .components()
                            .all(|part| matches!(part, std::path::Component::Normal(_)))
                        && relative.starts_with(prefix)
                })
            }) && child_covered_by_tsconfig(
                &child,
                tsconfig["compilerOptions"]["allowJs"]
                    .as_bool()
                    .unwrap_or(false),
            )
        });
        if included_by_parent {
            covered += 1;
        } else {
            retained.push(child);
        }
    }
    (retained, covered)
}

/// Rebase Go responses to the caller's scope, not the shared session folder.
/// Unresolvable paths are surfaced as partial coverage, never silently accepted.
pub(super) fn scope_go_response(value: &mut Value, requested_root: &Path, diagnostics: bool) {
    let key = if diagnostics { "files" } else { "symbols" };
    let reported_total = value["total"].as_u64().unwrap_or(0);
    let mut uncertain = false;
    let root = std::fs::canonicalize(requested_root).ok();
    let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) else {
        value["incomplete"] = json!(true);
        return;
    };
    let was_clipped = reported_total > items.len() as u64;
    items.retain_mut(|item| {
        let path = item["filePath"]
            .as_str()
            .and_then(|raw| std::fs::canonicalize(raw).ok());
        match (root.as_ref(), path) {
            (Some(root), Some(path)) => {
                let included = path.starts_with(root);
                if included && !diagnostics {
                    item["inProject"] = json!(true);
                }
                included
            }
            _ => {
                uncertain = true;
                false
            }
        }
    });
    let count = items.len();
    // Preserve upstream truncation/partial flags; filtering cannot prove that
    // missing results were all outside the request scope.
    value["count"] = json!(count);
    value["total"] = json!(count);
    if was_clipped {
        value["incomplete"] = json!(true);
        value["truncated"] = json!(true);
    }
    if uncertain {
        value["incomplete"] = json!(true);
        let warning = json!({"error":"Some Go result paths could not be resolved within the requested workspace"});
        if let Some(warnings) = value["warnings"].as_array_mut() {
            warnings.push(warning);
        } else {
            value["warnings"] = json!([warning]);
        }
    }
}

async fn query(args: &Value, project_id: Option<&str>, diagnostics: bool) -> napi::Result<Value> {
    let query_started = Instant::now();
    let trace = NEXT_QUERY_TRACE.fetch_add(1, Ordering::Relaxed);
    let operation = if diagnostics {
        "diagnostics"
    } else {
        "symbols"
    };
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
    let config_started = Instant::now();
    manager.reload_configs(project_id).await?;
    let configs = manager.configs(project_id).await;
    let config_ms = config_started.elapsed().as_millis();
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
        let scan_started = Instant::now();
        let (discovery, coalesced) = tokio::task::spawn_blocking(move || {
            let mut discovery = detect::discover_lang_roots(&scan_root, &lang);
            let mut coalesced = 0;
            if !diagnostics && lang == "typescript" {
                let (roots, removed) =
                    coalesce_typescript_roots(std::mem::take(&mut discovery.roots));
                discovery.roots = roots;
                coalesced = removed;
            }
            (discovery, coalesced)
        })
        .await
        .map_err(|err| Error::new(Status::GenericFailure, err.to_string()))?;
        let scan_ms = scan_started.elapsed().as_millis();
        let root_count = discovery.roots.len();
        queue_query_log(
            "info",
            "workspace_query_scan",
            format!("trace={trace} op={operation} language={} scanMs={scan_ms} roots={root_count} coalesced={coalesced} incomplete={}", server.lang, discovery.incomplete),
        );
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
            let root_started = Instant::now();
            let mut session_ms = 0;
            let mut lock_ms = 0;
            let mut search_ms = 0;
            let mut started = None;
            let result = async {
                let acquiring = Instant::now();
                let acquired = manager
                    .get_or_start_with_trace(&server.lang, &lang_root, project_id)
                    .await;
                session_ms = acquiring.elapsed().as_millis();
                let (session, cold_start) = acquired?;
                started = Some(cold_start);
                let locking = Instant::now();
                let mut guard = session.lock().await;
                lock_ms = locking.elapsed().as_millis();
                let searching = Instant::now();
                let response = if diagnostics {
                    if server.lang == "go" {
                        guard.warmup(&lang_root).await;
                    }
                    guard.workspace_diagnostics(limit).await
                } else {
                    guard.workspace_symbols_for_root(&query, &lang_root).await
                };
                search_ms = searching.elapsed().as_millis();
                response
            }
            .await;
            let outcome = if result.is_ok() { "ok" } else { "failed" };
            let root_label = lang_root
                .strip_prefix(&root)
                .map(|relative| {
                    if relative.as_os_str().is_empty() {
                        ".".to_string()
                    } else {
                        relative.display().to_string()
                    }
                })
                .unwrap_or_else(|_| "<outside-workspace>".to_string());
            queue_query_log(
                if result.is_ok() { "info" } else { "warn" },
                "workspace_query_root",
                format!("trace={trace} op={operation} language={} root={root_label} sessionMs={session_ms} sessionNew={started:?} lockWaitMs={lock_ms} searchMs={search_ms} totalMs={} outcome={outcome}", server.lang, root_started.elapsed().as_millis()),
            );
            match result {
                Ok(mut value) => {
                    if server.lang == "go" { scope_go_response(&mut value, &root, diagnostics); }
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
    let warning_count = warnings.len();
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
    queue_query_log(
        "info",
        "workspace_query_total",
        format!("trace={trace} op={operation} configMs={config_ms} totalMs={} successfulRoots={successful_roots} warningCount={warning_count} status={} resultCount={total}", query_started.elapsed().as_millis(), output["status"].as_str().unwrap_or("unknown")),
    );
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
