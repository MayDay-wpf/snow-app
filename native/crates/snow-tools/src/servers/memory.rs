//! 持久记忆（Project Memory）内置 MCP 服务。
//!
//! 单个 `memory-manage` 工具（action = save / search / list / update / delete）
//! 读写 `project_memories` 表：scope=project 按会话项目（directory_id）隔离；
//! scope=user 写入全局作用域（directory_id 空串），跨项目注入。search / list /
//! 注入章节合并项目与全局条目，条目带 `scope` 字段。全部 SQLite I/O 走
//! spawn_blocking，项目上下文（directory_id）与会话溯源（conversation_id）
//! 由 `call_mcp_tool` 分发层注入，模型不可能伪造。
//!
//! 系统提示词注入：`build_system_prompt_section` 仿 LSP / imagegen 的
//! 「方案 B」——域 scope 允许时在系统提示词末尾追加 `## Project Memory`
//! 章节（importance 头部条目 + 工具指引），查询失败静默降级为空串。
//! 章节按会话冻结：会话首次注入时渲染并存档（memory_prompt_snapshots
//! 表），之后每轮复用同一份文本，会话中新增/修改记忆不再改变已发送的
//! 提示词前缀，prompt cache 全程有效——新记忆只对之后新建的会话生效。

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::contract::{McpService, McpTool};
use crate::servers::id_list_arg;

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
    /// action=save 且 scope=project 时作为隔离键；无项目上下文时直接报错。
    /// `conversation_id` 为当前会话 ID（分发层注入，AI 不可填写），仅
    /// action=save 用作溯源锚点。
    pub async fn execute_async(
        &self,
        args: &Value,
        project_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> napi::Result<Value> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "action is required (save | search | list | update | delete)".to_string(),
                )
            })?
            .to_string();

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

        match action.as_str() {
            "save" => self.execute_save(args, &project_id, conversation_id).await,
            "search" => self.execute_search(args, &project_id).await,
            "list" => self.execute_list(args, &project_id).await,
            "update" => self.execute_update(args).await,
            "delete" => self.execute_delete(args).await,
            other => Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Unknown action: \"{other}\" for memory-manage. Available actions: [save, search, list, update, delete]"
                ),
            )),
        }
    }

    // -----------------------------------------------------------------
    // action=save：AI 主动保存记忆（按标题自动去重合并）。
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
        // scope=user 写全局作用域（directory_id 空串），条目会注入所有项目
        // 的新会话；scope=project（默认）仍按当前项目隔离。
        let scope = optional_string(args, "scope").unwrap_or_else(|| "project".to_string());
        let directory_id = match scope.as_str() {
            "user" | "global" => String::new(),
            "project" => project_id.to_string(),
            other => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Invalid scope: \"{other}\". Use \"project\" or \"user\"."),
                ))
            }
        };
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

        let (record, created) = tokio::task::spawn_blocking(move || {
            snow_storage::project_memories_api::upsert_project_memory(
                directory_id,
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

        let target = if record.scope == "global" {
            "the cross-project user memory"
        } else {
            "this project"
        };
        let message = if created {
            format!(
                "Memory saved as a new entry in {target} (id: {}). It will be injected into the system prompt of NEW conversations only — the injected section of the current session stays frozen so its context cache keeps hitting.",
                record.memory_id
            )
        } else {
            format!(
                "An existing memory with the same title was found in {target} and has been MERGED/updated instead of creating a duplicate (id: {}). The injected section of the current session stays frozen; the change shows up in NEW conversations.",
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
    // action=search：按需检索（打分排序 + 召回统计）。
    // -----------------------------------------------------------------
    async fn execute_search(&self, args: &Value, project_id: &str) -> napi::Result<Value> {
        let query = required_string(args, "query")?;
        let kind = optional_string(args, "kind");
        let status = optional_string(args, "status").unwrap_or_else(|| "active".to_string());
        let limit = optional_i32(args, "limit").unwrap_or(10);

        let project_id = project_id.to_string();
        let query_echo = query.clone();
        let (results, stats) = tokio::task::spawn_blocking(move || {
            let database_path = snow_storage_core::bootstrap::ensure_database_file()?;
            let results = snow_storage::project_memories::search_memories(
                &database_path,
                &project_id,
                &query,
                kind.as_deref(),
                Some(status.as_str()),
                limit,
            )?;
            let stats = snow_storage::project_memories_api::get_project_memory_stats(project_id.clone())?;
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
                    "No memories matched the query. The project memory bank holds {} active / {} pending entries; use action=list to browse by kind.",
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
    // action=list：分页浏览。
    // -----------------------------------------------------------------
    async fn execute_list(&self, args: &Value, project_id: &str) -> napi::Result<Value> {
        let status = optional_string(args, "status");
        let kind = optional_string(args, "kind");
        let limit = optional_i32(args, "limit").unwrap_or(50);
        let offset = optional_i32(args, "offset").unwrap_or(0);

        let project_id = project_id.to_string();
        let page = tokio::task::spawn_blocking(move || {
            snow_storage::project_memories_api::list_project_memories(project_id, limit, offset, status, kind)
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
    // action=update：修改可编辑字段（缺省字段保持不变）。
    // -----------------------------------------------------------------
    async fn execute_update(&self, args: &Value) -> napi::Result<Value> {
        let memory_ids = id_list_arg(args, "memoryId")?;
        let patch = snow_storage::project_memories::MemoryUpdatePatch {
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

        // title / content 与去重键、正文绑定：多条共用同一值会造成标题冲突，
        // 故仅允许单条更新这两个字段。
        if memory_ids.len() > 1 && (patch.title.is_some() || patch.content.is_some()) {
            return Err(Error::new(
                Status::InvalidArg,
                "title and content can only be changed for a single memory (one memoryId string); batch updates support kind / importance / status / tags".to_string(),
            ));
        }

        let records = tokio::task::spawn_blocking(move || {
            let database_path = snow_storage_core::bootstrap::ensure_database_file()?;
            snow_storage::project_memories::update_memories(
                &database_path,
                &memory_ids,
                &patch,
            )
        })
        .await
        .map_err(spawn_error("update memory"))??;

        Ok(json!({
            "memories": serde_json::to_value(&records).unwrap_or(json!([])),
            "count": records.len(),
            "message": format!(
                "Updated {} memor{}.",
                records.len(),
                if records.len() == 1 { "y" } else { "ies" }
            ),
        }))
    }

    // -----------------------------------------------------------------
    // action=delete：删除单条或多条。DESTRUCTIVE：要求 confirmed=true，
    // 且工具描述强制 AI 先经 user-interaction-askUserQuestion 获得用户
    // 同意（与 config-manage 的 action=delete 同规）。
    // -----------------------------------------------------------------
    async fn execute_delete(&self, args: &Value) -> napi::Result<Value> {
        let memory_ids = id_list_arg(args, "memoryId")?;
        let confirmed = args
            .get("confirmed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !confirmed {
            return Err(Error::new(
                Status::GenericFailure,
                "DESTRUCTIVE: action=delete requires confirmed: true. First ask the user for explicit approval via the user-interaction askUserQuestion tool, then retry with confirmed: true.".to_string(),
            ));
        }

        let deleted = tokio::task::spawn_blocking(move || {
            let database_path = snow_storage_core::bootstrap::ensure_database_file()?;
            snow_storage::project_memories::delete_memories_by_memory_ids(
                &database_path,
                &memory_ids,
            )
        })
        .await
        .map_err(spawn_error("delete memory"))??;

        let any_deleted = deleted > 0;
        let message = if any_deleted {
            format!(
                "Deleted {deleted} memor{}.",
                if deleted == 1 { "y" } else { "ies" }
            )
        } else {
            "No memory matched the given ids; they may have been deleted already.".to_string()
        };
        Ok(json!({
            "deleted": any_deleted,
            "deletedCount": deleted,
            "message": message,
        }))
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
                name: "manage".to_string(),
                description: "Unified manager for the persistent, cross-session memory bank. ONE tool with a required \"action\": save | search | list | update | delete. Project scope and the conversation provenance (for save) are injected by the runtime — never pass session/project ids.\n\nACTIONS:\n- save: create or merge (same title in the same scope merges instead of duplicating). Required: title, content. Optional: scope (\"project\" default | \"user\" = cross-project user memory injected into EVERY project), kind (fact|decision|preference|pitfall|task_state, default fact), importance (1-5, default 2), tags (string[]). Save confirmed decisions, conventions, pitfalls/fixes, structure facts, task state, and the user's durable working style — not transient state (that is todo-todo-manage) and never secrets; keep content under ~400 chars.\n- search: required query; optional kind, status (default active), limit (default 10). Ranked by title/tag/content hits, importance and recency; covers the project bank plus the cross-project user memory (entries carry \"scope\").\n- list: optional status, kind, limit (default 50), offset (default 0). Ordered by importance then last update; use to review what is remembered or to get ids.\n- update: required memoryId (string or string[]); optional title/content (single id only — title is the dedup key), kind, importance, status (\"archived\" retires without deleting), tags (replacement). Omitted fields keep their values; a batch shares one kind/importance/status/tags patch.\n- delete: required memoryId (string or string[]); DESTRUCTIVE — first get explicit user approval via user-interaction askUserQuestion, then retry with confirmed: true. Prefer update status=\"archived\" when it may still be useful. One confirmation covers a whole batch.\n\nIMPORTANCE: 1-2 (default) = retrieval-only (specific, task-bound events). >= 3 = auto-injected into the system prompt of EVERY new conversation — reserve it for general knowledge useful to nearly all sessions.\n\nUSER STYLE: save scope=\"user\" entries tagged user-style for the user's durable habits (reply language/length, formatting, code/comment conventions, confirmation appetite, tool preferences) — one entry per topic, merge by title instead of duplicating; a single clear signal is enough.\n\nRESULTS: save -> {memory, created, message}; search -> {results, count, query}; list -> {items, total, hasMore}; update -> {memories, count, message}; delete -> {deleted, deletedCount, message}. Saves only reach conversations started afterwards — the injected section of the current session stays frozen so its prompt cache keeps hitting.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["save", "search", "list", "update", "delete"],
                            "description": "Operation to run on the memory bank."
                        },
                        "memoryId": {
                            "oneOf": [
                                { "type": "string", "description": "A single memory id from list/search results." },
                                { "type": "array", "items": { "type": "string" }, "description": "Several ids; the same patch (update) or one confirmation (delete) applies to all." }
                            ],
                            "description": "For update/delete: entry id(s)."
                        },
                        "scope": {
                            "type": "string",
                            "enum": ["project", "user"],
                            "description": "For save: project (default) = this project's bank; user = cross-project user memory injected into every project (use it for durable user style/preferences)."
                        },
                        "kind": {
                            "type": "string",
                            "enum": ["fact", "decision", "preference", "pitfall", "task_state"],
                            "description": "Memory category (save default fact; optional filter for search/list; optional new value for update)."
                        },
                        "title": {
                            "type": "string",
                            "description": "For save: required one-line summary; dedup key (same title merges). For update: optional new title (single id only)."
                        },
                        "content": {
                            "type": "string",
                            "description": "For save: required details (paths, commands, reasons). For update: optional new content (single id only)."
                        },
                        "importance": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 5,
                            "description": "1-5, default 2. 1-2 = retrieval-only via action=search; >= 3 = auto-injected into every new conversation — general knowledge only."
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Lowercase retrieval keywords. save: optional; update: replacement list."
                        },
                        "query": {
                            "type": "string",
                            "description": "For search: keywords matched against titles, content and tags."
                        },
                        "status": {
                            "type": "string",
                            "enum": ["active", "pending", "archived"],
                            "description": "search/list: optional filter (search defaults to active). update: new status; archived retires without deleting."
                        },
                        "limit": { "type": "integer", "description": "search: max results (default 10). list: page size (default 50)." },
                        "offset": { "type": "integer", "description": "For list only: page offset (default 0)." },
                        "confirmed": {
                            "type": "boolean",
                            "description": "For delete only: MUST be true and only after explicit user approval via askUserQuestion."
                        }
                    },
                    "required": ["action"]
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
                "Tool \"{tool_name}\" of server \"memory\" requires the async call_mcp_tool path (project context). Available tools: [memory-manage]"
            ),
        ))
    }
}

// ---------------------------------------------------------------------------
// 域 scope 判定与系统提示词注入
// ---------------------------------------------------------------------------

/// 核心工具全名（域级判定代表集合：全部被全局黑名单禁用 → 域不可用）。
const CORE_MEMORY_TOOL_NAMES: [&str; 1] = ["memory-manage"];

/// memory 是默认启用的内置服务器：全局黑名单全部禁用，或项目 scope
/// 显式关闭 builtin:memory 时返回 false（与 collect 阶段 tool_is_enabled
/// 口径一致，保证提示词注入与工具可见性不脱节）。
async fn memory_domain_scope_allowed(project_id: Option<&str>) -> napi::Result<bool> {
    use crate::servers::scope::{builtin_scope_server_id, load_global_scope, load_project_scope};

    if let Some(global) = load_global_scope().await? {
        if CORE_MEMORY_TOOL_NAMES
            .iter()
            .all(|tool| global.is_tool_disabled(tool))
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
/// 章节按会话冻结：会话首次注入时渲染并写入 memory_prompt_snapshots，
/// 之后每轮直接复用快照——会话中新增/修改记忆不再改动提示词前缀，
/// prompt cache 全程有效，新记忆只对之后新建的会话生效。无 conversation_id
/// 时无法冻结，返回空串不注入。
///
/// - 无项目/会话上下文 / 域被禁用 / 查询失败 → 空串（静默降级）；
/// - 记忆库为空 → 注入简短引导（让 AI 知道可以开始积累记忆）；
/// - 有记忆 → importance 头部条目 + 检索/保存指引 + 库统计。
///
/// action=save 的会话溯源由分发层注入（conversation_id），无需在提示词里
/// 引导 AI 传会话 ID。
pub async fn build_system_prompt_section(
    project_id: Option<&str>,
    conversation_id: Option<&str>,
) -> String {
    let Some(project_id) = project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return String::new();
    };
    let Some(conversation_id) = conversation_id
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
    let conversation_id_owned = conversation_id.to_string();
    let loaded = crate::servers::with_database_path(move |database_path| {
        if let Some(snapshot) = snow_storage::project_memories::read_prompt_snapshot(
            &database_path,
            &conversation_id_owned,
        )? {
            return Ok(snapshot);
        }
        let records = snow_storage::project_memories::top_memories_for_injection(
            &database_path,
            &project_id_owned,
            INJECT_MIN_IMPORTANCE,
            INJECT_MAX_ENTRIES,
        )?;
        let stats =
            snow_storage::project_memories::get_memory_stats(&database_path, &project_id_owned)?;
        let section = render_memory_section(records, &stats);
        snow_storage::project_memories::write_prompt_snapshot(
            &database_path,
            &conversation_id_owned,
            &project_id_owned,
            &section,
        )?;
        Ok(section)
    })
    .await;

    loaded.unwrap_or_default()
}

/// 渲染注入章节。逐行累计并在 `INJECT_MAX_CHARS` 处截断，保证上下文预算。
fn render_memory_section(
    records: Vec<crate::storage::MemoryRecord>,
    stats: &crate::storage::MemoryStats,
) -> String {
    let mut section = String::from(
        "## Project Memory\n\nThis project keeps a persistent, cross-session memory bank — \
knowledge learned about THIS project in earlier sessions, plus the user's durable \
working style saved as cross-project memory (reply language/format/verbosity, code and \
comment conventions, how much confirmation they want, tool preferences). Project facts \
are reference material (verify them against the actual code when it matters); follow \
saved user-style preferences unless the current request says otherwise. \
This section is a snapshot taken when the session started: memories saved or edited \
afterwards are NOT listed here, so use `memory-manage` (action=\"search\") to look up recent changes.\n",
    );

    if records.is_empty() {
        if stats.total == 0 {
            section.push_str(
                "\nThe bank is currently empty. When you learn durable, cross-session \
knowledge about this project (confirmed decisions, pitfalls, task state) or the user's \
durable working style (reply language/format, code conventions, confirmation appetite, \
tool preferences), save it with `memory-manage` (action=\"save\") — it will be available in future sessions.",
            );
        } else {
            section.push_str(&format!(
                "\nNo entry currently meets the auto-inject importance bar (>= {} for \
this project, >= {} for cross-project user memory), though the bank holds {} entries. \
Use `memory-manage` (action=\"search\") to look up prior knowledge when needed.",
                INJECT_MIN_IMPORTANCE,
                (INJECT_MIN_IMPORTANCE - 1).max(1),
                stats.total
            ));
        }
    } else {
        let (global_records, project_records): (Vec<&crate::storage::MemoryRecord>, Vec<&crate::storage::MemoryRecord>) =
            records.iter().partition(|record| record.directory_id.is_empty());
        let mut used = section.chars().count();
        let truncated = push_memory_lines(
            &mut section,
            &mut used,
            "\nCross-project user memory (apply these preferences in every project):\n",
            &global_records,
        );
        if !truncated {
            push_memory_lines(
                &mut section,
                &mut used,
                "\nProject knowledge:\n",
                &project_records,
            );
        }

        section.push_str(&format!(
            "\nBank stats: {} total ({} active / {} pending / {} archived, including the \
cross-project user memory). Use \
`memory-manage` (action=\"search\") for details on any topic, and `memory-manage` (action=\"save\") when you learn \
durable knowledge worth keeping for future sessions (same-title saves in the same \
scope merge instead of duplicating). Save the user's preferences and \
communication style with scope=\"user\", tagged `user-style` (reply language, \
verbosity, formatting, code/comment conventions, confirmation appetite, tool \
habits) — one entry per topic, updated in place rather than duplicated — a single clear signal is enough to note one. When \
saving, keep specific/task-bound events at importance 1-2 (retrieval-only) and \
reserve importance >= 3 for general knowledge worth auto-injecting into every new \
session.",
            stats.total, stats.active, stats.pending, stats.archived
        ));
    }

    section
}

/// 追加一组记忆条目；返回 true 表示命中字符预算并已截断。
fn push_memory_lines(
    section: &mut String,
    used: &mut usize,
    label: &str,
    records: &[&crate::storage::MemoryRecord],
) -> bool {
    if records.is_empty() {
        return false;
    }
    section.push_str(label);
    for record in records {
        let date = record.updated_at.chars().take(10).collect::<String>();
        let content = truncate_chars(&record.content, INJECT_CONTENT_TRUNCATE);
        let line = if content.is_empty() {
            format!("- [{}] {} ({})\n", record.kind, record.title, date)
        } else {
            format!("- [{}] {} — {} ({})\n", record.kind, record.title, content, date)
        };
        *used += line.chars().count();
        if *used > INJECT_MAX_CHARS {
            section.push_str("- ... more entries exist in the bank (use `memory-manage` action=\"search\")\n");
            return true;
        }
        section.push_str(&line);
    }
    false
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
