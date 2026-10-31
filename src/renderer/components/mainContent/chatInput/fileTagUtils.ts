import {
  getChangeIconHtml,
  getCommitIconHtml,
  getFileTypeIconHtml,
} from "../../../utils/fileIcons";
import { getSkillIconHtml } from "../../../utils/skillIcons";

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

export type SkillTag = {
  /** 技能唯一标识（SkillDefinition.id） */
  skillId: string;
  /** 技能显示名 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 技能作用域 */
  location: "project" | "global";
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

export type CommandTag = {
  name: string;
  prompt: string;
  charCount: number;
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
  /** 元素在页面 DOM 中的层级树（根 -> 元素祖先链 + 直接子元素摘要） */
  domTree: string;
};

export type WebTag = {
  /** 网页 URL（拖拽时取浏览器 tab 的实时地址） */
  url: string;
  /** 页面标题（可选，缺失时 chip 仅显示域名） */
  title?: string;
  /** 拖入的浏览器标签 ID，供浏览器工具直接定位 */
  instanceId?: string;
  /** 清洗后的整页正文快照（≤8000 字符，随消息发送给 AI，AI 无需再开浏览器） */
  text?: string;
  /** 元素区域文本摘要（可选，来自浏览器元素选择器 picked） */
  elementText?: string;
  /** 元素选择器（可选，供 AI 复现定位） */
  elementSelector?: string;
};

export type ConversationTag = {
  /** 被引用的历史会话 conversationId */
  conversationId: string;
  /** 会话所属工作区目录（同项目校验用） */
  directoryId: string;
  /** 会话显示名（chip 显示） */
  title: string;
};

export type QuoteTag = {
  /** 划词原文（随消息发送给 AI） */
  content: string;
  /** 摘要标签，用于 chip 显示 */
  summary: string;
  /** 字符数 */
  charCount: number;
};

export type AnnotationTag = {
  /** 被标注文件路径 */
  filePath: string;
  /** 标注起始行（0 表示行号未知） */
  startLine: number;
  /** 标注结束行 */
  endLine: number;
  /** 被标注的原文片段 */
  quote: string;
  /** 标注正文 */
  content: string;
  /** 行号口径：源码文件 / 文档提取正文 */
  representation: "source" | "extracted-text";
};

export type FileSelectionTag = {
  /** 选区所在文件路径 */
  path: string;
  /** 文件名（chip 显示与图标） */
  name: string;
  /** 选区起始行（0 表示行号未知） */
  startLine: number;
  /** 选区结束行 */
  endLine: number;
  /** 选中原文（随消息发送给 AI） */
  content: string;
  /** 行号口径：源码文件 / 文档提取正文 */
  representation: "source" | "extracted-text";
};

/** WorkFlow 手动编排提交的折叠标签：完整图在随后的工具调用里，这里只存概要。 */
export type WorkflowTag = {
  title: string;
  nodeCount: number;
  edgeCount: number;
  /** 节点清单文本（悬停预览与 AI 概要共用） */
  outline: string;
  /** 编排图快照（JSON 文本），回滚时还原到编排器画布 */
  graphJson?: string;
};

/**
 * 浏览器面板元素选择器完成选取后，通过该全局事件将 ElementTag 派发给
 * 聊天输入框（ChatInputView）插入为 element chip。
 */
export const INSERT_ELEMENT_TAG_EVENT = "snow:insert-element-tag";

/**
 * 消息内容区划词引用完成后，通过该全局事件将 QuoteTag 派发给
 * 聊天输入框插入为 quote chip。
 */
export const INSERT_QUOTE_TAG_EVENT = "snow:insert-quote-tag";

/**
 * 资源管理器右键菜单「添加到输入框」通过该全局事件将选中条目（支持
 * ctrl/shift 多选，文件与文件夹均支持）派发给聊天输入框插入为 file chip，
 * 效果与拖拽条目到输入框一致。
 */
export const INSERT_FILE_TAGS_EVENT = "snow:insert-file-tags";

/**
 * 自定义剪贴板 MIME 类型：应用内复制/剪切选区时携带编辑区的完整
 * 编码内容（含 @@file:...@@ 等 chip 标签），粘贴时只解析该格式，
 * 可将选区内容（含各类 chip）完整还原；外部纯文本一律按原文粘贴。
 */
export const CHIPS_CLIPBOARD_TYPE = "application/x-snow-chat-chips";

/**
 * 将编码内容（含 chip 标签）写入剪贴板：同时写入 CHIPS_CLIPBOARD_TYPE
 * 与 text/plain，使粘贴回输入框时能还原 chips。自定义 MIME 只能经
 * copy 事件的 clipboardData 写入，因此借助 execCommand("copy") 触发；
 * 返回 false 表示当前环境无法触发复制，调用方需自行降级。
 */
export const copyEncodedContentToClipboard = (encoded: string): boolean => {
  const handleCopy = (event: ClipboardEvent): void => {
    if (!event.clipboardData) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData(CHIPS_CLIPBOARD_TYPE, encoded);
    event.clipboardData.setData("text/plain", encoded);
  };
  document.addEventListener("copy", handleCopy);
  try {
    return document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", handleCopy);
  }
};

export type ContentSegment =
  | { type: "text"; content: string }
  | { type: "file"; tag: FileTag }
  | { type: "image"; tag: ImageTag }
  | { type: "commit"; tag: CommitTag }
  | { type: "change"; tag: ChangeTag }
  | { type: "text-snippet"; tag: TextSnippetTag }
  | { type: "review"; tag: ReviewTag }
  | { type: "element"; tag: ElementTag }
  | { type: "web"; tag: WebTag }
  | { type: "conversation"; tag: ConversationTag }
  | { type: "quote"; tag: QuoteTag }
  | { type: "command"; tag: CommandTag }
  | { type: "skill"; tag: SkillTag }
  | { type: "annotation"; tag: AnnotationTag }
  | { type: "file-selection"; tag: FileSelectionTag }
  | { type: "workflow"; tag: WorkflowTag };

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

const FILE_CHIP_LINES_MAX_CHARS = 24;

/**
 * chip 展示用的行号文本：行号过多时只保留前两段并省略，避免 chip 被
 * 长行号列表撑开（完整行号仍保留在 chip title 与编码标签里）。
 */
export const formatFileChipLinesLabel = (
  lines: number[] | undefined,
): string => {
  if (!lines || lines.length === 0) {
    return "";
  }
  const linesStr = formatLinesStr(lines);
  if (!linesStr || linesStr.length <= FILE_CHIP_LINES_MAX_CHARS) {
    return linesStr;
  }
  return `${linesStr.split(",").slice(0, 2).join(",")}…`;
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

/**
 * 文件 + 行号区间的显示文本：`文件名:L9-L13`（单行取 `文件名:L9`，行号未知时
 * 仅文件名），与文件 chip 的行号写法保持一致。
 */
export const formatFileLinesLabel = (
  filePath: string,
  startLine: number,
  endLine: number,
): string => {
  const name = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
  if (startLine <= 0) {
    return name;
  }
  return endLine > startLine
    ? `${name}:L${startLine}-L${endLine}`
    : `${name}:L${startLine}`;
};

/** 标注 chip 的显示文本（复用文件 + 行号标签）。 */
export const formatAnnotationLabel = (tag: AnnotationTag): string =>
  formatFileLinesLabel(tag.filePath, tag.startLine, tag.endLine);

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

export const encodeCommandTag = (tag: CommandTag): string =>
  `@@command:${JSON.stringify({
    name: tag.name,
    prompt: utf8ToBase64(tag.prompt),
    charCount: tag.charCount,
  })}@@`;

/**
 * 将历史会话引用编码为 conversation 标签。
 * title 为用户自由文本（可能含 `@@`），以 base64 承载避免破坏标签终止符；
 * conversationId / directoryId 为结构化 id，直接 JSON 内嵌。
 */
export const encodeConversationTag = (tag: ConversationTag): string =>
  `@@conversation:${JSON.stringify({
    conversationId: tag.conversationId,
    directoryId: tag.directoryId,
    title: utf8ToBase64(tag.title),
  })}@@`;

/**
 * 将技能引用编码为 skill 标签。
 * 与 commit/change 等结构化标签一致：description 直接 JSON 内嵌明文，
 * 原样发送给 AI 时可直接读取技能名称与描述。
 */
export const encodeSkillTag = (tag: SkillTag): string =>
  `@@skill:${JSON.stringify({
    skillId: tag.skillId,
    name: tag.name,
    description: tag.description,
    location: tag.location,
  })}@@`;

/**
 * 将划词引用编码为 quote 标签。
 * 与 text-snippet 一致以 JSON 明文承载，AI 可直接读取被引用的原文。
 */
export const encodeQuoteTag = (tag: QuoteTag): string =>
  `@@quote:${JSON.stringify({
    content: tag.content,
    summary: tag.summary,
    charCount: tag.charCount,
  })}@@`;

/**
 * 将文件标注（审阅标注）编码为 annotation 标签。
 *
 * 后端展开为可读文本时按「文件:行号 + 引用原文 + 标注正文」呈现，因此这里
 * 只携带结构化字段；quote / content 为自由文本（可能含 `@@`），以 base64 承载。
 */
export const encodeAnnotationTag = (tag: AnnotationTag): string =>
  `@@annotation:${JSON.stringify({
    filePath: tag.filePath,
    startLine: tag.startLine,
    endLine: tag.endLine,
    quote: utf8ToBase64(tag.quote),
    content: utf8ToBase64(tag.content),
    representation: tag.representation,
  })}@@`;

/**
 * 将文件选区引用编码为 file-selection 标签。
 *
 * 同时承载文件路径、行号区间与选中原文：只给行号时 AI 必须自行读取整行，
 * 与用户实际选中的词不对应；选中原文为自由文本（可能含 `@@`），以 base64 承载。
 */
export const encodeFileSelectionTag = (tag: FileSelectionTag): string =>
  `@@file-selection:${JSON.stringify({
    path: tag.path,
    name: tag.name,
    startLine: tag.startLine,
    endLine: tag.endLine,
    content: utf8ToBase64(tag.content),
    representation: tag.representation,
  })}@@`;

/** title / outline / graph 为自由文本（可能含 `@@`），以 base64 承载。 */
export const encodeWorkflowTag = (tag: WorkflowTag): string =>
  `@@workflow:${JSON.stringify({
    title: utf8ToBase64(tag.title),
    nodeCount: tag.nodeCount,
    edgeCount: tag.edgeCount,
    outline: utf8ToBase64(tag.outline),
    graph: tag.graphJson ? utf8ToBase64(tag.graphJson) : undefined,
  })}@@`;

/** WorkFlow 标签的 chip 文本：`WorkFlow: 流程名`（无名称时仅 WorkFlow）。 */
export const formatWorkflowTagLabel = (tag: WorkflowTag): string =>
  tag.title.trim() ? `WorkFlow: ${tag.title.trim()}` : "WorkFlow";

/**
 * 将浏览器元素选择器选取的元素编码为 element 标签。
 * text / note / domTree 为自由文本（可能含 `@@`），以 base64 承载，
 * 避免破坏标签终止符；url / tag / label 为结构化字段，直接 JSON 内嵌。
 */
export const encodeElementTag = (tag: ElementTag): string =>
  `@@element:${JSON.stringify({
    url: tag.url,
    tag: tag.tag,
    label: tag.label,
    text: utf8ToBase64(tag.text),
    note: utf8ToBase64(tag.note),
    domTree: utf8ToBase64(tag.domTree),
  })}@@`;

/**
 * 将网页引用编码为 web 标签。
 * url / title 为结构化字段（标题可能含引号等字符，由 JSON 序列化承载），
 * 发送给 AI 时保留完整 URL 便于其使用浏览器工具打开该页面；text /
 * elementText / elementSelector 为 F4 网页快照字段（正文 / 元素区域），
 * 携带后 AI 无需再开浏览器即可基于页面内容工作。
 */
export const encodeWebTag = (tag: WebTag): string =>
  `@@web:${JSON.stringify({
    url: tag.url,
    title: tag.title,
    instanceId: tag.instanceId,
    text: tag.text,
    elementText: tag.elementText,
    elementSelector: tag.elementSelector,
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
    const fallback = lines.map((l) => l.trim()).find((l) => l.length > 0);
    return fallback || "text";
  }
  const summary = meaningfulLines.join(" ");
  return summary.length > maxLen ? `${summary.slice(0, maxLen)}...` : summary;
};

const contentTagPattern =
  /@@(file-selection|file|dir|image|commit|change|text-snippet|review|element|web|conversation|quote|command|skill|annotation|workflow):(.+?)@@/g;

/** Treat chips as opaque encoded spans: no attachment loading or re-encoding. */
export const splitDraftText = (
  content: string,
): { text: string; chips: string[] } => {
  const chips: string[] = [];
  const text = content.replace(new RegExp(contentTagPattern), (chip) => {
    chips.push(chip);
    return "";
  });
  return { text, chips };
};

export const replaceDraftText = (content: string, text: string): string => {
  if (splitDraftText(text).chips.length > 0) {
    throw new Error("Replacement must be plain text, not encoded chips");
  }
  const { chips } = splitDraftText(content);
  return chips.length ? `${text}\n${chips.join("\n")}` : text;
};

export const parseContentSegments = (content: string): ContentSegment[] => {
  const segments: ContentSegment[] = [];
  const regex = new RegExp(contentTagPattern);
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
            charCount:
              typeof data.charCount === "number"
                ? data.charCount
                : (data.content ?? "").length,
          },
        });
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "quote") {
      try {
        const data = JSON.parse(value) as Partial<QuoteTag>;
        const quoteContent = data.content ?? "";
        segments.push({
          type: "quote",
          tag: {
            content: quoteContent,
            summary: data.summary ?? buildTextSnippetSummary(quoteContent),
            charCount:
              typeof data.charCount === "number"
                ? data.charCount
                : quoteContent.length,
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
    } else if (kind === "command") {
      try {
        const data = JSON.parse(value) as Partial<CommandTag>;
        const name = typeof data.name === "string" ? data.name.trim() : "";
        if (!name) {
          segments.push({ type: "text", content: match[0] });
        } else {
          const prompt = data.prompt ? base64ToUtf8(data.prompt) : "";
          segments.push({
            type: "command",
            tag: {
              name,
              prompt,
              charCount:
                typeof data.charCount === "number"
                  ? data.charCount
                  : prompt.length,
            },
          });
        }
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
            domTree: data.domTree ? base64ToUtf8(data.domTree) : "",
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
              instanceId:
                typeof data.instanceId === "string"
                  ? data.instanceId
                  : undefined,
              text: typeof data.text === "string" ? data.text : undefined,
              elementText:
                typeof data.elementText === "string"
                  ? data.elementText
                  : undefined,
              elementSelector:
                typeof data.elementSelector === "string"
                  ? data.elementSelector
                  : undefined,
            },
          });
        }
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "conversation") {
      try {
        const data = JSON.parse(value) as Partial<ConversationTag>;
        if (
          typeof data.conversationId !== "string" ||
          data.conversationId.trim().length === 0
        ) {
          segments.push({ type: "text", content: match[0] });
        } else {
          segments.push({
            type: "conversation",
            tag: {
              conversationId: data.conversationId,
              directoryId:
                typeof data.directoryId === "string" ? data.directoryId : "",
              title: data.title ? base64ToUtf8(data.title) : "",
            },
          });
        }
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "skill") {
      try {
        const data = JSON.parse(value) as Partial<SkillTag>;
        if (
          typeof data.skillId === "string" &&
          data.skillId.trim().length > 0
        ) {
          segments.push({
            type: "skill",
            tag: {
              skillId: data.skillId,
              name: data.name || data.skillId,
              description: data.description ?? "",
              location: data.location === "project" ? "project" : "global",
            },
          });
        } else {
          segments.push({ type: "text", content: match[0] });
        }
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "file-selection") {
      try {
        const data = JSON.parse(value) as Partial<FileSelectionTag>;
        const path = typeof data.path === "string" ? data.path : "";
        if (!path.trim()) {
          segments.push({ type: "text", content: match[0] });
        } else {
          segments.push({
            type: "file-selection",
            tag: {
              path,
              name:
                data.name || path.split(/[\\/]/).filter(Boolean).pop() || path,
              startLine:
                typeof data.startLine === "number" ? data.startLine : 0,
              endLine: typeof data.endLine === "number" ? data.endLine : 0,
              content: data.content ? base64ToUtf8(data.content) : "",
              representation:
                data.representation === "extracted-text"
                  ? "extracted-text"
                  : "source",
            },
          });
        }
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "annotation") {
      try {
        const data = JSON.parse(value) as Partial<AnnotationTag>;
        const filePath = typeof data.filePath === "string" ? data.filePath : "";
        if (!filePath.trim()) {
          segments.push({ type: "text", content: match[0] });
        } else {
          segments.push({
            type: "annotation",
            tag: {
              filePath,
              startLine:
                typeof data.startLine === "number" ? data.startLine : 0,
              endLine: typeof data.endLine === "number" ? data.endLine : 0,
              quote: data.quote ? base64ToUtf8(data.quote) : "",
              content: data.content ? base64ToUtf8(data.content) : "",
              representation:
                data.representation === "extracted-text"
                  ? "extracted-text"
                  : "source",
            },
          });
        }
      } catch {
        segments.push({ type: "text", content: match[0] });
      }
    } else if (kind === "workflow") {
      try {
        const data = JSON.parse(value) as Partial<
          Record<keyof WorkflowTag | "graph", unknown>
        >;
        let graphJson: string | undefined;
        if (typeof data.graph === "string") {
          try {
            graphJson = base64ToUtf8(data.graph);
          } catch {
            graphJson = undefined;
          }
        }
        segments.push({
          type: "workflow",
          tag: {
            title:
              typeof data.title === "string" ? base64ToUtf8(data.title) : "",
            nodeCount: typeof data.nodeCount === "number" ? data.nodeCount : 0,
            edgeCount: typeof data.edgeCount === "number" ? data.edgeCount : 0,
            outline:
              typeof data.outline === "string"
                ? base64ToUtf8(data.outline)
                : "",
            graphJson,
          },
        });
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

/**
 * 把消息内容（含 @@file:...@@ / @@image:...@@ 等 chip 标签）折叠为单行
 * 可读纯文本，用于回滚目标列表、会话导航栏等紧凑位置的预览与 tooltip。
 *
 * 标签不会以编码串形式暴露，而是替换为其人类可读名称：文件取「名称:行号」
 * （L7-L9），图片取 [image.png]，提交取短 hash，网页取「标题 URL」，文本片段
 * 与引用取摘要等。
 */
export const summarizeContentAsPlainText = (content: string): string => {
  const parts: string[] = [];
  for (const segment of parseContentSegments(content)) {
    if (segment.type === "text") {
      // 历史数据里可能混有未编码的 data URL，替换掉避免长串 base64 污染摘要。
      const text = segment.content.replace(
        /data:image\/[^;]+;base64,[^\s)]+/g,
        "[image]",
      );
      const trimmed = text.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    } else if (segment.type === "image") {
      parts.push(`[${segment.tag.name}]`);
    } else if (segment.type === "commit") {
      parts.push(segment.tag.shortHash);
    } else if (segment.type === "change") {
      const lastSep = Math.max(
        segment.tag.path.lastIndexOf("/"),
        segment.tag.path.lastIndexOf("\\"),
      );
      parts.push(
        lastSep === -1 ? segment.tag.path : segment.tag.path.slice(lastSep + 1),
      );
    } else if (
      segment.type === "text-snippet" ||
      segment.type === "quote" ||
      segment.type === "review"
    ) {
      parts.push(segment.tag.summary);
    } else if (segment.type === "element") {
      parts.push(
        segment.tag.note
          ? `${segment.tag.label}: ${segment.tag.note}`
          : segment.tag.label,
      );
    } else if (segment.type === "web") {
      parts.push(
        segment.tag.title
          ? `${segment.tag.title} ${segment.tag.url}`
          : segment.tag.url,
      );
    } else if (segment.type === "annotation") {
      parts.push(formatAnnotationLabel(segment.tag));
    } else if (segment.type === "file-selection") {
      parts.push(
        formatFileLinesLabel(
          segment.tag.path,
          segment.tag.startLine,
          segment.tag.endLine,
        ),
      );
    } else if (segment.type === "conversation") {
      parts.push(segment.tag.title);
    } else if (segment.type === "skill") {
      parts.push(segment.tag.name);
    } else if (segment.type === "command") {
      parts.push(`/${segment.tag.name}`);
    } else if (segment.type === "workflow") {
      parts.push(formatWorkflowTagLabel(segment.tag));
    } else {
      const { tag } = segment;
      const linesStr = tag.isDirectory
        ? ""
        : formatFileChipLinesLabel(tag.lines);
      parts.push(linesStr ? `${tag.name}:${linesStr}` : tag.name);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
};

/** 非文本片段（chip）：消息区与列表预览共用的渲染单位。 */
type ChipSegment = Exclude<ContentSegment, { type: "text" }>;

/**
 * chip 在紧凑位置显示的单行文本：文件取「名称:行号」、图片取「名称 #序号」、
 * 提交取短 hash、网页取「标题 · 域名」等。
 *
 * 消息区 chip 渲染与回滚列表的「预览长度预算」共用这份规则，避免两处各写一套
 * 显示名逻辑（原始路径、data URL 等不得进入显示文本）。
 */
export const getChipDisplayLabel = (segment: ChipSegment): string => {
  switch (segment.type) {
    case "image": {
      const index = segment.tag.index ?? 0;
      return index > 0 ? `${segment.tag.name} #${index}` : segment.tag.name;
    }
    case "commit":
      return segment.tag.shortHash;
    case "change": {
      const lastSep = Math.max(
        segment.tag.path.lastIndexOf("/"),
        segment.tag.path.lastIndexOf("\\"),
      );
      return lastSep === -1
        ? segment.tag.path
        : segment.tag.path.slice(lastSep + 1);
    }
    case "text-snippet":
    case "quote":
    case "review":
      return segment.tag.summary;
    case "element":
      return segment.tag.note
        ? `${segment.tag.label} · ${segment.tag.note}`
        : segment.tag.label;
    case "web": {
      const host = extractUrlHost(segment.tag.url);
      return segment.tag.title ? `${segment.tag.title} · ${host}` : host;
    }
    case "conversation":
      return segment.tag.title;
    case "skill":
      return segment.tag.name;
    case "command":
      return `/${segment.tag.name}`;
    case "annotation":
      return formatAnnotationLabel(segment.tag);
    case "file-selection":
      return formatFileLinesLabel(
        segment.tag.path,
        segment.tag.startLine,
        segment.tag.endLine,
      );
    case "workflow":
      return formatWorkflowTagLabel(segment.tag);
    default: {
      const { tag } = segment;
      const linesStr = tag.isDirectory
        ? ""
        : formatFileChipLinesLabel(tag.lines);
      return linesStr ? `${tag.name}:${linesStr}` : tag.name;
    }
  }
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
  const chipLinesLabel = tag.isDirectory
    ? ""
    : formatFileChipLinesLabel(tag.lines);
  const displayName = chipLinesLabel
    ? `${tag.name}:${chipLinesLabel}`
    : tag.name;
  return `<span class="file-chip" contenteditable="false" data-file-tag="true" data-file-path="${escapeHtml(
    tag.path,
  )}" data-file-name="${escapeHtml(tag.name)}" data-file-is-dir="${
    tag.isDirectory
  }"${linesAttr}><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    displayName,
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

export const createImageChipHtml = (tag: ImageTag): string => {
  const icon = getFileTypeIconHtml(tag.name, false, false, 12);
  const indexSuffix =
    typeof tag.index === "number" && tag.index > 0 ? ` #${tag.index}` : "";
  return `<span class="file-chip image-chip" contenteditable="false" data-image-tag="true" data-image-name="${escapeHtml(
    tag.name,
  )}" data-image-data-url="${escapeHtml(
    tag.dataUrl,
  )}"><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    `${tag.name}${indexSuffix}`,
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
    }),
  );
  return `<span class="file-chip commit-chip" contenteditable="false" data-commit-tag="true" data-commit-data="${commitData}"><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    tag.shortHash,
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

