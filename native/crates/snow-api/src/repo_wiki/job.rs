//! Wiki 任务编排：完整生成（分析 → 目录 → 页面 → 保存）与增量刷新（受影响页面）。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

use futures::StreamExt;
use napi::bindgen_prelude::*;
use serde_json::Value;

use super::agent::{resolve_model_context, run_agent, ModelContext};
use super::prompts::{
    catalog_file_map, catalog_outline, catalog_review_system_prompt, catalog_review_user_prompt,
    catalog_system_prompt, catalog_user_prompt, page_edit_system_prompt, page_edit_user_prompt,
    page_system_prompt, page_user_prompt,
};
use super::store::{
    self, now_ms, sanitize_page_id, Fingerprint, RepoWiki, WikiPage, WikiSource, MAX_FILES_PER_PAGE,
    MAX_PAGES, WIKI_VERSION,
};
use super::tools::{
    catalog_edit_tool, page_edit_tool, CatalogDraft, PageDraft, WikiReadView, WikiToolExecutor,
};
use super::{
    emit, new_handle, normalize_project_path, running_job, try_register, unregister, JobHandle,
    RepoWikiEvent, RepoWikiStartOptions,
};
use crate::api::file_search_agent::{strip_code_fences, AgentToolExecutor};
use crate::mcp::tools::McpTool;

const PAGE_CONCURRENCY: usize = 3;
const MAX_SOURCES_PER_PAGE: usize = 200;
pub(super) const MAX_RETRIES: u32 = 5;

/// 自动更新触发的目录审视输入。
pub(super) struct CatalogReview {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub modified: Vec<String>,
}

enum JobMode {
    Full,
    Refresh {
        page_ids: Vec<String>,
        fingerprint: Fingerprint,
        /// 触发刷新的改动文件（用于局部编辑提示词）
        changed_files: Vec<String>,
        /// 代码结构变化时的目录审视（无变化为 None）
        review: Option<CatalogReview>,
    },
}

struct Job {
    project_path: String,
    handle: Arc<JobHandle>,
    ctx: ModelContext,
    view: WikiReadView,
}

pub(super) fn normalize_language(language: &str) -> String {
    if language.trim().to_lowercase().starts_with("zh") {
        "zh-CN".to_string()
    } else {
        "en".to_string()
    }
}

fn base_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

pub(super) fn build_event(wiki: &RepoWiki, kind: &str) -> RepoWikiEvent {
    RepoWikiEvent {
        project_path: wiki.project_path.clone(),
        kind: kind.to_string(),
        status: wiki.status.clone(),
        phase: wiki.phase.clone(),
        error: wiki.error.clone(),
        total_pages: wiki.pages.len() as u32,
        done_pages: wiki.count("done"),
        failed_pages: wiki.count("failed"),
        ..Default::default()
    }
}

fn emit_activity(project_path: &str, page_id: Option<&str>, tool: &str, target: &str) {
    emit(RepoWikiEvent {
        project_path: project_path.to_string(),
        kind: "activity".to_string(),
        status: "running".to_string(),
        page_id: page_id.map(str::to_string),
        activity_tool: Some(tool.to_string()),
        activity_target: Some(target.chars().take(200).collect()),
        ..Default::default()
    });
}

async fn save_logged(wiki: &RepoWiki) {
    if let Err(error) = store::save_wiki(wiki).await {
        eprintln!("[repo-wiki] failed to save wiki: {}", error.reason);
    }
}

