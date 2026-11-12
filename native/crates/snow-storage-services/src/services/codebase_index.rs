use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::params;

use super::super::database;

/// 项目向量表名前缀：每个项目一张 `cb_vec_<short_hash>` 表。
pub const VECTOR_TABLE_PREFIX: &str = "cb_vec_";

/// Sanitize a project id into a safe SQLite table name suffix.
/// Each project gets its own vector table: `cb_vec_<short_hash>`.
///
/// Uses the first 16 hex chars of blake3 (64 bits) to keep table names
/// short while maintaining negligible collision probability for project
/// counts encountered in practice.
pub fn vector_table_name(project_id: &str) -> String {
    let hash = blake3::hash(project_id.as_bytes()).to_hex();
    format!("{VECTOR_TABLE_PREFIX}{}", &hash[..16])
}

/// Ensure the vector table for the given project exists. Each project gets
/// its own table to keep vector data isolated and allow per-project cleanup.
///
/// Embeddings are stored as fixed-width little-endian `f32` BLOBs with a
/// precomputed norm column. Tables created by older versions (which stored
/// embeddings as JSON text) are upgraded in place by
/// [`ensure_vector_schema`]: every row is converted to a BLOB and the legacy
/// `embedding_json` column is dropped.
pub fn ensure_vector_table(database_path: &Path, project_id: &str) -> Result<String> {
    let table_name = vector_table_name(project_id);
    let connection = database::open_connection(database_path).map_err(|error| {
        database::database_error(database_path, "create codebase vector table", error)
    })?;
    connection
        .execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {table_name} (
               id TEXT PRIMARY KEY NOT NULL,
               project_id TEXT NOT NULL,
               file_path TEXT NOT NULL,
               relative_path TEXT NOT NULL,
               chunk_index INTEGER NOT NULL,
               start_line INTEGER NOT NULL,
               end_line INTEGER NOT NULL,
               content TEXT NOT NULL,
               embedding BLOB,
               norm REAL,
               embedding_model TEXT NOT NULL DEFAULT '',
               file_hash TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
             );
             CREATE INDEX IF NOT EXISTS idx_{table_name}_file
               ON {table_name}(relative_path);
             CREATE INDEX IF NOT EXISTS idx_{table_name}_chunk
               ON {table_name}(relative_path, chunk_index);"
        ))
        .map_err(|error| {
            database::database_error(database_path, "create codebase vector table", error)
        })?;
    ensure_vector_schema(database_path, &connection, &table_name).map_err(|error| {
        database::database_error(database_path, "upgrade codebase vector table", error)
    })?;

    Ok(table_name)
}

/// 已完成结构升级的 `(数据库路径, 表名)`，避免每次检索都跑 PRAGMA / DDL。
fn upgraded_vector_tables() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static UPGRADED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    UPGRADED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

fn table_columns(
    connection: &rusqlite::Connection,
    table_name: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    let mut columns = Vec::new();
    for row in rows {
        columns.push(row?);
    }
    Ok(columns)
}

/// Upgrade a vector table to the BLOB layout. Idempotent and cached per
/// process: each table is inspected at most once.
///
/// For legacy tables this converts every JSON `embedding_json` row to a BLOB
/// (in batches of 500) and then drops the column, so the old text is no longer
/// stored on disk. Rows whose JSON cannot be parsed keep a `NULL` embedding and
/// are simply skipped by retrieval; they are not deleted.
pub fn ensure_vector_schema(
    database_path: &Path,
    connection: &rusqlite::Connection,
    table_name: &str,
) -> rusqlite::Result<()> {
    let cache_key = format!("{}::{}", database_path.display(), table_name);
    {
        let upgraded = upgraded_vector_tables()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if upgraded.contains(&cache_key) {
            return Ok(());
        }
    }

    let columns = table_columns(connection, table_name)?;
    if columns.is_empty() {
        // 表还不存在：由 ensure_vector_table 的 CREATE TABLE 负责。
        return Ok(());
    }

    if !columns.iter().any(|column| column == "embedding") {
        connection.execute_batch(&format!(
            "ALTER TABLE {table_name} ADD COLUMN embedding BLOB;"
        ))?;
    }
    if !columns.iter().any(|column| column == "norm") {
        connection.execute_batch(&format!("ALTER TABLE {table_name} ADD COLUMN norm REAL;"))?;
    }

    if columns.iter().any(|column| column == "embedding_json") {
        migrate_legacy_vectors(connection, table_name)?;
        connection.execute_batch(&format!(
            "ALTER TABLE {table_name} DROP COLUMN embedding_json;"
        ))?;
    }

    let mut upgraded = upgraded_vector_tables()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    upgraded.insert(cache_key);
    Ok(())
}

