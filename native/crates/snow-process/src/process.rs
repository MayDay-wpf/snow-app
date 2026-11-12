//! 统一的子进程创建与回收工具。
//!
//! Windows 下 GUI 宿主（Electron 主进程）spawn 控制台程序（reg.exe、
//! git.exe、rg.exe、shell 等）时，若不带 `CREATE_NO_WINDOW` 标志，
//! 系统会为子进程新建一个控制台窗口，表现为"cmd 窗口一闪而过"。
//! 该标志是 `CreateProcess` 的 per-process 标志，不存在系统级全局
//! 开关，因此统一收敛到本模块：内部子进程创建一律使用 [`cmd`] /
//! [`cmd_async`]，禁止直接 `Command::new`，避免遗漏。
//!
//! 例外：需要用户可见窗口的 spawn（启动 IDE、终端会话等）不在此列。
//!
//! 回收侧同样收敛在本模块：[`poll_child_exit`] / [`kill_process_tree`]
//! 是「等待退出 + 杀掉整棵进程树」的规范实现，bash 工具与 git clone
//! 等长任务共用同一套语义（Windows 用 taskkill /T，Unix 用进程组）。

use std::ffi::OsStr;
use std::process::Stdio;
use std::time::{Duration, Instant};

/// Windows 下隐藏子进程控制台窗口的创建标志。
#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 创建隐藏控制台窗口的同步子进程命令。
///
/// Windows 下自动携带 `CREATE_NO_WINDOW`；其它平台该标志无意义，
/// 行为与 `Command::new` 一致。
pub fn cmd(program: impl AsRef<OsStr>) -> std::process::Command {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut command = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// 创建隐藏控制台窗口的异步子进程命令（tokio 版）。
pub fn cmd_async(program: impl AsRef<OsStr>) -> tokio::process::Command {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut command = tokio::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        // tokio::process::Command 的 creation_flags 是 inherent method，
        // 无需引入 CommandExt trait。
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Await the child's exit by polling `try_wait` in a loop instead of using
/// `Child::wait()`.
///
/// On Windows `Child::wait()` registers a `RegisterWaitForSingleObject`
/// callback that runs on the OS wait-thread pool (bounded, shared across the
/// whole process). When that pool is saturated — e.g. many in-flight tool
/// processes with blocking PowerShell scripts — the callback is delayed and
/// the wait future never wakes even though the process has exited. `try_wait()`
/// is a synchronous non-blocking handle check that depends on no thread pool,
/// so polling it keeps the timeout/cancel path fully decoupled from the
/// exit-detection path: whichever fires first wins, and neither can stall the
/// other. (Dropping a `wait()` future mid-wait also runs `UnregisterWaitEx`
/// synchronously, which can block a tokio worker until the queued callback
/// runs — polling avoids that hazard entirely.)
pub async fn poll_child_exit(
    child: &mut tokio::process::Child,
) -> std::io::Result<std::process::ExitStatus> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Kill the entire process tree rooted at `child`, not just the
/// immediate shell process. On Windows, `taskkill` is launched asynchronously
/// and bounded by a short deadline; if it stalls, the shell is force-killed
/// immediately as a fallback. On Unix the dedicated process group is killed
/// (the child must have been spawned with `process_group(0)`).
pub async fn kill_process_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(target_os = "windows")]
        {
            // /T = kill entire process tree, /F = force kill. Do not await this
            // command indefinitely: a broken taskkill must never block the
            // safety-critical cancellation path. 300ms covers the common case;
            // the TerminateProcess fallback below is the authoritative kill.
            let killer = cmd_async("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn();
            if let Ok(mut killer) = killer {
                // Never `killer.wait()` here: this is on the safety-critical
                // cancel path and the same Windows wait-thread-pool hazard
                // applies. Poll `try_wait` for a bounded time instead; the
                // `kill_on_drop(true)` above reaps the taskkill process on drop.
                let _ = tokio::time::timeout(
                    Duration::from_millis(300),
                    poll_child_exit(&mut killer),
                )
                .await;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            // Negative PID kills the entire process group. The child was
            // spawned with process_group(0), so it leads its own group.
            let _ = cmd_async("kill")
                .args(["-9", &format!("-{pid}")])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
    }

    // Fallback is a synchronous TerminateProcess — the authoritative kill.
    let _ = child.start_kill();
    // Reap the direct child with a bounded poll of `try_wait` (never
    // `child.wait()`: its OS wait-thread callback can be delayed when the
    // wait-thread pool is busy, stalling this safety-critical path). A
    // grandchild that survives can never keep the Electron event loop blocked.
    let deadline = Instant::now() + Duration::from_millis(750);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            _ if Instant::now() >= deadline => break,
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
