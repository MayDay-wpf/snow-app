//! 常驻 PowerShell 会话：把「每条命令新建一个 shell 进程」的冷启动开销摊薄成一次。
//!
//! 背景（2026-09-26 实测）：本机 pwsh 7 冷启动 ≈ 360ms、Windows PowerShell ≈ 220ms，
//! 而在构建/IO 高压时段，新建进程自身可被拖到 15–20s —— 工具历史里出现过
//! 「非递归 Get-ChildItem 16.9s 超时且零输出」的偶发卡顿，阶段分解显示编排侧
//! （敏感检查/远端解析/spawn）都在 10ms 内，时间全花在子进程产出首字节之前。
//! 复用常驻会话后单条命令实测 4–8ms。
//!
//! 协议（与一次性 `pwsh -NoProfile -Command "<文本>"` 路径逐项对拍，19 个用例中
//! 18 个输出与退出码完全一致；唯一差异是命令中途 `return` 时退出码为 1 而非 0）：
//!
//! ```text
//! 下发（三行一次性写入会话 stdin）:
//!   [Console]::OutputEncoding = UTF8; <SNOW_* 环境变量>; $global:__snow_ok = $false;
//!   Set-Location -LiteralPath '<cwd>' -ErrorAction Stop;
//!   & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('<b64>'))))
//!   if ($global:__snow_ok) { $__snow_ec = 0 } else { $__snow_ec = 1 }
//!   [Console]::Out.WriteLine("<token>" + $__snow_ec)
//! ```
//!
//! - 命令文本必须 base64 单行包装：stdin 是逐行解析的，多行语句（if 块、here-string）
//!   直接写入会让会话停止响应；base64 同时消除引号/中文/`$` 的转义问题。
//! - 命令在脚本块子作用域内执行：变量与函数不残留；cwd 每次由 Set-Location 重置；
//!   进程级环境变量按终端语义保留。
//! - 退出码对齐 `-Command`（末尾语句失败 → 1，`exit N` 由进程退出码给出 N）：脚本文本
//!   尾部追加 `$global:__snow_ok = $?` 在块内捕获；块外读 `$?` 拿到的是调用本身的成功
//!   状态（恒为 True），不可用。
//! - 哨兵 token 每条命令随机生成；stdout 尾部保留 SENTINEL_HOLDBACK_BYTES 字节不外发，
//!   避免 token 与退出码泄漏到流式输出与最终 stdout。
//! - 同一会话同一时刻只服务一条命令；并发命令各自新建会话，结束后只回池一个。
//! - 会话带 `-NonInteractive`：Read-Host 等提示类 cmdlet 立即报错，不会吞掉协议字节；
//!   需要 stdin 输入的交互式命令必须走 isInteractive 的一次性进程路径。
//! - 空闲 SESSION_IDLE_TIMEOUT 后由回收任务杀掉；应用退出时 stdin 管道关闭，会话读到
//!   EOF 自行退出，无需额外清理钩子。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::stream_io::{
    emit_complete_utf8_chunks, emit_stream_chunk, kill_process_tree, BoundedCapture,
    CapturedOutput, STREAM_EMIT_LIMIT,
};
use super::BashStreamCallback;

/// 会话闲置多久后被回收（与 LSP 会话的懒回收约定一致，不阻塞任何调用路径）。
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(900);
const REAPER_INTERVAL: Duration = Duration::from_secs(60);
/// stdout 尾部保留窗口：未命中哨兵 token 时保留这么多字节不外发。
const SENTINEL_HOLDBACK_BYTES: usize = 48;
/// 命令执行期间 `try_wait` 的轮询间隔（对齐 utils::process::poll_child_exit 的语义：
/// 会话被命令自身杀掉（`exit N` / 崩溃）时及时收尾，不依赖管道 EOF）。
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

pub(crate) struct SessionCommand<'a> {
    pub(crate) shell: &'a str,
    pub(crate) working_directory: &'a str,
    pub(crate) command: &'a str,
    pub(crate) env_prelude: &'a str,
    pub(crate) login_path: Option<&'a str>,
    pub(crate) on_chunk: Arc<BashStreamCallback>,
    pub(crate) cancel_token: &'a CancellationToken,
    pub(crate) tool_execution_id: &'a str,
    pub(crate) timeout: Duration,
}

