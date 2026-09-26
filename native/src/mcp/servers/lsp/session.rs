//! ServerSession：单个 (语言 × 项目根) 的语言服务器会话。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyOutgoingCall, Diagnostic, Location, TextEdit,
    WorkspaceEdit,
};
use serde_json::{json, Value};

use async_lsp::LanguageServer;

use super::client::{self, PushDiagnostics};
use super::format;
use super::types::{LspError, ServerConfig};
use crate::utils::process_tree::ProcessTreeGuard;

use std::sync::Arc;

/// 最大分析文件大小（与 codelens MAX_FILE_SIZE 一致，§9）。
pub const MAX_FILE_SIZE: u64 = 512 * 1024;

/// 请求超时（§7.3）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const HOVER_TIMEOUT: Duration = Duration::from_secs(5);
/// push 诊断等待上限：rust-analyzer 的 rustc/cargo 诊断经 flycheck（cargo check）
/// 产生，首次项目构建可能 10-30s（§8.1 / rust-lang/rust-analyzer#18709）。
const PUSH_TIMEOUT: Duration = Duration::from_secs(30);
/// references 返回上限（§10 输出限制）。
const MAX_REFERENCES: usize = 100;

pub struct ServerSession {
    pub lang: String,
    pub project_root: PathBuf,
    config: ServerConfig,
    child: tokio::process::Child,
    /// mainloop 完成标志（M5/R2.2）：mainloop 结束（进程退出/管道断开）置位，
    /// 状态快照与 get_or_start 据此判定 dead，消除「running 但请求全失败」僵尸态。
    pub main_loop_done: Arc<AtomicBool>,
    /// mainloop 异步任务句柄：会话销毁或初始化失败时主动 abort，防后台管道悬空
    pub mainloop_task: tokio::task::JoinHandle<()>,
    socket: async_lsp::ServerSocket,
    opened_files: HashMap<PathBuf, i32>, // 已打开文件 → 当前 LSP 版本
    opened_contents: HashMap<PathBuf, String>, // 每文件≤512KB，无碰撞内容指纹
    /// 服务器是否声明 pull 诊断支持（initialize 能力，§8.1）。
    pull_diagnostics_supported: bool,
    server_capabilities: lsp_types::ServerCapabilities,
    rename_previews: HashMap<String, RenamePreview>,
    /// 最近使用时间（unix 毫秒，原子更新供空闲回收 / LRU 淘汰）。
    pub last_used_ms: AtomicU64,
    pub restart_count: u32,
    pub dead: bool,
    push_diagnostics: PushDiagnostics,
    diagnostic_leases: Arc<AtomicU64>,
    /// 进程树回收 guard（M2/R4.1）：会话销毁时 Drop 兜底杀整棵树
    ///（Windows Job Object / Unix 进程组），消除 shim 后代孤儿进程。
    /// shutdown() 的显式 kill 逻辑不变；字段本身不读（下划线前缀抑制告警）。
    _process_tree_guard: ProcessTreeGuard,
}

impl Drop for ServerSession {
    fn drop(&mut self) {
        self.mainloop_task.abort();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ServerSession {
    /// 完整有效配置比较（不使用易碰撞的短哈希作为会话身份）。
    pub(crate) fn matches_config(&self, config: &ServerConfig) -> bool {
        &self.config == config
    }

    pub(crate) fn config_fingerprint(&self) -> String {
        self.config.fingerprint()
    }
    pub(crate) fn active_diagnostics(&self) -> u64 {
        self.diagnostic_leases.load(Ordering::Acquire)
    }

    pub(crate) fn negotiated_tools(&self) -> Vec<String> {
        super::capabilities::negotiated_tools(&self.server_capabilities)
    }

    fn require_tool(&self, tool: &str) -> Result<(), LspError> {
        if self.negotiated_tools().iter().any(|name| name == tool) {
            Ok(())
        } else {
            Err(LspError::CapabilityNotSupported(
                self.lang.clone(),
                tool.into(),
            ))
        }
    }

    /// 启动会话：spawn 进程 + initialize 握手（带超时）。
    /// `restart_count`：本次启动前已连续重启次数（崩溃重启用，R2.1）。
    pub async fn start(
        lang: &str,
        project_root: &Path,
        config: ServerConfig,
        restart_count: u32,
    ) -> Result<Self, LspError> {
        let (child, mainloop_task, socket, push_diagnostics, main_loop_done, process_tree_guard) =
            client::spawn_client(&config, project_root).map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    LspError::ServerMissing(config.command.clone(), config.install_command.clone())
                }
                _ => LspError::ServerFailed(format!("spawn failed: {error}")),
            })?;

        let mut session = ServerSession {
            lang: lang.to_string(),
            project_root: project_root.to_path_buf(),
            config,
            child,
            main_loop_done,
            mainloop_task,
            socket,
            opened_files: HashMap::new(),
            opened_contents: HashMap::new(),
            pull_diagnostics_supported: false,
            server_capabilities: lsp_types::ServerCapabilities::default(),
            rename_previews: HashMap::new(),
            last_used_ms: AtomicU64::new(now_ms()),
            restart_count,
            dead: false,
            push_diagnostics,
            diagnostic_leases: Arc::new(AtomicU64::new(0)),
            _process_tree_guard: process_tree_guard,
        };

