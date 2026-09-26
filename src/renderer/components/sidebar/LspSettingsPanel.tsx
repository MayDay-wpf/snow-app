import {
  Folder,
  Globe2,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  ScanSearch,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";
import type { WorkspaceDirectoryRecord } from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import {
  LspSettingsEditor,
  LspSettingsEditorActions,
} from "./lspSettings/LspSettingsEditor";
import { LspSettingsList } from "./lspSettings/LspSettingsList";
import { LspSettingsSummary } from "./lspSettings/LspSettingsSummary";
import {
  useLspSettingsController,
  type LspScope,
} from "./lspSettings/useLspSettingsController";

type LspSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onClose?: () => void;
};

export function LspSettingsPanel(
  props: LspSettingsPanelProps,
): React.JSX.Element {
  const [scope, setScope] = useState<LspScope>("global");
  const activeScope = props.activeDirectory ? scope : "global";
  // Different scopes never share state or promises, even if the same language exists in both.
  const scopeKey = `${activeScope}:${props.activeDirectory?.directoryId ?? ""}:${props.activeDirectory?.path ?? ""}`;
  return (
    <LspSettingsScopePanel
      key={scopeKey}
      {...props}
      activeScope={activeScope}
      setActiveScope={setScope}
    />
  );
}

function LspSettingsScopePanel({
  activeDirectory,
  onClose,
  activeScope,
  setActiveScope,
}: LspSettingsPanelProps & {
  activeScope: LspScope;
  setActiveScope: (scope: LspScope) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const {
    isGlobalScope,
    servers,
    listItems,
    installedByCommand,
    operatingLang,
    isLoading,
    isBusy,
    isSaving,
    isProbing,
    isInstalling,
    isDetecting,
    pendingInstall,
    setPendingInstall,
    pendingDelete,
    setPendingDelete,
    draft,
    status,
    setStatus,
    error,
    setError,
    stackDetections,
    enabledCount,
    listTitle,
    emptyMessage,
    canEnableDetected,
    canRemoveDetected,
    reprobe,
    detectStack,
    confirmInstall,
    startAdd,
    cancelDraft,
    patchDraft,
    updateItem,
    addItem,
    removeItem,
    saveDraft,
    handleListToggle,
    handleListEdit,
    handleListDelete,
    confirmDelete,
    enableDetected,
    removeDetectedOverrides,
    handleStart,
    handleStop,
    handleRestart,
  } = useLspSettingsController(activeScope, activeDirectory);

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.lspTitle", { defaultValue: "LSP settings" })}
          </strong>
          <span className="settings-item-description">
            {t("settings.lspSettingsInfo", {
              defaultValue:
                "Configure external language servers (rust-analyzer, gopls, pyright ...) for lsp-diagnostics / lsp-hover.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeLspSettings", {
              defaultValue: "Close LSP settings",
            })}
            title={t("settings.closeLspSettings", {
              defaultValue: "Close LSP settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <LspSettingsSummary
        totalCount={listItems.length}
        enabledCount={enabledCount}
      />

      <div
        className={`api-settings-actions ${
          !isGlobalScope ? "lsp-settings-actions" : ""
        }`}
      >
        <button
          className="api-settings-action-btn secondary"
          onClick={() => void reprobe()}
          type="button"
          disabled={isBusy || isLoading}
          title={t("settings.lspRecheck", {
            defaultValue: "Re-check installation status",
          })}
        >
          {isProbing ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <RefreshCw size={15} />
          )}
          <span>
            {t("settings.lspRecheck", {
              defaultValue: "Re-check",
            })}
          </span>
        </button>
        <button
          className="api-settings-action-btn secondary"
          onClick={startAdd}
          type="button"
          disabled={isBusy || (!isGlobalScope && !activeDirectory)}
        >
          <Plus size={15} />
          <span>
            {t("settings.lspAddNew", { defaultValue: "Add language" })}
          </span>
        </button>
        {!isGlobalScope && (
          <button
            className="api-settings-action-btn secondary"
            onClick={() => void detectStack()}
            type="button"
            disabled={
              isBusy || !activeDirectory || activeDirectory.kind === "ssh"
            }
            title={
              activeDirectory?.kind === "ssh"
                ? t("settings.lspStackSshUnsupported", {
                    defaultValue:
                      "Stack detection is not supported for remote projects",
                  })
                : t("settings.lspDetectStack", {
                    defaultValue: "Detect stack",
                  })
            }
          >
            {isDetecting ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <ScanSearch size={15} strokeWidth={1.8} />
            )}
            <span>
              {t("settings.lspDetectStack", {
                defaultValue: "Detect stack",
              })}
            </span>
          </button>
        )}
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div
        className="skills-settings-tabs"
        role="tablist"
        aria-label={t("settings.lspScopeTabs", { defaultValue: "LSP scope" })}
      >
        <button
          className={`skills-settings-tab ${isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={isGlobalScope}
          onClick={() => setActiveScope("global")}
        >
          <Globe2 size={14} strokeWidth={1.8} />
          <span>{t("settings.lspTabGlobal", { defaultValue: "Global" })}</span>
        </button>
        <button
          className={`skills-settings-tab ${!isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={!isGlobalScope}
          onClick={() => setActiveScope("project")}
          disabled={!activeDirectory}
        >
          <Folder size={14} strokeWidth={1.8} />
          <span>
            {t("settings.lspTabProject", { defaultValue: "Project" })}
          </span>
        </button>
      </div>

      {!isGlobalScope &&
        stackDetections !== null &&
        stackDetections.length > 0 && (
          <div className="lsp-stack-detect-panel">
            <div className="lsp-stack-detect-header">
              <strong>
                {t("settings.lspStackDetectTitle", {
                  defaultValue: "Detected project stack",
                })}
              </strong>
              <span className="lsp-stack-detect-count">
                {t("settings.lspStackDetected", {
                  defaultValue: "{{count}} language(s) detected",
                  values: { count: String(stackDetections.length) },
                })}
              </span>
            </div>
            <div className="lsp-stack-detect-list">
              {stackDetections.map((detection) => {
                const existing = servers.find((s) => s.lang === detection.lang);
                const enabled = existing?.enabled === true;
                const statusLabel = enabled
                  ? t(
                      existing?.id.startsWith("project:")
                        ? "settings.lspStackProjectEnabled"
                        : "settings.lspStackGlobalEnabled",
                    )
                  : existing
                    ? t("settings.lspStackDisabled", {
                        defaultValue: "Disabled",
                      })
                    : t("settings.lspStackNotConfigured", {
                        defaultValue: "Not configured",
                      });
                return (
                  <div
                    key={`${detection.path}:${detection.lang}`}
                    className="lsp-stack-detect-row"
                  >
                    <span
                      className="lsp-stack-detect-path"
                      title={detection.path || "/"}
                    >
                      {detection.path || "/"}
                    </span>
                    <span className="lsp-stack-detect-lang">
                      {detection.lang}
                    </span>
                    <span className="lsp-stack-detect-marker">
                      {detection.marker}
                    </span>
                    <span
                      className={`lsp-stack-detect-badge ${
                        enabled ? "enabled" : "muted"
                      }`}
                    >
                      {statusLabel}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="lsp-stack-detect-actions">
              <button
                className="api-settings-action-btn secondary"
                onClick={() => void enableDetected()}
                type="button"
                disabled={isBusy || !canEnableDetected}
                title={t("settings.lspEnableDetected", {
                  defaultValue: "Enable detected",
                })}
              >
                <Power size={15} strokeWidth={1.8} />
                <span>
                  {t("settings.lspEnableDetected", {
                    defaultValue: "Enable detected",
                  })}
                </span>
              </button>
              <button
                className="api-settings-action-btn secondary"
                onClick={() => void removeDetectedOverrides()}
                type="button"
                disabled={isBusy || !canRemoveDetected}
                title={t("settings.lspRemoveDetected", {
                  defaultValue: "Remove overrides",
                })}
              >
                <Undo2 size={15} strokeWidth={1.8} />
                <span>
                  {t("settings.lspRemoveDetected", {
                    defaultValue: "Remove overrides",
                  })}
                </span>
              </button>
            </div>
          </div>
        )}

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>{listTitle}</strong>
          <span>
            {isGlobalScope
              ? t("settings.lspGlobalTabInfo", {
                  defaultValue:
                    "Manage language servers shared by all projects.",
                })
              : t("settings.lspProjectTabInfo", {
                  defaultValue:
                    "Manage project-specific language servers for {{name}}. Project configs override the global ones for the same language.",
                  values: { name: activeDirectory?.name ?? "" },
                })}
          </span>
        </div>

        <div className="api-settings-form-body">
          {isLoading ? (
            <div className="main-content-loading" role="status">
              <Loader2 size={22} className="spin" aria-hidden="true" />
              <span>{t("common.loading")}</span>
            </div>
          ) : (
            <LspSettingsList
              servers={listItems}
              isBusy={isBusy}
              listTitle={listTitle}
              emptyMessage={emptyMessage}
              installedByCommand={installedByCommand}
              isProjectScope={!isGlobalScope}
              operatingLang={operatingLang}
              onToggleEnabled={handleListToggle}
              onEdit={handleListEdit}
              onDelete={handleListDelete}
              onInstall={setPendingInstall}
              onStart={handleStart}
              onStop={handleStop}
              onRestart={handleRestart}
            />
          )}
        </div>
      </div>

      <Modal
        open={Boolean(draft)}
        title={t("settings.lspEditorTitle", {
          defaultValue: "Language server editor",
        })}
        description={
          draft?.lang ||
          t("settings.lspAddNew", { defaultValue: "Add language" })
        }
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={cancelDraft}
        closeDisabled={isBusy}
        size="large"
        className="lsp-settings-editor-modal"
        footer={
          draft && (
            <LspSettingsEditorActions
              isBusy={isBusy}
              isSaving={isSaving}
              onCancel={cancelDraft}
            />
          )
        }
      >
        {draft && (
          <LspSettingsEditor
            draft={draft}
            isBusy={isBusy}
            isSaving={isSaving}
            onDraftChange={patchDraft}
            onUpdateItem={updateItem}
            onAddItem={addItem}
            onRemoveItem={removeItem}
            onCancel={cancelDraft}
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("settings.lspDeleteConfirmTitle", {
          defaultValue: "Delete language server",
        })}
        message={t("settings.lspDeleteConfirm", {
          defaultValue:
            "Delete the language server for {{lang}}? lsp-diagnostics / lsp-hover will no longer work for this language.",
          values: { lang: pendingDelete?.lang ?? "" },
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingInstall)}
        title={t("settings.lspInstallConfirmTitle", {
          defaultValue: "Install language server",
        })}
        message={t("settings.lspInstallConfirm", {
          defaultValue:
            "Run the install command for {{lang}}?\n\n{{command}}\n\nThis may modify your system environment (global install).",
          values: {
            lang: pendingInstall?.lang ?? "",
            command: pendingInstall?.installCommand ?? "",
          },
        })}
        confirmLabel={t("settings.lspInstallServer", {
          defaultValue: "Install",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="warning"
        onConfirm={() => void confirmInstall()}
        onCancel={() => setPendingInstall(null)}
      />
    </div>
  );
}
