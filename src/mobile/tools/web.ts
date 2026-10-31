/**
 * web 工具族卡片：网络与媒体类工具调用（搜索 / 抓取 / 绘图 / 内置浏览器）。
 *
 * 归口工具：
 * - 精确名 `websearch-websearch-search` → 网页搜索卡片（query + 结果条目列表）；
 * - 精确名 `websearch-websearch-fetch`  → 网页抓取卡片（URL + 正文预览 / 图片结果）；
 * - 精确名 `imagegen-generate`         → 图像生成卡片（参数 + 生成状态 + 图片区）；
 * - 前缀 `browser-`                     → 内置浏览器卡片（18 个操作，见 BROWSER_OPS）；
 * - 前缀 `anysearch-` / `anysearch_`    → Anysearch（外部 MCP）检索卡片（search /
 *                                          extract / batch-search / get-sub-domains，
 *                                          结果正文为 markdown，解析见 parse* 系列）。
 *
 * ── 图片可达性（重要结论，勿单方面改动） ──────────────────────────────────
 * 远控桥对工具字段只脱敏、不截断（arguments / result / streaming* 全量下发，
 * 见 RemoteControlBridge.tsx + remoteControlRedaction.ts）：内联 base64 会完整
 * 抵达手机；脱敏会替换密钥类字面量（可能破坏 base64 载荷），因此可达性判据
 * 集中在 resolveImageSrc()：载荷必须是完整的 data URL（CSP 的 img-src 放行
 * data:，外链 https 一律被拦）且 base64 长度为 4 的整数倍。移动端的图片端点有
 * 两个：`/api/message-images/{messageId}/{index}` 只服务**用户消息** contentBlocks
 * 的附件；`/api/upload-images/{date}/{file}` 服务桌面端 Rust 落盘的工具结果图
 * （截图 / 抓取图，标签或图片块里是 `upload/…` 路径），均在 native/src/remote_control/
 * server.rs。图库引用（image/…）需要主进程 IPC，移动端读不到。不可达的图片一律
 * 给明确提示 + 替代信息，绝不渲染破图。
 *
 * 其他约定：数据一律 createElement + textContent（不拼 innerHTML）；URL 只做
 * 纯文本展示（不做外跳链接）；未登记的操作 / 无法解析的输入返回 null 交给兜底卡。
 */
import type { SnowRemoteToolCall } from "../../renderer/types/remoteControl";
import { t } from "../i18n";
import { iconMarkup, type MobileIconName } from "../icons";
import type { ToolModule } from "./types";
import {
  argsSummary,
  createToolNode,
  decodeEscapedNewlines,
  parseJsonRecord,
  resolveStatus,
  tcBadge,
  tcErrorRow,
  tcKv,
  tcPre,
  tcSection,
  type JsonRecord,
  uploadImageUrl,
} from "./ui";

/** 本模块词条（remote.toolCall.web.*，三语同键）。 */
const tr = (key: string, values?: Record<string, string | number>): string =>
  t(`remote.toolCall.web.${key}`, values);

/** 框架公共词条（remote.toolCall.common.*）。 */
const tc = (key: string, values?: Record<string, string | number>): string =>
  t(`remote.toolCall.common.${key}`, values);

// ── 解析小工具（类型不符即视为缺失，半截 JSON 也能部分渲染） ───────────────

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: JsonRecord, key: string): string | undefined =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;

const readNumber = (record: JsonRecord, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const readBoolean = (record: JsonRecord, key: string): boolean | undefined =>
  typeof record[key] === "boolean" ? (record[key] as boolean) : undefined;

const readArray = (record: JsonRecord, key: string): unknown[] | undefined =>
  Array.isArray(record[key]) ? (record[key] as unknown[]) : undefined;

/** 数组里的脏元素（非对象）直接丢弃。 */
const records = (values?: unknown[]): JsonRecord[] =>
  (values ?? []).filter(isRecord);

/** 可空字段：空串与缺省一律视为「无」。 */
const optional = (value?: string): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/** 单行截断（多行内容交给 tcPre / 模块自身折行）。 */
const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** URL → host（解析失败原样返回）。 */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** `browser-1751234567890-a1b2c3d4` → `#a1b2c3d4`（完整 ID 放 title）。 */
const shortId = (instanceId: string): string => {
  const tail = instanceId.split("-").pop();
  return tail ? `#${tail}` : instanceId;
};

// ── DOM 小工具 ─────────────────────────────────────────────────────────────

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 图标占位（只承载 lucide 静态标记，不含任何数据）。 */
const iconSpan = (name: MobileIconName, className: string): HTMLSpanElement => {
  const span = el("span", className);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkup(name);
  return span;
};

const textSpan = (className: string, text: string): HTMLSpanElement =>
  el("span", className, text);

const monoEl = (text: string): HTMLElement => el("code", "tc-web-mono", text);

/** 徽章（可带图标 / 色调）。 */
const badge = (
  text: string,
  options?: {
    icon?: MobileIconName;
    variant?: "ok" | "warn" | "err" | "muted";
  },
): HTMLElement => {
  const node = tcBadge(text, options?.variant);
  if (options?.icon) node.prepend(iconSpan(options.icon, "tc-web-ico"));
  return node;
};

/** 参数行：label + 等宽值。 */
const kv = (label: string, value: string, isMono = false): HTMLElement => {
  const row = tcKv(label, value);
  if (isMono) row.querySelector(".tc-kv-value")?.classList.add("tc-web-mono");
  return row;
};

const paramsHost = (...children: Node[]): HTMLElement => {
  const host = el("div", "tc-web-params");
  host.append(...children);
  return host;
};

const flagsHost = (...children: Node[]): HTMLElement => {
  const host = el("div", "tc-web-flags");
  host.append(...children);
  return host;
};

/** 提示 / 空态 / 进行中：图标 + 文案。 */
const noteRow = (
  kind: "note" | "empty" | "progress",
  icon: MobileIconName,
  text: string,
): HTMLElement => {
  const row = el("div", `tc-web-${kind}`);
  row.append(iconSpan(icon, "tc-web-ico"), textSpan("tc-web-note-text", text));
  return row;
};

/** 次要说明行（无图标，弱化色）。 */
const hintRow = (text: string): HTMLElement => el("div", "tc-web-hint", text);

/** 警告行（部分失败 / 受限提示）。 */
const warnRow = (text: string): HTMLElement => {
  const row = el("div", "tc-web-warn");
  row.append(
    iconSpan("shield-alert", "tc-web-ico"),
    textSpan("tc-web-note-text", text),
  );
  return row;
};

/** 操作行：图标 + 标签 + 值 / 片段（浏览器族与参数共用）。 */
const opRow = (
  icon: MobileIconName,
  label: string,
  value?: string,
  isMono = false,
): HTMLElement => {
  const row = el("div", "tc-web-op");
  row.append(iconSpan(icon, "tc-web-ico"), textSpan("tc-web-op-label", label));
  if (value !== undefined && value !== "") {
    const node = isMono ? monoEl(value) : textSpan("tc-web-op-value", value);
    node.title = value;
    row.append(node);
  }
  return row;
};

const section = (
  label: string,
  content: Node,
  opts?: { icon?: MobileIconName; meta?: (Node | string)[] },
): HTMLElement => tcSection(label, content, opts);

// ── 折叠行列表（协议见 ui.ts 顶部注释） ────────────────────────────────────

/** 行列表折叠阈值：行数超过它才挂 .tc-fold。 */
const FOLD_ROWS = 10;

/**
 * 双文案折叠按钮：显隐由 base.css 按 `.tc-fold.tc-expanded` 切换
 * （.tc-more-show / .tc-more-hide），展开态由 timeline.ts 的 .tc-more 委托切换。
 */
const moreButton = (expandLabel: string): HTMLButtonElement => {
  const button = el("button", "tc-more");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.append(
    textSpan("tc-more-show", expandLabel),
    textSpan("tc-more-hide", tc("collapse")),
    iconSpan("chevron-down", "tc-more-icon"),
  );
  return button;
};

/** 行列表：超过 FOLD_ROWS 行挂折叠，高度用 --tc-fold-lines 表达（base.css 消费）。 */
const rowList = (rows: Node[], className = "tc-web-list"): HTMLElement => {
  const host = el("div", className);
  const body = el("div", "tc-fold-body");
  body.append(...rows);
  if (rows.length <= FOLD_ROWS) {
    host.append(body);
    return host;
  }
  host.classList.add("tc-fold");
  host.style.setProperty("--tc-fold-lines", String(FOLD_ROWS));
  host.append(body, moreButton(tr("more", { count: rows.length - FOLD_ROWS })));
  return host;
};

// ── 图片可达性 ─────────────────────────────────────────────────────────────

/** 候选图：data 可以是完整 data URL、纯 base64、upload/ 落盘路径，或（占位场景下）空串。 */
type RemoteImage = {
  data: string;
  mimeType?: string;
  /** 磁盘引用：upload/… 经远控端点读取；图库 image/… 需要主进程 IPC，不可直接读取。 */
  path?: string;
};

/** base64 载荷：标准字母表，长度必须是 4 的整数倍（脱敏会破坏这条）。 */
const DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/i;

/**
 * 图片可达性判定：返回可直接用于 <img src> 的地址，不可达返回 null。
 * upload/ 落盘路径走远控取图端点；其余判据（任一不满足即不可达）：
 *   1. 载荷形如完整 data URL（CSP 的 img-src 放行 data:，外链 https 不放行）；
 *   2. 载荷非空且长度为 4 的整数倍（脱敏插入的 [REDACTED…] 会破坏 base64）。
 */
const resolveImageSrc = (image: RemoteImage): string | null => {
  const uploaded = uploadImageUrl(image.data) ?? uploadImageUrl(image.path);
  if (uploaded) return uploaded;
  const raw = image.data.trim();
  if (raw === "") return null;
  const dataUrl = raw.startsWith("data:")
    ? raw
    : `data:${image.mimeType ?? "image/png"};base64,${raw}`;
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return null;
  return match[1].length % 4 === 0 ? dataUrl : null;
};

/** 不可达图片的占位：序号 + 可交代的替代信息（格式 / 图库引用）。 */
const imagePlaceholder = (index: number, image: RemoteImage): HTMLElement => {
  const box = el("div", "tc-web-img-void");
  box.append(
    iconSpan("image", "tc-web-ico"),
    textSpan("tc-web-img-index", `#${index + 1}`),
  );
  const detail = [image.mimeType, image.path].filter(Boolean).join(" · ");
  if (detail) box.append(textSpan("tc-web-img-detail", detail));
  return box;
};

/** 图片区：可确认渲染的走 img.tc-image（灯箱已由 timeline 接入），否则给明确提示。 */
const imageArea = (images: RemoteImage[]): HTMLElement => {
  const host = el("div", "tc-web-images");
  const grid = el("div", "tc-web-img-grid");
  if (images.length > 1) grid.classList.add("tc-web-img-grid--multi");
  let blocked = 0;
  images.forEach((image, index) => {
    const src = resolveImageSrc(image);
    if (!src) {
      blocked += 1;
      grid.append(imagePlaceholder(index, image));
      return;
    }
    const img = el("img", "tc-image tc-web-img");
    img.src = src;
    img.loading = "lazy";
    img.alt = tr("image.alt", { index: index + 1 });
    grid.append(img);
  });
  host.append(grid);
  if (blocked > 0) {
    host.append(noteRow("note", "image", tr("image.unavailable")));
    host.append(hintRow(tr("image.unavailableHint")));
  }
  return host;
};

// ── websearch-websearch-search ─────────────────────────────────────────────

/** 结果条目展示上限（其余以「已省略 N 条」提示，避免长列表淹没时间线）。 */
const MAX_SEARCH_ITEMS = 8;

type SearchItem = {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
};

type SearchResult =
  | {
      kind: "ok";
      items: SearchItem[];
      total: number;
      engineNames: string[];
      blockedCount: number;
      blockedItems: SearchItem[];
      blockedPatterns: string[];
      blockNote?: string;
    }
  | { kind: "error"; message: string }
  | { kind: "raw"; text: string }
  | { kind: "none" };

/** 结果条目：title + url 是硬性要求，缺一即丢弃（与桌面 WebSearchToolCall 一致）。 */
const searchItems = (values: unknown[]): SearchItem[] =>
  records(values)
    .map((item): SearchItem | null => {
      const title = readString(item, "title");
      const url = readString(item, "url");
      if (title === undefined || url === undefined) return null;
      return {
        title,
        url,
        snippet: readString(item, "snippet") ?? "",
        displayUrl: readString(item, "displayUrl") ?? "",
      };
    })
    .filter((item): item is SearchItem => item !== null);

const parseSearchResult = (raw?: string): SearchResult => {
  if (!raw) return { kind: "none" };
  const record = parseJsonRecord(raw);
  if (!record) return { kind: "raw", text: raw };

  const error = readString(record, "error");
  if (error) return { kind: "error", message: error };

  const values = readArray(record, "results");
  if (values) {
    const items = searchItems(values);
    return {
      kind: "ok",
      items,
      total: readNumber(record, "totalResults") ?? items.length,
      engineNames: (readArray(record, "engineNames") ?? []).filter(
        (name): name is string => typeof name === "string",
      ),
      blockedCount: readNumber(record, "blockedCount") ?? 0,
      blockedItems: searchItems(readArray(record, "blockedResults") ?? []),
      blockedPatterns: (readArray(record, "blockedPatterns") ?? []).filter(
        (pattern): pattern is string => typeof pattern === "string",
      ),
      blockNote: optional(readString(record, "blockNote")),
    };
  }

  const message = readString(record, "message");
  if (message) return { kind: "error", message };
  return { kind: "raw", text: raw };
};

/** 搜索条目：序号 + 标题 + URL/host（纯文本，不做外跳）+ 摘要。 */
const searchItemEl = (item: SearchItem, index: number): HTMLElement => {
  const card = el("div", "tc-web-item");
  const head = el("div", "tc-web-item-head");
  head.append(textSpan("tc-web-item-index", String(index + 1)));
  const title = textSpan("tc-web-item-title", item.title);
  title.title = item.title;
  head.append(title);
  card.append(head);

  const url = item.displayUrl || item.url;
  const urlEl = textSpan("tc-web-item-url", url || item.url);
  urlEl.title = item.url;
  urlEl.prepend(iconSpan("link", "tc-web-ico"));
  card.append(urlEl);

  if (item.snippet) card.append(el("p", "tc-web-item-snippet", item.snippet));
  return card;
};

/** 条目展示上限见 MAX_SEARCH_ITEMS：参数与结果都无法解析时没有结构化信息可展示。 */
const renderSearch = (tool: SnowRemoteToolCall): HTMLElement | null => {
  const args = parseJsonRecord(tool.arguments);
  const result = parseSearchResult(tool.result);
  if (!args && result.kind === "raw") return null; // 交给兜底卡展示原文
  const query = args ? optional(readString(args, "query")) : undefined;
  const maxResults = args ? readNumber(args, "maxResults") : undefined;
  const body = document.createDocumentFragment();

  const params: Node[] = [];
  if (query) params.push(kv(tr("label.query"), query, true));
  if (maxResults !== undefined) {
    params.push(kv(tr("label.maxResults"), String(maxResults)));
  }
  if (params.length) body.append(paramsHost(...params));

  if (result.kind === "error") {
    body.append(tcErrorRow(result.message));
  } else if (result.kind === "raw") {
    body.append(
      section(tc("result"), tcPre(decodeEscapedNewlines(result.text))),
    );
  } else if (result.kind === "none") {
    body.append(
      noteRow(
        "note",
        "search",
        tool.status === "running"
          ? tr("search.searching")
          : tr("search.waiting"),
      ),
    );
  } else if (result.items.length === 0) {
    body.append(noteRow("empty", "search", tr("search.noResults")));
  } else {
    const shown = result.items.slice(0, MAX_SEARCH_ITEMS);
    const rows: Node[] = shown.map(searchItemEl);
    if (result.items.length > shown.length) {
      rows.push(
        hintRow(
          tr("search.omitted", { count: result.items.length - shown.length }),
        ),
      );
    }
    body.append(
      section(tr("search.results"), rowList(rows), {
        icon: "search",
        meta: [badge(tr("search.resultCount", { count: result.total }))],
      }),
    );
    body.append(hintRow(tr("search.linkHint")));

    const blockedRows: Node[] = result.blockedItems.map((item, index) => {
      const row = searchItemEl(item, index);
      row.classList.add("tc-web-item--blocked");
      return row;
    });
    if (result.blockedPatterns.length > 0) {
      blockedRows.push(
        opRow(
          "regex",
          tr("search.blockedRules"),
          result.blockedPatterns.join(" · "),
        ),
      );
    }
    if (result.blockNote) blockedRows.push(hintRow(result.blockNote));
    if (blockedRows.length > 0) {
      body.append(
        section(tr("search.blockedTitle"), rowList(blockedRows), {
          icon: "shield-alert",
          meta: [
            badge(tr("search.blocked", { count: result.blockedCount }), {
              variant: "warn",
            }),
          ],
        }),
      );
    }
  }

  const meta: HTMLElement[] = [];
  if (result.kind === "ok") {
    if (result.engineNames.length > 0) {
      meta.push(badge(result.engineNames.join(" · "), { variant: "muted" }));
    }
    if (result.items.length > 0) {
      meta.push(
        badge(tr("search.resultCount", { count: result.total }), {
          variant: result.total > 0 ? "ok" : "muted",
        }),
      );
    }
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("search.name"),
    display: query || argsSummary(tool.arguments),
    displayTitle: query || undefined,
    meta,
    className: "tc-web-search",
    bodyClass: "tc-web",
    body,
  });
};

