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

import {
  escapeCodeHtml as escapeHtml,
  getCodeLanguageHint,
  highlightCodeHtml,
} from "../../../../utils/syntaxHighlight";
import katex from "katex";
import MarkdownIt from "markdown-it";
import type { RuleBlock } from "markdown-it/lib/parser_block.mjs";
import fenceRule from "markdown-it/lib/rules_block/fence.mjs";
import { localFileUrlToPath } from "../../../../utils/localFileUrl";
import type Token from "markdown-it/lib/token.mjs";
import texmath from "markdown-it-texmath";
import { renderAcceptanceBlock } from "./acceptanceRenderer";
import {
  imageProxyUrl,
  isAbsoluteImagePath,
  localImageProxyUrl,
} from "../../../../utils/imageProxyUrl";

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  highlight(str: string, lang: string): string {
    const language = getCodeLanguageHint(lang ?? "");

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

    const highlighted = highlightCodeHtml(str, language);

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

const defaultValidateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (url: string): boolean =>
  /^file:/i.test(url)
    ? localFileUrlToPath(url) !== undefined
    : defaultValidateLink(url);

// Observe the real fence parser while quote/list indentation is still active.
// fenceRule passes its exclusive body end to getLines and advances state.line
// beyond that end only when it actually consumes a closing marker. EOF and
// parent-container termination therefore stay incomplete without rescanning.
const trackFenceCompletion: RuleBlock = (state, startLine, endLine, silent) => {
  if (silent) return fenceRule(state, startLine, endLine, silent);
  const getLines = state.getLines;
  let bodyEnd: number | undefined;
  const tokenIndex = state.tokens.length;
  state.getLines = (begin, end, indent, keepLastLF) => {
    bodyEnd = end;
    return getLines.call(state, begin, end, indent, keepLastLF);
  };
  try {
    const matched = fenceRule(state, startLine, endLine, silent);
    const token = state.tokens[tokenIndex];
    if (matched && token?.type === "fence") {
      token.meta = {
        ...token.meta,
        htmlArtifactComplete:
          bodyEnd !== undefined && state.line === bodyEnd + 1,
      };
    }
    return matched;
  } finally {
    state.getLines = getLines;
  }
};
(
  markdown as unknown as {
    block: {
      ruler: {
        at: (name: string, rule: RuleBlock, options: { alt: string[] }) => void;
      };
    };
  }
).block.ruler.at("fence", trackFenceCompletion, {
  alt: ["paragraph", "reference", "blockquote", "list"],
});

// The highlight callback above returns a complete .code-block-wrapper element.
// markdown-it's default fence renderer would nest any highlight result that
// does not start with "<pre" inside an extra <pre><code>, producing invalid
// HTML (<div> inside inline <code>) whose empty inline fragments render as
// stray gray bars around the code block. Return the wrapper directly instead.
markdown.renderer.rules.fence = (tokens, idx, options): string => {
  const token = tokens[idx];
  const lang = token.info ? token.info.trim() : "";
  if (/^acceptance$/i.test(lang)) {
    const complete =
      (token.meta as { htmlArtifactComplete?: boolean } | null)
        ?.htmlArtifactComplete === true;
    const receipt = complete ? renderAcceptanceBlock(token.content) : null;
    if (receipt) return receipt + "\n";
    const state = complete ? "invalidReport" : "incompleteReport";
    return `<section class="md-acceptance"><div class="md-acceptance-note" data-acceptance-label="${state}"></div></section>\n`;
  }
  if (/^(?:html|htm|text\/html)(?:\s|$)/i.test(lang)) {
    const complete =
      (token.meta as { htmlArtifactComplete?: boolean } | null)
        ?.htmlArtifactComplete === true;
    const encoded = encodeURIComponent(token.content);
    return (
      `<div class="html-artifact-block" data-html-source="${encoded}" data-html-complete="${complete}" data-html-view="code">` +
      `<div class="html-artifact-toolbar">` +
      `<button type="button" data-html-action="code" aria-pressed="true"></button>` +
      `<button type="button" data-html-action="preview" aria-pressed="false" disabled></button>` +
      `<div class="html-artifact-zoom-slot"></div>` +
      `</div><div class="html-artifact-code"><pre><code class="hljs language-html">${highlightCodeHtml(token.content, "html")}</code></pre></div>` +
      `<div class="html-artifact-preview"></div></div>\n`
    );
  }
  const rendered = options.highlight
    ? options.highlight(token.content, lang, "")
    : "";
  return (
    (rendered || `<pre><code>${escapeHtml(token.content)}</code></pre>`) + "\n"
  );
};

// Wrap tables in a scrollable container so that wide tables are horizontally
// scrollable instead of being clipped by overflow:hidden on the table element.
// .table-scroll is the only scrolling box: the floating download button (CSV /
// XLSX export, dispatched by the React layer via `data-table-action`) sits in
// the non-scrolling .table-wrapper so it stays pinned to the right edge.
//
// The button deliberately carries no `title` here: this worker has no i18n
// context, so the React layer writes the localized tooltip when it parses the
// chunk HTML (parseChunkNodes / MarkdownBlock in markdownRenderer.tsx). Keeping
// the HTML language-neutral also keeps the render cache valid across language
// switches.
markdown.renderer.rules.table_open = (): string =>
  '<div class="table-wrapper">' +
  `<button class="table-download-btn" type="button" data-table-action="download">` +
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>` +
  `</button>` +
  '<div class="table-scroll">' +
  "\n<table>\n";
markdown.renderer.rules.table_close = (): string =>
  "</table>\n</div>\n</div>\n";

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
  const rendered = inner
    ? markdown.render(inner, { artifactSource: inner })
    : "";
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
 * inline code 中的文件路径识别：命中时渲染为带 `md-file-path` 类与
 * `data-file-path` 的 code，由 React 层（聊天区委托 / 文件阅读器）在点击时
 * 解析并打开。这里只做纯文本判定，文件是否真实存在留到点击时由 Rust 校验。
 *
 * 判定规则（全部满足）：
 *   - 无空白、长度受限，可带 `:行号`、`:起-止` 或 `#L行号` 后缀；
 *   - 每段不含路径非法字符与常见代码符号（括号、逗号、分号等）；
 *   - 末段扩展名属于已知文件类型，或是 Dockerfile / Makefile 等无扩展名文件；
 *   - 无分隔符的裸文件名不能以易与成员访问混淆的扩展名结尾
 *     （如 `console.log`、`process.env`、`arr.map`）；
 *   - 带分隔符时首段不能像域名（排除 `example.com/a.html` 这类 URL）。
 */
const FILE_PATH_EXTENSIONS = new Set([
  ...FAKE_LINK_FILE_EXTENSIONS,
  "mdx",
  "rst",
  "tsv",
  "jsonc",
  "json5",
  "mts",
  "cts",
  "astro",
  "sass",
  "styl",
  "kts",
  "scala",
  "dart",
  "lua",
  "r",
  "jl",
  "pl",
  "pm",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "proto",
  "graphql",
  "gql",
  "prisma",
  "tf",
  "gradle",
  "properties",
  "xlsm",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "wps",
  "et",
  "dps",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "wav",
  "flac",
  "mkv",
  "webm",
  "sln",
  "csproj",
  "vcxproj",
  "xaml",
  "plist",
  "pem",
  "crt",
  "prettierrc",
  "eslintrc",
  "babelrc",
  "nvmrc",
  "dockerignore",
  "gitattributes",
]);

/** 裸文件名（无分隔符）不认这些扩展名：与 JS 成员访问写法高度重叠。 */
const AMBIGUOUS_BARE_EXTENSIONS = new Set([
  "log",
  "map",
  "lock",
  "env",
  "ai",
  "go",
  "r",
  "c",
  "h",
  "cc",
  "ex",
  "et",
  "pm",
  "pl",
  "tf",
  "properties",
]);

/** 无扩展名但常被直接引用的文件名（小写比较）。 */
const EXTENSIONLESS_FILE_NAMES = new Set([
  "dockerfile",
  "makefile",
  "license",
  "readme",
  "changelog",
  "procfile",
  "gemfile",
  "rakefile",
  "jenkinsfile",
  "vagrantfile",
]);

const FILE_PATH_LINE_SUFFIX_RE = /(?::\d+(?:[-–]\d+)?|#L\d+(?:-L?\d+)?)$/i;
const FILE_PATH_PREFIX_RE = /^(?:[a-zA-Z]:[\\/]|\.{1,2}[\\/]|[\\/])/;
const FILE_PATH_SEGMENT_RE = /^[^\s\\/:*?"<>|`'(){},;=!&^%$#~]+$/;
const DOMAIN_LIKE_SEGMENT_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** 识别结果：路径类型（决定图标与打开方式）与末段名称（决定文件类型图标）。 */
type PathReference = { kind: "file" | "dir"; name: string };

const classifyPathReference = (raw: string): PathReference | null => {
  const text = raw.trim();
  if (!text || text.length > 260 || /\s/.test(text)) {
    return null;
  }
  const path = text.replace(FILE_PATH_LINE_SUFFIX_RE, "");
  const prefix = FILE_PATH_PREFIX_RE.exec(path)?.[0] ?? "";
  const trailingSeparator = /[\\/]$/.test(path);
  const body = path.slice(prefix.length).replace(/[\\/]+$/, "");
  if (!body) {
    return null;
  }
  const segments = body.split(/[\\/]/);
  if (!segments.every((segment) => FILE_PATH_SEGMENT_RE.test(segment))) {
    return null;
  }
  const hasSeparator =
    prefix.length > 0 || trailingSeparator || segments.length > 1;
  // 首段像域名（且不是 . 开头的隐藏目录）时视为 URL 片段，例如 example.com/a.html。
  if (
    segments.length > 1 &&
    !prefix &&
    !segments[0].startsWith(".") &&
    DOMAIN_LIKE_SEGMENT_RE.test(segments[0])
  ) {
    return null;
  }
  const name = segments[segments.length - 1];
  const dot = name.lastIndexOf(".");
  if (dot < 0 || trailingSeparator) {
    if (
      !trailingSeparator &&
      EXTENSIONLESS_FILE_NAMES.has(name.toLowerCase())
    ) {
      return { kind: "file", name };
    }
    return isLikelyDirectoryPath(prefix, trailingSeparator, segments)
      ? { kind: "dir", name }
      : null;
  }
  const extension = name.slice(dot + 1).toLowerCase();
  if (!FILE_PATH_EXTENSIONS.has(extension)) {
    return null;
  }
  // `.env`、`.gitignore` 这类点文件不受裸名歧义限制（点前为空）。
  if (!hasSeparator && dot > 0 && AMBIGUOUS_BARE_EXTENSIONS.has(extension)) {
    return null;
  }
  return { kind: "file", name };
};

/**
 * 目录路径判定（末段无扩展名或以分隔符结尾）。为避免把 URL 路由（`/api/users`）、
 * 日期（`2024/10/18`）、`and/or` 之类误认成目录，只接受：
 *   - 以分隔符结尾（`src/components/`）；
 *   - 盘符或 `./`、`../` 开头（`D:\proj\src`、`./scripts`）；
 *   - 无前缀且至少三段（`src/renderer/components`）。
 * 且每段都含字母。
 */
const isLikelyDirectoryPath = (
  prefix: string,
  trailingSeparator: boolean,
  segments: string[],
): boolean => {
  if (!segments.every((segment) => /[a-zA-Z]/.test(segment))) {
    return false;
  }
  if (trailingSeparator) {
    return true;
  }
  if (/^(?:[a-zA-Z]:|\.{1,2})[\\/]$/.test(prefix)) {
    return true;
  }
  return !prefix && segments.length >= 3;
};

// inline code：像文件路径时加上 md-file-path 标记与图标占位，其余保持默认渲染。
// 文件类型图标由 React 层按 data-path-kind / data-path-name 填入占位
// （图标组件依赖 react-dom/server，不放进 worker）。
markdown.renderer.rules.code_inline = (tokens, idx, _options, _env, self) => {
  const token = tokens[idx];
  const content = token.content;
  const reference = classifyPathReference(content);
  if (reference) {
    return (
      `<code class="md-file-path" data-file-path="${attrEscape(
        content.trim(),
      )}" data-path-kind="${reference.kind}" data-path-name="${attrEscape(
        reference.name,
      )}">` +
      `<span class="md-file-path-icon" aria-hidden="true"></span>` +
      `${escapeHtml(content)}</code>`
    );
  }
  return `<code${self.renderAttrs(token)}>${escapeHtml(content)}</code>`;
};

/**
 * 判断是否为本地图片路径：图库落盘引用（image/...，安装目录旁图库目录）、
 * 会话上传引用（upload/...，数据库目录旁的 upload 目录），或磁盘绝对路径
 * （D:/... 或 /...，模型引用项目内图片时常见）。这些路径在渲染进程中没有
 * 对应静态资源，直接作为 <img src> 加载必然失败（破损图片），需要改写为
 * img-proxy:// 协议 URL，由主进程读取磁盘后返回。
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
  // 绝对路径：交给主进程直接读盘（主进程侧限制图片扩展名）。
  if (isAbsoluteImagePath(normalized)) {
    return normalized.includes("..") ? null : normalized;
  }
  if (!/^(image|upload)\//.test(normalized) || normalized.includes("..")) {
    return null;
  }
  return normalized;
};

// 把图片 src 统一改写为 img-proxy:// 协议：外部 http(s) 图与本地路径
// （image/、upload/ 相对路径或磁盘绝对路径）都经主进程协议处理器加载
// （外部 net.fetch 代理，本地直接读盘），符合渲染进程 CSP（img-src 允许
// img-proxy: 但不允许任意 https: 与本地相对路径）。
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
 * 块级渲染缓存：key 为块文本。主线程只请求“尚未提交过的块”，因此流式
 * 中间态入缓存没有任何复用价值，只会把上限挤满大字符串——只在非流式
 * （终态）请求时写入，并跳过超长块。
 *
 * The cache lives in the worker (not the main thread) so that:
 *   - The same worker instance is reused across all MarkdownBlock instances.
 *   - Cache lookups do not require a structured-clone round-trip.
 */
const CACHE_MAX_ENTRIES = 256;
const CACHE_MAX_CHUNK_CHARS = 8_192;
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

/** 块指纹：长度 + 53 位哈希，用于跨帧比对已提交块（碰撞概率可忽略）。 */
const cyrb53 = (str: string, seed: number): number => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

const chunkKey = (text: string): string => `${text.length}:${cyrb53(text, 0)}`;

/** 围栏代码块：起始行（可带 info string）与闭合行（行尾仅空白）。 */
const FENCE_START_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * 切点行若以空白开头（缩进续行/缩进代码块）、或以列表/引用/表格/数字等
 * 标记字符开头，就说明它可能与前文合并解析，或正处在标记输入的中间态
 * （如列表项 "2" → "2."），不能作为新块开头。判据只看行首字符类别，
 * 因此内容继续增长不会让已建立的切点回退——已固化块得以稳定复用。
 */
const INDENTED_RE = /^[ \t]/;
const LEADING_MARKER_RE = /^ {0,3}[-*+>|]/;
const LEADING_DIGIT_RE = /^ {0,3}\d/;
const HANDOFF_OPEN_COUNT_RE = /<handoff\b/gi;
const HANDOFF_CLOSE_COUNT_RE = /<\/handoff>/gi;

const isSafeChunkStart = (line: string): boolean =>
  !INDENTED_RE.test(line) &&
  !LEADING_MARKER_RE.test(line) &&
  !LEADING_DIGIT_RE.test(line);

const countDollarPairs = (line: string): number => {
  let count = 0;
  let index = line.indexOf("$$");
  while (index >= 0) {
    count += 1;
    index = line.indexOf("$$", index + 2);
  }
  return count;
};

const countMatches = (line: string, re: RegExp): number =>
  (line.match(re) ?? []).length;

/**
 * 按“安全边界”把内容切成块：只在空行之后、且前后块不会互相影响时切分，
 * 使 markdown.render(块1) + … + markdown.render(块n) 与整篇渲染结果一致
 * （因此流式时只需重算变化的那几块，其余块复用已提交的 DOM）。
 *
 * 切分判据（全部满足才切）：
 *   - 切点前：围栏代码块已闭合、`$$` 成对、<handoff> 标签配对；
 *   - 切点行：非缩进、非列表/引用/表格/数字起始（见 isSafeChunkStart）。
 * 行尾空行不进入块文本，保证已固化块的文本（以及由它算出的 key）在内容
 * 继续增长时保持稳定，不会被反复重建。
 * tailInsideBlock 表示内容末尾仍处在未闭合的围栏代码块或 `$$` 公式中。
 */
const splitMarkdownChunks = (
  content: string,
): { texts: string[]; tailInsideBlock: boolean } => {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let chunkStart = 0;
  let lastContentLine = -1;
  let fence: { marker: string; size: number } | null = null;
  let dollarCount = 0;
  let handoffDepth = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (
        close &&
        close[1][0] === fence.marker &&
        close[1].length >= fence.size
      ) {
        fence = null;
      }
      // 围栏内的行（含空行）都属于代码块内容，同样计入块尾。
      lastContentLine = i;
      continue;
    }

    if (line.trim().length === 0) {
      continue;
    }

    if (
      lastContentLine >= 0 &&
      i > lastContentLine + 1 &&
      dollarCount % 2 === 0 &&
      handoffDepth === 0 &&
      isSafeChunkStart(line)
    ) {
      chunks.push(lines.slice(chunkStart, lastContentLine + 1).join("\n"));
      chunkStart = i;
    }

    lastContentLine = i;

    const fenceStart = FENCE_START_RE.exec(line);
    if (fenceStart) {
      fence = { marker: fenceStart[1][0], size: fenceStart[1].length };
      continue;
    }
    dollarCount += countDollarPairs(line);
    handoffDepth +=
      countMatches(line, HANDOFF_OPEN_COUNT_RE) -
      countMatches(line, HANDOFF_CLOSE_COUNT_RE);
  }

  if (lastContentLine >= chunkStart) {
    chunks.push(lines.slice(chunkStart, lastContentLine + 1).join("\n"));
  }
  return {
    texts: chunks,
    tailInsideBlock: fence !== null || dollarCount % 2 === 1,
  };
};

/**
 * 流式尾部的未完成语法：原文先按纯文本铺开、闭合后才收成渲染形态，
 * 高度会在闭合瞬间回落（钉底跟随随之先下拉、再被新内容顶回，表现为
 * 上下跳动）。这里只在流式请求中、只对尾块的最后一行预先采用闭合后的
 * 形态——不延后任何正文的显示，只是不把注定会消失的语法原文铺出来：
 *   - 未闭合的链接 `[文字](地址 "摘要"`：只显示链接文字（闭合后是同样
 *     文字的链接或来源徽章），地址与摘要原文不上屏；未闭合的图片整体
 *     不上屏（闭合后由图片占位）；
 *   - 只有块标记、尚无正文的行（`-`、`1.`、`#`、`>`、`---` 等）：先不上屏，
 *     避免在段落下方被临时解析成 setext 标题、空标题或空列表后又改回。
 * 尾块处在围栏代码块或 `$$` 公式内部时原样渲染。
 */
const INCOMPLETE_LINK_TAIL_RE =
  /(!?)\[([^[\]\n`]*)\]\(\s*[^\s()\n`]*(?:\s+(?:"[^"\n]*"?|'[^'\n]*'?))?\s*$/;
const BARE_BLOCK_MARKER_LINE_RE =
  /^ {0,3}(?:[-*+=_]+|\d{1,9}[.)]|#{1,6}|>)[ \t]*$/;

const predictStreamingTail = (text: string): string => {
  const lineStart = text.lastIndexOf("\n") + 1;
  const lastLine = text.slice(lineStart);
  if (BARE_BLOCK_MARKER_LINE_RE.test(lastLine)) {
    return text.slice(0, Math.max(0, lineStart - 1));
  }
  const link = INCOMPLETE_LINK_TAIL_RE.exec(lastLine);
  if (!link) {
    return text;
  }
  // 行内代码未闭合时，`](` 只是代码文本的一部分。
  const before = lastLine.slice(0, link.index);
  if ((before.match(/`/g)?.length ?? 0) % 2 === 1) {
    return text;
  }
  return text.slice(0, lineStart) + before + (link[1] ? "" : link[2]);
};

export type MarkdownChunk = {
  /** 块文本的稳定指纹，用于跨帧比对已提交块 */
  key: string;
  /** 该块的渲染结果 */
  html: string;
};

export type MarkdownRenderRequest = {
  /** Correlates the response with the request that triggered it. */
  id: number;
  content: string;
  /** 调用方已提交的块 key（连续前缀），据此算出需要重建的起点 */
  knownKeys: string[];
  /** 流式渲染的结果不写缓存 */
  streaming: boolean;
};

export type MarkdownRenderResponse = {
  id: number;
  /** 从该索引起的块与 knownKeys 不同，调用方需重建该索引起的节点 */
  changedFrom: number;
  /** changedFrom 起（含）的块渲染结果 */
  chunks: MarkdownChunk[];
};

const renderChunk = (text: string, streaming: boolean): string => {
  const cached = cacheGet(text);
  if (cached !== undefined) {
    return cached;
  }
  const html = markdown.render(text, { artifactSource: text });
  if (!streaming && text.length <= CACHE_MAX_CHUNK_CHARS) {
    cacheSet(text, html);
  }
  return html;
};

// Self-listener keeps the worker framework-agnostic and type-safe even when
// `self` is the global worker scope (no DOM `window` available).
self.onmessage = (event: MessageEvent<MarkdownRenderRequest>): void => {
  const { id, content, knownKeys, streaming } = event.data;
  const { texts, tailInsideBlock } = splitMarkdownChunks(content);
  const keys = texts.map(chunkKey);
  // 流式尾块按预判形态渲染；形态与原文不同时使用独立 key，保证终态
  // 渲染（原文）必然替换掉它，不会因 key 相同被误当作已就位的块复用。
  // 只有内容的最后一行仍在书写（非空）时才预判：已换行的行语法已定型。
  const tailIndex = texts.length - 1;
  if (
    streaming &&
    tailIndex >= 0 &&
    !tailInsideBlock &&
    content.slice(content.lastIndexOf("\n") + 1).trim().length > 0
  ) {
    const predicted = predictStreamingTail(texts[tailIndex]);
    if (predicted !== texts[tailIndex]) {
      texts[tailIndex] = predicted;
      keys[tailIndex] = `${keys[tailIndex]}:p`;
    }
  }
  const comparable = Math.min(keys.length, knownKeys.length);
  let changedFrom = 0;
  while (
    changedFrom < comparable &&
    keys[changedFrom] === knownKeys[changedFrom]
  ) {
    changedFrom += 1;
  }
  const chunks: MarkdownChunk[] = [];
  for (let i = changedFrom; i < texts.length; i += 1) {
    chunks.push({ key: keys[i], html: renderChunk(texts[i], streaming) });
  }
  const response: MarkdownRenderResponse = { id, changedFrom, chunks };
  (self as unknown as Worker).postMessage(response);
};
