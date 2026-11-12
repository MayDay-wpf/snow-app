//! Office 文档文本提取。
//!
//! 通过扩展名识别文档类型并提取纯文本，供 read 工具以带行号文本的形式返回：
//! - pdf: 使用 pdf-extract 提取全文
//! - docx/pptx: 作为 OOXML(zip) 容器解包后按标签提取文本运行
//! - xlsx/xls/xlsb/xlsm/ods: 使用 calamine 逐 Sheet 读取
//! - csv: 使用 csv crate 正确解析带引号字段（字段内可含换行/分隔符），
//!        读取时经编码检测解码，支持 GBK 等非 UTF-8 编码的 CSV
//! - doc/ppt（旧版二进制格式）: 依次尝试系统工具与文本扫描提取：
//!        1. macOS 内置 textutil（仅 .doc，可靠）
//!        2. LibreOffice soffice --headless 转换（.doc/.ppt，需用户安装）
//!        3. UTF-16 可读文本扫描兜底（对 .doc/.ppt 的 UTF-16LE 文本段有效）
//!        全部失败才返回引导性错误
//!
//! 注意：本模块的提取函数都是同步的 CPU/IO 密集型操作，调用方必须保证其运行在
//! tokio 的阻塞线程池中（内置 MCP 工具统一经 tokio::task::spawn_blocking 调度），
//! 不得在异步任务或 NodeJS 主线程中直接调用。

use std::fs;
use std::path::Path;

use napi::bindgen_prelude::*;

/// 单个 Office 文档允许解析的最大文件大小，避免超大文件长时间占用阻塞线程。
const MAX_OFFICE_FILE_BYTES: u64 = 200 * 1024 * 1024;

/// 可提取文本的 Office 文档类型。
pub enum OfficeDocKind {
    Pdf,
    Word,
    Excel,
    Csv,
    PowerPoint,
    /// 旧版二进制格式（.doc / .ppt），无标准纯 Rust 解析库，
    /// 通过系统工具（textutil / soffice）与 UTF-16 文本扫描提取，失败才报错。
    LegacyBinary,
}

/// 根据扩展名判断是否为可提取文本的 Office 文档。
pub fn office_document_kind(path: &Path) -> Option<OfficeDocKind> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("pdf") => Some(OfficeDocKind::Pdf),
        Some("docx") => Some(OfficeDocKind::Word),
        Some("xlsx") | Some("xls") | Some("xlsb") | Some("xlsm") | Some("ods") => {
            Some(OfficeDocKind::Excel)
        }
        Some("csv") => Some(OfficeDocKind::Csv),
        Some("pptx") => Some(OfficeDocKind::PowerPoint),
        Some("doc") | Some("ppt") => Some(OfficeDocKind::LegacyBinary),
        _ => None,
    }
}

/// 从 Office 文档中提取纯文本。
pub fn extract_office_document_text(path: &Path, kind: OfficeDocKind) -> napi::Result<String> {
    let file_size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if file_size > MAX_OFFICE_FILE_BYTES {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Office document is too large to parse: {} bytes (limit: {} bytes, path: {})",
                file_size,
                MAX_OFFICE_FILE_BYTES,
                path.display()
            ),
        ));
    }

    let text = match kind {
        OfficeDocKind::Pdf => extract_pdf_text(path)?,
        OfficeDocKind::Word => extract_docx_text(path)?,
        OfficeDocKind::Excel => extract_excel_text(path)?,
        OfficeDocKind::Csv => extract_csv_text(path)?,
        OfficeDocKind::PowerPoint => extract_pptx_text(path)?,
        OfficeDocKind::LegacyBinary => extract_legacy_binary_text(path)?,
    };

    Ok(text.trim_end().to_string())
}

