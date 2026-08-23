use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};

use super::super::database;
use super::super::{LspServerConfigInput, LspServerConfigRecord};
// 探测模块位于 mcp 层（纯 PATH 扫描、无副作用、不依赖 storage），
// 种子/迁移/校正需要它来判断命令是否真的可执行（enabled 语义见设计文档 §8.6）。
use crate::mcp::servers::lsp::probe;

pub fn list_lsp_server_configs(database_path: &Path) -> Result<Vec<LspServerConfigRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_lsp_server_configs(&connection))
        .map_err(|error| database::database_error(database_path, "list LSP server configs", error))
}

pub fn upsert_lsp_server_config(database_path: &Path, item: &LspServerConfigInput) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| upsert_lsp_server_config_with_connection(&connection, item))
        .map_err(|error| database::database_error(database_path, "upsert LSP server config", error))
}

pub fn delete_lsp_server_config(database_path: &Path, lang: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM lsp_server_configs WHERE lang = ?1",
                [lang],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete LSP server config", error))
}

/// 清空全部 LSP 服务器配置。
/// Phase 1.5 由 config-delete scope=lsp-config 调用（DB-backed scope）。
pub fn clear_lsp_server_configs(database_path: &Path) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute("DELETE FROM lsp_server_configs", [])?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "clear LSP server configs", error))
}

pub(crate) fn query_lsp_server_configs(
    connection: &Connection,
) -> rusqlite::Result<Vec<LspServerConfigRecord>> {
    let mut statement = connection.prepare(
        "SELECT id,
                lang,
                command,
                args_json,
                file_extensions_json,
                install_command,
                initialization_options_json,
                enabled,
                sort_order,
                source,
                updated_at
         FROM lsp_server_configs
         ORDER BY sort_order ASC, lang ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(LspServerConfigRecord {
            id: row.get(0)?,
            lang: row.get(1)?,
            command: row.get(2)?,
            args_json: row.get(3)?,
            file_extensions_json: row.get(4)?,
            install_command: row.get(5)?,
            initialization_options_json: row.get(6)?,
            enabled: row.get(7)?,
            sort_order: row.get(8)?,
            source: row.get(9)?,
            updated_at: row.get(10)?,
        })
    })?;
    rows.collect()
}

fn upsert_lsp_server_config_with_connection(
    connection: &Connection,
    item: &LspServerConfigInput,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO lsp_server_configs (
            id, lang, command, args_json, file_extensions_json, install_command,
            initialization_options_json, enabled, sort_order, source
         ) VALUES (
            lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
         )
         ON CONFLICT(lang) DO UPDATE SET
            command = excluded.command,
            args_json = excluded.args_json,
            file_extensions_json = excluded.file_extensions_json,
            install_command = excluded.install_command,
            initialization_options_json = excluded.initialization_options_json,
            enabled = excluded.enabled,
            sort_order = excluded.sort_order,
            source = excluded.source,
            updated_at = datetime('now', 'localtime')",
        params![
            item.lang,
            item.command,
            item.args_json,
            item.file_extensions_json,
            item.install_command.as_deref().unwrap_or(""),
            item.initialization_options_json
                .as_deref()
                .unwrap_or("{}"),
            item.enabled,
            item.sort_order,
            item.source,
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 迁移与种子（幂等；仅在表为空时执行一次）
// ---------------------------------------------------------------------------

/// 表是否为空。
pub fn is_empty(database_path: &Path) -> Result<bool> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM lsp_server_configs",
                [],
                |row| row.get(0),
            )?;
            Ok(count == 0)
        })
        .map_err(|error| database::database_error(database_path, "count LSP server configs", error))
}

/// 旧 ~/.snow/lsp-config.json 结构（迁移用）。
#[derive(serde::Deserialize)]
struct LegacyLspConfigFile {
    // Vec<(lang, config)> 保留 JSON 文档顺序（HashMap 会打乱顺序），
    // 迁移时未知 lang 需要按文件内相对顺序分配 sort_order。
    #[serde(default)]
    servers: Vec<(String, LegacyServerConfig)>,
}

#[derive(serde::Deserialize)]
struct LegacyServerConfig {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(rename = "fileExtensions", default)]
    file_extensions: Vec<String>,
    #[serde(rename = "installCommand", default)]
    install_command: Option<String>,
    #[serde(rename = "initializationOptions", default)]
    initialization_options: Option<serde_json::Value>,
}

