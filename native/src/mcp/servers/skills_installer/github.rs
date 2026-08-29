use super::*;

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;

use napi::{Error, Status};

use super::super::skills::{parse_skill_metadata_for_install, SKILL_FILE_NAME};

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
pub(crate) fn install_skill_from_github_blocking(
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
