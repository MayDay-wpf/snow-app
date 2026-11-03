//! 应用进程树资源采集（任务管理器面板使用）。
//!
//! 只负责「操作系统事实」：枚举以给定 root pid 为根的进程树，读取每个进程的
//! CPU 时间与内存占用。CPU 百分比需要两次采样求差，因此这里保留一份采样缓存
//! （pid → 上次的 CPU 时间与墙钟时间），由调用方按固定间隔轮询驱动。
//!
//! 全部为同步系统调用，调用方必须置于 `spawn_blocking` 中执行，避免阻塞
//! Node.js 主线程。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Instant;

use napi::bindgen_prelude::*;

use super::models::ProcessSnapshotEntry;

/// 单个进程的一次原始采样（与平台无关）。
struct ProcessSample {
    pid: u32,
    parent_pid: u32,
    name: String,
    /// 可执行文件完整路径；取不到时为空串（前端据此回退到通用图标）。
    exe_path: String,
    /// 进程累计 CPU 时间（用户态 + 内核态，单位：毫秒）
    cpu_time_ms: u64,
    memory_bytes: i64,
    thread_count: u32,
    /// 进程创建时间（平台原生单位，仅用于同一次快照内比较先后）。
    /// Windows 为 FILETIME；取不到句柄时为 None。其它平台的 ppid 始终指向
    /// 存活父进程（孤儿会被 init / launchd 收养），无需该字段，恒为 None。
    start_time: Option<u64>,
}

/// 上次采样的基线：用于把累计 CPU 时间换算成瞬时占用百分比。
#[derive(Clone)]
struct CpuBaseline {
    cpu_time_ms: u64,
    at: Instant,
}

/// CPU 基线表：pid → 上次采样的 CPU 时间与墙钟时刻。
type CpuBaselines = HashMap<u32, CpuBaseline>;

/// 单槽基线：(root pid, 该次采样下各进程的基线)。
type BaselineSlot = Mutex<Option<(u32, CpuBaselines)>>;

/// 任务管理器面板的采样缓存。同一时刻只可能有一个面板在轮询，单槽即可。
static SAMPLING_BASELINE: OnceLock<BaselineSlot> = OnceLock::new();

/// 进程日志采样器专用基线：与面板互不干扰，各自拥有完整的 CPU 统计窗口。
static LOG_SAMPLING_BASELINE: OnceLock<BaselineSlot> = OnceLock::new();

fn baseline_slot(cell: &'static OnceLock<BaselineSlot>) -> &'static BaselineSlot {
    cell.get_or_init(|| Mutex::new(None))
}

/// 采集以 `root_pid` 为根的进程树快照（任务管理器面板）。
///
/// 返回值的 `cpu_percent` 是「相对上一次调用」的增量占用；首次调用（没有基线）
/// 或两次采样间隔过短时返回 -1，由前端显示为占位符。
pub fn list_process_tree(root_pid: u32) -> Result<Vec<ProcessSnapshotEntry>> {
    sample_process_tree(root_pid, baseline_slot(&SAMPLING_BASELINE))
}

/// 采集进程树快照（进程日志采样器）：使用独立基线，CPU 为两次日志采样之间的平均值。
pub fn list_process_tree_for_log(root_pid: u32) -> Result<Vec<ProcessSnapshotEntry>> {
    sample_process_tree(root_pid, baseline_slot(&LOG_SAMPLING_BASELINE))
}

fn sample_process_tree(
    root_pid: u32,
    baselines_cell: &'static BaselineSlot,
) -> Result<Vec<ProcessSnapshotEntry>> {
    let all = collect_processes()?;
    let descendants = collect_tree(&all, root_pid);

    let now = Instant::now();
    let mut slot = baselines_cell
        .lock()
        .map_err(|_| Error::from_reason("Process sampling baseline mutex poisoned"))?;
    // root pid 变化（应用重启后 pid 复用/新进程）时丢弃旧基线，避免错配。
    if slot.as_ref().is_some_and(|(pid, _)| *pid != root_pid) {
        *slot = None;
    }
    let previous = slot
        .as_ref()
        .map(|(_, baselines)| baselines)
        .cloned()
        .unwrap_or_default();

    let mut next_baselines: CpuBaselines = HashMap::with_capacity(descendants.len());
    let mut entries: Vec<ProcessSnapshotEntry> = Vec::with_capacity(descendants.len());
    let cores = logical_cpu_count();
    for sample in descendants {
        let cpu_percent = previous
            .get(&sample.pid)
            .map(|baseline| cpu_percent_since(baseline, sample.cpu_time_ms, now, cores))
            .unwrap_or(-1.0);
        entries.push(ProcessSnapshotEntry {
            pid: sample.pid,
            parent_pid: sample.parent_pid,
            name: sample.name,
            cpu_percent,
            exe_path: sample.exe_path,
            memory_bytes: sample.memory_bytes,
            thread_count: sample.thread_count,
        });
        next_baselines.insert(
            sample.pid,
            CpuBaseline {
                cpu_time_ms: sample.cpu_time_ms,
                at: now,
            },
        );
    }

    *slot = Some((root_pid, next_baselines));
    // 内存占用降序，便于前端直接展示「占用大户」；CPU 排序交给前端（用户可切换）。
    entries.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.memory_bytes));
    Ok(entries)
}

