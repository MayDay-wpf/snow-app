use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use napi::bindgen_prelude::*;
use regex::Regex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};
use tokio_util::sync::CancellationToken;

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::remote_workspace::{
    execute_remote_workspace_command, is_ssh_path, RemoteWorkspaceCallback,
};

use crate::utils::paths::expand_home_dir;

pub struct GrepService;

impl GrepService {
    pub fn new() -> Self {
        GrepService
    }
}

const SERVER_ID: &str = "grep";
const MAX_OUTPUT_LENGTH: usize = 50000;
const DEFAULT_MAX_RESULTS: usize = 100;
const DEFAULT_FIND_MAX_RESULTS: usize = 200;
const MAX_FIND_RESULTS: usize = 2000;
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
            description: "Search file contents using ripgrep (preferred) or native Rust file walker (fallback). Supports regex patterns and file glob filtering. Returns matching lines with file paths and line numbers. Automatically skips node_modules, .git, target, dist, out and other heavy directories. When the current project is linked with sibling projects (a linked project group), searching the project root (or omitting `path`) searches ALL linked roots and merges the matches; the result lists the searched roots under `linkedRoots`.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "The search pattern (regex by default, or literal string when isRegex is false)."
                    },
                    "description": {
                        "type": "string",
                        "description": "REQUIRED: a SHORT user-friendly explanation of what this search is looking for - one brief sentence (about 15 words / 20 characters max), written in the SAME language as the user's latest query. It is shown to the user in place of the raw pattern, so they never have to read the regex. Do NOT repeat the pattern or explain its syntax."
                    },
                    "path": {
                        "type": "string",
                        "description": "The directory or file to search in. Defaults to the current working directory (the project root; a linked project group is searched in full when this points at the project root)."
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
                "required": ["pattern", "description"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "find".to_string(),
            description: "Find files by path/name using a glob pattern (file paths only, no content matching). Uses ripgrep `--files` (preferred) or a native Rust walker (fallback). Returns file paths you can pass straight to `filesystem-read`. By default it skips node_modules, .git, target, dist, out and other heavy directories; set `searchAll` to search everything instead (also disables ignore-file filtering when the ripgrep backend is available). A pattern without a slash matches file names at any depth (e.g. `*.ts`, `**/*.test.ts`); a pattern with a slash matches the path relative to the search root (e.g. `src/**/*.{ts,tsx}`). Use this instead of `grep-search` whenever you only need to locate files by name. When the search root is the current project root (or `path` is omitted) and the project belongs to a linked project group, all linked roots are searched and merged; the result lists them under `linkedRoots`.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern for file paths. No slash = match the file name at any depth (`*.ts`, `**/*.json`); with slash = match the path relative to the search root (`src/**/*.{ts,tsx}`)."
                    },
                    "description": {
                        "type": "string",
                        "description": "REQUIRED: a SHORT user-friendly explanation of what files this search is looking for - one brief sentence (about 15 words / 20 characters max), written in the SAME language as the user's latest query. It is shown to the user in place of the raw glob. Do NOT repeat the glob or explain its syntax."
                    },
                    "path": {
                        "type": "string",
                        "description": "The directory to search in. Defaults to the current working directory (the project root; a linked project group is searched in full when this points at the project root)."
                    },
                    "maxResults": {
                        "type": "number",
                        "description": "Maximum number of file paths to return (default 200, cap 2000).",
                        "default": 200
                    },
                    "searchAll": {
                        "type": "boolean",
                        "description": "Search everything instead of the default filtered walk: include heavy directories (node_modules, .git, target, dist, ...) and files excluded by ignore rules (ripgrep backend only). Slower on large repositories; use only when results are missing because of those filters.",
                        "default": false
                    }
                },
                "required": ["pattern", "description"]
            }),
        }]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "search" | "find" => Err(Error::new(
                Status::GenericFailure,
                "The Grep tools must be executed through the asynchronous executor".to_string(),
            )),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{}\" for MCP server \"grep\". Available tools: [grep-search, grep-find]",
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
        // 释义（description）只是面向用户的展示字段，不参与检索逻辑：模型漏填
        // 时照常执行搜索，由 UI 回退为展示原始正则——只读检索不该因为缺少一句
        // 解释而失败（schema 仍把 description 列为必填，用于提示模型补齐）。
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
    /// 释义（description）只用于 UI 展示、不参与检索逻辑，缺失时不影响搜索。
    ///
    /// `linkedRoots` 为关联项目组（合集）的兄弟根目录：调用方（工具参数解析层）
    /// 在「针对项目根的整体搜索」时注入，这里逐个搜索并把匹配合并进同一结果，
    /// 让一次 grep 覆盖关联起来的全部项目。
    pub async fn execute_search_local(&self, args: &Value) -> napi::Result<Value> {
        let pattern = args.get("pattern").and_then(Value::as_str).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "pattern is required for tool \"grep-search\"".to_string(),
            )
        })?;

        let search_path = expand_home_dir(args.get("path").and_then(Value::as_str).unwrap_or("."));

        let linked_roots: Vec<String> = args
            .get("linkedRoots")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .map(expand_home_dir)
                    .collect()
            })
            .unwrap_or_default();

        let file_glob = args
            .get("fileGlob")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());

        let options = GrepSearchOptions {
            pattern: pattern.to_string(),
            file_glob: file_glob.map(str::to_string),
            is_regex: args.get("isRegex").and_then(Value::as_bool).unwrap_or(true),
            case_sensitive: args
                .get("caseSensitive")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            max_results: args
                .get("maxResults")
                .and_then(Value::as_u64)
                .map(|v| v as usize)
                .unwrap_or(DEFAULT_MAX_RESULTS),
        };

        let (backend, output) = run_search_on_path(&options, &search_path).await?;
        let mut matches = parse_grep_output(&output);
        let mut raw_output = output;
        let mut roots_report = vec![json!({
            "path": search_path,
            "backend": backend,
            "totalMatches": matches.len(),
        })];

        for root in linked_roots {
            if root == search_path {
                continue;
            }
            match run_search_on_path(&options, &root).await {
                Ok((root_backend, root_output)) => {
                    let root_matches = parse_grep_output(&root_output);
                    roots_report.push(json!({
                        "path": root,
                        "backend": root_backend,
                        "totalMatches": root_matches.len(),
                    }));
                    if raw_output.len() < MAX_OUTPUT_LENGTH {
                        raw_output.push_str(&root_output);
                    }
                    matches.extend(root_matches);
                }
                // 兄弟根不可读（被移除 / 权限变化）时记录并跳过，不影响主根结果。
                Err(error) => {
                    roots_report.push(json!({ "path": root, "error": error.reason }));
                }
            }
        }

        let total_matches = matches.len();
        let truncated = total_matches > options.max_results;
        matches.truncate(options.max_results);

        let mut result = json!({
            "backend": backend,
            "pattern": options.pattern,
            "path": search_path,
            "fileGlob": options.file_glob,
            "matches": matches,
            "totalMatches": total_matches,
            "truncated": truncated,
            "rawOutput": raw_output.chars().take(MAX_OUTPUT_LENGTH).collect::<String>(),
        });
        if roots_report.len() > 1 {
            result["linkedRoots"] = json!(roots_report);
        }
        Ok(result)
    }

    /// 按 glob 查找文件路径：SSH 工作区转发到远端，否则本地遍历。
    pub async fn execute_find(
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
                "grep-find",
                args,
                cancel_token,
            )
            .await;
        }

        self.execute_find_local(args).await
    }

    /// 本地 glob 查找执行体（不含 SSH 远程派发逻辑）。
    /// 释义（description）只面向 UI 展示，缺失时照常查找。
    pub async fn execute_find_local(&self, args: &Value) -> napi::Result<Value> {
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "pattern (glob) is required for tool \"grep-find\"".to_string(),
                )
            })?
            .to_string();

        let search_path = expand_home_dir(args.get("path").and_then(Value::as_str).unwrap_or("."));

        let linked_roots: Vec<String> = args
            .get("linkedRoots")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .map(expand_home_dir)
                    .collect()
            })
            .unwrap_or_default();

        let max_results = args
            .get("maxResults")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_FIND_MAX_RESULTS)
            .clamp(1, MAX_FIND_RESULTS);
        // 无损全量：包含重目录与被 .gitignore 忽略的文件（默认关闭）。
        let search_all = args
            .get("searchAll")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // 多取一条用于判断是否被截断（后端按上限提前停止，无法知道总数）。
        let probe_limit = max_results.saturating_add(1);
        let (backend, mut files) =
            run_find_on_path(&pattern, &search_path, probe_limit, search_all).await?;
        let mut roots_report = vec![json!({
            "path": search_path,
            "backend": backend,
            "totalMatches": files.len(),
        })];

        for root in linked_roots {
            if root == search_path {
                continue;
            }
            match run_find_on_path(&pattern, &root, probe_limit, search_all).await {
                Ok((root_backend, root_files)) => {
                    roots_report.push(json!({
                        "path": root,
                        "backend": root_backend,
                        "totalMatches": root_files.len(),
                    }));
                    files.extend(root_files);
                }
                // 兄弟根不可读时记录并跳过，不影响主根结果。
                Err(error) => {
                    roots_report.push(json!({ "path": root, "error": error.reason }));
                }
            }
        }

        // 关联根之间理论上不重叠，防御性去重并保持顺序。
        let mut seen = std::collections::HashSet::new();
        files.retain(|file| seen.insert(file.clone()));

        let truncated = files.len() > max_results;
        files.truncate(max_results);
        // 后端按上限提前停止，真实总数不可知；totalMatches 报告实际返回数量，
        // 是否还有更多由 truncated 表达。
        let total_matches = files.len();

        let mut result = json!({
            "backend": backend,
            "pattern": pattern,
            "path": search_path,
            "searchAll": search_all,
            "files": files,
            "totalMatches": total_matches,
            "truncated": truncated,
        });
        if roots_report.len() > 1 {
            result["linkedRoots"] = json!(roots_report);
        }
        Ok(result)
    }
}

