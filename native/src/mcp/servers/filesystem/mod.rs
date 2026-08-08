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

mod office;
mod text_codec;

use office::{extract_office_document_text, office_document_kind};
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
                description: "Read file content with line numbers. Supports text files, images, Office documents (pdf, docx, xlsx, xls, xlsb, xlsm, ods, csv, pptx), and directories. Text file encoding is auto-detected (UTF-8, UTF-16/32 with BOM, GBK/GB18030, Big5, Shift_JIS, EUC-KR, windows-1252, etc.) and decoded to UTF-8. Office documents are extracted to plain text and can be very long - ALWAYS read them in chunks via startLine/endLine (e.g. read the first 100 lines first, then decide the next range based on the returned totalLines) instead of loading the whole document at once.".to_string(),
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
                description: "Fuzzy search-and-replace editing. Finds searchContent in the file and replaces it with replaceContent. The file's original text encoding is auto-detected and preserved on write-back (the edited file keeps its original encoding and BOM). IMPORTANT: searchContent must be COPIED EXACTLY from the file - do NOT include line number prefixes (like \"42:\") that appear in read output, do NOT retype or paraphrase. Copy the raw source text verbatim. If the exact text is not found, a fuzzy match is attempted; on failure the error includes the closest matching region to help you correct your searchContent. On success the response includes a \"review\" field with the edited region plus surrounding context lines (edited lines marked with \">>>\") - always verify the edit landed correctly. ESCAPE SEQUENCES: text inside string literals (e.g. Rust/Python/JSON source) stores escapes like \\n, \\t, \\\", \\\\ as literal backslash + character pairs in the file. When searchContent or replaceContent touches such text, keep the escapes in their literal form exactly as shown by filesystem-read output - never convert a literal backslash-n into a real newline, and never convert a real newline into a literal \\n. Use a real newline only when the file actually contains one; use a literal escape sequence only when the file text shows that escape.".to_string(),
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
                            "description": "New content to replace with. Match the file's escape style: write a literal backslash-n (two characters) when the file should keep an escape sequence like \\n; write a real newline only when the file actually uses real newlines."
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

        match tool_name {
            "read" => self.execute_read(args),
            "replace_edit" => self.execute_replace_edit(args),
            "create" => self.execute_create(args),
            _ => self.execute(tool_name, args),
        }
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

        read_path(file_path, start_line, end_line)
    }

    fn execute_replace_edit(&self, args: &Value) -> napi::Result<Value> {
        let file_path = normalize_path(
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
        let replace_content = adapt_line_endings(replace_content, &content);

        // 全程使用 split('\n') 而非 lines()，保留 \r 在行内容中。
        // 匹配时用 normalize_whitespace 比较（忽略空白差异含 \r），
        // 替换时用 splice 在行数组上操作，天然保持文件原有行尾风格。
        let file_lines: Vec<&str> = content.split('\n').collect();
        let total_lines = file_lines.len();

        // search_lines_variants: 每个元素是 (变体名, 行数组)
        let search_content_stripped = try_strip_line_prefixes(search_content);
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

            // 收集所有匹配位置
            let mut match_positions: Vec<usize> = Vec::new();
            for start in 0..=(file_lines.len() - search_line_count) {
                let all_match = search_lines.iter().enumerate().all(|(i, &sline)| {
                    normalize_whitespace(&file_lines[start + i]) == normalize_whitespace(sline)
                });
                if all_match {
                    match_positions.push(start);
                }
            }

            if let Some(&target_start) = match_positions.get(occurrence.saturating_sub(1)) {
                let end_line = target_start + search_line_count;

                // 行级替换：用 splice 替换目标行范围
                let replacement_lines: Vec<String> =
                    replace_content.split('\n').map(str::to_owned).collect();
                let mut new_lines: Vec<String> = file_lines.iter().map(|s| s.to_string()).collect();
                new_lines.splice(target_start..end_line, replacement_lines);
                let new_content = new_lines.join("\n");

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

                let review = build_edit_review_context_lines(
                    &new_content,
                    target_start,
                    target_start + replace_content.split('\n').count().saturating_sub(1),
                );

                return Ok(json!({
                    "success": true,
                    "totalMatches": match_positions.len(),
                    "occurrence": occurrence,
                    "matchType": match_type,
                    "matchedLineStart": target_start + 1,
                    "matchedLineEnd": end_line,
                    "review": review
                }));
            }
        }

        // Step 2: 模糊行匹配（基于 Levenshtein 距离 + 变窗口 + 预过滤）
        if let Some((start_line, end_line, similarity)) =
            find_best_line_match_v2(search_content, &file_lines)
        {
            if similarity >= FUZZY_MATCH_THRESHOLD {
                let replacement_lines: Vec<String> =
                    replace_content.split('\n').map(str::to_owned).collect();
                let mut new_lines: Vec<String> = file_lines.iter().map(|s| s.to_string()).collect();
                new_lines.splice(start_line..end_line, replacement_lines);
                let new_content = new_lines.join("\n");

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

                let review = build_edit_review_context_lines(
                    &new_content,
                    start_line,
                    start_line + replace_content.split('\n').count().saturating_sub(1),
                );

                return Ok(json!({
                    "success": true,
                    "matchType": "fuzzy",
                    "similarity": similarity,
                    "matchedLineStart": start_line + 1,
                    "matchedLineEnd": end_line,
                    "totalLines": total_lines,
                    "review": review
                }));
            }
        }

        // Step 3: 所有匹配策略均失败 - 返回包含最相似区间上下文的详细错误
        let error_msg =
            build_search_not_found_error_v2(search_content, &file_lines, &file_path, total_lines);

        Err(Error::new(Status::GenericFailure, error_msg))
    }

    fn execute_create(&self, args: &Value) -> napi::Result<Value> {
        let file_path = normalize_path(
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

/// 将所有空白字符（含 \r、\n、\t、BOM 等）压缩为单个空格并 trim 首尾。
/// 仅用于比较两段文本是否"内容等价"，不修改原始文件。
/// 这天然解决了 CRLF/LF 行尾差异、多余空格/制表符差异等问题。
fn normalize_whitespace(content: &str) -> String {
    let mut normalized = String::with_capacity(content.len());
    let mut previous_was_whitespace = true;

    for character in content.chars() {
        let is_whitespace = character.is_whitespace() || character == '\u{feff}';
        if is_whitespace {
            if !previous_was_whitespace {
                normalized.push(' ');
            }
        } else {
            normalized.push(character);
        }
        previous_was_whitespace = is_whitespace;
    }

    normalized.trim_end().to_owned()
}

/// 计算两个字符串之间的 Levenshtein 相似度（0.0 ~ 1.0），带提前剪枝优化。
fn compute_levenshtein_similarity(left: &str, right: &str, threshold: f64) -> f64 {
    let left_u16: Vec<u16> = left.encode_utf16().collect();
    let right_u16: Vec<u16> = right.encode_utf16().collect();

    if left_u16.is_empty() {
        return if right_u16.is_empty() { 1.0 } else { 0.0 };
    }
    if right_u16.is_empty() {
        return 0.0;
    }

    let max_length = left_u16.len().max(right_u16.len());
    let length_ratio = left_u16.len().min(right_u16.len()) as f64 / max_length as f64;
    if threshold > 0.0 && length_ratio < threshold {
        return length_ratio;
    }

    let max_distance = (max_length as f64 * (1.0 - threshold)).ceil() as usize;

    // 带提前终止的 Levenshtein 距离
    if left_u16 == right_u16 {
        return 1.0;
    }
    if left_u16.len().abs_diff(right_u16.len()) > max_distance {
        return 0.0;
    }

    let mut previous: Vec<usize> = (0..=right_u16.len()).collect();
    for (left_index, left_unit) in left_u16.iter().enumerate() {
        let mut current = Vec::with_capacity(right_u16.len() + 1);
        current.push(left_index + 1);
        let mut minimum = left_index + 1;

        for (right_index, right_unit) in right_u16.iter().enumerate() {
            let value = (previous[right_index + 1] + 1)
                .min(current[right_index] + 1)
                .min(previous[right_index] + usize::from(left_unit != right_unit));
            current.push(value);
            minimum = minimum.min(value);
        }

        if minimum > max_distance {
            return 0.0;
        }
        previous = current;
    }

    let distance = previous[right_u16.len()];
    1.0 - distance as f64 / max_length as f64
}

/// 根据文件内容的主要行尾风格，调整 text 的行尾以匹配。
/// 若文件以 CRLF 为主，则将 text 中的行尾转为 CRLF；
/// 若文件以 LF 为主，则将 text 中的行尾转为 LF。
/// 若文件为空或无法判定，则原样返回。
fn adapt_line_endings(text: &str, file_content: &str) -> String {
    if file_content.is_empty() || text.is_empty() {
        return text.to_string();
    }

    let crlf_count = file_content.matches("\r\n").count();
    let lf_count = file_content.matches('\n').count();
    let lf_only = lf_count.saturating_sub(crlf_count);

    let use_crlf = crlf_count > lf_only;

    if use_crlf {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        normalized.replace('\n', "\r\n")
    } else {
        text.replace("\r\n", "\n").replace('\r', "\n")
    }
}

/// 如果 searchContent 的每一行都以行号前缀开头（如 "42: " 或 "  10| "），
/// 则剥离所有行号前缀，返回纯内容。否则返回 None。
/// 这处理 AI 从 read 输出中复制了行号前缀的情况。
fn try_strip_line_prefixes(text: &str) -> Option<String> {
    let re = regex::Regex::new(LINE_PREFIX_REGEX).ok()?;

    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return None;
    }

    let non_empty_count = lines.iter().filter(|l| !l.trim().is_empty()).count();
    if non_empty_count == 0 {
        return None;
    }

    let prefixed_count = lines
        .iter()
        .filter(|l| !l.trim().is_empty() && re.is_match(l))
        .count();

    let ratio = prefixed_count as f64 / non_empty_count as f64;
    if ratio < 0.6 {
        return None;
    }

    let stripped_lines: Vec<String> = lines
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                line.to_string()
            } else {
                re.replace(line, "").to_string()
            }
        })
        .collect();

    let result = stripped_lines.join("\n");

    if result != text {
        Some(result)
    } else {
        None
    }
}

