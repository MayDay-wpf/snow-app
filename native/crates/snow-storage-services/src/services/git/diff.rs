use std::collections::HashSet;
use std::path::Path;

use napi::bindgen_prelude::*;

use super::{
    is_git_repo, run_git, run_git_bytes, run_git_raw, GitCommitFile, GitDiffResult, GitLogEntry,
};

/// 已知图片扩展名。对这些文件不做 `--text` 强制文本 diff：
/// 二进制内容按文本输出会产生巨大乱码 patch，渲染端解析会卡死。
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg", "tif", "tiff", "avif",
];

/// `--text` 重试 diff 的最大字节数。超过则视为真正的二进制文件
/// （即使扩展名不是图片），避免巨大乱码 diff 传输/渲染卡死。
const MAX_TEXT_DIFF_BYTES: usize = 256 * 1024;

/// 按扩展名判断是否为图片文件（不区分大小写）。
fn is_image_path(file_path: &str) -> bool {
    Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| IMAGE_EXTENSIONS.contains(&s.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// 单个文件内容的最大字节数（图片预览传输用）。超出时拒绝读取，
/// 避免超大 base64 经过 IPC 传输导致 UI 卡顿。
const MAX_FILE_CONTENT_BYTES: usize = 20 * 1024 * 1024;

/// Read a file's raw content either from the working tree (`revision` is
/// None/empty) or from a git revision (`git show <revision>:<path>`).
///
/// The content is processed through `process_file_content` so images come
/// back as base64 with a MIME type, ready for direct `<img>` rendering.
pub fn get_file_content(
    repo_path: &str,
    file_path: &str,
    revision: Option<&str>,
) -> Result<crate::storage::services::fs_explorer::FileContentResult> {
    let bytes: Vec<u8> = match revision {
        Some(rev) if !rev.trim().is_empty() => {
            let rev_path = format!("{rev}:{file_path}");
            let args = vec!["show", &rev_path];
            run_git_bytes(repo_path, &args)?
        }
        _ => {
            let full_path = Path::new(repo_path).join(file_path);
            std::fs::read(&full_path).map_err(|e| {
                Error::from_reason(format!("Failed to read file {}: {e}", full_path.display()))
            })?
        }
    };

    if bytes.len() > MAX_FILE_CONTENT_BYTES {
        return Err(Error::from_reason(format!(
            "File too large to preview ({:.1} MB)",
            bytes.len() as f64 / (1024.0 * 1024.0)
        )));
    }

    Ok(crate::storage::services::fs_explorer::process_file_content(
        file_path, bytes,
    ))
}

/// Returns the full staged diff (`git diff --cached`).
///
/// This is used by the AI commit-message generator to analyse what has been
/// staged and produce a concise commit message.
pub fn get_staged_diff(repo_path: &str) -> Result<String> {
    run_git(repo_path, &["diff", "--cached"])
}

pub fn get_file_diff(repo_path: &str, file_path: &str, staged: bool) -> Result<GitDiffResult> {
    // `--no-ext-diff` 强制使用 git 内建 diff：用户在 gitconfig 里配置了
    // `diff.external` / `GIT_EXTERNAL_DIFF` 时，外部程序会产出无法解析
    // 的内容，渲染端只能显示空白。
    let args: Vec<&str> = if staged {
        vec!["diff", "--cached", "--no-ext-diff", "--", file_path]
    } else {
        vec!["diff", "--no-ext-diff", "--", file_path]
    };

    match run_git(repo_path, &args) {
        Ok(stdout) => {
            if stdout.contains("Binary files") {
                // 已知图片（或常见二进制）扩展名：直接判定为二进制。
                // 绝不能对图片重试 `--text`——二进制内容按文本输出会
                // 产生几 MB 乱码 patch，渲染端解析会卡死。
                if is_image_path(file_path) {
                    return Ok(GitDiffResult {
                        content: "Binary file - diff not available".to_string(),
                        is_binary: true,
                        error: String::new(),
                    });
                }
                // Git's heuristic may falsely flag text files as binary
                // (e.g. files containing NUL bytes). Retry with --text
                // to force a text-mode diff, but bound the result size —
                // a huge text dump means the file is really binary.
                let text_args: Vec<&str> = if staged {
                    vec!["diff", "--cached", "--text", "--no-ext-diff", "--", file_path]
                } else {
                    vec!["diff", "--text", "--no-ext-diff", "--", file_path]
                };
                match run_git(repo_path, &text_args) {
                    Ok(text_diff)
                        if !text_diff.is_empty() && text_diff.len() <= MAX_TEXT_DIFF_BYTES =>
                    {
                        return Ok(GitDiffResult {
                            content: text_diff,
                            is_binary: false,
                            error: String::new(),
                        });
                    }
                    _ => {
                        return Ok(GitDiffResult {
                            content: "Binary file - diff not available".to_string(),
                            is_binary: true,
                            error: String::new(),
                        });
                    }
                }
            }

            // If no diff and not staged, the file may be untracked (new).
            // `git diff --no-index /dev/null <file>` generates a diff showing
            // the entire file as additions.  It exits with code 1 when the
            // files differ (the normal case), so we must use `run_git_raw`
            // which ignores the exit code and returns stdout.
            if !staged && stdout.is_empty() {
                if is_image_path(file_path) {
                    return Ok(GitDiffResult {
                        content: "Binary file - diff not available".to_string(),
                        is_binary: true,
                        error: String::new(),
                    });
                }
                let no_index_args = vec!["diff", "--no-index", "--text", "/dev/null", file_path];
                let full_diff = run_git_raw(repo_path, &no_index_args).unwrap_or_default();
                if !full_diff.is_empty() && full_diff.len() <= MAX_TEXT_DIFF_BYTES {
                    return Ok(GitDiffResult {
                        content: full_diff,
                        is_binary: false,
                        error: String::new(),
                    });
                }
            }

            Ok(GitDiffResult {
                content: stdout,
                is_binary: false,
                error: String::new(),
            })
        }
        Err(e) => Ok(GitDiffResult {
            content: String::new(),
            is_binary: false,
            error: format!("{e}"),
        }),
    }
}

pub fn get_git_log(repo_path: &str, skip: i32, limit: i32) -> Result<Vec<GitLogEntry>> {
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }

    let skip_count = if skip > 0 { skip } else { 0 };
    let max_count = if limit <= 0 { 50 } else { limit };
    let skip_str = skip_count.to_string();
    let max_count_str = max_count.to_string();
    let format_arg = "--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%P%x1f%b%x1f";

    // Use run_git_raw because `git log` on an empty repo exits with code 128
    // ("fatal: your current branch does not have any commits yet").
    // run_git_raw returns stdout regardless of exit code, so we get an empty
    // string for repos with no commits.
    // 只遍历当前分支（HEAD）可达的提交，刻意不追加 `--all`：`--all` 会把其他
    // 引用独占的提交一并拉进来（例如其他 fork 远端 main 分支上的同步合并），
    // 混进提交图；被合并进当前分支的侧分支历史依然可达，照常显示。
    // `--decorate=full` emits unambiguous ref names (refs/heads/…,
    // refs/remotes/…, refs/tags/…) so the renderer can tell local branches,
    // remote-tracking branches and tags apart.
    // `--decorate-refs-exclude=refs/remotes/*/HEAD` drops the origin/HEAD
    // symbolic ref, which is redundant with the default branch badge
    // (origin/main) it points to.
    // `--shortstat` appends a diffstat line (e.g. "1 file changed,
    // 5 insertions(+), 2 deletions(-)") after each commit's pretty line so
    // the renderer can show per-commit added/removed line counts. Merge
    // commits with no changes produce no shortstat line (additions/deletions
    // stay 0). The stat vocabulary is hardcoded English in git and does not
    // follow the system locale.
    // 额外遍历当前分支的 upstream，让落后（未拉取）的远端提交也进入提交图。
    let upstream = run_git(
        repo_path,
        &["rev-parse", "--verify", "--quiet", "@{upstream}"],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());

    let mut log_args: Vec<&str> = vec!["log", "HEAD"];
    if let Some(hash) = upstream.as_deref() {
        log_args.push(hash);
    }
    log_args.extend_from_slice(&[
        // 顶层排序：与 git log --graph / VSCode 的行序一致——合并提交的
        // 第二父分支紧跟其第一父展开，主线不会被更新的侧分支提交挤到
        // 后面的车道；--skip/--max-count 分页在位序上依然连续。
        "--topo-order",
        "--decorate=full",
        "--decorate-refs-exclude=refs/remotes/*/HEAD",
        "--shortstat",
        format_arg,
        "--date=iso",
        "--skip",
        &skip_str,
        "--max-count",
        &max_count_str,
    ]);
    let output = run_git_raw(repo_path, &log_args)?;

    let mut entries: Vec<GitLogEntry> = Vec::new();

    for chunk in output.split('\x1e') {
        let chunk = chunk.trim_matches(|c| c == '\r' || c == '\n');
        if chunk.is_empty() {
            continue;
        }

        let parts: Vec<&str> = chunk.split('\x1f').collect();
        if parts.len() >= 9 {
            let parents: Vec<String> = parts[7].split_whitespace().map(|s| s.to_string()).collect();
            let body = parts[8].trim();
            let body_opt = if body.is_empty() {
                None
            } else {
                Some(body.to_string())
            };

            let mut entry = GitLogEntry {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                author: parts[2].to_string(),
                email: parts[3].to_string(),
                date: parts[4].to_string(),
                message: parts[5].to_string(),
                body: body_opt,
                refs: parts[6].to_string(),
                parents,
                additions: 0,
                deletions: 0,
                files_changed: 0,
                pushed: true,
                behind: false,
            };

            if parts.len() > 9 {
                let stat_text = parts[9];
                // "1 file changed, 18 insertions(+), 10 deletions(-)" 三段同源，
                // 文件数一并取出，前端无需再为统计单独查询文件列表。
                entry.files_changed = parse_shortstat_count(stat_text, "file");
                entry.additions = parse_shortstat_count(stat_text, "insertion");
                entry.deletions = parse_shortstat_count(stat_text, "deletion");
            }

            entries.push(entry);
        }
    }

    mark_pushed(repo_path, &mut entries);
    if let Some(hash) = upstream.as_deref() {
        mark_behind(repo_path, hash, &mut entries);
    }

    Ok(entries)
}

/// 标记落后提交：upstream 可达但 HEAD 不可达（`HEAD..upstream`）。
fn mark_behind(repo_path: &str, upstream: &str, entries: &mut [GitLogEntry]) {
    if entries.is_empty() {
        return;
    }
    let range = format!("HEAD..{upstream}");
    let behind: HashSet<String> = run_git(repo_path, &["rev-list", &range])
        .map(|output| output.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default();
    if behind.is_empty() {
        return;
    }
    for entry in entries {
        entry.behind = behind.contains(&entry.hash);
    }
}

/// 判定窗口内每个提交是否已推送到远端（被任一远端跟踪分支包含）。
///
/// 一条 `git rev-list --all --not --remotes` 即可列出全部「只在本地」的
/// 提交：未推送的提交通常只有寥寥几个，rev-list 会在远端引用边界处剪枝，
/// 远快于逐条提交做包含判断。仓库没有任何远端跟踪分支时直接跳过（全部
/// 视为已推送），避免纯本地仓库满屏空心环。
fn mark_pushed(repo_path: &str, entries: &mut [GitLogEntry]) {
    if entries.is_empty() {
        return;
    }

    let has_remote = run_git(
        repo_path,
        &[
            "for-each-ref",
            "--count=1",
            "--format=%(refname)",
            "refs/remotes",
        ],
    )
    .map(|output| !output.trim().is_empty())
    .unwrap_or(false);
    if !has_remote {
        return;
    }

    let unpushed: HashSet<String> =
        run_git(repo_path, &["rev-list", "--all", "--not", "--remotes"])
            .map(|output| output.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default();

    for entry in entries {
        entry.pushed = !unpushed.contains(&entry.hash);
    }
}

/// Extracts the number preceding `keyword` in a git `--shortstat` line, e.g.
/// "1 file changed, 5 insertions(+), 2 deletions(-)" with keyword "insertion"
/// yields 5. Matches both singular and plural forms ("insertion"/"insertions",
/// "deletion"/"deletions"). Returns 0 when the keyword is absent.
fn parse_shortstat_count(line: &str, keyword: &str) -> i32 {
    let mut result = 0;
    let mut rest = line;
    while let Some(idx) = rest.find(keyword) {
        // 数字与 keyword 之间有空白（"347 insertions"），先 trim 掉再取数字。
        let digits: String = rest[..idx]
            .trim_end()
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            if let Ok(n) = digits.chars().rev().collect::<String>().parse::<i32>() {
                result = n;
            }
        }
        rest = &rest[idx + keyword.len()..];
    }
    result
}

/// Lists the files changed by one commit.
///
/// `git log -m --first-parent` is used instead of `git diff-tree` because
/// diff-tree outputs NOTHING for merge commits by default (it needs `-m`),
/// which made merge-pull commits show an empty file list. `-m --first-parent`
/// shows the diff against the first parent only, matching what GitHub shows
/// for a merge commit ("files changed by this merge"), while staying
/// byte-identical to diff-tree for ordinary commits and full creation for the
/// root commit.
pub fn get_commit_files(repo_path: &str, hash: &str) -> Result<Vec<GitCommitFile>> {
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }

    let output = run_git_raw(
        repo_path,
        &[
            "log",
            "-m",
            "--first-parent",
            "--format=",
            "--name-status",
            "-1",
            hash,
        ],
    )?;

    let mut files: Vec<GitCommitFile> = Vec::new();

    for line in output.lines() {
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.splitn(2, '\t').collect();
        if parts.len() < 2 {
            continue;
        }

        files.push(GitCommitFile {
            status: parts[0].to_string(),
            path: parts[1].to_string(),
        });
    }

    Ok(files)
}

/// Get the full diff introduced by a single commit (`git show <hash>`).
///
/// Suppresses the commit-header/message output (`--format=`) so only the
/// patch remains. Binary files are detected the same way as `get_file_diff`.
pub fn get_commit_diff(repo_path: &str, hash: &str) -> Result<GitDiffResult> {
    if !is_git_repo(repo_path) {
        return Ok(GitDiffResult {
            content: String::new(),
            is_binary: false,
            error: String::new(),
        });
    }

    let args = vec!["show", "--format=", "--find-renames", "--no-ext-diff", hash];

    match run_git(repo_path, &args) {
        Ok(stdout) => {
            if stdout.contains("Binary files") {
                // `--text` 重试仅用于 git 误判文本为二进制的场景；结果
                // 有大小上限，真正的二进制文件（如图片）会 dump 出巨大
                // 乱码文本，超过上限即判定为二进制，避免渲染端卡死。
                let text_args = vec!["show", "--format=", "--text", "--no-ext-diff", hash];
                match run_git(repo_path, &text_args) {
                    Ok(text_diff)
                        if !text_diff.is_empty() && text_diff.len() <= MAX_TEXT_DIFF_BYTES =>
                    {
                        return Ok(GitDiffResult {
                            content: text_diff,
                            is_binary: false,
                            error: String::new(),
                        });
                    }
                    _ => {
                        return Ok(GitDiffResult {
                            content: "Binary file - diff not available".to_string(),
                            is_binary: true,
                            error: String::new(),
                        });
                    }
                }
            }

            Ok(GitDiffResult {
                content: stdout,
                is_binary: false,
                error: String::new(),
            })
        }
        Err(e) => Ok(GitDiffResult {
            content: String::new(),
            is_binary: false,
            error: format!("{e}"),
        }),
    }
}

/// Get the diff of a single file within a single commit
/// (`git log -m --first-parent -1 <hash> -- <path>`).
///
/// `git log -m --first-parent` is used instead of `git show` because `git show`
/// renders merge commits in combined format, which only lists files that
/// differ from ALL parents and is therefore empty for typical merge-pull
/// commits. `-m --first-parent` diffs against the first parent only, matching
/// the file list from `get_commit_files`. It still works for the root commit
/// (compares against the empty tree).
/// Binary files are detected the same way as `get_file_diff` / `get_commit_diff`.
pub fn get_commit_file_diff(repo_path: &str, hash: &str, file_path: &str) -> Result<GitDiffResult> {
    if !is_git_repo(repo_path) {
        return Ok(GitDiffResult {
            content: String::new(),
            is_binary: false,
            error: String::new(),
        });
    }

    let args = vec![
        "log",
        "-m",
        "--first-parent",
        "--format=",
        "--find-renames",
        "--no-ext-diff",
        "-p",
        "-1",
        hash,
        "--",
        file_path,
    ];

    match run_git(repo_path, &args) {
        Ok(stdout) => {
            if stdout.contains("Binary files") {
                // 已知图片扩展名：直接判定为二进制，绝不 `--text` 重试
                // （会 dump 出巨大乱码 patch，渲染端解析卡死）。
                if is_image_path(file_path) {
                    return Ok(GitDiffResult {
                        content: "Binary file - diff not available".to_string(),
                        is_binary: true,
                        error: String::new(),
                    });
                }
                let text_args = vec![
                    "log",
                    "-m",
                    "--first-parent",
                    "--format=",
                    "--text",
                    "--no-ext-diff",
                    "-p",
                    "-1",
                    hash,
                    "--",
                    file_path,
                ];
                match run_git(repo_path, &text_args) {
                    Ok(text_diff)
                        if !text_diff.is_empty() && text_diff.len() <= MAX_TEXT_DIFF_BYTES =>
                    {
                        return Ok(GitDiffResult {
                            content: text_diff,
                            is_binary: false,
                            error: String::new(),
                        });
                    }
                    _ => {
                        return Ok(GitDiffResult {
                            content: "Binary file - diff not available".to_string(),
                            is_binary: true,
                            error: String::new(),
                        });
                    }
                }
            }

            Ok(GitDiffResult {
                content: stdout,
                is_binary: false,
                error: String::new(),
            })
        }
        Err(e) => Ok(GitDiffResult {
            content: String::new(),
            is_binary: false,
            error: format!("{e}"),
        }),
    }
}