/// 一次本地搜索的参数（跨根复用时保持完全一致的检索条件）。
struct GrepSearchOptions {
    pattern: String,
    file_glob: Option<String>,
    is_regex: bool,
    case_sensitive: bool,
    max_results: usize,
}

/// 在单个根路径上执行搜索：优先 ripgrep，失败时回退到原生遍历器。
async fn run_search_on_path(
    options: &GrepSearchOptions,
    search_path: &str,
) -> napi::Result<(&'static str, String)> {
    let metadata = tokio::fs::metadata(search_path).await.map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Search path does not exist or is inaccessible: {search_path} ({error})"),
        )
    })?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Search path is not a file or directory: {search_path}"),
        ));
    }

    if is_ripgrep_available().await {
        let ripgrep_result = run_ripgrep(
            &options.pattern,
            search_path,
            options.file_glob.as_deref(),
            options.is_regex,
            options.case_sensitive,
            options.max_results,
        )
        .await;
        return match ripgrep_result {
            Ok(output) => Ok(("ripgrep", output)),
            Err(ripgrep_error) => {
                // ripgrep 失败时回退到原生遍历器，两者都失败则报告原始错误。
                match run_native_search(
                    &options.pattern,
                    search_path,
                    options.is_regex,
                    options.case_sensitive,
                    options.max_results,
                )
                .await
                {
                    Ok(output) => Ok(("native", output)),
                    Err(_) => Err(ripgrep_error),
                }
            }
        };
    }

    let output = run_native_search(
        &options.pattern,
        search_path,
        options.is_regex,
        options.case_sensitive,
        options.max_results,
    )
    .await?;
    Ok(("native", output))
}

