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
//! 结果按查询串缓存在内存与 `~/.snowapp/plugin-market/community.json`，默认
//! 复用 10 分钟（GitHub 匿名搜索限流 10 次/分钟）；限流或网络故障时沿用缓存
//! 并通过 `limited` 告知渲染层。有 `GITHUB_TOKEN` / `GH_TOKEN` 时改用认证请求。
//!
//! 安装（全部在 spawn_blocking 内执行，不阻塞 Node 主线程）：解析仓库 →
//! 通过 commits atom 订阅源解析默认分支最新提交 SHA（普通网页请求，不消耗
//! GitHub API 配额，无需 token）→ 下载该提交的 zip 快照 → 解压 → 按内容判定：
//! 含 `plugin.json` 即复用存储层 `install_plugin_with_source` 按面板插件安装
//! （`source_path` 记录仓库地址）；否则扫描 `.user.js` 用户脚本——只有一个时
//! 直接安装，多个时保留解压目录并把候选清单返回渲染层，用户勾选后二次调用完成
//! 安装（脚本 id 取文件名主干，与官方市场 `kind: script` 条目同一套语义，可
//! 原地更新）。订阅源不可用时退化为直接下载默认分支快照
//! （`codeload .../zip/HEAD`），仍然不依赖 API。社区仓库没有索引锁定的
//! SHA-256，因此不做归档哈希校验。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use napi::bindgen_prelude::*;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

use crate::plugin_market::{
    build_blocking_client, download_with_mirror, extract_archive, github_repo_slug, github_token,
    is_commit_sha, locate_plugin_root, marketplace_dir, now_epoch_secs, MAX_PLUGIN_ARCHIVE_BYTES,
};

/// 社区插件约定的 GitHub 主题：仓库打上该主题即出现在社区列表。
/// 渲染层 `src/renderer/plugins/market.ts` 的 `COMMUNITY_PLUGIN_TOPIC` 与之对应。
const COMMUNITY_TOPIC: &str = "snow-plugins";

/// GitHub 仓库搜索接口。
const COMMUNITY_SEARCH_API: &str = "https://api.github.com/search/repositories";
/// commits atom 订阅源前缀：`{前缀}{owner/repo}/commits/{分支或 HEAD}.atom`。
/// 普通网页请求，不消耗 GitHub API 配额，也不需要 token。
const GITHUB_COMMITS_ATOM_PREFIX: &str = "https://github.com/";
/// codeload zip 快照前缀：`{前缀}{owner/repo}/zip/{提交 SHA 或 HEAD}`。
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
/// 整批图标读取的总时长上限：raw 地址不可达（被黑洞）时不能让列表一直等下去，
/// 超时后剩余条目留空、回退占位图标。
const COMMUNITY_ICON_DEADLINE: Duration = Duration::from_secs(8);
/// 并发读取社区条目图标的工作线程数。
const COMMUNITY_ICON_WORKERS: usize = 8;

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
    /// 仓库默认分支 `plugin.json` 里的 `icon`（已归一化为可直接展示的值）；
    /// 未声明或读取失败时为空，渲染层回退占位图标。
    #[serde(default)]
    icon: String,
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
        icon: String::new(),
    })
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
    let total = parsed
        .get("total_count")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let mut items: Vec<CommunityRepo> = parsed
        .get("items")
        .and_then(serde_json::Value::as_array)
        .map(|entries| entries.iter().filter_map(parse_repo).collect())
        .unwrap_or_default();
    resolve_community_icons(&client, &mut items);
    Ok((items, total))
}

