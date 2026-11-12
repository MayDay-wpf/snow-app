//! 内容抓取跳过策略：checkpoint 指纹捕获时跳过该文件（不哈希、不写入
//! 对象库），其变更不可回滚。独立维护：只改本文件即可调整跳过范围。

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// 内容抓取的单文件上限：超过则跳过（变更不可回滚），避免大文件 IO。
pub const PENDING_COPY_SIZE_LIMIT: u64 = 32 * 1024 * 1024;

/// 抓取时跳过的扩展名（AI 工具几乎不会修改的文件）。
///
/// 只收录明确的二进制/不可编辑格式；绝不收录源码与文本格式
/// （.ts/.mts/.json/.svg/.map/.log/.pem/.yaml 等），否则 AI 修改这些文件
/// 时将失去回滚能力。
pub const SKIP_BINARY_EXTENSIONS: &[&str] = &[
    // 图片
    "png", "jpg", "jpeg", "jfif", "jpe", "gif", "webp", "bmp", "ico", "icns", "cur",
    "ani", "heic", "heif", "avif", "tiff", "tif", "psd", "xcf", "kra", "ora", "svgz",
    "tga", "exr", "hdr", "dds", "ktx", "j2k", "jp2", "jpx", "jxr", "mng",
    // 音频
    "mp3", "mp2", "wav", "flac", "ogg", "oga", "opus", "m4a", "m4p", "m4r", "aac",
    "aiff", "aif", "mid", "midi", "ape", "wv", "tta", "caf", "au", "ra", "wma",
    "amr", "amrwb", "spx",
    // 视频
    "mp4", "mkv", "avi", "mov", "wmv", "webm", "flv", "f4v", "m4v", "m4b", "3gp",
    "3g2", "asf", "vob", "ogv", "ogm", "rm", "rmvb", "m2ts", "mpg", "mpeg", "mpe",
    "m1v", "m2v", "m2p", "ac3", "eac3", "swf", "divx", "mxf",
    // 压缩包/镜像
    "zip", "zipx", "tar", "tgz", "tbz2", "txz", "tzst", "gz", "bz2", "xz", "lzma",
    "lz4", "br", "z", "7z", "rar", "cab", "arj", "lzh", "ace", "cpio", "zst",
    "nupkg", "crx", "xpi", "vsix", "iso", "img", "dmg", "vhd", "vhdx", "vdi",
    "vmdk", "qcow", "qcow2", "wim", "ova",
    // 可执行/库
    "exe", "com", "msi", "msix", "appx", "apk", "aab", "ipa", "deb", "rpm", "pkg",
    "dll", "so", "dylib", "a", "lib", "o", "obj", "rlib", "sys", "drv", "ocx", "ax",
    "cpl", "mui", "efi", "node",
    // 二进制数据/数据库
    "bin", "dat", "db", "sqlite", "sqlite3", "wal", "shm", "ldb", "sst", "mdb",
    "accdb", "dbf", "frm", "myd", "myi", "ibd", "mdf", "ldf", "bak", "dmp", "pcap",
    "pcapng", "evtx", "p12", "pfx", "jks", "keystore", "dex",
    // 构建产物/字节码
    "class", "jar", "war", "ear", "whl", "pyc", "pyd", "pyo", "wasm", "pdb",
    // 模型/数据科学
    "pt", "pth", "onnx", "safetensors", "gguf", "pb", "tflite", "h5", "keras",
    "pkl", "joblib", "ckpt", "npz", "npy", "hdf5", "caffemodel", "engine", "nc",
    "rds", "rdata", "feather", "parquet", "arrow", "orc",
    // 文档
    "pdf", "epub", "mobi", "azw", "azw3", "chm", "doc", "docx", "docm", "xls",
    "xlsx", "xlsm", "xlsb", "ppt", "pptx", "pptm", "odt", "ods", "odp", "indd",
    "sketch", "fig", "ai", "numbers", "pages", "msg", "pst", "ost",
    // 字体
    "ttf", "otf", "ttc", "otc", "woff", "woff2", "eot", "dfont", "fnt",
    // 游戏/3D/设计
    "pak", "wad", "unity3d", "fbx", "blend", "3ds", "glb", "stl", "dwg",
];

static SKIP_EXTENSIONS_SET: OnceLock<HashSet<&'static str>> = OnceLock::new();

pub fn should_skip_pending_copy(path: &Path) -> bool {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > PENDING_COPY_SIZE_LIMIT {
            return true;
        }
    }
    let set = SKIP_EXTENSIONS_SET.get_or_init(|| SKIP_BINARY_EXTENSIONS.iter().copied().collect());
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            set.contains(lower.as_str())
        })
        .unwrap_or(false)
}

/// 按已知大小与路径判断是否跳过内容抓取。SSH 工作区已通过远程 stat
/// 拿到 size，无需再访问本地文件系统（与 should_skip_pending_copy 一致）。
pub fn should_skip_pending_copy_size(size: u64, path: &str) -> bool {
    if size > PENDING_COPY_SIZE_LIMIT {
        return true;
    }
    let set = SKIP_EXTENSIONS_SET.get_or_init(|| SKIP_BINARY_EXTENSIONS.iter().copied().collect());
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            set.contains(lower.as_str())
        })
        .unwrap_or(false)
}
