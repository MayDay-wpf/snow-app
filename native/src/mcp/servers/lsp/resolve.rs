//! Symbol addressing uses complete server responses and verified selection ranges.
// Runtime capabilities are checked on each initialized session.
use super::detect;
use super::manager::ServerManager;
use super::session::{read_line_context, ServerSession};
use super::types::{LspError, ServerConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolCandidate {
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    pub preview: String,
}

pub enum ResolvedTarget {
    Exact {
        path: PathBuf,
        line: u32,
        column: u32,
    },
    Ambiguous(Value),
}

pub enum GlobalResolvedTarget {
    Exact {
        path: PathBuf,
        line: u32,
        column: u32,
        lang: String,
    },
    Ambiguous(Value),
}

struct MatchItem {
    line: u32,
    column: u32,
    kind: String,
    container: Option<String>,
    precise: bool,
}

fn positive_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0)
}

fn collect_matching_document_symbols(symbols: &Value, name: &str, out: &mut Vec<MatchItem>) {
    let Some(items) = symbols.as_array() else {
        return;
    };
    for item in items {
        if item.get("name").and_then(Value::as_str) == Some(name) {
            let selection = item.get("selection").and_then(|s| s.get("start"));
            let position = selection.or_else(|| item.get("range").and_then(|r| r.get("start")));
            let line = positive_u32(position.and_then(|p| p.get("line")));
            let column = positive_u32(position.and_then(|p| p.get("column")));
            out.push(MatchItem {
                line: line.unwrap_or(0),
                column: column.unwrap_or(0),
                kind: item
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .into(),
                container: item
                    .get("detail")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                precise: selection.is_some() && line.is_some() && column.is_some(),
            });
        }
        collect_matching_document_symbols(&item["children"], name, out);
    }
}

async fn resolve_document_matches(
    path: &Path,
    symbol: &str,
    matches: Vec<MatchItem>,
) -> ResolvedTarget {
    if matches.len() == 1 && matches[0].precise {
        return ResolvedTarget::Exact {
            path: path.to_path_buf(),
            line: matches[0].line,
            column: matches[0].column,
        };
    }
    let mut candidates = Vec::new();
    for item in matches {
        candidates.push(SymbolCandidate {
            file_path: path.to_string_lossy().into_owned(),
            line: item.line,
            column: item.column,
            kind: item.kind,
            container: item.container,
            preview: read_line_context(path, item.line.saturating_sub(1)).await,
        });
    }
    ResolvedTarget::Ambiguous(json!({
        "status": "ambiguous_symbol", "symbol": symbol, "count": candidates.len(),
        "requiresExplicitCoordinates": true,
        "message": "No unique verified selectionRange. Candidate ranges are navigation hints, not safe edit positions; inspect the declaration and supply explicit filePath/line/column.",
        "candidates": candidates,
    }))
}

/// Reject clipped/partial responses before interpreting uniqueness.
pub(crate) fn workspace_response_complete(value: &Value) -> bool {
    let Some(symbols) = value.get("symbols").and_then(Value::as_array) else {
        return false;
    };
    !value
        .get("incomplete")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && !matches!(
            value.get("status").and_then(Value::as_str),
            Some("failed" | "partial" | "partial_symbol_search")
        )
        && value.get("error").is_none_or(Value::is_null)
        && !value
            .get("partial")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        && !value
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        && value
            .get("total")
            .and_then(Value::as_u64)
            .unwrap_or(symbols.len() as u64)
            <= symbols.len() as u64
        && value
            .get("warnings")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        && symbols.iter().all(|item| {
            item.get("filePath")
                .and_then(Value::as_str)
                .is_some_and(|p| !p.trim().is_empty())
        })
}

pub async fn resolve_symbol_or_coords(
    session: &mut ServerSession,
    file_path: &Path,
    args: &Value,
) -> Result<ResolvedTarget, LspError> {
    if let (Some(line), Some(column)) = (
        positive_u32(args.get("line")),
        positive_u32(args.get("column")),
    ) {
        return Ok(ResolvedTarget::Exact {
            path: file_path.to_path_buf(),
            line,
            column,
        });
    }
    let symbol = args
        .get("symbol")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| LspError::Internal("Provide positive u32 line/column or symbol".into()))?;
    session.ensure_open(file_path).await?;
    let doc = session.document_symbols(file_path).await?;
    let mut local = Vec::new();
    collect_matching_document_symbols(&doc["symbols"], symbol, &mut local);
    if !local.is_empty() {
        return Ok(resolve_document_matches(file_path, symbol, local).await);
    }
    let workspace = session.workspace_symbols(symbol).await?;
    let mut matches = Vec::new();
    collect_matching_workspace_symbols(
        &workspace,
        symbol,
        &session.lang,
        Some(&session.project_root),
        &mut HashSet::new(),
        &mut matches,
    );
    if !workspace_response_complete(&workspace) {
        return Ok(ResolvedTarget::Ambiguous(
            candidate_response(
                symbol,
                &matches,
                vec![json!({"error":"Workspace response is partial or truncated"})],
            )
            .await,
        ));
    }
    if matches.len() == 1 {
        let path = PathBuf::from(&matches[0].file_path);
        session.ensure_open(&path).await?;
        let doc = session.document_symbols(&path).await?;
        let mut precise = Vec::new();
        collect_matching_document_symbols(&doc["symbols"], symbol, &mut precise);
        return Ok(resolve_document_matches(&path, symbol, precise).await);
    }
    if matches.is_empty() {
        return Err(LspError::Internal(format!(
            "Symbol '{symbol}' not found in this file or language workspace"
        )));
    }
    Ok(ResolvedTarget::Ambiguous(
        candidate_response(symbol, &matches, Vec::new()).await,
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceSymbolMatch {
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub kind: String,
    pub container: Option<String>,
    pub lang: String,
}

fn path_identity(path: &Path) -> String {
    let physical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = physical.to_string_lossy().replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text);
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text.to_string()
    }
}

