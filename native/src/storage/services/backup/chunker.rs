use std::fs::File;
use std::io::{ErrorKind, Read};
use std::path::Path;

use napi::bindgen_prelude::*;

/// 分块大小：8 MB。它同时是内容寻址的去重粒度，取值需满足两点：
/// 1. 远小于各家对象存储的单文件上限，跨后端无需改动；
/// 2. 足够大，使 GB 量级的数据库只产生百余个块，避免元数据膨胀。
pub(crate) const CHUNK_SIZE: usize = 8 * 1024 * 1024;

/// 按固定大小逐块读取文件，对每块计算 BLAKE3 并在写入回调中交出内容。
///
/// 内存中同时只驻留一个块，因此 1 GB 以上的数据库不会把整个文件读进内存。
/// 返回块的哈希列表与实际读取到的总字节数（以后者为准，避免源文件在
/// 读取过程中被修改时把长度写成 stat 的旧值）。
pub(crate) fn chunk_file(
    path: &Path,
    mut on_chunk: impl FnMut(&str, &[u8]) -> Result<()>,
) -> Result<(Vec<String>, u64)> {
    let mut file = File::open(path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to open backup source '{}': {error}",
            path.display()
        ))
    })?;
    let mut buffer = vec![0_u8; CHUNK_SIZE];
    let mut hashes = Vec::new();
    let mut total = 0_u64;

    loop {
        let mut filled = 0_usize;
        while filled < CHUNK_SIZE {
            match file.read(&mut buffer[filled..]) {
                Ok(0) => break,
                Ok(count) => filled += count,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => {
                    return Err(Error::from_reason(format!(
                        "Failed to read backup source '{}': {error}",
                        path.display()
                    )))
                }
            }
        }
        if filled == 0 {
            break;
        }

        let hash = blake3::hash(&buffer[..filled]).to_hex().to_string();
        on_chunk(&hash, &buffer[..filled])?;
        hashes.push(hash);
        total += filled as u64;

        if filled < CHUNK_SIZE {
            break;
        }
    }

    Ok((hashes, total))
}
