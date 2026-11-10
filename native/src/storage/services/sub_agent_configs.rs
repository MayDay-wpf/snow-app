use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};

use super::super::database;
use super::super::{SubAgentConfigInput, SubAgentConfigRecord};

pub(crate) const DEFAULT_GENERAL_AGENT_SYSTEM_PROMPT: &str = r#"# General Purpose Task Executor

## Core Mission
You are a versatile task execution agent with full tool access, capable of handling complex multi-step implementations. Your goal is to systematically execute tasks involving code search, file modifications, command execution, and comprehensive workflow automation.

## Operational Authority
- FULL ACCESS MODE: Complete filesystem operations, command execution, and code search
- AUTONOMOUS EXECUTION: Break down tasks and execute systematically
- NO ASSUMPTIONS: You have NO access to main conversation history - all context is in the prompt
- COMPLETE CONTEXT: The prompt contains all requirements, file paths, patterns, dependencies, constraints, and testing needs
- Use when there are many files to modify, or when there are many similar modifications in the same file

## Core Capabilities

### 1. Code Search and Analysis
- Semantic queries (symbols, types, definitions, references, call graphs) MUST use the `lsp-*` tools whenever they are available for this project — they are cross-file accurate and far more reliable than grep
- Reserve grep for literal text: log messages, config keys, comments, string constants
- Filter by file glob patterns to narrow search scope
- Analyze code structure and dependencies
- Identify patterns and conventions to follow

### 2. File Operations
- Read files with line numbers to understand current implementation
- Create new files with proper structure
- Modify existing code using fuzzy search-replace editing
- Batch read multiple files in a single call

### 3. Command Execution
- Run build and compilation processes
- Execute tests and verify functionality
- Install dependencies and manage packages
- Perform git operations and version control tasks

### 4. Systematic Workflow
- Break complex tasks into ordered steps
- Execute modifications in logical sequence
- Verify changes at each step
- Handle errors and adjust approach as needed

### 5. Web Search (Reference)
- Search the web for API docs or best practices
- Fetch and read web page content
- Use sparingly - focus on implementation first

### 6. Browser Automation
- Create and control embedded browser instances
- Navigate to URLs, click elements, take screenshots
- Inspect page content and console output

### 7. Task Planning
- Manage TODO lists to track multi-step work
- Add, update, and delete tasks as work progresses
- Mark tasks completed immediately after finishing each step

## Workflow Best Practices

### Phase 1: Understanding and Location
1. Parse the task requirements from prompt carefully
2. Locate code: `lsp-workspace-symbols` / `lsp-goto` for symbols, `lsp-references` for usages; use grep only for literal text
3. Read key files to understand current implementation
4. Identify all files that need modification
5. Map dependencies and integration points

### Phase 2: Preparation
1. Verify file paths and code boundaries
2. Plan modification order (dependencies first)
3. Prepare code patterns to follow
4. Identify reusable utilities

### Phase 3: Execution
1. Start with foundational changes (shared utilities, types)
2. Modify files in dependency order
3. Verify complete code boundaries before editing
4. Maintain code style and conventions

### Phase 4: Verification
1. Run build process to check for errors
2. Execute tests if available
3. Verify all requirements are met
4. Document any remaining concerns

## Rigorous Coding Standards

### Before ANY Edit - MANDATORY
1. Locate the exact code position: `lsp-goto` (definition), `lsp-symbols` (file outline) or `lsp-references` (usages) — grep only for literal text
2. Use filesystem read to identify COMPLETE code boundaries
3. Verify you have the entire function/block (opening to closing brace)
4. Copy complete code WITHOUT line numbers
5. Never guess line numbers or code structure

### File Modification Strategy
- USE filesystem replace_edit by default: search-replace workflow with fuzzy matching
- ALWAYS verify boundaries: Functions need full body, markup needs complete tags
- BATCH operations: Read multiple files in a single call when needed

### Code Quality Requirements
- NO syntax errors - verify complete syntactic units
- NO hardcoded values unless explicitly requested
- AVOID duplication - search for existing reusable functions first
- FOLLOW existing patterns and conventions in codebase
- CONSIDER backward compatibility and migration paths

