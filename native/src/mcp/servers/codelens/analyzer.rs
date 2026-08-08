use std::path::Path;

use oxc::allocator::Allocator;
use oxc::ast::ast;
use oxc::ast_visit::Visit;
use oxc::parser::ParseOptions;
use oxc::semantic::SemanticBuilder;
use oxc::span::{GetSpan, SourceType};

use super::types::{
    AnalyzedFile, OutlineEntry, ReferenceInfo, SymbolInfo, SymbolKind, SymbolLocation,
};

fn source_type_from_path(path: &Path) -> SourceType {
    SourceType::from_path(path).unwrap_or_default()
}

pub struct LineIndex {
    line_starts: Vec<u32>,
}

impl LineIndex {
    pub fn new(source: &str) -> Self {
        let mut line_starts = vec![0u32];
        for (offset, ch) in source.char_indices() {
            if ch == '\n' {
                line_starts.push((offset + 1) as u32);
            }
        }
        LineIndex { line_starts }
    }

    pub fn line_col(&self, offset: u32) -> (u32, u32) {
        let line_idx = match self.line_starts.binary_search(&offset) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        };
        let col = offset - self.line_starts[line_idx];
        (line_idx as u32 + 1, col + 1)
    }
}

pub struct LineIndexRef<'a> {
    inner: LineIndex,
    _marker: std::marker::PhantomData<&'a str>,
}

impl<'a> LineIndexRef<'a> {
    pub fn new(source: &str) -> Self {
        LineIndexRef {
            inner: LineIndex::new(source),
            _marker: std::marker::PhantomData,
        }
    }

    pub fn line_col(&self, offset: u32) -> (u32, u32) {
        self.inner.line_col(offset)
    }
}

/// Analyze a JS/TS file with oxc, collecting symbols, references and
/// unresolved references for definition / reference lookups.
pub fn analyze_file(file_path: &str, source_text: &str) -> AnalyzedFile {
    let path = Path::new(file_path);
    let source_type = source_type_from_path(path);
    let line_index = LineIndex::new(source_text);

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
    let nodes = semantic.nodes();

    let mut symbols: Vec<SymbolInfo> = Vec::new();
    for symbol_id in scoping.symbol_ids() {
        let name = scoping.symbol_name(symbol_id).to_string();
        let flags = scoping.symbol_flags(symbol_id);
        let span = scoping.symbol_span(symbol_id);
        let kind = symbol_kind_from_flags(flags);

        let (start_line, start_col) = line_index.line_col(span.start);
        let (end_line, end_col) = line_index.line_col(span.end);

        symbols.push(SymbolInfo {
            name,
            kind: kind.as_str().to_string(),
            location: SymbolLocation {
                file_path: file_path.to_string(),
                line: start_line,
                column: start_col,
                end_line,
                end_column: end_col,
            },
            container_name: None,
            is_exported: false,
        });
    }

    let mut references: Vec<(String, ReferenceInfo)> = Vec::new();
    let mut unresolved_references: Vec<(String, ReferenceInfo)> = Vec::new();

    for symbol_id in scoping.symbol_ids() {
        let name = scoping.symbol_name(symbol_id).to_string();
        for ref_id in scoping.get_resolved_reference_ids(symbol_id) {
            let reference = scoping.get_reference(*ref_id);
            let node = nodes.get_node(reference.node_id());
            let span = node.span();
            let (start_line, start_col) = line_index.line_col(span.start);
            let (end_line, end_col) = line_index.line_col(span.end);
            let access = reference_access_str(reference);
            references.push((
                name.clone(),
                ReferenceInfo {
                    location: SymbolLocation {
                        file_path: file_path.to_string(),
                        line: start_line,
                        column: start_col,
                        end_line,
                        end_column: end_col,
                    },
                    access: access.to_string(),
                },
            ));
        }
    }

    for (name, ref_ids) in scoping.root_unresolved_references() {
        for ref_id in ref_ids {
            let reference = scoping.get_reference(*ref_id);
            let node = nodes.get_node(reference.node_id());
            let span = node.span();
            let (start_line, start_col) = line_index.line_col(span.start);
            let (end_line, end_col) = line_index.line_col(span.end);
            let access = reference_access_str(reference);
            unresolved_references.push((
                name.to_string(),
                ReferenceInfo {
                    location: SymbolLocation {
                        file_path: file_path.to_string(),
                        line: start_line,
                        column: start_col,
                        end_line,
                        end_column: end_col,
                    },
                    access: access.to_string(),
                },
            ));
        }
    }

    AnalyzedFile {
        file_path: file_path.to_string(),
        source_text: source_text.to_string(),
        symbols,
        references,
        unresolved_references,
    }
}