        // initialize 握手（JVM 系 120s，其余 30s）。
        let timeout = client::initialize_timeout_for(lang);
        let mut socket = session.socket.clone();
        let server_capabilities = match client::initialize(
            &mut socket,
            project_root,
            session.config.initialization_options.clone(),
            timeout,
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                // 握手失败立即中止后台 mainloop 任务，避免 channel 关闭引发底层异常
                session.mainloop_task.abort();
                // 进程已提前退出（如 rustup shim 存在但组件缺失）：附加退出码与
                // 行动指引，否则只有 "initialize failed: ServiceStopped"（D1）。
                // tokio Child::try_wait 是同步方法（不阻塞，只查一次退出状态）。
                match session.child.try_wait() {
                    Ok(Some(status)) => {
                        let code = match status.code() {
                            Some(code) => code.to_string(),
                            None => "unknown".to_string(),
                        };
                        let base = match &error {
                            LspError::ServerFailed(message) => message.clone(),
                            other => format!("{other:?}"),
                        };
                        eprintln!("[lsp:{lang}] 服务器进程已提前退出 (exit code {code}): {base}");
                        // 若配置了 install_command 且提前退出，判定为组件缺失/不完整，引导安装
                        if session.config.install_command.is_some() {
                            return Err(LspError::ServerMissing(
                                session.config.command.clone(),
                                session.config.install_command.clone(),
                            ));
                        }
                        let hint = format!(
                            "。服务器进程已提前退出（exit code {code}），常见原因：组件未安装或运行环境不完整{}",
                            session
                                .config
                                .install_command
                                .as_deref()
                                .filter(|cmd| !cmd.is_empty())
                                .map(|cmd| format!("。可尝试安装命令: {cmd}"))
                                .unwrap_or_default()
                        );
                        return Err(LspError::ServerFailed(format!("{base}{hint}")));
                    }
                    // 进程仍在运行（如 initialize 超时）：原样返回原错误。
                    _ => return Err(error),
                }
            }
        };
        session.pull_diagnostics_supported = server_capabilities.diagnostic_provider.is_some();
        session.server_capabilities = server_capabilities;
        // 会话首次启动预热：didOpen 项目入口文件，让服务器提前加载 workspace
        // 建索引（不触发 flycheck，避免后台 cargo check CPU 成本；失败静默）。
        // 预热文件记入 opened_files，后续真实调用不重复打开。
        session.warmup(project_root).await;
        Ok(session)
    }

    /// 同步磁盘快照。保存有界全文而非 mtime/size，避免同尺寸修改和哈希碰撞。
    pub async fn ensure_open(&mut self, path: &Path) -> Result<(), LspError> {
        let canonical = tokio::fs::canonicalize(path).await.map_err(|error| {
            LspError::Internal(format!("resolve document path failed: {error}"))
        })?;
        let path = canonical.as_path();
        let text = self.read_file_text(path).await?;
        if self.opened_contents.get(path) == Some(&text) {
            self.touch();
            return Ok(());
        }
        match self.opened_files.get(path).copied() {
            Some(version) => {
                let next = version.checked_add(1).ok_or_else(|| {
                    LspError::Internal("document version exhausted; restart the session".into())
                })?;
                client::did_change(&mut self.socket, path, next, &text).await?;
                self.opened_files.insert(path.to_path_buf(), next);
            }
            None => {
                client::did_open(&mut self.socket, &self.lang, path, &text).await?;
                self.opened_files.insert(path.to_path_buf(), 1);
            }
        }
        self.opened_contents.insert(path.to_path_buf(), text);
        self.touch();
        Ok(())
    }

    /// Workspace 请求前同步所有已打开文件；删除文件发送 didClose，不保留幽灵符号。
    async fn sync_opened_files(&mut self) -> Result<(), LspError> {
        let mut paths: Vec<PathBuf> = self.opened_files.keys().cloned().collect();
        paths.sort();
        for path in paths {
            match tokio::fs::metadata(&path).await {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let uri = lsp_types::Url::from_file_path(&path)
                        .map_err(|_| LspError::Internal("invalid document path".into()))?;
                    self.socket
                        .did_close(lsp_types::DidCloseTextDocumentParams {
                            text_document: lsp_types::TextDocumentIdentifier { uri },
                        })
                        .map_err(|error| {
                            LspError::ServerFailed(format!("didClose failed: {error:?}"))
                        })?;
                    self.opened_files.remove(&path);
                    self.opened_contents.remove(&path);
                }
                _ => self.ensure_open(&path).await?,
            }
        }
        Ok(())
    }

    /// 读取文件内容（≤512KB），读取前后均检查大小以覆盖读取期间增长。
    async fn read_file_text(&self, path: &Path) -> Result<String, LspError> {
        let metadata = tokio::fs::metadata(path)
            .await
            .map_err(|error| LspError::Internal(format!("read metadata failed: {error}")))?;
        if !metadata.is_file() {
            return Err(LspError::Internal(format!(
                "not a file: {}",
                path.display()
            )));
        }
        if metadata.len() > MAX_FILE_SIZE {
            return Err(LspError::FileTooLarge(path.display().to_string()));
        }
        let text = tokio::fs::read_to_string(path)
            .await
            .map_err(|error| LspError::Internal(format!("read file failed: {error}")))?;
        if text.len() as u64 > MAX_FILE_SIZE {
            return Err(LspError::FileTooLarge(path.display().to_string()));
        }
        Ok(text)
    }

    /// Workspace 查询共享冷启动入口。预热只建立上下文，不代表索引已经完成。
    pub async fn warmup(&mut self, project_root: &Path) {
        let root = project_root.to_path_buf();
        let lang = self.lang.clone();
        let entry = tokio::task::spawn_blocking(move || match lang.as_str() {
            "typescript" => find_project_entry(
                &root,
                &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
            ),
            "rust" => ["src/lib.rs", "src/main.rs", "lib.rs", "main.rs"]
                .iter()
                .map(|name| root.join(name))
                .find(|path| path.is_file()),
            _ => None,
        })
        .await
        .ok()
        .flatten();
        if let Some(entry) = entry {
            if let Err(error) = self.ensure_open(&entry).await {
                eprintln!("[lsp:{}] warmup didOpen failed: {error:?}", self.lang);
            }
        }
    }

    /// 兼容旧入口；实际 workspace 查询随后检查上下文是否建立，失败不会伪装成功。
    pub async fn ensure_project_context(&mut self, project_root: &Path) {
        if self.lang == "typescript" && self.opened_files.is_empty() {
            self.warmup(project_root).await;
        }
    }

    async fn prepare_workspace(&mut self) -> Result<(), LspError> {
        self.sync_opened_files().await?;
        let root = self.project_root.clone();
        self.ensure_project_context(&root).await;
        if self.lang == "typescript" && self.opened_files.is_empty() {
            return Err(LspError::ServerFailed(
                "TypeScript project context unavailable: no readable JS/TS entry found within the scan budget; supply filePath to open a project source file".into()
            ));
        }
        Ok(())
    }

    /// hover 查询。
    pub async fn hover(&mut self, path: &Path, line: u32, column: u32) -> Result<Value, LspError> {
        self.require_tool("hover")?;
        let result = client::hover(&mut self.socket, path, line, column, HOVER_TIMEOUT).await?;
        self.touch();
        match result {
            Some(hover) => Ok(format::hover_to_value(&self.lang, &hover)),
            None => Ok(serde_json::json!({
                "language": self.lang,
                "contents": "",
                "range": null,
            })),
        }
    }

    /// goto definition 查询（语义跳转，可跨文件；name 从请求位置行提取）。
    pub async fn goto_definition(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Value, LspError> {
        self.require_tool("goto")?;
        let response =
            client::goto_definition(&mut self.socket, path, line, column, REQUEST_TIMEOUT).await?;
        self.touch();
        let name = self.symbol_at(path, line, column).await;
        Ok(format::definition_to_value(&self.lang, &name, response))
    }

    /// references 查询（全部引用位置 + 代码上下文，上限 MAX_REFERENCES）。
    pub async fn references(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
        include_declaration: bool,
    ) -> Result<Value, LspError> {
        self.require_tool("references")?;
        let locations = client::references(
            &mut self.socket,
            path,
            line,
            column,
            include_declaration,
            REQUEST_TIMEOUT,
        )
        .await?;
        self.touch();
        let symbol = self.symbol_at(path, line, column).await;
        let contexts = read_reference_contexts(&locations, MAX_REFERENCES).await;
        let shown = locations.len().min(contexts.len());
        let mut value = format::references_to_value(
            &self.lang,
            &symbol,
            &locations[..shown],
            &contexts[..shown],
        );
        value["total"] = json!(locations.len());
        value["truncated"] = json!(shown < locations.len());
        value["partial"] = json!(shown < locations.len());
        value["status"] = json!(if shown < locations.len() {
            "partial"
        } else {
            "complete"
        });
        Ok(value)
    }

    /// documentSymbol 查询（树形大纲：name/kind/detail/range/children）。
    pub async fn document_symbols(&mut self, path: &Path) -> Result<Value, LspError> {
        self.require_tool("symbols")?;
        let response = client::document_symbols(&mut self.socket, path, REQUEST_TIMEOUT).await?;
        self.touch();
        Ok(format::symbols_to_value(&self.lang, response))
    }

    /// 预览产生一次性凭证；执行只消费已冻结的编辑，不重新询问服务器。
    pub async fn rename(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
        new_name: &str,
        dry_run: bool,
        preview_id: Option<&str>,
    ) -> Result<Value, LspError> {
        self.require_tool("rename")?;
        let target = tokio::fs::canonicalize(path)
            .await
            .map_err(|error| LspError::Internal(error.to_string()))?;
        let binding = RenameBinding {
            target: target.clone(),
            line,
            column,
            new_name: new_name.into(),
            root: self.project_root.clone(),
            config_fingerprint: self.config.fingerprint(),
        };
        self.touch();
        if !dry_run {
            let id = preview_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| {
                    LspError::Unsupported(
                        "rename apply requires previewId; run dryRun=true first".into(),
                    )
                })?;
            let preview =
                consume_rename_preview(&mut self.rename_previews, id, &binding, Instant::now())?;
            return apply_rename_preview(self, preview).await;
        }
        self.sync_opened_files().await?;
        self.ensure_open(path).await?;
        let target_before_discovery = blake3::hash(self.read_file_text(&target).await?.as_bytes());
        // 第一遍只发现受影响文件，不发凭证、不采用其编辑范围。
        let discovery = client::rename(
            &mut self.socket,
            path,
            line,
            column,
            new_name,
            REQUEST_TIMEOUT,
        )
        .await?
        .unwrap_or_default();
        for (uri, _, _) in format::workspace_edit_files_versioned(&discovery)? {
            let affected = uri
                .to_file_path()
                .map_err(|_| LspError::Unsupported("non-file rename edit URI".into()))?;
            self.ensure_open(&affected).await?;
        }
        self.sync_opened_files().await?;
        if blake3::hash(self.read_file_text(&target).await?.as_bytes()) != target_before_discovery {
            return Err(LspError::Unsupported(
                "rename target changed during discovery; retry with current coordinates".into(),
            ));
        }
        let snapshots = capture_rename_snapshots(self).await?;
        let before = snapshots
            .get(&target)
            .ok_or_else(|| {
                LspError::Unsupported("target snapshot unavailable; retry preview".into())
            })?
            .hash;
        // 第二遍以已同步的请求前快照为基线，拒绝结果中新出现的未同步文件。
        let edit = client::rename(
            &mut self.socket,
            path,
            line,
            column,
            new_name,
            REQUEST_TIMEOUT,
        )
        .await?
        .unwrap_or_default();
        let files = prepare_rename_files(&edit, &snapshots).await?;
        verify_rename_snapshots(self, &snapshots).await?;
        let created = Instant::now();
        let expires_at_ms = now_ms().saturating_add(RENAME_PREVIEW_TTL.as_millis() as u64);
        let preview = RenamePreview {
            binding,
            target_hash: before,
            files,
            created,
            expires_at_ms,
        };
        let id = retain_rename_preview(&mut self.rename_previews, preview, created);
        let mut value = format::workspace_edit_to_value(&edit);
        value["language"] = json!(self.lang);
        value["applied"] = json!(false);
        value["dryRun"] = json!(true);
        value["previewId"] = json!(id);
        value["previewExpiresAt"] = json!(expires_at_ms);
        value["requiresPreview"] = json!(true);
        Ok(value)
    }

    /// typeDefinition 查询（跳到符号「类型」的定义；输出与 definition 对齐）。
    pub async fn type_definition(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Value, LspError> {
        self.require_tool("type-definition")?;
        let response =
            client::type_definition(&mut self.socket, path, line, column, REQUEST_TIMEOUT).await?;
        self.touch();
        let name = self.symbol_at(path, line, column).await;
        Ok(format::definition_to_value(&self.lang, &name, response))
    }

    /// implementation 查询（接口/抽象类的实现跳转；输出与 definition 对齐）。
    pub async fn implementation(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Value, LspError> {
        self.require_tool("implementation")?;
        let response =
            client::implementation(&mut self.socket, path, line, column, REQUEST_TIMEOUT).await?;
        self.touch();
        let name = self.symbol_at(path, line, column).await;
        Ok(format::definition_to_value(&self.lang, &name, response))
    }

    /// callHierarchy 查询（LSP 3.16，双向调用链）：
    /// incoming = 谁调用了该函数（调用者 + 调用点上下文）；outgoing = 该函数调用了谁。
    /// 一次调用拿全，agent 改前影响分析无需递归 references。
    pub async fn call_hierarchy(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Value, LspError> {
        self.require_tool("call-hierarchy")?;
        let items =
            client::prepare_call_hierarchy(&mut self.socket, path, line, column, REQUEST_TIMEOUT)
                .await?;
        self.touch();
        let symbol = self.symbol_at(path, line, column).await;
        let Some(first) = items.and_then(|items| items.into_iter().next()) else {
            return Ok(format::call_hierarchy_empty(&self.lang, &symbol));
        };
        let incoming =
            client::call_hierarchy_incoming_calls(&mut self.socket, first.clone(), REQUEST_TIMEOUT)
                .await?
                .unwrap_or_default();
        let outgoing =
            client::call_hierarchy_outgoing_calls(&mut self.socket, first, REQUEST_TIMEOUT)
                .await?
                .unwrap_or_default();
        let incoming_contexts = read_incoming_call_contexts(&incoming, MAX_REFERENCES).await;
        let outgoing_contexts = read_outgoing_call_contexts(path, &outgoing, MAX_REFERENCES).await;
        let caller_path = path.to_str().map(|p| p.to_string()).unwrap_or_default();
        Ok(format::call_hierarchy_to_value(
            &self.lang,
            &symbol,
            &caller_path,
            &incoming,
            &incoming_contexts,
            &outgoing,
            &outgoing_contexts,
        ))
    }

    /// typeHierarchy 查询（LSP 3.17）：supertypes 父类型链 + subtypes 全部子类型。
    pub async fn type_hierarchy(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Value, LspError> {
        self.require_tool("type-hierarchy")?;
        let items =
            client::prepare_type_hierarchy(&mut self.socket, path, line, column, REQUEST_TIMEOUT)
                .await?;
        self.touch();
        let symbol = self.symbol_at(path, line, column).await;
        let Some(first) = items.and_then(|items| items.into_iter().next()) else {
            return Ok(format::type_hierarchy_empty(&self.lang, &symbol));
        };
        let supertypes =
            client::type_hierarchy_supertypes(&mut self.socket, first.clone(), REQUEST_TIMEOUT)
                .await?
                .unwrap_or_default();
        let subtypes = client::type_hierarchy_subtypes(&mut self.socket, first, REQUEST_TIMEOUT)
            .await?
            .unwrap_or_default();
        Ok(format::type_hierarchy_to_value(
            &self.lang,
            &symbol,
            &supertypes,
            &subtypes,
        ))
    }

    /// workspaceSymbol 内部完整响应；显示限额仅在工具入口实施。
    pub async fn workspace_symbols(&mut self, query: &str) -> Result<Value, LspError> {
        self.require_tool("workspace-symbols")?;
        self.prepare_workspace().await?;
        let response = client::workspace_symbols(&mut self.socket, query, REQUEST_TIMEOUT).await?;
        self.touch();
        Ok(format::workspace_symbols_to_value(
            &self.lang,
            query,
            &self.project_root,
            response,
        ))
    }

    /// 项目级诊断（LSP 3.17 workspace/diagnostic pull）：一次返回全项目诊断。
    /// 服务器不支持该能力（Ok(None)）→ 明确能力错误，由入口归入 warnings。
    /// 输出上限：max_files 文件 × 200 诊断/文件（防输出爆炸，M4/R3.2）。
    pub async fn workspace_diagnostics(&mut self, max_files: usize) -> Result<Value, LspError> {
        self.require_tool("workspace-diagnostics")?;
        self.prepare_workspace().await?;
        let result = client::workspace_diagnostics(&mut self.socket, PUSH_TIMEOUT).await?;
        self.touch();

        let Some(files) = result else {
            return Err(LspError::CapabilityNotSupported(
                self.lang.clone(),
                "workspace-diagnostics".into(),
            ));
        };

        let total_files = files.len();
        let diagnostic_total: usize = files.iter().map(|(_, items)| items.len()).sum();
        let truncated = total_files > max_files || files.iter().any(|(_, items)| items.len() > 200);
        let mut out_files: Vec<Value> = Vec::new();
        let mut total_errors: usize = 0;
        let mut total_warnings: usize = 0;
        for (uri, diagnostics) in files.into_iter().take(max_files) {
            let path = uri
                .to_file_path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| uri.to_string());
            let (errors, warnings) = count_severities(&diagnostics);
            total_errors += errors;
            total_warnings += warnings;
            let items: Vec<Value> = diagnostics
                .iter()
                .take(200)
                .map(format::diagnostic_to_json)
                .collect();
            out_files.push(json!({
                "filePath": path,
                "summary": format::diagnostics_summary(&diagnostics),
                "diagnosticTotal": diagnostics.len(),
                "truncated": diagnostics.len() > items.len(),
                "status": if diagnostics.len() > items.len() { "partial" } else { "complete" },
                "diagnostics": items,
            }));
        }

        Ok(json!({
            "language": self.lang,
            "server": self.config.command,
            "summary": format!(
                "{total_errors} errors, {total_warnings} warnings across {} file(s)",
                out_files.len()
            ),
            "total": total_files,
            "totalFiles": total_files,
            "diagnosticTotal": diagnostic_total,
            "truncated": truncated,
            "partial": truncated,
            "status": if truncated { "partial" } else { "complete" },
            "files": out_files,
        }))
    }

    /// 提取 (line, column) 处的标识符（1-indexed；简单边界扫描，无 regex 依赖）。
    async fn symbol_at(&self, path: &Path, line: u32, column: u32) -> String {
        let Ok(text) = self.read_file_text(path).await else {
            return String::new();
        };
        let Some(source_line) = text.lines().nth(line.saturating_sub(1) as usize) else {
            return String::new();
        };
        extract_identifier_at(source_line, column.saturating_sub(1) as usize)
    }

    /// 不读取持久诊断缓存：单文件mtime无法证明依赖/配置未变化。
    /// 每次同步已开文件并请求新诊断，保存请求快照用于等待完成后的复核。
    pub async fn prepare_diagnostics(&mut self, path: &Path) -> Result<PrepareResult, LspError> {
        self.require_tool("diagnostics")?;
        let canonical = tokio::fs::canonicalize(path).await.map_err(|error| {
            LspError::Internal(format!("resolve document path failed: {error}"))
        })?;
        let path = canonical.as_path();
        self.sync_opened_files().await?;
        self.ensure_open(path).await?;
        let uri = lsp_types::Url::from_file_path(path)
            .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
        let version = self
            .opened_files
            .get(path)
            .copied()
            .unwrap_or(1)
            .checked_add(1)
            .ok_or_else(|| LspError::Internal("document version exhausted".into()))?;
        let text = self.read_file_text(path).await?;
        let requested_at = Instant::now();
        self.push_diagnostics
            .lock()
            .await
            .remove(&client::uri_key(&uri));
        client::did_change(&mut self.socket, path, version, &text).await?;
        self.opened_files.insert(path.to_path_buf(), version);
        self.opened_contents
            .insert(path.to_path_buf(), text.clone());
        if self.pull_diagnostics_supported {
            client::did_save(&mut self.socket, path, &text).await?;
        }
        Ok(PrepareResult::Pending(PendingDiagnostics {
            path: path.to_path_buf(),
            uri,
            expected_version: version,
            requested_at,
            snapshots: self
                .opened_contents
                .iter()
                .map(|(path, text)| (path.clone(), blake3::hash(text.as_bytes())))
                .collect(),
        }))
    }

    /// 生成诊断等待任务（锁外并发）：socket / push store 克隆进 task，
    /// 不持有会话锁，批量诊断可并行等待。
    ///
    /// - 声明 diagnosticProvider（rust-analyzer）：**push + pull 合并**——
    ///   rustc/cargo 诊断（类型错误等）只走 push（publishDiagnostics，didSave
    ///   触发），rust-analyzer 原生诊断走 pull，两者不重叠（#18709）。
    /// - 未声明（gopls 等）：纯 push。
    pub fn spawn_await_task(
        &self,
        pending: &PendingDiagnostics,
    ) -> tokio::task::JoinHandle<Result<Value, LspError>> {
        let mut socket = self.socket.clone();
        let push_store = self.push_diagnostics.clone();
        let expected_version = pending.expected_version;
        let requested_at = pending.requested_at;
        let pull_supported = self.pull_diagnostics_supported;
        let uri = pending.uri.clone();
        let lang = self.lang.clone();
        let command = self.config.command.clone();
        let snapshots = pending.snapshots.clone();
        let lease = DiagnosticLease::new(self.diagnostic_leases.clone());
        tokio::spawn(async move {
            let _lease = lease;
            let (items, warnings, source, push_version_verified) = collect_fresh_diagnostics(
                &mut socket,
                &push_store,
                &uri,
                &lang,
                pull_supported,
                expected_version,
                requested_at,
            )
            .await?;
            // 请求快照与完成时磁盘不一致：拒绝将旧结果当作新代码的诊断。
            for (path, fingerprint) in snapshots {
                let metadata = tokio::fs::metadata(&path).await.map_err(|error| {
                    LspError::Internal(format!("diagnostic snapshot unavailable: {error}"))
                })?;
                if metadata.len() > MAX_FILE_SIZE {
                    return Err(LspError::FileTooLarge(path.display().to_string()));
                }
                let current = tokio::fs::read(&path).await.map_err(|error| {
                    LspError::Internal(format!("diagnostic snapshot unavailable: {error}"))
                })?;
                if blake3::hash(&current) != fingerprint {
                    return Err(LspError::Internal(format!(
                        "Content changed during diagnostics: {}. Retry the request.",
                        path.display()
                    )));
                }
            }
            let mut value = format::diagnostics_to_value(&lang, &command, items);
            value["documentVersion"] = json!(expected_version);
            value["diagnosticSource"] = json!(source);
            value["pushVersionVerified"] = json!(push_version_verified);
            if !warnings.is_empty() {
                value["partial"] = json!(true);
                value["status"] = json!("partial");
                value["warnings"] = json!(warnings);
            }
            Ok(value)
        })
    }

    /// 保留入口兼容性；不持久化无法证明依赖有效性的单文件诊断结果。
    pub async fn store_diagnostics(&mut self, _path: &Path, _value: &Value) {
        self.touch();
    }

    /// 标记最近使用（供空闲回收 / LRU 淘汰）。
    pub fn touch(&self) {
        self.last_used_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// 查询子进程是否已退出（同步、非阻塞）：返回退出码；`None` = 仍在运行。
    /// 供状态快照检测「进程崩溃但会话未标记 dead」的情况（§7.1 懒标记）。
    pub fn exited_code(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => status.code(),
            _ => None,
        }
    }

    /// 优雅关闭：shutdown → 等待退出（≤3s）→ kill 兜底。
    pub async fn shutdown(&mut self) {
        self.dead = true;
        let _ = tokio::time::timeout(Duration::from_secs(3), self.socket.shutdown(())).await;
        let _ = self.socket.exit(());
        self.mainloop_task.abort();
        // 等待进程退出（≤3s），超时 kill。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            if tokio::time::Instant::now() >= deadline {
                let _ = self.child.kill().await;
                break;
            }
            if let Ok(Some(_)) = self.child.try_wait() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = self.child.kill().await;
    }
}

/// 在任务创建前取得租约，任务完成/取消/未轮询即被丢弃都会归还。
struct DiagnosticLease(Arc<AtomicU64>);
impl DiagnosticLease {
    fn new(counter: Arc<AtomicU64>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self(counter)
    }
}
impl Drop for DiagnosticLease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 诊断准备结果：缓存命中（直接返回）或待等待（并发拉取）。
pub enum PrepareResult {
    // 保留旧入口匹配分支的兼容性；目前不产生缓存命中。
    #[allow(dead_code)]
    Cached(Value),
    Pending(PendingDiagnostics),
}

/// 待等待的诊断（锁外并发所需的最小信息集）。
pub struct PendingDiagnostics {
    pub path: PathBuf,
    pub uri: lsp_types::Url,
    expected_version: i32,
    requested_at: Instant,
    snapshots: Vec<(PathBuf, blake3::Hash)>,
}

/// 合法pull（包括空诊断）立即返回；仅取消错误重试，不靠非空判断就绪。
async fn pull_diagnostics_with_retry(
    socket: &mut async_lsp::ServerSocket,
    uri: &lsp_types::Url,
) -> Result<Option<Vec<Diagnostic>>, LspError> {
    for attempt in 0..3 {
        match client::pull_diagnostics(socket, uri, REQUEST_TIMEOUT).await {
            Err(LspError::ServerFailed(message))
                if attempt < 2 && (message.contains("cancelled") || message.contains("-32802")) =>
            {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            result => return result,
        }
    }
    Err(LspError::RequestTimeout(
        "diagnostic request cancelled repeatedly".into(),
    ))
}

async fn collect_fresh_diagnostics(
    socket: &mut async_lsp::ServerSocket,
    store: &PushDiagnostics,
    uri: &lsp_types::Url,
    lang: &str,
    pull_supported: bool,
    expected_version: i32,
    requested_at: Instant,
) -> Result<(Vec<Diagnostic>, Vec<Value>, &'static str, Option<bool>), LspError> {
    let mut warnings = Vec::new();
    let pulled = if pull_supported {
        match pull_diagnostics_with_retry(socket, uri).await {
            Ok(items) => items,
            Err(error) => {
                warnings.push(json!({"source":"pull","error":format!("{error:?}")}));
                None
            }
        }
    } else {
        None
    };
    if let Some(mut items) = pulled {
        if lang != "rust" {
            return Ok((items, warnings, "pull", None));
        }
        // rustc/flycheck是附加通道：短暂机会等待，不以它阻塞/丢弃成功pull。
        match client::wait_push_diagnostics(
            store,
            uri,
            expected_version,
            requested_at,
            Duration::from_millis(500),
        )
        .await
        {
            Ok(report) => {
                let verified = report.version == Some(expected_version);
                if !verified {
                    warnings.push(json!({"source":"push","error":"Supplemental diagnostics omit document version; freshness is unverified"}));
                }
                items.extend(report.diagnostics);
                dedup_diagnostics(&mut items);
                Ok((items, warnings, "pull+push", Some(verified)))
            }
            Err(error) => {
                warnings.push(json!({"source":"push","error":format!("Supplemental rustc diagnostics unavailable: {error:?}")}));
                Ok((items, warnings, "pull", Some(false)))
            }
        }
    } else {
        let report =
            client::wait_push_diagnostics(store, uri, expected_version, requested_at, PUSH_TIMEOUT)
                .await?;
        let verified = report.version == Some(expected_version);
        if !verified {
            warnings.push(json!({"source":"push","error":"Server omitted document version; these diagnostics are observations, not a verified result for the requested version"}));
        }
        Ok((report.diagnostics, warnings, "push", Some(verified)))
    }
}

/// 寻找代表性 JS/TS 入口；有界扫描、不跟随链接、不进入依赖和构建目录。
fn find_project_entry(project_root: &Path, extensions: &[&str]) -> Option<PathBuf> {
    let matches = |path: &Path| {
        path.extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                extensions
                    .iter()
                    .any(|wanted| ext.eq_ignore_ascii_case(wanted.trim_start_matches('.')))
            })
    };
    const CANDIDATES: &[&str] = &[
        "src/main.ts",
        "src/index.ts",
        "main.ts",
        "index.ts",
        "src/main.tsx",
        "src/index.tsx",
        "main.tsx",
        "index.tsx",
        "src/main.js",
        "src/index.js",
        "main.js",
        "index.js",
        "src/main.jsx",
        "src/index.jsx",
        "main.jsx",
        "index.jsx",
    ];
    let suitable = |path: &Path| {
        matches(path)
            && std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= MAX_FILE_SIZE)
    };
    for candidate in CANDIDATES {
        let path = project_root.join(candidate);
        if suitable(&path) {
            return Some(path);
        }
    }
    super::detect::scan_project_inventory(project_root, 6)
        .files
        .into_iter()
        .find(|path| suitable(path))
}

