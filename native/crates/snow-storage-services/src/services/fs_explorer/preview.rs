//! 右侧文件查看器的结构化只读预览。
//!
//! 统一返回判别式结果 `FilePreviewResult`：
//! - `ready`：已生成结构化预览（表格 / 数据库 / 幻灯片大纲），或 DOCX
//!   的原始字节（由渲染层的 docx-preview 渲染）；
//! - `unavailable`：带枚举原因（not_found / unsupported / too_large /
//!   format_mismatch / parse_failed / read_failed）与原始细节，渲染层据此本地化；
//! - `passthrough`：不属于结构化预览范围且未超限，渲染层继续走 `read_file_content`。
//!
//! 所有解析都是同步 CPU/IO 操作，只能在 tokio 阻塞线程池中调用；
//! 文档与数据库一律只读打开（SQLite 使用 `mode=ro&immutable=1`），不写回原文件。

use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use super::{preview_document_kind, MAX_DOCUMENT_INPUT_BYTES, MAX_RAW_TEXT_READ_BYTES};
use snow_text::office::{open_ooxml_archive, unescape_xml_entities};

/// DOCX 在渲染进程主线程解析，上限与抽取文本保持一致。
const MAX_DOCX_BYTES: u64 = MAX_DOCUMENT_INPUT_BYTES;
/// calamine 会把整张工作表载入内存，限制输入大小避免内存放大。
const MAX_SPREADSHEET_BYTES: u64 = 50 * 1024 * 1024;
/// PPTX 只解压幻灯片 XML，输入上限与工具侧 Office 解析一致。
const MAX_SLIDES_BYTES: u64 = 200 * 1024 * 1024;
/// 单个幻灯片 XML 解压后的上限，防止 zip 炸弹。
const MAX_SLIDE_XML_BYTES: u64 = 16 * 1024 * 1024;

const MAX_SHEET_ROWS: usize = 500;
const MAX_TABLE_ROWS: usize = 200;
const MAX_GRID_COLUMNS: usize = 100;
const MAX_CELL_CHARS: usize = 1000;
const MAX_DATABASE_TABLES: usize = 500;
const MAX_SLIDES: usize = 500;
const MAX_SLIDE_BLOCK_CHARS: usize = 4000;
/// 单次数据库查询的超时：复杂视图可能很慢，到时中断查询。
const DATABASE_QUERY_TIMEOUT: Duration = Duration::from_secs(5);

const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
const SIGNATURE_BYTES: usize = 16;

#[napi(object)]
pub struct PreviewColumn {
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    pub primary_key: bool,
}

#[napi(object)]
pub struct PreviewTable {
    pub name: String,
    /// "table" | "view"
    pub kind: String,
    pub columns: Vec<PreviewColumn>,
}

/// 合并区域，坐标相对于 `PreviewGrid.rows`（已裁剪到可见窗口）。
#[napi(object)]
pub struct PreviewMerge {
    pub row: u32,
    pub column: u32,
    pub row_span: u32,
    pub column_span: u32,
}

#[napi(object)]
pub struct PreviewGrid {
    pub name: String,
    /// 数据库列名；工作表为空数组（渲染层按列号生成 A/B/C 表头）。
    pub headers: Vec<String>,
    /// 工作表数据区左上角在表内的绝对行/列（0 起），用于显示真实行号与列号。
    pub row_offset: u32,
    pub column_offset: u32,
    pub rows: Vec<Vec<Option<String>>>,
    /// 工作表的数据区总行数；数据库不做 COUNT，固定为 -1。
    pub total_rows: i64,
    pub total_columns: i64,
    pub truncated_rows: bool,
    pub truncated_columns: bool,
    /// 本次读取的行数上限（工作表 500，数据表 200）。
    pub row_limit: u32,
    pub merges: Vec<PreviewMerge>,
}

#[napi(object)]
pub struct PreviewSlide {
    pub index: u32,
    pub title: String,
    pub blocks: Vec<String>,
    pub hidden: bool,
}

