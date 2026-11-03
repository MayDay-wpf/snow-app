use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::{is_git_repo, run_git};
use crate::storage::{database, services::workspace_directories};

#[napi(object)]
#[derive(Clone)]
pub struct GitWorktreeInfo {
    pub worktree_id: String,
    pub directory_id: String,
    pub repository_path: String,
    pub worktree_path: String,
    pub branch_name: Option<String>,
    pub head_oid: String,
    pub is_detached: bool,
    pub is_dirty: bool,
    pub is_valid: bool,
}

struct GitWorktreeEntry {
    path: String,
    head: String,
    branch: Option<String>,
    detached: bool,
}

fn project_repository(database_path: &Path, directory_id: &str) -> Result<String> {
    let kind = workspace_directories::get_workspace_directory_kind(database_path, directory_id)?;
    if kind.as_deref() != Some("local") {
        return Err(Error::from_reason("Worktrees are only supported for local Git projects"));
    }
    let path = workspace_directories::get_workspace_directory_path(database_path, directory_id)?
        .ok_or_else(|| Error::from_reason("Workspace directory was not found"))?;
    if !is_git_repo(&path) {
        return Err(Error::from_reason("Workspace directory is not a valid Git repository"));
    }
    Ok(path)
}

fn list_git_worktree_entries(repository_path: &str) -> Result<Vec<GitWorktreeEntry>> {
    let output = run_git(repository_path, &["worktree", "list", "--porcelain"])?;
    let mut entries = Vec::new();
    let mut path: Option<String> = None;
    let mut head = String::new();
    let mut branch = None;
    let mut detached = false;

    let flush = |entries: &mut Vec<GitWorktreeEntry>, path: &mut Option<String>, head: &mut String, branch: &mut Option<String>, detached: &mut bool| {
        if let Some(path) = path.take() {
            entries.push(GitWorktreeEntry {
                path,
                head: std::mem::take(head),
                branch: branch.take(),
                detached: std::mem::replace(detached, false),
            });
        }
    };

    for line in output.lines() {
        if line.is_empty() {
            flush(&mut entries, &mut path, &mut head, &mut branch, &mut detached);
        } else if let Some(value) = line.strip_prefix("worktree ") {
            flush(&mut entries, &mut path, &mut head, &mut branch, &mut detached);
            path = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            head = value.to_string();
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = value.strip_prefix("refs/heads/").map(str::to_string);
        } else if line == "detached" {
            detached = true;
        }
    }
    flush(&mut entries, &mut path, &mut head, &mut branch, &mut detached);
    Ok(entries)
}

fn is_team_worktree(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let components: Vec<&str> = normalized.split('/').collect();
    components
        .windows(2)
        .any(|pair| pair[0] == ".snow" && pair[1] == "team-worktree")
}

fn inspect_entry(repository_path: &str, directory_id: &str, entry: GitWorktreeEntry, worktree_id: String) -> Result<GitWorktreeInfo> {
    let top_level = run_git(&entry.path, &["rev-parse", "--show-toplevel"])?;
    if canonical(top_level.trim()) != canonical(&entry.path) {
        return Err(Error::from_reason("Git worktree path does not match the registered worktree"));
    }
    let head_oid = run_git(&entry.path, &["rev-parse", "HEAD"])?.trim().to_string();
    let status = run_git(&entry.path, &["status", "--porcelain", "--untracked-files=normal"])?;
    Ok(GitWorktreeInfo {
        worktree_id,
        directory_id: directory_id.to_string(),
        repository_path: canonical(repository_path),
        worktree_path: canonical(&entry.path),
        branch_name: entry.branch,
        head_oid,
        is_detached: entry.detached,
        is_dirty: !status.trim().is_empty(),
        is_valid: true,
    })
}

fn persist_entry(database_path: &Path, directory_id: &str, info: &GitWorktreeInfo) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO git_worktrees (worktree_id, directory_id, repository_path, worktree_path, branch_name, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', 'localtime'))
                 ON CONFLICT(directory_id, worktree_path) DO UPDATE SET
                   repository_path = excluded.repository_path,
                   branch_name = excluded.branch_name,
                   updated_at = excluded.updated_at",
                params![info.worktree_id, directory_id, info.repository_path, info.worktree_path, info.branch_name],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "register git worktree", error))
}

