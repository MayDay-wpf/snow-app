//! Bounded read-only prompt context. No raw queries, code or credentials are persisted.
use crate::storage::services::{codebase_index, prompt_context_policy, system_settings};
use napi::bindgen_prelude::*;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub type ProgressCallback =
    napi::threadsafe_function::ThreadsafeFunction<String, Unknown<'static>, String, Status, false>;
pub fn progress(callback: Option<&ProgressCallback>, phase: &str) {
    if let Some(callback) = callback {
        callback.call(
            phase.to_string(),
            napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

fn failure(code: &str) -> Error {
    Error::from_reason(code.to_string())
}
fn hash(value: &str) -> String {
    blake3::hash(value.as_bytes()).to_hex().to_string()
}
fn db_path() -> Result<PathBuf> {
    Ok(PathBuf::from(
        crate::storage::initialize_app_storage()?.database_path,
    ))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub owner_id: String,
    pub plugin_id: String,
    pub project_id: String,
    pub session_key: String,
    pub conversation_id: Option<String>,
    pub workspace_root: Option<String>,
    pub worktree_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub mode: String,
    pub budget: String,
    pub planner: String,
    pub rerank: bool,
    pub review_sources: bool,
    pub include_paths: Vec<String>,
    pub exclude_paths: Vec<String>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            mode: "off".into(),
            budget: "fast".into(),
            planner: "local".into(),
            rerank: false,
            review_sources: false,
            include_paths: vec![],
            exclude_paths: vec![],
        }
    }
}
pub fn options(raw: Option<&str>) -> Result<Options> {
    let o: Options = match raw {
        Some(s) if s.len() <= 16000 => {
            serde_json::from_str(s).map_err(|_| failure("invalid_context_options"))?
        }
        Some(_) => return Err(failure("invalid_context_options")),
        None => Options::default(),
    };
    if !["off", "auto", "always"].contains(&o.mode.as_str())
        || !["fast", "balanced"].contains(&o.budget.as_str())
        || !["local", "model"].contains(&o.planner.as_str())
        || o.include_paths.len() + o.exclude_paths.len() > 64
    {
        return Err(failure("invalid_context_options"));
    }
    for p in o.include_paths.iter().chain(&o.exclude_paths) {
        if !prompt_context_policy::valid_relative(p, true) {
            return Err(failure("invalid_context_paths"));
        }
    }
    Ok(o)
}
pub fn binding(raw: &str) -> Result<Binding> {
    if raw.len() > 16000 {
        return Err(failure("invalid_context_binding"));
    }
    let b: Binding = serde_json::from_str(raw).map_err(|_| failure("invalid_context_binding"))?;
    if [&b.owner_id, &b.plugin_id, &b.project_id, &b.session_key]
        .iter()
        .any(|s| s.trim().is_empty() || s.len() > 200 || s.chars().any(char::is_control))
    {
        return Err(failure("invalid_context_binding"));
    }
    Ok(b)
}
fn safe<T>(value: std::result::Result<T, rusqlite::Error>) -> Result<T> {
    value.map_err(|_| failure("context_storage_unavailable"))
}
fn validate_binding(db: &Path, b: &Binding, history: bool, retrieval: bool) -> Result<PathBuf> {
    let c = crate::storage::database::open_connection(db)
        .map_err(|_| failure("context_storage_unavailable"))?;
    let (enabled, privacy, manifest): (bool, String, String) = safe(c.query_row(
        "SELECT enabled, privacy_json, manifest_json FROM app_plugins WHERE plugin_id=?1",
        [&b.plugin_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ))?;
    let scopes: Vec<String> =
        serde_json::from_str(&privacy).map_err(|_| failure("plugin_privacy_missing"))?;
    if !enabled
        || (retrieval && !scopes.iter().any(|s| s == "projectContext"))
        || (history && !scopes.iter().any(|s| s == "messages"))
    {
        return Err(failure("plugin_privacy_missing"));
    }
    // Read the installed manifest, not caller assertions or source-directory defaults.
    let m: Value =
        serde_json::from_str(&manifest).map_err(|_| failure("plugin_privacy_missing"))?;
    if m.get("id").and_then(Value::as_str) != Some(b.plugin_id.as_str()) {
        return Err(failure("plugin_identity_mismatch"));
    }
    let (path, kind): (String, String) = safe(c.query_row(
        "SELECT path,kind FROM workspace_directories WHERE directory_id=?1",
        [&b.project_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    if kind != "local" {
        return Err(failure("remote_project_unsupported"));
    }
    if retrieval && b.worktree_id.as_deref().is_some_and(|s| !s.is_empty()) {
        return Err(failure("worktree_index_unavailable"));
    }
    let root_path = if !retrieval {
        if let Some(worktree) = b.worktree_id.as_deref().filter(|id| !id.is_empty()) {
            safe(c.query_row(
                "SELECT worktree_path FROM git_worktrees WHERE worktree_id=?1 AND directory_id=?2",
                rusqlite::params![worktree, &b.project_id],
                |r| r.get::<_, String>(0),
            ))?
        } else {
            path
        }
    } else {
        path
    };
    let root = std::fs::canonicalize(root_path).map_err(|_| failure("project_root_unavailable"))?;
    let supplied = b
        .workspace_root
        .as_deref()
        .ok_or_else(|| failure("project_root_missing"))?;
    if std::fs::canonicalize(supplied).map_err(|_| failure("project_root_unavailable"))? != root {
        return Err(failure("project_binding_mismatch"));
    }
    if let Some(id) = &b.conversation_id {
        let (pid, worktree): (String, Option<bool>) = safe(c.query_row(
            "SELECT directory_id,worktree_mode FROM chat_conversations WHERE conversation_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        if pid != b.project_id {
            return Err(failure("conversation_binding_mismatch"));
        }
        if retrieval && worktree == Some(true) {
            return Err(failure("worktree_index_unavailable"));
        }
    }
    if !retrieval {
        if let Some(id) = &b.conversation_id {
            let worktree:Option<String>=safe(c.query_row("SELECT worktree_id FROM conversation_worktree_bindings WHERE conversation_id=?1",[id],|r|r.get(0)).optional())?;
            if worktree.as_deref() != b.worktree_id.as_deref().filter(|id| !id.is_empty()) {
                return Err(failure("conversation_binding_mismatch"));
            }
        }
        return Ok(root);
    }
    let tool_scope = setting_json(&c, &format!("project_mcp_scope_{}", hash(&b.project_id)))?;
    let global_scope = setting_json(&c, "mcp_global_scope")?;
    if tool_scope
        .get("projectId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty() && id != b.project_id)
    {
        return Err(failure("context_scope_mismatch"));
    }
    if denied(&tool_scope, "disabledServerIds", "codebase")?
        || denied(&tool_scope, "disabledToolNames", "codebase-search")?
        || denied(&global_scope, "disabledToolNames", "codebase-search")?
    {
        return Err(failure("context_tool_disabled"));
    }
    let scope = setting_json(
        &c,
        &format!("project_codebase_scope_{}", hash(&b.project_id)),
    )?;
    if scope
        .get("projectId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty() && id != b.project_id)
    {
        return Err(failure("context_scope_mismatch"));
    }
    if scope.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Err(failure("project_index_disabled"));
    }
    Ok(root)
}

fn validate(db: &Path, b: &Binding, history: bool) -> Result<PathBuf> {
    validate_binding(db, b, history, true)
}

pub fn validate_history(
    input: &crate::api::prompt_optimization::PromptOptimizationRequest,
) -> Result<()> {
    if (options(input.project_context_json.as_deref())?.mode != "off"
        || input.project_binding_json.is_some())
        && input.include_context == Some(true)
    {
        let b = binding(
            input
                .project_binding_json
                .as_deref()
                .ok_or_else(|| failure("project_binding_missing"))?,
        )?;
        if b.conversation_id != input.conversation_id {
            return Err(failure("conversation_binding_mismatch"));
        }
        validate_binding(&db_path()?, &b, true, false)?;
    }
    Ok(())
}

pub fn resolve_context(
    b: &Binding,
    profile: Option<&str>,
) -> Result<crate::api::config::ActiveApiRequestContext> {
    let db = db_path()?;
    let bound = if profile.is_none() {
        match &b.conversation_id {
            Some(id) => {
                crate::storage::services::chat_conversations::get_conversation_api_profile(&db, id)
                    .map_err(|_| failure("optimization_service_unavailable"))?
            }
            None => None,
        }
    } else {
        None
    };
    crate::api::config::get_api_request_context_for_profile(profile.or(bound.as_deref()))
        .map_err(|_| failure("optimization_service_unavailable"))
}
struct Services {
    fingerprint: String,
    embedding: crate::api::embedding::EmbeddingConfig,
    reranking: crate::api::reranking::RerankingConfig,
    labels: Value,
}
fn services(
    db: &Path,
    b: &Binding,
    profile: Option<&str>,
    model: Option<&str>,
    o: &Options,
) -> Result<Services> {
    let c = crate::storage::database::open_connection(db)
        .map_err(|_| failure("context_storage_unavailable"))?;
    // Consent must react immediately to settings updates, not the general UI cache TTL.
    // 选中的嵌入 / 重排模型展开后参与指纹，模型配置变化同样使授权失效。
    let (_, v): (String, Value) =
        safe(system_settings::resolve_codebase_settings_with_connection(&c))?;
    let raw = v.to_string();
    let (manifest, privacy): (String, String) = safe(c.query_row(
        "SELECT manifest_json,privacy_json FROM app_plugins WHERE plugin_id=?1",
        [&b.plugin_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let tool_scope = setting_json(&c, &format!("project_mcp_scope_{}", hash(&b.project_id)))?;
    let global_scope = setting_json(&c, "mcp_global_scope")?;
    if tool_scope
        .get("projectId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty() && id != b.project_id)
    {
        return Err(failure("context_scope_mismatch"));
    }
    let s = |key: &str| v.get(key).and_then(Value::as_str).unwrap_or("");
    let n = |key: &str| {
        v.get(key)
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .clamp(0, 100000) as i32
    };
    let context = resolve_context(b, profile)?;
    let model = crate::api::config::resolve_basic_model(model, &context.api_config.basic_model)
        .map_err(|_| failure("optimization_service_unavailable"))?;
    // Credential/config changes invalidate consent; only the hash is stored.
    let headers = std::collections::BTreeMap::from_iter(context.custom_headers.iter());
    let fingerprint=hash(&json!({"codebase":hash(&raw),"manifest":hash(&manifest),"privacy":hash(&privacy),"tools":tool_scope,"globalTools":global_scope,"optimization":hash(&context.api_config.config_json),"endpoint":context.api_config.base_url,"endpointMode":context.api_config.base_url_mode,"credential":hash(&context.api_config.api_key),"method":context.api_config.request_method,"profile":context.api_config.profile_name,"model":model,"headers":headers,"root":b.workspace_root,"plugin":b.plugin_id,"project":b.project_id,"rerank":o.rerank,"planner":o.planner}).to_string());
    let mut embedding = crate::api::embedding::EmbeddingConfig::from_settings(
        s("embeddingType"),
        s("embeddingModelName"),
        s("embeddingBaseUrl"),
        s("embeddingApiKey"),
        n("embeddingDimensions"),
    );
    embedding.model_name = crate::api::embedding::resolve_default_model(&embedding);
    let reranking = crate::api::reranking::RerankingConfig::from_settings(
        s("rerankingModelName"),
        s("rerankingBaseUrl"),
        s("rerankingApiKey"),
        n("rerankingContextLength"),
        8,
    );
    let mut labels = vec![
        json!({"kind":"embedding","label":service_label(&embedding.model_name,"embedding")}),
        json!({"kind":"optimization","label":service_label(&model,"optimization")}),
    ];
    if o.rerank {
        labels.push(
            json!({"kind":"reranking","label":service_label(&reranking.model_name,"reranking")}),
        );
    }
    if o.planner == "model" {
        labels.push(json!({"kind":"planner","label":service_label(&model,"planner")}));
    }
    Ok(Services {
        fingerprint,
        embedding,
        reranking,
        labels: json!(labels),
    })
}
fn service_label(value: &str, fallback: &str) -> String {
    if value.len() <= 96
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._/ ".contains(c))
    {
        value.to_string()
    } else {
        fallback.to_string()
    }
}
fn consent_key(b: &Binding) -> String {
    format!(
        "prompt_context_access_{}",
        hash(&json!([b.plugin_id, b.project_id, b.workspace_root]).to_string())
    )
}
fn authorized(db: &Path, b: &Binding, s: &Services) -> Result<bool> {
    let c = crate::storage::database::open_connection(db)
        .map_err(|_| failure("context_storage_unavailable"))?;
    let value: Option<String> = safe(
        c.query_row(
            "SELECT setting_value FROM system_settings WHERE setting_code=?1",
            [consent_key(b)],
            |r| r.get(0),
        )
        .optional(),
    )?;
    Ok(value.as_deref() == Some(s.fingerprint.as_str()))
}
static ACCESS_LOCK: Mutex<()> = Mutex::new(());

pub fn access(
    binding_json: &str,
    profile: Option<&str>,
    model: Option<&str>,
    raw_options: Option<&str>,
    grant: Option<bool>,
    authorization_ticket: Option<&str>,
) -> Result<String> {
    let _access = ACCESS_LOCK
        .lock()
        .map_err(|_| failure("context_memory_unavailable"))?;
    let b = binding(binding_json)?;
    let o = options(raw_options)?;
    let db = db_path()?;
    let ticket = if grant == Some(true) {
        Some(consume_ticket(authorization_ticket)?)
    } else {
        None
    };
    let validation = validate(&db, &b, false);
    if grant == Some(false) {
        system_settings::set_system_setting(
            &db,
            "Prompt context access",
            &consent_key(&b),
            "false",
        )
        .map_err(|_| failure("context_access_write_failed"))?;
        if let Ok(mut mem) = memory().lock() {
            mem.retain(|_, e| {
                e.binding.plugin_id != b.plugin_id || e.binding.project_id != b.project_id
            });
        }
        if let Ok(mut tickets) = tickets().lock() {
            tickets.retain(|_, t| {
                t.binding.plugin_id != b.plugin_id || t.binding.project_id != b.project_id
            });
        }
        return Ok("true".into());
    }
    if let Err(e) = validation {
        if grant == Some(true) {
            return Err(e);
        }
        return Ok(
            json!({"projectId":b.project_id,"status":e.reason,"authorized":false,"services":[]})
                .to_string(),
        );
    }
    let s = services(&db, &b, profile, model, &o)?;
    if grant == Some(true) {
        let ticket = ticket.ok_or_else(|| failure("authorization_ticket_required"))?;
        if ticket.binding != b
            || ticket.fingerprint != s.fingerprint
            || ticket.request != ticket_request(&o, profile, model)
        {
            return Err(failure("authorization_ticket_changed"));
        }
        system_settings::set_system_setting(
            &db,
            "Prompt context access",
            &consent_key(&b),
            &s.fingerprint,
        )
        .map_err(|_| failure("context_access_write_failed"))?;
    }
    let authorized = authorized(&db, &b, &s)?;
    let status = if indexing(&b.project_id) {
        "indexing"
    } else if snapshot(&db, &b.project_id).is_err() {
        "index_unavailable"
    } else if authorized {
        "ready"
    } else {
        "authorization_required"
    };
    let ticket = if grant.is_none() {
        Some(issue_ticket(&b, &s.fingerprint, &o, profile, model)?)
    } else {
        None
    };
    Ok(json!({"projectId":b.project_id,"status":status,"authorized":authorized,"services":s.labels,"authorizationTicket":ticket}).to_string())
}
fn indexing(id: &str) -> bool {
    crate::codebase_state_port::is_embedding_active(id)
        || crate::codebase_state_port::is_sync_active(id)
}

#[derive(Clone)]
struct Source {
    id: String,
    path: String,
    start: i32,
    end: i32,
    text: String,
    file_hash: String,
    kind: String,
    score: f64,
}
impl Source {
    fn report(&self, selected: bool) -> Value {
        json!({"id":self.id,"path":self.path,"startLine":self.start,"endLine":self.end,"matchKind":self.kind,"characters":self.text.chars().count(),"freshness":"fresh","selected":selected})
    }
}
#[derive(Clone)]
struct Entry {
    binding: Binding,
    fingerprint: String,
    index: String,
    query: String,
    options: Options,
    profile: Option<String>,
    model: Option<String>,
    sources: Vec<Source>,
    created: Instant,
    warnings: Vec<String>,
    truncated: bool,
}
static MEMORY: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
fn memory() -> &'static Mutex<HashMap<String, Entry>> {
    MEMORY.get_or_init(|| Mutex::new(HashMap::new()))
}
fn insert(key: String, entry: Entry) -> Result<()> {
    let mut mem = memory()
        .lock()
        .map_err(|_| failure("context_memory_unavailable"))?;
    mem.retain(|_, e| e.created.elapsed() < Duration::from_secs(300));
    let chars: usize = mem
        .values()
        .map(|e| e.sources.iter().map(|s| s.text.len()).sum::<usize>())
        .sum();
    let added: usize = entry.sources.iter().map(|s| s.text.len()).sum();
    if mem.len() >= 64 || chars.saturating_add(added) > 512000 {
        mem.clear();
    }
    mem.insert(key, entry);
    Ok(())
}
fn sensitive_path(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    path.split('/').any(|p| {
        p.starts_with(".env")
            || [
                ".git",
                ".ssh",
                ".snow",
                ".snowapp",
                "node_modules",
                "credentials",
                "secrets",
            ]
            .contains(&p)
    }) || [
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".keystore",
        ".sqlite",
        ".db",
    ]
    .iter()
    .any(|s| path.ends_with(s))
        || path.contains("secret")
        || path.contains("credential")
}
fn file_hash(root: &Path, path: &str) -> Result<String> {
    if sensitive_path(path)
        || path.contains('\\')
        || path.contains(':')
        || Path::new(path).is_absolute()
        || path.split('/').any(|s| s == "..")
    {
        return Err(failure("unsafe_source_path"));
    }
    let p = prompt_context_policy::eligible_source(root, path)?;
    let target = p
        .strip_prefix(root)
        .map_err(|_| failure("source_outside_project"))?
        .to_string_lossy()
        .replace(char::from(92), "/");
    if sensitive_path(&target) {
        return Err(failure("unsafe_source_path"));
    }
    if !p.starts_with(root) {
        return Err(failure("source_outside_project"));
    }
    let metadata = std::fs::metadata(&p).map_err(|_| failure("source_unavailable"))?;
    if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 {
        return Err(failure("source_budget_exceeded"));
    }
    let bytes = std::fs::read(p).map_err(|_| failure("source_unavailable"))?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}
struct Record {
    source: Source,
    embedding: Vec<f64>,
    model: String,
}
// Strict DB failure semantics, bounded full metadata snapshot. Unknown/stale is
// never promoted to full-index freshness merely because candidates validate.
fn snapshot(db: &Path, pid: &str) -> Result<(String, Vec<Record>)> {
    let c = crate::storage::database::open_connection(db)
        .map_err(|_| failure("context_storage_unavailable"))?;
    let table = codebase_index::vector_table_name(pid);
    // 旧索引表可能缺少 BLOB 列：先升级结构并迁移旧数据。
    let _ = codebase_index::ensure_vector_schema(db, &c, &table);
    let count: i64 = safe(c.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE project_id=?1"),
        [pid],
        |r| r.get(0),
    ))?;
    if count == 0 {
        return Err(failure("index_empty"));
    }
    if count > 20000 {
        return Err(failure("index_budget_exceeded"));
    }
    let mut q=safe(c.prepare(&format!("SELECT id,relative_path,start_line,end_line,content,file_hash,embedding,embedding_model,created_at FROM {table} WHERE project_id=?1 ORDER BY id")))?;
    let rows = safe(q.query_map([pid], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i32>(2)?,
            r.get::<_, i32>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<Vec<u8>>>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
        ))
    }))?;
    let mut records = vec![];
    let mut digest = blake3::Hasher::new();
    let mut total = 0;
    digest.update(
        crate::storage::services::codebase_watcher::prompt_context_change_fingerprint(pid)
            .unwrap_or_default()
            .as_bytes(),
    );
    for row in rows {
        let (id, path, start, end, text, file_hash, embedding_blob, model, created) = safe(row)?;
        let stored_bytes = embedding_blob.as_deref().unwrap_or_default();
        total += text.len() + stored_bytes.len();
        if total > 32 * 1024 * 1024 {
            return Err(failure("index_budget_exceeded"));
        }
        digest.update(
            json!([
                id,
                path,
                start,
                end,
                file_hash,
                model,
                created,
                hash(&text),
                hash(&String::from_utf8_lossy(stored_bytes))
            ])
            .to_string()
            .as_bytes(),
        );
        let Some(vector) = codebase_index::decode_embedding(stored_bytes) else {
            return Err(failure("index_vector_invalid"));
        };
        let embedding: Vec<f64> = vector.into_iter().map(|value| value as f64).collect();
        if embedding.is_empty() || embedding.iter().any(|v| !v.is_finite()) {
            return Err(failure("index_vector_invalid"));
        }
        records.push(Record {
            source: Source {
                id: hash(&id),
                path,
                start,
                end,
                text,
                file_hash,
                kind: "semantic".into(),
                score: 0.0,
            },
            embedding,
            model,
        });
    }
    if records.len() != count as usize {
        return Err(failure("context_index_changed"));
    }
    let project_path: String = safe(c.query_row(
        "SELECT path FROM workspace_directories WHERE directory_id=?1 AND kind='local'",
        [pid],
        |r| r.get(0),
    ))?;
    let root =
        std::fs::canonicalize(project_path).map_err(|_| failure("project_root_unavailable"))?;
    digest.update(
        prompt_context_policy::fingerprint(&root, records.iter().map(|r| r.source.path.as_str()))?
            .as_bytes(),
    );
    Ok((digest.finalize().to_hex().to_string(), records))
}
fn check_entry(e: &Entry, owner: &str) -> Result<PathBuf> {
    if e.binding.owner_id != owner || e.created.elapsed() >= Duration::from_secs(300) {
        return Err(failure("context_handle_expired"));
    }
    let db = db_path()?;
    let root = validate(&db, &e.binding, false)?;
    let s = services(
        &db,
        &e.binding,
        e.profile.as_deref(),
        e.model.as_deref(),
        &e.options,
    )?;
    if e.fingerprint != s.fingerprint || !authorized(&db, &e.binding, &s)? {
        return Err(failure("context_authorization_changed"));
    }
    if indexing(&e.binding.project_id) || snapshot(&db, &e.binding.project_id)?.0 != e.index {
        return Err(failure("context_index_changed"));
    }
    for source in &e.sources {
        if file_hash(&root, &source.path)? != source.file_hash {
            return Err(failure("context_source_changed"));
        }
    }
    Ok(root)
}
pub fn preview(handle: &str, id: &str, owner: &str) -> Result<String> {
    if handle.len() > 200 || id.len() > 200 || owner.len() > 200 {
        return Err(failure("invalid_context_handle"));
    }
    let e = memory()
        .lock()
        .map_err(|_| failure("context_memory_unavailable"))?
        .get(handle)
        .cloned()
        .ok_or_else(|| failure("context_handle_expired"))?;
    check_entry(&e, owner)?;
    let source = e
        .sources
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| failure("unknown_context_source"))?;
    Ok(json!({"id":source.id,"path":source.path,"startLine":source.start,"endLine":source.end,"content":crate::mcp::privacy_mask::mask_local(&source.text)}).to_string())
}
pub struct Prepared {
    pub code: Value,
    pub report: Option<String>,
    pub handle: Option<String>,
    pub review: bool,
    guard: Option<Entry>,
}
fn report(
    outcome: &str,
    reason: &str,
    sources: &[Source],
    warnings: &[String],
    kind: &str,
    elapsed: Instant,
    hit: bool,
    truncated: bool,
) -> String {
    let kind = if sources.is_empty() {
        kind
    } else {
        source_query_kind(sources)
    };
    json!({"outcome":outcome,"reason":reason,"sources":sources.iter().map(|s|s.report(true)).collect::<Vec<_>>(),"warnings":warnings,"indexState":if reason=="indexing" {"indexing"} else if reason=="context_source_changed" || warnings.iter().any(|w|w=="context_source_changed") {"stale"} else if sources.is_empty() {"unavailable"} else {"unknown"},"queryKind":kind,"characters":sources.iter().map(|s|s.text.chars().count()).sum::<usize>(),"elapsedMs":elapsed.elapsed().as_millis(),"cacheHit":hit,"truncated":truncated}).to_string()
}
fn code(sources: &[Source]) -> Value {
    json!(sources
        .iter()
        .map(|s| json!({"path":s.path,"startLine":s.start,"endLine":s.end,"content":s.text}))
        .collect::<Vec<_>>())
}
fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !(c.is_alphanumeric() || "_./-".contains(c)))
        .filter(|s| {
            s.chars().count() >= 3
                && s.len() <= 120
                && ![
                    "the",
                    "this",
                    "that",
                    "with",
                    "from",
                    "into",
                    "for",
                    "and",
                    "not",
                    "are",
                    "you",
                    "please",
                    "code",
                    "function",
                    "class",
                    "module",
                    "implement",
                    "refactor",
                    "fix",
                    "return",
                    "pub",
                    "const",
                    "let",
                    "string",
                ]
                .contains(&s.to_ascii_lowercase().as_str())
        })
        .take(80)
        .map(str::to_owned)
        .collect()
}
fn code_intent(draft: &str) -> bool {
    [
        "代码",
        "函数",
        "项目",
        "接口",
        "模块",
        "类",
        "实现",
        "重构",
        "修复",
        "源码",
        "组件",
        "bug",
        "function",
        "class",
        "code",
        "api",
        "module",
        "implement",
        "refactor",
        "fix",
    ]
    .iter()
    .any(|s| draft.to_ascii_lowercase().contains(s))
        || tokens(draft)
            .iter()
            .any(|s| s.contains('/') || s.contains('.'))
}
fn cosine(a: &[f64], b: &[f64]) -> Option<f64> {
    if a.len() != b.len() || a.iter().chain(b).any(|v| !v.is_finite()) {
        return None;
    }
    let norm = (a.iter().map(|v| v * v).sum::<f64>() * b.iter().map(|v| v * v).sum::<f64>()).sqrt();
    if norm == 0.0 {
        None
    } else {
        Some(a.iter().zip(b).map(|(a, b)| a * b).sum::<f64>() / norm)
    }
}
async fn bounded<T>(
    cancel: &CancellationToken,
    seconds: u64,
    future: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {biased; _=cancel.cancelled()=>Err(failure("Prompt optimization cancelled")), result=tokio::time::timeout(Duration::from_secs(seconds),future)=>result.map_err(|_|failure("context_service_timeout"))?.map_err(|_|failure("context_service_failed"))}
}

pub async fn prepare(
    input: &crate::api::prompt_optimization::PromptOptimizationRequest,
    history: &Value,
    cancel: &CancellationToken,
    on_progress: Option<&ProgressCallback>,
) -> Result<Prepared> {
    let started = Instant::now();
    let o = options(input.project_context_json.as_deref())?;
    let timeout = if o.budget == "fast" { 8 } else { 12 };
    if o.mode == "off" {
        if input.context_handle.is_some() || input.selected_source_ids.is_some() {
            return Err(failure("context_handle_binding_mismatch"));
        }
        return Ok(Prepared {
            code: json!([]),
            report: None,
            handle: None,
            review: false,
            guard: None,
        });
    }
    let empty = |reason: &str| Prepared {
        code: json!([]),
        report: Some(report(
            "degraded",
            reason,
            &[],
            &[],
            "none",
            started,
            false,
            false,
        )),
        handle: None,
        review: false,
        guard: None,
    };
    let b = match input
        .project_binding_json
        .as_deref()
        .map(binding)
        .transpose()?
    {
        Some(b) => b,
        None => {
            if input.context_handle.is_some() {
                return Err(failure("project_binding_missing"));
            }
            return Ok(empty("project_binding_missing"));
        }
    };
    if b.conversation_id != input.conversation_id {
        return Err(failure("conversation_binding_mismatch"));
    }
    let db = db_path()?;
    let root = match validate(&db, &b, input.include_context == Some(true)) {
        Ok(v) => v,
        Err(e) => {
            if input.context_handle.is_some() || !availability_failure(&e.reason) {
                return Err(e);
            }
            return Ok(empty(&e.reason));
        }
    };
    crate::mcp::tools::ensure_project_tool_enabled(Some(&b.project_id), "codebase-search", false)
        .await
        .map_err(|_| failure("context_tool_disabled"))?;
    let s = services(
        &db,
        &b,
        input.api_profile.as_deref(),
        input.model.as_deref(),
        &o,
    )?;
    if !authorized(&db, &b, &s)? {
        if input.context_handle.is_some() {
            return Err(failure("context_authorization_changed"));
        }
        return Ok(empty("authorization_required"));
    }
    if indexing(&b.project_id) {
        if input.context_handle.is_some() {
            return Err(failure("context_index_changed"));
        }
        return Ok(empty("indexing"));
    }
    progress(on_progress, "searching");
    let (index, mut records) = match snapshot(&db, &b.project_id) {
        Ok(v) => v,
        Err(e) => {
            if input.context_handle.is_some() {
                return Err(e);
            }
            return Ok(empty(&e.reason));
        }
    };
    // 维度未配置（0）时以已索引向量的长度为准。
    let expected_dim = match s.embedding.dimensions {
        0 => records.first().map_or(0, |r| r.embedding.len()),
        d => d,
    };
    if records
        .iter()
        .any(|r| r.model != s.embedding.model_name || r.embedding.len() != expected_dim)
    {
        if input.context_handle.is_some() {
            return Err(failure("context_index_changed"));
        }
        return Ok(empty("index_model_or_dimension_mismatch"));
    }
    let query = crate::mcp::privacy_mask::mask_local(&input.draft);
    let query_hash = hash(
        &json!([
            query,
            if input.include_context == Some(true) {
                history.clone()
            } else {
                json!([])
            },
            input.optimization_instructions
        ])
        .to_string(),
    );
    if input
        .context_handle
        .as_ref()
        .is_some_and(|v| v.is_empty() || v.len() > 200)
        || input.selected_source_ids.as_ref().is_some_and(|ids| {
            ids.len() > 16 || ids.iter().any(|id| id.is_empty() || id.len() > 200)
        })
    {
        return Err(failure("invalid_context_selection"));
    }
    if let Some(handle) = &input.context_handle {
        let entry = memory()
            .lock()
            .map_err(|_| failure("context_memory_unavailable"))?
            .get(handle)
            .cloned()
            .ok_or_else(|| failure("context_handle_expired"))?;
        if entry.binding != b
            || entry.query != query_hash
            || entry.fingerprint != s.fingerprint
            || serde_json::to_string(&entry.options).ok() != serde_json::to_string(&o).ok()
        {
            return Err(failure("context_handle_binding_mismatch"));
        }
        check_entry(&entry, &b.owner_id)?;
        let selected = input
            .selected_source_ids
            .as_ref()
            .ok_or_else(|| failure("context_selection_missing"))?;
        if selected.len() > 16
            || selected
                .iter()
                .any(|id| !entry.sources.iter().any(|s| &s.id == id))
        {
            return Err(failure("unknown_context_source"));
        }
        let sources: Vec<Source> = entry
            .sources
            .iter()
            .cloned()
            .filter(|s| selected.contains(&s.id))
            .collect();
        memory()
            .lock()
            .map_err(|_| failure("context_memory_unavailable"))?
            .remove(handle);
        return Ok(Prepared {
            code: code(&sources),
            report: Some(report(
                if sources.is_empty() {
                    "skipped"
                } else {
                    "used"
                },
                "sources_selected",
                &sources,
                &[],
                "mixed",
                started,
                false,
                false,
            )),
            handle: None,
            review: false,
            guard: Some(Entry {
                sources: sources.clone(),
                ..entry
            }),
        });
    }
    if input.selected_source_ids.is_some() {
        return Err(failure("context_handle_missing"));
    }
    if o.mode == "auto" && !code_intent(&query) {
        return Ok(Prepared {
            code: json!([]),
            report: Some(report(
                "skipped",
                "not_code_related",
                &[],
                &[],
                "none",
                started,
                false,
                false,
            )),
            handle: None,
            review: false,
            guard: None,
        });
    }
    let cache_key = hash(&json!([b, query_hash, s.fingerprint, index, o]).to_string());
    let cached = memory()
        .lock()
        .map_err(|_| failure("context_memory_unavailable"))?
        .get(&cache_key)
        .cloned();
    let mut hit = false;
    let mut warnings = vec![];
    let mut query_kind = "exact";
    let mut truncated = false;
    let watched = crate::storage::services::codebase_watcher::prompt_context_change_fingerprint(
        &b.project_id,
    )
    .is_some();
    let mut sources = if let Some(entry) = cached.filter(|e| {
        watched
            && e.created.elapsed() < Duration::from_secs(45)
            && check_entry(e, &b.owner_id).is_ok()
    }) {
        hit = true;
        warnings = entry.warnings.clone();
        truncated = entry.truncated;
        entry.sources
    } else {
        let mut search = query.clone();
        if input.include_context == Some(true)
            && (query.contains("这个")
                || query.contains("上述")
                || query.contains("this")
                || query.contains("above"))
        {
            let reference = crate::mcp::privacy_mask::mask_local(&history.to_string());
            search.push(' ');
            search.push_str(
                &reference
                    .chars()
                    .rev()
                    .take(1000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>(),
            );
        }
        if o.planner == "model" {
            ensure_current(
                &db,
                &b,
                &o,
                &s.fingerprint,
                &index,
                input.api_profile.as_deref(),
                input.model.as_deref(),
            )
            .await?;
            let planner = crate::api::prompt_optimization::plan_context_query(
                &b,
                input.api_profile.as_deref(),
                input.model.as_deref(),
                &query,
                history,
                cancel,
            );
            match bounded(cancel, timeout, planner).await {
                Ok(q) => search = crate::mcp::privacy_mask::mask_local(&q),
                Err(_) => warnings.push("planner_unavailable".into()),
            }
        }
        let terms = tokens(&search);
        for r in &mut records {
            let exact = terms
                .iter()
                .filter(|t| {
                    r.source.path == **t
                        || r.source.path.ends_with(&format!("/{t}"))
                        || r.source
                            .text
                            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                            .any(|word| word == *t)
                })
                .count();
            if exact > 0 {
                r.source.score = 2.0 + (exact as f64 / terms.len().max(1) as f64);
                r.source.kind = "exact".into();
            }
        }
        for term in &terms {
            if !term.contains('/') {
                let paths: HashSet<_> = records
                    .iter()
                    .filter(|r| {
                        r.source.kind == "exact"
                            && (r.source.path.ends_with(&format!("/{term}"))
                                || r.source.path == *term)
                    })
                    .map(|r| r.source.path.as_str())
                    .collect();
                if paths.len() > 1 {
                    warnings.push("ambiguous_source_name".into());
                }
            }
        }
        let needs_semantic = records.iter().filter(|r| r.source.score > 2.0).count() < 2;
        if needs_semantic {
            ensure_current(
                &db,
                &b,
                &o,
                &s.fingerprint,
                &index,
                input.api_profile.as_deref(),
                input.model.as_deref(),
            )
            .await?;
            // Only one bounded embedding request; no agent-review loop.
            match bounded(
                cancel,
                timeout,
                crate::api::embedding::embed_batch(
                    &s.embedding,
                    &[crate::mcp::privacy_mask::mask_local(
                        &search.chars().take(2000).collect::<String>(),
                    )],
                ),
            )
            .await
            {
                Ok(vectors) => {
                    if let Some(vector) = vectors.first() {
                        if vector.len() != expected_dim {
                            warnings.push("embedding_dimension_mismatch".into());
                        } else {
                            query_kind = "mixed";
                            for r in &mut records {
                                if r.model == s.embedding.model_name {
                                    if let Some(score) = cosine(vector, &r.embedding) {
                                        if r.source.score > 2.0 {
                                            r.source.kind = "mixed".into();
                                        } else {
                                            r.source.score = score;
                                        }
                                    }
                                } else {
                                    warnings.push("index_model_mismatch".into());
                                }
                            }
                        }
                    }
                }
                Err(_) => warnings.push("embedding_unavailable".into()),
            }
        }
        records.sort_by(|a, b| b.source.score.total_cmp(&a.source.score));
        let mut selected: Vec<Source> = vec![];
        let mut per_file = HashMap::<String, usize>::new();
        let mut chars = 0;
        let total_budget: usize = if o.budget == "fast" { 36000 } else { 48000 };
        let fixed_chars = input.draft.chars().count()
            + history.to_string().chars().count()
            + input
                .optimization_instructions
                .as_ref()
                .map(|v| v.chars().count())
                .unwrap_or(0)
            + 4000;
        let max_chars = (if o.budget == "fast" { 6000 } else { 12000 })
            .min(total_budget.saturating_sub(fixed_chars));
        let max_sources = if o.budget == "fast" { 4 } else { 8 };
        for r in records {
            let mut source = r.source;
            if source.score < 0.45
                || source.start < 1
                || source.end < source.start
                || source.file_hash.is_empty()
                || sensitive_path(&source.path)
                || (!o.include_paths.is_empty()
                    && !o
                        .include_paths
                        .iter()
                        .any(|p| prompt_context_policy::matches_path(&source.path, p)))
                || o.exclude_paths
                    .iter()
                    .any(|p| prompt_context_policy::matches_path(&source.path, p))
            {
                continue;
            }
            if per_file.get(&source.path).copied().unwrap_or(0) >= 2
                || selected.iter().any(|s| {
                    s.path == source.path && s.start <= source.end && source.start <= s.end
                })
            {
                continue;
            }
            if file_hash(&root, &source.path).ok().as_deref() != Some(&source.file_hash) {
                warnings.push("context_source_changed".into());
                continue;
            }
            source.text = crate::mcp::privacy_mask::mask_local(&source.text);
            let remaining = max_chars - chars;
            if remaining == 0 {
                truncated = true;
                break;
            }
            if source.text.chars().count() > remaining.min(3000) {
                truncated = true;
                source.text = source.text.chars().take(remaining.min(3000)).collect();
                source.end = source.start + source.text.lines().count().saturating_sub(1) as i32;
            }
            chars += source.text.chars().count();
            *per_file.entry(source.path.clone()).or_default() += 1;
            selected.push(source);
            if selected.len() >= max_sources {
                truncated = true;
                break;
            }
        }
        if o.rerank && !selected.is_empty() {
            ensure_current(
                &db,
                &b,
                &o,
                &s.fingerprint,
                &index,
                input.api_profile.as_deref(),
                input.model.as_deref(),
            )
            .await?;
            for source in &selected {
                if file_hash(&root, &source.path)? != source.file_hash {
                    return Err(failure("context_source_changed"));
                }
            }
            let documents: Vec<_> = selected
                .iter()
                .enumerate()
                .map(|(index, s)| crate::api::reranking::RerankDocument {
                    index,
                    text: crate::mcp::privacy_mask::mask_local(&s.text),
                })
                .collect();
            match bounded(
                cancel,
                timeout,
                crate::api::reranking::rerank(
                    &s.reranking,
                    &crate::mcp::privacy_mask::mask_local(&search),
                    &documents,
                ),
            )
            .await
            {
                Ok(results) => {
                    let mut seen = HashSet::new();
                    let ordered: Vec<_> = results
                        .into_iter()
                        .filter(|r| r.score.is_finite() && r.score >= 0.0 && seen.insert(r.index))
                        .filter_map(|r| selected.get(r.index).cloned())
                        .collect();
                    if !ordered.is_empty() {
                        selected = ordered;
                    }
                }
                Err(_) => warnings.push("reranking_unavailable".into()),
            }
        }
        selected
    };
    progress(on_progress, "checking");
    // Re-check all mutable security and freshness facts immediately before use.
    let entry = Entry {
        binding: b.clone(),
        fingerprint: s.fingerprint,
        index,
        query: query_hash,
        options: o.clone(),
        profile: input.api_profile.clone(),
        model: input.model.clone(),
        sources: sources.clone(),
        created: Instant::now(),
        warnings: warnings.clone(),
        truncated,
    };
    check_entry(&entry, &b.owner_id)?;
    warnings.sort();
    warnings.dedup();
    if sources.is_empty() {
        return Ok(Prepared {
            code: json!([]),
            report: Some(report(
                "skipped",
                "no_relevant_sources",
                &[],
                &warnings,
                query_kind,
                started,
                hit,
                truncated,
            )),
            handle: None,
            review: false,
            guard: None,
        });
    }
    insert(cache_key, entry.clone())?;
    if o.review_sources {
        let handle = uuid::Uuid::new_v4().to_string();
        insert(handle.clone(), entry)?;
        return Ok(Prepared {
            code: json!([]),
            report: Some(report(
                "review_required",
                "source_review_required",
                &sources,
                &warnings,
                query_kind,
                started,
                hit,
                truncated,
            )),
            handle: Some(handle),
            review: true,
            guard: None,
        });
    }
    for source in &mut sources {
        source.text = crate::mcp::privacy_mask::mask_local(&source.text);
    }
    Ok(Prepared {
        code: code(&sources),
        report: Some(report(
            if warnings.is_empty() {
                "used"
            } else {
                "degraded"
            },
            "bounded_project_context",
            &sources,
            &warnings,
            query_kind,
            started,
            hit,
            truncated,
        )),
        handle: None,
        review: false,
        guard: Some(entry),
    })
}

async fn ensure_current(
    db: &Path,
    b: &Binding,
    o: &Options,
    fingerprint: &str,
    index: &str,
    profile: Option<&str>,
    model: Option<&str>,
) -> Result<()> {
    validate(db, b, false)?;
    let current = services(db, b, profile, model, o)?;
    if current.fingerprint != fingerprint || !authorized(db, b, &current)? {
        return Err(failure("context_authorization_changed"));
    }
    if indexing(&b.project_id) {
        return Err(failure("indexing"));
    }
    if snapshot(db, &b.project_id)?.0 != index {
        return Err(failure("context_source_policy_changed"));
    }
    crate::mcp::tools::ensure_project_tool_enabled(Some(&b.project_id), "codebase-search", false)
        .await
        .map_err(|_| failure("context_tool_disabled"))
}

fn setting_json(c: &rusqlite::Connection, key: &str) -> Result<Value> {
    let raw: Option<String> = safe(
        c.query_row(
            "SELECT setting_value FROM system_settings WHERE setting_code=?1",
            [key],
            |r| r.get(0),
        )
        .optional(),
    )?;
    let Some(raw) = raw else {
        return Ok(json!({}));
    };
    if raw.len() > 128000 {
        return Err(failure("context_settings_invalid"));
    }
    let value: Value =
        serde_json::from_str(&raw).map_err(|_| failure("context_settings_invalid"))?;
    if !value.is_object() {
        return Err(failure("context_settings_invalid"));
    }
    Ok(value)
}
fn denied(scope: &Value, key: &str, name: &str) -> Result<bool> {
    let Some(value) = scope.get(key) else {
        return Ok(false);
    };
    let list = value
        .as_array()
        .ok_or_else(|| failure("context_settings_invalid"))?;
    if list.iter().any(|v| !v.is_string()) {
        return Err(failure("context_settings_invalid"));
    }
    Ok(list.iter().any(|v| v.as_str() == Some(name)))
}
pub async fn outbound_context(
    input: &crate::api::prompt_optimization::PromptOptimizationRequest,
    prepared: &Prepared,
) -> Result<Option<crate::api::config::ActiveApiRequestContext>> {
    let Some(e) = &prepared.guard else {
        return Ok(None);
    };
    if e.sources.is_empty() {
        return Ok(None);
    }
    let db = db_path()?;
    ensure_current(
        &db,
        &e.binding,
        &e.options,
        &e.fingerprint,
        &e.index,
        e.profile.as_deref(),
        e.model.as_deref(),
    )
    .await?;
    check_entry(e, &e.binding.owner_id)?;
    validate(&db, &e.binding, input.include_context == Some(true))?;
    let context = resolve_context(&e.binding, input.api_profile.as_deref())?;
    // Configuration was just reloaded for this outbound request, never reuse
    // the optimization profile snapshot captured before embedding/planning.
    Ok(Some(context))
}

fn source_query_kind(sources: &[Source]) -> &'static str {
    let exact = sources
        .iter()
        .any(|s| s.kind == "exact" || s.kind == "mixed");
    let semantic = sources
        .iter()
        .any(|s| s.kind == "semantic" || s.kind == "mixed");
    match (exact, semantic) {
        (true, true) => "mixed",
        (true, false) => "exact",
        (false, true) => "semantic",
        _ => "none",
    }
}

struct AuthorizationTicket {
    binding: Binding,
    fingerprint: String,
    request: String,
    created: Instant,
}
static TICKETS: OnceLock<Mutex<HashMap<String, AuthorizationTicket>>> = OnceLock::new();
fn tickets() -> &'static Mutex<HashMap<String, AuthorizationTicket>> {
    TICKETS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn ticket_request(o: &Options, profile: Option<&str>, model: Option<&str>) -> String {
    hash(&json!([o, profile, model]).to_string())
}
fn issue_ticket(
    b: &Binding,
    fingerprint: &str,
    o: &Options,
    profile: Option<&str>,
    model: Option<&str>,
) -> Result<String> {
    let mut tickets = tickets()
        .lock()
        .map_err(|_| failure("context_memory_unavailable"))?;
    tickets.retain(|_, t| t.created.elapsed() < Duration::from_secs(120));
    if tickets.len() >= 128 {
        if let Some(oldest) = tickets
            .iter()
            .min_by_key(|(_, t)| t.created)
            .map(|(k, _)| k.clone())
        {
            tickets.remove(&oldest);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    tickets.insert(
        id.clone(),
        AuthorizationTicket {
            binding: b.clone(),
            fingerprint: fingerprint.into(),
            request: ticket_request(o, profile, model),
            created: Instant::now(),
        },
    );
    Ok(id)
}
fn consume_ticket(id: Option<&str>) -> Result<AuthorizationTicket> {
    let id = id
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .ok_or_else(|| failure("authorization_ticket_required"))?;
    let ticket = tickets()
        .lock()
        .map_err(|_| failure("context_memory_unavailable"))?
        .remove(id)
        .ok_or_else(|| failure("authorization_ticket_expired"))?;
    if ticket.created.elapsed() >= Duration::from_secs(120) {
        return Err(failure("authorization_ticket_expired"));
    }
    Ok(ticket)
}

fn availability_failure(reason: &str) -> bool {
    matches!(
        reason,
        "project_index_disabled"
            | "context_tool_disabled"
            | "worktree_index_unavailable"
            | "remote_project_unsupported"
    )
}
