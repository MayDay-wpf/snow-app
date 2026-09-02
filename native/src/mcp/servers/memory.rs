//! 项目级持久记忆（Project Memory）内置 MCP 服务。
//!
//! 5 个工具（save / search / list / update / delete）按会话项目隔离读写
//! `project_memories` 表，全部 SQLite I/O 走 spawn_blocking。项目上下文
//! （directory_id）与会话溯源（conversation_id，仅 save 用作锚点）都由
//! `call_mcp_tool` 分发层注入，工具参数无需携带，模型不可能跨项目读写，
//! 也不可能伪造溯源。
//!
//! 系统提示词注入：`build_system_prompt_section` 仿 LSP / imagegen 的
//! 「方案 B」——域 scope 允许时在系统提示词末尾追加 `## Project Memory`
//! 章节（importance 头部条目 + 工具指引），查询失败静默降级为空串。
//! 追加在末尾以最小化 prompt cache 前缀失效范围。

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "memory";

/// 系统提示词注入的头部记忆筛选：importance 下限 / 条数上限 / 章节字符
/// 上限（保护上下文预算）。
const INJECT_MIN_IMPORTANCE: i32 = 3;
const INJECT_MAX_ENTRIES: i32 = 30;
const INJECT_MAX_CHARS: usize = 4000;

/// 单条注入行的 content 截断长度（title 优先展示，content 只保留要点）。
const INJECT_CONTENT_TRUNCATE: usize = 180;

pub struct MemoryService;

impl MemoryService {
    pub fn new() -> Self {
        MemoryService
    }

