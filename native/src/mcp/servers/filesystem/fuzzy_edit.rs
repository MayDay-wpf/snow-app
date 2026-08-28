use super::*;

use std::path::Path;

use serde_json::{json, Value};

/// 将所有空白字符（含 \r、\n、\t、BOM 等）压缩为单个空格并 trim 首尾。
/// 仅用于比较两段文本是否“内容等价”，不修改原始文件。
/// 这天然解决了 CRLF/LF 行尾差异、多余空格/制表符差异等问题。
pub(crate) fn normalize_whitespace(content: &str) -> String {
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

/// 判断文件是否使用缩进表达语义，不能在模糊匹配时忽略行首空白。
pub(crate) fn is_indentation_sensitive_path(file_path: &str) -> bool {
    let file_name = Path::new(file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(file_path)
        .to_ascii_lowercase();

    matches!(
        file_name.as_str(),
        "makefile" | "gnumakefile" | "snakefile"
    ) || file_name.ends_with(".mk")
        || file_name.ends_with(".py")
        || file_name.ends_with(".pyw")
        || file_name.ends_with(".pyi")
        || file_name.ends_with(".yaml")
        || file_name.ends_with(".yml")
}

/// 仅忽略 CRLF/LF 行尾差异，保留行首和行中的全部空白。
pub(crate) fn normalize_line_endings_for_match(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "")
}

fn normalize_for_match(content: &str, preserve_indentation: bool) -> String {
    if preserve_indentation {
        normalize_line_endings_for_match(content)
    } else {
        normalize_whitespace(content)
    }
}

fn leading_horizontal_whitespace(line: &str) -> &str {
    let end = line
        .char_indices()
        .find(|(_, character)| *character != ' ' && *character != '\t')
        .map(|(index, _)| index)
        .unwrap_or(line.len());
    &line[..end]
}

fn first_non_empty_line<'a>(mut lines: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    lines.find(|line| {
        !line
            .trim_matches(|character: char| {
                matches!(character, ' ' | '\t' | '\r' | '\u{feff}')
            })
            .is_empty()
    })
}

fn auto_pad_first_line_to_reference(reference_line: &str, text: &str) -> Option<String> {
    let indent = leading_horizontal_whitespace(reference_line);
    if indent.is_empty() {
        return None;
    }

    let mut found_first = false;
    let mut padded_lines: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim_start_matches([' ', '\t']);
        if !found_first && !trimmed.is_empty() {
            if leading_horizontal_whitespace(line).is_empty() {
                padded_lines.push(format!("{indent}{trimmed}"));
            } else {
                padded_lines.push(line.to_string());
            }
            found_first = true;
        } else {
            padded_lines.push(line.to_string());
        }
    }

    found_first
        .then_some(padded_lines.join("\n"))
        .filter(|padded| padded != text)
}

/// 在 content 中查找 needle 第 occurrence 次出现的位置（1-indexed，occurrence 为 0 时视为第 1 次）。
fn find_nth_occurrence(content: &str, needle: &str, occurrence: usize) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let target = occurrence.max(1);
    let mut count = 0usize;
    let mut cursor = 0usize;
    while let Some(relative) = content[cursor..].find(needle) {
        let absolute = cursor + relative;
        count += 1;
        if count == target {
            return Some(absolute);
        }
        cursor = absolute + needle.len();
    }
    None
}

