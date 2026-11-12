use std::fs;
use std::path::{Path, PathBuf};

use napi::{Error, Status};
use napi_derive::napi;
use serde::{Deserialize, Serialize};

use crate::mcp::servers::remote_workspace::is_ssh_path;
use crate::mcp::servers::skills_remote::remove_remote_skill_dir;

mod github;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Parsed GitHub URL information used to download a repository archive.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ParsedGitHubUrl {
    /// GitHub owner / org name, e.g. "MayDay-wpf"
    pub owner: String,
    /// Repository name, e.g. "snow-cli"
    pub repo: String,
    /// Branch/tag/commit. When omitted the default branch is used.
    pub r#ref: Option<String>,
    /// Optional sub-directory inside the repository that should be treated as
    /// the skill root (the directory containing `SKILL.md`).
    pub sub_dir: Option<String>,
}

/// Metadata persisted for every skill installed from GitHub so that it can be
/// updated or removed later.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InstalledSkillRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub location: String,
    pub source_url: String,
    pub github: ParsedGitHubUrl,
    pub installed_at: String,
    pub commit_sha: Option<String>,
}

#[napi(object)]
pub struct SkillInstallResult {
    pub success: bool,
    pub skill_id: String,
    pub path: String,
    pub installed_at: String,
    pub commit_sha: Option<String>,
    pub error: Option<String>,
}

#[napi(object)]
pub struct SkillBatchInstallResult {
    pub success: bool,
    pub results: Vec<SkillInstallResult>,
    pub installed_count: i64,
    pub total_count: i64,
    pub commit_sha: Option<String>,
    pub error: Option<String>,
}

#[napi(object)]
pub struct GithubSkillRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub location: String,
    pub source_url: String,
    pub installed_at: String,
    pub commit_sha: Option<String>,
}

#[napi(object)]
pub struct SkillUninstallResult {
    pub success: bool,
    pub skill_id: String,
    pub message: String,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/// Parse a GitHub URL into owner/repo (+ optional ref / sub-directory).
/// Lenient on purpose: only github.com URLs and owner/repo shorthands are
/// recognized, everything else is left to the download to accept or fail.
pub fn parse_github_url(input: &str) -> Option<ParsedGitHubUrl> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut working = trimmed.to_string();
    let lowered = working.to_ascii_lowercase();
    let is_url = lowered.starts_with("http://")
        || lowered.starts_with("https://")
        || lowered.starts_with("github.com/")
        || lowered.starts_with("www.github.com/");

    if is_url {
        // Strip query / fragment (URLs only; shorthand branches may contain them).
        if let Some(hash_idx) = working.find('#') {
            working.truncate(hash_idx);
        }
        if let Some(query_idx) = working.find('?') {
            working.truncate(query_idx);
        }
    } else if lowered.starts_with("git@github.com:") {
        // SSH clone URL -> rewrite into the owner/repo shorthand form.
        working = working.split_off("git@github.com:".len());
    }

    // Strip a trailing .git suffix and any trailing slashes.
    if working.ends_with(".git") {
        working.truncate(working.len() - 4);
    }
    while working.ends_with('/') {
        working.pop();
    }

    if is_url {
        // Skip the scheme, then the host must be github.com (www. tolerated).
        let after_scheme = working.find("://").map(|idx| idx + 3).unwrap_or(0);
        let mut segments = working[after_scheme..].split('/');
        let host = segments.next().unwrap_or_default();
        if !(host.eq_ignore_ascii_case("github.com")
            || host.eq_ignore_ascii_case("www.github.com"))
        {
            return None;
        }
        let owner = segments.next().filter(|s| !s.is_empty())?;
        let repo = segments.next().filter(|s| !s.is_empty())?;
        let rest: Vec<&str> = segments.filter(|s| !s.is_empty()).collect();
        let (r#ref, sub_dir) = match rest.first() {
            Some(&first)
                if matches!(
                    first.to_ascii_lowercase().as_str(),
                    "tree" | "blob" | "raw"
                ) && rest.len() >= 2 =>
            {
                let sub = if rest.len() > 2 {
                    Some(rest[2..].join("/"))
                } else {
                    None
                };
                (Some(rest[1].to_string()), sub)
            }
            _ => (None, None),
        };
        return Some(ParsedGitHubUrl {
            owner: owner.to_string(),
            repo: repo.to_string(),
            r#ref: r#ref.filter(|r| !r.is_empty()),
            sub_dir: sub_dir.filter(|s| !s.is_empty()),
        });
    }

    // Shorthand: owner/repo  or  owner/repo@ref  or  owner/repo@ref:sub/dir
    let shorthand_re = regex::Regex::new(r"^([^/\s@]+)/([^/\s@]+)(?:@([^:]+))?(?::(.+))?$").ok()?;
    let caps = shorthand_re.captures(&working)?;
    let owner = caps.get(1)?.as_str().to_string();
    let repo = caps.get(2)?.as_str().to_string();
    let r#ref = caps.get(3).map(|m| m.as_str().to_string());
    let sub_dir = caps.get(4).map(|m| m.as_str().to_string());
    Some(ParsedGitHubUrl {
        owner,
        repo,
        r#ref: r#ref.filter(|r| !r.is_empty()),
        sub_dir: sub_dir.filter(|s| !s.is_empty()),
    })
}