pub(super) async fn start_full(options: RepoWikiStartOptions) -> Result<()> {
    let project_path = normalize_project_path(&options.project_path);
    if running_job(&project_path).is_some() {
        return Err(Error::from_reason(
            "A wiki generation is already running for this project",
        ));
    }
    let ctx = resolve_model_context(
        options.api_profile.as_deref().unwrap_or(""),
        options.model.as_deref().unwrap_or(""),
        false,
        &project_path,
    )
    .await?;
    let previous = store::load_wiki(&project_path).await.ok().flatten();
    let now = now_ms();
    let mut wiki = previous.clone().unwrap_or_default();
    wiki.version = WIKI_VERSION;
    wiki.project_path = project_path.clone();
    wiki.project_name = options
        .project_name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| base_name(&project_path));
    wiki.language = normalize_language(&options.language);
    wiki.api_profile = ctx.profile_name.clone();
    wiki.model = ctx.model.clone();
    wiki.diagrams = options.diagrams;
    wiki.retries = options.retries.min(MAX_RETRIES);
    wiki.auto_refresh = previous.as_ref().is_some_and(|prev| prev.auto_refresh);
    wiki.status = "running".to_string();
    wiki.phase = "analyzing".to_string();
    wiki.error = None;
    if previous.is_none() {
        wiki.created_at = now;
    }
    wiki.updated_at = now;

    let handle = new_handle(wiki);
    if !try_register(&project_path, handle.clone()) {
        return Err(Error::from_reason(
            "A wiki generation is already running for this project",
        ));
    }
    tokio::spawn(run(project_path, handle, ctx, JobMode::Full));
    Ok(())
}

pub(super) async fn auto_refresh(project_path: String) -> Result<bool> {
    let project_path = normalize_project_path(&project_path);
    let Some(mut wiki) = store::load_wiki(&project_path).await? else {
        return Ok(false);
    };
    if !wiki.auto_refresh || wiki.status == "running" || wiki.count("done") == 0 {
        return Ok(false);
    }
    let previous = store::load_fingerprint(&project_path).await;
    let current = store::scan_fingerprint(&project_path).await?;
    let diff = store::diff_fingerprints(&previous, &current);
    let changed_files = diff.changed();
    if changed_files.is_empty() {
        return Ok(false);
    }
    let changed: HashSet<String> = changed_files.iter().cloned().collect();
    let affected: Vec<String> = if previous.is_empty() {
        Vec::new()
    } else {
        wiki.pages
            .iter()
            .filter(|page| {
                page.files.iter().any(|file| changed.contains(file))
                    || page.sources.iter().any(|source| changed.contains(&source.path))
            })
            .map(|page| page.id.clone())
            .collect()
    };
    let structural = !previous.is_empty() && structural_change(&wiki, &diff, &current);
    if affected.is_empty() && !structural {
        store::save_fingerprint(&project_path, &current).await?;
        return Ok(false);
    }
    let Ok(ctx) =
        resolve_model_context(&wiki.api_profile, &wiki.model, true, &project_path).await
    else {
        return Ok(false);
    };
    wiki.status = "running".to_string();
    wiki.phase = "analyzing".to_string();
    wiki.error = None;
    wiki.updated_at = now_ms();
    let review = structural.then(|| CatalogReview {
        added: diff.added.clone(),
        removed: diff.removed.clone(),
        modified: diff.modified.clone(),
    });
    let handle = new_handle(wiki);
    if !try_register(&project_path, handle.clone()) {
        return Ok(false);
    }
    tokio::spawn(run(
        project_path,
        handle,
        ctx,
        JobMode::Refresh {
            page_ids: affected,
            fingerprint: current,
            changed_files,
            review,
        },
    ));
    Ok(true)
}

/// 需要重新审视目录的信号：出现未被任何页面覆盖的新增文件，或某页关键文件全部消失。
fn structural_change(
    wiki: &RepoWiki,
    diff: &store::FingerprintDiff,
    current: &Fingerprint,
) -> bool {
    if diff.added.is_empty() && diff.removed.is_empty() {
        return false;
    }
    let covered: HashSet<&str> = wiki
        .pages
        .iter()
        .flat_map(|page| {
            page.files
                .iter()
                .map(String::as_str)
                .chain(page.sources.iter().map(|source| source.path.as_str()))
        })
        .collect();
    let uncovered_added = diff
        .added
        .iter()
        .filter(|file| is_code_file(file.as_str()))
        .filter(|file| !covered.contains(file.as_str()))
        .count();
    let broken_page = wiki.pages.iter().any(|page| {
        !page.files.is_empty() && page.files.iter().all(|file| !current.contains_key(file))
    });
    uncovered_added >= 1 || broken_page
}