/// 把 `embedding_json` 中的 JSON 文本分批转成 BLOB。每批独立提交，避免
/// 一次性长事务与整表数据在内存中累积。
fn migrate_legacy_vectors(
    connection: &rusqlite::Connection,
    table_name: &str,
) -> rusqlite::Result<()> {
    const BATCH_SIZE: i64 = 500;

    loop {
        let rows: Vec<(String, String)> = {
            let mut statement = connection.prepare(&format!(
                "SELECT id, embedding_json FROM {table_name}
                 WHERE embedding IS NULL AND embedding_json != ''
                 LIMIT ?1"
            ))?;
            let mapped = statement.query_map([BATCH_SIZE], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let mut collected = Vec::new();
            for row in mapped {
                collected.push(row?);
            }
            collected
        };
        if rows.is_empty() {
            return Ok(());
        }

        let mut updates: Vec<(String, Option<(Vec<u8>, f64)>)> = Vec::with_capacity(rows.len());
        for (id, json) in rows {
            let encoded = match serde_json::from_str::<Vec<f64>>(&json) {
                Ok(parsed) if !parsed.is_empty() => Some(encode_embedding(&parsed)),
                // 损坏的行保留但不再参与检索；清空旧文本以便后续批次推进。
                _ => None,
            };
            updates.push((id, encoded));
        }

        let transaction = connection.unchecked_transaction()?;
        {
            let mut update = transaction.prepare(&format!(
                "UPDATE {table_name}
                 SET embedding = ?1, norm = ?2, embedding_json = ''
                 WHERE id = ?3"
            ))?;
            for (id, encoded) in &updates {
                match encoded {
                    Some((blob, norm)) => {
                        update.execute(rusqlite::params![blob, norm, id])?;
                    }
                    None => {
                        update.execute(rusqlite::params![
                            Option::<Vec<u8>>::None,
                            Option::<f64>::None,
                            id
                        ])?;
                    }
                }
            }
        }
        transaction.commit()?;
    }
}

/// Encode a vector as fixed-width little-endian f32 values, together with its
/// Euclidean norm. BLOBs are roughly a quarter of the size of the old JSON
/// text and need no per-row parsing when searching.
fn encode_embedding(vector: &[f64]) -> (Vec<u8>, f64) {
    let mut bytes = Vec::with_capacity(vector.len() * 4);
    let mut sum = 0.0f64;
    for value in vector {
        bytes.extend_from_slice(&(*value as f32).to_le_bytes());
        sum += value * value;
    }
    (bytes, sum.sqrt())
}

pub fn decode_embedding(blob: &[u8]) -> Option<Vec<f32>> {
    if blob.is_empty() || blob.len() % 4 != 0 {
        return None;
    }
    Some(
        blob.chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect(),
    )
}

/// Drop the vector table for the given project (used when disabling codebase
/// or re-indexing from scratch).
pub fn drop_vector_table(database_path: &Path, project_id: &str) -> Result<()> {
    let table_name = vector_table_name(project_id);
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute_batch(&format!("DROP TABLE IF EXISTS {table_name};"))
        })
        .map_err(|error| {
            database::database_error(database_path, "drop codebase vector table", error)
        })
}

