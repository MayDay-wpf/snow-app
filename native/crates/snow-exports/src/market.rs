use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::storage::{PluginRecord, UserscriptRecord};

/// 拉取插件市场索引 JSON 文本（Rust 侧负责镜像降级与缓存）。
///
/// `forceRefresh` 为 true 时跳过内存缓存直接请求网络；网络失败时回退到
/// 最近一次成功写入磁盘的缓存。
#[napi]
pub async fn fetch_plugin_registry(force_refresh: Option<bool>) -> napi::Result<String> {
    let force_refresh = force_refresh.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        crate::plugin_market::fetch_registry_blocking(force_refresh)
    })
    .await
    .map_err(|error| Error::from_reason(format!("Fetch plugin registry task failed: {error}")))?
}

/// 拉取市场条目下载量统计（GitHub Release 资产 download_count）。
///
/// `targets` 为 `[{id, repo, tag, asset}]` JSON，返回 `{id: 下载量}` JSON；
/// Rust 侧按仓库 + tag 缓存 6 小时，限流或网络故障时沿用缓存值。
#[napi]
pub async fn fetch_plugin_market_stats(
    targets: String,
    force_refresh: Option<bool>,
) -> napi::Result<String> {
    let force_refresh = force_refresh.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        crate::plugin_market::fetch_market_stats_blocking(&targets, force_refresh)
    })
    .await
    .map_err(|error| Error::from_reason(format!("Fetch plugin market stats task failed: {error}")))?
}

/// 从插件市场下载并安装（或更新）插件：
/// zip 下载 -> SHA256 校验 -> 解压 -> 校验 plugin.json id -> 存储层安装。
#[napi]
pub async fn install_plugin_from_market(
    plugin_id: String,
    download_url: String,
    sha256: String,
    source_url: String,
) -> napi::Result<PluginRecord> {
    tokio::task::spawn_blocking(move || {
        crate::plugin_market::install_from_market_blocking(
            &plugin_id,
            &download_url,
            &sha256,
            &source_url,
        )
    })
    .await
    .map_err(|error| Error::from_reason(format!("Install plugin from market task failed: {error}")))?
}

/// 从插件市场下载并安装（或更新）用户脚本：.user.js 下载 -> SHA256 校验 -> 写入脚本库。
/// `source_url` 为脚本仓库地址，写入来源字段（供「已安装」判定与来源核对）。
#[napi]
pub async fn install_script_from_market(
    script_id: String,
    download_url: String,
    sha256: String,
    source_url: String,
) -> napi::Result<UserscriptRecord> {
    tokio::task::spawn_blocking(move || {
        crate::plugin_market::install_script_from_market_blocking(
            &script_id,
            &download_url,
            &sha256,
            &source_url,
        )
    })
    .await
    .map_err(|error| {
        Error::from_reason(format!(
            "Install userscript from market task failed: {error}"
        ))
    })?
}

/// 检索 GitHub 上打了 `snow-plugins` 主题的社区插件仓库（Rust 侧负责限流回退与缓存）。
///
/// `query` 为追加在主题之后的检索关键词（可为空）；返回
/// `{query, items, total, limited, reason, fetchedAt, cached}` JSON 文本。
#[napi]
pub async fn fetch_plugin_community(
    query: String,
    force_refresh: Option<bool>,
) -> napi::Result<String> {
    let force_refresh = force_refresh.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        crate::plugin_community::fetch_community_plugins_blocking(&query, force_refresh)
    })
    .await
    .map_err(|error| Error::from_reason(format!("Fetch plugin community task failed: {error}")))?
}

/// 解析并安装社区来源：按最新 Release tag 下载该 tag 的 zip 快照 -> 解压 ->
/// 按内容判定。没有发行版的仓库直接报错。
///
/// 返回 JSON：`{"outcome":"plugin"}`（已按面板插件安装）、
/// `{"outcome":"scripts","installed":[…]}`（已安装用户脚本）或
/// `{"outcome":"selection-required","token":…,"items":[…]}`（仓库含多个用户脚本，
/// 需要渲染层勾选后用同一 token 二次调用）。全程不调用 GitHub API，无需 token、
/// 不计配额。
///
/// `releaseTag` 为检索结果给出的最新发行版 tag（为空时现场解析），
/// `token`/`selection` 用于二次调用。
#[napi]
pub async fn resolve_plugin_community_source(
    repo: String,
    release_tag: Option<String>,
    token: Option<String>,
    selection_json: Option<String>,
) -> napi::Result<String> {
    let release_tag = release_tag.unwrap_or_default();
    let token = token.unwrap_or_default();
    let selection_json = selection_json.unwrap_or_else(|| "[]".to_string());
    tokio::task::spawn_blocking(move || {
        crate::plugin_community::resolve_community_source_blocking(
            &repo,
            &release_tag,
            &token,
            &selection_json,
        )
    })
    .await
    .map_err(|error| {
        Error::from_reason(format!("Resolve plugin community source task failed: {error}"))
    })?
}