// ── websearch-websearch-fetch ──────────────────────────────────────────────

type FetchedImage = { data: string; mimeType: string; path?: string };

type FetchResult =
  | {
      kind: "ok";
      url: string;
      title: string;
      content: string;
      textLength: number;
      contentPreview: string;
      image: FetchedImage | null;
      truncated: boolean;
    }
  | { kind: "error"; message: string }
  | { kind: "raw"; text: string }
  | { kind: "none" };

/** 后端在正文里插入的截断标记（见 native/src/mcp/servers/websearch.rs）。 */
const CONTENT_TRUNCATION_MARKER = "[Content truncated...]";

/** HTML 抓取返回字符串正文；图片抓取返回 [{text}, {image}] 内容块数组。 */
const parseFetchResult = (raw?: string): FetchResult => {
  if (!raw) return { kind: "none" };
  const record = parseJsonRecord(raw);
  if (!record) return { kind: "raw", text: raw };

  const error = readString(record, "error");
  if (error) return { kind: "error", message: error };

  const url = readString(record, "url");
  if (url === undefined) return { kind: "raw", text: raw };

  let content = "";
  let image: FetchedImage | null = null;
  const rawContent = record.content;
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    for (const block of records(rawContent)) {
      if (block.type === "text" && typeof block.text === "string") {
        content = content ? `${content}\n${block.text}` : block.text;
      } else if (block.type === "image") {
        const mimeType = readString(block, "mimeType");
        const data = readString(block, "data");
        if (mimeType !== undefined && data !== undefined)
          image = { data, mimeType, path: optional(readString(block, "path")) };
      }
    }
  }

  return {
    kind: "ok",
    url,
    title: readString(record, "title") ?? "",
    content: decodeEscapedNewlines(content),
    textLength: readNumber(record, "textLength") ?? content.length,
    contentPreview: readString(record, "contentPreview") ?? "",
    image,
    truncated: content.includes(CONTENT_TRUNCATION_MARKER),
  };
};

const renderFetch = (tool: SnowRemoteToolCall): HTMLElement | null => {
  const args = parseJsonRecord(tool.arguments);
  const result = parseFetchResult(tool.result);
  if (!args && result.kind === "raw") return null; // 交给兜底卡展示原文
  const argUrl = args ? optional(readString(args, "url")) : undefined;
  const maxLength = args ? readNumber(args, "maxLength") : undefined;
  const targetUrl = result.kind === "ok" ? result.url : (argUrl ?? "");
  const body = document.createDocumentFragment();

  const params: Node[] = [];
  if (argUrl) params.push(kv(tr("label.url"), argUrl, true));
  if (maxLength !== undefined)
    params.push(kv(tr("label.maxLength"), String(maxLength)));
  if (params.length) body.append(paramsHost(...params));

  if (result.kind === "error") {
    body.append(tcErrorRow(result.message));
  } else if (result.kind === "raw") {
    body.append(
      section(tc("result"), tcPre(decodeEscapedNewlines(result.text))),
    );
  } else if (result.kind === "none") {
    body.append(
      noteRow(
        "note",
        "link",
        tool.status === "running" ? tr("fetch.fetching") : tr("fetch.waiting"),
      ),
    );
  } else {
    const page = el("div", "tc-web-page");
    const head = el("div", "tc-web-page-title");
    head.append(
      iconSpan(result.image ? "image" : "file", "tc-web-ico"),
      textSpan("tc-web-page-text", result.title || hostOf(result.url)),
    );
    page.append(head);
    const urlRow = el("div", "tc-web-page-row");
    const urlEl = textSpan("tc-web-item-url", result.url);
    urlEl.title = result.url;
    urlEl.prepend(iconSpan("link", "tc-web-ico"));
    urlRow.append(urlEl);
    page.append(urlRow);
    body.append(page);

    if (result.image) {
      body.append(
        section(tr("fetch.fetchedImage"), imageArea([result.image]), {
          icon: "image",
        }),
      );
      if (result.content) body.append(tcPre(result.content));
    } else {
      const preview = result.contentPreview || result.content;
      if (preview) {
        body.append(
          section(tr("fetch.preview"), tcPre(preview), { icon: "file" }),
        );
      } else {
        body.append(noteRow("empty", "file", tr("fetch.noContent")));
      }
      if (result.content && result.content !== preview) {
        body.append(
          section(tr("fetch.fullContent"), tcPre(result.content), {
            icon: "file",
            meta: result.truncated
              ? [badge(tr("fetch.contentTruncated"), { variant: "warn" })]
              : [],
          }),
        );
      }
    }
  }

  const meta: HTMLElement[] = [];
  if (result.kind === "ok") {
    meta.push(
      result.image
        ? badge(tr("fetch.fetchedImage"), { icon: "image" })
        : badge(tc("charCount", { count: result.textLength.toLocaleString() })),
    );
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("fetch.name"),
    display: targetUrl ? hostOf(targetUrl) : argsSummary(tool.arguments),
    displayTitle: targetUrl || undefined,
    meta,
    className: "tc-web-fetch",
    bodyClass: "tc-web",
    body,
  });
};