pub(crate) fn collect_matching_workspace_symbols(
    value: &Value,
    symbol: &str,
    lang: &str,
    root: Option<&Path>,
    seen: &mut HashSet<(String, u32, u32)>,
    out: &mut Vec<WorkspaceSymbolMatch>,
) {
    let Some(items) = value
        .get("symbols")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
    else {
        return;
    };
    for item in items {
        if item.get("name").and_then(Value::as_str) != Some(symbol) {
            continue;
        }
        let Some(raw) = item
            .get("filePath")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        else {
            continue;
        };
        let path = Path::new(raw);
        let path = if path.is_relative() {
            root.map(|r| r.join(path))
                .unwrap_or_else(|| path.to_path_buf())
        } else {
            path.to_path_buf()
        };
        let line = positive_u32(item.get("line")).unwrap_or(0);
        let column = positive_u32(item.get("column")).unwrap_or(0);
        if !seen.insert((path_identity(&path), line, column)) {
            continue;
        }
        out.push(WorkspaceSymbolMatch {
            file_path: path.to_string_lossy().into_owned(),
            line,
            column,
            kind: item
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .into(),
            container: item
                .get("detail")
                .and_then(Value::as_str)
                .map(str::to_string),
            lang: lang.into(),
        });
    }
}

async fn candidate_response(
    symbol: &str,
    matches: &[WorkspaceSymbolMatch],
    warnings: Vec<Value>,
) -> Value {
    let mut candidates = Vec::new();
    for item in matches.iter().take(50) {
        candidates.push(SymbolCandidate {
            file_path: item.file_path.clone(),
            line: item.line,
            column: item.column,
            kind: item.kind.clone(),
            container: item.container.clone(),
            preview: read_line_context(Path::new(&item.file_path), item.line.saturating_sub(1))
                .await,
        });
    }
    json!({
        "status": if warnings.is_empty() { "ambiguous_symbol" } else { "partial_symbol_search" },
        "symbol": symbol, "count": candidates.len(), "total": matches.len(),
        "partial": !warnings.is_empty(), "truncated": matches.len() > candidates.len(),
        "requiresExplicitCoordinates": true,
        "message": "Uniqueness is not established. Supply an explicit file and verified coordinates; no operation was executed.",
        "warnings": warnings, "candidates": candidates,
    })
}

/// Backward-compatible entry point; explicit-root callers should use the function below.
pub async fn resolve_symbol_workspace_global(
    manager: &ServerManager,
    configs: &[ServerConfig],
    project_id: Option<&str>,
    symbol: &str,
) -> Result<GlobalResolvedTarget, LspError> {
    resolve_symbol_workspace_global_in_root(manager, configs, project_id, symbol, None).await
}