/// 提取旧版二进制 Office 文档（.doc/.ppt）的文本。
///
/// 老格式没有成熟的标准纯 Rust 解析库，按可靠性依次尝试：
/// 1. macOS 内置 textutil（仅 .doc，系统自带、官方支持、可靠）
/// 2. LibreOffice soffice --headless 转换（.doc/.ppt，需用户安装）
/// 3. UTF-16 可读文本扫描兜底（Word/PPT 97 的 Unicode 文本流以 UTF-16LE 存储）
/// 全部失败才返回引导性错误，提示用户转换为新格式。
fn extract_legacy_binary_text(path: &Path) -> napi::Result<String> {
    // 1. macOS 内置 textutil（仅 .doc）
    #[cfg(target_os = "macos")]
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("doc"))
    {
        if let Ok(text) = extract_doc_via_textutil(path) {
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }

    // 2. LibreOffice soffice（.doc/.ppt）
    if let Ok(text) = extract_via_soffice(path) {
        if !text.trim().is_empty() {
            return Ok(text);
        }
    }

    // 3. UTF-16 可读文本扫描兜底（.doc/.ppt）
    if let Ok(text) = extract_via_utf16_scan(path) {
        if !text.trim().is_empty() {
            return Ok(text);
        }
    }

    Err(Error::new(
        Status::GenericFailure,
        format!(
            "Failed to extract text from legacy binary Office format (.doc/.ppt) (path: {}). \
             Tried textutil, LibreOffice (soffice) and a UTF-16 text scan; none produced readable text. \
             Please convert it to .docx, .pptx or .pdf first.",
            path.display()
        ),
    ))
}

/// 使用 macOS 内置 textutil 提取 .doc 文本（输出经编码检测解码为 UTF-8）。
#[cfg(target_os = "macos")]
fn extract_doc_via_textutil(path: &Path) -> napi::Result<String> {
    let output = std::process::Command::new("textutil")
        .arg("-convert")
        .arg("txt")
        .arg("-stdout")
        .arg(path)
        .output()
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to run textutil: {} (path: {})",
                    error,
                    path.display()
                ),
            )
        })?;

    if !output.status.success() {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "textutil failed with status {:?} (path: {})",
                output.status.code(),
                path.display()
            ),
        ));
    }

    let text = super::text_codec::decode_text_bytes(&output.stdout)
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to decode textutil output as text: {} (path: {})",
                    error,
                    path.display()
                ),
            )
        })?
        .text;

    Ok(text)
}

/// 使用 LibreOffice soffice 以 headless 模式将 .doc/.ppt 转换为 txt 后读取。
/// 转换输出到唯一的临时目录，读取完成后清理。
fn extract_via_soffice(path: &Path) -> napi::Result<String> {
    let soffice = find_soffice().ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            "LibreOffice (soffice) is not installed".to_string(),
        )
    })?;

    // 唯一临时输出目录，避免并发转换互相覆盖
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let out_dir = std::env::temp_dir().join(format!(
        "snow_native_office_{}_{}",
        std::process::id(),
        unique
    ));
    fs::create_dir_all(&out_dir).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create temp dir: {}", error),
        )
    })?;

    let cleanup = || {
        let _ = fs::remove_dir_all(&out_dir);
    };

    let output = match std::process::Command::new(soffice)
        .arg("--headless")
        .arg("--nolockcheck")
        .arg("--convert-to")
        // 显式指定 UTF-8 编码的 txt 过滤器，避免中文系统默认输出本地编码
        .arg("txt:Text (encoded):UTF8")
        .arg("--outdir")
        .arg(&out_dir)
        .arg(path)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            cleanup();
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to run LibreOffice soffice: {} (path: {})",
                    error,
                    path.display()
                ),
            ));
        }
    };

    if !output.status.success() {
        cleanup();
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "LibreOffice soffice conversion failed with status {:?} (path: {})",
                output.status.code(),
                path.display()
            ),
        ));
    }

    // 输出文件名为输入文件名追加 .txt
    let out_path = out_dir.join(format!(
        "{}.txt",
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    ));

    let bytes = match fs::read(&out_path) {
        Ok(bytes) => bytes,
        Err(error) => {
            cleanup();
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "LibreOffice soffice produced no output file: {} (path: {})",
                    error,
                    path.display()
                ),
            ));
        }
    };

    let text = match super::text_codec::decode_text_bytes(&bytes) {
        Ok(decoded) => decoded.text,
        Err(error) => {
            cleanup();
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to decode LibreOffice output as text: {} (path: {})",
                    error,
                    path.display()
                ),
            ));
        }
    };

    cleanup();
    Ok(text)
}

