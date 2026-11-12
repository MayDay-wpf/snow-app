import { isImeComposing } from "../../../../shared/imeKeyboard";
import { isMacOS } from "../../../utils/shortcutUtils";
import { placeCaretAtEditableEnd } from "./fileTagUtils";

/**
 * contenteditable 统一撤销/重做栈。
 * chip 插入/删除直接改 DOM，不进浏览器原生撤销历史，故整体接管：
 * 每次内容变化记录一份 DOM 克隆快照，连续键入合并为一步。
 */

type NodePoint = { path: number[]; offset: number };
type SelectionSnapshot = { start: NodePoint; end: NodePoint } | null;
type TypingGroup = "insert" | "delete";

type HistoryEntry = {
  // 克隆节点共享属性字符串，图片 data URL 不会被重复拷贝
  fragment: DocumentFragment;
  selection: SelectionSnapshot;
  group: TypingGroup | null;
  at: number;
};

export type EditableHistoryOptions = {
  readContent: (el: HTMLElement) => string;
  /** 快照还原后同步外部状态（此期间的 record 不入栈） */
  onRestore: () => void;
};

const MAX_ENTRIES = 100;
const TYPING_MERGE_MS = 1000;

const typingGroupOf = (inputType: string): TypingGroup | null => {
  if (inputType === "insertText" || inputType === "insertCompositionText") {
    return "insert";
  }
  if (
    inputType.startsWith("delete") &&
    inputType !== "deleteByCut" &&
    inputType !== "deleteByDrag"
  ) {
    return "delete";
  }
  return null;
};

const cloneChildren = (el: HTMLElement): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  el.childNodes.forEach((child) => {
    fragment.appendChild(child.cloneNode(true));
  });
  return fragment;
};