/// searchContent 首行缩进与实际命中行不一致时的定点矫正。
/// substring 能命中意味着中间行是逐字匹配的，AI 的缩进基准只有首行失真：
/// 用命中行的真实缩进重写 searchContent 首行，并把仍停留在旧缩进基准上的
/// replaceContent 行迁移到真实缩进（多行 search 仅迁移首个非空行——中间行
/// 已逐字命中即基准正确；单行 search 时 replaceContent 整体共享该行基准，
/// 迁移全部非空行）。无法定位命中或首行并非失真来源时返回 None。
fn realign_search_first_line_indentation(
    content: &str,
    search_content: &str,
    replace_content: &str,
    occurrence: usize,
) -> Option<(String, String)> {
    let adapted_search = adapt_line_endings(search_content, content);
    let target = find_nth_occurrence(content, &adapted_search, occurrence)?;
    let line_start = content[..target]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    // 仅当命中位置位于某行首个非空白字符处时，首行缩进才有意义。
    let before_match = &content[line_start..target];
    if !before_match.chars().all(|character| character == ' ' || character == '\t') {
        return None;
    }
    let line_end = content[target..]
        .find('\n')
        .map(|relative| target + relative)
        .unwrap_or(content.len());
    let file_indent = leading_horizontal_whitespace(&content[line_start..line_end]);

    let (search_first_line, search_rest) = match search_content.split_once('\n') {
        Some((first, rest)) => (first, Some(rest)),
        None => (search_content, None),
    };
    let search_indent = leading_horizontal_whitespace(search_first_line);
    let search_body = search_first_line.trim_start_matches([' ', '\t']);
    // 首行去缩进后为空说明缩进基准不在首行；缩进一致则无需矫正。
    if search_body.is_empty() || search_indent == file_indent {
        return None;
    }

    let realigned_search = match search_rest {
        Some(rest) => format!("{file_indent}{search_body}\n{rest}"),
        None => format!("{file_indent}{search_body}"),
    };

    let single_line_search = search_rest.is_none();
    let replace_lines: Vec<&str> = replace_content.split('\n').collect();
    let first_body_index = replace_lines.iter().position(|line| {
        !line
            .trim_matches(|character: char| matches!(character, ' ' | '\t' | '\r'))
            .is_empty()
    });
    let Some(first_body_index) = first_body_index else {
        // 空替换表示删除，不涉及缩进基准。
        return Some((realigned_search, replace_content.to_string()));
    };
    let replace_indent = leading_horizontal_whitespace(replace_lines[first_body_index]);
    // replaceContent 已按命中行缩进书写，或与旧缩进基准没有前缀关系
    // （无法解释其缩进意图）时保持原样，交由内置缩进校验兜底。
    if replace_indent == file_indent || !replace_indent.starts_with(search_indent) {
        return Some((realigned_search, replace_content.to_string()));
    }

    let remap_line = |line: &str| -> String {
        let trimmed = line.trim_start_matches([' ', '\t']);
        let indent = leading_horizontal_whitespace(line);
        if trimmed.is_empty() || !indent.starts_with(search_indent) {
            return line.to_string();
        }
        format!("{file_indent}{}", &line[indent.len()..])
    };
    let realigned_replace: Vec<String> = replace_lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if single_line_search || index == first_body_index {
                remap_line(line)
            } else {
                (*line).to_string()
            }
        })
        .collect();
    let realigned_replace = realigned_replace.join("\n");
    let realigned_replace = if realigned_replace == replace_content {
        replace_content.to_string()
    } else {
        realigned_replace
    };
    Some((realigned_search, realigned_replace))
}

fn validate_candidate_indentation(
    file_path: &str,
    matched_line: &str,
    candidate_line: &str,
    candidate_name: &str,
) -> std::result::Result<(), String> {
    let matched_indent = leading_horizontal_whitespace(matched_line);
    let candidate_indent = leading_horizontal_whitespace(candidate_line);
    if matched_indent == candidate_indent {
        return Ok(());
    }

    Err(format!(
        "Edit rejected: leading indentation mismatch in indentation-sensitive file `{file_path}`. The matched region starts with {:?} ({} characters), but {candidate_name} starts with {:?} ({} characters). Copy the leading spaces/tabs from the matched region exactly; filesystem-replace_edit refuses to apply this edit to avoid silently breaking Python/YAML/Makefile structure.",
        matched_indent,
        matched_indent.chars().count(),
        candidate_indent,
        candidate_indent.chars().count()
    ))
}

/// 拒绝 searchContent 丢失命中行首缩进，避免子串匹配绕过缩进保护。
pub(crate) fn validate_search_indentation(
    file_path: &str,
    search_content: &str,
    matched_content: &str,
) -> std::result::Result<(), String> {
    if !is_indentation_sensitive_path(file_path) {
        return Ok(());
    }

    let Some(search_line) = first_non_empty_line(search_content.split('\n')) else {
        return Ok(());
    };
    let Some(matched_line) = first_non_empty_line(matched_content.split('\n')) else {
        return Ok(());
    };

    validate_candidate_indentation(file_path, matched_line, search_line, "searchContent")
}

