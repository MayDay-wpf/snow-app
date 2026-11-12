//! 通用文本截断助手。

/// 按字节预算截断并保证落在 UTF-8 字符边界上。
pub fn truncate_utf8_safe(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// 自定义请求头中的会话 ID 占位符。
pub const SESSION_ID_PLACEHOLDER_TOKENS: &[&str] = &[
    "{{session_id}}",
    "{{sessionId}}",
    "{{conversation_id}}",
    "{{conversationId}}",
    "${session_id}",
    "${conversation_id}",
];

pub fn contains_session_id_placeholder(value: &str) -> bool {
    SESSION_ID_PLACEHOLDER_TOKENS
        .iter()
        .any(|token| value.contains(token))
}

/// 展开自定义请求头中的会话 ID 占位符；空会话 ID 时清空该头。
pub fn expand_custom_header_session_id(
    headers: &mut std::collections::HashMap<String, String>,
    session_id: &str,
) {
    let session_id = session_id.trim();

    for value in headers.values_mut() {
        if !contains_session_id_placeholder(value) {
            continue;
        }

        if session_id.is_empty() {
            value.clear();
            continue;
        }

        let mut expanded = value.clone();
        for token in SESSION_ID_PLACEHOLDER_TOKENS {
            if expanded.contains(token) {
                expanded = expanded.replace(token, session_id);
            }
        }
        *value = expanded;
    }
}