#[cfg(test)]
mod context_tests {
    use super::*;

    #[test]
    fn dotted_and_plain_extensions_find_the_same_typescript_entry() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let dotted = find_project_entry(root, &[".ts", ".tsx"]);
        let plain = find_project_entry(root, &["ts", "tsx"]);
        assert!(dotted.is_some());
        assert_eq!(dotted, plain);
    }

    #[test]
    fn snapshot_fingerprint_detects_same_size_changes() {
        assert_ne!(blake3::hash(b"let a=1;"), blake3::hash(b"let a=2;"));
    }
}

/// 诊断去重（push 与 pull 可能重叠）：按 (起始行, 起始列, 消息) 去重。
fn dedup_diagnostics(diagnostics: &mut Vec<Diagnostic>) {
    let mut seen = std::collections::HashSet::new();
    diagnostics.retain(|d| {
        seen.insert((
            d.range.start.line,
            d.range.start.character,
            d.message.clone(),
        ))
    });
}

/// 统计诊断 severity 数量（1=error, 2=warning；其余忽略）。
fn count_severities(diagnostics: &[Diagnostic]) -> (usize, usize) {
    let mut errors = 0usize;
    let mut warnings = 0usize;
    for item in diagnostics {
        match item.severity {
            Some(lsp_types::DiagnosticSeverity::ERROR) => errors += 1,
            Some(lsp_types::DiagnosticSeverity::WARNING) => warnings += 1,
            _ => {}
        }
    }
    (errors, warnings)
}

