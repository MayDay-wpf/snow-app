use super::*;

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;

use napi::{Error, Status};

use super::super::skills::{parse_skill_metadata_for_install, SKILL_FILE_NAME};
use super::super::skills_remote::{install_remote_skill_dir, remove_remote_skill_dir};

struct ShaInfo {
    sha: String,
    r#ref: String,
}

/// Commit SHA as an option: an empty SHA (degraded mode, when the GitHub API
/// was unavailable and the archive was downloaded by ref name) becomes `None`.
fn commit_sha_opt(sha: &str) -> Option<String> {
    if sha.is_empty() {
        None
    } else {
        Some(sha.to_string())
    }
}

/// Resolve the commit SHA for the given GitHub ref via the GitHub REST API.
fn resolve_commit_sha(parsed: &ParsedGitHubUrl) -> napi::Result<ShaInfo> {
    let ref_path = parsed.r#ref.clone().unwrap_or_else(|| "HEAD".to_string());
    let url = format!(
        "https://api.github.com/repos/{}/{}/commits/{}",
        parsed.owner, parsed.repo, ref_path
    );
    let client = build_http_client()?;
    let resp = client.get(&url).send().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("GitHub API request failed: {e}"),
        )
    })?;

    if !resp.status().is_success() {
        // Fall back to the repo endpoint for default branch info
        let repo_url = format!(
            "https://api.github.com/repos/{}/{}",
            parsed.owner, parsed.repo
        );
        let repo_resp = client.get(&repo_url).send().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("GitHub repo API request failed: {e}"),
            )
        })?;
        if !repo_resp.status().is_success() {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "GitHub API error: {} {}",
                    resp.status().as_u16(),
                    resp.status().canonical_reason().unwrap_or("")
                ),
            ));
        }
        let repo_data: serde_json::Value = repo_resp.json().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse GitHub repo response: {e}"),
            )
        })?;
        let default_branch = repo_data
            .get("default_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("main")
            .to_string();
        let sha_url = format!(
            "https://api.github.com/repos/{}/{}/commits/{}",
            parsed.owner, parsed.repo, default_branch
        );
        let sha_resp = client.get(&sha_url).send().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("GitHub commits API request failed: {e}"),
            )
        })?;
        if !sha_resp.status().is_success() {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Cannot resolve commit SHA for {}/{}@{}",
                    parsed.owner, parsed.repo, default_branch
                ),
            ));
        }
        let sha_data: serde_json::Value = sha_resp.json().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse GitHub commits response: {e}"),
            )
        })?;
        let sha = sha_data
            .get("sha")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Ok(ShaInfo {
            sha,
            r#ref: default_branch,
        });
    }

    let data: serde_json::Value = resp.json().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse GitHub commits response: {e}"),
        )
    })?;
    let sha = data
        .get("sha")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(ShaInfo {
        sha,
        r#ref: parsed.r#ref.clone().unwrap_or_else(|| ref_path),
    })
}

fn build_http_client() -> napi::Result<reqwest::blocking::Client> {
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(crate::api::http_client::app_user_agent())
        // Avoid hanging forever on flaky networks.
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300));
    // Use a GitHub token when available to avoid unauthenticated API rate
    // limits (60 requests/hour per IP). Reads GITHUB_TOKEN first, then
    // GH_TOKEN (the environment variable used by the gh CLI, e.g. after
    // `gh auth login`); the app inherits user-level environment variables,
    // so a logged-in gh usually makes the installer authenticated too.
    let token = std::env::var("GITHUB_TOKEN")
        .or_else(|_| std::env::var("GH_TOKEN"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(token) = token {
        if let Ok(header_value) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(reqwest::header::AUTHORIZATION, header_value);
            builder = builder.default_headers(headers);
        }
    }
    builder.build().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to build HTTP client: {e}"),
        )
    })
}

