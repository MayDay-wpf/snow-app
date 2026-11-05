import type {
  SnowRemoteChange,
  SnowRemoteChatInputState,
  SnowRemoteMcpServer,
  SnowRemoteSkill,
  SnowRemoteState,
} from "../renderer/types/remoteControl";
import {
  fetchChanges,
  fetchCodebase,
  fetchMcpServers,
  fetchPermissions,
  fetchReview,
  fetchRole,
  fetchSensitiveCommands,
  fetchSkills,
  runCommand,
  setMcpEnabled,
  setSkillEnabled,
} from "./api";
import { $, escapeHtml } from "./dom";
import { formatBytes } from "./format";
import { t } from "./i18n";
import { iconMarkup, type MobileIconName } from "./icons";
import { initModelPanel, renderModelPanel } from "./modelPanel";
import { showNotice } from "./notice";
import {
  beginOverlay,
  closeOverlays,
  hideOverlays,
  rememberOverlayTrigger,
} from "./overlays";
import type { AppContext } from "./types";

/**
 * 远程面板：指令 / 模型 / Skills / MCP / 权限 / 角色 / 敏感指令 / 代码库 / 审查 / 变更。
 * 面板是静态骨架，本模块负责打开关闭、内容渲染与数据加载。
 */
let skillsDirectoryId: string | null = null;
let skillsSnapshot: SnowRemoteSkill[] = [];
let mcpDirectoryId = "";
let mcpSnapshot: SnowRemoteMcpServer[] = [];

export const closeRemotePanels = (): void => {
  closeOverlays(false);
};

export const openRemotePanel = (id: string): void => {
  rememberOverlayTrigger();
  hideOverlays();
  beginOverlay();
  const panel = $(id);
  const head = panel?.querySelector(".panel-head");
  if (head && !head.querySelector(".panel-close")) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "panel-close";
    close.setAttribute("aria-label", t("remote.panel.close"));
    close.innerHTML = iconMarkup("x");
    close.onclick = () => {
      closeRemotePanels();
    };
    head.appendChild(close);
  }
  $("remotePanelScrim").classList.add("open");
  if (panel) {
    panel.classList.add("open");
    setTimeout(() => {
      const close = panel.querySelector<HTMLElement>(".panel-close");
      if (close) close.focus();
    }, 180);
  }
};

// ── 指令 / 模型列表（由 main.ts 的 render 循环驱动） ──────────────────────

const renderCommandList = (
  input: SnowRemoteChatInputState | null | undefined,
): void => {
  const commands = input?.commands || [];
  $("commandList").innerHTML =
    commands
      .map(
        (command) =>
          `<button class="remote-command" data-command="${escapeHtml(command.id)}" ${command.disabled ? "disabled" : ""}><b>${escapeHtml(command.label || command.id)}</b><small>${escapeHtml(command.description || "")}</small></button>`,
      )
      .join("") || `<div class="empty">${t("remote.empty.noCommands")}</div>`;
};

export const renderPanels = (next: SnowRemoteState | null): void => {
  renderCommandList(next?.chatInput);
  renderModelPanel(next?.chatInput);
};

// ── 面板加载器 ────────────────────────────────────────────────────────────

const panelErrorHtml = (title: string, error: unknown): string =>
  `<div class="empty"><strong>${title}</strong><br>${escapeHtml((error as Error).message || t("remote.error.retry"))}</div>`;

const skillToggleAriaLabel = (name: string, enabled: boolean): string =>
  enabled
    ? t("remote.skills.disable", { name })
    : t("remote.skills.enable", { name });

/** 开关的局部更新：只改这一个按钮与本条快照，不重建列表（无刷新）。 */
const applySkillToggle = (
  button: HTMLButtonElement,
  enabled: boolean,
): void => {
  const skillId = button.dataset.skill ?? "";
  const skill = skillsSnapshot.find((item) => item.id === skillId);
  button.classList.toggle("on", enabled);
  button.dataset.enabled = String(!enabled);
  button.setAttribute(
    "aria-label",
    skillToggleAriaLabel(skill?.name || skillId, enabled),
  );
  if (skill) skill.enabled = enabled;
};

