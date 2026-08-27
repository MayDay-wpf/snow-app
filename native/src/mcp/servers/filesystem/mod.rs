use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use base64::Engine;
use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::remote_workspace::{
    execute_remote_workspace_command, is_ssh_path, RemoteWorkspaceCallback,
};

mod office;
mod text_codec;
mod fuzzy_edit;
mod io;

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

/// 写文件类工具按完整路径持有的互斥锁表，
/// 保证同一文件「读取 -> 计算 -> 写盘 -> 格式化」全程串行。
type FileWriteLockMap = HashMap<String, Arc<AsyncMutex<()>>>;

static FILE_WRITE_LOCKS: OnceLock<std::sync::Mutex<FileWriteLockMap>> = OnceLock::new();

fn file_write_lock(file_path: &str) -> Arc<AsyncMutex<()>> {
    let locks = FILE_WRITE_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    map.entry(file_path.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// Prettier 会整体改变行数，格式化后需在结果中重新定位编辑区。
/// 仅用于行号对齐，低于编辑替换阈值属正常现象。
const FORMATTED_ALIGN_THRESHOLD: f64 = 0.6;

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
                description: "Fuzzy search-and-replace editing. Finds searchContent in the file and replaces it with replaceContent. The file's original text encoding is auto-detected and preserved on write-back (the edited file keeps its original encoding and BOM). IMPORTANT: searchContent and replaceContent must be COPIED EXACTLY from the file's raw content. Do NOT include line number prefixes (like \\\"42:\\\") from read output, do NOT retype or paraphrase, and preserve every leading space/tab. For indentation-sensitive Python/YAML/Makefile files, indentation is syntax: exact and fuzzy matching retain line indentation, and the edit is rejected with an explicit error if replaceContent's leading indentation differs from the matched region. This tool never silently changes indentation. If the exact text is not found, a fuzzy match is attempted only without discarding indentation; on failure the error includes the closest matching region. On success the response includes a \\\"review\\\" field with the edited region plus surrounding context lines (edited lines marked with \\\">>>\\\") - always verify the edit landed correctly. When the auto-format setting is enabled (default), the edited file is automatically formatted with Prettier afterwards and the response marks \\\"formatted\\\": true. ESCAPE SEQUENCES: text inside string literals (e.g. Rust/Python/JSON source) stores escapes like \\\\n, \\\\t, \\\\\\\", \\\\\\\\ as literal backslash + character pairs in the file. When searchContent or replaceContent touches such text, keep the escapes in their literal form exactly as shown by filesystem-read output - never convert a literal backslash-n into a real newline, and never convert a real newline into a literal \\\\n. Use a real newline only when the file actually contains one; use a literal escape sequence only when the file text shows that escape.".to_string(),
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
                            "description": "New content to replace with. Preserve every required leading space/tab, especially for Python/YAML/Makefile. If its first non-empty line's indentation differs from the matched region, the edit is rejected to prevent silent syntax damage. Match the file's escape style: write a literal backslash-n (two characters) when the file should keep an escape sequence like \\n; write a real newline only when the file actually uses real newlines."
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
                description: "Create a new file with content. Automatically creates parent directories if needed. If the file already exists, an error is returned with the current file size and line count - use overwrite=true to replace it, or use replace_edit instead to modify the existing file. The optional encoding parameter (default: utf-8) controls the file's byte encoding, e.g. gbk, gb18030, big5, shift_jis, euc-kr, utf-16le, utf-16be, windows-1252.".to_string(),
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
        ]
    }

    fn execute(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        match tool_name {
            "read" => self.execute_read(args),
            "replace_edit" => self.execute_replace_edit(args),
            "create" => self.execute_create(args),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{}\" for MCP server \"filesystem\". Available tools: [filesystem-read, filesystem-replace_edit, filesystem-create]",
                    tool_name
                ),
            )),
        }
    }
}