/// 在文件行数组中，按行滑动窗口查找与 searchContent 最相似的区间。
/// 基于 normalize_whitespace + Levenshtein 距离 + 变窗口 + 首行预过滤。
/// 返回 (起始行号, 结束行号(不含), 相似度)，均为 0-indexed。
fn find_best_line_match_v2(
    search_content: &str,
    file_lines: &[&str],
) -> Option<(usize, usize, f64)> {
    let search_lines: Vec<&str> = search_content.split('\n').collect();
    if search_lines.is_empty() || file_lines.is_empty() {
        return None;
    }

    let base_window = search_lines.len();
    if base_window > file_lines.len() {
        return None;
    }

    let threshold = FUZZY_MATCH_THRESHOLD;
    let normalized_search = normalize_whitespace(search_content);
    let normalized_first_line =
        normalize_whitespace(search_lines.first().copied().unwrap_or_default());

    // 变窗口：大代码块允许窗口大小浮动以改善边界对齐
    let window_delta = if base_window >= 10 {
        (base_window / 5).clamp(3, 15)
    } else {
        0
    };

    let mut best_similarity: f64 = 0.0;
    let mut best_start: usize = 0;
    let mut best_end: usize = 0;

    for start_index in 0..=(file_lines.len() - base_window) {
        // 首行预过滤：首行相似度低于阈值则跳过
        let normalized_candidate_first = normalize_whitespace(file_lines[start_index]);
        if compute_levenshtein_similarity(&normalized_first_line, &normalized_candidate_first, 0.5)
            < 0.5
        {
            continue;
        }

        // 尝试精确窗口大小
        let exact_candidate = file_lines[start_index..start_index + base_window].join("\n");
        let exact_score = if exact_candidate == search_content {
            1.0
        } else {
            compute_levenshtein_similarity(
                &normalized_search,
                &normalize_whitespace(&exact_candidate),
                threshold,
            )
        };

        if exact_score >= 0.9 {
            if exact_score > best_similarity {
                best_similarity = exact_score;
                best_start = start_index;
                best_end = start_index + base_window;
            }
            if best_similarity >= 0.95 {
                return Some((best_start, best_end, best_similarity));
            }
            continue;
        }

        // 大块：尝试变窗口
        if window_delta > 0 {
            let mut score = exact_score;
            let mut end = start_index + base_window;

            for delta in 1..=window_delta {
                // 更小窗口
                if base_window > delta {
                    let smaller = base_window - delta;
                    let candidate = file_lines[start_index..start_index + smaller].join("\n");
                    let s = if candidate == search_content {
                        1.0
                    } else {
                        compute_levenshtein_similarity(
                            &normalized_search,
                            &normalize_whitespace(&candidate),
                            threshold,
                        )
                    };
                    if s > score {
                        score = s;
                        end = start_index + smaller;
                    }
                }

                // 更大窗口
                let larger = base_window + delta;
                if start_index + larger <= file_lines.len() {
                    let candidate = file_lines[start_index..start_index + larger].join("\n");
                    let s = if candidate == search_content {
                        1.0
                    } else {
                        compute_levenshtein_similarity(
                            &normalized_search,
                            &normalize_whitespace(&candidate),
                            threshold,
                        )
                    };
                    if s > score {
                        score = s;
                        end = start_index + larger;
                    }
                }

                if score >= 0.95 {
                    break;
                }
            }

            if score >= threshold && score > best_similarity {
                best_similarity = score;
                best_start = start_index;
                best_end = end;
                if best_similarity >= 0.95 {
                    return Some((best_start, best_end, best_similarity));
                }
            }
        } else if exact_score >= threshold && exact_score > best_similarity {
            best_similarity = exact_score;
            best_start = start_index;
            best_end = start_index + base_window;
            if best_similarity >= 0.95 {
                return Some((best_start, best_end, best_similarity));
            }
        }
    }

    if best_similarity > 0.0 {
        Some((best_start, best_end, best_similarity))
    } else {
        None
    }
}

