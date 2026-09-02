/**
 * Markdown rendering Web Worker.
 *
 * Runs markdown-it + highlight.js off the main thread so that streaming
 * chunk bursts from the AI loop no longer jank the UI. The worker keeps a
 * small LRU cache keyed by content hash so that repeated renders (e.g. a
 * finalized message re-rendered after re-entering a conversation) are free.
 *
 * The worker is intentionally framework-agnostic: it receives a plain
 * { id, content } message and replies with { id, html }. The React layer
 * is responsible for throttling and dispatching.
 */

import hljs from "highlight.js";
import katex from "katex";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import texmath from "markdown-it-texmath";
import {
  imageProxyUrl,
  localImageProxyUrl,
} from "../../../../utils/imageProxyUrl";

/**
 * Escape HTML special characters in a string so that when highlight.js
 * returns autoHighlight for an unknown language the result is safe to inject.
 */
const escapeHtml = (str: string): string =>
  str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  highlight(str: string, lang: string): string {
    const language = lang?.trim();

    // Mermaid diagrams are rendered on the main thread (mermaid needs DOM
    // access and cannot run inside a Web Worker). Emit a placeholder container
    // carrying the escaped source. The structure includes:
    //   - a toolbar with copy + view-toggle buttons (handled in the React layer)
    //   - a code view (highlighted source, visible by default during streaming)
    //   - an empty diagram view (filled with SVG by mermaidRenderer once parsed)
    // `data-mermaid-view="code"` keeps the code visible until the diagram is
    // ready, preventing flicker while incomplete code is streaming in.
    if (language === "mermaid") {
      const encoded = encodeURIComponent(str);
      const highlighted = escapeHtml(str);
      return (
        `<div class="mermaid-block" data-mermaid="${encoded}" data-mermaid-view="code">` +
        `<div class="mermaid-toolbar">` +
        `<span class="mermaid-toolbar-label">mermaid</span>` +
        `<div class="mermaid-toolbar-actions">` +
        `<button class="mermaid-btn-copy" type="button" data-code="${encoded}" title="Copy">` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>` +
        `</button>` +
        `<button class="mermaid-btn-download" type="button" data-mermaid-action="download" title="Save as image">` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>` +
        `</button>` +
        `<button class="mermaid-btn-code" type="button" data-mermaid-action="code" title="Code view">` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>` +
        `</button>` +
        `<button class="mermaid-btn-diagram" type="button" data-mermaid-action="diagram" title="Diagram view">` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M3 9h6"/></svg>` +
        `</button>` +
        `</div>` +
        `</div>` +
        `<div class="mermaid-view-code"><pre><code class="hljs language-mermaid">${highlighted}</code></pre></div>` +
        `<div class="mermaid-view-diagram"></div>` +
        `</div>`
      );
    }

    let highlighted: string;

    if (language && hljs.getLanguage(language)) {
      try {
        highlighted = hljs.highlight(str, {
          language,
          ignoreIllegals: true,
        }).value;
      } catch {
        highlighted = escapeHtml(str);
      }
    } else {
      highlighted = escapeHtml(str);
    }

    const label = language || "code";

    return (
      `<div class="code-block-wrapper">` +
      `<div class="code-block-header">` +
      `<button class="code-block-lang" type="button">` +
      `<svg class="code-block-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>` +
      `<span>${label}</span>` +
      `</button>` +
      `<button class="code-block-copy" type="button" data-code="${encodeURIComponent(
        str,
      )}\">` +
      `<svg class="code-block-copy-icon code-block-copy-icon-copy" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>` +
      `<svg class="code-block-copy-icon code-block-copy-icon-check" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` +
      `</button>` +
      `</div>` +
      `<pre><code class="hljs language-${
        language || ""
      }">${highlighted}</code></pre>` +
      `</div>`
    );
  },
});

// The highlight callback above returns a complete .code-block-wrapper element.
// markdown-it's default fence renderer would nest any highlight result that
// does not start with "<pre" inside an extra <pre><code>, producing invalid
// HTML (<div> inside inline <code>) whose empty inline fragments render as
// stray gray bars around the code block. Return the wrapper directly instead.
markdown.renderer.rules.fence = (tokens, idx, options): string => {
  const token = tokens[idx];
  const lang = token.info ? token.info.trim() : "";
  const rendered = options.highlight
    ? options.highlight(token.content, lang, "")
    : "";
  return (
    (rendered || `<pre><code>${escapeHtml(token.content)}</code></pre>`) + "\n"
  );
};

