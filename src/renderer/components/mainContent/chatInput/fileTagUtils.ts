import {
  getChangeIconHtml,
  getCommitIconHtml,
  getFileTypeIconHtml,
} from "../../../utils/fileIcons";

export type FileTag = {
  path: string;
  name: string;
  isDirectory: boolean;
  /**
   * 可选的行号列表。当用户从搜索结果拖拽文件到输入框时，
   * 携带命中的行号，便于 AI 定位到具体代码行。
   * 仅对文件（非目录）有意义。
   */
  lines?: number[];
};

export type ImageTag = {
  name: string;
  dataUrl: string;
  index?: number;
};

export type CommitTag = {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  repoPath: string;
};

export type ChangeTag = {
  repoPath: string;
  path: string;
  section: "staged" | "unstaged";
  status: string;
};

export type TextSnippetTag = {
  /** 粘贴的原始文本内容 */
  content: string;
  /** 摘要标签，用于 chip 显示 */
  summary: string;
  /** 字符数 */
  charCount: number;
};

export type ReviewTag = {
  /** 完整 review prompt（编码时以 base64 存入标签，避免 diff 中必然
   *  出现的 `@@` hunk 头破坏标签终止符） */
  prompt: string;
  /** 摘要标签，用于 chip 显示 */
  summary: string;
  /** 字符数 */
  charCount: number;
  /** 当前分支（可选，用于 chip title） */
  branch?: string;
  /** 仓库路径（可选） */
  repoPath?: string;
};

export type ElementTag = {
  /** 元素所在页面 URL */
  url: string;
  /** 元素标签名（小写，如 button） */
  tag: string;
  /** 元素选择器描述（如 button#search），用于 chip 显示 */
  label: string;
  /** 元素文本内容摘要 */
  text: string;
  /** 用户添加的文字备注 */
  note: string;
};

export type WebTag = {
  /** 网页 URL（拖拽时取浏览器 tab 的实时地址） */
  url: string;
  /** 页面标题（可选，缺失时 chip 仅显示域名） */
  title?: string;
};

/**
 * 浏览器面板元素选择器完成选取后，通过该全局事件将 ElementTag 派发给
 * 聊天输入框（ChatInputView）插入为 element chip。
 */
export const INSERT_ELEMENT_TAG_EVENT = "snow:insert-element-tag";

/**
 * 自定义剪贴板 MIME 类型：应用内复制/剪切选区时携带编辑区的完整
 * 编码内容（含 @@file:...@@ 等 chip 标签），粘贴时优先解析该格式，
 * 可将选区内容（含各类 chip）完整还原。
 */
export const CHIPS_CLIPBOARD_TYPE = "application/x-snow-chat-chips";

export type ContentSegment =
  | { type: "text"; content: string }
  | { type: "file"; tag: FileTag }
  | { type: "image"; tag: ImageTag }
  | { type: "commit"; tag: CommitTag }
  | { type: "change"; tag: ChangeTag }
  | { type: "text-snippet"; tag: TextSnippetTag }
  | { type: "review"; tag: ReviewTag }
  | { type: "element"; tag: ElementTag }
  | { type: "web"; tag: WebTag };

/**
 * 将行号数组格式化为紧凑的字符串表示，连续区间合并为范围。
 * 例：[7,8,9,47] -> "L7-L9,L47"，[42] -> "L42"，[] -> ""
 */
export const formatLinesStr = (lines: number[]): string => {
  const sorted = [...new Set(lines)].filter((n) => n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return "";
  }
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `L${start}` : `L${start}-L${prev}`);
    start = cur;
    prev = cur;
  }
  parts.push(start === prev ? `L${start}` : `L${start}-L${prev}`);
  return parts.join(",");
};

/**
 * 解析行号字符串（支持区间格式 "L7-L9,L47" 与枚举格式 "L7,L8"）
 * 回到行号数组 [7,8,9,47]。无效项被忽略。
 */
