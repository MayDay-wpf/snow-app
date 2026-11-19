import hljs from "highlight.js";
import { foldService, foldedRanges, unfoldEffect } from "@codemirror/language";
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { normalizeCodeLanguage } from "../../../utils/syntaxHighlight";

// ===== 共享的 CodeMirror 配置：语法高亮、主题、搜索标记、审阅标记 =====

const CHUNK_LINES = 128;
const CONTEXT_LINES = 12;
const MAX_CHUNK_CHARS = 65536;
const MAX_CACHED_CHUNKS = 256;

type Token = [from: number, to: number, cls: string];

const tokenCache = new Map<string, Token[] | null>();
const markCache = new Map<string, Decoration>();

const markFor = (cls: string): Decoration => {
  let mark = markCache.get(cls);
  if (!mark) {
    mark = Decoration.mark({ class: cls });
    markCache.set(cls, mark);
  }
  return mark;
};

/** 把 hljs 输出的 HTML 解析为相对原文的 [from, to, class] 区间。 */
const parseHljsTokens = (html: string): Token[] => {
  const tokens: Token[] = [];
  const stack: { from: number; cls: string }[] = [];
  let pos = 0;
  let i = 0;
  while (i < html.length) {
    const code = html.charCodeAt(i);
    if (code === 60) {
      const end = html.indexOf(">", i);
      if (end === -1) break;
      if (html.charCodeAt(i + 1) === 47) {
        const open = stack.pop();
        if (open && open.cls && pos > open.from) {
          tokens.push([open.from, pos, open.cls]);
        }
      } else {
        const match = /class="([^"]*)"/.exec(html.slice(i, end));
        stack.push({ from: pos, cls: match?.[1] ?? "" });
      }
      i = end + 1;
    } else if (code === 38) {
      const end = html.indexOf(";", i);
      i = end === -1 ? i + 1 : end + 1;
      pos += 1;
    } else {
      i += 1;
      pos += 1;
    }
  }
  return tokens;
};

const readChunkTokens = (
  language: string,
  prefix: string,
  body: string,
): Token[] | null => {
  const key = `${language}\0${prefix}\0${body}`;
  const cached = tokenCache.get(key);
  if (cached !== undefined) {
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached;
  }
  let tokens: Token[] | null = null;
  const shift = prefix.length > 0 ? prefix.length + 1 : 0;
  try {
    const html = hljs.highlight(
      prefix.length > 0 ? `${prefix}\n${body}` : body,
      { language, ignoreIllegals: true },
    ).value;
    tokens = [];
    for (const [from, to, cls] of parseHljsTokens(html)) {
      if (to <= shift) continue;
      tokens.push([Math.max(0, from - shift), to - shift, cls]);
    }
  } catch {
    tokens = null;
  }
  if (tokenCache.size >= MAX_CACHED_CHUNKS) {
    const oldest = tokenCache.keys().next();
    if (!oldest.done) tokenCache.delete(oldest.value);
  }
  tokenCache.set(key, tokens);
  return tokens;
};

const pushChunk = (
  doc: Text,
  language: string,
  chunk: number,
  out: Range<Decoration>[],
): void => {
  const firstLine = chunk * CHUNK_LINES + 1;
  if (firstLine > doc.lines) return;
  const lastLine = Math.min(doc.lines, firstLine + CHUNK_LINES - 1);
  const base = doc.line(firstLine).from;
  const end = doc.line(lastLine).to;
  if (end - base > MAX_CHUNK_CHARS) return;
  const contextFrom = doc.line(Math.max(1, firstLine - CONTEXT_LINES)).from;
  const prefix =
    contextFrom < base ? doc.sliceString(contextFrom, base - 1) : "";
  const tokens = readChunkTokens(language, prefix, doc.sliceString(base, end));
  if (!tokens) return;
  for (const [from, to, cls] of tokens) {
    out.push(markFor(cls).range(base + from, base + to));
  }
};