/// A single vector record to insert.
pub struct VectorInsert {
    pub id: String,
    pub file_path: String,
    pub relative_path: String,
    pub chunk_index: i32,
    pub start_line: i32,
    pub end_line: i32,
    pub content: String,
    pub embedding: Vec<f64>,
    pub embedding_model: String,
    pub file_hash: String,
}

/// Insert a batch of vectors into the project's vector table.
pub fn insert_vectors(
    database_path: &Path,
    project_id: &str,
    vectors: &[VectorInsert],
) -> Result<()> {
    let table_name = vector_table_name(project_id);
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            // Clear existing vectors for the files being updated (by file_path)
            // to avoid duplicates when re-indexing.
            let mut seen_files: std::collections::HashSet<&str> = std::collections::HashSet::new();
            for v in vectors {
                if seen_files.insert(&v.file_path) {
                    transaction.execute(
                        &format!("DELETE FROM {table_name} WHERE file_path = ?1"),
                        params![&v.file_path],
                    )?;
                }
            }
            for v in vectors {
                let (embedding_blob, norm) = encode_embedding(&v.embedding);
                transaction.execute(
                    &format!(
                        "INSERT INTO {table_name}
                         (id, project_id, file_path, relative_path, chunk_index,
                          start_line, end_line, content, embedding, norm,
                          embedding_model, file_hash)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
                    ),
                    params![
                        &v.id,
                        project_id,
                        &v.file_path,
                        &v.relative_path,
                        v.chunk_index,
                        v.start_line,
                        v.end_line,
                        &v.content,
                        embedding_blob,
                        norm,
                        &v.embedding_model,
                        &v.file_hash,
                    ],
                )?;
            }
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "insert codebase vectors", error))
}

/// Get statistics about the indexed vectors for a project.
#[derive(Debug, Clone, Default)]
pub struct IndexStats {
    pub total_chunks: i64,
    pub total_files: i64,
    pub total_size_bytes: i64,
}

pub fn get_index_stats(database_path: &Path, project_id: &str) -> Result<IndexStats> {
    let table_name = vector_table_name(project_id);
    database::open_connection(database_path)
        .and_then(|connection| {
            let total_chunks: i64 =
                connection.query_row(&format!("SELECT COUNT(*) FROM {table_name}"), [], |row| {
                    row.get(0)
                })?;
            let total_files: i64 = connection.query_row(
                &format!("SELECT COUNT(DISTINCT file_path) FROM {table_name}"),
                [],
                |row| row.get(0),
            )?;
            let total_size_bytes: i64 = connection.query_row(
                &format!("SELECT COALESCE(SUM(LENGTH(content)), 0) FROM {table_name}"),
                [],
                |row| row.get(0),
            )?;
            Ok(IndexStats {
                total_chunks,
                total_files,
                total_size_bytes,
            })
        })
        .map_err(|error| database::database_error(database_path, "get codebase index stats", error))
}

/// Get a map of `file_path -> file_hash` for all files that already have
/// vectors stored for the given project. Used by `start_codebase_embedding`
/// to skip files whose content hasn't changed since the last embedding run
/// (incremental re-indexing / resume after interruption).
///
/// Returns an empty map if the vector table doesn't exist yet.
pub fn get_indexed_file_hashes(
    database_path: &Path,
    project_id: &str,
) -> Result<std::collections::HashMap<String, String>> {
    let table_name = vector_table_name(project_id);
    let map = database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT file_path, file_hash FROM {table_name} WHERE file_hash != ''"
            ))?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let mut collected = std::collections::HashMap::new();
            for row in rows {
                let (file_path, file_hash) = row?;
                collected.insert(file_path, file_hash);
            }
            Ok(collected)
        })
        .unwrap_or_default();
    Ok(map)
}

