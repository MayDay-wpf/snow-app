//! 间接执行脚本的识别与读取。
//!
//! 把敏感操作写进脚本、再交给解释器执行 / 直接运行 / 点源引入时，命令文本本身
//! 不含敏感关键字。这里把这些脚本找出来读取内容交给规则一并匹配，并沿脚本内部
//! 再引用的脚本继续向下追踪（有层数与数量上限）。
//!
//! 识别刻意偏宽：候选路径只有真实存在、且能确认是脚本（扩展名或 shebang）时才会
//! 读取，误识别的普通参数因文件不存在被直接忽略，不会造成额外拦截。

use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::mcp::servers::remote_workspace::is_ssh_path;

/// 单个脚本的读取上限；超过时 shell 脚本按「无法检查」处理。
const MAX_SCRIPT_BYTES: u64 = 4 * 1024 * 1024;
/// 脚本引用脚本的最大追踪层数（命令本身为第 0 层）。
const MAX_SCRIPT_DEPTH: usize = 3;
/// 一次检查最多读取的脚本数量。
const MAX_SCRIPTS: usize = 16;
/// 引号内联命令（`bash -c "..."`、`cmd /c "..."`）的最大递归层数。
const MAX_INLINE_DEPTH: usize = 2;

/// 解释器 / shell 程序名（小写、去掉 `.exe`）：其后的操作数可能是脚本路径。
const INTERPRETERS: &[&str] = &[
    "bash",
    "sh",
    "zsh",
    "dash",
    "ksh",
    "ash",
    "fish",
    "pwsh",
    "powershell",
    "cmd",
    "node",
    "deno",
    "bun",
    "tsx",
    "ts-node",
    "python",
    "python3",
    "py",
    "ruby",
    "perl",
    "php",
];

/// 调用前缀：PowerShell 调用运算符 `&` / 点源 `.`、bash `source`、cmd `call` /
/// `start`、`exec`。其后的操作数就是被执行或引入的目标。
const CALL_PREFIXES: &[&str] = &["&", ".", "source", "call", "start", "exec"];

/// 包装前缀：只改变执行方式，其后才是真正的程序。
const WRAPPER_PREFIXES: &[&str] = &["sudo", "env", "nohup", "time"];

/// shell 脚本扩展名：超大 / 读取失败 / 不是文本时按命中处理（无法确认安全就交给用户）。
const SHELL_SCRIPT_EXTENSIONS: &[&str] = &[
    "sh", "bash", "zsh", "ksh", "fish", "command", "ps1", "psm1", "bat", "cmd",
];

/// 其余交给解释器执行的脚本扩展名：读取失败时跳过（不是 shell 命令文本）。
const OTHER_SCRIPT_EXTENSIONS: &[&str] = &[
    "js", "mjs", "cjs", "ts", "mts", "cts", "py", "rb", "pl", "php",
];

pub(super) enum ScriptSource {
    /// 读取到的脚本内容，参与规则匹配。
    Content { path: String, content: String },
    /// 确认是 shell 脚本却无法检查内容：调用方按命中处理。
    Unreadable { path: String, reason: String },
}

enum Inspection {
    NotScript,
    Script(String),
    Unreadable(String),
}

struct Token {
    text: String,
    quoted: bool,
}

/// 找出命令间接执行的全部脚本（含脚本内部继续引用的脚本）。
/// 同步文件 IO，调用方必须在阻塞线程池中执行。
pub(super) fn collect_script_sources(
    command: &str,
    working_directory: Option<&str>,
) -> Vec<ScriptSource> {
    let base = working_directory
        .map(str::trim)
        .filter(|dir| !dir.is_empty() && !is_ssh_path(dir))
        .map(PathBuf::from);
    let mut visited = HashSet::new();
    let mut sources = Vec::new();
    scan(command, base.as_deref(), 0, &mut visited, &mut sources);
    sources
}

fn scan(
    text: &str,
    base: Option<&Path>,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    sources: &mut Vec<ScriptSource>,
) {
    if depth >= MAX_SCRIPT_DEPTH {
        return;
    }
    let mut candidates = Vec::new();
    collect_candidates(text, 0, &mut candidates);
    for candidate in candidates {
        if sources.len() >= MAX_SCRIPTS {
            return;
        }
        let Some(path) = resolve_candidate(&candidate, base) else {
            continue;
        };
        if !visited.insert(path.clone()) {
            continue;
        }
        let display = path.to_string_lossy().to_string();
        match inspect(&path) {
            Inspection::NotScript => {}
            Inspection::Unreadable(reason) => sources.push(ScriptSource::Unreadable {
                path: display,
                reason,
            }),
            Inspection::Script(content) => {
                // 脚本内部的相对路径按脚本所在目录解析（PowerShell 的 $PSScriptRoot
                // 习惯写法）；取不到目录时沿用上层目录。
                let script_dir = path.parent().map(Path::to_path_buf);
                sources.push(ScriptSource::Content {
                    path: display,
                    content: content.clone(),
                });
                scan(
                    &content,
                    script_dir.as_deref().or(base),
                    depth + 1,
                    visited,
                    sources,
                );
            }
        }
    }
}

