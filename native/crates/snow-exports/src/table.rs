//! Markdown 表格导出 napi 壳。

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub async fn export_markdown_table(format: String, rows_json: String) -> napi::Result<Buffer> {
    snow_text::table::export_markdown_table(format, rows_json).await
}
