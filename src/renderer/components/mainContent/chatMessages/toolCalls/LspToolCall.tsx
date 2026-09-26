import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clock,
  Crosshair,
  FileCode,
  Hash,
  Languages,
  ListPlus,
  Loader2,
  PencilLine,
  ScanSearch,
  ShieldAlert,
  Sigma,
  Terminal,
  Wand2,
  XCircle,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { readLspResultMeta, type LspResultMeta } from "./lspResultMeta";
import {
  readLspDiagnostics,
  type LspDiagnosticsResult,
} from "./lspDiagnostics";
export type { BatchDiagnosticsFile } from "./lspDiagnostics";
import {
  readLspRenameSafety,
  sanitizeLspResult,
  type LspRenameSafety,
} from "./lspRenameSafety";
import {
  LspResultNotice,
  LspSymbolTree,
  LspDiagnosticsFiles,
  LspDiagnosticsSummaryView,
  LspRenameNotice,
} from "./LspResultViews";

type LspToolCallProps = {
  toolCall: ToolCallInfo;
};

type LspOperation =
  | "diagnostics"
  | "completion"
  | "hover"
  | "goto"
  | "references"
  | "symbols"
  | "rename"
  | "code-action"
  | "signature-help"
  | "type-definition"
  | "implementation"
  | "workspace-symbols"
  | "execute-command"
  | "call-hierarchy"
  | "type-hierarchy"
  | "workspace-diagnostics"
  | "vulncheck";

// ---- Args types（与 native/src/mcp/servers/lsp/mod.rs 的 input_schema 对齐）----

type PositionArgs = {
  filePath?: string;
  line?: number;
  column?: number;
  symbol?: string;
  kind?: string;
};
type RenameArgs = {
  filePath?: string;
  line?: number;
  column?: number;
  symbol?: string;
  newName?: string;
  dryRun?: boolean;
};
type CodeActionArgs = PositionArgs & { only?: string[]; apply?: boolean };
type GotoArgs = PositionArgs & {
  kind?: "definition" | "type-definition" | "implementation";
};
type ReferencesArgs = PositionArgs & { includeDeclaration?: boolean };
type SymbolsArgs = { filePath: string };
type WorkspaceSymbolsArgs = { query: string };
type DiagnosticsArgs = { filePath?: string; filePaths?: string[] };
type WorkspaceDiagnosticsArgs = { maxFiles?: number };
type VulncheckArgs = { dir?: string; pattern?: string };
type ExecuteCommandArgs = {
  command: string;
  arguments?: unknown[];
  filePath?: string;
  dryRun?: boolean;
};
type GenericArgs = Record<string, unknown>;

type ParsedArgs =
  | PositionArgs
  | RenameArgs
  | CodeActionArgs
  | GotoArgs
  | ReferencesArgs
  | SymbolsArgs
  | WorkspaceSymbolsArgs
  | DiagnosticsArgs
  | WorkspaceDiagnosticsArgs
  | VulncheckArgs
  | ExecuteCommandArgs
  | GenericArgs
  | null;

// ---- Result types（与 native/src/mcp/servers/lsp/format.rs 输出对齐）----

export type SymbolCandidate = {
  filePath: string;
  line: number;
  column: number;
  kind: string;
  container?: string;
  preview: string;
};

type CompletionItem = {
  label: string;
  kind?: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
};

type EditInfo = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
};

type WorkspaceFile = {
  uri: string;
  editCount: number;
  edits?: EditInfo[];
  applied?: boolean;
};

type SignatureParameter = { label: string; documentation?: string };
type SignatureInfo = {
  label: string;
  documentation?: string;
  parameters: SignatureParameter[];
};

type CodeActionItem = {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  hasEdit: boolean;
  command?: { command: string; title?: string; arguments?: unknown[] };
};

type AppliedAction = {
  title: string;
  kind?: string;
  changeCount: number;
  files: WorkspaceFile[];
};

type DeferredCommand = {
  title: string;
  command?: string;
  arguments?: unknown[];
  executed: boolean;
  note?: string;
};

type DefinitionItem = {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
};

type WorkspaceSymbolItem = {
  name: string;
  kind?: string;
  detail?: string;
  filePath?: string;
  line?: number;
  column?: number;
};

type HierarchyItem = {
  name: string;
  kind?: string;
  detail?: string;
  filePath?: string;
  line?: number;
  column?: number;
};

type HierarchyCall = {
  caller?: HierarchyItem;
  callee?: HierarchyItem;
  callSites: {
    filePath: string;
    line: number;
    column: number;
    context?: string;
  }[];
};

type ParsedResult =
  | LspDiagnosticsResult
  | {
      type: "completion";
      language?: string;
      isIncomplete: boolean;
      count: number;
      total: number;
      items: CompletionItem[];
    }
  | {
      type: "rename";
      safety: LspRenameSafety;
      language?: string;
      applied: boolean;
      dryRun: boolean;
      changeCount: number;
      files: WorkspaceFile[];
    }
  | {
      type: "code-action";
      language?: string;
      apply: boolean;
      actions: CodeActionItem[];
      appliedCount: number;
      applied: AppliedAction[];
      deferred: DeferredCommand[];
    }
  | {
      type: "signature-help";
      language?: string;
      count: number;
      signatures: SignatureInfo[];
      activeSignature: number | null;
      activeParameter: number | null;
    }
  | {
      type: "definition-jump";
      language?: string;
      name?: string;
      count: number;
      definitions: DefinitionItem[];
      kind?: string;
    }
  | {
      type: "hover";
      language?: string;
      contents: string;
      range?: {
        start: { line: number; column: number };
        end: { line: number; column: number };
      };
    }
  | {
      type: "references";
      language?: string;
      symbol?: string;
      count: number;
      references: ReferenceLocation[];
    }
  | {
      type: "symbols";
      language?: string;
      count: number;
      symbols: DocumentSymbolNode[];
    }
  | {
      type: "vulncheck";
      count: number;
      findings: VulnFinding[];
      summary?: string;
    }
  | {
      type: "execute-command";
      command?: string;
      applied?: boolean;
      dryRun?: boolean;
      changeCount?: number;
      files?: WorkspaceFile[];
      resultText?: string;
    }
  | {
      type: "workspace-symbols";
      language?: string;
      query?: string;
      count: number;
      total: number;
      symbols: WorkspaceSymbolItem[];
    }
  | {
      type: "call-hierarchy";
      language?: string;
      symbol?: string;
      incomingCount: number;
      outgoingCount: number;
      incoming: HierarchyCall[];
      outgoing: HierarchyCall[];
    }
  | {
      type: "type-hierarchy";
      language?: string;
      symbol?: string;
      supertypesCount: number;
      subtypesCount: number;
      supertypes: HierarchyItem[];
      subtypes: HierarchyItem[];
    }
  | {
      type: "ambiguous-symbol";
      symbol: string;
      count: number;
      message: string;
      candidates: SymbolCandidate[];
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

type ReferenceLocation = {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  context?: string;
};

export type DocumentSymbolNode = {
  name: string;
  kind: string;
  detail?: string | null;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  selection?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  children?: DocumentSymbolNode[] | null;
};

type VulnFinding = {
  id: string;
  details: string;
  affectedPackages: string[];
};

const BADGE_KEYS: Record<LspOperation, string> = {
  diagnostics: "toolCall.lsp.op.diagnostics",
  hover: "toolCall.lsp.op.hover",
  goto: "toolCall.lsp.op.goto",
  references: "toolCall.lsp.op.references",
  symbols: "toolCall.lsp.op.symbols",
  rename: "toolCall.lsp.op.rename",
  completion: "toolCall.lsp.op.completion",
  "code-action": "toolCall.lsp.op.code-action",
  "signature-help": "toolCall.lsp.op.signature-help",
  "type-definition": "toolCall.lsp.op.type-definition",
  implementation: "toolCall.lsp.op.implementation",
  "workspace-symbols": "toolCall.lsp.op.workspace-symbols",
  "execute-command": "toolCall.lsp.op.execute-command",
  "call-hierarchy": "toolCall.lsp.op.call-hierarchy",
  "type-hierarchy": "toolCall.lsp.op.type-hierarchy",
  "workspace-diagnostics": "toolCall.lsp.op.workspace-diagnostics",
  vulncheck: "toolCall.lsp.op.vulncheck",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositionArgs = (args: ParsedArgs): args is PositionArgs =>
  args !== null &&
  typeof args === "object" &&
  (("line" in args && typeof (args as { line?: unknown }).line === "number") ||
    "symbol" in args);

/** 是否携带 filePath 参数（type-definition / implementation / 位置类工具）。 */
const hasFilePath = (
  args: ParsedArgs,
): args is (
  | PositionArgs
  | RenameArgs
  | CodeActionArgs
  | GotoArgs
  | ReferencesArgs
  | SymbolsArgs
  | GenericArgs
) & { filePath: string } =>
  args !== null &&
  typeof args === "object" &&
  "filePath" in args &&
  typeof args.filePath === "string" &&
  args.filePath.length > 0;

const isRenameArgs = (args: ParsedArgs): args is RenameArgs =>
  args !== null && typeof args === "object" && "newName" in args;

const isCodeActionArgs = (args: ParsedArgs): args is CodeActionArgs =>
  args !== null && typeof args === "object" && "apply" in args;

const getOperation = (toolName: string): LspOperation | null => {
  switch (toolName) {
    case "lsp-diagnostics":
      return "diagnostics";
    case "lsp-hover":
      return "hover";
    case "lsp-goto":
      return "goto";
    case "lsp-references":
      return "references";
    case "lsp-symbols":
      return "symbols";
    case "lsp-rename":
      return "rename";
    case "lsp-completion":
      return "completion";
    case "lsp-code-action":
      return "code-action";
    case "lsp-signature-help":
      return "signature-help";
    case "lsp-type-definition":
      return "type-definition";
    case "lsp-implementation":
      return "implementation";
    case "lsp-workspace-symbols":
      return "workspace-symbols";
    case "lsp-execute-command":
      return "execute-command";
    case "lsp-call-hierarchy":
      return "call-hierarchy";
    case "lsp-type-hierarchy":
      return "type-hierarchy";
    case "lsp-workspace-diagnostics":
      return "workspace-diagnostics";
    case "lsp-vulncheck":
      return "vulncheck";
    default:
      return null;
  }
};

const parseString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;

const parseNumber = (
  record: Record<string, unknown>,
  key: string,
): number | undefined =>
  typeof record[key] === "number" ? (record[key] as number) : undefined;

const parseBoolean = (
  record: Record<string, unknown>,
  key: string,
): boolean | undefined =>
  typeof record[key] === "boolean" ? (record[key] as boolean) : undefined;

const getFileName = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

/**
 * 参数仍在流式到达（半截 JSON，parseArgs 会失败）时的兜底：
 * 直接从原始 arguments 字符串里正则抠出 filePath，让 header 在等待期
 * 也能显示文件名；参数完整后 useMemo 重算会被正式解析结果替换。
 */
const extractFilePath = (args: string): string | undefined => {
  if (!args) return undefined;
  const match = args.match(/"filePath"\s*:\s*"([^"]*)"/);
  return match ? match[1].replace(/\\/g, "\\") : undefined;
};

/** file:// URI → 本地路径（Windows: file:///E:/...）。 */
const uriToPath = (uri: string): string => {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//i, ""));
  } catch {
    return uri.replace(/^file:\/\//i, "");
  }
};

const parseArgs = (
  args: string,
  operation: LspOperation | null,
): ParsedArgs => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) return null;

    // workspace-symbols 只有 query，无文件位置。
    if (operation === "workspace-symbols") {
      const query = parseString(parsed, "query");
      if (!query) return null;
      return { query };
    }

    if (operation === "workspace-diagnostics") {
      return { maxFiles: parseNumber(parsed, "maxFiles") };
    }

    if (operation === "vulncheck") {
      return {
        dir: parseString(parsed, "dir"),
        pattern: parseString(parsed, "pattern"),
      };
    }

    if (operation === "execute-command") {
      const command = parseString(parsed, "command") ?? "";
      return {
        command,
        arguments: Array.isArray(parsed.arguments)
          ? parsed.arguments
          : undefined,
        filePath: parseString(parsed, "filePath"),
        dryRun: parseBoolean(parsed, "dryRun") ?? true,
      };
    }

    if (operation === "symbols") {
      const filePath = parseString(parsed, "filePath");
      return filePath ? { filePath } : null;
    }

    // diagnostics：filePath 或 filePaths（批量）。
    if (operation === "diagnostics") {
      const filePath = parseString(parsed, "filePath");
      const filePathsValue = parsed.filePaths;
      const filePaths = Array.isArray(filePathsValue)
        ? filePathsValue.filter(
            (item): item is string => typeof item === "string",
          )
        : undefined;
      if (!filePath && (!filePaths || filePaths.length === 0)) return null;
      return filePath ? { filePath } : { filePaths };
    }

    const filePath = parseString(parsed, "filePath");
    const line = parseNumber(parsed, "line");
    const column = parseNumber(parsed, "column");
    const symbol = parseString(parsed, "symbol");
    const hasCoords = Boolean(
      filePath && line !== undefined && column !== undefined,
    );
    const hasSymbol = typeof symbol === "string" && symbol.trim().length > 0;
    if (!hasCoords && !hasSymbol) {
      return parsed;
    }

    if (operation === "goto") {
      const kind = parseString(parsed, "kind") as GotoArgs["kind"];
      return { filePath, line, column, symbol, kind };
    }
    if (operation === "references") {
      return {
        filePath,
        line,
        column,
        symbol,
        includeDeclaration: parseBoolean(parsed, "includeDeclaration") ?? true,
      };
    }
    if (operation === "rename") {
      return {
        filePath,
        line,
        column,
        symbol,
        newName: parseString(parsed, "newName"),
        dryRun: parseBoolean(parsed, "dryRun") ?? true,
      };
    }
    if (operation === "code-action") {
      const onlyValue = parsed.only;
      return {
        filePath,
        line,
        column,
        symbol,
        only: Array.isArray(onlyValue)
          ? onlyValue.filter((item): item is string => typeof item === "string")
          : undefined,
        apply: parseBoolean(parsed, "apply") ?? false,
      };
    }
    const kind = parseString(parsed, "kind");
    return { filePath, line, column, symbol, ...(kind ? { kind } : {}) };
  } catch {
    return null;
  }
};

