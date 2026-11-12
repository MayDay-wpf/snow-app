use std::fs;
use std::path::Path;

use napi::bindgen_prelude::*;

use super::DirectoryEntry;

// Directories that are always skipped during traversal. These are build
// artifacts, dependency caches, VCS metadata, or IDE-local state.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "out",
    "coverage",
    ".cache",
    ".turbo",
    ".vercel",
    "target",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".tox",
    ".venv",
    "venv",
    "env",
    ".idea",
    ".vscode",
    ".gradle",
    ".terraform",
    "Pods",
    "DerivedData",
];

// Directories that start with a dot are usually hidden config dirs. Some of
// them (like `.github`, `.claude`, `.cursor`) may still contain content the
// user wants to search, so we keep an allowlist that overrides the dot-prefix
// skip rule for directories.
const DOTDIR_ALLOWLIST: &[&str] = &[
    "github",
    "claude",
    "cursor",
    "husky",
    "storybook",
    "devcontainer",
];

pub fn read_directory_entries(dir_path: &str) -> Result<Vec<DirectoryEntry>> {
    let path = Path::new(dir_path);

    if !path.exists() {
        return Err(Error::from_reason(format!(
            "Directory does not exist: {}",
            dir_path
        )));
    }

    if !path.is_dir() {
        return Err(Error::from_reason(format!(
            "Path is not a directory: {}",
            dir_path
        )));
    }

    let entries = fs::read_dir(path).map_err(|e| {
        Error::from_reason(format!("Failed to read directory '{}': {}", dir_path, e))
    })?;

    let mut result: Vec<DirectoryEntry> = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().to_string();

        let full_path = entry.path();
        let path_string = full_path.to_string_lossy().to_string();

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let is_directory = metadata.is_dir();
        // Lazy loading: don't read directory contents during listing.
        // Children are loaded on demand when the user expands the directory.
        let size = if is_directory {
            0
        } else {
            metadata.len() as i64
        };

        result.push(DirectoryEntry {
            name,
            path: path_string,
            is_directory,
            size,
        });
    }

    // Sort: directories first, then by name
    result.sort_by(|a, b| {
        if a.is_directory != b.is_directory {
            return if a.is_directory {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.name.cmp(&b.name)
    });

    Ok(result)
}

pub fn should_skip_dir(name: &str) -> bool {
    if SKIP_DIRS.contains(&name) {
        return true;
    }

    // Allow selected dot-directories through; skip all other dot-prefixed
    // directories to avoid scanning transient caches.
    if name.starts_with('.') {
        let stripped = &name[1..];
        return !DOTDIR_ALLOWLIST.contains(&stripped);
    }

    false
}
