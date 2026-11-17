import { ChevronDown, ChevronUp } from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useI18n } from "../../../../i18n";
import { HoverCopyButton } from "../../../common/HoverCopyButton";

// Windows 路径 / 多段或 ./ ~/ 开头的 POSIX 路径
const PATH_RE =
  /[A-Za-z]:[\\/][^\s`'"，。；：、（）()<>]*|(?:~|\.{1,2})\/[\w.@/-]+|\/[\w.@-]+(?:\/[\w.@-]+)+\/?/g;

// 命令行（整行等宽）
const COMMAND_LINE_RE =
  /^\s*(?:\$\s|>\s|(?:npm|npx|pnpm|yarn|cargo|git|node|python3?|pip3?|cd|ls|rm|mv|cp|mkdir|docker|make|go|bash|sh)\s)/;

type InlineToken = { type: "text" | "code"; value: string };

/**
 * 按 CommonMark 规则切分行内代码：反引号串必须等长闭合、内容非空，
 * 否则保持原文（`` 这类孤立反引号不再被当成代码）。
 */
const splitCodeSpans = (line: string): InlineToken[] => {
  const tokens: InlineToken[] = [];
  const runs = Array.from(line.matchAll(/`+/g), (match) => ({
    start: match.index ?? 0,
    length: match[0].length,
  }));
  let cursor = 0;
  let runIndex = 0;
  while (runIndex < runs.length) {
    const open = runs[runIndex];
    // 代码片段不跨行（与原行为一致，避免整段被吞）
    const lineBreak = line.indexOf("\n", open.start + open.length);
    const limit = lineBreak === -1 ? line.length : lineBreak;
    const closeIndex = runs.findIndex(
      (run, index) =>
        index > runIndex && run.length === open.length && run.start < limit,
    );
    const close = closeIndex === -1 ? null : runs[closeIndex];
    let content = close
      ? line.slice(open.start + open.length, close.start)
      : "";
    // 首尾各一个空格且有实体内容时各去掉一个
    if (
      content.length >= 2 &&
      content.startsWith(" ") &&
      content.endsWith(" ")
    ) {
      content = content.slice(1, -1);
    }
    if (!close || !content.trim()) {
      runIndex += 1;
      continue;
    }
    if (open.start > cursor) {
      tokens.push({ type: "text", value: line.slice(cursor, open.start) });
    }
    tokens.push({ type: "code", value: content });
    cursor = close.start + close.length;
    runIndex = closeIndex + 1;
  }
  if (cursor < line.length) {
    tokens.push({ type: "text", value: line.slice(cursor) });
  }
  return tokens;
};

type RenderPromptInlineOptions = {
  /** 是否把反引号包裹的内容渲染为行内代码，默认 true */
  codeSpans?: boolean;
};

/** 把一行文本中的路径/行内代码渲染为等宽片段。 */
export const renderPromptInline = (
  line: string,
  keyPrefix = "",
  { codeSpans = true }: RenderPromptInlineOptions = {},
): ReactNode[] => {
  const nodes: ReactNode[] = [];
  const tokens: InlineToken[] = codeSpans
    ? splitCodeSpans(line)
    : [{ type: "text", value: line }];
  tokens.forEach((token, tokenIndex) => {
    if (token.type === "code") {
      nodes.push(
        <code
          key={`${keyPrefix}code-${tokenIndex}`}
          className="prompt-inline-code"
        >
          {token.value}
        </code>,
      );
      return;
    }
    const text = token.value;
    let last = 0;
    for (const match of text.matchAll(PATH_RE)) {
      const index = match.index ?? 0;
      const value = match[0];
      // 前一字符为单词字符时不是独立路径（如 a/b/c、https://）
      if (index > 0 && /\w/.test(text[index - 1])) continue;
      if (index > last) nodes.push(text.slice(last, index));
      nodes.push(
        <code
          key={`${keyPrefix}${tokenIndex}-${index}`}
          className="prompt-inline-code"
        >
          {value}
        </code>,
      );
      last = index + value.length;
    }
    if (last < text.length) nodes.push(text.slice(last));
  });
  return nodes;
};

export const isPromptCommandLine = (line: string): boolean =>
  COMMAND_LINE_RE.test(line);

/** 提示词规模：字符数与行数。 */
export const getPromptStats = (
  text: string,
): { chars: number; lines: number } => ({
  chars: Array.from(text).length,
  lines: text ? text.split("\n").length : 0,
});

type PromptPreviewProps = {
  text: string;
  label?: string;
  /** 收起时显示的行数 */
  collapsedLines?: number;
  className?: string;
};

/** 只读提示词块：规模提示 + 展开/收起 + 复制，保留换行并突出路径/命令。 */
export const PromptPreview = ({
  text,
  label,
  collapsedLines = 3,
  className,
}: PromptPreviewProps): React.JSX.Element => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const normalized = useMemo(() => text.replace(/\r\n/g, "\n"), [text]);
  const lines = useMemo(() => normalized.split("\n"), [normalized]);
  const stats = useMemo(() => getPromptStats(normalized), [normalized]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    const measure = (): void => {
      setOverflowing(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [normalized, expanded]);

  const canToggle = expanded || overflowing;
  const rootClassName = [
    "prompt-preview",
    expanded ? "is-expanded" : "",
    !expanded && overflowing ? "is-overflowing" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rootClassName}
      style={{ "--prompt-preview-lines": collapsedLines } as CSSProperties}
    >
      <div className="prompt-preview-head">
        <span className="prompt-preview-label">
          {label ?? t("chat.promptPreview.label")}
        </span>
        <span className="prompt-preview-stats">
          {t("chat.promptPreview.stats", {
            values: { chars: stats.chars, lines: stats.lines },
          })}
        </span>
        <span className="prompt-preview-actions">
          {canToggle ? (
            <button
              type="button"
              className="prompt-preview-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? t("chat.message.collapse") : t("chat.message.expand")}
            </button>
          ) : null}
          <HoverCopyButton
            text={normalized}
            className="prompt-preview-copy"
            label={t("common.copy")}
          />
        </span>
      </div>
      <div ref={bodyRef} className="prompt-preview-body">
        {lines.map((line, index) =>
          line.trim() ? (
            <div
              key={index}
              className={`prompt-preview-line${
                isPromptCommandLine(line) ? " is-command" : ""
              }`}
            >
              {renderPromptInline(line, `${index}-`)}
            </div>
          ) : (
            <div
              key={index}
              className="prompt-preview-gap"
              aria-hidden="true"
            />
          ),
        )}
      </div>
    </div>
  );
};
