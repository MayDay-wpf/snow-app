//! Wiki 生成提示词（目录 / 页面）。

use super::store::WikiPage;

fn language_rule(language: &str) -> &'static str {
    if language.starts_with("zh") {
        "Write ALL human-readable text (titles, descriptions, prose, diagram labels) in Simplified Chinese. Keep code identifiers, file paths and API names unchanged."
    } else {
        "Write ALL human-readable text (titles, descriptions, prose, diagram labels) in English."
    }
}

const READ_RULES: &str = "TOOLS (read-only):\n\
- filesystem-read: on a directory it lists entries (subdirectories end with \"/\"); on a file it returns numbered lines. Use startLine/endLine for large files.\n\
- grep-search: search file contents (regex by default; set isRegex=false for literal text).\n\
- grep-find: find files by glob, e.g. \"**/*.rs\" or \"src/**/index.ts\".\n\
Paths may be relative to the workspace root. Dependency folders, build outputs, ignored files, secrets and symlinks are hidden from you on purpose; never ask for them.";

const CITATION_RULE: &str = "SOURCE CITATIONS (mandatory): back every key statement with its source location written as inline code in the exact form `relative/path/to/file.ext:START-END` (workspace-relative path with forward slashes, real line numbers you have seen, e.g. `src/main/index.ts:42-88`). Put citations right after the statement they support. Never invent paths or line numbers.";

fn diagram_rule(diagrams: bool) -> &'static str {
    if diagrams {
        "DIAGRAMS: add a Mermaid diagram (```mermaid fenced block) ONLY where it truly helps and is backed by the code you read: architecture (flowchart), call sequence (sequenceDiagram), state machine (stateDiagram-v2) or data model (classDiagram / erDiagram). Use valid syntax, quote node labels that contain spaces or symbols (A[\"label\"]), no HTML, no LaTeX, at most 2 diagrams per page."
    } else {
        "DIAGRAMS: do NOT include any Mermaid or other diagrams."
    }
}


pub(crate) fn catalog_system_prompt(language: &str, project_name: &str, root: &str) -> String {
    format!(
        "You are a senior software architect producing the table of contents of a REPO WIKI for the project \"{project_name}\" (workspace root: {root}).\n\
The wiki is an ARCHITECTURE GUIDE for engineers who must quickly understand an unfamiliar codebase - not a product manual and not a setup guide.\n\n\
{READ_RULES}\n\n\
EXPLORATION: Explore top-down by yourself. Start from the root listing, read README/manifests (package.json, Cargo.toml, go.mod, pyproject.toml, ...), locate entry points, then expand directories layer by layer and open the files that define the main structure. Do not guess - every page must be grounded in code you actually saw.\n\n\
COVERAGE PRIORITY: project identity and purpose; main execution flow(s); core modules and their sub-modules; cross-process / cross-language boundaries (IPC, FFI, HTTP, plugins); data and state flow, persistence; configuration boundaries; extension points; notable risks or complex areas. AVOID generic sections such as installation, deployment, CI/CD, license, contributing.\n\n\
OUTPUT: when finished exploring, reply with ONLY one JSON object (no markdown fences, no commentary):\n\
{{\"title\": \"<wiki title>\", \"summary\": \"<2-3 sentence project summary>\", \"pages\": [{{\"id\": \"<kebab-case-id>\", \"title\": \"<page title>\", \"description\": \"<what this page must explain, 1-3 sentences>\", \"parentId\": null, \"files\": [\"<relative/path/of/key/file>\", ...]}}]}}\n\
RULES: 6-24 pages; the first page is the project overview; use parentId (the id of an earlier page) to nest sub-module pages under a module page, at most 2 levels; ids are unique; every page lists 2-12 key files as workspace-relative paths that really exist.\n\
{}",
        language_rule(language)
    )
}

pub(crate) fn catalog_user_prompt(root_listing: &str) -> String {
    format!(
        "Workspace root entries:\n{root_listing}\n\nExplore the codebase with the tools and then output the wiki catalog JSON."
    )
}