#[napi(object)]
pub struct FilePreviewResult {
    /// "ready" | "unavailable" | "passthrough"
    pub status: String,
    /// "spreadsheet" | "database" | "slides" | "docx"；非结构化预览为空串
    pub kind: String,
    /// unavailable 原因："not_found" | "unsupported" | "too_large" |
    /// "format_mismatch" | "parse_failed" | "read_failed"；其余状态为空串
    pub reason: String,
    /// 原始错误细节（仅用于折叠展示，渲染层不解析）。
    pub detail: String,
    /// 文件头前 16 字节的十六进制（format_mismatch 时提供）。
    pub signature: String,
    pub size: i64,
    /// too_large 时对应的上限字节数，其余为 0。
    pub limit: i64,
    /// 是否可切换到「抽取文本」视图（复用 read_file_content 的文档抽取）。
    pub text_available: bool,
    pub sheets: Vec<String>,
    pub tables: Vec<PreviewTable>,
    pub truncated_tables: bool,
    /// 当前工作表 / 数据表的单元格数据。
    pub grid: Option<PreviewGrid>,
    /// 当前工作表 / 数据表读取失败的原始原因（列表仍可用）。
    pub grid_error: String,
    pub slides: Vec<PreviewSlide>,
    pub truncated_slides: bool,
    /// SQLite 存在非空 -wal 文件：immutable 只读打开看不到其中未合并的写入。
    pub wal_pending: bool,
    /// DOCX 的原始字节。
    pub data: Option<Buffer>,
}

#[derive(Clone, Copy)]
enum PreviewKind {
    Spreadsheet,
    Database,
    Slides,
    Docx,
}

impl PreviewKind {
    fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_lowercase();
        match ext.as_str() {
            "xlsx" | "xls" | "xlsb" | "xlsm" | "ods" => Some(Self::Spreadsheet),
            "db" | "sqlite" | "sqlite3" | "db3" => Some(Self::Database),
            "pptx" => Some(Self::Slides),
            "docx" => Some(Self::Docx),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Spreadsheet => "spreadsheet",
            Self::Database => "database",
            Self::Slides => "slides",
            Self::Docx => "docx",
        }
    }

    /// 数据库按需查询，不受文件大小限制。
    fn input_limit(self) -> Option<u64> {
        match self {
            Self::Spreadsheet => Some(MAX_SPREADSHEET_BYTES),
            Self::Database => None,
            Self::Slides => Some(MAX_SLIDES_BYTES),
            Self::Docx => Some(MAX_DOCX_BYTES),
        }
    }
}

impl FilePreviewResult {
    fn new(status: &str, kind: &str, size: u64) -> Self {
        Self {
            status: status.to_string(),
            kind: kind.to_string(),
            reason: String::new(),
            detail: String::new(),
            signature: String::new(),
            size: size as i64,
            limit: 0,
            text_available: false,
            sheets: Vec::new(),
            tables: Vec::new(),
            truncated_tables: false,
            grid: None,
            grid_error: String::new(),
            slides: Vec::new(),
            truncated_slides: false,
            wal_pending: false,
            data: None,
        }
    }

    fn unavailable(kind: &str, reason: &str, size: u64, detail: impl Into<String>) -> Self {
        let mut result = Self::new("unavailable", kind, size);
        result.reason = reason.to_string();
        result.detail = detail.into();
        result
    }

    fn too_large(kind: &str, size: u64, limit: u64) -> Self {
        let mut result = Self::unavailable(kind, "too_large", size, String::new());
        result.limit = limit as i64;
        result
    }

    fn format_mismatch(kind: &str, size: u64, signature: &[u8]) -> Self {
        let mut result = Self::unavailable(kind, "format_mismatch", size, String::new());
        result.signature = hex_bytes(signature, " ");
        result
    }
}