// ── imagegen-generate ──────────────────────────────────────────────────────

type ImageGenArgs = {
  prompt: string;
  prompts?: string[];
  provider?: string;
  model?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  outputCompression?: number;
  n?: number;
  seed?: number;
  personGeneration?: string;
  inputFidelity?: string;
  background?: string;
  moderation?: string;
  thinkingLevel?: string;
  webSearch?: boolean;
  imageSearch?: boolean;
  stream?: boolean;
  /** 参考图张数（顶层 images，或 requestImages 的首组）。 */
  refCount: number;
  /** 逐请求参考图组数（>0 时首组已计入 refCount）。 */
  refGroups: number;
};

type GenImage = { data: string; mimeType: string; path?: string };

type ImageGenResult =
  | {
      kind: "ok";
      imageCount: number;
      images: GenImage[];
      inlineDataUrls: string[];
      remoteUrls: string[];
      contentPreview: string;
    }
  | { kind: "error"; message: string }
  | { kind: "raw"; text: string }
  | { kind: "none" };

/** 持久化时 image block 的 base64 被占位符替换，图片追加为 `@@image:…@@`（data URL 或 upload/ 路径）。 */
const INLINE_IMAGE_TAG_RE = /@@image:([^@]+)@@/g;

const PLACEHOLDER_DATA = "[attached as multimodal image]";

const parseImageGenArgs = (raw?: string): ImageGenArgs | null => {
  const record = parseJsonRecord(raw);
  if (!record) return null;
  const prompt = readString(record, "prompt");
  if (prompt === undefined || prompt.trim() === "") return null;

  const prompts = (readArray(record, "prompts") ?? []).filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  const images = readArray(record, "images") ?? [];
  const requestImages = readArray(record, "requestImages") ?? [];
  const firstGroup = Array.isArray(requestImages[0]) ? requestImages[0] : [];
  const refGroups = requestImages.length;
  const refCount = refGroups > 0 ? firstGroup.length : images.length;

  return {
    prompt,
    prompts: prompts.length > 0 ? prompts : undefined,
    provider: optional(readString(record, "provider")),
    model: optional(readString(record, "model")),
    size: optional(readString(record, "size")),
    quality: optional(readString(record, "quality")),
    outputFormat: optional(readString(record, "outputFormat")),
    outputCompression: readNumber(record, "outputCompression"),
    n: readNumber(record, "n"),
    seed: readNumber(record, "seed"),
    personGeneration: optional(readString(record, "personGeneration")),
    inputFidelity: optional(readString(record, "inputFidelity")),
    background: optional(readString(record, "background")),
    moderation: optional(readString(record, "moderation")),
    thinkingLevel: optional(readString(record, "thinkingLevel")),
    webSearch: readBoolean(record, "webSearch"),
    imageSearch: readBoolean(record, "imageSearch"),
    stream: readBoolean(record, "stream"),
    refCount,
    refGroups,
  };
};

const parseImageGenResult = (raw?: string): ImageGenResult => {
  if (!raw) return { kind: "none" };

  const inlineDataUrls: string[] = [];
  const stripped = raw
    .replace(INLINE_IMAGE_TAG_RE, (_match, dataUrl: string) => {
      inlineDataUrls.push(dataUrl);
      return "";
    })
    .trim();

  const record = parseJsonRecord(stripped);
  if (!record) return { kind: "raw", text: raw };

  const error = readString(record, "error");
  if (error) return { kind: "error", message: error };

  const images: GenImage[] = [];
  for (const block of records(readArray(record, "content"))) {
    if (block.type !== "image") continue;
    const mimeType = readString(block, "mimeType");
    if (mimeType === undefined) continue;
    images.push({
      data: readString(block, "data") ?? "",
      mimeType,
      path: optional(readString(block, "path")),
    });
  }

  const remoteUrls = (readArray(record, "remoteUrls") ?? []).filter(
    (url): url is string => typeof url === "string" && url.trim() !== "",
  );

  if (images.length === 0 && remoteUrls.length === 0) {
    return { kind: "raw", text: raw };
  }

  return {
    kind: "ok",
    imageCount:
      readNumber(record, "imageCount") ?? images.length + remoteUrls.length,
    images,
    inlineDataUrls,
    remoteUrls,
    contentPreview: readString(record, "contentPreview") ?? "",
  };
};

/**
 * 结果图 → 候选图：data 为占位符 / 空时按序号取回 `@@image:…@@` 里的真实
 * data URL（与桌面 imagegenUtils.parseImageGenResult 的还原策略一致）。
 */
const toRemoteImages = (
  images: GenImage[],
  inlineDataUrls: string[],
): RemoteImage[] =>
  images.map((image, index) => {
    const data = image.data.trim();
    const placeholder = data === "" || data === PLACEHOLDER_DATA;
    return {
      data: placeholder ? (inlineDataUrls[index] ?? "") : data,
      mimeType: image.mimeType,
      path: image.path,
    };
  });

/** 生图参数标签（与桌面 imagegenUtils 解析出的字段一一对应）。 */
const imageGenFlags = (args: ImageGenArgs): HTMLElement[] => {
  const flags: HTMLElement[] = [];
  const push = (key: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    flags.push(badge(`${tr(`imagegen.param.${key}`)}: ${value}`));
  };
  push("provider", args.provider);
  push("model", args.model);
  push("size", args.size);
  push("quality", args.quality);
  push("outputFormat", args.outputFormat);
  push("outputCompression", args.outputCompression);
  push("count", args.n !== undefined && args.n > 1 ? args.n : undefined);
  push("seed", args.seed);
  push("personGeneration", args.personGeneration);
  push("inputFidelity", args.inputFidelity);
  push("background", args.background);
  push("moderation", args.moderation);
  push("thinkingLevel", args.thinkingLevel);
  if (args.webSearch === true)
    flags.push(badge(tr("imagegen.param.webSearch")));
  if (args.imageSearch === true)
    flags.push(badge(tr("imagegen.param.imageSearch")));
  if (args.stream === true) flags.push(badge(tr("imagegen.param.stream")));
  if (args.refCount > 0) {
    flags.push(
      badge(
        tr("imagegen.refImages", { count: args.refCount }) +
          (args.refGroups > 0
            ? ` · ${tr("imagegen.refGroups", { count: args.refGroups })}`
            : ""),
        { icon: "image-plus" },
      ),
    );
  }
  return flags;
};

/** 提示词文本：多个提示词逐条编号，单提示词原样。 */
const promptsText = (args: ImageGenArgs): string =>
  args.prompts && args.prompts.length > 0
    ? args.prompts.map((item, index) => `${index + 1}. ${item}`).join("\n\n")
    : args.prompt;

/**
 * 生图失败原因分类：后端错误串是英文自由文本（含上游 API 原文与修复建议），
 * 这里只把它归入有限类别用于本地化标题，详情仍原样展示（不丢信息）。
 */
const ERROR_RULES: [string, string[]][] = [
  ["timeout", ["timed out", "timeout", "deadline exceeded", "took too long"]],
  [
    "auth",
    [
      "401",
      "403",
      "unauthorized",
      "api key",
      "invalid api key",
      "permission denied",
    ],
  ],
  [
    "rateLimit",
    ["429", "rate limit", "too many requests", "quota", "insufficient"],
  ],
  [
    "contentFiltered",
    ["content filter", "safety", "moderation", "blocked", "policy"],
  ],
  [
    "server",
    ["500", "502", "503", "504", "internal server", "service unavailable"],
  ],
  [
    "network",
    ["connection", "dns", "tls", "ssl", "certificate", "reset by peer"],
  ],
  [
    "invalidParams",
    ["400", "bad request", "invalid", "is required", "not supported"],
  ],
];

const classifyImageGenError = (message: string): string => {
  const lower = message.toLowerCase();
  for (const [kind, keywords] of ERROR_RULES) {
    if (keywords.some((keyword) => lower.includes(keyword))) return kind;
  }
  return "fallback";
};

/** 错误块：本地化类别标题 + 后端原始详情。 */
const imageGenErrorBlock = (message: string): HTMLElement => {
  const wrap = el("div", "tc-web-error");
  wrap.append(
    el(
      "div",
      "tc-web-error-title",
      tr(`imagegen.error.${classifyImageGenError(message)}`),
    ),
    tcErrorRow(message),
  );
  return wrap;
};

/** 部分失败摘要：contentPreview 尾部由 Rust 追加的「X/Y parallel requests failed: …」。 */
const partialFailure = (preview: string): string => {
  const match = /(\d+\/\d+ parallel requests failed: [\s\S]*)$/.exec(preview);
  return match ? match[1] : "";
};

const renderImageGen = (tool: SnowRemoteToolCall): HTMLElement | null => {
  const args = parseImageGenArgs(tool.arguments);
  const result = parseImageGenResult(tool.result);
  if (!args && result.kind === "raw") return null; // 交给兜底卡展示原文
  const prompt = args?.prompt ?? "";
  const body = document.createDocumentFragment();

  if (args) {
    body.append(
      section(tr("imagegen.prompt"), tcPre(promptsText(args)), {
        icon: "sparkles",
      }),
    );
    const flags = imageGenFlags(args);
    if (flags.length > 0) body.append(flagsHost(...flags));
  }

  if (result.kind === "error") {
    body.append(imageGenErrorBlock(result.message));
  } else if (result.kind === "raw") {
    body.append(section(tc("result"), tcPre(result.text)));
  } else if (result.kind === "none") {
    body.append(
      noteRow(
        "progress",
        "loader-circle",
        tool.status === "running"
          ? tr("imagegen.generating")
          : tr("imagegen.waiting"),
      ),
    );
    body.append(hintRow(tr("imagegen.noStreamPreview")));
  } else {
    const images = toRemoteImages(result.images, result.inlineDataUrls);
    if (images.length > 0) {
      body.append(
        section(tr("imagegen.images"), imageArea(images), {
          icon: "image",
          meta: [badge(tr("imagegen.count", { count: result.imageCount }))],
        }),
      );
    } else {
      body.append(noteRow("empty", "image", tr("imagegen.noImages")));
    }

    const failure = partialFailure(result.contentPreview);
    if (failure)
      body.append(warnRow(`${tr("imagegen.partialFailed")} ${failure}`));

    if (result.remoteUrls.length > 0) {
      const list = el("div", "tc-web-links");
      for (const url of result.remoteUrls) {
        const node = textSpan("tc-web-link-text", url);
        node.title = url;
        list.append(node);
      }
      body.append(
        section(tr("imagegen.remoteUrls"), list, {
          icon: "link",
          meta: [
            badge(tr("imagegen.remoteBlocked"), {
              variant: "warn",
              icon: "wifi-off",
            }),
          ],
        }),
      );
    }
  }

  const meta: HTMLElement[] = [];
  if (result.kind === "ok") {
    meta.push(
      badge(tr("imagegen.count", { count: result.imageCount }), {
        icon: "image",
        variant: result.imageCount > 0 ? "ok" : "muted",
      }),
    );
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("imagegen.name"),
    display: prompt ? clip(prompt, 56) : argsSummary(tool.arguments),
    displayTitle: prompt || undefined,
    meta,
    className: "tc-web-imagegen",
    bodyClass: "tc-web",
    body,
  });
};

// ── browser-* ──────────────────────────────────────────────────────────────

