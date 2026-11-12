use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};

use super::super::database;
use super::super::{SensitiveCommandConfigInput, SensitiveCommandConfigRecord};

struct PresetSensitiveCommand {
    command_id: &'static str,
    pattern: &'static str,
    description: &'static str,
    enabled: bool,
}

const PRESET_SENSITIVE_COMMANDS: &[PresetSensitiveCommand] = &[
    // rm 必须是独立命令词（前一个字符不是 `-` 或词字符），且后跟至少一个
    // 参数，才可能产生删除行为。旧规则 "rm " 无词边界，会误匹配 arm64、
    // warm、--rm、--format 等任意包含 rm 的子串。
    PresetSensitiveCommand {
        command_id: "rm",
        pattern: r"(?:^|[^-\w])rm\s+\S",
        description: "Delete files or directories (rm, rm -rf, etc.)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "rmdir",
        pattern: "rmdir ",
        description: "Remove directories",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "unlink",
        pattern: "unlink ",
        description: "Delete files using unlink command",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "mv-to-trash",
        pattern: "mv .* /tmp",
        description: "Move files to trash/tmp (potential data loss)",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "chmod",
        pattern: "chmod ",
        description: "Change file permissions",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "chown",
        pattern: "chown ",
        description: "Change file ownership",
        enabled: false,
    },
    // dd 与 rm 同理：必须是独立命令词（前一个字符不是 `-` 或词字符），
    // 且后跟至少一个参数，才可能产生实际的复制/覆写行为。旧规则 "dd "
    // 无词边界，会误匹配 git add、address、--add 等任意包含 "dd " 的子串。
    PresetSensitiveCommand {
        command_id: "dd",
        pattern: r"(?:^|[^-\w])dd\s+\S",
        description: "Low-level data copy (disk operations)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "mkfs",
        pattern: "mkfs",
        description: "Format filesystem",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "fdisk",
        pattern: "fdisk ",
        description: "Disk partition manipulation",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "killall",
        pattern: "killall ",
        description: "Kill all processes by name",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "pkill",
        pattern: "pkill ",
        description: "Kill processes by pattern",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "reboot",
        pattern: "reboot",
        description: "Reboot the system",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "shutdown",
        pattern: "shutdown ",
        description: "Shutdown the system",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "sudo",
        pattern: "sudo ",
        description: "Execute commands with superuser privileges",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "su",
        pattern: "su ",
        description: "Switch user",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "curl-post",
        pattern: "curl.*-X POST",
        description: "HTTP POST requests (potential data transmission)",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "wget",
        pattern: "wget ",
        description: "Download files from internet",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "git-push",
        pattern: "git push",
        description: "Push code to remote repository",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "git-force-push",
        pattern: "git push.*--force",
        description: "Force push to remote repository (destructive)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "git-force-push-short",
        pattern: "git push.*-f",
        description: "Force push to remote repository with -f flag (destructive)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "git-reset-hard",
        pattern: "git reset.*--hard",
        description: "Hard reset git repository (destructive)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "git-clean",
        pattern: "git clean.*-f",
        description: "Remove untracked files from git repository",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "git-revert",
        pattern: "git revert",
        description: "Revert git commits",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "git-reset",
        pattern: "git reset ",
        description: "Reset git repository state",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "npm-publish",
        pattern: "npm publish",
        description: "Publish package to npm registry",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "docker-rm",
        pattern: "docker rm",
        description: "Remove Docker containers",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "docker-rmi",
        pattern: "docker rmi",
        description: "Remove Docker images",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "powershell-remove-item",
        pattern: "Remove-Item",
        description: "PowerShell delete files or directories",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "powershell-remove-item-recurse",
        pattern: "Remove-Item.*Recurse",
        description: "PowerShell recursive delete (destructive)",
        enabled: true,
    },
    // CMD/PowerShell 内置别名：del/rd/erase 与 Remove-Item/rmdir 等价，
    // 但规则表无法覆盖（大小写不敏感由匹配层保证）。带词边界防止
    // 误伤 cancel、model、third 等含 "del "/"rd " 子串的普通词。
    PresetSensitiveCommand {
        command_id: "cmd-del",
        pattern: r"(?:^|[^\w])del\s+\S",
        description: "Delete files using del (CMD/PowerShell alias for Remove-Item)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "cmd-rd",
        pattern: r"(?:^|[^\w])rd\s+\S",
        description: "Remove directories using rd (CMD/PowerShell alias for rmdir)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "cmd-erase",
        pattern: r"(?:^|[^\w])erase\s+\S",
        description: "Delete files using erase (CMD alias for del)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "format-volume",
        pattern: "Format-Volume",
        description: "Format disk volume (destructive)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "mysql",
        pattern: "mysql ",
        description: "MySQL CLI client (direct database access)",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "psql",
        pattern: "psql ",
        description: "PostgreSQL CLI client (direct database access)",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "sqlite3",
        pattern: "sqlite3 ",
        description: "SQLite3 CLI (direct database access)",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "mongosh",
        pattern: "mongosh ",
        description: "MongoDB Shell (direct database access)",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "redis-cli",
        pattern: "redis-cli ",
        description: "Redis CLI client (direct cache/database access)",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "sqlcmd",
        pattern: "sqlcmd ",
        description: "SQL Server CLI client (direct database access)",
        enabled: false,
    },
    PresetSensitiveCommand {
        command_id: "sql-drop-table",
        pattern: "DROP TABLE",
        description: "SQL DROP TABLE statement (destroys table and all data)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "sql-drop-database",
        pattern: "DROP DATABASE",
        description: "SQL DROP DATABASE statement (destroys entire database)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "sql-truncate",
        pattern: "TRUNCATE ",
        description: "SQL TRUNCATE statement (removes all rows from table)",
        enabled: true,
    },
    PresetSensitiveCommand {
        command_id: "sql-delete",
        pattern: "DELETE FROM",
        description: "SQL DELETE statement (removes rows from table)",
        enabled: false,
    },
];