/// 生成文件预览。`section` 指定工作表名 / 数据表名，缺省取第一个。
pub fn read_file_preview(file_path: &str, section: Option<&str>) -> FilePreviewResult {
    let path = Path::new(file_path);
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return FilePreviewResult::unavailable("", "not_found", 0, error.to_string());
        }
        Err(error) => {
            return FilePreviewResult::unavailable("", "read_failed", 0, error.to_string());
        }
    };
    let size = metadata.len();
    if !metadata.is_file() {
        return FilePreviewResult::unavailable("", "unsupported", size, String::new());
    }

    let Some(kind) = PreviewKind::from_path(path) else {
        // 与 read_file_content 的读取上限保持一致：文档抽取 20 MiB，原始文本 64 MiB。
        let limit = if preview_document_kind(path).is_some() {
            MAX_DOCUMENT_INPUT_BYTES
        } else {
            MAX_RAW_TEXT_READ_BYTES
        };
        if size > limit {
            return FilePreviewResult::too_large("", size, limit);
        }
        return FilePreviewResult::new("passthrough", "", size);
    };

    let kind_name = kind.name();
    if let Some(limit) = kind.input_limit() {
        if size > limit {
            return FilePreviewResult::too_large(kind_name, size, limit);
        }
    }

    let mut result = match kind {
        PreviewKind::Spreadsheet => build_spreadsheet(path, size, section),
        PreviewKind::Database => build_database(path, size, section),
        PreviewKind::Slides => build_slides(path, size),
        PreviewKind::Docx => build_binary_document(path, size, kind),
    };
    result.text_available =
        preview_document_kind(path).is_some() && size <= MAX_DOCUMENT_INPUT_BYTES;
    result
}

fn read_signature(path: &Path, len: usize) -> std::io::Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    let mut buffer = Vec::with_capacity(len);
    file.take(len as u64).read_to_end(&mut buffer)?;
    Ok(buffer)
}

fn hex_bytes(bytes: &[u8], separator: &str) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(separator)
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

// ============================================================================
// DOCX：校验文件头后返回原始字节
// ============================================================================

fn build_binary_document(path: &Path, size: u64, kind: PreviewKind) -> FilePreviewResult {
    let kind_name = kind.name();
    let head = match read_signature(path, SIGNATURE_BYTES) {
        Ok(head) => head,
        Err(error) => {
            return FilePreviewResult::unavailable(kind_name, "read_failed", size, error.to_string());
        }
    };
    if !head.starts_with(b"PK\x03\x04") {
        let signature = &head[..head.len().min(SIGNATURE_BYTES)];
        return FilePreviewResult::format_mismatch(kind_name, size, signature);
    }

    match fs::read(path) {
        Ok(bytes) => {
            let mut result = FilePreviewResult::new("ready", kind_name, size);
            result.data = Some(Buffer::from(bytes));
            result
        }
        Err(error) => {
            FilePreviewResult::unavailable(kind_name, "read_failed", size, error.to_string())
        }
    }
}

// ============================================================================
// 工作表：calamine 读取单元格值与合并区域
// ============================================================================