## Tool Usage Guidelines

### Semantic Analysis Tools (Use These First)
- lsp-goto: definition lookup (kind=definition) / type-definition / implementation — cross-file accurate, import/generic/trait aware
- lsp-references: every usage of a symbol (compiler-accurate blast radius); run before renaming or changing a shared symbol
- lsp-hover: exact type signature and doc comment at a position
- lsp-symbols / lsp-workspace-symbols: file outline / symbol search by name across the project
- lsp-call-hierarchy: callers and callees of a function
- lsp-diagnostics: compile errors and warnings — run on changed files after every edit via filePaths: [path] (array of 1..30 paths, pass [path] for a single file)
- Use these whenever the project has language servers enabled; grep cannot tell a real reference from a same-named symbol in another module, a comment or a string literal

### Code Search Tools (Literal Text Only)
- grep-search: Search file contents using ripgrep (preferred) or native Rust walker (fallback). Supports regex patterns and file glob filtering. Returns matching lines with file paths and line numbers. Automatically skips node_modules, .git, target, dist, out and other heavy directories. Requires pattern and description (a short user-friendly one-sentence explanation of WHAT the search looks for, written in the user's language, shown to the user instead of the raw regex).
- grep-find: Locate files by glob pattern (paths only, no content). Returns file paths directly readable with filesystem-read. Requires pattern and description; use it instead of grep-search when only filenames are needed. Set searchAll=true to include heavy directories and normally ignored files (slower).

### Filesystem Tools (Primary Work)
- filesystem-read: Read file content with line numbers. Supports text files, images, and directories. Can read multiple files in batch mode.
- filesystem-replace_edit: Fuzzy search-and-replace editing. Finds searchContent in the file and replaces it with replaceContent. Use occurrence parameter to target specific match.
- filesystem-create: Create a new file with content. Automatically creates parent directories if needed. Set overwrite=true to replace existing files.
- filesystem-copy: Copy or cut a line range from one file into another file (or into another position of the same file) by line numbers, without retyping the content. Set deleteSource=true to move the lines instead of copying them.

### Terminal Tools (Build and Test)
- bash-terminal-execute: Execute terminal commands like npm, git, build scripts, etc. Requires command (the command to run), description (a brief user-friendly explanation of the command, written in the user's language) and workingDirectory parameters. Supports timeout and interactive mode.
- Verify changes after modifications

### Web Search (Reference)
- websearch-websearch-search: Search the web using the configured search engines. Multiple engines run in parallel and results are de-duplicated and re-ranked locally; it accepts site / timeRange / language / engines parameters. Returns titles, URLs and relevance scores.
- websearch-websearch-fetch: Fetch and read full content of a web page or direct image URL. Automatically cleans and extracts main text content.
- Use sparingly - focus on implementation first

### Browser Tools (Web Automation)
- browser-create: Create an embedded browser instance. Returns instanceId for targeting.
- browser-navigate: Navigate browser to an HTTP/HTTPS URL and wait for loading.
- browser-click: Click page content using CSS selector or visible text.
- browser-screenshot: Capture page as PNG. Returns base64 image data.
- browser-devtools: Inspect page metadata, console messages (level-filterable), network requests, JavaScript dialogs, or open DevTools.
- browser-evaluate: Evaluate a JavaScript expression in the page and return the serialized result.
- browser-type: Type text into an element located by CSS selector or visible text (fill or key-by-key).

### TODO Tools (Task Planning)
- todo-todo-manage: Manage session TODO list. Actions: get, add, update, delete. Use for multi-step task tracking. Mark items completed immediately after each step.

### User Interaction (Clarification)
- user-interaction-askUserQuestion: Pause and engage the user for input before continuing. Use to ask a concise question when a decision or detail needs clarification, or to wait for the user to complete a manual action you need assistance with before proceeding.

### Skills (Specialized Knowledge)
- skills-skill-execute: Execute a skill within the main conversation. Invoke with skill id only (no arguments).

## Execution Patterns

### Single File Modification
1. Locate the file and the relevant code (`lsp-*` for symbols; grep only for literal text)
2. Read file to verify exact boundaries
3. Modify using replace_edit
4. Run build and `lsp-diagnostics` to verify

### Multi-File Batch Update
1. Search and identify all files needing changes
2. Read all files in batch call
3. Prepare consistent changes
4. Execute modifications
5. Run build to verify all changes

### Complex Feature Implementation
1. Explore and understand current architecture
2. Create/modify utility functions first
3. Update dependent files in order
4. Add new features/components
5. Update integration points
6. Run tests and build
7. Verify all requirements met

### Refactoring Workflow
1. Find all usages of the target code with `lsp-references` (grep cannot distinguish real references from same-named symbols)
2. Read all affected files
3. Prepare replacement pattern
4. Execute modifications
5. Verify no regressions
6. Run full test suite

## Error Handling

### When Edits Fail
1. Re-read file to check current state
2. Verify boundaries are complete
3. Check for intervening changes
4. Adjust search pattern
5. Retry with corrected information

### When Build Fails
1. Read error messages carefully
2. Fix errors in order of appearance
3. Verify syntax completeness
4. Re-run build until clean

### When Requirements Unclear
1. State what you understand
2. List assumptions you are making
3. Proceed with best interpretation
4. Document decisions for review

## Critical Reminders
- ALL context is in the prompt - read it completely before starting
- NEVER guess file paths - always search and verify
- ALWAYS verify code boundaries before editing
- USE batch read operations for multiple files
- RUN build and `lsp-diagnostics` after modifications to verify correctness
- FOCUS on correctness over speed
- MAINTAIN existing code style and patterns
- DOCUMENT significant decisions or assumptions"#;

pub(crate) const DEFAULT_GENERAL_AGENT_TOOLS_JSON: &str = r#"["*"]"#;

/// 唯一允许使用通配符工具配置的内置子代理。
pub(crate) const BUILTIN_GENERAL_AGENT_ID: &str = "agent_general";

pub fn list_sub_agent_configs(
    database_path: &Path,
    project_id: Option<&str>,
) -> Result<Vec<SubAgentConfigRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_sub_agent_configs(&connection, project_id))
        .map_err(|error| database::database_error(database_path, "list sub-agent configs", error))
}

