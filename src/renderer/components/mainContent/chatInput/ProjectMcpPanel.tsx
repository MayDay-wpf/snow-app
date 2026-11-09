import {
  AlertCircle,
  Blocks,
  ChevronDown,
  ChevronRight,
  ListFilter,
  Loader2,
  PowerOff,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  McpProjectServerStatus,
  McpProjectToolStatus,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { formatMcpError } from "../../sidebar/mcpSettings/mcpErrorMessages";
import { builtinServerDescriptionKey } from "../../sidebar/mcpSettings/builtinServerDescriptions";
import { builtinServerIcon } from "../../sidebar/mcpSettings/builtinServerIcons";
import {
  McpSearchInput,
  matchesMcpQuery,
} from "../../sidebar/mcpSettings/McpSearchInput";
import { Modal } from "../../common/Modal";
import { LITE_MODE_CHANGED_EVENT } from "../chatMessages/hooks/useToolAuthorization";
import { notifyMcpServerStateChanged } from "./mcpServerEvents";

type ProjectMcpPanelProps = {
  open: boolean;
  projectId?: string;
  projectName?: string;
  /** 非空时只展示该服务器（右侧面板横幅「去开启」的定向入口） */
  focusServerId?: string | null;
  workflowMode: boolean;
  /** 清除定向展示，恢复完整列表 */
  onClearFocus?: () => void;
  onClose: () => void;
};

type ToolErrorsByServerId = Record<string, string>;

/// Codebase 服务器的「模式可用性」状态：只有当项目 Codebase 索引已启用
/// 且向量表中至少有一个分片时，codebase-* 工具才会真正进入请求体。
type CodebaseModeStatus = "loading" | "disabled" | "noIndex" | "active";

const toolDisplayName = (fullName: string): string => {
  const parts = fullName.split("__");
  return parts.length === 3 ? parts[2] : fullName;
};

const formatServerError = (
  error: string,
  t: (key: string, options?: { defaultValue?: string }) => string,
): string => {
  if (error === "imagegen:not_configured") {
    return t("projectMcp.serverErrorImagegenNotConfigured", {
      defaultValue:
        "No image generation channel configured. Configure at least one channel in Settings -> Image generation.",
    });
  }
  return error;
};

export const ProjectMcpPanel = ({
  open,
  projectId,
  projectName,
  focusServerId,
  workflowMode,
  onClearFocus,
  onClose,
}: ProjectMcpPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpProjectServerStatus[]>([]);
  const [codebaseMode, setCodebaseMode] =
    useState<CodebaseModeStatus>("loading");
  const [expandedServerIds, setExpandedServerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [loadingToolServerIds, setLoadingToolServerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [toolErrorsByServerId, setToolErrorsByServerId] =
    useState<ToolErrorsByServerId>({});
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const pendingServerIdsRef = useRef<Set<string>>(new Set());
  const pendingToolNamesRef = useRef<Set<string>>(new Set());
  const catalogGenerationRef = useRef(0);
  const loadingToolServerIdsRef = useRef<Set<string>>(new Set());
  const requestedToolServerIdsRef = useRef<Set<string>>(new Set());

  const loadServers = useCallback(async (): Promise<void> => {
    const generation = catalogGenerationRef.current + 1;
    catalogGenerationRef.current = generation;
    loadingToolServerIdsRef.current.clear();
    requestedToolServerIdsRef.current.clear();
    pendingServerIdsRef.current.clear();
    pendingToolNamesRef.current.clear();
    setServers([]);
    setExpandedServerIds(new Set());
    setLoadingToolServerIds(new Set());
    setToolErrorsByServerId({});
    setLoadError(null);

    if (!projectId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const nextServers =
        await window.snow.listMcpProjectServersCached(projectId);
      if (catalogGenerationRef.current === generation) {
        setServers(nextServers);
      }
    } catch (error) {
      if (catalogGenerationRef.current === generation) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (catalogGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadServers();
  }, [loadServers, open]);

  // 加载 Codebase 索引的模式状态（启用开关 + 索引是否已有数据），用于
  // 在面板里给 codebase 工具标注「索引未启用 / 尚无索引数据」——这两种
  // 情况下工具不会进入请求体，但服务器开关本身仍可打开。
  useEffect(() => {
    if (!open || !projectId) {
      setCodebaseMode("loading");
      return;
    }
    let cancelled = false;
    void Promise.all([
      window.snow.getCodebaseProjectScopeSettings(projectId),
      window.snow.getCodebaseIndexStats(projectId),
    ])
      .then(([scope, stats]) => {
        if (cancelled) {
          return;
        }
        if (!scope.enabled) {
          setCodebaseMode("disabled");
        } else if (stats.totalChunks <= 0) {
          setCodebaseMode("noIndex");
        } else {
          setCodebaseMode("active");
        }
      })
      .catch(() => {
        // 状态读取失败时不标注，避免误导。
        if (!cancelled) {
          setCodebaseMode("active");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // 单个项目/全局服务器的工具发现：列表来自快速接口（只读 Rust 端进程内
  // 缓存，未命中的服务器标记为待获取），由展开动作触发或失败后手动重试。
  // 注意：此处 server.source === "external" 表示来自全局配置的 MCP，
  // 界面上显示为「全局 MCP」分组。
  const fetchServerTools = useCallback(
    async (server: McpProjectServerStatus): Promise<void> => {
      if (
        !projectId ||
        server.source === "system" ||
        loadingToolServerIdsRef.current.has(server.id)
      ) {
        return;
      }

      const generation = catalogGenerationRef.current;
      loadingToolServerIdsRef.current.add(server.id);
      setLoadingToolServerIds((current) => new Set(current).add(server.id));
      setToolErrorsByServerId((current) => {
        const next = { ...current };
        delete next[server.id];
        return next;
      });

      try {
        const tools = await window.snow.listMcpProjectServerTools(
          projectId,
          server.id,
        );
        if (catalogGenerationRef.current === generation) {
          // 直接写回列表状态，渲染统一从 server.tools 读取
          setServers((current) =>
            current.map((item) =>
              item.id === server.id
                ? { ...item, tools, toolsPending: false, error: undefined }
                : item,
            ),
          );
        }
      } catch (error) {
        if (catalogGenerationRef.current === generation) {
          setToolErrorsByServerId((current) => ({
            ...current,
            [server.id]: formatMcpError(error, t),
          }));
        }
      } finally {
        if (catalogGenerationRef.current === generation) {
          loadingToolServerIdsRef.current.delete(server.id);
          setLoadingToolServerIds((current) => {
            const next = new Set(current);
            next.delete(server.id);
            return next;
          });
        }
      }
    },
    [projectId, t],
  );

  const ensureServerTools = useCallback(
    (server: McpProjectServerStatus): void => {
      if (
        !projectId ||
        server.source === "system" ||
        server.tools.length > 0 ||
        requestedToolServerIdsRef.current.has(server.id)
      ) {
        return;
      }

      requestedToolServerIdsRef.current.add(server.id);
      void fetchServerTools(server);
    },
    [fetchServerTools, projectId],
  );

  const toggleExpanded = (server: McpProjectServerStatus): void => {
    const willExpand = !expandedServerIds.has(server.id);
    setExpandedServerIds((current) => {
      const next = new Set(current);
      if (next.has(server.id)) {
        next.delete(server.id);
      } else {
        next.add(server.id);
      }
      return next;
    });
    if (willExpand) {
      ensureServerTools(server);
    }
  };

  const updateServer = async (
    server: McpProjectServerStatus,
    enabled: boolean,
  ): Promise<void> => {
    if (
      !projectId ||
      pendingServerIdsRef.current.has(server.id) ||
      !server.globalEnabled ||
      server.error === "toolSearch:no_enabled_plugins"
    ) {
      return;
    }

    const generation = catalogGenerationRef.current;
    const previousEnabled = server.enabled;
    pendingServerIdsRef.current.add(server.id);
    setLoadError(null);
    setServers((current) =>
      current.map((item) =>
        item.id === server.id ? { ...item, enabled } : item,
      ),
    );

    try {
      await window.snow.setMcpProjectServerEnabled(
        projectId,
        server.id,
        enabled,
      );
      notifyMcpServerStateChanged();
      // 手动启用被精简模式禁用的内置服务器（browser / app-control /
      // terminal / computer-use）时，Rust 侧会自动关闭精简模式；派发事件
      // 让会话层重新读取状态。
      if (
        enabled &&
        (server.id === "builtin:browser" ||
          server.id === "builtin:app-control" ||
          server.id === "builtin:terminal" ||
          server.id === "builtin:computer-use")
      ) {
        window.dispatchEvent(new CustomEvent(LITE_MODE_CHANGED_EVENT));
      }
    } catch (error) {
      if (catalogGenerationRef.current === generation) {
        setServers((current) =>
          current.map((item) =>
            item.id === server.id
              ? { ...item, enabled: previousEnabled }
              : item,
          ),
        );
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      pendingServerIdsRef.current.delete(server.id);
    }
  };

  const setToolEnabled = (
    serverId: string,
    toolName: string,
    enabled: boolean,
  ): void => {
    setServers((current) =>
      current.map((item) =>
        item.id === serverId
          ? {
              ...item,
              tools: item.tools.map((tool) =>
                tool.name === toolName ? { ...tool, enabled } : tool,
              ),
            }
          : item,
      ),
    );
  };

  const updateTool = async (
    server: McpProjectServerStatus,
    tool: McpProjectToolStatus,
    enabled: boolean,
  ): Promise<void> => {
    if (
      !projectId ||
      pendingToolNamesRef.current.has(tool.name) ||
      !server.globalEnabled ||
      server.error === "toolSearch:no_enabled_plugins" ||
      !server.enabled ||
      !tool.globalEnabled
    ) {
      return;
    }

    const generation = catalogGenerationRef.current;
    pendingToolNamesRef.current.add(tool.name);
    setLoadError(null);
    setToolEnabled(server.id, tool.name, enabled);

    try {
      await window.snow.setMcpProjectToolEnabled(projectId, tool.name, enabled);
    } catch (error) {
      if (catalogGenerationRef.current === generation) {
        setToolEnabled(server.id, tool.name, tool.enabled);
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      pendingToolNamesRef.current.delete(tool.name);
    }
  };

  // 定向展示（横幅「去开启」）：只保留目标服务器及其所在分组；目标不在
  // 列表中时回退完整列表，避免出现空面板。
  const focusedServer = focusServerId
    ? servers.find((server) => server.id === focusServerId)
    : undefined;
  const visibleServers = focusedServer ? [focusedServer] : servers;
  const isSearching = searchQuery.trim().length > 0;
  const serverSelfMatches = (server: McpProjectServerStatus): boolean => {
    const key = builtinServerDescriptionKey(server.id);
    return matchesMcpQuery(searchQuery, server.name, key ? t(key) : undefined);
  };
  const toolMatches = (tool: McpProjectToolStatus): boolean =>
    matchesMcpQuery(
      searchQuery,
      toolDisplayName(tool.name),
      tool.name,
      tool.description,
    );
  const searchedServers = isSearching
    ? visibleServers.filter(
        (server) => serverSelfMatches(server) || server.tools.some(toolMatches),
      )
    : visibleServers;
  const systemServers = searchedServers.filter(
    (server) => server.source === "system",
  );
  const projectOwnedServers = searchedServers.filter(
    (server) => server.source === "project",
  );
  const externalServers = searchedServers.filter(
    (server) => server.source === "external",
  );
  const serverGroups = [
    { title: t("projectMcp.systemServers"), servers: systemServers },
    { title: t("projectMcp.projectServers"), servers: projectOwnedServers },
    { title: t("projectMcp.globalServers"), servers: externalServers },
  ];
  const visibleGroups =
    focusedServer || isSearching
      ? serverGroups.filter((group) => group.servers.length > 0)
      : serverGroups;

  const renderServerGroup = (
    title: string,
    groupServers: McpProjectServerStatus[],
  ): React.JSX.Element => (
    <section className="project-mcp-group">
      <div className="project-mcp-group-title">
        <span>{title}</span>
        <span>{groupServers.length}</span>
      </div>
      {groupServers.length === 0 ? (
        <div className="project-mcp-empty">{t("projectMcp.emptyGroup")}</div>
      ) : (
        groupServers.map((server) => {
          // 仅因工具命中搜索时自动展开，并只列出命中的工具
          const matchedByTools = isSearching && !serverSelfMatches(server);
          const expanded = expandedServerIds.has(server.id) || matchedByTools;
          // 工具来自列表缓存（Rust 进程内 TTL 缓存）或展开时的按需发现结果。
          const tools = matchedByTools
            ? server.tools.filter(toolMatches)
            : server.tools;
          const toolsRetrying = loadingToolServerIds.has(server.id);
          const toolError = toolErrorsByServerId[server.id];
          const toolsLoading =
            toolsRetrying || (server.toolsPending && !toolError);
          const searchUnavailable =
            server.error === "toolSearch:no_enabled_plugins";
          const discoveryError = searchUnavailable
            ? toolError
            : (toolError ?? server.error);
          const canRetry = server.source !== "system";
          const descriptionKey = builtinServerDescriptionKey(server.id);
          const ServerIcon = builtinServerIcon(server.id) ?? Blocks;
          const serverDescription = descriptionKey
            ? t(descriptionKey)
            : undefined;
          const automatic = server.id === "builtin:toolSearch";
          const serverDisabled = !server.globalEnabled || searchUnavailable;
          // 全局停用或无可用插件时按关闭展示，避免误以为已启用
          const effectiveEnabled = server.enabled && !serverDisabled;
          const toolsReadOnly = !serverDisabled && !server.enabled;
          // 「特殊模式」标注：这些服务器/工具即使开关处于启用状态，也只有在
          // 对应模式生效时才会真正加入请求体。模式未生效时给出醒目提示，
          // 避免「开关是开的、工具却不存在」的误解。
          let modeNote: string | null = null;
          if (server.id === "builtin:workflow" && !workflowMode) {
            modeNote = t("projectMcp.modeNoteWorkflow");
          } else if (server.id === "builtin:codebase") {
            if (codebaseMode === "disabled") {
              modeNote = t("projectMcp.modeNoteCodebase");
            } else if (codebaseMode === "noIndex") {
              modeNote = t("projectMcp.modeNoteCodebaseNoIndex");
            }
          }
          const serverClassName = [
            "project-mcp-server",
            expanded ? "is-expanded" : "",
            serverDisabled ? "is-disabled" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <article className={serverClassName} key={server.id}>
              <div className="project-mcp-server-row">
                <button
                  aria-expanded={expanded}
                  className="project-mcp-expand-btn"
                  onClick={() => toggleExpanded(server)}
                  type="button"
                >
                  {expanded ? (
                    <ChevronDown size={16} />
                  ) : (
                    <ChevronRight size={16} />
                  )}
                  <ServerIcon size={16} />
                  <span
                    aria-hidden="true"
                    className={`project-mcp-status-dot${
                      effectiveEnabled ? " is-enabled" : ""
                    }`}
                  />
                  <span className="project-mcp-server-info">
                    <span className="project-mcp-server-name">
                      {server.name}
                    </span>
                    {serverDescription ? (
                      <span
                        className="project-mcp-server-desc"
                        title={serverDescription}
                      >
                        {serverDescription}
                      </span>
                    ) : null}
                  </span>
                  <span className="project-mcp-tool-count">
                    {toolsRetrying
                      ? t("projectMcp.loadingToolsShort")
                      : server.toolsPending
                        ? t("projectMcp.toolsPending")
                        : t("projectMcp.toolCount", {
                            values: { count: server.tools.length },
                          })}
                  </span>
                </button>
                {!automatic ? (
                  <label className="toggle-switch">
                    <input
                      checked={effectiveEnabled}
                      disabled={serverDisabled}
                      hidden
                      onChange={(event) =>
                        void updateServer(server, event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span className="toggle-slider" />
                  </label>
                ) : null}
              </div>
              {serverDisabled ? (
                <div className="project-mcp-global-note">
                  {searchUnavailable
                    ? t("settings.mcpToolSearchNoPlugins")
                    : t("projectMcp.globalDisabled")}
                </div>
              ) : null}
              {!serverDisabled && modeNote ? (
                <div className="project-mcp-mode-note" title={modeNote}>
                  <PowerOff size={13} />
                  <span>{modeNote}</span>
                </div>
              ) : null}
              {discoveryError ? (
                <div className="project-mcp-server-error">
                  <AlertCircle size={14} />
                  <span>{formatServerError(discoveryError, t)}</span>
                  {canRetry ? (
                    <button
                      className="project-mcp-tool-retry"
                      disabled={toolsRetrying}
                      onClick={() => void fetchServerTools(server)}
                      type="button"
                    >
                      <RefreshCw size={13} />
                      <span>{t("projectMcp.retryTools")}</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
              {expanded ? (
                <div className="project-mcp-tools">
                  {toolsReadOnly ? (
                    <div className="project-mcp-mode-note">
                      <PowerOff size={13} />
                      <span>{t("projectMcp.serverDisabledNote")}</span>
                    </div>
                  ) : null}
                  {toolsLoading ? (
                    <div className="project-mcp-tools-state">
                      <Loader2 className="spin" size={15} />
                      <span>{t("projectMcp.loadingTools")}</span>
                    </div>
                  ) : toolError ? (
                    <div className="project-mcp-tools-state is-error">
                      <AlertCircle size={15} />
                      <div>
                        <strong>{t("projectMcp.loadToolsFailed")}</strong>
                        <span>{toolError}</span>
                      </div>
                      <button
                        className="project-mcp-tool-retry"
                        onClick={() => void fetchServerTools(server)}
                        type="button"
                      >
                        <RefreshCw size={13} />
                        <span>{t("projectMcp.retryTools")}</span>
                      </button>
                    </div>
                  ) : tools.length === 0 ? (
                    discoveryError ? null : (
                      <div className="project-mcp-empty">
                        {t("projectMcp.noTools")}
                      </div>
                    )
                  ) : (
                    tools.map((tool) => {
                      // 工具级「模式未启用」徽章：与服务器行提示互补，在
                      // 工具列表里也一眼可见。
                      let toolModeBadge: string | null = null;
                      if (!tool.globalEnabled) {
                        // 全局禁用优先：项目层开关无法覆盖，工具只读展示为关闭。
                        toolModeBadge = t("projectMcp.toolGlobalDisabled");
                      } else if (
                        server.id === "builtin:workflow" &&
                        !workflowMode
                      ) {
                        toolModeBadge = t("projectMcp.modeBadgeWorkflow");
                      } else if (server.id === "builtin:codebase") {
                        if (codebaseMode === "disabled") {
                          toolModeBadge = t("projectMcp.modeBadgeCodebase");
                        } else if (codebaseMode === "noIndex") {
                          toolModeBadge = t(
                            "projectMcp.modeBadgeCodebaseNoIndex",
                          );
                        }
                      }
                      return (
                        <div className="project-mcp-tool-row" key={tool.name}>
                          <Wrench size={14} />
                          <div className="project-mcp-tool-content">
                            <div className="project-mcp-tool-name">
                              <strong>{toolDisplayName(tool.name)}</strong>
                              {toolModeBadge ? (
                                <span
                                  className="project-mcp-mode-badge"
                                  title={toolModeBadge}
                                >
                                  <PowerOff size={10} />
                                  <span>{toolModeBadge}</span>
                                </span>
                              ) : null}
                            </div>
                            <span>{tool.description}</span>
                          </div>
                          {!automatic ? (
                            <label className="toggle-switch">
                              <input
                                checked={tool.enabled && !searchUnavailable}
                                disabled={
                                  serverDisabled ||
                                  !server.enabled ||
                                  !tool.globalEnabled
                                }
                                hidden
                                onChange={(event) =>
                                  void updateTool(
                                    server,
                                    tool,
                                    event.target.checked,
                                  )
                                }
                                type="checkbox"
                              />
                              <span className="toggle-slider" />
                            </label>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              ) : null}
            </article>
          );
        })
      )}
    </section>
  );

  return (
    <Modal
      className="project-mcp-modal"
      closeLabel={t("projectMcp.close")}
      closeOnEscape
      description={
        projectId
          ? t("projectMcp.description", {
              values: { project: projectName || projectId },
            })
          : t("projectMcp.noProject")
      }
      onClose={onClose}
      open={open}
      size="large"
      title={t("projectMcp.title")}
    >
      {!projectId ? (
        <div className="project-mcp-state">
          <AlertCircle size={18} />
          <span>{t("projectMcp.noProject")}</span>
        </div>
      ) : isLoading && servers.length === 0 ? (
        <div className="project-mcp-state">
          <Loader2 className="spin" size={18} />
          <span>{t("projectMcp.loading")}</span>
        </div>
      ) : (
        <>
          <div className="project-mcp-toolbar">
            <span>
              {focusedServer
                ? t("projectMcp.filteredNote", {
                    values: { server: focusedServer.name },
                  })
                : t("projectMcp.scopeNote")}
            </span>
            {focusedServer && onClearFocus ? (
              <div className="project-mcp-toolbar-actions">
                <button
                  className="project-mcp-refresh"
                  onClick={onClearFocus}
                  type="button"
                >
                  <ListFilter size={14} />
                  <span>{t("projectMcp.showAllServers")}</span>
                </button>
                <button
                  className="project-mcp-refresh"
                  disabled={isLoading || loadingToolServerIds.size > 0}
                  onClick={() => void loadServers()}
                  type="button"
                >
                  <RefreshCw className={isLoading ? "spin" : ""} size={14} />
                  <span>{t("projectMcp.refresh")}</span>
                </button>
              </div>
            ) : (
              <button
                className="project-mcp-refresh"
                disabled={isLoading || loadingToolServerIds.size > 0}
                onClick={() => void loadServers()}
                type="button"
              >
                <RefreshCw className={isLoading ? "spin" : ""} size={14} />
                <span>{t("projectMcp.refresh")}</span>
              </button>
            )}
          </div>
          <McpSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t("projectMcp.searchPlaceholder")}
          />
          {loadError ? (
            <div className="project-mcp-load-error">
              <AlertCircle size={15} />
              <span>{loadError}</span>
            </div>
          ) : null}
          <div className="project-mcp-list">
            {isSearching && visibleGroups.length === 0 ? (
              <div className="project-mcp-empty">
                {t("projectMcp.searchEmpty")}
              </div>
            ) : null}
            {visibleGroups.map((group) => (
              <Fragment key={group.title}>
                {renderServerGroup(group.title, group.servers)}
              </Fragment>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
};
