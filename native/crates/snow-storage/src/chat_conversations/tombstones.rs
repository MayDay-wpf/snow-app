use rusqlite::{params, Connection, OptionalExtension};

/// 会话墓碑（deleted_conversations）：删除 / 归档把会话移出运行库时登记，
/// 仍在收尾的回合（中止中的流、子代理、WorkFlow 节点）持久化前据此丢弃
/// 迟到的写入，避免用 `ON CONFLICT DO NOTHING` 的插入把会话行重建出来。
///
/// 墓碑只需覆盖删除后短时间内的收尾窗口；超过保留期的墓碑在下次登记时
/// 顺带清理，表体积保持有界。
const TOMBSTONE_RETENTION: &str = "-7 days";

/// 登记会话墓碑。必须在删除 / 归档事务内调用，与会话行的移除原子生效。
pub fn record_conversation_tombstones(
    connection: &Connection,
    conversation_ids: &[String],
) -> rusqlite::Result<()> {
    if conversation_ids.is_empty() {
        return Ok(());
    }
    connection.execute(
        "DELETE FROM deleted_conversations
          WHERE deleted_at < datetime('now', 'localtime', ?1)",
        params![TOMBSTONE_RETENTION],
    )?;
    let mut statement = connection.prepare_cached(
        "INSERT INTO deleted_conversations (conversation_id, deleted_at)
         VALUES (?1, datetime('now', 'localtime'))
         ON CONFLICT(conversation_id) DO UPDATE SET deleted_at = excluded.deleted_at",
    )?;
    for conversation_id in conversation_ids {
        statement.execute(params![conversation_id])?;
    }
    Ok(())
}

/// 清除会话墓碑（归档还原回运行库时调用），还原后的会话可继续正常持久化。
pub fn clear_conversation_tombstones(
    connection: &Connection,
    conversation_ids: &[String],
) -> rusqlite::Result<()> {
    let mut statement = connection
        .prepare_cached("DELETE FROM deleted_conversations WHERE conversation_id = ?1")?;
    for conversation_id in conversation_ids {
        statement.execute(params![conversation_id])?;
    }
    Ok(())
}

/// 会话是否已被删除 / 归档（存在墓碑）。
pub fn is_conversation_tombstoned(
    connection: &Connection,
    conversation_id: &str,
) -> rusqlite::Result<bool> {
    connection
        .query_row(
            "SELECT 1 FROM deleted_conversations WHERE conversation_id = ?1 LIMIT 1",
            params![conversation_id],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
}
