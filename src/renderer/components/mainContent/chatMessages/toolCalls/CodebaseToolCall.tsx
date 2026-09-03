import { useMemo, useState } from "react";
import {
  AlertCircle,
  BrainCircuit,
  CheckCircle,
  ChevronRight,
  Database,
  FileCode,
  Hash,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type CodebaseToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedCodebaseArgs = {
  query: string;
  topN?: number;
};

type CodebaseResult = {
  filePath: string;
  relativePath: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
};

type PipelineInfo = {
  type: "cosine" | "reranking" | "agent_review";
  agentReview: boolean;
  reranking: boolean;
  attempts: number;
  refinedQuery: string | null;
  initialCount: number;
  finalCount: number;
};

type ReviewPhase = "reviewing" | "re_searching" | "completed";

type ReviewProgressEvent = {
  type: "codebase_review_progress";
  phase: ReviewPhase;
  attempt: number;
  query: string;
  totalCount: number;
  relevantCount: number | null;
  refinedQuery: string | null;
};

type ParsedCodebaseResult =
  | {
      type: "success";
      query: string;
      results: CodebaseResult[];
      totalResults: number;
      topN: number;
      pipeline: PipelineInfo;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArgs = (args: string): ParsedCodebaseArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed) || typeof parsed.query !== "string") {
      return null;
    }
    const result: ParsedCodebaseArgs = { query: parsed.query };
    if (typeof parsed.topN === "number") {
      result.topN = parsed.topN;
    }
    return result;
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedCodebaseResult => {
  if (!result) {
    return { type: "empty" };
  }

  try {
    const parsed: unknown = JSON.parse(result);

    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }

    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }

    if (typeof parsed.message === "string" && !Array.isArray(parsed.results)) {
      return { type: "error", message: parsed.message };
    }

    if (Array.isArray(parsed.results)) {
      const results: CodebaseResult[] = parsed.results
        .filter(isRecord)
        .filter(
          (r) =>
            typeof r.filePath === "string" &&
            typeof r.relativePath === "string" &&
            typeof r.content === "string",
        )
        .map((r) => ({
          filePath: r.filePath as string,
          relativePath: r.relativePath as string,
          chunkIndex:
            typeof r.chunkIndex === "number" ? (r.chunkIndex as number) : 0,
          startLine:
            typeof r.startLine === "number" ? (r.startLine as number) : 0,
          endLine: typeof r.endLine === "number" ? (r.endLine as number) : 0,
          content: r.content as string,
          score: typeof r.score === "number" ? (r.score as number) : 0,
        }));

      const pipelineRaw = isRecord(parsed.pipeline) ? parsed.pipeline : null;
      const pipeline: PipelineInfo = pipelineRaw
        ? {
            type: (pipelineRaw.type as PipelineInfo["type"]) ?? "cosine",
            agentReview: pipelineRaw.agentReview === true,
            reranking: pipelineRaw.reranking === true,
            attempts:
              typeof pipelineRaw.attempts === "number"
                ? (pipelineRaw.attempts as number)
                : 1,
            refinedQuery:
              typeof pipelineRaw.refinedQuery === "string" &&
              pipelineRaw.refinedQuery.length > 0
                ? (pipelineRaw.refinedQuery as string)
                : null,
            initialCount:
              typeof pipelineRaw.initialCount === "number"
                ? (pipelineRaw.initialCount as number)
                : results.length,
            finalCount:
              typeof pipelineRaw.finalCount === "number"
                ? (pipelineRaw.finalCount as number)
                : results.length,
          }
        : {
            type: "cosine",
            agentReview: false,
            reranking: false,
            attempts: 1,
            refinedQuery: null,
            initialCount: results.length,
            finalCount: results.length,
          };

      return {
        type: "success",
        query: typeof parsed.query === "string" ? (parsed.query as string) : "",
        results,
        totalResults:
          typeof parsed.totalResults === "number"
            ? (parsed.totalResults as number)
            : results.length,
        topN: typeof parsed.topN === "number" ? (parsed.topN as number) : 10,
        pipeline,
      };
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

/// Parse progress events from the streamingStdout string.
///
/// The Rust backend sends each progress event as a JSON object on its
/// own line (terminated by \n). This function splits the accumulated
/// stdout, parses each line as JSON, and returns only the lines that
/// are valid codebase_review_progress events.
///
/// Returns events in the order they were received (oldest first).
const parseProgressEvents = (
  stdout: string | undefined,
): ReviewProgressEvent[] => {
  if (!stdout) {
    return [];
  }

  const events: ReviewProgressEvent[] = [];
  const lines = stdout.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        isRecord(parsed) &&
        parsed.type === "codebase_review_progress" &&
        typeof parsed.phase === "string" &&
        typeof parsed.attempt === "number" &&
        typeof parsed.query === "string" &&
        typeof parsed.totalCount === "number"
      ) {
        events.push({
          type: "codebase_review_progress",
          phase: parsed.phase as ReviewPhase,
          attempt: parsed.attempt as number,
          query: parsed.query as string,
          totalCount: parsed.totalCount as number,
          relevantCount:
            typeof parsed.relevantCount === "number"
              ? (parsed.relevantCount as number)
              : null,
          refinedQuery:
            typeof parsed.refinedQuery === "string" &&
            parsed.refinedQuery.length > 0
              ? (parsed.refinedQuery as string)
              : null,
        });
      }
    } catch {
      // Ignore lines that aren't valid JSON.
    }
  }

  return events;
};