const renderSkills = (): void => {
  const query = $<HTMLInputElement>("skillsSearch").value.trim().toLowerCase();
  const items = skillsSnapshot.filter(
    (skill) =>
      !query ||
      (skill.name + " " + skill.id + " " + skill.description)
        .toLowerCase()
        .indexOf(query) !== -1,
  );
  $("skillsList").innerHTML =
    items
      .map((skill) => {
        const tools =
          Array.isArray(skill.allowedTools) && skill.allowedTools.length
            ? skill.allowedTools.map(escapeHtml).join(t("remote.listSeparator"))
            : t("remote.skills.toolsUndeclared");
        const location =
          skill.location === "project"
            ? t("remote.skills.locationProject")
            : t("remote.skills.locationGlobal");
        const ariaLabel = skillToggleAriaLabel(
          skill.name || skill.id,
          skill.enabled,
        );
        return `<details class="skill-detail"><summary class="remote-row"><span><b>${escapeHtml(skill.name || skill.id)}</b><small>${escapeHtml(location + " · " + (skill.description || skill.id))}</small></span><span class="skill-summary-actions"><button type="button" class="remote-toggle ${skill.enabled ? "on" : ""}" data-skill="${escapeHtml(skill.id)}" data-enabled="${!skill.enabled}" aria-label="${escapeHtml(ariaLabel)}"></button></span></summary><div class="skill-detail-body"><div><b>${t("remote.skills.detailSource")}</b><small>${escapeHtml(skill.source === "agents" ? t("remote.skills.sourceAgents") : t("remote.skills.sourceSnow"))} · ${escapeHtml(skill.id)}</small></div><div><b>${t("remote.skills.detailTools")}</b><small>${tools}</small></div><div><b>${t("remote.skills.detailPermission")}</b><small>${t("remote.skills.detailPermissionNote")}</small></div></div></details>`;
      })
      .join("") || `<div class="empty">${t("remote.skills.empty")}</div>`;
};

const loadSkills = async (): Promise<void> => {
  skillsSnapshot = [];
  $("skillsList").innerHTML =
    `<div class="empty">${t("remote.loading.skills")}</div>`;
  try {
    const result = await fetchSkills();
    skillsDirectoryId = result.directoryId == null ? null : result.directoryId;
    skillsSnapshot = Array.isArray(result.skills) ? result.skills : [];
    renderSkills();
  } catch (error) {
    $("skillsList").innerHTML = panelErrorHtml(
      t("remote.error.loadSkills"),
      error,
    );
    throw error;
  }
};

/** 开关的局部更新：server 启停联动其下 tool 的可用性，并同步内存快照。 */
const applyMcpToggle = (
  button: HTMLButtonElement,
  target: "server" | "tool",
  enabled: boolean,
): void => {
  button.classList.toggle("on", enabled);
  button.dataset.mcpEnabled = String(!enabled);
  const id = button.dataset.mcpId ?? "";
  if (target === "tool") {
    for (const server of mcpSnapshot) {
      const tool = (server.tools || []).find((item) => item.name === id);
      if (tool) {
        tool.enabled = enabled;
        break;
      }
    }
    return;
  }
  const server = mcpSnapshot.find((item) => item.id === id);
  if (!server) return;
  server.enabled = enabled;
  const locked = !server.globalEnabled || !server.available;
  button
    .closest("section")
    ?.querySelectorAll<HTMLButtonElement>('[data-mcp-target="tool"]')
    .forEach((toolButton) => {
      toolButton.disabled = locked || !enabled;
    });
};

