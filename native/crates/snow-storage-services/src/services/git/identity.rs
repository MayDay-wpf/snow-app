use std::path::PathBuf;

use napi::bindgen_prelude::*;

use super::{discover_git_repos, is_git_repo, run_git_raw, GitIdentity};

fn resolve_repo_root(path: &str) -> String {
    let mut current = PathBuf::from(path);
    loop {
        if current.join(".git").exists() {
            return current.to_string_lossy().to_string();
        }
        if !current.pop() {
            break;
        }
    }
    discover_git_repos(path, 1, &[])
        .ok()
        .and_then(|repos| repos.into_iter().next())
        .map(|repo| repo.path)
        .unwrap_or_default()
}

pub fn get_git_identity(repo_path: &str) -> Result<GitIdentity> {
    let resolved = if is_git_repo(repo_path) {
        repo_path.to_string()
    } else {
        resolve_repo_root(repo_path)
    };
    if resolved.is_empty() {
        return Ok(GitIdentity {
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
    let has_identity = !name.is_empty() && !email.is_empty();
    Ok(GitIdentity {
        is_repo: true,
        repo_path: resolved,
        name,
        email,
        remote_url,
        has_identity,
        error: None,
    })
}
