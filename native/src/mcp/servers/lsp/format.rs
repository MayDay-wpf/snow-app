//! LSP 响应 → agent 友好输出（JSON + Markdown，见设计文档 §8.1/§8.2）。

use lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall, Diagnostic,
    DiagnosticSeverity, DocumentChanges, DocumentSymbol, DocumentSymbolResponse,
    GotoDefinitionResponse, Hover, HoverContents, Location, LocationLink, MarkedString,
    NumberOrString, OneOf, SymbolInformation, TextEdit, TypeHierarchyItem, Url, WorkspaceEdit,
};
use serde_json::{json, Value};

use super::types::LspError;

/// 最大返回诊断条数（§10 输出限制）。
const MAX_DIAGNOSTICS: usize = 200;

/// 单条诊断 → JSON。
pub fn diagnostic_to_json(diagnostic: &Diagnostic) -> Value {
    let severity = match diagnostic.severity {
        Some(DiagnosticSeverity::ERROR) => "error",
        Some(DiagnosticSeverity::WARNING) => "warning",
        Some(DiagnosticSeverity::INFORMATION) => "information",
        Some(DiagnosticSeverity::HINT) => "hint",
        Some(_) => "unknown",
        None => "unknown",
    };
    let range = diagnostic.range;
    json!({
        "severity": severity,
        "message": diagnostic.message,
        "source": diagnostic.source,
        "code": diagnostic.code.as_ref().map(|c| match c {
            NumberOrString::Number(n) => n.to_string(),
            NumberOrString::String(s) => s.clone(),
        }),
        "line": range.start.line + 1,
        "column": range.start.character + 1,
        "endLine": range.end.line + 1,
        "endColumn": range.end.character + 1,
    })
}

/// 诊断统计摘要。
pub fn diagnostics_summary(items: &[Diagnostic]) -> String {
    let errors = items
        .iter()
        .filter(|d| d.severity == Some(DiagnosticSeverity::ERROR))
        .count();
    let warnings = items
        .iter()
        .filter(|d| d.severity == Some(DiagnosticSeverity::WARNING))
        .count();
    let infos = items
        .iter()
        .filter(|d| {
            matches!(
                d.severity,
                Some(DiagnosticSeverity::INFORMATION) | Some(DiagnosticSeverity::HINT)
            )
        })
        .count();
    format!("{errors} errors, {warnings} warnings, {infos} infos")
}

/// 诊断列表 → 工具输出 JSON。
pub fn diagnostics_to_value(language: &str, server: &str, diagnostics: Vec<Diagnostic>) -> Value {
    let total = diagnostics.len();
    let shown: Vec<Value> = diagnostics
        .iter()
        .take(MAX_DIAGNOSTICS)
        .map(diagnostic_to_json)
        .collect();
    let summary = if total > MAX_DIAGNOSTICS {
        format!(
            "{} (truncated to {MAX_DIAGNOSTICS})",
            diagnostics_summary(&diagnostics)
        )
    } else {
        diagnostics_summary(&diagnostics)
    };
    json!({
        "language": language,
        "server": server,
        "summary": summary,
        "total": total,
        "diagnosticTotal": total,
        "truncated": total > MAX_DIAGNOSTICS,
        "partial": total > MAX_DIAGNOSTICS,
        "status": if total > MAX_DIAGNOSTICS { "partial" } else { "complete" },
        "diagnostics": shown,
    })
}

/// hover 内容 → Markdown 文本。
pub fn hover_contents_to_markdown(contents: &HoverContents) -> String {
    match contents {
        HoverContents::Scalar(marked) => marked_string_to_markdown(marked),
        HoverContents::Array(items) => items
            .iter()
            .map(marked_string_to_markdown)
            .collect::<Vec<_>>()
            .join("\n\n"),
        HoverContents::Markup(markup) => markup.value.clone(),
    }
}

fn marked_string_to_markdown(marked: &MarkedString) -> String {
    match marked {
        MarkedString::String(text) => text.clone(),
        MarkedString::LanguageString(lang_string) => {
            format!("```{}\n{}\n```", lang_string.language, lang_string.value)
        }
    }
}

