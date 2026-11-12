// 拖放落点：按指针坐标解析编辑区插入位置，并绘制插入指示条。

type CaretBox = { x: number; top: number; height: number };

const AUTO_SCROLL_EDGE = 18;
const AUTO_SCROLL_STEP = 8;

/** 取 node 所在的最外层不可编辑 chip（root 内）。 */
const findChip = (root: HTMLElement, node: Node): HTMLElement | null => {
  let el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  let chip: HTMLElement | null = null;
  while (el && el !== root) {
    if (el.getAttribute("contenteditable") === "false") {
      chip = el;
    }
    el = el.parentElement;
  }
  return el === root ? chip : null;
};

const endRange = (root: HTMLElement): Range => {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
};

/** 落在 chip 上：按水平中线决定插在其前或其后。 */
const rangeBesideChip = (chip: HTMLElement, x: number): Range => {
  const rect = chip.getBoundingClientRect();
  const range = document.createRange();
  if (x < rect.left + rect.width / 2) {
    range.setStartBefore(chip);
  } else {
    // chip 后紧跟的分隔空格一并跳过，插入后仍保持一个空格间隔
    const next = chip.nextSibling;
    if (
      next &&
      next.nodeType === Node.TEXT_NODE &&
      (next.textContent ?? "").startsWith(" ")
    ) {
      range.setStart(next, 1);
    } else {
      range.setStartAfter(chip);
    }
  }
  range.collapse(true);
  return range;
};

/**
 * 解析拖放落点。规则：
 * - 指针在 chip 上：按 chip 中线插到前/后；
 * - 指针在文本行内：插到最近的字符边界（行右侧空白即行尾）；
 * - 其它空白（如内容下方）：插到内容末尾。
 */
export const resolveDropRange = (
  root: HTMLElement,
  x: number,
  y: number,
): Range => {
  const hit = document.elementFromPoint(x, y);
  if (hit && root.contains(hit)) {
    const hitChip = findChip(root, hit);
    if (hitChip) {
      return rangeBesideChip(hitChip, x);
    }
  }
  const raw =
    typeof document.caretRangeFromPoint === "function"
      ? document.caretRangeFromPoint(x, y)
      : null;
  if (raw && root.contains(raw.startContainer)) {
    const chip = findChip(root, raw.startContainer);
    if (chip) {
      return rangeBesideChip(chip, x);
    }
    raw.collapse(true);
    return raw;
  }
  return endRange(root);
};

/** 聚焦编辑区并把选区放到 range；range 已失效时退回内容末尾。 */
export const placeSelectionAt = (
  root: HTMLElement,
  range: Range | null | undefined,
): void => {
  root.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const valid =
    !!range &&
    range.startContainer.isConnected &&
    root.contains(range.startContainer);
  selection.removeAllRanges();
  selection.addRange(valid ? range.cloneRange() : endRange(root));
};

/** 当前选区若在编辑区内则克隆返回（Range 为活对象，会随 DOM 变化自动调整）。 */
export const captureSelectionIn = (root: HTMLElement | null): Range | null => {
  const selection = window.getSelection();
  if (!root || !selection || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  return root.contains(range.startContainer) ? range.cloneRange() : null;
};

/** 拖拽贴近可滚动编辑区上下边缘时自动滚动。 */
export const autoScrollForDrag = (root: HTMLElement, y: number): void => {
  if (root.scrollHeight <= root.clientHeight) {
    return;
  }
  const bounds = root.getBoundingClientRect();
  if (y < bounds.top + AUTO_SCROLL_EDGE) {
    root.scrollTop -= AUTO_SCROLL_STEP;
  } else if (y > bounds.bottom - AUTO_SCROLL_EDGE) {
    root.scrollTop += AUTO_SCROLL_STEP;
  }
};

const boxFromRect = (
  rect: DOMRect | undefined,
  edge: "left" | "right",
): CaretBox | null => {
  if (!rect || rect.height <= 0) {
    return null;
  }
  return {
    x: edge === "left" ? rect.left : rect.right,
    top: rect.top,
    height: rect.height,
  };
};

const measureTextChar = (
  text: Text,
  index: number,
  edge: "left" | "right",
): CaretBox | null => {
  if (index < 0 || index >= text.length || text.data[index] === "\n") {
    return null;
  }
  const probe = document.createRange();
  probe.setStart(text, index);
  probe.setEnd(text, index + 1);
  return boxFromRect(probe.getClientRects()[0], edge);
};

const measureNodeEdge = (
  node: Node | undefined | null,
  side: "start" | "end",
): CaretBox | null => {
  if (!node) {
    return null;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    return side === "start"
      ? measureTextChar(text, 0, "left")
      : measureTextChar(text, text.length - 1, "right");
  }
  if (node.nodeType === Node.ELEMENT_NODE && node.nodeName !== "BR") {
    return boxFromRect(
      (node as Element).getBoundingClientRect(),
      side === "start" ? "left" : "right",
    );
  }
  return null;
};

const measureCaret = (root: HTMLElement, range: Range): CaretBox => {
  const direct = boxFromRect(range.getClientRects()[0], "left");
  if (direct) {
    return direct;
  }
  const { startContainer: container, startOffset: offset } = range;
  let box: CaretBox | null = null;
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container as Text;
    box =
      measureTextChar(text, offset, "left") ??
      measureTextChar(text, offset - 1, "right");
  } else {
    box =
      measureNodeEdge(container.childNodes[offset], "start") ??
      measureNodeEdge(container.childNodes[offset - 1], "end");
  }
  if (box) {
    return box;
  }
  const style = window.getComputedStyle(root);
  const bounds = root.getBoundingClientRect();
  return {
    x: bounds.left + (Number.parseFloat(style.paddingLeft) || 0),
    top:
      bounds.top + (Number.parseFloat(style.paddingTop) || 0) - root.scrollTop,
    height: Number.parseFloat(style.lineHeight) || 20,
  };
};

export type DropCaretIndicator = {
  show: (root: HTMLElement, range: Range) => void;
  hide: () => void;
  dispose: () => void;
};

/** 插入位置指示条：fixed 定位挂在 body 上，裁剪到编辑区可见范围。 */
export const createDropCaretIndicator = (): DropCaretIndicator => {
  let el: HTMLDivElement | null = null;

  const hide = (): void => {
    el?.classList.remove("visible");
  };

  const show = (root: HTMLElement, range: Range): void => {
    const caret = measureCaret(root, range);
    const bounds = root.getBoundingClientRect();
    const top = Math.max(caret.top, bounds.top);
    const bottom = Math.min(caret.top + caret.height, bounds.bottom);
    if (bottom - top < 2) {
      hide();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.className = "chat-drop-caret";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
    }
    el.style.transform = `translate(${Math.round(caret.x)}px, ${Math.round(top)}px)`;
    el.style.height = `${Math.round(bottom - top)}px`;
    el.classList.add("visible");
  };

  const dispose = (): void => {
    el?.remove();
    el = null;
  };

  return { show, hide, dispose };
};
