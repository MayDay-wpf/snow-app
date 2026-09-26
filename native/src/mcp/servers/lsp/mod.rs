//! LSP MCP service — external language-server integration.
//!
//! Consumes the `lsp_server_configs` table and drives external language
//! servers (rust-analyzer / gopls / pyright ...) over LSP stdio.
//!
//! Tools:
//! - `lsp-diagnostics`: per-file diagnostics (pull-first, push fallback)
//! - `lsp-hover`: symbol hover info as Markdown
//! - `lsp-goto` / `lsp-references` / `lsp-symbols`:
//!   semantic navigation (Phase 3; definition/type-definition/implementation
//!   merged into lsp-goto{kind} in the 2026-08-16 tool trim)
//!
//! Tools are OFF by default (§8.0): `collect_all_mcp_tools` filters them out
//! unless the table has at least one enabled server.
//!
//! Design: docs/zh-CN/4-架构与开发/7-LSP外部语言服务器接入设计.md

pub(crate) mod capabilities;
mod client;
mod config;
pub(crate) mod detect; // crate 内共享（exports 层 napi 导出「检测技术栈」）
mod diagnostics;
mod format;
pub(crate) mod manager; // crate 内共享（exports 层 napi 导出会话状态快照）
pub(crate) mod probe; // crate 内共享（storage 种子/迁移/校正也要探测，§8.6）
pub(crate) mod prompt_context;
pub(crate) mod resolve;
mod schemas;
mod session;
mod types;
mod workspace_queries;

// Workspace-aware exposure is consumed through prompt_context.
pub use probe::{probe_commands, ProbeResult};

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::remote_workspace::is_ssh_path;
use crate::storage::services::workspace_directories::get_workspace_directory_path;
use session::{PendingDiagnostics, PrepareResult, ServerSession};
use types::ServerConfig;

const SERVER_ID: &str = "lsp";

fn tool_schemas() -> Vec<McpTool> {
    schemas::tools()
}

pub struct LspService;

enum ResolvedTargetLocation {
    Exact {
        path: PathBuf,
        line: u32,
        column: u32,
        lang: String,
        symbol: Option<String>,
    },
    Ambiguous(Value),
}

impl LspService {
    pub fn new() -> Self {
        LspService
    }

