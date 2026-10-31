import type { Locale } from "../../../shared/locale";

/** Browser-card display text only; protocol errors remain unchanged. */
export const browserToolErrorTranslations: Record<
  Locale,
  Record<string, string>
> = {
  "zh-CN": {
    "toolCall.browser.errors.technicalDetails": "技术详情（已脱敏）",
    "toolCall.browser.errors.unknown":
      "浏览器操作失败，请展开技术详情查看原因。",
    "toolCall.browser.errors.frameStale":
      "页面或框架已更新，请重新获取框架信息。",
    "toolCall.browser.errors.frameRefStale":
      "元素引用已失效，请重新获取所选框架的无障碍快照。",
    "toolCall.browser.errors.emptyField":
      "参数 {{field}} 不能为空；不使用此参数时请将其省略。",
    "toolCall.browser.errors.invalidType":
      "参数 {{field}} 的类型不正确，请检查工具参数要求。",
    "toolCall.browser.errors.requiredField": "缺少必填参数 {{field}}。",
    "toolCall.browser.errors.invalidParameters":
      "浏览器参数无效，请检查参数格式与取值。",
    "toolCall.browser.errors.navigateConflict":
      "url 与 reload=true 不能同时使用，请选择导航或重新加载。",
    "toolCall.browser.errors.coordinateConflict":
      "坐标 x/y 与 selector、text、ref 定位不能同时使用。",
    "toolCall.browser.errors.coordinatesRequired":
      "坐标定位必须同时提供 x 和 y。",
    "toolCall.browser.errors.targetRequired": "请提供工具要求的元素定位参数。",
    "toolCall.browser.errors.waitConflict":
      "等待时长 time 与文本或元素等待条件不能同时使用。",
    "toolCall.browser.errors.waitRequired":
      "请提供等待时长或文本、元素等待条件。",
    "toolCall.browser.errors.documentNotReady":
      "浏览器调试文档尚未初始化，暂时无法读取元素信息。",
    "toolCall.browser.errors.pageToolMissing":
      "页面未注册该工具，请重新获取页面工具列表。",
    "toolCall.browser.errors.handlerUnavailable":
      "浏览器操作处理程序未就绪，请检查浏览器连接。",
    "toolCall.browser.errors.browserMissing":
      "没有可用的内嵌浏览器，请先打开并聚焦浏览器标签页。",
    "toolCall.browser.errors.timedOut":
      "浏览器或框架操作超时，请检查页面状态后重试。",
    "toolCall.browser.errors.debuggerUnavailable":
      "浏览器调试连接不可用，请关闭页面开发者工具后重试。",
    "toolCall.browser.errors.accessDenied":
      "浏览器访问或共享请求被拒绝，请检查权限设置。",
    "toolCall.browser.errors.sharingRequired":
      "此标签页尚未共享给助手，请先请求用户共享。",
    "toolCall.browser.errors.noFrames":
      "录屏未捕获到画面，请确认标签页正在渲染后重试。",
  },
  "zh-TW": {
    "toolCall.browser.errors.technicalDetails": "技術詳情（已遮蔽敏感資料）",
    "toolCall.browser.errors.unknown":
      "瀏覽器操作失敗，請展開技術詳情查看原因。",
    "toolCall.browser.errors.frameStale":
      "頁面或框架已更新，請重新取得框架資訊。",
    "toolCall.browser.errors.frameRefStale":
      "元素參照已失效，請重新取得所選框架的無障礙快照。",
    "toolCall.browser.errors.emptyField":
      "參數 {{field}} 不可為空；不使用此參數時請將其省略。",
    "toolCall.browser.errors.invalidType":
      "參數 {{field}} 的類型不正確，請檢查工具參數要求。",
    "toolCall.browser.errors.requiredField": "缺少必填參數 {{field}}。",
    "toolCall.browser.errors.invalidParameters":
      "瀏覽器參數無效，請檢查參數格式與數值。",
    "toolCall.browser.errors.navigateConflict":
      "url 與 reload=true 不可同時使用，請選擇導覽或重新載入。",
    "toolCall.browser.errors.coordinateConflict":
      "座標 x/y 與 selector、text、ref 定位不可同時使用。",
    "toolCall.browser.errors.coordinatesRequired":
      "座標定位必須同時提供 x 和 y。",
    "toolCall.browser.errors.targetRequired": "請提供工具要求的元素定位參數。",
    "toolCall.browser.errors.waitConflict":
      "等待時間 time 與文字或元素等待條件不可同時使用。",
    "toolCall.browser.errors.waitRequired":
      "請提供等待時間或文字、元素等待條件。",
    "toolCall.browser.errors.documentNotReady":
      "瀏覽器偵錯文件尚未初始化，暫時無法讀取元素資訊。",
    "toolCall.browser.errors.pageToolMissing":
      "頁面尚未註冊此工具，請重新取得頁面工具清單。",
    "toolCall.browser.errors.handlerUnavailable":
      "瀏覽器操作處理程式尚未就緒，請檢查瀏覽器連線。",
    "toolCall.browser.errors.browserMissing":
      "沒有可用的內嵌瀏覽器，請先開啟並聚焦瀏覽器分頁。",
    "toolCall.browser.errors.timedOut":
      "瀏覽器或框架操作逾時，請檢查頁面狀態後重試。",
    "toolCall.browser.errors.debuggerUnavailable":
      "瀏覽器偵錯連線無法使用，請關閉頁面開發者工具後重試。",
    "toolCall.browser.errors.accessDenied":
      "瀏覽器存取或共用請求遭拒，請檢查權限設定。",
    "toolCall.browser.errors.sharingRequired":
      "此分頁尚未共用給助理，請先請求使用者共用。",
    "toolCall.browser.errors.noFrames":
      "錄影未擷取到畫面，請確認分頁正在繪製後重試。",
  },
  en: {
    "toolCall.browser.errors.technicalDetails": "Technical details (redacted)",
    "toolCall.browser.errors.unknown":
      "The browser operation failed. Expand technical details to inspect the cause.",
    "toolCall.browser.errors.frameStale":
      "The page or frame has changed. Enumerate frames again.",
    "toolCall.browser.errors.frameRefStale":
      "The element reference has expired. Capture a new accessibility snapshot of the selected frame.",
    "toolCall.browser.errors.emptyField":
      "Parameter {{field}} must not be empty. Omit it when it is not used.",
    "toolCall.browser.errors.invalidType":
      "Parameter {{field}} has an incorrect type. Check the tool's parameter requirements.",
    "toolCall.browser.errors.requiredField":
      "Required parameter {{field}} is missing.",
    "toolCall.browser.errors.invalidParameters":
      "Browser parameters are invalid. Check their format and values.",
    "toolCall.browser.errors.navigateConflict":
      "url and reload=true cannot be used together. Choose navigation or reload.",
    "toolCall.browser.errors.coordinateConflict":
      "Coordinates x/y cannot be combined with selector, text, or ref targeting.",
    "toolCall.browser.errors.coordinatesRequired":
      "Coordinate targeting requires both x and y.",
    "toolCall.browser.errors.targetRequired":
      "Provide the element-targeting parameters required by this tool.",
    "toolCall.browser.errors.waitConflict":
      "Wait duration time cannot be combined with text or element conditions.",
    "toolCall.browser.errors.waitRequired":
      "Provide a wait duration or a text or element condition.",
    "toolCall.browser.errors.documentNotReady":
      "The browser debugging document is not initialized. Element information is temporarily unavailable.",
    "toolCall.browser.errors.pageToolMissing":
      "The page has not registered this tool. List page tools again.",
    "toolCall.browser.errors.handlerUnavailable":
      "The browser operation handler is not ready. Check the browser connection.",
    "toolCall.browser.errors.browserMissing":
      "No embedded browser is available. Open and focus a browser tab first.",
    "toolCall.browser.errors.timedOut":
      "The browser or frame operation timed out. Check the page state before retrying.",
    "toolCall.browser.errors.debuggerUnavailable":
      "The browser debugger is unavailable. Close the page DevTools and retry.",
    "toolCall.browser.errors.accessDenied":
      "Browser access or sharing was denied. Check permission settings.",
    "toolCall.browser.errors.sharingRequired":
      "This tab is not shared with the agent. Ask the user to share it first.",
    "toolCall.browser.errors.noFrames":
      "The recording captured no frames. Make sure the tab is rendering before retrying.",
  },
};