// ---------------------------------------------------------------------------
// Phase 3 工具辅助（definition/references/symbols/format）
// ---------------------------------------------------------------------------

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// 从代码行提取 column（0-indexed）处的标识符（简单边界扫描，无 regex 依赖）。
fn extract_identifier_at(line: &str, column: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    if chars.is_empty() || column >= chars.len() || !is_ident_char(chars[column]) {
        return String::new();
    }
    let mut start = column;
    let mut end = column;
    while start > 0 && is_ident_char(chars[start - 1]) {
        start -= 1;
    }
    while end < chars.len() && is_ident_char(chars[end]) {
        end += 1;
    }
    chars[start..end].iter().collect()
}

/// 读取每个引用位置的上下文行（trim，最多 max 条；读取失败留空）。
async fn read_reference_contexts(locations: &[Location], max: usize) -> Vec<String> {
    let mut contexts = Vec::with_capacity(locations.len().min(max));
    for location in locations.iter().take(max) {
        let context = match location.uri.to_file_path() {
            Ok(path) => read_line_context(&path, location.range.start.line).await,
            Err(_) => String::new(),
        };
        contexts.push(context);
    }
    contexts
}

/// 读取指定行（0-indexed）的 trim 文本。
pub(crate) async fn read_line_context(path: &Path, line: u32) -> String {
    let Ok(text) = tokio::fs::read_to_string(path).await else {
        return String::new();
    };
    text.lines()
        .nth(line as usize)
        .map(|l| l.trim().to_string())
        .unwrap_or_default()
}