pub(crate) enum SessionStatus {
    Completed {
        exit_code: i32,
        /// 进程被信号/系统异常终止时的名称（正常退出为 None）。
        signal: Option<String>,
    },
    /// 执行期限到达；`watchdog` 为 true 表示渲染层倒计时触发的中止。
    TimedOut { watchdog: bool },
    Cancelled { reason: String },
    Failed { error: String },
    SpawnFailed { error: String },
}

pub(crate) struct SessionOutcome {
    pub(crate) status: SessionStatus,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) first_output_ms: Option<u64>,
    /// 会话取用/新建耗时（含命令下发）。
    pub(crate) session_ms: u64,
    /// 新建会话进程的耗时；复用现有会话时为 0。
    pub(crate) spawn_ms: u64,
    pub(crate) wait_ms: u64,
    /// 会话被强杀（超时/取消/写入失败）时为 false，表示输出可能不完整。
    pub(crate) output_complete: bool,
    /// 超出捕获上限被省略的字节数（stdout + stderr）。
    pub(crate) truncated_bytes: u64,
}

pub(crate) async fn execute(cmd: SessionCommand<'_>) -> SessionOutcome {
    let acquire_started = Instant::now();
    let mut spawn_ms = 0_u64;
    let mut session = match take_session(cmd.shell).await {
        Some(session) => session,
        None => {
            let spawn_started = Instant::now();
            match spawn_session(cmd.shell, cmd.working_directory, cmd.login_path).await {
                Ok(session) => {
                    spawn_ms = spawn_started.elapsed().as_millis() as u64;
                    session
                }
                Err(error) => {
                    return SessionOutcome {
                        status: SessionStatus::SpawnFailed { error },
                        stdout: String::new(),
                        stderr: String::new(),
                        first_output_ms: None,
                        session_ms: acquire_started.elapsed().as_millis() as u64,
                        spawn_ms,
                        wait_ms: 0,
                        output_complete: true,
                        truncated_bytes: 0,
                    };
                }
            }
        }
    };
    let session_ms = acquire_started.elapsed().as_millis() as u64;

    let token = format!("__snow_end_{}__", uuid::Uuid::new_v4().simple());
    let script = format!("{}\n\n$global:__snow_ok = $?", cmd.command);
    let encoded = base64::engine::general_purpose::STANDARD.encode(script.as_bytes());
    let env_prefix = if cmd.env_prelude.is_empty() {
        String::new()
    } else {
        format!("{}; ", cmd.env_prelude)
    };
    let payload = format!(
        concat!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {env_prefix}",
            "$global:__snow_ok = $false; Set-Location -LiteralPath '{cwd}' -ErrorAction Stop; ",
            "& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString(",
            "[Convert]::FromBase64String('{encoded}'))))\n",
            "if ($global:__snow_ok) {{ $__snow_ec = 0 }} else {{ $__snow_ec = 1 }}\n",
            "[Console]::Out.WriteLine(\"{token}\" + $__snow_ec)\n",
        ),
        env_prefix = env_prefix,
        cwd = escape_single_quoted(cmd.working_directory),
        encoded = encoded,
        token = token,
    );

    let dispatch_started = Instant::now();
    let deadline = tokio::time::Instant::from_std(dispatch_started + cmd.timeout);
    session
        .io
        .lock_state()
        .begin_command(&token, Arc::clone(&cmd.on_chunk), dispatch_started);

    // 命令下发必须与截止期限、取消令牌同场竞速：会话若不再消费 stdin（管道写满、
    // pwsh 卡在上一条命令里），write_all 会一直挂起——此时还没进入下面的等待循环，
    // deadline 与 abort 都无人监听，命令会永远停在「执行中」。写入阶段的中止/失败
    // 与等待循环一样收口：杀掉会话、保留已产出的输出，并给出 timed_out / cancelled /
    // failed 状态。
    let mut write_abort: Option<SessionStatus> = None;
    tokio::select! {
        biased;
        _ = cmd.cancel_token.cancelled() => {
            write_abort = Some(cancel_status(cmd.tool_execution_id));
        }
        _ = tokio::time::sleep_until(deadline) => {
            write_abort = Some(SessionStatus::TimedOut { watchdog: false });
        }
        result = session.stdin.write_all(payload.as_bytes()) => {
            if let Err(error) = result {
                write_abort = Some(SessionStatus::Failed {
                    error: format!("Failed to write to the terminal session: {error}"),
                });
            }
        }
    }
    if let Some(status) = write_abort {
        let (stdout, stderr, first_output_ms, truncated_bytes) = session.take_output();
        session.kill().await;
        return SessionOutcome {
            status,
            stdout,
            stderr,
            first_output_ms,
            session_ms,
            spawn_ms,
            wait_ms: dispatch_started.elapsed().as_millis() as u64,
            output_complete: false,
            truncated_bytes,
        };
    }

    let status = loop {
        if let Some(exit_code) = session.io.lock_state().command_exit_code() {
            break SessionStatus::Completed {
                exit_code,
                signal: None,
            };
        }
        match session.child.try_wait() {
            // 命令里显式 `exit N`（或会话被命令杀掉）：沿用进程退出码，与一次性路径一致。
            Ok(Some(exit_status)) => {
                break SessionStatus::Completed {
                    exit_code: exit_status.code().unwrap_or(1),
                    signal: super::diagnostics::exit_signal(&exit_status),
                };
            }
            Ok(None) => {}
            Err(error) => {
                break SessionStatus::Failed {
                    error: format!("Failed to wait for process: {error}"),
                };
            }
        }
        tokio::select! {
            biased;
            _ = cmd.cancel_token.cancelled() => {
                break cancel_status(cmd.tool_execution_id);
            }
            _ = tokio::time::sleep_until(deadline) => {
                break SessionStatus::TimedOut { watchdog: false };
            }
            _ = session.io.notify.notified() => {}
            _ = tokio::time::sleep(EXIT_POLL_INTERVAL) => {}
        }
    };
    let wait_ms = dispatch_started.elapsed().as_millis() as u64;

    let output_complete = matches!(&status, SessionStatus::Completed { .. });
    if !output_complete {
        session.kill().await;
    }
    let (stdout, stderr, first_output_ms, truncated_bytes) = session.take_output();
    if output_complete {
        return_session(cmd.shell, session).await;
    }

    SessionOutcome {
        status,
        stdout,
        stderr,
        first_output_ms,
        session_ms,
        spawn_ms,
        wait_ms,
        output_complete,
        truncated_bytes,
    }
}