// Wrap tables in a scrollable container so that wide tables are horizontally
// scrollable instead of being clipped by overflow:hidden on the table element.
markdown.renderer.rules.table_open = (): string =>
  '<div class="table-wrapper">\n<table>\n';
markdown.renderer.rules.table_close = (): string => "</table>\n</div>\n";

/**
 * 工作流交接文档块：<handoff>...</handoff>（标签独占行）渲染为可折叠的
 * tag 块，而非裸露的 XML 文本。在 paragraph 之前注册块级规则，内容中的
 * 代码块/列表等结构不会干扰识别（识别只看标签行本身）。
 *
 * 必须找到闭合标签才消费：未闭合时（流式写入中，或模型在思考/正文里
 * 字面引用标签说明格式）一律交给 paragraph 原样渲染，绝不把后续内容
 * 吞进折叠块——否则该行之后直到文末的正文会整体消失。
 */
const HANDOFF_OPEN_RE = /^ {0,3}<handoff>[ \t]*$/i;
const HANDOFF_CLOSE_RE = /^ {0,3}<\/handoff>[ \t]*$/i;

// markdown-it 的块级规则挂在实例的 block.ruler 上，其类型定义未声明
// 该成员（运行时存在），这里按用到的最小签名做类型收窄。
type HandoffBlockState = {
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  blkIndent: number;
  src: string;
  line: number;
  getLines: (
    begin: number,
    end: number,
    indent: number,
    keepNewLines: boolean,
  ) => string;
  push: (type: string, tag: string, nesting: number) => Token;
};

(
  markdown as unknown as {
    block: {
      ruler: {
        before: (
          beforeName: string,
          ruleName: string,
          fn: (
            state: HandoffBlockState,
            startLine: number,
            endLine: number,
            silent: boolean,
          ) => boolean,
        ) => void;
      };
    };
  }
).block.ruler.before(
  "paragraph",
  "handoff_block",
  (state, startLine, endLine, silent) => {
    // 廉价预检：行长不足 "<handoff>"（9 字符）直接跳过。
    if (state.tShift[startLine] < 0) {
      return false;
    }
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (pos + 8 > max) {
      return false;
    }
    if (!HANDOFF_OPEN_RE.test(state.src.slice(pos, max))) {
      return false;
    }
    // 找不到闭合标签行则不消费（silent 探测与实际消费同一判定，
    // 保证上游嵌套块的探测结果一致）。
    let closeLine = -1;
    for (let line = startLine + 1; line < endLine; line += 1) {
      if (state.tShift[line] < 0) {
        continue;
      }
      const linePos = state.bMarks[line] + state.tShift[line];
      const lineMax = state.eMarks[line];
      if (
        linePos + 9 <= lineMax &&
        HANDOFF_CLOSE_RE.test(state.src.slice(linePos, lineMax))
      ) {
        closeLine = line;
        break;
      }
    }
    if (closeLine < 0) {
      return false;
    }
    if (silent) {
      return true;
    }
    const token = state.push("handoff_block", "", 0);
    token.content = state.getLines(
      startLine + 1,
      closeLine,
      state.blkIndent,
      true,
    );
    token.map = [startLine, closeLine + 1];
    state.line = closeLine + 1;
    return true;
  },
);

// handoff tag 块：默认收起的主题色胶囊标签，点击展开（React 层事件委托
// 处理）。内部文本作为 markdown 嵌套渲染（交接文档含列表/路径等富文本
// 结构），展开为主题色引用面板。
markdown.renderer.rules.handoff_block = (tokens, idx): string => {
  const inner = tokens[idx].content.trim();
  const rendered = inner ? markdown.render(inner) : "";
  return (
    `<div class="md-handoff-block">` +
    `<button class="md-handoff-toggle" type="button" aria-expanded="false">` +
    `<span class="md-handoff-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg></span>` +
    `<span class="md-handoff-label">handoff</span>` +
    `<svg class="md-handoff-chevron" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>` +
    `</button>` +
    `<div class="md-handoff-content">${rendered}</div>` +
    `</div>\n`
  );
};

/**
 * linkify 会把 `README.md` 这类裸文本误识别为链接：`.md` 是 IANA 顶级域名
 * （黑山共和国），`README.md` 会被转成 `http://README.md`，点击会打开
 * 浏览器而不是右侧文件阅读器。这里把"单段 host + 文件扩展名 TLD"的伪链接
 * 在 token 层面还原为纯文本（保留原文，不渲染成 <a>）。
 */