/// Delete all vectors for a specific file in the project's vector table.
/// Used by the incremental sync logic when a file is deleted from disk or
/// is no longer eligible for embedding (e.g. added to .gitignore).
///
/// Returns the number of rows deleted. Returns 0 if the table doesn't exist
/// or the file has no vectors.
pub fn delete_vectors_for_file(
    database_path: &Path,
    project_id: &str,
    file_path: &str,
) -> Result<i64> {
    let table_name = vector_table_name(project_id);
    let deleted = database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                &format!("DELETE FROM {table_name} WHERE file_path = ?1"),
                params![file_path],
            )
        })
        .unwrap_or(0);
    Ok(deleted as i64)
}

/// Get the set of all indexed file paths for a project. Used by the
/// incremental sync logic to detect files that have been deleted from disk
/// (their vectors need to be removed).
///
/// Returns an empty set if the vector table doesn't exist yet.
pub fn get_indexed_file_paths(
    database_path: &Path,
    project_id: &str,
) -> Result<std::collections::HashSet<String>> {
    let table_name = vector_table_name(project_id);
    let set = database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement =
                connection.prepare(&format!("SELECT DISTINCT file_path FROM {table_name}"))?;
            let rows = statement.query_map([], |row| Ok(row.get::<_, String>(0)?))?;
            let mut collected = std::collections::HashSet::new();
            for row in rows {
                collected.insert(row?);
            }
            Ok(collected)
        })
        .unwrap_or_default();
    Ok(set)
}

/// A single search result from vector similarity search.
#[derive(Debug, Clone)]
pub struct SearchResult {
    pub file_path: String,
    pub relative_path: String,
    pub chunk_index: i32,
    pub start_line: i32,
    pub end_line: i32,
    pub content: String,
    /// Cosine similarity score in range [-1.0, 1.0]. Higher is more similar.
    pub score: f64,
}

/// Search the project's vector table for chunks most similar to the given
/// query vector. Returns up to `limit` results sorted by descending
/// cosine similarity.
///
/// This loads all stored embeddings into memory and computes cosine
/// similarity in Rust. SQLite has no native vector index, so this is the
/// simplest correct approach. For typical project sizes (thousands of
/// chunks) the in-memory computation is fast enough (< 50ms).
///
/// Returns an empty Vec if the vector table doesn't exist yet.
pub fn search_vectors(
    database_path: &Path,
    project_id: &str,
    query_vector: &[f64],
    limit: usize,
) -> Result<Vec<SearchResult>> {
    let table_name = vector_table_name(project_id);
    let query_norm = vector_norm(query_vector);
    if query_norm == 0.0 || limit == 0 {
        return Ok(Vec::new());
    }

    let connection = match database::open_connection(database_path) {
        Ok(connection) => connection,
        Err(_) => return Ok(Vec::new()),
    };
    // 旧索引表在检索路径上就地升级：补齐 BLOB 列、迁移 JSON 行并删除旧列。
    let _ = ensure_vector_schema(database_path, &connection, &table_name);

    // 阶段一：只读取 id 与向量（不碰 content），算完分数只保留 Top-K。
    // 正文可能占整表体积的绝大部分，旧实现把它一起读进内存纯属浪费。
    let mut scored = {
        let mut statement = match connection.prepare(&format!(
            "SELECT id, embedding, norm FROM {table_name}"
        )) {
            Ok(statement) => statement,
            Err(_) => return Ok(Vec::new()),
        };
        let rows = match statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<Vec<u8>>>(1)?,
                row.get::<_, Option<f64>>(2)?,
            ))
        }) {
            Ok(rows) => rows,
            Err(_) => return Ok(Vec::new()),
        };

        let mut scored: Vec<(f64, String)> = Vec::new();
        for row in rows {
            let Ok((id, blob, stored_norm)) = row else {
                continue;
            };
            let Some(vector) = blob.as_deref().and_then(decode_embedding) else {
                continue;
            };
            let norm = stored_norm.unwrap_or_else(|| norm_of(&vector));
            if norm == 0.0 || vector.len() != query_vector.len() {
                continue;
            }
            let dot: f64 = query_vector
                .iter()
                .zip(vector.iter())
                .map(|(query, stored)| query * (*stored as f64))
                .sum();
            scored.push((dot / (query_norm * norm), id));
        }
        scored
    };

    if scored.len() > limit {
        scored.select_nth_unstable_by(limit, |a, b| b.0.total_cmp(&a.0));
        scored.truncate(limit);
    }
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    if scored.is_empty() {
        return Ok(Vec::new());
    }

    // 阶段二：只回查选中块的正文。
    let ids: Vec<String> = scored.iter().map(|(_, id)| id.clone()).collect();
    let placeholders = vec!["?"; ids.len()].join(", ");
    let mut fetched: std::collections::HashMap<String, SearchResult> =
        std::collections::HashMap::with_capacity(ids.len());
    {
        let mut statement = match connection.prepare(&format!(
            "SELECT id, file_path, relative_path, chunk_index, start_line, end_line, content
             FROM {table_name} WHERE id IN ({placeholders})"
        )) {
            Ok(statement) => statement,
            Err(_) => return Ok(Vec::new()),
        };
        let rows = match statement.query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                SearchResult {
                    file_path: row.get(1)?,
                    relative_path: row.get(2)?,
                    chunk_index: row.get(3)?,
                    start_line: row.get(4)?,
                    end_line: row.get(5)?,
                    content: row.get(6)?,
                    score: 0.0,
                },
            ))
        }) {
            Ok(rows) => rows,
            Err(_) => return Ok(Vec::new()),
        };
        for row in rows {
            if let Ok((id, result)) = row {
                fetched.insert(id, result);
            }
        }
    }

    let mut results = Vec::with_capacity(scored.len());
    for (score, id) in scored {
        if let Some(mut result) = fetched.remove(&id) {
            result.score = score;
            results.push(result);
        }
    }

    Ok(results)
}