/// hover 响应 → 工具输出 JSON。
pub fn hover_to_value(language: &str, hover: &Hover) -> Value {
    let range = hover.range;
    let range_value = range.map(|range| {
        json!({
            "start": { "line": range.start.line + 1, "column": range.start.character + 1 },
            "end": { "line": range.end.line + 1, "column": range.end.character + 1 },
        })
    });
    json!({
        "language": language,
        "contents": hover_contents_to_markdown(&hover.contents),
        "range": range_value,
    })
}

/// Location → JSON（uri 转文件路径）。
fn location_to_json(location: &Location) -> Value {
    let file_path = location
        .uri
        .to_file_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| location.uri.as_str().to_string());
    json!({
        "filePath": file_path,
        "line": location.range.start.line + 1,
        "column": location.range.start.character + 1,
        "endLine": location.range.end.line + 1,
        "endColumn": location.range.end.character + 1,
    })
}

/// LocationLink → JSON（含目标 uri/range + 选择范围）。
fn location_link_to_json(link: &LocationLink) -> Value {
    let file_path = link
        .target_uri
        .to_file_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| link.target_uri.as_str().to_string());
    json!({
        "filePath": file_path,
        "line": link.target_range.start.line + 1,
        "column": link.target_range.start.character + 1,
        "endLine": link.target_range.end.line + 1,
        "endColumn": link.target_range.end.character + 1,
        "selectionLine": link.target_selection_range.start.line + 1,
        "selectionColumn": link.target_selection_range.start.character + 1,
    })
}

/// goto definition 响应 → 工具输出 JSON（对齐 codelens-find_definition 输出）。
///
/// LSP 不返回符号名/类型：name 由调用方从请求位置行提取后传入。
pub fn definition_to_value(
    language: &str,
    name: &str,
    response: Option<GotoDefinitionResponse>,
) -> Value {
    let definitions = match response {
        Some(GotoDefinitionResponse::Scalar(location)) => vec![location_to_json(&location)],
        Some(GotoDefinitionResponse::Array(locations)) => {
            locations.iter().map(location_to_json).collect()
        }
        Some(GotoDefinitionResponse::Link(links)) => {
            links.iter().map(location_link_to_json).collect()
        }
        None => Vec::new(),
    };
    json!({
        "language": language,
        "name": name,
        "count": definitions.len(),
        "definitions": definitions,
    })
}

/// references 响应 → 工具输出 JSON（含每个引用位置的代码上下文）。
///
/// contexts 与 locations 一一对应（调用方读取所在行文本）。
pub fn references_to_value(
    language: &str,
    symbol: &str,
    locations: &[Location],
    contexts: &[String],
) -> Value {
    let references: Vec<Value> = locations
        .iter()
        .zip(contexts.iter())
        .map(|(location, context)| {
            let mut item = location_to_json(location);
            if let Value::Object(map) = &mut item {
                map.insert("context".to_string(), json!(context));
            }
            item
        })
        .collect();
    json!({
        "language": language,
        "symbol": symbol,
        "count": references.len(),
        "references": references,
    })
}

/// SymbolKind 数字 → 名称（LSP 3.17 枚举，仅映射常用项）。
fn symbol_kind_name(kind: lsp_types::SymbolKind) -> &'static str {
    match kind {
        lsp_types::SymbolKind::FILE => "file",
        lsp_types::SymbolKind::MODULE => "module",
        lsp_types::SymbolKind::NAMESPACE => "namespace",
        lsp_types::SymbolKind::PACKAGE => "package",
        lsp_types::SymbolKind::CLASS => "class",
        lsp_types::SymbolKind::METHOD => "method",
        lsp_types::SymbolKind::PROPERTY => "property",
        lsp_types::SymbolKind::FIELD => "field",
        lsp_types::SymbolKind::CONSTRUCTOR => "constructor",
        lsp_types::SymbolKind::ENUM => "enum",
        lsp_types::SymbolKind::INTERFACE => "interface",
        lsp_types::SymbolKind::FUNCTION => "function",
        lsp_types::SymbolKind::VARIABLE => "variable",
        lsp_types::SymbolKind::CONSTANT => "constant",
        lsp_types::SymbolKind::STRING => "string",
        lsp_types::SymbolKind::NUMBER => "number",
        lsp_types::SymbolKind::BOOLEAN => "boolean",
        lsp_types::SymbolKind::ARRAY => "array",
        lsp_types::SymbolKind::OBJECT => "object",
        lsp_types::SymbolKind::KEY => "key",
        lsp_types::SymbolKind::NULL => "null",
        lsp_types::SymbolKind::ENUM_MEMBER => "enum member",
        lsp_types::SymbolKind::STRUCT => "struct",
        lsp_types::SymbolKind::EVENT => "event",
        lsp_types::SymbolKind::OPERATOR => "operator",
        lsp_types::SymbolKind::TYPE_PARAMETER => "type parameter",
        _ => "unknown",
    }
}

