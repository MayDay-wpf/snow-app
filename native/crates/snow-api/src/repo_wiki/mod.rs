//! 仓库 Wiki：Rust 端 agent 生成代码库架构导读（只读浏览 + 页面就地编辑），结果存于 ~/.snowapp/repo-wiki。
//! SSH 工作区经全局远程命令回调由 Electron 代为读取（见 remote.rs）。

mod agent;
mod job;
mod prompts;
mod remote;
mod store;
mod tools;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio_util::sync::CancellationToken as CancelToken;

pub(crate) use store::normalize_project_path;

#[napi(object)]
pub struct RepoWikiStartOptions {
    pub project_path: String,
    pub project_name: Option<String>,
    /// zh-CN | en
    pub language: String,
    pub api_profile: Option<String>,
    pub model: Option<String>,
    pub diagrams: bool,
    pub retries: u32,
}

/// 已生成 Wiki 的生成配置（只改配置，不重新生成）。
#[napi(object)]
pub struct RepoWikiSettingsOptions {
    pub project_path: String,
    /// zh-CN | en
    pub language: String,
    pub api_profile: Option<String>,
    pub model: Option<String>,
    pub diagrams: bool,
    pub retries: u32,
}

#[napi(object)]
#[derive(Clone, Default)]
pub struct RepoWikiEvent {
    pub project_path: String,
    /// status | page | activity
    pub kind: String,
    pub status: String,
    pub phase: String,
    pub page_id: Option<String>,
    pub page_status: Option<String>,
    pub activity_tool: Option<String>,
    pub activity_target: Option<String>,
    pub error: Option<String>,
    pub total_pages: u32,
    pub done_pages: u32,
    pub failed_pages: u32,
}

pub type RepoWikiEventCallback =
    ThreadsafeFunction<RepoWikiEvent, Unknown<'static>, RepoWikiEvent, Status, false, true>;

static EVENT_HANDLER: OnceLock<Mutex<Option<Arc<RepoWikiEventCallback>>>> = OnceLock::new();

fn handler_slot() -> &'static Mutex<Option<Arc<RepoWikiEventCallback>>> {
    EVENT_HANDLER.get_or_init(|| Mutex::new(None))
}

pub fn set_event_handler(handler: Option<RepoWikiEventCallback>) {
    *handler_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = handler.map(Arc::new);
}

pub(crate) fn emit(event: RepoWikiEvent) {
    let handler = handler_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if let Some(handler) = handler {
        let _ = handler.call(event, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// 任务暂停开关：暂停时各轮请求之间停住，恢复后继续。
pub(crate) struct PauseState {
    paused: AtomicBool,
    notify: tokio::sync::Notify,
}

impl PauseState {
    pub(crate) fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        }
    }

    pub(crate) fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
        if !paused {
            self.notify.notify_waiters();
        }
    }

    /// 暂停中则等待恢复（与取消无关：取消由外层 select 处理）。
    pub(crate) async fn wait_if_paused(&self) {
        while self.paused.load(Ordering::SeqCst) {
            let notified = self.notify.notified();
            if !self.paused.load(Ordering::SeqCst) {
                break;
            }
            notified.await;
        }
    }
}

pub(crate) struct JobHandle {
    pub token: CancelToken,
    pub wiki: Arc<tokio::sync::Mutex<store::RepoWiki>>,
    pub pause: Arc<PauseState>,
}

pub(crate) fn new_handle(wiki: store::RepoWiki) -> Arc<JobHandle> {
    Arc::new(JobHandle {
        token: CancelToken::default(),
        wiki: Arc::new(tokio::sync::Mutex::new(wiki)),
        pause: Arc::new(PauseState::new()),
    })
}

static JOBS: OnceLock<Mutex<HashMap<String, Arc<JobHandle>>>> = OnceLock::new();

fn jobs() -> &'static Mutex<HashMap<String, Arc<JobHandle>>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn running_job(project_path: &str) -> Option<Arc<JobHandle>> {
    jobs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&normalize_project_path(project_path))
        .cloned()
}

/// 同一仓库同时只允许一个任务。
pub(crate) fn try_register(project_path: &str, handle: Arc<JobHandle>) -> bool {
    let mut map = jobs().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let key = normalize_project_path(project_path);
    if map.contains_key(&key) {
        return false;
    }
    map.insert(key, handle);
    true
}

pub(crate) fn unregister(project_path: &str) {
    jobs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&normalize_project_path(project_path));
}

fn require_project_path(project_path: &str) -> Result<()> {
    if project_path.trim().is_empty() {
        return Err(Error::from_reason("Project path is required"));
    }
    Ok(())
}

