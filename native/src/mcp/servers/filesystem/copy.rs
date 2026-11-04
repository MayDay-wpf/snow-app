//! filesystem-copy：按行号把源文件的一段内容原样「复制 / 剪切」到目标文件，
//! 或同一文件的其他位置。
//!
//! 与 filesystem-replace_edit 的根本差别：被搬运的内容不经由 AI 输出（只传行号），
//! 逐行原样搬动。因此搬运一大段代码既不消耗模型的输出 token，也不会因转述产生内容
//! 偏差；剪切模式在一次调用里同时完成「粘贴 + 删除源区间」，等同于一次原子移动。
//!
//! 本模块全部是同步 IO/CPU 操作，调用方（FilesystemService::execute_local）保证
//! 它们运行在 tokio 阻塞线程池中。

use std::fs;
use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::fuzzy_edit;
use super::io::normalize_path;
use super::text_codec::{decode_text_bytes, encode_text_back};
use super::EDIT_REVIEW_CONTEXT_LINES;

/// 回传内容（pastedContent / removedContent）的行数上限：超过时只保留首尾各
/// COPY_PAYLOAD_EDGE_LINES 行并在中间插入省略标记，避免一大段搬运内容长期占据
/// 会话上下文与历史库。
const COPY_PAYLOAD_MAX_LINES: usize = 800;
const COPY_PAYLOAD_EDGE_LINES: usize = 30;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CopyMode {
    Insert,
    Replace,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InsertPosition {
    Before,
    After,
}

/// 目标位置的落点：拼接区间 + 粘贴区域在新内容中的起点。
struct Placement {
    splice_start: usize,
    splice_end: usize,
    paste_start: usize,
    /// 被整体覆盖掉的原目标行（replace 模式；insert 模式为空）。
    replaced_elements: Vec<String>,
}

struct TextDocument {
    content: String,
    encoding: &'static encoding_rs::Encoding,
    had_bom: bool,
}

/// 复制 / 剪切主体：读取源与目标 -> 计算新内容 -> 落盘 -> 构建回传结果。
pub(super) fn execute(args: &Value) -> napi::Result<Value> {
    if is_delete_mode(args) {
        return execute_delete(args);
    }
    let target_path = normalize_path(&required_string(args, "filePath")?);
    let source_path = normalize_path(&required_string(args, "sourceFilePath")?);
    let source_start_line = required_line(args, "sourceStartLine")?;
    let source_end_line = optional_line(args, "sourceEndLine")?;
    let target_line = optional_line(args, "targetLine")?;
    let target_end_line = optional_line(args, "targetEndLine")?;
    let mode = parse_mode(args)?;
    let position = parse_position(args)?;
    let delete_source = args
        .get("deleteSource")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // 只有 insert 会用到 targetEndLine：静默忽略会让「想替换却忘写 mode」的调用
    // 变成插入，直接把文件内容变成重复块，因此这里显式拒绝。
    if mode == CopyMode::Insert && target_end_line.is_some() {
        return Err(Error::new(
            Status::InvalidArg,
            "targetEndLine is only used with mode=\"replace\". Pass mode=\"replace\" to overwrite a target range, or drop targetEndLine to insert the copied lines."
                .to_string(),
        ));
    }

    // 与 targetEndLine 对称：position 只在 insert 下有意义，replace 下静默吞掉会让
    // 「想插到某行前后却写错 mode」的调用毫无痕迹，因此显式拒绝。
    if mode == CopyMode::Replace && has_position(args) {
        return Err(Error::new(
            Status::InvalidArg,
            "position is only used with mode=\"insert\". Pass mode=\"insert\" to insert the lines before/after targetLine, or drop position to overwrite the targetLine..targetEndLine range."
                .to_string(),
        ));
    }

    let source_document = read_document(&source_path, "sourceFilePath")?;
    let source_ends_with_newline = source_document.content.ends_with('\n');
    let source_elements = split_line_elements(&source_document.content);
    let source_total_lines = source_elements.len();
    if source_total_lines == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("sourceFilePath {source_path} is empty: there is no line to copy."),
        ));
    }
    if source_start_line > source_total_lines {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "sourceStartLine {source_start_line} is beyond the end of the source file ({source_path} has {source_total_lines} lines)."
            ),
        ));
    }
    // 末行与起始行逆序时交换，再截断到源文件末行（与 filesystem-read 的容错一致）。
    let source_end_line = source_end_line
        .unwrap_or(source_start_line)
        .max(source_start_line)
        .min(source_total_lines);
    let source_start_index = source_start_line - 1;
    // 元素下标区间左闭右开：1-based 闭区间 [start, end] 对应 [start - 1, end)。
    let source_end_index = source_end_line;
    let copied_elements: Vec<String> =
        source_elements[source_start_index..source_end_index].to_vec();
    let copied_line_count = source_end_index - source_start_index;

    let target_exists = Path::new(&target_path).exists();
    let target_document = match target_exists {
        true => Some(read_document(&target_path, "filePath")?),
        false => None,
    };
    // 目标不存在时，新文件的编码、BOM 与行尾风格全部继承源文件，
    // 让「把一段代码另存为新文件」保持与源一致的字节风格。
    let target_original_content = target_document
        .as_ref()
        .map(|document| document.content.as_str())
        .unwrap_or("");
    let target_encoding = target_document
        .as_ref()
        .map(|document| document.encoding)
        .unwrap_or(source_document.encoding);
    let target_had_bom = target_document
        .as_ref()
        .map(|document| document.had_bom)
        .unwrap_or(source_document.had_bom);
    let target_uses_crlf = match &target_document {
        Some(document) => fuzzy_edit::uses_crlf_line_endings(&document.content),
        None => fuzzy_edit::uses_crlf_line_endings(&source_document.content),
    };
    // 目标既有的行尾风格是 CRLF 时粘贴行补 '\r'，是 LF 时去掉行尾 '\r'，避免混合行尾。
    let adapted_copied_elements: Vec<String> = copied_elements
        .iter()
        .map(|line| adapt_line_element(line, target_uses_crlf))
        .collect();

    // 目标既有内容以换行结尾时，新内容也保留结尾换行；目标文件不存在时，新文件的
    // 内容完全由复制来的行构成 —— 源区间一直取到源文件末尾且源文件以换行结尾时同样
    // 保留结尾换行，让「整段复制成新文件」保持字节保真。
    let target_ends_with_newline = match target_exists {
        true => target_original_content.ends_with('\n'),
        false => source_ends_with_newline && source_end_line == source_total_lines,
    };
    let target_elements = split_line_elements(target_original_content);
    let target_total_lines = target_elements.len();

    let same_file = same_file_paths(&source_path, &target_path);
    // 同文件剪切：先按操作前的行号在快照上删掉源区间，得到目标基线；目标行号一律
    // 按「操作前」解释，落到基线上时再按删除量整体前移。
    let removal_count = if same_file && delete_source {
        copied_line_count
    } else {
        0
    };
    let mut target_baseline = target_elements.clone();
    if removal_count > 0 {
        target_baseline.drain(source_start_index..source_end_index);
    }
    let shift_after_removal = |index: usize| {
        if removal_count == 0 || index < source_end_index {
            index
        } else {
            index - removal_count
        }
    };

    let placement = match mode {
        CopyMode::Insert => {
            // 1-based 行号 -> 元素下标：插入到第 N 行之前即下标 N - 1；追加即下标 len。
            let insert_index = match target_line {
                None => target_total_lines,
                Some(line) => {
                    if line > target_total_lines + 1 {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!(
                                "targetLine {line} is beyond the end of the target file ({target_path} has {target_total_lines} lines): use a line between 1 and {}, or omit targetLine to append at the end of the file.",
                                target_total_lines + 1
                            ),
                        ));
                    }
                    match position {
                        InsertPosition::Before => line - 1,
                        // 「在第 N 行之后插入」= 下标 N；N 为末行 + 1 时等价于追加。
                        InsertPosition::After => line.min(target_total_lines),
                    }
                }
            };
            if removal_count > 0
                && insert_index >= source_start_index
                && insert_index <= source_end_index
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Refused: the insert position lies inside or directly next to the source range (lines {source_start_line}-{source_end_line}) of the same file, so the moved lines would come from the region being overwritten. Choose a position outside {source_start_line}-{source_end_line}, or move the block to another file."
                    ),
                ));
            }
            let index = shift_after_removal(insert_index);
            Placement {
                splice_start: index,
                splice_end: index,
                paste_start: index,
                replaced_elements: Vec::new(),
            }
        }
        CopyMode::Replace => {
            let Some(target_line) = target_line else {
                return Err(Error::new(
                    Status::InvalidArg,
                    "targetLine is required with mode=\"replace\": it is the first line to overwrite."
                        .to_string(),
                ));
            };
            let Some(target_end_line) = target_end_line else {
                return Err(Error::new(
                    Status::InvalidArg,
                    "targetEndLine is required with mode=\"replace\": it is the last line to overwrite (1-indexed, inclusive)."
                        .to_string(),
                ));
            };
            if target_total_lines == 0 {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Cannot replace lines in {target_path}: the file is empty. Use mode=\"insert\" (default) instead."
                    ),
                ));
            }
            if target_line > target_total_lines {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "targetLine {target_line} is beyond the end of the target file ({target_path} has {target_total_lines} lines)."
                    ),
                ));
            }
            // 逆序区间交换，末行截断到文件末行。
            let start_line = target_line.min(target_end_line);
            let end_line = target_line.max(target_end_line).min(target_total_lines);
            let start_index = start_line - 1;
            let end_index = end_line;
            if removal_count > 0
                && start_index < source_end_index
                && source_start_index < end_index
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Refused: the replaced range (lines {start_line}-{end_line}) overlaps the source range (lines {source_start_line}-{source_end_line}) of the same file. A cut needs non-overlapping ranges; use filesystem-replace_edit to rewrite a block in place."
                    ),
                ));
            }
            Placement {
                splice_start: shift_after_removal(start_index),
                splice_end: shift_after_removal(end_index),
                paste_start: shift_after_removal(start_index),
                replaced_elements: target_elements[start_index..end_index].to_vec(),
            }
        }
    };

    let mut new_target_lines = target_baseline;
    new_target_lines.splice(
        placement.splice_start..placement.splice_end,
        adapted_copied_elements.clone(),
    );
    let new_target_content = join_line_elements(&new_target_lines, target_ends_with_newline);

    // 0 修改检测：等值搬运（把块插回原处、把等价内容覆盖到自身）拒绝写盘，避免
    // 返回「成功但什么都没变」的结果误导模型。
    if new_target_content == target_original_content {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "No change: moving lines {source_start_line}-{source_end_line} of {source_path} into {target_path} leaves the target file identical, so nothing was written. Check sourceStartLine/sourceEndLine and the target position."
            ),
        ));
    }

    let region_start = placement.paste_start;
    let region_end = placement.paste_start + copied_line_count - 1;
    let target_new_total_lines = total_line_count(&new_target_content);

    // 剪切时源文件删除源区间后的行：跨文件写盘与 sourceReview 共用。
    // 同文件时源就是目标，None 表示直接看新的目标内容。
    let source_after_removal: Option<Vec<String>> = if delete_source && !same_file {
        let mut lines = source_elements.clone();
        lines.drain(source_start_index..source_end_index);
        Some(lines)
    } else {
        None
    };

    // 目标文件：编码 / BOM 保持原样；新文件才需要补建父目录。
    write_document(
        &target_path,
        &new_target_content,
        target_encoding,
        target_had_bom,
        !target_exists,
    )
    .map_err(|message| Error::new(Status::GenericFailure, message))?;

    // 跨文件剪切：目标写成功后再删源，宁可留下重复副本，也不因目标写失败丢掉内容。
    if let Some(lines) = source_after_removal.as_ref() {
        let source_new_content = join_line_elements(lines, source_ends_with_newline);
        write_document(
            &source_path,
            &source_new_content,
            source_document.encoding,
            source_document.had_bom,
            false,
        )
        .map_err(|message| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Target file was written, but removing the copied lines from the source file failed: {message}. {source_path} still contains lines {source_start_line}-{source_end_line}, so a duplicate copy may now exist."
                ),
            )
        })?;
    }

    let source_total_lines_after = match (delete_source, same_file) {
        (false, _) => source_total_lines,
        (true, true) => target_new_total_lines,
        (true, false) => source_total_lines - copied_line_count,
    };

    // 回传载荷：pastedContent 供前端 diff 展示与模型复核；跨文件剪切额外给出
    // removedContent（源文件被删掉的行），供前端渲染源文件侧的删除 diff。
    let (pasted_content, omitted_lines) = build_payload(&adapted_copied_elements);
    let removed_content = match source_after_removal.is_some() {
        true => pasted_content.clone(),
        false => String::new(),
    };
    let source_review = match (delete_source, source_after_removal.as_ref()) {
        // 跨文件：看源文件删除源区间后的上下文。
        (true, Some(lines)) => Some(build_review(
            &join_line_elements(lines, source_ends_with_newline),
            source_start_index,
            None,
        )),
        // 同文件：源就是目标，看新的目标内容里删除点附近的上下文。
        (true, None) => Some(build_review(&new_target_content, region_start, None)),
        (false, _) => None,
    };

    let mode_label = match mode {
        CopyMode::Insert => "insert",
        CopyMode::Replace => "replace",
    };
    let position_label = match position {
        InsertPosition::Before => "before",
        InsertPosition::After => "after",
    };

    let mut result = json!({
        "success": true,
        "deleteSource": delete_source,
        "sourceFilePath": source_path,
        "sourceLineStart": source_start_line,
        "sourceLineEnd": source_end_line,
        "sourceTotalLines": source_total_lines_after,
        "copiedLines": copied_line_count,
        "targetFilePath": target_path,
        "mode": mode_label,
        "matchedLineStart": region_start + 1,
        "matchedLineEnd": region_end + 1,
        "totalLines": target_new_total_lines,
        "replacedContent": logical_text(&placement.replaced_elements),
        "pastedContent": pasted_content,
        "omittedLines": omitted_lines,
        "review": build_review(&new_target_content, region_start, Some(region_end)),
    });

    if let Some(object) = result.as_object_mut() {
        if mode == CopyMode::Insert {
            object.insert("position".to_string(), json!(position_label));
        }
        if source_after_removal.is_some() {
            object.insert("removedContent".to_string(), json!(removed_content));
        }
        if let Some(source_review) = source_review {
            object.insert("sourceReview".to_string(), source_review);
        }
    }

    Ok(result)
}

