//! Snow App 插件社区通道：GitHub `snow-plugins` 主题（topic）检索与安装。
//!
//! 与官方插件市场（[`crate::plugin_market`]）互补：
//!
//! - 官方市场：作者提 PR 合并进 snow-plugin-store，条目格式与归档 SHA-256 都
//!   经过索引校验，客户端按锁定的哈希安装；
//! - 社区通道：直接把 GitHub 上打了 `snow-plugins` 主题的仓库列为候选，没有
//!   人工收录与哈希锁定，因此界面上必须标注「社区插件 · 未发布到市场」并要求
//!   用户二次确认后才能安装。
//!
//! 检索走 GitHub 搜索 API（`/search/repositories?q=topic:snow-plugins …`），
//! 并对每个仓库读取 `releases.atom` 解析最新发行版（普通网页请求，不消耗 API
//! 配额）：没有 GitHub Release 的仓库不会进入列表，版本号取自 Release tag。
//! 结果按查询串缓存在内存与 `~/.snowapp/plugin-market/community.json`，默认
//! 复用 10 分钟（GitHub 匿名搜索限流 10 次/分钟）；限流或网络故障时沿用缓存
//! 并通过 `limited` 告知渲染层。有 `GITHUB_TOKEN` / `GH_TOKEN` 时改用认证请求。
//!
//! 安装（全部在 spawn_blocking 内执行，不阻塞 Node 主线程）：解析仓库 →
//! 按最新 Release tag 下载该 tag 的 codeload zip 快照（不可变地址；仓库没有
//! 发行版时直接报错）→ 解压 → 按内容判定：
//! 含 `plugin.json` 即复用存储层 `install_plugin_with_source` 按面板插件安装
//! （`source_path` 记录仓库地址）；否则扫描 `.user.js` 用户脚本——只有一个时
//! 直接安装，多个时保留解压目录并把候选清单返回渲染层，用户勾选后二次调用完成
//! 安装（脚本 id 取文件名主干，与官方市场 `kind: script` 条目同一套语义，可
//! 原地更新）。全程不依赖 GitHub API，也不需要 token。社区仓库没有索引锁定的
//! SHA-256，因此不做归档哈希校验。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use napi::bindgen_prelude::*;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

use crate::market::{
    build_blocking_client, download_with_mirror, extract_archive, github_repo_slug, github_token,
    locate_plugin_root, marketplace_dir, normalize_manifest_icon, now_epoch_secs,
    MAX_PLUGIN_ARCHIVE_BYTES,
};

/// 社区插件约定的 GitHub 主题：仓库打上该主题即出现在社区列表。
/// 渲染层 `src/renderer/plugins/market.ts` 的 `COMMUNITY_PLUGIN_TOPIC` 与之对应。
const COMMUNITY_TOPIC: &str = "snow-plugins";

/// GitHub 仓库搜索接口。
const COMMUNITY_SEARCH_API: &str = "https://api.github.com/search/repositories";
/// codeload zip 快照前缀：`{前缀}{owner/repo}/zip/{tag}`。
const GITHUB_CODELOAD_ZIP_PREFIX: &str = "https://codeload.github.com/";
/// 单次检索返回的仓库数量上限。
const COMMUNITY_SEARCH_PER_PAGE: usize = 30;
/// 检索结果缓存有效期：GitHub 匿名搜索限流为 10 次/分钟，缓存可显著降低压力。
const COMMUNITY_CACHE_TTL_SECS: u64 = 10 * 60;
/// 检索请求超时上限。
const COMMUNITY_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// 查询串长度上限（防御性截断，避免构造超长 URL）。
const COMMUNITY_QUERY_MAX_CHARS: usize = 80;
/// 单个仓库最多识别的用户脚本数量（防止超大仓库拖慢探测）。
const COMMUNITY_MAX_SCRIPTS: usize = 50;
/// 勾选安装的临时目录名（位于 `~/.snowapp/plugin-market/` 下）。
const COMMUNITY_TMP_DIR_NAME: &str = "community-tmp";
/// 勾选安装的临时目录保留时长：用户中途放弃时由后续调用清理。
const COMMUNITY_TMP_TTL_SECS: u64 = 60 * 60;
/// 社区条目图标的读取上限（`plugin.json` 只有几百字节）。
const COMMUNITY_ICON_MAX_BYTES: u64 = 64 * 1024;
/// 单个仓库图标读取的超时。
const COMMUNITY_ICON_TIMEOUT: Duration = Duration::from_secs(5);
/// 并发读取社区条目元数据（Release + 图标）的工作线程数。
const COMMUNITY_ICON_WORKERS: usize = 8;
/// 仓库 Release atom 订阅源：`{前缀}{owner/repo}/releases.atom`。
/// 普通网页请求，不消耗 GitHub API 配额；第一条 entry 即最新发布。
const GITHUB_RELEASES_ATOM_PREFIX: &str = "https://github.com/";
/// 单个仓库 Release 读取超时。
const COMMUNITY_RELEASE_TIMEOUT: Duration = Duration::from_secs(8);
/// 整批元数据解析（Release + 图标）的总时长上限。
const COMMUNITY_META_DEADLINE: Duration = Duration::from_secs(12);

