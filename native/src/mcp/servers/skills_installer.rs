use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use napi::{Error, Status};
use napi_derive::napi;
use serde::{Deserialize, Serialize};

use super::skills::{parse_skill_metadata_for_install, SKILL_FILE_NAME};

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

/// Parse a GitHub URL into its components.
///
/// Supported formats:
///  - https://github.com/owner/repo
///  - https://github.com/owner/repo/tree/branch
///  - https://github.com/owner/repo/tree/branch/sub/dir
///  - https://github.com/owner/repo.git
///  - owner/repo
///  - owner/repo@branch
///  - owner/repo@branch:sub/dir
pub fn parse_github_url(input: &str) -> Option<ParsedGitHubUrl> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut working = trimmed.to_string();
    // Strip trailing slash / .git
    if working.ends_with(".git") {
        working = working[..working.len() - 4].to_string();
    }
    while working.ends_with('/') {
        working.pop();
    }

    // Full https / http URL
    // https://github.com/owner/repo/tree/branch/sub/dir
    let url_re =
        regex::Regex::new(r"(?i)^https?://github\.com/([^/]+)/([^/]+)(?:/tree/([^/]+)(/.*)?)?$")
            .ok()?;
    if let Some(caps) = url_re.captures(&working) {
        let owner = caps.get(1)?.as_str().to_string();
        let repo = caps.get(2)?.as_str().to_string();
        let r#ref = caps.get(3).map(|m| m.as_str().to_string());
        let sub_dir = caps.get(4).map(|m| {
            let s = m.as_str();
            // strip leading/trailing slashes
            let s = s.trim_start_matches('/').trim_end_matches('/');
            s.to_string()
        });
        return Some(ParsedGitHubUrl {
            owner,
            repo,
            r#ref: r#ref.filter(|r| !r.is_empty()),
            sub_dir: sub_dir.filter(|s| !s.is_empty()),
        });
    }

    // Shorthand: owner/repo  or  owner/repo@ref  or  owner/repo@ref:sub/dir
    let shorthand_re = regex::Regex::new(r"^([^/\s@]+)/([^/\s@]+)(?:@([^:]+))?(?::(.+))?$").ok()?;
    if let Some(caps) = shorthand_re.captures(&working) {
        let owner = caps.get(1)?.as_str().to_string();
        let repo = caps.get(2)?.as_str().to_string();
        let r#ref = caps.get(3).map(|m| m.as_str().to_string());
        let sub_dir = caps.get(4).map(|m| m.as_str().to_string());
        return Some(ParsedGitHubUrl {
            owner,
            repo,
            r#ref: r#ref.filter(|r| !r.is_empty()),
            sub_dir: sub_dir.filter(|s| !s.is_empty()),
        });
    }

    None
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
// Skill directory helpers
// ---------------------------------------------------------------------------

fn get_skill_directory(skill_id: &str, location: &str, project_root: Option<&Path>) -> PathBuf {
    let segments: Vec<String> = skill_id
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    match location {
        "project" => {
            let root = project_root
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
            let mut path = root.join(".snow").join("skills");
            for seg in &segments {
                path.push(seg);
            }
            path
        }
        _ => {
            let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
            let mut path = home.join(".snow").join("skills");
            for seg in &segments {
                path.push(seg);
            }
            path
        }
    }
}

// ---------------------------------------------------------------------------
// GitHub API + download
// ---------------------------------------------------------------------------

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
    let mut builder =
        reqwest::blocking::Client::builder().user_agent(crate::api::http_client::app_user_agent());
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