    /// call.rs 分发入口：`project_id` 为当前会话项目（directory_id），
    /// 所有操作都以它为隔离键；无项目上下文时直接报错。
    /// `conversation_id` 为当前会话 ID（分发层注入，AI 不可填写），仅
    /// memory-save 用作溯源锚点。
    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        project_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> napi::Result<Value> {
        let project_id = project_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "Project Memory tools require a selected project (workspace). Select a project for the conversation first.".to_string(),
                )
            })?
            .to_string();

        match tool_name {
            "save" => self.execute_save(args, &project_id, conversation_id).await,
            "search" => self.execute_search(args, &project_id).await,
            "list" => self.execute_list(args, &project_id).await,
            "update" => self.execute_update(args).await,
            "delete" => self.execute_delete(args).await,
            other => Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Unknown tool: \"{other}\" for MCP server \"memory\". Available tools: [memory-save, memory-search, memory-list, memory-update, memory-delete]"
                ),
            )),
        }
    }

    // -----------------------------------------------------------------
    // memory-save：AI 主动保存记忆（按标题自动去重合并）。
    // -----------------------------------------------------------------
    async fn execute_save(
        &self,
        args: &Value,
        project_id: &str,
        conversation_id: Option<&str>,
    ) -> napi::Result<Value> {
        let kind = optional_string(args, "kind").unwrap_or_else(|| "fact".to_string());
        let title = required_string(args, "title")?;
        let content = required_string(args, "content")?;
        let importance = optional_i32(args, "importance").unwrap_or(2);
        let tags = optional_string_array(args, "tags");
        // 溯源锚点由分发层注入（call_mcp_tool 传入当前会话 ID），AI 不可
        // 填写——避免抄写错误/伪造；无会话上下文（如 PENDING 会话）时为
        // 空串，会话删除联动不会匹配到空溯源记忆。
        let conversation_id = conversation_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_default()
            .to_string();
        // 响应级溯源：渲染层工具执行器注入当前 assistant responseId
        // （与 todo-todo-manage 相同的模式），回滚据此圈定被回滚轮次
        // 保存的记忆；无响应上下文时为空串，不参与回滚范围匹配。
        let response_id = optional_string(args, "responseId")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_default();

        let project_id = project_id.to_string();
        let (record, created) = tokio::task::spawn_blocking(move || {
            crate::storage::upsert_project_memory(
                project_id,
                kind,
                title,
                content,
                "agent".to_string(),
                "active".to_string(),
                importance,
                conversation_id,
                response_id,
                tags,
            )
        })
        .await
        .map_err(spawn_error("save memory"))??;

        let message = if created {
            format!("Memory saved as a new entry (id: {}).", record.memory_id)
        } else {
            format!(
                "An existing memory with the same title was found and has been MERGED/updated instead of creating a duplicate (id: {}).",
                record.memory_id
            )
        };
        Ok(json!({
            "memory": serde_json::to_value(&record).unwrap_or(json!({})),
            "created": created,
            "message": message,
        }))
    }

    // -----------------------------------------------------------------
    // memory-search：按需检索（打分排序 + 召回统计）。
    // -----------------------------------------------------------------
    async fn execute_search(&self, args: &Value, project_id: &str) -> napi::Result<Value> {
        let query = required_string(args, "query")?;
        let kind = optional_string(args, "kind");
        let status = optional_string(args, "status").unwrap_or_else(|| "active".to_string());
        let limit = optional_i32(args, "limit").unwrap_or(10);

        let project_id = project_id.to_string();
        let query_echo = query.clone();
        let (results, stats) = tokio::task::spawn_blocking(move || {
            let database_path = crate::storage::ensure_database_file()?;
            let results = crate::storage::services::project_memories::search_memories(
                &database_path,
                &project_id,
                &query,
                kind.as_deref(),
                Some(status.as_str()),
                limit,
            )?;
            let stats = crate::storage::get_project_memory_stats(project_id.clone())?;
            Ok::<_, Error>((results, stats))
        })
        .await
        .map_err(spawn_error("search memories"))??;

        if results.is_empty() {
            return Ok(json!({
                "results": [],
                "count": 0,
                "query": query_echo,
                "message": format!(
                    "No memories matched the query. The project memory bank holds {} active / {} pending entries; use memory-list to browse by kind.",
                    stats.active, stats.pending
                ),
            }));
        }
        Ok(json!({
            "results": serde_json::to_value(&results).unwrap_or(json!([])),
            "count": results.len(),
            "query": query_echo,
        }))
    }

    // -----------------------------------------------------------------
    // memory-list：分页浏览。
    // -----------------------------------------------------------------
    async fn execute_list(&self, args: &Value, project_id: &str) -> napi::Result<Value> {
        let status = optional_string(args, "status");
        let kind = optional_string(args, "kind");
        let limit = optional_i32(args, "limit").unwrap_or(50);
        let offset = optional_i32(args, "offset").unwrap_or(0);

        let project_id = project_id.to_string();
        let page = tokio::task::spawn_blocking(move || {
            crate::storage::list_project_memories(project_id, limit, offset, status, kind)
        })
        .await
        .map_err(spawn_error("list memories"))??;

        Ok(json!({
            "items": serde_json::to_value(&page.items).unwrap_or(json!([])),
            "total": page.total,
            "hasMore": page.has_more,
        }))
    }

    // -----------------------------------------------------------------
    // memory-update：修改可编辑字段（None 字段保持不变）。
    // -----------------------------------------------------------------
    async fn execute_update(&self, args: &Value) -> napi::Result<Value> {
        let memory_id = required_string(args, "memoryId")?;
        let patch = crate::storage::services::project_memories::MemoryUpdatePatch {
            kind: optional_string(args, "kind"),
            title: optional_string(args, "title"),
            content: optional_string(args, "content"),
            importance: optional_i32(args, "importance"),
            status: optional_string(args, "status"),
            // tags 字段存在时替换（空数组 = 清空标签），缺省保持不变。
            tags: args.get("tags").map(|_| optional_string_array(args, "tags")),
        };
        if patch.kind.is_none()
            && patch.title.is_none()
            && patch.content.is_none()
            && patch.importance.is_none()
            && patch.status.is_none()
            && patch.tags.is_none()
        {
            return Err(Error::new(
                Status::InvalidArg,
                "At least one field to update must be provided (title / content / kind / importance / status / tags)".to_string(),
            ));
        }

        let record = tokio::task::spawn_blocking(move || {
            crate::storage::update_project_memory(memory_id, patch)
        })
        .await
        .map_err(spawn_error("update memory"))??;

        Ok(json!({
            "memory": serde_json::to_value(&record).unwrap_or(json!({})),
            "message": "Memory updated.".to_string(),
        }))
    }

    // -----------------------------------------------------------------
    // memory-delete：删除单条。DESTRUCTIVE：要求 confirmed=true，且工具
    // 描述强制 AI 先经 user-interaction-askUserQuestion 获得用户同意
    // （与 config-delete 同规）。
    // -----------------------------------------------------------------
    async fn execute_delete(&self, args: &Value) -> napi::Result<Value> {
        let memory_id = required_string(args, "memoryId")?;
        let confirmed = args
            .get("confirmed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !confirmed {
            return Err(Error::new(
                Status::GenericFailure,
                "DESTRUCTIVE: memory-delete requires confirmed: true. First ask the user for explicit approval via the user-interaction askUserQuestion tool, then retry with confirmed: true.".to_string(),
            ));
        }

        let deleted = tokio::task::spawn_blocking(move || {
            crate::storage::delete_project_memory(memory_id)
        })
        .await
        .map_err(spawn_error("delete memory"))??;

        if deleted {
            Ok(json!({ "deleted": true, "message": "Memory deleted.".to_string() }))
        } else {
            Ok(json!({
                "deleted": false,
                "message": "No memory matched the given id; it may have been deleted already.".to_string(),
            }))
        }
    }
}

