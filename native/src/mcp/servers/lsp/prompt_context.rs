//! Request-local tool visibility and pure routing text. No session/global cache.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub(crate) use super::config::{resolve_analysis_workspace_root, tool_exposure_for_workspace};

use crate::mcp::tools::McpTool;

/// Built from the same final tool list that is serialized into a provider request.
#[derive(Default)]
pub(crate) struct ToolSnapshot {
    names: BTreeSet<String>,
    summaries: BTreeMap<String, String>,
}

const ROUTES: &[(&str, &str)] = &[
    ("lsp-goto", "Locate a symbol's definition (kind=definition)"),
    (
        "lsp-references",
        "Find symbol usages / assess impact before editing",
    ),
    (
        "lsp-hover",
        "Inspect a symbol's type, signature and documentation",
    ),
    ("lsp-symbols", "Read a file's symbol outline"),
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

    pub(crate) fn from_tools(tools: &[McpTool]) -> Self {
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

    pub(crate) fn has(&self, name: &str) -> bool {
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

    pub(crate) fn analysis_tools_line(&self) -> Option<String> {
        let names = self.lsp_names();
        if names.is_empty() {
            return None;
        }
        Some(format!("- Semantic code tools — prefer these for the languages and operations they support: {}",
            names.iter().map(|name| format!("`{name}`")).collect::<Vec<_>>().join(" / ")))
    }

    /// Required only for the current change and supported target language /
    /// operation. This is guidance, never an authorization bypass.
    pub(crate) fn required_workflow_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        if self.has("lsp-references") {
            lines.push("- Before changing a shared symbol, you MUST inspect impact with `lsp-references` when it is available and supports the target language/operation.".to_string());
        }
        if self.has("lsp-rename") {
            lines.push("- For a supported semantic rename, you MUST preview `lsp-rename` with dryRun=true and review the edits before dryRun=false; pass the returned previewId and apply only with the required authorization and unchanged preview inputs/files.".to_string());
        }
        if self.has("lsp-diagnostics") {
            lines.push("- After changing source code, you MUST check supported changed files with `lsp-diagnostics`: use filePath for one file or filePaths in batches of at most 30. This does not replace required builds/tests.".to_string());
        }
        if !lines.is_empty() {
            lines.push("- Run only checks relevant to this change, not the whole tool suite every time. Reuse an existing complete, successful result only when the same document versions, relevant dependencies/configuration and analysis scope are unchanged. For unavailable/unsupported/failed checks, explain the limitation and use permitted fallbacks; never enable or bypass disabled tools, whitelist restrictions or authorization to satisfy a MUST.".to_string());
        }
        lines
    }

    pub(crate) fn system_prompt_section(&self) -> String {
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
        lines.push("The following semantic tools are available in this request. Availability does not mean a server is running or pre-warmed; a call may start it and initialization/indexing may take time. Support varies by language, file type and operation.".to_string());
        if let Some(line) = self.analysis_tools_line() {
            lines.push(line);
        }
        lines.extend(self.routing_lines());
        let addressing = [
            "lsp-hover",
            "lsp-goto",
            "lsp-references",
            "lsp-rename",
            "lsp-call-hierarchy",
            "lsp-type-hierarchy",
        ]
        .into_iter()
        .filter(|name| self.has(name))
        .map(|name| format!("`{name}`"))
        .collect::<Vec<_>>();
        if !addressing.is_empty() {
            lines.push(format!("- {} accept a symbol name or 1-indexed line/column coordinates. Specify filePath when known to narrow scope; handle ambiguity and partial results before drawing conclusions.", addressing.join(", ")));
        }
        if self.has("grep-search") {
            lines.push("- `grep-search` is for literal strings/patterns (logs, config keys, comments); text matches are not proof of semantic references.".to_string());
        }
        if self.has("filesystem-read") {
            lines.push("- `filesystem-read` provides raw source when a language or operation is not covered, or semantic results need context.".to_string());
        }
        lines.push("Prefer the available semantic tool for supported queries. For unsupported languages/operations or failed semantic analysis, use available fallback tools and state their limitations.".to_string());
        lines.join("\n")
    }

    pub(crate) fn grep_hint(&self) -> Option<String> {
        let routes = self.routing_lines();
        if routes.is_empty() {
            return None;
        }
        Some(format!("Text matches cannot distinguish a semantic reference from a same-named symbol, comment or string literal. For a semantic query supported by the configured language servers, prefer an available tool:\n{}\nKeep grep for literal text; unsupported languages/operations may require fallback analysis.", routes.join("\n")))
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

/// Compatibility for callers without a prepared request. Request builders must
/// use ToolSnapshot::from_tools instead, after applying the sub-agent whitelist.
pub(crate) async fn build_system_prompt_section(
    project_id: Option<&str>,
    project_root: Option<&Path>,
) -> String {
    if project_root
        .is_some_and(|root| super::super::remote_workspace::is_ssh_path(&root.to_string_lossy()))
    {
        return String::new();
    }
    let tools = crate::mcp::tools::collect_all_mcp_tools_for_workspace(
        project_id,
        project_root,
        false,
        false,
    )
    .await
    .unwrap_or_default();
    ToolSnapshot::from_tools(&tools).system_prompt_section()
}

pub(crate) async fn analysis_tools_line(
    project_id: Option<&str>,
    project_root: Option<&Path>,
) -> Option<String> {
    if project_root
        .is_some_and(|root| super::super::remote_workspace::is_ssh_path(&root.to_string_lossy()))
    {
        return None;
    }
    let tools = crate::mcp::tools::collect_all_mcp_tools_for_workspace(
        project_id,
        project_root,
        false,
        false,
    )
    .await
    .ok()?;
    ToolSnapshot::from_tools(&tools).analysis_tools_line()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conditional_musts_are_visible_applicable_and_authorization_bounded() {
        let snapshot = ToolSnapshot::from_names(
            ["lsp-references", "lsp-rename", "lsp-diagnostics"].map(str::to_string),
        );
        let rules = snapshot.required_workflow_lines().join("\n");
        for expected in [
            "MUST",
            "target language/operation",
            "dryRun=true",
            "previewId",
            "at most 30",
            "same document versions",
            "authorization",
            "permitted fallbacks",
            "not the whole tool suite",
        ] {
            assert!(rules.contains(expected), "{expected}");
        }
        let hover_only = ToolSnapshot::from_names(["lsp-hover".to_string()]);
        assert!(hover_only.required_workflow_lines().is_empty());
    }

    #[test]
    fn descriptions_do_not_recommend_disabled_checks() {
        let tool = |server: &str, name: &str| McpTool {
            server_id: server.into(),
            name: name.into(),
            description: "operation".into(),
            input_schema: serde_json::json!({"type": "object"}),
        };
        let mut tools = vec![
            tool("filesystem", "replace_edit"),
            tool("lsp", "references"),
        ];
        append_tool_guidance(&mut tools);
        assert!(tools[0].description.contains("MUST"));
        assert!(tools[0].description.contains("`lsp-references`"));
        assert!(!tools[0].description.contains("lsp-diagnostics"));
        assert!(!tools[0].description.contains("lsp-rename"));
    }

    #[test]
    fn support_summaries_stay_per_tool_and_exclude_appended_guidance() {
        let tools = vec![McpTool {
            server_id: "lsp".into(), name: "workspace-diagnostics".into(),
            description: "Diagnostics\n\nCurrent tool support:\nApplicable server configurations: rust\n\nConditional workflow requirements:\nnot metadata".into(),
            input_schema: serde_json::json!({"type": "object"}),
        }];
        let snapshot = ToolSnapshot::from_tools(&tools);
        assert_eq!(
            snapshot.summaries["lsp-workspace-diagnostics"],
            "Applicable server configurations: rust"
        );
        assert!(!snapshot.system_prompt_section().contains("typescript"));
        assert!(!snapshot.system_prompt_section().contains("not metadata"));
    }

    #[test]
    fn hover_only_does_not_require_representative_core_tools() {
        let snapshot = ToolSnapshot::from_names(["lsp-hover".to_string()]);
        let section = snapshot.system_prompt_section();
        assert!(section.contains("`lsp-hover`"));
        for absent in [
            "lsp-goto",
            "lsp-references",
            "lsp-diagnostics",
            "grep-search",
            "filesystem-read",
        ] {
            assert!(!section.contains(absent), "unexpected {absent}");
        }
        assert_eq!(snapshot.routing_lines().len(), 1);
        assert!(!snapshot.grep_hint().unwrap().contains("lsp-goto"));
    }

    #[test]
    fn no_lsp_no_semantic_hint() {
        let snapshot = ToolSnapshot::from_names(["grep-search".to_string()]);
        assert!(snapshot.system_prompt_section().is_empty());
        assert!(snapshot.analysis_tools_line().is_none());
        assert!(snapshot.grep_hint().is_none());
    }

    #[test]
    fn every_route_is_filtered_independently() {
        for (visible, _) in ROUTES {
            let snapshot = ToolSnapshot::from_names([visible.to_string()]);
            let rendered = format!(
                "{}\n{}",
                snapshot.system_prompt_section(),
                snapshot.grep_hint().unwrap()
            );
            for (name, _) in ROUTES {
                assert_eq!(
                    rendered.contains(&format!("`{name}`")),
                    name == visible,
                    "{visible}: {name}"
                );
            }
        }
    }

    #[test]
    fn provider_tool_names_and_prompt_use_the_same_snapshot() {
        let tools = vec![McpTool {
            server_id: "lsp".to_string(),
            name: "hover".to_string(),
            description:
                "Hover\n\nCurrent tool support:\nApplicable server configurations: rust (rust-analyzer)"
                    .to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        }];
        let snapshot = ToolSnapshot::from_tools(&tools);
        assert!(snapshot
            .system_prompt_section()
            .contains("rust (rust-analyzer)"));
        for serialized in [
            crate::mcp::tools::tools_as_openai_chat_json(&tools),
            crate::mcp::tools::tools_as_openai_responses_json(&tools),
            crate::mcp::tools::tools_as_anthropic_json(&tools),
            crate::mcp::tools::tools_as_gemini_json(&tools),
            crate::mcp::tools::tools_as_interactions_json(&tools),
        ] {
            assert!(serialized.to_string().contains("lsp-hover"));
            assert!(!serialized.to_string().contains("lsp-goto"));
        }
        assert!(!snapshot.system_prompt_section().contains("lsp-goto"));
    }

    #[test]
    fn request_order_does_not_change_routing_text() {
        let a = ToolSnapshot::from_names(["lsp-hover".to_string(), "lsp-goto".to_string()]);
        let b = ToolSnapshot::from_names(["lsp-goto".to_string(), "lsp-hover".to_string()]);
        assert_eq!(a.system_prompt_section(), b.system_prompt_section());
    }
}