/// 从旧 ~/.snow/lsp-config.json 一次性迁移到表（source=legacy）。
/// 文件缺失或解析失败时静默跳过（非致命，种子仍会执行）。
pub fn migrate_legacy_file(database_path: &Path, snow_dir: &Path) -> Result<()> {
    let legacy_path = snow_dir.join("lsp-config.json");
    if !legacy_path.exists() {
        return Ok(());
    }
    let content = match std::fs::read_to_string(&legacy_path) {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };
    let parsed: LegacyLspConfigFile = match serde_json::from_str(&content) {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    if parsed.servers.is_empty() {
        return Ok(());
    }

    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "migrate LSP configs", error))?;
    // sort_order 规范化（B1）：已知 lang 用种子顺序（typescript=0 优先于
    // tailwindcss，避免 .tsx/.jsx 被 tailwindcss 抢先匹配）；未知 lang 排
    // seed 之后，保持文件内相对顺序递增。
    let seed_orders = seed_sort_orders();
    let mut unknown_base = seed_orders.values().max().copied().unwrap_or(-1) + 1;
    for (lang, server) in parsed.servers {
        // enabled 按真实安装状态（命令在 PATH 中可执行）——未安装不启用（§8.6）。
        let enabled = probe::is_command_installed(&server.command);
        let sort_order = match seed_orders.get(&lang) {
            Some(order) => *order,
            None => {
                let order = unknown_base;
                unknown_base += 1;
                order
            }
        };
        let item = LspServerConfigInput {
            lang,
            command: server.command,
            args_json: serde_json::to_string(&server.args).unwrap_or_else(|_| "[]".into()),
            file_extensions_json: serde_json::to_string(&server.file_extensions)
                .unwrap_or_else(|_| "[]".into()),
            install_command: server.install_command,
            initialization_options_json: server.initialization_options.map(|v| v.to_string()),
            enabled,
            sort_order,
            source: "legacy".to_string(),
        };
        upsert_lsp_server_config_with_connection(&connection, &item)
            .map_err(|error| database::database_error(database_path, "migrate LSP server config", error))?;
    }
    Ok(())
}

/// 平台相关种子（附录 A 推荐清单；source=seed，仅插入缺失 lang，绝不覆盖已有记录）。
pub fn seed_defaults(database_path: &Path) -> Result<()> {
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "seed LSP configs", error))?;

    // 已存在的 lang 集合（跳过，不覆盖用户/迁移数据）。
    let mut existing: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let mut statement = connection
            .prepare("SELECT lang FROM lsp_server_configs")
            .map_err(|error| database::database_error(database_path, "seed LSP configs", error))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| database::database_error(database_path, "seed LSP configs", error))?;
        for row in rows {
            existing.insert(row.map_err(|error| {
                database::database_error(database_path, "seed LSP configs", error)
            })?);
        }
    }

    let seeds = default_seed_servers();
    for seed in seeds {
        if existing.contains(&seed.lang) {
            continue;
        }
        upsert_lsp_server_config_with_connection(&connection, &seed)
            .map_err(|error| database::database_error(database_path, "seed LSP server config", error))?;
    }
    Ok(())
}

/// 存量数据校正（启动时执行，幂等、无副作用）：仅对 `source=seed`/`source=legacy`
/// 且 `enabled=true` 的记录探测命令是否可执行，未安装 → 置为 `enabled=false`。
///
/// 覆盖修复旧版本种子/迁移写入的「启用但未安装」矛盾状态（§8.6）；不动
/// `source=manual` 与用户手动停用的记录（只做「未安装 → 停用」单向校正，
/// 绝不反向自动启用——用户安装服务器后需在设置页手动打开开关）。
pub fn reconcile_enabled_by_probe(database_path: &Path) -> Result<()> {
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "reconcile LSP install state", error))?;
    let records = query_lsp_server_configs(&connection)
        .map_err(|error| database::database_error(database_path, "reconcile LSP install state", error))?;
    let mut updated = 0u32;
    for record in records {
        if !record.enabled || (record.source != "seed" && record.source != "legacy") {
            continue;
        }
        if !probe::is_command_installed(&record.command) {
            connection
                .execute(
                    "UPDATE lsp_server_configs
                     SET enabled = 0, updated_at = datetime('now', 'localtime')
                     WHERE id = ?1",
                    [&record.id],
                )
                .map_err(|error| {
                    database::database_error(database_path, "reconcile LSP install state", error)
                })?;
            updated += 1;
        }
    }
    if updated > 0 {
        eprintln!("LSP install-state reconcile: disabled {updated} enabled-but-missing server(s)");
    }
    Ok(())
}