// ---------------------------------------------------------------------------
// ripgrep backend (preferred)
// ---------------------------------------------------------------------------

static RIPGREP_AVAILABILITY: AtomicU8 = AtomicU8::new(0);

async fn is_ripgrep_available() -> bool {
    match RIPGREP_AVAILABILITY.load(Ordering::Relaxed) {
        1 => return true,
        2 => return false,
        _ => {}
    }

    let mut cmd = crate::utils::process::cmd_async("rg");
    cmd.arg("--version");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let available = cmd
        .spawn()
        .map(|mut child| {
            let _ = child.start_kill();
        })
        .is_ok();

    RIPGREP_AVAILABILITY.store(if available { 1 } else { 2 }, Ordering::Relaxed);
    available
}

fn utf8_safe_cut(bytes: &[u8], max: usize) -> usize {
    if bytes.len() <= max {
        return bytes.len();
    }
    let mut end = max;
    while end > 0 && (bytes[end] & 0xc0) == 0x80 {
        end -= 1;
    }
    end
}

async fn run_ripgrep(
    pattern: &str,
    path: &str,
    file_glob: Option<&str>,
    is_regex: bool,
    case_sensitive: bool,
    _max_results: usize,
) -> napi::Result<String> {
    let mut cmd = crate::utils::process::cmd_async("rg");
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
        .stderr(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to spawn ripgrep: {e}"),
        )
    })?;

    let stdout = child.stdout.take();
    let result = tokio::time::timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS), async {
        let mut collected: Vec<u8> = Vec::new();
        let mut stopped_early = false;
        if let Some(stdout) = stdout {
            let limit = (MAX_OUTPUT_LENGTH as u64).saturating_mul(2);
            let mut reader = tokio::io::BufReader::new(stdout.take(limit));
            let mut chunk: Vec<u8> = Vec::new();
            loop {
                chunk.clear();
                let read = reader.read_until(b'\n', &mut chunk).await.map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to read ripgrep stdout: {e}"),
                    )
                })?;
                if read == 0 {
                    break;
                }
                collected.extend_from_slice(&chunk);
                if collected.len() >= MAX_OUTPUT_LENGTH {
                    stopped_early = true;
                    break;
                }
            }
        }

        if stopped_early {
            let _ = child.start_kill();
        }

        let status = child.wait().await.map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to wait for ripgrep: {e}"),
            )
        })?;

        Ok::<(Vec<u8>, std::process::ExitStatus, bool), Error>((collected, status, stopped_early))
    })
    .await;

    match result {
        Ok(Ok((bytes, status, stopped_early))) => {
            // rg exits with 1 when no matches found (not an error).
            // rg exits with 2 for actual errors.
            if !stopped_early && !status.success() {
                let code = status.code().unwrap_or(-1);
                if code == 2 {
                    return Err(Error::new(
                        Status::GenericFailure,
                        "ripgrep encountered an error during search".to_string(),
                    ));
                }
            }

            let mut bytes = bytes;
            let cut = utf8_safe_cut(&bytes, MAX_OUTPUT_LENGTH);
            bytes.truncate(cut);

            String::from_utf8(bytes).map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to read ripgrep stdout: {e}"),
                )
            })
        }
        Ok(Err(e)) => Err(e),
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
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

    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_flag = Arc::clone(&cancelled);

    // Run the file walk in a blocking thread to avoid blocking the tokio runtime.
    let search = tokio::task::spawn_blocking(move || {
        native_search_sync(&path_buf, &regex, max_lines, &cancel_flag)
    });

    match tokio::time::timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS), search).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(Error::new(
            Status::GenericFailure,
            format!("Search task failed: {error}"),
        )),
        Err(_) => {
            cancelled.store(true, Ordering::Relaxed);
            Err(Error::new(
                Status::GenericFailure,
                format!("native search timed out after {SEARCH_TIMEOUT_SECS}s"),
            ))
        }
    }
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