fn saved_id(database_path: &Path, directory_id: &str, worktree_path: &str) -> Result<Option<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.query_row(
                "SELECT worktree_id FROM git_worktrees WHERE directory_id = ?1 AND worktree_path = ?2",
                params![directory_id, worktree_path],
                |row| row.get(0),
            ).optional()
        })
        .map_err(|error| database::database_error(database_path, "find git worktree", error))
}

fn canonical(path: &str) -> String {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path)).to_string_lossy().into_owned()
}

/// 清除目录已删除但 git 仍保留的工作树登记（git worktree prune）。
pub fn prune_worktree_registry(repository_path: &str) -> Result<()> {
    run_git(repository_path, &["worktree", "prune"]).map(|_| ())
}

pub fn list_worktrees(database_path: &Path, directory_id: &str) -> Result<Vec<GitWorktreeInfo>> {
    let repository_path = project_repository(database_path, directory_id)?;
    prune_worktree_registry(&repository_path)?;
    let entries = list_git_worktree_entries(&repository_path)?;
    let mut actual_paths = Vec::new();
    let mut result = Vec::new();
    for entry in entries {
        if is_team_worktree(&entry.path) || canonical(&entry.path) == canonical(&repository_path) {
            continue;
        }
        let path = canonical(&entry.path);
        actual_paths.push(path.clone());
        let worktree_id = saved_id(database_path, directory_id, &path)?
            .unwrap_or_else(crate::storage::database::create_snowflake_id);
        let info = if is_git_repo(&entry.path) {
            inspect_entry(&repository_path, directory_id, entry, worktree_id)?
        } else {
            GitWorktreeInfo {
                worktree_id,
                directory_id: directory_id.to_string(),
                repository_path: canonical(&repository_path),
                worktree_path: path.clone(),
                branch_name: entry.branch,
                head_oid: entry.head,
                is_detached: entry.detached,
                is_dirty: false,
                is_valid: false,
            }
        };
        persist_entry(database_path, directory_id, &info)?;
        let mut info = info;
        info.worktree_id = saved_id(database_path, directory_id, &path)?
            .ok_or_else(|| Error::from_reason("Persisted worktree registry entry could not be read back"))?;
        result.push(info);
    }

    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open worktree registry", error))?;
    let transaction = connection.transaction()
        .map_err(|error| database::database_error(database_path, "begin worktree reconciliation", error))?;
    let mut statement = transaction.prepare("SELECT worktree_id, worktree_path FROM git_worktrees WHERE directory_id = ?1")
        .map_err(|error| database::database_error(database_path, "query worktree registry", error))?;
    let saved: Vec<(String, String)> = statement.query_map([directory_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| database::database_error(database_path, "query worktree registry", error))?
        .collect::<rusqlite::Result<_>>()
        .map_err(|error| database::database_error(database_path, "read worktree registry", error))?;
    drop(statement);
    for (id, path) in saved {
        if !actual_paths.contains(&path) && !is_team_worktree(&path) {
            transaction.execute(
                "DELETE FROM conversation_worktree_bindings WHERE worktree_id = ?1",
                params![id],
            ).map_err(|error| database::database_error(database_path, "delete orphan worktree binding", error))?;
            transaction.execute(
                "DELETE FROM git_worktrees WHERE worktree_id = ?1",
                params![id],
            ).map_err(|error| database::database_error(database_path, "delete orphan worktree registry entry", error))?;
        }
    }
    transaction.commit().map_err(|error| database::database_error(database_path, "finish worktree reconciliation", error))?;
    Ok(result)
}

fn should_remove_created_branch(current_ref: Option<&str>, base_oid: &str, checked_out_elsewhere: bool) -> bool {
    !checked_out_elsewhere && current_ref == Some(base_oid)
}

fn should_delete_created_registry_entry(preexisting_worktree_id: Option<&str>) -> bool {
    preexisting_worktree_id.is_none()
}

fn delete_worktree_registry_entry(
    database_path: &Path,
    directory_id: &str,
    worktree_path: &str,
    created_worktree_id: &str,
) -> Result<()> {
    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open worktree registry for rollback", error))?;
    let transaction = connection.transaction()
        .map_err(|error| database::database_error(database_path, "begin worktree registry rollback", error))?;
    transaction.execute(
        "DELETE FROM git_worktrees WHERE directory_id = ?1 AND worktree_path = ?2 AND worktree_id = ?3",
        params![directory_id, worktree_path, created_worktree_id],
    ).map_err(|error| database::database_error(database_path, "delete rolled-back worktree registry entry", error))?;
    transaction.commit()
        .map_err(|error| database::database_error(database_path, "finish worktree registry rollback", error))
}

fn cleanup_empty_worktree_directories(target: &Path, manager_root: &Path) -> Vec<String> {
    let mut failures = Vec::new();
    match std::fs::remove_dir(target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {
            failures.push(format!("{}: rollback directory is not empty", target.display()));
            return failures;
        }
        Err(error) => {
            failures.push(format!("{}: {error}", target.display()));
            return failures;
        }
    }
    let mut current = target.parent();
    while let Some(path) = current {
        if !path.starts_with(manager_root) {
            break;
        }
        match std::fs::remove_dir(path) {
            Ok(()) => current = path.parent(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => current = path.parent(),
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => break,
            Err(error) => {
                failures.push(format!("{}: {error}", path.display()));
                break;
            }
        }
    }
    failures
}

pub fn create_worktree(database_path: &Path, directory_id: &str, branch_name: &str, base_ref: &str) -> Result<GitWorktreeInfo> {
    let repository_path = project_repository(database_path, directory_id)?;
    let branch_name = branch_name.trim();
    let base_ref = base_ref.trim();
    if branch_name.is_empty() || base_ref.is_empty() || branch_name.chars().any(char::is_control) || base_ref.chars().any(char::is_control) {
        return Err(Error::from_reason("Branch name and base ref must be non-empty and contain no control characters"));
    }
    run_git(&repository_path, &["check-ref-format", "--branch", branch_name])?;
    // Resolve the ref first, then pass only the object id to worktree add so
    // values beginning with '-' cannot be interpreted as Git options.
    let resolved_base = run_git(
        &repository_path,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{base_ref}^{{commit}}"),
        ],
    )?;
    let base_oid = resolved_base.trim();
    if base_oid.is_empty() {
        return Err(Error::from_reason("Base ref does not resolve to a commit"));
    }
    let entries = list_git_worktree_entries(&repository_path)?;
    if entries.iter().any(|entry| entry.branch.as_deref() == Some(branch_name)) {
        return Err(Error::from_reason(format!("Branch is already checked out in a worktree: {branch_name}")));
    }
    if run_git(&repository_path, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch_name}")]).is_ok() {
        return Err(Error::from_reason(format!("Branch already exists: {branch_name}")));
    }

    let repo = Path::new(&repository_path);
    let repo_root = std::fs::canonicalize(repo)
        .map_err(|error| Error::from_reason(format!("Failed to resolve repository path: {error}")))?;
    let parent = repo.parent().ok_or_else(|| Error::from_reason("Cannot determine repository parent directory"))?;
    let repo_name = repo.file_name().and_then(|name| name.to_str()).filter(|name| !name.is_empty())
        .ok_or_else(|| Error::from_reason("Cannot determine repository folder name"))?;
    // One stable, repository-external manager directory adjacent to the project.
    // Branch slashes become path separators (e.g. feature/x) but cannot escape it.
    let target = parent.join(".snowapp-worktrees").join(repo_name).join(branch_name);
    if target.exists() {
        return Err(Error::from_reason(format!("Worktree target already exists: {}", target.display())));
    }
    let target_string = target.to_string_lossy().into_owned();
    let target_registry_path = canonical(&target_string);
    let existing_worktree_id = saved_id(database_path, directory_id, &target_registry_path)?;
    if let Some(target_parent) = target.parent() {
        std::fs::create_dir_all(target_parent).map_err(|error| Error::from_reason(format!("Failed to create worktree manager directory: {error}")))?;
        let resolved_parent = std::fs::canonicalize(target_parent)
            .map_err(|error| Error::from_reason(format!("Failed to resolve worktree manager directory: {error}")))?;
        if resolved_parent.starts_with(&repo_root) {
            return Err(Error::from_reason("Worktree manager directory must remain outside the repository"));
        }
    }
    let created_worktree_id = crate::storage::database::create_snowflake_id();
    run_git(&repository_path, &["worktree", "add", "-b", branch_name, &target_string, base_oid])?;

    let manager_root = parent.join(".snowapp-worktrees");
    let creation_result: Result<GitWorktreeInfo> = (|| {
        let path = canonical(&target_string);
        let entry = list_git_worktree_entries(&repository_path)?.into_iter()
            .find(|entry| canonical(&entry.path) == path)
            .ok_or_else(|| Error::from_reason("Git created the worktree but it was not present in the repository worktree list"))?;
        let info = inspect_entry(&repository_path, directory_id, entry, created_worktree_id.clone())?;
        persist_entry(database_path, directory_id, &info)?;
        let mut info = info;
        info.worktree_id = saved_id(database_path, directory_id, &path)?
            .ok_or_else(|| Error::from_reason("Persisted worktree registry entry could not be read back"))?;
        Ok(info)
    })();

    match creation_result {
        Ok(info) => Ok(info),
        Err(original_error) => {
            let mut compensation_failures = Vec::new();
            let worktree_removed = match run_git(&repository_path, &["worktree", "remove", "--", &target_string]) {
                Ok(_) => true,
                Err(error) => {
                    compensation_failures.push(format!(
                        "worktree removal failed without force: {error}; preserved worktree contents and kept new branch '{branch_name}' because removal was not confirmed"
                    ));
                    false
                }
            };

            if worktree_removed {
                match list_git_worktree_entries(&repository_path) {
                    Ok(entries) => {
                        let checked_out_elsewhere = entries
                            .iter()
                            .any(|entry| entry.branch.as_deref() == Some(branch_name));
                        let current_ref = run_git(
                            &repository_path,
                            &[
                                "rev-parse",
                                "--verify",
                                "--end-of-options",
                                &format!("refs/heads/{branch_name}"),
                            ],
                        )
                        .ok()
                        .map(|oid| oid.trim().to_string());
                        if should_remove_created_branch(current_ref.as_deref(), base_oid, checked_out_elsewhere) {
                            if let Err(error) = run_git(&repository_path, &["branch", "-d", "--", branch_name]) {
                                compensation_failures.push(format!(
                                    "new branch '{branch_name}' was retained because safe branch deletion failed: {error}"
                                ));
                            }
                        } else if checked_out_elsewhere {
                            compensation_failures.push(format!(
                                "new branch '{branch_name}' was retained because another worktree still checks it out"
                            ));
                        } else if let Some(current_ref) = current_ref {
                            compensation_failures.push(format!(
                                "new branch '{branch_name}' was retained because its ref moved from base {base_oid} to {current_ref}"
                            ));
                        } else {
                            compensation_failures.push(format!(
                                "new branch '{branch_name}' was retained because its current ref could not be verified"
                            ));
                        }
                    }
                    Err(error) => compensation_failures.push(format!(
                        "new branch '{branch_name}' was retained because worktree checkouts could not be verified after removal: {error}"
                    )),
                }
            }

            if should_delete_created_registry_entry(existing_worktree_id.as_deref()) {
                if let Err(error) = delete_worktree_registry_entry(
                    database_path,
                    directory_id,
                    &target_registry_path,
                    &created_worktree_id,
                ) {
                    compensation_failures.push(format!("registry rollback failed: {error}"));
                }
            }
            compensation_failures.extend(
                cleanup_empty_worktree_directories(&target, &manager_root),
            );
            if compensation_failures.is_empty() {
                Err(Error::from_reason(format!("{original_error}; newly created worktree was rolled back")))
            } else {
                Err(Error::from_reason(format!("{original_error}; rollback was incomplete: {}", compensation_failures.join("; "))))
            }
        }
    }
}