fn build_spreadsheet(path: &Path, size: u64, section: Option<&str>) -> FilePreviewResult {
    use calamine::{Data, Reader, Sheets};

    let kind_name = PreviewKind::Spreadsheet.name();
    let mut workbook = match calamine::open_workbook_auto(path) {
        Ok(workbook) => workbook,
        Err(error) => {
            return FilePreviewResult::unavailable(kind_name, "parse_failed", size, error.to_string());
        }
    };
    let sheet_names = workbook.sheet_names();
    let Some(first_sheet) = sheet_names.first() else {
        return FilePreviewResult::unavailable(
            kind_name,
            "parse_failed",
            size,
            "Workbook contains no worksheets",
        );
    };
    let active = section
        .filter(|name| sheet_names.iter().any(|sheet| sheet == name))
        .unwrap_or(first_sheet.as_str())
        .to_string();

    let mut result = FilePreviewResult::new("ready", kind_name, size);
    result.sheets = sheet_names.clone();

    let range = match workbook.worksheet_range(&active) {
        Ok(range) => range,
        Err(error) => {
            result.grid_error = error.to_string();
            return result;
        }
    };
    // 合并区域只是展示增强：读取失败时仍展示单元格值。
    let merge_cells = match &mut workbook {
        Sheets::Xlsx(xlsx) => xlsx.merge_cells_by_sheet_name(&active).unwrap_or_default(),
        Sheets::Xls(xls) => xls.merge_cells_by_sheet_name(&active).unwrap_or_default(),
        Sheets::Xlsb(_) | Sheets::Ods(_) => Vec::new(),
    };

    let (row_offset, column_offset) = range.start().unwrap_or((0, 0));
    let (height, width) = range.get_size();
    let visible_rows = height.min(MAX_SHEET_ROWS);
    let visible_columns = width.min(MAX_GRID_COLUMNS);

    let rows = range
        .rows()
        .take(visible_rows)
        .map(|row| {
            row.iter()
                .take(visible_columns)
                .map(|cell| match cell {
                    Data::Empty => None,
                    other => Some(truncate_chars(&other.to_string(), MAX_CELL_CHARS)),
                })
                .collect()
        })
        .collect();

    let merges = merge_cells
        .iter()
        .filter_map(|dimensions| {
            let start_row = dimensions.start.0.checked_sub(row_offset)? as usize;
            let start_column = dimensions.start.1.checked_sub(column_offset)? as usize;
            let end_row = (dimensions.end.0.checked_sub(row_offset)? as usize).min(visible_rows.checked_sub(1)?);
            let end_column = (dimensions.end.1.checked_sub(column_offset)? as usize)
                .min(visible_columns.checked_sub(1)?);
            if start_row > end_row || start_column > end_column {
                return None;
            }
            let row_span = end_row - start_row + 1;
            let column_span = end_column - start_column + 1;
            if row_span == 1 && column_span == 1 {
                return None;
            }
            Some(PreviewMerge {
                row: start_row as u32,
                column: start_column as u32,
                row_span: row_span as u32,
                column_span: column_span as u32,
            })
        })
        .collect();

    result.grid = Some(PreviewGrid {
        name: active,
        headers: Vec::new(),
        row_offset,
        column_offset,
        rows,
        total_rows: height as i64,
        total_columns: width as i64,
        truncated_rows: height > visible_rows,
        truncated_columns: width > visible_columns,
        row_limit: MAX_SHEET_ROWS as u32,
        merges,
    });
    result
}

// ============================================================================
// SQLite：只读 + immutable 打开，列出表/视图结构并按需读取前 N 行
// ============================================================================

