import {
  FileCode2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { UserscriptRecord } from "../../../preload/types/userscripts";
import { useI18n } from "../../i18n";
import {
  clientScriptStore,
  useClientScriptStore,
} from "../../userscripts/clientScriptStore";
import { scriptEditorStore } from "../../userscripts/scriptEditorStore";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { useChatConversationContext } from "../mainContent/chatMessages";

/** 新建脚本时的最小模板：声明客户端作用域并给出锚点 / 插槽用法示例。 */
const CLIENT_SCRIPT_TEMPLATE = `// ==UserScript==
// @name         My Client Script
// @namespace    snow-app
// @version      1.0.0
// @description  Customize the Snow desktop UI
// @snow-target  client
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

// 锚点：data-snow-anchor（app.root / topbar / sidebar / sidebar.nav / sidebar.footer /
//   main.view / chat.messages / chat.message / chat.input / rightPanel / rightPanel.tabs / rightPanel.content）
// 插槽：data-snow-slot（topbar.actions / sidebar.nav.actions / sidebar.footer.actions /
//   chat.input.actions / chat.message.actions）
// 脚本与页面共享 DOM：直接用原生 DOM API 定制任意位置（React 重建节点时用 MutationObserver 重挂）
GM_addStyle(\`
  /* [data-snow-anchor="rightPanel.tabs"] { display: none !important; } */
\`);

// 往输入区插槽加一个「续写」按钮
const slot = document.querySelector('[data-snow-slot="chat.input.actions"]');
if (slot) {
  const button = document.createElement("button");
  button.className = "plugin-script-command";
  button.textContent = "续写";
  button.onclick = () => snow.client.insertInputText("继续");
  slot.append(button);
  snow.onCleanup(() => button.remove());
}

// 给每条 AI 消息加标记：虚拟化滚动会重建节点，用 MutationObserver 自动重挂
const decorateMessages = () => {
  document
    .querySelectorAll('[data-snow-anchor="chat.message"]')
    .forEach((message) => {
      if (message.dataset.snowMessageRole !== "assistant") return;
      if (message.querySelector(".demo-badge")) return;
      const badge = document.createElement("span");
      badge.className = "demo-badge";
      badge.textContent = "custom";
      message.append(badge);
      snow.onCleanup(() => badge.remove());
    });
};
const observer = new MutationObserver(decorateMessages);
observer.observe(document.body, { childList: true, subtree: true });
decorateMessages();
snow.onCleanup(() => observer.disconnect());
`;

type PluginScriptsSectionProps = {
  onClose: () => void;
};

/** 「脚本插件」标签页：管理注入桌面窗口的客户端脚本（不改动浏览器油猴脚本）。 */
export const PluginScriptsSection = ({
  onClose,
}: PluginScriptsSectionProps): React.JSX.Element => {
  const { t } = useI18n();
  const state = useClientScriptStore();
  const { buildFromContent } = useChatConversationContext();
  const [busyScriptId, setBusyScriptId] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [createRequest, setCreateRequest] = useState("");
  const [pendingDelete, setPendingDelete] = useState<UserscriptRecord | null>(
    null,
  );
  const [pendingUnsafeEnable, setPendingUnsafeEnable] =
    useState<UserscriptRecord | null>(null);

  useEffect(() => {
    void clientScriptStore.ensureLoaded();
  }, []);

  const commandsByScript = useMemo(() => {
    const map = new Map<string, { id: number; title: string }[]>();
    for (const command of state.commands) {
      const list = map.get(command.scriptId) ?? [];
      list.push({ id: command.id, title: command.title });
      map.set(command.scriptId, list);
    }
    return map;
  }, [state.commands]);

  const startCreate = useCallback((): void => {
    setError(null);
    scriptEditorStore.openNew("client", {
      fileName: "client-script.user.js",
      title: t("plugins.scripts.newTitle", { defaultValue: "New script" }),
      content: CLIENT_SCRIPT_TEMPLATE,
    });
  }, [t]);

  const handleCreateWithAi = useCallback(() => {
    const requirement = createRequest.trim();
    if (!requirement) {
      return;
    }
    // 先离开插件页让聊天视图可见，再新建会话自动发送需求：
    // AI 会读客户端脚本文档、写出 .user.js 并安装启用。
    setCreateRequest("");
    onClose();
    buildFromContent(
      t("plugins.scripts.createPrompt", { values: { request: requirement } }),
    );
  }, [buildFromContent, createRequest, onClose, t]);

  const handleCreateKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      const nativeEvent = event.nativeEvent as unknown as {
        isComposing?: boolean;
        keyCode?: number;
      };
      if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
        return;
      }
      event.preventDefault();
      handleCreateWithAi();
    },
    [handleCreateWithAi],
  );

  const startEdit = useCallback(
    async (script: UserscriptRecord) => {
      setError(null);
      try {
        const source = await clientScriptStore.readSource(script.scriptId);
        scriptEditorStore.openEdit("client", {
          scriptId: script.scriptId,
          fileName: `${script.name}.user.js`,
          title: `${t("plugins.scripts.editTitle", {
            defaultValue: "Edit script",
          })} — ${script.name}`,
          content: source,
        });
      } catch (readError) {
        setError(
          readError instanceof Error ? readError.message : String(readError),
        );
      }
    },
    [t],
  );

  /** 从本地 .user.js 文件导入：选择 → 预填编辑器，保存时才写库。 */
  const startImport = useCallback(async () => {
    setError(null);
    try {
      const picked = await clientScriptStore.pickFile(
        t("plugins.scripts.importPickTitle", {
          defaultValue: "Select a userscript file",
        }),
      );
      if (!picked) {
        return;
      }
      scriptEditorStore.openNew("client", {
        fileName: picked.fileName,
        title: t("plugins.scripts.newTitle", { defaultValue: "New script" }),
        content: picked.content,
      });
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : String(importError),
      );
    }
  }, [t]);

  const handleInstallUrl = useCallback(async () => {
    const url = installUrl.trim();
    if (!url) {
      return;
    }
    setIsInstalling(true);
    setError(null);
    try {
      await clientScriptStore.installFromUrl(url);
      setInstallUrl("");
    } catch (installError) {
      setError(
        installError instanceof Error
          ? installError.message
          : String(installError),
      );
    } finally {
      setIsInstalling(false);
    }
  }, [installUrl]);

  const handleToggle = useCallback(async (script: UserscriptRecord) => {
    // 启用「完全权限档」脚本（@grant unsafeWindow / @snow-sandbox false）
    // 需要用户明确确认：它等同本地代码执行权限。
    if (!script.enabled && !script.sandbox) {
      setPendingUnsafeEnable(script);
      return;
    }
    setBusyScriptId(script.scriptId);
    setError(null);
    try {
      await clientScriptStore.setEnabled(script.scriptId, !script.enabled);
    } catch (toggleError) {
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : String(toggleError),
      );
    } finally {
      setBusyScriptId(null);
    }
  }, []);

  const confirmUnsafeEnable = useCallback(async () => {
    if (!pendingUnsafeEnable) {
      return;
    }
    setBusyScriptId(pendingUnsafeEnable.scriptId);
    setError(null);
    try {
      await clientScriptStore.setEnabled(pendingUnsafeEnable.scriptId, true);
      setPendingUnsafeEnable(null);
    } catch (toggleError) {
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : String(toggleError),
      );
    } finally {
      setBusyScriptId(null);
    }
  }, [pendingUnsafeEnable]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) {
      return;
    }
    setBusyScriptId(pendingDelete.scriptId);
    setError(null);
    try {
      await clientScriptStore.remove(pendingDelete.scriptId);
      setPendingDelete(null);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : String(deleteError),
      );
    } finally {
      setBusyScriptId(null);
    }
  }, [pendingDelete]);

  return (
    <>
      <div className="plugins-toolbar">
        <button
          className="plugins-toolbar-btn primary"
          type="button"
          onClick={startCreate}
        >
          <Plus size={14} strokeWidth={1.8} />
          <span>
            {t("plugins.scripts.create", { defaultValue: "New script" })}
          </span>
        </button>
        <button
          className="plugins-toolbar-btn"
          type="button"
          onClick={() => void startImport()}
        >
          <Upload size={14} strokeWidth={1.8} />
          <span>
            {t("plugins.scripts.importFile", { defaultValue: "Import file" })}
          </span>
        </button>
        <button
          className="plugins-toolbar-btn"
          type="button"
          onClick={() => void clientScriptStore.refresh()}
        >
          <RefreshCw size={14} strokeWidth={1.8} />
          <span>{t("plugins.refresh", { defaultValue: "Refresh" })}</span>
        </button>
      </div>

      <div className="plugins-scripts-install">
        <input
          className="plugins-scripts-install-input"
          type="url"
          value={installUrl}
          placeholder={t("plugins.scripts.urlPlaceholder", {
            defaultValue: "https://example.com/script.user.js",
          })}
          onChange={(event) => setInstallUrl(event.target.value)}
        />
        <button
          className="plugins-toolbar-btn"
          type="button"
          disabled={isInstalling || installUrl.trim().length === 0}
          onClick={() => void handleInstallUrl()}
        >
          <span>
            {isInstalling
              ? t("plugins.installing", { defaultValue: "Installing…" })
              : t("plugins.scripts.installUrl", {
                  defaultValue: "Install URL",
                })}
          </span>
        </button>
      </div>

      {error && <div className="plugins-error">{error}</div>}

      {state.status === "loading" && state.scripts.length === 0 && (
        <div className="plugins-empty">
          {t("plugins.loading", { defaultValue: "Loading…" })}
        </div>
      )}

      {state.status === "ready" && state.scripts.length === 0 && (
        <div className="plugins-empty">
          <FileCode2 size={22} strokeWidth={1.6} />
          <span>
            {t("plugins.scripts.empty", {
              defaultValue: "No client scripts installed yet",
            })}
          </span>
          <span className="plugins-empty-hint">
            {t("plugins.scripts.emptyHint", {
              defaultValue:
                "Create a script or install one from a URL to customize this window.",
            })}
          </span>
          <span className="plugins-empty-hint">
            {t("plugins.scripts.hint", {
              defaultValue:
                "Client scripts run inside this desktop window (sandboxed by default). Use data-snow-anchor / data-snow-slot hooks; declare @grant unsafeWindow for full-permission mode.",
            })}
          </span>
          <div className="plugins-create">
            <textarea
              className="plugins-create-input"
              value={createRequest}
              placeholder={t("plugins.scripts.createPlaceholder", {
                defaultValue:
                  "e.g. a button next to the chat input that inserts a fixed prompt",
              })}
              onChange={(event) => setCreateRequest(event.target.value)}
              onKeyDown={handleCreateKeyDown}
            />
            <div className="plugins-create-actions">
              <button
                className="plugins-toolbar-btn primary"
                type="button"
                disabled={createRequest.trim().length === 0}
                onClick={handleCreateWithAi}
              >
                <Sparkles size={14} strokeWidth={1.8} />
                <span>
                  {t("plugins.scripts.createAction", {
                    defaultValue: "Build with AI",
                  })}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="plugins-list">
        {state.scripts.map((script) => {
          const isBusy = busyScriptId === script.scriptId;
          const failure = state.failures[script.scriptId];
          const commands = commandsByScript.get(script.scriptId) ?? [];
          const summary = [
            ...script.views.map((view) =>
              t("plugins.scripts.viewBadge", {
                defaultValue: "view:{{name}}",
                values: { name: view },
              }),
            ),
            ...script.surfaces.map((surface) =>
              t("plugins.scripts.surfaceBadge", {
                defaultValue: "area:{{name}}",
                values: { name: surface },
              }),
            ),
          ];
          return (
            <div className="plugins-item" key={script.scriptId}>
              <div className="plugins-item-head">
                <span className="plugins-item-icon">
                  <FileCode2 size={18} strokeWidth={1.6} />
                </span>
                <div className="plugins-item-title">
                  <span className="plugins-item-name">{script.name}</span>
                  <span className="plugins-item-meta">
                    v{script.version}
                    {script.author ? ` · ${script.author}` : ""}
                    {` · ${script.runAt}`}
                    {script.scope === "global" ? " · global" : ""}
                  </span>
                  <div className="plugin-script-badges">
                    <span
                      className={`plugin-script-badge${
                        script.sandbox ? "" : " unsafe"
                      }`}
                    >
                      {script.sandbox
                        ? t("plugins.scripts.badgeSandbox", {
                            defaultValue: "Sandboxed",
                          })
                        : t("plugins.scripts.badgeUnsafe", {
                            defaultValue: "Full permissions",
                          })}
                    </span>
                    {script.scope === "global" && (
                      <span className="plugin-script-badge">
                        {t("plugins.scripts.badgeGlobal", {
                          defaultValue: "Always on",
                        })}
                      </span>
                    )}
                    {summary.map((item) => (
                      <span className="plugin-script-badge" key={item}>
                        {item}
                      </span>
                    ))}
                    {failure && (
                      <span className="plugin-script-badge failed">
                        {t("plugins.scripts.badgeFailed", {
                          defaultValue: "Errors {{count}}",
                          values: { count: failure.count },
                        })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="plugins-item-actions">
                  <button
                    aria-checked={script.enabled}
                    className="plugins-toggle"
                    disabled={isBusy}
                    onClick={() => void handleToggle(script)}
                    role="switch"
                    type="button"
                  >
                    <span
                      className={`plugins-toggle-track${
                        script.enabled ? " on" : ""
                      }`}
                    >
                      <span className="plugins-toggle-thumb" />
                    </span>
                  </button>
                  <button
                    className="plugins-icon-btn"
                    disabled={isBusy}
                    title={t("plugins.scripts.edit", { defaultValue: "Edit" })}
                    type="button"
                    onClick={() => void startEdit(script)}
                  >
                    <Pencil size={13} strokeWidth={1.8} />
                  </button>
                  <button
                    className="plugins-icon-btn"
                    disabled={isBusy}
                    title={t("plugins.scripts.delete", {
                      defaultValue: "Delete",
                    })}
                    type="button"
                    onClick={() => setPendingDelete(script)}
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>
                </div>
              </div>

              {commands.length > 0 && (
                <div className="plugin-script-commands">
                  {commands.map((command) => (
                    <button
                      className="plugin-script-command"
                      key={command.id}
                      type="button"
                      onClick={() =>
                        void clientScriptStore.runCommand(command.id)
                      }
                    >
                      {command.title}
                    </button>
                  ))}
                </div>
              )}

              {failure && (
                <div className="plugin-script-hint">
                  <ShieldAlert size={11} strokeWidth={1.8} />{" "}
                  {failure.disabled
                    ? t("plugins.scripts.autoDisabled", {
                        defaultValue:
                          "Auto-disabled after repeated errors: {{message}}",
                        values: { message: failure.message },
                      })
                    : failure.message}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("plugins.scripts.deleteTitle", {
          defaultValue: "Delete script",
        })}
        message={t("plugins.scripts.deleteMessage", {
          values: { name: pendingDelete?.name ?? "" },
          defaultValue:
            "Delete “{{name}}”? The script file is removed from disk as well.",
        })}
        confirmLabel={t("plugins.scripts.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        isConfirming={busyScriptId === pendingDelete?.scriptId}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={pendingUnsafeEnable !== null}
        title={t("plugins.scripts.unsafeTitle", {
          defaultValue: "Enable full-permission script",
        })}
        message={t("plugins.scripts.unsafeMessage", {
          values: { name: pendingUnsafeEnable?.name ?? "" },
          defaultValue:
            "“{{name}}” declares @grant unsafeWindow or @snow-sandbox false. It runs in the page's main world with local-code permissions (window.snow: files, terminal, MCP). Enable it only if you trust the source.",
        })}
        confirmLabel={t("plugins.scripts.unsafeConfirm", {
          defaultValue: "Enable anyway",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        isConfirming={busyScriptId === pendingUnsafeEnable?.scriptId}
        onConfirm={() => void confirmUnsafeEnable()}
        onCancel={() => setPendingUnsafeEnable(null)}
      />
    </>
  );
};