impl McpService for MemoryService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "save".to_string(),
                description: "Save a durable, cross-session memory about the CURRENT project to its persistent memory bank (SQLite, scoped to the conversation's project). Use for knowledge worth remembering in FUTURE sessions: key technical decisions, user preferences/conventions, pitfalls and their fixes, project structure facts, task state. NOT for transient session state (use the todo tool for that).\n\nFields:\n- kind (optional): \"fact\" | \"decision\" | \"preference\" | \"pitfall\" | \"task_state\" (default \"fact\")\n- title (required): one concise line; it is the dedup key — saving with an existing title MERGES into that entry instead of creating a duplicate\n- content (required): concrete details (paths, commands, reasons); keep under ~400 chars\n- importance (optional, default 2): 1-5. 1-2 = retrieval-only (found via memory-search, never injected) — the default and correct level for specific, task-bound events (a fixed bug, a one-off decision, current task state). >= 3 = auto-injected into the system prompt of EVERY new conversation — reserve it strictly for general project knowledge useful to nearly all sessions (build/test commands, core conventions, architecture facts); if an entry only matters for one specific topic or task, keep it at 1-2 even if it feels important\n- tags (optional): lowercase keywords for retrieval\n\nWhat to save: architecture choices the user confirmed, build/test conventions, \"don't do X\" lessons, environment quirks, recurring user instructions specific to this project. Do NOT save secrets, one-off facts easily re-derived from code, or content the user asked to forget.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["fact", "decision", "preference", "pitfall", "task_state"],
                            "description": "Memory category. decision = confirmed technical/architecture choice; preference = user convention/instruction; pitfall = a lesson learned from a failure; task_state = where long-running work left off (task-bound: save at importance 1-2)."
                        },
                        "title": {
                            "type": "string",
                            "description": "Concrete one-line summary; dedup key (same title merges)."
                        },
                        "content": {
                            "type": "string",
                            "description": "Full details worth keeping (paths, symbols, commands, reasons)."
                        },
                        "importance": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 5,
                            "description": "1-5. 1-2 (default): retrieval-only via memory-search — for specific, task-bound events. >= 3: auto-injected into every new conversation's system prompt — general project knowledge only, never topic-specific events."
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Lowercase retrieval keywords."
                        }
                    },
                    "required": ["title", "content"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "search".to_string(),
                description: "Search the CURRENT project's persistent memory bank by keywords. Results are ranked (title/tag/content hits, importance, recency) and only entries with actual text matches are returned. Use when the injected Project Memory section is not enough and you need prior knowledge about this project (past decisions, pitfalls, user preferences).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Keywords to search for. Supports natural language; matched against titles, content and tags."
                        },
                        "kind": {
                            "type": "string",
                            "enum": ["fact", "decision", "preference", "pitfall", "task_state"],
                            "description": "Optional category filter."
                        },
                        "status": {
                            "type": "string",
                            "enum": ["active", "pending", "archived"],
                            "description": "Optional status filter (default \"active\")."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max results (default 10)."
                        }
                    },
                    "required": ["query"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "list".to_string(),
                description: "Browse the CURRENT project's persistent memory bank page by page, ordered by importance then last update. Use to review what is already remembered (e.g. before saving, to avoid duplicates) or to audit/clean up entries.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": ["active", "pending", "archived"],
                            "description": "Optional status filter (empty = all statuses)."
                        },
                        "kind": {
                            "type": "string",
                            "enum": ["fact", "decision", "preference", "pitfall", "task_state"],
                            "description": "Optional category filter."
                        },
                        "limit": { "type": "integer", "description": "Page size (default 50)." },
                        "offset": { "type": "integer", "description": "Page offset (default 0)." }
                    },
                    "required": []
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "update".to_string(),
                description: "Update an existing memory entry in the CURRENT project's memory bank by id (obtained from memory-list / memory-search results). Only provided fields change; omitted fields keep their values. Use to refine wording, correct an outdated memory, or change importance/status.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "memoryId": { "type": "string", "description": "Memory id from list/search results." },
                        "title": { "type": "string", "description": "Optional new title." },
                        "content": { "type": "string", "description": "Optional new content." },
                        "kind": {
                            "type": "string",
                            "enum": ["fact", "decision", "preference", "pitfall", "task_state"],
                            "description": "Optional new category."
                        },
                        "importance": { "type": "integer", "minimum": 1, "maximum": 5, "description": "Optional new importance." },
                        "status": {
                            "type": "string",
                            "enum": ["active", "pending", "archived"],
                            "description": "Optional new status. Use \"archived\" to retire a memory without deleting it."
                        },
                        "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional replacement tags." }
                    },
                    "required": ["memoryId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "delete".to_string(),
                description: "Delete one memory entry from the CURRENT project's memory bank. DESTRUCTIVE — before calling, you MUST obtain the user's explicit approval via the user-interaction askUserQuestion tool, then retry with confirmed: true; calls without it are rejected. Prefer memory-update with status=\"archived\" when the memory may still be useful later.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "memoryId": { "type": "string", "description": "Memory id from list/search results." },
                        "confirmed": {
                            "type": "boolean",
                            "description": "MUST be true and may only be set after explicit user approval via askUserQuestion."
                        }
                    },
                    "required": ["memoryId", "confirmed"]
                }),
            },
        ]
    }

    /// 同步 fallback：memory 工具依赖调用期项目上下文（call_mcp_tool 分发
    /// 注入的 directory_id），此入口拿不到项目，直接报错引导走异步路径。
    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        Err(Error::new(
            Status::GenericFailure,
            format!(
                "Tool \"{tool_name}\" of server \"memory\" requires the async call_mcp_tool path (project context). Available tools: [memory-save, memory-search, memory-list, memory-update, memory-delete]"
            ),
        ))
    }
}

