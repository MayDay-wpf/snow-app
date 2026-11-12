use std::fs;
use std::path::{Path, PathBuf};

/// A compiled .gitignore matcher that supports the most common gitignore
/// patterns: simple globs, directory-only patterns (trailing `/`), negation
/// (`!`), root-anchored patterns (leading `/`), and double-wildcards (`**`).
///
/// This is intentionally a lightweight implementation — it does not aim for
/// 100% git compatibility, but covers the patterns typically found in real
/// projects (node_modules, dist, *.log, .env, etc.).
///
/// Scope model: subdirectory `.gitignore` files are loaded via
/// `load_directory_gitignore` and their patterns are rewritten into
/// root-anchored form. Callers load parent directories before children so
/// that deeper rules override shallower ones (patterns are evaluated in
/// order), mirroring git's precedence.
#[derive(Debug, Clone)]
pub struct GitignoreMatcher {
    patterns: Vec<GitignorePattern>,
}

#[derive(Debug, Clone)]
struct GitignorePattern {
    negated: bool,
    dir_only: bool,
    anchored: bool,
    segments: Vec<String>,
}

/// A single parsed `.gitignore` line (before scope prefixing is applied).
struct ParsedPattern {
    negated: bool,
    dir_only: bool,
    anchored: bool,
    segments: Vec<String>,
}

impl GitignoreMatcher {
    /// Build a matcher from the root `.gitignore` content already fetched by
    /// the caller. Used by the remote (SSH) checkpoint flow where the file is
    /// read via SFTP instead of the local file system.
    pub fn from_root_content(root_gitignore: Option<&str>) -> Self {
        let mut patterns = Vec::new();
        if let Some(content) = root_gitignore {
            Self::parse_into(content, &mut patterns);
        }
        Self { patterns }
    }

    /// Build a matcher by reading `.gitignore` files from the given root
    /// directory and all of its parent directories (mirroring git behaviour
    /// where parent `.gitignore` files also apply), plus the repository-local
    /// `.git/info/exclude` file.
    pub fn from_project_root(root: &Path) -> Self {
        let mut patterns = Vec::new();

        // Walk up from root to collect parent .gitignore files.
        let mut ancestors: Vec<PathBuf> = root.ancestors().map(Path::to_path_buf).collect();
        ancestors.reverse(); // outermost first

        for ancestor in &ancestors {
            let gitignore = ancestor.join(".gitignore");
            if gitignore.is_file() {
                if let Ok(content) = fs::read_to_string(&gitignore) {
                    Self::parse_into(&content, &mut patterns);
                }
            }
        }

        // Also read root .gitignore again to ensure it takes precedence
        // (patterns are evaluated in order; later patterns win for negation).
        let root_gitignore = root.join(".gitignore");
        if root_gitignore.is_file() {
            if let Ok(content) = fs::read_to_string(&root_gitignore) {
                Self::parse_into(&content, &mut patterns);
            }
        }

        // Repository-local excludes (.git/info/exclude) apply with root scope.
        let info_exclude = root.join(".git").join("info").join("exclude");
        if info_exclude.is_file() {
            if let Ok(content) = fs::read_to_string(&info_exclude) {
                Self::parse_into(&content, &mut patterns);
            }
        }

        Self { patterns }
    }

    /// Load the `.gitignore` of a subdirectory and append its patterns with
    /// the directory as their scope.
    ///
    /// `root` is the project root (used to locate the `.gitignore` file on
    /// disk); `dir_relative` is the subdirectory **relative to the project
    /// root** (used to scope the patterns).
    ///
    /// Each pattern is rewritten into a root-anchored form so the flat
    /// `is_ignored(relative_path)` interface keeps working:
    /// - anchored patterns (`/build/`, `foo/bar`) become `<dir>/build/`
    /// - unanchored patterns (`*.log`, `dist/`) become `<dir>/**/...` so they
    ///   still match at any depth below the directory (git semantics)
    ///
    /// Callers must load a directory's rules **before** matching any path
    /// below it, and parent directories before children, so that deeper
    /// rules override shallower ones (patterns are evaluated in order).
    pub fn load_directory_gitignore(&mut self, root: &Path, dir_relative: &Path) {
        let gitignore_path = root.join(dir_relative).join(".gitignore");
        if !gitignore_path.is_file() {
            return;
        }
        let Ok(content) = fs::read_to_string(&gitignore_path) else {
            return;
        };
        self.append_directory_content(dir_relative, &content);
    }

    /// Append subdirectory `.gitignore` rules from already-fetched content
    /// (remote SSH flow: content arrives via SFTP). Scoping semantics are
    /// identical to `load_directory_gitignore`.
    pub fn append_directory_content(&mut self, dir_relative: &Path, content: &str) {
        let dir_rel = dir_relative.to_string_lossy().replace('\\', "/");
        let dir_segments: Vec<String> = dir_rel.split('/').map(String::from).collect();

        for line in content.lines() {
            let Some(parsed) = Self::parse_line(line) else {
                continue;
            };
            let mut segments = Vec::with_capacity(dir_segments.len() + 1 + parsed.segments.len());
            segments.extend(dir_segments.iter().cloned());
            if !parsed.anchored {
                // Unanchored: match at any depth below the directory, so
                // insert a `**` segment between the scope and the pattern.
                segments.push("**".to_string());
            }
            segments.extend(parsed.segments);
            self.patterns.push(GitignorePattern {
                negated: parsed.negated,
                dir_only: parsed.dir_only,
                anchored: true,
                segments,
            });
        }
    }

