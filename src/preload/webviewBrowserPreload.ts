import { contextBridge, ipcRenderer } from "electron";
import { injectUserscripts } from "./userscriptEngine";

/**
 * 内置浏览器 webview 的密码助手 preload。
 *
 * 运行在 guest 页面上下文中（`<webview webpreferences="sandbox=no">`），
 * 提供两项能力：
 *
 * 1. 自动填充：页面出现密码输入框且为空时，向主进程查询当前 origin
 *    已保存的凭据并填入（主进程侧带 senderFrame origin 校验，恶意站点
 *    无法借此跨源读取）。
 * 2. 自动保存：监听表单 submit 与提交按钮点击，捕获用户名/密码并写入
 *    密码保险库（AES-256-GCM 加密落盘）。同一次会话中相同凭据只保存
 *    一次，避免登录失败反复覆盖；凭据变化（如修改密码）会再次保存。
 *
 * 同时通过 contextBridge 暴露 `window.snowPasswordBridge`，页面脚本可
 * 以手动触发查找/保存。
 */

const getOrigin = (): string => {
  try {
    return window.location.origin;
  } catch {
    return "";
  }
};

const isHttpOrigin = (origin: string): boolean =>
  origin.startsWith("http://") || origin.startsWith("https://");

const isVisible = (input: HTMLInputElement): boolean =>
  input.offsetParent !== null;

const findPasswordInput = (): HTMLInputElement | null => {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>("input[type=password]"),
  ).filter((input) => input.ownerDocument === document);
  return inputs.find(isVisible) ?? inputs[0] ?? null;
};

const findUsernameInput = (
  passwordInput: HTMLInputElement,
): HTMLInputElement | null => {
  const form = passwordInput.form;
  const candidates = form
    ? Array.from(form.querySelectorAll<HTMLInputElement>("input"))
    : Array.from(document.querySelectorAll<HTMLInputElement>("input"));
  const textInputs = candidates.filter(
    (input) =>
      input.ownerDocument === document &&
      input !== passwordInput &&
      input.type !== "password" &&
      input.type !== "hidden" &&
      input.type !== "submit" &&
      input.type !== "button" &&
      input.type !== "checkbox" &&
      input.type !== "radio" &&
      !input.disabled &&
      !input.readOnly &&
      isVisible(input),
  );
  // 优先 name/id/autocomplete 含 user/email/login/account 语义的输入框。
  const named = textInputs.find((input) =>
    /(user|email|login|account)/i.test(
      `${input.name} ${input.id} ${input.autocomplete || ""}`,
    ),
  );
  return named ?? textInputs[0] ?? null;
};

const tryAutofill = async (): Promise<void> => {
  const origin = getOrigin();
  if (!isHttpOrigin(origin)) {
    return;
  }
  const passwordInput = findPasswordInput();
  if (
    !passwordInput ||
    passwordInput.value ||
    passwordInput.dataset.snowFilled === "1"
  ) {
    return;
  }
  let credentials: { username: string; password: string } | null = null;
  try {
    credentials = (await ipcRenderer.invoke("browser-passwords:find", {
      origin,
    })) as { username: string; password: string } | null;
  } catch {
    return;
  }
  if (!credentials || !credentials.password) {
    return;
  }
  const usernameInput = findUsernameInput(passwordInput);
  if (usernameInput && !usernameInput.value) {
    usernameInput.value = credentials.username;
    usernameInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  passwordInput.value = credentials.password;
  passwordInput.dataset.snowFilled = "1";
  passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
  passwordInput.dispatchEvent(new Event("change", { bubbles: true }));
};

/** 已提交过的凭据（origin + username + password），避免重复写入。 */
let lastSubmitted = "";

const trySave = async (passwordInput: HTMLInputElement): Promise<void> => {
  const origin = getOrigin();
  if (!isHttpOrigin(origin) || passwordInput.ownerDocument !== document) {
    return;
  }
  const password = passwordInput.value;
  if (!password) {
    return;
  }
  const usernameInput = findUsernameInput(passwordInput);
  const username = usernameInput?.value ?? "";
  const fingerprint = `${origin}\u0000${username}\u0000${password}`;
  if (fingerprint === lastSubmitted) {
    return;
  }
  lastSubmitted = fingerprint;
  try {
    await ipcRenderer.invoke("browser-passwords:save", {
      origin,
      username,
      password,
    });
  } catch {
    // 保存失败（origin 校验拒绝/保险库不可用）静默忽略，不影响浏览。
  }
};

// ---------------------------------------------------------------------------
// target="_blank" 链接拦截：在侧边浏览器内以新标签页打开。
//
// Electron webview guest 存在长期未修复的 bug（electron#30886）：页面内
// 点击 target="_blank" 链接既不触发 setWindowOpenHandler 也不创建窗口
// （表现为点击无效），而 JS window.open() 调用可正常触发 handler。
// 因此在 guest 侧以捕获阶段拦截链接激活（早于页面自身点击逻辑），改经
// 主进程中继（browserPopupWindow 校验后转发宿主窗口），复用现有
// browser:open-tab 链路在侧边浏览器内新建标签页：
//   - 左键点击 <a target="_blank">（含 <base target> 生效场景）→ 前台标签页
//   - 中键 / Ctrl(⌘)+点击 任意链接 → 后台标签页（对齐 Chrome 语义）
// 其余导航（普通链接、JS window.open 的 OAuth 弹窗等）不经此路径，
// 维持主进程 setWindowOpenHandler 原有分流。
// ---------------------------------------------------------------------------

const GUEST_OPEN_TAB_CHANNEL = "browser:guest-open-tab";

const isHttpLikeHref = (url: string): boolean => /^(https?|file):/i.test(url);

/** 链接生效的 target：显式 target 缺省时回退 <base target>。 */
const getEffectiveAnchorTarget = (anchor: Element): string =>
  anchor.getAttribute("target") ||
  document.querySelector("base")?.getAttribute("target") ||
  "";

const sendGuestOpenTab = (url: string, background: boolean): void => {
  // 本地去重：同一激活序列中 mouseup 与 click/auxclick 会相继到达，
  // 短窗口内同 URL 同目标态只发送一次（主进程侧另有同 guest+URL 去重兜底）。
  const key = `${background ? "b" : "f"}\u0000${url}`;
  const now = Date.now();
  if (key === lastSentOpenTabKey && now - lastSentOpenTabAt < 300) {
    return;
  }
  lastSentOpenTabKey = key;
  lastSentOpenTabAt = now;
  ipcRenderer.send(GUEST_OPEN_TAB_CHANNEL, {
    url,
    disposition: background ? "background-tab" : "foreground-tab",
  });
};

let lastSentOpenTabKey = "";
let lastSentOpenTabAt = 0;

const handleLinkActivation = (event: MouseEvent): void => {
  // 激活判定包含 mouseup 兜底：webview 中左键点击 target=_blank 时
  // Chromium 的辅助导航流程可能吞掉 click 事件（electron#30886 相关，
  // 中键 auxclick 不受影响）——mouseup 总是先于 click 派发且无法被
  // 辅助导航抑制，以它兜底保证左键点击稳定触发。
  const isActivation =
    (event.type === "click" && event.button === 0) ||
    (event.type === "auxclick" && event.button === 1) ||
    (event.type === "mouseup" && (event.button === 0 || event.button === 1));
  if (!isActivation) {
    return;
  }
  const anchor =
    event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor || anchor.hasAttribute("download")) {
    return;
  }
  let url: string;
  try {
    url = new URL(anchor.getAttribute("href") || "", document.baseURI).href;
  } catch {
    return;
  }
  if (!isHttpLikeHref(url)) {
    return;
  }
  // 中键 / Ctrl(⌘)+点击 → 后台标签页（对齐 Chrome 语义）。
  const background = event.button === 1 || event.ctrlKey || event.metaKey;
  // 普通左键激活只拦截 target=_blank 链接，其余交给页面默认导航。
  if (!background && getEffectiveAnchorTarget(anchor) !== "_blank") {
    return;
  }
  sendGuestOpenTab(url, background);
  // 阻止默认行为（webview 下默认开窗本就无效）与自动滚动等副作用。
  event.preventDefault();
};

