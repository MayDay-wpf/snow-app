//! LSP 协议客户端封装：进程 spawn、initialize、didOpen、hover、diagnostics、
//! definition / references / documentSymbol。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_lsp::router::Router;
use async_lsp::{ErrorCode, LanguageServer, MainLoop};
use lsp_types::notification::{
    LogMessage, Progress, PublishDiagnostics, ShowMessage, TelemetryEvent,
};
use lsp_types::request::{WorkspaceConfiguration, WorkspaceFoldersRequest};
use lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem,
    CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams,
    ClientCapabilities, Diagnostic, DidChangeTextDocumentParams, DidOpenTextDocumentParams,
    DidSaveTextDocumentParams, DocumentDiagnosticParams, DocumentDiagnosticReport,
    DocumentSymbolParams, DocumentSymbolResponse, GotoDefinitionParams, GotoDefinitionResponse,
    Hover, HoverParams, InitializeParams, InitializedParams, Location, PartialResultParams,
    Position, ProgressParams, ReferenceContext, ReferenceParams, RenameParams,
    TextDocumentClientCapabilities, TextDocumentContentChangeEvent, TextDocumentIdentifier,
    TextDocumentItem, TextDocumentPositionParams, TypeHierarchyItem, TypeHierarchyPrepareParams,
    TypeHierarchySubtypesParams, TypeHierarchySupertypesParams, Url,
    VersionedTextDocumentIdentifier, WorkDoneProgressParams, WorkspaceEdit, WorkspaceFolder,
    WorkspaceSymbolParams, WorkspaceSymbolResponse,
};
use tokio::sync::Mutex;

use super::probe;
use super::types::{LspError, ServerConfig};
use crate::utils::process_tree::ProcessTreeGuard;

/// 每URI保留最近若干版本，批量请求互不改变其他文档的预期版本。
pub type PushDiagnostics = Arc<Mutex<HashMap<String, Vec<PushEntry>>>>;

#[derive(Debug, Clone)]
pub struct PushEntry {
    pub version: Option<i32>,
    pub received_at: Instant,
    pub diagnostics: Vec<Diagnostic>,
}

fn select_push_entry(
    entries: &[PushEntry],
    expected_version: i32,
    not_before: Instant,
) -> Option<PushEntry> {
    entries
        .iter()
        .rev()
        .find(|entry| entry.version == Some(expected_version) && entry.received_at >= not_before)
        .or_else(|| {
            entries
                .iter()
                .rev()
                .find(|entry| entry.version.is_none() && entry.received_at >= not_before)
        })
        .cloned()
}

/// 统一的 uri key：Windows 路径大小写不敏感（rust-analyzer 推
/// `file:///c:/...`，Url::from_file_path 生成 `file:///C:/...`），
/// 统一转小写保证匹配。
pub fn uri_key(uri: &Url) -> String {
    match uri.to_file_path() {
        Ok(path) => path
            .to_str()
            .map(|p| {
                #[cfg(windows)]
                {
                    p.to_lowercase()
                }
                #[cfg(not(windows))]
                {
                    p.to_string()
                }
            })
            .unwrap_or_else(|| uri.as_str().to_string()),
        Err(_) => uri.as_str().to_string(),
    }
}

/// JVM 系服务器启动超时（附录 B / §7.3）。
pub fn initialize_timeout_for(lang: &str) -> Duration {
    if matches!(lang, "java" | "kotlin") {
        Duration::from_secs(120)
    } else {
        Duration::from_secs(30)
    }
}

/// 生成 LSP 语言标识（didOpen 用）。
pub fn language_id_for(lang: &str) -> String {
    match lang {
        "typescript" => "typescript".into(),
        "python" => "python".into(),
        "go" => "go".into(),
        "rust" => "rust".into(),
        "c" => "c".into(),
        "csharp" => "csharp".into(),
        "java" => "java".into(),
        "kotlin" => "kotlin".into(),
        "php" => "php".into(),
        "ruby" => "ruby".into(),
        "swift" => "swift".into(),
        "lua" => "lua".into(),
        other => other.to_string(),
    }
}

