import { useMemo, useState, type ReactNode } from "react";
import { AlertCircle, Copy, Check } from "lucide-react";
import { useI18n } from "../../../../../i18n";

export type DiagnosticStream = "stdout" | "stderr";

/** 单条诊断：行号相对所属输出流，块用 endLine 表示范围。 */
export type BashDiagnosticItem = {
  severity: "error" | "warning";
  stream: DiagnosticStream;
  line: number;
  endLine: number;
  confidence: "high" | "medium";
  rule: string;
  message: string;
};

export type BashDiagnostics = {
  complete: boolean;
  commandKind: string;
  counts: { error: number; warning: number };
  items: BashDiagnosticItem[];
};

export type BashOutputSegment = {
  stream: DiagnosticStream;
  text: string;
};

type AnsiOutputProps = {
  /** 无法分流的原始文本（旧记录 / 非结构化结果）。 */
  text?: string;
  segments?: BashOutputSegment[];
  diagnostics?: BashDiagnostics;
  className?: string;
};

type StyledSpan = {
  text: string;
  color?: string;
  bold?: boolean;
  underline?: boolean;
};

type LineSeverity = "error" | "warning" | "hint" | "context";

/** 过滤视图在诊断块两侧保留的上下文行数。 */
const CONTEXT_LINES = 2;

// ANSI 颜色映射表 (标准终端 16 色)
const ANSI_COLOR_MAP: Record<number, string> = {
  30: "var(--text-muted, #6e7681)", // Black / Muted
  31: "#f85149", // Red
  32: "#3fb950", // Green
  33: "#d29922", // Yellow
  34: "#58a6ff", // Blue
  35: "#bc8cff", // Magenta
  36: "#39c5cf", // Cyan
  37: "var(--text-primary, #e6edf3)", // White
  90: "#8b949e", // Bright Black (Gray)
  91: "#ff7b72", // Bright Red
  92: "#56d364", // Bright Green
  93: "#e3b341", // Bright Yellow
  94: "#79c0ff", // Bright Blue
  95: "#d2a8ff", // Bright Magenta
  96: "#56d4dd", // Bright Cyan
  97: "#ffffff", // Bright White
};

/**
 * 轻量高性能 ANSI 转义码解析器
 */
const parseAnsiLine = (line: string): StyledSpan[] => {
  // 匹配 \u001b[...m 序列
  const regex = /\u001b\[([0-9;]*)m/g;
  const spans: StyledSpan[] = [];
  let lastIndex = 0;
  let currentColor: string | undefined;
  let isBold = false;
  let isUnderline = false;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      spans.push({
        text: line.slice(lastIndex, match.index),
        color: currentColor,
        bold: isBold,
        underline: isUnderline,
      });
    }

    const codes = match[1]
      ? match[1].split(";").map((c) => parseInt(c, 10))
      : [0];

    for (const code of codes) {
      if (code === 0) {
        currentColor = undefined;
        isBold = false;
        isUnderline = false;
      } else if (code === 1) {
        isBold = true;
      } else if (code === 4) {
        isUnderline = true;
      } else if (code === 22) {
        isBold = false;
      } else if (code === 24) {
        isUnderline = false;
      } else if (ANSI_COLOR_MAP[code]) {
        currentColor = ANSI_COLOR_MAP[code];
      }
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    spans.push({
      text: line.slice(lastIndex),
      color: currentColor,
      bold: isBold,
      underline: isUnderline,
    });
  }

  return spans.length > 0 ? spans : [{ text: line }];
};

const splitLines = (text: string): string[] => text.split(/\r?\n/);

const severityOf = (item: BashDiagnosticItem): LineSeverity => {
  if (item.severity === "warning") {
    return "warning";
  }
  // 只有高置信度的命中有资格使用错误色；兜底/弱规则用提示色。
  return item.confidence === "high" ? "error" : "hint";
};

type Range = [number, number];

const mergeRanges = (ranges: Range[]): Range[] => {
  const sorted = ranges
    .map(([start, end]) => [Math.max(0, start), Math.max(0, end)] as Range)
    .sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1] + 1) {
      merged.push([start, end]);
      continue;
    }
    last[1] = Math.max(last[1], end);
  }
  return merged;
};