/// 只看代码文件，避免文档/资源/测试新增频繁触发目录审视。
fn is_code_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    if lower.contains(".test.")
        || lower.contains(".spec.")
        || lower.contains("__tests__/")
        || lower.contains("/tests/")
        || lower.ends_with("_test.rs")
    {
        return false;
    }
    let extension = path
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_lowercase())
        .unwrap_or_default();
    matches!(
        extension.as_str(),
        "rs" | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "mts"
            | "cts"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "kts"
            | "swift"
            | "c"
            | "h"
            | "cc"
            | "cpp"
            | "hpp"
            | "cs"
            | "rb"
            | "php"
            | "vue"
            | "svelte"
            | "dart"
            | "scala"
            | "lua"
            | "ex"
            | "exs"
    )
}

/// 单章节重新生成：成功或失败过的页面都可重试。
pub(super) async fn start_page_retry(project_path: String, page_id: String) -> Result<()> {
    let project_path = normalize_project_path(&project_path);
    if running_job(&project_path).is_some() {
        return Err(Error::from_reason(
            "Stop or wait for the running wiki task before retrying a page",
        ));
    }
    let Some(mut wiki) = store::load_wiki(&project_path).await? else {
        return Err(Error::from_reason("Wiki has not been generated yet"));
    };
    if !wiki.pages.iter().any(|page| page.id == page_id) {
        return Err(Error::from_reason(format!("Wiki page not found: {page_id}")));
    }
    let ctx = resolve_model_context(&wiki.api_profile, &wiki.model, true, &project_path).await?;
    wiki.status = "running".to_string();
    wiki.phase = "pages".to_string();
    wiki.error = None;
    wiki.updated_at = now_ms();
    let handle = new_handle(wiki);
    if !try_register(&project_path, handle.clone()) {
        return Err(Error::from_reason("A wiki task is already running"));
    }
    tokio::spawn(run_page_retry(project_path, handle, ctx, page_id));
    Ok(())
}

async fn run_page_retry(
    project_path: String,
    handle: Arc<JobHandle>,
    ctx: ModelContext,
    page_id: String,
) {
    {
        let wiki = handle.wiki.lock().await;
        save_logged(&wiki).await;
        emit(build_event(&wiki, "status"));
    }
    let token = handle.token.clone();
    let result = tokio::select! {
        _ = token.cancelled() => Ok(()),
        result = retry_page_with_view(project_path.clone(), handle.clone(), ctx, page_id) => result,
    };
    match result {
        Ok(()) => finish_page_retry(&project_path, &handle).await,
        // 只读视图建立失败（如 SSH 不可达）：整体标记失败并带上原因
        Err(error) => finalize(&project_path, &handle, Err(Some(error))).await,
    }
}

async fn retry_page_with_view(
    project_path: String,
    handle: Arc<JobHandle>,
    ctx: ModelContext,
    page_id: String,
) -> Result<()> {
    let view = WikiReadView::new(&project_path).await?;
    let job = Job {
        project_path,
        handle,
        ctx,
        view,
    };
    generate_page(&job, page_id, true, &[]).await;
    Ok(())
}

async fn finish_page_retry(project_path: &str, handle: &JobHandle) {
    let event = {
        let mut wiki = handle.wiki.lock().await;
        wiki.status = if wiki.count("done") > 0 {
            "completed".to_string()
        } else {
            "failed".to_string()
        };
        wiki.phase = "done".to_string();
        wiki.updated_at = now_ms();
        for page in &mut wiki.pages {
            if page.status == "generating" {
                page.status = if page.content.is_empty() {
                    "pending".to_string()
                } else {
                    "done".to_string()
                };
            }
        }
        save_logged(&wiki).await;
        build_event(&wiki, "status")
    };
    unregister(project_path);
    emit(event);
}

async fn run(project_path: String, handle: Arc<JobHandle>, ctx: ModelContext, mode: JobMode) {
    {
        let wiki = handle.wiki.lock().await;
        save_logged(&wiki).await;
        emit(build_event(&wiki, "status"));
    }
    let token = handle.token.clone();
    let result = tokio::select! {
        _ = token.cancelled() => Err(None),
        result = execute_with_view(project_path.clone(), handle.clone(), ctx, mode) => result.map_err(Some),
    };
    finalize(&project_path, &handle, result).await;
}

