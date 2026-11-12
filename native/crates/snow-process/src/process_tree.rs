//! 子进程树回收：Windows 用独立 Job Object（KILL_ON_JOB_CLOSE）杀整棵树，
//! Unix 用进程组 kill(-pgid)。每个 MCP session 一个，避免 gopls 等后代残留。

pub struct ProcessTreeGuard {
    server_name: String,
    pid: u32,
    #[cfg(target_os = "windows")]
    job: Option<windows_sys::Win32::Foundation::HANDLE>,
}

// Windows 的 HANDLE（Job Object）是进程级内核句柄表索引，微软保证句柄值
// 可在进程内任意线程使用（CloseHandle/TerminateJobObject 均线程安全），
// 跨线程传递安全。手动标记 Send+Sync，使持有 guard 的 StdioMcpClient 满足
// ClientHandle: Send + Sync 约束（否则 Windows 上整个 napi 异步层无法编译，
// 而 Unix 分支只有 String+u32 字段天然满足，故仅 Windows 需要）。
#[cfg(target_os = "windows")]
unsafe impl Send for ProcessTreeGuard {}

#[cfg(target_os = "windows")]
unsafe impl Sync for ProcessTreeGuard {}

impl ProcessTreeGuard {
    /// 为已 spawn 的子进程建立进程树回收句柄。
    /// Windows 上创建独立 Job Object 并分配子进程；失败时降级为日志告警。
    pub fn new(server_name: &str, pid: u32) -> Self {
        #[cfg(target_os = "windows")]
        let job = attach_to_job(pid);
        #[cfg(target_os = "windows")]
        if job.is_none() {
            eprintln!(
                "[External MCP {server_name}] WARNING: failed to assign pid={pid} to a job object, descendant processes may survive on close"
            );
        }
        Self {
            server_name: server_name.to_string(),
            pid,
            #[cfg(target_os = "windows")]
            job,
        }
    }

    /// Read-only Windows Job accounting: cumulative CPU includes terminated
    /// descendants; active count is a snapshot. No job/unsupported OS => unavailable.
    pub fn accounting(&self) -> Option<(u64, u32)> {
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::System::JobObjects::{QueryInformationJobObject, JobObjectBasicAccountingInformation, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION};
            let job = self.job?;
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            let ok = unsafe { QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &mut info as *mut _ as *mut _, std::mem::size_of_val(&info) as u32, std::ptr::null_mut()) };
            if ok == 0 { return None; }
            return Some(((info.TotalUserTime as u64).saturating_add(info.TotalKernelTime as u64), info.ActiveProcesses));
        }
        #[cfg(not(target_os = "windows"))]
        { None }
    }

    /// 终止整棵进程树并记录结果（与析构等价）。
    pub fn terminate(&mut self) {
        #[cfg(target_os = "windows")]
        if let Some(job) = self.job.take() {
            unsafe {
                use windows_sys::Win32::Foundation::CloseHandle;
                use windows_sys::Win32::System::JobObjects::TerminateJobObject;
                let _ = TerminateJobObject(job, 1);
                CloseHandle(job);
            }
            eprintln!(
                "[External MCP {}] closed pid={} process tree via job object",
                self.server_name, self.pid
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            // 子进程以 process_group(0) spawn，进程组 id == pid
            let _ = unsafe { libc::kill(-(self.pid as i32), libc::SIGKILL) };
            eprintln!(
                "[External MCP {}] closed pid={} process tree via process group",
                self.server_name, self.pid
            );
        }
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        // 关句柄即触发 KILL_ON_JOB_CLOSE；Snow 进程退出时同样生效
        #[cfg(target_os = "windows")]
        if let Some(job) = self.job.take() {
            unsafe {
                use windows_sys::Win32::Foundation::CloseHandle;
                use windows_sys::Win32::System::JobObjects::TerminateJobObject;
                let _ = TerminateJobObject(job, 1);
                CloseHandle(job);
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = unsafe { libc::kill(-(self.pid as i32), libc::SIGKILL) };
        }
    }
}

#[cfg(target_os = "windows")]
fn attach_to_job(pid: u32) -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }

        // 设置 KILL_ON_JOB_CLOSE：Job 句柄全部关闭时终止所有关联进程
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            CloseHandle(job);
            return None;
        }

        // 通过 PID 打开子进程句柄并分配进 Job
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            CloseHandle(job);
            return None;
        }
        let assigned = AssignProcessToJobObject(job, process);
        CloseHandle(process);
        if assigned == 0 {
            CloseHandle(job);
            return None;
        }
        Some(job)
    }
}