/**
 * browser 族全部工具名（native/src/mcp/servers/browser/validation.rs 的注册表，
 * 共 20 个；未登记的 browser-* 返回 null 交给兜底卡）。
 */
const BROWSER_OPS = [
  "create",
  "navigate",
  "click",
  "hover",
  "type",
  "fill_form",
  "drag",
  "select_option",
  "press_key",
  "screenshot",
  "wait",
  "devtools",
  "close",
  "focus",
  "list",
  "evaluate",
  "upload-file",
  "back",
  "forward",
  "get_tab_content",
] as const;

type BrowserOp = (typeof BROWSER_OPS)[number];

const isBrowserOp = (value: string): value is BrowserOp =>
  (BROWSER_OPS as readonly string[]).includes(value);

/** 浏览器操作上下文：参数、结果（二选一：error / raw）与内联图片。 */
type BrowserContext = {
  op: BrowserOp;
  args: JsonRecord | null;
  data: JsonRecord | null;
  error: string | null;
  raw: string | null;
  inlineImages: string[];
};

const parseBrowserResult = (
  raw: string | undefined,
): Pick<BrowserContext, "data" | "error" | "raw" | "inlineImages"> => {
  if (!raw) {
    return {
      data: null,
      error: null,
      raw: null,
      inlineImages: [],
    };
  }
  const inlineImages: string[] = [];
  const text = raw
    .replace(INLINE_IMAGE_TAG_RE, (_match, dataUrl: string) => {
      inlineImages.push(dataUrl);
      return "";
    })
    .trim();
  const record = parseJsonRecord(text);
  if (!record) {
    return {
      data: null,
      error: null,
      raw: text,
      inlineImages,
    };
  }
  const error = readString(record, "error");
  return {
    data: error ? null : record,
    error: error ?? null,
    raw: null,
    inlineImages,
  };
};

const argStr = (ctx: BrowserContext, key: string): string | undefined =>
  ctx.args ? optional(readString(ctx.args, key)) : undefined;

const argNum = (ctx: BrowserContext, key: string): number | undefined =>
  ctx.args ? readNumber(ctx.args, key) : undefined;

const outStr = (ctx: BrowserContext, key: string): string | undefined =>
  ctx.data ? optional(readString(ctx.data, key)) : undefined;

const outNum = (ctx: BrowserContext, key: string): number | undefined =>
  ctx.data ? readNumber(ctx.data, key) : undefined;

type ClickedElement = {
  tagName: string;
  id: string | null;
  text: string;
  href: string | null;
};

const parseElement = (value: unknown): ClickedElement | null => {
  if (!isRecord(value)) return null;
  return {
    tagName: optional(readString(value, "tagName")) ?? "?",
    id: optional(readString(value, "id")) ?? null,
    text: readString(value, "text") ?? "",
    href: optional(readString(value, "href")) ?? null,
  };
};

const elementRow = (element: ClickedElement): HTMLElement => {
  const row = el("div", "tc-web-op");
  row.append(iconSpan("code", "tc-web-ico"), monoEl(element.tagName));
  if (element.id) row.append(monoEl(`#${element.id}`));
  if (element.text) {
    const text = textSpan("tc-web-op-text", clip(element.text, 80));
    text.title = element.text;
    row.append(text);
  }
  if (element.href) {
    const href = textSpan("tc-web-sub", element.href);
    href.title = element.href;
    row.append(href);
  }
  return row;
};

/** 实例徽章（完整 ID 放 title；手机端无「聚焦标签页」动作）。 */
const instanceChip = (instanceId: string): HTMLElement => {
  const chip = el("span", "tc-web-chip", shortId(instanceId));
  chip.title = instanceId;
  return chip;
};

/** 单行状态条：图标 + 文案 + 附加片段（create / close / focus / wait 等）。 */
const statusRow = (
  icon: MobileIconName,
  label: string,
  ...extras: (Node | string)[]
): HTMLElement => {
  const row = el("div", "tc-web-op tc-web-op--status");
  row.append(iconSpan(icon, "tc-web-ico"), textSpan("tc-web-op-label", label));
  row.append(...extras);
  return row;
};

/** 页面信息卡：标题 + URL（纯文本；手机端不做外跳）+ 实例徽章。 */
const pageCard = (
  title: string,
  url: string,
  instanceId?: string,
): HTMLElement => {
  const card = el("div", "tc-web-page");
  const head = el("div", "tc-web-page-title");
  head.append(
    iconSpan("link", "tc-web-ico"),
    textSpan("tc-web-page-text", title || hostOf(url)),
  );
  card.append(head);
  const row = el("div", "tc-web-page-row");
  if (url) {
    const urlEl = textSpan("tc-web-item-url", url);
    urlEl.title = url;
    row.append(urlEl);
  }
  if (instanceId) row.append(instanceChip(instanceId));
  if (row.childNodes.length > 0) card.append(row);
  return card;
};

/** 目标定位行（选择器 / 文本 / 无障碍引用 / 按键）。 */
const targetRow = (
  icon: MobileIconName,
  parts: (Node | string)[],
): HTMLElement => {
  const row = el("div", "tc-web-op");
  row.append(iconSpan(icon, "tc-web-ico"), ...parts);
  return row;
};

/** 短标签（开关类参数）。 */
const tag = (text: string): HTMLElement => tcBadge(text);

/** 便捷取数：结果记录（可能为 null）。 */
const recordOf = (value: unknown): JsonRecord | null =>
  isRecord(value) ? value : null;

/** evaluate 返回值类型摘要（头部 meta 用）。 */
const describeValue = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
};

/**
 * 半截 JSON 的正文抢救：仅用于兼容历史会话里 result 被旧版远控桥截断成半截
 * JSON 的快照（新版桥全量下发，正常结果可完整解析）——从首个 "text":"…"
 * 文案抽出可展示的正文，避免只看到半截 base64。
 */
const SALVAGED_TEXT_RE = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/;

const salvagedText = (raw: string | null): string | undefined => {
  if (!raw) return undefined;
  const match = SALVAGED_TEXT_RE.exec(raw);
  return match
    ? match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n")
    : undefined;
};

/** devtools snapshot：页面元信息 + 正文 + 链接。 */
const snapshotView = (snapshot: JsonRecord, instanceId?: string): Node[] => {
  const nodes: Node[] = [];
  const url = readString(snapshot, "url") ?? "";
  nodes.push(pageCard(readString(snapshot, "title") ?? "", url, instanceId));

  const viewport = recordOf(snapshot.viewport);
  const documentSize = recordOf(snapshot.document);
  const cells: [string, string][] = [
    [tr("browser.readyState"), readString(snapshot, "readyState") ?? ""],
    [tr("browser.contentType"), readString(snapshot, "contentType") ?? ""],
    [
      tr("browser.viewport"),
      viewport
        ? `${readNumber(viewport, "width") ?? "?"} × ${readNumber(viewport, "height") ?? "?"}`
        : "",
    ],
    [
      tr("browser.documentSize"),
      documentSize
        ? `${readNumber(documentSize, "scrollWidth") ?? "?"} × ${readNumber(documentSize, "scrollHeight") ?? "?"}`
        : "",
    ],
  ];
  const rows = cells
    .filter(([, value]) => value !== "")
    .map(([label, value]) => kv(label, value));
  if (rows.length > 0) nodes.push(paramsHost(...rows));

  const text = readString(snapshot, "text") ?? "";
  if (text) {
    nodes.push(
      section(tr("browser.pageText"), tcPre(text), {
        icon: "file",
        meta: [badge(tc("charCount", { count: text.length.toLocaleString() }))],
      }),
    );
  }

  const links = (readArray(snapshot, "links") ?? [])
    .map(recordOf)
    .filter((link): link is JsonRecord => link !== null)
    .map((link) => ({
      text: readString(link, "text") ?? "",
      href: readString(link, "href") ?? "",
    }))
    .filter((link) => link.href !== "");
  if (links.length > 0) {
    const list = el("div", "tc-web-links");
    for (const link of links) {
      const row = el("div", "tc-web-link-row");
      row.append(textSpan("tc-web-link-text", link.text || hostOf(link.href)));
      row.append(textSpan("tc-web-sub", link.href));
      list.append(row);
    }
    nodes.push(
      section(tr("browser.links"), rowList([list]), {
        icon: "link",
        meta: [badge(String(links.length))],
      }),
    );
  }
  return nodes;
};

/** devtools console：级别 + 消息 + 来源。 */
const consoleView = (messages: unknown[]): Node[] => {
  const rows = messages
    .map(recordOf)
    .filter((item): item is JsonRecord => item !== null)
    .map((item) => {
      const level = readNumber(item, "level") ?? 1;
      const levelKey =
        level <= 0
          ? "verbose"
          : level === 1
            ? "info"
            : level === 2
              ? "warning"
              : "error";
      const row = el("div", `tc-web-row tc-web-console-${levelKey}`);
      row.append(
        textSpan(
          `tc-web-sev tc-web-sev-${levelKey}`,
          tr(`browser.level.${levelKey}`),
        ),
        textSpan("tc-web-row-text", readString(item, "message") ?? ""),
      );
      const sourceId =
        readString(item, "sourceId") ?? readString(item, "url") ?? "";
      const line = readNumber(item, "line");
      if (sourceId) {
        const file = sourceId.split("/").pop() || sourceId;
        row.append(textSpan("tc-web-sub", line ? `${file}:${line}` : file));
      }
      return row;
    });
  if (rows.length === 0)
    return [noteRow("empty", "command", tr("browser.noConsoleMessages"))];
  return [rowList(rows)];
};

/** devtools network：方法 + 状态 + URL + 耗时。 */
const networkView = (requests: unknown[]): Node[] => {
  const rows = requests
    .map((item) => recordOf(recordOf(item)?.record ?? item))
    .filter((item): item is JsonRecord => item !== null)
    .map((item) => {
      const row = el("div", "tc-web-row");
      row.append(tag(readString(item, "method") ?? "?"));
      const status = readNumber(item, "status");
      row.append(
        textSpan(
          "tc-web-status",
          status !== undefined
            ? String(status)
            : (readString(item, "status") ?? "…"),
        ),
      );
      const url = textSpan("tc-web-row-text", readString(item, "url") ?? "");
      url.title = readString(item, "url") ?? "";
      row.append(url);
      const duration = readNumber(item, "durationMs");
      if (duration !== undefined)
        row.append(textSpan("tc-web-sub", `${duration}ms`));
      return row;
    });
  if (rows.length === 0) {
    return [noteRow("empty", "gauge", tr("browser.noNetworkRequests"))];
  }
  return [rowList(rows)];
};