const renderMcp = (): void => {
  $("mcpList").innerHTML =
    mcpSnapshot
      .map((server) => {
        const locked = !server.globalEnabled || !server.available;
        const source =
          server.source === "project"
            ? t("remote.mcp.sourceProject")
            : t("remote.mcp.sourceGlobal");
        const tools = (server.tools || [])
          .map(
            (tool) =>
              `<div class="remote-row"><span><b>${escapeHtml(tool.name)}</b><small>${escapeHtml(tool.description || t("remote.mcp.toolFallback"))}</small></span><button class="remote-toggle ${tool.enabled ? "on" : ""}" data-mcp-target="tool" data-mcp-id="${escapeHtml(tool.name)}" data-mcp-enabled="${!tool.enabled}" ${locked || !server.enabled ? "disabled" : ""}></button></div>`,
          )
          .join("");
        return `<section><div class="remote-row"><span><b>${escapeHtml(server.name || server.id)}</b><small>${escapeHtml(source + (server.available ? "" : t("remote.mcp.unavailableSuffix")))}</small></span><button class="remote-toggle ${server.enabled ? "on" : ""}" data-mcp-target="server" data-mcp-id="${escapeHtml(server.id)}" data-mcp-enabled="${!server.enabled}" ${locked ? "disabled" : ""}></button></div>${tools}</section>`;
      })
      .join("") || `<div class="empty">${t("remote.mcp.empty")}</div>`;
};

const loadMcp = async (): Promise<void> => {
  mcpSnapshot = [];
  $("mcpList").innerHTML =
    `<div class="empty">${t("remote.loading.mcp")}</div>`;
  try {
    const result = await fetchMcpServers();
    mcpDirectoryId = result.directoryId;
    mcpSnapshot = Array.isArray(result.servers) ? result.servers : [];
    renderMcp();
  } catch (error) {
    $("mcpList").innerHTML = panelErrorHtml(t("remote.error.loadMcp"), error);
    throw error;
  }
};

/** 供动作面板（composer.ts）复用：打开面板并加载数据。 */
export const openSkillsPanel = async (): Promise<void> => {
  openRemotePanel("skillsPanel");
  await loadSkills();
};

export const openMcpPanel = async (): Promise<void> => {
  openRemotePanel("mcpPanel");
  await loadMcp();
};

const loadPermissions = async (): Promise<void> => {
  $("permissionsList").innerHTML =
    `<div class="empty">${t("remote.loading.permissions")}</div>`;
  try {
    const data = await fetchPermissions();
    const separator = t("remote.listSeparator");
    const project =
      (data.projectApprovedTools || []).map(escapeHtml).join(separator) ||
      t("remote.permissions.none");
    const global =
      (data.globalApprovedTools || []).map(escapeHtml).join(separator) ||
      t("remote.permissions.none");
    $("permissionsList").innerHTML =
      `<div class="remote-row"><span><b>${t("remote.permissions.projectApproved")}</b><small>${project}</small></span></div>` +
      `<div class="remote-row"><span><b>${t("remote.permissions.globalApproved")}</b><small>${global}</small></span></div>` +
      `<div class="remote-row"><span><b>${t("remote.permissions.readonly")}</b><small>${t("remote.permissions.readonlyCount", { count: data.readonlyToolCount || 0 })}</small></span></div>` +
      `<div class="remote-row"><span><b>${t("remote.permissions.yolo")}</b><small>${data.yolo ? t("remote.permissions.yoloOn") : t("remote.permissions.yoloOff")}</small></span></div>`;
  } catch (error) {
    $("permissionsList").innerHTML = panelErrorHtml(
      t("remote.error.loadPermissions"),
      error,
    );
    throw error;
  }
};

const loadRole = async (): Promise<void> => {
  $("roleList").innerHTML =
    `<div class="empty">${t("remote.loading.role")}</div>`;
  try {
    const data = await fetchRole();
    const source =
      data.source === "project"
        ? t("remote.role.sourceProject")
        : data.source === "ssh"
          ? t("remote.role.sourceSsh")
          : data.source === "global"
            ? t("remote.role.sourceGlobal")
            : t("remote.role.sourceNone");
    $("roleList").innerHTML =
      `<div class="remote-row"><span><b>${t("remote.role.source")}</b><small>${source}</small></span></div>` +
      `<div class="remote-row"><span><b>${t("remote.role.status")}</b><small>${data.exists ? t("remote.role.exists") : t("remote.role.missing")} · ${t("remote.role.charCount", { count: data.characterCount || 0 })}</small></span></div>` +
      `<div class="remote-row"><span><b>${t("remote.role.preview")}</b><small>${escapeHtml(data.preview || data.reason || t("remote.role.previewNone"))}</small></span></div>` +
      `<div class="empty">${escapeHtml(data.reason || t("remote.role.readonlyNote"))}</div>`;
  } catch (error) {
    $("roleList").innerHTML = panelErrorHtml(t("remote.error.loadRole"), error);
    throw error;
  }
};