fn remove_dir_if_exists(dir: &Path) -> napi::Result<()> {
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

/// Install a single skill from an already-extracted source directory.
fn install_single_skill_from_dir(
    skill_source_dir: &Path,
    parsed: &ParsedGitHubUrl,
    sha_info: &ShaInfo,
    location: &str,
    project_root: Option<&Path>,
    raw_url: &str,
    sub_dir_override: Option<&str>,
) -> napi::Result<SkillInstallResult> {
    install_single_skill_from_dir_with_registry(
        skill_source_dir,
        parsed,
        sha_info,
        location,
        project_root,
        raw_url,
        sub_dir_override,
        &get_registry_path(),
    )
}

fn install_single_skill_from_dir_with_registry(
    skill_source_dir: &Path,
    parsed: &ParsedGitHubUrl,
    sha_info: &ShaInfo,
    location: &str,
    project_root: Option<&Path>,
    raw_url: &str,
    sub_dir_override: Option<&str>,
    registry_path: &Path,
) -> napi::Result<SkillInstallResult> {
    let metadata = read_skill_metadata(skill_source_dir);
    let skill_id = derive_skill_id(&metadata, &parsed.repo);

    let dest_dir = get_skill_directory(&skill_id, location, project_root);
    let mut directory_commit = DirectoryCommit::prepare(skill_source_dir, dest_dir.clone())?;
    directory_commit.commit()?;

    let installed_at = chrono::Utc::now().to_rfc3339();
    let record = InstalledSkillRecord {
        id: skill_id.clone(),
        name: metadata
            .as_ref()
            .map(|(n, _)| n.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| skill_id.clone()),
        description: metadata
            .as_ref()
            .map(|(_, d)| d.clone())
            .unwrap_or_default(),
        location: location.to_string(),
        source_url: raw_url.to_string(),
        github: ParsedGitHubUrl {
            owner: parsed.owner.clone(),
            repo: parsed.repo.clone(),
            r#ref: parsed.r#ref.clone(),
            sub_dir: sub_dir_override
                .map(|s| s.to_string())
                .or_else(|| parsed.sub_dir.clone()),
        },
        installed_at: installed_at.clone(),
        commit_sha: commit_sha_opt(&sha_info.sha),
    };
    if let Err(error) = upsert_record_at(record, registry_path) {
        if let Err(rollback_error) = directory_commit.rollback() {
            directory_commit.cleanup();
            return Err(Error::new(
                Status::GenericFailure,
                format!("Failed to update Skill registry: {error}. {rollback_error}"),
            ));
        }
        directory_commit.cleanup();
        return Err(error);
    }
    directory_commit.cleanup();

    Ok(SkillInstallResult {
        success: true,
        skill_id,
        path: dest_dir.to_string_lossy().into_owned(),
        installed_at,
        commit_sha: commit_sha_opt(&sha_info.sha),
        error: None,
    })
}

/// Core install routine (blocking). Resolves the commit, downloads the
/// tarball, discovers skill directories, and installs each one.
fn install_skill_from_github_blocking(
    raw_url: String,
    location: String,
    project_root: Option<PathBuf>,
) -> napi::Result<SkillBatchInstallResult> {
    let parsed = match parse_github_url(&raw_url) {
        Some(p) => p,
        None => {
            return Ok(SkillBatchInstallResult {
                success: false,
                results: Vec::new(),
                installed_count: 0,
                total_count: 0,
                commit_sha: None,
                error: Some(format!("Invalid GitHub URL: {raw_url}")),
            });
        }
    };

    // 1. Resolve commit SHA. When the GitHub API is unavailable or
    // rate-limited (e.g. no gh login / GITHUB_TOKEN), degrade gracefully:
    // download the requested ref (or `HEAD` = default branch) from codeload
    // and leave commit_sha empty in the registry.
    let sha_info = match resolve_commit_sha(&parsed) {
        Ok(info) => info,
        Err(_) => ShaInfo {
            sha: String::new(),
            r#ref: parsed.r#ref.clone().unwrap_or_else(|| "HEAD".to_string()),
        },
    };

    // 2. Create temp directory
    let tmp_dir = std::env::temp_dir().join(format!(
        "snow-skill-{}",
        chrono::Utc::now().timestamp_millis()
    ));
    fs::create_dir_all(&tmp_dir).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create temp directory: {e}"),
        )
    })?;

    let result = (|| {
        // 3. Download + extract
        download_and_extract(&parsed, &sha_info.r#ref, &tmp_dir)?;

        // 4. Determine the base search directory (apply subDir if present)
        let base_dir = match &parsed.sub_dir {
            Some(sub) => tmp_dir.join(sub),
            None => tmp_dir.clone(),
        };
        if !base_dir.exists() {
            return Ok(SkillBatchInstallResult {
                success: false,
                results: Vec::new(),
                installed_count: 0,
                total_count: 0,
                commit_sha: commit_sha_opt(&sha_info.sha),
                error: Some(format!(
                    "Directory \"{}\" not found in repository {}/{}. Make sure the path is correct.",
                    parsed.sub_dir.as_deref().unwrap_or(""),
                    parsed.owner,
                    parsed.repo
                )),
            });
        }

        // 5. Discover all skill directories
        let skill_dirs = discover_skill_dirs(&base_dir);
        if skill_dirs.is_empty() {
            return Ok(SkillBatchInstallResult {
                success: false,
                results: Vec::new(),
                installed_count: 0,
                total_count: 0,
                commit_sha: commit_sha_opt(&sha_info.sha),
                error: Some(format!(
                    "SKILL.md not found in repository {}/{}{}. Make sure the repository contains a SKILL.md file (either at the root or inside a sub-directory).",
                    parsed.owner,
                    parsed.repo,
                    parsed.sub_dir.as_deref().map(|s| format!("/{s}")).unwrap_or_default()
                )),
            });
        }

        // 6. Install each discovered skill
        let mut results: Vec<SkillInstallResult> = Vec::new();
        for skill_source_dir in &skill_dirs {
            let sub_dir_override: Option<String> = if *skill_source_dir != base_dir {
                let skill_dir_name = skill_source_dir
                    .strip_prefix(&base_dir)
                    .unwrap_or(skill_source_dir)
                    .to_string_lossy()
                    .to_string();
                Some(match &parsed.sub_dir {
                    Some(sub) => format!("{sub}/{skill_dir_name}"),
                    None => skill_dir_name,
                })
            } else {
                parsed.sub_dir.clone()
            };
            match install_single_skill_from_dir(
                skill_source_dir,
                &parsed,
                &sha_info,
                &location,
                project_root.as_deref(),
                &raw_url,
                sub_dir_override.as_deref(),
            ) {
                Ok(r) => results.push(r),
                Err(e) => {
                    results.push(SkillInstallResult {
                        success: false,
                        skill_id: String::new(),
                        path: String::new(),
                        installed_at: chrono::Utc::now().to_rfc3339(),
                        commit_sha: None,
                        error: Some(format!("Failed to install skill: {e}")),
                    });
                }
            }
        }

        let installed_count = results.iter().filter(|r| r.success).count() as i64;
        Ok(SkillBatchInstallResult {
            success: installed_count > 0,
            results,
            installed_count,
            total_count: skill_dirs.len() as i64,
            commit_sha: commit_sha_opt(&sha_info.sha),
            error: None,
        })
    })();

    // Clean up temp directory
    let _ = fs::remove_dir_all(&tmp_dir);

    result
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
    let project_root = match project_id.as_deref() {
        Some(pid) => resolve_project_root(pid)?,
        None => None,
    };
    let location = location;
    tokio::task::spawn_blocking(move || {
        install_skill_from_github_blocking(url, location, project_root)
    })
    .await
    .map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Install skill task failed: {e}"),
        )
    })?
}