/// mode=delete：直接删除 sourceFilePath 中的 sourceStartLine..sourceEndLine，不粘贴到任何位置。
/// 只作用于一个文件（filePath 必须与 sourceFilePath 相同），因此拒绝 targetLine /
/// targetEndLine / position：静默忽略会让「想移动却写成删除」的调用丢失内容。
fn execute_delete(args: &Value) -> napi::Result<Value> {
    let file_path = normalize_path(&required_string(args, "filePath")?);
    let source_path = normalize_path(&required_string(args, "sourceFilePath")?);
    let start_line = required_line(args, "sourceStartLine")?;
    let end_line = optional_line(args, "sourceEndLine")?;

    let has_target = ["targetLine", "targetEndLine"]
        .iter()
        .any(|field| args.get(*field).is_some_and(|value| !value.is_null()));
    if has_target || has_position(args) {
        return Err(Error::new(
            Status::InvalidArg,
            "targetLine, targetEndLine and position are not used with mode=\"delete\": the lines are removed, not pasted anywhere. Drop them, or use mode=\"insert\" / \"replace\" with deleteSource=true to move the lines.".to_string(),
        ));
    }

    let document = read_document(&source_path, "sourceFilePath")?;
    if !same_file_paths(&source_path, &file_path) {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "mode=\"delete\" removes lines from sourceFilePath itself, so filePath must be the same file ({source_path}). To paste the lines elsewhere, use mode=\"insert\" or \"replace\" with deleteSource=true."
            ),
        ));
    }

    let ends_with_newline = document.content.ends_with('\n');
    let mut lines = split_line_elements(&document.content);
    let total_lines = lines.len();
    if total_lines == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{source_path} is empty: there is no line to delete."),
        ));
    }
    if start_line > total_lines {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "sourceStartLine {start_line} is beyond the end of the file ({source_path} has {total_lines} lines)."
            ),
        ));
    }
    let end_line = end_line
        .unwrap_or(start_line)
        .max(start_line)
        .min(total_lines);
    let start_index = start_line - 1;
    let removed_elements: Vec<String> = lines.drain(start_index..end_line).collect();
    let new_content = join_line_elements(&lines, ends_with_newline);

    write_document(
        &source_path,
        &new_content,
        document.encoding,
        document.had_bom,
        false,
    )
    .map_err(|message| Error::new(Status::GenericFailure, message))?;

    let (removed_content, omitted_lines) = build_payload(&removed_elements);
    Ok(json!({
        "success": true,
        "mode": "delete",
        "filePath": source_path,
        "sourceLineStart": start_line,
        "sourceLineEnd": end_line,
        "removedLines": removed_elements.len(),
        "totalLines": lines.len(),
        "removedContent": removed_content,
        "omittedLines": omitted_lines,
        "review": build_review(&new_content, start_index, None),
    }))
}

