use napi::bindgen_prelude::*;

use super::database;
use super::ensure_archive_database_file;
use super::ensure_database_file;
use super::models::*;
use super::services;

/// 读取当前进程的常驻内存占用（字节）；用于设置页展示资源占用。
/// 仅做系统调用查询，调用方需置于 spawn_blocking 中执行。
pub fn get_process_memory_bytes() -> Result<i64> {
    #[cfg(target_os = "macos")]
    {
        unsafe { macos_resident_memory() }
    }
    #[cfg(target_os = "linux")]
    {
        linux_resident_memory()
    }
    #[cfg(target_os = "windows")]
    {
        unsafe { windows_resident_memory() }
    }
}

/// 本进程内存整理（「设置 → 资源占用」的优化占用触发的内存部分）：
/// 仅 Windows 支持整理（收缩工作集把不活跃页换出物理内存，纯内核层
/// 操作、不触碰堆内部结构）。Node 侧的 V8 full GC 在调用前完成。
/// macOS 的 `malloc_zone_pressure_relief` 在 Electron 多线程进程中存在
/// 段错误崩溃风险（实测 SIGSEGV），为稳定性不在非 Windows 平台提供
/// 内存整理；调用方（IPC handler）在非 Windows 平台快速失败。
/// 系统调用极快，调用方仍需置于 spawn_blocking 中执行。
pub fn optimize_memory() -> Result<MemoryOptimizeResult> {
    let bytes_before = get_process_memory_bytes()?;
    // 非 Windows 平台不支持整理：回退为不整理（bytes_after = bytes_before）
    let bytes_after = trim_working_set().unwrap_or(bytes_before);
    Ok(MemoryOptimizeResult {
        bytes_before,
        bytes_after,
    })
}

/// Windows：向系统申请尽可能收缩本进程工作集，成功后重新测量常驻内存。
/// 该调用仅请求内核把暂不使用的页移出工作集（转入 standby 列表），不触碰
/// 堆内部结构，多线程下安全。
#[cfg(target_os = "windows")]
fn trim_working_set() -> Result<i64> {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Memory::SetProcessWorkingSetSizeEx;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // 最小 / 最大工作集同时传入 SIZE_T::MAX（即 -1）为系统约定语义：
    // 尽可能清空本进程工作集，把暂不使用的页换出物理内存。
    // 对自身进程始终持有 PROCESS_SET_QUOTA 权限，正常路径不会失败。
    let handle = unsafe { GetCurrentProcess() } as HANDLE;
    let succeeded = unsafe {
        SetProcessWorkingSetSizeEx(handle, usize::MAX, usize::MAX, 0)
    } != 0;
    if !succeeded {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "SetProcessWorkingSetSizeEx failed: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    unsafe { windows_resident_memory() }
}

/// 非 Windows 平台：不支持内存整理（macOS / Linux 的堆整理接口在多线程
/// GUI 进程中风险过高，见 [optimize_memory] 文档），由调用方回退为不整理。
#[cfg(not(target_os = "windows"))]
fn trim_working_set() -> Result<i64> {
    Err(Error::new(
        Status::GenericFailure,
        "Memory trimming is only supported on Windows",
    ))
}

/// macOS：mach task_info(MACH_TASK_BASIC_INFO) 查询常驻内存。
#[cfg(target_os = "macos")]
unsafe fn macos_resident_memory() -> Result<i64> {
    // flavor 20 = MACH_TASK_BASIC_INFO，结构与 mach/task_info.h 保持一致
    const MACH_TASK_BASIC_INFO_FLAVOR: u32 = 20;
    // 结构体 48 字节，count 以 natural_t(u32) 为单位
    const MACH_TASK_BASIC_INFO_COUNT: u32 = 12;

    #[repr(C)]
    struct MachTaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        // time_value_t：seconds(i32) + microseconds(i32)
        user_time: u64,
        system_time: u64,
        policy: i32,
        suspend_count: i32,
        thread_count: i32,
    }

    extern "C" {
        fn mach_task_self() -> u32;
        fn task_info(
            target: u32,
            flavor: u32,
            info: *mut std::ffi::c_void,
            count: *mut u32,
        ) -> i32;
    }

    let mut info = MachTaskBasicInfo {
        virtual_size: 0,
        resident_size: 0,
        resident_size_max: 0,
        user_time: 0,
        system_time: 0,
        policy: 0,
        suspend_count: 0,
        thread_count: 0,
    };
    let mut count = MACH_TASK_BASIC_INFO_COUNT;
    let status = task_info(
        mach_task_self(),
        MACH_TASK_BASIC_INFO_FLAVOR,
        &mut info as *mut _ as *mut std::ffi::c_void,
        &mut count,
    );
    if status != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            format!("task_info failed with kern status {status}"),
        ));
    }
    Ok(info.resident_size as i64)
}

/// Linux：读取 /proc/self/status 的 VmRSS 行（单位 kB）。
#[cfg(target_os = "linux")]
fn linux_resident_memory() -> Result<i64> {
    let status = std::fs::read_to_string("/proc/self/status").map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read process memory: {error}"),
        )
    })?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: i64 = rest
                .trim()
                .trim_end_matches("kB")
                .trim()
                .parse()
                .unwrap_or(0);
            return Ok(kb.saturating_mul(1024));
        }
    }
    Err(Error::new(
        Status::GenericFailure,
        "VmRSS not found in /proc/self/status",
    ))
}

/// Windows：GetProcessMemoryInfo 查询工作集大小。
#[cfg(target_os = "windows")]
unsafe fn windows_resident_memory() -> Result<i64> {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    if GetProcessMemoryInfo(
        GetCurrentProcess() as HANDLE,
        &mut counters,
        counters.cb,
    ) == 0
    {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "GetProcessMemoryInfo failed: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    Ok(counters.WorkingSetSize as i64)
}

/// 修复数据库（kind: "runtime" = 运行数据库 | "archive" = 归档数据库）：
/// 完整性检查 → 损坏则恢复数据（原文件保留 `.corrupt.*.bak` 备份），
/// 完好则 VACUUM 压缩优化。所有文件 I/O 均在调用方的 spawn_blocking 中执行。
pub fn repair_database(kind: String) -> Result<DatabaseRepairResult> {
    match kind.trim() {
        "runtime" => {
            let database_path = ensure_database_file()?;
            database::repair_database(&database_path, database::create_schema)
        }
        "archive" => {
            let archive_path = ensure_archive_database_file()?;
            database::repair_database(&archive_path, services::archive::create_archive_schema)
        }
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unknown database kind: {other}"),
        )),
    }
}

/// 数据库空间优化（kind: "runtime" = 运行数据库 | "archive" = 归档数据库）：
/// `VACUUM` 重建文件回收空闲页并截断 WAL，返回释放的磁盘字节数。
pub fn optimize_database(kind: String) -> Result<DatabaseOptimizeResult> {
    let result = match kind.trim() {
        "runtime" => database::optimize_database(&ensure_database_file()?)?,
        "archive" => database::optimize_database(&ensure_archive_database_file()?)?,
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Unknown database kind: {other}"),
            ));
        }
    };
    Ok(result)
}