// ---------------------------------------------------------------------------
// 域 scope 判定与系统提示词注入
// ---------------------------------------------------------------------------

/// 核心工具全名（域级判定代表集合：全部被全局黑名单禁用 → 域不可用）。
const CORE_MEMORY_TOOL_NAMES: [&str; 5] = [
    "memory-save",
    "memory-search",
    "memory-list",
    "memory-update",
    "memory-delete",
];

/// memory 是默认启用的内置服务器：全局黑名单全部禁用，或项目 scope
/// 显式关闭 builtin:memory 时返回 false（与 collect 阶段 tool_is_enabled
/// 口径一致，保证提示词注入与工具可见性不脱节）。
async fn memory_domain_scope_allowed(project_id: Option<&str>) -> napi::Result<bool> {
    use crate::mcp::tools::{builtin_scope_server_id, load_global_scope, load_project_scope};

    if let Some(global) = load_global_scope().await? {
        if CORE_MEMORY_TOOL_NAMES
            .iter()
            .all(|tool| global.disabled_tool_names.contains(*tool))
        {
            return Ok(false);
        }
    }
    match load_project_scope(project_id).await? {
        Some(scope) => Ok(scope.is_server_enabled(&builtin_scope_server_id(SERVER_ID))),
        None => Ok(true),
    }
}

