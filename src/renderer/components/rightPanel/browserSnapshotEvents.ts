/**
 * 浏览器标签页网页快照（F4）的跨组件事件通道。
 *
 * 请求-响应模式：聊天输入框（ChatInputView）拖入浏览器 tab 后派发
 * WEB_SNAPSHOT_REQUEST_EVENT，浏览器面板（BrowserPanelContent）监听后
 * 定位对应实例的 webview 完成三层提取（整页正文 / 元素区域 / 可视区
 * 截图），再派发 WEB_SNAPSHOT_RESULT_EVENT 回发。requestId 由输入框侧
 * 生成，按递增计数保证多浏览器 tab 并发不错串。
 */

/** 输入框 → 浏览器面板：请求对某个浏览器 tab 生成三层网页快照 */
export const WEB_SNAPSHOT_REQUEST_EVENT = "snow:web-snapshot-request";

/** 浏览器面板 → 输入框：返回快照结果（按 requestId 匹配） */
export const WEB_SNAPSHOT_RESULT_EVENT = "snow:web-snapshot-result";

/** 输入框侧等待快照结果的全链路超时（毫秒），超时则放弃并保持纯 URL 引用 */
export const WEB_SNAPSHOT_TIMEOUT_MS = 5000;

/** 快照请求（输入框 → 浏览器） */
export type WebSnapshotRequest = {
  requestId: number;
  instanceId: string;
  /** 拖拽时记录的 URL，浏览器侧兜底校验实时 URL 仍一致 */
  url: string;
};

/** 快照结果（浏览器 → 输入框）；snapshot 缺省 = 抓取失败，降级纯 URL 引用 */
export type WebSnapshotResult = {
  requestId: number;
  snapshot?: WebPageSnapshot;
};

/** 三层网页快照数据 */
export type WebPageSnapshot = {
  /** 清洗后的整页正文（≤8000 字符） */
  text: string;
  /** 元素选择器文本摘要（若存在 picked 且属于该标签页） */
  elementText?: string;
  /** 元素选择器（供 AI 复现定位） */
  elementSelector?: string;
  /** 可视区截图 dataURL（若截取成功且尺寸合理） */
  screenshotDataUrl?: string;
};

let snapshotRequestId = 0;

/** 生成单调递增的快照请求 id（模块级计数，跨组件 / 多实例唯一）。 */
export const nextSnapshotRequestId = (): number => {
  snapshotRequestId += 1;
  return snapshotRequestId;
};
