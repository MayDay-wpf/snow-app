//! Fail-closed, read-only eligibility for already-indexed prompt sources.
//! Reads policy files along indexed paths, never scans the workspace or source bodies.
use super::{file_scanner, gitignore::GitignoreMatcher};
use napi::bindgen_prelude::*;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

fn denied() -> Error {
    Error::from_reason("context_source_policy_changed")
}
pub fn valid_relative(path: &str, directory: bool) -> bool {
    let clean = if directory {
        path.strip_suffix('/').unwrap_or(path)
    } else {
        path
    };
    !clean.is_empty()
        && clean.len() <= 512
        && !Path::new(clean).is_absolute()
        && !clean
            .chars()
            .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
        && clean.split('/').all(|s| {
            !s.is_empty() && s != "." && s != ".." && !s.ends_with(' ') && !s.ends_with('.')
        })
}
/// Shared path-segment matching: file exact match or directory descendants only.
pub fn matches_path(path: &str, prefix: &str) -> bool {
    let prefix = prefix.trim_end_matches('/');
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}
fn read_rule(path: &Path) -> Result<Option<String>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(denied()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
        return Err(denied());
    }
    let content = fs::read_to_string(path).map_err(|_| denied())?;
    if content.len() > 1024 * 1024 {
        return Err(denied());
    }
    Ok(Some(content))
}
fn base_matcher(root: &Path) -> Result<GitignoreMatcher> {
    let mut text = String::new();
    let mut ancestors: Vec<_> = root.ancestors().collect();
    ancestors.reverse();
    for parent in ancestors {
        if let Some(rule) = read_rule(&parent.join(".gitignore"))? {
            text.push_str(&rule);
            text.push('\n');
        }
    }
    // Match the existing host matcher precedence exactly.
    for rule in [root.join(".gitignore"), root.join(".git/info/exclude")] {
        if let Some(content) = read_rule(&rule)? {
            text.push_str(&content);
            text.push('\n');
        }
    }
    Ok(GitignoreMatcher::from_root_content(Some(&text)))
}
fn directories(relative: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut current = PathBuf::new();
    let pieces: Vec<_> = relative.split('/').collect();
    for part in pieces.iter().take(pieces.len().saturating_sub(1)) {
        current.push(part);
        dirs.push(current.clone());
    }
    dirs
}
pub fn eligible_source(root: &Path, relative: &str) -> Result<PathBuf> {
    if !valid_relative(relative, false) {
        return Err(denied());
    }
    let pieces: Vec<_> = relative.split('/').collect();
    if pieces.len() > 21
        || pieces
            .iter()
            .any(|name| name.starts_with('.') || file_scanner::SKIP_DIRS.contains(name))
    {
        return Err(denied());
    }
    let mut matcher = base_matcher(root)?;
    for dir in directories(relative) {
        let name = dir.to_string_lossy().replace('\\', "/");
        if matcher.is_ignored(&name, true) {
            return Err(denied());
        }
        if let Some(content) = read_rule(&root.join(&dir).join(".gitignore"))? {
            matcher.append_directory_content(&dir, &content);
        }
    }
    if matcher.is_ignored(relative, false) {
        return Err(denied());
    }
    let canonical = fs::canonicalize(root.join(relative)).map_err(|_| denied())?;
    if !canonical.starts_with(root) {
        return Err(denied());
    }
    // A symlink cannot use an allowed alias to bypass target-side exclusions.
    let target = canonical
        .strip_prefix(root)
        .map_err(|_| denied())?
        .to_string_lossy()
        .replace('\\', "/");
    if target != relative {
        if !valid_relative(&target, false)
            || target
                .split('/')
                .any(|p| p.starts_with('.') || file_scanner::SKIP_DIRS.contains(&p))
        {
            return Err(denied());
        }
        let mut target_matcher = base_matcher(root)?;
        for dir in directories(&target) {
            if target_matcher.is_ignored(&dir.to_string_lossy().replace('\\', "/"), true) {
                return Err(denied());
            }
            if let Some(content) = read_rule(&root.join(&dir).join(".gitignore"))? {
                target_matcher.append_directory_content(&dir, &content);
            }
        }
        if target_matcher.is_ignored(&target, false) {
            return Err(denied());
        }
    }
    let metadata = fs::metadata(&canonical).map_err(|_| denied())?;
    if !metadata.is_file()
        || metadata.len() > file_scanner::MAX_FILE_SIZE
        || file_scanner::is_likely_binary(&canonical)
    {
        return Err(denied());
    }
    for path in [root.join(relative), canonical.clone()] {
        let extension = file_scanner::get_extension(&path);
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(denied)?;
        if file_scanner::IMAGE_EXTENSIONS.contains(&extension.as_str())
            || file_scanner::BINARY_EXTENSIONS.contains(&extension.as_str())
            || (!file_scanner::TEXT_EXTENSIONS.contains(&extension.as_str())
                && !file_scanner::is_extensionless_text_file(name))
        {
            return Err(denied());
        }
    }
    Ok(canonical)
}
/// Fingerprints current rules for all indexed parent paths (including absent
/// rules), so adding a nested .gitignore invalidates old handles immediately.
pub fn fingerprint<'a>(
    root: &Path,
    paths: impl IntoIterator<Item = &'a str>,
) -> Result<String> {
    let mut rules = BTreeSet::new();
    for ancestor in root.ancestors() {
        rules.insert(ancestor.join(".gitignore"));
    }
    rules.insert(root.join(".git/info/exclude"));
    for name in ["AGENTS.md", "ROLE.md", "CLAUDE.md"] {
        rules.insert(root.join(name));
    }
    let paths: BTreeSet<_> = paths.into_iter().collect();
    for path in paths {
        if !valid_relative(path, false) {
            return Err(denied());
        }
        for dir in directories(path) {
            rules.insert(root.join(&dir).join(".gitignore"));
        }
        // Include policy ancestors of canonical symlink targets too.
        if let Ok(canonical) = fs::canonicalize(root.join(path)) {
            if let Ok(target) = canonical.strip_prefix(root) {
                let target = target.to_string_lossy().replace('\\', "/");
                for dir in directories(&target) {
                    rules.insert(root.join(dir).join(".gitignore"));
                }
            }
        }
        if rules.len() > 20000 {
            return Err(denied());
        }
    }
    let mut digest = blake3::Hasher::new();
    let mut bytes = 0;
    digest.update(
        serde_json::json!([
            file_scanner::SKIP_DIRS,
            file_scanner::TEXT_EXTENSIONS,
            file_scanner::BINARY_EXTENSIONS,
            file_scanner::IMAGE_EXTENSIONS,
            file_scanner::MAX_FILE_SIZE
        ])
        .to_string()
        .as_bytes(),
    );
    for rule in rules {
        digest.update(rule.to_string_lossy().as_bytes());
        match read_rule(&rule)? {
            Some(content) => {
                bytes += content.len();
                if bytes > 8 * 1024 * 1024 {
                    return Err(denied());
                }
                digest.update(b"present");
                digest.update(content.as_bytes());
            }
            None => {
                digest.update(b"absent");
            }
        }
    }
    Ok(digest.finalize().to_hex().to_string())
}