fn build_database(path: &Path, size: u64, section: Option<&str>) -> FilePreviewResult {
    use rusqlite::{Connection, OpenFlags};

    let kind_name = PreviewKind::Database.name();
    // 0 字节文件是合法的空 SQLite 库。
    if size == 0 {
        return FilePreviewResult::new("ready", kind_name, size);
    }
    let head = match read_signature(path, SIGNATURE_BYTES) {
        Ok(head) => head,
        Err(error) => {
            return FilePreviewResult::unavailable(kind_name, "read_failed", size, error.to_string());
        }
    };
    if head.as_slice() != SQLITE_HEADER.as_slice() {
        return FilePreviewResult::format_mismatch(kind_name, size, &head);
    }

    let connection = match Connection::open_with_flags(
        sqlite_readonly_uri(path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => {
            return FilePreviewResult::unavailable(kind_name, "parse_failed", size, error.to_string());
        }
    };

    let mut result = FilePreviewResult::new("ready", kind_name, size);
    result.wal_pending = sqlite_wal_pending(path);

    let objects = match list_database_objects(&connection) {
        Ok(objects) => objects,
        Err(error) => {
            return FilePreviewResult::unavailable(kind_name, "parse_failed", size, error.to_string());
        }
    };
    result.truncated_tables = objects.len() > MAX_DATABASE_TABLES;
    result.tables = objects
        .into_iter()
        .take(MAX_DATABASE_TABLES)
        .map(|(name, kind)| {
            let columns = read_table_columns(&connection, &name);
            PreviewTable { name, kind, columns }
        })
        .collect();

    let active = section
        .and_then(|name| result.tables.iter().find(|table| table.name == name))
        .or_else(|| result.tables.first())
        .map(|table| table.name.clone());
    if let Some(active) = active {
        match with_query_deadline(&connection, || read_table_rows(&connection, &active)) {
            Ok(grid) => result.grid = Some(grid),
            Err(error) => result.grid_error = error.to_string(),
        }
    }
    result
}

/// 构造只读 SQLite URI：`mode=ro&immutable=1` 不创建 -wal/-shm、不加锁、不写回。
fn sqlite_readonly_uri(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let mut encoded = String::with_capacity(raw.len() + 16);
    for ch in raw.chars() {
        match ch {
            '%' => encoded.push_str("%25"),
            '?' => encoded.push_str("%3F"),
            '#' => encoded.push_str("%23"),
            ' ' => encoded.push_str("%20"),
            other => encoded.push(other),
        }
    }
    let prefix = if encoded.starts_with('/') { "file://" } else { "file:///" };
    format!("{prefix}{encoded}?mode=ro&immutable=1")
}

fn sqlite_wal_pending(path: &Path) -> bool {
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    fs::metadata(Path::new(&wal))
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
}

fn list_database_objects(connection: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut statement = connection.prepare(
        "SELECT name, type FROM sqlite_master \
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
         ORDER BY type, name LIMIT ?1",
    )?;
    let rows = statement.query_map([(MAX_DATABASE_TABLES + 1) as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect()
}

/// 读取列结构；虚拟表等无法解析结构时返回空列表（行数据读取会给出具体原因）。
fn read_table_columns(connection: &rusqlite::Connection, table: &str) -> Vec<PreviewColumn> {
    let read = || -> rusqlite::Result<Vec<PreviewColumn>> {
        let mut statement = connection
            .prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?1)")?;
        let rows = statement.query_map([table], |row| {
            Ok(PreviewColumn {
                name: row.get(0)?,
                data_type: row.get(1)?,
                not_null: row.get::<_, i64>(2)? != 0,
                primary_key: row.get::<_, i64>(3)? != 0,
            })
        })?;
        rows.collect()
    };
    read().unwrap_or_default()
}

fn read_table_rows(connection: &rusqlite::Connection, table: &str) -> rusqlite::Result<PreviewGrid> {
    use rusqlite::types::ValueRef;

    let sql = format!(
        "SELECT * FROM \"{}\" LIMIT {}",
        table.replace('"', "\"\""),
        MAX_TABLE_ROWS + 1
    );
    let mut statement = connection.prepare(&sql)?;
    let column_count = statement.column_count();
    let visible_columns = column_count.min(MAX_GRID_COLUMNS);
    let headers = statement
        .column_names()
        .into_iter()
        .take(visible_columns)
        .map(str::to_string)
        .collect();

    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut truncated_rows = false;
    let mut query = statement.query([])?;
    while let Some(row) = query.next()? {
        if rows.len() == MAX_TABLE_ROWS {
            truncated_rows = true;
            break;
        }
        let mut cells = Vec::with_capacity(visible_columns);
        for index in 0..visible_columns {
            let cell = match row.get_ref(index)? {
                ValueRef::Null => None,
                ValueRef::Integer(value) => Some(value.to_string()),
                ValueRef::Real(value) => Some(value.to_string()),
                ValueRef::Text(bytes) => Some(truncate_chars(
                    &String::from_utf8_lossy(bytes),
                    MAX_CELL_CHARS,
                )),
                ValueRef::Blob(bytes) => {
                    let head = hex_bytes(&bytes[..bytes.len().min(SIGNATURE_BYTES)], "");
                    let ellipsis = if bytes.len() > SIGNATURE_BYTES { "…" } else { "" };
                    Some(format!("x'{head}{ellipsis}' ({} B)", bytes.len()))
                }
            };
            cells.push(cell);
        }
        rows.push(cells);
    }

    Ok(PreviewGrid {
        name: table.to_string(),
        headers,
        row_offset: 0,
        column_offset: 0,
        rows,
        total_rows: -1,
        total_columns: column_count as i64,
        truncated_rows,
        truncated_columns: column_count > visible_columns,
        row_limit: MAX_TABLE_ROWS as u32,
        merges: Vec::new(),
    })
}

/// 在超时后中断当前连接上的查询；查询先结束时看门狗随通道断开立即退出。
fn with_query_deadline<T>(connection: &rusqlite::Connection, run: impl FnOnce() -> T) -> T {
    let interrupt = connection.get_interrupt_handle();
    let (done, wait) = mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        if let Err(mpsc::RecvTimeoutError::Timeout) = wait.recv_timeout(DATABASE_QUERY_TIMEOUT) {
            interrupt.interrupt();
        }
    });
    let output = run();
    drop(done);
    let _ = watchdog.join();
    output
}