/// 本次调用会改写的文件路径（纯复制只改目标文件；剪切同时改写源文件）。
/// 去重并按路径排序，供调用方顺序加锁，避免两次交叉剪切互相等待。
pub(super) fn write_lock_paths(args: &Value) -> Vec<&str> {
    let mut paths: Vec<&str> = Vec::new();
    if let Some(path) = args.get("filePath").and_then(Value::as_str) {
        paths.push(path);
    }
    if args
        .get("deleteSource")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        if let Some(path) = args.get("sourceFilePath").and_then(Value::as_str) {
            paths.push(path);
        }
    }
    paths.sort_unstable();
    paths.dedup();
    paths
}

/// 复核块，结构与 replace_edit 的 review 一致（startLine / endLine /
/// editedLineStart / editedLineEnd / totalLines / content），让模型用同一套方式复核
/// 搬运结果：粘贴行以 ">>>" 标记，区域过大时只保留首尾行并在中间插入省略标记。
/// `region_end = None` 表示只给 region_start 附近的上下文窗口（无标记行），用于
/// 剪切后源文件删除点的复核。
fn build_review(content: &str, region_start: usize, region_end: Option<usize>) -> Value {
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = total_line_count(content);
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
    let last_index = lines.len() - 1;

    let Some(region_end) = region_end else {
        let window_start = region_start
            .saturating_sub(EDIT_REVIEW_CONTEXT_LINES)
            .min(last_index);
        let window_end = (region_start + EDIT_REVIEW_CONTEXT_LINES).min(lines.len());
        let block: Vec<String> = (window_start..window_end)
            .map(|index| fuzzy_edit::format_review_line("   ", index + 1, lines[index]))
            .collect();
        return json!({
            "startLine": window_start + 1,
            "endLine": window_end,
            "editedLineStart": 0,
            "editedLineEnd": 0,
            "totalLines": total_lines,
            "content": block.join("\n")
        });
    };

    let region_start = region_start.min(last_index);
    let region_end = region_end.min(last_index);
    let region_line_count = region_end - region_start + 1;
    let context_start = region_start.saturating_sub(EDIT_REVIEW_CONTEXT_LINES);
    let context_end = (region_end + 1 + EDIT_REVIEW_CONTEXT_LINES).min(lines.len());

    let mut block: Vec<String> = Vec::new();
    if region_line_count <= COPY_PAYLOAD_MAX_LINES {
        for index in context_start..context_end {
            let marker = if index >= region_start && index <= region_end {
                ">>>"
            } else {
                "   "
            };
            block.push(fuzzy_edit::format_review_line(marker, index + 1, lines[index]));
        }
    } else {
        let head_end = region_start + COPY_PAYLOAD_EDGE_LINES;
        let tail_start = region_end + 1 - COPY_PAYLOAD_EDGE_LINES;
        for index in context_start..head_end {
            let marker = if index >= region_start { ">>>" } else { "   " };
            block.push(fuzzy_edit::format_review_line(marker, index + 1, lines[index]));
        }
        block.push(format!(
            "          ... {} lines omitted ...",
            tail_start - head_end
        ));
        for index in tail_start..context_end {
            let marker = if index <= region_end { ">>>" } else { "   " };
            block.push(fuzzy_edit::format_review_line(marker, index + 1, lines[index]));
        }
    }

    json!({
        "startLine": context_start + 1,
        "endLine": context_end,
        "editedLineStart": region_start + 1,
        "editedLineEnd": region_end + 1,
        "totalLines": total_lines,
        "content": block.join("\n")
    })
}

