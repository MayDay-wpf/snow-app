import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { Annotation, EditorState, Prec, Transaction } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useImperativeHandle, useRef } from "react";

import {
  codeSearchExtension,
  codeTheme,
  hljsHighlight,
  setCodeSearch,
  type CodeSearchMarks,
} from "./codeMirrorSupport";

const INDENT = "  ";

export type CodeEditorHandle = {
  focus: () => void;
  getText: () => string;
  getSelection: () => { from: number; to: number };
  getSelectedText: () => string;
  select: (from: number, to: number) => void;
  /** 程序化替换全文：不进撤销栈，也不视为用户编辑。 */
  setText: (text: string) => void;
};

export type CodeEditorSearch = Exclude<CodeSearchMarks, null>;

type CodeEditorProps = {
  ref?: React.Ref<CodeEditorHandle>;
  initialText: string;
  language: string;
  autoFocus?: boolean;
  search: CodeSearchMarks;
  /** 文档变化回调（O(1)，不序列化全文）；userEdit=false 表示 setText。 */
  onChange: (state: EditorState, userEdit: boolean) => void;
  onSave: () => void;
  onEscape: () => void;
};

const externalChange = Annotation.define<boolean>();

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
          codeSearchExtension(),
          codeTheme,
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
    view.dispatch({ effects: setCodeSearch.of(search) });
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