// ---------------------------------------------------------------------------
// Registry (installed skills metadata)
// ---------------------------------------------------------------------------

fn get_registry_path() -> PathBuf {
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".snow").join("skills-registry.json")
}

fn load_installed_skills() -> Vec<InstalledSkillRecord> {
    let registry_path = get_registry_path();
    let Ok(content) = fs::read_to_string(&registry_path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<InstalledSkillRecord>>(&content) {
        Ok(records) => records,
        Err(_) => Vec::new(),
    }
}

fn save_installed_skills_at(
    records: &[InstalledSkillRecord],
    registry_path: &Path,
) -> napi::Result<()> {
    if let Some(parent) = registry_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create registry directory: {e}"),
            )
        })?;
    }
    let json = serde_json::to_string_pretty(records).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize skill registry: {e}"),
        )
    })?;
    let parent = registry_path.parent().ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            format!("Registry path has no parent: {}", registry_path.display()),
        )
    })?;
    let file_name = registry_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skills-registry.json");
    let temporary = parent.join(format!(".{file_name}.snow-stage-{}", uuid::Uuid::new_v4()));
    let backup = parent.join(format!(
        ".{file_name}.snow-previous-{}",
        uuid::Uuid::new_v4()
    ));
    if let Err(error) = fs::write(&temporary, json) {
        let _ = fs::remove_file(&temporary);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to write staged skill registry: {error}"),
        ));
    }

    let had_previous = registry_path.exists();
    if had_previous {
        fs::rename(registry_path, &backup).map_err(|e| {
            let _ = fs::remove_file(&temporary);
            Error::new(
                Status::GenericFailure,
                format!("Failed to preserve existing skill registry: {e}"),
            )
        })?;
    }
    if let Err(error) = fs::rename(&temporary, registry_path) {
        if had_previous {
            if let Err(restore_error) = fs::rename(&backup, registry_path) {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!(
                        "Failed to replace skill registry: {error}. Automatic restoration failed: {restore_error}. Recovery data was kept at {}",
                        parent.display()
                    ),
                ));
            }
        }
        let _ = fs::remove_file(&temporary);
        return Err(Error::new(
            Status::GenericFailure,
            format!("Failed to replace skill registry: {error}"),
        ));
    }
    if had_previous {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn save_installed_skills(records: &[InstalledSkillRecord]) -> napi::Result<()> {
    save_installed_skills_at(records, &get_registry_path())
}

fn upsert_record_at(record: InstalledSkillRecord, registry_path: &Path) -> napi::Result<()> {
    let mut records = if registry_path.exists() {
        let content = fs::read_to_string(registry_path).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read skill registry: {e}"),
            )
        })?;
        serde_json::from_str::<Vec<InstalledSkillRecord>>(&content).unwrap_or_default()
    } else {
        Vec::new()
    };
    let idx = records
        .iter()
        .position(|r| r.id == record.id && r.location == record.location);
    match idx {
        Some(i) => {
            records[i] = record;
        }
        None => records.push(record),
    }
    save_installed_skills_at(&records, registry_path)
}

fn remove_record(skill_id: &str, location: &str) -> napi::Result<()> {
    let records = load_installed_skills();
    let filtered: Vec<InstalledSkillRecord> = records
        .into_iter()
        .filter(|r| !(r.id == skill_id && r.location == location))
        .collect();
    save_installed_skills(&filtered)
}

// ---------------------------------------------------------------------------
// Install target / destination
// ---------------------------------------------------------------------------

/// 技能安装目标：全局目录、本地项目目录，或 SSH 远程项目目录。
pub(crate) enum SkillInstallTarget {
    Global,
    LocalProject(PathBuf),
    RemoteProject(String),
}

impl SkillInstallTarget {
    /// SSH 远程工作区 URI（非远程目标返回 None）。
    pub(crate) fn remote_workspace(&self) -> Option<&str> {
        match self {
            SkillInstallTarget::RemoteProject(workspace) => Some(workspace),
            _ => None,
        }
    }
}

/// 技能目录的最终落点：本地文件系统路径，或 SSH 工作区内的 `ssh://` URI。
pub(crate) enum SkillDestination {
    Local(PathBuf),
    Remote(String),
}

