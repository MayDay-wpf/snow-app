//! Request-local tool visibility and pure routing text. No session/global cache.

use std::collections::{BTreeMap, BTreeSet};

pub(crate) use super::config::tool_exposure_for_workspace;

use crate::mcp::tools::McpTool;

pub use super::config::resolve_analysis_workspace_root;

/// Built from the same final tool list that is serialized into a provider request.
#[derive(Default)]
pub struct ToolSnapshot {
    names: BTreeSet<String>,
    summaries: BTreeMap<String, String>,
}

const ROUTES: &[(&str, &str)] = &[
    (
        "lsp-goto",
        "Locate symbol definitions, type definitions or implementations in batches (supply items: [target])",
    ),
    (
        "lsp-references",
        "Find symbol usages / assess impact in batches (supply items: [target])",
    ),
    (
        "lsp-hover",
        "Inspect symbol types, signatures and documentation in batches (supply items: [target])",
    ),
    (
        "lsp-symbols",
        "Read file symbol outlines in batches (supply filePaths: [path])",
    ),
    (
        "lsp-workspace-symbols",
        "Find symbols by name across the workspace",
    ),
    ("lsp-call-hierarchy", "Inspect incoming and outgoing calls"),
    (
        "lsp-type-hierarchy",
        "Inspect parent types and implementations",
    ),
    (
        "lsp-rename",
        "Rename a symbol (preview with dryRun=true before applying)",
    ),
    (
        "lsp-diagnostics",
        "Check changed files for language-server diagnostics (not a replacement for builds/tests)",
    ),
    (
        "lsp-workspace-diagnostics",
        "Survey workspace diagnostics after a large refactor",
    ),
    (
        "lsp-vulncheck",
        "Check Go dependencies for known vulnerabilities",
    ),
];

impl ToolSnapshot {
    pub(crate) fn from_names(names: impl IntoIterator<Item = String>) -> Self {
        Self {
            names: names.into_iter().collect(),
            summaries: BTreeMap::new(),
        }
    }

    pub fn from_tools(tools: &[McpTool]) -> Self {
        let mut snapshot = Self::from_names(tools.iter().map(McpTool::full_name));
        snapshot.summaries = tools
            .iter()
            .filter(|tool| tool.server_id == "lsp")
            .filter_map(|tool| {
                tool.description
                    .split_once("\n\nCurrent tool support:\n")
                    .map(|(_, summary)| {
                        (
                            tool.full_name(),
                            summary.split("\n\n").next().unwrap_or_default().to_string(),
                        )
                    })
            })
            .collect();
        snapshot
    }

    pub fn has(&self, name: &str) -> bool {
        self.names.contains(name)
    }

    fn lsp_names(&self) -> Vec<&str> {
        self.names
            .iter()
            .filter(|name| name.starts_with("lsp-"))
            .map(String::as_str)
            .collect()
    }

    pub(crate) fn routing_lines(&self) -> Vec<String> {
        ROUTES
            .iter()
            .filter(|(name, _)| self.has(name))
            .map(|(name, task)| format!("- {task} → `{name}`"))
            .collect()
    }

    pub fn analysis_tools_line(&self) -> Option<String> {
        let names = self.lsp_names();
        if names.is_empty() {
            return None;
        }
        Some(format!("- Semantic code tools — prefer these for the languages and operations they support: {}",
            names.iter().map(|name| format!("`{name}`")).collect::<Vec<_>>().join(" / ")))
    }