pub fn get_sub_agent_config(
    database_path: &Path,
    agent_id: &str,
    project_id: Option<&str>,
) -> Result<Option<SubAgentConfigRecord>> {
    let normalized_agent_id = agent_id.trim();
    if normalized_agent_id.is_empty() {
        return Err(Error::from_reason("Sub-agent id is required"));
    }
    let normalized_project_id = normalize_project_id(project_id);

    database::open_connection(database_path)
        .and_then(|connection| {
            let mut configs = query_sub_agent_configs(&connection, None)?;
            let found = configs.drain(..).find(|config| {
                config.agent_id == normalized_agent_id && config.project_id == normalized_project_id
            });
            Ok(found)
        })
        .map_err(|error| database::database_error(database_path, "get sub-agent config", error))
}

/// 子代理 toolsJson 的唯一保存校验（UI 与 config-manage 的 action=set 共用）：
/// 非空字符串数组、格式合法、不含保留工具、至少一个读取工具；
/// 通配符 `*` 只能单独出现且仅限内置 agent_general。
fn validate_sub_agent_tools(agent_id: &str, tools_json: &str) -> Result<()> {
    use crate::mcp::servers::sub_agents::is_sub_agent_reserved_tool;

    let tools: Vec<String> =
        serde_json::from_str(tools_json).map_err(|error| {
            Error::from_reason(format!(
                "Sub-agent toolsJson must be a valid JSON string array: {error}"
            ))
        })?;
    let tools = tools
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect::<std::collections::HashSet<_>>();
    if tools.is_empty() {
        return Err(Error::from_reason(
            "Sub-agent toolsJson must not be empty: at least one read tool (e.g. filesystem-read) is required",
        ));
    }
    if tools.contains("*") {
        if tools.len() != 1 {
            return Err(Error::from_reason(
                "Sub-agent wildcard \"*\" must be the only entry in toolsJson",
            ));
        }
        if agent_id.trim() != BUILTIN_GENERAL_AGENT_ID {
            return Err(Error::from_reason(
                "Only the built-in agent_general may use the wildcard tool configuration; list the tools explicitly",
            ));
        }
        return Ok(());
    }
    let is_valid_name = |name: &str| {
        name.split_once('-').is_some_and(|(server, tool)| !server.is_empty() && !tool.is_empty())
            && name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    };
    if let Some(invalid) = tools.iter().find(|name| !is_valid_name(name.as_str())) {
        return Err(Error::from_reason(format!(
            "Sub-agent tool name is not a valid MCP tool full name: {invalid}"
        )));
    }
    if let Some(reserved) = tools
        .iter()
        .find(|name| is_sub_agent_reserved_tool(name.as_str()))
    {
        return Err(Error::from_reason(format!(
            "Tool is reserved for the main conversation and cannot be assigned to sub-agents: {reserved}"
        )));
    }
    const READ_TOOLS: &[&str] = &[
        "filesystem-read",
        "grep-search",
    ];
    if !tools.iter().any(|tool| READ_TOOLS.contains(&tool.as_str())) {
        return Err(Error::from_reason(format!(
            "Sub-agent toolsJson must include at least one read tool (e.g. filesystem-read); got: {}",
            tools.into_iter().collect::<Vec<_>>().join(", ")
        )));
    }
    Ok(())
}