export const parseLinesStr = (str: string): number[] => {
  const result: number[] = [];
  for (const rawPart of str.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    const rangeMatch = part.match(/^L(\d+)-L(\d+)$/);
    if (rangeMatch) {
      const from = Number.parseInt(rangeMatch[1], 10);
      const to = Number.parseInt(rangeMatch[2], 10);
      if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > 0) {
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        for (let n = lo; n <= hi; n++) {
          result.push(n);
        }
      }
      continue;
    }
    const singleMatch = part.match(/^L(\d+)$/);
    if (singleMatch) {
      const n = Number.parseInt(singleMatch[1], 10);
      if (Number.isFinite(n) && n > 0) {
        result.push(n);
      }
    }
  }
  return result;
};

export const encodeFileTag = (tag: FileTag): string => {
  const kind = tag.isDirectory ? "dir" : "file";
  const linesSuffix =
    !tag.isDirectory && tag.lines && tag.lines.length > 0
      ? `:${formatLinesStr(tag.lines)}`
      : "";
  return `@@${kind}:${tag.path}${linesSuffix}@@`;
};

export const encodeImageTag = (tag: ImageTag): string =>
  `@@image:${tag.dataUrl}@@`;

export const encodeCommitTag = (tag: CommitTag): string =>
  `@@commit:${JSON.stringify({
    hash: tag.hash,
    shortHash: tag.shortHash,
    author: tag.author,
    date: tag.date,
    message: tag.message,
    repoPath: tag.repoPath,
  })}@@`;

export const encodeChangeTag = (tag: ChangeTag): string =>
  `@@change:${JSON.stringify({
    repoPath: tag.repoPath,
    path: tag.path,
    section: tag.section,
    status: tag.status,
  })}@@`;

/**
 * 将粘贴的大段文本编码为 text-snippet 标签。
 * 使用 JSON 序列化内容，避免 @@ 终止符被破坏。
 */
export const encodeTextSnippetTag = (tag: TextSnippetTag): string =>
  `@@text-snippet:${JSON.stringify({
    content: tag.content,
    summary: tag.summary,
    charCount: tag.charCount,
  })}@@`;

/**
 * UTF-8 字符串转 base64。btoa 只能处理 Latin-1 字符，中文等多字节
 * 文本需先用 TextEncoder 转为字节再编码。
 */
const utf8ToBase64 = (str: string): string => {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

/** base64 还原为 UTF-8 字符串（与 utf8ToBase64 互逆）。 */
export const base64ToUtf8 = (base64: string): string => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
};

/**
 * 将 Review 生成的完整审查提示词编码为 review 标签。
 *
 * prompt 字段使用 base64 编码：git diff 的 hunk 头（`@@ -1,5 +1,5 @@`）
 * 几乎必然包含 `@@`，直接 JSON 内嵌会被解析器误判为标签终止符；
 * base64 字符集不含 `@@`，可安全承载任意内容。
 */
export const encodeReviewTag = (tag: ReviewTag): string =>
  `@@review:${JSON.stringify({
    prompt: utf8ToBase64(tag.prompt),
    summary: tag.summary,
    charCount: tag.charCount,
    branch: tag.branch,
    repoPath: tag.repoPath,
  })}@@`;

/**
 * 将浏览器元素选择器选取的元素编码为 element 标签。
 * text / note 为用户或页面自由文本（可能含 `@@`），以 base64 承载，
 * 避免破坏标签终止符；url / tag / label 为结构化字段，直接 JSON 内嵌。
 */
export const encodeElementTag = (tag: ElementTag): string =>
  `@@element:${JSON.stringify({
    url: tag.url,
    tag: tag.tag,
    label: tag.label,
    text: utf8ToBase64(tag.text),
    note: utf8ToBase64(tag.note),
  })}@@`;

/**
 * 将网页引用编码为 web 标签。
 * url / title 为结构化字段（标题可能含引号等字符，由 JSON 序列化承载），
 * 发送给 AI 时保留完整 URL 便于其使用浏览器工具打开该页面。
 */
export const encodeWebTag = (tag: WebTag): string =>
  `@@web:${JSON.stringify({
    url: tag.url,
    title: tag.title,
  })}@@`;

/**
 * 提取 URL 的域名（含端口），用于 web chip 显示。
 * 无法解析（如异常 URL）时原样返回输入。
 */
export const extractUrlHost = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
};

/**
 * 根据原始文本生成一个简短的摘要标签，用于 chip 显示。
 *
 * 跳过过短或纯符号的行（如 "{", "}", ">", "<?"），从多行累积
 * 有意义的内容直到达到 maxLen，避免格式文件首行仅为单个符号
 * 时标签过于简短。最终截断到 maxLen 并加省略号。
 */