fn native_search_sync(
    root: &Path,
    regex: &Regex,
    max_lines: usize,
    cancelled: &AtomicBool,
) -> napi::Result<String> {
    let mut output = String::new();
    let mut match_count = 0usize;

    if root.is_file() {
        search_file(root, regex, max_lines, &mut match_count, &mut output, cancelled);
    } else if root.is_dir() {
        walk_dir(root, regex, max_lines, &mut match_count, &mut output, cancelled);
    }

    Ok(output)
}

fn walk_dir(
    dir: &Path,
    regex: &Regex,
    max_lines: usize,
    match_count: &mut usize,
    output: &mut String,
    cancelled: &AtomicBool,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if *match_count >= max_lines || cancelled.load(Ordering::Relaxed) {
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
            walk_dir(&path, regex, max_lines, match_count, output, cancelled);
        } else if path.is_file() {
            // Skip files without a known code extension.
            if !is_searchable_file(&path) {
                continue;
            }

            search_file(&path, regex, max_lines, match_count, output, cancelled);
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
    cancelled: &AtomicBool,
) {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };

    // Use a buffered reader for efficiency.
    let reader = BufReader::new(file);
    let path_str = path.to_string_lossy();

    for (line_idx, line_result) in reader.lines().enumerate() {
        if *match_count >= max_lines || cancelled.load(Ordering::Relaxed) {
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
// File finding (glob) — ripgrep `--files` or native walker
// ---------------------------------------------------------------------------

/// 在单个根路径上按 glob 查找文件：优先 ripgrep，失败时回退到原生遍历器。
async fn run_find_on_path(
    pattern: &str,
    search_path: &str,
    max_results: usize,
    search_all: bool,
) -> napi::Result<(&'static str, Vec<String>)> {
    let metadata = tokio::fs::metadata(search_path).await.map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Search path does not exist or is inaccessible: {search_path} ({error})"),
        )
    })?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Search path is not a file or directory: {search_path}"),
        ));
    }

    if is_ripgrep_available().await {
        match run_ripgrep_files(pattern, search_path, max_results, search_all).await {
            Ok(files) => return Ok(("ripgrep", files)),
            Err(ripgrep_error) => {
                return match run_native_find(pattern, search_path, max_results, search_all).await {
                    Ok(files) => Ok(("native", files)),
                    Err(_) => Err(ripgrep_error),
                };
            }
        }
    }

    let files = run_native_find(pattern, search_path, max_results, search_all).await?;
    Ok(("native", files))
}