const loadSensitive = async (): Promise<void> => {
  $("sensitiveList").innerHTML =
    `<div class="empty">${t("remote.loading.sensitive")}</div>`;
  try {
    const data = await fetchSensitiveCommands();
    const items = Array.isArray(data.commands) ? data.commands : [];
    $("sensitiveList").innerHTML =
      items
        .map((item) => {
          const scope =
            item.scope === "project"
              ? t("remote.sensitive.scopeProject")
              : t("remote.sensitive.scopeGlobal");
          const inherited = item.inherited
            ? t("remote.sensitive.inheritedSuffix")
            : "";
          const preset = item.isPreset
            ? t("remote.sensitive.presetSuffix")
            : "";
          const state = item.enabled
            ? t("remote.sensitive.enabled")
            : t("remote.sensitive.disabled");
          return `<div class="remote-row"><span><b>${escapeHtml(item.pattern)}</b><small>${escapeHtml(scope + inherited + preset + " · " + state)}</small></span></div>`;
        })
        .join("") || `<div class="empty">${t("remote.sensitive.empty")}</div>`;
  } catch (error) {
    $("sensitiveList").innerHTML = panelErrorHtml(
      t("remote.error.loadSensitive"),
      error,
    );
    throw error;
  }
};

const loadCodebase = async (): Promise<void> => {
  $("codebaseList").innerHTML =
    `<div class="empty">${t("remote.loading.codebase")}</div>`;
  try {
    const data = await fetchCodebase();
    const sizeLabel = formatBytes(Number(data.totalSizeBytes) || 0);
    const switchLabel = (on: boolean): string =>
      on ? t("remote.codebase.switchOn") : t("remote.codebase.switchOff");
    $("codebaseList").innerHTML =
      `<div class="remote-row"><span><b>${t("remote.codebase.index")}</b><small>${data.indexed ? t("remote.codebase.indexed") : t("remote.codebase.notIndexed")} · ${t("remote.codebase.fileCount", { count: data.totalFiles || 0 })}</small></span></div>` +
      `<div class="remote-row"><span><b>${t("remote.codebase.scale")}</b><small>${t("remote.codebase.chunkCount", { count: data.totalChunks || 0 })} · ${sizeLabel}</small></span></div>` +
      `<div class="remote-row"><span><b>${t("remote.codebase.features")}</b><small>${data.enabled ? t("remote.codebase.enabled") : t("remote.codebase.disabled")} · ${t("remote.codebase.agentReview", { state: switchLabel(data.agentReview) })} · ${t("remote.codebase.rerank", { state: switchLabel(data.reranking) })}</small></span></div>` +
      `<div class="empty">${escapeHtml(data.reason || t("remote.codebase.note"))}</div>`;
  } catch (error) {
    $("codebaseList").innerHTML = panelErrorHtml(
      t("remote.error.loadCodebase"),
      error,
    );
    throw error;
  }
};

const loadReview = async (): Promise<void> => {
  $("reviewList").innerHTML =
    `<div class="empty">${t("remote.loading.review")}</div>`;
  try {
    const data = await fetchReview();
    $("reviewList").innerHTML =
      `<div class="remote-row"><span><b>${t("remote.review.repository")}</b><small>${data.available ? t("remote.review.available") : t("remote.review.unavailable")} · ${escapeHtml(data.currentBranch || t("remote.review.noBranch"))}</small></span></div>` +
      `<div class="remote-row"><span><b>${t("remote.review.changes")}</b><small>${t("remote.review.staged", { count: data.stagedCount || 0 })} · ${t("remote.review.unstaged", { count: data.unstagedCount || 0 })} · ${t("remote.review.untracked", { count: data.untrackedCount || 0 })}</small></span></div>` +
      `<div class="empty">${escapeHtml(data.reason || t("remote.review.note"))}</div>`;
  } catch (error) {
    $("reviewList").innerHTML = panelErrorHtml(
      t("remote.error.loadReview"),
      error,
    );
    throw error;
  }
};

