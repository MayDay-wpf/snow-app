//! 数据库连接串脱敏：key=value 串（ADO.NET / ODBC / JDBC / libpq）、URI 串、
//! Oracle thin 串。只遮罩主机、用户名、密码，库名与端口保留。

use std::sync::OnceLock;

use regex::Regex;

use super::{
    add_match, is_definitely_code, is_placeholder_secret, should_mask_context_value,
    SensitiveMatch,
};

const MATCH_TYPE: &str = "db_connection";
const CONFIDENCE: f64 = 0.97;
/// 同一连接串内相邻键值对的最大间距（字节）。
const MAX_PAIR_GAP: usize = 160;
const HOST_PROTOCOL_PREFIXES: [&str; 4] = ["tcp:", "np:", "lpc:", "admin:"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum KeyKind {
    Host,
    User,
    Password,
    Other,
}

struct KeyHit {
    key_start: usize,
    end: usize,
    kind: KeyKind,
    /// password / passwd 即使单独出现也遮罩
    standalone: bool,
    value: Option<(usize, usize)>,
}

fn kv_key_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:^|[^A-Za-z0-9_.]|\\[nrt])(data[ \t]*source|network[ \t]*address|host[ \t]*name|hostaddr|host|server|address|addr|user[ \t]*id|user[ \t]*name|user|uid|password|passwd|pwd|initial[ \t]*catalog|database[ \t]*name|database|dbname|port|provider|driver|dsn|integrated[ \t]*security|trusted[_ \t]*connection|encrypt|trust[ \t]*server[ \t]*certificate|persist[ \t]*security[ \t]*info|connect(?:ion)?[ \t]*timeout|sslmode|charset|pooling|application[ \t]*name|multiple[ \t]*active[ \t]*result[ \t]*sets|auth[ \t]*source|service[ \t]*name|sid)[ \t]*=",
        )
        .unwrap()
    })
}

fn uri_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\b(jdbc(?::[a-z][a-z0-9+.\-]*)+|[a-z][a-z0-9+.\-]*)://([^\s/?#"'`<>\\;]+)"#,
        )
        .unwrap()
    })
}

fn oracle_thin_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\bjdbc:oracle:[a-z]+:(?:([^\s/@:;"'`<>\\]+)/([^\s@;"'`<>\\]+))?@(?://)?(\[[0-9a-f:.]+\]|[a-z0-9_.\-]+)"#,
        )
        .unwrap()
    })
}

fn key_kind(key: &str) -> (KeyKind, bool) {
    let normalized: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "datasource" | "networkaddress" | "hostname" | "hostaddr" | "host" | "server"
        | "address" | "addr" => (KeyKind::Host, false),
        "userid" | "username" | "user" | "uid" => (KeyKind::User, false),
        "password" | "passwd" => (KeyKind::Password, true),
        "pwd" => (KeyKind::Password, false),
        _ => (KeyKind::Other, false),
    }
}

/// 真实换行或 JSON 转义后的 `\n` / `\r`。
fn is_line_break_at(bytes: &[u8], i: usize) -> bool {
    matches!(bytes[i], b'\n' | b'\r')
        || (bytes[i] == b'\\' && matches!(bytes.get(i + 1), Some(b'n' | b'r')))
}

/// 解析 `key=` 之后的值，返回值的字节区间（不含引号）。
fn parse_value(text: &str, from: usize, kind: KeyKind) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut i = from;
    while i < bytes.len() && matches!(bytes[i], b' ' | b'\t') {
        i += 1;
    }
    let first = *bytes.get(i)?;
    // `==` 是比较运算
    if first == b'=' {
        return None;
    }

    let quote: Option<(&[u8], usize)> = match first {
        b'"' => Some((&b"\""[..], 1)),
        b'\'' => Some((&b"'"[..], 1)),
        b'{' => Some((&b"}"[..], 1)),
        b'\\' if bytes.get(i + 1) == Some(&b'"') => Some((&b"\\\""[..], 2)),
        _ => None,
    };
    if let Some((close, open_len)) = quote {
        let start = i + open_len;
        let mut j = start;
        while j < bytes.len() {
            if is_line_break_at(bytes, j) {
                return None;
            }
            if bytes[j..].starts_with(close) {
                // 连写两次视为转义（ADO.NET / ODBC 规则）
                if close.len() == 1 && bytes.get(j + 1) == Some(&close[0]) {
                    j += 2;
                    continue;
                }
                let after = j + close.len();
                let closed = after >= bytes.len()
                    || matches!(
                        bytes[after],
                        b';' | b' ' | b'\t' | b'\r' | b'\n' | b'\\' | b'"' | b'\'' | b',' | b')' | b'}' | b'&'
                    );
                return (closed && j > start).then_some((start, j));
            }
            j += 1;
        }
        return None;
    }

    let mut j = i;
    while j < bytes.len() {
        let b = bytes[j];
        if matches!(b, b';' | b'\r' | b'\n' | b'"' | b'\'' | b'`') {
            break;
        }
        if b == b'\\' && matches!(bytes.get(j + 1), Some(b'n' | b'r' | b't' | b'"' | b'u')) {
            break;
        }
        if kind != KeyKind::Password && matches!(b, b'&' | b')' | b'<' | b'>' | b'}') {
            break;
        }
        j += 1;
    }
    let mut end = j;
    // libpq 空格分隔：后续 token 仍含 `=` 时在首个空白处截断
    if let Some(ws) = bytes[i..end].iter().position(|b| matches!(b, b' ' | b'\t')) {
        if bytes[i + ws..end].contains(&b'=') {
            end = i + ws;
        }
    }
    while end > i
        && (matches!(bytes[end - 1], b' ' | b'\t')
            || (kind != KeyKind::Password && bytes[end - 1] == b','))
    {
        end -= 1;
    }
    (end > i).then_some((i, end))
}