/// Windows 上解析 spawn 命令。npm 全局二进制是 .cmd/.ps1 shim（无 .exe），
/// CreateProcess 无法直接执行；返回 (program, args) 供 Command 使用（A1）。
///
/// - `.cmd/.bat`：`cmd.exe /d /s /c call "path" args...`——`call` 前缀 + 每个参数
///   作为独立 argv 元素，规避 cmd 的引号解析陷阱（Rust 会把含空格参数包成
///   `"..."`，行首非引号时 cmd 不做引号剥离，`call` 正确接收带引号路径）。
/// - `.ps1`：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File path args...`。
/// - 其他（.exe/.com/无扩展名）：直跑。
#[cfg(windows)]
fn resolve_windows_spawn(command: &str, args: &[String]) -> std::io::Result<(String, Vec<String>)> {
    use std::io::ErrorKind;

    // probe::resolve_command 按 PATHEXT(+.PS1) 返回首个存在的候选；找不到 →
    // NotFound（保持现有 ServerMissing 降级路径，含 install_command 提示）。
    let Some(mut path) = probe::resolve_command(command) else {
        return Err(std::io::Error::from(ErrorKind::NotFound));
    };

    // npm cmd-shim 会额外生成无扩展名的 sh 脚本（排在 PATHEXT 候选之前，probe
    // 先命中它），CreateProcess 无法执行：改选同名 shim（.cmd/.bat/.ps1）。
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".exe")
        || lower.ends_with(".com")
        || lower.ends_with(".cmd")
        || lower.ends_with(".bat")
        || lower.ends_with(".ps1"))
    {
        for shim_ext in [".cmd", ".bat", ".ps1"] {
            let candidate = format!("{path}{shim_ext}");
            if Path::new(&candidate).is_file() {
                path = candidate;
                break;
            }
        }
    }

    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut full = vec!["/d".into(), "/s".into(), "/c".into(), "call".into(), path];
        full.extend(args.iter().map(|arg| escape_cmd_arg(arg)));
        Ok(("cmd.exe".into(), full))
    } else if lower.ends_with(".ps1") {
        let mut full = vec![
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            path,
        ];
        full.extend(args.iter().cloned());
        Ok(("powershell.exe".into(), full))
    } else {
        // .exe/.com/无扩展名可执行文件。
        Ok((path, args.to_vec()))
    }
}

/// cmd.exe 命令行参数转义：`^` → `^^`、`"` → `^"`（cmd 的转义符是 `^` 而非
/// 反斜杠；参数内出现这两个字符会被 cmd 解析吞掉或打断引号。罕见但防炸）。
#[cfg(windows)]
fn escape_cmd_arg(arg: &str) -> String {
    arg.replace('^', "^^").replace('"', "^\"")
}