    /// 异步执行入口（call.rs 的 `lsp-` 前缀分支分发）。
    pub async fn execute_lsp_tool(
        &self,
        tool_name: &str,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        match tool_name {
            "diagnostics" => self.execute_diagnostics(args, project_id).await,
            "hover" => self.execute_hover(args, project_id).await,
            "goto" => self.execute_goto(args, project_id).await,
            "references" => self.execute_references(args, project_id).await,
            "symbols" => self.execute_symbols(args, project_id).await,
            "rename" => self.execute_rename(args, project_id).await,
            "call-hierarchy" => self.execute_call_hierarchy(args, project_id).await,
            "type-hierarchy" => self.execute_type_hierarchy(args, project_id).await,
            "workspace-symbols" => self.execute_workspace_symbols(args, project_id).await,
            "workspace-diagnostics" => self.execute_workspace_diagnostics(args, project_id).await,
            "vulncheck" => self.execute_vulncheck(args, project_id).await,
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown lsp tool: \"{tool_name}\". Available tools: [diagnostics, hover, goto, references, symbols, rename, call-hierarchy, type-hierarchy, workspace-symbols, workspace-diagnostics, vulncheck]"
                ),
            )),
        }
    }

    /// codelens-* 代码定位工具的 LSP 优先执行（call.rs 的 `codelens-` 分支分发）。
    ///
    /// 项目启用了匹配文件语言的 LSP 服务器（外部命令可用、scope 允许）时，
    /// 优先通过外部 LSP 语义分析执行（跨文件解析准确），并把结果归一化为
    /// codelens 输出格式（前端 CodeLensToolCall 无感，附加 `"engine": "lsp"`
    /// 标记）。归一化映射：
    /// - `codelens-find_definition` → `lsp-goto`（kind=definition）
    /// - `codelens-find_references` → `lsp-references`
    /// - `codelens-file_outline` → `lsp-symbols`
    ///
    /// 返回 `Ok(None)` 表示 LSP 不可用（未配置 / 命令缺失 / 启动失败 /
    /// SSH 远程 / scope 禁用 / 参数缺失），调用方应回退到 CodeLensService
    /// 的 tree-sitter 静态分析——LSP 只是更优路径，不应阻断代码定位。
    pub async fn execute_codelens_preferred(
        &self,
        codelens_tool: &str,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Option<Value>> {
        let (lsp_tool, kind) = match codelens_tool {
            "find_definition" => ("goto", Some("definition")),
            "find_references" => ("references", None),
            "file_outline" => ("symbols", None),
            _ => return Ok(None),
        };
        let Some(file_path) = args.get("filePath").and_then(Value::as_str) else {
            return Ok(None);
        };
        // lsp 仅支持本地项目：SSH 远程路径不转发。
        if is_ssh_path(file_path) {
            return Ok(None);
        }
        // 用户显式禁用了 LSP 域（全局黑名单 / 项目 scope）时不转发；
        // scope 查询失败（DB 瞬时故障）同样视为不可用，静默回退静态分析
        //（LSP 只是更优路径，任何 LSP 侧错误都不应阻断代码定位）。
        let scope_allowed = match lsp_tool_scope_allowed(lsp_tool, project_id).await {
            Ok(allowed) => allowed,
            Err(error) => {
                lsp_app_log(
                    "warn",
                    "execute_codelens_preferred",
                    &format!(
                        "codelens-{codelens_tool} LSP scope check failed, falling back to static analysis"
                    ),
                    Some(&error.to_string()),
                )
                .await;
                return Ok(None);
            }
        };
        if !scope_allowed {
            return Ok(None);
        }
        // goto 需要注入 kind 参数（find_definition → kind=definition）。
        let mut effective_args = args.clone();
        if let Some(kind) = kind {
            effective_args["kind"] = json!(kind);
        }
        let result = match self
            .execute_lsp_tool(lsp_tool, &effective_args, project_id)
            .await
        {
            Ok(value) => value,
            Err(error) => {
                lsp_app_log(
                    "warn",
                    "execute_codelens_preferred",
                    &format!(
                        "codelens-{codelens_tool} LSP-preferred execution failed, falling back to static analysis"
                    ),
                    Some(&error.to_string()),
                )
                .await;
                return Ok(None);
            }
        };
        let normalized = match lsp_tool {
            "goto" => definition_to_codelens(file_path, result),
            "references" => references_to_codelens(file_path, result),
            _ => symbols_to_codelens(file_path, result),
        };
        Ok(Some(normalized))
    }

    /// Single filePath or one batch filePaths; the dedicated module validates and schedules both.
    async fn execute_diagnostics(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        diagnostics::execute(self, args, project_id).await
    }

    /// 单文件诊断准备（共享实现）：配置匹配 + 会话获取 + 缓存指纹检查 + didChange 触发。
    /// 返回缓存命中（直接结果）或待等待（并发拉取所需信息）。
    /// `configs` 由调用方提供（单文件路径自行 reload 一次；批量路径循环前
    /// 统一加载一次，避免 n 次 DB 读）。
    async fn prepare_single_with_configs(
        &self,
        file_path: &str,
        project_id: Option<&str>,
        configs: &[ServerConfig],
    ) -> napi::Result<Prepared> {
        let path = PathBuf::from(file_path);

        if is_ssh_path(file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let (_config, lang) = config::match_config(configs, &path)
            .ok_or_else(|| types::LspError::NotConfigured(file_extension_label(&path)))?;
        let project_root = resolve_lang_root(project_id, file_path, lang)?;

        let session = manager::ServerManager::instance()
            .get_or_start(lang, &project_root, project_id)
            .await?;
        let prepare_result = {
            let mut guard = session.lock().await;
            guard.prepare_diagnostics(&path).await?
        };
        match prepare_result {
            PrepareResult::Cached(value) => Ok(Prepared::Cached(value)),
            PrepareResult::Pending(pending) => Ok(Prepared::Pending { session, pending }),
        }
    }

    /// 解析目标符号的位置与归属语言：
    /// 1. 若提供了 filePath：
    ///    - 优先物理坐标 (line, column)；
    ///    - 若仅提供了 symbol，则在该文件的单文件 AST 中推测匹配，未命中回退到该语言的 workspace_symbols；
    /// 2. 若未提供 filePath：
    ///    - 必须提供 symbol，跨当前项目所有激活且支持 workspace-symbols 的技术栈服务器全局寻址。
    async fn resolve_target_location(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<ResolvedTargetLocation> {
        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;

        let file_path_opt = args
            .get("filePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        if let Some(file_path) = file_path_opt {
            if is_ssh_path(file_path) {
                return Err(types::LspError::RemoteNotSupported.into());
            }
            let path = tokio::fs::canonicalize(file_path).await.map_err(|error| {
                Error::new(
                    Status::InvalidArg,
                    format!("Cannot resolve source file: {error}"),
                )
            })?;
            let (_config, lang) = config::match_config(&configs, &path)
                .ok_or_else(|| types::LspError::NotConfigured(file_extension_label(&path)))?;

            let has_line = args.get("line").and_then(Value::as_u64);
            let has_col = args.get("column").and_then(Value::as_u64);
            let symbol_opt = args
                .get("symbol")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());

            if let (Some(l), Some(c)) = (has_line, has_col) {
                if l > 0 && c > 0 && l <= u32::MAX as u64 && c <= u32::MAX as u64 {
                    return Ok(ResolvedTargetLocation::Exact {
                        path,
                        line: l as u32,
                        column: c as u32,
                        lang: lang.to_string(),
                        symbol: symbol_opt.map(ToString::to_string),
                    });
                }
            }

            let Some(symbol) = symbol_opt else {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Missing addressing parameters: provide either (line, column) coordinates or symbol."
                        .to_string(),
                ));
            };

            let project_root = resolve_lang_root(project_id, file_path, lang)?;
            let session = manager
                .get_or_start(lang, &project_root, project_id)
                .await?;
            let mut guard = session.lock().await;
            guard.ensure_open(&path).await?;

            let resolved = resolve::resolve_symbol_or_coords(&mut guard, &path, args).await?;
            match resolved {
                resolve::ResolvedTarget::Exact {
                    path: target_path,
                    line,
                    column,
                } => {
                    let target_lang = if target_path != path {
                        config::match_config(&configs, &target_path)
                            .map(|(_, l)| l.to_string())
                            .unwrap_or_else(|| lang.to_string())
                    } else {
                        lang.to_string()
                    };
                    Ok(ResolvedTargetLocation::Exact {
                        path: target_path,
                        line,
                        column,
                        lang: target_lang,
                        symbol: Some(symbol.to_string()),
                    })
                }
                resolve::ResolvedTarget::Ambiguous(val) => {
                    Ok(ResolvedTargetLocation::Ambiguous(val))
                }
            }
        } else {
            let symbol_opt = args
                .get("symbol")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());

            let Some(symbol) = symbol_opt else {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Missing addressing parameters: provide either filePath (with line/column or symbol) or symbol alone for workspace-wide resolution."
                        .to_string(),
                ));
            };

            let workspace_root = workspace_queries::root(args, project_id).await?;
            let global_target = resolve::resolve_symbol_workspace_global_in_root(
                manager,
                &configs,
                project_id,
                symbol,
                Some(&workspace_root),
            )
            .await?;

            match global_target {
                resolve::GlobalResolvedTarget::Exact {
                    path,
                    line,
                    column,
                    lang,
                } => Ok(ResolvedTargetLocation::Exact {
                    path,
                    line,
                    column,
                    lang,
                    symbol: Some(symbol.to_string()),
                }),
                resolve::GlobalResolvedTarget::Ambiguous(val) => {
                    Ok(ResolvedTargetLocation::Ambiguous(val))
                }
            }
        }
    }

    /// lsp-hover。
    async fn execute_hover(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let resolved = self.resolve_target_location(args, project_id).await?;
        let (path, line, column, lang, symbol) = match resolved {
            ResolvedTargetLocation::Exact {
                path,
                line,
                column,
                lang,
                symbol,
            } => (path, line, column, lang, symbol),
            ResolvedTargetLocation::Ambiguous(val) => return Ok(val),
        };

        let manager = manager::ServerManager::instance();
        let project_root = resolve_lang_root(project_id, path.to_str().unwrap_or(""), &lang)?;
        let session = manager
            .get_or_start(&lang, &project_root, project_id)
            .await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;

        let mut result = guard.hover(&path, line, column).await?;
        if let Some(symbol_str) = symbol {
            if let Value::Object(map) = &mut result {
                map.insert(
                    "resolvedSymbol".to_string(),
                    json!({
                        "symbol": symbol_str,
                        "filePath": path.to_string_lossy(),
                        "line": line,
                        "column": column,
                    }),
                );
            }
        }
        Ok(result)
    }

    /// lsp-goto：统一跳转入口（definition / type-definition / implementation）。
    ///
    /// kind 默认 definition（全语言核心）；type-definition / implementation
    /// 按能力表运行时校验（§8.7.1 兜底，能力标记保留在 capabilities.rs）。
    async fn execute_goto(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let kind = args
            .get("kind")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("definition")
            .to_string();

        let resolved = self.resolve_target_location(args, project_id).await?;
        let (path, line, column, lang, symbol) = match resolved {
            ResolvedTargetLocation::Exact {
                path,
                line,
                column,
                lang,
                symbol,
            } => (path, line, column, lang, symbol),
            ResolvedTargetLocation::Ambiguous(val) => return Ok(val),
        };

        match kind.as_str() {
            // Actual support is checked by the initialized ServerSession.
            "definition" | "type-definition" | "implementation" => {}
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Unknown goto kind: \"{kind}\". Available kinds: [definition, type-definition, implementation]"
                    ),
                ))
            }
        }

        let manager = manager::ServerManager::instance();
        let project_root = resolve_lang_root(project_id, path.to_str().unwrap_or(""), &lang)?;
        let session = manager
            .get_or_start(&lang, &project_root, project_id)
            .await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;

        let mut result = match kind.as_str() {
            "definition" => guard.goto_definition(&path, line, column).await?,
            "type-definition" => guard.type_definition(&path, line, column).await?,
            _ => guard.implementation(&path, line, column).await?,
        };

        if let Some(symbol_str) = symbol {
            if let Value::Object(map) = &mut result {
                map.insert(
                    "resolvedSymbol".to_string(),
                    json!({
                        "symbol": symbol_str,
                        "filePath": path.to_string_lossy(),
                        "line": line,
                        "column": column,
                    }),
                );
            }
        }
        Ok(result)
    }

    /// lsp-references。
    async fn execute_references(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        let include_declaration = args
            .get("includeDeclaration")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let resolved = self.resolve_target_location(args, project_id).await?;
        let (path, line, column, lang, symbol) = match resolved {
            ResolvedTargetLocation::Exact {
                path,
                line,
                column,
                lang,
                symbol,
            } => (path, line, column, lang, symbol),
            ResolvedTargetLocation::Ambiguous(val) => return Ok(val),
        };

        let manager = manager::ServerManager::instance();
        let project_root = resolve_lang_root(project_id, path.to_str().unwrap_or(""), &lang)?;
        let session = manager
            .get_or_start(&lang, &project_root, project_id)
            .await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;

        let mut result = guard
            .references(&path, line, column, include_declaration)
            .await?;
        if let Some(symbol_str) = symbol {
            if let Value::Object(map) = &mut result {
                map.insert(
                    "resolvedSymbol".to_string(),
                    json!({
                        "symbol": symbol_str,
                        "filePath": path.to_string_lossy(),
                        "line": line,
                        "column": column,
                    }),
                );
            }
        }
        Ok(result)
    }

    /// lsp-symbols。
    async fn execute_symbols(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let file_path = required_string(args, "filePath")?;
        let path = tokio::fs::canonicalize(&file_path).await.map_err(|error| {
            Error::new(
                Status::InvalidArg,
                format!("Cannot resolve source file: {error}"),
            )
        })?;

        if is_ssh_path(&file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let (_config, lang) = config::match_config(&configs, &path)
            .ok_or_else(|| types::LspError::NotConfigured(file_extension_label(&path)))?;
        let project_root = resolve_lang_root(project_id, &file_path, lang)?;

        let session = manager
            .get_or_start(lang, &project_root, project_id)
            .await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;
        Ok(guard.document_symbols(&path).await?)
    }

    /// lsp-rename。
    async fn execute_rename(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let new_name = required_string(args, "newName")?;
        if new_name.trim().is_empty() {
            return Err(Error::new(Status::InvalidArg, "newName must not be empty"));
        }
        let dry_run = match args.get("dryRun") {
            None => true,
            Some(Value::Bool(value)) => *value,
            Some(_) => return Err(Error::new(Status::InvalidArg, "dryRun must be boolean")),
        };
        if !dry_run
            && args
                .get("previewId")
                .and_then(Value::as_str)
                .is_none_or(|id| id.trim().is_empty())
        {
            return Err(Error::new(Status::InvalidArg, "Applying a rename requires the previewId returned by an unchanged, unexpired preview"));
        }

        let resolved = self.resolve_target_location(args, project_id).await?;
        let (path, line, column, lang, symbol) = match resolved {
            ResolvedTargetLocation::Exact {
                path,
                line,
                column,
                lang,
                symbol,
            } => (path, line, column, lang, symbol),
            ResolvedTargetLocation::Ambiguous(val) => return Ok(val),
        };

        let manager = manager::ServerManager::instance();
        let project_root = resolve_lang_root(project_id, path.to_str().unwrap_or(""), &lang)?;
        let session = manager
            .get_or_start(&lang, &project_root, project_id)
            .await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;

        let mut result = guard
            .rename(
                &path,
                line,
                column,
                &new_name,
                dry_run,
                args.get("previewId").and_then(Value::as_str),
            )
            .await?;
        if let Some(symbol_str) = symbol {
            if let Value::Object(map) = &mut result {
                map.insert(
                    "resolvedSymbol".to_string(),
                    json!({
                        "symbol": symbol_str,
                        "filePath": path.to_string_lossy(),
                        "line": line,
                        "column": column,
                    }),
                );
            }
        }
        Ok(result)
    }

    /// callHierarchy 查询（LSP 3.16，双向调用链）：
    async fn execute_call_hierarchy(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        let resolved = self.resolve_target_location(args, project_id).await?;
        let (path, line, column, lang, symbol) = match resolved {
            ResolvedTargetLocation::Exact {
                path,
                line,
                column,
                lang,
                symbol,
            } => (path, line, column, lang, symbol),
            ResolvedTargetLocation::Ambiguous(val) => return Ok(val),
        };

        let manager = manager::ServerManager::instance();
        let project_root = resolve_lang_root(project_id, path.to_str().unwrap_or(""), &lang)?;
        let session = manager
            .get_or_start(&lang, &project_root, project_id)
            .await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;

        let mut result = guard.call_hierarchy(&path, line, column).await?;
        if let Some(symbol_str) = symbol {
            if let Value::Object(map) = &mut result {
                map.insert(
                    "resolvedSymbol".to_string(),
                    json!({
                        "symbol": symbol_str,
                        "filePath": path.to_string_lossy(),
                        "line": line,
                        "column": column,
                    }),
                );
            }
        }
        Ok(result)
    }

    /// lsp-type-hierarchy（LSP 3.17：父类型链 + 全部子类型）。
    async fn execute_type_hierarchy(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        let resolved = self.resolve_target_location(args, project_id).await?;
        let (path, line, column, lang, symbol) = match resolved {
            ResolvedTargetLocation::Exact {
                path,
                line,
                column,
                lang,
                symbol,
            } => (path, line, column, lang, symbol),
            ResolvedTargetLocation::Ambiguous(val) => return Ok(val),
        };

        let manager = manager::ServerManager::instance();
        let project_root = resolve_lang_root(project_id, path.to_str().unwrap_or(""), &lang)?;
        let session = manager
            .get_or_start(&lang, &project_root, project_id)
            .await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;

        let mut result = guard.type_hierarchy(&path, line, column).await?;
        if let Some(symbol_str) = symbol {
            if let Value::Object(map) = &mut result {
                map.insert(
                    "resolvedSymbol".to_string(),
                    json!({
                        "symbol": symbol_str,
                        "filePath": path.to_string_lossy(),
                        "line": line,
                        "column": column,
                    }),
                );
            }
        }
        Ok(result)
    }

    async fn execute_workspace_symbols(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        workspace_queries::symbols(args, project_id).await
    }

    async fn execute_workspace_diagnostics(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        workspace_queries::diagnostics(args, project_id).await
    }

    /// lsp-vulncheck（go 专属依赖漏洞扫描，2026-08-16）。
    ///
    /// 复用官方 `govulncheck` 二进制（gopls MCP `go_vulncheck` 同款机制：
    /// `-json -mode source -scan symbol`），绕开 gopls MCP 的 dir 参数缺陷
    /// （per-project daemon 架构下显式传 dir 会与 gopls 锁定 root 的 env
    /// 不一致，见分析记录）。stdout 为 NDJSON 多文档流（config / SBOM /
    /// progress / osv / finding），只收集 `osv` + `finding`，按 OSV ID 分组
    /// 输出 `{id, details, affectedPackages}`（与 gopls MCP 输出格式对齐）。
    ///
    /// 参数：`dir`（默认项目根：project_id → workspace 目录 → 当前目录）、
    /// `pattern`（默认 `./...`）。超时 120s（首次需下载漏洞库）。go 语言
    /// 能力表标记；无 govulncheck 时给出安装指引。
    async fn execute_vulncheck(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("./...")
            .to_string();

        // Explicit module directory wins; otherwise use the request's analysis root.
        let mut root_args = args.clone();
        if let Some(dir) = args.get("dir") {
            root_args["workspaceRoot"] = dir.clone();
        }
        let root = workspace_queries::root(&root_args, project_id).await?;

        // govulncheck 在单独进程中运行（CPU 密集 + 网络下载漏洞库），
        // 异步执行不阻塞 Node.js 主线程（架构红线）；超时兜底 + kill_on_drop
        // 防止超时后残留进程（同 gopls 上游注释：独立进程即完美的 GC）。
        let mut command = crate::utils::process::cmd_async("govulncheck");
        command
            .arg("-json")
            .arg("-mode")
            .arg("source")
            .arg("-scan")
            .arg("symbol")
            .arg("-C")
            .arg(&root)
            .arg(&pattern)
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(120), command.output())
            .await
            .map_err(|_| {
                Error::new(
                    Status::GenericFailure,
                    "govulncheck timed out after 120s (vulnerability database download may be slow); retry later".to_string(),
                )
            })?
            .map_err(|error| {
                // spawn 失败（二进制缺失 / 不可执行）→ 安装指引。
                if error.kind() == std::io::ErrorKind::NotFound {
                    Error::new(
                        Status::GenericFailure,
                        "govulncheck not found in PATH. Install it with: go install golang.org/x/vuln/cmd/govulncheck@latest".to_string(),
                    )
                } else {
                    Error::new(
                        Status::GenericFailure,
                        format!("failed to run govulncheck: {error}"),
                    )
                }
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "govulncheck failed (exit {:?}): {}",
                    output.status.code(),
                    stderr.trim()
                ),
            ));
        }

        parse_vulncheck_output(&output.stdout, &pattern, &root.to_string_lossy())
    }
}