export const createChangeChipHtml = (tag: ChangeTag): string => {
  const icon = getChangeIconHtml(12);
  const lastSep = Math.max(
    tag.path.lastIndexOf("/"),
    tag.path.lastIndexOf("\\"),
  );
  const name = lastSep === -1 ? tag.path : tag.path.slice(lastSep + 1);
  const changeData = escapeHtml(
    JSON.stringify({
      repoPath: tag.repoPath,
      path: tag.path,
      section: tag.section,
      status: tag.status,
    }),
  );
  return `<span class="file-chip change-chip" contenteditable="false" data-change-tag="true" data-change-data="${changeData}"><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    name,
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

export const createTextSnippetChipHtml = (tag: TextSnippetTag): string => {
  const snippetData = escapeHtml(
    JSON.stringify({
      content: tag.content,
      summary: tag.summary,
      charCount: tag.charCount,
    }),
  );
  const displayName = `${tag.summary} (${tag.charCount} chars)`;
  return `<span class="file-chip text-snippet-chip" contenteditable="false" data-text-snippet-tag="true" data-text-snippet-data="${snippetData}" title="${escapeHtml(
    displayName,
  )}"><span class="file-chip-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9Z"/><path d="M15 3v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg></span><span class="file-chip-name">${escapeHtml(
    tag.summary,
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
    }),
  );
  return `<span class="file-chip review-chip" contenteditable="false" data-review-tag="true" data-review-data="${reviewData}"><span class="file-chip-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/></svg></span><span class="file-chip-name">${escapeHtml(
    tag.summary,
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

const COMMAND_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>';

export const createCommandChipHtml = (tag: CommandTag): string => {
  const commandData = escapeHtml(
    JSON.stringify({
      name: tag.name,
      prompt: utf8ToBase64(tag.prompt),
      charCount: tag.charCount,
    }),
  );
  return `<span class="file-chip command-chip" contenteditable="false" data-command-tag="true" data-command-data="${commandData}"><span class="file-chip-icon">${COMMAND_ICON_SVG}</span><span class="file-chip-name">${escapeHtml(
    `/${tag.name}`,
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
      domTree: utf8ToBase64(tag.domTree),
    }),
  );
  const displayName = tag.note ? `${tag.label} · ${tag.note}` : tag.label;
  return `<span class="file-chip element-chip" contenteditable="false" data-element-tag="true" data-element-data="${elementData}"><span class="file-chip-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></svg></span><span class="file-chip-name">${escapeHtml(
    displayName,
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

/**
 * 生成网页引用 chip HTML。显示「标题 · 域名」，标题缺失时仅显示域名；
 * 完整 URL 与 F4 快照字段（text/elementText/elementSelector）存放在
 * data-web-data 中，供序列化（发送给 AI）与点击打开浏览器使用。
 */
export const createWebTagChipHtml = (tag: WebTag): string => {
  const webData = escapeHtml(
    JSON.stringify({
      url: tag.url,
      title: tag.title,
      instanceId: tag.instanceId,
      text: tag.text,
      elementText: tag.elementText,
      elementSelector: tag.elementSelector,
    }),
  );
  const host = extractUrlHost(tag.url);
  const displayName = tag.title ? `${tag.title} · ${host}` : host;
  return `<span class="file-chip web-chip" contenteditable="false" data-web-tag="true" data-web-data="${webData}" title="${escapeHtml(
    `${displayName} (${tag.url})`,
  )}"><span class="file-chip-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg></span><span class="file-chip-name">${escapeHtml(
    displayName,
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

/**
 * 生成历史会话引用 chip HTML。显示会话标题；
 * 完整会话信息存放在 data-conversation-data 中，供序列化（发送时转为
 * 上下文附件）与剪贴板复制/粘贴还原使用。悬停时由 useChipInteractions
 * 异步加载并预览实际注入的上下文内容，故不再设置原生 title 提示。
 */
export const createConversationChipHtml = (tag: ConversationTag): string => {
  const conversationData = escapeHtml(
    JSON.stringify({
      conversationId: tag.conversationId,
      directoryId: tag.directoryId,
      title: utf8ToBase64(tag.title),
    }),
  );
  const icon =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></svg>';
  return `<span class="file-chip conversation-chip" contenteditable="false" data-conversation-tag="true" data-conversation-data="${conversationData}"><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    tag.title,
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

/**
 * 生成技能引用 chip HTML。显示技能名，悬停提示完整描述；
 * 完整技能信息存放在 data-skill-data 中，供序列化与剪贴板还原。
 */
export const createSkillChipHtml = (tag: SkillTag): string => {
  const skillData = escapeHtml(
    JSON.stringify({
      skillId: tag.skillId,
      name: tag.name,
      description: tag.description,
      location: tag.location,
    }),
  );
  const icon = getSkillIconHtml(tag.skillId);
  const title = tag.description ? `${tag.name} - ${tag.description}` : tag.name;
  return `<span class="file-chip skill-chip" contenteditable="false" data-skill-tag="true" data-skill-data="${skillData}" title="${escapeHtml(
    title,
  )}"><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    tag.name,
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

/**
 * 生成划词引用 chip HTML。显示摘要，悬停提示字符数；
 * 原文存放在 data-quote-data 中，供序列化与剪贴板还原。
 */
export const createQuoteChipHtml = (tag: QuoteTag): string => {
  const quoteData = escapeHtml(
    JSON.stringify({
      content: tag.content,
      summary: tag.summary,
      charCount: tag.charCount,
    }),
  );
  return `<span class="file-chip quote-chip" contenteditable="false" data-quote-tag="true" data-quote-data="${quoteData}" title="${escapeHtml(
    `${tag.summary} (${tag.charCount} chars)`,
  )}"><span class="file-chip-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg></span><span class="file-chip-name">${escapeHtml(
    tag.summary,
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

const ANNOTATION_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/></svg>';

/**
 * 生成文件标注（审阅标注）chip HTML。显示「文件名:行号」，悬停提示标注正文；
 * 完整标注信息存放在 data-annotation-data 中，供序列化与剪贴板还原使用。
 */
export const createAnnotationChipHtml = (tag: AnnotationTag): string => {
  const annotationData = escapeHtml(
    JSON.stringify({
      filePath: tag.filePath,
      startLine: tag.startLine,
      endLine: tag.endLine,
      quote: utf8ToBase64(tag.quote),
      content: utf8ToBase64(tag.content),
      representation: tag.representation,
    }),
  );
  const label = formatAnnotationLabel(tag);
  const title = tag.content.trim() ? `${label} - ${tag.content}` : label;
  return `<span class="file-chip annotation-chip" contenteditable="false" data-annotation-tag="true" data-annotation-data="${annotationData}" title="${escapeHtml(
    title,
  )}"><span class="file-chip-icon">${ANNOTATION_ICON_SVG}</span><span class="file-chip-name">${escapeHtml(
    label,
  )}</span><span class="file-chip-remove" data-chip-remove="true">${CLOSE_ICON_SVG}</span></span>`;
};

/**
 * 生成文件选区引用 chip HTML。显示「文件名:行号」，悬停提示选中内容的摘要；
 * 完整选区信息存放在 data-file-selection-data 中，供序列化（发送给 AI）、
 * 悬停详情预览与剪贴板复制/粘贴还原使用。
 */
export const createFileSelectionChipHtml = (tag: FileSelectionTag): string => {
  const selectionData = escapeHtml(
    JSON.stringify({
      path: tag.path,
      name: tag.name,
      startLine: tag.startLine,
      endLine: tag.endLine,
      content: utf8ToBase64(tag.content),
      representation: tag.representation,
    }),
  );
  const label = formatFileLinesLabel(tag.path, tag.startLine, tag.endLine);
  const summary = buildTextSnippetSummary(tag.content, 60);
  const icon = getFileTypeIconHtml(tag.name, false, false, 12);
  return `<span class="file-chip file-selection-chip" contenteditable="false" data-file-selection-tag="true" data-file-selection-data="${selectionData}" title="${escapeHtml(
    `${label} · ${summary}`,
  )}"><span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(
    label,
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
      if (segment.type === "conversation") {
        return createConversationChipHtml(segment.tag);
      }
      if (segment.type === "quote") {
        return createQuoteChipHtml(segment.tag);
      }
      if (segment.type === "command") {
        return createCommandChipHtml(segment.tag);
      }
      if (segment.type === "skill") {
        return createSkillChipHtml(segment.tag);
      }
      if (segment.type === "annotation") {
        return createAnnotationChipHtml(segment.tag);
      }
      if (segment.type === "file-selection") {
        return createFileSelectionChipHtml(segment.tag);
      }
      // 编排图无法从标签还原，回填输入框时丢弃（只保留备注文本）
      if (segment.type === "workflow") {
        return "";
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
  conversation: (tag: ConversationTag) => string;
  quote: (tag: QuoteTag) => string;
  command: (tag: CommandTag) => string;
  skill: (tag: SkillTag) => string;
  annotation: (tag: AnnotationTag) => string;
  fileSelection: (tag: FileSelectionTag) => string;
};