/// 逻辑处理器数。CPU 百分比按总核数归一化，与系统 / Chrome 任务管理器口径一致：
/// 一个进程跑满全部核心 = 100%（而不是按单核算成 cores × 100%）。
fn logical_cpu_count() -> f64 {
    std::thread::available_parallelism()
        .map(|count| count.get() as f64)
        .unwrap_or(1.0)
}

/// 把两次采样的累计 CPU 时间差换算成百分比（相对整机总算力）。
/// 采样间隔过短（< 50ms）时时间差噪声过大，返回 -1 交由前端显示占位符。
fn cpu_percent_since(
    baseline: &CpuBaseline,
    cpu_time_ms: u64,
    now: Instant,
    cores: f64,
) -> f64 {
    let elapsed_ms = now.duration_since(baseline.at).as_millis();
    if elapsed_ms < 50 {
        return -1.0;
    }
    let delta_ms = cpu_time_ms.saturating_sub(baseline.cpu_time_ms);
    // delta / elapsed = 该进程这段时间平均占用的核数；除以总核数得到整机占比。
    (delta_ms as f64 / elapsed_ms as f64) * 100.0 / cores
}

/// 从全量进程表中筛出以 `root_pid` 为根的整棵树（含根自身）。
///
/// 采用「反复扩展」而不是递归：先用 parent → children 建邻接表，再从根做一次
/// 广度优先，天然免疫进程表里的环（理论上不存在，但 pid 复用时可能构造出异常
/// 关系，visited 集合保证不会死循环）。每条父子边还要经过 [`is_child_of`]
/// 校验，排除 pid 复用造成的伪父子关系。
fn collect_tree(all: &[ProcessSample], root_pid: u32) -> Vec<ProcessSample> {
    let mut children: HashMap<u32, Vec<usize>> = HashMap::new();
    let mut root_index: Option<usize> = None;
    for (index, process) in all.iter().enumerate() {
        if process.pid == root_pid {
            root_index = Some(index);
        }
        children.entry(process.parent_pid).or_default().push(index);
    }

    let Some(root_index) = root_index else {
        return Vec::new();
    };

    let mut visited: HashSet<u32> = HashSet::new();
    visited.insert(root_pid);
    let mut queue: Vec<usize> = vec![root_index];
    let mut result: Vec<ProcessSample> = Vec::new();
    while let Some(index) = queue.pop() {
        let parent = &all[index];
        result.push(ProcessSample {
            pid: parent.pid,
            parent_pid: parent.parent_pid,
            name: parent.name.clone(),
            exe_path: parent.exe_path.clone(),
            cpu_time_ms: parent.cpu_time_ms,
            memory_bytes: parent.memory_bytes,
            thread_count: parent.thread_count,
            start_time: parent.start_time,
        });
        if let Some(descendants) = children.get(&parent.pid) {
            for &child_index in descendants {
                let child = &all[child_index];
                if is_child_of(parent, child) && visited.insert(child.pid) {
                    queue.push(child_index);
                }
            }
        }
    }
    result
}