/// `rg --files --glob <pattern>`：只列路径；默认跳过重目录与 ignore 规则。
async fn run_ripgrep_files(
    pattern: &str,
    path: &str,
    max_results: usize,
    search_all: bool,
) -> napi::Result<Vec<String>> {
    let mut cmd = crate::utils::process::cmd_async("rg");
    cmd.arg("--files");
    cmd.arg("--color").arg("never");
    // 隐藏文件（.env / .gitignore 等）也应能被查找，重目录由下方 glob 排除。
    cmd.arg("--hidden");
    cmd.arg("--glob").arg(pattern);
    if search_all {
        // 无损全量：不遵守 .gitignore 等 ignore 规则，也不排除重目录。
        cmd.arg("--no-ignore");
    } else {
        for dir in SKIP_DIRS {
            cmd.arg("--glob").arg(format!("!{dir}"));
        }
    }
    cmd.arg(path);

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = cmd.spawn().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to spawn ripgrep: {error}"),
        )
    })?;

    let stdout = child.stdout.take();
    let result = tokio::time::timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS), async {
        let mut collected: Vec<u8> = Vec::new();
        let mut stopped_early = false;
        if let Some(stdout) = stdout {
            let limit = (MAX_OUTPUT_LENGTH as u64).saturating_mul(2);
            let mut reader = tokio::io::BufReader::new(stdout.take(limit));
            let mut chunk: Vec<u8> = Vec::new();
            loop {
                chunk.clear();
                let read = reader.read_until(b'\n', &mut chunk).await.map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to read ripgrep stdout: {error}"),
                    )
                })?;
                if read == 0 {
                    break;
                }
                collected.extend_from_slice(&chunk);
                if collected.len() >= MAX_OUTPUT_LENGTH {
                    stopped_early = true;
                    break;
                }
            }
        }

        if stopped_early {
            let _ = child.start_kill();
        }

        let status = child.wait().await.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to wait for ripgrep: {error}"),
            )
        })?;

        Ok::<(Vec<u8>, std::process::ExitStatus, bool), Error>((collected, status, stopped_early))
    })
    .await;

    match result {
        Ok(Ok((bytes, status, stopped_early))) => {
            // 无匹配时 rg 退出码为 1；2 才是真正的错误。
            if !stopped_early && !status.success() && status.code() == Some(2) {
                return Err(Error::new(
                    Status::GenericFailure,
                    "ripgrep encountered an error while listing files".to_string(),
                ));
            }

            let text = String::from_utf8_lossy(&bytes);
            let mut files: Vec<String> = text
                .lines()
                .map(str::trim_end)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect();
            files.truncate(max_results);
            Ok(files)
        }
        Ok(Err(error)) => Err(error),
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(Error::new(
                Status::GenericFailure,
                format!("ripgrep timed out after {SEARCH_TIMEOUT_SECS}s"),
            ))
        }
    }
}

