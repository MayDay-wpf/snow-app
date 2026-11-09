/**
 * 主进程原生 UI（托盘、webview 右键菜单、宠物菜单、下载对话框/通知）的最小文案字典。
 *
 * 为什么单独维护：这些菜单由 Electron 主进程直接构建，拿不到渲染层的
 * React i18n 上下文。语言取自 system_settings 的 `language` 键（与桌面
 * Renderer 写入的是同一份设置）：启动时读一次，之后由
 * `settings:set-system-setting` 处理器在语言变更时刷新。
 *
 * 约定：新增文案三种语言都要给；查不到时回退 DEFAULT_LOCALE（en），再回退
 * key 本身，便于排查缺失。
 */
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type Locale,
} from "../../shared/locale";
import { native } from "../native/nativeBridge";

/** 与渲染层 I18nProvider 写入的语言设置键一致。 */
export const MAIN_LANGUAGE_SETTING_CODE = "language";

type MainMessages = Record<string, string>;
type MainMessageValues = Record<string, string | number>;

const en: MainMessages = {
  "tray.openApp": "Open Snow App",
  "tray.quit": "Quit",
  "explorerMenu.openInSnowApp": "Open in Snow App",
  "explorerMenu.openInSnowAppPreview": "Open in Snow App (Preview)",
  "contextMenu.cut": "Cut",
  "contextMenu.copy": "Copy",
  "contextMenu.paste": "Paste",
  "contextMenu.copyLinkAddress": "Copy link address",
  "contextMenu.copyImageAddress": "Copy image address",
  "contextMenu.back": "Back",
  "contextMenu.forward": "Forward",
  "contextMenu.reload": "Reload",
  "contextMenu.selectAll": "Select all",
  "contextMenu.inspectElement": "Inspect element",
  "contextMenu.scriptCommands": "Script commands",
  "pet.settings": "Pet settings",
  "pet.close": "Close pet",
  "pet.chat.placeholder": "Say something to your pet…",
  "pet.chat.send": "Send",
  "pet.chat.stop": "Stop",
  "pet.chat.newChat": "New chat",
  "pet.chat.close": "Back to pet",
  "pet.chat.thinking": "Thinking…",
  "pet.chat.error": "Something went wrong. Please try again.",
  "pet.chat.hintContext": "Chatting about your open session",
  "pet.chat.hintFree": "No session open — just chat",
  "pet.chat.hintTitle": "About",
  "pet.chat.toolRunning": "Working on it…",
  "tray.tooltip.activeSessions": "Active sessions: {{count}}",
  "tray.tooltip.activeTerminals": "Active terminals: {{count}}",
  "tray.tooltip.projects": "Projects: {{count}}",
  "tray.tooltip.pendingMemos": "Pending memos: {{count}}",
  "tray.tooltip.todayTokens": "Today's usage: {{value}}",
  "download.saveDialogTitle": "Save file",
  "download.completed": "Download complete",
  "download.failed": "Download failed",
  "sshTransfer.downloadSaveTitle": "Choose where to save",
  "sshTransfer.downloadDirTitle": "Choose a destination folder",
  "sshTransfer.saveButton": "Save",
  "sshTransfer.chooseButton": "Select",
  "sshTransfer.continueButton": "Continue",
  "sshTransfer.cancelButton": "Cancel",
  "sshTransfer.noTransferableFiles":
    "No transferable files were selected. Only regular files are supported.",
  "sshTransfer.partialTitle": "Some items cannot be transferred",
  "sshTransfer.partialMessage":
    "{{count}} file(s) will continue; {{skipped}} item(s) will be skipped (only regular files are supported).",
};

const zhCN: MainMessages = {
  "tray.openApp": "打开 Snow App",
  "tray.quit": "退出",
  "explorerMenu.openInSnowApp": "在 Snow App 中打开",
  "explorerMenu.openInSnowAppPreview": "在 Snow App 中打开（预览）",
  "contextMenu.cut": "剪切",
  "contextMenu.copy": "复制",
  "contextMenu.paste": "粘贴",
  "contextMenu.copyLinkAddress": "复制链接地址",
  "contextMenu.copyImageAddress": "复制图片地址",
  "contextMenu.back": "后退",
  "contextMenu.forward": "前进",
  "contextMenu.reload": "刷新",
  "contextMenu.selectAll": "全选",
  "contextMenu.inspectElement": "检查元素",
  "contextMenu.scriptCommands": "脚本命令",
  "pet.settings": "宠物设置",
  "pet.close": "关闭宠物",
  "pet.chat.placeholder": "和宠物说点什么…",
  "pet.chat.send": "发送",
  "pet.chat.stop": "停止",
  "pet.chat.newChat": "新建对话",
  "pet.chat.close": "变回宠物",
  "pet.chat.thinking": "正在思考…",
  "pet.chat.error": "出了点问题，请再试一次。",
  "pet.chat.hintContext": "正在围绕你打开的会话聊天",
  "pet.chat.hintFree": "没有打开的会话，随便聊聊",
  "pet.chat.hintTitle": "关于",
  "pet.chat.toolRunning": "正在处理…",
  "tray.tooltip.activeSessions": "会话进行中 {{count}}",
  "tray.tooltip.activeTerminals": "活跃终端 {{count}}",
  "tray.tooltip.projects": "项目 {{count}}",
  "tray.tooltip.pendingMemos": "待办备忘录 {{count}}",
  "tray.tooltip.todayTokens": "今日用量 {{value}}",
  "download.saveDialogTitle": "保存文件",
  "download.completed": "下载完成",
  "download.failed": "下载失败",
  "sshTransfer.downloadSaveTitle": "选择保存位置",
  "sshTransfer.downloadDirTitle": "选择保存文件夹",
  "sshTransfer.saveButton": "保存",
  "sshTransfer.chooseButton": "选择",
  "sshTransfer.continueButton": "继续",
  "sshTransfer.cancelButton": "取消",
  "sshTransfer.noTransferableFiles": "没有可传输的文件。仅支持普通文件。",
  "sshTransfer.partialTitle": "部分项目无法传输",
  "sshTransfer.partialMessage":
    "将传输 {{count}} 个文件，跳过 {{skipped}} 项（仅支持普通文件）。",
};

