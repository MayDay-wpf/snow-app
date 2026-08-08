use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use napi::bindgen_prelude::*;
use regex::Regex;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::remote_workspace::{
    execute_remote_workspace_command, is_ssh_path, RemoteWorkspaceCallback,
};

pub struct GrepService;

impl GrepService {
    pub fn new() -> Self {
        GrepService
    }
}

const SERVER_ID: &str = "grep";
const MAX_OUTPUT_LENGTH: usize = 50000;
const DEFAULT_MAX_RESULTS: usize = 100;
const SEARCH_TIMEOUT_SECS: u64 = 30;

/// Directories that are always skipped during recursive search.
/// These are typically very large and contain generated/dependency files.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "target",
    "dist",
    "out",
    "build",
    ".next",
    ".nuxt",
    ".snow",
    ".cache",
    ".turbo",
    "__pycache__",
    ".pytest_cache",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    "coverage",
    ".nyc_output",
    "release",
];

/// File extensions that are treated as source code and will be searched.
/// Files with other extensions are skipped to avoid searching binaries,
/// media, and other non-text files.
const CODE_EXTENSIONS: &[&str] = &[
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "mts",
    "cts",
    "py",
    "pyw",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "kts",
    "swift",
    "c",
    "cpp",
    "cc",
    "cxx",
    "h",
    "hpp",
    "hxx",
    "hh",
    "m",
    "mm",
    "cs",
    "vb",
    "fs",
    "fsx",
    "css",
    "scss",
    "sass",
    "less",
    "styl",
    "html",
    "htm",
    "xml",
    "svg",
    "vue",
    "svelte",
    "astro",
    "json",
    "json5",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "config",
    "properties",
    "md",
    "mdx",
    "mdc",
    "txt",
    "rst",
    "tex",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "psm1",
    "bat",
    "cmd",
    "sql",
    "graphql",
    "gql",
    "prisma",
    "dockerfile",
    "makefile",
    "cmake",
    "ninja",
    "lua",
    "php",
    "r",
    "dart",
    "scala",
    "clj",
    "cljs",
    "ex",
    "exs",
    "erl",
    "hs",
    "ml",
    "nim",
    "zig",
    "v",
    "proto",
    "thrift",
    "gitignore",
    "dockerignore",
    "editorconfig",
    "env",
];

impl McpService for GrepService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: "search".to_string(),
            description: "Search file contents using ripgrep (preferred) or native Rust file walker (fallback). Supports regex patterns and file glob filtering. Returns matching lines with file paths and line numbers. Automatically skips node_modules, .git, target, dist, out and other heavy directories.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "The search pattern (regex by default, or literal string when isRegex is false)."
                    },
                    "path": {
                        "type": "string",
                        "description": "The directory or file to search in. Defaults to the current working directory."
                    },
                    "fileGlob": {
                        "type": "string",
                        "description": "Optional glob pattern to filter files, e.g. \"*.ts\", \"**/*.{js,ts}\". Only used by ripgrep; ignored by native fallback."
                    },
                    "isRegex": {
                        "type": "boolean",
                        "description": "Whether the pattern is a regex (default true). Set to false for literal string search.",
                        "default": true
                    },
                    "caseSensitive": {
                        "type": "boolean",
                        "description": "Whether the search is case-sensitive (default true).",
                        "default": true
                    },
                    "maxResults": {
                        "type": "number",
                        "description": "Maximum number of matching lines to return (default 100).",
                        "default": 100
                    }
                },
                "required": ["pattern"]
            }),
        }]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "search" => Err(Error::new(
                Status::GenericFailure,
                "The Grep search tool must be executed through the asynchronous executor"
                    .to_string(),
            )),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{}\" for MCP server \"grep\". Available tools: [grep-search]",
                    tool_name
                ),
            )),
        }
    }
}

impl GrepService {
    pub async fn execute_search(
        &self,
        args: &Value,
        on_remote_workspace_command: &RemoteWorkspaceCallback,
        cancel_token: Option<&CancellationToken>,
    ) -> napi::Result<Value> {
        if args
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(is_ssh_path)
        {
            return execute_remote_workspace_command(
                on_remote_workspace_command,
                "grep-search",
                args,
                cancel_token,
            )
            .await;
        }

        self.execute_search_local(args).await
    }