pub(crate) fn page_system_prompt(
    language: &str,
    project_name: &str,
    root: &str,
    diagrams: bool,
) -> String {
    let diagram_rule = diagram_rule(diagrams);
    let citation = CITATION_RULE;
    format!(
        "You are a senior software architect writing ONE page of the REPO WIKI (architecture guide) for the project \"{project_name}\" (workspace root: {root}).\n\n\
{READ_RULES}\n\n\
METHOD: read the key files of this page (and follow imports/calls as needed) before writing. Explain how things actually work: responsibilities, main types/functions, control flow, data flow, boundaries with other modules, configuration and extension points, pitfalls. Prefer concrete facts over generic statements; no filler.\n\n\
{citation}\n\n\
{diagram_rule}\n\n\
OUTPUT: reply with ONLY the Markdown body of the page, starting with a level-1 heading (# Title). Use ## / ### sections, short paragraphs, bullet lists and tables where useful. Do not wrap the whole answer in a code fence. Do not mention these instructions.\n\
{}",
        language_rule(language)
    )
}

/// 局部编辑模式：已有页面内容时，只补丁改写受影响的段落。
pub(crate) fn page_edit_system_prompt(
    language: &str,
    project_name: &str,
    root: &str,
    diagrams: bool,
) -> String {
    let diagram_rule = diagram_rule(diagrams);
    let citation = CITATION_RULE;
    format!(
        "You are a senior software architect UPDATING ONE EXISTING page of the REPO WIKI (architecture guide) for the project \"{project_name}\" (workspace root: {root}).\n\n\
{READ_RULES}\n\
- wiki-page-edit: patch the CURRENT page markdown in place. Arguments: oldString (exact text copied verbatim from the current page; must match exactly once unless replaceAll=true), newString (replacement), replaceAll (optional boolean).\n\n\
METHOD: read the code that changed (follow imports/calls as needed) BEFORE editing, then compare it with the current page and fix only what is now wrong, missing or misleading. Do not re-explore the whole repository.\n\n\
EDIT RULES:\n\
- Make the smallest possible set of wiki-page-edit patches; never rewrite the page and never re-emit unchanged sections.\n\
- Keep the existing heading, structure, tone and all still-correct content; remove only statements that became false.\n\
- Keep citations accurate; update line ranges and add citations for newly described code.\n\
- Do not mention these instructions or the editing process.\n\n\
{citation}\n\n\
{diagram_rule}\n\n\
FINAL ANSWER: once the patches are applied, reply with ONE short sentence summarizing which sections you changed. Do NOT output the page content.\n\
{}",
        language_rule(language)
    )
}