/// govulncheck `-json` stdout 解析（NDJSON 多文档流，实测 v1.6.0）。
///
/// 流对象形如 `{"config": ...}` / `{"SBOM": ...}` / `{"progress": ...}` /
/// `{"osv": {...}}` / `{"finding": {...}}`（多行缩进文档串联，非每行一个）。
/// 只收集 `osv`（id → entry）与 `finding`（引用 osv id + trace 链），按
/// OSV ID 分组输出 `{id, details, affectedPackages}`——与 gopls MCP
/// `go_vulncheck` 输出格式一致（package 取 trace[0]，空则标
/// "Go standard library"；`osv` 对象含大量未调用的候选，只有被 `finding`
/// 引用的才算真实命中）。
fn parse_vulncheck_output(stdout: &[u8], pattern: &str, dir: &str) -> napi::Result<Value> {
    let mut osvs: HashMap<String, Value> = HashMap::new();
    let mut findings: Vec<Value> = Vec::new();

    let mut stream = serde_json::Deserializer::from_slice(stdout).into_iter::<Value>();
    while let Some(item) = stream.next() {
        let obj = item.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("failed to parse govulncheck JSON stream: {error}"),
            )
        })?;
        if let Some(osv) = obj.get("osv") {
            if let Some(id) = osv.get("id").and_then(Value::as_str) {
                osvs.insert(id.to_string(), osv.clone());
            }
        } else if let Some(finding) = obj.get("finding") {
            findings.push(finding.clone());
        }
    }

    // 按 OSV ID 分组（BTreeMap 保证 ID 排序稳定）。
    let mut grouped: BTreeMap<String, (String, BTreeSet<String>)> = BTreeMap::new();
    for finding in &findings {
        let Some(osv_id) = finding.get("osv").and_then(Value::as_str) else {
            continue;
        };
        let details = osvs
            .get(osv_id)
            .and_then(|entry| entry.get("details"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let pkg = finding
            .get("trace")
            .and_then(Value::as_array)
            .and_then(|trace| trace.first())
            .and_then(|t0| t0.get("package"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "Go standard library".to_string());
        let entry = grouped
            .entry(osv_id.to_string())
            .or_insert_with(|| (details, BTreeSet::new()));
        entry.1.insert(pkg);
    }

    let findings_out: Vec<Value> = grouped
        .into_iter()
        .map(|(id, (details, packages))| {
            json!({
                "id": id,
                "details": details,
                "affectedPackages": packages.into_iter().collect::<Vec<_>>(),
            })
        })
        .collect();
    let count = findings_out.len();

    Ok(json!({
        "findings": findings_out,
        "count": count,
        "summary": format!(
            "Vulnerability check for pattern {pattern:?} in {dir:?} complete. Found {count} vulnerabilities."
        ),
    }))
}

impl McpService for LspService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        // 暴露与否由 collect_all_mcp_tools 按表配置过滤（§8.0）。
        tool_schemas()
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        Err(Error::new(
            Status::GenericFailure,
            format!("LSP tool \"{tool_name}\" must be executed through the asynchronous executor"),
        ))
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 单文件准备结果：缓存命中（直接返回）或待并发等待（锁外拉取）。
enum Prepared {
    Cached(Value),
    Pending {
        session: Arc<tokio::sync::Mutex<ServerSession>>,
        pending: PendingDiagnostics,
    },
}

/// 解析项目根：project_id → workspace_directories 表；无则文件父目录兜底（§7.2）。
fn resolve_project_root(project_id: Option<&str>, file_path: &str) -> napi::Result<PathBuf> {
    if let Some(pid) = project_id {
        if !pid.trim().is_empty() {
            let storage_info = crate::storage::initialize_app_storage()?;
            let database_path = PathBuf::from(storage_info.database_path);
            if let Ok(Some(root)) = get_workspace_directory_path(&database_path, pid) {
                return Ok(PathBuf::from(root));
            }
        }
    }
    // 兜底：文件所在目录。
    Ok(PathBuf::from(file_path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".")))
}

/// 解析 LSP 会话根（技术栈感知，2026-09-24）：
/// 项目根（workspace_directories 表）→ 该语言真实技术栈根（Cargo.toml /
/// go.mod / tsconfig.json 等标志文件所在目录；文件级请求向上找最近的，
/// 无文件上下文向下扫）。找不到技术栈标志 → 明确错误（不启动：避免
/// 服务器在无项目配置的目录退化/异常，如 rust-analyzer 单文件模式、
/// gopls 无 go.mod）。标志未定义的语言不约束（保持旧行为）。
fn resolve_lang_root(
    project_id: Option<&str>,
    file_path: &str,
    lang: &str,
) -> napi::Result<PathBuf> {
    let project_root = resolve_project_root(project_id, file_path)?;
    // 空 file_path：无起始目录，走向下扫描（Path::new("").parent() 为 None，天然覆盖）。
    let start = Path::new(file_path).parent();
    if let Some(root) = detect::find_lang_root(&project_root, start, lang) {
        return Ok(root);
    }
    Err(
        types::LspError::NoLangStack(lang.to_string(), detect::markers_for_lang(lang).join(", "))
            .into(),
    )
}

/// 文件扩展名标签（错误信息用）。
fn file_extension_label(path: &std::path::Path) -> String {
    path.extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_else(|| "<unknown>".to_string())
}

fn required_string(args: &Value, key: &str) -> napi::Result<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("Missing or invalid string parameter: {key}"),
            )
        })
}

