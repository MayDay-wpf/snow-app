//! 终端输出的诊断提取与退出码语义。
//!
//! 失败结论只来自进程状态（退出码 / 信号）；文本规则产出的只是“可能相关”
//! 的弱提示，允许不准确，不参与成功/失败判定。规则全部做行首锚定，或匹配
//! 工具自身的固定记录格式，不做任意位置的关键词包含判断。

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

/// 单个流参与诊断的最大字节数；超出部分不再扫描（诊断标记为不完整）。
const SCAN_LIMIT: usize = 512 * 1024;
/// 单行超过此长度直接跳过（压缩后的 bundle、base64 等没有诊断价值）。
const MAX_LINE_CHARS: usize = 4096;
const MAX_ITEMS: usize = 50;
const MAX_MESSAGE_CHARS: usize = 160;
const MAX_BLOCK_LINES: usize = 40;

/// 数据型命令：输出是被观察的数据，不对其做行级诊断。
const DATA_COMMANDS: &[&str] = &[
    "cat",
    "type",
    "get-content",
    "gc",
    "head",
    "tail",
    "more",
    "less",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "ag",
    "ack",
    "findstr",
    "select-string",
    "sls",
    "jq",
    "yq",
    "sqlite3",
    "curl",
    "wget",
    "echo",
    "printf",
    "dir",
    "ls",
    "get-childitem",
    "gci",
    "tree",
    "find",
    "where",
    "which",
    "ps",
    "tasklist",
    "get-process",
];

/// 诊断型命令：构建、测试、检查、安装类工具，错误行具有稳定的输出格式。
const DIAGNOSTIC_COMMANDS: &[&str] = &[
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "bun",
    "tsc",
    "vue-tsc",
    "eslint",
    "prettier",
    "stylelint",
    "biome",
    "vitest",
    "jest",
    "mocha",
    "pytest",
    "py.test",
    "cargo",
    "rustc",
    "go",
    "dotnet",
    "mvn",
    "gradle",
    "gradlew",
    "make",
    "cmake",
    "ninja",
    "docker",
    "kubectl",
    "helm",
    "terraform",
    "composer",
    "bundle",
    "rake",
    "swift",
    "xcodebuild",
    "msbuild",
    "ruff",
    "mypy",
];

pub(crate) struct DiagnosticInput<'a> {
    pub(crate) command: &'a str,
    pub(crate) stdout: &'a str,
    pub(crate) stderr: &'a str,
    pub(crate) exit_code: Option<i32>,
    pub(crate) output_complete: bool,
    pub(crate) truncated_bytes: u64,
}

/// 进程被信号/系统异常终止时返回其名称，正常退出返回 None。
#[cfg(unix)]
pub(crate) fn exit_signal(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| match signal {
        1 => "SIGHUP".to_string(),
        2 => "SIGINT".to_string(),
        3 => "SIGQUIT".to_string(),
        4 => "SIGILL".to_string(),
        6 => "SIGABRT".to_string(),
        7 => "SIGBUS".to_string(),
        8 => "SIGFPE".to_string(),
        9 => "SIGKILL".to_string(),
        11 => "SIGSEGV".to_string(),
        13 => "SIGPIPE".to_string(),
        15 => "SIGTERM".to_string(),
        other => format!("SIG{other}"),
    })
}

