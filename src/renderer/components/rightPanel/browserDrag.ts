import type { DragEvent } from "react";

/**
 * 浏览器标签页拖拽到聊天输入框的共享工具。
 *
 * 浏览器标签页即右侧面板的 browser tab（每个 tab 对应一个浏览器实例 /
 * 一个 webview），拖拽时写入 web-tag 协议，聊天输入框
 * （ChatInputView.handleDrop）解析后插入网页引用 chip。
 */

/** web-tag 拖拽数据的 type 标识（与 ChatInputView.handleDrop 的解析约定一致） */
export const WEB_TAG_DRAG_TYPE = "web-tag";

export type WebTagDragPayload = {
  type: typeof WEB_TAG_DRAG_TYPE;
  url: string;
  title?: string;
  /** 浏览器实例 id（可选）：携带后输入框可向该实例的 webview 请求三层网页快照 */
  instanceId?: string;
};

/** setWebTagDragData 的可选扩展参数（F4 网页快照的定位信息）。 */
export type WebTagDragExtra = {
  instanceId?: string;
};

/**
 * 将浏览器标签页引用写入拖拽数据（web-tag 协议）。
 * @param event dragstart 事件
 * @param url   标签页当前 URL（实时值，如 addressInput || src）
 * @param title 页面标题（可为空串，chip 将回退显示域名）
 * @param extra 可选：浏览器实例 id（F4 快照请求的定位信息）
 * @returns 是否成功写入；url 为空时返回 false，调用方应 preventDefault 取消拖拽
 */
export const setWebTagDragData = (
  event: DragEvent<HTMLElement>,
  url: string,
  title: string,
  extra?: WebTagDragExtra,
): boolean => {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    return false;
  }
  const payload: WebTagDragPayload = {
    type: WEB_TAG_DRAG_TYPE,
    url: trimmedUrl,
    title: title.trim() || undefined,
    ...(extra?.instanceId ? { instanceId: extra.instanceId } : {}),
  };
  event.dataTransfer.setData("application/json", JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "copy";
  return true;
};