fn required_u32(args: &Value, key: &str) -> napi::Result<u32> {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("Missing or invalid number parameter: {key}"),
            )
        })
}

/// 检查 LSP 工具是否被用户允许（与 collect 阶段对 lsp-* 工具的判定一致）：
/// 全局黑名单或项目 scope（builtin:lsp 服务器 / 具体 lsp-* 工具）禁用时
/// 返回 false——用户禁用了 LSP 就不应把 codelens 调用转发过去。lsp 是
/// 默认关闭服务器：无项目 scope（用户从未在项目 MCP 面板启用 builtin:lsp）
/// 同样返回 false，与 tool_is_enabled 的无 scope 判定保持一致。
async fn lsp_tool_scope_allowed(lsp_tool: &str, project_id: Option<&str>) -> napi::Result<bool> {
    use crate::mcp::tools::{builtin_scope_server_id, load_global_scope, load_project_scope};
    let lsp_full_name = format!("lsp-{lsp_tool}");
    if let Some(global) = load_global_scope().await? {
        if global.disabled_tool_names.contains(&lsp_full_name) {
            return Ok(false);
        }
    }
    let Some(scope) = load_project_scope(project_id).await? else {
        return Ok(false);
    };
    Ok(scope.is_server_enabled(&builtin_scope_server_id("lsp"))
        && scope.is_tool_enabled(&lsp_full_name))
}

