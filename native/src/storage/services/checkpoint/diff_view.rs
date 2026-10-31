//! 检查点 diff 的摘要统计与分页明细。
//!
//! 打开会话、回滚弹窗只需要每个文件的变更类型与增删行数；diff 正文只在
//! 用户点开某个文件时按页生成。两条路径都不把文件整读进内存：
//! - 按 64KB 分块扫描文件，逐行记录 64 位内容哈希与行首偏移（行尾 CRLF
//!   归一为 LF，与旧版整文本归一化等价）；
//! - 在哈希序列上做 Myers 比对，带截止时间，超时退化为粗粒度结果；
//! - 明细按「展示行」分页，只读取当前页涉及的行，页内重新生成 hunk 头，
//!   各页按顺序拼接后仍是合法的 unified diff。

use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::Hasher;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use similar::{capture_diff_slices_deadline, group_diff_ops, Algorithm, DiffOp, DiffTag};

const SCAN_CHUNK_SIZE: usize = 64 * 1024;
/// unified diff 的上下文行数（与旧版 TextDiff 输出一致）。
const CONTEXT_RADIUS: usize = 3;
/// 摘要统计的比对截止时间：超时后 Myers 退化为粗粒度结果，统计仍然成立。
const STATS_DEADLINE: Duration = Duration::from_secs(2);
/// 明细比对的截止时间。
const PLAN_DEADLINE: Duration = Duration::from_secs(5);
/// 单个展示行读取的字节上限：超长行（压缩产物、单行 SQL）截断显示。
const MAX_ROW_BYTES: u64 = 16 * 1024;
const ROW_TRUNCATED_SUFFIX: &str = " …";
const NO_NEWLINE_HINT: &str = "\\ No newline at end of file";
/// 单页请求参数的取值范围。
const PAGE_ROWS_RANGE: (u32, u32) = (1, 5000);
const PAGE_BYTES_RANGE: (u32, u32) = (4 * 1024, 2 * 1024 * 1024);

/// SSH 工作区的文件内容经 SFTP + JSON(base64) 整体传输，超过此大小不读取
/// 内容（无行数统计、不提供明细），避免把超大文件整份搬进主进程。
pub(crate) const REMOTE_DIFF_CONTENT_LIMIT: u64 = 32 * 1024 * 1024;

/// 回滚链上一个文件的变更摘要（不含 diff 正文）。
#[napi(object)]
pub struct CheckpointFileSummary {
    pub path: String,
    pub change_type: String,
    pub is_binary: bool,
    /// SSH 工作区中超过传输上限、未读取内容的文件：无行数统计、不提供明细。
    pub too_large: bool,
    pub additions: u32,
    pub deletions: u32,
}

/// 单个文件 diff 明细的一页。
#[napi(object)]
pub struct CheckpointDiffPage {
    pub is_binary: bool,
    pub too_large: bool,
    /// 本页 unified diff 文本（首页带文件头），按顺序拼接各页即完整 diff。
    pub content: String,
    /// 展示行总数（不含文件头与 hunk 头）。
    pub total_rows: u32,
    /// 下一页的起始行；等于 total_rows 表示已读完。
    pub next_row: u32,
    /// 内容版本：基线或当前文件变化后改变，调用方据此丢弃已加载的页。
    pub revision: String,
}

/// 行内容来源：本地文件（工作区文件 / 对象库对象）或内存字节（Git 基线、
/// SSH 远程内容）。
#[derive(Clone)]
pub(crate) enum LineSource {
    Missing,
    File(PathBuf),
    Bytes(Arc<Vec<u8>>),
}

impl LineSource {
    fn is_missing(&self) -> bool {
        matches!(self, LineSource::Missing)
    }
}

/// 摘要统计；二进制或未读取内容的文件不计行数。
#[derive(Clone, Copy, Default)]
pub(crate) struct DiffStats {
    pub(crate) is_binary: bool,
    pub(crate) too_large: bool,
    pub(crate) additions: u64,
    pub(crate) deletions: u64,
}

impl DiffStats {
    pub(crate) fn too_large() -> Self {
        Self {
            too_large: true,
            ..Self::default()
        }
    }

    pub(crate) fn into_summary(self, path: String, change_type: String) -> CheckpointFileSummary {
        CheckpointFileSummary {
            path,
            change_type,
            is_binary: self.is_binary,
            too_large: self.too_large,
            additions: saturating_u32(self.additions),
            deletions: saturating_u32(self.deletions),
        }
    }
}

