use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::api::repo_wiki::{
    self, RepoWikiEventCallback, RepoWikiSettingsOptions, RepoWikiStartOptions,
};
use crate::utils::panic_guard::guard_panic;

/// 主进程注册一次：Wiki 任务的状态/页面/活动事件经此回调广播。
#[napi(ts_args_type = "handler: ((event: RepoWikiEvent) => void) | undefined | null")]
pub fn set_repo_wiki_event_handler(handler: Option<RepoWikiEventCallback>) {
    repo_wiki::set_event_handler(handler);
}

/// 读取 Wiki JSON（不存在返回 null）。
#[napi]
pub async fn repo_wiki_load(project_path: String) -> Result<Option<String>> {
    guard_panic(repo_wiki::load(project_path)).await
}

/// 启动完整生成（后台执行，立即返回）。
#[napi]
pub async fn repo_wiki_start(options: RepoWikiStartOptions) -> Result<()> {
    guard_panic(repo_wiki::start(options)).await
}

#[napi]
pub fn repo_wiki_stop(project_path: String) -> bool {
    repo_wiki::stop(&project_path)
}

/// 暂停任务（进行中的请求完成后停住）。
#[napi]
pub async fn repo_wiki_pause(project_path: String) -> Result<()> {
    guard_panic(repo_wiki::pause(&project_path)).await
}

/// 恢复已暂停的任务。
#[napi]
pub async fn repo_wiki_resume(project_path: String) -> Result<()> {
    guard_panic(repo_wiki::resume(&project_path)).await
}

/// 单独重新生成某一章节（成功或失败都可重试）。
#[napi]
pub async fn repo_wiki_retry_page(project_path: String, page_id: String) -> Result<()> {
    guard_panic(repo_wiki::retry_page(project_path, page_id)).await
}

/// 导出 md 压缩包（运行中的任务不可导出），返回导出的页面数。
#[napi]
pub async fn repo_wiki_export(project_path: String, target_path: String) -> Result<u32> {
    guard_panic(repo_wiki::export(project_path, target_path)).await
}

/// 从 JSON 导入 Wiki（运行中的任务不可导入），返回导入的页面数。
#[napi]
pub async fn repo_wiki_import(project_path: String, json: String) -> Result<u32> {
    guard_panic(repo_wiki::import(project_path, json)).await
}

#[napi]
pub async fn repo_wiki_delete(project_path: String) -> Result<bool> {
    guard_panic(repo_wiki::delete(project_path)).await
}

#[napi]
pub async fn repo_wiki_set_auto_refresh(project_path: String, enabled: bool) -> Result<()> {
    guard_panic(repo_wiki::set_auto_refresh(project_path, enabled)).await
}

/// 修改已生成 Wiki 的生成配置（运行中的任务不可修改）。
#[napi]
pub async fn repo_wiki_update_settings(options: RepoWikiSettingsOptions) -> Result<()> {
    guard_panic(repo_wiki::update_settings(options)).await
}

/// 回合结束通知：返回是否启动了增量刷新。
#[napi]
pub async fn repo_wiki_notify_turn_ended(project_path: String) -> Result<bool> {
    guard_panic(repo_wiki::notify_turn_ended(project_path)).await
}

#[napi]
pub fn repo_wiki_file_path(project_path: String) -> Result<String> {
    repo_wiki::file_path(&project_path)
}