// ============================================================================
// 幻灯片：按演示文稿顺序提取标题与文本块
// ============================================================================

fn build_slides(path: &Path, size: u64) -> FilePreviewResult {
    let kind_name = PreviewKind::Slides.name();
    let mut archive = match open_ooxml_archive(path) {
        Ok(archive) => archive,
        Err(error) => {
            return FilePreviewResult::unavailable(
                kind_name,
                "parse_failed",
                size,
                error.reason.clone(),
            );
        }
    };

    let entries = slide_entries(&mut archive);
    if entries.is_empty() {
        return FilePreviewResult::unavailable(
            kind_name,
            "parse_failed",
            size,
            "No slides found under ppt/slides/",
        );
    }

    let shape_re = regex::Regex::new(
        r"(?s)<p:sp\b[^>]*>.*?</p:sp>|<p:graphicFrame\b[^>]*>.*?</p:graphicFrame>",
    )
    .expect("pptx shape regex must compile");
    let title_re = regex::Regex::new(r#"<p:ph\b[^>]*\btype="(?:title|ctrTitle)""#)
        .expect("pptx title regex must compile");
    let hidden_re =
        regex::Regex::new(r#"<p:sld\b[^>]*\bshow="0""#).expect("pptx hidden regex must compile");
    let token_re = regex::Regex::new(
        r"(?s)<a:t(?:\s[^>]*)?>(.*?)</a:t>|<a:br\b[^>]*/>|</a:p>|</a:tc>|</a:tr>",
    )
    .expect("pptx token regex must compile");

    let mut result = FilePreviewResult::new("ready", kind_name, size);
    result.truncated_slides = entries.len() > MAX_SLIDES;
    for (position, entry_name) in entries.iter().take(MAX_SLIDES).enumerate() {
        let xml = match read_zip_text(&mut archive, entry_name) {
            Ok(xml) => xml,
            Err(error) => {
                return FilePreviewResult::unavailable(kind_name, "parse_failed", size, error);
            }
        };

        let mut title = String::new();
        let mut blocks = Vec::new();
        for shape in shape_re.find_iter(&xml) {
            let shape = shape.as_str();
            let text = shape_text(shape, &token_re);
            if text.is_empty() {
                continue;
            }
            if title.is_empty() && title_re.is_match(shape) {
                title = text.split_whitespace().collect::<Vec<_>>().join(" ");
            } else {
                blocks.push(truncate_chars(&text, MAX_SLIDE_BLOCK_CHARS));
            }
        }
        result.slides.push(PreviewSlide {
            index: (position + 1) as u32,
            title,
            blocks,
            hidden: hidden_re.is_match(&xml),
        });
    }
    result
}

/// 幻灯片条目按 presentation.xml 的 sldIdLst 顺序排列；
/// 关系解析失败时退回到 slideN.xml 的编号顺序。
fn slide_entries<R: std::io::Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> Vec<String> {
    let ordered = read_zip_text(archive, "ppt/presentation.xml")
        .ok()
        .zip(read_zip_text(archive, "ppt/_rels/presentation.xml.rels").ok())
        .map(|(presentation, relationships)| {
            let slide_id_re = regex::Regex::new(r#"<p:sldId\b[^>]*\br:id="([^"]+)""#)
                .expect("pptx slide id regex must compile");
            let relationship_re = regex::Regex::new(r"<Relationship\b[^>]*>")
                .expect("pptx relationship regex must compile");
            let id_re = regex::Regex::new(r#"\bId="([^"]+)""#).expect("rel id regex must compile");
            let target_re =
                regex::Regex::new(r#"\bTarget="([^"]+)""#).expect("rel target regex must compile");

            let targets: std::collections::HashMap<String, String> = relationship_re
                .find_iter(&relationships)
                .filter_map(|tag| {
                    let tag = tag.as_str();
                    let id = id_re.captures(tag)?.get(1)?.as_str().to_string();
                    let target = target_re.captures(tag)?.get(1)?.as_str();
                    let entry = match target.strip_prefix('/') {
                        Some(absolute) => absolute.to_string(),
                        None => format!("ppt/{target}"),
                    };
                    Some((id, entry))
                })
                .collect();

            slide_id_re
                .captures_iter(&presentation)
                .filter_map(|captures| targets.get(captures.get(1)?.as_str()).cloned())
                .filter(|entry| archive.index_for_name(entry).is_some())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !ordered.is_empty() {
        return ordered;
    }

    let mut numbered: Vec<(u32, String)> = archive
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
    numbered.sort_by_key(|(number, _)| *number);
    numbered.into_iter().map(|(_, name)| name).collect()
}

fn read_zip_text<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<String, String> {
    let entry = archive
        .by_name(name)
        .map_err(|error| format!("Failed to read {name}: {error}"))?;
    let mut bytes = Vec::new();
    entry
        .take(MAX_SLIDE_XML_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read {name}: {error}"))?;
    if bytes.len() as u64 > MAX_SLIDE_XML_BYTES {
        return Err(format!(
            "{name} exceeds the {} MiB XML limit",
            MAX_SLIDE_XML_BYTES / 1024 / 1024
        ));
    }
    String::from_utf8(bytes).map_err(|error| format!("{name} is not valid UTF-8: {error}"))
}

/// 提取形状 / 表格框中的文本：段落换行，表格单元格以 " | " 分隔、行换行。
fn shape_text(shape: &str, token_re: &regex::Regex) -> String {
    let mut text = String::new();
    for captures in token_re.captures_iter(shape) {
        if let Some(run) = captures.get(1) {
            text.push_str(&unescape_xml_entities(run.as_str()));
            continue;
        }
        let token = captures.get(0).map(|m| m.as_str()).unwrap_or_default();
        match token {
            "</a:tc>" => {
                let trimmed = text.trim_end().len();
                text.truncate(trimmed);
                text.push_str(" | ");
            }
            "</a:tr>" => {
                let trimmed = text.trim_end_matches([' ', '|']).len();
                text.truncate(trimmed);
                text.push('\n');
            }
            _ => text.push('\n'),
        }
    }

    let mut lines: Vec<&str> = Vec::new();
    for line in text.lines().map(str::trim_end) {
        if line.trim().is_empty() && lines.last().is_none_or(|last| last.trim().is_empty()) {
            continue;
        }
        lines.push(line);
    }
    lines.join("\n").trim().to_string()
}