/// 构建编辑成功后的复核上下文：返回编辑区域前后各 EDIT_REVIEW_CONTEXT_LINES 行
/// 的带行号代码块（编辑行以 ">>>" 标记），供 AI 复核编辑结果是否正确。
///
/// edit_start_line / edit_end_line 是 0-indexed 的行号（闭区间）。
fn build_edit_review_context_lines(
    new_content: &str,
    edit_start_line: usize,
    edit_end_line: usize,
) -> Value {
    let lines: Vec<&str> = new_content.split('\n').collect();
    let total_lines = lines.len();
    if total_lines == 0 {
        return json!({
            "startLine": 0,
            "endLine": 0,
            "editedLineStart": 0,
            "editedLineEnd": 0,
            "totalLines": 0,
            "content": ""
        });
    }

    let edit_end = edit_end_line.min(total_lines.saturating_sub(1));

    let context_start = edit_start_line.saturating_sub(EDIT_REVIEW_CONTEXT_LINES);
    let context_end = (edit_end + 1 + EDIT_REVIEW_CONTEXT_LINES).min(total_lines);

    let block: Vec<String> = (context_start..context_end)
        .map(|i| {
            let marker = if i >= edit_start_line && i <= edit_end {
                ">>>"
            } else {
                "   "
            };
            format!("{} {:>6}: {}", marker, i + 1, lines[i])
        })
        .collect();

    json!({
        "startLine": context_start + 1,
        "endLine": context_end,
        "editedLineStart": edit_start_line + 1,
        "editedLineEnd": edit_end + 1,
        "totalLines": total_lines,
        "content": block.join("\n")
    })
}