/// 校验 `child` 是否真是 `parent` 派生的进程。
///
/// Windows 的 `th32ParentProcessID` 只是创建时记下的父 PID：父进程退出后该 PID
/// 会被系统复用，孤儿进程（explorer.exe、各类常驻程序等）的 ppid 可能恰好等于
/// 本应用某个进程的 PID，整棵无关子树就会被误并入任务管理器，表现为应用占用
/// 数十 GB 内存。真实子进程一定不早于父进程创建，据此剔除伪父子关系；任一侧
/// 取不到创建时间时无法证明归属，按非子进程处理。其它平台不提供创建时间
/// （ppid 始终指向存活父进程），直接信任 ppid。
fn is_child_of(parent: &ProcessSample, child: &ProcessSample) -> bool {
    match (parent.start_time, child.start_time) {
        (Some(parent_start), Some(child_start)) => child_start >= parent_start,
        (None, None) => true,
        _ => false,
    }
}

// ============================================================================
// Windows：Toolhelp32 枚举进程 + GetProcessTimes / GetProcessMemoryInfo
// ============================================================================

/// Windows FILETIME（100ns 为单位的高/低位对）合成 64 位整数。
#[cfg(target_os = "windows")]
fn filetime_to_u64(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

/// Windows：读取进程可执行文件的完整路径（QueryFullProcessImageNameW）。
/// 需要在调用前用 PROCESS_QUERY_LIMITED_INFORMATION 打开进程句柄。
#[cfg(target_os = "windows")]
fn windows_process_image_path(
    process: windows_sys::Win32::Foundation::HANDLE,
) -> String {
    use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;

    // MAX_PATH 在长路径场景不够，用足够大的缓冲一次读全（失败则返回空串）。
    let mut buffer = vec![0u16; 1024];
    let mut size = buffer.len() as u32;
    let succeeded = unsafe {
        QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size)
    } != 0;
    if !succeeded {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..size as usize])
}

#[cfg(target_os = "windows")]
fn collect_processes() -> Result<Vec<ProcessSample>> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(Error::from_reason(format!(
                "CreateToolhelp32Snapshot failed: {}",
                std::io::Error::last_os_error()
            )));
        }

        let mut samples: Vec<ProcessSample> = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..std::mem::zeroed()
        };
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|&character| character == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                let pid = entry.th32ProcessID;
                let parent_pid = entry.th32ParentProcessID;

                // 系统进程（PID 0 / 4）无权查询，打不开句柄时只保留名字与
                // 进程树结构（内存 / CPU 记 0）；线程数可直接取进程快照字段。
                let mut cpu_time_ms = 0u64;
                let mut memory_bytes = 0i64;
                let mut start_time: Option<u64> = None;
                let mut exe_path = String::new();
                let thread_count = entry.cntThreads;
                if pid != 0 {
                    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                    if !process.is_null() {
                        exe_path = windows_process_image_path(process);
                        let mut creation: FILETIME = std::mem::zeroed();
                        let mut exit: FILETIME = std::mem::zeroed();
                        let mut kernel: FILETIME = std::mem::zeroed();
                        let mut user: FILETIME = std::mem::zeroed();
                        if GetProcessTimes(
                            process,
                            &mut creation,
                            &mut exit,
                            &mut kernel,
                            &mut user,
                        ) != 0
                        {
                            // FILETIME 为 100ns 单位的高低位对，先合成 64 位再折算毫秒。
                            let total_100ns = filetime_to_u64(kernel)
                                .saturating_add(filetime_to_u64(user));
                            cpu_time_ms = total_100ns / 10_000;
                            start_time = Some(filetime_to_u64(creation));
                        }
                        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
                        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
                        if GetProcessMemoryInfo(process, &mut counters, counters.cb) != 0 {
                            memory_bytes = counters.WorkingSetSize as i64;
                        }
                        CloseHandle(process);
                    }
                }

                samples.push(ProcessSample {
                    pid,
                    parent_pid,
                    name,
                    exe_path,
                    cpu_time_ms,
                    memory_bytes,
                    thread_count,
                    start_time,
                });

                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        Ok(samples)
    }
}

