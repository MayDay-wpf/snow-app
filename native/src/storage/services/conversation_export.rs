use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::params;
use serde_json::json;

use super::super::database;
use super::super::{ChatConversationRecord, ChatMessageRecord};
use super::chat_conversations;

/// Supported export formats.
pub const FORMAT_MARKDOWN: &str = "markdown";
pub const FORMAT_HTML: &str = "html";
pub const FORMAT_JSON: &str = "json";
pub const FORMAT_CSV: &str = "csv";

/// 获取会话记录和全部消息，然后按照指定格式生成导出内容。
/// 所有 SQLite I/O 由调用方的 spawn_blocking 包裹，不会阻塞 Node.js 主线程。
pub fn export_conversation(
    database_path: &Path,
    conversation_id: &str,
    format: &str,
) -> Result<String> {
    let conversation = chat_conversations::get_chat_conversation(database_path, conversation_id)?
        .ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            format!("Conversation not found: {conversation_id}"),
        )
    })?;

    let messages = chat_conversations::list_chat_messages(database_path, conversation_id)?;

    let content = match format {
        FORMAT_MARKDOWN => render_markdown(&conversation, &messages),
        FORMAT_HTML => render_html(&conversation, &messages),
        FORMAT_JSON => render_json(&conversation, &messages)?,
        FORMAT_CSV => render_csv(&conversation, &messages)?,
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Unsupported export format: {format}"),
            ));
        }
    };

    Ok(content)
}

/// 返回指定格式的文件扩展名（不含点号）。
#[allow(dead_code)]
pub fn extension_for_format(format: &str) -> &'static str {
    match format {
        FORMAT_MARKDOWN => "md",
        FORMAT_HTML => "html",
        FORMAT_JSON => "json",
        FORMAT_CSV => "csv",
        _ => "txt",
    }
}

// ============================================================================
// Markdown
// ============================================================================

fn render_markdown(
    conversation: &ChatConversationRecord,
    messages: &[ChatMessageRecord],
) -> String {
    let title = display_title(conversation);
    let mut output = String::new();

    output.push_str(&format!("# {title}\n\n"));
    output.push_str(&format!(
        "- **Model**: {}\n",
        if conversation.model.is_empty() {
            "N/A"
        } else {
            &conversation.model
        }
    ));
    output.push_str(&format!("- **Created**: {}\n", conversation.created_at));
    output.push_str(&format!("- **Updated**: {}\n", conversation.updated_at));
    output.push_str(&format!("- **Messages**: {}\n\n", messages.len()));
    output.push_str("---\n\n");

    for message in messages {
        let role = normalize_role(&message.role);
        let label = role_label(&role);
        output.push_str(&format!("## {label}\n\n"));

        if !message.content.is_empty() {
            output.push_str(&message.content);
            output.push_str("\n\n");
        }

        if !message.thinking.is_empty() {
            output.push_str("<details>\n<summary>Thinking</summary>\n\n");
            output.push_str(&message.thinking);
            output.push_str("\n\n</details>\n\n");
        }

        if !message.tool_calls_json.is_empty()
            && message.tool_calls_json != "[]"
            && message.tool_calls_json != "null"
        {
            output.push_str("<details>\n<summary>Tool calls</summary>\n\n");
            output.push_str("```json\n");
            output.push_str(&message.tool_calls_json);
            output.push_str("\n```\n\n</details>\n\n");
        }
    }

    output
}

// ============================================================================
// HTML
// ============================================================================