/// spawn 语言服务器进程并建立 async-lsp 客户端。
///
/// 返回 (子进程句柄, mainloop 任务, 客户端 socket, push 诊断共享状态,
/// mainloop 完成标志, 进程树回收 guard)。mainloop 完成
/// 标志用于会话死亡检测；诊断使用服务器原始文档版本关联请求。
/// ProcessTreeGuard（M2/R4.1，Job Object / 进程组）在会话销毁时兜底杀整棵树，
/// 消除 cmd/powershell shim 后代孤儿进程（构造失败仅告警，不失败）。
pub fn spawn_client(
    config: &ServerConfig,
    project_root: &Path,
) -> std::io::Result<(
    tokio::process::Child,
    tokio::task::JoinHandle<()>,
    async_lsp::ServerSocket,
    PushDiagnostics,
    Arc<AtomicBool>,
    ProcessTreeGuard,
)> {
    // Windows：npm 全局二进制是 .cmd/.ps1 shim（无 .exe），CreateProcess 无法直接
    // 执行，需按 PATHEXT 解析候选并包装（A1）；非 Windows 保持原样。
    #[cfg(windows)]
    let (program, parsed_args) = resolve_windows_spawn(&config.command, &config.args)?;
    #[cfg(not(windows))]
    let (program, parsed_args) = (
        probe::resolve_command(&config.command).unwrap_or_else(|| config.command.clone()),
        config.args.clone(),
    );

    let mut command = tokio::process::Command::new(program);
    command
        .args(parsed_args)
        .current_dir(project_root)
        .env("PATH", probe::augmented_path_os_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: 防止服务器进程弹出黑窗（tokio Command 自带方法）。
        command.creation_flags(0x0800_0000);
    }

    // Unix：子进程设为独立进程组组长（pgid == pid），进程树 guard 用
    // kill(-pgid) 回收整棵树（与 external MCP 一致，M2/R4.1）。
    #[cfg(unix)]
    {
        command.process_group(0);
    }

    let mut child = command.spawn()?;
    // M2/R4.1：接入进程树回收（Windows Job Object / Unix 进程组），与 external
    // MCP 一致；构造失败仅告警（guard 内部降级，不阻断 spawn）。
    // id() 为 None（进程已退出）时 pid 0 → guard 为无害空操作。
    let process_tree_guard = ProcessTreeGuard::new(&config.lang, child.id().unwrap_or(0));
    let stdout = child.stdout.take().expect("stdout piped");
    let stdin = child.stdin.take().expect("stdin piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let lang_for_stderr = config.lang.clone();
    let lang_for_mainloop = config.lang.clone();
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        // stderr 转发（降噪版，2026-09-24）：
        // - 已知噪音模式直接丢弃：rust-analyzer 的 "inference diagnostic in
        //   desugared expr" 内部日志实测可达数百条连续重复、无诊断价值
        //   （其内部 tracing 输出，被它标为 ERROR 级）；
        // - 其余行折叠连续重复：相同内容连续出现只保留首条，恢复输出时附
        //   "(previous line repeated N more times)" 摘要——真实错误一条不漏
        //   （不同内容照常输出）；
        // - 跨块行缓冲：块读边界不再截断长行（此前 1024B 边界会把一行切
        //   成两段分别打印）。
        const NOISE_MARKERS: &[&str] = &["inference diagnostic in desugared expr"];
        let mut reader = stderr;
        let mut buffer = [0u8; 1024];
        let mut carry = String::new();
        let mut pending: Option<String> = None;
        let mut repeated: u32 = 0;
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.push_str(&String::from_utf8_lossy(&buffer[..n]));
                    while let Some(newline) = carry.find('\n') {
                        let line = carry[..newline].trim_end_matches('\r').to_string();
                        carry.drain(..=newline);
                        if NOISE_MARKERS.iter().any(|marker| line.contains(marker)) {
                            continue;
                        }
                        if pending.as_deref() == Some(line.as_str()) {
                            repeated += 1;
                            continue;
                        }
                        if repeated > 0 {
                            if let Some(previous) = pending.as_deref() {
                                eprintln!(
                                    "[lsp:{lang_for_stderr}] (previous line repeated {repeated} more times): {previous}"
                                );
                            }
                            repeated = 0;
                        }
                        eprintln!("[lsp:{lang_for_stderr}] {line}");
                        pending = Some(line);
                    }
                }
            }
        }
        // 流结束：处理残余（无换行结尾的最后一行）+ 折叠摘要。
        let tail = carry.trim_end_matches('\r');
        if !tail.is_empty() && !NOISE_MARKERS.iter().any(|marker| tail.contains(marker)) {
            if pending.as_deref() == Some(tail) {
                repeated += 1;
            } else {
                if repeated > 0 {
                    if let Some(previous) = pending.as_deref() {
                        eprintln!(
                            "[lsp:{lang_for_stderr}] (previous line repeated {repeated} more times): {previous}"
                        );
                    }
                    repeated = 0;
                }
                eprintln!("[lsp:{lang_for_stderr}] {tail}");
                pending = Some(tail.to_string());
            }
        }
        if repeated > 0 {
            if let Some(previous) = pending.as_deref() {
                eprintln!(
                    "[lsp:{lang_for_stderr}] (previous line repeated {repeated} more times): {previous}"
                );
            }
        }
    });

    let push_diagnostics: PushDiagnostics = Arc::new(Mutex::new(HashMap::new()));
    let push_clone = push_diagnostics.clone();

    let (mainloop, socket) = MainLoop::new_client(move |_socket| {
        let mut router = Router::new(());
        // 未注册的普通通知会终止 mainloop（Router 默认 Break）——必须覆盖
        // 常见通知：诊断收集 + showMessage/logMessage/telemetry 记日志。
        router.notification::<PublishDiagnostics>(move |_, params| {
            let uri = params.uri.clone();
            let entry = PushEntry {
                version: params.version,
                received_at: Instant::now(),
                diagnostics: params.diagnostics,
            };
            let store = push_clone.clone();
            tokio::spawn(async move {
                let mut guard = store.lock().await;
                let entries = guard.entry(uri_key(&uri)).or_default();
                if entries
                    .iter()
                    .any(|old| old.version == entry.version && old.received_at > entry.received_at)
                {
                    return;
                }
                entries.retain(|old| old.version != entry.version);
                entries.push(entry);
                entries.sort_by_key(|entry| entry.received_at);
                if entries.len() > 8 {
                    entries.remove(0);
                }
            });
            std::ops::ControlFlow::Continue(())
        });
        router.notification::<ShowMessage>(|_, params| {
            eprintln!("[lsp] showMessage: {:?}: {}", params.typ, params.message);
            std::ops::ControlFlow::Continue(())
        });
        router.notification::<LogMessage>(|_, params| {
            eprintln!("[lsp] logMessage: {:?}: {}", params.typ, params.message);
            std::ops::ControlFlow::Continue(())
        });
        router.notification::<TelemetryEvent>(|_, _| std::ops::ControlFlow::Continue(()));
        router.notification::<Progress>(|_, params: ProgressParams| {
            if let lsp_types::NumberOrString::String(token) = &params.token {
                eprintln!("[lsp] progress: {token}");
            }
            std::ops::ControlFlow::Continue(())
        });
        // rust-analyzer 等请求 workspace/configuration 获取服务器设置：
        // 返回空数组 = 使用服务器默认配置（未处理会报
        // "No such method workspace/configuration"，诊断等功能可能降级）。
        router.request::<WorkspaceConfiguration, _>(|_, _params| async move {
            Ok(Vec::<serde_json::Value>::new())
        });
        // workspaceFolders：root 已通过 initialize 的 workspaceFolders 提供。
        router.request::<WorkspaceFoldersRequest, _>(|_, _params| async move { Ok(None) });
        router
    });

    let main_loop_done = Arc::new(AtomicBool::new(false));
    let done_flag = main_loop_done.clone();
    let mainloop_task = tokio::spawn(async move {
        use futures::FutureExt;
        use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
        let run_fut = std::panic::AssertUnwindSafe(async {
            mainloop
                .run_buffered(stdout.compat(), stdin.compat_write())
                .await
        });
        match run_fut.catch_unwind().await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                eprintln!("[lsp:{lang_for_mainloop}] mainloop ended: {error}");
            }
            Err(panic_payload) => {
                let msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "panic occurred".to_string()
                };
                eprintln!("[lsp:{lang_for_mainloop}] mainloop safely recovered from panic: {msg}");
            }
        }
        // mainloop 结束 = 会话不可用（进程退出 / 管道断开）：置位供死亡检测。
        done_flag.store(true, Ordering::Release);
    });

    Ok((
        child,
        mainloop_task,
        socket,
        push_diagnostics,
        main_loop_done,
        process_tree_guard,
    ))
}