/// 查找可用的 LibreOffice soffice 可执行文件。
/// 纯命令名候选通过 --version 探测（依赖 PATH），绝对路径候选直接检查存在性。
fn find_soffice() -> Option<std::path::PathBuf> {
    let candidates: Vec<std::path::PathBuf> = {
        let mut list = vec![std::path::PathBuf::from("soffice")];
        #[cfg(target_os = "macos")]
        list.push(std::path::PathBuf::from(
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        ));
        #[cfg(target_os = "windows")]
        list.extend([
            std::path::PathBuf::from(r"C:\Program Files\LibreOffice\program\soffice.exe"),
            std::path::PathBuf::from(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
        ]);
        #[cfg(target_os = "linux")]
        list.push(std::path::PathBuf::from("libreoffice"));
        list
    };

    candidates.into_iter().find(|candidate| {
        if candidate.is_absolute() {
            candidate.is_file()
        } else {
            std::process::Command::new(candidate)
                .arg("--version")
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
        }
    })
}

/// UTF-16 可读文本扫描：按 2 字节一组分别以 LE/BE 解码文件，
/// 收集连续可读 code unit 组成的文本片段。老式 .doc/.ppt 的文本常以
/// UTF-16LE 存储（Word/PPT 97 的 Unicode 文本流），此扫描能提取大部分正文。
/// 返回 (文本, 可读单元总数)，调用方选择得分更高的一端。
fn extract_via_utf16_scan(path: &Path) -> napi::Result<String> {
    let bytes = fs::read(path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Failed to read file for UTF-16 scan: {} (path: {})",
                error,
                path.display()
            ),
        )
    })?;

    let (text_le, score_le) = scan_utf16_text(&bytes, true);
    let (text_be, score_be) = scan_utf16_text(&bytes, false);

    if score_le == 0 && score_be == 0 {
        return Err(Error::new(
            Status::GenericFailure,
            format!("No readable UTF-16 text found (path: {})", path.display()),
        ));
    }

    Ok(if score_le >= score_be { text_le } else { text_be })
}

/// 片段中至少含一个 ASCII 可打印字符时的最小长度。
/// ASCII 字符在二进制噪声中极少误命中（每对随机字节落入 0x20..=0x7E
/// 的概率约 0.15%），是强信号，因此阈值可以较低。
const UTF16_SCAN_MIN_RUN: usize = 3;
/// 纯 CJK 片段的额外最小长度。随机字节对按 UTF-16 误读时落入 CJK 区间的
/// 概率不低，纯中文片段需足够长才可信。
const UTF16_SCAN_MIN_RUN_CJK: usize = 5;

fn scan_utf16_text(bytes: &[u8], little_endian: bool) -> (String, usize) {
    let mut text = String::new();
    let mut score = 0usize;
    let mut run = String::new();
    let mut run_len = 0usize;
    let mut has_ascii = false;

    for chunk in bytes.chunks_exact(2) {
        let unit = if little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        };

        if is_readable_utf16_unit(unit) {
            if unit == b'\n' as u16 || unit == b'\r' as u16 {
                run.push('\n');
            } else if let Some(ch) = char::from_u32(unit as u32) {
                run.push(ch);
            }
            if (0x20..=0x7E).contains(&unit) {
                has_ascii = true;
            }
            run_len += 1;
        } else {
            flush_utf16_run(&mut text, &mut score, &mut run, &mut run_len, &mut has_ascii);
        }
    }
    flush_utf16_run(&mut text, &mut score, &mut run, &mut run_len, &mut has_ascii);

    (text, score)
}

fn flush_utf16_run(
    text: &mut String,
    score: &mut usize,
    run: &mut String,
    run_len: &mut usize,
    has_ascii: &mut bool,
) {
    let keep = *run_len >= UTF16_SCAN_MIN_RUN
        && (*has_ascii || *run_len >= UTF16_SCAN_MIN_RUN_CJK);
    if keep {
        text.push_str(run);
        text.push('\n');
        *score += *run_len;
    }
    run.clear();
    *run_len = 0;
    *has_ascii = false;
}

