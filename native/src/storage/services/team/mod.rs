//! 基于 Git 的团队协作数据层。
//!
//! 不引入任何后端服务：身份取自仓库 `git config user.name/user.email`，
//! 团队数据平面是 origin 上的 `snow/team` 分支，本地以独立 worktree
//! (`<repo>/.snow/team-worktree`) 承载，不触碰用户主工作区。
//! 每条记录一个 JSON 文件（`snow-team/<kind>/<id>.json`），合并粒度到
//! 文件，天然低冲突；本地提交 + 定期 fetch/rebase/push 实现最终一致。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::storage::services::git::{is_git_repo, run_git, run_git_raw};

pub const TEAM_BRANCH: &str = "snow/team";
pub const TEAM_DIR: &str = "snow-team";
mod knowledge_skill;
use knowledge_skill::sync_knowledge_skill;

const WORKTREE_REL: &str = ".snow/team-worktree";
const MEMBER_HEARTBEAT_SECS: i64 = 600;

/// 团队协作总开关的系统设置 code（DB 持久化）。默认关闭，显式写入 "1" 才启用。
pub const TEAM_ENABLED_SETTING: &str = "team_collaboration_enabled";

/// 团队协作是否启用：未写入或非 "1" 一律视为关闭。
pub fn is_team_enabled() -> bool {
    crate::storage::get_system_setting_value(TEAM_ENABLED_SETTING.to_string())
        .ok()
        .flatten()
        .map(|value| value == "1")
        .unwrap_or(false)
}

/// 团队协作关闭时的统一错误。
fn team_disabled_err() -> Error {
    Error::from_reason("team collaboration is disabled")
}

/// 串行化所有团队数据层操作（同一进程内），避免 sync/upsert 交错。
fn team_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

