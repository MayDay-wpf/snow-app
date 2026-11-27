/**
 * Markdown 文件预览里文档作者写的原始 HTML 的净化器。
 *
 * worker 把原始 HTML 渲染成占位节点（data-md-raw-html），主线程在解析整块
 * 之前把占位还原成净化后的标记字符串。净化必须发生在字符串阶段：行内标签
 * 的成对关系（`<kbd>` … `</kbd>`）只有整块解析才成立，逐段做 DOM 解析会把
 * 它们拆成两个孤立的空元素。
 *
 * 策略是标签 / 属性白名单：脚本、表单、事件处理、样式表与外部资源挂载点
 * 全部移除，未知标签只保留其文本内容。
 */

import { resolvePreviewImageSrc } from "../../../../utils/imageProxyUrl";

/** 连同内容一起删除的标签：可执行脚本、表单控件、外部资源挂载点。 */
const DROP_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "base",
  "title",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "param",
  "form",
  "input",
  "textarea",
  "select",
  "option",
  "optgroup",
  "button",
  "noscript",
  "template",
  "svg",
  "math",
  "canvas",
  "audio",
  "video",
  "source",
  "track",
  "portal",
  "slot",
]);

/** 保留的展示型标签（其余未知标签只保留其文本内容）。 */
const KEEP_TAGS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
]);

/** 所有标签通用属性（布局对齐由浏览器按展示性提示处理）。 */
const GLOBAL_ATTRS = new Set(["title", "align", "dir", "lang"]);

/** 按标签额外允许的属性。 */
const TAG_ATTRS: Record<string, readonly string[]> = {
  a: ["href"],
  blockquote: ["cite"],
  col: ["span", "width"],
  colgroup: ["span", "width"],
  del: ["cite", "datetime"],
  details: ["open"],
  hr: ["size", "width"],
  img: ["src", "alt", "width", "height"],
  ins: ["cite", "datetime"],
  li: ["value"],
  ol: ["start", "reversed", "type"],
  q: ["cite"],
  table: ["border", "cellpadding", "cellspacing", "summary", "width"],
  td: ["colspan", "rowspan", "valign", "width", "height"],
  th: ["colspan", "rowspan", "valign", "width", "height", "scope"],
  time: ["datetime"],
  ul: ["type"],
};

/** 允许的链接协议；无协议即相对路径，交由宿主点击处理器解析。 */
const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto"]);

/** markdown-it 生成的占位节点：<div data-md-raw-html="…"> 或 <span …>。 */
const RAW_HTML_PLACEHOLDER_RE =
  /<(?:div|span) data-md-raw-html="([^"]*)"><\/(?:div|span)>/g;

/** 标签起点（粘性匹配：只认当前位置，非标签的 `<` 按文本保留）。 */
const TAG_START_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/y;

/** 属性名 + 可选取值（双引号 / 单引号 / 无引号）。 */
const ATTRIBUTE_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** 属性值里的基础实体还原（重写属性时统一重新转义）。 */
const decodeEntities = (value: string): string =>
  value.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (whole, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const sanitizeHref = (value: string): string | null => {
  // 去掉控制字符，避免 "java\nscript:" 之类的绕过写法
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#")) {
    return trimmed;
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)?.[1];
  if (!scheme) {
    return trimmed;
  }
  return SAFE_LINK_SCHEMES.has(scheme.toLowerCase()) ? trimmed : null;
};

/** 找到标签结束的 `>`（跳过引号内的内容）；未闭合返回 -1。 */
const findTagEnd = (source: string, from: number): number => {
  let quote = "";
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return i;
    }
  }
  return -1;
};

/** 需要整体丢弃的标签：返回到闭合标签之后的索引（找不到则丢弃到结尾）。 */
const findClosingTagEnd = (
  source: string,
  name: string,
  from: number,
): number => {
  const pattern = new RegExp(`</${name}\\s*>`, "i");
  const match = pattern.exec(source.slice(from));
  return match ? from + match.index + match[0].length : source.length;
};

/** 按白名单重写标签属性：返回 ` attr="value"…`（不含标签名）。 */
const rewriteAttributes = (
  name: string,
  body: string,
  imageBaseDir: string | undefined,
): string => {
  const extra = TAG_ATTRS[name];
  const pattern = new RegExp(ATTRIBUTE_RE.source, "g");
  let out = "";
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const attr = match[1].toLowerCase();
    if (!GLOBAL_ATTRS.has(attr) && !extra?.includes(attr)) {
      continue;
    }
    const raw = match[2] ?? match[3] ?? match[4];
    if (raw === undefined) {
      // 布尔属性（open / reversed 等）
      out += ` ${attr}`;
      continue;
    }
    const value = decodeEntities(raw);
    if (attr === "href") {
      const href = sanitizeHref(value);
      if (href !== null) {
        out += ` href="${escapeAttribute(href)}"`;
      }
      continue;
    }
    if (attr === "src") {
      const src = resolvePreviewImageSrc(value, imageBaseDir);
      if (src !== null) {
        out += ` src="${escapeAttribute(src)}"`;
      }
      continue;
    }
    out += ` ${attr}="${escapeAttribute(value)}"`;
  }
  return out;
};

/** 净化一段文档作者写的 HTML，返回可安全解析的标记字符串。 */
export const sanitizeRawHtml = (
  source: string,
  imageBaseDir?: string,
): string => {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const lt = source.indexOf("<", index);
    if (lt < 0) {
      out += source.slice(index);
      break;
    }
    out += source.slice(index, lt);
    index = lt;
    // 注释 / CDATA / DOCTYPE / 处理指令：整体丢弃
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", index) || source.startsWith("<?", index)) {
      const end = source.indexOf(">", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    TAG_START_RE.lastIndex = index;
    const start = TAG_START_RE.exec(source);
    if (!start) {
      out += "<";
      index += 1;
      continue;
    }
    const tagEnd = findTagEnd(source, index + start[0].length);
    if (tagEnd < 0) {
      out += "<";
      index += 1;
      continue;
    }
    const name = start[2].toLowerCase();
    const closing = start[1] === "/";
    if (DROP_TAGS.has(name)) {
      index = closing
        ? tagEnd + 1
        : findClosingTagEnd(source, name, tagEnd + 1);
      continue;
    }
    if (!KEEP_TAGS.has(name)) {
      // 未知标签：丢弃标签本身，内容照常保留
      index = tagEnd + 1;
      continue;
    }
    if (closing) {
      out += `</${name}>`;
      index = tagEnd + 1;
      continue;
    }
    const body = source
      .slice(index + start[0].length, tagEnd)
      .replace(/\/$/, "");
    out += `<${name}${rewriteAttributes(name, body, imageBaseDir)}>`;
    index = tagEnd + 1;
  }
  return out;
};

/** 把一块渲染结果里的原始 HTML 占位节点替换为净化后的标记。 */
export const expandRawHtmlPlaceholders = (
  html: string,
  imageBaseDir?: string,
): string =>
  html.replace(RAW_HTML_PLACEHOLDER_RE, (_match, encoded: string) => {
    let source: string;
    try {
      source = decodeURIComponent(encoded);
    } catch {
      return "";
    }
    return sanitizeRawHtml(source, imageBaseDir);
  });