/// DocumentSymbol（树形）→ JSON。
fn document_symbol_to_json(symbol: &DocumentSymbol) -> Value {
    let range = symbol.range;
    let selection = symbol.selection_range;
    json!({
        "name": symbol.name,
        "kind": symbol_kind_name(symbol.kind),
        "detail": symbol.detail,
        "range": {
            "start": { "line": range.start.line + 1, "column": range.start.character + 1 },
            "end": { "line": range.end.line + 1, "column": range.end.character + 1 },
        },
        "selection": {
            "start": { "line": selection.start.line + 1, "column": selection.start.character + 1 },
            "end": { "line": selection.end.line + 1, "column": selection.end.character + 1 },
        },
        "children": symbol.children.as_ref().map(|children| {
            children.iter().map(document_symbol_to_json).collect::<Vec<_>>()
        }),
    })
}

/// documentSymbol 响应 → 工具输出 JSON（树形大纲）。
pub fn symbols_to_value(language: &str, response: Option<DocumentSymbolResponse>) -> Value {
    let symbols = match response {
        Some(DocumentSymbolResponse::Nested(symbols)) => symbols
            .iter()
            .map(document_symbol_to_json)
            .collect::<Vec<_>>(),
        Some(DocumentSymbolResponse::Flat(symbols)) => symbols
            .iter()
            .map(symbol_information_to_json)
            .collect::<Vec<_>>(),
        None => Vec::new(),
    };
    json!({
        "language": language,
        "count": symbols.len(),
        "symbols": symbols,
    })
}

/// SymbolInformation（扁平）→ JSON。
fn symbol_information_to_json(symbol: &SymbolInformation) -> Value {
    let location = symbol.location.clone();
    json!({
        "name": symbol.name,
        "kind": symbol_kind_name(symbol.kind),
        "detail": symbol.container_name,
        "range": {
            "start": { "line": location.range.start.line + 1, "column": location.range.start.character + 1 },
            "end": { "line": location.range.end.line + 1, "column": location.range.end.character + 1 },
        },
        "children": null,
    })
}

/// 从 WorkspaceEdit 提取 (uri, TextEdit 列表)：优先 `document_changes::Edits`，
/// 回退 `changes` 映射；`Operations` 类变更（create/rename/delete file）不支持
/// 自动应用 → 返回明确的 Unsupported 错误（不得静默丢弃，R1.2）。
pub(crate) fn workspace_edit_files(
    edit: &WorkspaceEdit,
) -> Result<Vec<(Url, Vec<TextEdit>)>, LspError> {
    Ok(workspace_edit_files_versioned(edit)?
        .into_iter()
        .map(|(uri, _, edits)| (uri, edits))
        .collect())
}

/// 保留TextDocumentEdit版本用于安全预览；changes映射没有版本。
pub(crate) fn workspace_edit_files_versioned(
    edit: &WorkspaceEdit,
) -> Result<Vec<(Url, Option<i32>, Vec<TextEdit>)>, LspError> {
    if let Some(doc_changes) = &edit.document_changes {
        match doc_changes {
            DocumentChanges::Edits(edits) => {
                return Ok(edits
                    .iter()
                    .map(|text_document_edit| {
                        let edits = text_document_edit
                            .edits
                            .iter()
                            .filter_map(|one_of: &OneOf<TextEdit, lsp_types::AnnotatedTextEdit>| {
                                match one_of {
                                    OneOf::Left(text_edit) => Some(text_edit.clone()),
                                    OneOf::Right(annotated) => Some(annotated.text_edit.clone()),
                                }
                            })
                            .collect::<Vec<_>>();
                        (
                            text_document_edit.text_document.uri.clone(),
                            text_document_edit.text_document.version,
                            edits,
                        )
                    })
                    .collect());
            }
            DocumentChanges::Operations(_) => {
                return Err(LspError::Unsupported(
                    "documentChanges.operations (create/rename/delete file) is not supported yet — edit was NOT applied"
                        .into(),
                ));
            }
        }
    }
    Ok(edit
        .changes
        .as_ref()
        .map(|changes| {
            changes
                .iter()
                .map(|(uri, edits)| (uri.clone(), None, edits.clone()))
                .collect()
        })
        .unwrap_or_default())
}