// ============================================================================
// macOS：libproc 枚举进程 + proc_pidinfo(PROC_PIDTASKINFO)
// ============================================================================

/// Mach 绝对时间基准：把 proc_taskinfo 的时间换算成纳秒。
///
/// `pti_total_user` / `pti_total_system` 的单位是 Mach 绝对时间 tick，**不是纳秒**
/// （Apple 未公开该结构的单位，但这是社区反复实证的结论）。Apple Silicon 上
/// timebase 为 numer=125 / denom=3（1 tick ≈ 41.67ns），Intel Mac 为 1:1——
/// 若一律按纳秒处理，Apple Silicon 上的 CPU 占用会虚高约 41.67 倍。
/// timebase 在进程生命周期内恒定，缓存一次即可。
#[cfg(target_os = "macos")]
fn mach_timebase() -> (u64, u64) {
    #[repr(C)]
    struct MachTimebaseInfo {
        numer: u32,
        denom: u32,
    }

    extern "C" {
        fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
    }

    static TIMEBASE: OnceLock<(u64, u64)> = OnceLock::new();
    *TIMEBASE.get_or_init(|| {
        let mut info = MachTimebaseInfo {
            numer: 1,
            denom: 1,
        };
        let status = unsafe { mach_timebase_info(&mut info) };
        // 查询失败或 denom 为 0 时退化为 1:1，避免除零。
        if status == 0 && info.denom != 0 {
            (info.numer as u64, info.denom as u64)
        } else {
            (1, 1)
        }
    })
}

/// macOS：把定长 u8 数组字段（NUL 结尾）解成字符串。
#[cfg(target_os = "macos")]
fn cstr_field_to_string(field: &[u8]) -> String {
    let len = field
        .iter()
        .position(|&character| character == 0)
        .unwrap_or(field.len());
    String::from_utf8_lossy(&field[..len]).into_owned()
}

