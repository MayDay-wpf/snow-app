use napi_derive::napi;

use crate::mcp::servers::filesystem::FilesystemService;

/// 立即把仍在等待自动格式化的文件全部落盘。
///
/// 自动格式化已改为「延迟 + 合并」执行（见 filesystem/format.rs），因此应用
/// 退出前必须调用一次，否则退出瞬间尚未执行的格式化会随进程一起丢失。
#[napi]
pub async fn flush_pending_file_formats() -> napi::Result<()> {
    FilesystemService::flush_pending_formats().await;
    Ok(())
}
