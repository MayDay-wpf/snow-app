//! 旧版「基于 Git 的团队协作」数据一次性导入。
//!
//! 旧数据存放在 `<repo>/.snow/team-worktree/snow-team/` 下：每条记录一个
//! JSON 文件，附件放在 `media/<owner_id>/`。启用新团队时若检测到该目录，
//! 就把成员、记录与附件一次性搬进数据库，之后不再读取该目录。
//!
//! 全程只做文件系统读取与数据库写入，不执行任何 Git 命令。

use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};
use serde_json::Value;

use super::TeamMemberRecord;

const WORKTREE_REL: &str = ".snow/team-worktree";
const TEAM_DIR: &str = "snow-team";
const LEGACY_KINDS: [&str; 4] = ["message", "task", "review", "note"];
/// 旧笔记正文中的图片引用前缀（`snow-team/media/<owner_id>/<file>`）。
const LEGACY_MEDIA_PREFIX: &str = "snow-team/media/";
/// 新笔记正文中的图片引用前缀（`team-media:<media_id>`）。
const MEDIA_REF_PREFIX: &str = "team-media:";

fn legacy_root(repo_path: &str) -> PathBuf {
    Path::new(repo_path).join(WORKTREE_REL).join(TEAM_DIR)
}

/// 旧版团队数据是否存在（用于迁移提示与幂等判断）。
pub fn legacy_team_data_exists(repo_path: &str) -> bool {
    let repo_path = repo_path.trim();
    if repo_path.is_empty() {
        return false;
    }
    let root = legacy_root(repo_path);
    root.join("member").is_dir()
        || LEGACY_KINDS
            .iter()
            .any(|kind| root.join(kind).is_dir() && dir_has_json(&root.join(kind)))
}

fn dir_has_json(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .any(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        })
        .unwrap_or(false)
}

/// 把旧版团队数据导入指定团队，返回导入的记录条数（成员 + 记录）。
pub fn import_legacy_team_data(
    database_path: &Path,
    team_id: &str,
    repo_path: &str,
) -> Result<usize> {
    let repo_path = repo_path.trim().to_string();
    let team_id = team_id.trim().to_string();
    if repo_path.is_empty() || team_id.is_empty() {
        return Ok(0);
    }
    let root = legacy_root(&repo_path);
    if !root.is_dir() {
        return Ok(0);
    }
    let members = read_legacy_members(&root);
    let records = read_legacy_records(&root);
    let media = read_legacy_media(&root);

    super::with_connection(database_path, "import legacy team data", move |connection| {
        let media_ids = insert_media(connection, &team_id, &media)?;
        let mut imported = 0usize;
        for member in &members {
            super::upsert_member_with_connection(connection, &team_id, member, "", "")?;
            imported += 1;
        }
        for (kind, record_id, mut payload) in records {
            rewrite_media_refs(&kind, &mut payload, &media_ids);
            let text = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
            super::upsert_record_with_connection(connection, &team_id, &kind, &record_id, &text)?;
            imported += 1;
        }
        Ok(imported)
    })
}

// ===== 读取旧文件 =====

fn read_legacy_members(root: &Path) -> Vec<TeamMemberRecord> {
    let dir = root.join("member");
    let mut members = Vec::new();
    for value in read_json_dir(&dir) {
        let email = value
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if email.is_empty() {
            continue;
        }
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let role = value
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("member")
            .trim()
            .to_string();
        let color = value
            .get("avatarSeed")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        members.push(TeamMemberRecord {
            peer_id: email.clone(),
            name: if name.is_empty() { email.clone() } else { name },
            color,
            role: if role.is_empty() {
                "member".to_string()
            } else {
                role
            },
            online: false,
            joined_at: text_field(&value, "joinedAt"),
            last_seen: text_field(&value, "lastSeen"),
        });
    }
    members
}

fn read_legacy_records(root: &Path) -> Vec<(String, String, Value)> {
    let mut records = Vec::new();
    for kind in LEGACY_KINDS {
        for value in read_json_dir(&root.join(kind)) {
            let record_id = value
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if record_id.is_empty() {
                continue;
            }
            records.push((
                // 旧版评审没有投票模型：迁移为议题，避免迁移后数据不可见
                if kind == "review" { "topic".to_string() } else { kind.to_string() },
                record_id,
                normalize_payload(kind, value),
            ));
        }
    }
    records
}

/// 旧附件：`media/<owner_id>/<file>` 中的二进制内容。
fn read_legacy_media(root: &Path) -> Vec<(String, String, Vec<u8>)> {
    let mut media = Vec::new();
    let dir = root.join("media");
    let Ok(owners) = fs::read_dir(&dir) else {
        return media;
    };
    for owner in owners.flatten() {
        let owner_path = owner.path();
        if !owner_path.is_dir() {
            continue;
        }
        let Some(owner_id) = owner_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Ok(files) = fs::read_dir(&owner_path) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if !path.is_file() {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if let Ok(bytes) = fs::read(&path) {
                if !bytes.is_empty() && bytes.len() <= super::MEDIA_MAX_BYTES {
                    media.push((owner_id.to_string(), file_name.to_string(), bytes));
                }
            }
        }
    }
    media
}

