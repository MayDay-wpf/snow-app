import hljs from "highlight.js";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import {
  Annotation,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  keymap,
  lineNumbers,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useImperativeHandle, useRef } from "react";

import { normalizeCodeLanguage } from "../../../utils/syntaxHighlight";

/** 与预览一致的分块高亮参数。 */
const CHUNK_LINES = 128;
const CONTEXT_LINES = 12;
const MAX_CHUNK_CHARS = 65536;
const MAX_CACHED_CHUNKS = 256;
const INDENT = "  ";

type Token = [from: number, to: number, cls: string];

export type CodeEditorHandle = {
  focus: () => void;
  getText: () => string;
  getSelection: () => { from: number; to: number };
  getSelectedText: () => string;
  select: (from: number, to: number) => void;
  /** 程序化替换全文：不进撤销栈，也不视为用户编辑。 */
  setText: (text: string) => void;
};

export type CodeEditorSearch = {
  matches: readonly { start: number; end: number }[];
  current: number;
  limit: number;
};

type CodeEditorProps = {
  ref?: React.Ref<CodeEditorHandle>;
  initialText: string;
  language: string;
  autoFocus?: boolean;
  search: CodeEditorSearch | null;
  /** 文档变化回调（O(1)，不序列化全文）；userEdit=false 表示 setText。 */
  onChange: (state: EditorState, userEdit: boolean) => void;
  onSave: () => void;
  onEscape: () => void;
};

const externalChange = Annotation.define<boolean>();

// ===== hljs 视口分块高亮 =====

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
      {
        language,
        ignoreIllegals: true,
      },
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

const hljsHighlight = (fileLanguage: string) => {
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

// ===== 文内搜索标记 =====

const setSearchMarks = StateEffect.define<DecorationSet>();

const searchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setSearchMarks)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const searchMark = Decoration.mark({ class: "file-viewer-search-mark-inline" });
const searchMarkCurrent = Decoration.mark({
  class: "file-viewer-search-mark-inline current",
});
const searchLine = Decoration.line({ class: "file-viewer-cm-search-line" });
const searchLineCurrent = Decoration.line({
  class: "file-viewer-cm-search-line current",
});

const buildSearchMarks = (
  doc: Text,
  search: CodeEditorSearch | null,
): DecorationSet => {
  if (!search || search.matches.length === 0) return Decoration.none;
  const { matches, limit } = search;
  const current = matches[Math.min(search.current, matches.length - 1)];
  const ranges: Range<Decoration>[] = [];
  const lines = new Map<number, boolean>();
  let count = 0;
  for (const match of matches) {
    if (match.end > doc.length) break;
    const isCurrent = match === current;
    if (count >= limit && !isCurrent) continue;
    count += 1;
    ranges.push(
      (isCurrent ? searchMarkCurrent : searchMark).range(
        match.start,
        match.end,
      ),
    );
    const lineFrom = doc.lineAt(match.start).from;
    lines.set(lineFrom, (lines.get(lineFrom) ?? false) || isCurrent);
  }
  for (const [lineFrom, isCurrent] of lines) {
    ranges.push((isCurrent ? searchLineCurrent : searchLine).range(lineFrom));
  }
  return Decoration.set(ranges, true);
};

// ===== 外观：沿用 .file-viewer-code 的字体、行高与行号列样式 =====

const editorTheme = EditorView.theme({
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
});

/** Tab：无选区插入缩进，有选区整行缩进。 */
const indentOrInsert = (view: EditorView): boolean => {
  const { state } = view;
  if (state.selection.ranges.some((range) => !range.empty)) {
    return indentMore(view);
  }
  view.dispatch({
    ...state.replaceSelection(state.facet(indentUnit)),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

/** CodeMirror 6 编辑器：DOM 只渲染视口内的行，高亮复用 hljs 主题与分块缓存。 */
export function CodeEditor({
  ref,
  initialText,
  language,
  autoFocus,
  search,
  onChange,
  onSave,
  onEscape,
}: CodeEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacksRef = useRef({ onChange, onSave, onEscape });
  callbacksRef.current = { onChange, onSave, onEscape };
  const initialRef = useRef({ initialText, language, autoFocus });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = initialRef.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial.initialText,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          EditorState.tabSize.of(2),
          indentUnit.of(INDENT),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  callbacksRef.current.onSave();
                  return true;
                },
              },
              {
                key: "Escape",
                run: () => {
                  callbacksRef.current.onEscape();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([
            { key: "Tab", run: indentOrInsert, shift: indentLess },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          hljsHighlight(initial.language),
          searchField,
          editorTheme,
          EditorView.contentAttributes.of({
            class: "hljs",
            spellcheck: "false",
            autocorrect: "off",
            autocapitalize: "off",
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const userEdit = update.transactions.some(
              (tr) => !tr.annotation(externalChange),
            );
            callbacksRef.current.onChange(update.state, userEdit);
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (initial.autoFocus) view.focus();
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: setSearchMarks.of(buildSearchMarks(view.state.doc, search)),
    });
  }, [search]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      getText: () => viewRef.current?.state.sliceDoc() ?? "",
      getSelection: () => {
        const main = viewRef.current?.state.selection.main;
        return { from: main?.from ?? 0, to: main?.to ?? 0 };
      },
      getSelectedText: () => {
        const state = viewRef.current?.state;
        if (!state) return "";
        const { from, to } = state.selection.main;
        return state.sliceDoc(from, to);
      },
      select: (from, to) => {
        const view = viewRef.current;
        if (!view) return;
        const length = view.state.doc.length;
        const anchor = Math.min(from, length);
        const head = Math.min(to, length);
        view.dispatch({
          selection: { anchor, head },
          effects: EditorView.scrollIntoView(anchor, { y: "center" }),
        });
      },
      setText: (text) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          annotations: [
            externalChange.of(true),
            Transaction.addToHistory.of(false),
          ],
        });
      },
    }),
    [],
  );

  return <div className="file-viewer-cm" ref={hostRef} />;
}
