use std::fs;
use std::path::Path;

use base64::Engine;
use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::remote_workspace::{
    execute_remote_workspace_command, is_ssh_path, RemoteWorkspaceCallback,
};

mod copy;
mod file_lock;
mod format;
mod fuzzy_edit;
mod io;
pub(crate) use snow_text::{office, text_codec};

use text_codec::{decode_text_bytes, encode_text, encode_text_back, encoding_for_label};

/// 模糊匹配的最低相似度阈值（0.0 ~ 1.0）。
/// 当 searchContent 与文件中某段内容相似度达到此值时，视为匹配成功。
/// 0.75 时误替换率偏高，抬高至 0.85 以降低 AI 转述内容被错误匹配的风险。
const FUZZY_MATCH_THRESHOLD: f64 = 0.85;

/// 编辑成功后，在响应中返回编辑区域前后各多少行上下文供 AI 复核。
const EDIT_REVIEW_CONTEXT_LINES: usize = 5;

/// 当 searchContent 不含行号前缀但文件内容含行号前缀（或反之）时，
/// 逐行剥离前缀后重试匹配。
const LINE_PREFIX_REGEX: &str = r"^\s*\d+[\s\|:]*";

/// 行级精确匹配比较：先按原始文本快速判定（无分配），不一致时再按
/// 「缩进敏感文件仅忽略 CRLF/LF 差异、普通文件压缩全部空白」的规则归一化比较。
fn line_matches_normalized(file_line: &str, search_line: &str, preserve_indentation: bool) -> bool {
    fuzzy_edit::line_matches_normalized(file_line, search_line, preserve_indentation)
}

pub struct FilesystemService;

impl FilesystemService {
    pub fn new() -> Self {
        FilesystemService
    }
}

const SERVER_ID: &str = "filesystem";