/// A per-file summary row for the codebase index table view.
#[derive(Debug, Clone, Default)]
pub struct IndexedFileRecord {
    pub relative_path: String,
    pub file_path: String,
    pub chunk_count: i64,
    pub start_line: i64,
    pub end_line: i64,
    pub size_bytes: i64,
    pub updated_at: String,
}

/// A file with its aggregated (mean) embedding vector, used by the 3D
/// similarity sphere view.
#[derive(Debug, Clone, Default)]
pub struct FileEmbeddingRecord {
    pub relative_path: String,
    pub chunk_count: i64,
    pub start_line: i64,
    pub end_line: i64,
    pub size_bytes: i64,
    pub embedding: Vec<f64>,
}

/// Compute the mean embedding for up to `limit` files (sorted by relative
/// path). Used by the 3D similarity visualization to place files in space
/// according to their real semantic distance.
///
/// Returns an empty Vec if the vector table doesn't exist yet.
pub fn get_file_embeddings(
    database_path: &Path,
    project_id: &str,
    limit: i64,
) -> Result<Vec<FileEmbeddingRecord>> {
    let table_name = vector_table_name(project_id);
    let limit = limit.clamp(1, 2000);

    let records = database::open_connection(database_path)
        .and_then(|connection| {
            let _ = ensure_vector_schema(database_path, &connection, &table_name);
            let mut statement = connection.prepare(&format!(
                "SELECT relative_path, file_path, chunk_index, start_line, end_line,
                        LENGTH(content), embedding
                 FROM {table_name}
                 WHERE file_path IN (
                   SELECT file_path FROM {table_name}
                   GROUP BY file_path
                   ORDER BY relative_path ASC
                   LIMIT ?1
                 )
                 ORDER BY file_path ASC, chunk_index ASC"
            ))?;
            let rows = statement.query_map(params![limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, i32>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<Vec<u8>>>(6)?,
                ))
            })?;

            // Aggregate chunks per file, accumulating the mean embedding.
            let mut by_file: std::collections::HashMap<String, (FileEmbeddingRecord, usize)> =
                std::collections::HashMap::new();

            for row in rows {
                let (
                    relative_path,
                    file_path,
                    _chunk_index,
                    start_line,
                    end_line,
                    content_len,
                    embedding_blob,
                ) = row?;
                let Some(embedding) = embedding_blob.as_deref().and_then(decode_embedding) else {
                    continue;
                };
                let embedding: Vec<f64> = embedding
                    .into_iter()
                    .map(|value| value as f64)
                    .collect();
                let entry = by_file.entry(file_path.clone()).or_insert_with(|| {
                    (
                        FileEmbeddingRecord {
                            relative_path: relative_path.clone(),
                            chunk_count: 0,
                            start_line: i64::MAX,
                            end_line: 0,
                            size_bytes: 0,
                            embedding: vec![0.0; embedding.len()],
                        },
                        0,
                    )
                });
                entry.0.chunk_count += 1;
                entry.0.start_line = entry.0.start_line.min(start_line as i64);
                entry.0.end_line = entry.0.end_line.max(end_line as i64);
                entry.0.size_bytes += content_len;
                for (acc, value) in entry.0.embedding.iter_mut().zip(embedding.iter()) {
                    *acc += value;
                }
            }

            let mut result: Vec<FileEmbeddingRecord> = by_file
                .into_values()
                .map(|(mut record, _)| {
                    if record.chunk_count > 0 {
                        for value in record.embedding.iter_mut() {
                            *value /= record.chunk_count as f64;
                        }
                    }
                    record
                })
                .collect();
            result.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
            Ok(result)
        })
        .unwrap_or_default();

    Ok(records)
}