/// Download a tar.gz archive of a GitHub repo and extract it into the target
/// directory. The top-level "owner-repo-hash/" directory is stripped.
///
/// Uses codeload.github.com (GitHub's archive CDN) directly instead of the
/// api.github.com tarball endpoint: codeload is not subject to the anonymous
/// API rate limit, so installs keep working without authentication (e.g. no
/// gh login / GITHUB_TOKEN). It accepts a branch, tag, commit SHA or `HEAD`.
fn download_and_extract(
    parsed: &ParsedGitHubUrl,
    ref_name: &str,
    target_dir: &Path,
) -> napi::Result<()> {
    let download_url = format!(
        "https://codeload.github.com/{}/{}/tar.gz/{}",
        parsed.owner, parsed.repo, ref_name
    );
    let client = build_http_client()?;
    let resp = client.get(&download_url).send().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to download archive: {e}"),
        )
    })?;
    if !resp.status().is_success() {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Failed to download archive: {} {}",
                resp.status().as_u16(),
                resp.status().canonical_reason().unwrap_or("")
            ),
        ));
    }

    let bytes = resp.bytes().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read archive bytes: {e}"),
        )
    })?;

    fs::create_dir_all(target_dir).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create target directory: {e}"),
        )
    })?;

    // Decompress gzip then unpack the tar stream, stripping the top-level
    // "owner-repo-hash/" directory prefix from every entry.
    let cursor = Cursor::new(bytes);
    let gz_decoder = flate2::read::GzDecoder::new(cursor);
    let mut archive = tar::Archive::new(gz_decoder);
    let entries_iter = archive.entries().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read tar entries: {e}"),
        )
    })?;
    for entry_result in entries_iter {
        let mut entry = entry_result.map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read tar entry: {e}"),
            )
        })?;
        let path = entry.path().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read tar entry path: {e}"),
            )
        })?;
        let path = path.into_owned();
        // Strip the first path component (owner-repo-hash/)
        let relative = match path.iter().next() {
            Some(first) => {
                let first_str = first.to_string_lossy().to_string();
                path.strip_prefix(&first_str).unwrap_or(&path)
            }
            None => &path,
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let dest_path = target_dir.join(relative);
        // Safety: ensure the resolved dest path stays within target_dir to
        // avoid path traversal.
        if !dest_path.starts_with(target_dir) {
            continue;
        }

        match entry.header().entry_type() {
            tar::EntryType::Directory => {
                fs::create_dir_all(&dest_path).map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to create directory {}: {e}", dest_path.display()),
                    )
                })?;
            }
            _ => {
                if let Some(parent) = dest_path.parent() {
                    fs::create_dir_all(parent).map_err(|e| {
                        Error::new(
                            Status::GenericFailure,
                            format!("Failed to create parent directory: {e}"),
                        )
                    })?;
                }
                let mut file = fs::File::create(&dest_path).map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to create file {}: {e}", dest_path.display()),
                    )
                })?;
                std::io::copy(&mut entry, &mut file).map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to write file {}: {e}", dest_path.display()),
                    )
                })?;
            }
        }
    }

    Ok(())
}

/// Read SKILL.md frontmatter from an extracted skill directory.
fn read_skill_metadata(skill_dir: &Path) -> Option<(String, String)> {
    let skill_file = skill_dir.join(SKILL_FILE_NAME);
    let Ok(content) = fs::read_to_string(&skill_file) else {
        return None;
    };
    let metadata = parse_skill_metadata_for_install(&content)?;
    Some((metadata.0, metadata.1))
}

/// Recursively copy a directory.
fn copy_dir(src: &Path, dest: &Path) -> napi::Result<()> {
    fs::create_dir_all(dest).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create destination directory: {e}"),
        )
    })?;
    let entries = fs::read_dir(src).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read source directory: {e}"),
        )
    })?;
    for entry in entries.flatten() {
        let src_path = entry.path();
        let entry_name = entry.file_name();
        let dest_path = dest.join(&entry_name);
        let file_type = entry.file_type().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read entry type: {e}"),
            )
        })?;
        if file_type.is_dir() {
            copy_dir(&src_path, &dest_path)?;
        } else if file_type.is_file() {
            fs::copy(&src_path, &dest_path).map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to copy file {}: {e}", src_path.display()),
                )
            })?;
        }
    }
    Ok(())
}