pub fn seed_default_sensitive_command_configs(database_path: &Path) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| seed_defaults_with_connection(&connection))
        .map_err(|error| {
            database::database_error(database_path, "seed sensitive command configs", error)
        })
}

pub fn list_sensitive_command_configs(
    database_path: &Path,
) -> Result<Vec<SensitiveCommandConfigRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_sensitive_command_configs(&connection))
        .map_err(|error| {
            database::database_error(database_path, "list sensitive command configs", error)
        })
}

pub fn upsert_sensitive_command_config(
    database_path: &Path,
    item: &SensitiveCommandConfigInput,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| upsert_sensitive_command_config_with_connection(&connection, item))
        .map_err(|error| {
            database::database_error(database_path, "upsert sensitive command config", error)
        })
}

pub fn delete_sensitive_command_config(database_path: &Path, command_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM sensitive_command_configs
                  WHERE command_id = ?1 AND is_preset = 0",
                params![command_id],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "delete sensitive command config", error)
        })
}

pub fn reset_sensitive_command_configs(database_path: &Path) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| reset_sensitive_command_configs_with_connection(&connection))
        .map_err(|error| {
            database::database_error(database_path, "reset sensitive command configs", error)
        })
}

fn reset_sensitive_command_configs_with_connection(connection: &Connection) -> rusqlite::Result<()> {
    // 移除所有非预设规则（手动添加、Snow CLI 导入等），只保留系统内置预设。
    connection.execute(
        "DELETE FROM sensitive_command_configs WHERE is_preset = 0",
        [],
    )?;

    // 将每个预设行恢复为系统默认值（pattern/description/enabled/排序/来源），
    // 缺失的预设（如新版本新增的内置规则）则补插。
    for (index, command) in PRESET_SENSITIVE_COMMANDS.iter().enumerate() {
        connection.execute(
            "INSERT INTO sensitive_command_configs (
               id,
               command_id,
               pattern,
               description,
               enabled,
               is_preset,
               sort_order,
               source,
               created_at,
               updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'preset', datetime('now', 'localtime'), datetime('now', 'localtime'))
             ON CONFLICT(command_id) DO UPDATE SET
               pattern = excluded.pattern,
               description = excluded.description,
               enabled = excluded.enabled,
               is_preset = 1,
               sort_order = excluded.sort_order,
               source = 'preset',
               updated_at = datetime('now', 'localtime')",
            params![
                database::create_snowflake_id(),
                command.command_id,
                command.pattern,
                command.description,
                command.enabled as i32,
                index as i32,
            ],
        )?;
    }

    Ok(())
}