async fn run_native_find(
    pattern: &str,
    path: &str,
    max_results: usize,
    search_all: bool,
) -> napi::Result<Vec<String>> {
    let matcher = compile_glob_regex(pattern)?;
    let match_full_path = pattern.contains('/') || pattern.contains('\\');
    let root = PathBuf::from(path);

    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_flag = Arc::clone(&cancelled);

    let find = tokio::task::spawn_blocking(move || {
        native_find_sync(
            &root,
            &matcher,
            match_full_path,
            max_results,
            search_all,
            &cancel_flag,
        )
    });

    match tokio::time::timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS), find).await {
        Ok(Ok(files)) => Ok(files),
        Ok(Err(error)) => Err(Error::new(
            Status::GenericFailure,
            format!("Find task failed: {error}"),
        )),
        Err(_) => {
            cancelled.store(true, Ordering::Relaxed);
            Err(Error::new(
                Status::GenericFailure,
                format!("native find timed out after {SEARCH_TIMEOUT_SECS}s"),
            ))
        }
    }
}

fn compile_glob_regex(pattern: &str) -> napi::Result<Regex> {
    let regex = glob_to_regex(pattern);
    Regex::new(&regex)
        .map_err(|error| Error::new(Status::InvalidArg, format!("Invalid glob pattern: {error}")))
}

/// glob 转锚定正则：`**` 跨目录，`*` / `?` 不跨目录，支持 `{a,b}` 与 `[abc]`。
fn glob_to_regex(pattern: &str) -> String {
    format!("^{}$", glob_body_to_regex(pattern))
}