/// 构建系统提示词的「Project Memory」章节（方案 B：追加在末尾）。
///
/// - 无项目上下文 / 域被禁用 / 查询失败 → 空串（静默降级）；
/// - 记忆库为空 → 注入简短引导（让 AI 知道可以开始积累记忆）；
/// - 有记忆 → importance 头部条目 + 检索/保存指引 + 库统计。
///
/// 章节仅在记忆内容变化时改变，稳定于 prompt cache。memory-save 的会话
/// 溯源由分发层注入（conversation_id），无需在提示词里引导 AI 传会话 ID。
pub(crate) async fn build_system_prompt_section(project_id: Option<&str>) -> String {
    let Some(project_id) = project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return String::new();
    };

    let scope_allowed = match memory_domain_scope_allowed(Some(project_id)).await {
        Ok(allowed) => allowed,
        Err(_) => return String::new(),
    };
    if !scope_allowed {
        return String::new();
    }

    let project_id_owned = project_id.to_string();
    let loaded = crate::mcp::tools::with_database_path(move |database_path| {
        let records = crate::storage::services::project_memories::top_memories_for_injection(
            &database_path,
            &project_id_owned,
            INJECT_MIN_IMPORTANCE,
            INJECT_MAX_ENTRIES,
        )?;
        let stats = crate::storage::services::project_memories::get_memory_stats(
            &database_path,
            &project_id_owned,
        )?;
        Ok((records, stats))
    })
    .await;

    match loaded {
        Ok((records, stats)) => render_memory_section(records, &stats),
        Err(_) => String::new(),
    }
}

/// 渲染注入章节。逐行累计并在 `INJECT_MAX_CHARS` 处截断，保证上下文预算。
fn render_memory_section(
    records: Vec<crate::storage::MemoryRecord>,
    stats: &crate::storage::MemoryStats,
) -> String {
    let mut section = String::from(
        "## Project Memory\n\nThis project keeps a persistent, cross-session memory bank — \
knowledge learned about THIS project in earlier sessions. Treat the entries as \
reference material (not binding rules); verify against the actual code when it matters.\n",
    );

    if records.is_empty() {
        if stats.total == 0 {
            section.push_str(
                "\nThe bank is currently empty. When you learn durable, cross-session \
knowledge about this project (confirmed decisions, user preferences, pitfalls, \
task state), save it with `memory-save` — it will be available in future sessions.",
            );
        } else {
            section.push_str(&format!(
                "\nNo entry currently meets the auto-inject importance bar (>= {}), \
though the bank holds {} entries. Use `memory-search` to look up prior knowledge \
about this project when needed.",
                INJECT_MIN_IMPORTANCE, stats.total
            ));
        }
    } else {
        section.push_str("\nTop entries by importance:\n");
        let mut used = section.chars().count();
        for record in records.iter() {
            let date = record.updated_at.chars().take(10).collect::<String>();
            let content = truncate_chars(&record.content, INJECT_CONTENT_TRUNCATE);
            let line = if content.is_empty() {
                format!("- [{}] {} ({})\n", record.kind, record.title, date)
            } else {
                format!("- [{}] {} — {} ({})\n", record.kind, record.title, content, date)
            };
            used += line.chars().count();
            if used > INJECT_MAX_CHARS {
                section.push_str(
                    "- ... more entries exist in the bank (use `memory-search`)\n",
                );
                break;
            }
            section.push_str(&line);
        }

        section.push_str(&format!(
            "\nBank stats: {} total ({} active / {} pending / {} archived). Use \
`memory-search` for details on any topic, and `memory-save` when you learn \
durable knowledge worth keeping for future sessions (same-title saves merge \
instead of duplicating). When saving, keep specific/task-bound events at \
importance 1-2 (retrieval-only) and reserve importance >= 3 for general \
project knowledge worth auto-injecting into every new session.",
            stats.total, stats.active, stats.pending, stats.archived
        ));
    }

    section
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        let truncated: String = value.chars().take(max_chars).collect();
        format!("{truncated}…")
    }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

fn required_string(args: &Value, key: &str) -> napi::Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("Missing or invalid string parameter: {key}"),
            )
        })
}

fn optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
}

fn optional_i32(args: &Value, key: &str) -> Option<i32> {
    args.get(key)
        .and_then(Value::as_i64)
        .map(|value| value as i32)
        .or_else(|| {
            // 部分 provider 会把数字序列化为字符串。
            args.get(key)
                .and_then(Value::as_str)
                .and_then(|value| value.trim().parse::<i32>().ok())
        })
}

fn optional_string_array(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.trim().to_lowercase())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn spawn_error(operation: &'static str) -> impl Fn(tokio::task::JoinError) -> Error {
    move |error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to {operation}: {error}"),
        )
    }
}
