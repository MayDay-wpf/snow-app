use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::Deserialize;
use std::path::Path;

use super::super::{database, FileReviewAnnotationRecord};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TextAnchor {
    kind: String,
    representation: String,
    start: u64,
    end: u64,
    start_line: u64,
    end_line: u64,
    quote: String,
    before: String,
    after: String,
    source_hash: String,
}

fn invalid(message: &str) -> Error {
    Error::new(Status::InvalidArg, message.to_owned())
}

// Match JavaScript String.trim, including BOM but not U+0085.
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn validate_anchor(anchor_json: &str) -> Result<()> {
    if anchor_json.len() > 32 * 1024 {
        return Err(invalid("File review anchorJson exceeds 32 KiB UTF-8"));
    }
    let anchor: TextAnchor = serde_json::from_str(anchor_json)
        .map_err(|_| invalid("Invalid file review text anchor JSON"))?;
    let quote_length = anchor.quote.encode_utf16().count() as u64;
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if anchor.kind != "text-range"
        || !matches!(anchor.representation.as_str(), "source" | "extracted-text")
        || anchor.end > MAX_SAFE_INTEGER
        || anchor.start >= anchor.end
        || anchor.end - anchor.start != quote_length
        || anchor.start_line < 1
        || anchor.end_line < anchor.start_line
        || anchor.end_line > MAX_SAFE_INTEGER
        || anchor.quote.trim_matches(js_whitespace).is_empty()
        || quote_length > 4096
        || anchor.before.encode_utf16().count() > 80
        || anchor.after.encode_utf16().count() > 80
        || anchor.source_hash.len() != 64
        || !anchor
            .source_hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(invalid("Invalid file review text anchor fields"));
    }
    Ok(())
}

fn normalize_content(content: &str) -> Result<&str> {
    let content = content.trim_matches(js_whitespace);
    if content.is_empty() || content.len() > 8 * 1024 {
        return Err(invalid(
            "File review content must be non-empty and at most 8 KiB UTF-8",
        ));
    }
    Ok(content)
}

fn validate_annotation_id(annotation_id: &str) -> Result<()> {
    if annotation_id.trim().is_empty()
        || annotation_id != annotation_id.trim()
        || annotation_id.chars().any(char::is_control)
    {
        return Err(invalid("File review annotation ID is required"));
    }
    Ok(())
}

/// Lexical normalization only: never opens the source file (including Office files).
/// Windows drive/UNC scopes are case-stable, POSIX/SSH scopes remain case-sensitive.
fn normalize_scope(
    database_path: &Path,
    source_key: &str,
    file_path: &str,
) -> Result<(String, String)> {
    let remote = if source_key == "local" {
        false
    } else if let Some(workspace_id) = source_key.strip_prefix("ssh:") {
        if workspace_id.trim_matches(js_whitespace).is_empty()
            || workspace_id.chars().any(char::is_control)
        {
            return Err(invalid(
                "SSH workspace ID must be non-empty and contain no control characters",
            ));
        }
        // Workspace IDs contain the persisted SSH URL; preserve the entire ID
        // after the outer ssh: prefix and match it exactly, never as a session ID.
        let kind: Option<String> = database::open_connection(database_path)
            .and_then(|connection| {
                connection
                    .query_row(
                        "SELECT kind FROM workspace_directories WHERE directory_id = ?1 LIMIT 1",
                        [workspace_id],
                        |row| row.get(0),
                    )
                    .optional()
            })
            .map_err(|error| {
                database::database_error(database_path, "validate file review SSH workspace", error)
            })?;
        if kind.as_deref() != Some("ssh") {
            return Err(invalid(
                "SSH sourceKey must reference a registered stable SSH workspace ID",
            ));
        }
        true
    } else {
        return Err(invalid(
            "File review sourceKey must be local or ssh:<workspaceId>",
        ));
    };
    if file_path.is_empty() || file_path.chars().any(char::is_control) {
        return Err(invalid("File review filePath must be an absolute path"));
    }
    if remote && (!file_path.starts_with('/') || file_path.contains('\\')) {
        return Err(invalid("SSH filePath must be a remote POSIX absolute path"));
    }
    let path = if remote {
        file_path.to_owned()
    } else {
        file_path.replace('\\', "/")
    };
    let bytes = path.as_bytes();
    let drive =
        !remote && bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":/";
    let unc = !remote && path.starts_with("//");
    let windows = drive || unc;
    let (prefix, tail, protected) = if drive {
        (path[..3].to_ascii_lowercase(), &path[3..], 0)
    } else if unc {
        ("//".to_owned(), &path[2..], 2)
    } else if path.starts_with('/') && (remote || !cfg!(windows)) {
        ("/".to_owned(), path.trim_start_matches('/'), 0)
    } else {
        return Err(invalid(
            "Local filePath must be fully qualified (drive, UNC or POSIX absolute)",
        ));
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in tail.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.len() <= protected {
                    return Err(invalid("File review path escapes its root"));
                }
                parts.pop();
            }
            _ => {
                if windows
                    && (part.contains([':', '<', '>', '"', '|', '?', '*'])
                        || part.ends_with(['.', ' ']))
                {
                    return Err(invalid("Invalid Windows file review path component"));
                }
                parts.push(part);
            }
        }
    }
    if parts.len() <= protected {
        return Err(invalid(
            "File review filePath must identify a file, not a root",
        ));
    }
    let normalized = format!("{prefix}{}", parts.join("/"));
    Ok((
        source_key.to_owned(),
        if windows {
            normalized.to_lowercase()
        } else {
            normalized
        },
    ))
}