const FAKE_LINK_FILE_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "log",
  "csv",
  "json",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "svg",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "sql",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "zip",
  "tar",
  "gz",
  "7z",
  "ai",
  "psd",
  "wasm",
  "map",
  "lock",
  "patch",
  "diff",
  "vue",
  "svelte",
  "ttf",
  "woff",
  "woff2",
  "mp3",
  "mp4",
  "avi",
  "mov",
  "dmg",
  "exe",
  "dll",
  "bat",
  "cmd",
  "ps1",
  "reg",
  "env",
  "npmrc",
  "yarnrc",
  "editorconfig",
  "gitignore",
]);

const isFakeLinkUrl = (href: string): boolean => {
  if (!/^https?:\/\//i.test(href)) {
    return false;
  }
  try {
    const url = new URL(href);
    // 仅处理单段 host（形如 README.md、design.ai）：无子域、无路径。
    const match = url.hostname.match(/^[^.]+\.([a-z0-9]+)$/i);
    if (!match) {
      return false;
    }
    return FAKE_LINK_FILE_EXTENSIONS.has(match[1].toLowerCase());
  } catch {
    return false;
  }
};

// 在 linkify 规则之后把伪链接 token 序列拍平成单个文本 token。
markdown.core.ruler.after("linkify", "de-linkify-fake-links", (state) => {
  for (const blockToken of state.tokens) {
    if (blockToken.type !== "inline" || !blockToken.children) {
      continue;
    }
    const children = blockToken.children;
    for (let i = 0; i < children.length; i += 1) {
      const token = children[i];
      if (token.type !== "link_open") {
        continue;
      }
      const href = token.attrGet("href") ?? "";
      if (!isFakeLinkUrl(href)) {
        continue;
      }
      // 收集 link_open 到对应 link_close 之间的文本，替换为纯文本 token。
      let end = i + 1;
      while (end < children.length && children[end].type !== "link_close") {
        end += 1;
      }
      const text = children
        .slice(i + 1, end)
        .map((t) => t.content ?? "")
        .join("");
      const textToken = new state.Token("text", "", 0);
      textToken.content = text;
      children.splice(i, end - i + 1, textToken);
    }
  }
});

/** 来源徽章：带 title 摘要的 http(s) 链接替换为徽章（favicon + 缩略标题），
 *  悬停摘要/点击跳转由 React 层从 data-* 读取；无 title 链接保持原样。 */
type SourceEntry = {
  title: string;
  url: string;
  summary: string;
  favicon: string;
};

/** 属性值转义，防模型输出注入引号/尖括号破坏 HTML 结构。 */
const attrEscape = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** 徽章缺 favicon 时的占位图标（lucide Globe）。 */
const SOURCE_BADGE_FALLBACK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';

markdown.core.ruler.push("annotate-source-badges", (state) => {
  for (const token of state.tokens) {
    if (token.type !== "inline" || !token.children) {
      continue;
    }
    const children = token.children;
    const out: Token[] = [];
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child.type !== "link_open") {
        out.push(child);
        continue;
      }
      // 定位对应 link_close，拼接链接文本
      let close = i + 1;
      while (close < children.length && children[close].type !== "link_close") {
        close += 1;
      }
      if (close >= children.length) {
        out.push(child);
        continue;
      }
      const label = children
        .slice(i + 1, close)
        .filter((c) => c.type === "text")
        .map((c) => c.content ?? "")
        .join("")
        .trim();
      const href = child.attrGet("href") ?? "";
      const summary = (child.attrGet("title") ?? "").trim();
      // 仅带 title 摘要的 http(s) 链接视为徽章
      if (!/^https?:\/\//i.test(href) || !summary) {
        out.push(child);
        continue;
      }
      const title = label;
      if (!title) {
        out.push(child);
        continue;
      }
      let favicon = "";
      try {
        favicon = imageProxyUrl(`${new URL(href).origin}/favicon.ico`);
      } catch {
        // 保留空 favicon，徽章显示占位图标
      }
      const badge = new state.Token("md_source_badge", "span", 0);
      badge.meta = { title, url: href, summary, favicon };
      out.push(badge);
      i = close;
    }
    children.splice(0, children.length, ...out);
  }
});

// 正文来源徽章：favicon + 缩略标题，悬停详情由 React 层从 data-* 读取。
markdown.renderer.rules.md_source_badge = (tokens, idx): string => {
  const meta = tokens[idx].meta as SourceEntry;
  const favicon = meta.favicon
    ? `<img class="md-source-badge-favicon" src="${attrEscape(
        meta.favicon,
      )}" alt="" decoding="async">`
    : "";
  return (
    `<span class="md-source-badge" data-title="${attrEscape(
      meta.title,
    )}" data-url="${attrEscape(meta.url)}" data-summary="${attrEscape(
      meta.summary,
    )}">` +
    favicon +
    `<span class="md-source-badge-fallback" aria-hidden="true">${SOURCE_BADGE_FALLBACK_SVG}</span>` +
    `<span class="md-source-badge-title">${escapeHtml(meta.title)}</span>` +
    `</span>`
  );
};