pub(crate) fn remove_dir_if_exists(dir: &Path) -> napi::Result<()> {
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to remove directory {}: {e}", dir.display()),
            )
        })?;
    }
    Ok(())
}

struct DirectoryCommit {
    target: PathBuf,
    staging_root: PathBuf,
    staged: PathBuf,
    backup: PathBuf,
    committed: bool,
    replaced_target: bool,
    preserve_recovery: bool,
}

impl DirectoryCommit {
    fn prepare(source: &Path, target: PathBuf) -> napi::Result<Self> {
        if !source.is_dir() {
            return Err(Error::new(
                Status::GenericFailure,
                format!("Directory source does not exist: {}", source.display()),
            ));
        }
        let parent = target.parent().ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                format!("Skill destination has no parent: {}", target.display()),
            )
        })?;
        fs::create_dir_all(parent).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create skill destination directory: {e}"),
            )
        })?;
        let target_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill");
        let staging_root = parent.join(format!(
            ".{target_name}.snow-stage-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&staging_root).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create local Skill staging directory: {e}"),
            )
        })?;
        let staged = staging_root.join("new");
        if let Err(error) = copy_dir(source, &staged) {
            let _ = fs::remove_dir_all(&staging_root);
            return Err(Error::new(
                Status::GenericFailure,
                format!("Failed to stage Skill directory: {error}"),
            ));
        }
        Ok(Self {
            target,
            backup: staging_root.join("previous"),
            staged,
            staging_root,
            committed: false,
            replaced_target: false,
            preserve_recovery: false,
        })
    }

    fn restore_previous(&mut self) -> std::io::Result<()> {
        if self.replaced_target && self.backup.exists() {
            fs::rename(&self.backup, &self.target)?;
        }
        Ok(())
    }

    fn commit(&mut self) -> napi::Result<()> {
        if self.committed {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Skill directory transaction is already committed: {}",
                    self.target.display()
                ),
            ));
        }
        if self.target.exists() {
            fs::rename(&self.target, &self.backup).map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to preserve existing Skill directory: {e}"),
                )
            })?;
            self.replaced_target = true;
        }
        if let Err(error) = fs::rename(&self.staged, &self.target) {
            if let Err(restore_error) = self.restore_previous() {
                self.preserve_recovery = true;
                return Err(Error::new(
                    Status::GenericFailure,
                    format!(
                        "Failed to commit Skill directory: {error}. Automatic restoration failed: {restore_error}. Recovery data was kept at {}",
                        self.staging_root.display()
                    ),
                ));
            }
            return Err(Error::new(
                Status::GenericFailure,
                format!("Failed to commit Skill directory: {error}"),
            ));
        }
        self.committed = true;
        Ok(())
    }

    fn rollback(&mut self) -> napi::Result<()> {
        if !self.committed {
            return Ok(());
        }
        if let Err(error) = fs::remove_dir_all(&self.target) {
            self.preserve_recovery = true;
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to remove new Skill directory: {error}. Recovery data was kept at {}",
                    self.staging_root.display()
                ),
            ));
        }
        if let Err(error) = self.restore_previous() {
            self.preserve_recovery = true;
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to restore previous Skill directory: {error}. Recovery data was kept at {}",
                    self.staging_root.display()
                ),
            ));
        }
        self.committed = false;
        Ok(())
    }

    fn cleanup(&self) {
        if !self.preserve_recovery {
            let _ = fs::remove_dir_all(&self.staging_root);
        }
    }
}

// ---------------------------------------------------------------------------
// Install logic
// ---------------------------------------------------------------------------