#[cfg(target_os = "macos")]
fn collect_processes() -> Result<Vec<ProcessSample>> {
    use std::mem::size_of;

    // libproc 的 C 结构：proc_taskinfo / proc_bsdinfo 字段较多，只声明用到的前缀，
    // 但 size_of 必须按真实结构长度传入，否则 proc_pidinfo 会因缓冲区过小失败。
    const PROC_PIDTASKINFO: i32 = 4;
    const PROC_PIDTBSDINFO: i32 = 3;
    const MAX_PROCESSES: usize = 4096;

    #[repr(C)]
    #[derive(Clone, Copy)]
    #[allow(dead_code)]
    struct ProcTaskInfo {
        pti_virtual_size: u64,
        pti_resident_size: u64,
        pti_total_user: u64,
        pti_total_system: u64,
        pti_threads_user: u64,
        pti_threads_system: u64,
        pti_policy: i32,
        pti_faults: i32,
        pti_pageins: i32,
        pti_cow_faults: i32,
        pti_messages_sent: i32,
        pti_messages_received: i32,
        pti_syscalls_mach: i32,
        pti_syscalls_unix: i32,
        pti_csw: i32,
        pti_threadnum: i32,
        pti_numrunning: i32,
        pti_priority: i32,
    }

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
        fn proc_listpids(kind: u32, typeinfo: u32, buffer: *mut std::ffi::c_void, buffersize: i32)
            -> i32;
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            buffersize: i32,
        ) -> i32;
        fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffersize: u32) -> i32;
    }

    // PROC_ALL_PIDS = 1
    const PROC_ALL_PIDS: u32 = 1;

    // 先问内核需要多大缓冲：proc_listpids 传 null 缓冲时返回所需字节数。
    // 直接用固定上限会在进程数超出时静默截断（系统进程多时并不罕见）。
    let needed = unsafe {
        proc_listpids(
            PROC_ALL_PIDS,
            0,
            std::ptr::null_mut(),
            0,
        )
    };
    let capacity = if needed > 0 {
        (needed as usize / size_of::<i32>()) + 32
    } else {
        MAX_PROCESSES
    };

    let mut pids = vec![0i32; capacity];
    let bytes = unsafe {
        proc_listpids(
            PROC_ALL_PIDS,
            0,
            pids.as_mut_ptr() as *mut std::ffi::c_void,
            (pids.len() * size_of::<i32>()) as i32,
        )
    };
    if bytes <= 0 {
        return Err(Error::from_reason(
            "proc_listpids returned no processes".to_string(),
        ));
    }
    let count = (bytes as usize) / size_of::<i32>();

    let mut samples: Vec<ProcessSample> = Vec::with_capacity(count);
    for &pid in pids.iter().take(count) {
        if pid <= 0 {
            continue;
        }
        let mut bsd: ProcBsdInfo = unsafe { std::mem::zeroed() };
        let bsd_size = size_of::<ProcBsdInfo>() as i32;
        let read_bsd = unsafe {
            proc_pidinfo(
                pid,
                PROC_PIDTBSDINFO,
                0,
                &mut bsd as *mut _ as *mut std::ffi::c_void,
                bsd_size,
            )
        };
        if read_bsd != bsd_size {
            continue;
        }
        // pbi_name 为空时回退到 pbi_comm（comm 是截断到 16 字节的短名）。
        let name = {
            let primary = cstr_field_to_string(&bsd.pbi_name);
            if primary.is_empty() {
                cstr_field_to_string(&bsd.pbi_comm)
            } else {
                primary
            }
        };

        let mut task: ProcTaskInfo = unsafe { std::mem::zeroed() };
        let task_size = size_of::<ProcTaskInfo>() as i32;
        let read_task = unsafe {
            proc_pidinfo(
                pid,
                PROC_PIDTASKINFO,
                0,
                &mut task as *mut _ as *mut std::ffi::c_void,
                task_size,
            )
        };
        let (cpu_time_ms, memory_bytes, thread_count) = if read_task == task_size {
            // pti_total_user / pti_total_system 是 Mach 绝对时间 tick：先按 timebase
            // 折算成纳秒（Apple Silicon 上 tick ≠ 1ns），再除以 1e6 得毫秒。
            let total_ticks = task
                .pti_total_user
                .saturating_add(task.pti_total_system);
            let (numer, denom) = mach_timebase();
            let total_ns = total_ticks.saturating_mul(numer) / denom;
            (
                total_ns / 1_000_000,
                task.pti_resident_size as i64,
                task.pti_threadnum.max(0) as u32,
            )
        } else {
            (0, 0, 0)
        };

        // 可执行文件完整路径（PROC_PIDPATHINFO_MAXSIZE = 4096）；失败返回空串。
        let mut path_buffer = vec![0u8; 4096];
        let path_len = unsafe {
            proc_pidpath(
                pid,
                path_buffer.as_mut_ptr() as *mut std::ffi::c_void,
                path_buffer.len() as u32,
            )
        };
        let exe_path = if path_len > 0 {
            String::from_utf8_lossy(&path_buffer[..path_len as usize]).into_owned()
        } else {
            String::new()
        };

        samples.push(ProcessSample {
            pid: pid as u32,
            parent_pid: bsd.pbi_ppid,
            name,
            exe_path,
            cpu_time_ms,
            memory_bytes,
            thread_count,
            start_time: None,
        });
    }
    Ok(samples)
}

// ============================================================================
// Linux：/proc 遍历 + /proc/<pid>/stat + /proc/<pid>/status
// ============================================================================