fn seed_defaults_with_connection(connection: &Connection) -> rusqlite::Result<()> {
    // 迁移：旧版内置 rm 规则的正则 "rm " 无词边界，会误匹配 arm64、warm、
    // --rm、--format 等任意包含 "rm " 的子串。仅当该预设行仍保留旧 pattern
    // （即用户未手动编辑过 pattern）时才升级，用户自定义的 pattern 不受影响。
    connection.execute(
        "UPDATE sensitive_command_configs
            SET pattern = ?2,
                updated_at = datetime('now', 'localtime')
          WHERE command_id = ?1
            AND is_preset = 1
            AND pattern = ?3",
        params!["rm", r"(?:^|[^-\w])rm\s+\S", "rm "],
    )?;

    // 迁移：旧版内置 dd 规则的正则 "dd " 无词边界，会误匹配 git add、
    // address、--add 等任意包含 "dd " 的子串。仅当该预设行仍保留旧 pattern
    // （即用户未手动编辑过 pattern）时才升级，用户自定义的 pattern 不受影响。
    connection.execute(
        "UPDATE sensitive_command_configs
            SET pattern = ?2,
                updated_at = datetime('now', 'localtime')
          WHERE command_id = ?1
            AND is_preset = 1
            AND pattern = ?3",
        params!["dd", r"(?:^|[^-\w])dd\s+\S", "dd "],
    )?;

    for (index, command) in PRESET_SENSITIVE_COMMANDS.iter().enumerate() {
        connection.execute(
            "INSERT OR IGNORE INTO sensitive_command_configs (
               id,
               command_id,
               pattern,
               description,
               enabled,
               is_preset,
               sort_order,
               source,
               created_at,
               updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'preset', datetime('now', 'localtime'), datetime('now', 'localtime'))",
            params![
                database::create_snowflake_id(),
                command.command_id,
                command.pattern,
                command.description,
                command.enabled as i32,
                index as i32,
            ],
        )?;
    }

    Ok(())
}

fn query_sensitive_command_configs(
    connection: &Connection,
) -> rusqlite::Result<Vec<SensitiveCommandConfigRecord>> {
    let mut statement = connection.prepare(
        "SELECT id,
                command_id,
                pattern,
                description,
                enabled,
                is_preset,
                sort_order,
                source,
                updated_at
           FROM sensitive_command_configs
          ORDER BY is_preset DESC, sort_order ASC, id ASC",
    )?;

    let rows = statement.query_map([], |row| {
        let enabled: i64 = row.get(4)?;
        let is_preset: i64 = row.get(5)?;

        Ok(SensitiveCommandConfigRecord {
            id: row.get(0)?,
            command_id: row.get(1)?,
            pattern: row.get(2)?,
            description: row.get(3)?,
            enabled: enabled != 0,
            is_preset: is_preset != 0,
            sort_order: row.get(6)?,
            source: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;

    rows.collect()
}

fn upsert_sensitive_command_config_with_connection(
    connection: &Connection,
    item: &SensitiveCommandConfigInput,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO sensitive_command_configs (
           id,
           command_id,
           pattern,
           description,
           enabled,
           is_preset,
           sort_order,
           source,
           created_at,
           updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now', 'localtime'), datetime('now', 'localtime'))
         ON CONFLICT(command_id) DO UPDATE SET
           pattern = excluded.pattern,
           description = excluded.description,
           enabled = excluded.enabled,
           is_preset = excluded.is_preset,
           sort_order = excluded.sort_order,
           source = excluded.source,
           updated_at = datetime('now', 'localtime')",
        params![
            database::create_snowflake_id(),
            item.command_id,
            item.pattern,
            item.description,
            item.enabled as i32,
            item.is_preset as i32,
            item.sort_order,
            item.source,
        ],
    )?;

    Ok(())
}