/// Derive a filesystem-safe skill id from SKILL.md frontmatter `name` or fall
/// back to the repository name.
fn derive_skill_id(metadata: &Option<(String, String)>, repo: &str) -> String {
    if let Some((name, _)) = metadata {
        if !name.is_empty() {
            let id = name.to_lowercase().replace(
                |c: char| !c.is_ascii_alphanumeric() && c != '/' && c != '-',
                "-",
            );
            let id = collapse_dashes(&id);
            let id = id.trim_matches('-').to_string();
            if !id.is_empty() {
                return id;
            }
        }
    }
    let fallback = repo
        .to_lowercase()
        .replace(|c: char| !c.is_ascii_alphanumeric(), "-");
    collapse_dashes(&fallback).trim_matches('-').to_string()
}

/// Replace runs of consecutive `-` with a single `-` (mirrors `/-+/g`).
fn collapse_dashes(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut prev_dash = false;
    for ch in input.chars() {
        if ch == '-' {
            if !prev_dash {
                result.push(ch);
            }
            prev_dash = true;
        } else {
            result.push(ch);
            prev_dash = false;
        }
    }
    result
}

/// Discover all skill source directories inside `base_dir`.
/// - If `baseDir` itself contains a `SKILL.md`, it is treated as a single skill.
/// - Otherwise every immediate sub-directory that contains a `SKILL.md` is
///   collected (supports multi-skill repositories).
fn discover_skill_dirs(base_dir: &Path) -> Vec<PathBuf> {
    if base_dir.join(SKILL_FILE_NAME).exists() {
        return vec![base_dir.to_path_buf()];
    }
    let Ok(entries) = fs::read_dir(base_dir) else {
        return Vec::new();
    };
    let mut skill_dirs = Vec::new();
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_dir() && entry.path().join(SKILL_FILE_NAME).exists() {
            skill_dirs.push(entry.path());
        }
    }
    skill_dirs
}

/// 已下载并解压完成的技能源码；临时目录随结构体一起释放。
struct PreparedSources {
    tmp_dir: PathBuf,
    parsed: ParsedGitHubUrl,
    sha_info: ShaInfo,
    raw_url: String,
    location: String,
    target: SkillInstallTarget,
    skills: Vec<PreparedSkillSource>,
}

impl Drop for PreparedSources {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.tmp_dir);
    }
}

/// 仓库中发现的单个技能源码目录（位于临时目录内）。
struct PreparedSkillSource {
    source_dir: PathBuf,
    sub_dir_override: Option<String>,
}

/// 准备阶段的结果：可以开始安装，或直接返回失败结果（URL 非法、子目录不存在、
/// 仓库内没有 SKILL.md）。
enum PrepareOutcome {
    Ready(Box<PreparedSources>),
    Rejected(SkillBatchInstallResult),
}

/// 安装（或重装）GitHub 上的技能：先在本地下载解压，再按解析出的目标位置落到
/// 本地技能目录，或经 Electron 的 SSH 通道上传到远程工作区。
pub(crate) async fn install_skills_from_github(
    raw_url: String,
    location: String,
    target: SkillInstallTarget,
) -> napi::Result<SkillBatchInstallResult> {
    let outcome =
        tokio::task::spawn_blocking(move || prepare_skill_sources(raw_url, location, target))
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Install skill task failed: {error}"),
                )
            })??;

    let sources = match outcome {
        PrepareOutcome::Ready(sources) => sources,
        PrepareOutcome::Rejected(result) => return Ok(result),
    };

    let mut results = Vec::with_capacity(sources.skills.len());
    for skill in &sources.skills {
        match install_prepared_skill(&sources, skill).await {
            Ok(result) => results.push(result),
            Err(error) => results.push(SkillInstallResult {
                success: false,
                skill_id: String::new(),
                path: String::new(),
                installed_at: chrono::Utc::now().to_rfc3339(),
                commit_sha: None,
                error: Some(format!("Failed to install skill: {error}")),
            }),
        }
    }

    let installed_count = results.iter().filter(|result| result.success).count() as i64;
    Ok(SkillBatchInstallResult {
        success: installed_count > 0,
        results,
        installed_count,
        total_count: sources.skills.len() as i64,
        commit_sha: commit_sha_opt(&sources.sha_info.sha),
        error: None,
    })
}