/// 读取 incoming call 每个调用点的上下文行（调用点位于调用者 from.uri 文件，最多 max 条）。
async fn read_incoming_call_contexts(
    calls: &[CallHierarchyIncomingCall],
    max: usize,
) -> Vec<Vec<String>> {
    let mut all = Vec::with_capacity(calls.len().min(max));
    for call in calls.iter().take(max) {
        let mut contexts = Vec::with_capacity(call.from_ranges.len());
        let path = call.from.uri.to_file_path().ok();
        for range in call.from_ranges.iter() {
            let context = match &path {
                Some(path) => read_line_context(path, range.start.line).await,
                None => String::new(),
            };
            contexts.push(context);
        }
        all.push(contexts);
    }
    all
}

/// 读取 outgoing call 每个调用点的上下文行（调用点位于**调用者**文件，即
/// prepare 时选中的当前文件；最多 max 条）。
async fn read_outgoing_call_contexts(
    caller_path: &Path,
    calls: &[CallHierarchyOutgoingCall],
    max: usize,
) -> Vec<Vec<String>> {
    let mut all = Vec::with_capacity(calls.len().min(max));
    for call in calls.iter().take(max) {
        let mut contexts = Vec::with_capacity(call.from_ranges.len());
        for range in call.from_ranges.iter() {
            contexts.push(read_line_context(caller_path, range.start.line).await);
        }
        all.push(contexts);
    }
    all
}

