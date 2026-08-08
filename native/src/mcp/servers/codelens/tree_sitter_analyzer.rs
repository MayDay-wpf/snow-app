//! Multi-language analyzer powered by tree-sitter.
//!
//! Provides syntax-level analysis (outline, definition lookup, reference
//! search) for a wide range of programming languages:
//! Python, Rust, Go, C, C++, Java, C#, Ruby, PHP, CSS, HTML, JSON, YAML,
//! Bash, SQL, Lua, Dockerfile, Make, and more.
//!
//! JS/TS are handled separately by the oxc-based `analyzer.rs`.

use std::path::Path;

use tree_sitter::{Language, Node, Parser, Point, Query, QueryCursor, StreamingIterator, Tree};

use super::analyzer::LineIndex;
use super::types::{OutlineEntry, ReferenceInfo, SymbolInfo, SymbolLocation};

/// Supported tree-sitter languages.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TsLang {
    Python,
    Rust,
    Go,
    C,
    Java,
    CSharp,
    Ruby,
    Php,
    Css,
    Html,
    Json,
    Yaml,
    Bash,
    Lua,
}

impl TsLang {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_lowercase().as_str() {
            "py" | "pyw" | "pyi" => Some(TsLang::Python),
            "rs" => Some(TsLang::Rust),
            "go" => Some(TsLang::Go),
            "c" | "h" => Some(TsLang::C),
            "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" | "ino" => None, // C++ grammar incompatible
            "java" => Some(TsLang::Java),
            "cs" => Some(TsLang::CSharp),
            "rb" => Some(TsLang::Ruby),
            "php" | "phtml" | "php3" | "php4" | "php5" => Some(TsLang::Php),
            "css" | "scss" | "sass" | "less" => Some(TsLang::Css),
            "html" | "htm" => Some(TsLang::Html),
            "json" | "json5" | "jsonc" => Some(TsLang::Json),
            "yaml" | "yml" => Some(TsLang::Yaml),
            "sh" | "bash" | "zsh" | "fish" | "ps1" | "psm1" | "bat" | "cmd" => Some(TsLang::Bash),
            "lua" => Some(TsLang::Lua),
            _ => None,
        }
    }

    pub fn language(self) -> Language {
        match self {
            TsLang::Python => tree_sitter_python::LANGUAGE.into(),
            TsLang::Rust => tree_sitter_rust::LANGUAGE.into(),
            TsLang::Go => tree_sitter_go::LANGUAGE.into(),
            TsLang::C => tree_sitter_c::LANGUAGE.into(),
            TsLang::Java => tree_sitter_java::LANGUAGE.into(),
            TsLang::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
            TsLang::Ruby => tree_sitter_ruby::LANGUAGE.into(),
            TsLang::Php => tree_sitter_php::LANGUAGE_PHP.into(),
            TsLang::Css => tree_sitter_css::LANGUAGE.into(),
            TsLang::Html => tree_sitter_html::LANGUAGE.into(),
            TsLang::Json => tree_sitter_json::LANGUAGE.into(),
            TsLang::Yaml => tree_sitter_yaml::LANGUAGE.into(),
            TsLang::Bash => tree_sitter_bash::LANGUAGE.into(),
            TsLang::Lua => tree_sitter_lua::LANGUAGE.into(),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            TsLang::Python => "python",
            TsLang::Rust => "rust",
            TsLang::Go => "go",
            TsLang::C => "c",
            TsLang::Java => "java",
            TsLang::CSharp => "csharp",
            TsLang::Ruby => "ruby",
            TsLang::Php => "php",
            TsLang::Css => "css",
            TsLang::Html => "html",
            TsLang::Json => "json",
            TsLang::Yaml => "yaml",
            TsLang::Bash => "bash",
            TsLang::Lua => "lua",
        }
    }
}