export const AnsiOutput = ({
  text = "",
  segments,
  diagnostics,
  className = "",
}: AnsiOutputProps): React.JSX.Element => {
  const { t } = useI18n();
  const [filterMode, setFilterMode] = useState<"all" | "diagnostics">("all");
  const [copied, setCopied] = useState(false);

  const resolvedSegments = useMemo<BashOutputSegment[]>(() => {
    if (segments && segments.length > 0) {
      return segments.filter((segment) => segment.text.length > 0);
    }
    return text ? [{ stream: "stdout", text }] : [];
  }, [segments, text]);

  const items = diagnostics?.items ?? [];
  const hasDiagnostics = items.length > 0;
  const effectiveFilter =
    filterMode === "diagnostics" && hasDiagnostics ? "diagnostics" : "all";

  const annotations = useMemo(() => {
    const result: Record<DiagnosticStream, Map<number, LineSeverity>> = {
      stdout: new Map(),
      stderr: new Map(),
    };
    for (const item of items) {
      const target = result[item.stream];
      if (!target) {
        continue;
      }
      const severity = severityOf(item);
      if (!target.has(item.line)) {
        target.set(item.line, severity);
      }
      for (let line = item.line + 1; line <= item.endLine; line += 1) {
        if (!target.has(line)) {
          target.set(line, "context");
        }
      }
    }
    return result;
  }, [items]);

  const ranges = useMemo(() => {
    const grouped: Record<DiagnosticStream, Range[]> = {
      stdout: [],
      stderr: [],
    };
    for (const item of items) {
      grouped[item.stream]?.push([
        item.line - CONTEXT_LINES,
        item.endLine + CONTEXT_LINES,
      ]);
    }
    return {
      stdout: mergeRanges(grouped.stdout),
      stderr: mergeRanges(grouped.stderr),
    };
  }, [items]);

  const totalLines = useMemo(
    () =>
      resolvedSegments.reduce(
        (sum, segment) => sum + splitLines(segment.text).length,
        0,
      ),
    [resolvedSegments],
  );

  const copyText = useMemo(
    () => resolvedSegments.map((segment) => segment.text).join("\n"),
    [resolvedSegments],
  );

  const handleCopy = (event: React.MouseEvent): void => {
    event.stopPropagation();
    // 拷贝时剥离 ANSI 控制码
    navigator.clipboard.writeText(copyText.replace(/\u001b\[[0-9;]*m/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const renderLine = (
    stream: DiagnosticStream,
    line: string,
    index: number,
  ): ReactNode => {
    const spans = parseAnsiLine(line);
    const severity = annotations[stream].get(index);
    return (
      <div
        key={`${stream}-${index}`}
        className={`tool-call-ansi-line${severity ? ` is-diagnostic-${severity}` : ""}`}
      >
        {spans.map((span, spanIdx) => (
          <span
            key={spanIdx}
            style={{
              color: span.color,
              fontWeight: span.bold ? "bold" : "normal",
              textDecoration: span.underline ? "underline" : "none",
            }}
          >
            {span.text}
          </span>
        ))}
      </div>
    );
  };

  const renderSegment = (
    segment: BashOutputSegment,
    segmentIndex: number,
  ): ReactNode => {
    const lines = splitLines(segment.text);
    const nodes: ReactNode[] = [];

    if (effectiveFilter === "diagnostics") {
      const segmentRanges = ranges[segment.stream];
      if (segmentRanges.length === 0) {
        return null;
      }
      let cursor = 0;
      for (const [rangeStart, rangeEnd] of segmentRanges) {
        const from = Math.min(Math.max(0, rangeStart), lines.length);
        const to = Math.min(Math.max(0, rangeEnd), lines.length - 1);
        if (from > cursor) {
          nodes.push(
            <div
              className="tool-call-ansi-omitted"
              key={`omitted-${segment.stream}-${segmentIndex}-${cursor}`}
            >
              {t("toolCall.common.omittedLines", {
                values: { count: from - cursor },
              })}
            </div>,
          );
        }
        for (let line = from; line <= to; line += 1) {
          nodes.push(renderLine(segment.stream, lines[line], line));
        }
        cursor = Math.max(cursor, to + 1);
      }
      if (cursor < lines.length) {
        nodes.push(
          <div
            className="tool-call-ansi-omitted"
            key={`omitted-${segment.stream}-${segmentIndex}-${cursor}`}
          >
            {t("toolCall.common.omittedLines", {
              values: { count: lines.length - cursor },
            })}
          </div>,
        );
      }
    } else {
      lines.forEach((line, index) => {
        nodes.push(renderLine(segment.stream, line, index));
      });
    }

    return (
      <div
        className={`tool-call-ansi-stream tool-call-ansi-stream-${segment.stream}`}
        key={`${segment.stream}-${segmentIndex}`}
      >
        {segment.stream === "stderr" ? (
          <div className="tool-call-ansi-stream-label">
            {t("toolCall.bash.stderrStream")}
          </div>
        ) : null}
        <pre className="tool-call-section-pre tool-call-bash-output-pre tool-call-ansi-pre">
          {nodes}
        </pre>
      </div>
    );
  };

  return (
    <div className={`tool-call-ansi-container ${className}`}>
      {hasDiagnostics ? (
        <div className="tool-call-ansi-toolbar">
          <div className="tool-call-ansi-filter-tabs">
            <button
              type="button"
              className={`tool-call-ansi-filter-btn ${
                effectiveFilter === "all" ? "active" : ""
              }`}
              onClick={(event) => {
                event.stopPropagation();
                setFilterMode("all");
              }}
            >
              {t("toolCall.common.filterAll", {
                values: { count: totalLines },
              })}
            </button>
            <button
              type="button"
              className={`tool-call-ansi-filter-btn tool-call-ansi-filter-err ${
                effectiveFilter === "diagnostics" ? "active" : ""
              }`}
              onClick={(event) => {
                event.stopPropagation();
                setFilterMode("diagnostics");
              }}
            >
              <AlertCircle size={10} aria-hidden="true" />
              {t("toolCall.common.filterDiagnostics", {
                values: { count: items.length },
              })}
            </button>
            {diagnostics?.complete === false ? (
              <span className="tool-call-ansi-incomplete">
                {t("toolCall.common.diagnosticsIncomplete")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="tool-call-ansi-output">
        {resolvedSegments.map(renderSegment)}
        <button
          type="button"
          className="tool-call-ansi-copy-btn"
          onClick={handleCopy}
          title={t("toolCall.common.copyOutput")}
        >
          {copied ? (
            <Check size={11} aria-hidden="true" />
          ) : (
            <Copy size={11} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
};
