import {
  AlertCircle,
  Blocks,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  McpProjectServerStatus,
  McpProjectToolStatus,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { formatMcpError } from "../../sidebar/mcpSettings/mcpErrorMessages";
import { Modal } from "../../common/Modal";
import { LITE_MODE_CHANGED_EVENT } from "../chatMessages/hooks/useToolAuthorization";

type ProjectMcpPanelProps = {
  open: boolean;
  projectId?: string;
  projectName?: string;
  onClose: () => void;
};

type ToolErrorsByServerId = Record<string, string>;

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
  onClose,
}: ProjectMcpPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpProjectServerStatus[]>([]);
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
  const pendingServerIdsRef = useRef<Set<string>>(new Set());
  const pendingToolNamesRef = useRef<Set<string>>(new Set());
  const catalogGenerationRef = useRef(0);
  const loadingToolServerIdsRef = useRef<Set<string>>(new Set());

  const loadServers = useCallback(async (): Promise<void> => {
    const generation = catalogGenerationRef.current + 1;
    catalogGenerationRef.current = generation;
    loadingToolServerIdsRef.current.clear();
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
      const nextServers = await window.snow.listMcpProjectServers(projectId);
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

  // 局部重试单个项目/全局服务器的工具发现：list_mcp_project_servers 已
  // 并发返回全部工具（与设置页共用同一份数据），仅在发现失败时手动刷新。
  // 注意：此处 server.source === "external" 表示来自全局配置的 MCP，
  // 界面上显示为「全局 MCP」分组。
  const retryServerTools = useCallback(
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
                ? { ...item, tools, error: undefined }
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

  const toggleExpanded = (server: McpProjectServerStatus): void => {
    setExpandedServerIds((current) => {
      const next = new Set(current);
      if (next.has(server.id)) {
        next.delete(server.id);
      } else {
        next.add(server.id);
      }
      return next;
    });
  };

  const updateServer = async (
    server: McpProjectServerStatus,
    enabled: boolean,
  ): Promise<void> => {
    if (
      !projectId ||
      pendingServerIdsRef.current.has(server.id) ||
      !server.globalEnabled
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
      // 手动启用被精简模式禁用的内置服务器（browser / app-control /
      // terminal）时，Rust 侧会自动关闭精简模式；派发事件让会话层重新读取状态。
      if (
        enabled &&
        (server.id === "builtin:browser" ||
          server.id === "builtin:app-control" ||
          server.id === "builtin:terminal")
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
      !server.enabled
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

  const systemServers = servers.filter((server) => server.source === "system");
  const projectOwnedServers = servers.filter(
    (server) => server.source === "project",
  );
  const externalServers = servers.filter(
    (server) => server.source === "external",
  );

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
          const expanded = expandedServerIds.has(server.id);
          // 工具直接来自 list_mcp_project_servers 的返回值（Rust 已并发发现），
          // 与设置页项目 MCP 列表共用同一份数据。
          const tools = server.tools;
          const toolsRetrying = loadingToolServerIds.has(server.id);
          const toolError = toolErrorsByServerId[server.id];
          const discoveryError =
            toolError ?? (server.error as string | null | undefined);
          const canRetry = server.source !== "system";
          const serverDisabled = !server.globalEnabled;
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
                  <Blocks size={16} />
                  <span
                    aria-hidden="true"
                    className={`project-mcp-status-dot${
                      server.enabled ? " is-enabled" : ""
                    }`}
                  />
                  <span className="project-mcp-server-name">{server.name}</span>
                  <span className="project-mcp-tool-count">
                    {toolsRetrying
                      ? t("projectMcp.loadingToolsShort")
                      : t("projectMcp.toolCount", {
                          values: { count: tools.length },
                        })}
                  </span>
                </button>
                <label className="toggle-switch">
                  <input
                    checked={server.enabled}
                    disabled={serverDisabled}
                    hidden
                    onChange={(event) =>
                      void updateServer(server, event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
              {serverDisabled ? (
                <div className="project-mcp-global-note">
                  {t("projectMcp.globalDisabled")}
                </div>
              ) : null}
              {discoveryError ? (
                <div className="project-mcp-server-error">
                  <AlertCircle size={14} />
                  <span>{formatServerError(discoveryError, t)}</span>
                  {canRetry && !serverDisabled ? (
                    <button
                      className="project-mcp-tool-retry"
                      disabled={toolsRetrying}
                      onClick={() => void retryServerTools(server)}
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
                  {toolsRetrying ? (
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
                        onClick={() => void retryServerTools(server)}
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
                    tools.map((tool) => (
                      <div className="project-mcp-tool-row" key={tool.name}>
                        <Wrench size={14} />
                        <div className="project-mcp-tool-content">
                          <strong>{toolDisplayName(tool.name)}</strong>
                          <span>{tool.description}</span>
                        </div>
                        <label className="toggle-switch">
                          <input
                            checked={tool.enabled}
                            disabled={!server.globalEnabled || !server.enabled}
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
                      </div>
                    ))
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
            <span>{t("projectMcp.scopeNote")}</span>
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
          {loadError ? (
            <div className="project-mcp-load-error">
              <AlertCircle size={15} />
              <span>{loadError}</span>
            </div>
          ) : null}
          <div className="project-mcp-list">
            {renderServerGroup(t("projectMcp.systemServers"), systemServers)}
            {renderServerGroup(
              t("projectMcp.projectServers"),
              projectOwnedServers,
            )}
            {renderServerGroup(t("projectMcp.globalServers"), externalServers)}
          </div>
        </>
      )}
    </Modal>
  );
};