const getFileName = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

const formatScore = (score: number): string => {
  if (score >= 0.8) return `${(score * 100).toFixed(0)}%`;
  return `${(score * 100).toFixed(1)}%`;
};

export const CodebaseToolCall = ({
  toolCall,
}: CodebaseToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  const isRunning = toolCall.status === "running";

  // 文件内容详情默认收起，点击文件头展开
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const toggleFileExpanded = (filePath: string): void => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  const query = parsedArgs?.query ?? "search";
  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;

  const resultCount =
    parsedResult.type === "success" ? parsedResult.totalResults : 0;
  const hasResults = resultCount > 0;

  // Parse real-time progress events from streamingStdout. These are
  // emitted by the Rust backend during the agent review loop, so the
  // UI can show what the review is doing instead of a static spinner.
  const progressEvents = useMemo(
    () => parseProgressEvents(toolCall.streamingStdout),
    [toolCall.streamingStdout],
  );
  const latestProgress =
    progressEvents.length > 0
      ? progressEvents[progressEvents.length - 1]
      : null;

  // Group results by file for display.
  const groupedResults = useMemo(() => {
    if (parsedResult.type !== "success") return null;

    const groups = new Map<string, CodebaseResult[]>();
    for (const result of parsedResult.results) {
      const existing = groups.get(result.relativePath) ?? [];
      existing.push(result);
      groups.set(result.relativePath, existing);
    }

    return Array.from(groups.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }, [parsedResult]);

  // Pipeline summary for the header badge.
  const pipelineBadge = useMemo(() => {
    if (parsedResult.type !== "success") return null;
    const p = parsedResult.pipeline;

    if (p.type === "agent_review") {
      return {
        icon: BrainCircuit,
        label: t("toolCall.codebase.pipeline.agentReview"),
        className: "tool-call-codebase-pipeline-agent",
        detail:
          p.attempts > 1
            ? t("toolCall.codebase.pipeline.attempts", {
                values: { count: p.attempts },
              })
            : null,
      };
    }
    if (p.type === "reranking") {
      return {
        icon: Sparkles,
        label: t("toolCall.codebase.pipeline.reranking"),
        className: "tool-call-codebase-pipeline-rerank",
        detail: null,
      };
    }
    return {
      icon: Search,
      label: t("toolCall.codebase.pipeline.cosine"),
      className: "tool-call-codebase-pipeline-cosine",
      detail: null,
    };
  }, [parsedResult, t]);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.codebase.name")}
      category="search"
      displayName={query.length > 60 ? `${query.slice(0, 60)}...` : query}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" ? (
          <span
            className={`tool-call-codebase-result-count ${
              hasResults
                ? "tool-call-codebase-has-results"
                : "tool-call-codebase-no-results"
            }`}
          >
            {t("toolCall.codebase.resultCount", {
              values: { count: resultCount },
            })}
          </span>
        ) : null
      }
      className="tool-call-codebase"
    >
      <div className="tool-call-body tool-call-codebase-body">
        {/* Search parameters */}
        {parsedArgs ? (
          <div className="tool-call-codebase-params">
            <div className="tool-call-codebase-param-item">
              <Search size={11} aria-hidden="true" />
              <span className="tool-call-codebase-param-label">
                {t("toolCall.codebase.query")}
              </span>
              <code className="tool-call-codebase-param-value">{query}</code>
            </div>
            {parsedArgs.topN !== undefined ? (
              <div className="tool-call-codebase-param-item">
                <Database size={11} aria-hidden="true" />
                <span className="tool-call-codebase-param-label">
                  {t("toolCall.codebase.topN")}
                </span>
                <span className="tool-call-codebase-param-value">
                  {parsedArgs.topN}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Pipeline summary */}
        {pipelineBadge ? (
          <div className="tool-call-codebase-pipeline">
            <pipelineBadge.icon size={12} aria-hidden="true" />
            <span className="tool-call-codebase-pipeline-label">
              {pipelineBadge.label}
            </span>
            {pipelineBadge.detail ? (
              <span className="tool-call-codebase-pipeline-detail">
                {pipelineBadge.detail}
              </span>
            ) : null}
            {parsedResult.type === "success" &&
            parsedResult.pipeline.refinedQuery ? (
              <span
                className="tool-call-codebase-pipeline-refined"
                title={parsedResult.pipeline.refinedQuery}
              >
                <RefreshCw size={10} aria-hidden="true" />
                <span>{t("toolCall.codebase.pipeline.refinedQuery")}</span>
                <code>{parsedResult.pipeline.refinedQuery}</code>
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Agent review progress indicator (shown while running) */}
        {isRunning ? (
          <div className="tool-call-codebase-progress">
            <div className="tool-call-codebase-progress-step">
              <CheckCircle size={11} aria-hidden="true" />
              <span>{t("toolCall.codebase.progress.embedding")}</span>
            </div>
            <div className="tool-call-codebase-progress-step">
              <CheckCircle size={11} aria-hidden="true" />
              <span>{t("toolCall.codebase.progress.searching")}</span>
            </div>
            {latestProgress ? (
              <div className="tool-call-codebase-progress-step tool-call-codebase-progress-active">
                <Loader2
                  size={11}
                  className="tool-call-icon-spinning"
                  aria-hidden="true"
                />
                <span>
                  {latestProgress.phase === "reviewing"
                    ? t("toolCall.codebase.progress.reviewing", {
                        values: {
                          attempt: latestProgress.attempt,
                          total: latestProgress.totalCount,
                        },
                      })
                    : latestProgress.phase === "re_searching"
                      ? t("toolCall.codebase.progress.reSearching", {
                          values: { attempt: latestProgress.attempt },
                        })
                      : t("toolCall.codebase.progress.processing")}
                </span>
                {latestProgress.relevantCount !== null ? (
                  <span className="tool-call-codebase-progress-counts">
                    {t("toolCall.codebase.progress.relevant", {
                      values: {
                        relevant: latestProgress.relevantCount,
                        total: latestProgress.totalCount,
                      },
                    })}
                  </span>
                ) : null}
                {latestProgress.refinedQuery ? (
                  <span
                    className="tool-call-codebase-progress-refined"
                    title={latestProgress.refinedQuery}
                  >
                    <RefreshCw size={9} aria-hidden="true" />
                    <code>{latestProgress.refinedQuery}</code>
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="tool-call-codebase-progress-step tool-call-codebase-progress-active">
                <Loader2
                  size={11}
                  className="tool-call-icon-spinning"
                  aria-hidden="true"
                />
                <span>{t("toolCall.codebase.progress.processing")}</span>
              </div>
            )}
          </div>
        ) : null}

        {/* Error */}
        {hasError ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>
              {parsedResult.type === "error" ? parsedResult.message : ""}
            </span>
          </div>
        ) : null}

        {/* Search results grouped by file, 详情默认收起 */}
        {groupedResults && groupedResults.length > 0 ? (
          <div className="tool-call-codebase-results">
            {groupedResults.map(([filePath, fileResults], groupIdx) => {
              const fileName = getFileName(filePath);
              const fileExpanded = expandedFiles.has(filePath);
              return (
                <div
                  key={`${filePath}-${groupIdx}`}
                  className={`tool-call-codebase-file-group${
                    fileExpanded
                      ? ""
                      : " tool-call-codebase-file-group-collapsed"
                  }`}
                >
                  <div
                    className="tool-call-codebase-file-header"
                    title={filePath}
                    data-path={filePath}
                    role="button"
                    aria-expanded={fileExpanded}
                    onClick={(e) => {
                      // Ctrl+点击保留给"打开文件"语义
                      if (e.ctrlKey || e.metaKey) {
                        return;
                      }
                      toggleFileExpanded(filePath);
                    }}
                  >
                    <ChevronRight
                      size={12}
                      className={`tool-call-codebase-file-chevron${
                        fileExpanded
                          ? " tool-call-codebase-file-chevron-open"
                          : ""
                      }`}
                      aria-hidden="true"
                    />
                    <FileCode size={12} aria-hidden="true" />
                    <span
                      className="tool-call-codebase-file-name"
                      data-path={filePath}
                    >
                      {fileName}
                    </span>
                    <span
                      className="tool-call-codebase-file-path"
                      data-path={filePath}
                    >
                      {filePath}
                    </span>
                    <span className="tool-call-codebase-file-count">
                      {fileResults.length}
                    </span>
                  </div>
                  {fileExpanded ? (
                    <div className="tool-call-codebase-match-list">
                      {fileResults.map((result, matchIdx) => (
                        <div
                          key={`${result.chunkIndex}-${matchIdx}`}
                          className="tool-call-codebase-match-line"
                          data-path={filePath}
                          data-line={result.startLine}
                        >
                          <span className="tool-call-codebase-line-info">
                            <Hash size={9} aria-hidden="true" />
                            {result.startLine}-{result.endLine}
                          </span>
                          <span className="tool-call-codebase-score">
                            {formatScore(result.score)}
                          </span>
                          <code className="tool-call-codebase-line-content">
                            {result.content}
                          </code>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {/* No results */}
        {parsedResult.type === "success" && !hasResults ? (
          <div className="tool-call-codebase-no-results">
            <Search size={14} aria-hidden="true" />
            <span>{t("toolCall.codebase.noResults")}</span>
          </div>
        ) : null}

        {/* Raw result fallback */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.codebase.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* Pending state */}
        {parsedResult.type === "empty" && !isRunning ? (
          <div className="tool-call-codebase-pending">
            <Database size={14} aria-hidden="true" />
            <span>{t("toolCall.codebase.waiting")}</span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
