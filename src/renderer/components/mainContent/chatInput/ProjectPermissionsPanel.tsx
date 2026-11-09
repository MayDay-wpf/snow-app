import {
  AlertCircle,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { McpProjectServerStatus } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import type { CustomSelectOption } from "../../common/CustomSelect";
import { CustomSelect } from "../../common/CustomSelect";
import { Modal } from "../../common/Modal";
import { TOOL_APPROVALS_CHANGED_EVENT } from "../chatMessages/hooks/useToolAuthorization";

type ProjectPermissionsPanelProps = {
  open: boolean;
  projectId?: string;
  projectName?: string;
  onClose: () => void;
};

export const ProjectPermissionsPanel = ({
  open,
  projectId,
  projectName,
  onClose,
}: ProjectPermissionsPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [globalToolNames, setGlobalToolNames] = useState<string[]>([]);
  const [toolOptions, setToolOptions] = useState<CustomSelectOption[]>([]);
  const [selectedToolNames, setSelectedToolNames] = useState<string[]>([]);
  const [serverCount, setServerCount] = useState(0);
  const [isAddingTool, setIsAddingTool] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolPendingDeletion, setToolPendingDeletion] = useState<string | null>(
    null,
  );
  const [pendingToolNames, setPendingToolNames] = useState<Set<string>>(
    () => new Set(),
  );
  const pendingToolGenerationsRef = useRef<Map<string, number>>(new Map());
  const loadGenerationRef = useRef(0);

  const loadToolNames = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    pendingToolGenerationsRef.current.clear();
    setPendingToolNames(new Set());
    setToolNames([]);
    setGlobalToolNames([]);
    setToolOptions([]);
    setSelectedToolNames([]);
    setServerCount(0);
    setToolPendingDeletion(null);
    setError(null);

    if (!projectId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const [nextToolNames, nextGlobalToolNames, nextServers, readonlyTools] =
        await Promise.all([
          window.snow.listToolApprovalProjectApprovedTools(projectId),
          window.snow.getAlwaysApprovedTools().catch(() => [] as string[]),
          window.snow
            .listMcpProjectServers(projectId)
            .catch(() => [] as McpProjectServerStatus[]),
          window.snow.listReadonlyTools().catch(() => [] as string[]),
        ]);

      // 只读工具默认授权：把尚未授权的只读工具一次性批量写入项目级
      // 授权（单个 IPC 内完成读-改-写，避免逐条并发互相覆盖），
      // 用户打开面板即可看到全部只读工具并可按需删除。
      let finalToolNames = nextToolNames;
      const approvedSet = new Set([...nextToolNames, ...nextGlobalToolNames]);
      const missingReadonly = readonlyTools.filter(
        (name) => !approvedSet.has(name),
      );
      if (missingReadonly.length > 0) {
        await window.snow.setToolApprovalProjectToolsApproved(
          projectId,
          missingReadonly,
          true,
        );
        window.dispatchEvent(new CustomEvent(TOOL_APPROVALS_CHANGED_EVENT));
        finalToolNames =
          await window.snow.listToolApprovalProjectApprovedTools(projectId);
      }

      if (loadGenerationRef.current === generation) {
        setToolNames(finalToolNames);
        setGlobalToolNames(nextGlobalToolNames);
        setServerCount(nextServers.length);
        const approved = new Set([...finalToolNames, ...nextGlobalToolNames]);
        const options = new Map<string, CustomSelectOption>();
        for (const server of nextServers) {
          for (const tool of server.tools) {
            if (!approved.has(tool.name) && !options.has(tool.name)) {
              options.set(tool.name, { value: tool.name, label: tool.name });
            }
          }
        }
        setToolOptions(
          [...options.values()].sort((a, b) => a.label.localeCompare(b.label)),
        );
      }
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    if (open) {
      void loadToolNames();
      return;
    }

    loadGenerationRef.current += 1;
    pendingToolGenerationsRef.current.clear();
    setPendingToolNames(new Set());
    setIsLoading(false);
    setToolPendingDeletion(null);
  }, [loadToolNames, open]);

  const deleteToolApproval = useCallback(
    async (toolName: string): Promise<void> => {
      if (
        !projectId ||
        pendingToolGenerationsRef.current.has(toolName) ||
        pendingToolNames.has(toolName)
      ) {
        return;
      }

      const generation = loadGenerationRef.current;
      const operationProjectId = projectId;
      pendingToolGenerationsRef.current.set(toolName, generation);
      setPendingToolNames((current) => new Set(current).add(toolName));
      setError(null);
      try {
        await window.snow.setToolApprovalProjectToolApproved(
          operationProjectId,
          toolName,
          false,
        );
        window.dispatchEvent(new CustomEvent(TOOL_APPROVALS_CHANGED_EVENT));
        if (loadGenerationRef.current === generation) {
          setToolNames((current) =>
            current.filter((name) => name !== toolName),
          );
        }
      } catch (deleteError) {
        if (loadGenerationRef.current === generation) {
          setError(
            deleteError instanceof Error
              ? deleteError.message
              : String(deleteError),
          );
        }
      } finally {
        if (pendingToolGenerationsRef.current.get(toolName) === generation) {
          pendingToolGenerationsRef.current.delete(toolName);
          setPendingToolNames((current) => {
            const next = new Set(current);
            next.delete(toolName);
            return next;
          });
        }
      }
    },
    [projectId, pendingToolNames],
  );

  const confirmDeleteTool = (): void => {
    if (!toolPendingDeletion) {
      return;
    }
    const toolName = toolPendingDeletion;
    setToolPendingDeletion(null);
    void deleteToolApproval(toolName);
  };

  const addTools = useCallback(async (): Promise<void> => {
    const toolNames = selectedToolNames;
    if (
      !projectId ||
      toolNames.length === 0 ||
      isAddingTool ||
      pendingToolNames.size > 0
    ) {
      return;
    }

    setIsAddingTool(true);
    setError(null);
    try {
      await window.snow.setToolApprovalProjectToolsApproved(
        projectId,
        toolNames,
        true,
      );
      setSelectedToolNames([]);
      window.dispatchEvent(new CustomEvent(TOOL_APPROVALS_CHANGED_EVENT));
      await loadToolNames();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setIsAddingTool(false);
    }
  }, [
    isAddingTool,
    loadToolNames,
    pendingToolNames.size,
    projectId,
    selectedToolNames,
  ]);

  const canAddTools = selectedToolNames.length > 0 && !isAddingTool;

  return (
    <>
      <Modal
        className="project-sensitive-command-modal"
        closeLabel={t("projectPermissions.close")}
        closeOnEscape
        description={
          projectId
            ? t("projectPermissions.description", {
                values: { project: projectName || projectId },
              })
            : t("projectPermissions.noProject")
        }
        onClose={onClose}
        open={open}
        size="large"
        title={t("projectPermissions.title")}
      >
        {!projectId ? (
          <div className="project-sensitive-command-state">
            <AlertCircle size={18} />
            <span>{t("projectPermissions.noProject")}</span>
          </div>
        ) : isLoading && toolNames.length === 0 ? (
          <div className="project-sensitive-command-state">
            <Loader2 className="spin" size={18} />
            <span>{t("projectPermissions.loading")}</span>
          </div>
        ) : (
          <>
            <div className="project-sensitive-command-toolbar">
              <div>
                <span>{t("projectPermissions.scopeNote")}</span>
                <small>
                  {t("projectPermissions.count", {
                    values: { count: toolNames.length },
                  })}
                </small>
              </div>
              <div>
                <button
                  className="project-sensitive-command-toolbar-btn"
                  disabled={isLoading || pendingToolNames.size > 0}
                  onClick={() => void loadToolNames()}
                  type="button"
                >
                  <RefreshCw className={isLoading ? "spin" : ""} size={14} />
                  <span>{t("projectPermissions.refresh")}</span>
                </button>
              </div>
            </div>

            {error ? (
              <div className="project-sensitive-command-error">
                <AlertCircle size={15} />
                <span>{error}</span>
              </div>
            ) : null}

            <div className="project-sensitive-command-groups">
              {globalToolNames.length > 0 ? (
                <div className="project-sensitive-command-group">
                  <div className="project-sensitive-command-group-header">
                    <div>
                      <strong>{t("projectPermissions.globalTitle")}</strong>
                      <span>{t("projectPermissions.globalNote")}</span>
                    </div>
                    <span>{globalToolNames.length}</span>
                  </div>
                  <div className="project-sensitive-command-list">
                    {globalToolNames.map((toolName) => (
                      <article
                        className="project-sensitive-command-row is-enabled"
                        key={toolName}
                      >
                        <Globe size={15} />
                        <div className="project-sensitive-command-content">
                          <div>
                            <code>{toolName}</code>
                          </div>
                          <span>{t("projectPermissions.globalApproved")}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="project-sensitive-command-group">
                <div className="project-sensitive-command-group-header">
                  <div>
                    <strong>{t("projectPermissions.projectTitle")}</strong>
                    <span>{t("projectPermissions.projectNote")}</span>
                  </div>
                  <span>{toolNames.length}</span>
                </div>
                <div className="project-sensitive-command-add">
                  <CustomSelect
                    disabled={
                      isLoading || isAddingTool || pendingToolNames.size > 0
                    }
                    filterPlaceholder={t(
                      "projectPermissions.filterPlaceholder",
                    )}
                    filterable
                    multiple
                    multipleCountLabel={(count) =>
                      t("projectPermissions.selectedCount", {
                        values: { count },
                      })
                    }
                    multipleEmptyLabel={t("projectPermissions.selectTool")}
                    noMatchText={t("projectPermissions.noMatch")}
                    onChange={setSelectedToolNames}
                    options={toolOptions}
                    portal
                    value={selectedToolNames}
                  />
                  <button
                    className="project-sensitive-command-toolbar-btn"
                    disabled={
                      !canAddTools || isLoading || pendingToolNames.size > 0
                    }
                    onClick={() => void addTools()}
                    type="button"
                  >
                    {isAddingTool ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Plus size={14} />
                    )}
                    <span>{t("projectPermissions.addTool")}</span>
                  </button>
                </div>
                {toolOptions.length === 0 ? (
                  <div className="project-sensitive-command-empty">
                    {serverCount > 0
                      ? t("projectPermissions.allApproved")
                      : t("projectPermissions.noTools")}
                  </div>
                ) : null}
                {toolNames.length === 0 ? (
                  <div className="project-sensitive-command-empty">
                    {t("projectPermissions.empty")}
                  </div>
                ) : (
                  <div className="project-sensitive-command-list">
                    {toolNames.map((toolName) => (
                      <article
                        className="project-sensitive-command-row is-enabled"
                        key={toolName}
                      >
                        <ShieldCheck size={15} />
                        <div className="project-sensitive-command-content">
                          <div>
                            <code>{toolName}</code>
                          </div>
                          <span>{t("projectPermissions.approved")}</span>
                        </div>
                        <div className="project-sensitive-command-actions">
                          <button
                            aria-label={t("projectPermissions.delete")}
                            className="icon-btn ghost danger"
                            disabled={pendingToolNames.has(toolName)}
                            onClick={() => setToolPendingDeletion(toolName)}
                            title={t("projectPermissions.delete")}
                            type="button"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </Modal>
      <ConfirmDialog
        cancelLabel={t("settings.cancel")}
        confirmLabel={t("settings.delete")}
        message={t("projectPermissions.deleteConfirm", {
          values: { toolName: toolPendingDeletion ?? "" },
        })}
        onCancel={() => setToolPendingDeletion(null)}
        onConfirm={confirmDeleteTool}
        open={toolPendingDeletion !== null}
        title={t("projectPermissions.deleteTitle")}
        variant="danger"
      />
    </>
  );
};