export const buildTextSnippetSummary = (text: string, maxLen = 30): string => {
  const lines = text.split(/\r?\n/);
  const meaningfulLines: string[] = [];
  let totalLen = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    // 跳过过短或纯符号行（如 "{", "}", ">", "---"），这类行在
    // 格式文件（JSON / XML / HTML / 代码）开头很常见，作为标签
    // 几乎没有辨识度。
    if (trimmed.length < 4) {
      continue;
    }
    meaningfulLines.push(trimmed);
    totalLen += trimmed.length;
    if (totalLen >= maxLen) {
      break;
    }
  }
  if (meaningfulLines.length === 0) {
    // 所有行都太短时，退回取第一个非空行
    const fallback = lines
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return fallback || "text";
  }
  const summary = meaningfulLines.join(" ");
  return summary.length > maxLen
    ? `${summary.slice(0, maxLen)}...`
    : summary;
};

export const parseContentSegments = (content: string): ContentSegment[] => {
  const segments: ContentSegment[] = [];
  const regex = /@@(file|dir|image|commit|change|text-snippet|review|element|web):(.+?)@@/g;
  let lastIndex = 0;
  let imageCounter = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        content: content.slice(lastIndex, match.index),
      });
    }
    const kind = match[1];
    const value = match[2];

    if (kind === "text-snippet") {
      try {
        const data = JSON.parse(value) as Partial<TextSnippetTag>;
        segments.push({
          type: "text-snippet",
          tag: {
            content: data.content ?? "",
            summary: data.summary ?? "text",
            charCount: typeof data.charCount === "number" ? data.charCount : (data.content ?? "").length,
          },
        });
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "review") {
      try {
        const data = JSON.parse(value) as Partial<ReviewTag>;
        const prompt = data.prompt ? base64ToUtf8(data.prompt) : "";
        segments.push({
          type: "review",
          tag: {
            prompt,
            summary: data.summary ?? "review",
            charCount:
              typeof data.charCount === "number"
                ? data.charCount
                : prompt.length,
            branch: data.branch,
            repoPath: data.repoPath,
          },
        });
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "element") {
      try {
        const data = JSON.parse(value) as Partial<ElementTag>;
        segments.push({
          type: "element",
          tag: {
            url: data.url ?? "",
            tag: data.tag ?? "",
            label: data.label ?? "",
            text: data.text ? base64ToUtf8(data.text) : "",
            note: data.note ? base64ToUtf8(data.note) : "",
          },
        });
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "web") {
      try {
        const data = JSON.parse(value) as Partial<WebTag>;
        const url = data.url ?? "";
        if (!url) {
          segments.push({ type: "text", content: match[0] });
        } else {
          segments.push({
            type: "web",
            tag: {
              url,
              title: typeof data.title === "string" ? data.title : undefined,
            },
          });
        }
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "commit") {
      try {
        const data = JSON.parse(value) as Partial<CommitTag>;
        segments.push({
          type: "commit",
          tag: {
            hash: data.hash ?? "",
            shortHash: data.shortHash ?? "",
            author: data.author ?? "",
            date: data.date ?? "",
            message: data.message ?? "",
            repoPath: data.repoPath ?? "",
          },
        });
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "change") {
      try {
        const data = JSON.parse(value) as Partial<ChangeTag>;
        segments.push({
          type: "change",
          tag: {
            repoPath: data.repoPath ?? "",
            path: data.path ?? "",
            section: data.section === "staged" ? "staged" : "unstaged",
            status: data.status ?? "",
          },
        });
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "image") {
      imageCounter += 1;
      // 图片统一显示为 image.<ext>，避免磁盘存储路径里冗长的文件名
      // （带 hash/时间戳）污染 chip 标签。扩展名从 data URL 或路径推断。
      const ext = (() => {
        const mimeMatch = value.match(/^data:image\/([a-z0-9+.-]+);/);
        if (mimeMatch) {
          // "svg+xml" -> "svg"
          return mimeMatch[1].split("+")[0];
        }
        const pathExtMatch = value.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
        return pathExtMatch ? pathExtMatch[1].toLowerCase() : "png";
      })();
      segments.push({
        type: "image",
        tag: {
          name: `image.${ext}`,
          dataUrl: value,
          index: imageCounter,
        },
      });
    } else {
      const isDirectory = kind === "dir";
      // 解析末尾的行号后缀，支持区间格式 ":L7-L9,L47" 与枚举格式
      // ":L7,L8"。仅对文件有效；路径本身可能含冒号（如 Windows 盘符
      // C:），因此只匹配以 ":L" 开头、由逗号分隔的行号段。
      let path = value;
      let lines: number[] | undefined;
      if (!isDirectory) {
        const linesMatch = value.match(/:L\d+(?:-L\d+)?(?:,L\d+(?:-L\d+)?)*$/);
        if (linesMatch) {
          lines = parseLinesStr(linesMatch[0].slice(1));
          path = value.slice(0, linesMatch.index);
        }
      }
      const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
      segments.push({
        type: "file",
        tag: { path, name, isDirectory, lines },
      });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < content.length) {
    segments.push({ type: "text", content: content.slice(lastIndex) });
  }

  return segments;
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const CLOSE_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export const createChipHtml = (tag: FileTag): string => {
  const icon = getFileTypeIconHtml(tag.name, tag.isDirectory, false, 12);
  const linesStr =
    !tag.isDirectory && tag.lines && tag.lines.length > 0
      ? formatLinesStr(tag.lines)
      : "";
  const linesAttr = linesStr
    ? ` data-file-lines="${escapeHtml(linesStr)}"`
    : "";
  const displayName = linesStr ? `${tag.name}:${linesStr}` : tag.name;
  return `<span class="file-chip" contenteditable="false" data-file-tag="true" data-file-path="${escapeHtml(
    tag.path
  )}" data-file-name="${escapeHtml(tag.name)}" data-file-is-dir="${
    tag.isDirectory
  }"${linesAttr}><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    displayName
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

export const createImageChipHtml = (tag: ImageTag): string => {
  const icon = getFileTypeIconHtml(tag.name, false, false, 12);
  const indexSuffix =
    typeof tag.index === "number" && tag.index > 0 ? ` #${tag.index}` : "";
  return `<span class="file-chip image-chip" contenteditable="false" data-image-tag="true" data-image-name="${escapeHtml(
    tag.name
  )}" data-image-data-url="${escapeHtml(
    tag.dataUrl
  )}"><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    `${tag.name}${indexSuffix}`
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

export const createCommitChipHtml = (tag: CommitTag): string => {
  const icon = getCommitIconHtml(12);
  const commitData = escapeHtml(
    JSON.stringify({
      hash: tag.hash,
      shortHash: tag.shortHash,
      author: tag.author,
      date: tag.date,
      message: tag.message,
      repoPath: tag.repoPath,
    })
  );
  return `<span class="file-chip commit-chip" contenteditable="false" data-commit-tag="true" data-commit-data="${commitData}"><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    tag.shortHash
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

export const createChangeChipHtml = (tag: ChangeTag): string => {
  const icon = getChangeIconHtml(12);
  const lastSep = Math.max(
    tag.path.lastIndexOf("/"),
    tag.path.lastIndexOf("\\")
  );
  const name = lastSep === -1 ? tag.path : tag.path.slice(lastSep + 1);
  const changeData = escapeHtml(
    JSON.stringify({
      repoPath: tag.repoPath,
      path: tag.path,
      section: tag.section,
      status: tag.status,
    })
  );
  return `<span class="file-chip change-chip" contenteditable="false" data-change-tag="true" data-change-data="${changeData}"><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    name
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

export const createTextSnippetChipHtml = (tag: TextSnippetTag): string => {
  const snippetData = escapeHtml(
    JSON.stringify({
      content: tag.content,
      summary: tag.summary,
      charCount: tag.charCount,
    })
  );
  const displayName = `${tag.summary} (${tag.charCount} chars)`;
  return `<span class="file-chip text-snippet-chip" contenteditable="false" data-text-snippet-tag="true" data-text-snippet-data="${snippetData}" title="${escapeHtml(
    displayName
  )}"><span class="file-chip-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9Z"/><path d="M15 3v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg></span><span class="file-chip-name">${escapeHtml(
    tag.summary
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

export const createReviewChipHtml = (tag: ReviewTag): string => {
  const reviewData = escapeHtml(
    JSON.stringify({
      prompt: utf8ToBase64(tag.prompt),
      summary: tag.summary,
      charCount: tag.charCount,
      branch: tag.branch,
      repoPath: tag.repoPath,
    })
  );
  return `<span class="file-chip review-chip" contenteditable="false" data-review-tag="true" data-review-data="${reviewData}"><span class="file-chip-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/></svg></span><span class="file-chip-name">${escapeHtml(
    tag.summary
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

export const createElementChipHtml = (tag: ElementTag): string => {
  const elementData = escapeHtml(
    JSON.stringify({
      url: tag.url,
      tag: tag.tag,
      label: tag.label,
      text: utf8ToBase64(tag.text),
      note: utf8ToBase64(tag.note),
    })
  );
  const displayName = tag.note ? `${tag.label} · ${tag.note}` : tag.label;
  return `<span class="file-chip element-chip" contenteditable="false" data-element-tag="true" data-element-data="${elementData}"><span class="file-chip-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></svg></span><span class="file-chip-name">${escapeHtml(
    displayName
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

/**
 * 生成网页引用 chip HTML。显示「标题 · 域名」，标题缺失时仅显示域名；
 * 完整 URL 存放在 data-web-data 中，供序列化与点击打开浏览器使用。
 */
export const createWebTagChipHtml = (tag: WebTag): string => {
  const webData = escapeHtml(
    JSON.stringify({
      url: tag.url,
      title: tag.title,
    })
  );
  const host = extractUrlHost(tag.url);
  const displayName = tag.title ? `${tag.title} · ${host}` : host;
  return `<span class="file-chip web-chip" contenteditable="false" data-web-tag="true" data-web-data="${webData}" title="${escapeHtml(
    `${displayName} (${tag.url})`
  )}"><span class="file-chip-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg></span><span class="file-chip-name">${escapeHtml(
    displayName
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

/**
 * 将内容片段列表渲染为可插入编辑区的 HTML：纯文本做 HTML 转义
 * （换行转为 <br>），各类标签转换为对应 chip。用于剪贴板粘贴、
 * 草稿还原等场景重建 chip。
 */
export const buildSegmentsHtml = (segments: ContentSegment[]): string =>
  segments
    .map((segment) => {
      if (segment.type === "text") {
        return escapeHtml(segment.content).replace(/\n/g, "<br>");
      }
      if (segment.type === "image") {
        return createImageChipHtml(segment.tag);
      }
      if (segment.type === "commit") {
        return createCommitChipHtml(segment.tag);
      }
      if (segment.type === "change") {
        return createChangeChipHtml(segment.tag);
      }
      if (segment.type === "text-snippet") {
        return createTextSnippetChipHtml(segment.tag);
      }
      if (segment.type === "review") {
        return createReviewChipHtml(segment.tag);
      }
      if (segment.type === "element") {
        return createElementChipHtml(segment.tag);
      }
      if (segment.type === "web") {
        return createWebTagChipHtml(segment.tag);
      }
      return createChipHtml(segment.tag);
    })
    .join("");

type ChipSerializers = {
  file: (tag: FileTag) => string;
  image: (tag: ImageTag) => string;
  commit: (tag: CommitTag) => string;
  change: (tag: ChangeTag) => string;
  textSnippet: (tag: TextSnippetTag) => string;
  review: (tag: ReviewTag) => string;
  element: (tag: ElementTag) => string;
  web: (tag: WebTag) => string;
};

const readEditableContentWith = (
  el: HTMLElement,
  serializers: ChipSerializers
): string => {
  let result = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += (node.textContent || "").replace(/\u200B/g, "");
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement;
      if (elem.dataset.fileTag === "true") {
        const linesRaw = elem.dataset.fileLines;
        const lines =
          linesRaw && linesRaw.length > 0 ? parseLinesStr(linesRaw) : undefined;
        result += serializers.file({
          path: elem.dataset.filePath || "",
          name: elem.dataset.fileName || "",
          isDirectory: elem.dataset.fileIsDir === "true",
          lines: elem.dataset.fileIsDir === "true" ? undefined : lines,
        });
      } else if (elem.dataset.imageTag === "true") {
        result += serializers.image({
          name: elem.dataset.imageName || "image.png",
          dataUrl: elem.dataset.imageDataUrl || "",
        });
      } else if (elem.dataset.commitTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.commitData || "{}"
          ) as Partial<CommitTag>;
          result += serializers.commit({
            hash: data.hash ?? "",
            shortHash: data.shortHash ?? "",
            author: data.author ?? "",
            date: data.date ?? "",
            message: data.message ?? "",
            repoPath: data.repoPath ?? "",
          });
        } catch {
          // Ignore malformed commit data
        }
      } else if (elem.dataset.changeTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.changeData || "{}"
          ) as Partial<ChangeTag>;
          result += serializers.change({
            repoPath: data.repoPath ?? "",
            path: data.path ?? "",
            section: data.section === "staged" ? "staged" : "unstaged",
            status: data.status ?? "",
          });
        } catch {
          // Ignore malformed change data
        }
      } else if (elem.dataset.textSnippetTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.textSnippetData || "{}"
          ) as Partial<TextSnippetTag>;
          const textContent = data.content ?? "";
          result += serializers.textSnippet({
            content: textContent,
            summary: data.summary ?? buildTextSnippetSummary(textContent),
            charCount:
              typeof data.charCount === "number"
                ? data.charCount
                : textContent.length,
          });
        } catch {
          // Ignore malformed text-snippet data
        }
      } else if (elem.dataset.reviewTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.reviewData || "{}"
          ) as Partial<ReviewTag>;
          const prompt = data.prompt ? base64ToUtf8(data.prompt) : "";
          result += serializers.review({
            prompt,
            summary: data.summary ?? "review",
            charCount:
              typeof data.charCount === "number"
                ? data.charCount
                : prompt.length,
            branch: data.branch,
            repoPath: data.repoPath,
          });
        } catch {
          // Ignore malformed review data
        }
      } else if (elem.dataset.elementTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.elementData || "{}"
          ) as Partial<ElementTag>;
          result += serializers.element({
            url: data.url ?? "",
            tag: data.tag ?? "",
            label: data.label ?? "",
            text: data.text ? base64ToUtf8(data.text) : "",
            note: data.note ? base64ToUtf8(data.note) : "",
          });
        } catch {
          // Ignore malformed element data
        }
      } else if (elem.dataset.webTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.webData || "{}"
          ) as Partial<WebTag>;
          const url = data.url ?? "";
          if (url) {
            result += serializers.web({
              url,
              title:
                typeof data.title === "string" ? data.title : undefined,
            });
          }
        } catch {
          // Ignore malformed web data
        }
      } else if (elem.tagName === "BR") {
        result += "\n";
      } else {
        const isBlock = elem.tagName === "DIV" || elem.tagName === "P";
        if (isBlock && result.length > 0 && !result.endsWith("\n")) {
          result += "\n";
        }
        elem.childNodes.forEach(walk);
      }
    }
  };
  el.childNodes.forEach(walk);
  return result;
};

/**
 * 读取编辑区内容为编码字符串，各类 chip 序列化为 @@kind:...@@ 标签。
 * 用于消息发送、草稿保存等场景。
 */
export const readEditableContent = (el: HTMLElement): string =>
  readEditableContentWith(el, {
    file: encodeFileTag,
    image: encodeImageTag,
    commit: encodeCommitTag,
    change: encodeChangeTag,
    textSnippet: encodeTextSnippetTag,
    review: encodeReviewTag,
    element: encodeElementTag,
    web: encodeWebTag,
  });

/**
 * 读取编辑区内容为人类可读纯文本，用于复制/剪切时剪贴板的
 * text/plain 格式：文件 chip 输出路径（含行号后缀）、文本片段
 * chip 输出原文等，保证粘贴到应用外依然可读。
 */
export const readEditableContentAsPlainText = (el: HTMLElement): string =>
  readEditableContentWith(el, {
    file: (tag) => {
      const linesStr =
        !tag.isDirectory && tag.lines && tag.lines.length > 0
          ? formatLinesStr(tag.lines)
          : "";
      return linesStr ? `${tag.path}:${linesStr}` : tag.path;
    },
    image: (tag) => `[${tag.name}]`,
    commit: (tag) => tag.shortHash,
    change: (tag) => tag.path,
    textSnippet: (tag) => tag.content,
    review: (tag) => tag.summary,
    element: (tag) => (tag.note ? `${tag.label}: ${tag.note}` : tag.label),
    // 复制到应用外时输出「标题 URL」，保留可读性与可点击性
    web: (tag) => (tag.title ? `${tag.title} ${tag.url}` : tag.url),
  });

export const insertHtmlAtSelection = (html: string): void => {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();

  const fragment = range.createContextualFragment(html);
  const lastNode = fragment.lastChild;
  range.insertNode(fragment);

  if (lastNode) {
    // 插入内容末尾是 chip（或 <br>）时需要补一个空格，否则光标无法
    // 定位到 chip 之后、且 chip 会与后续输入的文字紧贴；末尾是纯
    // 文本节点时（如粘贴的文本片段）不补空格，避免污染粘贴内容。
    let caretAnchor: Node = lastNode;
    if (lastNode.nodeType !== Node.TEXT_NODE) {
      const space = document.createTextNode(" ");
      lastNode.parentNode?.insertBefore(space, lastNode.nextSibling);
      caretAnchor = space;
    }

    range.setStartAfter(caretAnchor);
    range.setEndAfter(caretAnchor);
    selection.removeAllRanges();
    selection.addRange(range);
  }
};

/**
 * 在 contenteditable 编辑区的当前光标位置插入换行。
 *
 * Shift+Enter 在 contenteditable 上有默认换行行为，但 Ctrl/Cmd+Enter
 * 没有统一的默认行为，需手动调用浏览器原生换行命令插入 <br>，确保
 * 光标定位与行末可见性与 Shift+Enter 一致。Chromium (Electron) 下
 * 可靠工作。
 */
export const insertLineBreak = (): void => {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();

  document.execCommand("insertLineBreak");
};

/**
 * 重新编号编辑区内的图片 chip，并固定所有 chip 的宽度。
 *
 * 固定宽度的目的：chip 内的 remove 按钮默认隐藏，hover 时才显示。
 * 若不固定宽度，hover 出现按钮会撑大 chip，导致名字不省略、布局跳动。
 * 固定后，hover 时名字用省略号收缩让位，chip 外框尺寸不变。
 *
 * 测量时需要临时释放 name 元素的 `flex: 1` + `min-width: 0`，否则
 * inline-flex chip 会把名字收缩到接近 0，从而钉住一个过小的宽度，
 * 导致大部分文件名被截断。释放后 chip 展开到完整内容宽度，再复原样式。
 *
 * 此逻辑在输入框内容变化（syncContent）和草稿还原（draftToRestore）
 * 两个场景都需要调用，因此提取为独立工具函数。
 */
export const renumberImageChips = (el: HTMLElement): void => {
  const chips = el.querySelectorAll<HTMLElement>("[data-image-tag='true']");
  chips.forEach((chip, i) => {
    const index = i + 1;
    const name = chip.dataset.imageName || "";
    const nameEl = chip.querySelector<HTMLElement>(".file-chip-name");
    if (nameEl) {
      nameEl.textContent = `${name} #${index}`;
    }
    chip.dataset.imageIndex = String(index);
  });

  const allChips = el.querySelectorAll<HTMLElement>(".file-chip");
  allChips.forEach((chip) => {
    const removeEl = chip.querySelector<HTMLElement>(".file-chip-remove");
    const nameEl = chip.querySelector<HTMLElement>(".file-chip-name");

    const prevRemoveDisplay = removeEl ? removeEl.style.display : "";
    const prevNameFlex = nameEl ? nameEl.style.flex : "";
    const prevNameMinWidth = nameEl ? nameEl.style.minWidth : "";

    if (removeEl) {
      removeEl.style.display = "none";
    }
    if (nameEl) {
      nameEl.style.flex = "0 0 auto";
      nameEl.style.minWidth = "";
    }
    chip.style.width = "";
    const naturalWidth = chip.offsetWidth;

    if (removeEl) {
      removeEl.style.display = prevRemoveDisplay;
    }
    if (nameEl) {
      nameEl.style.flex = prevNameFlex;
      nameEl.style.minWidth = prevNameMinWidth;
    }
    chip.style.width = `${naturalWidth}px`;
  });
};