fn escape_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

/// 取消令牌触发的中止状态：渲染层倒计时（reason=timeout）与显式终止共用同一个
/// 令牌，差别只在注册时记录的原因；没有记录原因时按用户终止处理。
fn cancel_status(tool_execution_id: &str) -> SessionStatus {
    let reason = crate::api::cancel::take_tool_cancel_reason(tool_execution_id)
        .unwrap_or_else(|| "user".to_string());
    if reason == "timeout" {
        SessionStatus::TimedOut { watchdog: true }
    } else {
        SessionStatus::Cancelled { reason }
    }
}

fn sessions() -> &'static tokio::sync::Mutex<HashMap<String, LiveSession>> {
    static SESSIONS: OnceLock<tokio::sync::Mutex<HashMap<String, LiveSession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn ensure_reaper() {
    static REAPER: OnceLock<()> = OnceLock::new();
    REAPER.get_or_init(|| {
        tokio::spawn(reap_idle_sessions());
    });
}

async fn take_session(shell: &str) -> Option<LiveSession> {
    ensure_reaper();
    let mut session = { sessions().lock().await.remove(shell) }?;
    if session.is_alive() {
        return Some(session);
    }
    session.kill().await;
    None
}

async fn return_session(shell: &str, mut session: LiveSession) {
    if !session.is_alive() {
        session.kill().await;
        return;
    }
    session.last_used = Instant::now();
    let replaced = { sessions().lock().await.insert(shell.to_string(), session) };
    if let Some(mut replaced) = replaced {
        replaced.kill().await;
    }
}