#[cfg(target_os = "linux")]
fn collect_processes() -> Result<Vec<ProcessSample>> {
    let entries = std::fs::read_dir("/proc")
        .map_err(|error| Error::from_reason(format!("Failed to read /proc: {error}")))?;
    let mut samples: Vec<ProcessSample> = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Some(stat) = read_linux_stat(pid) else {
            continue;
        };
        samples.push(ProcessSample {
            pid,
            parent_pid: stat.parent_pid,
            name: stat.name,
            // /proc/<pid>/exe 是指向可执行文件的符号链接；无权限或已退出时为空串。
            exe_path: std::fs::read_link(format!("/proc/{pid}/exe"))
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
            cpu_time_ms: stat.cpu_time_ms,
            memory_bytes: stat.memory_bytes,
            thread_count: stat.thread_count,
            start_time: None,
        });
    }
    Ok(samples)
}

/// Linux：解析 /proc/<pid>/stat。
///
/// 第 2 字段 `comm` 可能包含空格与括号，必须按最后一个 ')' 切分，不能按空格
/// 简单 split —— 否则像 "(Web Content)" 这类进程名会把字段整体错位。
#[cfg(target_os = "linux")]
struct LinuxStat {
    name: String,
    parent_pid: u32,
    cpu_time_ms: u64,
    memory_bytes: i64,
    thread_count: u32,
}

#[cfg(target_os = "linux")]
fn read_linux_stat(pid: u32) -> Option<LinuxStat> {
    // 时钟节拍：把 stat 里的 jiffies 折算成毫秒。Linux 用户态无法直接读
    // USER_HZ，但 CLK_TCK 恒为 100 是事实标准，且 /proc 自身也用该频率暴露
    // utime/stime；展示场景下的这点误差可以接受。
    const CLK_TCK: u64 = 100;
    let content = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let open = content.find('(')?;
    let close = content.rfind(')')?;
    if close <= open {
        return None;
    }
    let name = content[open + 1..close].to_string();
    let rest: Vec<&str> = content[close + 1..].split_whitespace().collect();
    // rest[0] 对应 stat 的第 3 字段（state），故字段号 N 落在 rest[N - 3]：
    // ppid=4、utime=14、stime=15、num_threads=20、rss=24。
    let parent_pid = rest.get(1)?.parse::<u32>().ok()?;
    let utime = rest.get(11)?.parse::<u64>().ok()?;
    let stime = rest.get(12)?.parse::<u64>().ok()?;
    let thread_count = rest.get(17)?.parse::<u32>().unwrap_or(0);
    let rss_pages = rest.get(21)?.parse::<i64>().ok()?;
    Some(LinuxStat {
        name,
        parent_pid,
        cpu_time_ms: utime.saturating_add(stime).saturating_mul(1000) / CLK_TCK,
        // 页大小固定 4KiB 是 Linux 的通用约定（非 4K 页架构在此场景误差可接受）。
        memory_bytes: rss_pages.saturating_mul(4096),
        thread_count,
    })
}

// ============================================================================
// 其它平台：不提供进程枚举（保持接口存在，返回空列表）
// ============================================================================

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn collect_processes() -> Result<Vec<ProcessSample>> {
    Ok(Vec::new())
}

/// 结束指定进程树（任务管理器面板的「结束进程」）。
///
/// 仅用于应用派生的子进程：Windows 用 `taskkill /T /F` 连同后代一起结束；
/// Unix 用进程组 kill（子进程若未独立成组，退化为单进程 kill）。调用方需保证
/// 目标不是 Electron 自身进程（面板 UI 不提供该入口）。
pub fn kill_process_tree(pid: u32) -> Result<()> {
    if pid == 0 || pid == std::process::id() {
        return Err(Error::from_reason(
            "Refusing to kill an invalid or the current process".to_string(),
        ));
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::{Command, Stdio};
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：避免 taskkill 弹出控制台窗口。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| {
                Error::from_reason(format!("Failed to run taskkill for pid {pid}: {error}"))
            })?;
        if !status.success() {
            return Err(Error::from_reason(format!(
                "taskkill exited with status {status} for pid {pid}"
            )));
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        // 负 pid = 结束整个进程组；若该进程不是组长则仅结束自身，仍然有效。
        let result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if result != 0 {
            let fallback = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            if fallback != 0 {
                return Err(Error::from_reason(format!(
                    "Failed to kill process tree {pid}: {}",
                    std::io::Error::last_os_error()
                )));
            }
        }
        Ok(())
    }
}