/// LSP initialize 握手（带超时）。
///
/// 返回完整服务器能力；调用方必须保留它用于真实能力校验。
pub async fn initialize(
    socket: &mut async_lsp::ServerSocket,
    project_root: &Path,
    initialization_options: Option<serde_json::Value>,
    timeout: Duration,
) -> Result<lsp_types::ServerCapabilities, LspError> {
    let workspace_uri = Url::from_file_path(project_root).map_err(|_| {
        LspError::Internal(format!("invalid project root: {}", project_root.display()))
    })?;
    #[allow(deprecated)]
    let params = InitializeParams {
        process_id: None,
        root_path: Some(project_root.to_string_lossy().into_owned()),
        root_uri: Some(workspace_uri.clone()),
        initialization_options,
        capabilities: ClientCapabilities {
            text_document: Some(TextDocumentClientCapabilities {
                document_symbol: Some(lsp_types::DocumentSymbolClientCapabilities {
                    hierarchical_document_symbol_support: Some(true),
                    ..Default::default()
                }),
                publish_diagnostics: Some(lsp_types::PublishDiagnosticsClientCapabilities {
                    version_support: Some(true),
                    ..Default::default()
                }),
                diagnostic: Some(lsp_types::DiagnosticClientCapabilities {
                    dynamic_registration: None,
                    related_document_support: Some(false),
                }),
                ..Default::default()
            }),
            ..Default::default()
        },
        workspace_folders: Some(vec![WorkspaceFolder {
            uri: workspace_uri,
            name: "root".to_string(),
        }]),
        ..Default::default()
    };
    let result = tokio::time::timeout(timeout, socket.initialize(params))
        .await
        .map_err(|_| LspError::RequestTimeout("initialize".into()))?
        .map_err(|error| LspError::ServerFailed(format!("initialize failed: {error:?}")))?;
    let pull_diagnostics_supported = result.capabilities.diagnostic_provider.is_some();
    eprintln!(
        "[lsp] server={:?} pull_diagnostics={pull_diagnostics_supported}",
        result.server_info.as_ref().map(|i| i.name.clone())
    );
    socket
        .initialized(InitializedParams {})
        .map_err(|error| LspError::ServerFailed(format!("initialized failed: {error:?}")))?;
    // VS Code 等客户端必备：通知服务器应用配置（空配置，使用服务器默认）。
    socket
        .did_change_configuration(lsp_types::DidChangeConfigurationParams {
            settings: serde_json::json!({}),
        })
        .map_err(|error| {
            LspError::ServerFailed(format!("didChangeConfiguration failed: {error:?}"))
        })?;
    Ok(result.capabilities)
}

