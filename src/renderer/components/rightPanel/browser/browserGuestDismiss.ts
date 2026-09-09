/**
 * guest 内的点击不会冒泡到宿主文档，宿主侧「点击外部关闭」的下拉/浮层
 * 在点击网页区域时不收起。guest preload 经 sendToHost 上报 mousedown，
 * 这里在宿主文档合成 pointerdown/mousedown（target 为 document.body），
 * 复用各浮层既有的外部点击关闭逻辑。
 */

/** 通道名与 preload/webviewBrowserPreload.ts 保持一致 */
const GUEST_POINTERDOWN_CHANNEL = "snow:guest-pointerdown";

/**
 * 合成外部指针按下事件。派发到 document.body：只触发 document/window 上的
 * 原生监听（React 根节点 #root 是 body 的子节点，不在事件路径上，不会误
 * 触发组件事件）。
 */
const dispatchHostOutsidePointerDown = (): void => {
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
  };
  document.body.dispatchEvent(new PointerEvent("pointerdown", init));
  document.body.dispatchEvent(new MouseEvent("mousedown", init));
};

/** 绑定 guest 点击上报（监听器随 webview 元素销毁自动解绑）。 */
export const attachGuestPointerDismiss = (
  webview: Electron.WebviewTag,
): void => {
  webview.addEventListener("ipc-message", (event) => {
    if (event.channel === GUEST_POINTERDOWN_CHANNEL) {
      dispatchHostOutsidePointerDown();
    }
  });
};