const setupLinkActivation = (): void => {
  document.addEventListener("mouseup", handleLinkActivation, true);
  document.addEventListener("click", handleLinkActivation, true);
  document.addEventListener("auxclick", handleLinkActivation, true);
};

const setup = (): void => {
  // target=_blank / 中键链接激活拦截 → 侧边浏览器内新建标签页。
  setupLinkActivation();

  // 表单 submit（捕获阶段，兼容 iframe 冒泡的过滤）。
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target as HTMLFormElement;
      const passwordInput = form.querySelector<HTMLInputElement>(
        "input[type=password]",
      );
      if (passwordInput) {
        void trySave(passwordInput);
      }
    },
    true,
  );

  // 无 <form> 的站点：点击提交按钮时兜底捕获。
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest<HTMLButtonElement | HTMLInputElement>(
        "button[type=submit], input[type=submit], button:not([type])",
      );
      if (!button) {
        return;
      }
      const form = button.closest("form");
      const passwordInput = form
        ? form.querySelector<HTMLInputElement>("input[type=password]")
        : document.querySelector<HTMLInputElement>("input[type=password]");
      if (passwordInput) {
        void trySave(passwordInput);
      }
    },
    true,
  );

  // 自动填充：DOM 就绪后执行一次。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void tryAutofill(), {
      once: true,
    });
  } else {
    void tryAutofill();
  }

  // 站点用 JS 延迟渲染登录表单时轮询补填（约 8 秒内）。
  let attempts = 0;
  const poll = window.setInterval(() => {
    attempts += 1;
    if (attempts > 10) {
      window.clearInterval(poll);
      return;
    }
    const passwordInput = findPasswordInput();
    if (
      passwordInput &&
      !passwordInput.value &&
      passwordInput.dataset.snowFilled !== "1"
    ) {
      void tryAutofill();
    }
  }, 800);
};

contextBridge.exposeInMainWorld("snowPasswordBridge", {
  /** 查询当前页面 origin 已保存的凭据（供页面脚本手动触发填充）。 */
  find: (): Promise<{ username: string; password: string } | null> =>
    ipcRenderer.invoke("browser-passwords:find", {
      origin: getOrigin(),
    }),
  /** 保存凭据（供页面脚本自定义逻辑调用）。 */
  save: (payload: {
    origin: string;
    username: string;
    password: string;
  }): Promise<{ id: string; updated: boolean }> =>
    ipcRenderer.invoke("browser-passwords:save", payload),
});

// 用户脚本注入：必须在顶层同步调用。内部经 sendSync 同步匹配 +
// executeJavaScript 同步排队注入，确保脚本早于页面首个脚本执行
//（document-start 语义，h5player 等脚本依赖此前置劫持 MediaSource）。
injectUserscripts();

setup();