/// 构建 "searchContent not found" 的详细错误信息，包含最相似区间的上下文。
fn build_search_not_found_error_v2(
    search_content: &str,
    file_lines: &[&str],
    file_path: &str,
    total_lines: usize,
) -> String {
    let search_lines = search_content.split('\n').count();
    let search_preview: String = search_content
        .chars()
        .take(200)
        .collect::<String>()
        .replace('\n', "\\n");

    if let Some((start_line, end_line, similarity)) =
        find_best_line_match_v2(search_content, file_lines)
    {
        let context_start = start_line.saturating_sub(2);
        let context_end = (end_line + 2).min(file_lines.len());

        let context: Vec<String> = (context_start..context_end)
            .map(|i| {
                let marker = if i >= start_line && i < end_line {
                    ">>>"
                } else {
                    "   "
                };
                format!("{} {:>6}: {}", marker, i + 1, file_lines[i])
            })
            .collect();

        let similarity_percent = (similarity * 100.0) as u32;

        return format!(
            "searchContent not found in file (exact match failed).\n\n\
             File: {} ({} lines total)\n\
             searchContent: {} lines, preview: \"{}\"\n\n\
             Closest matching region (similarity: {}%, lines {}-{}):\n\
             {}\n\n\
             The searchContent does not match any part of the file exactly. Common causes:\n\
             1. searchContent was copied from read output and includes line number prefixes (e.g. \"42:...\") - remove them.\n\
             2. searchContent has been paraphrased or retyped instead of copied verbatim.\n\
             3. The file was modified since it was last read.\n\
             Please re-read the file with filesystem-read and copy the EXACT raw source text as searchContent.",
            file_path,
            total_lines,
            search_lines,
            search_preview,
            similarity_percent,
            start_line + 1,
            end_line,
            context.join("\n")
        );
    }

    format!(
        "searchContent not found in file (exact match failed).\n\n\
         File: {} ({} lines total)\n\
         searchContent: {} lines, preview: \"{}\"\n\n\
         No similar content found in the file. The file may have been modified since it was last read.\n\
         Please re-read the file with filesystem-read and copy the EXACT raw source text as searchContent.",
        file_path,
        total_lines,
        search_lines,
        search_preview
    )
}