/// 查询串编码集：保留 RFC 3986 未保留字符，其余（含 `:` 与空格）转义。
const QUERY_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

static COMMUNITY_MEMORY_CACHE: OnceLock<Mutex<Option<CommunityCache>>> = OnceLock::new();

/// 社区检索缓存：按规范化查询串保存最近一次结果。
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct CommunityCache {
    #[serde(default)]
    queries: BTreeMap<String, CommunityQueryCache>,
}

/// 单个查询串的检索结果。
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct CommunityQueryCache {
    #[serde(default)]
    fetched_at: u64,
    #[serde(default)]
    total: u64,
    /// 本轮是否因限流 / 网络故障而沿用缓存。
    #[serde(default)]
    limited: bool,
    /// `limited` 为 true 时的原因说明（面向用户）。
    #[serde(default)]
    reason: String,
    #[serde(default)]
    items: Vec<CommunityRepo>,
}

/// 归一化后的社区仓库条目（与渲染层字段一一对应）。
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct CommunityRepo {
    /// `owner/repo`。
    #[serde(default)]
    id: String,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    homepage: String,
    #[serde(default)]
    license: String,
    #[serde(default)]
    stars: u64,
    #[serde(default)]
    forks: u64,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default, rename = "pushedAt")]
    pushed_at: String,
    /// 仓库默认分支名（搜索接口直接返回，安装时用于解析提交与拼快照地址）。
    #[serde(default, rename = "defaultBranch")]
    default_branch: String,
    #[serde(default)]
    archived: bool,
    /// 最新 GitHub Release 的版本号（tag 去掉前导 `v`）；为空表示仓库没有发行版。
    #[serde(default)]
    version: String,
    /// 最新 GitHub Release 的原始 tag（安装时用于定位不可变快照）。
    #[serde(default, rename = "releaseTag")]
    release_tag: String,
    /// 最新 GitHub Release 页面地址。
    #[serde(default, rename = "releaseUrl")]
    release_url: String,
    /// 最新 GitHub Release 的发布时间（ISO 字符串）。
    #[serde(default, rename = "releasedAt")]
    released_at: String,
    /// 仓库默认分支 `plugin.json` 里的 `icon`（已归一化为可直接展示的值）；
    /// 未声明或读取失败时为空，渲染层回退占位图标。
    #[serde(default)]
    icon: String,
    /// 仓库默认分支 `plugin.json` 的类型（`tool` / `oauth` / `plugin`）；
    /// 空串表示没有清单、读取失败或未声明类型。
    #[serde(default)]
    kind: String,
}

/// 检索失败原因：限流可回退缓存，其余直接报错。
enum CommunityFetchError {
    Limited(String),
    Fatal(String),
}

fn memory_cache() -> &'static Mutex<Option<CommunityCache>> {
    COMMUNITY_MEMORY_CACHE.get_or_init(|| Mutex::new(None))
}

fn community_cache_path() -> Result<PathBuf> {
    Ok(marketplace_dir()?.join("community.json"))
}

fn load_cache() -> CommunityCache {
    if let Ok(guard) = memory_cache().lock() {
        if let Some(cache) = guard.as_ref() {
            return cache.clone();
        }
    }
    let cache = community_cache_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<CommunityCache>(&text).ok())
        .unwrap_or_default();
    store_cache(&cache);
    cache
}

fn store_cache(cache: &CommunityCache) {
    if let Ok(mut guard) = memory_cache().lock() {
        *guard = Some(cache.clone());
    }
    let Ok(path) = community_cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(text) = serde_json::to_string(cache) {
        let _ = fs::write(&path, text);
    }
}