const buildHighlight = (view: EditorView, language: string): DecorationSet => {
  const { doc } = view.state;
  const ranges: Range<Decoration>[] = [];
  const done = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    const first = Math.floor((doc.lineAt(from).number - 1) / CHUNK_LINES);
    const last = Math.floor((doc.lineAt(to).number - 1) / CHUNK_LINES);
    for (let chunk = first; chunk <= last; chunk += 1) {
      if (done.has(chunk)) continue;
      done.add(chunk);
      pushChunk(doc, language, chunk, ranges);
    }
  }
  return Decoration.set(ranges, true);
};

/** 只用 highlight.js 与共享主题给视口分块上色，不做增量语法树。 */
export const hljsHighlight = (fileLanguage: string): Extension => {
  const language = normalizeCodeLanguage(fileLanguage);
  if (!language || !hljs.getLanguage(language)) return [];
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildHighlight(view, language);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildHighlight(update.view, language);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
};

export const codeTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--bg-primary)",
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6" },
  ".cm-content": {
    padding: "12px 0",
    caretColor: "var(--text-primary)",
  },
  ".cm-line": { padding: "0 14px 0 10px" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-muted)",
    borderRight: "1px solid var(--border-color)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px 0 2px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-primary)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor:
        "color-mix(in srgb, var(--accent-color, #4f8cff) 28%, transparent)",
    },
  ".cm-line.file-viewer-cm-search-line": {
    backgroundColor:
      "color-mix(in srgb, var(--accent-amber-text, #d97706) 9%, transparent)",
  },
  ".cm-line.file-viewer-cm-search-line.current": {
    backgroundColor:
      "color-mix(in srgb, var(--accent-color, #4f8cff) 16%, transparent)",
  },
  ".cm-line.file-viewer-cm-focus-line": {
    backgroundColor:
      "color-mix(in srgb, var(--accent-amber-text, #d97706) 12%, transparent)",
  },
});

// ===== 文内搜索标记（只渲染视口内的命中） =====

export type CodeSearchMarks = {
  matches: readonly { start: number; end: number }[];
  current: number;
  limit: number;
} | null;

export const setCodeSearch = StateEffect.define<CodeSearchMarks>();

const codeSearchField = StateField.define<CodeSearchMarks>({
  create: () => null,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setCodeSearch)) next = effect.value;
    }
    if (next && tr.docChanged) {
      next = {
        ...next,
        matches: next.matches.map((match) => ({
          start: tr.changes.mapPos(match.start, 1),
          end: tr.changes.mapPos(match.end, -1),
        })),
      };
    }
    return next;
  },
});

const searchMark = Decoration.mark({ class: "file-viewer-search-mark-inline" });
const searchMarkCurrent = Decoration.mark({
  class: "file-viewer-search-mark-inline current",
});
const searchLine = Decoration.line({ class: "file-viewer-cm-search-line" });
const searchLineCurrent = Decoration.line({
  class: "file-viewer-cm-search-line current",
});