/**
 * 判断是否为本地图片相对路径：图库落盘引用（image/...，安装目录旁图库目录）
 * 或会话上传引用（upload/...，数据库目录旁的 upload 目录）。这两类路径在
 * 渲染进程中没有对应静态资源，直接作为 <img src> 加载必然失败（破损图片），
 * 需要改写为 img-proxy:// 协议 URL，由主进程读取磁盘后返回。
 */
const normalizeLocalImagePath = (src: string): string | null => {
  if (!src || src.length > 512 || /\s/.test(src)) {
    return null;
  }
  // markdown-it 会把反斜杠路径（image\2026-...）URL 编码为 %5C，先解码
  // 再统一分隔符判断；非法 % 转义按字面值处理。
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // 保留原值
  }
  const normalized = decoded.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/^(image|upload)\//.test(normalized) || normalized.includes("..")) {
    return null;
  }
  return normalized;
};

// 把图片 src 统一改写为 img-proxy:// 协议：外部 http(s) 图与本地相对路径
// （image/、upload/）都经主进程协议处理器加载（外部 net.fetch 代理，本地
// 直接读盘），符合渲染进程 CSP（img-src 允许 img-proxy: 但不允许任意 https:
// 与本地相对路径）。
const defaultImageRule = markdown.renderer.rules.image;
markdown.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const srcIndex = token.attrIndex("src");
  if (srcIndex >= 0 && token.attrs) {
    const pair = token.attrs[srcIndex];
    if (pair) {
      const src = pair[1];
      if (/^https?:\/\//i.test(src)) {
        pair[1] = imageProxyUrl(src);
      } else {
        const local = normalizeLocalImagePath(src);
        if (local) {
          pair[1] = localImageProxyUrl(local);
        }
      }
    }
  }
  return defaultImageRule
    ? defaultImageRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

/**
 * KaTeX math rendering. texmath parses `$...$` inline and `$$...$$` display
 * formulas and delegates to katex.renderToString, which is pure string work
 * and therefore safe inside a Web Worker. throwOnError is disabled so that a
 * half-typed formula during streaming renders as highlighted source instead
 * of throwing and breaking the whole render pass.
 */
markdown.use(texmath, {
  engine: katex,
  delimiters: "dollars",
  katexOptions: { throwOnError: false },
});

/**
 * Tiny LRU cache for rendered HTML. Keyed by content string. We cap the
 * number of entries (not byte size) — markdown HTML for chat messages is
 * small enough that 64 entries cover the visible viewport comfortably,
 * and evicting older entries keeps memory bounded across long sessions.
 *
 * The cache lives in the worker (not the main thread) so that:
 *   - The same worker instance is reused across all MarkdownBlock instances.
 *   - Cache lookups do not require a structured-clone round-trip.
 */
const CACHE_MAX_ENTRIES = 64;
const renderCache = new Map<string, string>();

const cacheGet = (key: string): string | undefined => {
  const value = renderCache.get(key);
  if (value !== undefined) {
    // Move to most-recently-used position (Map preserves insertion order).
    renderCache.delete(key);
    renderCache.set(key, value);
  }
  return value;
};

const cacheSet = (key: string, value: string): void => {
  if (renderCache.size >= CACHE_MAX_ENTRIES) {
    // Evict the oldest entry (first key of the Map).
    const oldestKey = renderCache.keys().next().value;
    if (oldestKey !== undefined) {
      renderCache.delete(oldestKey);
    }
  }
  renderCache.set(key, value);
};

export type MarkdownRenderRequest = {
  /** Correlates the response with the request that triggered it. */
  id: number;
  content: string;
};

export type MarkdownRenderResponse = {
  id: number;
  html: string;
};

const render = (content: string): string => {
  const cached = cacheGet(content);
  if (cached !== undefined) {
    return cached;
  }
  const html = markdown.render(content);
  cacheSet(content, html);
  return html;
};

// Self-listener keeps the worker framework-agnostic and type-safe even when
// `self` is the global worker scope (no DOM `window` available).
self.onmessage = (event: MessageEvent<MarkdownRenderRequest>): void => {
  const { id, content } = event.data;
  const html = render(content);
  const response: MarkdownRenderResponse = { id, html };
  (self as unknown as Worker).postMessage(response);
};