/// 解析安装目标。`project` 位置必须能取到项目工作区：本地工作区走本地安装，
/// `ssh://` 工作区交给 Electron 的 SSH 通道安装；取不到工作区时直接失败，
/// 绝不退化成相对路径把技能装到应用目录里。
fn resolve_install_target(
    location: &str,
    project_id: Option<&str>,
) -> napi::Result<SkillInstallTarget> {
    if location != "project" {
        return Ok(SkillInstallTarget::Global);
    }

    let workspace = match project_id {
        Some(project_id) => resolve_project_workspace(project_id)?,
        None => None,
    };
    let Some(workspace) = workspace
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
    else {
        return Err(Error::new(
            Status::InvalidArg,
            "Project Skills require a project with a workspace directory".to_string(),
        ));
    };

    if is_ssh_path(&workspace) {
        Ok(SkillInstallTarget::RemoteProject(workspace))
    } else {
        Ok(SkillInstallTarget::LocalProject(PathBuf::from(workspace)))
    }
}

/// 技能目录落点：本地返回文件系统路径，远程返回工作区内的 `ssh://` URI。
pub(crate) fn skill_destination(target: &SkillInstallTarget, skill_id: &str) -> SkillDestination {
    let segments: Vec<&str> = skill_id
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();

    match target {
        SkillInstallTarget::Global => {
            let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
            SkillDestination::Local(join_skill_segments(
                home.join(".snow").join("skills"),
                &segments,
            ))
        }
        SkillInstallTarget::LocalProject(root) => SkillDestination::Local(join_skill_segments(
            root.join(".snow").join("skills"),
            &segments,
        )),
        SkillInstallTarget::RemoteProject(workspace) => {
            let mut uri = format!("{}/.snow/skills", workspace.trim_end_matches('/'));
            for segment in segments {
                uri.push('/');
                uri.push_str(segment);
            }
            SkillDestination::Remote(uri)
        }
    }
}

/// 把技能 id 的分段依次拼到本地技能根目录之后。
fn join_skill_segments(mut root: PathBuf, segments: &[&str]) -> PathBuf {
    for segment in segments {
        root.push(segment);
    }
    root
}

// ---------------------------------------------------------------------------
// Public napi API
// ---------------------------------------------------------------------------

/// Install (or re-install) skill(s) from a GitHub URL.
#[napi]
pub async fn install_skill_from_github(
    url: String,
    location: String,
    project_id: Option<String>,
) -> napi::Result<SkillBatchInstallResult> {
    let target = resolve_install_target(&location, project_id.as_deref())?;
    github::install_skills_from_github(url, location, target).await
}

/// Uninstall a skill that was installed from GitHub.
#[napi]
pub async fn uninstall_github_skill(
    skill_id: String,
    project_id: Option<String>,
) -> napi::Result<SkillUninstallResult> {
    let record = {
        let skill_id = skill_id.clone();
        tokio::task::spawn_blocking(move || {
            load_installed_skills()
                .into_iter()
                .find(|record| record.id == skill_id)
        })
        .await
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Uninstall skill task failed: {e}"),
            )
        })?
    };
    let Some(record) = record else {
        return Ok(SkillUninstallResult {
            success: false,
            skill_id: skill_id.clone(),
            message: format!("Skill \"{skill_id}\" is not installed from GitHub"),
            error: None,
        });
    };

    let target = resolve_install_target(&record.location, project_id.as_deref())?;
    match skill_destination(&target, &record.id) {
        SkillDestination::Local(skill_dir) => {
            tokio::task::spawn_blocking(move || github::remove_dir_if_exists(&skill_dir))
                .await
                .map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Uninstall skill task failed: {e}"),
                    )
                })??;
        }
        SkillDestination::Remote(skill_uri) => {
            let workspace = target.remote_workspace().ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "Remote Skill directory requires an SSH workspace".to_string(),
                )
            })?;
            remove_remote_skill_dir(workspace, &skill_uri).await?;
        }
    }

    let removed = record.clone();
    tokio::task::spawn_blocking(move || remove_record(&removed.id, &removed.location))
        .await
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Uninstall skill task failed: {e}"),
            )
        })??;

    Ok(SkillUninstallResult {
        success: true,
        skill_id: record.id.clone(),
        message: format!("Skill \"{}\" uninstalled", record.id),
        error: None,
    })
}

/// List all skills installed from GitHub.
#[napi]
pub async fn list_github_skills() -> napi::Result<Vec<GithubSkillRecord>> {
    tokio::task::spawn_blocking(|| {
        let records = load_installed_skills();
        Ok(records
            .into_iter()
            .map(|r| GithubSkillRecord {
                id: r.id,
                name: r.name,
                description: r.description,
                location: r.location,
                source_url: r.source_url,
                installed_at: r.installed_at,
                commit_sha: r.commit_sha,
            })
            .collect())
    })
    .await
    .map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("List github skills task failed: {e}"),
        )
    })?
}

/// Resolve a project's workspace path (local absolute path or `ssh://` URI)
/// from its id.
fn resolve_project_workspace(project_id: &str) -> napi::Result<Option<String>> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    crate::storage::services::workspace_directories::get_workspace_directory_path(
        &database_path,
        project_id,
    )
}