fn render_html(conversation: &ChatConversationRecord, messages: &[ChatMessageRecord]) -> String {
    let title = html_escape(&display_title(conversation));
    let model = if conversation.model.is_empty() {
        "N/A"
    } else {
        &conversation.model
    };
    let mut output = String::new();

    output.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n");
    output.push_str("<meta charset=\"UTF-8\">\n");
    output.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n");
    output.push_str(&format!("<title>{title}</title>\n"));
    output.push_str(HTML_STYLE);
    output.push_str("</head>\n<body>\n");
    output.push_str("<div class=\"container\">\n");

    // ---- Header card ----
    output.push_str("<header class=\"header-card\">\n");
    output.push_str(&format!("<h1 class=\"header-title\">{title}</h1>\n"));

    // Meta pills
    output.push_str("<div class=\"meta-pills\">\n");
    output.push_str(&format!(
        "<span class=\"pill\"><span class=\"pill-label\">Model</span><span class=\"pill-value\">{}</span></span>\n",
        html_escape(model)
    ));
    output.push_str(&format!(
        "<span class=\"pill\"><span class=\"pill-label\">Messages</span><span class=\"pill-value\">{}</span></span>\n",
        messages.len()
    ));
    if conversation.input_tokens > 0 || conversation.output_tokens > 0 {
        let total = conversation.input_tokens + conversation.output_tokens;
        output.push_str(&format!(
            "<span class=\"pill\"><span class=\"pill-label\">Tokens</span><span class=\"pill-value\">{total}</span></span>\n"
        ));
    }
    if conversation.total_duration_ms > 0 {
        let secs = conversation.total_duration_ms as f64 / 1000.0;
        let dur = if secs >= 1.0 {
            format!("{secs:.1}s")
        } else {
            format!("{}ms", conversation.total_duration_ms)
        };
        output.push_str(&format!(
            "<span class=\"pill\"><span class=\"pill-label\">Duration</span><span class=\"pill-value\">{dur}</span></span>\n"
        ));
    }
    output.push_str("</div>\n"); // .meta-pills

    // Timestamps
    output.push_str("<div class=\"header-timestamps\">\n");
    output.push_str(&format!(
        "<span>Created: {}</span>\n",
        html_escape(&conversation.created_at)
    ));
    if conversation.updated_at != conversation.created_at {
        output.push_str(&format!(
            "<span>Updated: {}</span>\n",
            html_escape(&conversation.updated_at)
        ));
    }
    output.push_str("</div>\n"); // .header-timestamps
    output.push_str("</header>\n");

    // ---- Messages ----
    output.push_str("<div class=\"messages\">\n");
    for message in messages {
        let role = normalize_role(&message.role);
        let label = role_label(&role);
        let role_class = role_css_class(&role);
        let avatar = role_avatar(&role);
        let model_badge = if !message.model.is_empty() && role == "assistant" {
            format!(
                "<span class=\"msg-model\">{}</span>",
                html_escape(&message.model)
            )
        } else {
            String::new()
        };

        output.push_str(&format!("<article class=\"msg {role_class}\">\n"));
        output.push_str("<div class=\"msg-avatar-wrap\">\n");
        output.push_str(&format!(
            "<div class=\"msg-avatar avatar-{role_class}\">{avatar}</div>\n"
        ));
        output.push_str("<div class=\"msg-meta\">\n");
        output.push_str(&format!("<span class=\"msg-role\">{label}</span>\n"));
        if !model_badge.is_empty() {
            output.push_str(&model_badge);
            output.push('\n');
        }
        output.push_str("</div>\n"); // .msg-meta
        output.push_str("</div>\n"); // .msg-avatar-wrap

        output.push_str("<div class=\"msg-body\">\n");

        if !message.content.is_empty() {
            output.push_str("<div class=\"msg-content\">");
            output.push_str(&markdown_to_html(&message.content));
            output.push_str("</div>\n");
        }

        if !message.thinking.is_empty() {
            output.push_str("<details class=\"msg-thinking\"><summary>Thinking process</summary><div class=\"thinking-body\">");
            output.push_str(&markdown_to_html(&message.thinking));
            output.push_str("</div></details>\n");
        }

        if !message.tool_calls_json.is_empty()
            && message.tool_calls_json != "[]"
            && message.tool_calls_json != "null"
        {
            let pretty = format_json(&message.tool_calls_json);
            output.push_str("<details class=\"msg-tools\"><summary>Tool calls</summary><div class=\"tools-body\"><pre><code>");
            output.push_str(&html_escape(&pretty));
            output.push_str("</code></pre></div></details>\n");
        }

        output.push_str("</div>\n"); // .msg-body
        output.push_str("</article>\n");
    }
    output.push_str("</div>\n"); // .messages

    output.push_str("<footer class=\"export-footer\">Exported from Snow</footer>\n");
    output.push_str("</div>\n"); // .container
    output.push_str("</body>\n</html>\n");
    output
}

