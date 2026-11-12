use super::*;

use std::sync::{Arc, OnceLock};
use std::time::Instant;

use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use regex::Regex;
use tokio::io::{AsyncRead, AsyncReadExt};

// 进程回收（等待退出 / 杀整棵进程树）的规范实现收敛在 utils::process，
// 这里再导出，供 bash 工具与其它长任务（git clone 等）共用同一套语义。
pub(crate) use crate::utils::process::{kill_process_tree, poll_child_exit};

/// 单条流保留的头部字节上限。工具结果另有 token 上限，头部足够覆盖；
/// 超出后只滚动保留尾部，避免几十 GB 的命令输出把主进程内存吃满。
pub(crate) const STREAM_HEAD_LIMIT: usize = 4 * 1024 * 1024;
/// 头部写满后滚动保留的尾部字节数（错误信息通常出现在末尾）。
pub(crate) const STREAM_TAIL_LIMIT: usize = 512 * 1024;
/// 流式转发给前端的单条流上限；超出后停止转发，最终结果仍保留首尾。
pub(crate) const STREAM_EMIT_LIMIT: usize = 2 * 1024 * 1024;

/// 有界输出捕获：头部 + 尾部窗口 + 被省略的字节数。
#[derive(Default)]
pub(crate) struct BoundedCapture {
    head: Vec<u8>,
    tail: Vec<u8>,
    omitted: u64,
}

pub(crate) struct CapturedOutput {
    pub(crate) text: String,
    pub(crate) omitted: u64,
}

impl BoundedCapture {
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        let space = STREAM_HEAD_LIMIT.saturating_sub(self.head.len());
        let take = space.min(chunk.len());
        if take > 0 {
            self.head.extend_from_slice(&chunk[..take]);
        }
        if take < chunk.len() {
            self.tail.extend_from_slice(&chunk[take..]);
            if self.tail.len() > STREAM_TAIL_LIMIT {
                let drop = self.tail.len() - STREAM_TAIL_LIMIT;
                self.tail.drain(..drop);
                self.omitted += drop as u64;
            }
        }
    }

    pub(crate) fn finish(&self) -> CapturedOutput {
        let mut bytes = Vec::with_capacity(self.head.len() + self.tail.len() + 64);
        bytes.extend_from_slice(&self.head);
        if self.omitted > 0 {
            bytes.extend_from_slice(
                format!("\n… [output truncated: {} bytes omitted] …\n", self.omitted).as_bytes(),
            );
        }
        bytes.extend_from_slice(&self.tail);
        CapturedOutput {
            text: strip_ansi_codes(&String::from_utf8_lossy(&bytes)),
            omitted: self.omitted,
        }
    }
}

pub(crate) async fn read_stream<R>(
    mut reader: R,
    stream: &'static str,
    on_chunk: Arc<BashStreamCallback>,
    first_output_ms: Arc<OnceLock<u64>>,
    execution_started: Instant,
    accumulated: Arc<std::sync::Mutex<BoundedCapture>>,
) -> CapturedOutput
where
    R: AsyncRead + Unpin,
{
    let mut capture = BoundedCapture::default();
    let mut buffer = [0_u8; 4096];
    let mut pending_utf8 = Vec::new();
    let mut emitted = 0usize;
    let mut emit_stopped = false;

    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };

        let _ = first_output_ms.set(execution_started.elapsed().as_millis() as u64);
        let chunk = &buffer[..read];
        capture.push(chunk);
        // Mirror the bytes into the shared buffer so a partial output
        // survives even if this reader task is aborted before EOF.
        if let Ok(mut guard) = accumulated.lock() {
            guard.push(chunk);
        }

        if emit_stopped {
            continue;
        }
        pending_utf8.extend_from_slice(chunk);
        emit_complete_utf8_chunks(&on_chunk, stream, &mut pending_utf8);
        emitted = emitted.saturating_add(read);
        if emitted >= STREAM_EMIT_LIMIT {
            emit_stopped = true;
            pending_utf8.clear();
            emit_stream_chunk(
                &on_chunk,
                stream,
                format!(
                    "\n… [stream output truncated after {emitted} bytes; the final result keeps the captured head and tail] …\n"
                ),
            );
        }
    }

    if !emit_stopped && !pending_utf8.is_empty() {
        emit_stream_chunk(
            &on_chunk,
            stream,
            String::from_utf8_lossy(&pending_utf8).into_owned(),
        );
    }

    capture.finish()
}

/// Finalize whatever bytes a reader captured so far (used when the reader
/// task had to be aborted before reaching EOF, e.g. a surviving grandchild
/// keeps the pipe open after the process-tree kill).
pub(crate) fn finalize_accumulated_output(
    accumulated: &std::sync::Mutex<BoundedCapture>,
) -> CapturedOutput {
    let Ok(guard) = accumulated.lock() else {
        return CapturedOutput {
            text: String::new(),
            omitted: 0,
        };
    };
    guard.finish()
}

pub(crate) fn emit_complete_utf8_chunks(on_chunk: &BashStreamCallback, stream: &str, pending: &mut Vec<u8>) {
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                emit_stream_chunk(on_chunk, stream, text.to_string());
                pending.clear();
                return;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                if valid_up_to > 0 {
                    let text = String::from_utf8_lossy(&pending[..valid_up_to]).into_owned();
                    emit_stream_chunk(on_chunk, stream, text);
                    pending.drain(..valid_up_to);
                    continue;
                }

                if error.error_len().is_none() {
                    return;
                }

                let invalid_len = error.error_len().unwrap_or(1);
                let invalid = String::from_utf8_lossy(&pending[..invalid_len]).into_owned();
                emit_stream_chunk(on_chunk, stream, invalid);
                pending.drain(..invalid_len);
            }
        }
    }
}

pub(crate) fn emit_stream_chunk(on_chunk: &BashStreamCallback, stream: &str, data: String) {
    if data.is_empty() {
        return;
    }

    let cleaned = strip_ansi_codes(&data);
    if cleaned.is_empty() {
        return;
    }

    on_chunk.call(
        BashStreamChunk {
            stream: stream.to_string(),
            data: cleaned,
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
}

/// Strip ANSI escape sequences (CSI/SGR color codes, cursor movement,
/// OSC hyperlinks, etc.) from terminal output. These codes are emitted
/// by tools like `vite build` / `npm run build` when they detect a TTY
/// and would otherwise leak as raw `\x1b[...m` bytes into the model
/// context and the UI.
pub(crate) fn strip_ansi_codes(input: &str) -> String {
    static ANSI_RE: OnceLock<Regex> = OnceLock::new();
    let re = ANSI_RE.get_or_init(|| {
        // CSI sequences: ESC [ ... final byte in 0x40..=0x7E
        // OSC sequences: ESC ] ... BEL  or  ESC ] ... ESC \  (ST)
        // Other two-byte escapes (ESC + single char) that some tools emit.
        Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9AB]")
            .expect("invalid ANSI strip regex")
    });
    re.replace_all(input, "").into_owned()
}