impl McpService for FilesystemService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "read".to_string(),
                description: "Read file content with line numbers. Supports text files, images, Office documents (pdf, docx, doc, xlsx, xls, xlsb, xlsm, ods, csv, pptx, ppt), and directories. Legacy .doc/.ppt files are extracted via system tools (macOS textutil, LibreOffice if installed) with a UTF-16 text scan fallback. Text file encoding is auto-detected (UTF-8, UTF-16/32 with BOM, GBK/GB18030, Big5, Shift_JIS, EUC-KR, windows-1252, etc.) and decoded to UTF-8. Office documents are extracted to plain text and can be very long - ALWAYS read them in chunks via startLine/endLine (e.g. read the first 100 lines first, then decide the next range based on the returned totalLines) instead of loading the whole document at once.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Path to the file to read or directory to list."
                        },
                        "startLine": {
                            "type": "number",
                            "description": "Optional starting line number (1-indexed). Pair with endLine to page through large files and Office documents."
                        },
                        "endLine": {
                            "type": "number",
                            "description": "Optional ending line number (1-indexed). Pair with startLine to page through large files and Office documents."
                        }
                    },
                    "required": ["filePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "replace_edit".to_string(),
                description: "Fuzzy search-and-replace editing. Finds searchContent in the file and replaces it with replaceContent. The file's original text encoding is auto-detected and preserved on write-back (the edited file keeps its original encoding and BOM). IMPORTANT: searchContent and replaceContent must be COPIED EXACTLY from the file's raw content. Do NOT include line number prefixes (like \\\"42:\\\") from read output, do NOT retype or paraphrase, and preserve every leading space/tab. For indentation-sensitive Python/YAML/Makefile files, indentation is syntax: exact and fuzzy matching retain line indentation. If searchContent is missing leading indentation on some lines, the tool automatically realigns it from the matched region and rebases replaceContent the same way; the edit is rejected with an explicit error only when the indentation intent is genuinely ambiguous. If the exact text is not found, a fuzzy match is attempted only without discarding indentation; on failure the error includes the closest matching region. On success the response includes a \\\"review\\\" field with the edited region plus surrounding context lines (edited lines marked with \\\">>>\\\") - always verify the edit landed correctly. When the auto-format setting is enabled (default), the file is queued for automatic Prettier formatting that runs once this batch of edits stops writing the file; the response marks \\\"formatPending\\\": true. Formatting can reflow the whole file, so re-read it before issuing further edits from memory. ESCAPE SEQUENCES: text inside string literals (e.g. Rust/Python/JSON source) stores escapes like \\\\n, \\\\t, \\\\\\\", \\\\\\\\ as literal backslash + character pairs in the file. When searchContent or replaceContent touches such text, keep the escapes in their literal form exactly as shown by filesystem-read output - never convert a literal backslash-n into a real newline, and never convert a real newline into a literal \\\\n. Use a real newline only when the file actually contains one; use a literal escape sequence only when the file text shows that escape.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Path to the file to edit."
                        },
                        "searchContent": {
                            "type": "string",
                            "description": "The EXACT raw source text to find in the file. Do NOT include line number prefixes from read output. Copy verbatim from the file content. If the file text contains escape sequences (like \\n, \\t, \\\" inside string literals), copy them as literal backslash + character text - do NOT convert them to real newlines/tabs/quotes."
                        },
                        "replaceContent": {
                            "type": "string",
"description": "New content to replace with. Preserve every required leading space/tab, especially for Python/YAML/Makefile. Missing leading indentation is auto-corrected from the matched region; the edit is rejected only when the indentation intent is ambiguous, to prevent silent syntax damage. Match the file's escape style: write a literal backslash-n (two characters) when the file should keep an escape sequence like \\n; write a real newline only when the file actually uses real newlines."
                        },
                        "occurrence": {
                            "type": "number",
                            "description": "Which match to replace if multiple found (1-indexed, default 1)."
                        }
                    },
                    "required": ["filePath", "searchContent", "replaceContent"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "create".to_string(),
                description: "Create a new file with content. Automatically creates parent directories if needed. If the file already exists, an error is returned with the current file size and line count - use overwrite=true to replace it, or use replace_edit instead to modify the existing file. The optional encoding parameter (default: utf-8) controls the file's byte encoding, e.g. gbk, gb18030, big5, shift_jis, euc-kr, utf-16le, utf-16be, windows-1252. When auto-format is enabled the new file is queued for automatic Prettier formatting that runs once this batch of edits stops writing it.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Path where the file should be created."
                        },
                        "content": {
                            "type": "string",
                            "description": "Content to write to the file."
                        },
                        "overwrite": {
                            "type": "boolean",
                            "description": "Whether to overwrite the file if it already exists (default false)."
                        },
                        "encoding": {
                            "type": "string",
                            "description": "Byte encoding of the created file (default utf-8). Supports encoding labels like gbk, gb18030, big5, shift_jis, euc-kr, utf-16le, utf-16be, windows-1252."
                        }
                    },
                    "required": ["filePath", "content","overwrite"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "copy".to_string(),
                description: "Copy or cut a line range from one file (source) into another file (target), or into another position of the same file, WITHOUT retyping the content: only line numbers are transmitted, so no output tokens are spent on reproducing the code and every moved line stays byte-exact (no paraphrase, no re-indentation). Prefer it over filesystem-replace_edit whenever the destination text already exists somewhere on disk. HOW TO USE: 1) locate the source range with grep-search / filesystem-read (line numbers are 1-indexed and inclusive; omit sourceEndLine to copy a single line); 2) choose the target position: mode=insert (default) inserts before targetLine (position=before, default) or right after it (position=after), and appends at the end of the file when targetLine is omitted; mode=replace overwrites the inclusive range targetLine..targetEndLine; mode=delete removes the inclusive range sourceStartLine..sourceEndLine from sourceFilePath without pasting it anywhere (filePath must be that same file; targetLine, targetEndLine and position must be omitted). 3) set deleteSource=true to CUT (move) the lines instead of copying them - the source range is removed from the source file within the same call, and the source file is kept even when it becomes empty. All line numbers refer to the files BEFORE this operation. A missing target file is created together with its parent directories and inherits the encoding, BOM and line-ending style of the source file; an existing target keeps its own encoding, BOM, line-ending style and trailing-newline state. Overlapping source/target ranges inside one file, and operations that would change nothing, are rejected with an explicit error. On success the response reports where the lines landed (matchedLineStart / matchedLineEnd in the written file, totalLines), returns pastedContent and replacedContent (the target lines that were overwritten) for diff display, and for a cut also removedContent (only when the source is a different file) plus sourceReview with the context around the removal. The review block carries the pasted region with surrounding context lines (pasted lines marked with >>>): verify it instead of reading the file again. omittedLines > 0 means a very large region was elided in the payload. When auto-format is enabled the file is queued for automatic Prettier formatting that runs once this batch of edits stops writing it; the response marks formatPending=true. Formatting can reflow the whole file, so re-read it before issuing further edits from memory. EXAMPLES: copy lines 40-60 of a.ts to the end of b.ts -> {sourceFilePath: a.ts, sourceStartLine: 40, sourceEndLine: 60, filePath: b.ts}; insert them before line 12 of b.ts -> {sourceFilePath: a.ts, sourceStartLine: 40, sourceEndLine: 60, filePath: b.ts, targetLine: 12}; move lines 40-60 of a.ts into b.ts after line 5 -> {sourceFilePath: a.ts, sourceStartLine: 40, sourceEndLine: 60, filePath: b.ts, targetLine: 5, position: after, deleteSource: true}; overwrite lines 12-30 of b.ts with them -> {filePath: b.ts, mode: replace, targetLine: 12, targetEndLine: 30, sourceFilePath: a.ts, sourceStartLine: 40, sourceEndLine: 60}.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "sourceFilePath": {
                            "type": "string",
                            "description": "Path of the file the lines are copied from."
                        },
                        "sourceStartLine": {
                            "type": "number",
                            "description": "First line of the source range (1-indexed, inclusive)."
                        },
                        "sourceEndLine": {
                            "type": "number",
                            "description": "Last line of the source range (1-indexed, inclusive). Defaults to sourceStartLine; swapped when smaller than sourceStartLine and clamped to the source file's last line."
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Path of the target file that receives the lines (the file that gets modified or created)."
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["insert", "replace", "delete"],
                            "description": "insert (default): insert the lines at targetLine. replace: overwrite the targetLine..targetEndLine range. delete: remove the sourceStartLine..sourceEndLine range from sourceFilePath with nothing pasted; filePath must be the same file, and targetLine, targetEndLine and position must be omitted."
                        },
                        "targetLine": {
                            "type": "number",
                            "description": "Anchor line in the target file (1-indexed, referring to the file BEFORE this operation). Insert mode: insert before it (or after it with position=after); omit it to append at the end of the file. Replace mode: first line to overwrite (required)."
                        },
                        "targetEndLine": {
                            "type": "number",
                            "description": "Replace mode only (required): last line to overwrite (1-indexed, inclusive). Swapped when smaller than targetLine and clamped to the target file's last line. Rejected in insert mode so a forgotten mode cannot silently duplicate content."
                        },
                        "position": {
                            "type": "string",
                            "enum": ["before", "after"],
                            "description": "Insert mode only (default before): insert before or right after targetLine. Rejected in replace mode."
                        },
                        "deleteSource": {
                            "type": "boolean",
                            "description": "true = cut (move): remove the source range from the source file after pasting. Default false keeps the source file untouched."
                        }
                    },
                    "required": ["sourceFilePath", "sourceStartLine", "filePath"]
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        match tool_name {
            "read" => self.execute_read(args),
            "replace_edit" => self.execute_replace_edit(args),
            "create" => self.execute_create(args),
            "copy" => copy::execute(args),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{}\" for MCP server \"filesystem\". Available tools: [filesystem-read, filesystem-replace_edit, filesystem-create, filesystem-copy]",
                    tool_name
                ),
            )),
        }
    }
}