const readEditableContentWith = (
  el: HTMLElement,
  serializers: ChipSerializers,
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
            elem.dataset.commitData || "{}",
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
            elem.dataset.changeData || "{}",
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
            elem.dataset.textSnippetData || "{}",
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
            elem.dataset.reviewData || "{}",
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
            elem.dataset.elementData || "{}",
          ) as Partial<ElementTag>;
          result += serializers.element({
            url: data.url ?? "",
            tag: data.tag ?? "",
            label: data.label ?? "",
            text: data.text ? base64ToUtf8(data.text) : "",
            note: data.note ? base64ToUtf8(data.note) : "",
            domTree: data.domTree ? base64ToUtf8(data.domTree) : "",
          });
        } catch {
          // Ignore malformed element data
        }
      } else if (elem.dataset.webTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.webData || "{}",
          ) as Partial<WebTag>;
          const url = data.url ?? "";
          if (url) {
            result += serializers.web({
              url,
              title: typeof data.title === "string" ? data.title : undefined,
              instanceId:
                typeof data.instanceId === "string"
                  ? data.instanceId
                  : undefined,
              text: typeof data.text === "string" ? data.text : undefined,
              elementText:
                typeof data.elementText === "string"
                  ? data.elementText
                  : undefined,
              elementSelector:
                typeof data.elementSelector === "string"
                  ? data.elementSelector
                  : undefined,
            });
          }
        } catch {
          // Ignore malformed web data
        }
      } else if (elem.dataset.conversationTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.conversationData || "{}",
          ) as Partial<ConversationTag>;
          if (
            typeof data.conversationId === "string" &&
            data.conversationId.trim().length > 0
          ) {
            result += serializers.conversation({
              conversationId: data.conversationId,
              directoryId:
                typeof data.directoryId === "string" ? data.directoryId : "",
              title: data.title ? base64ToUtf8(data.title) : "",
            });
          }
        } catch {
          // Ignore malformed conversation data
        }
      } else if (elem.dataset.quoteTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.quoteData || "{}",
          ) as Partial<QuoteTag>;
          const quoteContent = data.content ?? "";
          result += serializers.quote({
            content: quoteContent,
            summary: data.summary ?? buildTextSnippetSummary(quoteContent),
            charCount:
              typeof data.charCount === "number"
                ? data.charCount
                : quoteContent.length,
          });
        } catch {
          // Ignore malformed quote data
        }
      } else if (elem.dataset.commandTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.commandData || "{}",
          ) as Partial<CommandTag>;
          const name = typeof data.name === "string" ? data.name.trim() : "";
          if (name) {
            const prompt = data.prompt ? base64ToUtf8(data.prompt) : "";
            result += serializers.command({
              name,
              prompt,
              charCount:
                typeof data.charCount === "number"
                  ? data.charCount
                  : prompt.length,
            });
          }
        } catch {
          // Ignore malformed command data
        }
      } else if (elem.dataset.skillTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.skillData || "{}",
          ) as Partial<SkillTag>;
          const skillId = data.skillId ?? "";
          if (skillId) {
            result += serializers.skill({
              skillId,
              name: data.name || skillId,
              description: data.description ?? "",
              location: data.location === "project" ? "project" : "global",
            });
          }
        } catch {
          // Ignore malformed skill data
        }
      } else if (elem.dataset.annotationTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.annotationData || "{}",
          ) as Partial<AnnotationTag>;
          const filePath =
            typeof data.filePath === "string" ? data.filePath : "";
          if (filePath.trim()) {
            result += serializers.annotation({
              filePath,
              startLine:
                typeof data.startLine === "number" ? data.startLine : 0,
              endLine: typeof data.endLine === "number" ? data.endLine : 0,
              quote: data.quote ? base64ToUtf8(data.quote) : "",
              content: data.content ? base64ToUtf8(data.content) : "",
              representation:
                data.representation === "extracted-text"
                  ? "extracted-text"
                  : "source",
            });
          }
        } catch {
          // Ignore malformed annotation data
        }
      } else if (elem.dataset.fileSelectionTag === "true") {
        try {
          const data = JSON.parse(
            elem.dataset.fileSelectionData || "{}",
          ) as Partial<FileSelectionTag>;
          const path = typeof data.path === "string" ? data.path : "";
          if (path.trim()) {
            result += serializers.fileSelection({
              path,
              name:
                data.name || path.split(/[\\/]/).filter(Boolean).pop() || path,
              startLine:
                typeof data.startLine === "number" ? data.startLine : 0,
              endLine: typeof data.endLine === "number" ? data.endLine : 0,
              content: data.content ? base64ToUtf8(data.content) : "",
              representation:
                data.representation === "extracted-text"
                  ? "extracted-text"
                  : "source",
            });
          }
        } catch {
          // Ignore malformed file-selection data
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
    conversation: encodeConversationTag,
    quote: encodeQuoteTag,
    command: encodeCommandTag,
    skill: encodeSkillTag,
    annotation: encodeAnnotationTag,
    fileSelection: encodeFileSelectionTag,
  });

