//! Office 文档文本提取。
//!
//! 通过扩展名识别文档类型并提取纯文本，供 read 工具以带行号文本的形式返回：
//! - pdf: 使用 pdf-extract 提取全文
//! - docx/pptx: 作为 OOXML(zip) 容器解包后按标签提取文本运行
//! - xlsx/xls/xlsb/xlsm/ods: 使用 calamine 逐 Sheet 读取
//! - csv: 使用 csv crate 正确解析带引号字段（字段内可含换行/分隔符），
//!        读取时经编码检测解码，支持 GBK 等非 UTF-8 编码的 CSV
//! - doc/ppt（旧版二进制格式）: 无法直接解析，返回引导性错误
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
    /// 旧版二进制格式（.doc / .ppt），无法直接解析，返回引导性错误。
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
    if let OfficeDocKind::LegacyBinary = kind {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Legacy binary Office format (.doc/.ppt) is not supported (path: {}). Please convert it to .docx, .pptx or .pdf first.",
                path.display()
            ),
        ));
    }

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
        OfficeDocKind::LegacyBinary => unreachable!(),
    };

    Ok(text.trim_end().to_string())
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

/// 打开 OOXML 文档（zip 容器）。
fn open_ooxml_archive(path: &Path) -> napi::Result<zip::ZipArchive<std::io::BufReader<fs::File>>> {
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
fn unescape_xml_entities(text: &str) -> String {
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