/// Windows 上 `ExitStatus::code` 对异常终止返回 NTSTATUS（如 0xC0000005），
/// 用十六进制字符串上报，避免和普通退出码混在一起。
#[cfg(windows)]
pub(crate) fn exit_signal(status: &std::process::ExitStatus) -> Option<String> {
    let code = status.code()?;
    let raw = code as u32;
    if raw >= 0xC000_0000 {
        Some(format!("0x{raw:08X}"))
    } else {
        None
    }
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn exit_signal(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

/// 按命令语义解释退出码。返回 (语义 id, 是否失败)。
///
/// 这里的映射是确定性的：例如 grep 的 1 表示“无匹配”，robocopy 的 1..=7
/// 表示成功/部分成功，都不是失败。
pub(crate) fn classify_exit(
    command: &str,
    exit_code: Option<i32>,
    signal: Option<&str>,
) -> (&'static str, bool) {
    if signal.is_some() {
        return ("crash", true);
    }
    let Some(code) = exit_code else {
        return ("unknown", false);
    };
    if code == 0 {
        return ("success", false);
    }

    let tokens = command_tokens(command);
    let has = |names: &[&str]| tokens.iter().any(|token| names.contains(&token.as_str()));

    if code == 1 {
        if has(&[
            "grep",
            "egrep",
            "fgrep",
            "rg",
            "ag",
            "ack",
            "findstr",
            "select-string",
            "sls",
        ]) {
            return ("no_matches", false);
        }
        if has(&["diff", "colordiff"]) {
            return ("differences", false);
        }
        if has(&["test", "["]) {
            return ("condition_false", false);
        }
        if has(&["which", "where", "command"]) {
            return ("not_found", false);
        }
        if has(&["git"])
            && tokens.windows(2).any(|pair| {
                pair[0] == "git"
                    && matches!(pair[1].as_str(), "diff" | "diff-index" | "diff-tree")
            })
        {
            return ("differences", false);
        }
    }
    if code == 5 && has(&["pytest", "py.test"]) {
        return ("tests_not_collected", false);
    }
    if (1..=7).contains(&code) && has(&["robocopy"]) {
        return ("partial_success", false);
    }

    ("failure", true)
}

pub(crate) fn analyze(input: DiagnosticInput<'_>) -> Value {
    let command_kind = command_kind(input.command);
    let mut items: Vec<Value> = Vec::new();
    let mut complete = input.output_complete && input.truncated_bytes == 0;

    // 数据型命令的输出不是诊断，只保留“失败原因”兜底。
    if command_kind != "data" {
        scan_stream("stderr", input.stderr, &mut items, &mut complete);
        scan_stream("stdout", input.stdout, &mut items, &mut complete);
    }

    let has_error = items
        .iter()
        .any(|item| item.get("severity").and_then(Value::as_str) == Some("error"));
    if !has_error {
        let (_, failed) = classify_exit(input.command, input.exit_code, None);
        if failed {
            let fallback = first_non_empty_line(input.stderr)
                .map(|(line, text)| ("stderr", line, text, "stderr-primary"))
                .or_else(|| {
                    last_non_empty_line(input.stdout)
                        .map(|(line, text)| ("stdout", line, text, "stdout-tail"))
                });
            if let Some((stream, line, text, rule)) = fallback {
                push_item(
                    &mut items,
                    "error",
                    stream,
                    line,
                    line,
                    "medium",
                    rule,
                    text,
                );
            }
        }
    }

    if items.len() >= MAX_ITEMS {
        complete = false;
    }
    let error_count = items
        .iter()
        .filter(|item| item.get("severity").and_then(Value::as_str) == Some("error"))
        .count();
    let warning_count = items
        .iter()
        .filter(|item| item.get("severity").and_then(Value::as_str) == Some("warning"))
        .count();

    json!({
        "version": 1,
        "complete": complete,
        "commandKind": command_kind,
        "counts": {
            "error": error_count,
            "warning": warning_count,
        },
        "items": items,
    })
}

fn command_kind(command: &str) -> &'static str {
    let tokens = command_tokens(command);
    let mut saw_data = false;
    for (index, token) in tokens.iter().enumerate() {
        if token == "git" {
            let subcommand = tokens.get(index + 1).map(String::as_str).unwrap_or("");
            if matches!(
                subcommand,
                "log"
                    | "show"
                    | "diff"
                    | "status"
                    | "blame"
                    | "ls-files"
                    | "rev-parse"
                    | "branch"
                    | "remote"
                    | "config"
                    | "tag"
                    | "shortlog"
                    | "describe"
            ) {
                saw_data = true;
            }
            continue;
        }
        if DIAGNOSTIC_COMMANDS.contains(&token.as_str()) {
            return "diagnostic";
        }
        if DATA_COMMANDS.contains(&token.as_str()) {
            saw_data = true;
        }
    }
    if saw_data {
        "data"
    } else {
        "unknown"
    }
}

fn command_tokens(command: &str) -> Vec<String> {
    command
        .split(|ch: char| {
            ch.is_whitespace() || matches!(ch, '&' | ';' | '|' | '(' | ')' | '`')
        })
        .filter(|token| !token.is_empty())
        .map(|token| {
            let name = token
                .rsplit(|ch| ch == '/' || ch == '\\')
                .next()
                .unwrap_or(token)
                .trim_matches(|ch| ch == '"' || ch == '\'')
                .to_ascii_lowercase();
            for suffix in [".exe", ".cmd", ".bat", ".ps1", ".com"] {
                if let Some(stripped) = name.strip_suffix(suffix) {
                    return stripped.to_string();
                }
            }
            name
        })
        .collect()
}

fn scan_stream(stream: &'static str, text: &str, items: &mut Vec<Value>, complete: &mut bool) {
    if text.is_empty() {
        return;
    }
    let (text, clamped) = clamp_text(text, SCAN_LIMIT);
    if clamped {
        *complete = false;
    }
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();

    let mut index = 0_usize;
    while index < lines.len() {
        if items.len() >= MAX_ITEMS {
            *complete = false;
            break;
        }
        let line = lines[index];
        if line.len() > MAX_LINE_CHARS {
            index += 1;
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.is_empty() || !may_be_diagnostic(trimmed) || is_negated(trimmed) {
            index += 1;
            continue;
        }

        if is_powershell_record(trimmed) {
            let end = powershell_block_end(&lines, index);
            push_item(
                items,
                "error",
                stream,
                index,
                end,
                "high",
                "powershell-error",
                lines[index],
            );
            index = end + 1;
            continue;
        }

        if is_traceback_start(trimmed) {
            let end = traceback_end(&lines, index);
            push_item(
                items,
                "error",
                stream,
                index,
                end,
                "high",
                "traceback",
                lines[end],
            );
            index = end + 1;
            continue;
        }

        if let Some((severity, rule, confidence)) = line_severity(trimmed) {
            let end = extend_code_block(&lines, index);
            push_item(
                items,
                severity,
                stream,
                index,
                end,
                confidence,
                rule,
                lines[index],
            );
            index = end + 1;
            continue;
        }

        index += 1;
    }
}

fn line_severity(trimmed: &str) -> Option<(&'static str, &'static str, &'static str)> {
    if warning_prefix_re().is_match(trimmed) {
        return Some(("warning", "warning-prefix", "high"));
    }
    if error_prefix_re().is_match(trimmed) {
        return Some(("error", "error-prefix", "high"));
    }
    if located_error_re().is_match(trimmed) {
        return Some(("error", "located-error", "high"));
    }
    if located_message_re().is_match(trimmed) {
        return Some(("error", "located-message", "medium"));
    }
    None
}

fn may_be_diagnostic(line: &str) -> bool {
    if line.len() > MAX_LINE_CHARS {
        return false;
    }
    let lower = line.to_ascii_lowercase();
    lower.contains("error")
        || lower.contains("fatal")
        || lower.contains("panic")
        || lower.contains("fail")
        || lower.contains("warn")
        || lower.contains("traceback")
        || lower.contains("exception")
        || lower.contains("err!")
        || lower.contains("categoryinfo")
        || lower.contains(" : ")
        || lower.contains(".go:")
        || lower.contains(".rs:")
        || lower.contains(".ts:")
        || lower.contains(".tsx:")
        || lower.contains(".py:")
        || lower.contains(".js:")
}

fn is_powershell_record(trimmed: &str) -> bool {
    powershell_cmdlet_re().is_match(trimmed) || powershell_type_re().is_match(trimmed)
}

fn powershell_block_end(lines: &[&str], start: usize) -> usize {
    let limit = (start + 8).min(lines.len());
    let mut end = start;
    for (index, line) in lines.iter().enumerate().take(limit).skip(start + 1) {
        let trimmed = line.trim_start();
        if trimmed.starts_with("+ CategoryInfo")
            || trimmed.starts_with("+ FullyQualifiedErrorId")
            || trimmed.starts_with("CategoryInfo")
            || trimmed.starts_with("FullyQualifiedErrorId")
            || trimmed.starts_with("At line:")
        {
            end = index;
            if trimmed.contains("FullyQualifiedErrorId") {
                return index;
            }
        }
    }
    end
}

fn is_traceback_start(trimmed: &str) -> bool {
    trimmed.starts_with("Traceback (most recent call last):")
}

fn traceback_end(lines: &[&str], start: usize) -> usize {
    let limit = (start + MAX_BLOCK_LINES).min(lines.len());
    let mut end = start;
    for (index, line) in lines.iter().enumerate().take(limit).skip(start + 1) {
        if line.trim().is_empty() {
            continue;
        }
        let is_indented = line
            .chars()
            .next()
            .is_some_and(|ch| ch.is_whitespace());
        if !is_indented {
            return index;
        }
        end = index;
    }
    end
}

fn extend_code_block(lines: &[&str], start: usize) -> usize {
    let limit = (start + MAX_BLOCK_LINES).min(lines.len());
    let mut end = start;
    for (index, line) in lines.iter().enumerate().take(limit).skip(start + 1) {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            break;
        }
        let is_continuation = trimmed.starts_with("at ")
            || trimmed.starts_with("-->")
            || trimmed.starts_with('|')
            || trimmed.starts_with("^^^")
            || trimmed.starts_with("~~~")
            || trimmed.starts_with("Caused by:")
            || trimmed.starts_with("= ")
            || trimmed.starts_with("...")
            || trimmed.contains("^^^^");
        if !is_continuation {
            break;
        }
        end = index;
    }
    end
}

fn push_item(
    items: &mut Vec<Value>,
    severity: &str,
    stream: &str,
    line: usize,
    end_line: usize,
    confidence: &str,
    rule: &str,
    message: &str,
) {
    if items.len() >= MAX_ITEMS {
        return;
    }
    items.push(json!({
        "severity": severity,
        "stream": stream,
        "line": line,
        "endLine": end_line.max(line),
        "confidence": confidence,
        "rule": rule,
        "message": truncate_chars(message.trim(), MAX_MESSAGE_CHARS),
    }));
}

fn clamp_text(text: &str, limit: usize) -> (&str, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let cut = text[..end].rfind('\n').map(|pos| pos + 1).unwrap_or(end);
    (&text[..cut], true)
}

fn truncate_chars(text: &str, limit: usize) -> String {
    let mut result: String = text.chars().take(limit).collect();
    if text.chars().nth(limit).is_some() {
        result.push('…');
    }
    result
}

fn first_non_empty_line(text: &str) -> Option<(usize, &str)> {
    text.split('\n').enumerate().find_map(|(index, line)| {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim().is_empty() {
            None
        } else {
            Some((index, line))
        }
    })
}

fn last_non_empty_line(text: &str) -> Option<(usize, &str)> {
    let lines: Vec<&str> = text.split('\n').collect();
    for (index, line) in lines.iter().enumerate().rev() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if !line.trim().is_empty() {
            return Some((index, line));
        }
    }
    None
}