pub fn remove_worktree(database_path: &Path, directory_id: &str, worktree_id: &str) -> Result<()> {
    let repository_path = project_repository(database_path, directory_id)?;
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                let mut connection = database::open_connection(database_path)?;
                let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let worktree = transaction.query_row(
                    "SELECT repository_path, worktree_path FROM git_worktrees WHERE worktree_id = ?1 AND directory_id = ?2",
                    params![worktree_id, directory_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                ).optional()?;
                let worktree = match worktree {
                    Some(w) => w,
                    None => return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                        Some("Worktree was not found in this project".to_string()),
                    )),
                };
                if canonical(&worktree.0) != canonical(&repository_path) {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                        Some("Worktree registry entry belongs to a different repository".to_string()),
                    ));
                }
                let registered_path = canonical(&worktree.1);
                if registered_path == canonical(&repository_path) {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                        Some("The main working tree cannot be removed".to_string()),
                    ));
                }
                if is_team_worktree(&registered_path) {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                        Some("Team worktrees cannot be removed here".to_string()),
                    ));
                }

                if Path::new(&registered_path).exists() {
                    let entry = list_git_worktree_entries(&repository_path)
                        .map_err(|err| rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some(err.to_string()),
                        ))?
                        .into_iter()
                        .find(|entry| canonical(&entry.path) == registered_path)
                        .ok_or_else(|| rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some("Registered path is not a worktree of this repository".to_string()),
                        ))?;
                    if !is_git_repo(&entry.path) {
                        return Err(rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some("Cannot remove an invalid or missing Git worktree".to_string()),
                        ));
                    }
                    let info = inspect_entry(&repository_path, directory_id, entry, worktree_id.to_string())
                        .map_err(|err| rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some(err.to_string()),
                        ))?;
                    if info.is_dirty {
                        return Err(rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some("Cannot remove a dirty worktree; commit or discard its changes first".to_string()),
                        ));
                    }
                    run_git(&repository_path, &["worktree", "remove", "--", &registered_path])
                        .map_err(|error| rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some(format!("Failed to remove Git worktree: {error}")),
                        ))?;
                }

                transaction.execute(
                    "DELETE FROM conversation_worktree_bindings WHERE worktree_id = ?1",
                    params![worktree_id],
                )?;
                transaction.execute(
                    "DELETE FROM git_worktrees WHERE worktree_id = ?1 AND directory_id = ?2",
                    params![worktree_id, directory_id],
                )?;
                transaction.commit()
            },
            "remove worktree",
        )
    })
    .map_err(|error| database::database_error(database_path, "remove worktree", error))
}

