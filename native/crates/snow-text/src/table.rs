//! Markdown 表格导出（CSV / XLSX）NAPI 导出。
//!
//! 渲染层从 DOM 提取表格二维数据（行 × 列的字符串矩阵，JSON 编码），
//! 主进程调用这里生成目标格式的文件字节（xlsx 为 zip 二进制），
//! 再弹出保存对话框写入用户选择的路径。
//! 生成过程放在 `tokio::task::spawn_blocking` 中执行，不阻塞 Node.js
//! 事件循环。

use napi::bindgen_prelude::*;
use rust_xlsxwriter::{Format, Workbook, XlsxError};

/// Excel 单元格文本上限（Excel 规范 32767 字符），超长内容截断避免保存失败。
const CELL_MAX_CHARS: usize = 32767;

/// 数值单元格识别的最大字符数：更长的数字文本（如长 ID）按文本写，
/// 避免 f64 精度丢失改变原始值。
const NUMBER_MAX_CHARS: usize = 15;

/// 列宽估算的上下限（字符宽度单位）。
const COLUMN_WIDTH_MIN: f64 = 8.0;
const COLUMN_WIDTH_MAX: f64 = 60.0;

/// 将表格数据导出为 CSV 或 XLSX 文件字节。
///
/// `format` 为 `"csv"` / `"xlsx"`；`rowsJson` 是二维字符串数组。
pub async fn export_markdown_table(format: String, rows_json: String) -> napi::Result<Buffer> {
    tokio::task::spawn_blocking(move || -> napi::Result<Vec<u8>> {
        let rows: Vec<Vec<String>> = serde_json::from_str(&rows_json).map_err(|error| {
            Error::new(
                Status::InvalidArg,
                format!("Invalid table rows JSON: {error}"),
            )
        })?;

        match format.as_str() {
            "csv" => build_csv(&rows),
            "xlsx" => build_xlsx(&rows),
            other => Err(Error::new(
                Status::InvalidArg,
                format!("Unsupported table export format: {other}"),
            )),
        }
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to export markdown table: {error}"),
        )
    })?
    .map(Buffer::from)
}

/// 生成 CSV 字节：RFC 4180 转义由 csv crate 处理，输出带 UTF-8 BOM，
/// Excel 才会把文件按 UTF-8 打开（否则中文按 ANSI 解析为乱码）。
fn build_csv(rows: &[Vec<String>]) -> napi::Result<Vec<u8>> {
    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(Vec::new());

    for row in rows {
        writer.write_record(row).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to write CSV table: {error}"),
            )
        })?;
    }

    let body = writer.into_inner().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write CSV table: {}", error.into_error()),
        )
    })?;

    let mut bytes = Vec::with_capacity(body.len() + 3);
    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bytes.extend_from_slice(&body);
    Ok(bytes)
}

/// 生成 XLSX 字节：首行加粗（Markdown 表格首行为表头），规范数字写成数值
/// 单元格方便 Excel 直接计算，列宽按内容估算。
fn build_xlsx(rows: &[Vec<String>]) -> napi::Result<Vec<u8>> {
    let mut workbook = Workbook::new();
    let header_format = Format::new().set_bold();
    let worksheet = workbook.add_worksheet();

    let mut column_widths: Vec<f64> = Vec::new();

    for (row_index, row) in rows.iter().enumerate() {
        let row_index = row_index as u32;
        for (column_index, cell) in row.iter().enumerate() {
            let column_index = column_index as u16;
            let column = column_index as usize;
            if column_widths.len() <= column {
                column_widths.resize(column + 1, 0.0);
            }
            column_widths[column] = column_widths[column].max(text_display_width(cell));

            if cell.is_empty() {
                continue;
            }
            let text = truncate_cell(cell);
            let written = if row_index == 0 {
                worksheet.write_string_with_format(row_index, column_index, &text, &header_format)
            } else if let Some(number) = parse_excel_number(&text) {
                worksheet.write_number(row_index, column_index, number)
            } else {
                worksheet.write_string(row_index, column_index, &text)
            };
            written.map_err(xlsx_error)?;
        }
    }

    for (column_index, width) in column_widths.iter().enumerate() {
        let width = (width + 2.0).clamp(COLUMN_WIDTH_MIN, COLUMN_WIDTH_MAX);
        worksheet
            .set_column_width(column_index as u16, width)
            .map_err(xlsx_error)?;
    }

    workbook.save_to_buffer().map_err(xlsx_error)
}

fn xlsx_error(error: XlsxError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Failed to write XLSX table: {error}"),
    )
}

/// 估算文本在 Excel 中的显示宽度：ASCII 记 1，其余字符（CJK 等）记 2。
fn text_display_width(text: &str) -> f64 {
    text.chars()
        .map(|ch| if ch.is_ascii() { 1.0 } else { 2.0 })
        .sum()
}

/// 截断超长单元格到 Excel 允许的最大字符数（按字符截断，不切开 UTF-8）。
fn truncate_cell(text: &str) -> String {
    if text.chars().count() <= CELL_MAX_CHARS {
        return text.to_string();
    }
    text.chars().take(CELL_MAX_CHARS).collect()
}

/// 仅把规范的十进制数字文本写成数值单元格："007"（前导零）、"1,000"、
/// "1e5"、超长 ID 等一律保留为文本，避免 Excel 改变原始展示或丢失精度。
fn parse_excel_number(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > NUMBER_MAX_CHARS {
        return None;
    }
    let digits = bytes.strip_prefix(b"-").unwrap_or(bytes);
    // 拒绝前导零（"007"、"01.5"），单独的 "0" 与 "0.x" 除外。
    if digits.len() > 1 && digits[0] == b'0' && digits[1] != b'.' {
        return None;
    }
    let mut seen_dot = false;
    let mut seen_digit = false;
    for &byte in digits {
        match byte {
            b'0'..=b'9' => seen_digit = true,
            b'.' if !seen_dot => seen_dot = true,
            _ => return None,
        }
    }
    if !seen_digit {
        return None;
    }
    text.parse::<f64>().ok()
}
