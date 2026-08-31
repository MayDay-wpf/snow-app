import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import { openBrowserDevTools } from "../ipc/handlers/windowHandlers";
import {
  getUserscriptMenuCommands,
  invokeUserscriptMenuCommand,
} from "../ipc/handlers/userscriptHandlers";

let installed = false;

/**
 * 为嵌入式浏览器（<webview> guest 页面）安装右键菜单。
 *
 * 背景：Electron 的 <webview> 标签默认没有右键菜单（不像 Chrome 内置
 * 浏览器菜单），必须监听 guest webContents 的 `context-menu` 事件并手动
 * 用 Menu.popup 弹出，否则浏览器里右键没有任何反应。
 *
 * 菜单项按上下文动态生成：
 *   - 可编辑区域：剪切 / 复制 / 粘贴（依据 editFlags）
 *   - 链接上：复制链接地址
 *   - 图片上：复制图片地址
 *   - 导航：后退 / 前进 / 刷新（按历史记录启用/禁用）
 *   - 全选、检查元素（DevTools）
 */
export const installWebviewContextMenu = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") {
      return;
    }

    contents.on("context-menu", (_event, params) => {
      const inspectBrowserElement = (): void => {
        if (contents.isDestroyed()) {
          return;
        }

        if (contents.isDevToolsOpened()) {
          contents.inspectElement(params.x, params.y);
          return;
        }

        // inspectElement() 会在 DevTools 未打开时创建 Electron 默认窗口；必须先让
        // 自定义窗口完成打开，再定位到右键目标元素。
        contents.once("devtools-opened", () => {
          if (!contents.isDestroyed()) {
            contents.inspectElement(params.x, params.y);
          }
        });
        openBrowserDevTools(contents);
      };

      const template: MenuItemConstructorOptions[] = [];

      // 编辑组：仅当目标可编辑/有选区时显示。
      // 注意：不能用 role: "cut"/"copy"/"paste" —— role 命令作用于聚焦的
      // BrowserWindow（宿主主窗口）而不是 webview guest，会导致编辑操作
      // 泄露到宿主页面；必须显式调用 contents 的实例方法。
      const editItems: MenuItemConstructorOptions[] = [];
      if (params.editFlags.canCut) {
        editItems.push({ label: "剪切", click: () => contents.cut() });
      }
      if (params.editFlags.canCopy) {
        editItems.push({ label: "复制", click: () => contents.copy() });
      }
      if (params.editFlags.canPaste) {
        editItems.push({ label: "粘贴", click: () => contents.paste() });
      }
      if (editItems.length > 0) {
        template.push(...editItems, { type: "separator" });
      }

      // 链接：复制地址。
      if (params.linkURL) {
        template.push({
          label: "复制链接地址",
          click: () => clipboard.writeText(params.linkURL),
        });
        template.push({ type: "separator" });
      }

      // 图片：复制地址。
      if (params.srcURL && params.mediaType === "image") {
        template.push({
          label: "复制图片地址",
          click: () => clipboard.writeText(params.srcURL),
        });
        template.push({ type: "separator" });
      }

      // 导航组。
      template.push(
        {
          label: "后退",
          enabled: contents.navigationHistory.canGoBack(),
          click: () => contents.navigationHistory.goBack(),
        },
        {
          label: "前进",
          enabled: contents.navigationHistory.canGoForward(),
          click: () => contents.navigationHistory.goForward(),
        },
        // 不能用 role: "reload"！role 命令刷新的是聚焦的 BrowserWindow
        // （即宿主主窗口），会把整个 Snow App 界面重新加载；必须显式
        // 调用 guest webContents 的 reload() 让刷新只作用于浏览器区域。
        { label: "刷新", click: () => contents.reload() },
        { type: "separator" },
        // 同理，role: "selectAll" 会作用于宿主页面，改为显式调用。
        { label: "全选", click: () => contents.selectAll() },
        { type: "separator" },
        {
          label: "检查元素",
          click: inspectBrowserElement,
        },
      );

      // 用户脚本菜单命令（GM_registerMenuCommand 注册）。
      const scriptCommands = getUserscriptMenuCommands(contents.id);
      if (scriptCommands.length > 0) {
        template.push(
          { type: "separator" },
          {
            label: "脚本命令",
            submenu: scriptCommands.map((command) => ({
              label: command.title,
              click: () => invokeUserscriptMenuCommand(contents, command.id),
            })),
          },
        );
      }

      // popup 挂到宿主窗口（webview guest 的 hostWebContents 对应主窗口）。
      const hostWindow = contents.hostWebContents
        ? BrowserWindow.fromWebContents(contents.hostWebContents)
        : undefined;
      Menu.buildFromTemplate(template).popup({
        window: hostWindow ?? undefined,
      });
    });
  });
};