fn read_json_dir(dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut values = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<Value>(&content) {
                values.push(value);
            }
        }
    }
    values
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

// ===== 写入数据库 =====

/// 插入旧附件，返回 `"<owner_id>/<file_name>" -> media_id` 映射。
fn insert_media(
    connection: &Connection,
    team_id: &str,
    media: &[(String, String, Vec<u8>)],
) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    let mut map = std::collections::HashMap::new();
    for (owner_id, file_name, bytes) in media {
        let media_id = super::new_id("media");
        connection.execute(
            "INSERT INTO team_media (
                id, team_id, media_id, owner_id, file_name, is_image, size, content, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                super::new_id("tmd"),
                team_id,
                media_id,
                owner_id,
                file_name,
                if is_image_name(file_name) { 1 } else { 0 },
                bytes.len() as i64,
                bytes,
                super::now_rfc3339(),
            ],
        )?;
        map.insert(format!("{owner_id}/{file_name}"), media_id);
    }
    Ok(map)
}

fn is_image_name(file_name: &str) -> bool {
    matches!(
        Path::new(file_name)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg"
    )
}

// ===== 字段与引用改写 =====

/// 把旧的 email 身份字段改写为 peer id 字段（迁移后统一以 peer id 寻址）。
fn normalize_payload(kind: &str, mut value: Value) -> Value {
    match kind {
        "message" | "note" => rename_keys(&mut value, &[("authorEmail", "authorPeerId")]),
        "task" => rename_keys(
            &mut value,
            &[
                ("creatorEmail", "creatorPeerId"),
                ("assigneeEmail", "assigneePeerId"),
            ],
        ),
        "review" => {
            rename_keys(
                &mut value,
                &[
                    ("creatorEmail", "creatorPeerId"),
                    ("summary", "description"),
                ],
            );
            if let Some(comments) = value.get_mut("comments").and_then(Value::as_array_mut) {
                for comment in comments {
                    rename_keys(comment, &[("authorEmail", "authorPeerId")]);
                }
            }
            // 议题字段：无投票、无否决；旧评审状态与评审人不再使用
            if let Some(object) = value.as_object_mut() {
                object.remove("status");
                object.remove("reviewerPeerId");
                object.insert("votes".to_string(), Value::Array(Vec::new()));
                object.insert("veto".to_string(), Value::Null);
                if !object.contains_key("taskId") {
                    object.insert("taskId".to_string(), Value::Null);
                }
                if !object.contains_key("description") {
                    object.insert("description".to_string(), Value::String(String::new()));
                }
            }
        }
        _ => {}
    }
    value
}

fn rename_keys(value: &mut Value, pairs: &[(&str, &str)]) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    for (from, to) in pairs {
        if let Some(item) = object.remove(*from) {
            object.insert((*to).to_string(), item);
        }
    }
}

/// 把记录里的旧附件路径改写为新的附件 id 引用。
fn rewrite_media_refs(
    kind: &str,
    payload: &mut Value,
    media_ids: &std::collections::HashMap<String, String>,
) {
    if kind == "message" {
        if let Some(attachments) = payload.get_mut("attachments").and_then(Value::as_array_mut) {
            for attachment in attachments {
                let Some(object) = attachment.as_object_mut() else {
                    continue;
                };
                let legacy_path = object
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let key = legacy_path
                    .strip_prefix(LEGACY_MEDIA_PREFIX)
                    .unwrap_or(&legacy_path)
                    .to_string();
                if let Some(media_id) = media_ids.get(&key) {
                    object.insert("id".to_string(), Value::String(media_id.clone()));
                }
                object.remove("path");
            }
        }
        return;
    }
    if kind == "note" {
        let Some(content) = payload.get("content").and_then(Value::as_str) else {
            return;
        };
        let rewritten = rewrite_note_content(content, media_ids);
        if let Some(object) = payload.as_object_mut() {
            object.insert("content".to_string(), Value::String(rewritten));
        }
    }
}

/// 把笔记正文中的 `snow-team/media/<owner>/<file>` 引用替换为 `team-media:<id>`。
fn rewrite_note_content(
    content: &str,
    media_ids: &std::collections::HashMap<String, String>,
) -> String {
    if !content.contains(LEGACY_MEDIA_PREFIX) {
        return content.to_string();
    }
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(index) = rest.find(LEGACY_MEDIA_PREFIX) {
        out.push_str(&rest[..index]);
        let tail = &rest[index + LEGACY_MEDIA_PREFIX.len()..];
        let end = tail
            .find(|ch: char| ch == ')' || ch == '"' || ch == '\'' || ch.is_whitespace())
            .unwrap_or(tail.len());
        let key = &tail[..end];
        match media_ids.get(key) {
            Some(media_id) => {
                out.push_str(MEDIA_REF_PREFIX);
                out.push_str(media_id);
            }
            None => {
                out.push_str(LEGACY_MEDIA_PREFIX);
                out.push_str(key);
            }
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}