const parseEdit = (value: unknown): EditInfo | null => {
  if (!isRecord(value)) return null;
  const startLine = parseNumber(value, "startLine");
  const startColumn = parseNumber(value, "startColumn");
  const endLine = parseNumber(value, "endLine");
  const endColumn = parseNumber(value, "endColumn");
  const newText = parseString(value, "newText");
  if (
    startLine === undefined ||
    startColumn === undefined ||
    endLine === undefined ||
    endColumn === undefined ||
    newText === undefined
  ) {
    return null;
  }
  return { startLine, startColumn, endLine, endColumn, newText };
};

const parseWorkspaceFile = (value: unknown): WorkspaceFile | null => {
  if (!isRecord(value)) return null;
  const uri = parseString(value, "uri");
  if (!uri) return null;
  const editCount = parseNumber(value, "editCount") ?? 0;
  const editsValue = value.edits;
  return {
    uri,
    editCount,
    edits: Array.isArray(editsValue)
      ? editsValue
          .map(parseEdit)
          .filter((edit): edit is EditInfo => edit !== null)
      : undefined,
    applied: parseBoolean(value, "applied"),
  };
};

const parseCompletionItem = (value: unknown): CompletionItem | null => {
  if (!isRecord(value)) return null;
  const label = parseString(value, "label");
  if (!label) return null;
  return {
    label,
    kind: parseString(value, "kind"),
    detail: parseString(value, "detail"),
    documentation: parseString(value, "documentation"),
    insertText: parseString(value, "insertText"),
    sortText: parseString(value, "sortText"),
  };
};

const parseCodeActionItem = (value: unknown): CodeActionItem | null => {
  if (!isRecord(value)) return null;
  const title = parseString(value, "title");
  if (!title) return null;
  const commandValue = value.command;
  return {
    title,
    kind: parseString(value, "kind"),
    isPreferred: parseBoolean(value, "isPreferred"),
    hasEdit: parseBoolean(value, "hasEdit") ?? false,
    command: isRecord(commandValue)
      ? {
          command: parseString(commandValue, "command") ?? "",
          title: parseString(commandValue, "title"),
          arguments: Array.isArray(commandValue.arguments)
            ? (commandValue.arguments as unknown[])
            : undefined,
        }
      : undefined,
  };
};

const parseSignature = (value: unknown): SignatureInfo | null => {
  if (!isRecord(value)) return null;
  const label = parseString(value, "label");
  if (!label) return null;
  const parametersValue = value.parameters;
  return {
    label,
    documentation: parseString(value, "documentation"),
    parameters: Array.isArray(parametersValue)
      ? parametersValue.filter(isRecord).map((param) => ({
          label: parseString(param, "label") ?? "",
          documentation: parseString(param, "documentation"),
        }))
      : [],
  };
};

