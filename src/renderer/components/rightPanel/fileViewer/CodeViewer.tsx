import { defaultKeymap } from "@codemirror/commands";
import { foldGutter } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useImperativeHandle, useRef } from "react";

import {
  codeFoldExtension,
  codeFocusExtension,
  codeReviewExtension,
  codeSearchExtension,
  codeTheme,
  hljsHighlight,
  scrollToPos,
  setCodeFocusLine,
  setCodeReviewMarks,
  setCodeSearch,
  type CodeFoldRegion,
  type CodeReviewMark,
  type CodeSearchMarks,
} from "./codeMirrorSupport";

const FOCUS_HIGHLIGHT_MS = 2400;
const EMPTY_MARKS: CodeReviewMark[] = [];

export type CodeViewerHandle = {
  focus: () => void;
  getText: () => string;
  getSelection: () => { from: number; to: number };
  getSelectedText: () => string;
  scrollToPos: (pos: number) => void;
  scrollToLine: (line: number) => void;
};

type CodeViewerProps = {
  ref?: React.Ref<CodeViewerHandle>;
  text: string;
  language: string;
  search: CodeSearchMarks;
  reviewMarks?: CodeReviewMark[];
  focusLine?: number | null;
  foldRegions?: CodeFoldRegion[];
  /** 选区可能变化（鼠标抬起 / 按键抬起），供审阅面板捕获锚点。 */
  onSelectionChange?: () => void;
};

/** 只读代码视图：与编辑模式共用 CodeMirror 配置，只渲染视口内的行。 */
export function CodeViewer({
  ref,
  text,
  language,
  search,
  reviewMarks = EMPTY_MARKS,
  focusLine = null,
  foldRegions = [],
  onSelectionChange,
}: CodeViewerProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastTextRef = useRef(text);
  const foldMapRef = useRef(new Map<number, CodeFoldRegion>());
  const selectionRef = useRef(onSelectionChange);
  selectionRef.current = onSelectionChange;
  const initialRef = useRef({ text, language });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = initialRef.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial.text,
        extensions: [
          lineNumbers(),
          foldGutter(),
          codeFoldExtension(foldMapRef),
          drawSelection(),
          keymap.of(defaultKeymap),
          EditorState.readOnly.of(true),
          EditorState.tabSize.of(2),
          hljsHighlight(initial.language),
          codeSearchExtension(),
          codeReviewExtension(),
          codeFocusExtension(),
          codeTheme,
          EditorView.contentAttributes.of({
            class: "hljs",
            spellcheck: "false",
          }),
          EditorView.domEventHandlers({
            mouseup: () => {
              selectionRef.current?.();
              return false;
            },
            keyup: () => {
              selectionRef.current?.();
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  // 内容被外部替换（重新加载 / 切换分区）：整篇替换，保留滚动与折叠状态。
  useEffect(() => {
    const view = viewRef.current;
    if (!view || lastTextRef.current === text) return;
    lastTextRef.current = text;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  }, [text]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setCodeSearch.of(search) });
  }, [search]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setCodeReviewMarks.of(reviewMarks) });
  }, [reviewMarks]);

  useEffect(() => {
    foldMapRef.current = new Map(
      foldRegions.map((region) => [region.start, region]),
    );
  }, [foldRegions]);

  // 外部定位：滚动到目标行并在短时间内高亮。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (focusLine == null || focusLine < 1) return;
    const line = Math.min(focusLine, view.state.doc.lines);
    scrollToPos(view, view.state.doc.line(line).from);
    view.dispatch({ effects: setCodeFocusLine.of(line) });
    const timer = window.setTimeout(() => {
      viewRef.current?.dispatch({ effects: setCodeFocusLine.of(null) });
    }, FOCUS_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [focusLine]);

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
      scrollToPos: (pos) => {
        const view = viewRef.current;
        if (view) scrollToPos(view, pos);
      },
      scrollToLine: (line) => {
        const view = viewRef.current;
        if (!view) return;
        scrollToPos(
          view,
          view.state.doc.line(Math.min(line, view.state.doc.lines)).from,
        );
      },
    }),
    [],
  );

  return <div className="file-viewer-cm" ref={hostRef} />;
}
