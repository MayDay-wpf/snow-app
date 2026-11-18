import {
  ChevronDown,
  Download,
  FileCode2,
  Loader2,
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
import { useI18n, type Locale } from "../../i18n";
import {
  hasMarketUpdate,
  isMarketEntryTooNew,
  type MarketPluginEntry,
} from "../../plugins/market";
import {
  findMarketEntry,
  marketStore,
  useMarketStore,
} from "../../plugins/marketStore";
import { pluginStore } from "../../plugins/pluginStore";
import { isSensitiveScope } from "../../plugins/types";
import {
  clientScriptStore,
  useClientScriptStore,
} from "../../userscripts/clientScriptStore";
import { scriptEditorStore } from "../../userscripts/scriptEditorStore";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { PluginMarketIcon } from "../common/PluginMarketIcon";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { PluginCreateBox } from "./PluginCreateBox";
import { PluginPrivacyBadges } from "./PluginPrivacyBadges";
import type { PluginPrivacyTarget } from "./PluginPrivacyDialog";

/**
 * 新建客户端脚本时的最小模板文案：声明客户端作用域并给出锚点 / 插槽用法示例。
 * 模板会原样写进用户脚本文件，因此按语言分别提供，避免英文界面下生成中文示例。
 */
const CLIENT_SCRIPT_STRINGS: Record<
  Locale,
  {
    anchorsNote: string;
    addButtonNote: string;
    buttonLabel: string;
    insertText: string;
    decorateNote: string;
  }
> = {
  en: {
    anchorsNote: `// Anchors: data-snow-anchor (app.root / topbar / sidebar / sidebar.nav / sidebar.footer /
//   main.view / chat.messages / chat.message / chat.input / rightPanel / rightPanel.tabs / rightPanel.content)
// Slots: data-snow-slot (topbar.actions / sidebar.nav.actions / sidebar.footer.actions /
//   chat.input.actions / chat.message.actions)
// Scripts share the DOM with the page: use the native DOM API to customize any position
// (re-attach with a MutationObserver when React rebuilds a node)`,
    addButtonNote: `// Add a "Continue" button to the chat input slot`,
    buttonLabel: "Continue",
    insertText: "Continue",
    decorateNote: `// Tag every AI message: virtualized scrolling rebuilds nodes, so re-attach via MutationObserver`,
  },
  "zh-CN": {
    anchorsNote: `// 锚点：data-snow-anchor（app.root / topbar / sidebar / sidebar.nav / sidebar.footer /
//   main.view / chat.messages / chat.message / chat.input / rightPanel / rightPanel.tabs / rightPanel.content）
// 插槽：data-snow-slot（topbar.actions / sidebar.nav.actions / sidebar.footer.actions /
//   chat.input.actions / chat.message.actions）
// 脚本与页面共享 DOM：直接用原生 DOM API 定制任意位置（React 重建节点时用 MutationObserver 重挂）`,
    addButtonNote: `// 往输入区插槽加一个「续写」按钮`,
    buttonLabel: "续写",
    insertText: "继续",
    decorateNote: `// 给每条 AI 消息加标记：虚拟化滚动会重建节点，用 MutationObserver 自动重挂`,
  },
  "zh-TW": {
    anchorsNote: `// 錨點：data-snow-anchor（app.root / topbar / sidebar / sidebar.nav / sidebar.footer /
//   main.view / chat.messages / chat.message / chat.input / rightPanel / rightPanel.tabs / rightPanel.content）
// 插槽：data-snow-slot（topbar.actions / sidebar.nav.actions / sidebar.footer.actions /
//   chat.input.actions / chat.message.actions）
// 腳本與頁面共享 DOM：直接用原生 DOM API 客製任意位置（React 重建節點時用 MutationObserver 重掛）`,
    addButtonNote: `// 往輸入區插槽加一個「續寫」按鈕`,
    buttonLabel: "續寫",
    insertText: "繼續",
    decorateNote: `// 給每條 AI 訊息加標記：虛擬化捲動會重建節點，用 MutationObserver 自動重掛`,
  },
};

/** 按当前 App 语言生成新建客户端脚本模板。 */
const buildClientScriptTemplate = (locale: Locale): string => {
  const strings = CLIENT_SCRIPT_STRINGS[locale];
  return `// ==UserScript==
// @name         My Client Script
// @namespace    snow-app
// @version      1.0.0
// @description  Customize the Snow desktop UI
// @icon         lucide:Sparkles
// @snow-target  client
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

${strings.anchorsNote}
GM_addStyle(\`
  /* [data-snow-anchor="rightPanel.tabs"] { display: none !important; } */
\`);

${strings.addButtonNote}
const slot = document.querySelector('[data-snow-slot="chat.input.actions"]');
if (slot) {
  const button = document.createElement("button");
  button.className = "plugin-script-command";
  button.textContent = ${JSON.stringify(strings.buttonLabel)};
  button.onclick = () => snow.client.insertInputText(${JSON.stringify(strings.insertText)});
  slot.append(button);
  snow.onCleanup(() => button.remove());
}

${strings.decorateNote}
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
};

type PluginScriptsSectionProps = {
  onClose: () => void;
  onOpenPrivacy: (target: PluginPrivacyTarget) => void;
};

/** 「脚本插件」标签页：管理注入桌面窗口的客户端脚本（不改动浏览器油猴脚本）。 */
export const PluginScriptsSection = ({
  onClose,
  onOpenPrivacy,
}: PluginScriptsSectionProps): React.JSX.Element => {
  const { locale, t } = useI18n();
  const state = useClientScriptStore();
  const market = useMarketStore();
  const { buildFromContent } = useChatConversationContext();
  const [busyScriptId, setBusyScriptId] = useState<string | null>(null);
  const [updateAllProgress, setUpdateAllProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [createRequest, setCreateRequest] = useState("");
  const [createOpen, setCreateOpen] = useState<boolean | null>(null);
  const [pendingDelete, setPendingDelete] = useState<UserscriptRecord | null>(
    null,
  );
  const [pendingUnsafeEnable, setPendingUnsafeEnable] =
    useState<UserscriptRecord | null>(null);

  useEffect(() => {
    void clientScriptStore.ensureLoaded();
    void marketStore.ensureLoaded();
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

  const isEmpty = state.status === "ready" && state.scripts.length === 0;
  const createBoxOpen = createOpen ?? isEmpty;

  // 可批量更新的脚本（市场有更高版本且满足最低应用版本要求）。
  const updatableScripts = useMemo(() => {
    const targets: { scriptId: string; entry: MarketPluginEntry }[] = [];
    for (const script of state.scripts) {
      const entry = findMarketEntry(market.entries, script.scriptId, "script");
      if (!entry || !hasMarketUpdate(script.version, entry.version)) {
        continue;
      }
      if (isMarketEntryTooNew(entry, market.appVersion)) {
        continue;
      }
      targets.push({ scriptId: script.scriptId, entry });
    }
    return targets;
  }, [market.appVersion, market.entries, state.scripts]);

  const startCreate = useCallback((): void => {
    setError(null);
    scriptEditorStore.openNew("client", {
      fileName: "client-script.user.js",
      title: t("plugins.scripts.newTitle", { defaultValue: "New script" }),
      content: buildClientScriptTemplate(locale),
    });
  }, [locale, t]);

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

  const handleUpdate = useCallback(
    async (entry: MarketPluginEntry): Promise<void> => {
      setBusyScriptId(entry.id);
      setError(null);
      try {
        await pluginStore.installFromMarket(entry);
      } catch (updateError) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
        );
      } finally {
        setBusyScriptId(null);
      }
    },
    [],
  );

  // 依次更新所有可更新脚本，失败的条目计入汇总提示。
  const handleUpdateAll = useCallback(async () => {
    const targets = updatableScripts;
    if (targets.length === 0 || updateAllProgress) {
      return;
    }
    setError(null);
    setUpdateAllProgress({ done: 0, total: targets.length });
    let failed = 0;
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      setBusyScriptId(target.scriptId);
      try {
        await pluginStore.installFromMarket(target.entry);
      } catch {
        failed += 1;
      }
      setUpdateAllProgress({ done: index + 1, total: targets.length });
    }
    setBusyScriptId(null);
    setUpdateAllProgress(null);
    if (failed > 0) {
      setError(
        t("plugins.updateAllFailed", {
          values: { count: failed },
          defaultValue: "{{count}} plugin(s) failed to update",
        }),
      );
    }
  }, [t, updatableScripts, updateAllProgress]);

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
        {updatableScripts.length > 0 && (
          <button
            className="plugins-toolbar-btn primary"
            type="button"
            disabled={updateAllProgress !== null}
            title={t("plugins.updateAllHint", {
              values: { count: updatableScripts.length },
              defaultValue: "{{count}} plugin(s) have a newer version",
            })}
            onClick={() => void handleUpdateAll()}
          >
            {updateAllProgress ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Download size={14} strokeWidth={1.8} />
            )}
            <span>
              {updateAllProgress
                ? t("plugins.updatingAll", {
                    values: {
                      done: updateAllProgress.done,
                      total: updateAllProgress.total,
                    },
                    defaultValue: "Updating {{done}}/{{total}}…",
                  })
                : t("plugins.updateAll", {
                    values: { count: updatableScripts.length },
                    defaultValue: "Update all ({{count}})",
                  })}
            </span>
          </button>
        )}
        <button
          aria-expanded={createBoxOpen}
          className={`plugins-toolbar-btn${createBoxOpen ? " active" : ""}`}
          type="button"
          onClick={() => setCreateOpen(!createBoxOpen)}
        >
          <Sparkles size={14} strokeWidth={1.8} />
          <span>
            {t("plugins.createButton", { defaultValue: "Generate with AI" })}
          </span>
          <ChevronDown
            className="plugins-create-toggle-chevron"
            size={14}
            strokeWidth={2}
          />
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

      {!isEmpty && createBoxOpen && (
        <PluginCreateBox
          autoFocus
          className="plugins-create-inline"
          value={createRequest}
          placeholder={t("plugins.scripts.createPlaceholder", {
            defaultValue:
              "e.g. a button next to the chat input that inserts a fixed prompt",
          })}
          submitLabel={t("plugins.scripts.createAction", {
            defaultValue: "Build with AI",
          })}
          onChange={setCreateRequest}
          onSubmit={handleCreateWithAi}
        />
      )}

      {error && <div className="plugins-error">{error}</div>}

      {state.status === "loading" && state.scripts.length === 0 && (
        <div className="plugins-empty">
          {t("plugins.loading", { defaultValue: "Loading…" })}
        </div>
      )}

      {isEmpty && (
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
          {createBoxOpen && (
            <PluginCreateBox
              value={createRequest}
              placeholder={t("plugins.scripts.createPlaceholder", {
                defaultValue:
                  "e.g. a button next to the chat input that inserts a fixed prompt",
              })}
              submitLabel={t("plugins.scripts.createAction", {
                defaultValue: "Build with AI",
              })}
              onChange={setCreateRequest}
              onSubmit={handleCreateWithAi}
            />
          )}
        </div>
      )}

      <div className="plugins-list">
        {state.scripts.map((script) => {
          const isBusy = busyScriptId === script.scriptId;
          const marketEntry = findMarketEntry(
            market.entries,
            script.scriptId,
            "script",
          );
          const updateAvailable =
            marketEntry !== null &&
            hasMarketUpdate(script.version, marketEntry.version);
          const updateTooNew =
            marketEntry !== null &&
            isMarketEntryTooNew(marketEntry, market.appVersion);
          const failure = state.failures[script.scriptId];
          const commands = commandsByScript.get(script.scriptId) ?? [];
          const privacyScopes = script.privacy.filter(isSensitiveScope);
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
                  <PluginMarketIcon
                    icon={marketEntry?.icon || script.icon}
                    size={18}
                  />
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
                  <PluginPrivacyBadges
                    scopes={privacyScopes}
                    onOpen={() =>
                      onOpenPrivacy({
                        name: script.name,
                        source: "script",
                        scopes: privacyScopes,
                        note: "",
                      })
                    }
                  />
                </div>
                <div className="plugins-item-actions">
                  {marketEntry !== null && updateAvailable ? (
                    <button
                      className="plugins-toolbar-btn primary"
                      type="button"
                      disabled={isBusy || updateTooNew}
                      title={
                        updateTooNew
                          ? t("plugins.market.requiresApp", {
                              values: { version: marketEntry.minAppVersion },
                              defaultValue:
                                "Requires app v{{version}} or newer",
                            })
                          : t("plugins.market.updateHint", {
                              values: {
                                from: script.version,
                                to: marketEntry.version,
                              },
                              defaultValue: "Installed v{{from}} → v{{to}}",
                            })
                      }
                      onClick={() => void handleUpdate(marketEntry)}
                    >
                      {isBusy ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <Download size={13} strokeWidth={1.8} />
                      )}
                      <span>
                        {t("plugins.market.update", {
                          defaultValue: "Update",
                        })}
                      </span>
                    </button>
                  ) : null}
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