pub fn set_conversation_worktree(database_path: &Path, conversation_id: &str, worktree_id: Option<&str>) -> Result<()> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Err(Error::from_reason("Conversation id is required"));
    }
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                let mut connection = database::open_connection(database_path)?;
                let transaction = connection.transaction()?;
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM chat_conversations WHERE conversation_id = ?1)",
                    [conversation_id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                        Some("Conversation was not found in the active database".to_string()),
                    ));
                }
                if let Some(worktree_id) = worktree_id {
                    let worktree = transaction.query_row(
                        "SELECT w.directory_id, w.repository_path, w.worktree_path
                           FROM git_worktrees w
                           JOIN chat_conversations c ON c.directory_id = w.directory_id
                          WHERE w.worktree_id = ?1 AND c.conversation_id = ?2",
                        params![worktree_id, conversation_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
                    ).optional()?;
                    let (_directory_id, repository_path, worktree_path) = match worktree {
                        Some(w) => w,
                        None => return Err(rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some("Worktree was not found or belongs to another project".to_string()),
                        )),
                    };
                    let path_matches = list_git_worktree_entries(&repository_path)
                        .map(|entries| entries.into_iter().any(|entry| canonical(&entry.path) == canonical(&worktree_path)))
                        .unwrap_or(false);
                    if !path_matches || !is_git_repo(&worktree_path) {
                        return Err(rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some("Cannot bind an invalid or missing Git worktree".to_string()),
                        ));
                    }
                    transaction.execute(
                        "INSERT INTO conversation_worktree_bindings (conversation_id, worktree_id, updated_at) VALUES (?1, ?2, datetime('now', 'localtime'))
                         ON CONFLICT(conversation_id) DO UPDATE SET worktree_id = excluded.worktree_id, updated_at = excluded.updated_at",
                        params![conversation_id, worktree_id],
                    )?;
                } else {
                    transaction.execute(
                        "DELETE FROM conversation_worktree_bindings WHERE conversation_id = ?1",
                        [conversation_id],
                    )?;
                }
                transaction.commit()
            },
            "bind conversation worktree",
        )
    })
    .map_err(|error| database::database_error(database_path, "set conversation worktree", error))
}

