use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use oxc::allocator::Allocator;
use oxc::parser::ParseOptions;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;

use super::types::{ReferenceInfo, SymbolInfo, SymbolLocation};

#[derive(Clone, Debug)]
pub struct IndexEntry {
    pub symbol: SymbolInfo,
}

pub struct SymbolIndex {
    symbols_by_name: HashMap<String, Vec<IndexEntry>>,
    exports_by_file: HashMap<String, Vec<IndexEntry>>,
}

impl SymbolIndex {
    pub fn new() -> Self {
        SymbolIndex {
            symbols_by_name: HashMap::new(),
            exports_by_file: HashMap::new(),
        }
    }

    pub fn index_file(&mut self, file_path: &str, source_text: &str) {
        if super::is_js_ts(file_path) {
            // JS/TS: use oxc deep semantic analysis
            let exports = parse_file_for_index(file_path, source_text);
            for entry in &exports {
                self.symbols_by_name
                    .entry(entry.symbol.name.clone())
                    .or_default()
                    .push(entry.clone());
            }
            self.exports_by_file.insert(file_path.to_string(), exports);
        } else {
            // Other languages: use tree-sitter outline for definitions
            let outline = super::tree_sitter_analyzer::build_file_outline(file_path, source_text);
            let mut exports = Vec::new();
            for entry in outline {
                let symbol = SymbolInfo {
                    name: entry.name.clone(),
                    kind: entry.kind.clone(),
                    location: SymbolLocation {
                        file_path: file_path.to_string(),
                        line: entry.line,
                        column: entry.column,
                        end_line: entry.end_line,
                        end_column: entry.end_column,
                    },
                    container_name: entry.container_name.clone(),
                    is_exported: entry.is_exported,
                };
                let index_entry = IndexEntry {
                    symbol: symbol.clone(),
                };
                self.symbols_by_name
                    .entry(symbol.name.clone())
                    .or_default()
                    .push(index_entry.clone());
                exports.push(index_entry);
            }
            self.exports_by_file.insert(file_path.to_string(), exports);
        }
    }

    /// Index a file from its path on disk, auto-detecting the language.
    fn index_file_from_disk(&mut self, file_path: &str) {
        let source_text = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(_) => return,
        };
        self.index_file(file_path, &source_text);
    }

    /// 索引整个项目下的源码文件。支持 SQLite 本地持久化与增量文件指纹比对：
    /// - 未变动文件：毫秒级指纹命中跳过，免去重复 AST 解析；
    /// - 变动/新增文件：重新解析并写入 SQLite；
    /// - 删除文件：自动从 SQLite 清理。
    pub fn index_project(&mut self, root_dir: &Path) {
        let db_opt = crate::storage::initialize_app_storage()
            .ok()
            .map(|s| PathBuf::from(s.database_path));
        let root_str = root_dir.to_string_lossy().to_string();
        let files = discover_source_files(root_dir);

        if let Some(ref db_path) = db_opt {
            let cached_map = crate::storage::services::codelens::get_file_cache_map(db_path, &root_str)
                .unwrap_or_default();
            let mut current_set = HashSet::new();

            for file in &files {
                let path_str = file.to_string_lossy().to_string();
                current_set.insert(path_str.clone());

                let (mtime_ms, size) = match std::fs::metadata(file) {
                    Ok(meta) => {
                        let mtime = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0);
                        (mtime, meta.len() as i64)
                    }
                    Err(_) => continue,
                };

                // 增量检查：如果缓存一致，保留文件记录并跳过重度 AST 解析
                if let Some(&(cached_mtime, cached_size)) = cached_map.get(&path_str) {
                    if cached_mtime == mtime_ms && cached_size == size {
                        self.exports_by_file.entry(path_str).or_default();
                        continue;
                    }
                }

                // 发生变动或新文件：从磁盘读取并解析
                let source_text = match std::fs::read_to_string(&path_str) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                self.index_file(&path_str, &source_text);

                // 收集符号并写入 SQLite
                if let Some(entries) = self.exports_by_file.get(&path_str) {
                    let records: Vec<crate::storage::services::codelens::SymbolRecord> = entries
                        .iter()
                        .map(|e| crate::storage::services::codelens::SymbolRecord {
                            symbol_name: e.symbol.name.clone(),
                            kind: "definition".to_string(),
                            file_path: e.symbol.location.file_path.clone(),
                            line: e.symbol.location.line,
                            column: e.symbol.location.column,
                            end_line: Some(e.symbol.location.end_line),
                            end_column: Some(e.symbol.location.end_column),
                            container_name: e.symbol.container_name.clone(),
                            is_exported: e.symbol.is_exported,
                        })
                        .collect();
                    let _ = crate::storage::services::codelens::upsert_file_symbols(
                        db_path,
                        &root_str,
                        &path_str,
                        mtime_ms,
                        size,
                        &records,
                    );
                }
            }

            // 清理已从磁盘删除的文件
            for cached_file in cached_map.keys() {
                if !current_set.contains(cached_file) {
                    let _ = crate::storage::services::codelens::remove_file(db_path, cached_file);
                }
            }
        } else {
            // 降级回退：纯内存解析
            for file in files {
                let path_str = file.to_string_lossy().to_string();
                self.index_file_from_disk(&path_str);
            }
        }
    }

    /// 在全项目中查找指定名称符号的引用。
    /// 包含快速子字符串短路优化：未包含目标符号名的文件直接跳过，避免昂贵的无用 AST 遍历。
    pub fn find_references_across_project(
        &self,
        _root_dir: Option<&Path>,
        name: &str,
    ) -> Vec<ReferenceInfo> {
        let mut all_refs = Vec::new();

        for file_path_str in self.exports_by_file.keys() {
            let source_text = match std::fs::read_to_string(file_path_str) {
                Ok(s) => s,
                Err(_) => continue,
            };

            // 核心短路优化：若文件内容根本不包含该符号名，直接跳过 AST 解析（微秒级）
            if !source_text.contains(name) {
                continue;
            }

            let refs = if super::is_js_ts(file_path_str) {
                super::analyzer::find_references_by_name(file_path_str, &source_text, name)
            } else {
                super::tree_sitter_analyzer::find_references_by_name(
                    file_path_str,
                    &source_text,
                    name,
                )
            };

            all_refs.extend(refs);
        }

        all_refs
    }

    /// 在全项目中查找符号定义。优先走本地 SQLite 倒排索引树（毫秒级命中），降级回退内存。
    pub fn find_definition_across_project(
        &self,
        root_dir: Option<&Path>,
        name: &str,
    ) -> Option<SymbolInfo> {
        // 1. 优先查 SQLite 索引表
        if let Some(root) = root_dir {
            if let Ok(storage_info) = crate::storage::initialize_app_storage() {
                let db_path = PathBuf::from(storage_info.database_path);
                let root_str = root.to_string_lossy();
                if let Ok(records) =
                    crate::storage::services::codelens::query_definitions(&db_path, &root_str, name)
                {
                    if let Some(first) = records.into_iter().next() {
                        return Some(SymbolInfo {
                            name: first.symbol_name,
                            kind: first.kind,
                            location: SymbolLocation {
                                file_path: first.file_path,
                                line: first.line,
                                column: first.column,
                                end_line: first.end_line.unwrap_or(first.line),
                                end_column: first.end_column.unwrap_or(first.column),
                            },
                            container_name: first.container_name,
                            is_exported: first.is_exported,
                        });
                    }
                }
            }
        }

        // 2. 内存符号表匹配
        if let Some(entries) = self.symbols_by_name.get(name) {
            if let Some(entry) = entries.first() {
                return Some(entry.symbol.clone());
            }
        }

        None
    }
}