/// 拒绝会改变缩进敏感文件块级缩进的替换，避免首行前导空格丢失后静默破坏源码。
pub(crate) fn validate_replacement_indentation(
    file_path: &str,
    file_lines: &[&str],
    matched_start: usize,
    matched_end: usize,
    replacement: &str,
) -> std::result::Result<(), String> {
    if !is_indentation_sensitive_path(file_path) {
        return Ok(());
    }

    let matched_lines: &[&str] = file_lines.get(matched_start..matched_end).unwrap_or(&[]);
    let Some(matched_line) = first_non_empty_line(matched_lines.iter().copied()) else {
        return Ok(());
    };
    let Some(replacement_line) = first_non_empty_line(replacement.split('\n')) else {
        return Ok(());
    };

    validate_candidate_indentation(file_path, matched_line, replacement_line, "replaceContent")
}

/// 校验 replaceContent 缩进；缺失首行缩进时用匹配区域的首行缩进自动补全。
/// 补全后的内容重新走完整校验，无法补全时返回原始校验错误。
pub(crate) fn pad_replacement_to_match(
    file_path: &str,
    file_lines: &[&str],
    matched_start: usize,
    matched_end: usize,
    replacement: &str,
) -> std::result::Result<String, String> {
    if !is_indentation_sensitive_path(file_path) {
        return Ok(replacement.to_string());
    }

    let matched_lines: &[&str] = file_lines.get(matched_start..matched_end).unwrap_or(&[]);
    let Some(matched_line) = first_non_empty_line(matched_lines.iter().copied()) else {
        return Ok(replacement.to_string());
    };
    let Some(replacement_line) = first_non_empty_line(replacement.split('\n')) else {
        return Ok(replacement.to_string());
    };

    if leading_horizontal_whitespace(matched_line)
        == leading_horizontal_whitespace(replacement_line)
    {
        return Ok(replacement.to_string());
    }

    match auto_pad_first_line_to_reference(matched_line, replacement) {
        Some(padded) => {
            validate_replacement_indentation(file_path, file_lines, matched_start, matched_end, &padded)?;
            Ok(padded)
        }
        None => {
            validate_replacement_indentation(file_path, file_lines, matched_start, matched_end, replacement)?;
            Ok(replacement.to_string())
        }
    }
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
pub(crate) fn adapt_line_endings(text: &str, file_content: &str) -> String {
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

/// 空替换表示删除匹配内容，不保留空行。
pub(crate) fn split_replacement_lines(content: &str) -> Vec<String> {
    if content.is_empty() {
        Vec::new()
    } else {
        content.split('\n').map(str::to_owned).collect()
    }
}

pub(crate) fn replacement_line_count(content: &str) -> usize {
    if content.is_empty() {
        0
    } else {
        content.split('\n').count()
    }
}

/// 如果 searchContent 的每一行都以行号前缀开头（如 "42: " 或 "  10| "），
/// 则剥离所有行号前缀，返回纯内容。否则返回 None。
pub(crate) fn try_strip_line_prefixes(text: &str) -> Option<String> {
    let re = regex::Regex::new(LINE_PREFIX_REGEX).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return None;
    }

    let non_empty_count = lines.iter().filter(|line| !line.trim().is_empty()).count();
    if non_empty_count == 0 {
        return None;
    }

    let prefixed_count = lines
        .iter()
        .filter(|line| !line.trim().is_empty() && re.is_match(line))
        .count();
    if (prefixed_count as f64 / non_empty_count as f64) < 0.6 {
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

    (result != text).then_some(result)
}

/// 尝试把 searchContent 作为字面子串在完整文件内容中匹配并替换。
/// 对缩进敏感文件，如果命中位置是某行的第一个非空白字符，则同时校验
/// replaceContent 首行缩进，防止缺少缩进时绕过整行匹配保护。
/// 当 searchContent / replaceContent 缺失前导缩进时自动补全后重试。
pub(crate) fn try_substring_replace(
    file_path: &str,
    content: &str,
    search_content: &str,
    replace_content: &str,
    occurrence: usize,
    preserve_indentation: bool,
) -> std::result::Result<Option<(String, usize, usize, usize)>, String> {
    let attempt = |search: &str, replacement: &str| {
        try_substring_replace_once(
            file_path,
            content,
            search,
            replacement,
            occurrence,
            preserve_indentation,
        )
    };

    match attempt(search_content, replace_content) {
        Err(first_error) if preserve_indentation => {
            // 缩进敏感文件：searchContent 首行丢失/错配缩进是常见失误。
            // 按实际命中位置定点重建缩进后重试，避免可直接恢复的编辑被拒绝。
            if let Some((realigned_search, realigned_replace)) =
                realign_search_first_line_indentation(content, search_content, replace_content, occurrence)
            {
                if let Ok(Some(result)) = attempt(&realigned_search, &realigned_replace) {
                    return Ok(Some(result));
                }
            }
            Err(first_error)
        }
        result => result,
    }
}

fn try_substring_replace_once(
    file_path: &str,
    content: &str,
    search_content: &str,
    replace_content: &str,
    occurrence: usize,
    preserve_indentation: bool,
) -> std::result::Result<Option<(String, usize, usize, usize)>, String> {
    if search_content.is_empty() {
        return Ok(None);
    }

    let adapted_search = adapt_line_endings(search_content, content);
    if adapted_search.is_empty() {
        return Ok(None);
    }

    let mut positions: Vec<usize> = Vec::new();
    let mut cursor = 0usize;
    while cursor <= content.len() {
        match content[cursor..].find(&adapted_search) {
            Some(relative) => {
                let absolute = cursor + relative;
                positions.push(absolute);
                cursor = absolute + adapted_search.len();
            }
            None => break,
        }
    }
    let Some(&target) = positions.get(occurrence.saturating_sub(1)) else {
        return Ok(None);
    };

    let mut padded_replacement: Option<String> = None;
    if preserve_indentation {
        let line_start = content[..target]
            .rfind('\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        let line_end = content[target..]
            .find('\n')
            .map(|relative| target + relative)
            .unwrap_or(content.len());
        let matched_line = &content[line_start..line_end];
        let before_match = &content[line_start..target];
        if before_match.chars().all(|character| character == ' ' || character == '\t') {
            validate_search_indentation(file_path, search_content, matched_line)?;
            if let Err(error) = validate_replacement_indentation(
                file_path,
                &[matched_line],
                0,
                1,
                replace_content,
            ) {
                match auto_pad_first_line_to_reference(matched_line, replace_content) {
                    Some(padded) => {
                        validate_replacement_indentation(file_path, &[matched_line], 0, 1, &padded)?;
                        padded_replacement = Some(padded);
                    }
                    None => return Err(error),
                }
            }
        }
    }
    let effective_replacement = padded_replacement.as_deref().unwrap_or(replace_content);

    let end = target + adapted_search.len();
    let mut new_content = String::with_capacity(content.len() + effective_replacement.len());
    new_content.push_str(&content[..target]);
    new_content.push_str(effective_replacement);
    new_content.push_str(&content[end..]);

    let edit_start_line = content[..target].matches('\n').count();
    let edit_end_line =
        edit_start_line + effective_replacement.split('\n').count().saturating_sub(1);
    Ok(Some((
        new_content,
        edit_start_line,
        edit_end_line,
        positions.len(),
    )))
}

fn indentation_matches(search_content: &str, candidate_lines: &[&str]) -> bool {
    let search_lines: Vec<&str> = search_content.split('\n').collect();
    if search_lines.len() != candidate_lines.len() {
        return false;
    }

    search_lines
        .iter()
        .zip(candidate_lines.iter())
        .all(|(search_line, candidate_line)| {
            leading_horizontal_whitespace(search_line)
                == leading_horizontal_whitespace(candidate_line)
        })
}

fn score_candidate(
    search_content: &str,
    candidate_lines: &[&str],
    preserve_indentation: bool,
    threshold: f64,
) -> f64 {
    if preserve_indentation && !indentation_matches(search_content, candidate_lines) {
        return 0.0;
    }

    let candidate = candidate_lines.join("\n");
    let normalized_search = normalize_for_match(search_content, preserve_indentation);
    let normalized_candidate = normalize_for_match(&candidate, preserve_indentation);
    if normalized_search == normalized_candidate {
        return 1.0;
    }
    compute_levenshtein_similarity(
        &normalized_search,
        &normalized_candidate,
        threshold,
    )
}

/// 在文件行数组中，按行滑动窗口查找与 searchContent 最相似的区间。
/// 缩进敏感文件的相似度计算保留所有行首空白，仅忽略 CRLF/LF 差异。
/// 返回 (起始行号, 结束行号(不含), 相似度)，均为 0-indexed。
pub(crate) fn find_best_line_match_v2(
    search_content: &str,
    file_lines: &[&str],
    preserve_indentation: bool,
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
    let normalized_first_line = normalize_for_match(
        search_lines.first().copied().unwrap_or_default(),
        preserve_indentation,
    );
    let window_delta = if base_window >= 10 {
        (base_window / 5).clamp(3, 15)
    } else {
        0
    };

    let mut best_similarity = 0.0;
    let mut best_start = 0usize;
    let mut best_end = 0usize;

    for start_index in 0..=(file_lines.len() - base_window) {
        let candidate_first = normalize_for_match(file_lines[start_index], preserve_indentation);
        if compute_levenshtein_similarity(&normalized_first_line, &candidate_first, 0.5) < 0.5 {
            continue;
        }

        let exact_lines = &file_lines[start_index..start_index + base_window];
        let exact_score = score_candidate(
            search_content,
            exact_lines,
            preserve_indentation,
            threshold,
        );
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

        if window_delta > 0 {
            let mut score = exact_score;
            let mut end = start_index + base_window;
            for delta in 1..=window_delta {
                if base_window > delta {
                    let smaller = base_window - delta;
                    let candidate = &file_lines[start_index..start_index + smaller];
                    let candidate_score = score_candidate(
                        search_content,
                        candidate,
                        preserve_indentation,
                        threshold,
                    );
                    if candidate_score > score {
                        score = candidate_score;
                        end = start_index + smaller;
                    }
                }

                let larger = base_window + delta;
                if start_index + larger <= file_lines.len() {
                    let candidate = &file_lines[start_index..start_index + larger];
                    let candidate_score = score_candidate(
                        search_content,
                        candidate,
                        preserve_indentation,
                        threshold,
                    );
                    if candidate_score > score {
                        score = candidate_score;
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

    (best_similarity > 0.0).then_some((best_start, best_end, best_similarity))
}

/// 缩进宽松整行匹配的命中结果。
pub(crate) struct IndentationRelaxedMatch {
    pub start_line: usize,
    pub end_line: usize,
    pub replacement: String,
    pub total_matches: usize,
}

/// 缩进宽松匹配的行键：忽略行首空白与 CRLF/LF 差异后的行内容。
fn relaxed_line_key(line: &str) -> String {
    normalize_line_endings_for_match(line)
        .trim_start_matches([' ', '\t'])
        .to_owned()
}

/// 按宽度平移一行的行首空白（不改动行内容本身，最低压到 0）。
fn shift_line_indent(line: &str, delta: isize) -> String {
    let indent = leading_horizontal_whitespace(line);
    let body = &line[indent.len()..];
    let current = indent.chars().count() as isize;
    let target = (current + delta).max(0) as usize;
    let mut shifted: String = indent.chars().take(target).collect();
    let kept = shifted.chars().count();
    if kept < target {
        shifted.push_str(&" ".repeat(target - kept));
    }
    format!("{shifted}{body}")
}

/// 把 replaceContent 重新定基到命中区域的首行缩进：
/// - replaceContent 首个非空行已使用命中缩进 → 原样返回（AI 已按文件真实缩进书写）；
/// - 仍停留在 searchContent 的（错误）缩进基准上 → 整体迁移到命中缩进并保留相对结构；
/// - 两种基准都对不上 → 返回 None（保持拒绝语义，交由后续匹配策略或报错处理）。
fn rebase_replacement_to_matched_indent(
    search_first_indent: &str,
    matched_first_indent: &str,
    replace_content: &str,
) -> Option<String> {
    if search_first_indent == matched_first_indent {
        return Some(replace_content.to_string());
    }

    let replace_lines: Vec<&str> = replace_content.split('\n').collect();
    let Some(first_body_line) = first_non_empty_line(replace_lines.iter().copied()) else {
        // 空替换表示删除，不涉及缩进基准。
        return Some(replace_content.to_string());
    };
    let replace_indent = leading_horizontal_whitespace(first_body_line);
    if replace_indent == matched_first_indent {
        return Some(replace_content.to_string());
    }
    if !replace_indent.starts_with(search_first_indent) {
        return None;
    }

    let delta = matched_first_indent.chars().count() as isize
        - search_first_indent.chars().count() as isize;
    let rebased: Vec<String> = replace_lines
        .iter()
        .map(|line| {
            if line.trim_start_matches([' ', '\t']).is_empty() {
                return (*line).to_string();
            }
            let indent = leading_horizontal_whitespace(line);
            if indent.starts_with(search_first_indent) {
                format!("{matched_first_indent}{}", &line[indent.len()..])
            } else {
                shift_line_indent(line, delta)
            }
        })
        .collect();
    Some(rebased.join("\n"))
}

/// 缩进敏感文件专用的缩进宽松整行匹配：searchContent 整块丢失/错配行首缩进
/// （精确与子串匹配均无法命中）时，按「去行首空白后逐行相等」定位命中区域，
/// 并把 replaceContent 重新定基到命中区域的首行缩进。
/// 候选位置优先选择所有非空行缩进呈统一偏移的（整体平移，语义最明确）。
pub(crate) fn find_indentation_relaxed_match(
    search_content: &str,
    replace_content: &str,
    file_lines: &[&str],
    occurrence: usize,
) -> Option<IndentationRelaxedMatch> {
    let search_lines: Vec<&str> = search_content.split('\n').collect();
    if search_lines.is_empty() || search_lines.len() > file_lines.len() {
        return None;
    }
    let search_keys: Vec<String> = search_lines.iter().map(|line| relaxed_line_key(line)).collect();

    let mut candidates: Vec<(usize, bool)> = Vec::new();
    for start in 0..=(file_lines.len() - search_lines.len()) {
        let all_match = search_keys
            .iter()
            .enumerate()
            .all(|(index, key)| relaxed_line_key(file_lines[start + index]) == *key);
        if !all_match {
            continue;
        }
        let mut uniform = true;
        let mut expected_delta: Option<isize> = None;
        for (index, search_line) in search_lines.iter().enumerate() {
            if search_keys[index].is_empty() {
                continue;
            }
            let delta = leading_horizontal_whitespace(file_lines[start + index]).chars().count() as isize
                - leading_horizontal_whitespace(search_line).chars().count() as isize;
            if expected_delta.is_some_and(|existing| existing != delta) {
                uniform = false;
                break;
            }
            expected_delta = Some(delta);
        }
        candidates.push((start, uniform));
    }
    if candidates.is_empty() {
        return None;
    }

    let preferred: Vec<usize> = if candidates.iter().any(|(_, uniform)| *uniform) {
        candidates
            .iter()
            .filter(|(_, uniform)| *uniform)
            .map(|(start, _)| *start)
            .collect()
    } else {
        candidates.iter().map(|(start, _)| *start).collect()
    };

    let start = preferred.get(occurrence.saturating_sub(1)).copied()?;
    let end = start + search_lines.len();
    let matched_lines = &file_lines[start..end];
    let search_first_indent = leading_horizontal_whitespace(
        first_non_empty_line(search_lines.iter().copied())?,
    );
    let matched_first_indent = leading_horizontal_whitespace(
        first_non_empty_line(matched_lines.iter().copied())?,
    );
    let replacement =
        rebase_replacement_to_matched_indent(search_first_indent, matched_first_indent, replace_content)?;

    Some(IndentationRelaxedMatch {
        start_line: start,
        end_line: end,
        replacement,
        total_matches: preferred.len(),
    })
}

/// 构建编辑成功后的复核上下文：返回编辑区域前后各 EDIT_REVIEW_CONTEXT_LINES 行
/// 的带行号代码块（编辑行以 ">>>" 标记），供 AI 复核编辑结果是否正确。
pub(crate) fn build_edit_review_context_lines(
    new_content: &str,
    edit_start_line: usize,
    edit_end_line: Option<usize>,
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

    let has_edited_lines = edit_end_line.is_some();
    let edit_end = edit_end_line
        .unwrap_or(edit_start_line)
        .min(total_lines.saturating_sub(1));
    let context_start = edit_start_line.saturating_sub(EDIT_REVIEW_CONTEXT_LINES);
    let context_end = (edit_end + 1 + EDIT_REVIEW_CONTEXT_LINES).min(total_lines);

    let block: Vec<String> = (context_start..context_end)
        .map(|index| {
            let marker = if has_edited_lines && index >= edit_start_line && index <= edit_end {
                ">>>"
            } else {
                "   "
            };
            format!("{} {:>6}: {}", marker, index + 1, lines[index])
        })
        .collect();

    json!({
        "startLine": context_start + 1,
        "endLine": context_end,
        "editedLineStart": edit_end_line.map(|_| edit_start_line + 1).unwrap_or(0),
        "editedLineEnd": edit_end_line.map(|line| line.min(total_lines.saturating_sub(1)) + 1).unwrap_or(0),
        "totalLines": total_lines,
        "content": block.join("\n")
    })
}

/// 构建 searchContent not found 的详细错误信息，包含最相似区间的上下文。
pub(crate) fn build_search_not_found_error_v2(
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
    let preserve_indentation = is_indentation_sensitive_path(file_path);

    if let Some((start_line, end_line, similarity)) =
        find_best_line_match_v2(search_content, file_lines, preserve_indentation)
    {
        let context_start = start_line.saturating_sub(2);
        let context_end = (end_line + 2).min(file_lines.len());
        let context: Vec<String> = (context_start..context_end)
            .map(|index| {
                let marker = if index >= start_line && index < end_line {
                    ">>>"
                } else {
                    "   "
                };
                format!("{} {:>6}: {}", marker, index + 1, file_lines[index])
            })
            .collect();
        let similarity_percent = (similarity * 100.0) as u32;

        return format!(
            "searchContent not found in file (exact match failed).\n\n\
             File: {} ({} lines total)\n\n\
             searchContent: {} lines, preview: \"{}\"\n\n\
             Closest matching region (similarity: {}%, lines {}-{}):\n\n\
             {}\n\n\
             The searchContent does not match any part of the file exactly. Common causes:\n\n\
              1. searchContent was copied from read output and includes line number prefixes (e.g. \"42:...\") - remove them.\n\n\
              2. searchContent has been paraphrased or retyped instead of copied verbatim.\n\n\
              3. The file was modified since it was last read.\n\n\
              4. For Python/YAML/Makefile files, leading indentation is significant and must be copied exactly.\n\n\
             Please re-read the file with filesystem-read and copy the EXACT raw source text as searchContent.",
            file_path,
            total_lines,
            search_lines,
            search_preview,
            similarity_percent,
            start_line + 1,
            end_line,
            context.join("\n")
        )
    } else {
        format!(
            "searchContent not found in file (exact match failed).\n\n\
             File: {} ({} lines total)\n\n\
             searchContent: {} lines, preview: \"{}\"\n\n\
             No similar content found in the file. The file may have been modified since it was last read.\n\n\
             For Python/YAML/Makefile files, copy leading indentation exactly; indentation is not ignored.\n\n\
             Please re-read the file with filesystem-read and copy the EXACT raw source text as searchContent.",
            file_path,
            total_lines,
            search_lines,
            search_preview
        )
    }
}

/// 构造编辑会产生 0 修改的详细错误信息。
pub(crate) fn build_noop_edit_error(
    file_path: &str,
    search_content: &str,
    replace_content: &str,
    file_lines: &[&str],
    total_lines: usize,
) -> String {
    let search_preview: String = search_content
        .chars()
        .take(200)
        .collect::<String>()
        .replace('\n', "\\n");
    let replace_preview: String = replace_content
        .chars()
        .take(200)
        .collect::<String>()
        .replace('\n', "\\n");
    let preserve_indentation = is_indentation_sensitive_path(file_path);
    let mut message = format!(
        "Edit rejected: replacement would produce zero changes (no-op). The matched region in the file is already byte-identical to replaceContent, so writing it would modify nothing.\n\nFile: {} ({} lines total)\nsearchContent preview: \"{}\"\nreplaceContent preview: \"{}\"",
        file_path, total_lines, search_preview, replace_preview
    );

    if let Some((start_line, end_line, similarity)) =
        find_best_line_match_v2(search_content, file_lines, preserve_indentation)
    {
        let context_start = start_line.saturating_sub(2);
        let context_end = (end_line + 2).min(file_lines.len());
        let context: Vec<String> = (context_start..context_end)
            .map(|index| {
                let marker = if index >= start_line && index < end_line {
                    ">>>"
                } else {
                    "   "
                };
                format!("{} {:>6}: {}", marker, index + 1, file_lines[index])
            })
            .collect();
        message.push_str(&format!(
            "\n\nMatched region (similarity: {}%, lines {}-{}):\n{}",
            (similarity * 100.0) as u32,
            start_line + 1,
            end_line,
            context.join("\n")
        ));
    }

    message.push_str(
        "\n\nCommon cause: searchContent and replaceContent are content-identical - the same characters, or differing only in whitespace/indentation (which fuzzy matching ignores for ordinary files). For Python/YAML/Makefile files, indentation is significant and must be copied exactly. If the intent was to change indentation, provide replaceContent with indentation that actually differs from the current text.",
    );
    message
}