fn saturating_u32(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// diff 结果的内容版本：original 摘要 + 当前文件 mtime/size。
pub(crate) fn diff_revision(original_digest: &str, mtime_ms: u64, size: u64) -> String {
    format!("{original_digest}|{mtime_ms}|{size}")
}

#[derive(Clone, Copy)]
struct ScanOptions {
    hashes: bool,
    offsets: bool,
}

#[derive(Default)]
struct LineIndex {
    line_count: usize,
    hashes: Vec<u64>,
    /// 每行起始字节偏移，末尾追加内容总长度（len = line_count + 1）。
    offsets: Vec<u64>,
    is_binary: bool,
    missing_final_newline: bool,
}

/// 分块行扫描器：块边界可以落在行中间、CRLF 中间或多字节字符中间。
struct LineScanner {
    options: ScanOptions,
    index: LineIndex,
    position: u64,
    line_start: u64,
    line_open: bool,
    pending_cr: bool,
    hasher: DefaultHasher,
    utf8_carry: Vec<u8>,
}

impl LineScanner {
    fn new(options: ScanOptions) -> Self {
        Self {
            options,
            index: LineIndex::default(),
            position: 0,
            line_start: 0,
            line_open: false,
            pending_cr: false,
            hasher: DefaultHasher::new(),
            utf8_carry: Vec::new(),
        }
    }

    fn feed(&mut self, chunk: &[u8]) {
        // 与旧版判定一致：含 NUL 或不是合法 UTF-8 即视为二进制。
        if chunk.contains(&0) {
            self.index.is_binary = true;
            return;
        }
        self.validate_utf8(chunk);
        if self.index.is_binary {
            return;
        }
        let mut rest = chunk;
        while let Some(newline) = rest.iter().position(|byte| *byte == b'\n') {
            self.push_content(&rest[..newline]);
            self.position += newline as u64 + 1;
            self.finish_line(true);
            rest = &rest[newline + 1..];
        }
        self.push_content(rest);
        self.position += rest.len() as u64;
    }

    fn validate_utf8(&mut self, chunk: &[u8]) {
        let joined;
        let data: &[u8] = if self.utf8_carry.is_empty() {
            chunk
        } else {
            let mut buffer = std::mem::take(&mut self.utf8_carry);
            buffer.extend_from_slice(chunk);
            joined = buffer;
            &joined
        };
        match std::str::from_utf8(data) {
            Ok(_) => {}
            // 块尾截断的多字节字符：留到下一块拼接后再校验。
            Err(error) if error.error_len().is_none() => {
                self.utf8_carry = data[error.valid_up_to()..].to_vec();
            }
            Err(_) => self.index.is_binary = true,
        }
    }

    fn push_content(&mut self, segment: &[u8]) {
        if segment.is_empty() {
            return;
        }
        self.line_open = true;
        if !self.options.hashes {
            return;
        }
        if self.pending_cr {
            self.hasher.write(b"\r");
        }
        // 段尾的 \r 先挂起：紧跟换行时属于 CRLF，归一化时丢弃。
        let (body, trailing_cr) = match segment.split_last() {
            Some((&b'\r', body)) => (body, true),
            _ => (segment, false),
        };
        self.hasher.write(body);
        self.pending_cr = trailing_cr;
    }

    fn finish_line(&mut self, has_newline: bool) {
        if self.options.hashes {
            // 文件末尾孤立的 \r 不属于 CRLF，按原样参与比对。
            if self.pending_cr && !has_newline {
                self.hasher.write(b"\r");
            }
            self.hasher.write(&[u8::from(has_newline)]);
            let hasher = std::mem::replace(&mut self.hasher, DefaultHasher::new());
            self.index.hashes.push(hasher.finish());
        }
        self.pending_cr = false;
        if self.options.offsets {
            self.index.offsets.push(self.line_start);
        }
        self.index.line_count += 1;
        self.index.missing_final_newline = !has_newline;
        self.line_open = false;
        self.line_start = self.position;
    }

    fn finish(mut self) -> LineIndex {
        if !self.utf8_carry.is_empty() {
            self.index.is_binary = true;
        }
        if self.index.is_binary {
            return LineIndex {
                is_binary: true,
                ..LineIndex::default()
            };
        }
        if self.line_open {
            self.finish_line(false);
        }
        if self.options.offsets {
            self.index.offsets.push(self.position);
        }
        self.index
    }
}

fn read_error(path: &Path, error: std::io::Error) -> Error {
    Error::from_reason(format!(
        "Failed to read checkpoint diff source '{}': {error}",
        path.display()
    ))
}

fn scan(source: &LineSource, options: ScanOptions) -> Result<LineIndex> {
    let mut scanner = LineScanner::new(options);
    match source {
        LineSource::Missing => {}
        LineSource::Bytes(bytes) => {
            for chunk in bytes.chunks(SCAN_CHUNK_SIZE) {
                scanner.feed(chunk);
                if scanner.index.is_binary {
                    break;
                }
            }
        }
        LineSource::File(path) => {
            let mut file = File::open(path).map_err(|error| read_error(path, error))?;
            let mut buffer = vec![0u8; SCAN_CHUNK_SIZE];
            loop {
                let read = match file.read(&mut buffer) {
                    Ok(read) => read,
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(error) => return Err(read_error(path, error)),
                };
                if read == 0 {
                    break;
                }
                scanner.feed(&buffer[..read]);
                if scanner.index.is_binary {
                    break;
                }
            }
        }
    }
    Ok(scanner.finish())
}

/// 行级比对：一侧为空时直接给出整段新增/删除，无需哈希。
fn compute_ops(old: &LineIndex, new: &LineIndex, deadline: Duration) -> Vec<DiffOp> {
    match (old.line_count, new.line_count) {
        (0, 0) => Vec::new(),
        (0, new_len) => vec![DiffOp::Insert {
            old_index: 0,
            new_index: 0,
            new_len,
        }],
        (old_len, 0) => vec![DiffOp::Delete {
            old_index: 0,
            old_len,
            new_index: 0,
        }],
        _ => capture_diff_slices_deadline(
            Algorithm::Myers,
            &old.hashes,
            &new.hashes,
            Some(Instant::now() + deadline),
        ),
    }
}

fn scan_options(old: &LineSource, new: &LineSource, offsets: bool) -> ScanOptions {
    ScanOptions {
        hashes: !old.is_missing() && !new.is_missing(),
        offsets,
    }
}

/// 摘要统计：只保留行哈希（新增/删除文件连哈希都不需要），内存与行数成正比。
pub(crate) fn compute_stats(old: &LineSource, new: &LineSource) -> Result<DiffStats> {
    let options = scan_options(old, new, false);
    let old_index = scan(old, options)?;
    if old_index.is_binary {
        return Ok(DiffStats {
            is_binary: true,
            ..DiffStats::default()
        });
    }
    let new_index = scan(new, options)?;
    if new_index.is_binary {
        return Ok(DiffStats {
            is_binary: true,
            ..DiffStats::default()
        });
    }
    let mut stats = DiffStats::default();
    for op in compute_ops(&old_index, &new_index, STATS_DEADLINE) {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        if tag != DiffTag::Equal {
            stats.additions += new_range.len() as u64;
            stats.deletions += old_range.len() as u64;
        }
    }
    Ok(stats)
}

struct DiffSide {
    source: LineSource,
    offsets: Vec<u64>,
    line_count: usize,
    missing_final_newline: bool,
}

impl DiffSide {
    fn new(source: LineSource, index: LineIndex) -> Self {
        Self {
            source,
            offsets: index.offsets,
            line_count: index.line_count,
            missing_final_newline: index.missing_final_newline,
        }
    }

    fn line_bytes(&self, line: usize) -> u64 {
        (self.offsets[line + 1] - self.offsets[line]).min(MAX_ROW_BYTES)
    }
}

/// 单个文件的分页计划：只保存两侧行偏移与比对分组，正文按页读取。
pub(crate) struct DiffPlan {
    revision: String,
    is_binary: bool,
    header: String,
    old: DiffSide,
    new: DiffSide,
    groups: Vec<Vec<DiffOp>>,
    /// 各组展示行数的前缀和（len = groups.len() + 1）。
    group_rows: Vec<u64>,
}

impl DiffPlan {
    fn total_rows(&self) -> u64 {
        self.group_rows.last().copied().unwrap_or(0)
    }
}

fn op_rows(op: &DiffOp) -> usize {
    let (tag, old_range, new_range) = op.as_tag_tuple();
    match tag {
        DiffTag::Equal => old_range.len(),
        _ => old_range.len() + new_range.len(),
    }
}

pub(crate) fn build_plan(
    relative: &str,
    old: LineSource,
    new: LineSource,
    revision: String,
) -> Result<DiffPlan> {
    let options = scan_options(&old, &new, true);
    let header = format!(
        "--- {}\n+++ {}",
        if old.is_missing() {
            "/dev/null".to_string()
        } else {
            format!("a/{relative}")
        },
        if new.is_missing() {
            "/dev/null".to_string()
        } else {
            format!("b/{relative}")
        },
    );
    let old_index = scan(&old, options)?;
    let new_index = if old_index.is_binary {
        LineIndex::default()
    } else {
        scan(&new, options)?
    };
    let is_binary = old_index.is_binary || new_index.is_binary;
    let groups = if is_binary {
        Vec::new()
    } else {
        group_diff_ops(
            compute_ops(&old_index, &new_index, PLAN_DEADLINE),
            CONTEXT_RADIUS,
        )
    };
    let mut group_rows = Vec::with_capacity(groups.len() + 1);
    let mut total = 0u64;
    group_rows.push(total);
    for group in &groups {
        total += group.iter().map(op_rows).sum::<usize>() as u64;
        group_rows.push(total);
    }
    Ok(DiffPlan {
        revision,
        is_binary,
        header,
        old: DiffSide::new(old, old_index),
        new: DiffSide::new(new, new_index),
        groups,
        group_rows,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RowKind {
    Context,
    Delete,
    Insert,
}

#[derive(Clone, Copy)]
struct Row {
    kind: RowKind,
    old_line: usize,
    new_line: usize,
}

/// 操作内第 offset 个展示行。替换操作先列删除行再列新增行（与 unified diff 一致）；
/// 不消耗某一侧的行时，该侧行号记为插入/删除发生的位置。
fn row_at(op: &DiffOp, offset: usize) -> Row {
    let (tag, old_range, new_range) = op.as_tag_tuple();
    match tag {
        DiffTag::Equal => Row {
            kind: RowKind::Context,
            old_line: old_range.start + offset,
            new_line: new_range.start + offset,
        },
        DiffTag::Delete => Row {
            kind: RowKind::Delete,
            old_line: old_range.start + offset,
            new_line: new_range.start,
        },
        DiffTag::Insert => Row {
            kind: RowKind::Insert,
            old_line: old_range.start,
            new_line: new_range.start + offset,
        },
        DiffTag::Replace if offset < old_range.len() => Row {
            kind: RowKind::Delete,
            old_line: old_range.start + offset,
            new_line: new_range.start,
        },
        DiffTag::Replace => Row {
            kind: RowKind::Insert,
            old_line: old_range.end,
            new_line: new_range.start + offset - old_range.len(),
        },
    }
}

struct Cursor {
    group: usize,
    op: usize,
    offset: usize,
}

impl Cursor {
    /// 把 offset 归位到真实存在的操作上（跨越操作 / 分组边界）。
    fn normalize(&mut self, groups: &[Vec<DiffOp>]) {
        while let Some(ops) = groups.get(self.group) {
            let Some(op) = ops.get(self.op) else {
                self.group += 1;
                self.op = 0;
                continue;
            };
            let rows = op_rows(op);
            if self.offset < rows {
                return;
            }
            self.offset -= rows;
            self.op += 1;
        }
    }
}

/// hunk 头中的行范围（与 similar 的 unified 输出格式一致）。
fn format_hunk_range(start: usize, len: usize) -> String {
    match len {
        0 => format!("{start},0"),
        1 => format!("{}", start + 1),
        _ => format!("{},{len}", start + 1),
    }
}

struct SideReader<'a> {
    side: &'a DiffSide,
    file: Option<File>,
}

impl<'a> SideReader<'a> {
    fn new(side: &'a DiffSide) -> Self {
        Self { side, file: None }
    }

    fn read_bytes(&mut self, start: u64, length: usize) -> Result<Vec<u8>> {
        match &self.side.source {
            LineSource::Missing => Ok(Vec::new()),
            LineSource::Bytes(bytes) => {
                let start = start as usize;
                Ok(bytes
                    .get(start..start + length)
                    .map(<[u8]>::to_vec)
                    .unwrap_or_default())
            }
            LineSource::File(path) => {
                let file = match self.file.take() {
                    Some(file) => file,
                    None => File::open(path).map_err(|error| read_error(path, error))?,
                };
                let file = self.file.insert(file);
                file.seek(SeekFrom::Start(start))
                    .map_err(|error| read_error(path, error))?;
                let mut buffer = vec![0u8; length];
                file.read_exact(&mut buffer)
                    .map_err(|error| read_error(path, error))?;
                Ok(buffer)
            }
        }
    }

    fn line(&mut self, line: usize) -> Result<String> {
        let start = self.side.offsets[line];
        let length = self.side.offsets[line + 1] - start;
        let truncated = length > MAX_ROW_BYTES;
        let bytes = self.read_bytes(start, length.min(MAX_ROW_BYTES) as usize)?;
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        if truncated {
            text.push_str(ROW_TRUNCATED_SUFFIX);
            return Ok(text);
        }
        if text.ends_with('\n') {
            text.pop();
            if text.ends_with('\r') {
                text.pop();
            }
        }
        if self.side.missing_final_newline && line + 1 == self.side.line_count {
            text.push('\n');
            text.push_str(NO_NEWLINE_HINT);
        }
        Ok(text)
    }
}

/// 渲染一页：按展示行数与字节数（由行偏移直接估算，无需读取）双重限额，
/// 至少输出一行。页内同一分组的行合并为一个 hunk 并重新计算 hunk 头。
pub(crate) fn render_page(
    plan: &DiffPlan,
    start_row: u32,
    max_rows: u32,
    max_bytes: u32,
) -> Result<CheckpointDiffPage> {
    let total = plan.total_rows();
    let max_rows = u64::from(max_rows.clamp(PAGE_ROWS_RANGE.0, PAGE_ROWS_RANGE.1));
    let max_bytes = u64::from(max_bytes.clamp(PAGE_BYTES_RANGE.0, PAGE_BYTES_RANGE.1));
    let start = u64::from(start_row).min(total);

    let mut segments: Vec<(usize, Vec<Row>)> = Vec::new();
    let mut row = start;
    if row < total {
        let group = plan.group_rows.partition_point(|&begin| begin <= row) - 1;
        let mut cursor = Cursor {
            group,
            op: 0,
            offset: (row - plan.group_rows[group]) as usize,
        };
        cursor.normalize(&plan.groups);
        let mut budget = 0u64;
        while row < total && row - start < max_rows && (row == start || budget < max_bytes) {
            let descriptor = row_at(&plan.groups[cursor.group][cursor.op], cursor.offset);
            budget += 2 + match descriptor.kind {
                RowKind::Insert => plan.new.line_bytes(descriptor.new_line),
                _ => plan.old.line_bytes(descriptor.old_line),
            };
            match segments.last_mut() {
                Some((group, rows)) if *group == cursor.group => rows.push(descriptor),
                _ => segments.push((cursor.group, vec![descriptor])),
            }
            row += 1;
            cursor.offset += 1;
            cursor.normalize(&plan.groups);
        }
    }

    let mut content = String::new();
    if start == 0 && total > 0 {
        content.push_str(&plan.header);
        content.push('\n');
    }
    let mut old_reader = SideReader::new(&plan.old);
    let mut new_reader = SideReader::new(&plan.new);
    for (_, rows) in &segments {
        let first = rows[0];
        let old_count = rows.iter().filter(|row| row.kind != RowKind::Insert).count();
        let new_count = rows.iter().filter(|row| row.kind != RowKind::Delete).count();
        content.push_str(&format!(
            "@@ -{} +{} @@\n",
            format_hunk_range(first.old_line, old_count),
            format_hunk_range(first.new_line, new_count),
        ));
        for row in rows {
            let (prefix, text) = match row.kind {
                RowKind::Context => (' ', old_reader.line(row.old_line)?),
                RowKind::Delete => ('-', old_reader.line(row.old_line)?),
                RowKind::Insert => ('+', new_reader.line(row.new_line)?),
            };
            content.push(prefix);
            content.push_str(&text);
            content.push('\n');
        }
    }

    Ok(CheckpointDiffPage {
        is_binary: plan.is_binary,
        too_large: false,
        content,
        total_rows: saturating_u32(total),
        next_row: saturating_u32(row),
        revision: plan.revision.clone(),
    })
}

pub(crate) fn too_large_page(revision: String) -> CheckpointDiffPage {
    CheckpointDiffPage {
        is_binary: false,
        too_large: true,
        content: String::new(),
        total_rows: 0,
        next_row: 0,
        revision,
    }
}

/// 最近一次查看的分页计划（单槽）：翻页时复用两侧行偏移与比对结果，
/// 不再重复扫描文件；内容版本变化即失效。
static PLAN_CACHE: OnceLock<Mutex<Option<(String, Arc<DiffPlan>)>>> = OnceLock::new();

fn plan_cache() -> MutexGuard<'static, Option<(String, Arc<DiffPlan>)>> {
    PLAN_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn cached_plan(key: &str, revision: &str) -> Option<Arc<DiffPlan>> {
    plan_cache()
        .as_ref()
        .filter(|(cached_key, plan)| cached_key == key && plan.revision == revision)
        .map(|(_, plan)| Arc::clone(plan))
}

pub(crate) fn store_plan(key: String, plan: DiffPlan) -> Arc<DiffPlan> {
    let plan = Arc::new(plan);
    *plan_cache() = Some((key, Arc::clone(&plan)));
    plan
}