fn is_adjacent(bytes: &[u8], prev_end: usize, next_start: usize) -> bool {
    if prev_end >= next_start {
        return true;
    }
    if next_start - prev_end > MAX_PAIR_GAP {
        return false;
    }
    !(prev_end..next_start).any(|i| is_line_break_at(bytes, i))
}

fn is_local_host(host: &str) -> bool {
    let lower = host.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "localhost" | "127.0.0.1" | "::1" | "[::1]" | "." | "(local)"
    ) || lower.starts_with("(localdb)")
}

/// `host:port` 只保留主机部分长度（IPv6 需带方括号）。
fn strip_port_len(item: &str) -> usize {
    if item.starts_with('[') {
        return item.find(']').map_or(item.len(), |p| p + 1);
    }
    match item.rfind(':') {
        Some(p)
            if !item[..p].contains(':') && item[p + 1..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            p
        }
        _ => item.len(),
    }
}

fn push_span(text: &str, (start, end): (usize, usize), matches: &mut Vec<SensitiveMatch>) {
    if end > start && !is_placeholder_secret(&text[start..end]) {
        add_match(matches, start, end, MATCH_TYPE, CONFIDENCE);
    }
}

/// 逗号分隔的主机列表，逐个去掉端口后遮罩。
fn mask_host_list(text: &str, start: usize, end: usize, matches: &mut Vec<SensitiveMatch>) {
    let mut pos = start;
    for item in text[start..end].split(',') {
        let host_len = strip_port_len(item);
        let host = &item[..host_len];
        if !host.trim().is_empty() && !is_local_host(host) {
            push_span(text, (pos, pos + host_len), matches);
        }
        pos += item.len() + 1;
    }
}

/// key=value 中的主机值：去掉 `tcp:` 等前缀，SQL Server 的 `,端口` 保留。
fn mask_kv_host(text: &str, start: usize, end: usize, matches: &mut Vec<SensitiveMatch>) {
    let lower = text[start..end].to_ascii_lowercase();
    let host_start = start
        + HOST_PROTOCOL_PREFIXES
            .iter()
            .find(|prefix| lower.starts_with(**prefix))
            .map_or(0, |prefix| prefix.len());
    let rest = &text[host_start..end];
    if let Some(comma) = rest.find(',') {
        let port = rest[comma + 1..].trim();
        if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) {
            mask_host_list(text, host_start, host_start + comma, matches);
            return;
        }
    }
    mask_host_list(text, host_start, end, matches);
}

fn mask_kv_hit(text: &str, hit: &KeyHit, grouped: bool, matches: &mut Vec<SensitiveMatch>) {
    let Some((start, end)) = hit.value else {
        return;
    };
    let value = &text[start..end];
    if is_placeholder_secret(value) {
        return;
    }
    // 主机/用户名是函数调用等代码表达式时跳过
    if matches!(hit.kind, KeyKind::Host | KeyKind::User) && is_definitely_code(value.trim()) {
        return;
    }
    match hit.kind {
        KeyKind::Password if grouped => push_span(text, (start, end), matches),
        KeyKind::Password if hit.standalone && should_mask_context_value(value, "password") => {
            push_span(text, (start, end), matches)
        }
        KeyKind::User if grouped => push_span(text, (start, end), matches),
        KeyKind::Host if grouped => mask_kv_host(text, start, end, matches),
        _ => {}
    }
}