/// 发送 didOpen（文件已确认未打开时）。
pub async fn did_open(
    socket: &mut async_lsp::ServerSocket,
    lang: &str,
    path: &Path,
    text: &str,
) -> Result<Url, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    socket
        .did_open(DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri: uri.clone(),
                language_id: match path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref()
                {
                    Some("js" | "mjs" | "cjs") if lang == "typescript" => "javascript".into(),
                    Some("jsx") if lang == "typescript" => "javascriptreact".into(),
                    Some("tsx") if lang == "typescript" => "typescriptreact".into(),
                    _ => language_id_for(lang),
                },
                version: 1,
                text: text.to_string(),
            },
        })
        .map_err(|error| LspError::ServerFailed(format!("didOpen failed: {error:?}")))?;
    Ok(uri)
}

/// 发送 didChange（version 递增，全量内容）——强制服务器重新诊断。
pub async fn did_change(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    version: i32,
    text: &str,
) -> Result<(), LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    socket
        .did_change(DidChangeTextDocumentParams {
            text_document: VersionedTextDocumentIdentifier { uri, version },
            content_changes: vec![TextDocumentContentChangeEvent {
                range: None,
                range_length: None,
                text: text.to_string(),
            }],
        })
        .map_err(|error| LspError::ServerFailed(format!("didChange failed: {error:?}")))
}

/// 发送 didSave（带全文）——触发 flycheck 类诊断（rust-analyzer 的 rustc/cargo
/// 诊断只在保存后运行，见 rust-lang/rust-analyzer#18709）。
pub async fn did_save(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    text: &str,
) -> Result<(), LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    socket
        .did_save(DidSaveTextDocumentParams {
            text_document: TextDocumentIdentifier { uri },
            text: Some(text.to_string()),
        })
        .map_err(|error| LspError::ServerFailed(format!("didSave failed: {error:?}")))
}

/// hover 请求。
pub async fn hover(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<Hover>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(
        timeout,
        socket.hover(HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri },
                position: Position {
                    line: line.saturating_sub(1),
                    character: column.saturating_sub(1),
                },
            },
            work_done_progress_params: WorkDoneProgressParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("hover".into()))?
    .map_err(|error| LspError::ServerFailed(format!("hover failed: {error:?}")))
}