const parseResult = (
  result: string | undefined,
  operation: LspOperation | null,
  decoded: unknown,
  fallbackFilePath = "",
): ParsedResult => {
  if (!result || result.trim().length === 0) return { type: "empty" };

  try {
    const parsed: unknown = decoded;
    if (!isRecord(parsed))
      return {
        type: "raw",
        text: isRecord(decoded) ? JSON.stringify(decoded, null, 2) : result,
      };

    if (
      (operation === "diagnostics" || operation === "workspace-diagnostics") &&
      (Array.isArray(parsed.files) ||
        Array.isArray(parsed.diagnostics) ||
        typeof parsed.filePath === "string" ||
        (fallbackFilePath &&
          typeof parsed.error === "string" &&
          parsed.error.trim()))
    ) {
      return readLspDiagnostics(parsed, fallbackFilePath);
    }
    // Partial application must retain appliedFiles and the failure, not collapse into a generic error.
    if (
      operation === "rename" &&
      (Array.isArray(parsed.files) ||
        Array.isArray(parsed.appliedFiles) ||
        typeof parsed.previewId === "string" ||
        typeof parsed.dryRun === "boolean" ||
        parsed.partiallyApplied === true)
    ) {
      const files = Array.isArray(parsed.files) ? parsed.files : [];
      return {
        type: "rename",
        language: parseString(parsed, "language"),
        applied: parseBoolean(parsed, "applied") ?? false,
        dryRun: parseBoolean(parsed, "dryRun") ?? false,
        changeCount: parseNumber(parsed, "changeCount") ?? files.length,
        files: files
          .map(parseWorkspaceFile)
          .filter((file): file is WorkspaceFile => file !== null),
        safety: readLspRenameSafety(parsed),
      };
    }

    // napi 错误包装为 { "error": "... " }。
    const errorStr = parseString(parsed, "error");
    if (errorStr) return { type: "error", message: errorStr };

    // 符号寻址歧义响应（多重命中）
    if (
      parsed.status === "ambiguous_symbol" ||
      parsed.status === "partial_symbol_search"
    ) {
      const candidates = Array.isArray(parsed.candidates)
        ? parsed.candidates
            .filter(isRecord)
            .map((c): SymbolCandidate | null => {
              const fp = parseString(c, "filePath");
              const line = parseNumber(c, "line");
              const col = parseNumber(c, "column");
              const kind = parseString(c, "kind") ?? "unknown";
              const container = parseString(c, "container");
              const preview = parseString(c, "preview") ?? "";
              if (!fp || line === undefined || col === undefined) return null;
              return {
                filePath: fp,
                line,
                column: col,
                kind,
                container,
                preview,
              };
            })
            .filter((c): c is SymbolCandidate => c !== null)
        : [];
      return {
        type: "ambiguous-symbol",
        symbol: parseString(parsed, "symbol") ?? "",
        count: parseNumber(parsed, "count") ?? candidates.length,
        message: parseString(parsed, "message") ?? "",
        candidates,
      };
    }

    const language = parseString(parsed, "language");

    // hover
    if (operation === "hover" && typeof parsed.contents === "string") {
      let range:
        | {
            start: { line: number; column: number };
            end: { line: number; column: number };
          }
        | undefined;
      if (
        isRecord(parsed.range) &&
        isRecord(parsed.range.start) &&
        isRecord(parsed.range.end)
      ) {
        const startLine = parseNumber(parsed.range.start, "line");
        const startCol = parseNumber(parsed.range.start, "column");
        const endLine = parseNumber(parsed.range.end, "line");
        const endCol = parseNumber(parsed.range.end, "column");
        if (
          startLine !== undefined &&
          startCol !== undefined &&
          endLine !== undefined &&
          endCol !== undefined
        ) {
          range = {
            start: { line: startLine, column: startCol },
            end: { line: endLine, column: endCol },
          };
        }
      }
      return {
        type: "hover",
        language,
        contents: parsed.contents,
        range,
      };
    }

    // references
    if (operation === "references" && Array.isArray(parsed.references)) {
      const references = parsed.references
        .filter(isRecord)
        .map((item): ReferenceLocation | null => {
          const filePath = parseString(item, "filePath");
          const line = parseNumber(item, "line");
          const column = parseNumber(item, "column");
          if (!filePath || line === undefined || column === undefined) {
            return null;
          }
          return {
            filePath,
            line,
            column,
            endLine: parseNumber(item, "endLine"),
            endColumn: parseNumber(item, "endColumn"),
            context: parseString(item, "context"),
          };
        })
        .filter((item): item is ReferenceLocation => item !== null);
      return {
        type: "references",
        language,
        symbol: parseString(parsed, "symbol"),
        count: parseNumber(parsed, "count") ?? references.length,
        references,
      };
    }

    // symbols (file outline)
    if (operation === "symbols" && Array.isArray(parsed.symbols)) {
      const parseSymbolNode = (node: unknown): DocumentSymbolNode | null => {
        if (!isRecord(node)) return null;
        const name = parseString(node, "name");
        const kind = parseString(node, "kind");
        if (!name || !kind) return null;
        const rangeObj = isRecord(node.range) ? node.range : null;
        const startObj =
          rangeObj && isRecord(rangeObj.start) ? rangeObj.start : null;
        const endObj = rangeObj && isRecord(rangeObj.end) ? rangeObj.end : null;
        const range = {
          start: {
            line: (startObj && parseNumber(startObj, "line")) ?? 1,
            column: (startObj && parseNumber(startObj, "column")) ?? 1,
          },
          end: {
            line: (endObj && parseNumber(endObj, "line")) ?? 1,
            column: (endObj && parseNumber(endObj, "column")) ?? 1,
          },
        };
        const selectionObj = isRecord(node.selection) ? node.selection : null;
        const selStartObj =
          selectionObj && isRecord(selectionObj.start)
            ? selectionObj.start
            : null;
        const selEndObj =
          selectionObj && isRecord(selectionObj.end) ? selectionObj.end : null;
        const selection = selectionObj
          ? {
              start: {
                line: (selStartObj && parseNumber(selStartObj, "line")) ?? 1,
                column:
                  (selStartObj && parseNumber(selStartObj, "column")) ?? 1,
              },
              end: {
                line: (selEndObj && parseNumber(selEndObj, "line")) ?? 1,
                column: (selEndObj && parseNumber(selEndObj, "column")) ?? 1,
              },
            }
          : undefined;
        const children = Array.isArray(node.children)
          ? node.children
              .map(parseSymbolNode)
              .filter((c): c is DocumentSymbolNode => c !== null)
          : undefined;
        return {
          name,
          kind,
          detail: parseString(node, "detail"),
          range,
          selection,
          children,
        };
      };
      const symbols = parsed.symbols
        .map(parseSymbolNode)
        .filter((s): s is DocumentSymbolNode => s !== null);
      return {
        type: "symbols",
        language,
        count: parseNumber(parsed, "count") ?? symbols.length,
        symbols,
      };
    }

    // vulncheck
    if (operation === "vulncheck" && Array.isArray(parsed.findings)) {
      const findings = parsed.findings
        .filter(isRecord)
        .map((item): VulnFinding | null => {
          const id = parseString(item, "id");
          if (!id) return null;
          const details = parseString(item, "details") ?? "";
          const affectedPackages = Array.isArray(item.affectedPackages)
            ? item.affectedPackages.filter(
                (p): p is string => typeof p === "string",
              )
            : [];
          return { id, details, affectedPackages };
        })
        .filter((f): f is VulnFinding => f !== null);
      return {
        type: "vulncheck",
        count: parseNumber(parsed, "count") ?? findings.length,
        findings,
        summary: parseString(parsed, "summary"),
      };
    }

    // execute-command
    if (operation === "execute-command") {
      if (Array.isArray(parsed.files)) {
        return {
          type: "execute-command",
          applied: parseBoolean(parsed, "applied"),
          dryRun: parseBoolean(parsed, "dryRun"),
          changeCount:
            parseNumber(parsed, "changeCount") ?? parsed.files.length,
          files: parsed.files
            .map(parseWorkspaceFile)
            .filter((f): f is WorkspaceFile => f !== null),
        };
      }
      return {
        type: "execute-command",
        resultText: JSON.stringify(parsed, null, 2),
      };
    }

    if (operation === "code-action") {
      const actionsValue = parsed.actions;
      const actions = Array.isArray(actionsValue)
        ? actionsValue
            .map(parseCodeActionItem)
            .filter((action): action is CodeActionItem => action !== null)
        : [];
      const appliedValue = parsed.applied;
      const deferredValue = parsed.deferredCommands;
      return {
        type: "code-action",
        language,
        apply: parseBoolean(parsed, "apply") ?? false,
        actions,
        appliedCount: parseNumber(parsed, "appliedCount") ?? 0,
        applied: Array.isArray(appliedValue)
          ? appliedValue.filter(isRecord).map((action) => ({
              title: parseString(action, "title") ?? "",
              kind: parseString(action, "kind"),
              changeCount: parseNumber(action, "changeCount") ?? 0,
              files: Array.isArray(action.files)
                ? action.files
                    .map(parseWorkspaceFile)
                    .filter((file): file is WorkspaceFile => file !== null)
                : [],
            }))
          : [],
        deferred: Array.isArray(deferredValue)
          ? deferredValue.filter(isRecord).map((item) => ({
              title: parseString(item, "title") ?? "",
              command: parseString(item, "command"),
              arguments: Array.isArray(item.arguments)
                ? (item.arguments as unknown[])
                : undefined,
              executed: parseBoolean(item, "executed") ?? false,
              note: parseString(item, "note"),
            }))
          : [],
      };
    }

    if (operation === "completion" && Array.isArray(parsed.items)) {
      const items = parsed.items
        .map(parseCompletionItem)
        .filter((item): item is CompletionItem => item !== null);
      return {
        type: "completion",
        language,
        isIncomplete: parseBoolean(parsed, "isIncomplete") ?? false,
        count: parseNumber(parsed, "count") ?? items.length,
        total: parseNumber(parsed, "total") ?? items.length,
        items,
      };
    }

    if (operation === "signature-help" && Array.isArray(parsed.signatures)) {
      const signatures = parsed.signatures
        .map(parseSignature)
        .filter((sig): sig is SignatureInfo => sig !== null);
      return {
        type: "signature-help",
        language,
        count: parseNumber(parsed, "count") ?? signatures.length,
        signatures,
        activeSignature: parseNumber(parsed, "activeSignature") ?? null,
        activeParameter: parseNumber(parsed, "activeParameter") ?? null,
      };
    }

    // goto / type-definition / implementation：输出与 definition 对齐（name + definitions）。
    if (
      (operation === "goto" ||
        operation === "type-definition" ||
        operation === "implementation") &&
      Array.isArray(parsed.definitions)
    ) {
      const definitions = parsed.definitions
        .filter(isRecord)
        .map((item): DefinitionItem | null => {
          const filePath = parseString(item, "filePath");
          const line = parseNumber(item, "line");
          const column = parseNumber(item, "column");
          if (!filePath || line === undefined || column === undefined) {
            return null;
          }
          const endLine = parseNumber(item, "endLine");
          const endColumn = parseNumber(item, "endColumn");
          return {
            filePath,
            line,
            column,
            ...(endLine !== undefined ? { endLine } : {}),
            ...(endColumn !== undefined ? { endColumn } : {}),
          };
        })
        .filter((item): item is DefinitionItem => item !== null);
      return {
        type: "definition-jump",
        language,
        name: parseString(parsed, "name"),
        count: parseNumber(parsed, "count") ?? definitions.length,
        definitions,
      };
    }

    // workspace-symbols：query + 符号列表（可能跨语言合并）。
    if (operation === "workspace-symbols" && Array.isArray(parsed.symbols)) {
      const symbols = parsed.symbols
        .filter(isRecord)
        .map((item) => ({
          name: parseString(item, "name") ?? "",
          kind: parseString(item, "kind"),
          detail: parseString(item, "detail"),
          filePath: parseString(item, "filePath"),
          line: parseNumber(item, "line"),
          column: parseNumber(item, "column"),
        }))
        .filter((item) => item.name.length > 0);
      return {
        type: "workspace-symbols",
        language,
        query: parseString(parsed, "query"),
        count: parseNumber(parsed, "count") ?? symbols.length,
        total: parseNumber(parsed, "total") ?? symbols.length,
        symbols,
      };
    }

    // call-hierarchy：incoming（谁调用它）+ outgoing（它调用谁）。
    if (operation === "call-hierarchy" && Array.isArray(parsed.incoming)) {
      const parseItem = (value: unknown): HierarchyItem | null => {
        if (!isRecord(value)) return null;
        const name = parseString(value, "name");
        if (!name) return null;
        return {
          name,
          kind: parseString(value, "kind"),
          detail: parseString(value, "detail"),
          filePath: parseString(value, "filePath"),
          line: parseNumber(value, "line"),
          column: parseNumber(value, "column"),
        };
      };
      const parseCall = (value: unknown): HierarchyCall | null => {
        if (!isRecord(value)) return null;
        const callSitesValue = value.callSites;
        const callSites = Array.isArray(callSitesValue)
          ? callSitesValue
              .filter(isRecord)
              .map((site) => ({
                filePath: parseString(site, "filePath") ?? "",
                line: parseNumber(site, "line") ?? 0,
                column: parseNumber(site, "column") ?? 0,
                context: parseString(site, "context"),
              }))
              .filter((site) => site.filePath.length > 0)
          : [];
        return {
          caller: parseItem(value.caller) ?? undefined,
          callee: parseItem(value.callee) ?? undefined,
          callSites,
        };
      };
      const incoming = parsed.incoming
        .map(parseCall)
        .filter((call): call is HierarchyCall => call !== null);
      const outgoingValue = parsed.outgoing;
      const outgoing = Array.isArray(outgoingValue)
        ? outgoingValue
            .map(parseCall)
            .filter((call): call is HierarchyCall => call !== null)
        : [];
      return {
        type: "call-hierarchy",
        language,
        symbol: parseString(parsed, "symbol"),
        incomingCount: parseNumber(parsed, "incomingCount") ?? incoming.length,
        outgoingCount: parseNumber(parsed, "outgoingCount") ?? outgoing.length,
        incoming,
        outgoing,
      };
    }

    // type-hierarchy：supertypes（父类型链）+ subtypes（子类型列表）。
    if (operation === "type-hierarchy" && Array.isArray(parsed.supertypes)) {
      const parseType = (value: unknown): HierarchyItem | null => {
        if (!isRecord(value)) return null;
        const name = parseString(value, "name");
        if (!name) return null;
        return {
          name,
          kind: parseString(value, "kind"),
          detail: parseString(value, "detail"),
          filePath: parseString(value, "filePath"),
          line: parseNumber(value, "line"),
          column: parseNumber(value, "column"),
        };
      };
      const supertypes = parsed.supertypes
        .map(parseType)
        .filter((item): item is HierarchyItem => item !== null);
      const subtypesValue = parsed.subtypes;
      const subtypes = Array.isArray(subtypesValue)
        ? subtypesValue
            .map(parseType)
            .filter((item): item is HierarchyItem => item !== null)
        : [];
      return {
        type: "type-hierarchy",
        language,
        symbol: parseString(parsed, "symbol"),
        supertypesCount:
          parseNumber(parsed, "supertypesCount") ?? supertypes.length,
        subtypesCount: parseNumber(parsed, "subtypesCount") ?? subtypes.length,
        supertypes,
        subtypes,
      };
    }

    // 部分错误以 { "message": "..." } 形式到达。
    const messageStr = parseString(parsed, "message");
    if (messageStr) return { type: "error", message: messageStr };

    return {
      type: "raw",
      text: isRecord(decoded) ? JSON.stringify(decoded, null, 2) : result,
    };
  } catch {
    return {
      type: "raw",
      text: isRecord(decoded) ? JSON.stringify(decoded, null, 2) : result,
    };
  }
};