    /// Required only for the current change and supported target language /
    /// operation. This is guidance, never an authorization bypass.
    pub fn required_workflow_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        if self.has("lsp-workspace-symbols") || self.has("lsp-goto") {
            let mut methods = Vec::new();
            if self.has("lsp-workspace-symbols") {
                methods.push("`lsp-workspace-symbols` (for name-based symbol discovery across workspace)");
            }
            if self.has("lsp-goto") {
                methods.push("`lsp-goto` (for definition/implementation jump)");
            }
            let fallback_target = if self.has("grep-search") {
                "text search (`grep-search`)"
            } else {
                "text search"
            };
            lines.push(format!(
                "- To locate or navigate to functions, types, classes, or symbols in supported code, you MUST use {} instead of {}.",
                methods.join(" or "),
                fallback_target
            ));
        }
        if self.has("lsp-references") {
            lines.push("- Before changing a shared symbol, you MUST inspect impact with `lsp-references` when it is available and supports the target language/operation.".to_string());
        }
        if self.has("lsp-rename") {
            lines.push("- For a supported semantic rename, you MUST preview `lsp-rename` with dryRun=true and review the edits before dryRun=false; pass the returned previewId and apply only with the required authorization and unchanged preview inputs/files.".to_string());
        }
        if self.has("lsp-diagnostics") {
            lines.push("- After changing source code, you MUST check supported changed files with `lsp-diagnostics`: supply filePaths as an array of at most 30 paths (pass [path] for a single file). This does not replace required builds/tests.".to_string());
        }
        if !lines.is_empty() {
            lines.push("- Run only checks relevant to this change, not the whole tool suite every time. Reuse an existing complete, successful result only when the same document versions, relevant dependencies/configuration and analysis scope are unchanged. For unavailable/unsupported/failed checks, explain the limitation and use permitted fallbacks; never enable or bypass disabled tools, whitelist restrictions or authorization to satisfy a MUST.".to_string());
        }
        lines
    }

    pub fn system_prompt_section(&self) -> String {
        if self.lsp_names().is_empty() {
            return String::new();
        }
        let mut lines = vec!["## Language Servers".to_string(), String::new()];
        for (name, summary) in &self.summaries {
            if self.has(name) {
                lines.push(format!("- `{name}`: {summary}"));
            }
        }
        lines.extend(self.required_workflow_lines());
        lines.push("The following semantic tools are available in this request. When exploring, navigating, modifying, or reviewing code in supported languages, you MUST prioritize these semantic tools over general text search.".to_string());
        if let Some(line) = self.analysis_tools_line() {
            lines.push(line);
        }
        lines.extend(self.routing_lines());
        let items_addressing = [
            "lsp-hover",
            "lsp-goto",
            "lsp-references",
        ]
        .into_iter()
        .filter(|name| self.has(name))
        .map(|name| format!("`{name}`"))
        .collect::<Vec<_>>();
        if !items_addressing.is_empty() {
            lines.push(format!("- {} require an `items` array (use a 1-element array for one target); each item may use a symbol or 1-indexed line/column coordinates. Specify filePath when known to narrow scope; handle ambiguity and partial results before drawing conclusions.", items_addressing.join(", ")));
        }
        let file_paths_addressing = [
            "lsp-symbols",
            "lsp-diagnostics",
        ]
        .into_iter()
        .filter(|name| self.has(name))
        .map(|name| format!("`{name}`"))
        .collect::<Vec<_>>();
        if !file_paths_addressing.is_empty() {
            lines.push(format!("- {} require a `filePaths` array of absolute paths (pass [path] for a single file).", file_paths_addressing.join(", ")));
        }
        let direct_addressing = [
            "lsp-workspace-symbols",
            "lsp-call-hierarchy",
            "lsp-type-hierarchy",
            "lsp-rename",
            "lsp-workspace-diagnostics",
            "lsp-vulncheck",
        ]
        .into_iter()
        .filter(|name| self.has(name))
        .map(|name| format!("`{name}`"))
        .collect::<Vec<_>>();
        if !direct_addressing.is_empty() {
            lines.push(format!("- {} accept direct top-level arguments (e.g. `query`, `symbol`, `filePath`, `line`, `column`, `newName`, `maxFiles`, `dir`), not wrapped in an items array.", direct_addressing.join(", ")));
        }
        if self.has("lsp-workspace-symbols") {
            lines.push("- `lsp-workspace-symbols` (flat args: `query`, optional `workspaceRoot`): Top-level symbol discovery by name across the workspace without requiring file path or line coordinates. Use as the FIRST-STEP locator.".to_string());
        }
        if self.has("lsp-goto") {
            lines.push("- `lsp-goto` (array: `items: [...]` with `symbol`, `filePath`, `line`, `column`, `kind`): Precise semantic jump. Specify `kind` as `definition`, `type-definition`, or `implementation`.".to_string());
        }
        if self.has("lsp-references") {
            lines.push("- `lsp-references` (array: `items: [...]` with `symbol`, `filePath`, `line`, `column`, optional `includeDeclaration`): Find all callers and references across the project. Mandatory before altering shared symbols.".to_string());
        }
        if self.has("lsp-hover") {
            lines.push("- `lsp-hover` (array: `items: [...]` with `symbol`, `filePath`, `line`, `column`): Inspect symbol types, function signatures, and doc comments. Prefer over reading whole files when only types/signatures are needed.".to_string());
        }
        if self.has("lsp-symbols") {
            lines.push("- `lsp-symbols` (array: `filePaths: [...]` of absolute paths): Extract structural symbol outlines (classes, functions, methods) for single or multiple files.".to_string());
        }
        if self.has("lsp-diagnostics") {
            lines.push("- `lsp-diagnostics` (array: `filePaths: [...]` of absolute paths, max 30): Compile and type-check changed files. Mandatory after modifying supported source code.".to_string());
        }
        if self.has("lsp-rename") {
            lines.push("- `lsp-rename` (flat args: `newName`, `dryRun`, optional `previewId`, `symbol`, `filePath`, `line`, `column`): Safe semantic rename across files. Always preview with `dryRun=true` first, then apply with the returned `previewId`.".to_string());
        }
        if self.has("lsp-call-hierarchy") {
            lines.push("- `lsp-call-hierarchy` (flat args: `symbol`, `filePath`, `line`, `column`): Static call graph analysis (incoming callers / outgoing callees). Use to trace caller/callee execution flow.".to_string());
        }
        if self.has("lsp-type-hierarchy") {
            lines.push("- `lsp-type-hierarchy` (flat args: `symbol`, `filePath`, `line`, `column`): Inspect class/interface inheritance hierarchies (supertypes / subtypes / implementations).".to_string());
        }
        if self.has("lsp-workspace-diagnostics") {
            lines.push("- `lsp-workspace-diagnostics` (flat args: optional `maxFiles`, `workspaceRoot`): Workspace-wide diagnostics aggregation across all files. Use after large refactoring or multi-file edits.".to_string());
        }
        if self.has("lsp-vulncheck") {
            lines.push("- `lsp-vulncheck` (flat args: optional `dir`, `pattern`): Check Go dependencies for known security vulnerabilities using official govulncheck database.".to_string());
        }
        if self.has("grep-search") {
            lines.push("- `grep-search` is for literal strings/patterns (logs, config keys, comments); text matches are not proof of semantic references.".to_string());
        }
        if self.has("filesystem-read") {
            lines.push("- `filesystem-read` provides raw source when a language or operation is not covered, or semantic results need context.".to_string());
        }
        if self.has("grep-search") {
            lines.push("MANDATORY: Use semantic language-server tools for code navigation, symbol discovery, impact analysis, and diagnostics. Use fallback text search (`grep-search`) ONLY for non-code text (logs, configuration files, natural language) or when language servers are unavailable/unsupported.".to_string());
        } else {
            lines.push("MANDATORY: Use semantic language-server tools for code navigation, symbol discovery, impact analysis, and diagnostics. Use fallback text search ONLY for non-code text (logs, configuration files, natural language) or when language servers are unavailable/unsupported.".to_string());
        }
        lines.join("\n")
    }

    pub(crate) fn grep_hint(&self) -> Option<String> {
        let routes = self.routing_lines();
        if routes.is_empty() {
            return None;
        }
        Some(format!("STRICT RESTRICTION: grep-search is strictly for literal non-code text (log messages, configuration files, natural language). Text matches cannot distinguish a semantic reference from a same-named symbol, comment or string literal. For any code navigation or symbol query supported by the configured language servers, you MUST use the corresponding LSP tool instead:\n{}\nKeep grep for literal text; unsupported languages/operations may require fallback analysis.", routes.join("\n")))
    }
}