/// Try to pretty-print a JSON string; fall back to the original on failure.
fn format_json(raw: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
        .unwrap_or_else(|| raw.to_string())
}

/// Return a single-letter avatar for a role.
fn role_avatar(role: &str) -> &'static str {
    match role {
        "user" => "U",
        "assistant" => "A",
        "system" => "S",
        "developer" => "D",
        "tool" => "T",
        _ => "?",
    }
}

// ----------------------------------------------------------------------------
// Lightweight Markdown-to-HTML renderer
// ----------------------------------------------------------------------------

/// Convert a subset of Markdown to HTML. Handles fenced code blocks, headings,
/// blockquotes, unordered/ordered lists, horizontal rules, paragraphs, and
/// inline formatting (bold, italic, inline code, links).
fn markdown_to_html(md: &str) -> String {
    let lines: Vec<&str> = md.lines().collect();
    let mut out = String::new();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        // Skip empty lines between blocks
        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        // Fenced code block
        if trimmed.starts_with("```") {
            let lang = trimmed.trim_start_matches('`').trim();
            i += 1;
            let mut code = String::new();
            while i < lines.len() && !lines[i].trim_start().starts_with("```") {
                code.push_str(lines[i]);
                code.push('\n');
                i += 1;
            }
            // skip closing fence
            if i < lines.len() {
                i += 1;
            }
            let lang_attr = if lang.is_empty() {
                String::new()
            } else {
                format!(" class=\"language-{}\"", html_escape(lang))
            };
            out.push_str(&format!(
                "<pre><code{}>{}</code></pre>\n",
                lang_attr,
                html_escape(code.trim_end())
            ));
            continue;
        }

        // Horizontal rule
        if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            out.push_str("<hr>\n");
            i += 1;
            continue;
        }

        // Headings
        if let Some(rest) = trimmed.strip_prefix("# ") {
            out.push_str(&format!("<h1>{}</h1>\n", inline_md(rest)));
            i += 1;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("## ") {
            out.push_str(&format!("<h2>{}</h2>\n", inline_md(rest)));
            i += 1;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("### ") {
            out.push_str(&format!("<h3>{}</h3>\n", inline_md(rest)));
            i += 1;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("#### ") {
            out.push_str(&format!("<h4>{}</h4>\n", inline_md(rest)));
            i += 1;
            continue;
        }

        // Blockquote
        if trimmed.starts_with("> ") {
            let mut quote_lines = Vec::new();
            while i < lines.len() {
                let l = lines[i].trim();
                if let Some(rest) = l.strip_prefix("> ") {
                    quote_lines.push(rest);
                    i += 1;
                } else if l == ">" {
                    quote_lines.push("");
                    i += 1;
                } else {
                    break;
                }
            }
            let inner = markdown_to_html(&quote_lines.join("\n"));
            out.push_str(&format!("<blockquote>{}</blockquote>\n", inner.trim()));
            continue;
        }

        // Unordered list
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            let mut items = Vec::new();
            while i < lines.len() {
                let l = lines[i].trim();
                if let Some(rest) = l.strip_prefix("- ").or_else(|| l.strip_prefix("* ")) {
                    items.push(inline_md(rest));
                    i += 1;
                } else {
                    break;
                }
            }
            out.push_str("<ul>\n");
            for item in &items {
                out.push_str(&format!("<li>{item}</li>\n"));
            }
            out.push_str("</ul>\n");
            continue;
        }

        // Ordered list
        if ordered_list_item(trimmed).is_some() {
            let mut items = Vec::new();
            while i < lines.len() {
                let l = lines[i].trim();
                if let Some(rest) = ordered_list_item(l) {
                    items.push(inline_md(rest));
                    i += 1;
                } else {
                    break;
                }
            }
            out.push_str("<ol>\n");
            for item in &items {
                out.push_str(&format!("<li>{item}</li>\n"));
            }
            out.push_str("</ol>\n");
            continue;
        }

        // Paragraph: collect consecutive non-empty, non-block lines
        let mut para = Vec::new();
        while i < lines.len() {
            let l = lines[i].trim();
            if l.is_empty()
                || l.starts_with("```")
                || l == "---"
                || l == "***"
                || l == "___"
                || l.starts_with("# ")
                || l.starts_with("## ")
                || l.starts_with("### ")
                || l.starts_with("#### ")
                || l.starts_with("> ")
                || l.starts_with("- ")
                || l.starts_with("* ")
                || ordered_list_item(l).is_some()
            {
                break;
            }
            para.push(lines[i]);
            i += 1;
        }
        let joined = para.join("\n");
        out.push_str(&format!("<p>{}</p>\n", inline_md(&joined)));
    }

    out
}