async fn reap_idle_sessions() {
    loop {
        tokio::time::sleep(REAPER_INTERVAL).await;
        let mut expired: Vec<LiveSession> = Vec::new();
        {
            let mut sessions = sessions().lock().await;
            let stale: Vec<String> = sessions
                .iter()
                .filter(|(_, session)| session.last_used.elapsed() >= SESSION_IDLE_TIMEOUT)
                .map(|(shell, _)| shell.clone())
                .collect();
            for shell in stale {
                if let Some(session) = sessions.remove(&shell) {
                    expired.push(session);
                }
            }
            let mut dead: Vec<String> = Vec::new();
            for (shell, session) in sessions.iter_mut() {
                if !session.is_alive() {
                    dead.push(shell.clone());
                }
            }
            for shell in dead {
                if let Some(session) = sessions.remove(&shell) {
                    expired.push(session);
                }
            }
        }
        for mut session in expired {
            session.kill().await;
        }
    }
}

async fn spawn_session(
    shell: &str,
    working_directory: &str,
    login_path: Option<&str>,
) -> Result<LiveSession, String> {
    use std::process::Stdio;

    let mut process = crate::utils::process::cmd_async(shell);
    process
        .args(["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        .env_remove("NODE_ENV")
        .current_dir(working_directory);
    #[cfg(not(target_os = "windows"))]
    {
        // 独立进程组：kill_process_tree 用 kill(-pid) 才能连带子进程。
        process.process_group(0);
    }
    if let Some(path) = login_path {
        process.env("PATH", path);
    }

    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "terminal session is missing its stdin pipe".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "terminal session is missing its stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "terminal session is missing its stderr pipe".to_string())?;

    let io = Arc::new(SessionIo::default());
    let stdout_reader = tokio::spawn(pump_stdout(stdout, Arc::clone(&io)));
    let stderr_reader = tokio::spawn(pump_stderr(stderr, Arc::clone(&io)));
    #[cfg(target_os = "windows")]
    let process_tree = child
        .id()
        .map(|pid| crate::utils::process_tree::ProcessTreeGuard::new("bash-session", pid));
    #[cfg(not(target_os = "windows"))]
    let process_tree = None;
    Ok(LiveSession {
        child,
        stdin,
        io,
        stdout_reader,
        stderr_reader,
        last_used: Instant::now(),
        _process_tree: process_tree,
    })
}

struct LiveSession {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    io: Arc<SessionIo>,
    stdout_reader: tokio::task::JoinHandle<()>,
    stderr_reader: tokio::task::JoinHandle<()>,
    last_used: Instant,
    /// Windows：Job Object（KILL_ON_JOB_CLOSE），宿主崩溃时连带杀掉常驻 shell 树。
    _process_tree: Option<crate::utils::process_tree::ProcessTreeGuard>,
}

impl LiveSession {
    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    async fn kill(&mut self) {
        kill_process_tree(&mut self.child).await;
        self.stdout_reader.abort();
        self.stderr_reader.abort();
    }

    fn take_output(&self) -> (String, String, Option<u64>, u64) {
        let mut state = self.io.lock_state();
        let (first_output_ms, token) = state
            .command
            .as_ref()
            .map(|command| (command.first_output_ms, command.token.clone()))
            .unwrap_or((None, Vec::new()));
        let mut stdout: CapturedOutput = state.stdout.capture.finish();
        if !token.is_empty() {
            // 捕获区是「头部 + 省略标记 + 尾部」，哨兵始终落在保留范围内。
            if let Some(index) = find_subslice(stdout.text.as_bytes(), &token) {
                stdout.text.truncate(index);
            }
        }
        let stderr = state.stderr.capture.finish();
        let truncated = stdout.omitted.saturating_add(stderr.omitted);
        state.reset();
        (stdout.text, stderr.text, first_output_ms, truncated)
    }
}

#[derive(Default)]
struct SessionIo {
    state: Mutex<IoState>,
    notify: Notify,
}

impl SessionIo {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, IoState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

struct ActiveCommand {
    token: Vec<u8>,
    exit_code: Option<i32>,
    first_output_ms: Option<u64>,
    dispatched_at: Instant,
    on_chunk: Arc<BashStreamCallback>,
}

/// 单条流的捕获状态：有界正文 + 增量哨兵窗口 + 流式待发送窗口。
#[derive(Default)]
struct StreamState {
    capture: BoundedCapture,
    probe: Vec<u8>,
    visible: Vec<u8>,
    emitted: usize,
    emit_stopped: bool,
    token_seen: bool,
    post_token: Vec<u8>,
}

#[derive(Default)]
struct IoState {
    stdout: StreamState,
    stderr: StreamState,
    command: Option<ActiveCommand>,
}

impl IoState {
    fn begin_command(
        &mut self,
        token: &str,
        on_chunk: Arc<BashStreamCallback>,
        dispatched_at: Instant,
    ) {
        self.reset();
        self.command = Some(ActiveCommand {
            token: token.as_bytes().to_vec(),
            exit_code: None,
            first_output_ms: None,
            dispatched_at,
            on_chunk,
        });
    }

    fn command_exit_code(&self) -> Option<i32> {
        self.command.as_ref().and_then(|command| command.exit_code)
    }

    fn active_callback(&self) -> Option<Arc<BashStreamCallback>> {
        self.command.as_ref().map(|command| Arc::clone(&command.on_chunk))
    }

    fn reset(&mut self) {
        self.stdout = StreamState::default();
        self.stderr = StreamState::default();
        self.command = None;
    }

    fn record_first_output(&mut self) {
        if let Some(command) = self.command.as_mut() {
            if command.first_output_ms.is_none() {
                command.first_output_ms = Some(command.dispatched_at.elapsed().as_millis() as u64);
            }
        }
    }
}

async fn pump_stdout(mut reader: tokio::process::ChildStdout, io: Arc<SessionIo>) {
    let mut buffer = vec![0_u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                {
                    let mut state = io.lock_state();
                    feed_stdout(&mut state, &buffer[..read]);
                }
                io.notify.notify_one();
            }
        }
    }
    // EOF：唤醒等待者去检查会话进程是否已退出。
    io.notify.notify_one();
}

async fn pump_stderr(mut reader: tokio::process::ChildStderr, io: Arc<SessionIo>) {
    let mut buffer = vec![0_u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                {
                    let mut state = io.lock_state();
                    feed_stderr(&mut state, &buffer[..read]);
                }
                io.notify.notify_one();
            }
        }
    }
    io.notify.notify_one();
}