/** 截断长文本（补全文档 / 编辑预览）。 */
const truncateText = (text: string, max = 220): string =>
  text.length > max ? `${text.slice(0, max)}...` : text;

export const LspToolCall = ({
  toolCall,
}: LspToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const operation = getOperation(toolCall.name);

  const parsedArgs = useMemo(
    () => (operation ? parseArgs(toolCall.arguments, operation) : null),
    [toolCall.arguments, operation],
  );
  const decodedResult = useMemo<unknown>(() => {
    try {
      return toolCall.result
        ? sanitizeLspResult(JSON.parse(toolCall.result))
        : null;
    } catch {
      return null;
    }
  }, [toolCall.result]);
  const resultMeta = useMemo(
    () => readLspResultMeta(decodedResult),
    [decodedResult],
  );
  const parsedResult = useMemo(
    () =>
      operation
        ? parseResult(
            toolCall.result,
            operation,
            decodedResult,
            hasFilePath(parsedArgs) ? parsedArgs.filePath : "",
          )
        : ({ type: "empty" } as ParsedResult),
    [toolCall.result, operation, decodedResult, parsedArgs],
  );

  const hasError = parsedResult.type === "error";
  const effectiveStatus =
    hasError || resultMeta.status === "failed" ? "error" : toolCall.status;

  const navigationKind =
    operation === "goto" && parsedArgs && "kind" in parsedArgs
      ? parsedArgs.kind
      : undefined;
  const badgeName =
    operation === "goto" &&
    (navigationKind === "definition" ||
      navigationKind === "type-definition" ||
      navigationKind === "implementation")
      ? t(`toolCall.lsp.goto.${navigationKind}`)
      : operation
        ? t(BADGE_KEYS[operation])
        : t("toolCall.lsp.name");

  const filePath = hasFilePath(parsedArgs)
    ? parsedArgs.filePath
    : (extractFilePath(toolCall.arguments) ?? "");

  const resolvedTarget = useMemo(() => {
    if (!toolCall.result) return null;
    try {
      const obj: unknown = decodedResult;
      if (isRecord(obj) && isRecord(obj.resolvedSymbol)) {
        const fp = parseString(obj.resolvedSymbol, "filePath");
        const line = parseNumber(obj.resolvedSymbol, "line");
        const col = parseNumber(obj.resolvedSymbol, "column");
        if (fp && line !== undefined && col !== undefined) {
          return { filePath: fp, line, column: col };
        }
      }
      return null;
    } catch {
      return null;
    }
  }, [decodedResult, toolCall.result]);

  const effectiveFilePath = filePath || resolvedTarget?.filePath || "";
  const displayName = effectiveFilePath
    ? getFileName(effectiveFilePath)
    : (parsedArgs &&
        "symbol" in parsedArgs &&
        typeof parsedArgs.symbol === "string" &&
        parsedArgs.symbol) ||
      (parsedArgs &&
        "query" in parsedArgs &&
        typeof parsedArgs.query === "string" &&
        parsedArgs.query) ||
      (parsedArgs &&
        "command" in parsedArgs &&
        typeof parsedArgs.command === "string" &&
        parsedArgs.command) ||
      (parsedArgs &&
        "pattern" in parsedArgs &&
        typeof parsedArgs.pattern === "string" &&
        parsedArgs.pattern) ||
      undefined;

  // Header meta：语言 badge + 结果计数 badge。
  const meta = useMemo(() => {
    const language =
      parsedResult.type === "rename" ||
      parsedResult.type === "completion" ||
      parsedResult.type === "code-action" ||
      parsedResult.type === "signature-help" ||
      parsedResult.type === "definition-jump" ||
      parsedResult.type === "workspace-symbols" ||
      parsedResult.type === "call-hierarchy" ||
      parsedResult.type === "type-hierarchy" ||
      parsedResult.type === "hover" ||
      parsedResult.type === "references" ||
      parsedResult.type === "symbols"
        ? parsedResult.language
        : undefined;
    const langBadge = language ? (
      <span className="tool-call-lsp-lang-badge">
        <Languages size={10} aria-hidden="true" />
        {language}
      </span>
    ) : null;

    if (parsedResult.type === "ambiguous-symbol") {
      return (
        <span className="tool-call-codelens-count tool-call-codelens-count-error">
          {t("toolCall.lsp.ambiguousCount", {
            values: { count: parsedResult.count },
            defaultValue: `${parsedResult.count} candidates`,
          })}
        </span>
      );
    }
    if (parsedResult.type === "completion") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.completionCount", {
              values: {
                shown: parsedResult.count,
                total: parsedResult.total,
              },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "hover") {
      return langBadge;
    }
    if (parsedResult.type === "references") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.referencesCount", {
              values: { count: parsedResult.count },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "symbols") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.symbolsCount", {
              values: { shown: parsedResult.count, total: parsedResult.count },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "vulncheck") {
      return (
        <span
          className={`tool-call-codelens-count ${
            parsedResult.count > 0
              ? "tool-call-codelens-count-error"
              : "tool-call-codelens-count-ok"
          }`}
        >
          {t("toolCall.lsp.vulnCount", {
            values: { count: parsedResult.count },
          })}
        </span>
      );
    }
    if (parsedResult.type === "execute-command") {
      return (
        <>
          {parsedResult.changeCount !== undefined ? (
            <span
              className={`tool-call-codelens-count ${
                parsedResult.applied
                  ? "tool-call-codelens-count-ok"
                  : "tool-call-codelens-count-info"
              }`}
            >
              {parsedResult.applied
                ? t("toolCall.lsp.renameApplied")
                : parsedResult.dryRun
                  ? t("toolCall.lsp.dryRun")
                  : t("toolCall.lsp.notApplied")}
            </span>
          ) : null}
        </>
      );
    }

    if (parsedResult.type === "rename") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.applied
                ? "tool-call-codelens-count-ok"
                : "tool-call-codelens-count-info"
            }`}
          >
            {parsedResult.applied
              ? t("toolCall.lsp.renameApplied")
              : parsedResult.dryRun
                ? t("toolCall.lsp.dryRun")
                : t("toolCall.lsp.notApplied")}
          </span>
          <span className="tool-call-codelens-count tool-call-codelens-count-muted">
            {t("toolCall.lsp.changeCount", {
              values: { count: parsedResult.changeCount },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "code-action") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.apply
                ? "tool-call-codelens-count-ok"
                : "tool-call-codelens-count-info"
            }`}
          >
            {parsedResult.apply
              ? t("toolCall.lsp.appliedCount", {
                  values: { count: parsedResult.appliedCount },
                })
              : t("toolCall.lsp.actionCount", {
                  values: { count: parsedResult.actions.length },
                })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "signature-help") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.signatureCount", {
              values: { count: parsedResult.count },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "definition-jump") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.definitionsCount", {
              values: { count: parsedResult.count },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "workspace-symbols") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.symbolsCount", {
              values: { shown: parsedResult.count, total: parsedResult.total },
            })}
          </span>
          {parsedResult.total > parsedResult.count ? (
            <span className="tool-call-codelens-count tool-call-codelens-count-muted">
              {t("toolCall.lsp.truncated", {
                values: { count: parsedResult.count },
              })}
            </span>
          ) : null}
        </>
      );
    }
    if (parsedResult.type === "call-hierarchy") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.incomingCount > 0 || parsedResult.outgoingCount > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.callHierarchyCount", {
              values: {
                incoming: parsedResult.incomingCount,
                outgoing: parsedResult.outgoingCount,
              },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "type-hierarchy") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.supertypesCount > 0 || parsedResult.subtypesCount > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.typeHierarchyCount", {
              values: {
                supertypes: parsedResult.supertypesCount,
                subtypes: parsedResult.subtypesCount,
              },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "diagnostics-batch") {
      return (
        <LspDiagnosticsSummaryView summary={parsedResult.summary} compact />
      );
    }
    return langBadge;
  }, [parsedResult, t]);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={badgeName}
      category="lens"
      displayName={displayName}
      displayNameTitle={effectiveFilePath || undefined}
      displayNameDataPath={effectiveFilePath || undefined}
      status={effectiveStatus}
      meta={
        <>
          {parsedResult.type === "diagnostics-batch" ||
          (resultMeta.status !== "failed" && resultMeta.status !== "partial")
            ? meta
            : null}
          {resultMeta.status === "partial" || resultMeta.status === "failed" ? (
            <span className="tool-call-codelens-count tool-call-codelens-count-error">
              {t(`toolCall.lsp.resultStatus.${resultMeta.status}`)}
            </span>
          ) : null}
        </>
      }
      className={`tool-call-lsp${resultMeta.status === "partial" ? " lsp-result-partial" : ""}`}
      lazyBody
    >
      <LspToolBody
        toolCall={toolCall}
        operation={operation}
        parsedArgs={parsedArgs}
        parsedResult={parsedResult}
        resultMeta={resultMeta}
        effectiveFilePath={effectiveFilePath}
        displayName={displayName}
        resolvedTarget={resolvedTarget}
      />
    </ToolCallNode>
  );
};