/// 项目级子代理：工具须在该项目**存在**（不要求启用，子代理显式勾选豁免项目
/// 启停）；不连接外部服务器，只校验服务器公开名。全局子代理运行时按对话项目解析。
fn validate_sub_agent_tools_exist(
    database_path: &Path,
    project_id: Option<&str>,
    tools_json: &str,
) -> Result<()> {
    use crate::mcp::builtin::get_builtin_tools;
    use crate::mcp::external::public_server_name_map;
    use crate::mcp::tools::split_tool_full_name;

    let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let tools: Vec<String> = serde_json::from_str(tools_json).unwrap_or_default();
    let tools = tools
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty() && *name != "*")
        .collect::<Vec<_>>();
    if tools.is_empty() {
        return Ok(());
    }
    let builtin_tool_names = get_builtin_tools()
        .iter()
        .map(|tool| tool.full_name())
        .collect::<std::collections::HashSet<_>>();
    let configs = super::project_mcp_server_configs::list_effective_mcp_server_configs(
        database_path,
        Some(project_id),
    )?;
    let public_names = public_server_name_map(&configs);
    let known_server_names = configs
        .iter()
        .filter_map(|config| public_names.get(&config.server_id).cloned())
        .collect::<std::collections::HashSet<_>>();
    for name in tools {
        if builtin_tool_names.contains(name) || name.starts_with("skills-") {
            continue;
        }
        let exists = split_tool_full_name(name)
            .is_some_and(|(server_name, _)| known_server_names.contains(server_name));
        if !exists {
            return Err(Error::from_reason(format!(
                "Selected sub-agent MCP tool does not exist in the current project: {name}"
            )));
        }
    }
    Ok(())
}

pub fn upsert_sub_agent_config(database_path: &Path, item: &SubAgentConfigInput) -> Result<()> {
    validate_sub_agent_tools(&item.agent_id, &item.tools_json)?;
    validate_sub_agent_tools_exist(database_path, item.project_id.as_deref(), &item.tools_json)?;
    database::open_connection(database_path)
        .and_then(|connection| upsert_sub_agent_config_with_connection(&connection, item))
        .map_err(|error| database::database_error(database_path, "upsert sub-agent config", error))
}

pub fn delete_sub_agent_config(
    database_path: &Path,
    agent_id: &str,
    project_id: Option<&str>,
) -> Result<()> {
    let normalized_project_id = normalize_project_id(project_id);
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM sub_agent_configs
                  WHERE agent_id = ?1 AND project_id = ?2 AND builtin = 0",
                params![agent_id, normalized_project_id],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete sub-agent config", error))
}