/// 逐个仓库读取默认分支的 `plugin.json`，把其中的 `icon` 归一化为可直接展示的值。
///
/// 与官方市场条目共用同一套图标语义：`lucide:Name` 原样交给宿主图标库；
/// `http(s)` / `data:image` 原样返回（渲染层经 `img-proxy` 代理或内联展示）；
/// 插件目录内相对路径展开为仓库 raw 地址。任何失败都只留空字符串，
/// 渲染层回退占位图标，不影响列表本身。
fn resolve_community_icons(client: &reqwest::blocking::Client, repos: &mut [CommunityRepo]) {
    if repos.is_empty() {
        return;
    }
    let deadline = Instant::now() + COMMUNITY_ICON_DEADLINE;
    let workers = COMMUNITY_ICON_WORKERS.min(repos.len());
    let chunk_size = (repos.len() + workers - 1) / workers;
    std::thread::scope(|scope| {
        for chunk in repos.chunks_mut(chunk_size) {
            scope.spawn(move || {
                for repo in chunk.iter_mut() {
                    let budget = deadline.saturating_duration_since(Instant::now());
                    if budget.is_zero() {
                        return;
                    }
                    repo.icon = fetch_community_icon(client, repo, budget);
                }
            });
        }
    });
}

/// 读取单个仓库的图标；仓库未声明 `icon`、文件不存在或超时都返回空串。
fn fetch_community_icon(
    client: &reqwest::blocking::Client,
    repo: &CommunityRepo,
    budget: Duration,
) -> String {
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
        return String::new();
    };
    if !response.status().is_success() {
        return String::new();
    }
    if matches!(response.content_length(), Some(length) if length > COMMUNITY_ICON_MAX_BYTES) {
        return String::new();
    }
    let Ok(text) = response.text() else {
        return String::new();
    };
    if text.len() as u64 > COMMUNITY_ICON_MAX_BYTES {
        return String::new();
    }
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) else {
        return String::new();
    };
    let raw = manifest
        .get("icon")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    normalize_community_icon(raw, &base)
}

/// 归一化社区条目图标：只接受受支持的取值，拒绝绝对路径与越界路径。
fn normalize_community_icon(raw: &str, base: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("lucide:")
        || lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("data:image/")
    {
        return raw.to_string();
    }
    if raw.starts_with('/') || raw.starts_with('\\') || raw.contains("..") || raw.contains('\\') {
        return String::new();
    }
    format!("{base}{raw}")
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
    let cached = cache.queries.get(&keyword).cloned();
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

/// 通过 commits atom 订阅源解析分支（空则默认分支）最新 commit SHA。
///
/// 这是普通网页请求，不消耗 GitHub API 配额、不需要 token；任何一步失败都
/// 返回 `None`，由调用方退化为直接下载默认分支快照。
fn resolve_head_commit(
    client: &reqwest::blocking::Client,
    slug: &str,
    branch: &str,
) -> Option<String> {
    let reference = match branch.trim() {
        "" => "HEAD",
        value => value,
    };
    let url = format!("{GITHUB_COMMITS_ATOM_PREFIX}{slug}/commits/{reference}.atom");
    let response = client
        .get(&url)
        .timeout(COMMUNITY_REQUEST_TIMEOUT)
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().ok()?;
    let marker = "Grit::Commit/";
    let marker_index = body.find(marker)?;
    let sha: String = body[marker_index + marker.len()..]
        .chars()
        .take(40)
        .collect();
    is_commit_sha(&sha).then_some(sha)
}

/// 构造 zip 快照地址：优先固定到不可变的提交 SHA，订阅源不可用时退回默认分支。
fn build_archive_url(client: &reqwest::blocking::Client, slug: &str, branch: &str) -> String {
    match resolve_head_commit(client, slug, branch) {
        Some(sha) => format!("{GITHUB_CODELOAD_ZIP_PREFIX}{slug}/zip/{sha}"),
        None => format!("{GITHUB_CODELOAD_ZIP_PREFIX}{slug}/zip/HEAD"),
    }
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
/// `repo` 为 `https://github.com/owner/repo` 形式的仓库地址，`branch` 为搜索
/// 结果给出的默认分支（可为空，空则按 `HEAD` 处理）。全程不调用 GitHub API：
/// 提交 SHA 来自 commits atom 订阅源，快照来自 codeload，因此既不需要 token
/// 也不受匿名配额限制。
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
    branch: &str,
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
            let download_url = build_archive_url(&client, &slug, branch);
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