/// 下载仓库归档、解压并发现全部技能目录。下载失败与「仓库里没有技能」都通过
/// `PrepareOutcome::Rejected` 返回；临时目录由本函数负责清理。
fn prepare_skill_sources(
    raw_url: String,
    location: String,
    target: SkillInstallTarget,
) -> napi::Result<PrepareOutcome> {
    let parsed = match parse_github_url(&raw_url) {
        Some(parsed) => parsed,
        None => {
            return Ok(PrepareOutcome::Rejected(rejected_batch_result(
                format!("Invalid GitHub URL: {raw_url}"),
                None,
            )))
        }
    };

    // 无法解析 commit SHA（GitHub API 不可用 / 被限流）时降级：按 ref 名下载归档，
    // 注册记录里的 commit_sha 留空。
    let sha_info = match resolve_commit_sha(&parsed) {
        Ok(info) => info,
        Err(_) => ShaInfo {
            sha: String::new(),
            r#ref: parsed.r#ref.clone().unwrap_or_else(|| "HEAD".to_string()),
        },
    };

    let tmp_dir = std::env::temp_dir().join(format!(
        "snow-skill-{}",
        chrono::Utc::now().timestamp_millis()
    ));
    fs::create_dir_all(&tmp_dir).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create temp directory: {error}"),
        )
    })?;

    let outcome =
        collect_prepared_sources(tmp_dir.clone(), parsed, sha_info, raw_url, location, target);
    match outcome {
        // 成功时临时目录的所有权移交给 PreparedSources，安装结束后由 Drop 清理。
        Ok(PrepareOutcome::Ready(sources)) => Ok(PrepareOutcome::Ready(sources)),
        Ok(rejected) => {
            let _ = fs::remove_dir_all(&tmp_dir);
            Ok(rejected)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&tmp_dir);
            Err(error)
        }
    }
}