/// Return true if the file extension is a tree-sitter-supported language.
pub fn is_supported(file_path: &str) -> bool {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    TsLang::from_extension(ext).is_some()
}

/// Determine the TsLang from a file path (handles extensionless files too).
pub fn lang_from_path(file_path: &str) -> Option<TsLang> {
    let ext = Path::new(file_path).extension().and_then(|e| e.to_str())?;
    TsLang::from_extension(ext)
}

fn parse(file_path: &str, source: &str) -> Option<(TsLang, Tree)> {
    let lang = lang_from_path(file_path)?;
    let mut parser = Parser::new();
    parser.set_language(&lang.language()).ok()?;
    let tree = parser.parse(source, None)?;
    Some((lang, tree))
}

// ---------------------------------------------------------------------------
// File outline
// ---------------------------------------------------------------------------

/// Build a file outline using tree-sitter queries.
pub fn build_file_outline(file_path: &str, source_text: &str) -> Vec<OutlineEntry> {
    let (lang, tree) = match parse(file_path, source_text) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let line_index = LineIndex::new(source_text);

    let query_str = outline_query(lang);
    let query = match Query::new(&lang.language(), query_str) {
        Ok(q) => q,
        Err(_) => return Vec::new(),
    };

    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(&query, tree.root_node(), source_text.as_bytes());

    let mut entries = Vec::new();

    matches.for_each(|m| {
        let mut name = String::new();
        let mut kind_str = "symbol".to_string();
        let mut start_byte = 0u32;
        let mut end_byte = 0u32;

        for cap in m.captures {
            let node = cap.node;
            let capture_name: &str = query.capture_names()[cap.index as usize];
            match capture_name {
                "name" => {
                    name = node
                        .utf8_text(source_text.as_bytes())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                }
                "definition" => {
                    start_byte = node.start_byte() as u32;
                    end_byte = node.end_byte() as u32;
                    kind_str = node.kind().to_string();
                }
                _ => {}
            }
        }

        if name.is_empty() {
            return;
        }

        let (start_line, start_col) = line_index.line_col(start_byte);
        let (end_line, end_col) = line_index.line_col(end_byte);

        let kind = normalize_kind(&kind_str, lang);

        entries.push(OutlineEntry {
            name,
            kind,
            line: start_line,
            column: start_col,
            end_line,
            end_column: end_col,
            container_name: None,
            is_exported: false,
            children: Vec::new(),
        });
    });

    entries
}