const toPoint = (root: Node, node: Node, offset: number): NodePoint | null => {
  const path: number[] = [];
  let current: Node = node;
  while (current !== root) {
    const parent = current.parentNode;
    if (!parent) {
      return null;
    }
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return { path, offset };
};

const fromPoint = (
  root: Node,
  point: NodePoint,
): { node: Node; offset: number } | null => {
  let node: Node = root;
  for (const index of point.path) {
    const child = node.childNodes[index];
    if (!child) {
      return null;
    }
    node = child;
  }
  const max =
    node.nodeType === Node.TEXT_NODE
      ? (node as Text).length
      : node.childNodes.length;
  return { node, offset: Math.min(point.offset, max) };
};

/** 取按键字母：非拉丁布局回退到物理键位 */
const readShortcutLetter = (event: KeyboardEvent): string => {
  if (event.key.length === 1 && /[a-z]/i.test(event.key)) {
    return event.key.toLowerCase();
  }
  if (event.code === "KeyZ") {
    return "z";
  }
  if (event.code === "KeyY") {
    return "y";
  }
  return "";
};

export class EditableHistory {
  private entries: HistoryEntry[] = [];
  private index = -1;
  private content = "";
  private restoring = false;
  private amendPending = false;
  /** 上一次键入以空白结尾：下一次键入另起一步，撤销按词粒度回退 */
  private sealed = false;
  private pendingInput: {
    group: TypingGroup | null;
    boundary: boolean;
    composing: boolean;
  } | null = null;
  private pendingTimer = 0;
  private readonly isMac = isMacOS();
  private readonly el: HTMLElement;
  private readonly options: EditableHistoryOptions;

  constructor(el: HTMLElement, options: EditableHistoryOptions) {
    this.el = el;
    this.options = options;
    this.reset();
  }

  /** 以当前内容为新基线清空历史（发送、切换会话草稿） */
  reset(): void {
    this.content = this.options.readContent(this.el);
    this.entries = [this.snapshot(null)];
    this.index = 0;
    this.sealed = false;
    this.amendPending = false;
  }

  /** 下一次 record 并入当前步（非用户操作的异步补全） */
  amendNext(): void {
    this.amendPending = true;
  }

  record(content: string = this.options.readContent(this.el)): void {
    const input = this.pendingInput;
    this.pendingInput = null;
    const amend = this.amendPending;
    this.amendPending = false;
    if (this.restoring) {
      this.content = content;
      return;
    }
    if (content === this.content) {
      this.captureSelection();
      return;
    }
    this.content = content;
    const current = this.entries[this.index];
    const now = Date.now();
    if (amend && current) {
      current.fragment = cloneChildren(this.el);
      current.selection = this.readSelection();
      return;
    }
    const group = input?.group ?? null;
    // 输入法组合期间不按时间拆分，避免撤销露出拼音中间态
    const canMerge =
      group !== null &&
      !this.sealed &&
      current !== undefined &&
      this.index === this.entries.length - 1 &&
      current.group === group &&
      (input?.composing === true || now - current.at < TYPING_MERGE_MS);
    if (canMerge) {
      current.fragment = cloneChildren(this.el);
      current.selection = this.readSelection();
      current.at = now;
    } else {
      this.entries.splice(this.index + 1);
      this.entries.push(this.snapshot(group));
      if (this.entries.length > MAX_ENTRIES) {
        this.entries.shift();
      }
      this.index = this.entries.length - 1;
    }
    this.sealed = input?.boundary ?? false;
  }

  undo(): boolean {
    this.flushUnrecorded();
    if (this.index <= 0) {
      return false;
    }
    this.index -= 1;
    this.apply(this.entries[this.index]);
    return true;
  }

  redo(): boolean {
    this.flushUnrecorded();
    if (this.index >= this.entries.length - 1) {
      return false;
    }
    this.index += 1;
    this.apply(this.entries[this.index]);
    return true;
  }

  attach(): () => void {
    this.el.addEventListener("beforeinput", this.handleBeforeInput);
    this.el.addEventListener("keydown", this.handleKeyDown);
    document.addEventListener("selectionchange", this.handleSelectionChange);
    return () => {
      this.el.removeEventListener("beforeinput", this.handleBeforeInput);
      this.el.removeEventListener("keydown", this.handleKeyDown);
      document.removeEventListener(
        "selectionchange",
        this.handleSelectionChange,
      );
      window.clearTimeout(this.pendingTimer);
    };
  }

  private snapshot(group: TypingGroup | null): HistoryEntry {
    return {
      fragment: cloneChildren(this.el),
      selection: this.readSelection(),
      group,
      at: Date.now(),
    };
  }

  /** 漏记的 DOM 改动先入栈，保证撤销回到最近一次真实状态 */
  private flushUnrecorded(): void {
    const content = this.options.readContent(this.el);
    if (content !== this.content) {
      this.record(content);
    }
  }

  private apply(entry: HistoryEntry): void {
    this.restoring = true;
    try {
      this.el.replaceChildren(entry.fragment.cloneNode(true));
      this.restoreSelection(entry.selection);
      this.options.onRestore();
    } finally {
      this.restoring = false;
    }
    this.sealed = true;
  }

  private readSelection(): SelectionSnapshot {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!this.el.contains(range.commonAncestorContainer)) {
      return null;
    }
    const start = toPoint(this.el, range.startContainer, range.startOffset);
    const end = toPoint(this.el, range.endContainer, range.endOffset);
    return start && end ? { start, end } : null;
  }

  /** 当前步光标随用户移动更新，撤销下一步时光标回到改动前位置 */
  private captureSelection(): void {
    if (this.restoring) {
      return;
    }
    const current = this.entries[this.index];
    const selection = this.readSelection();
    if (current && selection) {
      current.selection = selection;
    }
  }

  private restoreSelection(snapshot: SelectionSnapshot): void {
    if (document.activeElement !== this.el) {
      return;
    }
    const selection = window.getSelection();
    const start = snapshot ? fromPoint(this.el, snapshot.start) : null;
    const end = snapshot ? fromPoint(this.el, snapshot.end) : null;
    if (!selection || !start || !end) {
      placeCaretAtEditableEnd(this.el);
      return;
    }
    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      placeCaretAtEditableEnd(this.el);
    }
  }

  private readonly handleBeforeInput = (event: InputEvent): void => {
    if (
      event.inputType === "historyUndo" ||
      event.inputType === "historyRedo"
    ) {
      // 菜单/系统触发的原生撤销同样走自有栈
      event.preventDefault();
      if (event.inputType === "historyUndo") {
        this.undo();
      } else {
        this.redo();
      }
      return;
    }
    const group = typingGroupOf(event.inputType);
    this.pendingInput = {
      group,
      boundary:
        group === "insert" &&
        typeof event.data === "string" &&
        /\s$/.test(event.data),
      composing: event.inputType === "insertCompositionText",
    };
    // input 与 beforeinput 同一任务内派发；被取消时由定时器清掉
    window.clearTimeout(this.pendingTimer);
    this.pendingTimer = window.setTimeout(() => {
      this.pendingInput = null;
    }, 0);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || isImeComposing(event)) {
      return;
    }
    const hasMod = this.isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!hasMod) {
      return;
    }
    const letter = readShortcutLetter(event);
    const isUndo = letter === "z" && !event.shiftKey;
    const isRedo =
      (letter === "z" && event.shiftKey) ||
      (!this.isMac && letter === "y" && !event.shiftKey);
    if (!isUndo && !isRedo) {
      return;
    }
    // 栈空时也拦截，防止原生撤销在快照之外改动 DOM
    event.preventDefault();
    if (isUndo) {
      this.undo();
    } else {
      this.redo();
    }
  };

  private readonly handleSelectionChange = (): void => {
    this.captureSelection();
  };
}

const registry = new WeakMap<HTMLElement, EditableHistory>();

export const attachEditableHistory = (
  el: HTMLElement,
  options: EditableHistoryOptions,
): (() => void) => {
  const history = new EditableHistory(el, options);
  registry.set(el, history);
  const detach = history.attach();
  return () => {
    detach();
    if (registry.get(el) === history) {
      registry.delete(el);
    }
  };
};

export const getEditableHistory = (
  el: HTMLElement | null | undefined,
): EditableHistory | undefined => (el ? registry.get(el) : undefined);