fn feed_stdout(state: &mut IoState, chunk: &[u8]) {
    if state.command.is_none() {
        // 空闲期写入（上一条命令遗留的后台子进程）：丢弃，不污染下一条命令。
        state.reset();
        return;
    }
    state.record_first_output();
    state.stdout.capture.push(chunk);

    let Some(callback) = state.active_callback() else {
        return;
    };
    let Some(token) = state.command.as_ref().map(|command| command.token.clone()) else {
        return;
    };

    // 哨兵只在滑动窗口里找：旧实现每个 chunk 重扫整个输出，是 O(n^2)。
    let mut token_offset_in_chunk: Option<usize> = None;
    if !state.stdout.token_seen {
        let probe_len_before = state.stdout.probe.len();
        state.stdout.probe.extend_from_slice(chunk);
        if let Some(index) = find_subslice(&state.stdout.probe, &token) {
            state.stdout.token_seen = true;
            // None 表示 token 起始于上一个 chunk（跨窗口），本次 chunk 全是协议内容。
            token_offset_in_chunk = if index >= probe_len_before {
                Some(index - probe_len_before)
            } else {
                None
            };
            let rest = index + token.len();
            state
                .stdout
                .post_token
                .extend_from_slice(&state.stdout.probe[rest..]);
            state.stdout.probe.clear();
        } else {
            let keep = token.len().saturating_sub(1);
            if state.stdout.probe.len() > keep {
                let drop = state.stdout.probe.len() - keep;
                state.stdout.probe.drain(..drop);
            }
        }
    } else if state.stdout.post_token.len() < 32 {
        let room = 32 - state.stdout.post_token.len();
        state
            .stdout
            .post_token
            .extend_from_slice(&chunk[..chunk.len().min(room)]);
    }

    if state.stdout.token_seen {
        if let Some(exit_code) = parse_exit_code(&state.stdout.post_token) {
            if let Some(command) = state.command.as_mut() {
                command.exit_code = Some(exit_code);
            }
        }
    }

    // 流式转发：命中哨兵后剩余字节都是协议行，只发出 token 之前的可见内容。
    if state.stdout.emit_stopped {
        return;
    }
    if state.stdout.token_seen {
        state.stdout.emit_stopped = true;
        match token_offset_in_chunk {
            Some(offset) => {
                state.stdout.visible.extend_from_slice(&chunk[..offset]);
                let mut piece: Vec<u8> = state.stdout.visible.drain(..).collect();
                emit_complete_utf8_chunks(&callback, "stdout", &mut piece);
            }
            // token 跨 chunk 起始：可见窗口里只剩 token 前缀，直接丢弃。
            None => state.stdout.visible.clear(),
        }
        return;
    }
    state.stdout.visible.extend_from_slice(chunk);
    let emit_len = state
        .stdout
        .visible
        .len()
        .saturating_sub(SENTINEL_HOLDBACK_BYTES);
    if emit_len == 0 {
        return;
    }
    let mut piece: Vec<u8> = state.stdout.visible.drain(..emit_len).collect();
    emit_complete_utf8_chunks(&callback, "stdout", &mut piece);
    if !piece.is_empty() {
        // 不完整的 UTF-8 尾部放回队首，等下一个 chunk 补全。
        state.stdout.visible.splice(0..0, piece);
    }
    state.stdout.emitted = state.stdout.emitted.saturating_add(emit_len);
    if state.stdout.emitted >= STREAM_EMIT_LIMIT {
        state.stdout.emit_stopped = true;
        state.stdout.visible.clear();
        emit_stream_chunk(
            &callback,
            "stdout",
            format!(
                "\n… [stream output truncated after {} bytes; the final result keeps the captured head and tail] …\n",
                state.stdout.emitted
            ),
        );
    }
}