/// 建立只读视图（SSH 工作区需先拉取远程文件树）后执行任务，视图建立同样受停止控制。
async fn execute_with_view(
    project_path: String,
    handle: Arc<JobHandle>,
    ctx: ModelContext,
    mode: JobMode,
) -> Result<()> {
    let view = WikiReadView::new(&project_path).await?;
    let job = Job {
        project_path,
        handle,
        ctx,
        view,
    };
    execute(&job, mode).await
}

async fn set_phase(job: &Job, phase: &str) {
    let mut wiki = job.handle.wiki.lock().await;
    wiki.phase = phase.to_string();
    wiki.updated_at = now_ms();
    emit(build_event(&wiki, "status"));
}

async fn execute(job: &Job, mode: JobMode) -> Result<()> {
    job.handle.pause.wait_if_paused().await;
    let root = job.project_path.clone();
    let (branch, commit) = store::read_git_meta(&root).await;
    {
        let mut wiki = job.handle.wiki.lock().await;
        wiki.branch = branch;
        wiki.commit = commit;
    }
    let (page_ids, fingerprint, incremental, changed_files) = match mode {
        JobMode::Full => {
            let fingerprint = job.view.fingerprint().await.unwrap_or_default();
            set_phase(job, "catalog").await;
            let (title, summary, pages) = generate_catalog(job).await?;
            let ids = pages.iter().map(|page| page.id.clone()).collect();
            let mut wiki = job.handle.wiki.lock().await;
            wiki.title = title;
            wiki.summary = summary;
            wiki.pages = pages;
            wiki.updated_at = now_ms();
            save_logged(&wiki).await;
            emit(build_event(&wiki, "status"));
            (ids, fingerprint, false, Vec::new())
        }
        JobMode::Refresh {
            page_ids,
            fingerprint,
            changed_files,
            review,
        } => {
            let mut page_ids = page_ids;
            if let Some(review) = review {
                set_phase(job, "catalog").await;
                match review_catalog(job, &review).await {
                    Ok(touched) => {
                        for id in touched {
                            if !page_ids.contains(&id) {
                                page_ids.push(id);
                            }
                        }
                    }
                    // 目录审视失败不影响内容刷新
                    Err(error) => {
                        eprintln!("[repo-wiki] catalog review failed: {}", error.reason)
                    }
                }
                let wiki = job.handle.wiki.lock().await;
                page_ids.retain(|id| wiki.pages.iter().any(|page| &page.id == id));
            }
            (page_ids, fingerprint, true, changed_files)
        }
    };

    set_phase(job, "pages").await;
    futures::stream::iter(
        page_ids
            .into_iter()
            .map(|id| generate_page(job, id, incremental, &changed_files)),
    )
    .buffer_unordered(PAGE_CONCURRENCY)
    .collect::<Vec<()>>()
    .await;

    set_phase(job, "saving").await;
    let all_failed = {
        let wiki = job.handle.wiki.lock().await;
        !wiki.pages.is_empty() && wiki.count("done") == 0
    };
    if all_failed {
        return Err(Error::from_reason("All wiki pages failed to generate"));
    }
    store::save_fingerprint(&root, &fingerprint).await?;
    Ok(())
}

async fn finalize(
    project_path: &str,
    handle: &JobHandle,
    result: std::result::Result<(), Option<Error>>,
) {
    let event = {
        let mut wiki = handle.wiki.lock().await;
        match result {
            Ok(()) => {
                wiki.status = "completed".to_string();
                wiki.phase = "done".to_string();
                wiki.error = None;
                wiki.generated_at = Some(now_ms());
            }
            Err(error) => {
                wiki.status = if error.is_some() { "failed" } else { "stopped" }.to_string();
                wiki.error = error.map(|error| error.reason.clone());
                for page in &mut wiki.pages {
                    if page.status == "generating" {
                        page.status = if page.content.is_empty() {
                            "pending".to_string()
                        } else {
                            "done".to_string()
                        };
                    }
                }
            }
        }
        wiki.updated_at = now_ms();
        save_logged(&wiki).await;
        build_event(&wiki, "status")
    };
    unregister(project_path);
    emit(event);
}