/// 种子顺序索引：lang → seed sort_order（B 规范化基准）。
/// 已知 lang 的 legacy 记录按此分配；未知 lang（种子之外的自定义服务器）
/// 排 seed 之后。
pub fn seed_sort_orders() -> std::collections::HashMap<String, i32> {
    default_seed_servers()
        .iter()
        .map(|server| (server.lang.clone(), server.sort_order))
        .collect()
}

/// 规范化 legacy 记录的 sort_order（启动时执行，幂等、无副作用）：
/// 已知 lang 改用种子顺序（typescript=0 优先于 tailwindcss，修复 legacy
/// 迁移按字母序分配导致 `.tsx/.jsx` 被 tailwindcss 抢先匹配的问题）；
/// 未知 lang 排 seed 之后、按当前 sort_order 相对顺序递增。
///
/// 只处理 `source=legacy` 记录；`source=seed`/`source=manual` 不触碰。
/// 幂等性：种子顺序固定；未知 lang 第一次执行后已按 sort_order 递增有序，
/// 第二次排序结果与分配序列一致，且已命中的记录不再写入（不更新
/// updated_at）。
pub fn normalize_legacy_sort_orders(database_path: &Path) -> Result<()> {
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "normalize LSP sort orders", error))?;
    let records = query_lsp_server_configs(&connection)
        .map_err(|error| database::database_error(database_path, "normalize LSP sort orders", error))?;

    let seed_orders = seed_sort_orders();
    // 未知 lang（legacy 且不在种子列表）：按当前 sort_order 排序后，
    // 从 max(seed sort_order) + 1 起递增分配。
    let mut unknown = records
        .iter()
        .filter(|record| record.source == "legacy" && !seed_orders.contains_key(&record.lang))
        .collect::<Vec<_>>();
    unknown.sort_by_key(|record| record.sort_order);
    let unknown_base = seed_orders.values().max().copied().unwrap_or(-1) + 1;
    let unknown_orders: std::collections::HashMap<String, i32> = unknown
        .iter()
        .enumerate()
        .map(|(index, record)| (record.lang.clone(), unknown_base + index as i32))
        .collect();

    let mut updated = 0u32;
    for record in &records {
        if record.source != "legacy" {
            continue;
        }
        // 每个 legacy lang 必然命中其一：已知 lang 在 seed_orders，
        // 未知 lang 在 unknown_orders（两者并集 = 全部 legacy lang）。
        let Some(target) = seed_orders
            .get(&record.lang)
            .copied()
            .or_else(|| unknown_orders.get(&record.lang).copied())
        else {
            continue;
        };
        if record.sort_order == target {
            continue;
        }
        connection
            .execute(
                "UPDATE lsp_server_configs
                 SET sort_order = ?1, updated_at = datetime('now', 'localtime')
                 WHERE id = ?2",
                params![target, &record.id],
            )
            .map_err(|error| {
                database::database_error(database_path, "normalize LSP sort orders", error)
            })?;
        updated += 1;
    }
    if updated > 0 {
        eprintln!("LSP sort-order normalize: updated {updated} legacy record(s)");
    }
    Ok(())
}