/// List indexed files for a project, aggregated per file, sorted by relative
/// path, with simple pagination (1-based `page`, clamped `page_size`).
///
/// Returns `(records, total_file_count)`. Returns empty values if the vector
/// table doesn't exist yet.
pub fn list_indexed_files(
    database_path: &Path,
    project_id: &str,
    page: i64,
    page_size: i64,
) -> Result<(Vec<IndexedFileRecord>, i64)> {
    let table_name = vector_table_name(project_id);
    let page_size = page_size.clamp(1, 100);
    let offset = (page.max(1) - 1) * page_size;

    let (records, total) = database::open_connection(database_path)
        .and_then(|connection| {
            let total: i64 = connection.query_row(
                &format!("SELECT COUNT(DISTINCT file_path) FROM {table_name}"),
                [],
                |row| row.get(0),
            )?;

            let mut statement = connection.prepare(&format!(
                "SELECT relative_path, file_path,
                        COUNT(*) AS chunk_count,
                        MIN(start_line) AS start_line,
                        MAX(end_line) AS end_line,
                        SUM(LENGTH(content)) AS size_bytes,
                        MAX(created_at) AS updated_at
                 FROM {table_name}
                 GROUP BY file_path
                 ORDER BY relative_path ASC
                 LIMIT ?1 OFFSET ?2"
            ))?;
            let rows = statement.query_map(params![page_size, offset], |row| {
                Ok(IndexedFileRecord {
                    relative_path: row.get(0)?,
                    file_path: row.get(1)?,
                    chunk_count: row.get(2)?,
                    start_line: row.get(3)?,
                    end_line: row.get(4)?,
                    size_bytes: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })?;
            let mut collected = Vec::new();
            for row in rows {
                collected.push(row?);
            }
            Ok((collected, total))
        })
        .unwrap_or_default();

    Ok((records, total))
}

fn vector_norm(v: &[f64]) -> f64 {
    v.iter().map(|x| x * x).sum::<f64>().sqrt()
}

fn norm_of(vector: &[f32]) -> f64 {
    vector
        .iter()
        .map(|value| (*value as f64) * (*value as f64))
        .sum::<f64>()
        .sqrt()
}
