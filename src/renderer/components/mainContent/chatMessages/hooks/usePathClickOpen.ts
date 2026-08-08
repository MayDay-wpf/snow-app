import { useCallback, useEffect } from "react";
import { rightPanelEvents } from "../../../rightPanel/rightPanelEvents";

/** 启发式判断文本是否像文件路径（含分隔符，或是带扩展名的文件名）。 */
const looksLikePath = (value: string): boolean => {
  if (!value || value.length > 512 || /^https?:\/\//i.test(value)) {
    return false;
  }
  if (/\s/.test(value)) {
    return false;
  }
  return (
    /[\\/]/.test(value) ||
    /(?:^|[\\/])[^\\/]+\.[a-zA-Z0-9]{1,12}$/.test(value)
  );
};

/** 解析 `path:line`、`path:start-end` 或 Markdown `path#Lline`。 */
const parsePathWithLine = (
  raw: string
): { path: string; line?: number } => {
  const cleaned = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
  const hashMatch = cleaned.match(/^(.+?)#L(\d+)$/i);
  if (hashMatch) {
    return { path: hashMatch[1], line: parseInt(hashMatch[2], 10) };
  }
  // 冒号后必须为纯数字，避免误伤 Windows 盘符（C:\foo）。
  const lineMatch = cleaned.match(/^(.+):(\d+)(?:[-–](\d+))?$/);
  if (lineMatch) {
    return { path: lineMatch[1], line: parseInt(lineMatch[2], 10) };
  }
  return { path: cleaned };
};

const isAbsoluteLocalPath = (path: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/");

const resolveLocalPath = (
  path: string,
  cwd: string | undefined
): string | undefined => {
  if (!path) {
    return undefined;
  }
  if (isAbsoluteLocalPath(path)) {
    return path;
  }
  if (!cwd) {
    return undefined;
  }
  const separator = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${separator}${path.replace(
    /^[\\/]+/,
    ""
  )}`;
};

/** 将 SSH URL/相对路径转换为 sshReadFile 所需的远程绝对路径。 */
const resolveSshPath = (path: string, workspacePath: string): string => {
  if (path.startsWith("ssh://")) {
    return path.replace(/^ssh:\/\/[^/]+/, "") || "/";
  }
  if (path.startsWith("/")) {
    return path;
  }
  const remoteRoot =
    workspacePath.replace(/^ssh:\/\/[^/]+/, "").replace(/\/+$/, "") || "/";
  return `${remoteRoot}/${path.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
};

const decodeHref = (href: string): string => {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
};

/**
 * 聊天区 Ctrl(+Meta)+点击路径 → 右侧面板打开文件 的容器级委托。
 *
 * 性能设计：
 * - 渲染零扫描：不遍历消息文本，仅在用户主动 Ctrl+点击时识别目标元素。
 * - 单一委托：挂在常驻 chat-area，兼容消息虚拟化及 DOM 动态增删。
 * - Ctrl 状态用 body.classList 驱动纯 CSS，不触发 React re-render。
 *
 * 识别优先级：
 * 1. [data-path]：工具调用组件显式标记（精确）
 * 2. Markdown 文件链接的 href（启发式）
 * 3. inline code，排除 pre > code（启发式）
 * 4. [title] 中的完整路径（兜底）
 */
export const usePathClickOpen = (
  directoryPath: string | undefined
): {
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onAuxClick: (event: React.MouseEvent<HTMLDivElement>) => void;
} => {
  useEffect(() => {
    const updateHeld = (held: boolean): void => {
      document.body.classList.toggle("ctrl-held", held);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        updateHeld(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) {
        updateHeld(false);
      }
    };
    const handleBlur = (): void => updateHeld(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      updateHeld(false);
    };
  }, []);

  const openPath = useCallback(
    (raw: string, lineAttr?: string): void => {
      const { path, line } = parsePathWithLine(raw);
      const attrLine = lineAttr ? parseInt(lineAttr, 10) : undefined;
      const focusLine = line ?? attrLine;
      const isSshWorkspace = directoryPath?.startsWith("ssh://") ?? false;
      const resolved =
        isSshWorkspace && directoryPath
          ? resolveSshPath(path, directoryPath)
          : resolveLocalPath(path, directoryPath);
      if (!resolved) {
        return;
      }
      rightPanelEvents.emit("open-file", {
        filePath: resolved,
        isSsh: isSshWorkspace,
        sshWorkspacePath: isSshWorkspace ? directoryPath : undefined,
        focusLine: focusLine && focusLine > 0 ? focusLine : undefined,
      });
    },
    [directoryPath]
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      // 1) 工具组件显式标记的路径，优先级最高。
      const pathEl = target.closest<HTMLElement>("[data-path]");
      if (pathEl) {
        const raw = pathEl.dataset.path;
        if (raw) {
          event.preventDefault();
          openPath(raw, pathEl.dataset.line);
          return;
        }
      }

      // 2) Markdown 链接：HTTP(S) 保持现有右侧浏览器行为；
      // 非 HTTP 且 href 像文件路径时，按文件链接处理。
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (anchor) {
        const href = anchor.getAttribute("href")?.trim() ?? "";
        if (/^https?:\/\//i.test(href)) {
          return;
        }
        const decoded = decodeHref(href);
        if (looksLikePath(decoded)) {
          event.preventDefault();
          openPath(decoded);
        }
        return;
      }

      // 3) Markdown inline code（排除代码块，降低命令文本误判）。
      const codeEl = target.closest<HTMLElement>("code");
      if (codeEl && !codeEl.closest("pre")) {
        const text = codeEl.textContent?.trim();
        if (text && looksLikePath(text)) {
          event.preventDefault();
          openPath(text);
          return;
        }
      }

      // 4) title 携带完整路径的元素（tool call header 等兜底）。
      const titledEl = target.closest<HTMLElement>("[title]");
      if (titledEl) {
        const title = titledEl.getAttribute("title")?.trim();
        if (title && looksLikePath(title)) {
          event.preventDefault();
          openPath(title);
        }
      }
    },
    [openPath]
  );

  // auxclick 与 click 共用同一处理：Chromium 中 Ctrl/Cmd+点击或中键点击
  // 触发的是 auxclick 事件，其“新标签打开”默认行为只有 auxclick 的
  // preventDefault 才能阻止；若只挂 onClick，Ctrl+点击 <a href> 会降级为
  // 当前窗口导航，导致整个前端刷新、进行中的会话/生成全部中断。
  return { onClick: handleClick, onAuxClick: handleClick };
};