const zhTW: MainMessages = {
  "tray.openApp": "開啟 Snow App",
  "tray.quit": "結束",
  "explorerMenu.openInSnowApp": "在 Snow App 中開啟",
  "explorerMenu.openInSnowAppPreview": "在 Snow App 中開啟（預覽）",
  "contextMenu.cut": "剪下",
  "contextMenu.copy": "複製",
  "contextMenu.paste": "貼上",
  "contextMenu.copyLinkAddress": "複製連結網址",
  "contextMenu.copyImageAddress": "複製圖片網址",
  "contextMenu.back": "上一頁",
  "contextMenu.forward": "下一頁",
  "contextMenu.reload": "重新載入",
  "contextMenu.selectAll": "全選",
  "contextMenu.inspectElement": "檢查元素",
  "contextMenu.scriptCommands": "指令碼命令",
  "pet.settings": "寵物設定",
  "pet.close": "關閉寵物",
  "pet.chat.placeholder": "和寵物說點什麼…",
  "pet.chat.send": "傳送",
  "pet.chat.stop": "停止",
  "pet.chat.newChat": "新增對話",
  "pet.chat.close": "變回寵物",
  "pet.chat.thinking": "正在思考…",
  "pet.chat.error": "出了點問題，請再試一次。",
  "pet.chat.hintContext": "正在圍繞你開啟的會話聊天",
  "pet.chat.hintFree": "沒有開啟的會話，隨意聊聊",
  "pet.chat.hintTitle": "關於",
  "pet.chat.toolRunning": "正在處理…",
  "tray.tooltip.activeSessions": "會話進行中 {{count}}",
  "tray.tooltip.activeTerminals": "活躍終端 {{count}}",
  "tray.tooltip.projects": "專案 {{count}}",
  "tray.tooltip.pendingMemos": "待辦備忘錄 {{count}}",
  "tray.tooltip.todayTokens": "今日用量 {{value}}",
  "download.saveDialogTitle": "儲存檔案",
  "download.completed": "下載完成",
  "download.failed": "下載失敗",
  "sshTransfer.downloadSaveTitle": "選擇儲存位置",
  "sshTransfer.downloadDirTitle": "選擇儲存資料夾",
  "sshTransfer.saveButton": "儲存",
  "sshTransfer.chooseButton": "選擇",
  "sshTransfer.continueButton": "繼續",
  "sshTransfer.cancelButton": "取消",
  "sshTransfer.noTransferableFiles": "沒有可傳輸的檔案。僅支援一般檔案。",
  "sshTransfer.partialTitle": "部分項目無法傳輸",
  "sshTransfer.partialMessage":
    "將傳輸 {{count}} 個檔案，略過 {{skipped}} 項（僅支援一般檔案）。",
};

const dictionaries: Record<Locale, MainMessages> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

let activeLocale: Locale = DEFAULT_LOCALE;

const listeners = new Set<() => void>();

const interpolate = (template: string, values?: MainMessageValues): string => {
  if (!values) {
    return template;
  }

  return template.replace(/{{\s*(\w+)\s*}}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
};

/** 当前主进程文案语言（默认 en，读取成功后为用户的桌面语言）。 */
export const getMainLocale = (): Locale => activeLocale;

/** 语言真正变化时通知订阅者（用于重建常驻菜单，如托盘菜单）。 */
export const onMainLocaleChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const setMainLocale = (locale: Locale): void => {
  if (locale === activeLocale) {
    return;
  }
  activeLocale = locale;
  for (const listener of listeners) {
    listener();
  }
};

/**
 * 从 system_settings 读取桌面语言并刷新缓存。
 *
 * 读取失败（存储未就绪 / DB 异常）时保持当前语言，不抛错——原生菜单
 * 不能因为语言读取失败而无法弹出。
 */
export const refreshMainLocale = async (): Promise<Locale> => {
  try {
    const raw = await native.getSystemSettingValue(MAIN_LANGUAGE_SETTING_CODE);
    setMainLocale(normalizeLocale(raw) ?? DEFAULT_LOCALE);
  } catch {
    // 保持当前语言
  }
  return activeLocale;
};

/** 取主进程文案；缺失时回退 en，再回退 key。 */
export const tMain = (key: string, values?: MainMessageValues): string => {
  const template =
    dictionaries[activeLocale][key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
  return interpolate(template, values);
};