/// Extract the text portion of an ordered-list item (e.g. "1. text" -> "text").
fn ordered_list_item(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() && bytes[idx].is_ascii_digit() {
        idx += 1;
    }
    if idx > 0
        && idx < bytes.len()
        && bytes[idx] == b'.'
        && idx + 1 < bytes.len()
        && bytes[idx + 1] == b' '
    {
        Some(&line[idx + 2..])
    } else {
        None
    }
}

/// Process inline Markdown: bold, italic, inline code, and links.
/// Inline code is processed first to protect its content from other formatting.
fn inline_md(text: &str) -> String {
    let mut result = String::new();
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '`' => {
                let mut code = String::new();
                let mut found_close = false;
                while let Some(&c) = chars.peek() {
                    if c == '`' {
                        chars.next();
                        found_close = true;
                        break;
                    }
                    code.push(c);
                    chars.next();
                }
                if found_close {
                    result.push_str(&format!("<code>{}</code>", html_escape(&code)));
                } else {
                    result.push('`');
                    result.push_str(&html_escape(&code));
                }
            }
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next(); // consume second '*'
                    let mut bold = String::new();
                    let mut found_close = false;
                    while let Some(&c) = chars.peek() {
                        if c == '*' && bold.chars().last().map_or(false, |lc| lc != '*') {
                            // check for closing **
                            chars.next();
                            if chars.peek() == Some(&'*') {
                                chars.next();
                                found_close = true;
                                break;
                            }
                            bold.push('*');
                        } else {
                            bold.push(c);
                            chars.next();
                        }
                    }
                    if found_close {
                        result.push_str(&format!("<strong>{}</strong>", inline_md(&bold)));
                    } else {
                        result.push_str("**");
                        result.push_str(&bold);
                    }
                } else {
                    let mut italic = String::new();
                    let mut found_close = false;
                    while let Some(&c) = chars.peek() {
                        if c == '*' {
                            chars.next();
                            found_close = true;
                            break;
                        }
                        italic.push(c);
                        chars.next();
                    }
                    if found_close {
                        result.push_str(&format!("<em>{}</em>", inline_md(&italic)));
                    } else {
                        result.push('*');
                        result.push_str(&italic);
                    }
                }
            }
            '[' => {
                let mut link_text = String::new();
                let mut found_bracket = false;
                while let Some(&c) = chars.peek() {
                    if c == ']' {
                        chars.next();
                        found_bracket = true;
                        break;
                    }
                    link_text.push(c);
                    chars.next();
                }
                if found_bracket && chars.peek() == Some(&'(') {
                    chars.next(); // consume '('
                    let mut url = String::new();
                    let mut found_paren = false;
                    while let Some(&c) = chars.peek() {
                        if c == ')' {
                            chars.next();
                            found_paren = true;
                            break;
                        }
                        url.push(c);
                        chars.next();
                    }
                    if found_paren {
                        result.push_str(&format!(
                            "<a href=\"{}\" target=\"_blank\" rel=\"noopener\">{}</a>",
                            html_escape(&url),
                            html_escape(&link_text)
                        ));
                    } else {
                        result.push('[');
                        result.push_str(&link_text);
                        result.push(']');
                    }
                } else {
                    result.push('[');
                    result.push_str(&link_text);
                }
            }
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '&' => result.push_str("&amp;"),
            '"' => result.push_str("&quot;"),
            '\'' => result.push_str("&#39;"),
            _ => result.push(ch),
        }
    }

    result
}

const HTML_STYLE: &str = r#"<style>
/* ===== Reset ===== */
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