/// 读取 Wiki（运行中返回内存态；残留的 running / paused 状态视为已停止）。
pub async fn load(project_path: String) -> Result<Option<String>> {
    require_project_path(&project_path)?;
    let wiki = if let Some(handle) = running_job(&project_path) {
        Some(handle.wiki.lock().await.clone())
    } else {
        store::load_wiki(&project_path).await?.map(|mut wiki| {
            if wiki.status == "running" || wiki.status == "paused" {
                wiki.status = "stopped".to_string();
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
            wiki
        })
    };
    wiki.map(|wiki| serde_json::to_string(&wiki))
        .transpose()
        .map_err(|error| Error::from_reason(format!("Failed to serialize wiki: {error}")))
}

pub async fn start(options: RepoWikiStartOptions) -> Result<()> {
    require_project_path(&options.project_path)?;
    job::start_full(options).await
}

/// 暂停当前任务：已发出的请求跑完后停在下一轮之前。
pub async fn pause(project_path: &str) -> Result<()> {
    let Some(handle) = running_job(project_path) else {
        return Err(Error::from_reason("No wiki task is running"));
    };
    if handle.pause.is_paused() {
        return Ok(());
    }
    handle.pause.set_paused(true);
    let mut wiki = handle.wiki.lock().await;
    wiki.status = "paused".to_string();
    wiki.updated_at = store::now_ms();
    if let Err(error) = store::save_wiki(&wiki).await {
        eprintln!("[repo-wiki] failed to save wiki: {}", error.reason);
    }
    emit(job::build_event(&wiki, "status"));
    Ok(())
}

/// 恢复已暂停的任务。
pub async fn resume(project_path: &str) -> Result<()> {
    let Some(handle) = running_job(project_path) else {
        return Err(Error::from_reason("No wiki task is running"));
    };
    handle.pause.set_paused(false);
    let mut wiki = handle.wiki.lock().await;
    wiki.status = "running".to_string();
    wiki.updated_at = store::now_ms();
    if let Err(error) = store::save_wiki(&wiki).await {
        eprintln!("[repo-wiki] failed to save wiki: {}", error.reason);
    }
    emit(job::build_event(&wiki, "status"));
    Ok(())
}

/// 单个章节重新生成（成功或失败都可重试）。
pub async fn retry_page(project_path: String, page_id: String) -> Result<()> {
    require_project_path(&project_path)?;
    job::start_page_retry(project_path, page_id).await
}

/// 进行中的任务（含暂停）不允许导入导出，避免写出半成品。
fn ensure_idle(project_path: &str) -> Result<()> {
    if running_job(project_path).is_some() {
        return Err(Error::from_reason(
            "Stop the running wiki task before importing or exporting",
        ));
    }
    Ok(())
}

/// 导出为 md 压缩包（README.md + pages/*.md + wiki.json）。
pub async fn export(project_path: String, target_path: String) -> Result<u32> {
    require_project_path(&project_path)?;
    ensure_idle(&project_path)?;
    let Some(wiki) = store::load_wiki(&project_path).await? else {
        return Err(Error::from_reason("Wiki has not been generated yet"));
    };
    let target = std::path::PathBuf::from(target_path);
    tokio::task::spawn_blocking(move || store::export_archive(&wiki, &target))
        .await
        .map_err(|error| Error::from_reason(format!("Failed to export the wiki: {error}")))?
}

/// 从 JSON 导入 Wiki：覆盖当前项目的本地 Wiki。
pub async fn import(project_path: String, json: String) -> Result<u32> {
    require_project_path(&project_path)?;
    ensure_idle(&project_path)?;
    let mut wiki: store::RepoWiki = serde_json::from_str(&json)
        .map_err(|error| Error::from_reason(format!("Invalid wiki JSON: {error}")))?;
    if wiki.pages.is_empty() {
        return Err(Error::from_reason("Wiki JSON contains no pages"));
    }
    let project_path = normalize_project_path(&project_path);
    let base_name = project_path
        .rsplit('/')
        .next()
        .unwrap_or(&project_path)
        .to_string();
    wiki.version = store::WIKI_VERSION;
    wiki.project_path = project_path.clone();
    if wiki.project_name.trim().is_empty() {
        wiki.project_name = base_name;
    }
    if wiki.title.trim().is_empty() {
        wiki.title = wiki.project_name.clone();
    }
    if wiki.language.trim().is_empty() {
        wiki.language = "zh-CN".to_string();
    }
    for page in &mut wiki.pages {
        if page.status == "generating" {
            page.status = if page.content.is_empty() {
                "pending".to_string()
            } else {
                "done".to_string()
            };
        }
    }
    wiki.status = if wiki.count("done") > 0 {
        "completed".to_string()
    } else {
        "stopped".to_string()
    };
    wiki.phase = "done".to_string();
    wiki.error = None;
    wiki.updated_at = store::now_ms();
    if wiki.created_at == 0 {
        wiki.created_at = wiki.updated_at;
    }
    // 自动更新开关属于本地偏好，保持原值
    if let Some(existing) = store::load_wiki(&project_path).await? {
        wiki.auto_refresh = existing.auto_refresh;
    }
    store::save_wiki(&wiki).await?;
    // 重新取样指纹，避免导入后立刻触发自动刷新
    if let Ok(fingerprint) = store::scan_fingerprint(&project_path).await {
        let _ = store::save_fingerprint(&project_path, &fingerprint).await;
    }
    emit(job::build_event(&wiki, "status"));
    Ok(wiki.pages.len() as u32)
}

pub fn stop(project_path: &str) -> bool {
    match running_job(project_path) {
        Some(handle) => {
            handle.token.cancel();
            true
        }
        None => false,
    }
}

pub async fn delete(project_path: String) -> Result<bool> {
    require_project_path(&project_path)?;
    if running_job(&project_path).is_some() {
        return Err(Error::from_reason(
            "Stop the running wiki generation before deleting it",
        ));
    }
    store::delete_wiki(&project_path).await
}

pub async fn set_auto_refresh(project_path: String, enabled: bool) -> Result<()> {
    require_project_path(&project_path)?;
    if let Some(handle) = running_job(&project_path) {
        handle.wiki.lock().await.auto_refresh = enabled;
        return Ok(());
    }
    let Some(mut wiki) = store::load_wiki(&project_path).await? else {
        return Err(Error::from_reason("Wiki has not been generated yet"));
    };
    wiki.auto_refresh = enabled;
    store::save_wiki(&wiki).await
}

/// 修改生成配置：档案/模型按生成时同样规则解析校验，之后的自动更新与单页重试使用新配置。
pub async fn update_settings(options: RepoWikiSettingsOptions) -> Result<()> {
    require_project_path(&options.project_path)?;
    let project_path = normalize_project_path(&options.project_path);
    ensure_settings_editable(&project_path)?;
    if store::load_wiki(&project_path).await?.is_none() {
        return Err(Error::from_reason("Wiki has not been generated yet"));
    }
    let ctx = agent::resolve_model_context(
        options.api_profile.as_deref().unwrap_or(""),
        options.model.as_deref().unwrap_or(""),
        false,
        &project_path,
    )
    .await?;
    // 解析期间可能已启动自动刷新，重新确认并读取最新数据
    ensure_settings_editable(&project_path)?;
    let Some(mut wiki) = store::load_wiki(&project_path).await? else {
        return Err(Error::from_reason("Wiki has not been generated yet"));
    };
    wiki.api_profile = ctx.profile_name.clone();
    wiki.model = ctx.model.clone();
    wiki.language = job::normalize_language(&options.language);
    wiki.diagrams = options.diagrams;
    wiki.retries = options.retries.min(job::MAX_RETRIES);
    wiki.updated_at = store::now_ms();
    store::save_wiki(&wiki).await?;
    emit(job::build_event(&wiki, "status"));
    Ok(())
}

fn ensure_settings_editable(project_path: &str) -> Result<()> {
    if running_job(project_path).is_some() {
        return Err(Error::from_reason(
            "Stop the running wiki task before editing its settings",
        ));
    }
    Ok(())
}

pub fn file_path(project_path: &str) -> Result<String> {
    Ok(store::wiki_file_path(project_path)?
        .to_string_lossy()
        .into_owned())
}

/// 回合结束：代码有变化且开启自动刷新时，后台刷新受影响页面。
pub async fn notify_turn_ended(project_path: String) -> Result<bool> {
    if project_path.trim().is_empty() || running_job(&project_path).is_some() {
        return Ok(false);
    }
    job::auto_refresh(project_path).await
}

/// 系统提示词章节：项目已有 Wiki 时告知其绝对路径。
/// SSH 会话里只有 Windows 盘符路径会走本机通道读取（见 prepare_remote_workspace_args），
/// 其他平台的本机绝对路径会被解析到远端，因此仅 Windows 下为 SSH 项目注入。
pub(crate) async fn build_system_prompt_section(project_path: &str) -> String {
    if project_path.trim().is_empty()
        || (crate::mcp::servers::remote_workspace::is_ssh_path(project_path) && !cfg!(windows))
    {
        return String::new();
    }
    let Some(path) = store::ready_wiki_path(project_path).await else {
        return String::new();
    };
    format!(
        "## Project Wiki\n\nAn AI-generated architecture wiki of this project exists at `{}` (JSON: `title`, `summary`, `pages[]` with `title`, `content` Markdown and `sources` file:line references). Read or grep it when you need an overview of modules, main flows or where things live; it may lag behind the code, so verify against the actual source before relying on details or editing.",
        path.to_string_lossy()
    )
}