/// 判断 UTF-16 code unit 是否为可读文本字符。
/// 刻意排除韩文音节（0xAC00..=0xD7AF）与代理区：GBK 等 8 位编码的字节对
/// 按 UTF-16 误读时极易落入韩文区间，会制造大量噪声。
fn is_readable_utf16_unit(unit: u16) -> bool {
    match unit {
        // 控制字符：仅允许 tab / LF / CR
        0x09 | 0x0A | 0x0D => true,
        // ASCII 可打印
        0x20..=0x7E => true,
        // 通用标点（破折号、引号、省略号等），排除零宽/方向控制/行分隔符
        0x2000..=0x206F
            if !(0x200B..=0x200F).contains(&unit) && unit != 0x2028 && unit != 0x2029 =>
        {
            true
        }
        // CJK 符号与标点（、。「」等）
        0x3000..=0x303F => true,
        // 日文假名
        0x3040..=0x30FF => true,
        // CJK 扩展 A / 统一表意文字 / 兼容表意文字
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF => true,
        // CJK 兼容形式（竖排变体等）
        0xFE30..=0xFE4F => true,
        // 全角形式（全角标点、全角字母数字）
        0xFF00..=0xFFEF => true,
        _ => false,
    }
}

/// 提取 PDF 文本。pdf-extract 在畸形文件上可能 panic，
/// 用 catch_unwind 兜底避免拖垮阻塞线程池。
fn extract_pdf_text(path: &Path) -> napi::Result<String> {
    let path_buf = path.to_path_buf();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pdf_extract::extract_text(&path_buf)
    }));

    match result {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(error)) => Err(Error::new(
            Status::GenericFailure,
            format!(
                "Failed to extract text from PDF: {} (path: {})",
                error,
                path.display()
            ),
        )),
        Err(_) => Err(Error::new(
            Status::GenericFailure,
            format!(
                "Failed to parse PDF file: the document appears to be malformed or encrypted (path: {})",
                path.display()
            ),
        )),
    }
}

/// 打开 OOXML 文档（zip 容器）。文件查看器的幻灯片大纲预览复用。
pub fn open_ooxml_archive(path: &Path) -> napi::Result<zip::ZipArchive<std::io::BufReader<fs::File>>> {
    let file = fs::File::open(path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Failed to open document: {} (path: {})",
                error,
                path.display()
            ),
        )
    })?;

    zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Failed to parse document as OOXML (zip) container: {} (path: {})",
                error,
                path.display()
            ),
        )
    })
}

/// 提取 .docx 正文文本：按 <w:p> 段落换行，收集 <w:t> 文本运行，
/// 处理 <w:tab/> 与 <w:br/>。
fn extract_docx_text(path: &Path) -> napi::Result<String> {
    use std::io::Read as _;

    let mut archive = open_ooxml_archive(path)?;
    let mut entry = archive.by_name("word/document.xml").map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Invalid .docx file, missing word/document.xml: {} (path: {})",
                error,
                path.display()
            ),
        )
    })?;

    let mut xml = String::new();
    entry.read_to_string(&mut xml).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Failed to read word/document.xml: {} (path: {})",
                error,
                path.display()
            ),
        )
    })?;

    let token_re = regex::Regex::new(
        r"(?s)<w:t(?:\s[^>]*)?>(.*?)</w:t>|<w:tab\s*/>|<w:br(?:\s[^>]*)?/>|</w:p>",
    )
    .expect("docx token regex must compile");

    let mut text = String::new();
    for captures in token_re.captures_iter(&xml) {
        if let Some(run) = captures.get(1) {
            text.push_str(&unescape_xml_entities(run.as_str()));
        } else {
            let token = captures.get(0).expect("capture 0 always exists").as_str();
            if token.starts_with("<w:tab") {
                text.push('\t');
            } else {
                // <w:br/> 与 </w:p> 都视为换行
                text.push('\n');
            }
        }
    }

    Ok(text)
}

/// 提取 .pptx 文本：按幻灯片序号顺序收集各页 <a:t> 文本，
/// <a:p> 段落结束视为换行，每页前输出分页标记。
fn extract_pptx_text(path: &Path) -> napi::Result<String> {
    use std::io::Read as _;

    let mut archive = open_ooxml_archive(path)?;

    let mut slide_entries: Vec<(u32, String)> = archive
        .file_names()
        .filter_map(|name| {
            let number = name
                .strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?
                .parse::<u32>()
                .ok()?;
            Some((number, name.to_string()))
        })
        .collect();
    slide_entries.sort_by_key(|(number, _)| *number);

    if slide_entries.is_empty() {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Invalid .pptx file, no slides found under ppt/slides/ (path: {})",
                path.display()
            ),
        ));
    }

    let token_re =
        regex::Regex::new(r"(?s)<a:t>(.*?)</a:t>|</a:p>").expect("pptx token regex must compile");

    let mut text = String::new();
    for (number, entry_name) in slide_entries {
        let mut entry = archive.by_name(&entry_name).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to read {}: {} (path: {})",
                    entry_name,
                    error,
                    path.display()
                ),
            )
        })?;

        let mut xml = String::new();
        entry.read_to_string(&mut xml).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to read {}: {} (path: {})",
                    entry_name,
                    error,
                    path.display()
                ),
            )
        })?;

        text.push_str(&format!("=== Slide {} ===\n", number));
        for captures in token_re.captures_iter(&xml) {
            if let Some(run) = captures.get(1) {
                text.push_str(&unescape_xml_entities(run.as_str()));
            } else {
                text.push('\n');
            }
        }
        text.push('\n');
    }

    Ok(text)
}