/// 从命令文本中收集可能是脚本路径的词。引号包住、且内部含空白的词视为内联
/// 命令（`bash -c "..."`、`cmd /c "..."`、`-Command "..."`），递归继续识别。
fn collect_candidates(text: &str, inline_depth: usize, out: &mut Vec<String>) {
    for tokens in split_statements(text) {
        statement_candidates(&tokens, out);
        if inline_depth >= MAX_INLINE_DEPTH {
            continue;
        }
        for token in tokens
            .iter()
            .filter(|token| token.quoted && token.text.chars().any(char::is_whitespace))
        {
            collect_candidates(&token.text, inline_depth + 1, out);
        }
    }
}

/// 一条语句里的脚本候选：调用前缀后的目标、解释器的操作数，或被直接执行的程序本身。
fn statement_candidates(tokens: &[Token], out: &mut Vec<String>) {
    let mut index = 0;
    // 跳过环境变量赋值与包装前缀（`FOO=1 sudo bash x.sh`）。
    while let Some(token) = tokens.get(index) {
        let lower = token.text.to_ascii_lowercase();
        if !token.quoted
            && (is_env_assignment(&token.text) || WRAPPER_PREFIXES.contains(&lower.as_str()))
        {
            index += 1;
        } else {
            break;
        }
    }
    let Some(first) = tokens.get(index) else {
        return;
    };
    let first_lower = first.text.to_ascii_lowercase();
    if !first.quoted && CALL_PREFIXES.contains(&first_lower.as_str()) {
        operand_candidates(&tokens[index + 1..], &first_lower, out);
        return;
    }
    let program = program_name(&first.text);
    if INTERPRETERS.contains(&program.as_str()) {
        operand_candidates(&tokens[index + 1..], &program, out);
    } else {
        // 直接执行：第一个词本身可能就是脚本（./deploy.sh、.\build.ps1、x.bat）。
        out.push(first.text.clone());
    }
}

/// 解释器 / 调用前缀之后的操作数：跳过选项，第一个操作数一律作为候选（带值的
/// 选项如 `-ExecutionPolicy Bypass` 会让它落空，因此其后凡带脚本扩展名的词也
/// 一并作为候选）。
fn operand_candidates(tokens: &[Token], program: &str, out: &mut Vec<String>) {
    let mut first_operand = true;
    for token in tokens {
        if is_option(token, program) {
            continue;
        }
        if first_operand || has_script_extension(&token.text) {
            out.push(token.text.clone());
        }
        first_operand = false;
    }
}

/// 按 `;`、`|`、`&&`、换行、括号与反引号把命令切成语句（引号内不切），每条语句是
/// 一组去掉引号的词。语句开头的单个 `&` 保留为调用运算符，语句中间的 `&` 视为
/// 分隔符（cmd 顺序执行 / bash 后台执行）。
fn split_statements(text: &str) -> Vec<Vec<Token>> {
    let mut statements = Vec::new();
    let mut current: Vec<Token> = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut quote: Option<char> = None;
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(open) = quote {
            if ch == open {
                quote = None;
            } else {
                word.push(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                quoted = true;
            }
            '\n' | '\r' | ';' | '|' | '(' | ')' | '{' | '}' | '`' => {
                push_word(&mut word, &mut quoted, &mut current);
                push_statement(&mut current, &mut statements);
            }
            '&' => {
                push_word(&mut word, &mut quoted, &mut current);
                if chars.peek() == Some(&'&') {
                    chars.next();
                    push_statement(&mut current, &mut statements);
                } else if current.is_empty() {
                    current.push(Token {
                        text: "&".to_string(),
                        quoted: false,
                    });
                } else {
                    push_statement(&mut current, &mut statements);
                }
            }
            c if c.is_whitespace() => push_word(&mut word, &mut quoted, &mut current),
            _ => word.push(ch),
        }
    }
    push_word(&mut word, &mut quoted, &mut current);
    push_statement(&mut current, &mut statements);
    statements
}