/// 规范化查询串：折叠空白、截断长度，作为缓存键。
fn normalize_query(query: &str) -> String {
    query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(COMMUNITY_QUERY_MAX_CHARS)
        .collect()
}

/// 构造搜索地址：固定 `topic:snow-plugins`，追加用户关键词。
fn build_search_url(query: &str) -> String {
    let mut term = format!("topic:{COMMUNITY_TOPIC}");
    if !query.is_empty() {
        term.push(' ');
        term.push_str(query);
    }
    format!(
        "{COMMUNITY_SEARCH_API}?q={}&sort=stars&order=desc&per_page={COMMUNITY_SEARCH_PER_PAGE}",
        utf8_percent_encode(&term, QUERY_ENCODE_SET)
    )
}

/// 解析单个搜索结果的仓库字段；缺少必要字段的条目直接丢弃。
fn parse_repo(item: &serde_json::Value) -> Option<CommunityRepo> {
    let id = item
        .get("full_name")
        .and_then(serde_json::Value::as_str)?
        .trim();
    let repo = item
        .get("html_url")
        .and_then(serde_json::Value::as_str)?
        .trim()
        .trim_end_matches('/');
    if id.is_empty() || !repo.starts_with("https://github.com/") {
        return None;
    }
    let license = item
        .get("license")
        .and_then(|license| license.get("spdx_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| *value != "NOASSERTION")
        .unwrap_or_default();
    Some(CommunityRepo {
        id: id.to_string(),
        repo: repo.to_string(),
        owner: item
            .get("owner")
            .and_then(|owner| owner.get("login"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        name: item
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        description: item
            .get("description")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        homepage: item
            .get("homepage")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        license: license.to_string(),
        stars: item
            .get("stargazers_count")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        forks: item
            .get("forks_count")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        topics: item
            .get("topics")
            .and_then(serde_json::Value::as_array)
            .map(|topics| {
                topics
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        pushed_at: item
            .get("pushed_at")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        default_branch: item
            .get("default_branch")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        archived: item
            .get("archived")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        version: String::new(),
        release_tag: String::new(),
        release_url: String::new(),
        released_at: String::new(),
        icon: String::new(),
        kind: String::new(),
    })
}

/// 仓库最新发行版（GitHub Release）信息。
struct CommunityRelease {
    tag: String,
    version: String,
    url: String,
    released_at: String,
}

/// 版本号归一化：去掉一个前导 `v` / `V`，其余原样保留。
fn normalize_release_version(tag: &str) -> String {
    let trimmed = tag.trim();
    let stripped = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if stripped.is_empty() {
        trimmed.to_string()
    } else {
        stripped.to_string()
    }
}

/// 解析 releases atom：第一条 entry 即最新发布，取 tag 与发布时间。
fn parse_releases_atom(body: &str, slug: &str) -> Option<CommunityRelease> {
    let entry_start = body.find("<entry>")?;
    let entry = &body[entry_start..];
    let entry_end = entry.find("</entry>")?;
    let entry = &entry[..entry_end];
    let marker = "/releases/tag/";
    let tag_start = entry.find(marker)? + marker.len();
    let tag: String = entry[tag_start..]
        .chars()
        .take_while(|character| *character != '"' && *character != '<')
        .collect();
    let tag = tag.trim();
    if tag.is_empty() {
        return None;
    }
    let released_at = entry
        .find("<updated>")
        .map(|index| &entry[index + "<updated>".len()..])
        .and_then(|rest| rest.find("</updated>").map(|end| rest[..end].trim().to_string()))
        .unwrap_or_default();
    Some(CommunityRelease {
        tag: tag.to_string(),
        version: normalize_release_version(tag),
        url: format!("{GITHUB_RELEASES_ATOM_PREFIX}{slug}/releases/tag/{tag}"),
        released_at,
    })
}

/// 读取仓库最新 Release；没有发行版、请求失败或超时都返回 `None`。
fn fetch_latest_release(
    client: &reqwest::blocking::Client,
    slug: &str,
    budget: Duration,
) -> Option<CommunityRelease> {
    let url = format!("{GITHUB_RELEASES_ATOM_PREFIX}{slug}/releases.atom");
    let response = client
        .get(&url)
        .timeout(budget.min(COMMUNITY_RELEASE_TIMEOUT))
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().ok()?;
    parse_releases_atom(&body, slug)
}

/// 请求一页搜索结果；限流与网络故障分别归类，便于上层决定是否回退缓存。
fn fetch_community_page(
    query: &str,
) -> std::result::Result<(Vec<CommunityRepo>, u64), CommunityFetchError> {
    let client =
        build_blocking_client().map_err(|error| CommunityFetchError::Fatal(error.to_string()))?;
    let url = build_search_url(query);
    let mut request = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .timeout(COMMUNITY_REQUEST_TIMEOUT);
    if let Some(token) = github_token() {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let response = request
        .send()
        .map_err(|error| CommunityFetchError::Fatal(format!("{url}: {error}")))?;
    let status = response.status();
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return Err(CommunityFetchError::Limited(format!(
            "GitHub search API rate limit reached (HTTP {})",
            status.as_u16()
        )));
    }
    if !status.is_success() {
        return Err(CommunityFetchError::Fatal(format!(
            "{url}: HTTP {}",
            status.as_u16()
        )));
    }
    let body = response
        .text()
        .map_err(|error| CommunityFetchError::Fatal(format!("{url}: {error}")))?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| CommunityFetchError::Fatal(format!("{url}: invalid JSON ({error})")))?;
    let items: Vec<CommunityRepo> = parsed
        .get("items")
        .and_then(serde_json::Value::as_array)
        .map(|entries| entries.iter().filter_map(parse_repo).collect())
        .unwrap_or_default();
    // 社区通道以发行版为版本源：没有 GitHub Release 的仓库不进入列表。
    let items = resolve_community_releases(&client, items);
    let total = items.len() as u64;
    Ok((items, total))
}

/// 批量解析仓库发行版：读取最新 Release，过滤掉没有发行版的仓库，再读取图标。
///
/// 社区通道以发行版作为版本与更新来源，因此没有 GitHub Release 的仓库不进入列表。
/// 多个线程分摊仓库，整批受 `COMMUNITY_META_DEADLINE` 约束：超时未解析完的条目
/// 按无发行版处理，不会拖住列表。
fn resolve_community_releases(
    client: &reqwest::blocking::Client,
    repos: Vec<CommunityRepo>,
) -> Vec<CommunityRepo> {
    if repos.is_empty() {
        return repos;
    }
    let deadline = Instant::now() + COMMUNITY_META_DEADLINE;
    let workers = COMMUNITY_ICON_WORKERS.min(repos.len());
    let chunk_size = (repos.len() + workers - 1) / workers;
    let mut parts: Vec<Vec<CommunityRepo>> = Vec::with_capacity(workers);
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for chunk in repos.chunks(chunk_size) {
            handles.push(scope.spawn(move || {
                let mut kept: Vec<CommunityRepo> = Vec::with_capacity(chunk.len());
                for mut repo in chunk.iter().cloned() {
                    let budget = deadline.saturating_duration_since(Instant::now());
                    if budget.is_zero() {
                        break;
                    }
                    let slug = github_repo_slug(&repo.repo).unwrap_or_else(|| repo.id.clone());
                    let Some(release) = fetch_latest_release(client, &slug, budget) else {
                        continue;
                    };
                    repo.version = release.version;
                    repo.release_tag = release.tag;
                    repo.release_url = release.url;
                    repo.released_at = release.released_at;
                    let (icon, kind) = fetch_community_manifest(
                        client,
                        &repo,
                        deadline.saturating_duration_since(Instant::now()),
                    );
                    repo.icon = icon;
                    repo.kind = kind;
                    kept.push(repo);
                }
                kept
            }));
        }
        for handle in handles {
            if let Ok(kept) = handle.join() {
                parts.push(kept);
            }
        }
    });
    parts.into_iter().flatten().collect()
}

/// 读取单个仓库的 `plugin.json` 摘要（图标与插件类型）；仓库没有清单、
/// 文件不存在或超时时两项都返回空串。
fn fetch_community_manifest(
    client: &reqwest::blocking::Client,
    repo: &CommunityRepo,
    budget: Duration,
) -> (String, String) {
    let branch = if repo.default_branch.is_empty() {
        "HEAD"
    } else {
        repo.default_branch.as_str()
    };
    // `repo` 存的是 html_url（`https://github.com/owner/repo`），拼 raw 地址前
    // 必须先取出 `owner/repo`，否则会拼成 `raw.githubusercontent.com/https://github.com/...`。
    let slug = github_repo_slug(&repo.repo).unwrap_or_else(|| repo.id.clone());
    let base = format!("https://raw.githubusercontent.com/{slug}/{branch}/");
    let Ok(response) = client
        .get(format!("{base}plugin.json"))
        .timeout(budget.min(COMMUNITY_ICON_TIMEOUT))
        .send()
    else {
        return (String::new(), String::new());
    };
    if !response.status().is_success() {
        return (String::new(), String::new());
    }
    if matches!(response.content_length(), Some(length) if length > COMMUNITY_ICON_MAX_BYTES) {
        return (String::new(), String::new());
    }
    let Ok(text) = response.text() else {
        return (String::new(), String::new());
    };
    if text.len() as u64 > COMMUNITY_ICON_MAX_BYTES {
        return (String::new(), String::new());
    }
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (String::new(), String::new());
    };
    let raw = manifest
        .get("icon")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    (
        normalize_manifest_icon(raw, &base),
        resolve_community_kind(&manifest),
    )
}

/// 归一化仓库清单的插件类型，与安装侧的判定保持一致：
/// `oauth`（声明 `kind: "oauth"` 或提供 `oauth.entry`）优先，
/// 其次是 `tool`（声明 `kind: "tool"` 或包含 `mcpServers`），否则为 `plugin`。
fn resolve_community_kind(manifest: &serde_json::Value) -> String {
    let declared = manifest
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .map(|value| value.to_ascii_lowercase());
    let oauth_entry = manifest
        .get("oauth")
        .and_then(|oauth| oauth.get("entry"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if declared.as_deref() == Some("oauth") || !oauth_entry.is_empty() {
        return "oauth".to_string();
    }
    if declared.as_deref() == Some("tool") || manifest.get("mcpServers").is_some() {
        return "tool".to_string();
    }
    "plugin".to_string()
}

/// 序列化返回给渲染层的结果（字段名与 `parseCommunityPlugins` 对应）。
fn render_result(entry: &CommunityQueryCache, cached: bool, query: &str) -> String {
    serde_json::json!({
        "query": query,
        "items": entry.items,
        "total": entry.total,
        "limited": entry.limited,
        "reason": entry.reason,
        "fetchedAt": entry.fetched_at,
        "cached": cached,
    })
    .to_string()
}

/// 检索 GitHub 上打了 `snow-plugins` 主题的社区插件仓库（blocking）。
///
/// `query` 为追加在主题之后的检索关键词（可为空），返回
/// `{query, items, total, limited, reason, fetchedAt, cached}` JSON 文本。
/// 命中 10 分钟缓存时直接复用；GitHub 限流或网络故障时沿用缓存并把
/// `limited` 置为 true（渲染层提示用户稍后重试或配置 GITHUB_TOKEN），
/// 无缓存可用且请求失败时返回错误。
pub fn fetch_community_plugins_blocking(query: &str, force_refresh: bool) -> Result<String> {
    let keyword = normalize_query(query);
    let mut cache = load_cache();
    // 旧缓存条目没有发行版信息，直接丢弃，等本轮检索补齐。
    let cached = cache.queries.get(&keyword).cloned().map(|mut entry| {
        entry.items.retain(|item| !item.version.is_empty());
        entry.total = entry.items.len() as u64;
        entry
    });
    let fresh = cached
        .as_ref()
        .map(|entry| {
            entry.fetched_at > 0
                && now_epoch_secs().saturating_sub(entry.fetched_at) < COMMUNITY_CACHE_TTL_SECS
        })
        .unwrap_or(false);

    if !force_refresh && fresh {
        if let Some(entry) = cached {
            return Ok(render_result(&entry, true, &keyword));
        }
    }

    match fetch_community_page(&keyword) {
        Ok((items, total)) => {
            let entry = CommunityQueryCache {
                fetched_at: now_epoch_secs(),
                total,
                limited: false,
                reason: String::new(),
                items,
            };
            cache.queries.insert(keyword.clone(), entry.clone());
            store_cache(&cache);
            Ok(render_result(&entry, false, &keyword))
        }
        Err(CommunityFetchError::Limited(reason)) => match cached {
            Some(mut entry) => {
                entry.limited = true;
                entry.reason = reason;
                Ok(render_result(&entry, true, &keyword))
            }
            None => Err(Error::from_reason(format!(
                "Failed to search community plugins: {reason}. Set GITHUB_TOKEN or GH_TOKEN to raise the limit, then retry."
            ))),
        },
        Err(CommunityFetchError::Fatal(message)) => match cached {
            Some(mut entry) => {
                entry.limited = true;
                entry.reason = message;
                Ok(render_result(&entry, true, &keyword))
            }
            None => Err(Error::from_reason(format!(
                "Failed to search community plugins: {message}"
            ))),
        },
    }
}

/// 构造发行版 zip 快照地址：固定到 Release tag（不可变）；没有发行版则报错。
///
/// `release_tag` 来自检索结果，为空时现场解析最新 Release 兜底。全程不调用
/// GitHub API：订阅源与 codeload 都是普通网页请求。
fn build_archive_url(
    client: &reqwest::blocking::Client,
    slug: &str,
    release_tag: &str,
) -> Result<String> {
    let tag = match release_tag.trim() {
        "" => fetch_latest_release(client, slug, COMMUNITY_REQUEST_TIMEOUT)
            .map(|release| release.tag),
        value => Some(value.to_string()),
    };
    let Some(tag) = tag else {
        return Err(Error::from_reason(format!(
            "No published GitHub Release was found for {slug}; community plugins must publish a release before installing"
        )));
    };
    Ok(format!(
        "{GITHUB_CODELOAD_ZIP_PREFIX}{slug}/zip/{}",
        utf8_percent_encode(&tag, QUERY_ENCODE_SET)
    ))
}

/// 扫描解压目录内的用户脚本文件（相对路径，最多返回 `limit` 个，按路径排序）。
fn find_userscript_files(root: &Path, limit: usize) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        if found.len() >= limit {
            break;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|name| name == ".git") {
                    continue;
                }
                stack.push(path);
                continue;
            }
            let is_userscript = path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(".user.js"));
            if !is_userscript {
                continue;
            }
            if let Ok(relative) = path.strip_prefix(root) {
                found.push(relative.to_string_lossy().replace('\\', "/"));
            }
            if found.len() >= limit {
                break;
            }
        }
    }
    found.sort();
    found
}