/// pull 诊断（LSP 3.17 textDocument/diagnostic）。
///
/// 服务器不支持时返回 Ok(None)，调用方回退 push。
pub async fn pull_diagnostics(
    socket: &mut async_lsp::ServerSocket,
    uri: &Url,
    timeout: Duration,
) -> Result<Option<Vec<Diagnostic>>, LspError> {
    let result = tokio::time::timeout(
        timeout,
        socket.document_diagnostic(DocumentDiagnosticParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            identifier: None,
            previous_result_id: None,
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("diagnostics".into()))?;

    match result {
        Ok(report) => match report {
            lsp_types::DocumentDiagnosticReportResult::Report(report) => {
                if matches!(&report, DocumentDiagnosticReport::Unchanged(_)) {
                    return Err(LspError::Unsupported(
                        "unchanged diagnostic response without cached result".into(),
                    ));
                }
                Ok(Some(extract_diagnostic_items(report)))
            }
            lsp_types::DocumentDiagnosticReportResult::Partial(_) => Err(LspError::Unsupported(
                "partial diagnostic response without primary document report".into(),
            )),
        },
        Err(async_lsp::Error::Response(ref response_error))
            if response_error.code == ErrorCode::METHOD_NOT_FOUND =>
        {
            Ok(None)
        }
        Err(error) => Err(LspError::ServerFailed(format!(
            "diagnostics failed: {error:?}"
        ))),
    }
}

/// 固定URI和请求版本匹配；无版本报告仅作为未验证观察值交给上层标记partial。
pub async fn wait_push_diagnostics(
    store: &PushDiagnostics,
    uri: &Url,
    expected_version: i32,
    not_before: Instant,
    timeout: Duration,
) -> Result<PushEntry, LspError> {
    let key = uri_key(uri);
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        {
            let guard = store.lock().await;
            if let Some(entry) = guard
                .get(&key)
                .and_then(|entries| select_push_entry(entries, expected_version, not_before))
            {
                return Ok(entry);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(LspError::RequestTimeout(
                "publishDiagnostics (no report for requested document version)".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// workspace/diagnostic（LSP 3.17 pull）：一次请求返回整个项目的诊断。
///
/// 服务器不支持时返回 Ok(None)，调用方跳过该语言。
/// 返回 (uri, diagnostics) 列表，按服务器报告顺序。
pub async fn workspace_diagnostics(
    socket: &mut async_lsp::ServerSocket,
    timeout: Duration,
) -> Result<Option<Vec<(Url, Vec<Diagnostic>)>>, LspError> {
    let result = tokio::time::timeout(
        timeout,
        socket.workspace_diagnostic(lsp_types::WorkspaceDiagnosticParams {
            identifier: None,
            previous_result_ids: Vec::new(),
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("workspace-diagnostics".into()))?;

    match result {
        Ok(report) => {
            match report {
                lsp_types::WorkspaceDiagnosticReportResult::Report(report) => {
                    let mut files: Vec<(Url, Vec<Diagnostic>)> = Vec::new();
                    for item in report.items {
                        match item {
                            lsp_types::WorkspaceDocumentDiagnosticReport::Full(full) => {
                                let items = full.full_document_diagnostic_report.items;
                                files.push((full.uri, items));
                            }
                            lsp_types::WorkspaceDocumentDiagnosticReport::Unchanged(unchanged) => {
                                return Err(LspError::Unsupported(format!("unchanged workspace diagnostic report without cached result: {}", unchanged.uri)));
                            }
                        }
                    }
                    Ok(Some(files))
                }
                lsp_types::WorkspaceDiagnosticReportResult::Partial(_) => Err(
                    LspError::Unsupported("partial workspace diagnostic response".into()),
                ),
            }
        }
        Err(async_lsp::Error::Response(ref response_error))
            if response_error.code == ErrorCode::METHOD_NOT_FOUND =>
        {
            Ok(None)
        }
        Err(error) => Err(LspError::ServerFailed(format!(
            "workspace diagnostics failed: {error:?}"
        ))),
    }
}

/// 仅提取请求文档的诊断；related_documents的URI不能丢弃后归入主文件。
pub fn extract_diagnostic_items(report: DocumentDiagnosticReport) -> Vec<Diagnostic> {
    match report {
        DocumentDiagnosticReport::Full(report) => report.full_document_diagnostic_report.items,
        DocumentDiagnosticReport::Unchanged(_) => Vec::new(),
    }
}

/// goto definition 请求（跨文件语义跳转）。
pub async fn goto_definition(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<GotoDefinitionResponse>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(
        timeout,
        socket.definition(GotoDefinitionParams {
            text_document_position_params: text_document_position_params(uri, line, column),
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("definition".into()))?
    .map_err(|error| LspError::ServerFailed(format!("gotoDefinition failed: {error:?}")))
}

/// references 请求（全部引用位置，含/不含声明）。
pub async fn references(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    include_declaration: bool,
    timeout: Duration,
) -> Result<Vec<Location>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    let result = tokio::time::timeout(
        timeout,
        socket.references(ReferenceParams {
            text_document_position: text_document_position_params(uri, line, column),
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
            context: ReferenceContext {
                include_declaration,
            },
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("references".into()))?
    .map_err(|error| LspError::ServerFailed(format!("references failed: {error:?}")))?;
    Ok(result.unwrap_or_default())
}

/// documentSymbol 请求（文件符号大纲，树形）。
pub async fn document_symbols(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    timeout: Duration,
) -> Result<Option<DocumentSymbolResponse>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(
        timeout,
        socket.document_symbol(DocumentSymbolParams {
            text_document: TextDocumentIdentifier { uri },
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("documentSymbols".into()))?
    .map_err(|error| LspError::ServerFailed(format!("documentSymbol failed: {error:?}")))
}

/// 组装 TextDocumentPositionParams（line/column 1-indexed → 0-indexed）。
fn text_document_position_params(uri: Url, line: u32, column: u32) -> TextDocumentPositionParams {
    TextDocumentPositionParams {
        text_document: TextDocumentIdentifier { uri },
        position: Position {
            line: line.saturating_sub(1),
            character: column.saturating_sub(1),
        },
    }
}

/// rename 请求（语义级重命名，返回 WorkspaceEdit：多文件 edits）。
pub async fn rename(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    new_name: &str,
    timeout: Duration,
) -> Result<Option<WorkspaceEdit>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(
        timeout,
        socket.rename(RenameParams {
            text_document_position: text_document_position_params(uri, line, column),
            new_name: new_name.to_string(),
            work_done_progress_params: WorkDoneProgressParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("rename".into()))?
    .map_err(|error| LspError::ServerFailed(format!("rename failed: {error:?}")))
}

/// typeDefinition 请求（跳到符号「类型」的定义；参数类型是 GotoDefinitionParams 别名）。
pub async fn type_definition(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<GotoDefinitionResponse>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(
        timeout,
        socket.type_definition(GotoDefinitionParams {
            text_document_position_params: text_document_position_params(uri, line, column),
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("typeDefinition".into()))?
    .map_err(|error| LspError::ServerFailed(format!("typeDefinition failed: {error:?}")))
}

/// implementation 请求（接口/抽象类的实现跳转；参数类型是 GotoDefinitionParams 别名）。
pub async fn implementation(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<GotoDefinitionResponse>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(
        timeout,
        socket.implementation(GotoDefinitionParams {
            text_document_position_params: text_document_position_params(uri, line, column),
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("implementation".into()))?
    .map_err(|error| LspError::ServerFailed(format!("implementation failed: {error:?}")))
}

/// workspace/symbol 请求（跨文件按名搜索符号，语义级；无需 didOpen）。
pub async fn workspace_symbols(
    socket: &mut async_lsp::ServerSocket,
    query: &str,
    timeout: Duration,
) -> Result<Option<WorkspaceSymbolResponse>, LspError> {
    tokio::time::timeout(
        timeout,
        socket.symbol(WorkspaceSymbolParams {
            query: query.to_string(),
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("workspaceSymbols".into()))?
    .map_err(|error| LspError::ServerFailed(format!("workspace/symbol failed: {error:?}")))
}

/// prepareCallHierarchy 请求（LSP 3.16）：返回位置处的调用层级条目（函数/方法）。
pub async fn prepare_call_hierarchy(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<Vec<CallHierarchyItem>>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(
        timeout,
        socket.prepare_call_hierarchy(CallHierarchyPrepareParams {
            text_document_position_params: text_document_position_params(uri, line, column),
            work_done_progress_params: WorkDoneProgressParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("prepareCallHierarchy".into()))?
    .map_err(|error| LspError::ServerFailed(format!("prepareCallHierarchy failed: {error:?}")))
}

/// callHierarchy/incomingCalls 请求：谁调用了该条目（调用者 + 调用点位置）。
pub async fn call_hierarchy_incoming_calls(
    socket: &mut async_lsp::ServerSocket,
    item: CallHierarchyItem,
    timeout: Duration,
) -> Result<Option<Vec<CallHierarchyIncomingCall>>, LspError> {
    tokio::time::timeout(
        timeout,
        socket.incoming_calls(CallHierarchyIncomingCallsParams {
            item,
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("callHierarchy/incomingCalls".into()))?
    .map_err(|error| {
        LspError::ServerFailed(format!("callHierarchy/incomingCalls failed: {error:?}"))
    })
}

/// callHierarchy/outgoingCalls 请求：该条目调用了谁（被调者 + 调用点位置）。
pub async fn call_hierarchy_outgoing_calls(
    socket: &mut async_lsp::ServerSocket,
    item: CallHierarchyItem,
    timeout: Duration,
) -> Result<Option<Vec<CallHierarchyOutgoingCall>>, LspError> {
    tokio::time::timeout(
        timeout,
        socket.outgoing_calls(CallHierarchyOutgoingCallsParams {
            item,
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("callHierarchy/outgoingCalls".into()))?
    .map_err(|error| {
        LspError::ServerFailed(format!("callHierarchy/outgoingCalls failed: {error:?}"))
    })
}

/// prepareTypeHierarchy 请求（LSP 3.17）：返回位置处的类型层级条目（类/接口/trait）。
pub async fn prepare_type_hierarchy(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<Vec<TypeHierarchyItem>>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(
        timeout,
        socket.prepare_type_hierarchy(TypeHierarchyPrepareParams {
            text_document_position_params: text_document_position_params(uri, line, column),
            work_done_progress_params: WorkDoneProgressParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("prepareTypeHierarchy".into()))?
    .map_err(|error| LspError::ServerFailed(format!("prepareTypeHierarchy failed: {error:?}")))
}

/// typeHierarchy/supertypes 请求：条目的父类型链（基类/父接口）。
pub async fn type_hierarchy_supertypes(
    socket: &mut async_lsp::ServerSocket,
    item: TypeHierarchyItem,
    timeout: Duration,
) -> Result<Option<Vec<TypeHierarchyItem>>, LspError> {
    tokio::time::timeout(
        timeout,
        socket.supertypes(TypeHierarchySupertypesParams {
            item,
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("typeHierarchy/supertypes".into()))?
    .map_err(|error| LspError::ServerFailed(format!("typeHierarchy/supertypes failed: {error:?}")))
}

/// typeHierarchy/subtypes 请求：条目的所有子类型（子类/实现）。
pub async fn type_hierarchy_subtypes(
    socket: &mut async_lsp::ServerSocket,
    item: TypeHierarchyItem,
    timeout: Duration,
) -> Result<Option<Vec<TypeHierarchyItem>>, LspError> {
    tokio::time::timeout(
        timeout,
        socket.subtypes(TypeHierarchySubtypesParams {
            item,
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("typeHierarchy/subtypes".into()))?
    .map_err(|error| LspError::ServerFailed(format!("typeHierarchy/subtypes failed: {error:?}")))
}

#[cfg(test)]
mod diagnostic_version_tests {
    use super::*;
    #[test]
    fn late_old_version_cannot_match_new_request() {
        let at = Instant::now();
        let entries = vec![PushEntry {
            version: Some(4),
            received_at: at,
            diagnostics: vec![],
        }];
        assert!(select_push_entry(&entries, 5, at).is_none());
        assert_eq!(select_push_entry(&entries, 4, at).unwrap().version, Some(4));
    }
    #[test]
    fn unversioned_is_never_promoted_to_expected_version() {
        let at = Instant::now();
        let entries = vec![PushEntry {
            version: None,
            received_at: at,
            diagnostics: vec![],
        }];
        assert_eq!(select_push_entry(&entries, 8, at).unwrap().version, None);
    }
    #[test]
    fn independent_document_versions_do_not_invalidate_each_other() {
        let at = Instant::now();
        let first = vec![PushEntry {
            version: Some(3),
            received_at: at,
            diagnostics: vec![],
        }];
        let second = vec![PushEntry {
            version: Some(20),
            received_at: at,
            diagnostics: vec![],
        }];
        let store = HashMap::from([("a", first), ("b", second)]);
        assert!(select_push_entry(&store["a"], 3, at).is_some());
        assert!(select_push_entry(&store["b"], 20, at).is_some());
    }
    #[test]
    fn related_documents_are_not_misattributed() {
        let diagnostic = |message: &str| serde_json::json!({"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"message":message});
        let report: DocumentDiagnosticReport = serde_json::from_value(serde_json::json!({
            "kind":"full","items":[diagnostic("primary")],
            "relatedDocuments":{"file:///related.rs":{"kind":"full","items":[diagnostic("related")]}}
        })).unwrap();
        let items = extract_diagnostic_items(report);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].message, "primary");
    }
}