pub fn get_conversation_worktree(database_path: &Path, conversation_id: &str) -> Result<Option<GitWorktreeInfo>> {
    let binding = database::open_connection(database_path)
        .and_then(|connection| {
            connection.query_row(
                "SELECT w.worktree_id, w.directory_id, w.repository_path, w.worktree_path, w.branch_name
                   FROM conversation_worktree_bindings b JOIN git_worktrees w ON w.worktree_id = b.worktree_id
                  WHERE b.conversation_id = ?1",
                [conversation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?)),
            ).optional()
        })
        .map_err(|error| database::database_error(database_path, "get conversation worktree", error))?;
    let Some((worktree_id, directory_id, repository_path, worktree_path, branch_name)) = binding else {
        return Ok(None);
    };
    let current = list_git_worktree_entries(&repository_path)
        .ok()
        .and_then(|entries| {
            entries
                .into_iter()
                .find(|entry| canonical(&entry.path) == canonical(&worktree_path))
        });
    let Some(entry) = current else {
        return Ok(Some(GitWorktreeInfo {
            worktree_id,
            directory_id,
            repository_path,
            worktree_path,
            branch_name,
            head_oid: String::new(),
            is_detached: false,
            is_dirty: false,
            is_valid: false,
        }));
    };
    if !is_git_repo(&entry.path) {
        return Ok(Some(GitWorktreeInfo {
            worktree_id,
            directory_id,
            repository_path: canonical(&repository_path),
            worktree_path: canonical(&entry.path),
            branch_name: entry.branch,
            head_oid: entry.head,
            is_detached: entry.detached,
            is_dirty: false,
            is_valid: false,
        }));
    }
    inspect_entry(&repository_path, &directory_id, entry, worktree_id).map(Some)
}