/* ===== Design Tokens (Light) ===== */
:root {
  color-scheme: light;
  --bg: #f0f2f5;
  --bg-card: #ffffff;
  --bg-code: #f6f8fa;
  --bg-code-block: #1e1e2e;
  --bg-think: #f8f9fb;
  --bg-hover: #f3f4f6;
  --border: #e2e8f0;
  --border-light: #eef2f6;
  --text: #1a1a2e;
  --text-secondary: #475569;
  --text-muted: #94a3b8;
  --text-on-code: #cdd6f4;
  --accent: #6366f1;
  --accent-light: rgba(99, 102, 241, 0.08);
  --user-color: #3b82f6;
  --user-bg: #eff6ff;
  --assistant-color: #8b5cf6;
  --assistant-bg: #f5f3ff;
  --system-color: #64748b;
  --system-bg: #f8fafc;
  --tool-color: #f59e0b;
  --tool-bg: #fffbeb;
  --dev-color: #ec4899;
  --dev-bg: #fdf2f8;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --shadow-card: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03);
  --shadow-msg: 0 1px 2px rgba(0,0,0,0.03);
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "SF Mono", "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace;
}

/* ===== Design Tokens (Dark) ===== */
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #0a0a0f;
    --bg-card: #15151c;
    --bg-code: #1e1e2e;
    --bg-code-block: #11111b;
    --bg-think: #1a1a24;
    --bg-hover: #1f1f2a;
    --border: #2a2a35;
    --border-light: #222230;
    --text: #e4e4e7;
    --text-secondary: #a1a1aa;
    --text-muted: #6b6b76;
    --text-on-code: #cdd6f4;
    --accent: #818cf8;
    --accent-light: rgba(129, 140, 248, 0.12);
    --user-color: #60a5fa;
    --user-bg: rgba(59, 130, 246, 0.1);
    --assistant-color: #a78bfa;
    --assistant-bg: rgba(139, 92, 246, 0.1);
    --system-color: #94a3b8;
    --system-bg: rgba(100, 116, 139, 0.08);
    --tool-color: #fbbf24;
    --tool-bg: rgba(245, 158, 11, 0.1);
    --dev-color: #f472b6;
    --dev-bg: rgba(236, 72, 153, 0.1);
    --shadow-card: 0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.15);
    --shadow-msg: 0 1px 2px rgba(0,0,0,0.15);
  }
}

/* ===== Base ===== */
body {
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.7;
  font-size: 15px;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.container {
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 20px 80px;
}

/* ===== Scrollbar ===== */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--text-muted);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover { background: var(--text-secondary); background-clip: content-box; }

/* ===== Header Card ===== */
.header-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 28px 32px;
  margin-bottom: 28px;
  box-shadow: var(--shadow-card);
}
.header-title {
  font-size: 1.5em;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 18px;
  line-height: 1.3;
}
.meta-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--bg-hover);
  border: 1px solid var(--border-light);
  font-size: 0.8em;
}
.pill-label {
  color: var(--text-muted);
  font-weight: 500;
}
.pill-value {
  color: var(--text-secondary);
  font-weight: 600;
}
.header-timestamps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  font-size: 0.8em;
  color: var(--text-muted);
}

/* ===== Messages ===== */
.messages { display: flex; flex-direction: column; gap: 16px; }

.msg {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-msg);
  transition: border-color 0.15s ease;
}
.msg:hover { border-color: var(--text-muted); }