    /// Parse a single non-empty, non-comment `.gitignore` line.
    fn parse_line(line: &str) -> Option<ParsedPattern> {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }

        // Remove trailing whitespace and trailing backslash escapes
        let line = line.trim_end_matches('\\').trim_end();
        if line.is_empty() {
            return None;
        }

        let mut raw = line.to_string();
        let mut negated = false;
        let mut dir_only = false;
        let mut anchored = false;

        if raw.starts_with('!') {
            negated = true;
            raw = raw[1..].to_string();
        }

        if raw.ends_with('/') {
            dir_only = true;
            raw = raw.trim_end_matches('/').to_string();
        }

        if raw.starts_with('/') {
            anchored = true;
            raw = raw.trim_start_matches('/').to_string();
        }

        if raw.is_empty() {
            return None;
        }

        // If the pattern contains a `/` (other than leading), it is
        // implicitly anchored.
        if raw.contains('/') {
            anchored = true;
        }

        Some(ParsedPattern {
            negated,
            dir_only,
            anchored,
            segments: raw.split('/').map(String::from).collect(),
        })
    }

    fn parse_into(content: &str, patterns: &mut Vec<GitignorePattern>) {
        for line in content.lines() {
            let Some(parsed) = Self::parse_line(line) else {
                continue;
            };
            patterns.push(GitignorePattern {
                negated: parsed.negated,
                dir_only: parsed.dir_only,
                anchored: parsed.anchored,
                segments: parsed.segments,
            });
        }
    }

    /// Returns `true` if the given relative path should be ignored.
    ///
    /// `relative_path` should use forward slashes (`/`) as separators and
    /// be relative to the project root. `is_dir` indicates whether the path
    /// is a directory.
    pub fn is_ignored(&self, relative_path: &str, is_dir: bool) -> bool {
        let path_parts: Vec<&str> = relative_path.split('/').collect();
        let mut ignored = false;

        for pattern in &self.patterns {
            if pattern.dir_only && !is_dir {
                continue;
            }

            if Self::pattern_matches(pattern, &path_parts) {
                ignored = !pattern.negated;
            }
        }

        ignored
    }

    fn pattern_matches(pattern: &GitignorePattern, path_parts: &[&str]) -> bool {
        let seg_count = pattern.segments.len();
        let path_count = path_parts.len();

        if pattern.anchored {
            // Anchored: match from the root only. `**` matches zero or more
            // segments (git semantics), so no `seg_count > path_count` guard
            // here — the recursive matcher handles zero-length `**`; a
            // pattern that is a strict prefix of the path also matches
            // (directory-prefix semantics, e.g. `dist/` covers everything
            // under `dist/`).
            Self::anchored_match(&pattern.segments, path_parts, 0, 0)
        } else {
            // Non-anchored: match at any depth.
            // Try matching starting at each possible position.
            if seg_count > path_count {
                return false;
            }
            for start in 0..=(path_count - seg_count) {
                let mut all_match = true;
                for (i, seg) in pattern.segments.iter().enumerate() {
                    if !Self::segment_matches(seg, path_parts[start + i]) {
                        all_match = false;
                        break;
                    }
                }
                if all_match {
                    return true;
                }
            }
            false
        }
    }

    /// Anchored segment-by-segment match with `**` support (zero or more
    /// segments) and directory-prefix semantics: when the pattern is fully
    /// consumed before the path ends, the path still matches.
    fn anchored_match(segments: &[String], path_parts: &[&str], si: usize, pi: usize) -> bool {
        if si == segments.len() {
            return true; // pattern fully matched (possibly as a directory prefix)
        }
        if segments[si] == "**" {
            // `**` matches zero segments: skip it.
            if Self::anchored_match(segments, path_parts, si + 1, pi) {
                return true;
            }
            // `**` matches one or more segments: consume one path segment
            // and try again with the same `**`.
            if pi < path_parts.len() {
                return Self::anchored_match(segments, path_parts, si, pi + 1);
            }
            return false;
        }
        if pi >= path_parts.len() {
            return false;
        }
        if !Self::segment_matches(&segments[si], path_parts[pi]) {
            return false;
        }
        Self::anchored_match(segments, path_parts, si + 1, pi + 1)
    }

    fn segment_matches(pattern_seg: &str, path_seg: &str) -> bool {
        if pattern_seg == "**" {
            return true;
        }

        // Convert glob to regex-like matching manually for * and ?
        Self::glob_match(pattern_seg, path_seg)
    }

    /// Simple glob matcher supporting `*` (any chars except none required) and
    /// `?` (exactly one char). Does not handle character classes `[abc]`.
    fn glob_match(pattern: &str, text: &str) -> bool {
        let p: Vec<char> = pattern.chars().collect();
        let t: Vec<char> = text.chars().collect();
        Self::glob_match_inner(&p, 0, &t, 0)
    }

    fn glob_match_inner(p: &[char], pi: usize, t: &[char], ti: usize) -> bool {
        if pi == p.len() {
            return ti == t.len();
        }

        match p[pi] {
            '*' => {
                // Try matching zero or more characters
                if Self::glob_match_inner(p, pi + 1, t, ti) {
                    return true;
                }
                if ti < t.len() && Self::glob_match_inner(p, pi, t, ti + 1) {
                    return true;
                }
                false
            }
            '?' => {
                if ti < t.len() {
                    Self::glob_match_inner(p, pi + 1, t, ti + 1)
                } else {
                    false
                }
            }
            c => {
                if ti < t.len() && t[ti] == c {
                    Self::glob_match_inner(p, pi + 1, t, ti + 1)
                } else {
                    false
                }
            }
        }
    }
}