/// 构建回传载荷：行数超过 COPY_PAYLOAD_MAX_LINES 时只保留首尾各
/// COPY_PAYLOAD_EDGE_LINES 行，中间以省略标记代替；返回（文本, 被省略的行数）。
fn build_payload(elements: &[String]) -> (String, usize) {
    if elements.len() <= COPY_PAYLOAD_MAX_LINES {
        return (logical_text(elements), 0);
    }
    let omitted_lines = elements.len() - COPY_PAYLOAD_EDGE_LINES * 2;
    let head = logical_text(&elements[..COPY_PAYLOAD_EDGE_LINES]);
    let tail = logical_text(&elements[elements.len() - COPY_PAYLOAD_EDGE_LINES..]);
    (
        format!("{head}\n... {omitted_lines} lines omitted ...\n{tail}"),
        omitted_lines,
    )
}

/// 行元素的展示文本：去掉行尾 '\r'（CRLF 文件的 '\r' 不该出现在回传内容与 diff 里），
/// 按 '\n' 拼接。
fn logical_text(elements: &[String]) -> String {
    elements
        .iter()
        .map(|line| line.strip_suffix('\r').unwrap_or(line.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 把文件内容切成行元素：以 '\n' 分割并去掉文件末尾换行产生的幽灵空元素，空文件得到
/// 0 个元素。这样元素下标与 filesystem-read 的 1-based 行号一一对应（第 i 行 = 下标
/// i - 1），而元素本身保留 '\r'，剪切/拼接不会破坏 CRLF。
fn split_line_elements(content: &str) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = content.split('\n').map(str::to_owned).collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

/// 还原文件内容：按元素拼接，并保留原有的「文件以换行结尾」状态。
fn join_line_elements(lines: &[String], trailing_newline: bool) -> String {
    let mut content = lines.join("\n");
    if trailing_newline && !lines.is_empty() {
        content.push('\n');
    }
    content
}

/// 与 filesystem-read 一致的总行数口径：忽略文件末尾换行产生的幽灵空元素。
fn total_line_count(content: &str) -> usize {
    split_line_elements(content).len()
}

/// 单行元素适配目标文件的行尾风格：目标以 CRLF 为主时行尾补 '\r'，否则去掉 '\r'。
fn adapt_line_element(element: &str, use_crlf: bool) -> String {
    let trimmed = element.strip_suffix('\r').unwrap_or(element);
    match use_crlf {
        true => format!("{trimmed}\r"),
        false => trimmed.to_string(),
    }
}

/// 源文件与目标文件是否同一个文件：先比原始路径字符串，再比规范化后的真实路径
/// （覆盖相对路径、软链接与 Windows 大小写不敏感卷）。
fn same_file_paths(source_path: &str, target_path: &str) -> bool {
    if source_path == target_path {
        return true;
    }
    let (Ok(source), Ok(target)) = (
        Path::new(source_path).canonicalize(),
        Path::new(target_path).canonicalize(),
    ) else {
        return false;
    };
    if cfg!(windows) {
        source
            .to_string_lossy()
            .to_lowercase()
            .eq(&target.to_string_lossy().to_lowercase())
    } else {
        source == target
    }
}

fn read_document(path: &str, field: &str) -> napi::Result<TextDocument> {
    let target = Path::new(path);
    if target.is_dir() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{field} points to a directory, not a file: {path}"),
        ));
    }
    let bytes = fs::read(target).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read {field}: {error} (path: {path})"),
        )
    })?;
    let decoded = decode_text_bytes(&bytes).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to decode {field} as text: {error} (path: {path})"),
        )
    })?;
    Ok(TextDocument {
        content: decoded.text,
        encoding: decoded.encoding,
        had_bom: decoded.had_bom,
    })
}