    /// 本地路径的 grep 搜索执行体（不含 SSH 远程派发逻辑）。
    /// 文件搜索 agent 等内部调用方复用此入口执行本地搜索。
    pub async fn execute_search_local(&self, args: &Value) -> napi::Result<Value> {
        let pattern = args.get("pattern").and_then(Value::as_str).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "pattern is required for tool \"grep-search\"".to_string(),
            )
        })?;

        let search_path = args.get("path").and_then(Value::as_str).unwrap_or(".");

        let file_glob = args
            .get("fileGlob")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());

        let is_regex = args.get("isRegex").and_then(Value::as_bool).unwrap_or(true);

        let case_sensitive = args
            .get("caseSensitive")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let max_results = args
            .get("maxResults")
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_MAX_RESULTS);

        // Try ripgrep first, fall back to native Rust walker.
        let rg_available = is_ripgrep_available().await;

        let (backend, output) = if rg_available {
            let result = run_ripgrep(
                pattern,
                search_path,
                file_glob,
                is_regex,
                case_sensitive,
                max_results,
            )
            .await;
            match result {
                Ok(out) => ("ripgrep", out),
                Err(e) => {
                    // If rg fails, fall back to native walker.
                    let native_result = run_native_search(
                        pattern,
                        search_path,
                        is_regex,
                        case_sensitive,
                        max_results,
                    )
                    .await;
                    match native_result {
                        Ok(out) => ("native", out),
                        Err(_) => return Err(e),
                    }
                }
            }
        } else {
            let out =
                run_native_search(pattern, search_path, is_regex, case_sensitive, max_results)
                    .await?;
            ("native", out)
        };

        let matches = parse_grep_output(&output);
        let total_matches = matches.len();
        let truncated = total_matches > max_results;
        let limited_matches = &matches[..total_matches.min(max_results)];

        Ok(json!({
            "backend": backend,
            "pattern": pattern,
            "path": search_path,
            "fileGlob": file_glob,
            "matches": limited_matches,
            "totalMatches": total_matches,
            "truncated": truncated,
            "rawOutput": output.chars().take(MAX_OUTPUT_LENGTH).collect::<String>(),
        }))
    }
}

// ---------------------------------------------------------------------------
// ripgrep backend (preferred)
// ---------------------------------------------------------------------------

async fn is_ripgrep_available() -> bool {
    let mut cmd = Command::new("rg");
    cmd.arg("--version");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .and_then(|mut child| {
            let _ = child.start_kill();
            Ok(())
        })
        .is_ok()
}

