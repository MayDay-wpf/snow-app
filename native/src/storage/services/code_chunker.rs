/// Code chunker: splits source file content into overlapping line-based
/// chunks suitable for embedding.
///
/// Configuration is driven by the codebase settings:
/// - `max_lines_per_chunk`: maximum number of lines per chunk
/// - `min_lines_per_chunk`: minimum number of lines per chunk (chunks smaller
///   than this are merged into the previous chunk when possible)
/// - `min_chars_per_chunk`: minimum number of characters per chunk (chunks
///   with fewer characters are skipped or merged)
/// - `overlap_lines`: number of overlapping lines between consecutive chunks

#[derive(Debug, Clone)]
pub struct ChunkingConfig {
    pub max_lines_per_chunk: usize,
    pub min_lines_per_chunk: usize,
    pub min_chars_per_chunk: usize,
    pub overlap_lines: usize,
}

impl Default for ChunkingConfig {
    fn default() -> Self {
        Self {
            max_lines_per_chunk: 200,
            min_lines_per_chunk: 10,
            min_chars_per_chunk: 20,
            overlap_lines: 20,
        }
    }
}

impl ChunkingConfig {
    pub fn from_settings(max_lines: i32, min_lines: i32, min_chars: i32, overlap: i32) -> Self {
        let max_lines_per_chunk = if max_lines > 0 {
            max_lines as usize
        } else {
            200
        };
        let min_lines_per_chunk = if min_lines > 0 {
            min_lines as usize
        } else {
            10
        };
        let min_chars_per_chunk = if min_chars > 0 {
            min_chars as usize
        } else {
            20
        };
        // Ensure overlap is less than max_lines
        let overlap_lines = if overlap > 0 {
            (overlap as usize).min(max_lines_per_chunk.saturating_sub(1))
        } else {
            0
        };

        Self {
            max_lines_per_chunk,
            min_lines_per_chunk: min_lines_per_chunk.min(max_lines_per_chunk),
            min_chars_per_chunk,
            overlap_lines,
        }
    }
}

/// A single code chunk ready for embedding.
#[derive(Debug, Clone)]
pub struct CodeChunk {
    /// 0-based index of this chunk within the file.
    pub chunk_index: usize,
    /// 1-based starting line number in the original file.
    pub start_line: usize,
    /// 1-based ending line number in the original file.
    pub end_line: usize,
    /// The chunk text content (including line breaks).
    pub content: String,
}

/// Split file content into overlapping chunks based on the chunking config.
///
/// The algorithm:
/// 1. Split content into lines.
/// 2. Slide a window of `max_lines_per_chunk` with a step of
///    `max_lines_per_chunk - overlap_lines`.
/// 3. Merge tiny trailing chunks (< min_lines or < min_chars) into the
///    previous chunk when possible.
/// 4. Skip chunks that are entirely empty or below `min_chars_per_chunk`
///    and cannot be merged.
pub fn chunk_content(content: &str, config: &ChunkingConfig) -> Vec<CodeChunk> {
    if content.is_empty() {
        return Vec::new();
    }

    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }

    let max_lines = config.max_lines_per_chunk;
    let min_lines = config.min_lines_per_chunk.min(max_lines);
    let min_chars = config.min_chars_per_chunk;
    let overlap = config.overlap_lines.min(max_lines.saturating_sub(1));

    let step = max_lines.saturating_sub(overlap).max(1);
    let mut chunks: Vec<CodeChunk> = Vec::new();
    let mut chunk_index = 0usize;

    let mut start = 0usize;
    while start < lines.len() {
        let end = (start + max_lines).min(lines.len());
        let chunk_lines = &lines[start..end];
        let chunk_text = chunk_lines.join("\n");
        let char_count = chunk_text.chars().count();

        let line_count = end - start;

        // If this is the last chunk and it's too small, merge into previous
        if end == lines.len()
            && line_count < min_lines
            && char_count < min_chars
            && !chunks.is_empty()
        {
            // Merge: extend the last chunk to include these lines
            let last = chunks.last_mut().unwrap();
            last.end_line = end;
            last.content = lines[last.start_line.saturating_sub(1)..end].join("\n");
            break;
        }

        // Skip chunks that are below minimum thresholds and not the last
        if char_count < min_chars && line_count < min_lines && end != lines.len() {
            start += step;
            continue;
        }

        chunks.push(CodeChunk {
            chunk_index,
            start_line: start + 1, // 1-based
            end_line: end,         // 1-based inclusive
            content: chunk_text,
        });

        chunk_index += 1;

        if end >= lines.len() {
            break;
        }

        start += step;
    }

    // Re-index chunks after potential merges
    for (i, chunk) in chunks.iter_mut().enumerate() {
        chunk.chunk_index = i;
    }

    chunks
}