fn parse_file_for_index(file_path: &str, source_text: &str) -> Vec<IndexEntry> {
    let path = Path::new(file_path);
    let source_type = SourceType::from_path(path).unwrap_or_default();

    let allocator = Allocator::default();
    let parse_ret = oxc::parser::Parser::new(&allocator, source_text, source_type)
        .with_options(ParseOptions {
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .parse();

    let program = parse_ret.program;
    let semantic_ret = SemanticBuilder::new().build(&program);
    let semantic = &semantic_ret.semantic;
    let scoping = semantic.scoping();
    let line_index = super::analyzer::LineIndexRef::new(source_text);

    let mut exports: Vec<IndexEntry> = Vec::new();
    for symbol_id in scoping.symbol_ids() {
        let scope_id = scoping.symbol_scope_id(symbol_id);
        if scope_id == scoping.root_scope_id() {
            let name = scoping.symbol_name(symbol_id).to_string();
            let span = scoping.symbol_span(symbol_id);
            let (start_line, start_col) = line_index.line_col(span.start);
            let (end_line, end_col) = line_index.line_col(span.end);

            exports.push(IndexEntry {
                symbol: SymbolInfo {
                    name: name.clone(),
                    kind: "variable".to_string(),
                    location: SymbolLocation {
                        file_path: file_path.to_string(),
                        line: start_line,
                        column: start_col,
                        end_line,
                        end_column: end_col,
                    },
                    container_name: None,
                    is_exported: true,
                },
            });
        }
    }

    exports
}

fn discover_source_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    walk_source_dir(root, &mut files);
    files.sort();
    files
}

fn walk_source_dir(dir: &Path, files: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if is_skip_dir(name) {
                    continue;
                }
            }
            walk_source_dir(&path, files);
        } else if path.is_file() && is_source_file(&path) {
            files.push(path);
        }
    }
}

fn is_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | ".svn"
            | ".hg"
            | "target"
            | "dist"
            | "out"
            | "build"
            | ".next"
            | ".nuxt"
            | ".snow"
            | ".cache"
            | ".turbo"
            | "__pycache__"
            | ".pytest_cache"
            | ".venv"
            | "venv"
            | ".idea"
            | ".vscode"
            | "coverage"
            | ".nyc_output"
            | "release"
    )
}

fn is_source_file(path: &Path) -> bool {
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_lowercase(),
        None => return false,
    };
    matches!(
        ext.as_str(),
        "ts" | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "mts"
            | "cts"
            | "py"
            | "pyw"
            | "pyi"
            | "rs"
            | "go"
            | "c"
            | "h"
            | "java"
            | "cs"
            | "rb"
            | "php"
            | "phtml"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "html"
            | "htm"
            | "json"
            | "json5"
            | "jsonc"
            | "yaml"
            | "yml"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "ps1"
            | "psm1"
            | "bat"
            | "cmd"
            | "lua"
    )
}