.msg-avatar-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px 0;
}
.msg-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75em;
  font-weight: 700;
  flex-shrink: 0;
}
.avatar-user { background: var(--user-color); color: #fff; }
.avatar-assistant { background: var(--assistant-color); color: #fff; }
.avatar-system { background: var(--system-color); color: #fff; }
.avatar-tool { background: var(--tool-color); color: #fff; }
.avatar-developer { background: var(--dev-color); color: #fff; }
.msg-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.msg-role {
  font-size: 0.85em;
  font-weight: 600;
  color: var(--text-secondary);
}
.msg-model {
  font-size: 0.7em;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-light);
  color: var(--accent);
  font-weight: 500;
  font-family: var(--font-mono);
}

.msg-body { padding: 10px 20px 16px 60px; }

/* ===== Message Content (Markdown) ===== */
.msg-content { color: var(--text); word-break: break-word; }
.msg-content > *:first-child { margin-top: 0; }
.msg-content > *:last-child { margin-bottom: 0; }

.msg-content p { margin: 10px 0; }
.msg-content h1, .msg-content h2, .msg-content h3, .msg-content h4 {
  margin: 20px 0 10px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.35;
}
.msg-content h1 { font-size: 1.3em; }
.msg-content h2 { font-size: 1.2em; }
.msg-content h3 { font-size: 1.1em; }
.msg-content h4 { font-size: 1em; }

.msg-content ul, .msg-content ol {
  margin: 10px 0;
  padding-left: 24px;
}
.msg-content li { margin: 4px 0; }

.msg-content blockquote {
  margin: 12px 0;
  padding: 8px 16px;
  border-left: 3px solid var(--accent);
  background: var(--accent-light);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-secondary);
}

.msg-content hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 18px 0;
}

/* Inline code */
.msg-content code, .thinking-body code, .tools-body code {
  font-family: var(--font-mono);
  font-size: 0.85em;
  padding: 2px 6px;
  background: var(--bg-code);
  border-radius: var(--radius-sm);
  color: var(--accent);
}

/* Code blocks */
.msg-content pre, .tools-body pre {
  margin: 12px 0;
  padding: 16px 18px;
  background: var(--bg-code-block);
  border-radius: var(--radius-md);
  overflow-x: auto;
  border: 1px solid var(--border);
}
.msg-content pre code, .tools-body pre code {
  font-family: var(--font-mono);
  font-size: 0.85em;
  padding: 0;
  background: none;
  color: var(--text-on-code);
  line-height: 1.55;
}

.msg-content a {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.15s ease;
}
.msg-content a:hover { border-bottom-color: var(--accent); }

/* ===== Thinking & Tool Calls ===== */
.msg-thinking, .msg-tools {
  margin-top: 12px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.msg-thinking summary, .msg-tools summary {
  cursor: pointer;
  padding: 10px 14px;
  font-size: 0.8em;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-hover);
  user-select: none;
  transition: background 0.15s ease, color 0.15s ease;
  list-style: none;
}
.msg-thinking summary::-webkit-details-marker,
.msg-tools summary::-webkit-details-marker { display: none; }
.msg-thinking summary::before,
.msg-tools summary::before {
  content: "\25B8";
  display: inline-block;
  margin-right: 6px;
  transition: transform 0.15s ease;
}
.msg-thinking[open] summary::before,
.msg-tools[open] summary::before { transform: rotate(90deg); }
.msg-thinking summary:hover,
.msg-tools summary:hover {
  background: var(--border-light);
  color: var(--text-secondary);
}
.thinking-body, .tools-body { padding: 14px 16px; }
.thinking-body {
  color: var(--text-secondary);
  font-size: 0.92em;
}
.thinking-body > *:first-child { margin-top: 0; }
.thinking-body > *:last-child { margin-bottom: 0; }

/* ===== Footer ===== */
.export-footer {
  text-align: center;
  margin-top: 32px;
  font-size: 0.8em;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

/* ===== Responsive ===== */
@media (max-width: 640px) {
  .container { padding: 16px 12px 48px; }
  .header-card { padding: 20px; }
  .header-title { font-size: 1.25em; }
  .msg-avatar-wrap { padding: 12px 14px 0; }
  .msg-body { padding: 8px 14px 14px 14px; }
}
</style>
"#;

// ============================================================================
// JSON
// ============================================================================

fn render_json(
    conversation: &ChatConversationRecord,
    messages: &[ChatMessageRecord],
) -> Result<String> {
    let conversation_json = conversation_to_json(conversation);
    let messages_json: Vec<serde_json::Value> = messages.iter().map(message_to_json).collect();

    let export = json!({
        "conversation": conversation_json,
        "messages": messages_json,
    });

    serde_json::to_string_pretty(&export).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize conversation to JSON: {error}"),
        )
    })
}