/** devtools network_detail：请求头 / 响应头 / 请求体 / 响应体。 */
const networkDetailView = (data: JsonRecord): Node[] => {
  if (data.found === false) {
    return [
      tcErrorRow(optional(readString(data, "error")) ?? tr("browser.notFound")),
    ];
  }
  const detail = recordOf(data.details) ?? recordOf(data.request) ?? data;
  const nodes: Node[] = [];
  const head = el("div", "tc-web-op");
  head.append(
    tag(readString(detail, "method") ?? "?"),
    textSpan("tc-web-row-text", readString(detail, "url") ?? ""),
  );
  const status = readNumber(detail, "status");
  if (status !== undefined) head.append(tag(String(status)));
  nodes.push(head);

  const headerRows = (label: string, value: unknown): void => {
    const headers = recordOf(value);
    if (!headers) return;
    const rows = Object.entries(headers)
      .slice(0, FOLD_ROWS)
      .map(([key, item]) =>
        kv(key, Array.isArray(item) ? item.join(", ") : String(item)),
      );
    nodes.push(section(label, paramsHost(...rows)));
  };
  headerRows(tr("browser.requestHeaders"), detail.requestHeaders);
  headerRows(tr("browser.responseHeaders"), detail.responseHeaders);

  const requestBody = readString(detail, "requestBody");
  if (requestBody) {
    nodes.push(
      section(
        tr("browser.requestBody"),
        tcPre(decodeEscapedNewlines(requestBody)),
      ),
    );
  }
  const responseBody = recordOf(detail.responseBody);
  const responseText = responseBody
    ? readString(responseBody, "text")
    : undefined;
  if (responseText) {
    nodes.push(
      section(
        tr("browser.responseBody"),
        tcPre(decodeEscapedNewlines(responseText)),
      ),
    );
  }
  const responseError = readString(detail, "responseBodyError");
  if (responseError && !responseText) {
    nodes.push(noteRow("note", "activity", responseError));
  }
  return nodes;
};

/** devtools cookies：名称 + 域 + 值（可能已被脱敏）。 */
const cookiesView = (data: JsonRecord): Node[] => {
  const cookies = readArray(data, "cookies") ?? [];
  const nodes: Node[] = [];
  if (data.masked === true) {
    nodes.push(
      flagsHost(badge(tr("browser.cookiesMasked"), { variant: "warn" })),
    );
  }
  if (cookies.length === 0) {
    nodes.push(noteRow("empty", "database", tr("browser.noCookies")));
    return nodes;
  }
  nodes.push(
    rowList(
      cookies.map((item) => {
        const cookie = recordOf(item) ?? {};
        const row = el("div", "tc-web-row");
        row.append(
          monoEl(readString(cookie, "name") ?? ""),
          textSpan("tc-web-sub", readString(cookie, "domain") ?? ""),
        );
        const value = readString(cookie, "value");
        if (value) {
          const node = textSpan("tc-web-row-text", value);
          node.title = value;
          row.append(node);
        }
        return row;
      }),
    ),
  );
  return nodes;
};

/** devtools dialog：类型 + 文案。 */
const dialogsView = (dialogs: unknown[]): Node[] => {
  if (dialogs.length === 0) {
    return [noteRow("empty", "message-square-plus", tr("browser.noDialogs"))];
  }
  return [
    rowList(
      dialogs.map((item) => {
        const dialog = recordOf(item) ?? {};
        const row = el("div", "tc-web-row");
        row.append(
          tag(
            readString(dialog, "dialogType") ??
              readString(dialog, "type") ??
              "?",
          ),
          textSpan("tc-web-row-text", readString(dialog, "message") ?? ""),
        );
        return row;
      }),
    ),
  ];
};

/** devtools ax：无障碍树文本行（`- heading "Example" [uid=e1]`）或数组形式。 */
const axView = (data: JsonRecord): Node[] => {
  const nodes: Node[] = [];
  const stats = recordOf(data.stats);
  const raw = data.accessibility;
  const rows: HTMLElement[] = [];
  if (Array.isArray(raw)) {
    for (const item of records(raw)) {
      const row = el("div", "tc-web-row");
      const role = readString(item, "role");
      const name = readString(item, "name") ?? readString(item, "text");
      const uid = readString(item, "uid");
      if (role) row.append(tag(role));
      if (name) row.append(textSpan("tc-web-row-text", name));
      if (uid) row.append(monoEl(uid));
      if (row.childNodes.length > 0) rows.push(row);
    }
  } else if (typeof raw === "string") {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const body = trimmed.startsWith("- ") ? trimmed.slice(2) : trimmed;
      const uidMatch = /\[uid=([^\]]+)\]\s*$/.exec(body);
      const withoutUid = uidMatch
        ? body.slice(0, uidMatch.index).trimEnd()
        : body;
      const nameMatch = /^(.*?)\s+"((?:[^"\\]|\\.)*)"/.exec(withoutUid);
      const row = el("div", "tc-web-row");
      const role = (nameMatch ? nameMatch[1] : withoutUid).trim();
      if (role) row.append(tag(role));
      if (nameMatch) {
        row.append(
          textSpan("tc-web-row-text", nameMatch[2].replace(/\\"/g, '"')),
        );
      }
      if (uidMatch) row.append(monoEl(uidMatch[1]));
      if (row.childNodes.length > 0) rows.push(row);
    }
  }
  if (stats) {
    nodes.push(
      flagsHost(
        badge(
          tr("browser.axNodes", {
            count: readNumber(stats, "emitted") ?? rows.length,
          }),
        ),
        ...(stats.truncated === true
          ? [badge(tr("browser.axTruncated"), { variant: "warn" })]
          : []),
      ),
    );
  }
  if (rows.length > 0) nodes.push(rowList(rows));
  return nodes;
};

/** devtools 各 action 的结果视图。 */
const devtoolsView = (ctx: BrowserContext): Node[] => {
  const data = ctx.data;
  const action = argStr(ctx, "action") ?? "snapshot";
  const instanceId = outStr(ctx, "instanceId");
  const nodes: Node[] = [];
  if (!data) return nodes;

  switch (action) {
    case "snapshot": {
      const snapshot = recordOf(data.snapshot);
      if (snapshot) nodes.push(...snapshotView(snapshot, instanceId));
      break;
    }
    case "console":
      nodes.push(...consoleView(readArray(data, "messages") ?? []));
      break;
    case "network":
      nodes.push(...networkView(readArray(data, "requests") ?? []));
      break;
    case "network_detail":
    case "networkDetails":
      nodes.push(...networkDetailView(data));
      break;
    case "cookies":
      nodes.push(...cookiesView(data));
      break;
    case "ax":
      nodes.push(...axView(data));
      break;
    case "dialog": {
      const dialogs = readArray(data, "dialogs");
      if (dialogs) nodes.push(...dialogsView(dialogs));
      else if (data.responded) {
        nodes.push(
          statusRow("message-square-plus", tr("browser.dialogResponded")),
        );
      }
      break;
    }
    case "network_clear":
      nodes.push(statusRow("x", tr("browser.networkCleared")));
      break;
    case "networkState": {
      const offline = data.state === "offline";
      nodes.push(
        statusRow(
          offline ? "wifi-off" : "activity",
          offline
            ? tr("browser.networkStateOffline")
            : tr("browser.networkStateOnline"),
          tag(String(data.state ?? "")),
        ),
      );
      break;
    }
    case "route": {
      const pattern = readString(recordOf(data.rule) ?? {}, "pattern");
      nodes.push(
        statusRow(
          "git-branch",
          tr("browser.routeActive"),
          ...(pattern ? [tag(pattern)] : []),
        ),
      );
      break;
    }
    case "routeClear":
      nodes.push(statusRow("x", tr("browser.routeCleared")));
      break;
    case "storageSave":
    case "storageRestore": {
      const fileName = readString(recordOf(data.storage) ?? {}, "fileName");
      nodes.push(
        statusRow(
          action === "storageSave" ? "database" : "file",
          action === "storageSave"
            ? tr("browser.storageSaved")
            : tr("browser.storageRestored"),
          ...(fileName ? [tag(fileName)] : []),
        ),
      );
      break;
    }
    case "cookieDelete": {
      const name = readString(data, "name");
      const domain = readString(data, "domain");
      nodes.push(
        statusRow(
          "database",
          tr("browser.cookieDeleted"),
          ...(name ? [tag(name)] : []),
          ...(domain ? [tag(domain)] : []),
        ),
      );
      break;
    }
    case "open":
      nodes.push(statusRow("maximize", tr("browser.devtoolsOpened")));
      break;
    default:
      break;
  }

  if (nodes.length === 0) {
    nodes.push(section(tc("result"), tcPre(JSON.stringify(data, null, 2))));
  }
  return nodes;
};