/// 写应用日志（app_logs 表，复用项目现有日志体系——与系统日志面板同源，
/// config 工具 logs scope / listAppLogs 均可查；module="lsp" 便于过滤）。
/// 通过 spawn_blocking 执行 DB 写，不阻塞 tokio 工作线程；日志写入失败
/// 静默（eprintln 兜底），绝不影响主流程。
pub(crate) async fn lsp_app_log(level: &str, func: &str, message: &str, error: Option<&str>) {
    let input = crate::storage::services::app_logs::AppLogInput {
        level: level.to_string(),
        module: "lsp".to_string(),
        func: func.to_string(),
        line: None,
        message: message.to_string(),
        input: None,
        output: None,
        duration: None,
        context: None,
        error: error.map(str::to_string),
        source: "native".to_string(),
    };
    match tokio::task::spawn_blocking(move || crate::storage::write_app_log(input)).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => eprintln!("[lsp] write_app_log failed: {err}"),
        Err(join_err) => eprintln!("[lsp] write_app_log join failed: {join_err}"),
    }
}

/// 服务器是否与项目实际技术栈匹配（技术栈感知，2026-09-24 统一判定；collect
/// 阶段工具暴露与系统提示词注入共用）。匹配 = 该语言的技术栈标志文件存在
/// （find_lang_root 向下扫描，与调用阶段 resolve_lang_root 同一事实来源——
/// 保证「暴露 = 可调用」：标志不存在时工具不暴露，调用阶段也会明确拒绝）。
/// 未定义标志的语言退化为标志语言 + 扩展名匹配。检测结果走 TTL 缓存
/// （detect.rs，60s），避免每次调用重复全量目录扫描。
pub(crate) fn server_matches_project(config: &types::ServerConfig, project_root: &Path) -> bool {
    if !detect::markers_for_lang(&config.lang).is_empty() {
        return detect::find_lang_root(project_root, None, &config.lang).is_some();
    }
    // 未定义标志的语言（自定义 lang）：标志语言 + 扩展名兜底（保持旧行为）。
    let profile = detect::detect_project_languages_cached(&project_root.to_string_lossy());
    profile.langs.iter().any(|lang| lang == &config.lang)
        || config.file_extensions.iter().any(|ext| {
            profile
                .extensions
                .contains(&ext.trim_start_matches('.').to_ascii_lowercase())
        })
}