fn conversation_to_json(c: &ChatConversationRecord) -> serde_json::Value {
    json!({
        "conversationId": c.conversation_id,
        "title": c.title,
        "summary": c.summary,
        "lastMessagePreview": c.last_message_preview,
        "messageCount": c.message_count,
        "model": c.model,
        "status": c.status,
        "directoryId": c.directory_id,
        "forkedFromConversationId": c.forked_from_conversation_id,
        "forkMessageCount": c.fork_message_count,
        "conversationType": c.conversation_type,
        "parentConversationId": c.parent_conversation_id,
        "subAgentId": c.sub_agent_id,
        "subAgentName": c.sub_agent_name,
        "subAgentStatus": c.sub_agent_status,
        "subAgentError": c.sub_agent_error,
        "createdAt": c.created_at,
        "updatedAt": c.updated_at,
        "inputTokens": c.input_tokens,
        "outputTokens": c.output_tokens,
        "cacheCreationInputTokens": c.cache_creation_input_tokens,
        "cacheReadInputTokens": c.cache_read_input_tokens,
        "totalDurationMs": c.total_duration_ms,
    })
}

fn message_to_json(m: &ChatMessageRecord) -> serde_json::Value {
    json!({
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "thinking": m.thinking,
        "status": m.status,
        "model": m.model,
        "responseId": m.response_id,
        "checkpointId": m.checkpoint_id,
        "toolCallsJson": m.tool_calls_json,
        "createdAt": m.created_at,
    })
}

// ============================================================================
// CSV
// ============================================================================

fn render_csv(
    _conversation: &ChatConversationRecord,
    messages: &[ChatMessageRecord],
) -> Result<String> {
    let mut writer = csv::Writer::from_writer(vec![]);

    // CSV header
    writer
        .write_record(&[
            "id",
            "role",
            "content",
            "thinking",
            "status",
            "model",
            "response_id",
            "checkpoint_id",
            "tool_calls_json",
            "created_at",
        ])
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to write CSV header: {error}"),
            )
        })?;

    for message in messages {
        writer
            .write_record(&[
                &message.id,
                &message.role,
                &message.content,
                &message.thinking,
                &message.status,
                &message.model,
                &message.response_id,
                &message.checkpoint_id,
                &message.tool_calls_json,
                &message.created_at,
            ])
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to write CSV row: {error}"),
                )
            })?;
    }

    let bytes = writer.into_inner().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to finalize CSV: {error}"),
        )
    })?;

    String::from_utf8(bytes).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("CSV output is not valid UTF-8: {error}"),
        )
    })
}

// ============================================================================
// Helpers
// ============================================================================

fn display_title(conversation: &ChatConversationRecord) -> String {
    let title = if !conversation.summary.is_empty() {
        &conversation.summary
    } else if !conversation.title.is_empty() {
        &conversation.title
    } else {
        "Untitled"
    };
    title.to_string()
}

fn normalize_role(role: &str) -> String {
    let trimmed = role.trim().to_lowercase();
    match trimmed.as_str() {
        "user" | "human" => "user".to_string(),
        "assistant" | "ai" => "assistant".to_string(),
        "system" => "system".to_string(),
        "developer" => "developer".to_string(),
        "tool" | "function" => "tool".to_string(),
        _ => trimmed,
    }
}

fn role_label(role: &str) -> String {
    let upper = role[..1].to_uppercase() + &role[1..];
    upper
}

fn role_css_class(role: &str) -> &'static str {
    match role {
        "user" => "user",
        "assistant" => "assistant",
        "tool" => "tool",
        "system" => "system",
        "developer" => "developer",
        _ => "system",
    }
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[allow(dead_code)]
fn count_messages(database_path: &Path, conversation_id: &str) -> Result<i64> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )
        })
        .map_err(|error| database::database_error(database_path, "count chat messages", error))
}

#[allow(dead_code)]
fn conversation_summary_json(
    conversation: &ChatConversationRecord,
    message_count: usize,
) -> serde_json::Value {
    json!({
        "conversationId": conversation.conversation_id,
        "title": display_title(conversation),
        "model": conversation.model,
        "createdAt": conversation.created_at,
        "updatedAt": conversation.updated_at,
        "messageCount": message_count,
    })
}