fn collect_prepared_sources(
    tmp_dir: PathBuf,
    parsed: ParsedGitHubUrl,
    sha_info: ShaInfo,
    raw_url: String,
    location: String,
    target: SkillInstallTarget,
) -> napi::Result<PrepareOutcome> {
    download_and_extract(&parsed, &sha_info.r#ref, &tmp_dir)?;

    let base_dir = match &parsed.sub_dir {
        Some(sub_dir) => tmp_dir.join(sub_dir),
        None => tmp_dir.clone(),
    };
    if !base_dir.exists() {
        return Ok(PrepareOutcome::Rejected(rejected_batch_result(
            format!(
                "Directory \"{}\" not found in repository {}/{}. Make sure the path is correct.",
                parsed.sub_dir.as_deref().unwrap_or(""),
                parsed.owner,
                parsed.repo
            ),
            commit_sha_opt(&sha_info.sha),
        )));
    }

    let skill_dirs = discover_skill_dirs(&base_dir);
    if skill_dirs.is_empty() {
        return Ok(PrepareOutcome::Rejected(rejected_batch_result(
            format!(
                "SKILL.md not found in repository {}/{}{}. Make sure the repository contains a SKILL.md file (either at the root or inside a sub-directory).",
                parsed.owner,
                parsed.repo,
                parsed
                    .sub_dir
                    .as_deref()
                    .map(|sub_dir| format!("/{sub_dir}"))
                    .unwrap_or_default()
            ),
            commit_sha_opt(&sha_info.sha),
        )));
    }

    let skills = skill_dirs
        .into_iter()
        .map(|source_dir| {
            let sub_dir_override = if source_dir == base_dir {
                parsed.sub_dir.clone()
            } else {
                let skill_dir_name = source_dir
                    .strip_prefix(&base_dir)
                    .unwrap_or(&source_dir)
                    .to_string_lossy()
                    .to_string();
                Some(match &parsed.sub_dir {
                    Some(sub_dir) => format!("{sub_dir}/{skill_dir_name}"),
                    None => skill_dir_name,
                })
            };
            PreparedSkillSource {
                source_dir,
                sub_dir_override,
            }
        })
        .collect();

    Ok(PrepareOutcome::Ready(Box::new(PreparedSources {
        tmp_dir,
        parsed,
        sha_info,
        raw_url,
        location,
        target,
        skills,
    })))
}

/// 安装单个已准备好的技能目录：本地走「暂存 + 原子替换」，远程走 SSH 上传。
async fn install_prepared_skill(
    sources: &PreparedSources,
    skill: &PreparedSkillSource,
) -> napi::Result<SkillInstallResult> {
    let metadata = read_skill_metadata(&skill.source_dir);
    let skill_id = derive_skill_id(&metadata, &sources.parsed.repo);
    let installed_at = chrono::Utc::now().to_rfc3339();
    let commit_sha = commit_sha_opt(&sources.sha_info.sha);
    let record = InstalledSkillRecord {
        id: skill_id.clone(),
        name: metadata
            .as_ref()
            .map(|(name, _)| name.clone())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| skill_id.clone()),
        description: metadata
            .as_ref()
            .map(|(_, description)| description.clone())
            .unwrap_or_default(),
        location: sources.location.clone(),
        source_url: sources.raw_url.clone(),
        github: ParsedGitHubUrl {
            owner: sources.parsed.owner.clone(),
            repo: sources.parsed.repo.clone(),
            r#ref: sources.parsed.r#ref.clone(),
            sub_dir: skill
                .sub_dir_override
                .clone()
                .or_else(|| sources.parsed.sub_dir.clone()),
        },
        installed_at: installed_at.clone(),
        commit_sha: commit_sha.clone(),
    };

    let installed_path = match skill_destination(&sources.target, &skill_id) {
        SkillDestination::Local(destination) => {
            commit_local_skill_dir(skill.source_dir.clone(), destination, record).await?
        }
        SkillDestination::Remote(destination) => {
            let workspace = sources.target.remote_workspace().ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "Remote Skill destination requires an SSH workspace".to_string(),
                )
            })?;
            install_remote_skill_dir(workspace, &destination, &skill.source_dir).await?;
            if let Err(error) = write_skill_record(record).await {
                // 注册表写失败时撤回刚上传的技能目录，避免留下未登记的技能。
                let _ = remove_remote_skill_dir(workspace, &destination).await;
                return Err(error);
            }
            destination
        }
    };

    Ok(SkillInstallResult {
        success: true,
        skill_id,
        path: installed_path,
        installed_at,
        commit_sha,
        error: None,
    })
}

/// 本地安装：暂存 + 原子替换；注册表写失败时回滚到安装前的目录。
async fn commit_local_skill_dir(
    source_dir: PathBuf,
    destination: PathBuf,
    record: InstalledSkillRecord,
) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        let mut commit = DirectoryCommit::prepare(&source_dir, destination.clone())?;
        commit.commit()?;
        if let Err(error) = upsert_record_at(record, &get_registry_path()) {
            let rollback = commit.rollback();
            commit.cleanup();
            return match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(Error::new(
                    Status::GenericFailure,
                    format!("Failed to update Skill registry: {error}. {rollback_error}"),
                )),
            };
        }
        commit.cleanup();
        Ok(destination.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Install skill task failed: {error}"),
        )
    })?
}

/// 写入技能注册记录（本地文件读写放到阻塞池）。
async fn write_skill_record(record: InstalledSkillRecord) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || upsert_record_at(record, &get_registry_path()))
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to update Skill registry: {error}"),
            )
        })?
}

/// 准备阶段直接失败时的批量结果。
fn rejected_batch_result(error: String, commit_sha: Option<String>) -> SkillBatchInstallResult {
    SkillBatchInstallResult {
        success: false,
        results: Vec::new(),
        installed_count: 0,
        total_count: 0,
        commit_sha,
        error: Some(error),
    }
}