fn normalize_path(path: &str) -> String {
    let mut normalized = path.trim().to_string();
    normalized = normalized.replace('\0', "");
    if normalized.starts_with('\u{FEFF}') {
        normalized = normalized.trim_start_matches('\u{FEFF}').to_string();
    }
    normalized
}

fn read_path(
    file_path: &str,
    start_line: Option<u64>,
    end_line: Option<u64>,
) -> napi::Result<Value> {
    let file_path = normalize_path(file_path);

    if file_path.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "filePath must be a non-empty string for tool \"filesystem-read\".".to_string(),
        ));
    }

    let path = Path::new(&file_path);

    if path.is_dir() {
        let entries = fs::read_dir(path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read directory: {} (path: {})", error, file_path),
            )
        })?;

        let mut items: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let prefix = if entry.path().is_dir() { "/" } else { "" };
            items.push(format!("{}{}", name, prefix));
        }
        items.sort();

        return Ok(json!({
            "content": items.join("\n")
        }));
    }

    if is_image_file(path) {
        let data_url = read_image_as_data_url(path)?;
        return Ok(json!({
            "content": format!("@@image:{}@@", data_url),
            "mediaType": image_media_type(path),
            "isImage": true
        }));
    }

    let content = if let Some(kind) = office_document_kind(path) {
        extract_office_document_text(path, kind)?
    } else {
        // 字节读取 + 自动编码检测（BOM/chardetng），统一解码为 UTF-8。
        let bytes = fs::read(path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read file: {} (path: {})", error, file_path),
            )
        })?;
        decode_text_bytes(&bytes)
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!(
                        "Failed to decode file as text: {} (path: {})",
                        error, file_path
                    ),
                )
            })?
            .text
    };

    Ok(format_numbered_lines(&content, start_line, end_line))
}

fn is_image_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp") | Some("bmp")
    )
}

fn image_media_type(path: &Path) -> String {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("png") => "image/png".to_string(),
        Some("jpg") | Some("jpeg") => "image/jpeg".to_string(),
        Some("gif") => "image/gif".to_string(),
        Some("webp") => "image/webp".to_string(),
        Some("bmp") => "image/bmp".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn read_image_as_data_url(path: &Path) -> napi::Result<String> {
    let bytes = fs::read(path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read image file: {}", e),
        )
    })?;

    if bytes.is_empty() {
        return Err(Error::new(
            Status::GenericFailure,
            "Image file is empty".to_string(),
        ));
    }

    let media_type = image_media_type(path);
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", media_type, data))
}

/// 将文本内容按行号范围分页，返回带行号前缀的内容。
/// 文本文件与 Office 文档提取出的文本共用该逻辑。
fn format_numbered_lines(content: &str, start_line: Option<u64>, end_line: Option<u64>) -> Value {
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();

    // 当 startLine 与 endLine 同时存在且 startLine > endLine 时自动交换两者，
    // 纠正 AI 误传的逆序行号区间，避免后续切片 [start..end] 因 start > end 而 panic。
    let (start_line, end_line) = match (start_line, end_line) {
        (Some(s), Some(e)) if s > e => (Some(e), Some(s)),
        other => other,
    };

    let start = start_line
        .map(|line| line as usize)
        .unwrap_or(1)
        .saturating_sub(1);
    let end = end_line
        .map(|line| line as usize)
        .unwrap_or(total_lines)
        .min(total_lines);

    if start >= total_lines {
        return json!({
            "content": "",
            "totalLines": total_lines
        });
    }

    let selected: Vec<String> = lines[start..end]
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{:>6}: {}", start + index + 1, line))
        .collect();

    json!({
        "content": selected.join("\n"),
        "totalLines": total_lines,
        "startLine": start + 1,
        "endLine": end
    })
}