fn symbol_kind_from_flags(flags: oxc::semantic::SymbolFlags) -> SymbolKind {
    if flags.is_function() {
        SymbolKind::Function
    } else if flags.is_class() {
        SymbolKind::Class
    } else if flags.is_import() {
        SymbolKind::Import
    } else if flags.is_enum_member() {
        SymbolKind::EnumMember
    } else if flags.is_enum() {
        SymbolKind::Enum
    } else if flags.is_type_alias() {
        SymbolKind::Type
    } else if flags.is_interface() {
        SymbolKind::Interface
    } else if flags.is_const_variable() {
        SymbolKind::Constant
    } else {
        SymbolKind::Variable
    }
}

fn reference_access_str(reference: &oxc::semantic::Reference) -> &'static str {
    match (reference.is_read(), reference.is_write()) {
        (true, true) => "read-write",
        (false, true) => "write",
        _ => "read",
    }
}

pub fn build_file_outline(file_path: &str, source_text: &str) -> Vec<OutlineEntry> {
    let path = Path::new(file_path);
    let source_type = source_type_from_path(path);
    let line_index = LineIndex::new(source_text);

    let allocator = Allocator::default();
    let parse_ret = oxc::parser::Parser::new(&allocator, source_text, source_type)
        .with_options(ParseOptions {
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .parse();

    let program = parse_ret.program;

    let mut visitor = OutlineVisitor {
        entries: Vec::new(),
        line_index: &line_index,
    };
    visitor.visit_program(&program);
    visitor.entries
}

struct OutlineVisitor<'a> {
    entries: Vec<OutlineEntry>,
    line_index: &'a LineIndex,
}

impl<'a> Visit<'a> for OutlineVisitor<'a> {
    fn visit_variable_declarator(&mut self, it: &ast::VariableDeclarator<'_>) {
        if let Some(name) = get_binding_name_from_pattern(&it.id) {
            let (start_line, start_col) = self.line_index.line_col(it.span.start);
            let (end_line, end_col) = self.line_index.line_col(it.span.end);
            let is_const = matches!(it.kind, ast::VariableDeclarationKind::Const);
            self.entries.push(OutlineEntry {
                name,
                kind: if is_const { "constant" } else { "variable" }.to_string(),
                line: start_line,
                column: start_col,
                end_line,
                end_column: end_col,
                container_name: None,
                is_exported: false,
                children: Vec::new(),
            });
        }
    }

    fn visit_function(&mut self, it: &ast::Function<'_>, _flags: oxc::semantic::ScopeFlags) {
        if let Some(name) = it.name() {
            let name_str = name.as_str().to_string();
            let (start_line, start_col) = self.line_index.line_col(it.span.start);
            let (end_line, end_col) = self.line_index.line_col(it.span.end);
            self.entries.push(OutlineEntry {
                name: name_str,
                kind: "function".to_string(),
                line: start_line,
                column: start_col,
                end_line,
                end_column: end_col,
                container_name: None,
                is_exported: false,
                children: Vec::new(),
            });
        }
    }

    fn visit_class(&mut self, it: &ast::Class<'_>) {
        if let Some(name) = it.name() {
            let name_str = name.as_str().to_string();
            let (start_line, start_col) = self.line_index.line_col(it.span.start);
            let (end_line, end_col) = self.line_index.line_col(it.span.end);
            self.entries.push(OutlineEntry {
                name: name_str,
                kind: "class".to_string(),
                line: start_line,
                column: start_col,
                end_line,
                end_column: end_col,
                container_name: None,
                is_exported: false,
                children: Vec::new(),
            });
        }
    }

    fn visit_method_definition(&mut self, it: &ast::MethodDefinition<'_>) {
        if let Some(name) = get_property_name(&it.key) {
            let (start_line, start_col) = self.line_index.line_col(it.span.start);
            let (end_line, end_col) = self.line_index.line_col(it.span.end);
            let kind = match it.kind {
                ast::MethodDefinitionKind::Constructor => "constructor",
                ast::MethodDefinitionKind::Method => "method",
                ast::MethodDefinitionKind::Get => "property",
                ast::MethodDefinitionKind::Set => "property",
            };
            self.entries.push(OutlineEntry {
                name,
                kind: kind.to_string(),
                line: start_line,
                column: start_col,
                end_line,
                end_column: end_col,
                container_name: None,
                is_exported: false,
                children: Vec::new(),
            });
        }
    }

    fn visit_ts_interface_declaration(&mut self, it: &ast::TSInterfaceDeclaration<'_>) {
        let name_str = it.id.name.as_str().to_string();
        let (start_line, start_col) = self.line_index.line_col(it.span.start);
        let (end_line, end_col) = self.line_index.line_col(it.span.end);
        self.entries.push(OutlineEntry {
            name: name_str,
            kind: "interface".to_string(),
            line: start_line,
            column: start_col,
            end_line,
            end_column: end_col,
            container_name: None,
            is_exported: it.declare,
            children: Vec::new(),
        });
    }

    fn visit_ts_type_alias_declaration(&mut self, it: &ast::TSTypeAliasDeclaration<'_>) {
        let name_str = it.id.name.as_str().to_string();
        let (start_line, start_col) = self.line_index.line_col(it.span.start);
        let (end_line, end_col) = self.line_index.line_col(it.span.end);
        self.entries.push(OutlineEntry {
            name: name_str,
            kind: "type".to_string(),
            line: start_line,
            column: start_col,
            end_line,
            end_column: end_col,
            container_name: None,
            is_exported: it.declare,
            children: Vec::new(),
        });
    }

    fn visit_ts_enum_declaration(&mut self, it: &ast::TSEnumDeclaration<'_>) {
        let name_str = it.id.name.as_str().to_string();
        let (start_line, start_col) = self.line_index.line_col(it.span.start);
        let (end_line, end_col) = self.line_index.line_col(it.span.end);
        self.entries.push(OutlineEntry {
            name: name_str,
            kind: "enum".to_string(),
            line: start_line,
            column: start_col,
            end_line,
            end_column: end_col,
            container_name: None,
            is_exported: it.declare,
            children: Vec::new(),
        });
    }

    fn visit_import_declaration(&mut self, _it: &ast::ImportDeclaration<'_>) {}
}

fn get_binding_name_from_pattern(pattern: &ast::BindingPattern<'_>) -> Option<String> {
    match &pattern.kind {
        ast::BindingPatternKind::BindingIdentifier(id) => Some(id.name.as_str().to_string()),
        _ => None,
    }
}

fn get_property_name(key: &ast::PropertyKey<'_>) -> Option<String> {
    match key {
        ast::PropertyKey::Identifier(ident) => Some(ident.name.as_str().to_string()),
        ast::PropertyKey::PrivateIdentifier(ident) => Some(ident.name.as_str().to_string()),
        ast::PropertyKey::StringLiteral(lit) => Some(lit.value.as_str().to_string()),
        _ => None,
    }
}

pub fn find_symbol_at_position(
    file_path: &str,
    source_text: &str,
    line: u32,
    column: u32,
) -> Option<(String, SymbolInfo)> {
    let analyzed = analyze_file(file_path, source_text);
    let line_index = LineIndex::new(source_text);
    let offset = byte_offset_from_line_col(&line_index, line, column);

    for symbol in &analyzed.symbols {
        let start =
            byte_offset_from_line_col(&line_index, symbol.location.line, symbol.location.column);
        let end = byte_offset_from_line_col(
            &line_index,
            symbol.location.end_line,
            symbol.location.end_column,
        );
        if offset >= start && offset < end {
            return Some((symbol.name.clone(), symbol.clone()));
        }
    }

    for (name, ref_info) in &analyzed.references {
        let start = byte_offset_from_line_col(
            &line_index,
            ref_info.location.line,
            ref_info.location.column,
        );
        let end = byte_offset_from_line_col(
            &line_index,
            ref_info.location.end_line,
            ref_info.location.end_column,
        );
        if offset >= start && offset < end {
            for symbol in &analyzed.symbols {
                if symbol.name == *name {
                    return Some((symbol.name.clone(), symbol.clone()));
                }
            }
        }
    }

    None
}

pub fn find_references_at_position(
    file_path: &str,
    source_text: &str,
    line: u32,
    column: u32,
) -> Option<(String, Option<SymbolLocation>, Vec<ReferenceInfo>)> {
    let analyzed = analyze_file(file_path, source_text);
    let line_index = LineIndex::new(source_text);
    let offset = byte_offset_from_line_col(&line_index, line, column);

    let mut symbol_name: Option<String> = None;

    for symbol in &analyzed.symbols {
        let start =
            byte_offset_from_line_col(&line_index, symbol.location.line, symbol.location.column);
        let end = byte_offset_from_line_col(
            &line_index,
            symbol.location.end_line,
            symbol.location.end_column,
        );
        if offset >= start && offset < end {
            symbol_name = Some(symbol.name.clone());
            break;
        }
    }

    if symbol_name.is_none() {
        for (name, ref_info) in &analyzed.references {
            let start = byte_offset_from_line_col(
                &line_index,
                ref_info.location.line,
                ref_info.location.column,
            );
            let end = byte_offset_from_line_col(
                &line_index,
                ref_info.location.end_line,
                ref_info.location.end_column,
            );
            if offset >= start && offset < end {
                symbol_name = Some(name.clone());
                break;
            }
        }
    }

    let name = symbol_name?;

    let definition = analyzed
        .symbols
        .iter()
        .find(|s| s.name == name)
        .map(|s| s.location.clone());

    let refs: Vec<ReferenceInfo> = analyzed
        .references
        .iter()
        .filter(|(n, _)| *n == name)
        .map(|(_, r)| r.clone())
        .collect();

    Some((name, definition, refs))
}

/// Find all references to a symbol by name within a single JS/TS file.
/// Includes both resolved references, unresolved references, and the definition itself.
pub fn find_references_by_name(
    file_path: &str,
    source_text: &str,
    name: &str,
) -> Vec<ReferenceInfo> {
    let analyzed = analyze_file(file_path, source_text);
    let mut refs = Vec::new();

    // The definition itself
    for symbol in &analyzed.symbols {
        if symbol.name == name {
            refs.push(ReferenceInfo {
                location: symbol.location.clone(),
                access: "definition".to_string(),
            });
        }
    }

    // Resolved references
    for (n, r) in &analyzed.references {
        if n == name {
            refs.push(r.clone());
        }
    }

    // Unresolved references (e.g. usage of imported symbols)
    for (n, r) in &analyzed.unresolved_references {
        if n == name {
            refs.push(r.clone());
        }
    }

    refs
}

/// Find the definition of a symbol by name within a single JS/TS file.
pub fn find_definition_by_name(
    file_path: &str,
    source_text: &str,
    name: &str,
) -> Option<SymbolInfo> {
    let analyzed = analyze_file(file_path, source_text);
    analyzed.symbols.into_iter().find(|s| s.name == name)
}

fn byte_offset_from_line_col(line_index: &LineIndex, line: u32, col: u32) -> u32 {
    let line_idx = (line.saturating_sub(1)) as usize;
    if line_idx < line_index.line_starts.len() {
        line_index.line_starts[line_idx] + col.saturating_sub(1)
    } else {
        u32::MAX
    }
}