/// 同一行内出现 >= 2 个连接串键才视为连接串，避免误伤普通 `host=` 配置。
fn collect_kv_matches(text: &str, matches: &mut Vec<SensitiveMatch>) {
    let bytes = text.as_bytes();
    let mut hits: Vec<KeyHit> = Vec::new();
    for caps in kv_key_pattern().captures_iter(text) {
        let (Some(whole), Some(key)) = (caps.get(0), caps.get(1)) else {
            continue;
        };
        let (kind, standalone) = key_kind(key.as_str());
        let value = parse_value(text, whole.end(), kind);
        hits.push(KeyHit {
            key_start: key.start(),
            end: value.map_or(whole.end(), |(_, end)| end),
            kind,
            standalone,
            value,
        });
    }

    let mut group_start = 0;
    for idx in 0..=hits.len() {
        let split = idx == hits.len()
            || (idx > group_start && !is_adjacent(bytes, hits[idx - 1].end, hits[idx].key_start));
        if !split {
            continue;
        }
        let group = &hits[group_start..idx];
        let grouped = group.len() >= 2;
        for hit in group {
            mask_kv_hit(text, hit, grouped, matches);
        }
        group_start = idx;
    }
}

fn is_db_scheme(scheme: &str) -> bool {
    let lower = scheme.to_ascii_lowercase();
    if lower.starts_with("jdbc:") {
        return true;
    }
    let base = lower.split('+').next().unwrap_or("");
    matches!(
        base,
        "postgres"
            | "postgresql"
            | "pgsql"
            | "mysql"
            | "mysqlx"
            | "mariadb"
            | "mongodb"
            | "redis"
            | "rediss"
            | "valkey"
            | "amqp"
            | "amqps"
            | "mssql"
            | "sqlserver"
            | "oracle"
            | "clickhouse"
            | "cockroachdb"
            | "couchdb"
            | "couchbase"
            | "couchbases"
            | "neo4j"
            | "bolt"
            | "cassandra"
            | "db2"
            | "tidb"
            | "influxdb"
            | "memcached"
            | "nats"
            | "kafka"
            | "mqtt"
            | "ldap"
            | "ldaps"
    )
}

/// `scheme://user:pass@host:port/db`：数据库协议遮罩用户/密码/主机，
/// 其他协议仅在带密码时遮罩用户和密码。
fn collect_uri_matches(text: &str, matches: &mut Vec<SensitiveMatch>) {
    for caps in uri_pattern().captures_iter(text) {
        let (Some(scheme), Some(authority)) = (caps.get(1), caps.get(2)) else {
            continue;
        };
        let db = is_db_scheme(scheme.as_str());
        let auth_start = authority.start();
        let auth_end = authority.end();
        let at = authority.as_str().rfind('@').map(|p| auth_start + p);
        let hosts_start = at.map_or(auth_start, |p| p + 1);

        if let Some(at) = at {
            let userinfo = &text[auth_start..at];
            let (user, pass) = match userinfo.find(':') {
                Some(c) => (
                    (auth_start, auth_start + c),
                    Some((auth_start + c + 1, at)),
                ),
                None => ((auth_start, at), None),
            };
            let has_pass =
                pass.map_or(false, |(s, e)| e > s && !is_placeholder_secret(&text[s..e]));
            if has_pass || db {
                push_span(text, user, matches);
                if let Some(pass) = pass {
                    push_span(text, pass, matches);
                }
            }
        }
        if db {
            mask_host_list(text, hosts_start, auth_end, matches);
        }
    }
}

/// `jdbc:oracle:thin:user/pass@host:1521:sid` 与 `jdbc:oracle:thin:@//host:1521/svc`。
fn collect_oracle_matches(text: &str, matches: &mut Vec<SensitiveMatch>) {
    for caps in oracle_thin_pattern().captures_iter(text) {
        for group in [1, 2] {
            if let Some(m) = caps.get(group) {
                push_span(text, (m.start(), m.end()), matches);
            }
        }
        if let Some(host) = caps.get(3) {
            if !is_local_host(host.as_str()) {
                push_span(text, (host.start(), host.end()), matches);
            }
        }
    }
}

pub(super) fn collect_db_connection_matches(text: &str, matches: &mut Vec<SensitiveMatch>) {
    if text.contains('=') {
        collect_kv_matches(text, matches);
    }
    if text.contains("://") {
        collect_uri_matches(text, matches);
    }
    if text.contains('@') {
        collect_oracle_matches(text, matches);
    }
}
