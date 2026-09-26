//! Analysis-stage hints rendered exclusively from the final request tool list.

use crate::mcp::servers::lsp::prompt_context::ToolSnapshot;

/// Compatibility for non-request callers; request construction uses the pure
/// renderer below with its already-collected (and whitelist-filtered) tools.
#[allow(dead_code)]
pub(crate) async fn build_analysis_tools_lines(
    project_id: Option<&str>,
    project_root: Option<&std::path::Path>,
) -> Vec<String> {
    let tools = crate::mcp::tools::collect_all_mcp_tools_for_workspace(
        project_id,
        project_root,
        false,
        false,
    )
    .await
    .unwrap_or_default();
    let tools = if project_root.is_some_and(|root| {
        crate::mcp::servers::remote_workspace::is_ssh_path(&root.to_string_lossy())
    }) {
        tools
            .into_iter()
            .filter(|tool| tool.server_id != "lsp")
            .collect::<Vec<_>>()
    } else {
        tools
    };
    analysis_tools_lines(&ToolSnapshot::from_tools(&tools))
}

pub(crate) fn analysis_tools_lines(tools: &ToolSnapshot) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(line) = tools.analysis_tools_line() {
        lines.push(line);
    }
    if tools.has("codebase-search") {
        lines.push("- `codebase-search` - Concept-level search over the project index (not symbol-accurate)".to_string());
    }
    if tools.has("grep-search") {
        lines.push("- `grep-search` - Search literal strings/patterns; text matches are not semantic references".to_string());
    }
    if tools.has("filesystem-read") {
        lines
            .push("- `filesystem-read` - Read raw source to understand implementation".to_string());
    }
    for name in [
        "codelens-find_definition",
        "codelens-find_references",
        "codelens-file_outline",
    ] {
        if tools.has(name) {
            lines.push(format!(
                "- `{name}` - Static-analysis fallback for unsupported languages or operations"
            ));
        }
    }
    lines.extend(tools.required_workflow_lines());
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_baseline_tools_are_not_advertised() {
        assert!(analysis_tools_lines(&ToolSnapshot::default()).is_empty());
        let snapshot = ToolSnapshot::from_names(["filesystem-read".to_string()]);
        let lines = analysis_tools_lines(&snapshot);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("filesystem-read"));
        assert!(!lines.join("\n").contains("grep-search"));
    }
}
