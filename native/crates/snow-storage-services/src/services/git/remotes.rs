use std::collections::HashMap;

use napi::bindgen_prelude::*;

use super::{is_git_repo, run_git, GitRemoteInfo};

/// 获取仓库配置的所有远程仓库（git remote -v）
pub fn get_git_remotes(repo_path: &str) -> Result<Vec<GitRemoteInfo>> {
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }

    let output = match run_git(repo_path, &["remote", "-v"]) {
        Ok(out) => out,
        Err(_) => return Ok(Vec::new()),
    };

    let mut remotes_map: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    let mut ordered_names: Vec<String> = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        let name = parts[0].to_string();
        let url = if parts.len() > 1 {
            Some(parts[1].to_string())
        } else {
            None
        };
        let kind = if parts.len() > 2 { parts[2] } else { "" };

        if !remotes_map.contains_key(&name) {
            ordered_names.push(name.clone());
            remotes_map.insert(name.clone(), (None, None));
        }

        if let Some(entry) = remotes_map.get_mut(&name) {
            if kind.contains("fetch") {
                entry.0 = url.clone();
            } else if kind.contains("push") {
                entry.1 = url.clone();
            } else {
                if entry.0.is_none() {
                    entry.0 = url.clone();
                }
                if entry.1.is_none() {
                    entry.1 = url;
                }
            }
        }
    }

    let mut result = Vec::new();
    for name in ordered_names {
        if let Some((fetch_url, push_url)) = remotes_map.remove(&name) {
            result.push(GitRemoteInfo {
                name,
                fetch_url: fetch_url.clone().or_else(|| push_url.clone()),
                push_url: push_url.or(fetch_url),
            });
        }
    }

    Ok(result)
}
