/**
 * 会话记录显示方案（与桌面「设置 → 主题 → 会话记录」同一套语义）：
 * - classic：完整工具卡（移动端默认）
 * - chips：工具压成紧凑的胶囊行
 * - minimal：隐藏思考，工具合并为一个集合
 *
 * 选择保存在手机浏览器 localStorage（键与桌面 Renderer 相同），根节点的
 * data-tool-card-style 供样式层使用；时间线按方案渲染不同的工具分组结构。
 */
export type TranscriptStyle = "classic" | "chips" | "minimal";

const STORAGE_KEY = "snow:tool-card-style";
const ROOT_ATTRIBUTE = "data-tool-card-style";

const isTranscriptStyle = (value: unknown): value is TranscriptStyle =>
  value === "classic" || value === "chips" || value === "minimal";

let currentStyle: TranscriptStyle | null = null;

/** 当前方案：首次读取 localStorage，之后以内存值为准。 */
export const getTranscriptStyle = (): TranscriptStyle => {
  if (currentStyle === null) {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // 隐私模式下 storage 不可用：保持默认方案。
    }
    currentStyle = isTranscriptStyle(stored) ? stored : "classic";
  }
  return currentStyle;
};

const applyStyle = (style: TranscriptStyle): void => {
  document.documentElement.setAttribute(ROOT_ATTRIBUTE, style);
};

/** 切换方案并持久化；时间线重建由调用方（设置页）负责。 */
export const setTranscriptStyle = (style: TranscriptStyle): void => {
  if (currentStyle === style) return;
  currentStyle = style;
  try {
    window.localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // 存储不可用时仅在本次会话生效。
  }
  applyStyle(style);
};

/** 首屏同步应用上次选择，避免恢复会话时样式跳变。 */
export const initTranscriptStyle = (): void => {
  applyStyle(getTranscriptStyle());
};