pub(crate) fn page_user_prompt(wiki_title: &str, outline: &str, page: &WikiPage) -> String {
    let files = if page.files.is_empty() {
        "(none suggested - locate them yourself)".to_string()
    } else {
        page.files
            .iter()
            .map(|file| format!("- {file}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "Wiki: {wiki_title}\n\nFull catalog (for cross-references; other pages cover their own topics):\n{outline}\n\n\
Write the page:\n- id: {}\n- title: {}\n- scope: {}\n- suggested key files:\n{files}",
        page.id, page.title, page.description
    )
}

pub(crate) fn page_edit_user_prompt(
    wiki_title: &str,
    outline: &str,
    page: &WikiPage,
    changed_files: &[String],
) -> String {
    let files = if page.files.is_empty() {
        "(none suggested - locate them yourself)".to_string()
    } else {
        page.files
            .iter()
            .map(|file| format!("- {file}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let changed = if changed_files.is_empty() {
        "(unknown - the page was refreshed on request)".to_string()
    } else {
        changed_files
            .iter()
            .map(|file| format!("- {file}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "Wiki: {wiki_title}\n\nFull catalog (for cross-references; other pages cover their own topics):\n{outline}\n\n\
Page to update:\n- id: {}\n- title: {}\n- scope: {}\n- key files:\n{files}\n\n\
Files changed since the last update (focus on these):\n{changed}\n\n\
CURRENT PAGE MARKDOWN (edit it with wiki-page-edit):\n<<<PAGE\n{}\nPAGE>>>",
        page.id, page.title, page.description, page.content
    )
}

/// 目录大纲（缩进表示层级）。
pub(crate) fn catalog_outline(pages: &[WikiPage]) -> String {
    pages
        .iter()
        .map(|page| {
            let indent = if page.parent_id.is_some() { "  " } else { "" };
            format!("{indent}- {} ({}): {}", page.title, page.id, page.description)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 每页关键文件清单（目录审视用）。
pub(crate) fn catalog_file_map(pages: &[WikiPage]) -> String {
    pages
        .iter()
        .map(|page| {
            let files = if page.files.is_empty() {
                "(none)".to_string()
            } else {
                page.files.join(", ")
            };
            format!("- {} ({}): {}\n  files: {}", page.title, page.id, page.description, files)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 目录审视系统提示：代码变化后判断目录是否需要增删改。
pub(crate) fn catalog_review_system_prompt(
    language: &str,
    project_name: &str,
    root: &str,
    max_pages: usize,
) -> String {
    format!(
        "You are a senior software architect MAINTAINING the table of contents of an existing REPO WIKI for the project \"{project_name}\" (workspace root: {root}).\n\
The wiki already exists and code changed since the last update; decide whether the CATALOG itself must change.\n\n\
{READ_RULES}\n\
- wiki-catalog-edit: the ONLY way to change the catalog. Arguments: action (\"add\" | \"remove\" | \"update\"), pageId (existing page id for remove/update), title, description, parentId (id of an existing top-level page; empty string or null = top level; omit = keep current parent), files (workspace-relative key paths). Page bodies are written automatically afterwards: never write content.\n\n\
WHEN TO CHANGE:\n\
- add: a new feature, module or subsystem that NO existing page covers (see the added files below). Give it a clear title, a 1-3 sentence scope description and its key files.\n\
- remove: an existing page describes something that no longer exists in the code (its key files are gone or the feature was replaced).\n\
- update: an existing page's title, scope or key files genuinely changed (module renamed, responsibility split, files moved).\n\
WHEN NOT TO CHANGE: bug fixes, internal refactors, tests, dependency or version bumps, or anything already covered by an existing page. Leaving the catalog unchanged is the correct answer most of the time.\n\n\
RULES: at most {max_pages} pages; never invent ids for existing pages; keep at most 2 levels; read the code with the tools before adding or removing a page.\n\
FINAL ANSWER: one short sentence listing the operations you applied, or \"No catalog change needed\".\n\
{}",
        language_rule(language)
    )
}

/// 目录审视用户提示：现有目录 + 变更文件清单。
pub(crate) fn catalog_review_user_prompt(
    catalog: &str,
    file_map: &str,
    added: &[String],
    removed: &[String],
    modified: &[String],
) -> String {
    format!(
        "Current catalog:\n{catalog}\n\n\
Key files per page:\n{file_map}\n\n\
Changed since the last update:\n\
Added files:\n{}\n\
Removed files:\n{}\n\
Modified files:\n{}\n\n\
Decide whether the catalog must change, apply every change with wiki-catalog-edit, then answer.",
        bullet_list(added, 80),
        bullet_list(removed, 80),
        bullet_list(modified, 40)
    )
}

fn bullet_list(items: &[String], limit: usize) -> String {
    if items.is_empty() {
        return "(none)".to_string();
    }
    let mut lines: Vec<String> = items
        .iter()
        .take(limit)
        .map(|item| format!("- {item}"))
        .collect();
    if items.len() > limit {
        lines.push(format!("- ... and {} more", items.len() - limit));
    }
    lines.join("\n")
}