type LspToolBodyProps = {
  toolCall: ToolCallInfo;
  operation: LspOperation | null;
  parsedArgs: ParsedArgs;
  parsedResult: ParsedResult;
  resultMeta: LspResultMeta;
  effectiveFilePath: string;
  displayName?: string;
  resolvedTarget: { filePath: string; line: number; column: number } | null;
};

function LspToolBody({
  toolCall,
  operation,
  parsedArgs,
  parsedResult,
  resultMeta,
  effectiveFilePath,
  displayName,
  resolvedTarget,
}: LspToolBodyProps): React.JSX.Element {
  const { t } = useI18n();
  const isRunning = toolCall.status === "running";
  const hasError = parsedResult.type === "error";
  const position = isPositionArgs(parsedArgs) ? parsedArgs : null;
  return (
    <div className="tool-call-body tool-call-lsp-body">
      {/* Parameters */}
      {parsedArgs ? (
        <div className="tool-call-codelens-params">
          {"filePaths" in parsedArgs && Array.isArray(parsedArgs.filePaths) && (
            <details className="tool-call-lsp-requested-files">
              <summary>
                {t("toolCall.lsp.requestedFiles", {
                  values: { count: parsedArgs.filePaths.length },
                })}
              </summary>
              <ul>
                {parsedArgs.filePaths
                  .filter((path): path is string => typeof path === "string")
                  .map((path, index) => (
                    <li key={`${path}:${index}`}>
                      <code>{path}</code>
                    </li>
                  ))}
              </ul>
            </details>
          )}
          {"query" in parsedArgs && typeof parsedArgs.query === "string" ? (
            <div className="tool-call-codelens-param-item">
              <ScanSearch size={11} aria-hidden="true" />
              <span className="tool-call-codelens-param-label">
                {t("toolCall.lsp.query")}
              </span>
              <code className="tool-call-codelens-param-value">
                {parsedArgs.query}
              </code>
            </div>
          ) : null}
          {"command" in parsedArgs && typeof parsedArgs.command === "string" ? (
            <div className="tool-call-codelens-param-item">
              <Terminal size={11} aria-hidden="true" />
              <span className="tool-call-codelens-param-label">
                {t("toolCall.lsp.command")}
              </span>
              <code className="tool-call-codelens-param-value">
                {parsedArgs.command}
              </code>
            </div>
          ) : null}
          {"dir" in parsedArgs && typeof parsedArgs.dir === "string" ? (
            <div className="tool-call-codelens-param-item">
              <FileCode size={11} aria-hidden="true" />
              <span className="tool-call-codelens-param-label">
                {t("toolCall.lsp.dir")}
              </span>
              <span className="tool-call-codelens-param-value">
                {parsedArgs.dir}
              </span>
            </div>
          ) : null}
          {"pattern" in parsedArgs && typeof parsedArgs.pattern === "string" ? (
            <div className="tool-call-codelens-param-item">
              <ScanSearch size={11} aria-hidden="true" />
              <span className="tool-call-codelens-param-label">
                {t("toolCall.lsp.pattern")}
              </span>
              <code className="tool-call-codelens-param-value">
                {parsedArgs.pattern}
              </code>
            </div>
          ) : null}
          {"maxFiles" in parsedArgs &&
          typeof parsedArgs.maxFiles === "number" ? (
            <div className="tool-call-codelens-param-item">
              <Hash size={11} aria-hidden="true" />
              <span className="tool-call-codelens-param-label">
                {t("toolCall.lsp.maxFiles")}
              </span>
              <code className="tool-call-codelens-param-value">
                {parsedArgs.maxFiles}
              </code>
            </div>
          ) : null}
          {parsedArgs &&
          "symbol" in parsedArgs &&
          typeof parsedArgs.symbol === "string" ? (
            <div className="tool-call-codelens-param-item">
              <ScanSearch size={11} aria-hidden="true" />
              <span className="tool-call-codelens-param-label">
                {t("toolCall.lsp.symbol")}
              </span>
              <code className="tool-call-codelens-param-value">
                {parsedArgs.symbol}
              </code>
            </div>
          ) : null}
          {effectiveFilePath ? (
            <div className="tool-call-codelens-param-item">
              <FileCode size={11} aria-hidden="true" />
              <span className="tool-call-codelens-param-label">
                {t("toolCall.lsp.filePath")}
              </span>
              <span
                className="tool-call-codelens-param-value"
                title={effectiveFilePath}
              >
                {effectiveFilePath}
              </span>
            </div>
          ) : null}
          {position &&
          position.line !== undefined &&
          position.column !== undefined ? (
            <div className="tool-call-codelens-param-item">
              <Crosshair size={11} aria-hidden="true" />
              <span className="tool-call-codelens-param-label">
                {t("toolCall.lsp.position")}
              </span>
              <code className="tool-call-codelens-param-value">
                {position.line}:{position.column}
              </code>
            </div>
          ) : resolvedTarget ? (
            <div className="tool-call-codelens-param-item">
              <Crosshair size={11} aria-hidden="true" />
              <span className="tool-call-codelens-param-label">
                {t("toolCall.lsp.position")}
              </span>
              <code className="tool-call-codelens-param-value">
                {resolvedTarget.line}:{resolvedTarget.column}
              </code>
            </div>
          ) : null}
          {"kind" in parsedArgs && typeof parsedArgs.kind === "string" ? (
            <div className="tool-call-codelens-param-item">
              <span className="tool-call-codelens-param-label">
                {t("toolCall.lsp.kind")}
              </span>
              <span className="tool-call-lsp-kind-badge">
                {parsedArgs.kind}
              </span>
            </div>
          ) : null}
          {isRenameArgs(parsedArgs) ? (
            <>
              <div className="tool-call-codelens-param-item">
                <PencilLine size={11} aria-hidden="true" />
                <span className="tool-call-codelens-param-label">
                  {t("toolCall.lsp.newName")}
                </span>
                <code className="tool-call-codelens-param-value">
                  {parsedArgs.newName ?? ""}
                </code>
              </div>
              {parsedArgs.dryRun !== undefined ? (
                <div className="tool-call-codelens-param-item">
                  <ShieldAlert size={11} aria-hidden="true" />
                  <span className="tool-call-codelens-param-label">
                    {t("toolCall.lsp.dryRun")}
                  </span>
                  <span className="tool-call-codelens-param-value">
                    {parsedArgs.dryRun ? "true" : "false"}
                  </span>
                </div>
              ) : null}
            </>
          ) : null}

          {isCodeActionArgs(parsedArgs) ? (
            <>
              {parsedArgs.only && parsedArgs.only.length > 0 ? (
                <div className="tool-call-codelens-param-item">
                  <Wand2 size={11} aria-hidden="true" />
                  <span className="tool-call-codelens-param-label">
                    {t("toolCall.lsp.only")}
                  </span>
                  <code className="tool-call-codelens-param-value">
                    {parsedArgs.only.join(", ")}
                  </code>
                </div>
              ) : null}
              {parsedArgs.apply !== undefined ? (
                <div className="tool-call-codelens-param-item">
                  <Wand2 size={11} aria-hidden="true" />
                  <span className="tool-call-codelens-param-label">
                    {t("toolCall.lsp.apply")}
                  </span>
                  <span className="tool-call-codelens-param-value">
                    {parsedArgs.apply ? "true" : "false"}
                  </span>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {parsedResult.type !== "empty" && <LspResultNotice meta={resultMeta} />}
      {parsedResult.type === "diagnostics-batch" && (
        <LspDiagnosticsFiles
          files={parsedResult.files}
          summary={parsedResult.summary}
          complete={resultMeta.status === "complete"}
        />
      )}
      {parsedResult.type === "rename" && (
        <LspRenameNotice
          safety={parsedResult.safety}
          applied={parsedResult.applied}
          dryRun={parsedResult.dryRun}
          blocked={resultMeta.unsupportedOperations}
        />
      )}
      {/* Error */}
      {hasError ? (
        <div className="tool-call-error">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{parsedResult.message}</span>
        </div>
      ) : null}

      {(resultMeta.status !== "failed" || parsedResult.type === "rename") &&
        !resultMeta.unsupportedOperations && (
          <>
            {/* Ambiguous Symbol Candidates view */}
            {parsedResult.type === "ambiguous-symbol" ? (
              <div className="tool-call-lsp-ambiguous-block">
                <div className="tool-call-lsp-ambiguous-banner">
                  <AlertCircle size={13} aria-hidden="true" />
                  <span>{parsedResult.message}</span>
                </div>
                {parsedResult.candidates.length > 0 ? (
                  <div className="tool-call-lsp-ambiguous-list">
                    {parsedResult.candidates.map((cand, idx) => (
                      <div
                        key={`${cand.filePath}-${cand.line}-${cand.column}-${idx}`}
                        className="tool-call-lsp-ambiguous-candidate"
                      >
                        <div className="tool-call-lsp-ambiguous-header">
                          <span className="tool-call-lsp-kind-badge">
                            {cand.kind}
                          </span>
                          <span
                            className="tool-call-lsp-ambiguous-file"
                            title={cand.filePath}
                          >
                            {getFileName(cand.filePath)}
                          </span>
                          <span className="tool-call-lsp-ambiguous-loc">
                            <Hash size={9} aria-hidden="true" />
                            {cand.line}:{cand.column}
                          </span>
                          {cand.container ? (
                            <span className="tool-call-lsp-ambiguous-container">
                              ({cand.container})
                            </span>
                          ) : null}
                        </div>
                        {cand.preview ? (
                          <pre className="tool-call-lsp-ambiguous-preview">
                            <code>{cand.preview}</code>
                          </pre>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Completion view */}
            {parsedResult.type === "completion" ? (
              parsedResult.items.length > 0 ? (
                <div className="tool-call-lsp-completion-list">
                  {parsedResult.isIncomplete ? (
                    <div className="tool-call-lsp-incomplete-note">
                      {t("toolCall.lsp.incomplete")}
                    </div>
                  ) : null}
                  {parsedResult.items.map((item, idx) => (
                    <div
                      key={`${item.label}-${idx}`}
                      className="tool-call-lsp-completion-item"
                    >
                      <span className="tool-call-lsp-completion-label">
                        <ListPlus size={11} aria-hidden="true" />
                        <code>{item.label}</code>
                      </span>
                      {item.kind ? (
                        <span className="tool-call-lsp-kind-badge">
                          {item.kind}
                        </span>
                      ) : null}
                      {item.detail ? (
                        <span
                          className="tool-call-lsp-completion-detail"
                          title={item.detail}
                        >
                          {item.detail}
                        </span>
                      ) : null}
                      {item.documentation ? (
                        <span
                          className="tool-call-lsp-completion-doc"
                          title={item.documentation}
                        >
                          {truncateText(item.documentation)}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <XCircle size={14} aria-hidden="true" />
                  <span>
                    {t(
                      resultMeta.status === "partial"
                        ? "toolCall.lsp.incompleteEmpty"
                        : "toolCall.lsp.noCompletions",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {/* Rename view */}
            {parsedResult.type === "rename" ? (
              parsedResult.files.length > 0 ? (
                <div className="tool-call-lsp-rename-list">
                  {parsedResult.files.map((file, fileIdx) => (
                    <div
                      key={`${file.uri}-${fileIdx}`}
                      className="tool-call-lsp-rename-file"
                    >
                      <div
                        className="tool-call-lsp-rename-file-header"
                        title={uriToPath(file.uri)}
                      >
                        <FileCode size={12} aria-hidden="true" />
                        <span className="tool-call-lsp-rename-file-name">
                          {getFileName(uriToPath(file.uri))}
                        </span>
                        <span className="tool-call-lsp-rename-file-path">
                          {uriToPath(file.uri)}
                        </span>
                        {file.applied !== undefined ? (
                          <span
                            className={`tool-call-lsp-rename-applied ${
                              file.applied ? "applied" : "skipped"
                            }`}
                          >
                            {file.applied
                              ? t("toolCall.lsp.renameApplied")
                              : t(
                                  resultMeta.status === "partial"
                                    ? "toolCall.lsp.incompleteEmpty"
                                    : "toolCall.lsp.noChanges",
                                )}
                          </span>
                        ) : (
                          <span className="tool-call-codelens-ref-file-count">
                            {t("toolCall.lsp.editCount", {
                              values: { count: file.editCount },
                            })}
                          </span>
                        )}
                      </div>
                      {file.edits && file.edits.length > 0 ? (
                        <div className="tool-call-lsp-edit-list">
                          {file.edits.map((edit, editIdx) => (
                            <div
                              key={`${edit.startLine}-${edit.startColumn}-${editIdx}`}
                              className="tool-call-lsp-edit-row"
                            >
                              <span className="tool-call-lsp-edit-loc">
                                <Hash size={9} aria-hidden="true" />
                                {edit.startLine}:{edit.startColumn} →{" "}
                                {edit.endLine}:{edit.endColumn}
                              </span>
                              <code
                                className="tool-call-lsp-edit-text"
                                title={edit.newText}
                              >
                                {truncateText(edit.newText, 160)}
                              </code>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : parsedResult.safety.error ||
                parsedResult.safety.appliedFiles.length > 0 ||
                parsedResult.safety.requiresNewPreview ||
                resultMeta.status === "failed" ? null : (
                <div className="tool-call-codelens-no-results">
                  <XCircle size={14} aria-hidden="true" />
                  <span>
                    {t(
                      resultMeta.status === "partial"
                        ? "toolCall.lsp.incompleteEmpty"
                        : "toolCall.lsp.noChanges",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {/* Signature help view */}
            {parsedResult.type === "signature-help" ? (
              parsedResult.signatures.length > 0 ? (
                <div className="tool-call-lsp-signature-list">
                  {parsedResult.signatures.map((signature, sigIdx) => {
                    const isActive =
                      parsedResult.activeSignature === sigIdx ||
                      (parsedResult.activeSignature === null && sigIdx === 0);
                    return (
                      <div
                        key={`${signature.label}-${sigIdx}`}
                        className={`tool-call-lsp-signature-item ${
                          isActive ? "active" : ""
                        }`}
                      >
                        <div className="tool-call-lsp-signature-label">
                          <Sigma size={12} aria-hidden="true" />
                          <code>{signature.label}</code>
                          {isActive ? (
                            <span className="tool-call-lsp-active-badge">
                              {t("toolCall.lsp.activeSignature")}
                            </span>
                          ) : null}
                        </div>
                        {signature.documentation ? (
                          <div
                            className="tool-call-lsp-signature-doc"
                            title={signature.documentation}
                          >
                            {truncateText(signature.documentation)}
                          </div>
                        ) : null}
                        {signature.parameters.length > 0 ? (
                          <div className="tool-call-lsp-param-list">
                            {signature.parameters.map((param, paramIdx) => {
                              const isActiveParam =
                                isActive &&
                                (parsedResult.activeParameter === paramIdx ||
                                  (parsedResult.activeParameter === null &&
                                    paramIdx === 0));
                              return (
                                <span
                                  key={`${param.label}-${paramIdx}`}
                                  className={`tool-call-lsp-param-chip ${
                                    isActiveParam ? "active" : ""
                                  }`}
                                  title={param.documentation}
                                >
                                  {param.label || `#${paramIdx + 1}`}
                                </span>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <XCircle size={14} aria-hidden="true" />
                  <span>
                    {t(
                      resultMeta.status === "partial"
                        ? "toolCall.lsp.incompleteEmpty"
                        : "toolCall.lsp.noSignatures",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {/* Code action view */}
            {parsedResult.type === "code-action" ? (
              parsedResult.actions.length > 0 ||
              parsedResult.applied.length > 0 ||
              parsedResult.deferred.length > 0 ? (
                <div className="tool-call-lsp-action-list">
                  {parsedResult.actions.map((action, idx) => {
                    const appliedAction = parsedResult.applied.find(
                      (applied) => applied.title === action.title,
                    );
                    return (
                      <div
                        key={`${action.title}-${idx}`}
                        className="tool-call-lsp-action-item"
                      >
                        <span className="tool-call-lsp-action-title">
                          <Wand2 size={11} aria-hidden="true" />
                          {action.title}
                        </span>
                        {action.kind ? (
                          <span className="tool-call-lsp-kind-badge">
                            {action.kind}
                          </span>
                        ) : null}
                        {action.isPreferred ? (
                          <span className="tool-call-lsp-preferred-badge">
                            {t("toolCall.lsp.preferred")}
                          </span>
                        ) : null}
                        {action.hasEdit ? (
                          <span className="tool-call-lsp-edit-badge">
                            {t("toolCall.lsp.editsAvailable")}
                          </span>
                        ) : null}
                        {action.command ? (
                          <span
                            className="tool-call-lsp-command-badge"
                            title={action.command.command}
                          >
                            <ShieldAlert size={10} aria-hidden="true" />
                            {t("toolCall.lsp.commandNotExecuted")}
                          </span>
                        ) : null}
                        {appliedAction ? (
                          <span className="tool-call-lsp-applied-badge">
                            <CheckCircle2 size={10} aria-hidden="true" />
                            {t("toolCall.lsp.changeCount", {
                              values: { count: appliedAction.changeCount },
                            })}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                  {parsedResult.applied.length > 0 ? (
                    <div className="tool-call-lsp-result-section">
                      <span className="tool-call-lsp-section-label">
                        <CheckCircle2 size={11} aria-hidden="true" />
                        {t("toolCall.lsp.appliedSection")}
                      </span>
                      {parsedResult.applied.map((action, idx) => (
                        <div
                          key={`applied-${action.title}-${idx}`}
                          className="tool-call-lsp-action-item"
                        >
                          <span className="tool-call-lsp-action-title">
                            <CheckCircle2 size={11} aria-hidden="true" />
                            {action.title}
                          </span>
                          {action.kind ? (
                            <span className="tool-call-lsp-kind-badge">
                              {action.kind}
                            </span>
                          ) : null}
                          <span className="tool-call-lsp-applied-badge">
                            {t("toolCall.lsp.changeCount", {
                              values: { count: action.changeCount },
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {parsedResult.deferred.length > 0 ? (
                    <div className="tool-call-lsp-result-section">
                      <span className="tool-call-lsp-section-label">
                        <ShieldAlert size={11} aria-hidden="true" />
                        {t("toolCall.lsp.deferredSection")}
                      </span>
                      {parsedResult.deferred.map((item, idx) => (
                        <div
                          key={`deferred-${item.title}-${idx}`}
                          className="tool-call-lsp-action-item"
                        >
                          <span className="tool-call-lsp-action-title">
                            <ShieldAlert size={11} aria-hidden="true" />
                            {item.title}
                          </span>
                          {item.note ? (
                            <span className="tool-call-lsp-command-badge">
                              {item.note}
                            </span>
                          ) : (
                            <span className="tool-call-lsp-command-badge">
                              {t("toolCall.lsp.commandNotExecuted")}
                            </span>
                          )}
                          {item.command ? (
                            <code
                              className="tool-call-lsp-deferred-command"
                              title={item.command}
                            >
                              {item.command}
                            </code>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <XCircle size={14} aria-hidden="true" />
                  <span>
                    {t(
                      resultMeta.status === "partial"
                        ? "toolCall.lsp.incompleteEmpty"
                        : "toolCall.lsp.noActions",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {/* Definition jump view（goto definition / type-definition / implementation） */}
            {parsedResult.type === "definition-jump" ? (
              parsedResult.definitions.length > 0 ? (
                <div className="tool-call-lsp-def-list">
                  {parsedResult.definitions.map((def, idx) => (
                    <div
                      key={`${def.filePath}-${def.line}-${idx}`}
                      className="tool-call-lsp-def-item"
                    >
                      <div
                        className="tool-call-lsp-def-header"
                        title={def.filePath}
                      >
                        <Crosshair size={11} aria-hidden="true" />
                        <span className="tool-call-lsp-def-name">
                          {getFileName(def.filePath)}
                        </span>
                        <span className="tool-call-lsp-def-path">
                          {def.filePath}
                        </span>
                        <span className="tool-call-codelens-ref-file-count">
                          <Hash size={9} aria-hidden="true" />
                          {def.line}:{def.column}
                          {def.endLine !== undefined &&
                          def.endColumn !== undefined
                            ? ` → ${def.endLine}:${def.endColumn}`
                            : ""}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <XCircle size={14} aria-hidden="true" />
                  <span>
                    {t(
                      resultMeta.status === "partial"
                        ? "toolCall.lsp.incompleteEmpty"
                        : "toolCall.lsp.noDefinitions",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {/* Workspace symbols view */}
            {parsedResult.type === "workspace-symbols" ? (
              parsedResult.symbols.length > 0 ? (
                <div className="tool-call-lsp-symbol-list">
                  {parsedResult.symbols.map((symbol, idx) => (
                    <div
                      key={`${symbol.name}-${symbol.filePath ?? ""}-${symbol.line ?? 0}-${idx}`}
                      className="tool-call-lsp-symbol-item"
                    >
                      <span className="tool-call-lsp-symbol-name">
                        <ScanSearch size={11} aria-hidden="true" />
                        <code>{symbol.name}</code>
                      </span>
                      {symbol.kind ? (
                        <span className="tool-call-lsp-kind-badge">
                          {symbol.kind}
                        </span>
                      ) : null}
                      {symbol.detail ? (
                        <span
                          className="tool-call-lsp-symbol-detail"
                          title={symbol.detail}
                        >
                          {symbol.detail}
                        </span>
                      ) : null}
                      {symbol.filePath ? (
                        <span
                          className="tool-call-lsp-symbol-path"
                          title={symbol.filePath}
                        >
                          {getFileName(symbol.filePath)}
                          {symbol.line !== undefined && symbol.line > 0
                            ? `:${symbol.line}:${symbol.column ?? 0}`
                            : ""}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <XCircle size={14} aria-hidden="true" />
                  <span>
                    {t(
                      resultMeta.status === "partial"
                        ? "toolCall.lsp.incompleteEmpty"
                        : "toolCall.lsp.noSymbols",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {/* Call hierarchy view */}
            {parsedResult.type === "call-hierarchy" ? (
              parsedResult.incoming.length > 0 ||
              parsedResult.outgoing.length > 0 ? (
                <div className="tool-call-lsp-hierarchy">
                  {parsedResult.incoming.length > 0 ? (
                    <div className="tool-call-lsp-hierarchy-section">
                      <div className="tool-call-lsp-hierarchy-title">
                        <ArrowUp size={11} aria-hidden="true" />
                        {t("toolCall.lsp.callers")}
                      </div>
                      {parsedResult.incoming.map((call, idx) => (
                        <div
                          key={`in-${idx}`}
                          className="tool-call-lsp-hierarchy-item"
                        >
                          <code className="tool-call-lsp-hierarchy-name">
                            {call.caller?.name ?? "?"}
                          </code>
                          {call.caller?.kind ? (
                            <span className="tool-call-lsp-kind-badge">
                              {call.caller.kind}
                            </span>
                          ) : null}
                          <span className="tool-call-lsp-hierarchy-loc">
                            {call.caller?.filePath
                              ? `${getFileName(call.caller.filePath)}:${call.caller.line ?? 0}`
                              : ""}
                          </span>
                          <span className="tool-call-lsp-hierarchy-sites">
                            {t("toolCall.lsp.callSites", {
                              values: { count: call.callSites.length },
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {parsedResult.outgoing.length > 0 ? (
                    <div className="tool-call-lsp-hierarchy-section">
                      <div className="tool-call-lsp-hierarchy-title">
                        <ArrowDown size={11} aria-hidden="true" />
                        {t("toolCall.lsp.callees")}
                      </div>
                      {parsedResult.outgoing.map((call, idx) => (
                        <div
                          key={`out-${idx}`}
                          className="tool-call-lsp-hierarchy-item"
                        >
                          <code className="tool-call-lsp-hierarchy-name">
                            {call.callee?.name ?? "?"}
                          </code>
                          {call.callee?.kind ? (
                            <span className="tool-call-lsp-kind-badge">
                              {call.callee.kind}
                            </span>
                          ) : null}
                          <span className="tool-call-lsp-hierarchy-loc">
                            {call.callee?.filePath
                              ? `${getFileName(call.callee.filePath)}:${call.callee.line ?? 0}`
                              : ""}
                          </span>
                          <span className="tool-call-lsp-hierarchy-sites">
                            {t("toolCall.lsp.callSites", {
                              values: { count: call.callSites.length },
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <XCircle size={14} aria-hidden="true" />
                  <span>
                    {t(
                      resultMeta.status === "partial"
                        ? "toolCall.lsp.incompleteEmpty"
                        : "toolCall.lsp.noHierarchy",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {/* Type hierarchy view */}
            {parsedResult.type === "type-hierarchy" ? (
              parsedResult.supertypes.length > 0 ||
              parsedResult.subtypes.length > 0 ? (
                <div className="tool-call-lsp-hierarchy">
                  {parsedResult.supertypes.length > 0 ? (
                    <div className="tool-call-lsp-hierarchy-section">
                      <div className="tool-call-lsp-hierarchy-title">
                        <ArrowUp size={11} aria-hidden="true" />
                        {t("toolCall.lsp.supertypes")}
                      </div>
                      {parsedResult.supertypes.map((item, idx) => (
                        <div
                          key={`sup-${idx}`}
                          className="tool-call-lsp-hierarchy-item"
                        >
                          <code className="tool-call-lsp-hierarchy-name">
                            {item.name}
                          </code>
                          {item.kind ? (
                            <span className="tool-call-lsp-kind-badge">
                              {item.kind}
                            </span>
                          ) : null}
                          <span className="tool-call-lsp-hierarchy-loc">
                            {item.filePath
                              ? `${getFileName(item.filePath)}:${item.line ?? 0}`
                              : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {parsedResult.subtypes.length > 0 ? (
                    <div className="tool-call-lsp-hierarchy-section">
                      <div className="tool-call-lsp-hierarchy-title">
                        <ArrowDown size={11} aria-hidden="true" />
                        {t("toolCall.lsp.subtypes")}
                      </div>
                      {parsedResult.subtypes.map((item, idx) => (
                        <div
                          key={`sub-${idx}`}
                          className="tool-call-lsp-hierarchy-item"
                        >
                          <code className="tool-call-lsp-hierarchy-name">
                            {item.name}
                          </code>
                          {item.kind ? (
                            <span className="tool-call-lsp-kind-badge">
                              {item.kind}
                            </span>
                          ) : null}
                          <span className="tool-call-lsp-hierarchy-loc">
                            {item.filePath
                              ? `${getFileName(item.filePath)}:${item.line ?? 0}`
                              : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <XCircle size={14} aria-hidden="true" />
                  <span>
                    {t(
                      resultMeta.status === "partial"
                        ? "toolCall.lsp.incompleteEmpty"
                        : "toolCall.lsp.noHierarchy",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {/* Hover view */}
            {parsedResult.type === "hover" ? (
              <div className="tool-call-section">
                <span className="tool-call-section-label">
                  {t("toolCall.lsp.result")}
                </span>
                <pre
                  className="tool-call-section-pre"
                  style={{
                    whiteSpace: "pre-wrap",
                    maxHeight: 320,
                    overflowY: "auto",
                  }}
                >
                  {parsedResult.contents}
                </pre>
              </div>
            ) : null}

            {/* References view */}
            {parsedResult.type === "references" ? (
              parsedResult.references.length > 0 ? (
                <div className="tool-call-codelens-ref-list">
                  {parsedResult.references.map((ref, idx) => (
                    <div
                      key={`${ref.filePath}-${ref.line}-${idx}`}
                      className="tool-call-codelens-ref-match"
                      style={{ padding: "4px 8px" }}
                    >
                      <span className="tool-call-codelens-ref-loc">
                        <Hash size={9} aria-hidden="true" />
                        {ref.filePath ? `${getFileName(ref.filePath)}:` : ""}
                        {ref.line}:{ref.column}
                      </span>
                      {ref.context ? (
                        <code
                          className="tool-call-codelens-ref-access"
                          style={{ marginLeft: 8 }}
                        >
                          {ref.context}
                        </code>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <XCircle size={14} aria-hidden="true" />
                  <span>
                    {t(
                      resultMeta.status === "partial"
                        ? "toolCall.lsp.incompleteEmpty"
                        : "toolCall.lsp.noReferences",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {parsedResult.type === "symbols" &&
              (parsedResult.symbols.length > 0 ? (
                <LspSymbolTree nodes={parsedResult.symbols} />
              ) : (
                <p>
                  {t(
                    resultMeta.status === "partial"
                      ? "toolCall.lsp.incompleteEmpty"
                      : "toolCall.lsp.noSymbols",
                  )}
                </p>
              ))}

            {/* Vulncheck view */}
            {parsedResult.type === "vulncheck" ? (
              parsedResult.findings.length > 0 ? (
                <div className="tool-call-lsp-action-list">
                  {parsedResult.summary ? (
                    <div className="tool-call-lsp-diag-summary">
                      {parsedResult.summary}
                    </div>
                  ) : null}
                  {parsedResult.findings.map((finding) => (
                    <div key={finding.id} className="tool-call-lsp-action-item">
                      <span className="tool-call-lsp-action-title">
                        <ShieldAlert size={11} aria-hidden="true" />
                        <code>{finding.id}</code>
                      </span>
                      {finding.affectedPackages.length > 0 ? (
                        <span className="tool-call-lsp-kind-badge">
                          {finding.affectedPackages.join(", ")}
                        </span>
                      ) : null}
                      {finding.details ? (
                        <div
                          className="tool-call-lsp-completion-doc"
                          title={finding.details}
                        >
                          {truncateText(finding.details, 200)}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <CheckCircle2 size={14} aria-hidden="true" />
                  <span>
                    {t(
                      resultMeta.status === "partial"
                        ? "toolCall.lsp.incompleteEmpty"
                        : "toolCall.lsp.noVulns",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {/* Execute command view */}
            {parsedResult.type === "execute-command" ? (
              parsedResult.files && parsedResult.files.length > 0 ? (
                <div className="tool-call-lsp-rename-list">
                  {parsedResult.files.map((file, fileIdx) => (
                    <div
                      key={`${file.uri}-${fileIdx}`}
                      className="tool-call-lsp-rename-file"
                    >
                      <div
                        className="tool-call-lsp-rename-file-header"
                        title={uriToPath(file.uri)}
                      >
                        <FileCode size={12} aria-hidden="true" />
                        <span className="tool-call-lsp-rename-file-name">
                          {getFileName(uriToPath(file.uri))}
                        </span>
                        <span className="tool-call-codelens-ref-file-count">
                          {t("toolCall.lsp.editCount", {
                            values: { count: file.editCount },
                          })}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : parsedResult.resultText ? (
                <div className="tool-call-section">
                  <pre className="tool-call-section-pre">
                    {parsedResult.resultText}
                  </pre>
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <CheckCircle2 size={14} aria-hidden="true" />
                  <span>
                    {t(
                      parsedResult.applied
                        ? "toolCall.lsp.renameApplied"
                        : "toolCall.lsp.noChanges",
                    )}
                  </span>
                </div>
              )
            ) : null}

            {/* Raw result fallback */}
            {parsedResult.type === "raw" ? (
              <section className="tool-call-section">
                <span className="tool-call-section-label">
                  {t("toolCall.lsp.result")}
                </span>
                <pre className="tool-call-section-pre">{parsedResult.text}</pre>
              </section>
            ) : null}
          </>
        )}
      {/* Pending / running state */}
      {parsedResult.type === "empty" ? (
        isRunning ? (
          <LspProgress
            operation={operation}
            startedAt={toolCall.startedAt}
            displayName={displayName}
          />
        ) : (
          <div className="tool-call-codelens-pending">
            <ScanSearch size={14} aria-hidden="true" />
            <span>
              {t(
                toolCall.status === "pending"
                  ? "toolCall.lsp.waiting"
                  : toolCall.status === "error"
                    ? "toolCall.lsp.failedEmpty"
                    : "toolCall.lsp.completedEmpty",
              )}
            </span>
          </div>
        )
      ) : null}
    </div>
  );
}

function LspProgress({
  operation,
  startedAt,
  displayName,
}: {
  operation: LspOperation | null;
  startedAt?: number;
  displayName?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const isRunning = true;
  // 运行耗时计算（每 200ms 刷新一次）
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  useEffect(() => {
    if (!isRunning) {
      setElapsedMs(0);
      return;
    }
    const start = startedAt ?? Date.now();
    const update = () => {
      setElapsedMs(Math.max(0, Date.now() - start));
    };
    update();
    const timer = setInterval(update, 200);
    return () => clearInterval(timer);
  }, [isRunning, startedAt]);

  const phaseDescription = useMemo(() => {
    switch (operation) {
      case "diagnostics":
        return t("toolCall.lsp.progress.diagnostics");
      case "workspace-diagnostics":
        return t("toolCall.lsp.progress.workspaceDiagnostics");
      case "workspace-symbols":
        return t("toolCall.lsp.progress.workspaceSymbols");
      case "symbols":
        return t("toolCall.lsp.progress.symbols");
      case "rename":
        return t("toolCall.lsp.progress.rename");
      case "code-action":
        return t("toolCall.lsp.progress.codeAction");
      case "execute-command":
        return t("toolCall.lsp.progress.executeCommand");
      case "call-hierarchy":
        return t("toolCall.lsp.progress.callHierarchy");
      case "type-hierarchy":
        return t("toolCall.lsp.progress.typeHierarchy");
      case "hover":
        return t("toolCall.lsp.progress.hover");
      case "goto":
        return t("toolCall.lsp.progress.goto");
      case "references":
        return t("toolCall.lsp.progress.references");
      case "vulncheck":
        return t("toolCall.lsp.progress.vulncheck");
      default:
        return t("toolCall.lsp.progress.default");
    }
  }, [operation, t]);

  return (
    <div className="tool-call-lsp-progress-card">
      <div className="tool-call-lsp-progress-header">
        <Loader2
          className="tool-call-icon-spinning tool-call-lsp-progress-spinner"
          size={14}
          aria-hidden="true"
        />
        <div className="tool-call-lsp-progress-text">
          <span className="tool-call-lsp-progress-phase">
            {phaseDescription}
          </span>
          {displayName ? (
            <span className="tool-call-lsp-progress-detail" title={displayName}>
              {displayName}
            </span>
          ) : null}
        </div>
        <div className="tool-call-lsp-progress-meta">
          <span
            className="tool-call-lsp-progress-elapsed"
            title={t("toolCall.lsp.progress.elapsedTitle")}
          >
            <Clock size={11} aria-hidden="true" />
            {(elapsedMs / 1000).toFixed(1)}s
          </span>
        </div>
      </div>
      <div className="tool-call-lsp-progress-track">
        <div className="tool-call-lsp-progress-bar" />
      </div>
    </div>
  );
}