/// 严格把LSP UTF-16位置转换为UTF-8字节位置；拒绝越界或代理对中间位置。
fn utf16_byte_offset(text: &str, position: lsp_types::Position) -> Result<usize, LspError> {
    let mut start = 0usize;
    for _ in 0..position.line {
        let next = text[start..]
            .find('\n')
            .ok_or_else(|| LspError::Internal("edit line is out of bounds".into()))?;
        start += next + 1;
    }
    let raw_end = text[start..]
        .find('\n')
        .map(|n| start + n)
        .unwrap_or(text.len());
    let end = if raw_end > start && text.as_bytes()[raw_end - 1] == b'\r' {
        raw_end - 1
    } else {
        raw_end
    };
    let mut units = 0u32;
    for (offset, ch) in text[start..end].char_indices() {
        if units == position.character {
            return Ok(start + offset);
        }
        units += ch.len_utf16() as u32;
        if units > position.character {
            return Err(LspError::Internal(
                "edit position splits a UTF-16 surrogate pair".into(),
            ));
        }
    }
    if units == position.character {
        Ok(end)
    } else {
        Err(LspError::Internal("edit column is out of bounds".into()))
    }
}

/// 先验证全部范围再修改内存文本；重叠、反向范围或歧义同点插入均明确拒绝。
fn apply_edits(text: &str, edits: &[TextEdit]) -> Result<String, LspError> {
    let mut planned = Vec::with_capacity(edits.len());
    for edit in edits {
        let start = utf16_byte_offset(text, edit.range.start)?;
        let end = utf16_byte_offset(text, edit.range.end)?;
        if start > end {
            return Err(LspError::Internal("reversed edit range".into()));
        }
        planned.push((start, end, edit.new_text.as_str()));
    }
    planned.sort_by_key(|(start, end, _)| (*start, *end));
    for pair in planned.windows(2) {
        if pair[1].0 < pair[0].1 || pair[1].0 == pair[0].0 {
            return Err(LspError::Internal(
                "overlapping or ambiguous edit ranges".into(),
            ));
        }
    }
    let mut result = text.to_string();
    for (start, end, replacement) in planned.into_iter().rev() {
        result.replace_range(start..end, replacement);
    }
    Ok(result)
}

const RENAME_PREVIEW_TTL: Duration = Duration::from_secs(300);
const MAX_RENAME_PREVIEWS: usize = 32;
const MAX_RENAME_PREVIEW_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct RenameBinding {
    target: PathBuf,
    line: u32,
    column: u32,
    new_name: String,
    root: PathBuf,
    config_fingerprint: String,
}
struct RenameFile {
    uri: String,
    path: PathBuf,
    physical_path: PathBuf,
    before_hash: blake3::Hash,
    after: String,
    edit_count: usize,
    changed: bool,
}
struct RenamePreview {
    binding: RenameBinding,
    target_hash: blake3::Hash,
    files: Vec<RenameFile>,
    created: Instant,
    expires_at_ms: u64,
}