pub fn list_file_review_annotations(
    database_path: &Path,
    source_key: &str,
    file_path: &str,
) -> Result<Vec<FileReviewAnnotationRecord>> {
    let (source_key, file_path) = normalize_scope(database_path, source_key, file_path)?;
    database::open_connection(database_path).and_then(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, annotation_id, source_key, file_path, anchor_json, content, created_at, updated_at
             FROM file_review_annotations WHERE source_key = ?1 AND file_path = ?2
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![source_key, file_path], map_row)?;
        rows.collect()
    }).map_err(|error| database::database_error(database_path, "list file review annotations", error))
}

pub fn create_file_review_annotation(
    database_path: &Path,
    source_key: &str,
    file_path: &str,
    anchor_json: &str,
    content: &str,
) -> Result<FileReviewAnnotationRecord> {
    let (source_key, file_path) = normalize_scope(database_path, source_key, file_path)?;
    validate_anchor(anchor_json)?;
    let content = normalize_content(content)?;
    database::with_write_lock(|| database::with_write_retry(|| {
        database::open_connection(database_path).and_then(|mut connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let annotation_id = database::create_snowflake_id();
            transaction.execute(
                "INSERT INTO file_review_annotations (id, annotation_id, source_key, file_path, anchor_json, content)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![database::create_snowflake_id(), annotation_id, source_key, file_path, anchor_json, content],
            )?;
            let record = fetch_record(&transaction, &source_key, &file_path, &annotation_id)?;
            transaction.commit()?;
            Ok(record)
        })
    }, "create file review annotation"))
    .map_err(|error| database::database_error(database_path, "create file review annotation", error))
}

pub fn update_file_review_annotation(
    database_path: &Path,
    source_key: &str,
    file_path: &str,
    annotation_id: &str,
    content: &str,
) -> Result<FileReviewAnnotationRecord> {
    let (source_key, file_path) = normalize_scope(database_path, source_key, file_path)?;
    validate_annotation_id(annotation_id)?;
    let content = normalize_content(content)?;
    database::with_write_lock(|| database::with_write_retry(|| {
        database::open_connection(database_path).and_then(|mut connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let changed = transaction.execute(
                "UPDATE file_review_annotations SET content = ?1, updated_at = datetime('now', 'localtime')
                 WHERE source_key = ?2 AND file_path = ?3 AND annotation_id = ?4",
                params![content, source_key, file_path, annotation_id],
            )?;
            if changed == 0 { return Err(rusqlite::Error::QueryReturnedNoRows); }
            let record = fetch_record(&transaction, &source_key, &file_path, annotation_id)?;
            transaction.commit()?;
            Ok(record)
        })
    }, "update file review annotation"))
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Error::from_reason("File review annotation not found in the requested scope"),
        other => database::database_error(database_path, "update file review annotation", other),
    })
}

pub fn delete_file_review_annotation(
    database_path: &Path,
    source_key: &str,
    file_path: &str,
    annotation_id: &str,
) -> Result<()> {
    let (source_key, file_path) = normalize_scope(database_path, source_key, file_path)?;
    validate_annotation_id(annotation_id)?;
    database::with_write_lock(|| database::with_write_retry(|| {
        database::open_connection(database_path).and_then(|mut connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute(
                "DELETE FROM file_review_annotations WHERE source_key = ?1 AND file_path = ?2 AND annotation_id = ?3",
                params![source_key, file_path, annotation_id],
            )?;
            transaction.commit()
        })
    }, "delete file review annotation"))
    .map_err(|error| database::database_error(database_path, "delete file review annotation", error))
}

fn fetch_record(
    connection: &Connection,
    source_key: &str,
    file_path: &str,
    annotation_id: &str,
) -> rusqlite::Result<FileReviewAnnotationRecord> {
    connection.query_row(
        "SELECT id, annotation_id, source_key, file_path, anchor_json, content, created_at, updated_at
         FROM file_review_annotations WHERE source_key = ?1 AND file_path = ?2 AND annotation_id = ?3",
        params![source_key, file_path, annotation_id], map_row,
    ).optional()?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

fn map_row(row: &Row) -> rusqlite::Result<FileReviewAnnotationRecord> {
    Ok(FileReviewAnnotationRecord {
        id: row.get(0)?,
        annotation_id: row.get(1)?,
        source_key: row.get(2)?,
        file_path: row.get(3)?,
        anchor_json: row.get(4)?,
        content: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