impl FilesystemService {
    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        on_remote_workspace_command: &RemoteWorkspaceCallback,
        cancel_token: Option<&CancellationToken>,
    ) -> napi::Result<Value> {
        let file_path = args.get("filePath").and_then(Value::as_str);
        if file_path.is_some_and(is_ssh_path) {
            return execute_remote_workspace_command(
                on_remote_workspace_command,
                &format!("filesystem-{tool_name}"),
                args,
                cancel_token,
            )
            .await;
        }

        // 写文件类工具对同一文件全程加锁：并行调用若各自基于同一份旧
        // 内容计算再先后写盘，会互相覆盖或与格式化交错导致误报 not found。
        let write_guard = if matches!(tool_name, "replace_edit" | "create") {
            file_path.map(|path| file_write_lock(path))
        } else {
            None
        };
        // 锁须覆盖整个「读取 -> 计算 -> 写盘 -> 格式化」生命周期。
        let _write_permit = match write_guard.as_deref() {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };

        self.execute_local(tool_name, args, file_path).await
    }

    /// 本地执行：同步 IO 与模糊匹配放入 blocking pool；replace_edit 成功
    /// 后按全局开关自动 Prettier 格式化并重建反馈结果。
    async fn execute_local(
        &self,
        tool_name: &str,
        args: &Value,
        local_file_path: Option<&str>,
    ) -> napi::Result<Value> {
        // 本地文件系统读写、编码转换和模糊匹配都是同步操作，必须放进
        // Tokio blocking pool，不能占用承载 Electron N-API Promise 的异步线程。
        let tool_name_owned = tool_name.to_owned();
        let args_owned = args.clone();
        let mut result = tokio::task::spawn_blocking(move || {
            FilesystemService::new().execute(&tool_name_owned, &args_owned)
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Filesystem tool task failed: {error}"),
            )
        })??;

        if tool_name != "replace_edit" {
            return Ok(result);
        }

        // 编辑成功后按全局开关（默认开启）自动用 Prettier 格式化。
        // 格式化失败（未安装 prettier / 无 node / 不支持的类型等）静默
        // 跳过，绝不回退已成功的编辑结果。
        if let Some(file_path) = local_file_path {
            let auto_format = tokio::task::spawn_blocking(crate::storage::get_auto_format)
                .await
                .ok()
                .and_then(|result| result.ok())
                .unwrap_or(true);
            if auto_format {
                if let Some(formatted_content) =
                    format_file_with_prettier(Path::new(file_path)).await
                {
                    rebuild_result_after_format(&mut result, file_path, &formatted_content);
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
                "searchContent must be a non-empty string for tool \"filesystem-replace_edit\".".to_string(),
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
            // 不能把行首空格压平后再比较。
            let mut match_positions: Vec<usize> = Vec::new();
            for start in 0..=(file_lines.len() - search_line_count) {
                let all_match = search_lines.iter().enumerate().all(|(i, &sline)| {
                    if preserve_indentation {
                        fuzzy_edit::normalize_line_endings_for_match(&file_lines[start + i])
                            == fuzzy_edit::normalize_line_endings_for_match(sline)
                    } else {
                        fuzzy_edit::normalize_whitespace(&file_lines[start + i])
                            == fuzzy_edit::normalize_whitespace(sline)
                    }
                });
                if all_match {
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

                let replacement_lines =
                    fuzzy_edit::split_replacement_lines(&effective_replacement);
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

        // Step 2: 模糊行匹配（基于 Levenshtein 距离 + 变窗口 + 预过滤）
        if let Some((start_line, end_line, similarity)) =
            fuzzy_edit::find_best_line_match_v2(
                search_content,
                &file_lines,
                preserve_indentation,
            )
        {
            if similarity >= FUZZY_MATCH_THRESHOLD {
                let effective_replacement = fuzzy_edit::pad_replacement_to_match(
                    &file_path,
                    &file_lines,
                    start_line,
                    end_line,
                    &replace_content,
                )
                .map_err(|message| Error::new(Status::InvalidArg, message))?;

                let replacement_lines =
                    fuzzy_edit::split_replacement_lines(&effective_replacement);
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
                    (replacement_line_count > 0)
                        .then_some(start_line + replacement_line_count - 1),
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

        // Step 3: 所有匹配策略均失败 - 返回包含最相似区间上下文的详细错误
        let error_msg = fuzzy_edit::build_search_not_found_error_v2(
            search_content,
            &file_lines,
            &file_path,
            total_lines,
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

/// 格式化会整体改变行数，需在格式化结果中按实际写入片段重新定位编辑区，
/// 再用新行号重建 review，保证反馈给 AI 和前端 Diff 的都是格式化后的
/// 真实布局；定位失败时回退格式化前的旧行号。
fn locate_formatted_edit(
    file_path: &str,
    formatted_content: &str,
    edited_content: Option<&str>,
    old_start: usize,
    old_end: usize,
) -> (usize, Option<usize>) {
    let Some(edited) = edited_content.filter(|content| !content.trim().is_empty()) else {
        return (old_start, Some(old_end));
    };
    let formatted_lines: Vec<&str> = formatted_content.split('\n').collect();
    let preserve_indentation = fuzzy_edit::is_indentation_sensitive_path(file_path);
    if let Some((start, end, similarity)) =
        fuzzy_edit::find_best_line_match_v2(edited, &formatted_lines, preserve_indentation)
    {
        if similarity >= FORMATTED_ALIGN_THRESHOLD {
            return (start, Some(end.saturating_sub(1)));
        }
    }
    (old_start, Some(old_end))
}

/// 用格式化后的文件内容重建 replace_edit 的反馈：review、matched 行号和
/// totalLines 全部对齐格式化后的布局，并移除仅供定位的 editedContent。
fn rebuild_result_after_format(result: &mut Value, file_path: &str, formatted_content: &str) {
    let Some(object) = result.as_object_mut() else {
        return;
    };

    let edited_content = object
        .get("editedContent")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let old_start = object
        .get("matchedLineStart")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .saturating_sub(1) as usize;
    let old_end = object
        .get("matchedLineEnd")
        .and_then(Value::as_u64)
        .unwrap_or(old_start as u64 + 1)
        .saturating_sub(1) as usize;

    object.remove("editedContent");
    object.insert("formatted".to_string(), json!(true));

    let (edit_start, edit_end) = locate_formatted_edit(
        file_path,
        formatted_content,
        edited_content.as_deref(),
        old_start,
        old_end,
    );

    if object.contains_key("totalLines") {
        let total_lines = formatted_content.split('\n').count();
        object.insert("totalLines".to_string(), json!(total_lines));
    }

    if let Some(edit_end) = edit_end {
        object.insert("matchedLineStart".to_string(), json!(edit_start + 1));
        object.insert("matchedLineEnd".to_string(), json!(edit_end + 1));
    }

    let review = fuzzy_edit::build_edit_review_context_lines(formatted_content, edit_start, edit_end);
    object.insert("review".to_string(), review);
}

/// Prettier 3 内置支持（无需额外插件）的文件扩展名。
fn is_prettier_supported_extension(file_path: &Path) -> bool {
    let Some(extension) = file_path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts"
            | "json" | "jsonc" | "css" | "scss" | "less" | "html"
            | "md" | "markdown" | "yaml" | "yml" | "graphql" | "gql"
    )
}

/// 从被编辑文件所在目录向上逐级查找 node_modules/prettier/bin/prettier.cjs。
/// 找到后用 `node <该入口> --write <file>` 调用，不依赖 shell 与 PATH 上的
/// npx。目标项目未安装 prettier 时返回 None（调用方静默跳过格式化）。
fn find_prettier_bin(file_path: &Path) -> Option<std::path::PathBuf> {
    let mut dir = file_path.parent()?.to_path_buf();
    loop {
        let candidate = dir
            .join("node_modules")
            .join("prettier")
            .join("bin")
            .join("prettier.cjs");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// 对已编辑写入的文件执行 Prettier 格式化，成功后返回格式化后的内容。
/// 所有文件查找、子进程调用和回读都放在 spawn_blocking 中，避免阻塞
/// Node.js 主线程；任何一步失败都返回 None，不影响编辑结果。
async fn format_file_with_prettier(file_path: &Path) -> Option<String> {
    if !is_prettier_supported_extension(file_path) {
        return None;
    }
    let file_path_owned = file_path.to_path_buf();

    tokio::task::spawn_blocking(move || {
        let prettier_bin = find_prettier_bin(&file_path_owned)?;
        let mut command = std::process::Command::new("node");
        command
            .arg(&prettier_bin)
            .arg("--write")
            .arg(&file_path_owned);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW：避免格式化时控制台窗口一闪而过。
            command.creation_flags(0x0800_0000);
        }
        let output = command.output().ok()?;
        if !output.status.success() {
            return None;
        }

        // 重新读取格式化后的内容（保持与原编辑路径一致的编码检测）。
        let bytes = fs::read(&file_path_owned).ok()?;
        let decoded = decode_text_bytes(&bytes).ok()?;
        Some(decoded.text)
    })
    .await
    .ok()
    .flatten()
}
