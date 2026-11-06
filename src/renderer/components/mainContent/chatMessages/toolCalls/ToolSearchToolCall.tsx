import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Copy, Info, Search, Wrench } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { loadPluginMessages } from "../../../../plugins/manifest";
import { usePluginStore } from "../../../../plugins/pluginStore";
import { usePluginToolOwnerInfo } from "../../../../plugins/pluginToolIndex";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { GenericToolCall } from "./GenericToolCall";
import { ToolCallNode } from "./shared/ToolCallNode";

type ToolSearchToolCallProps = {
  toolCall: ToolCallInfo;
};

type DiscoveredTool = {
  name: string;
  server: string;
  description: string;
};

type DiscoveryFailure = {
  pluginId: string;
  server: string;
  error: string;
};

type DiscoveryResult = {
  status: string;
  tools: DiscoveredTool[];
  failures: DiscoveryFailure[];
  hint: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArguments = (
  raw: string | undefined,
): { query?: string; server?: string; limit?: number } => {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return {};
    return {
      query: typeof value.query === "string" ? value.query : undefined,
      server: typeof value.server === "string" ? value.server : undefined,
      limit: typeof value.limit === "number" ? value.limit : undefined,
    };
  } catch {
    return {};
  }
};

const parseResult = (raw: string | undefined): DiscoveryResult | null => {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.status !== "string" ||
      !Array.isArray(value.tools) ||
      !Array.isArray(value.failures)
    ) {
      return null;
    }
    const tools = value.tools.flatMap((tool): DiscoveredTool[] =>
      isRecord(tool) &&
      typeof tool.name === "string" &&
      typeof tool.server === "string" &&
      typeof tool.description === "string"
        ? [
            {
              name: tool.name,
              server: tool.server,
              description: tool.description,
            },
          ]
        : [],
    );
    const failures = value.failures.flatMap((failure): DiscoveryFailure[] =>
      isRecord(failure) && typeof failure.error === "string"
        ? [
            {
              pluginId:
                typeof failure.pluginId === "string" ? failure.pluginId : "",
              server: typeof failure.server === "string" ? failure.server : "",
              error: failure.error,
            },
          ]
        : [],
    );
    return {
      status: value.status,
      tools,
      failures,
      hint: typeof value.hint === "string" ? value.hint : "",
    };
  } catch {
    return null;
  }
};

const CopyToolNameButton = ({ name }: { name: string }): React.JSX.Element => {
  const { t } = useI18n();
  const [outcome, setOutcome] = useState<"idle" | "copied" | "error">("idle");
  const label =
    outcome === "copied"
      ? t("toolResults.copied")
      : outcome === "error"
        ? t("toolResults.copyFailed")
        : t("toolCall.toolSearch.copyName");

  return (
    <button
      type="button"
      className={`tool-search-copy${outcome === "error" ? " tool-search-copy-error" : ""}`}
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(name);
          setOutcome("copied");
        } catch {
          setOutcome("error");
        }
      }}
    >
      {outcome === "copied" ? (
        <Check size={12} aria-hidden="true" />
      ) : outcome === "error" ? (
        <AlertCircle size={12} aria-hidden="true" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
      <span aria-live="polite">{label}</span>
    </button>
  );
};

const DiscoveredToolRow = ({
  tool,
}: {
  tool: DiscoveredTool;
}): React.JSX.Element => {
  const { t, locale } = useI18n();
  const owner = usePluginToolOwnerInfo(tool.name);
  const { plugins } = usePluginStore();
  const plugin = owner
    ? (plugins.find((item) => item.pluginId === owner.pluginId) ?? null)
    : null;
  const [messages, setMessages] = useState<Record<string, string>>({});

  useEffect(() => {
    setMessages({});
    if (!plugin || !owner) return;
    const controller = new AbortController();
    void loadPluginMessages(plugin, locale, controller.signal).then((next) => {
      if (!controller.signal.aborted) setMessages(next);
    });
    return () => controller.abort();
  }, [plugin, owner, locale]);

  const localizedName = owner
    ? messages[`toolNames.${owner.toolName}`]
    : undefined;

  return (
    <article className="tool-search-tool" role="listitem">
      <div className="tool-search-tool-header">
        <Wrench
          className="tool-search-tool-icon"
          size={14}
          aria-hidden="true"
        />
        <code className="tool-search-tool-name" title={tool.name}>
          {localizedName || tool.name}
        </code>
        <span
          className="tool-search-server"
          title={t("toolCall.toolSearch.server", {
            values: { server: tool.server },
          })}
        >
          {tool.server}
        </span>
        <CopyToolNameButton name={tool.name} />
      </div>
      <p className="tool-search-description">{tool.description}</p>
    </article>
  );
};

export const ToolSearchToolCall = ({
  toolCall,
}: ToolSearchToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const args = useMemo(
    () => parseArguments(toolCall.arguments),
    [toolCall.arguments],
  );
  const result = useMemo(() => parseResult(toolCall.result), [toolCall.result]);

  if (toolCall.result && !result) {
    return <GenericToolCall toolCall={toolCall} />;
  }

  const running = toolCall.status === "running";
  const failed = result?.status === "discovery_failed";
  const query = args.query?.trim();
  const summary = query
    ? query.length > 72
      ? `${query.slice(0, 72)}…`
      : query
    : args.server;

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="search"
      displayName={summary}
      displayNameTitle={query}
      status={failed ? "error" : toolCall.status}
      meta={
        result ? (
          <span className="tool-search-count">
            {t("toolCall.toolSearch.toolCount", {
              values: { count: result.tools.length },
            })}
          </span>
        ) : null
      }
      className="tool-search-call"
      lazyBody
    >
      <div className="tool-search-result">
        {result && result.tools.length > 0 ? (
          <div
            className="tool-search-tools"
            role="list"
            aria-label={t("toolCall.toolSearch.results")}
          >
            {result.tools.map((tool) => (
              <DiscoveredToolRow key={tool.name} tool={tool} />
            ))}
          </div>
        ) : null}

        {result && result.tools.length === 0 && result.failures.length === 0 ? (
          <div className="tool-search-empty">
            <Search size={16} aria-hidden="true" />
            <span>{t(`toolCall.toolSearch.status.${result.status}`)}</span>
          </div>
        ) : null}

        {!result && running ? (
          <div className="tool-search-empty">
            <Search size={16} aria-hidden="true" />
            <span>{t("toolCall.toolSearch.searching")}</span>
          </div>
        ) : null}

        {result && result.failures.length > 0 ? (
          <section className="tool-search-failures">
            <h4 className="tool-search-failures-title">
              <AlertCircle size={13} aria-hidden="true" />
              {t("toolCall.toolSearch.failures", {
                values: { count: result.failures.length },
              })}
            </h4>
            {result.failures.map((failure, index) => (
              <div
                className="tool-search-failure"
                key={`${failure.pluginId}-${failure.server}-${index}`}
              >
                <code>{failure.server || failure.pluginId}</code>
                <p>{failure.error}</p>
              </div>
            ))}
          </section>
        ) : null}

        <div className="tool-search-meta">
          {args.server ? (
            <span>
              {t("toolCall.toolSearch.serverScope", {
                values: { server: args.server },
              })}
            </span>
          ) : null}
          {args.limit !== undefined ? (
            <span>
              {t("toolCall.toolSearch.limit", {
                values: { count: args.limit },
              })}
            </span>
          ) : null}
        </div>

        {result?.hint ? (
          <div className="tool-search-hint">
            <Info size={12} aria-hidden="true" />
            <span>{result.hint}</span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