/// 按平台生成默认种子列表（附录 A / D）。
fn default_seed_servers() -> Vec<LspServerConfigInput> {
    let is_windows = cfg!(windows);
    let clangd_install = if is_windows {
        "winget install LLVM.LLVM"
    } else if cfg!(target_os = "macos") {
        "brew install llvm"
    } else {
        "apt install clangd"
    };
    let jdtls_install = if is_windows {
        "scoop install jdtls"
    } else if cfg!(target_os = "macos") {
        "brew install jdtls"
    } else {
        "apt install eclipse-jdtls"
    };
    let lua_install = if is_windows {
        "winget install lua-language-server"
    } else if cfg!(target_os = "macos") {
        "brew install lua-language-server"
    } else {
        "apt install lua-language-server"
    };

    let mut seeds = vec![
        LspServerConfigInput {
            lang: "typescript".into(),
            command: "typescript-language-server".into(),
            args_json: "[\"--stdio\"]".into(),
            file_extensions_json: "[\".ts\",\".tsx\",\".js\",\".jsx\",\".mts\",\".cts\",\".mjs\",\".cjs\"]".into(),
            install_command: Some("npm install -g typescript-language-server typescript".into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 0,
            source: "seed".into(),
        },
        LspServerConfigInput {
            lang: "python".into(),
            command: "pyright-langserver".into(),
            args_json: "[\"--stdio\"]".into(),
            file_extensions_json: "[\".py\",\".pyi\"]".into(),
            install_command: Some("pip install pyright".into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 1,
            source: "seed".into(),
        },
        LspServerConfigInput {
            lang: "go".into(),
            command: "gopls".into(),
            args_json: "[]".into(),
            file_extensions_json: "[\".go\"]".into(),
            install_command: Some("go install golang.org/x/tools/gopls@latest".into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 2,
            source: "seed".into(),
        },
        LspServerConfigInput {
            lang: "rust".into(),
            command: "rust-analyzer".into(),
            args_json: "[]".into(),
            file_extensions_json: "[\".rs\"]".into(),
            install_command: Some("rustup component add rust-analyzer".into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 3,
            source: "seed".into(),
        },
        LspServerConfigInput {
            lang: "c".into(),
            command: "clangd".into(),
            args_json: "[\"--background-index\"]".into(),
            file_extensions_json: "[\".c\",\".h\",\".cpp\",\".cc\",\".cxx\",\".hpp\",\".hxx\",\".C\",\".H\"]".into(),
            install_command: Some(clangd_install.into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 4,
            source: "seed".into(),
        },
        LspServerConfigInput {
            lang: "csharp".into(),
            command: "csharp-ls".into(),
            args_json: "[]".into(),
            file_extensions_json: "[\".cs\"]".into(),
            install_command: Some("dotnet tool install --global csharp-ls".into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 5,
            source: "seed".into(),
        },
        LspServerConfigInput {
            lang: "java".into(),
            command: "jdtls".into(),
            args_json: "[]".into(),
            file_extensions_json: "[\".java\"]".into(),
            install_command: Some(jdtls_install.into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 6,
            source: "seed".into(),
        },
        LspServerConfigInput {
            lang: "kotlin".into(),
            command: "kotlin-lsp".into(),
            args_json: "[\"--stdio\"]".into(),
            file_extensions_json: "[\".kt\",\".kts\"]".into(),
            install_command: Some(String::new()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 7,
            source: "seed".into(),
        },
        LspServerConfigInput {
            lang: "php".into(),
            command: "intelephense".into(),
            args_json: "[\"--stdio\"]".into(),
            file_extensions_json: "[\".php\"]".into(),
            install_command: Some("npm install -g intelephense".into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 8,
            source: "seed".into(),
        },
        LspServerConfigInput {
            lang: "ruby".into(),
            command: "ruby-lsp".into(),
            args_json: "[\"--stdio\"]".into(),
            file_extensions_json: "[\".rb\",\".rake\",\".gemspec\",\".ru\",\".erb\"]".into(),
            install_command: Some("gem install ruby-lsp".into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 9,
            source: "seed".into(),
        },
        LspServerConfigInput {
            lang: "lua".into(),
            command: "lua-language-server".into(),
            args_json: "[]".into(),
            file_extensions_json: "[\".lua\"]".into(),
            install_command: Some(lua_install.into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 10,
            source: "seed".into(),
        },
    ];

    // Swift：Windows 上不预置（附录 B：sourcekit-lsp Windows 支持不成熟）。
    if !is_windows {
        seeds.push(LspServerConfigInput {
            lang: "swift".into(),
            command: "sourcekit-lsp".into(),
            args_json: "[]".into(),
            file_extensions_json: "[\\\".swift\\\"]".into(),
            install_command: Some("随 Swift toolchain / Xcode 安装".into()),
            initialization_options_json: None,
            enabled: true,
            sort_order: 11,
            source: "seed".into(),
        });
    }

    // enabled 按真实安装状态（§8.6）：命令在 PATH 中可执行才默认启用；
    // 未安装的服务器保留配置但停用，避免「启用但无法使用」的矛盾状态。
    // 用户之后安装服务器后，可在设置页手动打开开关启用。
    for seed in &mut seeds {
        seed.enabled = probe::is_command_installed(&seed.command);
    }

    seeds
}
