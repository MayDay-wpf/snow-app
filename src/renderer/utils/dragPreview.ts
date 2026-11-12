// 全局拖拽预览：把应用内拖拽的半透明预览挪到指针右下方，避免遮挡落点光标与文字。

const OFFSET_X = 16;
const OFFSET_Y = 20;
const MAX_NODES = 300;

type StyledElement = HTMLElement | SVGElement;

/** 克隆并内联计算样式，脱离原祖先选择器后外观保持一致。 */
const cloneWithStyles = (source: Element): StyledElement | null => {
  const clone = source.cloneNode(true) as Element;
  const sources = [source, ...Array.from(source.querySelectorAll("*"))];
  const targets = [clone, ...Array.from(clone.querySelectorAll("*"))];
  if (sources.length > MAX_NODES || sources.length !== targets.length) {
    return null;
  }
  sources.forEach((node, index) => {
    const target = targets[index] as StyledElement;
    if (!target.style) {
      return;
    }
    const computed = window.getComputedStyle(node);
    for (let i = 0; i < computed.length; i++) {
      const prop = computed[i];
      target.style.setProperty(prop, computed.getPropertyValue(prop));
    }
  });
  const root = clone as StyledElement;
  const rect = source.getBoundingClientRect();
  root.style.position = "static";
  root.style.margin = "0";
  root.style.transform = "none";
  root.style.transition = "none";
  root.style.animation = "none";
  if (root.style.display === "inline") {
    root.style.display = "inline-block";
  }
  root.style.width = `${rect.width}px`;
  root.style.height = `${rect.height}px`;
  return root;
};

const handleDragStart = (event: DragEvent): void => {
  const dataTransfer = event.dataTransfer;
  const target = event.target;
  if (!dataTransfer || !(target instanceof Element)) {
    return;
  }
  // 只接管显式 draggable 的应用内拖拽，文本选区/链接/图片保持原生行为
  const source = target.closest("[draggable='true']");
  if (!source || source.closest("[contenteditable='true']")) {
    return;
  }
  const clone = cloneWithStyles(source);
  if (!clone) {
    return;
  }
  // 透明内边距把内容推到指针右下方，偏移点取左上角，避免依赖负偏移的平台差异
  const wrapper = document.createElement("div");
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.style.cssText = `position:fixed;left:-10000px;top:0;padding:${OFFSET_Y}px 0 0 ${OFFSET_X}px;background:transparent;pointer-events:none;`;
  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);
  dataTransfer.setDragImage(wrapper, 0, 0);
  // 预览在 dragstart 分发后同步截取，下一轮即可移除
  window.setTimeout(() => wrapper.remove(), 0);
};

let installed = false;

/** 捕获阶段先设默认预览；拖拽源自行调用 setDragImage 时以其为准。 */
export const installDragPreviewOffset = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  window.addEventListener("dragstart", handleDragStart, true);
};