/// Uninstall a skill that was installed from GitHub.
#[napi]
pub async fn uninstall_github_skill(
    skill_id: String,
    project_id: Option<String>,
) -> napi::Result<SkillUninstallResult> {
    let skill_id_inner = skill_id.clone();
    let project_root = match project_id.as_deref() {
        Some(pid) => resolve_project_root(pid)?,
        None => None,
    };
    tokio::task::spawn_blocking(move || {
        let records = load_installed_skills();
        let record = records.into_iter().find(|r| r.id == skill_id_inner);
        let Some(record) = record else {
            return Ok(SkillUninstallResult {
                success: false,
                skill_id: skill_id_inner.clone(),
                message: format!("Skill \"{skill_id_inner}\" is not installed from GitHub"),
                error: None,
            });
        };

        let skill_dir = get_skill_directory(&record.id, &record.location, project_root.as_deref());
        remove_dir_if_exists(&skill_dir)?;
        remove_record(&record.id, &record.location)?;

        Ok(SkillUninstallResult {
            success: true,
            skill_id: record.id.clone(),
            message: format!("Skill \"{}\" uninstalled", record.id),
            error: None,
        })
    })
    .await
    .map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Uninstall skill task failed: {e}"),
        )
    })?
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

/// Resolve a project's workspace directory path from its id.
fn resolve_project_root(project_id: &str) -> napi::Result<Option<PathBuf>> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    let project_path =
        crate::storage::services::workspace_directories::get_workspace_directory_path(
            &database_path,
            project_id,
        )?;
    Ok(project_path.map(PathBuf::from))
}
