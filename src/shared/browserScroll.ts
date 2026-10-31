import { COLLECT_ROOTS_SCRIPT } from "./browserElementLocator";

/**
 * 页面上下文的滚动函数（issue #252）：(start, deltaY, position) => 回执。
 * start 自身不可滚动时沿父节点（穿透 shadow host）找最近的可滚动祖先；未指定
 * start 时滚动文档，文档不可滚动则选视口内可见面积最大的可滚动容器。滚动采用
 * 程序化 scrollBy/scrollTo（可作用于内部容器），返回前后位置供核验是否移动。
 */
export const SCROLL_FUNCTION = `async (start, deltaY, position) => {
  const scrollingRoot = document.scrollingElement || document.documentElement;
  const canScroll = (element) => {
    if (element.scrollHeight <= element.clientHeight) return false;
    if (element === scrollingRoot) return true;
    return /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY);
  };
  let container = null;
  let auto = false;
  if (start) {
    let node = start;
    while (node) {
      if (canScroll(node)) {
        container = node;
        break;
      }
      const root = node.getRootNode();
      node = node.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }
  } else if (canScroll(scrollingRoot)) {
    container = scrollingRoot;
  } else {
    ${COLLECT_ROOTS_SCRIPT}
    let bestArea = 0;
    for (const root of roots) {
      for (const element of root.querySelectorAll('*')) {
        if (!canScroll(element)) continue;
        const rect = element.getBoundingClientRect();
        const width = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
        const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
        const area = Math.max(0, width) * Math.max(0, height);
        if (area > bestArea) {
          bestArea = area;
          container = element;
        }
      }
    }
    auto = container !== null;
  }
  if (!container) container = scrollingRoot;
  const read = () => ({
    scrollTop: Math.round(container.scrollTop),
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  });
  const before = read();
  if (position === 'top') {
    container.scrollTo({ top: 0, behavior: 'instant' });
  } else if (position === 'bottom') {
    container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
  } else {
    container.scrollBy({ top: deltaY, behavior: 'instant' });
  }
  await new Promise((resolve) => {
    // 等两帧让滚动生效并触发懒加载监听；后台 webview 可能不调度动画帧。
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    }));
  });
  const after = read();
  const className = container !== scrollingRoot && typeof container.className === 'string'
    ? container.className.trim().slice(0, 80)
    : '';
  return {
    moved: after.scrollTop !== before.scrollTop,
    before,
    after,
    atTop: after.scrollTop <= 0,
    atBottom: after.scrollTop >= after.scrollHeight - after.clientHeight - 1,
    container: {
      tagName: container === scrollingRoot ? 'document' : container.tagName.toLowerCase(),
      id: container === scrollingRoot ? null : container.id || null,
      className: className || null,
      auto,
    },
  };
}`;