/** 操作 → 头部摘要 / meta / body（逐操作对齐桌面 BrowserToolCall 的取数规则）。 */
const buildBrowserView = (
  ctx: BrowserContext,
): { display?: string; meta: HTMLElement[]; body: Node[] } => {
  const { op, data, error, inlineImages } = ctx;
  const meta: HTMLElement[] = [];
  const body: Node[] = [];
  let display: string | undefined;

  if (error) body.push(tcErrorRow(error));

  switch (op) {
    case "create": {
      const url = argStr(ctx, "url");
      const instanceId = outStr(ctx, "instanceId");
      const resultUrl = outStr(ctx, "url");
      if (url) body.push(opRow("link", tr("label.url"), url));
      if (data && (instanceId || resultUrl)) {
        body.push(
          statusRow(
            "plus",
            tr("browser.created"),
            ...(instanceId ? [instanceChip(instanceId)] : []),
            ...(resultUrl ? [tag(hostOf(resultUrl))] : []),
          ),
        );
      }
      display = url ? hostOf(url) : tr("browser.newTab");
      break;
    }
    case "navigate": {
      const url = argStr(ctx, "url");
      const timeoutMs = argNum(ctx, "timeoutMs");
      const instanceId = outStr(ctx, "instanceId") ?? argStr(ctx, "instanceId");
      const resultUrl = outStr(ctx, "url");
      if (url) body.push(opRow("link", tr("label.url"), url));
      if (timeoutMs !== undefined) {
        body.push(
          flagsHost(
            badge(`${tr("label.timeout")}: ${timeoutMs.toLocaleString()}ms`),
            ...(argStr(ctx, "instanceId") &&
            argStr(ctx, "instanceId") !== "current"
              ? [badge(shortId(argStr(ctx, "instanceId") as string))]
              : []),
          ),
        );
      }
      if (data) {
        body.push(
          pageCard(
            outStr(ctx, "title") ?? "",
            resultUrl ?? url ?? "",
            instanceId,
          ),
        );
      }
      display = url ? hostOf(url) : undefined;
      const title = outStr(ctx, "title");
      if (title) meta.push(badge(clip(title, 40), { icon: "file" }));
      break;
    }
    case "click":
    case "hover":
    case "select_option": {
      const selector = argStr(ctx, "selector");
      const text = argStr(ctx, "text");
      const element = data ? parseElement(data.element) : null;
      const parts: (Node | string)[] = [];
      if (selector) parts.push(monoEl(selector));
      if (text) parts.push(textSpan("tc-web-op-text", `“${text}”`));
      if (ctx.args && readBoolean(ctx.args, "exact") === true) {
        parts.push(tag(tr("browser.exactMatch")));
      }
      if (parts.length > 0) body.push(targetRow("target", parts));
      if (op === "select_option") {
        const values = (readArray(ctx.args ?? {}, "values") ?? []).filter(
          (value): value is string => typeof value === "string",
        );
        const selected = (readArray(data ?? {}, "selectedOptions") ?? [])
          .map(recordOf)
          .filter((option): option is JsonRecord => option !== null)
          .map(
            (option) =>
              readString(option, "text") || readString(option, "value") || "",
          )
          .filter((value) => value !== "");
        if (values.length > 0) {
          body.push(flagsHost(...values.map((value) => tag(value))));
        }
        if (selected.length > 0) {
          body.push(
            flagsHost(
              ...selected.map((value) => badge(value, { variant: "ok" })),
            ),
          );
        }
      }
      if (op === "hover") {
        const position = recordOf(data?.position);
        const x = position ? readNumber(position, "x") : undefined;
        const y = position ? readNumber(position, "y") : undefined;
        if (x !== undefined && y !== undefined) {
          body.push(statusRow("target", `${tr("label.position")}: ${x}, ${y}`));
        }
      }
      if (element) body.push(elementRow(element));
      if (data && (outStr(ctx, "url") || outStr(ctx, "instanceId"))) {
        body.push(
          pageCard(
            outStr(ctx, "title") ?? "",
            outStr(ctx, "url") ?? "",
            outStr(ctx, "instanceId"),
          ),
        );
      }
      display = selector ?? (text ? `“${clip(text, 44)}”` : undefined);
      if (element) meta.push(badge(element.tagName));
      if (op === "select_option") {
        const selectedCount = (readArray(data ?? {}, "selectedOptions") ?? [])
          .length;
        if (selectedCount > 0) {
          meta.push(
            badge(tr("browser.selectedCount", { count: selectedCount }), {
              icon: "list-checks",
            }),
          );
        }
      }
      break;
    }
    case "type": {
      const selector = argStr(ctx, "selector");
      const ref = argStr(ctx, "ref");
      const text = argStr(ctx, "text");
      const value = argStr(ctx, "value") ?? "";
      const element = data ? parseElement(data.element) : null;
      const parts: (Node | string)[] = [];
      if (selector) parts.push(monoEl(selector));
      else if (ref) parts.push(monoEl(ref));
      if (text) parts.push(textSpan("tc-web-op-text", `“${text}”`));
      if (parts.length > 0) body.push(targetRow("target", parts));
      if (value !== "") {
        body.push(
          opRow("send", tr("label.value"), value, true),
          ...(ctx.args && readBoolean(ctx.args, "submit") === true
            ? [flagsHost(tag(tr("browser.submitted")))]
            : []),
        );
      }
      if (element) body.push(elementRow(element));
      if (data && (outStr(ctx, "url") || outStr(ctx, "instanceId"))) {
        body.push(
          pageCard(
            outStr(ctx, "title") ?? "",
            outStr(ctx, "url") ?? "",
            outStr(ctx, "instanceId"),
          ),
        );
      }
      display = selector ?? ref ?? (text ? `“${clip(text, 44)}”` : undefined);
      if (element) meta.push(badge(element.tagName));
      break;
    }
    case "press_key": {
      const key = outStr(ctx, "key") ?? argStr(ctx, "key");
      if (key) body.push(opRow("command", tr("label.key"), key, true));
      if (data) {
        body.push(
          pageCard(
            outStr(ctx, "title") ?? "",
            outStr(ctx, "url") ?? "",
            outStr(ctx, "instanceId"),
          ),
        );
      }
      display = key;
      if (key) meta.push(badge(key, { icon: "command" }));
      break;
    }
    case "upload-file": {
      const files = (readArray(ctx.args ?? {}, "files") ?? []).filter(
        (file): file is string => typeof file === "string",
      );
      if (files.length > 0) {
        body.push(opRow("chevrons-up", tr("label.files"), files.join(", ")));
      }
      const uploaded = outNum(ctx, "uploaded");
      if (uploaded !== undefined) {
        body.push(
          statusRow(
            "circle-check",
            tr("browser.uploaded", { count: uploaded }),
          ),
        );
      }
      if (data) {
        body.push(
          pageCard(
            outStr(ctx, "title") ?? "",
            outStr(ctx, "url") ?? "",
            outStr(ctx, "instanceId"),
          ),
        );
      }
      display = files.length > 0 ? clip(files.join(", "), 44) : undefined;
      if (uploaded !== undefined) {
        meta.push(
          badge(tr("browser.uploaded", { count: uploaded }), {
            icon: "chevrons-up",
          }),
        );
      }
      break;
    }
    case "wait": {
      const time = argNum(ctx, "time");
      const text = argStr(ctx, "text");
      const textGone = argStr(ctx, "textGone");
      const waitedMs = outNum(ctx, "waitedMs");
      if (time !== undefined || text || textGone) {
        body.push(
          opRow(
            "clock",
            tr("browser.waitTarget"),
            time !== undefined ? `${time}ms` : (text ?? textGone ?? ""),
          ),
        );
      }
      if (waitedMs !== undefined) {
        body.push(
          statusRow("clock", tr("browser.waitedMs", { count: waitedMs })),
        );
      }
      if (data) {
        body.push(
          pageCard(
            outStr(ctx, "title") ?? "",
            outStr(ctx, "url") ?? "",
            outStr(ctx, "instanceId"),
          ),
        );
      }
      display = text
        ? `“${clip(text, 40)}”`
        : textGone
          ? `“${clip(textGone, 40)}”`
          : time !== undefined
            ? `${time}ms`
            : undefined;
      if (waitedMs !== undefined) {
        meta.push(
          badge(tr("browser.waitedMs", { count: waitedMs }), { icon: "clock" }),
        );
      }
      break;
    }
    case "screenshot": {
      const fullPage = data
        ? data.fullPage !== false
        : ctx.args?.fullPage !== false;
      body.push(
        flagsHost(
          badge(tr(fullPage ? "browser.fullPage" : "browser.viewportOnly"), {
            icon: "maximize",
          }),
        ),
      );
      if (data) {
        body.push(
          pageCard(
            outStr(ctx, "title") ?? "",
            outStr(ctx, "url") ?? "",
            outStr(ctx, "instanceId"),
          ),
        );
      }
      const image: RemoteImage = {
        data: inlineImages[0] ?? "",
        mimeType: "image/png",
      };
      const summary = data ? undefined : salvagedText(ctx.raw);
      body.push(
        section(tr("fetch.fetchedImage"), imageArea([image]), {
          icon: "image",
        }),
      );
      if (summary) body.push(hintRow(summary));
      display = outStr(ctx, "url")
        ? hostOf(outStr(ctx, "url") as string)
        : undefined;
      meta.push(badge("PNG", { icon: "image" }));
      break;
    }
    case "evaluate": {
      const expression = argStr(ctx, "expression");
      if (expression)
        body.push(opRow("code", tr("label.expression"), expression, true));
      const resultValue = data?.result;
      if (resultValue !== undefined) {
        body.push(
          section(
            tc("result"),
            tcPre(
              typeof resultValue === "string"
                ? resultValue
                : JSON.stringify(resultValue, null, 2),
            ),
          ),
        );
      }
      if (data && (outStr(ctx, "url") || outStr(ctx, "instanceId"))) {
        body.push(
          pageCard(
            outStr(ctx, "title") ?? "",
            outStr(ctx, "url") ?? "",
            outStr(ctx, "instanceId"),
          ),
        );
      }
      display = expression ? clip(expression, 48) : undefined;
      if (resultValue !== undefined) {
        meta.push(badge(describeValue(resultValue)));
      }
      break;
    }
    case "back":
    case "forward": {
      const direction =
        outStr(ctx, "direction") ?? (op === "back" ? "back" : "forward");
      const isBack = direction === "back";
      const url = outStr(ctx, "url") ?? "";
      body.push(
        statusRow(
          isBack ? "arrow-up" : "arrow-down",
          tr(isBack ? "browser.historyBack" : "browser.historyForward"),
          ...(url ? [tag(hostOf(url))] : []),
        ),
      );
      if (data) {
        body.push(
          pageCard(outStr(ctx, "title") ?? "", url, outStr(ctx, "instanceId")),
        );
      }
      display = url ? hostOf(url) : undefined;
      break;
    }
    case "close":
    case "focus": {
      const instanceId = outStr(ctx, "instanceId") ?? argStr(ctx, "instanceId");
      const done =
        op === "close" ? data?.closed === true : data?.focused === true;
      body.push(
        statusRow(
          op === "close" ? "x" : "target",
          tr(
            op === "close"
              ? done
                ? "browser.closed"
                : "browser.closePending"
              : done
                ? "browser.focused"
                : "browser.focusPending",
          ),
          ...(instanceId ? [instanceChip(instanceId)] : []),
        ),
      );
      display = instanceId ? shortId(instanceId) : undefined;
      break;
    }
    case "list": {
      const tabs = (readArray(data ?? {}, "tabs") ?? [])
        .map(recordOf)
        .filter((tab): tab is JsonRecord => tab !== null)
        .map((tab) => ({
          instanceId: readString(tab, "instanceId") ?? "",
          title: readString(tab, "title") ?? "",
          isActive: tab.isActive === true,
        }))
        .filter((tab) => tab.instanceId !== "");
      if (tabs.length === 0) {
        body.push(noteRow("empty", "square", tr("browser.noTabs")));
      } else {
        body.push(
          rowList(
            tabs.map((tab) =>
              statusRow(
                tab.isActive ? "circle-dot" : "circle",
                tab.title || hostOf(tab.instanceId),
                instanceChip(tab.instanceId),
                ...(tab.isActive ? [tag(tr("browser.active"))] : []),
              ),
            ),
          ),
        );
      }
      display = tr("browser.allTabs");
      if (data)
        meta.push(
          badge(tr("browser.tabCount", { count: tabs.length }), {
            icon: "square",
          }),
        );
      break;
    }
    case "devtools": {
      const action = argStr(ctx, "action") ?? "snapshot";
      body.push(flagsHost(badge(action, { icon: "command" })));
      const maxContentLength = argNum(ctx, "maxContentLength");
      if (action === "snapshot" && maxContentLength !== undefined) {
        body.push(kv(tr("label.maxLength"), String(maxContentLength)));
      }
      body.push(...devtoolsView(ctx));
      const snapshot = recordOf(data?.snapshot);
      if (action === "console") {
        const count = (readArray(data ?? {}, "messages") ?? []).length;
        meta.push(
          badge(tr("browser.messageCount", { count }), { icon: "command" }),
        );
      } else if (action === "network") {
        const count = (readArray(data ?? {}, "requests") ?? []).length;
        if (count > 0) {
          meta.push(
            badge(tr("browser.requestCount", { count }), { icon: "gauge" }),
          );
        }
      } else if (action === "cookies") {
        const count = (readArray(data ?? {}, "cookies") ?? []).length;
        if (count > 0)
          meta.push(
            badge(tr("browser.cookieCount", { count }), { icon: "database" }),
          );
      } else if (snapshot) {
        const text = readString(snapshot, "text") ?? "";
        meta.push(
          badge(tc("charCount", { count: text.length.toLocaleString() })),
        );
      }
      display = snapshot
        ? hostOf(readString(snapshot, "url") ?? "")
        : outStr(ctx, "url")
          ? hostOf(outStr(ctx, "url") as string)
          : undefined;
      break;
    }
    case "get_tab_content": {
      if (data) {
        body.push(
          pageCard(
            outStr(ctx, "title") ?? "",
            outStr(ctx, "url") ?? "",
            outStr(ctx, "instanceId"),
          ),
        );
      }
      const content = outStr(ctx, "content");
      if (content) {
        body.push(
          section(tr("browser.pageText"), tcPre(content), {
            icon: "file",
            meta: [
              badge(
                tc("charCount", { count: content.length.toLocaleString() }),
              ),
            ],
          }),
        );
      }
      display = outStr(ctx, "url")
        ? hostOf(outStr(ctx, "url") as string)
        : undefined;
      if (content)
        meta.push(
          badge(tc("charCount", { count: content.length.toLocaleString() })),
        );
      break;
    }
    case "drag": {
      const fromLabel = argStr(ctx, "fromSelector") ?? argStr(ctx, "fromText");
      const toLabel = argStr(ctx, "toSelector") ?? argStr(ctx, "toText");
      if (data) {
        body.push(
          statusRow(
            "move",
            tr("browser.dragged"),
            ...(fromLabel || toLabel
              ? [tag(`${fromLabel ?? "?"} → ${toLabel ?? "?"}`)]
              : []),
          ),
        );
      }
      display = fromLabel ?? undefined;
      break;
    }
    case "fill_form": {
      const elements = Array.isArray(ctx.args?.elements)
        ? ctx.args?.elements
        : [];
      const results = data ? (readArray(data, "results") ?? []) : [];
      const failureCount = outNum(ctx, "failureCount") ?? 0;
      if (data) {
        body.push(
          statusRow(
            "list-checks",
            tr("browser.filled", {
              count: results.length || elements.length,
            }),
            ...(failureCount > 0
              ? [
                  badge(tr("browser.fillFailed", { count: failureCount }), {
                    variant: "warn",
                  }),
                ]
              : []),
          ),
        );
      }
      break;
    }
  }

  return { display, meta, body };
};

