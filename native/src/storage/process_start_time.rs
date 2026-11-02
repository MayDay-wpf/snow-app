// ============================================================================
// 进程身份校验：创建时刻（Unix epoch 毫秒）
// ============================================================================

/// 读取进程创建时刻（Unix epoch 毫秒）。
///
/// 只用于「这个 pid 是否还是当初那个进程」的身份校验（后台任务恢复后判断存活），
/// 取不到（无权限 / 进程已退出 / 平台不支持）返回 None。
pub fn process_start_time_ms(pid: u32) -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        use std::mem::size_of;

        // 与 collect_processes 中的 PROC_PIDTBSDINFO 结构保持同一布局；
        // proc_pidinfo 要求传入真实结构长度，字段前缀必须完整。
        const PROC_PIDTBSDINFO: i32 = 3;

        #[repr(C)]
        #[derive(Clone, Copy)]
        #[allow(dead_code)]
        struct ProcBsdInfo {
            pbi_flags: u32,
            pbi_status: u32,
            pbi_xstatus: u32,
            pbi_pid: u32,
            pbi_ppid: u32,
            pbi_uid: u32,
            pbi_gid: u32,
            pbi_ruid: u32,
            pbi_rgid: u32,
            pbi_svuid: u32,
            pbi_svgid: u32,
            rfu_1: u32,
            pbi_comm: [u8; 16],
            pbi_name: [u8; 32],
            pbi_nfiles: u32,
            pbi_pgid: u32,
            pbi_pjobc: u32,
            e_tdev: u32,
            e_tpgid: u32,
            pbi_nice: i32,
            pbi_start_tvsec: u64,
            pbi_start_tvusec: u64,
        }

        extern "C" {
            fn proc_pidinfo(
                pid: i32,
                flavor: i32,
                arg: u64,
                buffer: *mut std::ffi::c_void,
                buffersize: i32,
            ) -> i32;
        }

        if pid == 0 || pid > i32::MAX as u32 {
            return None;
        }
        let mut info: ProcBsdInfo = unsafe { std::mem::zeroed() };
        let read = unsafe {
            proc_pidinfo(
                pid as i32,
                PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut _,
                size_of::<ProcBsdInfo>() as i32,
            )
        };
        if read <= 0 {
            return None;
        }
        return Some(info.pbi_start_tvsec as i64 * 1000 + info.pbi_start_tvusec as i64 / 1000);
    }

    #[cfg(target_os = "linux")]
    {
        // /proc/<pid>/stat：comm 可能含空格与右括号，从最后一个 ')' 之后开始数，
        // 第 20 个字段即 starttime（1-based 的第 22 字段，单位为时钟滴答）。
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let rest = stat.rsplit_once(')')?.1;
        let ticks: i64 = rest.split_whitespace().nth(19)?.parse().ok()?;
        let boot_time: i64 = std::fs::read_to_string("/proc/stat")
            .ok()?
            .lines()
            .find_map(|line| line.strip_prefix("btime "))?
            .trim()
            .parse()
            .ok()?;
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if hz <= 0 {
            return None;
        }
        return Some(boot_time * 1000 + ticks * 1000 / hz as i64);
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        fn filetime_ticks(value: FILETIME) -> u64 {
            ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
        }

        if pid == 0 {
            return None;
        }
        // SAFETY: 只查询创建时间，句柄在返回前关闭。
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut creation: FILETIME = std::mem::zeroed();
            let mut exit: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            let ok = GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
            CloseHandle(process);
            if !ok {
                return None;
            }
            // FILETIME 为 1601-01-01 起的 100ns 计数，换算到 Unix epoch 毫秒。
            let ticks = filetime_ticks(creation) as i64;
            return Some(ticks / 10_000 - 11_644_473_600_000);
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = pid;
        None
    }
}
