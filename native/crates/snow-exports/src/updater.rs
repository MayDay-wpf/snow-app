use napi::bindgen_prelude::*;
use napi_derive::napi;

// ============================================================================
// 更新相关的 NAPI 函数。
// 均使用 async + spawn_blocking 模式，确保文件 I/O 不会阻塞 Node.js 主线程。
// ============================================================================

/// Compute the SHA-256 digest of a file as a lowercase hex string.
///
/// Used by the unsigned macOS update flow to verify the integrity of a
/// downloaded update archive before it is applied.
#[napi]
pub async fn sha256_file(file_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        use sha2::{Digest, Sha256};

        let mut file = std::fs::File::open(&file_path)?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher)?;
        let digest = hasher.finalize();
        Ok(digest
            .iter()
            .map(|byte| format!("{:02x}", byte))
            .collect::<String>())
    })
    .await
    .map_err(map_spawn_error)?
}

/// Convert a tokio JoinError into a napi Error.
fn map_spawn_error(e: tokio::task::JoinError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Spawned blocking task failed: {}", e),
    )
}