/// Append cross-tool recommendations only after the final whitelist is known.
/// Static schemas must describe only their own operation; dynamic references
/// live here so disabled tools can never leak through a shared description.
pub(crate) fn append_tool_guidance(tools: &mut [McpTool]) {
    let snapshot = ToolSnapshot::from_tools(tools);
    let workflow = snapshot.required_workflow_lines();
    for tool in tools {
        let name = tool.full_name();
        if name == "grep-search" {
            if let Some(hint) = snapshot.grep_hint() {
                tool.description.push_str(&format!("\n\n{hint}"));
            }
        }
        let source_write = matches!(
            name.as_str(),
            "filesystem-create" | "filesystem-replace_edit" | "filesystem-copy"
        );
        let mut applicable = workflow
            .iter()
            .filter(|line| {
                (source_write
                    && (line.contains("`lsp-references`") || line.contains("`lsp-diagnostics`")))
                    || (tool.server_id == "lsp" && line.contains(&format!("`{name}`")))
                    || (name == "lsp-rename" && line.contains("`lsp-references`"))
            })
            .cloned()
            .collect::<Vec<_>>();
        if !applicable.is_empty() {
            if let Some(boundary) = workflow.last() {
                applicable.push(boundary.clone());
            }
            tool.description.push_str(&format!(
                "\n\nConditional workflow requirements:\n{}",
                applicable.join("\n")
            ));
        }
    }
}