fn retain_rename_preview(
    cache: &mut HashMap<String, RenamePreview>,
    preview: RenamePreview,
    now: Instant,
) -> String {
    cache.retain(|_, entry| now.saturating_duration_since(entry.created) < RENAME_PREVIEW_TTL);
    if cache.len() >= MAX_RENAME_PREVIEWS {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.created)
            .map(|(id, _)| id.clone())
        {
            cache.remove(&oldest);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    cache.insert(id.clone(), preview);
    id
}

fn consume_rename_preview(
    cache: &mut HashMap<String, RenamePreview>,
    id: &str,
    binding: &RenameBinding,
    now: Instant,
) -> Result<RenamePreview, LspError> {
    let preview = cache.remove(id).ok_or_else(|| {
        LspError::Unsupported("unknown or consumed previewId; request a new rename preview".into())
    })?;
    if now.saturating_duration_since(preview.created) >= RENAME_PREVIEW_TTL
        || &preview.binding != binding
    {
        return Err(LspError::Unsupported(
            "rename preview expired or request/config/workspace changed; request a new preview"
                .into(),
        ));
    }
    Ok(preview)
}

struct RenameSnapshot {
    paths: Vec<PathBuf>,
    text: String,
    version: i32,
    hash: blake3::Hash,
}

async fn capture_rename_snapshots(
    session: &ServerSession,
) -> Result<HashMap<PathBuf, RenameSnapshot>, LspError> {
    let mut snapshots: HashMap<PathBuf, RenameSnapshot> = HashMap::new();
    let mut bytes = 0usize;
    for (path, text) in &session.opened_contents {
        let physical = tokio::fs::canonicalize(path)
            .await
            .map_err(|e| LspError::Internal(e.to_string()))?;
        let version = *session.opened_files.get(path).ok_or_else(|| {
            LspError::Unsupported("unsynchronized rename document; retry preview".into())
        })?;
        if session.read_file_text(path).await? != *text {
            return Err(LspError::Unsupported(
                "document changed before final rename request; retry preview".into(),
            ));
        }
        if let Some(existing) = snapshots.get_mut(&physical) {
            if existing.text != *text || existing.version != version {
                return Err(LspError::Unsupported(
                    "document aliases have inconsistent snapshots; retry with a fresh session"
                        .into(),
                ));
            }
            existing.paths.push(path.clone());
        } else {
            bytes = bytes.saturating_add(text.len());
            if bytes > MAX_RENAME_PREVIEW_BYTES {
                return Err(LspError::Unsupported(
                    "rename snapshot budget exceeded; narrow the operation".into(),
                ));
            }
            snapshots.insert(
                physical,
                RenameSnapshot {
                    paths: vec![path.clone()],
                    text: text.clone(),
                    version,
                    hash: blake3::hash(text.as_bytes()),
                },
            );
        }
    }
    Ok(snapshots)
}

async fn verify_rename_snapshots(
    session: &ServerSession,
    snapshots: &HashMap<PathBuf, RenameSnapshot>,
) -> Result<(), LspError> {
    for (physical, snapshot) in snapshots {
        for path in &snapshot.paths {
            let current = tokio::fs::canonicalize(path).await.map_err(|_| {
                LspError::Unsupported("rename snapshot path disappeared; retry preview".into())
            })?;
            if &current != physical
                || blake3::hash(session.read_file_text(path).await?.as_bytes()) != snapshot.hash
                || session.opened_files.get(path) != Some(&snapshot.version)
            {
                return Err(LspError::Unsupported(
                    "document changed during final rename request; retry preview".into(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_rename_version(
    snapshot: &RenameSnapshot,
    server_version: Option<i32>,
) -> Result<(), LspError> {
    if server_version.is_some_and(|version| version != snapshot.version) {
        return Err(LspError::Unsupported(
            "server rename edit version differs from synchronized request snapshot; retry preview"
                .into(),
        ));
    }
    Ok(())
}

async fn prepare_rename_files(
    edit: &WorkspaceEdit,
    snapshots: &HashMap<PathBuf, RenameSnapshot>,
) -> Result<Vec<RenameFile>, LspError> {
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut bytes = 0usize;
    for (uri, version, edits) in format::workspace_edit_files_versioned(edit)? {
        let path = uri
            .to_file_path()
            .map_err(|_| LspError::Unsupported("non-file rename edit URI".into()))?;
        let physical_path = tokio::fs::canonicalize(&path)
            .await
            .map_err(|e| LspError::Internal(e.to_string()))?;
        if !seen.insert(physical_path.clone()) {
            return Err(LspError::Unsupported(
                "multiple rename groups for the same physical file".into(),
            ));
        }
        let snapshot = snapshots.get(&physical_path).ok_or_else(|| LspError::Unsupported("final rename introduced an unsynchronized file; retry preview to discover the updated graph".into()))?;
        validate_rename_version(snapshot, version)?;
        let before = &snapshot.text;
        let after = apply_edits(before, &edits)?;
        bytes = bytes
            .saturating_add(before.len())
            .saturating_add(after.len());
        if bytes > MAX_RENAME_PREVIEW_BYTES {
            return Err(LspError::Unsupported(
                "rename preview exceeds 8MiB safety budget; narrow the operation".into(),
            ));
        }
        files.push(RenameFile {
            uri: uri.to_string(),
            path,
            physical_path,
            before_hash: snapshot.hash,
            changed: before != &after,
            after,
            edit_count: edits.len(),
        });
    }
    Ok(files)
}

fn rename_file_matches(file: &RenameFile, physical: &Path, content: &[u8]) -> bool {
    physical == file.physical_path && blake3::hash(content) == file.before_hash
}

async fn verify_rename_file(session: &ServerSession, file: &RenameFile) -> Result<(), LspError> {
    let physical = tokio::fs::canonicalize(&file.path).await.map_err(|_| {
        LspError::Unsupported("rename preview path unavailable; request a new preview".into())
    })?;
    let content = session.read_file_text(&physical).await.map_err(|_| {
        LspError::Unsupported("rename preview file unreadable; request a new preview".into())
    })?;
    if !rename_file_matches(file, &physical, content.as_bytes()) {
        return Err(LspError::Unsupported(format!(
            "rename preview content/path changed: {}; request a new preview",
            file.path.display()
        )));
    }
    Ok(())
}

fn rename_partial_result(
    applied: &[String],
    files: &[Value],
    failed: &Path,
    error: &LspError,
    may_be_modified: bool,
) -> Value {
    let partial = !applied.is_empty() || may_be_modified;
    json!({"status": if partial {"partial"} else {"failed"}, "partial":partial,
        "applied":false,"dryRun":false,"partiallyApplied":partial,
        "appliedFiles":applied,"files":files,"failedFile":failed.to_string_lossy(),
        "failedFileMayBeModified":may_be_modified,"error":format!("{error:?}"),
        "requiresNewPreview":true,"message":"Rename stopped; no cross-file transaction or rollback was performed. Inspect applied/failed files before a new preview."})
}

async fn apply_rename_preview(
    session: &mut ServerSession,
    preview: RenamePreview,
) -> Result<Value, LspError> {
    if blake3::hash(
        session
            .read_file_text(&preview.binding.target)
            .await?
            .as_bytes(),
    ) != preview.target_hash
    {
        return Err(LspError::Unsupported(
            "rename target changed since preview; request a new preview".into(),
        ));
    }
    for file in &preview.files {
        verify_rename_file(session, file).await?;
    }
    let mut applied: Vec<String> = Vec::new();
    let mut summaries = Vec::new();
    for file in &preview.files {
        if let Err(error) = verify_rename_file(session, file).await {
            return Ok(rename_partial_result(
                &applied, &summaries, &file.path, &error, false,
            ));
        }
        if file.changed {
            if let Err(error) = tokio::fs::write(&file.physical_path, &file.after).await {
                return Ok(rename_partial_result(
                    &applied,
                    &summaries,
                    &file.path,
                    &LspError::Internal(error.to_string()),
                    true,
                ));
            }
            applied.push(file.physical_path.to_string_lossy().into_owned());
            summaries.push(json!({"uri":file.uri,"editCount":file.edit_count,"applied":true}));
            let paths: Vec<PathBuf> = session.opened_files.keys().cloned().collect();
            for path in paths {
                if tokio::fs::canonicalize(&path).await.ok().as_ref() == Some(&file.physical_path) {
                    if let Err(error) = session.ensure_open(&path).await {
                        return Ok(rename_partial_result(
                            &applied, &summaries, &file.path, &error, true,
                        ));
                    }
                }
            }
        } else {
            summaries.push(json!({"uri":file.uri,"editCount":file.edit_count,"applied":false}));
        }
    }
    Ok(
        json!({"language":session.lang,"status":"complete","applied":true,"dryRun":false,
        "changeCount":applied.len(),"appliedFiles":applied,"files":summaries,"previewConsumed":true,
        "previewExpiresAt":preview.expires_at_ms}),
    )
}

#[cfg(test)]
mod rename_snapshot_tests {
    use super::*;
    fn snapshot() -> RenameSnapshot {
        RenameSnapshot {
            paths: vec![PathBuf::from("/fixture/b.rs")],
            text: "old".into(),
            version: 7,
            hash: blake3::hash(b"old"),
        }
    }
    #[test]
    fn server_version_must_equal_pre_request_version() {
        assert!(validate_rename_version(&snapshot(), Some(7)).is_ok());
        assert!(validate_rename_version(&snapshot(), Some(6)).is_err());
        assert!(validate_rename_version(&snapshot(), None).is_ok());
    }
    #[test]
    fn response_time_text_cannot_replace_synchronized_baseline() {
        let baseline = snapshot();
        assert_ne!(baseline.hash, blake3::hash(b"new"));
        assert_eq!(baseline.text, "old");
        assert_eq!(baseline.hash, blake3::hash(baseline.text.as_bytes()));
    }
    #[test]
    fn diagnostic_lease_is_released_even_without_polling() {
        let counter = Arc::new(AtomicU64::new(0));
        let lease = DiagnosticLease::new(counter.clone());
        assert_eq!(counter.load(Ordering::Acquire), 1);
        drop(lease);
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }
}

#[cfg(test)]
mod rename_preview_tests {
    use super::*;
    fn binding() -> RenameBinding {
        RenameBinding {
            target: PathBuf::from("/fixture/a.rs"),
            line: 2,
            column: 3,
            new_name: "renamed".into(),
            root: PathBuf::from("/fixture"),
            config_fingerprint: "config-a".into(),
        }
    }
    fn preview(now: Instant) -> RenamePreview {
        RenamePreview {
            binding: binding(),
            target_hash: blake3::hash(b"source"),
            files: vec![],
            created: now,
            expires_at_ms: 300000,
        }
    }
    #[test]
    fn receipt_is_single_use_and_expiry_is_enforced() {
        let now = Instant::now();
        let mut cache = HashMap::new();
        let id = retain_rename_preview(&mut cache, preview(now), now);
        assert!(consume_rename_preview(&mut cache, &id, &binding(), now).is_ok());
        assert!(consume_rename_preview(&mut cache, &id, &binding(), now).is_err());
        let id = retain_rename_preview(&mut cache, preview(now), now);
        assert!(
            consume_rename_preview(&mut cache, &id, &binding(), now + RENAME_PREVIEW_TTL).is_err()
        );
    }
    #[test]
    fn changed_binding_is_rejected_and_consumed() {
        let now = Instant::now();
        let mut cache = HashMap::new();
        let id = retain_rename_preview(&mut cache, preview(now), now);
        let mut changed = binding();
        changed.config_fingerprint = "config-b".into();
        assert!(consume_rename_preview(&mut cache, &id, &changed, now).is_err());
        assert!(!cache.contains_key(&id));
    }
    #[test]
    fn preview_cache_has_hard_capacity() {
        let now = Instant::now();
        let mut cache = HashMap::new();
        for _ in 0..40 {
            retain_rename_preview(&mut cache, preview(now), now);
        }
        assert_eq!(cache.len(), MAX_RENAME_PREVIEWS);
    }
    #[test]
    fn content_hash_and_physical_path_are_both_bound() {
        let file = RenameFile {
            uri: "file:///fixture/a.rs".into(),
            path: PathBuf::from("/fixture/a.rs"),
            physical_path: PathBuf::from("/physical/a.rs"),
            before_hash: blake3::hash(b"source"),
            after: "renamed".into(),
            edit_count: 1,
            changed: true,
        };
        assert!(rename_file_matches(
            &file,
            Path::new("/physical/a.rs"),
            b"source"
        ));
        assert!(!rename_file_matches(
            &file,
            Path::new("/physical/a.rs"),
            b"sourcE"
        ));
        assert!(!rename_file_matches(
            &file,
            Path::new("/physical/b.rs"),
            b"source"
        ));
    }
    #[test]
    fn partial_failure_names_already_applied_files() {
        let result = rename_partial_result(
            &["/fixture/a.rs".into()],
            &[],
            Path::new("/fixture/b.rs"),
            &LspError::Internal("io failure".into()),
            false,
        );
        assert_eq!(result["status"], "partial");
        assert_eq!(result["applied"], false);
        assert_eq!(result["appliedFiles"][0], "/fixture/a.rs");
        assert_eq!(result["requiresNewPreview"], true);
    }
}

#[cfg(test)]
mod utf16_edit_tests {
    use super::*;
    fn edit(sl: u32, sc: u32, el: u32, ec: u32, text: &str) -> TextEdit {
        TextEdit {
            range: lsp_types::Range::new(
                lsp_types::Position::new(sl, sc),
                lsp_types::Position::new(el, ec),
            ),
            new_text: text.into(),
        }
    }
    #[test]
    fn emoji_before_identifier_uses_utf16_units() {
        assert_eq!(
            apply_edits("😀foo\r\nbar", &[edit(0, 2, 0, 5, "name")]).unwrap(),
            "😀name\r\nbar"
        );
    }
    #[test]
    fn rejects_surrogate_split_and_out_of_bounds() {
        assert!(apply_edits("😀foo", &[edit(0, 1, 0, 2, "")]).is_err());
        assert!(apply_edits("abc", &[edit(0, 0, 0, 9, "")]).is_err());
        assert!(apply_edits("abc", &[edit(1, 0, 1, 0, "")]).is_err());
    }
    #[test]
    fn rejects_reversed_and_overlapping_ranges() {
        assert!(apply_edits("abcd", &[edit(0, 3, 0, 1, "")]).is_err());
        assert!(apply_edits("abcd", &[edit(0, 0, 0, 2, "x"), edit(0, 1, 0, 3, "y")]).is_err());
    }
    #[test]
    fn multiline_crlf_and_independent_edits_preserve_offsets() {
        assert_eq!(
            apply_edits("😀foo\r\nbar", &[edit(0, 5, 1, 0, "")]).unwrap(),
            "😀foobar"
        );
        assert_eq!(
            apply_edits("a😀b", &[edit(0, 0, 0, 1, "A"), edit(0, 3, 0, 4, "B")]).unwrap(),
            "A😀B"
        );
    }
}