/** 变更行类型图标：对应桌面 FileChangesPanel 的 FilePlus2 / FilePen / FileMinus2。 */
const CHANGE_KIND_ICON: Record<SnowRemoteChange["kind"], MobileIconName> = {
  create: "file-plus",
  edit: "file-pen",
  delete: "trash-2",
};

const changeKindLabel = (kind: SnowRemoteChange["kind"]): string =>
  kind === "create"
    ? t("remote.changes.kindCreate")
    : kind === "delete"
      ? t("remote.changes.kindDelete")
      : t("remote.changes.kindEdit");

/** 代理归属：子代理优先显示自己的名字（与桌面行一致）。 */
const changeAgentLabel = (change: SnowRemoteChange): string =>
  change.agent === "sub"
    ? change.subAgentName || t("remote.changes.agentSub")
    : t("remote.changes.agentMain");

/** 单条变更行：类型图标 + 路径 + 「类型 · 代理」+ 增减行数。 */
const changeRowHtml = (change: SnowRemoteChange): string => {
  const stats: string[] = [];
  if (change.additions > 0) {
    stats.push(`<span class="change-stat add">+${change.additions}</span>`);
  }
  if (change.deletions > 0) {
    stats.push(`<span class="change-stat del">-${change.deletions}</span>`);
  }
  const icon = CHANGE_KIND_ICON[change.kind] ?? "file-pen";
  return (
    `<div class="remote-row change-row">` +
    `<span class="change-row-icon" aria-hidden="true">${iconMarkup(icon)}</span>` +
    `<span class="change-row-main"><b>${escapeHtml(change.path)}</b>` +
    `<small>${escapeHtml(`${changeKindLabel(change.kind)} · ${changeAgentLabel(change)}`)}</small></span>` +
    (stats.length > 0
      ? `<span class="change-stats">${stats.join("")}</span>`
      : "") +
    `</div>`
  );
};

/** 摘要行：文件总数 + 主代理 / 子代理归属计数（与桌面面板同一口径）。 */
const changesSummaryHtml = (items: SnowRemoteChange[]): string => {
  const mainCount = items.filter((change) => change.agent !== "sub").length;
  const subCount = items.length - mainCount;
  const badges = [
    `<span class="changes-badge is-main">${escapeHtml(t("remote.changes.summaryMain", { count: mainCount }))}</span>`,
  ];
  if (subCount > 0) {
    badges.push(
      `<span class="changes-badge is-sub">${escapeHtml(t("remote.changes.summarySub", { count: subCount }))}</span>`,
    );
  }
  return (
    `<div class="remote-row changes-summary"><span>` +
    `<b>${escapeHtml(t("remote.changes.summary", { count: items.length }))}</b>` +
    `<small class="changes-badges">${badges.join("")}</small>` +
    `</span></div>`
  );
};

const loadChanges = async (ctx: AppContext): Promise<void> => {
  $("changesList").innerHTML =
    `<div class="empty">${t("remote.loading.changes")}</div>`;
  try {
    const result = await fetchChanges(
      ctx.getState()?.activeConversationId ?? "",
    );
    const items = Array.isArray(result.changes) ? result.changes : [];
    $("changesList").innerHTML =
      items.length > 0
        ? changesSummaryHtml(items) +
          items.map((change) => changeRowHtml(change)).join("")
        : `<div class="empty">${t("remote.changes.empty")}</div>`;
  } catch (error) {
    $("changesList").innerHTML = panelErrorHtml(
      t("remote.error.loadChanges"),
      error,
    );
    throw error;
  }
};

// ── 指令执行（指令列表点击） ──────────────────────────────────────────────