const renderBrowser = (tool: SnowRemoteToolCall): HTMLElement | null => {
  const op = tool.name.startsWith("browser-")
    ? tool.name.slice("browser-".length)
    : tool.name;
  if (!isBrowserOp(op)) return null;

  const ctx: BrowserContext = {
    op,
    args: parseJsonRecord(tool.arguments),
    ...parseBrowserResult(tool.result),
  };
  const { display, meta, body } = buildBrowserView(ctx);
  const status = resolveStatus(tool);

  const nodes = [...body];
  if (nodes.length === 0) {
    if (ctx.raw) {
      nodes.push(section(tc("result"), tcPre(decodeEscapedNewlines(ctx.raw))));
    } else if (status === "pending" || status === "running") {
      nodes.push(noteRow("progress", "loader-circle", tr("browser.running")));
    }
  }

  return createToolNode({
    tool,
    status,
    badge: tr(`browser.op.${op}`),
    display: display || argsSummary(tool.arguments),
    displayTitle: display || tool.name,
    meta,
    className: `tc-web-browser tc-web-browser--${op}`,
    bodyClass: "tc-web",
    body: nodes,
  });
};

// ── anysearch-*（外部 MCP：Anysearch 检索服务） ─────────────────────────────

/** Anysearch 操作（归一化后的短名）。 */
type AnySearchOp = "search" | "extract" | "batch-search" | "get-sub-domains";

const ANYSEARCH_OPS: readonly string[] = [
  "search",
  "extract",
  "batch-search",
  "get-sub-domains",
];

/**
 * 归一化 Anysearch 工具名：外部 MCP 的工具名可能是连字符（anysearch-search）、
 * 下划线（anysearch_search），也可能是 MCP 自带 server 前缀的复合形态
 * （anysearch_batch_search）——先剥 server 前缀，再剥工具名自带前缀，最后统一
 * 把下划线归一为连字符，得到 search / extract / batch-search / get-sub-domains。
 */
const anysearchOpOf = (name: string): string => {
  let bare = name.replace(/^anysearch[-_]/, "");
  if (bare.startsWith("anysearch_")) bare = bare.slice("anysearch_".length);
  return bare.replace(/_/g, "-");
};

const isAnySearchOp = (value: string): value is AnySearchOp =>
  ANYSEARCH_OPS.includes(value);

/** MCP content 数组里的首个文本块（无则 undefined）。 */
const mcpText = (record: JsonRecord): string | undefined => {
  const content = readArray(record, "content");
  if (!content) return undefined;
  for (const block of records(content)) {
    if (block.type !== "text") continue;
    const text = readString(block, "text");
    if (text !== undefined) return text;
  }
  return undefined;
};

// ── Anysearch markdown 解析（纯函数：格式不符就少解析，绝不抛错） ──────────

/** 结果条目：复用 websearch 的 SearchItem 形状（displayUrl 留空 → 直接展示 url）。 */
type SearchEntry = SearchItem;

/** `### 1. Tokio - An asynchronous Rust runtime` */
const SEARCH_ITEM_RE = /^###\s+(\d+)\.\s*(.+?)\s*$/;
/** `- **URL**: https://tokio.rs/` */
const SEARCH_URL_RE = /^[-*]\s*\*\*URL\*\*:\s*(\S+)\s*$/i;
/** `- Tokio is a runtime for writing reliable ...` */
const SEARCH_TEXT_RE = /^[-*]\s+(.*)$/;
/** `## Search Results (2 results, 1413ms)` */
const SEARCH_META_RE = /^##\s+Search Results\s*\(([^)]*)\)\s*$/i;
/** `## Query 1: tokio runtime tutorial` */
const BATCH_QUERY_RE = /^##\s+Query\s+\d+\s*:\s*(.*)$/i;
/** 组间分隔线 `---`（批量检索里没有条目的分组用它占位）。 */
const SECTION_RULE_RE = /^-{3,}\s*$/;
/** `## code Domain Capabilities (2 available)` */
const DOMAIN_META_RE = /^##\s+(\S+)\s+Domain Capabilities\s*\(([^)]*)\)\s*$/i;
/** `### code.doc` */
const DOMAIN_ENTRY_RE = /^###\s+(.+?)\s*$/;
/** `**Parameters:**` */
const DOMAIN_PARAMS_RE = /^\*\*Parameters:\*\*\s*$/i;
/** `- \`library\` (required): Library or framework name to query docs for` */
const DOMAIN_PARAM_RE = /^[-*]\s+`([^`]+)`\s*(?:\((required)\))?\s*:?\s*(.*)$/;

/** 搜索结果正文行（`## ` / `### ` 标题行作为段落边界，标题本身除外）。 */
const isSearchBodyLine = (line: string): boolean => {
  if (SEARCH_URL_RE.test(line) || SEARCH_TEXT_RE.test(line)) return true;
  return SEARCH_ITEM_RE.test(line) || SEARCH_META_RE.test(line);
};

/**
 * 搜索结果 markdown：`### <序号>. <标题>` 起一条，紧随的 `- **URL**: …` 取 URL，
 * 其余 `- ` 行按空格拼成摘要；`## Search Results (N results, Xms)` 里取总数与耗时。
 */
const parseSearchMarkdown = (
  text: string,
): { total?: number; elapsedMs?: number; items: SearchEntry[] } => {
  const items: SearchEntry[] = [];
  let total: number | undefined;
  let elapsedMs: number | undefined;
  let current: SearchEntry | null = null;

  const flush = (): void => {
    if (current && current.title !== "") items.push(current);
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const meta = SEARCH_META_RE.exec(line);
    if (meta) {
      const numbers = meta[1].match(/\d+/g) ?? [];
      if (numbers.length > 0) total = Number(numbers[0]);
      if (numbers.length > 1) elapsedMs = Number(numbers[1]);
      continue;
    }
    const head = SEARCH_ITEM_RE.exec(line);
    if (head) {
      flush();
      current = { title: head[2].trim(), url: "", snippet: "", displayUrl: "" };
      continue;
    }
    if (!current) continue;
    const url = SEARCH_URL_RE.exec(line);
    if (url) {
      current.url = url[1];
      continue;
    }
    const bodyLine = SEARCH_TEXT_RE.exec(line);
    if (bodyLine) {
      const snippet = bodyLine[1].trim();
      if (snippet !== "") {
        current.snippet = current.snippet
          ? `${current.snippet} ${snippet}`
          : snippet;
      }
    }
  }
  flush();

  return { total, elapsedMs, items };
};

/** 批量检索：按 `## Query N: xxx` 分组，组内复用 parseSearchMarkdown。 */
const parseBatchSections = (
  text: string,
): { query: string; items: SearchEntry[] }[] => {
  const sections: { query: string; lines: string[] }[] = [];
  let current: { query: string; lines: string[] } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const head = BATCH_QUERY_RE.exec(rawLine.trim());
    if (head) {
      if (current) sections.push(current);
      current = { query: head[1].trim(), lines: [] };
      continue;
    }
    if (!current) continue;
    const line = rawLine.trim();
    if (line === "" || SECTION_RULE_RE.test(line) || isSearchBodyLine(line)) {
      current.lines.push(rawLine);
    }
  }
  if (current) sections.push(current);

  return sections.map((entry) => ({
    query: entry.query,
    items: parseSearchMarkdown(entry.lines.join("\n")).items,
  }));
};

type ExtractedPage = { url: string; title: string; content: string };

/** extract：优先 structuredContent，其次 content 文本里的 JSON 字符串。 */
const parseExtract = (record: JsonRecord): ExtractedPage | null => {
  const structured = isRecord(record.structuredContent)
    ? record.structuredContent
    : null;
  if (structured) {
    const page = {
      url: readString(structured, "url") ?? "",
      title: readString(structured, "title") ?? "",
      content: readString(structured, "content") ?? "",
    };
    if (page.url !== "" || page.content !== "") return page;
  }

  const text = mcpText(record);
  if (text === undefined) return null;
  const parsed = parseJsonRecord(text);
  if (!parsed) return null;
  const page = {
    url: readString(parsed, "url") ?? "",
    title: readString(parsed, "title") ?? "",
    content: readString(parsed, "content") ?? "",
  };
  return page.url !== "" || page.content !== "" ? page : null;
};

type DomainParam = { name: string; required: boolean; description: string };

type DomainCapability = {
  name: string;
  description: string;
  params: DomainParam[];
};

/**
 * `## <domain> Domain Capabilities (N available)` 取领域名；`### <name>` 起一个
 * 能力条目，其后的普通段落是描述，`**Parameters:**` 之后的 `- \`param\` (required): …`
 * 解析为参数。
 */
const parseDomains = (
  text: string,
): { domain: string; entries: DomainCapability[] } => {
  let domain = "";
  const entries: DomainCapability[] = [];
  const descriptionLines: string[] = [];
  let current: DomainCapability | null = null;
  let inParams = false;

  const flushDescription = (): void => {
    if (!current) return;
    const description = descriptionLines.join(" ").trim();
    if (description !== "") current.description = description;
    descriptionLines.length = 0;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const meta = DOMAIN_META_RE.exec(line);
    if (meta) {
      if (domain === "") domain = meta[1];
      continue;
    }
    const head = DOMAIN_ENTRY_RE.exec(line);
    if (head) {
      flushDescription();
      current = { name: head[1], description: "", params: [] };
      entries.push(current);
      inParams = false;
      continue;
    }
    if (!current) continue;
    if (DOMAIN_PARAMS_RE.test(line)) {
      flushDescription();
      inParams = true;
      continue;
    }
    const param = DOMAIN_PARAM_RE.exec(line);
    if (param && (inParams || current.params.length > 0)) {
      current.params.push({
        name: param[1],
        required: param[2] !== undefined,
        description: param[3].trim(),
      });
      continue;
    }
    if (inParams) continue;
    if (line === "" || line.startsWith("#")) continue;
    descriptionLines.push(line);
  }
  flushDescription();

  return { domain, entries };
};

// ── Anysearch 渲染 ─────────────────────────────────────────────────────────

/** 每张卡片的可解析上下文：参数、结果记录与结果里的错误文案。 */
type AnySearchContext = {
  args: JsonRecord | null;
  result: JsonRecord | null;
  error?: string;
};