fn feed_stderr(state: &mut IoState, chunk: &[u8]) {
    if state.command.is_none() {
        state.reset();
        return;
    }
    state.record_first_output();
    state.stderr.capture.push(chunk);
    let Some(callback) = state.active_callback() else {
        return;
    };
    if state.stderr.emit_stopped {
        return;
    }
    state.stderr.visible.extend_from_slice(chunk);
    let emit_len = state.stderr.visible.len();
    if emit_len == 0 {
        return;
    }
    let mut piece: Vec<u8> = state.stderr.visible.drain(..emit_len).collect();
    emit_complete_utf8_chunks(&callback, "stderr", &mut piece);
    if !piece.is_empty() {
        state.stderr.visible.splice(0..0, piece);
    }
    state.stderr.emitted = state.stderr.emitted.saturating_add(emit_len);
    if state.stderr.emitted >= STREAM_EMIT_LIMIT {
        state.stderr.emit_stopped = true;
        state.stderr.visible.clear();
        emit_stream_chunk(
            &callback,
            "stderr",
            format!(
                "\n… [stream output truncated after {} bytes; the final result keeps the captured head and tail] …\n",
                state.stderr.emitted
            ),
        );
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// 解析哨兵后的退出码；数字尚未完整到达（等换行/后续字节）时返回 None。
fn parse_exit_code(bytes: &[u8]) -> Option<i32> {
    let mut value = 0_i32;
    let mut digits = 0_usize;
    let mut index = 0_usize;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        value = value
            .saturating_mul(10)
            .saturating_add((bytes[index] - b'0') as i32);
        digits += 1;
        index += 1;
    }
    if digits == 0 || index >= bytes.len() {
        return None;
    }
    Some(value)
}