fn glob_body_to_regex(pattern: &str) -> String {
    let chars: Vec<char> = pattern.replace('\\', "/").chars().collect();
    let mut out = String::new();
    let mut i = 0usize;

    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    // `**/` 允许匹配零层目录，`**` 跨任意层级。
                    if i + 2 < chars.len() && chars[i + 2] == '/' {
                        out.push_str("(?:.*/)?");
                        i += 3;
                    } else {
                        out.push_str(".*");
                        i += 2;
                    }
                } else {
                    out.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' => {
                out.push_str("[^/]");
                i += 1;
            }
            '[' => {
                let mut end = i + 1;
                while end < chars.len() && chars[end] != ']' {
                    end += 1;
                }
                if end >= chars.len() {
                    out.push_str("\\[");
                    i += 1;
                } else {
                    let mut start = i + 1;
                    let negated = start < end && (chars[start] == '!' || chars[start] == '^');
                    if negated {
                        start += 1;
                    }
                    if start >= end {
                        // 空字符集：永不匹配（regex crate 不支持 look-around）。
                        out.push_str("(?:\\b\\B)");
                    } else {
                        out.push('[');
                        if negated {
                            out.push('^');
                        }
                        for ch in &chars[start..end] {
                            out.push(*ch);
                        }
                        out.push(']');
                    }
                    i = end + 1;
                }
            }
            '{' => {
                if let Some(offset) = chars[i + 1..].iter().position(|ch| *ch == '}') {
                    let end = i + 1 + offset;
                    let inner: String = chars[i + 1..end].iter().collect();
                    let alternatives: Vec<String> =
                        inner.split(',').map(glob_body_to_regex).collect();
                    out.push_str("(?:");
                    out.push_str(&alternatives.join("|"));
                    out.push(')');
                    i = end + 1;
                } else {
                    out.push_str("\\{");
                    i += 1;
                }
            }
            ch => {
                if "\\^$.|+()".contains(ch) {
                    out.push('\\');
                }
                out.push(ch);
                i += 1;
            }
        }
    }

    out
}

fn native_find_sync(
    root: &Path,
    matcher: &Regex,
    match_full_path: bool,
    max_results: usize,
    search_all: bool,
    cancelled: &AtomicBool,
) -> Vec<String> {
    let mut files = Vec::new();
    if root.is_file() {
        push_find_match(root, root, matcher, match_full_path, max_results, &mut files);
        return files;
    }
    walk_find_dir(
        root,
        root,
        matcher,
        match_full_path,
        max_results,
        search_all,
        &mut files,
        cancelled,
    );
    files
}

fn walk_find_dir(
    root: &Path,
    dir: &Path,
    matcher: &Regex,
    match_full_path: bool,
    max_results: usize,
    search_all: bool,
    files: &mut Vec<String>,
    cancelled: &AtomicBool,
) {
    if files.len() >= max_results || cancelled.load(Ordering::Relaxed) {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if files.len() >= max_results || cancelled.load(Ordering::Relaxed) {
            return;
        }

        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            if !search_all {
                if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                    if SKIP_DIRS.contains(&name) {
                        continue;
                    }
                }
            }
            walk_find_dir(
                root,
                &path,
                matcher,
                match_full_path,
                max_results,
                search_all,
                files,
                cancelled,
            );
        } else if file_type.is_file() {
            push_find_match(root, &path, matcher, match_full_path, max_results, files);
        }
    }
}

fn push_find_match(
    root: &Path,
    path: &Path,
    matcher: &Regex,
    match_full_path: bool,
    max_results: usize,
    files: &mut Vec<String>,
) {
    if files.len() >= max_results {
        return;
    }

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let candidate = if match_full_path {
        match path.strip_prefix(root) {
            Ok(relative) if !relative.as_os_str().is_empty() => {
                relative.to_string_lossy().replace('\\', "/")
            }
            _ => file_name,
        }
    } else {
        file_name
    };

    if matcher.is_match(&candidate) {
        files.push(path.to_string_lossy().to_string());
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

fn parse_grep_line(line: &str) -> Option<Value> {
    let bytes = line.as_bytes();
    let mut search_from = 1usize;

    while search_from < bytes.len() {
        let offset = bytes[search_from..].iter().position(|byte| *byte == b':')?;
        let colon = search_from + offset;

        let digits_start = colon + 1;
        let mut digits_end = digits_start;
        while digits_end < bytes.len() && bytes[digits_end].is_ascii_digit() {
            digits_end += 1;
        }

        if digits_end > digits_start && digits_end < bytes.len() && bytes[digits_end] == b':' {
            let line_number: u64 = line[digits_start..digits_end].parse().ok()?;
            return Some(json!({
                "file": &line[..colon],
                "line": line_number,
                "content": &line[digits_end + 1..],
            }));
        }

        search_from = colon + 1;
    }

    None
}