/// WorkspaceEdit → 工具输出 JSON（rename dryRun / codeAction edits 预览；多文件）。
///
/// 含 `documentChanges.operations`（create/rename/delete file）时无法预览/应用：
/// 输出 `"unsupportedOperations": true` 标记（仅新增字段，不改变现有字段形状），
/// 避免空文件列表被误读为「无变更」。
pub fn workspace_edit_to_value(edit: &WorkspaceEdit) -> Value {
    let mut unsupported_operations = false;
    let files: Vec<Value> = match workspace_edit_files_versioned(edit) {
        Ok(files) => files
            .iter()
            .map(|(uri, version, edits)| {
                json!({
                    "uri": uri.to_string(),
                    "documentVersion": version,
                    "editCount": edits.len(),
                    "edits": edits.iter().map(|edit| json!({
                        "startLine": edit.range.start.line + 1,
                        "startColumn": edit.range.start.character + 1,
                        "endLine": edit.range.end.line + 1,
                        "endColumn": edit.range.end.character + 1,
                        "newText": edit.new_text,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect(),
        Err(_) => {
            unsupported_operations = true;
            Vec::new()
        }
    };
    let mut value = json!({
        "changeCount": files.len(),
        "files": files,
    });
    if unsupported_operations {
        value["unsupportedOperations"] = json!(true);
    }
    value
}

/// workspace/symbol 响应 → 完整内部 JSON；展示条数上限仅由工具入口实施。
///
/// 3.17 双形态：`Flat`（SymbolInformation 列表）与 `Nested`（WorkspaceSymbol 列表）。
/// `project_root` 用于标记符号是否属于当前项目（`inProject`，标准库/依赖为 false）。
pub fn workspace_symbols_to_value(
    language: &str,
    query: &str,
    project_root: &std::path::Path,
    response: Option<lsp_types::WorkspaceSymbolResponse>,
) -> Value {
    let symbols: Vec<Value> = match response {
        Some(lsp_types::WorkspaceSymbolResponse::Flat(list)) => list
            .iter()
            .map(|symbol| symbol_information_workspace_json(symbol, project_root))
            .collect(),
        Some(lsp_types::WorkspaceSymbolResponse::Nested(list)) => list
            .iter()
            .map(|symbol| workspace_symbol_json(symbol, project_root))
            .collect(),
        None => Vec::new(),
    };
    let total = symbols.len();
    // 内部寻址必须消费完整候选集；显示限额由工具入口最后实施。
    json!({
        "language": language,
        "query": query,
        "count": total,
        "total": total,
        "truncated": false,
        "symbols": symbols,
    })
}

/// 判断文件路径是否位于项目根内（Windows 大小写不敏感）。
fn is_in_project(project_root: &std::path::Path, file_path: &str) -> bool {
    let normalize = |path: &str| {
        let path = path.replace('\\', "/");
        let path = path.strip_prefix("//?/").unwrap_or(&path);
        if cfg!(windows) {
            path.to_ascii_lowercase()
        } else {
            path.to_string()
        }
    };
    let root = normalize(&project_root.to_string_lossy());
    let path = normalize(file_path);
    std::path::Path::new(&path).starts_with(std::path::Path::new(&root))
}

/// SymbolInformation（Flat 形态）→ 平铺 JSON（含 filePath / inProject）。
fn symbol_information_workspace_json(
    symbol: &SymbolInformation,
    project_root: &std::path::Path,
) -> Value {
    let location = symbol.location.clone();
    let file_path = location
        .uri
        .to_file_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| location.uri.as_str().to_string());
    json!({
        "name": symbol.name,
        "kind": symbol_kind_name(symbol.kind),
        "detail": symbol.container_name,
        "filePath": file_path,
        "inProject": is_in_project(project_root, &file_path),
        "line": location.range.start.line + 1,
        "column": location.range.start.character + 1,
        "endLine": location.range.end.line + 1,
        "endColumn": location.range.end.character + 1,
    })
}

/// WorkspaceSymbol（Nested 形态，3.17）→ 平铺 JSON（含 filePath / inProject）。
///
/// location 是 `OneOf<Location, WorkspaceLocation>`：Left 带 range，Right 仅 uri
/// （WorkspaceLocation 无 range，位置字段输出 0）。
fn workspace_symbol_json(
    symbol: &lsp_types::WorkspaceSymbol,
    project_root: &std::path::Path,
) -> Value {
    let (file_path, line, column, end_line, end_column) = match &symbol.location {
        OneOf::Left(loc) => {
            let path = loc
                .uri
                .to_file_path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| loc.uri.as_str().to_string());
            (
                path,
                loc.range.start.line + 1,
                loc.range.start.character + 1,
                loc.range.end.line + 1,
                loc.range.end.character + 1,
            )
        }
        OneOf::Right(ws_loc) => {
            let path = ws_loc
                .uri
                .to_file_path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ws_loc.uri.as_str().to_string());
            (path, 0u32, 0u32, 0u32, 0u32)
        }
    };
    json!({
        "name": symbol.name,
        "kind": symbol_kind_name(symbol.kind),
        "detail": symbol.container_name,
        "filePath": file_path,
        "inProject": is_in_project(project_root, &file_path),
        "line": line,
        "column": column,
        "endLine": end_line,
        "endColumn": end_column,
    })
}

/// CallHierarchyItem → JSON（name/kind/detail + 选择范围位置）。
fn call_hierarchy_item_to_json(item: &CallHierarchyItem) -> Value {
    let file_path = item
        .uri
        .to_file_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| item.uri.as_str().to_string());
    json!({
        "name": item.name,
        "kind": symbol_kind_name(item.kind),
        "detail": item.detail,
        "filePath": file_path,
        "line": item.selection_range.start.line + 1,
        "column": item.selection_range.start.character + 1,
    })
}

/// TypeHierarchyItem → JSON（结构同 CallHierarchyItem）。
fn type_hierarchy_item_to_json(item: &TypeHierarchyItem) -> Value {
    let file_path = item
        .uri
        .to_file_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| item.uri.as_str().to_string());
    json!({
        "name": item.name,
        "kind": symbol_kind_name(item.kind),
        "detail": item.detail,
        "filePath": file_path,
        "line": item.selection_range.start.line + 1,
        "column": item.selection_range.start.character + 1,
    })
}

/// callHierarchy 响应 → 工具输出 JSON（双向调用链，每个调用点带代码上下文）。
///
/// incoming：谁调用了该函数（caller + 调用点）；outgoing：该函数调用了谁
/// （callee + 调用点）。incoming 调用点位于调用者 from.uri 文件；outgoing 调用点
/// 位于**调用者**文件（即 prepare 时的当前文件，由 caller_path 给出）。
/// contexts 与 calls 一一对应（调用方读取调用点所在行）。
pub fn call_hierarchy_to_value(
    language: &str,
    symbol: &str,
    caller_path: &str,
    incoming: &[CallHierarchyIncomingCall],
    incoming_contexts: &[Vec<String>],
    outgoing: &[CallHierarchyOutgoingCall],
    outgoing_contexts: &[Vec<String>],
) -> Value {
    let incoming_json: Vec<Value> = incoming
        .iter()
        .zip(incoming_contexts.iter())
        .map(|(call, contexts)| {
            let call_sites: Vec<Value> = call
                .from_ranges
                .iter()
                .zip(contexts.iter())
                .map(|(range, context)| {
                    json!({
                        "filePath": hierarchy_item_path(&call.from.uri),
                        "line": range.start.line + 1,
                        "column": range.start.character + 1,
                        "context": context,
                    })
                })
                .collect();
            json!({
                "caller": call_hierarchy_item_to_json(&call.from),
                "callSites": call_sites,
            })
        })
        .collect();
    let outgoing_json: Vec<Value> = outgoing
        .iter()
        .zip(outgoing_contexts.iter())
        .map(|(call, contexts)| {
            let call_sites: Vec<Value> = call
                .from_ranges
                .iter()
                .zip(contexts.iter())
                .map(|(range, context)| {
                    json!({
                        "filePath": caller_path,
                        "line": range.start.line + 1,
                        "column": range.start.character + 1,
                        "context": context,
                    })
                })
                .collect();
            json!({
                "callee": call_hierarchy_item_to_json(&call.to),
                "callSites": call_sites,
            })
        })
        .collect();
    json!({
        "language": language,
        "symbol": symbol,
        "incomingCount": incoming_json.len(),
        "outgoingCount": outgoing_json.len(),
        "incoming": incoming_json,
        "outgoing": outgoing_json,
    })
}

/// callHierarchy 空结果（prepare 未命中任何条目时调用方返回）。
pub fn call_hierarchy_empty(language: &str, symbol: &str) -> Value {
    json!({
        "language": language,
        "symbol": symbol,
        "incomingCount": 0,
        "outgoingCount": 0,
        "incoming": [],
        "outgoing": [],
    })
}

/// typeHierarchy 响应 → 工具输出 JSON（父类型链 + 全部子类型）。
pub fn type_hierarchy_to_value(
    language: &str,
    symbol: &str,
    supertypes: &[TypeHierarchyItem],
    subtypes: &[TypeHierarchyItem],
) -> Value {
    json!({
        "language": language,
        "symbol": symbol,
        "supertypesCount": supertypes.len(),
        "subtypesCount": subtypes.len(),
        "supertypes": supertypes.iter().map(type_hierarchy_item_to_json).collect::<Vec<_>>(),
        "subtypes": subtypes.iter().map(type_hierarchy_item_to_json).collect::<Vec<_>>(),
    })
}

/// typeHierarchy 空结果（prepare 未命中任何条目时调用方返回）。
pub fn type_hierarchy_empty(language: &str, symbol: &str) -> Value {
    json!({
        "language": language,
        "symbol": symbol,
        "supertypesCount": 0,
        "subtypesCount": 0,
        "supertypes": [],
        "subtypes": [],
    })
}

/// hierarchy 条目 uri → 本地路径（调用点所在文件路径展示用）。
fn hierarchy_item_path(uri: &Url) -> String {
    uri.to_file_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| uri.as_str().to_string())
}

#[cfg(test)]
mod addressing_tests {
    use super::*;

    #[test]
    fn workspace_edit_preserves_document_versions() {
        let edit: WorkspaceEdit = serde_json::from_value(json!({"documentChanges":[{"textDocument":{"uri":"file:///fixture/b.rs","version":7},"edits":[]}]})).unwrap();
        let files = workspace_edit_files_versioned(&edit).unwrap();
        assert_eq!(files[0].1, Some(7));
        assert_eq!(
            workspace_edit_to_value(&edit)["files"][0]["documentVersion"],
            7
        );
        let unversioned: WorkspaceEdit =
            serde_json::from_value(json!({"changes":{"file:///fixture/b.rs":[]}})).unwrap();
        assert_eq!(
            workspace_edit_files_versioned(&unversioned).unwrap()[0].1,
            None
        );
    }

    #[test]
    #[allow(deprecated)]
    fn workspace_response_preserves_more_than_fifty_candidates() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let uri = Url::from_file_path(root.join("src/lib.rs")).unwrap();
        let symbols = (0..75)
            .map(|line| SymbolInformation {
                name: "same_name".into(),
                kind: lsp_types::SymbolKind::FUNCTION,
                tags: None,
                deprecated: None,
                container_name: None,
                location: Location {
                    uri: uri.clone(),
                    range: lsp_types::Range {
                        start: lsp_types::Position::new(line, 0),
                        end: lsp_types::Position::new(line, 9),
                    },
                },
            })
            .collect();
        let value = workspace_symbols_to_value(
            "rust",
            "same_name",
            root,
            Some(lsp_types::WorkspaceSymbolResponse::Flat(symbols)),
        );
        assert_eq!(value["count"], 75);
        assert_eq!(value["symbols"].as_array().unwrap().len(), 75);
        assert_eq!(value["truncated"], false);
    }

    #[test]
    fn project_prefix_requires_path_component_boundary() {
        assert!(!is_in_project(
            std::path::Path::new("/work/app"),
            "/work/app-other/src.rs"
        ));
        assert!(is_in_project(
            std::path::Path::new("/work/app"),
            "/work/app/src.rs"
        ));
    }
}