const handleCommandClick = async (
  ctx: AppContext,
  commandId: string,
): Promise<void> => {
  if (commandId === "skills") {
    await openSkillsPanel();
    return;
  }
  if (commandId === "mcp") {
    await openMcpPanel();
    return;
  }
  if (commandId === "changes") {
    openRemotePanel("changesPanel");
    await loadChanges(ctx);
    return;
  }
  if (commandId === "permissions") {
    openRemotePanel("permissionsPanel");
    await loadPermissions();
    return;
  }
  if (commandId === "role") {
    openRemotePanel("rolePanel");
    await loadRole();
    return;
  }
  if (commandId === "sensitive-commands") {
    openRemotePanel("sensitivePanel");
    await loadSensitive();
    return;
  }
  if (commandId === "codebase") {
    openRemotePanel("codebasePanel");
    await loadCodebase();
    return;
  }
  if (commandId === "review") {
    openRemotePanel("reviewPanel");
    await loadReview();
    return;
  }

  showNotice(
    commandId === "clear" || commandId === "compact"
      ? t("remote.notice.commandRunning")
      : t("remote.notice.commandExecuted"),
  );
  await runCommand(commandId);

  if (commandId === "clear") {
    await ctx.refresh(false);
    if (ctx.getState()?.activeConversationId === null) {
      closeRemotePanels();
    } else {
      showNotice(t("remote.notice.newChatPending"), true);
    }
    return;
  }

  if (commandId === "compact") {
    const started = Date.now();
    let done = false;
    while (Date.now() - started < 15000) {
      await ctx.refresh(true);
      const snapshot = ctx.getState();
      if (snapshot?.compactionError) throw new Error(snapshot.compactionError);
      if (snapshot && !snapshot.isCompacting) {
        done = true;
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    }
    if (!done) throw new Error(t("remote.notice.compactingWait"));
    closeRemotePanels();
    showNotice(t("remote.notice.compacted"));
    return;
  }

  closeRemotePanels();
  showNotice(t("remote.notice.commandExecuted"));
  await ctx.refresh(false);
};

// ── 事件绑定 ──────────────────────────────────────────────────────────────

export const initPanels = (ctx: AppContext): void => {
  initModelPanel(ctx);
  $("remotePanelScrim").onclick = closeRemotePanels;

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "/") {
      event.preventDefault();
      openRemotePanel("commandPanel");
    }
    if (event.key === "Escape") closeRemotePanels();
  });

  $("commandSearch").oninput = () => {
    const query = $<HTMLInputElement>("commandSearch").value.toLowerCase();
    document
      .querySelectorAll<HTMLElement>("#commandList .remote-command")
      .forEach((item) => {
        item.style.display =
          !query || item.textContent.toLowerCase().indexOf(query) !== -1
            ? "block"
            : "none";
      });
  };

  $("commandList").onclick = async (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-command]",
    );
    if (!item || item.disabled) return;
    try {
      await handleCommandClick(ctx, item.dataset.command ?? "");
    } catch (error) {
      showNotice((error as Error).message, true);
    }
  };

  $("skillsSearch").oninput = renderSkills;

  $("skillsList").onclick = async (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-skill]",
    );
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    if (item.classList.contains("pending")) return;
    const enabled = item.dataset.enabled === "true";
    // 乐观更新：只切换该开关，请求失败再回滚，不重建列表。
    item.classList.add("pending");
    applySkillToggle(item, enabled);
    try {
      await setSkillEnabled(
        item.dataset.skill ?? "",
        enabled,
        skillsDirectoryId,
      );
      showNotice(
        enabled
          ? t("remote.notice.skillEnabled")
          : t("remote.notice.skillDisabled"),
      );
    } catch (error) {
      applySkillToggle(item, !enabled);
      showNotice((error as Error).message, true);
    } finally {
      item.classList.remove("pending");
    }
  };

  $("mcpList").onclick = async (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-mcp-target]",
    );
    if (!item || item.disabled || item.classList.contains("pending")) return;
    const target = item.dataset.mcpTarget === "tool" ? "tool" : "server";
    const enabled = item.dataset.mcpEnabled === "true";
    // 乐观更新：只切换该开关（server 联动 tool 可用性），失败再回滚。
    item.classList.add("pending");
    applyMcpToggle(item, target, enabled);
    try {
      await setMcpEnabled(
        target,
        item.dataset.mcpId ?? "",
        enabled,
        mcpDirectoryId,
      );
      showNotice(t("remote.notice.mcpUpdated"));
    } catch (error) {
      applyMcpToggle(item, target, !enabled);
      showNotice((error as Error).message, true);
    } finally {
      item.classList.remove("pending");
    }
  };
};