fn is_negated(line: &str) -> bool {
    negated_re().is_match(line)
}

fn negated_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:\b0\s+errors?\b|\bno\s+errors?\b|\berrors?\s*[:=]\s*0\b|\berrorcount\s*[:=]\s*0\b|\b0\s+(?:failed|failures)\b|\bno\s+(?:failures?|fails?)\b|\bfailures?\s*[:=]\s*0\b|\b0\s+warnings?\b|\bno\s+warnings?\b|\bwarnings?\s*[:=]\s*0\b|error[-_ ]free|--no-error)",
        )
        .expect("invalid negated diagnostic regex")
    })
}

fn warning_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(?:\[warning\]|\[warn\]|warning|warn)\b")
            .expect("invalid warning prefix regex")
    })
}

fn error_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^(?:\[error\]|\[fatal\]|(?:error|fatal|panic|fail|failed|failure)\b|npm err!|err!)",
        )
        .expect("invalid error prefix regex")
    })
}

fn located_error_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^\S.{0,300}?(?:\(\d+[,:]\d+\)|:\d+:\d+):\s*(?:error|fatal)\b")
            .expect("invalid located error regex")
    })
}

fn located_message_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^\S+?\.(?:go|rs|c|cc|cpp|h|hpp|ts|tsx|js|jsx|mjs|cjs|py|java|cs|kt|swift|rb|php|sh|ps1):\d+:\d+:\s+\S",
        )
        .expect("invalid located message regex")
    })
}

fn powershell_cmdlet_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)?-[A-Z][A-Za-z0-9]*\s*:\s+\S")
            .expect("invalid powershell cmdlet regex")
    })
}

fn powershell_type_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+\s*:\s+\S")
            .expect("invalid powershell type regex")
    })
}