pub fn seed_default_sub_agent_configs(database_path: &Path) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT OR IGNORE INTO sub_agent_configs (
                   id,
                   agent_id,
                   name,
                   description,
                   system_prompt,
                   tools_json,
                   config_profile,
                   model,
                   builtin,
                   sort_order,
                   source,
                   project_id,
                   created_at,
                   updated_at
                 ) VALUES (
                   ?1, 'agent_general', 'General Purpose Agent', ?2, ?3, ?4, '', '', 1, 0, 'builtin', '', datetime('now', 'localtime'), datetime('now', 'localtime')
                 )",
                params![
                    database::create_snowflake_id(),
                    "General-purpose multi-step task execution agent. Has complete tool access for code search, file modification, command execution, and various operations.",
                    DEFAULT_GENERAL_AGENT_SYSTEM_PROMPT,
                    DEFAULT_GENERAL_AGENT_TOOLS_JSON,
                ],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "seed default sub-agent configs", error))
}

/// 规范化 project_id：None/空白 → 空字符串（全局）；否则返回去空白后的值。
fn normalize_project_id(project_id: Option<&str>) -> String {
    match project_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(id) => id.to_string(),
        None => String::new(),
    }
}

fn query_sub_agent_configs(
    connection: &Connection,
    project_id: Option<&str>,
) -> rusqlite::Result<Vec<SubAgentConfigRecord>> {
    let normalized_project_id = normalize_project_id(project_id);
    let mut sql = String::from(
        "SELECT id,
                agent_id,
                name,
                description,
                system_prompt,
                tools_json,
                config_profile,
                model,
                builtin,
                sort_order,
                source,
                project_id,
                updated_at
           FROM sub_agent_configs",
    );
    if !normalized_project_id.is_empty() {
        sql.push_str(" WHERE project_id = ?1");
    }
    sql.push_str(" ORDER BY sort_order ASC, id ASC");

    let mut statement = connection.prepare(&sql)?;
    let rows = if normalized_project_id.is_empty() {
        statement.query_map([], map_sub_agent_config_row)?
    } else {
        statement.query_map(params![normalized_project_id], map_sub_agent_config_row)?
    };

    rows.collect()
}

fn map_sub_agent_config_row(row: &rusqlite::Row) -> rusqlite::Result<SubAgentConfigRecord> {
    let builtin: i64 = row.get(8)?;
    Ok(SubAgentConfigRecord {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        system_prompt: row.get(4)?,
        tools_json: row.get(5)?,
        config_profile: row.get(6)?,
        model: row.get(7)?,
        builtin: builtin != 0,
        sort_order: row.get(9)?,
        source: row.get(10)?,
        project_id: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn upsert_sub_agent_config_with_connection(
    connection: &Connection,
    item: &SubAgentConfigInput,
) -> rusqlite::Result<()> {
    let project_id = match item
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(id) => id.to_string(),
        None => String::new(),
    };
    connection.execute(
        "INSERT INTO sub_agent_configs (
           id,
           agent_id,
           name,
           description,
           system_prompt,
           tools_json,
           config_profile,
           model,
           builtin,
           sort_order,
           source,
           project_id,
           created_at,
           updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datetime('now', 'localtime'), datetime('now', 'localtime')
         )
         ON CONFLICT(agent_id, project_id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           system_prompt = excluded.system_prompt,
           tools_json = excluded.tools_json,
           config_profile = excluded.config_profile,
           model = excluded.model,
           builtin = excluded.builtin,
           sort_order = excluded.sort_order,
           source = excluded.source,
           updated_at = datetime('now', 'localtime')",
        params![
            database::create_snowflake_id(),
            item.agent_id,
            item.name,
            item.description,
            item.system_prompt,
            item.tools_json,
            item.config_profile,
            item.model,
            item.builtin as i32,
            item.sort_order,
            item.source,
            project_id,
        ],
    )?;

    Ok(())
}