/// 写回文本：保留原编码与 BOM；`create_parents` 为 true（目标文件不存在）时按需
/// 创建父目录。返回 Err(String) 便于调用方包装成带上下文的错误。
fn write_document(
    path: &str,
    content: &str,
    encoding: &'static encoding_rs::Encoding,
    had_bom: bool,
    create_parents: bool,
) -> std::result::Result<(), String> {
    let target = Path::new(path);
    if create_parents {
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Failed to create directories: {error} (path: {path})"))?;
            }
        }
    }
    let bytes = encode_text_back(content, encoding, had_bom).map_err(|error| {
        format!("Failed to encode content back to the original encoding: {error} (path: {path})")
    })?;
    fs::write(target, &bytes).map_err(|error| format!("Failed to write file: {error} (path: {path})"))
}

fn required_string(args: &Value, field: &str) -> napi::Result<String> {
    let value = args
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            let keys: Vec<String> = args
                .as_object()
                .map(|object| object.keys().cloned().collect())
                .unwrap_or_default();
            Error::new(
                Status::InvalidArg,
                format!(
                    "{field} is required for tool \"filesystem-copy\". Received keys: [{}]. Please provide a valid file path.",
                    keys.join(", ")
                ),
            )
        })?;
    Ok(value.to_string())
}