const buildSearchDecorations = (view: EditorView): DecorationSet => {
  const state = view.state.field(codeSearchField);
  if (!state || state.matches.length === 0) return Decoration.none;
  const { doc } = view.state;
  const current =
    state.matches[Math.min(state.current, state.matches.length - 1)];
  const ranges: Range<Decoration>[] = [];
  const lines = new Map<number, boolean>();
  let count = 0;
  for (const { from, to } of view.visibleRanges) {
    let lo = 0;
    let hi = state.matches.length - 1;
    let first = state.matches.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (state.matches[mid].end > from) {
        first = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    for (let i = first; i < state.matches.length; i += 1) {
      const match = state.matches[i];
      if (match.start >= to) break;
      const isCurrent = match === current;
      if (count >= state.limit && !isCurrent) continue;
      const start = Math.max(0, match.start);
      const end = Math.min(doc.length, match.end);
      if (end <= start) continue;
      count += 1;
      ranges.push(
        (isCurrent ? searchMarkCurrent : searchMark).range(start, end),
      );
      const lineFrom = doc.lineAt(start).from;
      lines.set(lineFrom, (lines.get(lineFrom) ?? false) || isCurrent);
    }
  }
  for (const [lineFrom, isCurrent] of lines) {
    ranges.push((isCurrent ? searchLineCurrent : searchLine).range(lineFrom));
  }
  return Decoration.set(ranges, true);
};

const searchDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildSearchDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(codeSearchField) !==
          update.state.field(codeSearchField)
      ) {
        this.decorations = buildSearchDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const codeSearchExtension = (): Extension => [
  codeSearchField,
  searchDecorations,
];

// ===== 审阅高亮行（行区间 + 颜色槽） =====

export type CodeReviewMark = {
  startLine: number;
  endLine: number;
  colorIndex: number;
};

export const setCodeReviewMarks = StateEffect.define<CodeReviewMark[]>();

const buildReviewMarks = (
  doc: Text,
  marks: readonly CodeReviewMark[],
): DecorationSet => {
  if (marks.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const byLine = new Map<number, number>();
  for (const mark of marks) {
    const from = Math.max(1, mark.startLine);
    const to = Math.min(doc.lines, mark.endLine);
    for (let line = from; line <= to; line += 1) {
      // 同一行被多条标注覆盖时保留最后一个颜色槽（与旧渲染一致）。
      byLine.set(line, mark.colorIndex);
    }
  }
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const colorIndex = byLine.get(line) as number;
    builder.add(
      doc.line(line).from,
      doc.line(line).from,
      Decoration.line({
        class: `file-viewer-code-line--review-target file-review-hl-${colorIndex}`,
      }),
    );
  }
  return builder.finish();
};

const codeReviewField = StateField.define<{
  marks: CodeReviewMark[];
  decorations: DecorationSet;
}>({
  create: () => ({ marks: [], decorations: Decoration.none }),
  update(value, tr) {
    let marks = value.marks;
    let changed = false;
    for (const effect of tr.effects) {
      if (effect.is(setCodeReviewMarks)) {
        marks = effect.value;
        changed = true;
      }
    }
    // 文档整体替换后行号失效：位置装饰必须按新文档重建。
    if (!changed && !tr.docChanged) return value;
    return { marks, decorations: buildReviewMarks(tr.state.doc, marks) };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

export const codeReviewExtension = (): Extension => codeReviewField;

// ===== 跳转行高亮 =====

export const setCodeFocusLine = StateEffect.define<number | null>();

const focusDecorations = (doc: Text, line: number | null): DecorationSet =>
  line == null || line < 1 || line > doc.lines
    ? Decoration.none
    : Decoration.set([
        Decoration.line({ class: "file-viewer-cm-focus-line" }).range(
          doc.line(line).from,
        ),
      ]);

const codeFocusField = StateField.define<{
  line: number | null;
  decorations: DecorationSet;
}>({
  create: () => ({ line: null, decorations: Decoration.none }),
  update(value, tr) {
    let line = value.line;
    let changed = false;
    for (const effect of tr.effects) {
      if (effect.is(setCodeFocusLine)) {
        line = effect.value;
        changed = true;
      }
    }
    if (!changed && !tr.docChanged) return value;
    return { line, decorations: focusDecorations(tr.state.doc, line) };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

export const codeFocusExtension = (): Extension => codeFocusField;

// ===== 缩进折叠（沿用原有折叠区域，由外部算好后注入） =====

export type CodeFoldRegion = { start: number; end: number };

export const codeFoldExtension = (regionsRef: {
  current: Map<number, CodeFoldRegion>;
}): Extension =>
  foldService.of((state, lineStart) => {
    const region = regionsRef.current.get(state.doc.lineAt(lineStart).number);
    if (!region || region.end <= region.start) return null;
    const end = Math.min(region.end, state.doc.lines);
    return { from: lineStart, to: state.doc.line(end).to };
  });

/** 目标位置落在折叠区域内时先展开，保证跳转可见。 */
export const unfoldAround = (view: EditorView, pos: number): void => {
  const doc = view.state.doc;
  const target = Math.min(Math.max(0, pos), doc.length);
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(view.state).between(0, doc.length, (from, to) => {
    if (from <= target && target <= to) {
      effects.push(unfoldEffect.of({ from, to }));
    }
  });
  if (effects.length > 0) view.dispatch({ effects });
};

export const scrollToPos = (view: EditorView, pos: number): void => {
  const doc = view.state.doc;
  const target = Math.min(Math.max(0, pos), doc.length);
  unfoldAround(view, target);
  view.dispatch({
    effects: EditorView.scrollIntoView(target, { y: "center" }),
  });
};