impl FilesystemService {
    /// 把仍在等待自动格式化的文件立即落盘（应用退出前调用，避免退出时丢掉
    /// 延迟执行的格式化）。
    pub async fn flush_pending_formats() {
        format::flush_all().await;
    }

    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        on_remote_workspace_command: &RemoteWorkspaceCallback,
        cancel_token: Option<&CancellationToken>,
    ) -> napi::Result<Value> {
        let file_path = args
            .get("filePath")
            .and_then(Value::as_str)
            .map(io::normalize_path);
        if file_path.as_deref().is_some_and(is_ssh_path) {
            return execute_remote_workspace_command(
                on_remote_workspace_command,
                &format!("filesystem-{tool_name}"),
                args,
                cancel_token,
            )
            .await;
        }

        // 观察点：读取前先把该文件的待格式化落盘，保证模型读到的就是磁盘
        // 最终态 —— 否则基于它发起的后续编辑会匹配不到被重排过的正文。
        if tool_name == "read" {
            if let Some(path) = file_path.as_deref() {
                format::flush_path(path).await;
            }
        }

        // 写文件类工具：先登记「在途写」，再按路径加锁，全程串行同一文件的
        // 「读取 -> 计算 -> 写盘」。顺序很关键：延迟格式化调度器拿到同一把
        // 锁后会复查在途写并主动让位，因此同一批工具调用里的第二次编辑永远
        // 不会读到被格式化重排过的内容（并行调用也不会互相覆盖）。
        // 剪切会同时改写源文件与目标文件，两把锁按路径排序后依次获取，
        // 避免两次交叉剪切互相等待。
        let write_paths = write_target_paths(tool_name, args, file_path.as_deref());
        // A conflicting tracking window must not block the actual file write.
        // Its observation marker remains live, but only explicit operation
        // evidence may be reported when that marker is contaminated.
        let tracking_lease = if write_paths.is_empty() {
            None
        } else {
            crate::mcp::tools::file_tracking::coordinate(
                &write_paths,
                crate::mcp::tools::file_tracking::LeaseClass::Writer,
                crate::mcp::tools::file_tracking::WRITER_LEASE_WAIT,
            )
            .await
        };
        let mut _in_flight_writes = Vec::with_capacity(write_paths.len());
        let mut _write_permits = Vec::with_capacity(write_paths.len());
        for path in &write_paths {
            _in_flight_writes.push(file_lock::InFlightWrite::acquire(path));
            _write_permits.push(file_lock::file_write_lock(path).lock_owned().await);
        }
        if !write_paths.is_empty() {
            // 延迟格式化调度器按需启动；刷新写入静默窗口，让同一批编辑
            // 期间的格式化继续让位。
            format::ensure_worker().await;
            for path in &write_paths {
                format::note_write_start(path);
            }
        }

        self.execute_local(tool_name, args, &write_paths, tracking_lease)
            .await
    }

    /// 本地执行：同步 IO 与模糊匹配放入 blocking pool；写文件类工具成功后
    /// 按全局开关登记延迟格式化（由 format.rs 的后台任务合并执行）。
    async fn execute_local(
        &self,
        tool_name: &str,
        args: &Value,
        write_paths: &[String],
        tracking_lease: Option<std::sync::Arc<crate::mcp::tools::file_tracking::WriteLease>>,
    ) -> napi::Result<Value> {
        // 本地文件系统读写、编码转换和模糊匹配都是同步操作，必须放进
        // Tokio blocking pool，不能占用承载 Electron N-API Promise 的异步线程。
        let tool_name_owned = tool_name.to_owned();
        let args_owned = args.clone();
        let tracking_paths = write_paths.to_vec();
        let blocking_lease = tracking_lease.clone();
        let mut result = tokio::task::spawn_blocking(move || {
            let _lease = blocking_lease;
            // Successful explicit writes remain evidence even without isolation.
            let before = crate::mcp::tools::file_tracking::filesystem_before(&tracking_paths);
            let mut result = FilesystemService::new().execute(&tool_name_owned, &args_owned)?;
            if matches!(tool_name_owned.as_str(), "create" | "replace_edit" | "copy") {
                // Keep legacy path fields, but make their values agree with the
                // physical identity in the tracking envelope (including symlinks).
                for field in ["path", "filePath", "targetFilePath", "sourceFilePath"] {
                    if let Some(path) = result
                        .get(field)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                    {
                        if let Some(path) =
                            crate::mcp::tools::file_tracking::physical_path(Path::new(&path))
                        {
                            result[field] =
                                Value::String(crate::mcp::tools::file_tracking::path_string(&path));
                        }
                    }
                }
                if tool_name_owned == "copy" {
                    result["filePath"] = result["targetFilePath"].clone();
                }
                let isolated = _lease.as_ref().is_some_and(|lease| !lease.is_contaminated());
                result["fileTracking"] = crate::mcp::tools::file_tracking::filesystem_after(
                    before,
                    &result,
                    tracking_paths.len(),
                    isolated,
                );
                // Contention can start while metadata is being observed. Do not
                // publish create/delete inference from such a racing window.
                if isolated && _lease.as_ref().is_some_and(|lease| lease.is_contaminated()) {
                    let tracking = &mut result["fileTracking"];
                    tracking["coverage"] = json!("partial");
                    if let Some(reasons) = tracking["reasons"].as_array_mut() {
                        reasons.push(json!("concurrent-execution"));
                        reasons.push(json!("operation-evidence-only"));
                    }
                    if let Some(files) = tracking["files"].as_array_mut() {
                        for file in files {
                            file["kind"] = json!("edit");
                        }
                    }
                }
            }
            Ok::<_, napi::Error>(result)
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Filesystem tool task failed: {error}"),
            )
        })??;

        // 模型自己写入的内容无需回传：review 已给出编辑后的真实布局，
        // 重复回传只会白占上下文。
        if let Some(object) = result.as_object_mut() {
            object.remove("editedContent");
        }

        // 写文件成功后按全局开关（默认开启）登记自动格式化：格式化由后台
        // 任务在该文件停止写入后执行，失败（未安装 prettier / 无 node /
        // 不支持的类型等）静默跳过，绝不回退已成功的写入结果。
        if !write_paths.is_empty() && format::auto_format_enabled().await {
            let mut scheduled = false;
            for path in write_paths {
                scheduled |= format::schedule(path);
            }
            if scheduled {
                if let Some(object) = result.as_object_mut() {
                    object.insert("formatPending".to_string(), json!(true));
                }
            }
        }

        Ok(result)
    }

    fn execute_read(&self, args: &Value) -> napi::Result<Value> {
        let file_path = args
            .get("filePath")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                let keys: Vec<String> = args
                    .as_object()
                    .map(|object| object.keys().cloned().collect())
                    .unwrap_or_default();
                Error::new(
                    Status::InvalidArg,
                    format!(
                        "filePath is required for tool \"filesystem-read\". Received keys: [{}]. Please provide a valid file path.",
                        keys.join(", ")
                    ),
                )
            })?;

        let start_line = args.get("startLine").and_then(|value| value.as_u64());
        let end_line = args.get("endLine").and_then(|value| value.as_u64());

        io::read_path(file_path, start_line, end_line)
    }

    fn execute_replace_edit(&self, args: &Value) -> napi::Result<Value> {
        let file_path = io::normalize_path(
            args
                .get("filePath")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    let keys: Vec<String> = args.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
                    Error::new(
                        Status::InvalidArg,
                        format!(
                            "filePath is required for tool \"filesystem-replace_edit\". Received keys: [{}]. Please provide a valid file path.",
                            keys.join(", ")
                        ),
                    )
                })?,
        );

        let search_content = args
            .get("searchContent")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "searchContent is required for tool \"filesystem-replace_edit\". Please provide the content to search for in the file.".to_string(),
                )
            })?;

        if search_content.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "searchContent must be a non-empty string for tool \"filesystem-replace_edit\"."
                    .to_string(),
            ));
        }

        let replace_content = args
            .get("replaceContent")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "replaceContent is required for tool \"filesystem-replace_edit\". Please provide the new content to replace with.".to_string(),
                )
            })?;

        let occurrence = args
            .get("occurrence")
            .and_then(|v| v.as_u64())
            .map(|o| o as usize)
            .unwrap_or(1);

        // 按字节读取并自动检测文件原始编码，统一解码为 UTF-8 后在字符串上编辑，
        // 写回时再转回原始编码（含 BOM），保证非 UTF-8 文件编辑后编码不变。
        let bytes = fs::read(&file_path).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read file: {} (path: {})", e, file_path),
            )
        })?;
        let decoded = decode_text_bytes(&bytes).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to decode file as text: {} (path: {})", e, file_path),
            )
        })?;
        let content = decoded.text;
        let original_encoding = decoded.encoding;
        let had_bom = decoded.had_bom;

        // 检测文件主要使用的行尾风格，并将 replace_content 适配为相同风格，
        // 避免在 CRLF 文件中插入 LF 行尾导致混合行尾。
        let replace_content = fuzzy_edit::adapt_line_endings(replace_content, &content);

        // 全程使用 split('\n') 而非 lines()，保留 \r 在行内容中。
        // 匹配时用 normalize_whitespace 比较（忽略空白差异含 \r），
        // 替换时用 splice 在行数组上操作，天然保持文件原有行尾风格。
        let file_lines: Vec<&str> = content.split('\n').collect();
        let total_lines = file_lines.len();
        let preserve_indentation = fuzzy_edit::is_indentation_sensitive_path(&file_path);

        // 缩进敏感文件只允许逐字保留行首空白的匹配；行号前缀变体会吞掉
        // 前导空格，不能参与 Python/YAML/Makefile 的匹配。
        let search_content_stripped = if preserve_indentation {
            None
        } else {
            fuzzy_edit::try_strip_line_prefixes(search_content)
        };
        let variants: Vec<(&str, Vec<&str>)> =
            vec![("exact", search_content.split('\n').collect())]
                .into_iter()
                .chain(
                    search_content_stripped
                        .as_ref()
                        .map(|s| ("exact_after_stripping_prefixes", s.split('\n').collect())),
                )
                .collect();

        // Step 1: 精确行级匹配
        // 在 file_lines 中查找与 search 某个变体完全相同的行序列（归一化比较）。
        for (match_type, search_lines) in &variants {
            let search_line_count = search_lines.len();
            if search_line_count == 0 || search_line_count > file_lines.len() {
                continue;
            }

            // 收集所有匹配位置。缩进敏感文件只忽略 CRLF/LF 差异，
            // 不能把行首空格压平后再比较。先按首行筛选候选，再校验其余行：
            // 原实现对每个起始位置重复归一化全部 m 行，候选过滤后降为
            // O(n + k·m)，避免大文件下 O(n·m) 次字符串归一化分配。
            let first_search_line = search_lines[0];
            let mut match_positions: Vec<usize> = Vec::new();
            for start in 0..=(file_lines.len() - search_line_count) {
                if !line_matches_normalized(
                    file_lines[start],
                    first_search_line,
                    preserve_indentation,
                ) {
                    continue;
                }
                let rest_match = search_lines[1..]
                    .iter()
                    .enumerate()
                    .all(|(offset, &sline)| {
                        line_matches_normalized(
                            file_lines[start + 1 + offset],
                            sline,
                            preserve_indentation,
                        )
                    });
                if rest_match {
                    match_positions.push(start);
                }
            }

            if let Some(&target_start) = match_positions.get(occurrence.saturating_sub(1)) {
                let end_line = target_start + search_line_count;

                let effective_replacement = fuzzy_edit::pad_replacement_to_match(
                    &file_path,
                    &file_lines,
                    target_start,
                    end_line,
                    &replace_content,
                )
                .map_err(|message| Error::new(Status::InvalidArg, message))?;

                let replacement_lines = fuzzy_edit::split_replacement_lines(&effective_replacement);
                let replacement_line_count = replacement_lines.len();
                let mut new_lines: Vec<String> = file_lines.iter().map(|s| s.to_string()).collect();
                new_lines.splice(target_start..end_line, replacement_lines);
                let new_content = new_lines.join("\n");

                // 0 修改检测：替换后的内容与原文完全一致时拒绝写盘并给出缩进调整指引，
                // 避免 AI 因 searchContent/replaceContent 内容等价（如调整缩进失败）而静默"成功0修改"。
                if new_content == content {
                    let error_msg = fuzzy_edit::build_noop_edit_error(
                        &file_path,
                        search_content,
                        &effective_replacement,
                        &file_lines,
                        total_lines,
                    );
                    return Err(Error::new(Status::GenericFailure, error_msg));
                }

                let new_bytes =
                    encode_text_back(&new_content, original_encoding, had_bom).map_err(|e| {
                        Error::new(
                            Status::GenericFailure,
                            format!(
                                "Failed to encode edited content back to original encoding: {} (path: {})",
                                e, file_path
                            ),
                        )
                    })?;
                fs::write(&file_path, &new_bytes).map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to write file: {} (path: {})", e, file_path),
                    )
                })?;

                let review = fuzzy_edit::build_edit_review_context_lines(
                    &new_content,
                    target_start,
                    (replacement_line_count > 0)
                        .then_some(target_start + replacement_line_count - 1),
                );

                return Ok(json!({
                    "success": true,
                    "totalMatches": match_positions.len(),
                    "occurrence": occurrence,
                    "matchType": match_type,
                    "matchedLineStart": target_start + 1,
                    "matchedLineEnd": end_line,
                    "editedContent": effective_replacement,
                    "review": review
                }));
            }
        }

        // Step 1.5: 字面子串匹配
        // 覆盖 search_content 只是某一行片段（例如超长单行字符串中的一段）或
        // 跨行片段的场景，这是整行精确/模糊匹配无法命中的情况。
        if let Some((new_content, edit_start_line, edit_end_line, total_matches)) =
            fuzzy_edit::try_substring_replace(
                &file_path,
                &content,
                search_content,
                &replace_content,
                occurrence,
                preserve_indentation,
            )
            .map_err(|message| Error::new(Status::InvalidArg, message))?
        {
            // 0 修改检测：子串替换后内容与原文一致同样拒绝写盘。
            if new_content == content {
                let error_msg = fuzzy_edit::build_noop_edit_error(
                    &file_path,
                    search_content,
                    &replace_content,
                    &file_lines,
                    total_lines,
                );
                return Err(Error::new(Status::GenericFailure, error_msg));
            }

            let new_bytes =
                encode_text_back(&new_content, original_encoding, had_bom).map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!(
                            "Failed to encode edited content back to original encoding: {} (path: {})",
                            e, file_path
                        ),
                    )
                })?;
            fs::write(&file_path, &new_bytes).map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to write file: {} (path: {})", e, file_path),
                )
            })?;

            let replacement_line_count = fuzzy_edit::replacement_line_count(&replace_content);
            let review = fuzzy_edit::build_edit_review_context_lines(
                &new_content,
                edit_start_line,
                (replacement_line_count > 0)
                    .then_some(edit_start_line + replacement_line_count - 1),
            );

            return Ok(json!({
                "success": true,
                "totalMatches": total_matches,
                "occurrence": occurrence,
                "matchType": "substring",
                "matchedLineStart": edit_start_line + 1,
                "matchedLineEnd": edit_end_line + 1,
                "editedContent": replace_content,
                "review": review
            }));
        }

        // Step 1.6: 缩进宽松整行匹配（仅缩进敏感文件）
        // searchContent 整块丢失/错配行首缩进（精确与子串匹配均无法命中）时，
        // 按「去行首空白后逐行相等」定位命中区域，并把 replaceContent 重新
        // 定基到命中区域的首行缩进，避免可直接恢复的编辑被拒绝。
        if preserve_indentation {
            if let Some(relaxed) = fuzzy_edit::find_indentation_relaxed_match(
                search_content,
                &replace_content,
                &file_lines,
                occurrence,
            ) {
                let replacement_lines = fuzzy_edit::split_replacement_lines(&relaxed.replacement);
                let replacement_line_count = replacement_lines.len();
                let mut new_lines: Vec<String> = file_lines.iter().map(|s| s.to_string()).collect();
                new_lines.splice(relaxed.start_line..relaxed.end_line, replacement_lines);
                let new_content = new_lines.join("\n");

                // 0 修改检测：缩进宽松匹配替换后内容与原文一致同样拒绝写盘。
                if new_content == content {
                    let error_msg = fuzzy_edit::build_noop_edit_error(
                        &file_path,
                        search_content,
                        &relaxed.replacement,
                        &file_lines,
                        total_lines,
                    );
                    return Err(Error::new(Status::GenericFailure, error_msg));
                }

                let new_bytes =
                    encode_text_back(&new_content, original_encoding, had_bom).map_err(|e| {
                        Error::new(
                            Status::GenericFailure,
                            format!(
                                "Failed to encode edited content back to original encoding: {} (path: {})",
                                e, file_path
                            ),
                        )
                    })?;
                fs::write(&file_path, &new_bytes).map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to write file: {} (path: {})", e, file_path),
                    )
                })?;

                let review = fuzzy_edit::build_edit_review_context_lines(
                    &new_content,
                    relaxed.start_line,
                    (replacement_line_count > 0)
                        .then_some(relaxed.start_line + replacement_line_count - 1),
                );

                return Ok(json!({
                    "success": true,
                    "totalMatches": relaxed.total_matches,
                    "occurrence": occurrence,
                    "matchType": "indentation_relaxed",
                    "matchedLineStart": relaxed.start_line + 1,
                    "matchedLineEnd": relaxed.end_line,
                    "editedContent": relaxed.replacement,
                    "review": review
                }));
            }
        }

        // Step 2: 模糊行匹配（基于 Levenshtein 距离 + 变窗口 + 预过滤）
        let fuzzy_match =
            fuzzy_edit::find_best_line_match_v2(search_content, &file_lines, preserve_indentation);
        if let Some((start_line, end_line, similarity)) = fuzzy_match {
            if similarity >= FUZZY_MATCH_THRESHOLD {
                let effective_replacement = fuzzy_edit::pad_replacement_to_match(
                    &file_path,
                    &file_lines,
                    start_line,
                    end_line,
                    &replace_content,
                )
                .map_err(|message| Error::new(Status::InvalidArg, message))?;

                let replacement_lines = fuzzy_edit::split_replacement_lines(&effective_replacement);
                let replacement_line_count = replacement_lines.len();
                let mut new_lines: Vec<String> = file_lines.iter().map(|s| s.to_string()).collect();
                new_lines.splice(start_line..end_line, replacement_lines);
                let new_content = new_lines.join("\n");

                // 0 修改检测：模糊匹配替换后内容与原文一致同样拒绝写盘。
                if new_content == content {
                    let error_msg = fuzzy_edit::build_noop_edit_error(
                        &file_path,
                        search_content,
                        &effective_replacement,
                        &file_lines,
                        total_lines,
                    );
                    return Err(Error::new(Status::GenericFailure, error_msg));
                }

                let new_bytes =
                    encode_text_back(&new_content, original_encoding, had_bom).map_err(|e| {
                        Error::new(
                            Status::GenericFailure,
                            format!(
                                "Failed to encode edited content back to original encoding: {} (path: {})",
                                e, file_path
                            ),
                        )
                    })?;
                fs::write(&file_path, &new_bytes).map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to write file: {} (path: {})", e, file_path),
                    )
                })?;

                let review = fuzzy_edit::build_edit_review_context_lines(
                    &new_content,
                    start_line,
                    (replacement_line_count > 0).then_some(start_line + replacement_line_count - 1),
                );

                return Ok(json!({
                    "success": true,
                    "matchType": "fuzzy",
                    "similarity": similarity,
                    "matchedLineStart": start_line + 1,
                    "matchedLineEnd": end_line,
                    "totalLines": total_lines,
                    "editedContent": effective_replacement,
                    "review": review
                }));
            }
        }

        // Step 3: 所有匹配策略均失败 - 复用 Step 2 的扫描结果构建详细错误
        // （原实现会在此重复执行一次全量模糊扫描，未命中路径耗时翻倍）。
        let error_msg = fuzzy_edit::build_search_not_found_error_v2(
            search_content,
            &file_lines,
            &file_path,
            total_lines,
            fuzzy_match,
        );

        Err(Error::new(Status::GenericFailure, error_msg))
    }

    fn execute_create(&self, args: &Value) -> napi::Result<Value> {
        let file_path = io::normalize_path(
            args
                .get("filePath")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    let keys: Vec<String> = args.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
                    Error::new(
                        Status::InvalidArg,
                        format!(
                            "filePath is required for tool \"filesystem-create\". Received keys: [{}]. Please provide a valid file path.",
                            keys.join(", ")
                        ),
                    )
                })?,
        );

        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| Error::new(Status::InvalidArg, "content is required for tool \"filesystem-create\". Please provide the content to write to the file.".to_string()))?;

        let overwrite = args
            .get("overwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // 可选的输出编码（默认 UTF-8）。无效 label 直接报错，避免静默回退。
        let encoding = args
            .get("encoding")
            .and_then(|v| v.as_str())
            .map(|label| {
                encoding_for_label(label).ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        format!(
                            "Unsupported encoding label: \"{}\". Supported labels include: utf-8, gbk, gb18030, big5, shift_jis, euc-kr, utf-16le, utf-16be, windows-1252.",
                            label
                        ),
                    )
                })
            })
            .transpose()?
            .unwrap_or(encoding_rs::UTF_8);

        let path = Path::new(&file_path);

        if path.exists() && !overwrite {
            let file_size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            let line_count = fs::read(path)
                .map(|bytes| {
                    // 行数仅为错误信息参考，用 lossy 解码避免非 UTF-8 文件统计失败。
                    String::from_utf8_lossy(&bytes).lines().count()
                })
                .unwrap_or(0);
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "File already exists: {} ({} bytes, {} lines). To overwrite this file, set overwrite=true. To modify the existing file, use filesystem-replace_edit instead.",
                    file_path, file_size, line_count
                ),
            ));
        }

        if let Some(parent) = path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to create directories: {} (path: {})", e, file_path),
                    )
                })?;
            }
        }

        // 将 UTF-8 内容按指定编码转为字节后写入。
        let bytes = encode_text(content, encoding).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to encode content to \"{}\": {} (path: {})",
                    encoding.name(),
                    e,
                    file_path
                ),
            )
        })?;

        fs::write(path, &bytes).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to write file: {} (path: {})", e, file_path),
            )
        })?;

        let byte_count = bytes.len();
        let line_count = content.lines().count();

        Ok(json!({
            "success": true,
            "path": file_path,
            "bytes": byte_count,
            "lines": line_count
        }))
    }
}

/// 本次调用会改写的文件路径（去重后按路径排序）：替换编辑与新文件只写目标
/// 文件；剪切会同时改写源文件，因此源与目标都要登记加锁。
fn write_target_paths(tool_name: &str, args: &Value, file_path: Option<&str>) -> Vec<String> {
    match tool_name {
        "replace_edit" | "create" => file_path
            .map(|path| vec![path.to_string()])
            .unwrap_or_default(),
        "copy" => {
            let mut paths: Vec<String> = copy::write_lock_paths(args)
                .into_iter()
                .map(io::normalize_path)
                .collect();
            paths.sort_unstable();
            paths.dedup();
            paths
        }
        _ => Vec::new(),
    }
}