fn push_word(word: &mut String, quoted: &mut bool, current: &mut Vec<Token>) {
    if !word.is_empty() || *quoted {
        current.push(Token {
            text: std::mem::take(word),
            quoted: *quoted,
        });
    }
    *quoted = false;
}

fn push_statement(current: &mut Vec<Token>, statements: &mut Vec<Vec<Token>>) {
    if !current.is_empty() {
        statements.push(std::mem::take(current));
    }
}

fn is_env_assignment(text: &str) -> bool {
    text.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

fn is_option(token: &Token, program: &str) -> bool {
    if token.quoted {
        return false;
    }
    let text = token.text.as_str();
    text.starts_with('-') || (program == "cmd" && text.starts_with('/') && text.len() <= 3)
}

/// 程序名：取路径最后一段，小写并去掉 `.exe`。
fn program_name(text: &str) -> String {
    let name = text
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(text)
        .to_ascii_lowercase();
    match name.strip_suffix(".exe") {
        Some(stripped) => stripped.to_string(),
        None => name,
    }
}

fn extension_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

fn has_script_extension(text: &str) -> bool {
    let extension = extension_of(text);
    SHELL_SCRIPT_EXTENSIONS.contains(&extension.as_str())
        || OTHER_SCRIPT_EXTENSIONS.contains(&extension.as_str())
}

/// 候选词解析为本地路径：展开 `~`，相对路径按基准目录解析；SSH 路径不读取。
fn resolve_candidate(candidate: &str, base: Option<&Path>) -> Option<PathBuf> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() || trimmed.len() > 1024 || is_ssh_path(trimmed) {
        return None;
    }
    let path = PathBuf::from(crate::utils::paths::expand_home_dir(trimmed));
    if path.is_absolute() {
        Some(path)
    } else {
        base.map(|dir| dir.join(path))
    }
}

fn inspect(path: &Path) -> Inspection {
    let Ok(metadata) = std::fs::metadata(path) else {
        return Inspection::NotScript;
    };
    if !metadata.is_file() {
        return Inspection::NotScript;
    }
    let extension = extension_of(&path.to_string_lossy());
    let is_shell = if SHELL_SCRIPT_EXTENSIONS.contains(&extension.as_str()) {
        true
    } else if OTHER_SCRIPT_EXTENSIONS.contains(&extension.as_str()) {
        false
    } else if has_shebang(path) {
        true
    } else {
        return Inspection::NotScript;
    };
    let unreadable = |reason: String| {
        if is_shell {
            Inspection::Unreadable(reason)
        } else {
            Inspection::NotScript
        }
    };
    if metadata.len() > MAX_SCRIPT_BYTES {
        return unreadable(format!(
            "larger than {} MB",
            MAX_SCRIPT_BYTES / 1024 / 1024
        ));
    }
    match std::fs::read(path) {
        Ok(bytes) => match decode_script(&bytes) {
            Some(content) => Inspection::Script(content),
            None => unreadable("not a text file".to_string()),
        },
        Err(error) => unreadable(format!("read failed: {error}")),
    }
}

fn has_shebang(path: &Path) -> bool {
    let mut prefix = [0u8; 2];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut prefix))
        .is_ok()
        && &prefix == b"#!"
}

/// 解码脚本文本：识别 UTF-8 / UTF-16 BOM 与无 BOM 的 UTF-16；其余按 UTF-8 宽松
/// 解码（GBK 等本地编码的 .bat 中 ASCII 命令字节保持原样，规则仍能命中）。
/// 含大量 0 字节又不像 UTF-16 的内容视为二进制。
fn decode_script(bytes: &[u8]) -> Option<String> {
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return Some(String::from_utf8_lossy(rest).into_owned());
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        return Some(decode_utf16(rest, u16::from_le_bytes));
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        return Some(decode_utf16(rest, u16::from_be_bytes));
    }
    if !bytes.contains(&0) {
        return Some(String::from_utf8_lossy(bytes).into_owned());
    }
    // 无 BOM 的 UTF-16：ASCII 字符的高字节为 0，按 0 字节落在奇 / 偶位置判断字节序。
    let half = bytes.len() / 2;
    let odd_zeros = bytes.iter().skip(1).step_by(2).filter(|byte| **byte == 0).count();
    let even_zeros = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
    if odd_zeros * 2 >= half && even_zeros * 4 < half {
        Some(decode_utf16(bytes, u16::from_le_bytes))
    } else if even_zeros * 2 >= half && odd_zeros * 4 < half {
        Some(decode_utf16(bytes, u16::from_be_bytes))
    } else {
        None
    }
}

fn decode_utf16(bytes: &[u8], read_unit: fn([u8; 2]) -> u16) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| read_unit([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}