/// lsp-goto（kind=definition）结果 → codelens-find_definition 输出格式。
///
/// 保持 codelens 字段形状（found/name/location/searchScope，前端
/// CodeLensToolCall 与 agent 无感），附加 LSP 特有信息：完整
/// definitions 列表、language、engine 标记。LSP 不返回 kind /
/// containerName / isExported，对应字段为 null。
fn definition_to_codelens(_file_path: &str, value: Value) -> Value {
    let definitions = value
        .get("definitions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let count = definitions.len();
    json!({
        "found": count > 0,
        "name": value.get("name").cloned().unwrap_or(Value::Null),
        "kind": Value::Null,
        "location": definitions.first().cloned(),
        "containerName": Value::Null,
        "isExported": Value::Null,
        "searchScope": "project",
        "engine": "lsp",
        "language": value.get("language").cloned().unwrap_or(Value::Null),
        "count": count,
        "definitions": definitions,
    })
}

/// lsp-references 结果 → codelens-find_references 输出格式。
///
/// LSP 引用项自带 filePath/line/column/endLine/endColumn（前端 parseLocation
/// 直接读取），补充 codelens 需要的 access 字段并保留 LSP 的 context 代码
/// 上下文。LSP 不返回定义位置，definition 为 null。
fn references_to_codelens(_file_path: &str, value: Value) -> Value {
    let references = value
        .get("references")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let items: Vec<Value> = references
        .iter()
        .map(|reference| {
            let mut item = reference.clone();
            if let Value::Object(map) = &mut item {
                map.entry("access".to_string())
                    .or_insert_with(|| json!("read"));
            }
            item
        })
        .collect();
    let count = items.len();
    json!({
        "found": count > 0,
        "name": value.get("symbol").cloned().unwrap_or(Value::Null),
        "definition": Value::Null,
        "references": items,
        "totalReferences": count,
        "searchScope": "project",
        "engine": "lsp",
        "language": value.get("language").cloned().unwrap_or(Value::Null),
    })
}

/// lsp-symbols 结果 → codelens-file_outline 输出格式。
///
/// LSP documentSymbol 是树形（range/selection/children），展平为 codelens
/// 的扁平 outline 列表（先父后子，range.start 作为符号位置）。
fn symbols_to_codelens(file_path: &str, value: Value) -> Value {
    let symbols = value
        .get("symbols")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut outline: Vec<Value> = Vec::new();
    flatten_symbols(&symbols, &mut outline);
    let count = outline.len();
    json!({
        "filePath": file_path,
        "outline": outline,
        "totalSymbols": count,
        "engine": "lsp",
        "language": value.get("language").cloned().unwrap_or(Value::Null),
    })
}

/// LSP documentSymbol 树形 → 扁平 outline（先父后子递归）。
fn flatten_symbols(symbols: &[Value], out: &mut Vec<Value>) {
    for symbol in symbols {
        let range = symbol.get("range");
        let (line, column, end_line, end_column) = range
            .and_then(|r| {
                let start = r.get("start")?;
                let end = r.get("end")?;
                Some((
                    start.get("line")?.clone(),
                    start.get("column")?.clone(),
                    end.get("line")?.clone(),
                    end.get("column")?.clone(),
                ))
            })
            .unwrap_or((Value::Null, Value::Null, Value::Null, Value::Null));
        out.push(json!({
            "name": symbol.get("name").cloned().unwrap_or(Value::Null),
            "kind": symbol.get("kind").cloned().unwrap_or_else(|| json!("unknown")),
            "line": line,
            "column": column,
            "endLine": end_line,
            "endColumn": end_column,
            "containerName": symbol.get("detail").cloned().unwrap_or(Value::Null),
            "isExported": false,
        }));
        if let Some(children) = symbol.get("children").and_then(Value::as_array) {
            flatten_symbols(children, out);
        }
    }
}