/// 提取 Excel 工作簿文本：逐 Sheet 输出，每行记录以 " | " 连接单元格，
/// 跳过空行并裁剪行尾空单元格。支持 xlsx/xls/xlsb/xlsm/ods。
fn extract_excel_text(path: &Path) -> napi::Result<String> {
    use calamine::Reader as _;

    let mut workbook = calamine::open_workbook_auto(path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Failed to open spreadsheet: {} (path: {})",
                error,
                path.display()
            ),
        )
    })?;

    let sheet_names = workbook.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Ok(String::new());
    }

    let mut text = String::new();
    for name in &sheet_names {
        let range = workbook.worksheet_range(name).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to read sheet \"{}\": {} (path: {})",
                    name,
                    error,
                    path.display()
                ),
            )
        })?;

        if sheet_names.len() > 1 {
            text.push_str(&format!("=== Sheet: {} ===\n", name));
        }

        for row in range.rows() {
            let mut cells: Vec<String> = row.iter().map(|cell| cell.to_string()).collect();
            while cells.last().map(|cell| cell.is_empty()) == Some(true) {
                cells.pop();
            }
            if !cells.is_empty() {
                text.push_str(&cells.join(" | "));
                text.push('\n');
            }
        }
    }

    Ok(text)
}

/// 解析 CSV：正确处理带引号字段内的换行/分隔符，
/// 每条记录输出一行，字段间以 " | " 连接。允许行列数不一致。
/// 按字节读取并经编码检测解码，GBK 等非 UTF-8 编码的 CSV 也能正确解析。
fn extract_csv_text(path: &Path) -> napi::Result<String> {
    let bytes = fs::read(path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Failed to open CSV file: {} (path: {})",
                error,
                path.display()
            ),
        )
    })?;
    let text = super::text_codec::decode_text_bytes(&bytes)
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to decode CSV file as text: {} (path: {})",
                    error,
                    path.display()
                ),
            )
        })?
        .text;

    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(std::io::Cursor::new(text));

    let mut text = String::new();
    for record in reader.records() {
        let record = record.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to parse CSV record: {} (path: {})",
                    error,
                    path.display()
                ),
            )
        })?;

        let mut cells: Vec<&str> = record.iter().collect();
        while cells.last().map(|cell| cell.trim().is_empty()) == Some(true) {
            cells.pop();
        }
        text.push_str(&cells.join(" | "));
        text.push('\n');
    }

    Ok(text)
}

/// 还原 XML 实体引用（命名实体与十进制/十六进制数字实体）。
pub fn unescape_xml_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }

    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '&' {
            result.push(ch);
            continue;
        }

        let mut entity = String::new();
        let mut terminated = false;
        for next in chars.by_ref() {
            if next == ';' {
                terminated = true;
                break;
            }
            entity.push(next);
            if entity.len() > 10 {
                break;
            }
        }

        if !terminated {
            result.push('&');
            result.push_str(&entity);
            continue;
        }

        match entity.as_str() {
            "amp" => result.push('&'),
            "lt" => result.push('<'),
            "gt" => result.push('>'),
            "quot" => result.push('"'),
            "apos" => result.push('\''),
            _ => {
                let code_point = entity.strip_prefix('#').and_then(|digits| {
                    if let Some(hex) = digits
                        .strip_prefix('x')
                        .or_else(|| digits.strip_prefix('X'))
                    {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        digits.parse::<u32>().ok()
                    }
                });
                match code_point.and_then(char::from_u32) {
                    Some(resolved) => result.push(resolved),
                    None => {
                        result.push('&');
                        result.push_str(&entity);
                        result.push(';');
                    }
                }
            }
        }
    }

    result
}