pub async fn resolve_symbol_workspace_global_in_root(
    manager: &ServerManager,
    configs: &[ServerConfig],
    project_id: Option<&str>,
    symbol: &str,
    workspace_root: Option<&Path>,
) -> Result<GlobalResolvedTarget, LspError> {
    let project_root = match workspace_root {
        Some(root) => root.to_path_buf(),
        None => {
            let pid = project_id.map(str::to_string);
            tokio::task::spawn_blocking(move || -> Result<PathBuf, LspError> {
                if let Some(pid) = pid.filter(|p| !p.trim().is_empty()) {
                    let info = crate::storage::initialize_app_storage().map_err(|e| LspError::Internal(e.to_string()))?;
                    let root = crate::storage::services::workspace_directories::get_workspace_directory_path(&PathBuf::from(info.database_path), &pid)
                        .map_err(|e| LspError::Internal(e.to_string()))?
                        .ok_or_else(|| LspError::Internal("Project root unavailable; supply workspaceRoot".into()))?;
                    return Ok(PathBuf::from(root));
                }
                std::env::current_dir().map_err(|e| LspError::Internal(e.to_string()))
            }).await.map_err(|e| LspError::Internal(e.to_string()))??
        }
    };
    if !project_root.is_absolute() || !project_root.is_dir() {
        return Err(LspError::Internal(
            "workspaceRoot must be an existing absolute local directory".into(),
        ));
    }
    let mut matches = Vec::new();
    let mut seen = HashSet::new();
    let mut warnings = Vec::new();
    for config in configs
        .iter()
        .filter(|c| c.enabled && !c.file_extensions.is_empty())
    {
        let root = project_root.clone();
        let lang = config.lang.clone();
        let discovery =
            tokio::task::spawn_blocking(move || detect::discover_lang_roots(&root, &lang))
                .await
                .map_err(|e| LspError::Internal(e.to_string()))?;
        if discovery.incomplete {
            warnings.push(json!({"language":config.lang,"error":"Stack discovery is incomplete (scan budget, depth or unreadable path)"}));
        }
        for root in discovery.roots {
            let result = async {
                let session = manager
                    .get_or_start(&config.lang, &root, project_id)
                    .await?;
                let mut guard = session.lock().await;
                guard.workspace_symbols(symbol).await
            }
            .await;
            match result {
                Ok(value) => {
                    if !workspace_response_complete(&value) {
                        warnings.push(json!({"language":config.lang,"root":root,"error":"Partial workspace symbol response"}));
                    }
                    collect_matching_workspace_symbols(
                        &value,
                        symbol,
                        &config.lang,
                        Some(&root),
                        &mut seen,
                        &mut matches,
                    );
                }
                Err(error) => warnings
                    .push(json!({"language":config.lang,"root":root,"error":format!("{error:?}")})),
            }
        }
    }
    if !warnings.is_empty() || matches.len() > 1 {
        return Ok(GlobalResolvedTarget::Ambiguous(
            candidate_response(symbol, &matches, warnings).await,
        ));
    }
    let Some(target) = matches.first() else {
        return Err(LspError::Internal(format!(
            "Symbol '{symbol}' not found in the available workspace servers"
        )));
    };
    let path = PathBuf::from(&target.file_path);
    let root =
        detect::find_lang_root(&project_root, path.parent(), &target.lang).ok_or_else(|| {
            LspError::NoLangStack(
                target.lang.clone(),
                detect::markers_for_lang(&target.lang).join(", "),
            )
        })?;
    let session = manager
        .get_or_start(&target.lang, &root, project_id)
        .await?;
    let mut guard = session.lock().await;
    guard.ensure_open(&path).await?;
    let doc = guard.document_symbols(&path).await?;
    let mut selected = Vec::new();
    collect_matching_document_symbols(&doc["symbols"], symbol, &mut selected);
    match resolve_document_matches(&path, symbol, selected).await {
        ResolvedTarget::Exact { path, line, column } => Ok(GlobalResolvedTarget::Exact {
            path,
            line,
            column,
            lang: target.lang.clone(),
        }),
        ResolvedTarget::Ambiguous(value) => Ok(GlobalResolvedTarget::Ambiguous(value)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flat_declaration_start_is_not_a_selection() {
        let mut matches = Vec::new();
        collect_matching_document_symbols(
            &json!([{"name":"f","range":{"start":{"line":1,"column":1}}}]),
            "f",
            &mut matches,
        );
        assert_eq!(matches.len(), 1);
        assert!(!matches[0].precise);
    }
    #[test]
    fn nested_selection_is_precise() {
        let mut matches = Vec::new();
        collect_matching_document_symbols(
            &json!([{"name":"module","children":[{"name":"f","selection":{"start":{"line":3,"column":8}}}]}]),
            "f",
            &mut matches,
        );
        assert!(matches[0].precise);
        assert_eq!((matches[0].line, matches[0].column), (3, 8));
    }
    #[test]
    fn partial_and_truncated_are_never_complete() {
        assert!(!workspace_response_complete(
            &json!({"symbols":[],"total":51})
        ));
        assert!(!workspace_response_complete(
            &json!({"symbols":[],"partial":true})
        ));
        assert!(!workspace_response_complete(
            &json!({"symbols":[],"warnings":["failed"]})
        ));
        assert!(workspace_response_complete(
            &json!({"symbols":[],"total":0})
        ));
    }
    #[test]
    fn coordinates_reject_zero_and_overflow() {
        assert_eq!(positive_u32(Some(&json!(0))), None);
        assert_eq!(positive_u32(Some(&json!(u64::MAX))), None);
        assert_eq!(positive_u32(Some(&json!(42))), Some(42));
    }
    #[test]
    fn relative_candidates_are_rebased_and_duplicates_removed() {
        let payload = json!({"symbols":[
            {"name":"f","filePath":"src/a.rs","line":3,"column":8},
            {"name":"f","filePath":"src/a.rs","line":3,"column":8},
            {"name":"other","filePath":"src/b.rs","line":3,"column":8}
        ]});
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut matches = Vec::new();
        collect_matching_workspace_symbols(
            &payload,
            "f",
            "rust",
            Some(root),
            &mut HashSet::new(),
            &mut matches,
        );
        assert_eq!(matches.len(), 1);
        assert_eq!(PathBuf::from(&matches[0].file_path), root.join("src/a.rs"));
    }
}