async fn run_ripgrep(
    pattern: &str,
    path: &str,
    file_glob: Option<&str>,
    is_regex: bool,
    case_sensitive: bool,
    _max_results: usize,
) -> napi::Result<String> {
    let mut cmd = Command::new("rg");
    cmd.arg("--line-number");
    cmd.arg("--no-heading");
    cmd.arg("--color").arg("never");
    cmd.arg("--with-filename");

    if !is_regex {
        cmd.arg("--fixed-strings");
    }

    if !case_sensitive {
        cmd.arg("-i");
    }

    cmd.arg("--max-count").arg("500");

    if let Some(glob) = file_glob {
        cmd.arg("--glob").arg(glob);
    }

    cmd.arg(pattern);
    cmd.arg(path);

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to spawn ripgrep: {e}"),
        )
    })?;

    let result = tokio::time::timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS), async {
        let mut stdout = String::new();
        if let Some(mut stdout_pipe) = child.stdout.take() {
            stdout_pipe.read_to_string(&mut stdout).await.map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to read ripgrep stdout: {e}"),
                )
            })?;
        }

        if let Some(mut stderr_pipe) = child.stderr.take() {
            let mut stderr_buf = Vec::new();
            let _ = stderr_pipe.read_to_end(&mut stderr_buf).await;
        }

        let status = child.wait().await.map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to wait for ripgrep: {e}"),
            )
        })?;

        Ok::<(String, std::process::ExitStatus), Error>((stdout, status))
    })
    .await;

    match result {
        Ok(Ok((stdout, status))) => {
            // rg exits with 1 when no matches found (not an error).
            // rg exits with 2 for actual errors.
            if !status.success() {
                let code = status.code().unwrap_or(-1);
                if code == 2 {
                    return Err(Error::new(
                        Status::GenericFailure,
                        "ripgrep encountered an error during search".to_string(),
                    ));
                }
            }

            let stdout = if stdout.len() > MAX_OUTPUT_LENGTH {
                stdout[..MAX_OUTPUT_LENGTH].to_string()
            } else {
                stdout
            };

            Ok(stdout)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => {
            let _ = child.start_kill();
            Err(Error::new(
                Status::GenericFailure,
                format!("ripgrep timed out after {SEARCH_TIMEOUT_SECS}s"),
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Native Rust file walker (fallback when ripgrep is unavailable)
// ---------------------------------------------------------------------------

async fn run_native_search(
    pattern: &str,
    path: &str,
    is_regex: bool,
    case_sensitive: bool,
    max_results: usize,
) -> napi::Result<String> {
    // Compile the regex pattern.
    let regex = compile_search_regex(pattern, is_regex, case_sensitive)?;

    let path_buf = PathBuf::from(path);
    let max_lines = max_results.min(500); // Hard cap to avoid huge output.

    // Run the file walk in a blocking thread to avoid blocking the tokio runtime.
    let result =
        tokio::task::spawn_blocking(move || native_search_sync(&path_buf, &regex, max_lines))
            .await
            .map_err(|e| {
                Error::new(Status::GenericFailure, format!("Search task failed: {e}"))
            })??;

    Ok(result)
}

fn compile_search_regex(
    pattern: &str,
    is_regex: bool,
    case_sensitive: bool,
) -> napi::Result<Regex> {
    let actual_pattern = if is_regex {
        pattern.to_string()
    } else {
        // Escape regex metacharacters for literal search.
        regex::escape(pattern)
    };

    let mut builder = Regex::new(&actual_pattern);
    if !case_sensitive {
        builder = Regex::new(&format!("(?i){}", actual_pattern));
    }

    builder.map_err(|e| Error::new(Status::InvalidArg, format!("Invalid regex pattern: {e}")))
}

fn native_search_sync(root: &Path, regex: &Regex, max_lines: usize) -> napi::Result<String> {
    let mut output = String::new();
    let mut match_count = 0usize;

    if root.is_file() {
        search_file(root, regex, max_lines, &mut match_count, &mut output);
    } else if root.is_dir() {
        walk_dir(root, regex, max_lines, &mut match_count, &mut output);
    }

    Ok(output)
}

fn walk_dir(
    dir: &Path,
    regex: &Regex,
    max_lines: usize,
    match_count: &mut usize,
    output: &mut String,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if *match_count >= max_lines {
            return;
        }

        let path = entry.path();

        if path.is_dir() {
            // Skip heavy directories.
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if SKIP_DIRS.contains(&name) {
                    continue;
                }
            }
            walk_dir(&path, regex, max_lines, match_count, output);
        } else if path.is_file() {
            // Skip files without a known code extension.
            if !is_searchable_file(&path) {
                continue;
            }

            search_file(&path, regex, max_lines, match_count, output);
        }
    }
}

fn is_searchable_file(path: &Path) -> bool {
    // Files without extension: check against known filenames.
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        let lower = name.to_lowercase();
        if matches!(
            lower.as_str(),
            "dockerfile"
                | "makefile"
                | "rakefile"
                | "gemfile"
                | "procfile"
                | "brewfile"
                | "vagrantfile"
                | ".gitignore"
                | ".dockerignore"
                | ".editorconfig"
                | ".env"
                | ".npmrc"
                | ".prettierrc"
                | ".eslintrc"
                | ".babelrc"
        ) {
            return true;
        }
    }

    // Check extension.
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_lowercase(),
        None => return false,
    };

    CODE_EXTENSIONS.contains(&ext.as_str())
}

fn search_file(
    path: &Path,
    regex: &Regex,
    max_lines: usize,
    match_count: &mut usize,
    output: &mut String,
) {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };

    // Use a buffered reader for efficiency.
    let reader = BufReader::new(file);
    let path_str = path.to_string_lossy();

    for (line_idx, line_result) in reader.lines().enumerate() {
        if *match_count >= max_lines {
            return;
        }

        let line = match line_result {
            Ok(l) => l,
            Err(_) => return, // Likely binary file, skip.
        };

        if regex.is_match(&line) {
            // Format: file_path:line_number:content
            output.push_str(&path_str);
            output.push(':');
            output.push_str(&(line_idx + 1).to_string());
            output.push(':');
            output.push_str(&line);
            output.push('\n');

            *match_count += 1;

            if output.len() > MAX_OUTPUT_LENGTH {
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Output parsing (shared by both backends)
// ---------------------------------------------------------------------------

/// Parse grep/ripgrep/native output into structured match objects.
///
/// All backends output: `file_path:line_number:matched_content`
/// The separator is the FIRST `:<digits>:` pair from the left. Parsing from
/// the right would misparse every match whose content contains a colon
/// (e.g. `case "x": y`), silently dropping the result; paths with embedded
/// colons are rare (Windows drives) and are still skipped correctly because
/// the lazy quantifier advances until a `:<digits>:` separator is found.
fn parse_grep_output(output: &str) -> Vec<Value> {
    let mut matches = Vec::new();

    for line in output.lines() {
        if let Some(parsed) = parse_grep_line(line) {
            matches.push(parsed);
        }
    }

    matches
}

static GREP_LINE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

fn parse_grep_line(line: &str) -> Option<Value> {
    let re = GREP_LINE_RE
        .get_or_init(|| Regex::new(r"^(.+?):(\d+):(.*)$").expect("invalid grep line regex"));
    let captures = re.captures(line)?;
    let file_path = captures.get(1)?.as_str();
    let line_number: u64 = captures.get(2)?.as_str().parse().ok()?;
    let content = captures.get(3)?.as_str();

    Some(json!({
        "file": file_path,
        "line": line_number,
        "content": content,
    }))
}