async fn root_listing(job: &Job) -> String {
    let noop = |_: &str, _: &str| {};
    let executor = WikiToolExecutor {
        view: &job.view,
        on_activity: &noop,
        draft: None,
        catalog: None,
    };
    let output = executor
        .execute("filesystem-read", r#"{"filePath":"."}"#)
        .await
        .unwrap_or_default();
    serde_json::from_str::<Value>(&output)
        .ok()
        .and_then(|value| value.get("entries").and_then(Value::as_str).map(str::to_string))
        .unwrap_or(output)
}

async fn generate_catalog(job: &Job) -> Result<(String, String, Vec<WikiPage>)> {
    let (language, name, retries) = {
        let wiki = job.handle.wiki.lock().await;
        (wiki.language.clone(), wiki.project_name.clone(), wiki.retries)
    };
    let listing = root_listing(job).await;
    let system = catalog_system_prompt(&language, &name, &job.project_path);
    let user = catalog_user_prompt(&listing);
    let project_path = job.project_path.clone();
    let activity = move |tool: &str, target: &str| emit_activity(&project_path, None, tool, target);
    let executor = WikiToolExecutor {
        view: &job.view,
        on_activity: &activity,
        draft: None,
        catalog: None,
    };
    let mut last_error = Error::from_reason("Catalog generation failed");
    for _ in 0..=retries {
        match run_agent(
            &job.ctx,
            &system,
            &user,
            job.handle.pause.as_ref(),
            &executor,
            &[],
        )
        .await
        .and_then(|text| parse_catalog(&text, &job.view))
        {
            Ok(catalog) => return Ok(catalog),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

/// 目录审视：结构变化时让模型用 wiki-catalog-edit 增删改章节，返回被改动的页面 id。
async fn review_catalog(job: &Job, review: &CatalogReview) -> Result<Vec<String>> {
    let (language, name, pages) = {
        let wiki = job.handle.wiki.lock().await;
        (
            wiki.language.clone(),
            wiki.project_name.clone(),
            wiki.pages.clone(),
        )
    };
    let outline = catalog_outline(&pages);
    let file_map = catalog_file_map(&pages);
    let draft = CatalogDraft::new(pages);
    let system = catalog_review_system_prompt(&language, &name, &job.project_path, MAX_PAGES);
    let user = catalog_review_user_prompt(
        &outline,
        &file_map,
        &review.added,
        &review.removed,
        &review.modified,
    );
    let project_path = job.project_path.clone();
    let activity = move |tool: &str, target: &str| emit_activity(&project_path, None, tool, target);
    let executor = WikiToolExecutor {
        view: &job.view,
        on_activity: &activity,
        draft: None,
        catalog: Some(&draft),
    };
    let outcome = run_agent(
        &job.ctx,
        &system,
        &user,
        job.handle.pause.as_ref(),
        &executor,
        &[catalog_edit_tool()],
    )
    .await;
    if !draft.was_edited() {
        return outcome.map(|_| Vec::new());
    }
    if let Err(error) = outcome {
        eprintln!("[repo-wiki] catalog review agent stopped: {}", error.reason);
    }
    let (pages, touched) = draft.take().await;
    {
        let mut wiki = job.handle.wiki.lock().await;
        wiki.pages = pages;
        wiki.updated_at = now_ms();
        save_logged(&wiki).await;
        emit(build_event(&wiki, "status"));
    }
    Ok(touched)
}

fn parse_catalog(text: &str, view: &WikiReadView) -> Result<(String, String, Vec<WikiPage>)> {
    let cleaned = strip_code_fences(text.trim());
    let (Some(start), Some(end)) = (cleaned.find('{'), cleaned.rfind('}')) else {
        return Err(Error::from_reason("Catalog response is not JSON"));
    };
    let value: Value = serde_json::from_str(&cleaned[start..=end])
        .map_err(|error| Error::from_reason(format!("Invalid catalog JSON: {error}")))?;
    let items = value
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut id_map: HashMap<String, String> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut raw_parents: Vec<Option<String>> = Vec::new();
    let mut pages: Vec<WikiPage> = Vec::new();
    for (index, item) in items.iter().take(MAX_PAGES).enumerate() {
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if title.is_empty() {
            continue;
        }
        let raw_id = item.get("id").and_then(Value::as_str).unwrap_or("").trim();
        let mut id = sanitize_page_id(raw_id);
        if id.is_empty() {
            id = format!("page-{}", index + 1);
        }
        let base = id.clone();
        let mut suffix = 2;
        while seen.contains(&id) {
            id = format!("{base}-{suffix}");
            suffix += 1;
        }
        seen.insert(id.clone());
        if !raw_id.is_empty() {
            id_map.insert(raw_id.to_string(), id.clone());
        }
        let files = item
            .get("files")
            .and_then(Value::as_array)
            .map(|files| {
                files
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(|file| view.relative(file))
                    .filter(|file| !file.is_empty())
                    .take(MAX_FILES_PER_PAGE)
                    .collect()
            })
            .unwrap_or_default();
        raw_parents.push(
            item.get("parentId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|parent| !parent.is_empty())
                .map(str::to_string),
        );
        pages.push(WikiPage {
            id,
            title: title.to_string(),
            description: item
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
            files,
            status: "pending".to_string(),
            ..Default::default()
        });
    }
    if pages.is_empty() {
        return Err(Error::from_reason("Catalog contains no pages"));
    }

    // 父级只能是更靠前的顶层页面，保证最多两级。
    for index in 0..pages.len() {
        let Some(raw_parent) = raw_parents[index].as_ref() else {
            continue;
        };
        let Some(parent_id) = id_map.get(raw_parent).cloned() else {
            continue;
        };
        let parent_index = pages[..index].iter().position(|page| page.id == parent_id);
        if let Some(parent_index) = parent_index {
            let top = match pages[parent_index].parent_id.clone() {
                Some(grand) => grand,
                None => parent_id,
            };
            pages[index].parent_id = Some(top);
        }
    }

    let title = value
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let summary = value
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    Ok((title, summary, pages))
}

fn clean_markdown(text: &str) -> String {
    let trimmed = text.trim();
    if let Some(rest) = trimmed.strip_prefix("```") {
        let language = rest.lines().next().unwrap_or("").trim().to_lowercase();
        if (language.is_empty() || language == "markdown" || language == "md")
            && trimmed.ends_with("```")
        {
            return strip_code_fences(trimmed).trim().to_string();
        }
    }
    trimmed.to_string()
}

fn source_regex() -> &'static regex::Regex {
    static REGEX: OnceLock<regex::Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        regex::Regex::new(r"`([^`\s]+?):(\d+)(?:[-–](\d+))?`").expect("valid source regex")
    })
}

fn extract_sources(markdown: &str, view: &WikiReadView) -> Vec<WikiSource> {
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for captures in source_regex().captures_iter(markdown) {
        let Some(path) = view.relative(&captures[1]) else {
            continue;
        };
        if path.is_empty() || !(path.contains('.') || path.contains('/')) {
            continue;
        }
        let start: u32 = captures[2].parse().unwrap_or(0);
        let end: u32 = captures
            .get(3)
            .and_then(|value| value.as_str().parse().ok())
            .unwrap_or(start)
            .max(start);
        if start == 0 || !seen.insert((path.clone(), start, end)) {
            continue;
        }
        sources.push(WikiSource {
            path,
            start_line: start,
            end_line: end,
        });
        if sources.len() >= MAX_SOURCES_PER_PAGE {
            break;
        }
    }
    sources
}

/// 生成或更新单个页面。`incremental` 且有既有内容时，模型用 wiki-page-edit 就地打补丁，
/// 只重写受影响的段落；否则整章重写。
async fn generate_page(
    job: &Job,
    page_id: String,
    incremental: bool,
    changed_files: &[String],
) {
    job.handle.pause.wait_if_paused().await;
    let prepared = {
        let mut wiki = job.handle.wiki.lock().await;
        let outline = catalog_outline(&wiki.pages);
        let title = if wiki.title.is_empty() {
            wiki.project_name.clone()
        } else {
            wiki.title.clone()
        };
        let settings = (
            wiki.language.clone(),
            wiki.project_name.clone(),
            wiki.diagrams,
            wiki.retries,
        );
        match wiki.pages.iter_mut().find(|page| page.id == page_id) {
            Some(page) => {
                page.status = "generating".to_string();
                page.error = None;
                let snapshot = page.clone();
                let mut event = build_event(&wiki, "page");
                event.page_id = Some(page_id.clone());
                event.page_status = Some("generating".to_string());
                emit(event);
                Some((snapshot, outline, title, settings))
            }
            None => None,
        }
    };
    let Some((page, outline, wiki_title, (language, name, diagrams, retries))) = prepared else {
        return;
    };

    // 已有内容 -> 局部编辑；空页面或全量生成 -> 整章重写
    let use_edit = incremental && !page.content.trim().is_empty();
    let draft = use_edit.then(|| PageDraft::new(page.content.clone()));
    let (system, user) = if use_edit {
        let relevant: Vec<String> = changed_files
            .iter()
            .filter(|file| {
                page.files.iter().any(|item| item == *file)
                    || page.sources.iter().any(|source| &source.path == *file)
            })
            .map(|file| file.to_string())
            .collect();
        let relevant = if relevant.is_empty() {
            changed_files.to_vec()
        } else {
            relevant
        };
        (
            page_edit_system_prompt(&language, &name, &job.project_path, diagrams),
            page_edit_user_prompt(&wiki_title, &outline, &page, &relevant),
        )
    } else {
        (
            page_system_prompt(&language, &name, &job.project_path, diagrams),
            page_user_prompt(&wiki_title, &outline, &page),
        )
    };
    let extra_tools: Vec<McpTool> = if use_edit {
        vec![page_edit_tool()]
    } else {
        Vec::new()
    };
    let project_path = job.project_path.clone();
    let activity_page = page_id.clone();
    let activity = move |tool: &str, target: &str| {
        emit_activity(&project_path, Some(&activity_page), tool, target)
    };
    let executor = WikiToolExecutor {
        view: &job.view,
        on_activity: &activity,
        draft: draft.as_ref(),
        catalog: None,
    };
    let mut result: Result<String> = Err(Error::from_reason("Page generation failed"));
    for _ in 0..=retries {
        match run_agent(
            &job.ctx,
            &system,
            &user,
            job.handle.pause.as_ref(),
            &executor,
            &extra_tools,
        )
        .await
        {
            Ok(text) => {
                let Some(draft) = draft.as_ref() else {
                    let markdown = clean_markdown(&text);
                    if markdown.is_empty() {
                        result = Err(Error::from_reason("Model response has no text content"));
                        continue;
                    }
                    result = Ok(markdown);
                    break;
                };
                if !draft.was_edited() {
                    // 模型没走补丁而是整章输出时兜底接受，避免空转重试
                    let markdown = clean_markdown(&text);
                    if markdown.starts_with("# ") && markdown.lines().count() >= 8 {
                        result = Ok(markdown);
                        break;
                    }
                    result = Err(Error::from_reason(
                        "Model finished without applying any wiki-page-edit patch",
                    ));
                    continue;
                }
                let content = draft.content().await;
                if content.trim().is_empty() {
                    result = Err(Error::from_reason("Page content became empty after the edits"));
                    continue;
                }
                result = Ok(content);
                break;
            }
            Err(error) => {
                // 补丁已经落地时，即使最终答复为空也保留编辑结果
                let edited = match draft.as_ref() {
                    Some(draft) if draft.was_edited() => Some(draft.content().await),
                    _ => None,
                };
                match edited {
                    Some(content) if !content.trim().is_empty() => {
                        result = Ok(content);
                        break;
                    }
                    _ => result = Err(error),
                }
            }
        }
    }

    let mut wiki = job.handle.wiki.lock().await;
    let Some(target) = wiki.pages.iter_mut().find(|page| page.id == page_id) else {
        return;
    };
    let status = match result {
        Ok(markdown) => {
            target.sources = extract_sources(&markdown, &job.view);
            target.content = markdown;
            target.status = "done".to_string();
            target.error = None;
            target.updated_at = now_ms();
            "done"
        }
        Err(error) => {
            target.status = "failed".to_string();
            target.error = Some(error.reason.clone());
            "failed"
        }
    };
    wiki.updated_at = now_ms();
    save_logged(&wiki).await;
    let mut event = build_event(&wiki, "page");
    event.page_id = Some(page_id);
    event.page_status = Some(status.to_string());
    emit(event);
}