pub fn get_worktree_by_id(database_path: &Path, worktree_id: &str) -> Result<Option<GitWorktreeInfo>> {
    let binding = database::open_connection(database_path)
        .and_then(|connection| {
            connection.query_row(
                "SELECT w.worktree_id, w.directory_id, w.repository_path, w.worktree_path, w.branch_name
                   FROM git_worktrees w
                  WHERE w.worktree_id = ?1",
                [worktree_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?)),
            ).optional()
        })
        .map_err(|error| database::database_error(database_path, "get worktree by id", error))?;
    let Some((worktree_id, directory_id, repository_path, worktree_path, branch_name)) = binding else {
        return Ok(None);
    };
    let current = list_git_worktree_entries(&repository_path)
        .ok()
        .and_then(|entries| {
            entries
                .into_iter()
                .find(|entry| canonical(&entry.path) == canonical(&worktree_path))
        });
    let Some(entry) = current else {
        return Ok(Some(GitWorktreeInfo {
            worktree_id,
            directory_id,
            repository_path,
            worktree_path,
            branch_name,
            head_oid: String::new(),
            is_detached: false,
            is_dirty: false,
            is_valid: false,
        }));
    };
    if !is_git_repo(&entry.path) {
        return Ok(Some(GitWorktreeInfo {
            worktree_id,
            directory_id,
            repository_path: canonical(&repository_path),
            worktree_path: canonical(&entry.path),
            branch_name: entry.branch,
            head_oid: entry.head,
            is_detached: entry.detached,
            is_dirty: false,
            is_valid: false,
        }));
    }
    inspect_entry(&repository_path, &directory_id, entry, worktree_id).map(Some)
}