fn parse_line_number(value: &Value, field: &str) -> napi::Result<usize> {
    let Some(raw) = value.as_f64() else {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "{field} must be a number (1-indexed line number) for tool \"filesystem-copy\"."
            ),
        ));
    };
    if !raw.is_finite() || raw < 1.0 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be >= 1 (line numbers are 1-indexed), received {raw}."),
        ));
    }
    Ok(raw.floor() as usize)
}

fn required_line(args: &Value, field: &str) -> napi::Result<usize> {
    match args.get(field).filter(|value| !value.is_null()) {
        Some(value) => parse_line_number(value, field),
        None => Err(Error::new(
            Status::InvalidArg,
            format!(
                "{field} is required for tool \"filesystem-copy\": it is the 1-indexed first line of the source range."
            ),
        )),
    }
}

fn optional_line(args: &Value, field: &str) -> napi::Result<Option<usize>> {
    match args.get(field).filter(|value| !value.is_null()) {
        Some(value) => parse_line_number(value, field).map(Some),
        None => Ok(None),
    }
}

/// mode 是否为 "delete"（删除路径独立于 insert / replace，由 execute 先行分流）。
fn is_delete_mode(args: &Value) -> bool {
    args.get("mode").and_then(Value::as_str).map(str::trim) == Some("delete")
}

fn parse_mode(args: &Value) -> napi::Result<CopyMode> {
    match args
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None | Some("insert") => Ok(CopyMode::Insert),
        Some("replace") => Ok(CopyMode::Replace),
        Some(other) => Err(Error::new(
            Status::InvalidArg,
            format!("mode must be \"insert\" or \"replace\", received \"{other}\"."),
        )),
    }
}

fn parse_position(args: &Value) -> napi::Result<InsertPosition> {
    match args
        .get("position")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None | Some("before") => Ok(InsertPosition::Before),
        Some("after") => Ok(InsertPosition::After),
        Some(other) => Err(Error::new(
            Status::InvalidArg,
            format!("position must be \"before\" or \"after\", received \"{other}\"."),
        )),
    }
}

/// position 是否被显式传入（null / 空串视为未传，与 parse_position 的默认值口径一致）。
fn has_position(args: &Value) -> bool {
    match args.get("position").and_then(Value::as_str).map(str::trim) {
        Some(value) => !value.is_empty(),
        None => false,
    }
}