/**
 * 判断编辑区序列化内容是否为空（用于 data-empty / placeholder 显隐）。
 *
 * 注意不能用 String.prototype.trim() 判断：trim 会删除空格，导致仅含
 * 空格的输入被误判为空（输入空格时 placeholder 不隐藏）；也不能直接
 * 比较 === ""：删除全部内容后浏览器会在 contenteditable 中残留 <br>
 * 或 "\n" 文本节点（均序列化为单个 \n），导致 placeholder 不恢复显示。
 *
 * 因此先剥离换行符 \n：若还剩任何字符（包括空格）都视为真实内容；
 * 若一个不剩，则以换行符数量区分空框形态（Chromium 实测）：
 * - 0~1 个换行符只渲染一个空行，即删除全部内容后的残留形态，视为空；
 * - 2 个及以上换行符渲染出多个空行，即用户在空输入框中主动换行
 *   （insertLineBreak 恰好插入两个 "\n"），视为非空，此时
 *   placeholder 也应消失。
 */
export const isEditableContentEmpty = (content: string): boolean => {
  const withoutBreaks = content.replace(/\n/g, "");
  if (withoutBreaks !== "") {
    return false;
  }
  return content.length <= 1;
};

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
    conversation: (tag) => tag.title,
    quote: (tag) => tag.content,
    command: (tag) => tag.prompt,
    skill: (tag) => tag.name,
    annotation: (tag) =>
      tag.content.trim()
        ? `${formatAnnotationLabel(tag)}\n${tag.content}`
        : formatAnnotationLabel(tag),
    fileSelection: (tag) => {
      const label = formatFileLinesLabel(tag.path, tag.startLine, tag.endLine);
      return tag.content.trim() ? `${label}\n${tag.content}` : label;
    },
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