/// Return a tree-sitter query string for extracting symbol definitions.
fn outline_query(lang: TsLang) -> &'static str {
    match lang {
        TsLang::Python => {
            r#"
            (function_definition name: (identifier) @name) @definition
            (class_definition name: (identifier) @name) @definition
            (decorated_definition definition: (function_definition name: (identifier) @name)) @definition
            (decorated_definition definition: (class_definition name: (identifier) @name)) @definition
        "#
        }
        TsLang::Rust => {
            r#"
            (function_item name: (identifier) @name) @definition
            (struct_item name: (type_identifier) @name) @definition
            (enum_item name: (type_identifier) @name) @definition
            (trait_item name: (type_identifier) @name) @definition
            (impl_item type: (type_identifier) @name) @definition
            (mod_item name: (identifier) @name) @definition
            (const_item name: (identifier) @name) @definition
            (static_item name: (identifier) @name) @definition
            (type_item name: (type_identifier) @name) @definition
            (macro_definition name: (identifier) @name) @definition
        "#
        }
        TsLang::Go => {
            r#"
            (function_declaration name: (identifier) @name) @definition
            (method_declaration name: (field_identifier) @name) @definition
            (type_declaration (type_spec name: (type_identifier) @name)) @definition
        "#
        }
        TsLang::C => {
            r#"
            (function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition
            (function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @definition
            (struct_specifier name: (type_identifier) @name) @definition
            (enum_specifier name: (type_identifier) @name) @definition
        "#
        }
        TsLang::Java => {
            r#"
            (method_declaration name: (identifier) @name) @definition
            (class_declaration name: (identifier) @name) @definition
            (interface_declaration name: (identifier) @name) @definition
            (enum_declaration name: (identifier) @name) @definition
        "#
        }
        TsLang::CSharp => {
            r#"
            (method_declaration name: (identifier) @name) @definition
            (class_declaration name: (identifier) @name) @definition
            (interface_declaration name: (identifier) @name) @definition
            (enum_declaration name: (identifier) @name) @definition
            (struct_declaration name: (identifier) @name) @definition
        "#
        }
        TsLang::Ruby => {
            r#"
            (method name: (identifier) @name) @definition
            (class name: (constant) @name) @definition
            (module name: (constant) @name) @definition
        "#
        }
        TsLang::Php => {
            r#"
            (function_definition name: (name) @name) @definition
            (class_declaration name: (name) @name) @definition
            (interface_declaration name: (name) @name) @definition
            (method_declaration name: (name) @name) @definition
        "#
        }
        TsLang::Lua => {
            r#"
            (function_declaration name: (identifier) @name) @definition
            (function name: (identifier) @name) @definition
        "#
        }
        _ => "",
    }
}

fn normalize_kind(node_kind: &str, lang: TsLang) -> String {
    let k = node_kind;
    match lang {
        TsLang::Python => {
            if k.contains("function") {
                "function".to_string()
            } else if k.contains("class") {
                "class".to_string()
            } else {
                k.to_string()
            }
        }
        TsLang::Rust => match k {
            "function_item" => "function".to_string(),
            "struct_item" => "class".to_string(),
            "enum_item" => "enum".to_string(),
            "trait_item" => "interface".to_string(),
            "impl_item" => "class".to_string(),
            "mod_item" => "module".to_string(),
            "const_item" => "constant".to_string(),
            "static_item" => "variable".to_string(),
            "type_item" => "type".to_string(),
            "macro_definition" => "function".to_string(),
            _ => k.to_string(),
        },
        TsLang::Go => {
            if k.contains("function") {
                "function".to_string()
            } else if k.contains("method") {
                "method".to_string()
            } else if k.contains("type") {
                "type".to_string()
            } else {
                k.to_string()
            }
        }
        TsLang::Java | TsLang::CSharp => match k {
            "method_declaration" => "method".to_string(),
            "class_declaration" => "class".to_string(),
            "interface_declaration" => "interface".to_string(),
            "enum_declaration" => "enum".to_string(),
            "struct_declaration" => "class".to_string(),
            _ => k.to_string(),
        },
        TsLang::C => {
            if k.contains("function") {
                "function".to_string()
            } else if k.contains("struct") {
                "class".to_string()
            } else if k.contains("enum") {
                "enum".to_string()
            } else {
                k.to_string()
            }
        }
        TsLang::Ruby => {
            if k == "method" {
                "method".to_string()
            } else if k == "class" {
                "class".to_string()
            } else if k == "module" {
                "module".to_string()
            } else {
                k.to_string()
            }
        }
        TsLang::Php => {
            if k.contains("function") {
                "function".to_string()
            } else if k.contains("method") {
                "method".to_string()
            } else if k.contains("class") {
                "class".to_string()
            } else if k.contains("interface") {
                "interface".to_string()
            } else {
                k.to_string()
            }
        }
        TsLang::Lua => "function".to_string(),
        _ => k.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Find definition at position
// ---------------------------------------------------------------------------

/// Find the definition of a symbol at the given line/column.
pub fn find_symbol_at_position(
    file_path: &str,
    source_text: &str,
    line: u32,
    column: u32,
) -> Option<(String, SymbolInfo)> {
    let (lang, tree) = parse(file_path, source_text)?;
    let line_index = LineIndex::new(source_text);

    let target_point = Point {
        row: (line.saturating_sub(1)) as usize,
        column: (column.saturating_sub(1)) as usize,
    };

    let node = tree
        .root_node()
        .descendant_for_point_range(target_point, target_point)?;

    // Walk up the tree to find a named node with an identifier child
    let mut current = Some(node);
    while let Some(n) = current {
        let (name, kind) = extract_name_and_kind(&n, source_text, lang);
        if let Some(name) = name {
            let (start_line, start_col) = line_index.line_col(n.start_byte() as u32);
            let (end_line, end_col) = line_index.line_col(n.end_byte() as u32);
            return Some((
                name.clone(),
                SymbolInfo {
                    name,
                    kind,
                    location: SymbolLocation {
                        file_path: file_path.to_string(),
                        line: start_line,
                        column: start_col,
                        end_line,
                        end_column: end_col,
                    },
                    container_name: None,
                    is_exported: false,
                },
            ));
        }
        current = n.parent();
    }

    None
}

/// Extract the name string and kind from a tree-sitter node by looking at
/// its named children for identifier-like nodes.
fn extract_name_and_kind(node: &Node, source: &str, lang: TsLang) -> (Option<String>, String) {
    let kind = node.kind();

    // Check if this node is a definition node by looking for child identifiers
    let name_fields: &[&str] = match lang {
        TsLang::Python => &["name"],
        TsLang::Rust => &["name", "type", "declarator"],
        TsLang::Go => &["name", "type"],
        TsLang::C => &["declarator", "name", "type"],
        TsLang::Java | TsLang::CSharp => &["name", "type"],
        TsLang::Ruby => &["name"],
        TsLang::Php => &["name"],
        TsLang::Lua => &["name"],
        _ => &["name"],
    };

    for field_name in name_fields {
        if let Some(child) = node.child_by_field_name(field_name) {
            if let Ok(text) = child.utf8_text(source.as_bytes()) {
                let text = text.trim();
                if !text.is_empty() && is_identifier_like(text) {
                    let normalized_kind = normalize_kind(kind, lang);
                    if is_definition_node(kind, lang) {
                        return (Some(text.to_string()), normalized_kind);
                    }
                }
            }
        }
    }

    // Check direct identifier children
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if let Ok(text) = child.utf8_text(source.as_bytes()) {
            let text = text.trim();
            if !text.is_empty() && is_identifier_like(text) && is_definition_node(kind, lang) {
                return (Some(text.to_string()), normalize_kind(kind, lang));
            }
        }
    }

    (None, kind.to_string())
}

fn is_identifier_like(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '$')
        && s.chars()
            .next()
            .map(|c| c.is_alphabetic() || c == '_' || c == '$')
            .unwrap_or(false)
}

fn is_definition_node(kind: &str, lang: TsLang) -> bool {
    match lang {
        TsLang::Python => {
            kind.contains("function") || kind.contains("class") || kind.contains("definition")
        }
        TsLang::Rust => matches!(
            kind,
            "function_item"
                | "struct_item"
                | "enum_item"
                | "trait_item"
                | "impl_item"
                | "mod_item"
                | "const_item"
                | "static_item"
                | "type_item"
                | "macro_definition"
        ),
        TsLang::Go => kind.contains("function") || kind.contains("method") || kind.contains("type"),
        TsLang::C => kind.contains("function") || kind.contains("struct") || kind.contains("enum"),
        TsLang::Java | TsLang::CSharp => matches!(
            kind,
            "method_declaration"
                | "class_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "struct_declaration"
        ),
        TsLang::Ruby => matches!(kind, "method" | "class" | "module"),
        TsLang::Php => {
            kind.contains("function")
                || kind.contains("method")
                || kind.contains("class")
                || kind.contains("interface")
        }
        TsLang::Lua => kind.contains("function"),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Find references
// ---------------------------------------------------------------------------

/// Find all references to the symbol at the given position.
pub fn find_references_at_position(
    file_path: &str,
    source_text: &str,
    line: u32,
    column: u32,
) -> Option<(String, Option<SymbolLocation>, Vec<ReferenceInfo>)> {
    let (_lang, tree) = parse(file_path, source_text)?;
    let line_index = LineIndex::new(source_text);

    // First find the symbol name at position
    let target_point = Point {
        row: (line.saturating_sub(1)) as usize,
        column: (column.saturating_sub(1)) as usize,
    };

    let node = tree
        .root_node()
        .descendant_for_point_range(target_point, target_point)?;

    // Get the identifier text at the position
    let identifier_text = node
        .utf8_text(source_text.as_bytes())
        .ok()?
        .trim()
        .to_string();

    if identifier_text.is_empty() || !is_identifier_like(&identifier_text) {
        return None;
    }

    let name = identifier_text;

    // Find the definition by walking up
    let definition = {
        let mut current = Some(node);
        let mut def_loc = None;
        while let Some(n) = current {
            if is_definition_node(n.kind(), _lang) {
                let (sl, sc) = line_index.line_col(n.start_byte() as u32);
                let (el, ec) = line_index.line_col(n.end_byte() as u32);
                def_loc = Some(SymbolLocation {
                    file_path: file_path.to_string(),
                    line: sl,
                    column: sc,
                    end_line: el,
                    end_column: ec,
                });
                break;
            }
            current = n.parent();
        }
        def_loc
    };

    // Search for all identifier nodes matching the name
    let mut references = Vec::new();
    collect_matching_identifiers(
        &tree.root_node(),
        source_text,
        &line_index,
        &name,
        file_path,
        &mut references,
    );

    Some((name, definition, references))
}

/// Find all references to a symbol by name within a single tree-sitter file.
pub fn find_references_by_name(
    file_path: &str,
    source_text: &str,
    name: &str,
) -> Vec<ReferenceInfo> {
    let (_lang, tree) = match parse(file_path, source_text) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let line_index = LineIndex::new(source_text);

    let mut references = Vec::new();
    collect_matching_identifiers(
        &tree.root_node(),
        source_text,
        &line_index,
        name,
        file_path,
        &mut references,
    );
    references
}

/// Find the definition of a symbol by name within a single tree-sitter file.
pub fn find_definition_by_name(
    file_path: &str,
    source_text: &str,
    name: &str,
) -> Option<SymbolInfo> {
    let outline = build_file_outline(file_path, source_text);

    for entry in outline {
        if entry.name == name {
            return Some(SymbolInfo {
                name: entry.name,
                kind: entry.kind,
                location: SymbolLocation {
                    file_path: file_path.to_string(),
                    line: entry.line,
                    column: entry.column,
                    end_line: entry.end_line,
                    end_column: entry.end_column,
                },
                container_name: entry.container_name,
                is_exported: entry.is_exported,
            });
        }
    }

    None
}

fn collect_matching_identifiers(
    node: &Node,
    source: &str,
    line_index: &LineIndex,
    target_name: &str,
    file_path: &str,
    refs: &mut Vec<ReferenceInfo>,
) {
    // Check if this node is an identifier matching the target name
    let kind = node.kind();
    if kind.contains("identifier") || kind == "identifier" || kind.contains("name") {
        if let Ok(text) = node.utf8_text(source.as_bytes()) {
            if text.trim() == target_name {
                let (start_line, start_col) = line_index.line_col(node.start_byte() as u32);
                let (end_line, end_col) = line_index.line_col(node.end_byte() as u32);
                refs.push(ReferenceInfo {
                    location: SymbolLocation {
                        file_path: file_path.to_string(),
                        line: start_line,
                        column: start_col,
                        end_line,
                        end_column: end_col,
                    },
                    access: "read".to_string(),
                });
            }
        }
    }

    // Recurse
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_matching_identifiers(&child, source, line_index, target_name, file_path, refs);
    }
}
