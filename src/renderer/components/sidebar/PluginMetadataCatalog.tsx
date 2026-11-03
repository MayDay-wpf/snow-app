import { Database, Globe, Search, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { resolveLocalized } from "../../plugins/manifest";
import {
  METADATA_DOMAINS,
  describeMetadataDomains,
} from "../../plugins/metadata";
import {
  METADATA_DOMAIN_GROUP_IDS,
  resolveMetadataDomainEntry,
  type MetadataDomainGroupId,
} from "../../plugins/metadata/catalog";
import type { PluginView, SensitiveScope } from "../../plugins/types";
import { describeWriteDomains } from "../../plugins/writes";
import { WRITE_ACTIONS } from "../../plugins/writes/domains";

type PluginMetadataCatalogProps = {
  plugin: PluginView | null;
  onClearPlugin: () => void;
};

type PluginWriteRow = {
  id: string;
  summary: string;
  scope: SensitiveScope | null;
  granted: boolean | null;
};

type MetadataDomainRow = {
  id: string;
  group: MetadataDomainGroupId;
  summary: string;
  params: string[];
  scope: SensitiveScope | null;
  sensitiveFields: string[];
  live: boolean;
  granted: boolean | null;
};

type CatalogTab = "metadata" | "write" | "net";

type NetCapabilityRow = {
  id: string;
  summary: string;
  params: string[];
};

export const PluginMetadataCatalog = ({
  plugin,
  onClearPlugin,
}: PluginMetadataCatalogProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<CatalogTab>("metadata");

  const scopeLabel = (scope: SensitiveScope): string =>
    t(`plugins.scopes.${scope}`, { defaultValue: scope });

  const rows = useMemo<MetadataDomainRow[]>(() => {
    const grantedById = plugin
      ? new Map(
          describeMetadataDomains(plugin).map((item) => [
            item.id,
            item.granted,
          ]),
        )
      : null;
    return METADATA_DOMAINS.map((definition) => {
      const entry = resolveMetadataDomainEntry(definition.id);
      return {
        id: definition.id,
        group: entry.group,
        summary: entry.summary[locale],
        params: entry.params,
        scope: definition.scope ?? null,
        sensitiveFields: Object.keys(definition.sensitiveFields ?? {}),
        live: Boolean(definition.live),
        granted: grantedById ? (grantedById.get(definition.id) ?? null) : null,
      };
    });
  }, [locale, plugin]);

  const writeRows = useMemo<PluginWriteRow[]>(() => {
    if (!plugin) {
      return WRITE_ACTIONS.map((definition) => ({
        id: `${definition.domain}.${definition.action}`,
        summary: definition.summary[locale] ?? definition.summary.en ?? "",
        scope: definition.scope,
        granted: null,
      }));
    }
    return describeWriteDomains(plugin, locale).flatMap((domain) =>
      domain.actions.map((action) => ({
        id: action.id,
        summary: action.summary,
        scope: action.scope,
        granted: action.granted,
      })),
    );
  }, [locale, plugin]);

  const netRows = useMemo<NetCapabilityRow[]>(
    () => [
      {
        id: "api.net.fetch",
        summary: t("plugins.net.fetchSummary", {
          defaultValue:
            "Sends an external HTTP request (http/https only): follows the app proxy settings, bypasses CORS, and sends no cookies.",
        }),
        params: [
          "url",
          "method",
          "headers",
          "body",
          "timeoutMs",
          "responseType",
        ],
      },
      {
        id: "ctx.ws.connect",
        summary: t("plugins.net.wsSummary", {
          defaultValue:
            "Opens a long-lived WebSocket connection from a resident background module: http/https URLs map to ws/wss, wss uses the system TLS, text frames are sent with send(), received frames fire onMessage, and connections close when the background module stops. Up to 32 concurrent connections, 4 MiB per message.",
        }),
        params: ["url", "headers", "onOpen", "onMessage", "onError", "onClose"],
      },
    ],
    [t],
  );

  const grantedCount = rows.filter((row) => row.granted).length;
  const writeGrantedCount = writeRows.filter((row) => row.granted).length;

  const keyword = query.trim().toLowerCase();

  const matched = keyword
    ? rows.filter((row) =>
        [
          row.id,
          row.summary,
          row.scope ? scopeLabel(row.scope) : "",
          ...row.params,
          ...row.sensitiveFields,
        ].some((value) => value.toLowerCase().includes(keyword)),
      )
    : rows;

  const matchedWrites = keyword
    ? writeRows.filter((row) =>
        [row.id, row.summary, row.scope ? scopeLabel(row.scope) : ""].some(
          (value) => value.toLowerCase().includes(keyword),
        ),
      )
    : writeRows;

  const matchedNet = keyword
    ? netRows.filter((row) =>
        [row.id, row.summary, ...row.params].some((value) =>
          value.toLowerCase().includes(keyword),
        ),
      )
    : netRows;

  const sections = METADATA_DOMAIN_GROUP_IDS.map((group) => ({
    group,
    items: matched.filter((row) => row.group === group),
  })).filter((section) => section.items.length > 0);

  const writeSections = (() => {
    const order: string[] = [];
    const byDomain = new Map<string, PluginWriteRow[]>();
    for (const row of matchedWrites) {
      const separator = row.id.indexOf(".");
      const domain = separator > 0 ? row.id.slice(0, separator) : row.id;
      let items = byDomain.get(domain);
      if (!items) {
        items = [];
        byDomain.set(domain, items);
        order.push(domain);
      }
      items.push(row);
    }
    return order.map((domain) => ({
      domain,
      items: byDomain.get(domain) ?? [],
    }));
  })();

  const pluginName = plugin
    ? resolveLocalized(plugin.name, locale) || plugin.pluginId
    : "";

  return (
    <div className="plugin-metadata-body">
      <div className="import-settings-tabs plugin-metadata-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "metadata"}
          className={`import-settings-tab ${activeTab === "metadata" ? "active" : ""}`}
          onClick={() => setActiveTab("metadata")}
        >
          <Database size={13} strokeWidth={1.8} />
          {t("plugins.metadata.tabMetadata", {
            defaultValue: "Reading",
          })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "write"}
          className={`import-settings-tab ${activeTab === "write" ? "active" : ""}`}
          onClick={() => setActiveTab("write")}
        >
          <ShieldAlert size={13} strokeWidth={1.8} />
          {t("plugins.write.tabWrite", {
            defaultValue: "Writable",
          })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "net"}
          className={`import-settings-tab ${activeTab === "net" ? "active" : ""}`}
          onClick={() => setActiveTab("net")}
        >
          <Globe size={13} strokeWidth={1.8} />
          {t("plugins.net.tabNet", {
            defaultValue: "Network",
          })}
        </button>
      </div>

      <div className="plugin-metadata-toolbar">
        <div className="plugin-metadata-search">
          <Search size={14} strokeWidth={1.8} />
          <input
            aria-label={t("plugins.metadata.searchPlaceholder", {
              defaultValue: "Search domains, fields or parameters",
            })}
            className="plugin-metadata-search-input"
            type="text"
            value={query}
            placeholder={t("plugins.metadata.searchPlaceholder", {
              defaultValue: "Search domains, fields or parameters",
            })}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="plugin-metadata-count">
          {activeTab === "metadata"
            ? t("plugins.metadata.count", {
                values: { matched: matched.length, total: rows.length },
                defaultValue: "{{matched}} / {{total}} domains",
              })
            : activeTab === "write"
              ? t("plugins.write.count", {
                  values: {
                    matched: matchedWrites.length,
                    total: writeRows.length,
                  },
                  defaultValue: "{{matched}} / {{total}} actions",
                })
              : t("plugins.net.count", {
                  values: {
                    matched: matchedNet.length,
                    total: netRows.length,
                  },
                  defaultValue: "{{matched}} / {{total}} capabilities",
                })}
        </span>
      </div>

      {activeTab === "metadata" ? (
        <>
          <div className="plugin-metadata-caption">
            {t("plugins.metadata.description", {
              defaultValue:
                "App metadata domains a plugin can read through api.metadata (read-only).",
            })}
          </div>

          {plugin && (
            <div className="plugin-metadata-context">
              <ShieldAlert size={13} strokeWidth={1.8} />
              <span>
                {t("plugins.metadata.pluginContext", {
                  values: {
                    name: pluginName,
                    granted: grantedCount,
                    total: rows.length,
                  },
                  defaultValue:
                    "{{name}}: {{granted}} / {{total}} domains readable",
                })}
              </span>
              <button
                className="plugin-metadata-context-clear"
                onClick={onClearPlugin}
                type="button"
              >
                {t("plugins.metadata.contextClear", {
                  defaultValue: "Show all domains",
                })}
              </button>
            </div>
          )}

          <div className="plugin-metadata-list">
            {sections.map((section) => (
              <div className="plugin-metadata-group" key={section.group}>
                <div className="plugin-metadata-group-title">
                  {t(`plugins.metadata.groups.${section.group}`, {
                    defaultValue: section.group,
                  })}
                </div>
                {section.items.map((row) => (
                  <div className="plugin-metadata-item" key={row.id}>
                    <div className="plugin-metadata-item-head">
                      <code className="plugin-metadata-id">{row.id}</code>
                      <div className="plugin-metadata-badges">
                        {row.scope ? (
                          <span
                            className="plugin-metadata-badge scope"
                            title={t("plugins.metadata.scopeHint", {
                              values: { scope: scopeLabel(row.scope) },
                              defaultValue:
                                "Reading this domain requires declaring the “{{scope}}” privacy scope in plugin.json",
                            })}
                          >
                            {scopeLabel(row.scope)}
                          </span>
                        ) : row.sensitiveFields.length > 0 ? (
                          <span
                            className="plugin-metadata-badge field"
                            title={row.sensitiveFields.join(", ")}
                          >
                            {t("plugins.metadata.fieldLevel", {
                              defaultValue: "Field-level",
                            })}
                          </span>
                        ) : (
                          <span className="plugin-metadata-badge public">
                            {t("plugins.metadata.public", {
                              defaultValue: "Public",
                            })}
                          </span>
                        )}
                        <span
                          className={`plugin-metadata-badge${
                            row.live ? " live" : " polled"
                          }`}
                        >
                          {row.live
                            ? t("plugins.metadata.live", {
                                defaultValue: "Live",
                              })
                            : t("plugins.metadata.polled", {
                                defaultValue: "Polled",
                              })}
                        </span>
                        {row.granted !== null && (
                          <span
                            className={`plugin-metadata-badge${
                              row.granted ? " granted" : " denied"
                            }`}
                          >
                            {row.granted
                              ? t("plugins.metadata.granted", {
                                  defaultValue: "Readable",
                                })
                              : t("plugins.metadata.denied", {
                                  defaultValue: "Not declared",
                                })}
                          </span>
                        )}
                      </div>
                    </div>

                    {row.summary && (
                      <div className="plugin-metadata-summary">
                        {row.summary}
                      </div>
                    )}

                    {row.params.length > 0 && (
                      <div className="plugin-metadata-params">
                        <span className="plugin-metadata-params-label">
                          {t("plugins.metadata.params", {
                            defaultValue: "Parameters",
                          })}
                        </span>
                        {row.params.map((param) => (
                          <code className="plugin-metadata-param" key={param}>
                            {param}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}

            {sections.length === 0 && (
              <div className="plugin-metadata-empty">
                {t("plugins.metadata.empty", {
                  defaultValue: "No matching metadata domain",
                })}
              </div>
            )}
          </div>

          <div className="plugin-metadata-hint">
            {t("plugins.metadata.docHint", {
              defaultValue:
                "Full fields and examples: the built-in plugin metadata domain reference.",
            })}
          </div>
        </>
      ) : activeTab === "write" ? (
        <>
          <div className="plugin-metadata-caption">
            {t("plugins.write.description", {
              defaultValue:
                "Write actions a plugin can call through api.write; sensitive ones require the same privacy declaration as reads.",
            })}
          </div>

          {plugin && (
            <div className="plugin-metadata-context">
              <ShieldAlert size={13} strokeWidth={1.8} />
              <span>
                {t("plugins.write.pluginContext", {
                  values: {
                    name: pluginName,
                    granted: writeGrantedCount,
                    total: writeRows.length,
                  },
                  defaultValue:
                    "{{name}}: {{granted}} / {{total}} write actions declared",
                })}
              </span>
              <button
                className="plugin-metadata-context-clear"
                onClick={onClearPlugin}
                type="button"
              >
                {t("plugins.metadata.contextClear", {
                  defaultValue: "Show all domains",
                })}
              </button>
            </div>
          )}

          <div className="plugin-metadata-list">
            {writeSections.map((section) => (
              <div className="plugin-metadata-group" key={section.domain}>
                <div className="plugin-metadata-group-title">
                  {section.domain}
                </div>
                {section.items.map((row) => (
                  <div className="plugin-metadata-item" key={row.id}>
                    <div className="plugin-metadata-item-head">
                      <code className="plugin-metadata-id">{row.id}</code>
                      <div className="plugin-metadata-badges">
                        {row.scope ? (
                          <span
                            className="plugin-metadata-badge scope"
                            title={t("plugins.write.scopeHint", {
                              values: { scope: scopeLabel(row.scope) },
                              defaultValue:
                                "Calling this action requires declaring the “{{scope}}” privacy scope in plugin.json",
                            })}
                          >
                            {scopeLabel(row.scope)}
                          </span>
                        ) : (
                          <span className="plugin-metadata-badge public">
                            {t("plugins.metadata.public", {
                              defaultValue: "Public",
                            })}
                          </span>
                        )}
                        {row.granted !== null && (
                          <span
                            className={`plugin-metadata-badge${
                              row.granted ? " granted" : " denied"
                            }`}
                          >
                            {row.granted
                              ? t("plugins.write.granted", {
                                  defaultValue: "Writable",
                                })
                              : t("plugins.write.denied", {
                                  defaultValue: "Not declared",
                                })}
                          </span>
                        )}
                      </div>
                    </div>
                    {row.summary && (
                      <div className="plugin-metadata-summary">
                        {row.summary}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}

            {writeSections.length === 0 && (
              <div className="plugin-metadata-empty">
                {t("plugins.write.empty", {
                  defaultValue: "No matching write action",
                })}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="plugin-metadata-caption">
            {t("plugins.net.description", {
              defaultValue:
                "External HTTP requests through api.net.fetch and direct WebSocket / HTTP connections; the plugin must declare the network privacy scope.",
            })}
          </div>

          <div className="plugin-metadata-list">
            {matchedNet.map((row) => (
              <div className="plugin-metadata-item" key={row.id}>
                <div className="plugin-metadata-item-head">
                  <code className="plugin-metadata-id">{row.id}</code>
                  <div className="plugin-metadata-badges">
                    <span className="plugin-metadata-badge public">
                      {t("plugins.net.badge", {
                        defaultValue: "Declaration required",
                      })}
                    </span>
                  </div>
                </div>
                {row.summary && (
                  <div className="plugin-metadata-summary">{row.summary}</div>
                )}
                {row.params.length > 0 && (
                  <div className="plugin-metadata-params">
                    <span className="plugin-metadata-params-label">
                      {t("plugins.metadata.params", {
                        defaultValue: "Parameters",
                      })}
                    </span>
                    {row.params.map((param) => (
                      <code className="plugin-metadata-param" key={param}>
                        {param}
                      </code>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {matchedNet.length === 0 && (
              <div className="plugin-metadata-empty">
                {t("plugins.net.empty", {
                  defaultValue: "No matching network capability",
                })}
              </div>
            )}
          </div>

          <div className="plugin-metadata-hint">
            {t("plugins.net.docHint", {
              defaultValue:
                "Full reference: the built-in plugin development guide ~/.snowapp/docs/en/2-guides/24-plugin-development-and-installation.md",
            })}
          </div>
        </>
      )}
    </div>
  );
};