// ===== 数据模型（serde，仅用于文件存取与 JSON 序列化） =====

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamIdentity {
    pub is_repo: bool,
    /// 解析出的真实仓库根路径（渲染层所有团队操作都应使用它）。
    pub repo_path: String,
    pub name: String,
    pub email: String,
    pub remote_url: String,
    pub has_identity: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncResult {
    pub ok: bool,
    pub initialized: bool,
    pub pulled: bool,
    pub pushed: bool,
    pub local_ahead: i32,
    pub local_behind: i32,
    pub error: Option<String>,
}

// 以下结构体仅作为 JSON 数据契约（序列化/反序列化），不在 Rust 内部构造。
#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamHistoryEntry {
    pub at: String,
    pub by: String,
    pub action: String,
    pub detail: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamComment {
    pub id: String,
    pub author_email: String,
    pub content: String,
    pub created_at: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamTask {
    pub id: String,
    pub title: String,
    pub description: String,
    pub creator_email: String,
    pub assignee_email: String,
    pub status: String,
    pub priority: String,
    pub labels: Vec<String>,
    pub linked_files: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub history: Vec<TeamHistoryEntry>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamReview {
    pub id: String,
    pub title: String,
    pub task_id: Option<String>,
    pub branch: String,
    pub base_branch: String,
    pub creator_email: String,
    pub reviewer_email: String,
    pub status: String,
    pub summary: String,
    pub created_at: String,
    pub updated_at: String,
    pub history: Vec<TeamHistoryEntry>,
    pub comments: Vec<TeamComment>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamNote {
    pub id: String,
    pub title: String,
    pub content: String,
    pub author_email: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub email: String,
    pub name: String,
    pub role: String,
    pub avatar_seed: String,
    pub joined_at: String,
    pub last_seen: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessageAttachment {
    pub name: String,
    /// `snow-team/media/<message_id>/<file>` 相对路径。
    pub path: String,
    pub size: i64,
    pub is_image: bool,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessage {
    pub id: String,
    pub channel: String,
    pub author_email: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<TeamMessageAttachment>,
    pub created_at: String,
}

// ===== 路径与 git 工具 =====

fn worktree_path(repo_path: &str) -> PathBuf {
    Path::new(repo_path).join(WORKTREE_REL)
}

fn record_dir(worktree: &Path, kind: &str) -> PathBuf {
    worktree.join(TEAM_DIR).join(kind)
}

fn record_path(worktree: &Path, kind: &str, id: &str) -> PathBuf {
    record_dir(worktree, kind).join(format!("{id}.json"))
}

fn record_rel(kind: &str, id: &str) -> String {
    format!("{TEAM_DIR}/{kind}/{id}.json")
}

fn remote_has_origin(repo_path: &str) -> bool {
    run_git_raw(repo_path, &["remote", "get-url", "origin"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn seed_for(email: &str) -> String {
    use blake3::Hasher;
    let mut hasher = Hasher::new();
    hasher.update(email.trim().to_lowercase().as_bytes());
    hasher.finalize().to_hex()[..12].to_string()
}

fn io_err(e: std::io::Error) -> Error {
    Error::from_reason(format!("team io error: {e}"))
}

/// 确保 `snow/team` 分支及其独立 worktree 存在。幂等。
fn ensure_team_worktree(repo_path: &str) -> Result<PathBuf> {
    if !is_git_repo(repo_path) {
        return Err(Error::from_reason("not a git repository"));
    }
    let worktree = worktree_path(repo_path);
    if worktree.join(".git").exists() {
        return Ok(worktree);
    }
    // 清理残留目录（上次初始化中断留下的非 worktree 目录）
    if worktree.exists() {
        let _ = fs::remove_dir_all(&worktree);
    }
    let wt = worktree
        .to_str()
        .ok_or_else(|| Error::from_reason("invalid worktree path"))?;

    // 注意：存在性检查必须用校验退出码的 run_git（show-ref --verify --quiet
    // 在引用缺失时以非零退出，run_git_raw 不检查退出码会误判为存在）。
    let has_local = run_git(repo_path, &["show-ref", "--verify", "--quiet", "refs/heads/snow/team"])
        .map(|_| true)
        .unwrap_or(false);
    let has_remote = run_git(
        repo_path,
        &["show-ref", "--verify", "--quiet", "refs/remotes/origin/snow/team"],
    )
    .map(|_| true)
    .unwrap_or(false);

    if !has_local && has_remote {
        run_git(repo_path, &["branch", TEAM_BRANCH, "origin/snow/team"])?;
    }

    if has_local || has_remote {
        run_git(repo_path, &["worktree", "add", wt, TEAM_BRANCH])?;
    } else {
        // 全新初始化：detach worktree → orphan 分支 → 空提交
        run_git(repo_path, &["worktree", "add", "--detach", wt, "HEAD"])?;
        run_git(wt, &["checkout", "--orphan", TEAM_BRANCH])?;
        let _ = run_git_raw(wt, &["rm", "-rf", "--quiet", "."]);
        let _ = fs::create_dir_all(worktree.join(TEAM_DIR));
        let _ = fs::write(
            worktree.join(TEAM_DIR).join("README.md"),
            "# Snow Team\n\nTeam collaboration data for Snow App.\n",
        );
        run_git(wt, &["add", "."])?;
        // 初始化提交用固定身份，避免依赖用户 git 配置
        run_git(
            wt,
            &[
                "-c",
                "user.name=Snow Team",
                "-c",
                "user.email=snow@team.local",
                "commit",
                "-m",
                "chore(snow-team): initialize team store",
            ],
        )?;
    }
    Ok(worktree)
}

/// 定位团队协作对应的真实仓库路径：
/// 1. 从给定路径向上查找最近的 `.git`（工作区是仓库根或其子目录时命中）；
/// 2. 否则扫描直接子目录（父目录包含仓库的场景，与 Git 面板一致）；
/// 3. 都找不到则返回空串（渲染层据此提示"不是 Git 仓库"）。
pub fn resolve_team_repo(path: &str) -> Result<String> {
    if !is_team_enabled() {
        return Err(team_disabled_err());
    }
    let mut current = PathBuf::from(path);
    loop {
        if current.join(".git").exists() {
            return Ok(current.to_string_lossy().to_string());
        }
        if !current.pop() {
            break;
        }
    }
    if let Ok(repos) = crate::storage::services::git::discover_git_repos(path, 1, &[]) {
        if let Some(first) = repos.first() {
            return Ok(first.path.clone());
        }
    }
    Ok(String::new())
}

// ===== 公开 API =====

/// 入口统一解析真实仓库路径（自身是仓库直接用，否则自动定位）；非仓库返回错误。
fn resolve_repo_path_or_err(repo_path: &str) -> Result<String> {
    if is_git_repo(repo_path) {
        return Ok(repo_path.to_string());
    }
    let resolved = resolve_team_repo(repo_path)?;
    if resolved.is_empty() {
        return Err(Error::from_reason("not a git repository"));
    }
    Ok(resolved)
}

/// 读取仓库 git 身份与远端信息。
///
/// 入口自动定位真实仓库：给定路径自身是仓库则直接用；否则向上找最近的
/// `.git`（工作区是仓库子目录）或扫描子目录（父目录包含仓库）。这样无论
/// 渲染层传入什么路径，只要它位于某个 git 仓库内/上方都能命中，并返回
/// 解析出的 `repo_path` 供渲染层后续操作使用。
pub fn get_team_identity(repo_path: &str) -> Result<TeamIdentity> {
    // 总开关：默认关闭，未启用时直接返回非仓库身份（侧边栏入口与团队面板均隐藏）
    if !is_team_enabled() {
        return Ok(TeamIdentity {
            is_repo: false,
            repo_path: String::new(),
            name: String::new(),
            email: String::new(),
            remote_url: String::new(),
            has_identity: false,
            error: Some("team collaboration disabled".into()),
        });
    }
    let resolved = if is_git_repo(repo_path) {
        repo_path.to_string()
    } else {
        resolve_team_repo(repo_path)?
    };
    if resolved.is_empty() {
        return Ok(TeamIdentity {
            is_repo: false,
            repo_path: String::new(),
            name: String::new(),
            email: String::new(),
            remote_url: String::new(),
            has_identity: false,
            error: Some("not a git repository".into()),
        });
    }
    let name = run_git_raw(&resolved, &["config", "user.name"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let email = run_git_raw(&resolved, &["config", "user.email"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let remote_url = run_git_raw(&resolved, &["remote", "get-url", "origin"])
        .unwrap_or_default()
        .trim()
        .to_string();
    Ok(TeamIdentity {
        is_repo: true,
        repo_path: resolved,
        has_identity: !name.is_empty() && !email.is_empty(),
        name,
        email,
        remote_url,
        error: None,
    })
}

/// 配置仓库本地身份（git config user.name/user.email）。返回更新后的身份。
pub fn configure_team_identity(repo_path: &str, name: &str, email: &str) -> Result<TeamIdentity> {
    if !is_team_enabled() {
        return Err(team_disabled_err());
    }
    let _guard = team_lock()
        .lock()
        .map_err(|_| Error::from_reason("team lock poisoned"))?;
    let repo_path = resolve_repo_path_or_err(repo_path)?;
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() || email.is_empty() {
        return Err(Error::from_reason("name and email are required"));
    }
    run_git(&repo_path, &["config", "user.name", name])?;
    run_git(&repo_path, &["config", "user.email", email])?;
    get_team_identity(&repo_path)
}

/// 全量同步：确保 worktree → fetch origin → 合并/变基 → 推送本地提交。
pub fn sync_team(repo_path: &str) -> Result<TeamSyncResult> {
    if !is_team_enabled() {
        return Err(team_disabled_err());
    }
    let _guard = team_lock()
        .lock()
        .map_err(|_| Error::from_reason("team lock poisoned"))?;
    let mut result = TeamSyncResult {
        ok: true,
        initialized: false,
        pulled: false,
        pushed: false,
        local_ahead: 0,
        local_behind: 0,
        error: None,
    };
    if !is_git_repo(repo_path) {
        result.ok = false;
        result.error = Some("not a git repository".into());
        return Ok(result);
    }
    let repo_path = match resolve_repo_path_or_err(repo_path) {
        Ok(path) => path,
        Err(e) => {
            result.ok = false;
            result.error = Some(e.to_string());
            return Ok(result);
        }
    };
    let worktree = match ensure_team_worktree(&repo_path) {
        Ok(w) => {
            result.initialized = true;
            w
        }
        Err(e) => {
            result.ok = false;
            result.error = Some(e.to_string());
            return Ok(result);
        }
    };
    let wt = worktree
        .to_str()
        .unwrap_or_default()
        .to_string();

    let has_remote = remote_has_origin(&repo_path);
    if has_remote {
        // fetch 失败（无网络等）不致命：继续用本地状态
        let _ = run_git_raw(&repo_path, &["fetch", "origin", TEAM_BRANCH]);
    }

    if let Ok(counts) = run_git_raw(
        &repo_path,
        &["rev-list", "--left-right", "--count", &format!("{TEAM_BRANCH}...origin/{TEAM_BRANCH}")],
    ) {
        let parts: Vec<&str> = counts.split_whitespace().collect();
        if parts.len() == 2 {
            let ahead: i32 = parts[0].parse().unwrap_or(0);
            let behind: i32 = parts[1].parse().unwrap_or(0);
            result.local_ahead = ahead;
            result.local_behind = behind;
            if behind > 0 {
                let merge_res = if ahead > 0 {
                    // 本地有未推送提交且远端前进：变基。同文件并发修改时
                    // 以本地版本优先（last-write-wins），保证同步不被卡死；
                    // 不同文件天然互不冲突。
                    run_git(
                        &wt,
                        &["pull", "--rebase", "--strategy-option=theirs", "origin", TEAM_BRANCH],
                    )
                } else {
                    run_git(&wt, &["merge", "--ff-only", &format!("origin/{TEAM_BRANCH}")])
                };
                match merge_res {
                    Ok(_) => result.pulled = true,
                    Err(e) => {
                        let _ = run_git_raw(&wt, &["rebase", "--abort"]);
                        let _ = run_git_raw(&wt, &["merge", "--abort"]);
                        result.ok = false;
                        result.error = Some(format!("failed to sync team store: {e}"));
                        return Ok(result);
                    }
                }
            }
        }
    }

    // 心跳：确保当前用户成员记录存在，>10 分钟未更新则刷新 last_seen
    if has_remote || result.initialized {
        touch_member(&repo_path, &worktree);
    }

    // 团队知识自动沉淀为项目级 Skill（幂等，覆盖初始化与 pull 场景）
    if result.initialized || result.pulled {
        sync_knowledge_skill(&repo_path, &worktree);
    }

    if has_remote {
        let local_rev = run_git_raw(&repo_path, &["rev-parse", TEAM_BRANCH]).unwrap_or_default();
        let remote_rev =
            run_git_raw(&repo_path, &["rev-parse", &format!("origin/{TEAM_BRANCH}")]).unwrap_or_default();
        if !local_rev.trim().is_empty() && local_rev.trim() != remote_rev.trim() {
            match run_git(&repo_path, &["push", "origin", &format!("{TEAM_BRANCH}:{TEAM_BRANCH}")]) {
                Ok(_) => result.pushed = true,
                Err(e) => result.error = Some(format!("push failed: {e}")),
            }
        }
    }
    Ok(result)
}

fn touch_member(repo_path: &str, worktree: &Path) {
    let Ok(identity) = get_team_identity(repo_path) else {
        return;
    };
    if !identity.has_identity {
        return;
    }
    let path = record_path(worktree, "member", &identity.email);
    let now = now_rfc3339();
    let existed = fs::read_to_string(&path).is_ok();
    let mut member = if let Ok(content) = fs::read_to_string(&path) {
        serde_json::from_str::<TeamMember>(&content).unwrap_or_else(|_| TeamMember {
            email: identity.email.clone(),
            name: identity.name.clone(),
            role: "member".into(),
            avatar_seed: seed_for(&identity.email),
            joined_at: now.clone(),
            last_seen: now.clone(),
        })
    } else {
        TeamMember {
            email: identity.email.clone(),
            name: identity.name.clone(),
            role: "member".into(),
            avatar_seed: seed_for(&identity.email),
            joined_at: now.clone(),
            last_seen: now.clone(),
        }
    };
    member.name = identity.name.clone();
    member.avatar_seed = seed_for(&identity.email);
    // 仅当记录已存在且最近 10 分钟内刚心跳过才跳过；新成员必须落盘
    let fresh = existed
        && chrono::DateTime::parse_from_rfc3339(&member.last_seen)
            .map(|d| {
                chrono::Utc::now()
                    .signed_duration_since(d.with_timezone(&chrono::Utc))
                    .num_seconds()
                    < MEMBER_HEARTBEAT_SECS
            })
            .unwrap_or(false);
    if fresh {
        return;
    }
    member.last_seen = now;
    let Ok(json) = serde_json::to_string(&member) else {
        return;
    };
    if fs::create_dir_all(path.parent().unwrap()).is_err() {
        return;
    }
    if fs::write(&path, &json).is_err() {
        return;
    }
    let wt = worktree.to_str().unwrap_or_default();
    let rel = record_rel("member", &identity.email);
    let _ = run_git_raw(wt, &["add", "--", &rel]);
    let _ = run_git_raw(
        wt,
        &[
            "-c",
            "user.name=Snow Team",
            "-c",
            "user.email=snow@team.local",
            "commit",
            "-m",
            &format!("team: member heartbeat {}", identity.email),
        ],
    );
}

/// 活动即在线：写/删任何记录时顺带刷新当前用户 last_seen，
/// 返回需一并 `git add` 的成员记录相对路径（不提交，由调用方同一次 commit 带上）。
fn bump_member_last_seen(repo_path: &str, worktree: &Path) -> Option<String> {
    let identity = get_team_identity(repo_path).ok()?;
    if !identity.has_identity {
        return None;
    }
    let path = record_path(worktree, "member", &identity.email);
    let now = now_rfc3339();
    let mut member = match fs::read_to_string(&path).ok().and_then(|c| {
        serde_json::from_str::<TeamMember>(&c).ok()
    }) {
        Some(m) => m,
        None => TeamMember {
            email: identity.email.clone(),
            name: identity.name.clone(),
            role: "member".into(),
            avatar_seed: seed_for(&identity.email),
            joined_at: now.clone(),
            last_seen: now.clone(),
        },
    };
    member.name = identity.name.clone();
    member.last_seen = now;
    let Ok(json) = serde_json::to_string(&member) else {
        return None;
    };
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return None;
        }
    }
    if fs::write(&path, &json).is_err() {
        return None;
    }
    Some(record_rel("member", &identity.email))
}

/// 列出某类记录，返回原始 JSON 字符串数组（未格式化，便于直接透传）。
pub fn list_team_records(repo_path: &str, kind: &str) -> Result<Vec<String>> {
    if !is_team_enabled() {
        return Err(team_disabled_err());
    }
    let _guard = team_lock()
        .lock()
        .map_err(|_| Error::from_reason("team lock poisoned"))?;
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }
    let repo_path = match resolve_repo_path_or_err(repo_path) {
        Ok(path) => path,
        Err(_) => return Ok(Vec::new()),
    };
    let worktree = match ensure_team_worktree(&repo_path) {
        Ok(w) => w,
        Err(_) => return Ok(Vec::new()),
    };
    let dir = record_dir(&worktree, kind);
    let mut out: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|e| e == "json").unwrap_or(false))
            .collect();
        files.sort();
        for f in files {
            if let Ok(content) = fs::read_to_string(&f) {
                if serde_json::from_str::<serde_json::Value>(&content).is_ok() {
                    out.push(content);
                }
            }
        }
    }
    Ok(out)
}

/// 写入或更新一条记录：写文件 → 提交（使用用户 git 身份）。
pub fn upsert_team_record(repo_path: &str, kind: &str, id: &str, json: &str) -> Result<String> {
    if !is_team_enabled() {
        return Err(team_disabled_err());
    }
    let _guard = team_lock()
        .lock()
        .map_err(|_| Error::from_reason("team lock poisoned"))?;
    if !is_git_repo(repo_path) {
        return Err(Error::from_reason("not a git repository"));
    }
    let repo_path = resolve_repo_path_or_err(repo_path)?;
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| Error::from_reason(format!("invalid record json: {e}")))?;
    if !value.is_object() {
        return Err(Error::from_reason("record must be a JSON object"));
    }
    let id = id.trim();
    if id.is_empty() {
        return Err(Error::from_reason("record id is required"));
    }
    let worktree = ensure_team_worktree(&repo_path)?;
    let path = record_path(&worktree, kind, id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }
    fs::write(&path, json).map_err(io_err)?;
    // 活动即在线：同一次提交顺带刷新自己的 last_seen
    let member_rel = if kind == "member" {
        None
    } else {
        bump_member_last_seen(&repo_path, &worktree)
    };
    let wt = worktree
        .to_str()
        .ok_or_else(|| Error::from_reason("invalid worktree path"))?;
    let rel = record_rel(kind, id);
    run_git(wt, &["add", "--", &rel])?;
    if let Some(member_rel) = &member_rel {
        let _ = run_git_raw(wt, &["add", "--", member_rel]);
    }
    let msg = format!("team: {kind} update {id}");
    match run_git(wt, &["commit", "-m", &msg]) {
        Ok(_) => {
            if kind == "note" {
                sync_knowledge_skill(&repo_path, &worktree);
            }
            Ok(json.to_string())
        }
        Err(e) => {
            let msg_lower = e.to_string();
            if msg_lower.contains("nothing to commit") || msg_lower.contains("no changes added") {
                if kind == "note" {
                    sync_knowledge_skill(&repo_path, &worktree);
                }
                return Ok(json.to_string());
            }
            if msg_lower.contains("Please tell me who you are") || msg_lower.contains("user.email") {
                return Err(Error::from_reason("git identity not configured"));
            }
            Err(e)
        }
    }
}

/// 删除一条记录（git rm + 提交）。
pub fn delete_team_record(repo_path: &str, kind: &str, id: &str) -> Result<bool> {
    if !is_team_enabled() {
        return Err(team_disabled_err());
    }
    let _guard = team_lock()
        .lock()
        .map_err(|_| Error::from_reason("team lock poisoned"))?;
    if !is_git_repo(repo_path) {
        return Ok(false);
    }
    let repo_path = match resolve_repo_path_or_err(repo_path) {
        Ok(path) => path,
        Err(_) => return Ok(false),
    };
    let worktree = ensure_team_worktree(&repo_path)?;
    let path = record_path(&worktree, kind, id);
    if !path.exists() {
        return Ok(false);
    }
    let wt = worktree
        .to_str()
        .ok_or_else(|| Error::from_reason("invalid worktree path"))?;
    let rel = record_rel(kind, id);
    run_git(wt, &["rm", "--quiet", "--", &rel])?;
    // 活动即在线：同一次提交顺带刷新自己的 last_seen
    if kind != "member" {
        if let Some(member_rel) = bump_member_last_seen(&repo_path, &worktree) {
            let _ = run_git_raw(wt, &["add", "--", &member_rel]);
        }
    }
    let msg = format!("team: {kind} delete {id}");
    match run_git(wt, &["commit", "-m", &msg]) {
        Ok(_) => {
            if kind == "note" {
                sync_knowledge_skill(&repo_path, &worktree);
            }
            Ok(true)
        }
        Err(e) => {
            let msg_lower = e.to_string();
            if msg_lower.contains("nothing to commit") || msg_lower.contains("no changes added") {
                if kind == "note" {
                    sync_knowledge_skill(&repo_path, &worktree);
                }
                return Ok(true);
            }
            Err(e)
        }
    }
}

const TEAM_MEDIA_MAX_BYTES: usize = 5 * 1024 * 1024;
const TEAM_MEDIA_REL_PREFIX: &str = "snow-team/media/";

/// 团队媒体文件所有者 id（笔记/消息 id）校验。
fn validate_owner_id(owner_id: &str) -> Result<()> {
    if owner_id.is_empty()
        || owner_id.len() > 128
        || !owner_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(Error::from_reason("invalid owner id"));
    }
    Ok(())
}

/// 黑名单扩展名：禁止可执行/脚本类文件随仓库分发。
const BLOCKED_FILE_EXTS: &[&str] = &[
    "exe", "dll", "so", "dylib", "bat", "cmd", "com", "msi", "scr", "vbs",
    "vbe", "ps1", "psm1", "app", "deb", "rpm", "pkg", "dmg", "reg", "inf",
];

/// 文件名安全化：保留原名（含中文），剥掉路径成分与危险字符。
fn sanitize_file_name(file_name: &str) -> Result<String> {
    let base = Path::new(file_name.trim())
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() || cleaned.len() > 160 {
        return Err(Error::from_reason("invalid file name"));
    }
    Ok(cleaned)
}

fn image_ext_ok(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg"
    )
}

/// 保存团队媒体文件（图片或通用附件）到 snow/team 分支的
/// `snow-team/media/<owner_id>/` 目录，随后经 git 同步共享。
/// `base64_data` 支持 `data:*/*;base64,...` 或裸 base64，
/// 返回相对路径 `snow-team/media/<owner_id>/<file_name>`。
pub fn save_media_file(
    repo_path: &str,
    owner_id: &str,
    file_name: &str,
    base64_data: &str,
    image_only: bool,
) -> Result<String> {
    if !is_team_enabled() {
        return Err(team_disabled_err());
    }
    let _guard = team_lock()
        .lock()
        .map_err(|_| Error::from_reason("team lock poisoned"))?;
    if !is_git_repo(repo_path) {
        return Err(Error::from_reason("not a git repository"));
    }
    let repo_path = resolve_repo_path_or_err(repo_path)?;
    let owner_id = owner_id.trim();
    validate_owner_id(owner_id)?;
    let file_name = sanitize_file_name(file_name)?;
    let ext = Path::new(&file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if image_only {
        if !image_ext_ok(&ext) {
            return Err(Error::from_reason("unsupported image extension"));
        }
    } else if BLOCKED_FILE_EXTS.contains(&ext.as_str()) {
        return Err(Error::from_reason("file type not allowed"));
    }

    // 解析 data URL 或裸 base64
    let trimmed = base64_data.trim();
    let b64 = match trimmed.strip_prefix("data:") {
        Some(rest) => {
            let (meta, data) = rest
                .split_once(',')
                .ok_or_else(|| Error::from_reason("invalid data url"))?;
            let mime = meta.split(';').next().unwrap_or("").trim().to_lowercase();
            if image_only && !mime.starts_with("image/") {
                return Err(Error::from_reason("only image data urls allowed"));
            }
            data
        }
        None => trimmed,
    };

    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
    let bytes = BASE64_STANDARD
        .decode(b64)
        .map_err(|e| Error::from_reason(format!("invalid base64: {e}")))?;
    if bytes.is_empty() {
        return Err(Error::from_reason("empty media data"));
    }
    if bytes.len() > TEAM_MEDIA_MAX_BYTES {
        return Err(Error::from_reason(format!(
            "file exceeds {} bytes",
            TEAM_MEDIA_MAX_BYTES
        )));
    }

    let worktree = ensure_team_worktree(&repo_path)?;
    let dir = worktree.join(TEAM_DIR).join("media").join(owner_id);
    fs::create_dir_all(&dir).map_err(io_err)?;
    let path = dir.join(&file_name);
    fs::write(&path, &bytes).map_err(io_err)?;
    let rel = format!("{TEAM_DIR}/media/{owner_id}/{file_name}");
    let wt = worktree
        .to_str()
        .ok_or_else(|| Error::from_reason("invalid worktree path"))?;
    run_git(wt, &["add", "--", &rel])?;
    let msg = format!("team: media {owner_id} {file_name}");
    match run_git(wt, &["commit", "-m", &msg]) {
        Ok(_) => Ok(rel),
        Err(e) => {
            let msg_lower = e.to_string();
            if msg_lower.contains("nothing to commit") || msg_lower.contains("no changes added") {
                return Ok(rel);
            }
            if msg_lower.contains("Please tell me who you are") || msg_lower.contains("user.email")
            {
                return Err(Error::from_reason("git identity not configured"));
            }
            Err(e)
        }
    }
}

/// 保存团队笔记媒体文件（图片），供笔记编辑器使用。
pub fn save_team_media(
    repo_path: &str,
    note_id: &str,
    file_name: &str,
    base64_data: &str,
) -> Result<String> {
    save_media_file(repo_path, note_id, file_name, base64_data, true)
}

/// 保存团队消息附件（图片或普通文件）。
pub fn save_team_file(
    repo_path: &str,
    message_id: &str,
    file_name: &str,
    base64_data: &str,
) -> Result<String> {
    save_media_file(repo_path, message_id, file_name, base64_data, false)
}

/// 删除某条记录（笔记/消息）的整个媒体目录（git rm -r + 提交）。
pub fn delete_team_media(repo_path: &str, owner_id: &str) -> Result<bool> {
    if !is_team_enabled() {
        return Err(team_disabled_err());
    }
    let _guard = team_lock()
        .lock()
        .map_err(|_| Error::from_reason("team lock poisoned"))?;
    if !is_git_repo(repo_path) {
        return Ok(false);
    }
    let repo_path = resolve_repo_path_or_err(repo_path)?;
    let owner_id = owner_id.trim();
    validate_owner_id(owner_id)?;
    let worktree = ensure_team_worktree(&repo_path)?;
    let dir_rel = format!("{TEAM_DIR}/media/{owner_id}");
    if !worktree.join(&dir_rel).exists() {
        return Ok(false);
    }
    let wt = worktree
        .to_str()
        .ok_or_else(|| Error::from_reason("invalid worktree path"))?;
    run_git(wt, &["rm", "-r", "--quiet", "--", &dir_rel])?;
    let msg = format!("team: media delete {owner_id}");
    match run_git(wt, &["commit", "-m", &msg]) {
        Ok(_) => Ok(true),
        Err(e) => {
            let msg_lower = e.to_string();
            if msg_lower.contains("nothing to commit") || msg_lower.contains("no changes added") {
                return Ok(true);
            }
            Err(e)
        }
    }
}

/// 读取团队媒体文件，返回 data URL（`data:<mime>;base64,...`）。
pub fn read_team_media(repo_path: &str, rel: &str) -> Result<String> {
    if !is_team_enabled() {
        return Err(team_disabled_err());
    }
    let _guard = team_lock()
        .lock()
        .map_err(|_| Error::from_reason("team lock poisoned"))?;
    let rel = rel.trim().replace('\\', "/");
    if rel.len() > 512 || !rel.starts_with(TEAM_MEDIA_REL_PREFIX) || rel.contains("..") {
        return Err(Error::from_reason("invalid media path"));
    }
    let repo_path = resolve_repo_path_or_err(repo_path)?;
    let file_path = worktree_path(&repo_path).join(rel);
    let bytes = fs::read(&file_path).map_err(io_err)?;
    if bytes.is_empty() || bytes.len() > TEAM_MEDIA_MAX_BYTES {
        return Err(Error::from_reason("invalid media file size"));
    }
    let ext = file_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "zip" => "application/zip",
        "gz" | "gzip" => "application/gzip",
        "tar" => "application/x-tar",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "txt" | "md" | "log" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "xml" | "html" | "htm" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
    Ok(format!(
        "data:{mime};base64,{}",
        BASE64_STANDARD.encode(&bytes)
    ))
}

// 避免未使用告警：json! 宏仅用于测试/扩展场景
#[allow(dead_code)]
fn _placeholder() -> serde_json::Value {
    json!({})
}
