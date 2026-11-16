/**
 * 图片剪贴板共享工具。
 *
 * 生图工具卡片、绘图工作台图库历史、图库面板共用：把任意图片来源
 * （data URL / img-proxy:// / http(s) / 图库相对路径）写入系统剪贴板，
 * 便于直接粘贴到 QQ、微信等聊天窗口分享。
 *
 * 主进程已有 `clipboard:write-image` 通道（接受 data URL），这里只负责把
 * 各种来源统一解析成 data URL，避免每个组件重复实现。
 */

export type CopyImageSourceOptions = {
  /** 已渲染的图片地址：data URL、img-proxy:// 或 http(s)。 */
  src?: string;
  /**
   * 图库相对路径（如 `image/2026-10-23/hash.png`）。
   * 优先走主进程解析，避免 CSP / 自定义协议在剪贴板链路上失效。
   */
  libraryPath?: string;
};

/**
 * 复制图片到系统剪贴板。
 *
 * @returns 成功返回 true；无可用图片来源时返回 false（不抛错，调用方按需提示）。
 */
export const copyImageToClipboard = async (
  options: CopyImageSourceOptions,
): Promise<boolean> => {
  const { src, libraryPath } = options;

  let dataUrl = "";
  if (libraryPath) {
    dataUrl = (await window.snow.resolveLibraryImage(libraryPath)) ?? "";
  }
  if (!dataUrl && src) {
    // 非 data URL（img-proxy:// / http(s)）交主进程读取，避免渲染进程跨源 fetch 被拦截
    dataUrl = src.startsWith("data:")
      ? src
      : await window.snow.readImageSource(src);
  }
  if (!dataUrl) {
    return false;
  }

  await window.snow.writeImageToClipboard(dataUrl);
  return true;
};