const anysearchContext = (tool: SnowRemoteToolCall): AnySearchContext => {
  const args = parseJsonRecord(tool.arguments);
  const result = parseJsonRecord(tool.result);
  const error = result ? optional(readString(result, "error")) : undefined;
  return { args, result, error };
};

/** 参数与结果都解析不出（半截 JSON / 空结果）时交给兜底卡。 */
const isOpaqueAnySearch = (
  tool: SnowRemoteToolCall,
  ctx: AnySearchContext,
): boolean =>
  ctx.args === null &&
  ctx.result === null &&
  ((tool.result ?? "").trim() !== "" || resolveStatus(tool) === "error");

/** 领域能力条目：名称 + 描述 + 参数列表（名称复用搜索结果条目标题样式）。 */
const capabilityBlock = (entry: DomainCapability): HTMLElement => {
  const card = el("div", "tc-web-cap");
  const head = el("div", "tc-web-cap-head");
  const name = textSpan("tc-web-item-title", entry.name);
  name.title = entry.name;
  head.append(name);
  if (entry.params.length > 0) head.append(badge(tr("anysearch.parameters")));
  card.append(head);

  if (entry.description) {
    card.append(el("p", "tc-web-cap-desc", entry.description));
  }
  if (entry.params.length > 0) {
    const list = el("div", "tc-web-cap-params");
    for (const param of entry.params) {
      const row = el("div", "tc-web-cap-param");
      row.append(textSpan("tc-web-cap-param-name", param.name));
      if (param.required) {
        row.append(badge(tr("anysearch.required"), { variant: "warn" }));
      }
      if (param.description) {
        row.append(textSpan("tc-web-cap-param-desc", param.description));
      }
      list.append(row);
    }
    card.append(list);
  }
  return card;
};

const renderAnySearchSearch = (
  tool: SnowRemoteToolCall,
  ctx: AnySearchContext,
): HTMLElement | null => {
  if (isOpaqueAnySearch(tool, ctx)) return null;
  const query = ctx.args ? optional(readString(ctx.args, "query")) : undefined;
  const maxResults = ctx.args ? readNumber(ctx.args, "maxResults") : undefined;
  const text = ctx.result ? mcpText(ctx.result) : undefined;
  const parsed = text !== undefined ? parseSearchMarkdown(text) : null;
  const items = parsed?.items ?? [];
  const body = document.createDocumentFragment();

  const params: Node[] = [];
  if (query) params.push(kv(tr("label.query"), query, true));
  if (maxResults !== undefined) {
    params.push(kv(tr("label.maxResults"), String(maxResults)));
  }
  if (params.length) body.append(paramsHost(...params));

  if (ctx.error) {
    body.append(tcErrorRow(ctx.error));
  } else if (items.length > 0) {
    const shown = items.slice(0, MAX_SEARCH_ITEMS);
    const rows: Node[] = shown.map(searchItemEl);
    if (items.length > shown.length) {
      rows.push(
        hintRow(tr("search.omitted", { count: items.length - shown.length })),
      );
    }
    body.append(
      section(tr("search.results"), rowList(rows), {
        icon: "search",
        meta: [
          badge(
            tr("search.resultCount", { count: parsed?.total ?? items.length }),
          ),
        ],
      }),
    );
    body.append(hintRow(tr("search.linkHint")));
  } else if (tool.status === "running") {
    body.append(noteRow("note", "search", tr("search.searching")));
  } else if (tool.status === "pending") {
    body.append(noteRow("note", "search", tr("search.waiting")));
  } else {
    body.append(noteRow("empty", "search", tr("search.noResults")));
  }

  const meta: HTMLElement[] = [];
  if (items.length > 0) {
    meta.push(
      badge(
        tr("search.resultCount", { count: parsed?.total ?? items.length }),
        {
          variant: "ok",
        },
      ),
    );
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("anysearch.op.search"),
    display: query || argsSummary(tool.arguments),
    displayTitle: query || undefined,
    meta,
    className: "tc-web-anysearch tc-web-anysearch--search",
    bodyClass: "tc-web",
    body,
  });
};

const renderAnySearchBatch = (
  tool: SnowRemoteToolCall,
  ctx: AnySearchContext,
): HTMLElement | null => {
  if (isOpaqueAnySearch(tool, ctx)) return null;
  const queries = (ctx.args ? readArray(ctx.args, "queries") : undefined) ?? [];
  const queryLabels = queries.map((entry) => {
    const record = isRecord(entry) ? entry : null;
    const text = record ? readString(record, "query") : undefined;
    return text?.trim() || undefined;
  });
  const text = ctx.result ? mcpText(ctx.result) : undefined;
  const sections = text !== undefined ? parseBatchSections(text) : [];
  const itemCount = sections.reduce(
    (sum, entry) => sum + entry.items.length,
    0,
  );
  const body = document.createDocumentFragment();

  if (ctx.error) {
    body.append(tcErrorRow(ctx.error));
  } else if (sections.length > 0) {
    sections.forEach((entry, index) => {
      const rows: Node[] =
        entry.items.length > 0
          ? entry.items.map(searchItemEl)
          : [noteRow("empty", "search", tr("search.noResults"))];
      body.append(
        section(
          entry.query || queryLabels[index] || `#${index + 1}`,
          rowList(rows),
          {
            icon: "search",
            meta: [
              badge(tr("search.resultCount", { count: entry.items.length }), {
                variant: entry.items.length > 0 ? "ok" : "muted",
              }),
            ],
          },
        ),
      );
    });
    body.append(hintRow(tr("search.linkHint")));
  } else if (tool.status === "running") {
    body.append(noteRow("note", "search", tr("search.searching")));
  } else if (tool.status === "pending") {
    body.append(noteRow("note", "search", tr("search.waiting")));
  } else {
    body.append(noteRow("empty", "search", tr("search.noResults")));
  }

  const meta: HTMLElement[] = [];
  const count = sections.length || queryLabels.length;
  if (count > 0) meta.push(badge(tr("anysearch.queryCount", { count })));
  if (itemCount > 0) {
    meta.push(
      badge(tr("search.resultCount", { count: itemCount }), { variant: "ok" }),
    );
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("anysearch.op.batch-search"),
    display: queryLabels[0] ?? argsSummary(tool.arguments),
    displayTitle: queryLabels[0] ?? undefined,
    meta,
    className: "tc-web-anysearch tc-web-anysearch--batch-search",
    bodyClass: "tc-web",
    body,
  });
};

const renderAnySearchExtract = (
  tool: SnowRemoteToolCall,
  ctx: AnySearchContext,
): HTMLElement | null => {
  if (isOpaqueAnySearch(tool, ctx)) return null;
  const argUrl = ctx.args ? optional(readString(ctx.args, "url")) : undefined;
  const page = ctx.result ? parseExtract(ctx.result) : null;
  const targetUrl = page?.url || argUrl || "";
  const content = page ? decodeEscapedNewlines(page.content) : "";
  const body = document.createDocumentFragment();

  const params: Node[] = [];
  if (argUrl) params.push(kv(tr("label.url"), argUrl, true));
  if (params.length) body.append(paramsHost(...params));

  if (ctx.error) {
    body.append(tcErrorRow(ctx.error));
  } else if (page) {
    body.append(pageCard(page.title, targetUrl));
    if (content) {
      body.append(
        section(tr("fetch.preview"), tcPre(content, { maxLines: 8 }), {
          icon: "file",
        }),
      );
      body.append(
        section(tr("fetch.fullContent"), tcPre(content, { maxLines: 40 }), {
          icon: "file",
        }),
      );
    } else {
      body.append(noteRow("empty", "file", tr("fetch.noContent")));
    }
  } else if (tool.status === "running") {
    body.append(
      noteRow("progress", "loader-circle", tr("anysearch.extracting")),
    );
  } else if (tool.status === "pending") {
    body.append(noteRow("note", "clock", tr("anysearch.waitingExtract")));
  } else {
    body.append(noteRow("empty", "file", tr("fetch.noContent")));
  }

  const meta: HTMLElement[] = [];
  if (page) {
    meta.push(badge(tr("anysearch.charCount", { count: content.length })));
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("anysearch.op.extract"),
    display: targetUrl ? hostOf(targetUrl) : argsSummary(tool.arguments),
    displayTitle: targetUrl || undefined,
    meta,
    className: "tc-web-anysearch tc-web-anysearch--extract",
    bodyClass: "tc-web",
    body,
  });
};

const renderAnySearchDomains = (
  tool: SnowRemoteToolCall,
  ctx: AnySearchContext,
): HTMLElement | null => {
  if (isOpaqueAnySearch(tool, ctx)) return null;
  const argDomains = (
    (ctx.args ? readArray(ctx.args, "domains") : undefined) ?? []
  ).filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  const text = ctx.result ? mcpText(ctx.result) : undefined;
  const entries =
    (text !== undefined ? parseDomains(text) : null)?.entries ?? [];
  const body = document.createDocumentFragment();

  if (ctx.error) {
    body.append(tcErrorRow(ctx.error));
  } else if (entries.length > 0) {
    body.append(rowList(entries.map(capabilityBlock)));
  } else if (tool.status === "running") {
    body.append(noteRow("note", "search", tr("search.searching")));
  } else if (tool.status === "pending") {
    body.append(noteRow("note", "search", tr("search.waiting")));
  } else {
    body.append(noteRow("empty", "search", tr("search.noResults")));
  }

  const meta: HTMLElement[] = [];
  if (entries.length > 0) {
    meta.push(
      badge(tr("anysearch.capabilityCount", { count: entries.length })),
    );
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("anysearch.op.get-sub-domains"),
    display:
      argDomains.length > 0
        ? argDomains.join(", ")
        : argsSummary(tool.arguments),
    displayTitle: argDomains.length > 0 ? argDomains.join(", ") : undefined,
    meta,
    className: "tc-web-anysearch tc-web-anysearch--sub-domains",
    bodyClass: "tc-web",
    body,
  });
};

/**
 * Anysearch（外部 MCP）卡片：先归一化操作名再分派；未登记的操作、以及参数与
 * 结果都解析不出的情况返回 null，交给后续候选与兜底卡。
 */
const renderAnysearch = (tool: SnowRemoteToolCall): HTMLElement | null => {
  const op = anysearchOpOf(tool.name);
  if (!isAnySearchOp(op)) return null;
  const ctx = anysearchContext(tool);
  switch (op) {
    case "search":
      return renderAnySearchSearch(tool, ctx);
    case "batch-search":
      return renderAnySearchBatch(tool, ctx);
    case "extract":
      return renderAnySearchExtract(tool, ctx);
    case "get-sub-domains":
      return renderAnySearchDomains(tool, ctx);
    default:
      return null;
  }
};

// ── 模块装配 ───────────────────────────────────────────────────────────────

/**
 * 模块注册表（契约见 tools/types.ts 的 ToolModule）：
 * 三个精确名 + browser- / anysearch- 前缀族接管（未登记的操作返回 null 回退兜底卡）。
 * 前缀按长度降序派发，`anysearch-` / `anysearch_` 与 `browser-` 互不重叠。
 */
export const webModule: ToolModule = {
  renderers: {
    "websearch-websearch-search": renderSearch,
    "websearch-websearch-fetch": renderFetch,
    "imagegen-generate": renderImageGen,
  },
  prefixes: [
    { prefix: "browser-", render: renderBrowser },
    { prefix: "anysearch-", render: renderAnysearch },
    { prefix: "anysearch_", render: renderAnysearch },
  ],
};