/// 归一化脚本 id：只保留字母数字与 `.` `_`，其余折叠为 `-`，并裁到 96 字符。
fn sanitize_script_id(value: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || character == '.' || character == '_' {
            out.push(character);
            pending_dash = false;
        } else if !pending_dash {
            out.push('-');
            pending_dash = true;
        }
    }
    out.trim_matches(|character| character == '-' || character == '.')
        .chars()
        .take(96)
        .collect()
}

/// 由仓库内相对路径推导稳定的脚本 id：文件名主干优先，重名时加父目录前缀或序号。
///
/// 与官方市场的 `kind: script` 条目使用同一套 id 语义（文件名主干，如
/// `plugins/eye-care-ball/eye-care-ball.user.js` → `eye-care-ball`），因此同一
/// 脚本从社区通道或官方市场安装会命中同一行记录，实现原地更新。
fn derive_script_id(relative_path: &str, taken: &mut BTreeSet<String>) -> String {
    let path = Path::new(relative_path);
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let parent = path
        .parent()
        .and_then(|directory| directory.file_name())
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut candidates = vec![sanitize_script_id(&stem)];
    if !parent.is_empty() {
        candidates.push(sanitize_script_id(&format!("{parent}-{stem}")));
    }
    for index in 2..=COMMUNITY_MAX_SCRIPTS {
        candidates.push(sanitize_script_id(&format!("{stem}-{index}")));
    }
    for candidate in candidates {
        if !candidate.is_empty() && taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    let fallback = format!("script-{}", taken.len() + 1);
    taken.insert(fallback.clone());
    fallback
}

/// 仓库快照里的用户脚本条目（勾选安装时返回给渲染层）。
#[derive(Clone, serde::Serialize)]
struct CommunityScript {
    id: String,
    path: String,
    name: String,
    version: String,
    description: String,
}

/// 已安装的用户脚本回执。
#[derive(serde::Serialize)]
struct InstalledScript {
    #[serde(rename = "scriptId")]
    script_id: String,
    name: String,
}

/// 社区来源的解析结果。
enum CommunityOutcome {
    /// 仓库是面板插件，已按目录安装。
    Plugin,
    /// 已安装选定的用户脚本。
    Scripts(Vec<InstalledScript>),
    /// 仓库含多个用户脚本，需要用户勾选（保留解压目录，等二次调用）。
    SelectionRequired {
        token: String,
        items: Vec<CommunityScript>,
    },
}

/// 扫描仓库快照里的用户脚本：解析元数据、派生稳定 id，跳过没有合法元数据头的文件。
fn discover_community_scripts(extract_dir: &Path) -> Vec<CommunityScript> {
    let mut taken: BTreeSet<String> = BTreeSet::new();
    let mut items: Vec<CommunityScript> = Vec::new();
    for relative in find_userscript_files(extract_dir, COMMUNITY_MAX_SCRIPTS) {
        let Ok(raw) = fs::read_to_string(extract_dir.join(&relative)) else {
            continue;
        };
        if !raw.contains("==UserScript==") {
            continue;
        }
        let meta = crate::storage::parse_meta(&raw);
        if meta.name.trim().is_empty() {
            continue;
        }
        items.push(CommunityScript {
            id: derive_script_id(&relative, &mut taken),
            path: relative,
            name: meta.name,
            version: meta.version,
            description: meta.description,
        });
    }
    items
}

/// 安装仓库快照中选定的用户脚本（`selection` 为相对路径列表）。
fn install_community_scripts(
    extract_dir: &Path,
    selection: &[String],
    source_url: &str,
) -> Result<Vec<InstalledScript>> {
    let scripts = discover_community_scripts(extract_dir);
    let chosen: Vec<&CommunityScript> = if selection.is_empty() {
        if scripts.len() != 1 {
            return Err(Error::from_reason(
                "Userscript selection is required for this repository".to_string(),
            ));
        }
        vec![&scripts[0]]
    } else {
        let picked: Vec<&CommunityScript> = scripts
            .iter()
            .filter(|item| selection.iter().any(|path| path == &item.path))
            .collect();
        if picked.is_empty() {
            return Err(Error::from_reason(
                "None of the selected userscripts exist in the repository".to_string(),
            ));
        }
        picked
    };

    let database_path = crate::storage::ensure_database_file()?;
    let mut installed: Vec<InstalledScript> = Vec::new();
    for item in chosen {
        let raw = fs::read_to_string(extract_dir.join(&item.path)).map_err(|error| {
            Error::from_reason(format!("Failed to read '{}': {error}", item.path))
        })?;
        let record =
            crate::storage::install_market_userscript(&database_path, &item.id, &raw, source_url)?;
        installed.push(InstalledScript {
            script_id: record.script_id,
            name: record.name,
        });
    }
    Ok(installed)
}

/// 缺少清单且没有可安装脚本时的诊断错误（列出找到的 `.user.js`）。
fn community_missing_manifest_error(extract_dir: &Path, source_url: &str) -> Error {
    let scripts = find_userscript_files(extract_dir, 5);
    if scripts.is_empty() {
        return Error::from_reason(format!(
            "plugin.json was not found in the archive downloaded from {source_url}"
        ));
    }
    Error::from_reason(format!(
        "plugin.json was not found and no installable userscript was found in the archive downloaded from {source_url} ({}). Each .user.js needs a ==UserScript== header with @name.",
        scripts.join(", ")
    ))
}

/// 勾选安装的临时目录根（`~/.snowapp/plugin-market/community-tmp`）。
fn community_tmp_root() -> Result<PathBuf> {
    Ok(marketplace_dir()?.join(COMMUNITY_TMP_DIR_NAME))
}

/// 清理超时未完成的勾选安装目录（用户中途关掉弹窗时留下的快照）。
fn purge_stale_community_tmp(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let stale = fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age.as_secs() > COMMUNITY_TMP_TTL_SECS);
        if stale {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// 校验勾选安装令牌（uuid simple 形式的 32 位十六进制），防止路径穿越。
fn is_hex_token(value: &str) -> bool {
    value.len() == 32 && value.chars().all(|character| character.is_ascii_hexdigit())
}

/// 序列化解析结果（字段名与渲染层 `parseCommunityResolve` 对应）。
fn render_community_outcome(outcome: &CommunityOutcome, source_url: &str) -> String {
    match outcome {
        CommunityOutcome::Plugin => serde_json::json!({
            "outcome": "plugin",
            "repo": source_url,
        })
        .to_string(),
        CommunityOutcome::Scripts(installed) => serde_json::json!({
            "outcome": "scripts",
            "repo": source_url,
            "installed": installed,
        })
        .to_string(),
        CommunityOutcome::SelectionRequired { token, items } => serde_json::json!({
            "outcome": "selection-required",
            "repo": source_url,
            "token": token,
            "items": items,
        })
        .to_string(),
    }
}

/// 下载社区仓库快照并解压（blocking）。
fn download_and_extract_community_archive(
    client: &reqwest::blocking::Client,
    download_url: &str,
    work_dir: &Path,
    extract_dir: &Path,
) -> Result<()> {
    let archive_path = work_dir.join("plugin.zip");
    download_with_mirror(
        client,
        download_url,
        &archive_path,
        MAX_PLUGIN_ARCHIVE_BYTES,
        "plugin archive",
    )?;
    fs::create_dir_all(extract_dir).map_err(|error| {
        Error::from_reason(format!("Failed to create the extraction directory: {error}"))
    })?;
    extract_archive(&archive_path, extract_dir)
}

/// 解析并安装社区来源（blocking）。
///
/// `repo` 为 `https://github.com/owner/repo` 形式的仓库地址，`release_tag` 为
/// 检索结果给出的最新 Release tag（为空时现场解析最新 Release）。社区通道以
/// 发行版为版本源：没有 Release 的仓库直接报错，快照固定到该 tag 的
/// codeload 归档。全程不调用 GitHub API，既不需要 token 也不受匿名配额限制。
///
/// 一次调用完成「下载 → 判定 → 安装」，多脚本仓库分两步（`selection_json` 为
/// 勾选的脚本相对路径数组，`token` 为空表示首次调用）：
///
/// 1. 首次调用：解压后按内容判定——有 `plugin.json` 即按面板插件安装
///    （`source_path` 记录仓库地址）；只有 1 个用户脚本时直接安装；多个用户
///    脚本时保留解压目录并返回 `selection-required` 与候选清单；都没有则报错
///     （附上发现的 `.user.js` 清单）。
/// 2. 二次调用（带 `token` + `selection`）：复用保留的解压目录安装选中脚本并
///    清理目录。
pub fn resolve_community_source_blocking(
    repo: &str,
    release_tag: &str,
    token: &str,
    selection_json: &str,
) -> Result<String> {
    let slug = github_repo_slug(repo).ok_or_else(|| {
        Error::from_reason("Community plugin source must be a GitHub repository URL".to_string())
    })?;
    let selection: Vec<String> = serde_json::from_str(selection_json).map_err(|error| {
        Error::from_reason(format!("Invalid community userscript selection: {error}"))
    })?;
    let source_url = format!("https://github.com/{slug}");

    let tmp_root = community_tmp_root()?;
    fs::create_dir_all(&tmp_root).map_err(|error| {
        Error::from_reason(format!("Failed to create the market temp directory: {error}"))
    })?;
    purge_stale_community_tmp(&tmp_root);

    let token = token.trim();
    let resume = !token.is_empty();
    if resume && !is_hex_token(token) {
        return Err(Error::from_reason(
            "Invalid community install token".to_string(),
        ));
    }
    let work_dir = if resume {
        tmp_root.join(token)
    } else {
        tmp_root.join(uuid::Uuid::new_v4().simple().to_string())
    };
    let extract_dir = work_dir.join("extract");
    if resume && !extract_dir.is_dir() {
        return Err(Error::from_reason(
            "This community install session expired; start the installation again".to_string(),
        ));
    }

    let outcome = (|| -> Result<CommunityOutcome> {
        if !resume {
            fs::create_dir_all(&work_dir).map_err(|error| {
                Error::from_reason(format!("Failed to create the market temp directory: {error}"))
            })?;
            let client = build_blocking_client()?;
            let download_url = build_archive_url(&client, &slug, release_tag)?;
            download_and_extract_community_archive(&client, &download_url, &work_dir, &extract_dir)?;
            if let Some(plugin_root) = locate_plugin_root(&extract_dir) {
                let database_path = crate::storage::ensure_database_file()?;
                crate::storage::install_plugin_with_source(
                    &database_path,
                    &plugin_root.to_string_lossy(),
                    &source_url,
                )?;
                return Ok(CommunityOutcome::Plugin);
            }
        }

        let scripts = discover_community_scripts(&extract_dir);
        if scripts.is_empty() {
            return Err(community_missing_manifest_error(&extract_dir, &source_url));
        }
        if !resume && selection.is_empty() && scripts.len() > 1 {
            let token = work_dir
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            return Ok(CommunityOutcome::SelectionRequired {
                token,
                items: scripts,
            });
        }
        Ok(CommunityOutcome::Scripts(install_community_scripts(
            &extract_dir,
            &selection,
            &source_url,
        )?))
    })();

    // 只有等待用户勾选时才保留解压目录；其余情况（成功或失败）都清理。
    if !matches!(&outcome, Ok(CommunityOutcome::SelectionRequired { .. })) {
        let _ = fs::remove_dir_all(&work_dir);
    }

    outcome.map(|value| render_community_outcome(&value, &source_url))
}
