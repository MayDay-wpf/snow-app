import type {
  SnowRemoteGitBranch,
  SnowRemoteGitBranches,
  SnowRemoteGitDiff,
  SnowRemoteGitFile,
  SnowRemoteGitStatus,
  SnowRemoteGitSummary,
  SnowRemoteGitWorktree,
  SnowRemoteState,
} from "../renderer/types/remoteControl";
import { isSubmitEnter } from "../shared/imeKeyboard";
import {
  fetchGitBranches,
  fetchGitDiff,
  fetchGitStatus,
  fetchGitSummary,
  gitBindWorktree,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitCreateWorktree,
  gitDiscardFiles,
  gitRemoveWorktree,
  gitStageAll,
  gitStageFiles,
  gitUnstageAll,
  gitUnstageFiles,
} from "./api";
import { copyTextToClipboard } from "./clipboard";
import { $, escapeHtml } from "./dom";
import { t } from "./i18n";
import { iconMarkup } from "./icons";
import { showNotice } from "./notice";
import { rememberOverlayTrigger } from "./overlays";
import { openRemotePanel } from "./panels";

/**
 * 移动端 Git 入口：输入区 chip +「分支 / 变更」双 Tab 面板。
 * 数据与操作全部经远控桥调用桌面真实的 window.snow.git* 链路，
 * 仓库路径由桌面按当前工作区解析（手机端不传路径）。
 */
type GitTab = "branches" | "changes";
type CreateMode = "branch" | "worktree" | null;

type DiffView = {
  path: string;
  staged: boolean;
  loading: boolean;
  result: SnowRemoteGitDiff | null;
  error: string | null;
};

/** chip 摘要刷新间隔：与桌面远程仓库轮询同量级。 */
const SUMMARY_TTL_MS = 10_000;
/** 差异渲染行数上限（触摸端 DOM 保护）。 */
const MAX_DIFF_LINES = 1_500;

let tab: GitTab = "branches";
let createMode: CreateMode = null;
let branchQuery = "";
let summary: SnowRemoteGitSummary | null = null;
let branches: SnowRemoteGitBranches | null = null;
let status: SnowRemoteGitStatus | null = null;
let branchLoading = false;
let statusLoading = false;
let branchError: string | null = null;
let statusError: string | null = null;
let branchRequest = 0;
let statusRequest = 0;
let diffRequest = 0;
let busy = false;
let pendingRemove: string | null = null;
let pendingDiscard: string | null = null;
let newBranchName = "";
let newWorktreeBranch = "";
let newWorktreeBase = "HEAD";
let commitMessage = "";
let diffView: DiffView | null = null;
let focusField: "branch" | "worktree" | null = null;
let directoryKey = "";
let lastSummaryAt = 0;
let summaryInFlight = false;

const isGitPanelOpen = (): boolean => $("gitPanel").classList.contains("open");

const gitEmpty = (message: string, error = false): string =>
  `<div class="git-empty${error ? " is-error" : ""}">${escapeHtml(message)}</div>`;

/** 本地分支 / 远程分支 / 工作树 / 提交等按钮的统一禁用态。 */
const disabledAttr = (): string => (busy ? " disabled" : "");

const shortPath = (path: string): string => {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
};

const statusClass = (code: string): string => {
  if (code === "A" || code === "?") return "is-add";
  if (code === "D") return "is-del";
  if (code === "M" || code === "R" || code === "C") return "is-mod";
  return "";
};

// ── chip 与徽标 ───────────────────────────────────────────────────────────

const renderGitChip = (): void => {
  const chip = $<HTMLButtonElement>("gitChip");
  if (!summary || !summary.isRepo) {
    chip.hidden = true;
    chip.innerHTML = "";
    return;
  }
  chip.hidden = false;
  chip.innerHTML =
    iconMarkup("git-branch") +
    `<span class="git-chip-name">${escapeHtml(
      summary.currentBranch || t("remote.git.unknownBranch"),
    )}</span>` +
    (summary.ahead > 0
      ? `<span class="git-chip-sync is-ahead">↑${summary.ahead}</span>`
      : "") +
    (summary.behind > 0
      ? `<span class="git-chip-sync is-behind">↓${summary.behind}</span>`
      : "") +
    (summary.changesCount > 0
      ? `<span class="git-chip-badge">${summary.changesCount > 99 ? "99+" : summary.changesCount}</span>`
      : "") +
    `<span class="chip-caret">${iconMarkup("chevron-down")}</span>`;
};

const renderGitChangesBadge = (): void => {
  const badge = $("gitChangesBadge");
  const count = summary?.isRepo ? summary.changesCount : 0;
  badge.hidden = count <= 0;
  badge.textContent = count > 99 ? "99+" : String(count);
};

const refreshGitSummary = async (
  force = false,
  silent = true,
): Promise<void> => {
  if (summaryInFlight) return;
  if (!directoryKey) return;
  if (!force && summary && Date.now() - lastSummaryAt < SUMMARY_TTL_MS) {
    return;
  }
  const key = directoryKey;
  summaryInFlight = true;
  lastSummaryAt = Date.now();
  try {
    const next = await fetchGitSummary();
    if (key !== directoryKey) return;
    summary = next;
    renderGitChip();
    renderGitChangesBadge();
  } catch (error) {
    if (!silent && key === directoryKey) {
      showNotice((error as Error).message, true);
    }
  } finally {
    summaryInFlight = false;
  }
};

// ── 面板数据加载 ──────────────────────────────────────────────────────────

const applyStatusToSummary = (next: SnowRemoteGitStatus): void => {
  if (!summary) return;
  summary = {
    ...summary,
    isRepo: next.isRepo,
    currentBranch: next.currentBranch,
    upstream: next.upstream,
    ahead: next.ahead,
    behind: next.behind,
    stagedCount: next.stagedCount,
    unstagedCount: next.unstagedCount,
    untrackedCount: next.untrackedCount,
    changesCount: next.files.length,
    statusLimitHit: next.statusLimitHit,
  };
  renderGitChip();
  renderGitChangesBadge();
};

const loadBranches = async (): Promise<void> => {
  const request = ++branchRequest;
  branchLoading = true;
  branchError = null;
  renderGitPanel();
  try {
    const next = await fetchGitBranches();
    if (request !== branchRequest) return;
    branches = next;
    if (summary) {
      const current = next.branches.find((branch) => branch.isCurrent);
      if (current) {
        summary = { ...summary, isRepo: true, currentBranch: current.name };
        renderGitChip();
      }
    }
  } catch (error) {
    if (request !== branchRequest) return;
    branchError = (error as Error).message || t("remote.git.operationFailed");
  } finally {
    if (request === branchRequest) {
      branchLoading = false;
      renderGitPanel();
    }
  }
};

const loadStatus = async (): Promise<void> => {
  const request = ++statusRequest;
  statusLoading = true;
  statusError = null;
  renderGitPanel();
  try {
    const next = await fetchGitStatus();
    if (request !== statusRequest) return;
    status = next;
    applyStatusToSummary(next);
  } catch (error) {
    if (request !== statusRequest) return;
    statusError = (error as Error).message || t("remote.git.operationFailed");
  } finally {
    if (request === statusRequest) {
      statusLoading = false;
      renderGitPanel();
    }
  }
};

const reloadAfterAction = async (): Promise<void> => {
  lastSummaryAt = 0;
  void refreshGitSummary(true);
  if (tab === "branches") {
    await loadBranches();
  } else {
    await loadStatus();
  }
};

const runGitAction = async (
  action: () => Promise<unknown>,
  successText?: string,
): Promise<void> => {
  if (busy) {
    showNotice(t("remote.git.operationBusy"));
    return;
  }
  busy = true;
  renderGitPanel();
  try {
    await action();
    if (successText) showNotice(successText);
    await reloadAfterAction();
  } catch (error) {
    showNotice(
      (error as Error).message || t("remote.git.operationFailed"),
      true,
    );
  } finally {
    busy = false;
    renderGitPanel();
  }
};

// ── 分支 Tab ──────────────────────────────────────────────────────────────

const branchMatches = (branch: SnowRemoteGitBranch): boolean => {
  const query = branchQuery.trim().toLowerCase();
  if (!query) return true;
  return (
    branch.name.toLowerCase().includes(query) ||
    (branch.upstream ?? "").toLowerCase().includes(query)
  );
};

const worktreeMatches = (worktree: SnowRemoteGitWorktree): boolean => {
  const query = branchQuery.trim().toLowerCase();
  if (!query) return true;
  return (
    worktree.worktreeName.toLowerCase().includes(query) ||
    (worktree.branchName ?? "").toLowerCase().includes(query) ||
    worktree.worktreePath.toLowerCase().includes(query)
  );
};

const renderBranchRow = (
  branch: SnowRemoteGitBranch,
  index: number,
): string => {
  const worktreeFolder = branch.worktreePath
    ? branch.worktreePath.replace(/\\/g, "/").split("/").filter(Boolean).pop()
    : "";
  const detail = branch.isRemote
    ? branch.remoteName || t("remote.git.remote")
    : branch.upstream
      ? `→ ${branch.upstream}`
      : t("remote.git.local");
  const aside = [
    branch.isGone
      ? `<span class="git-badge is-danger">${t("remote.git.gone")}</span>`
      : "",
    branch.behind > 0 ? `<span class="git-sync">↓${branch.behind}</span>` : "",
    branch.ahead > 0 ? `<span class="git-sync">↑${branch.ahead}</span>` : "",
    branch.isCurrent
      ? `<span class="git-check">${iconMarkup("check")}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  return (
    `<button class="git-row${branch.isCurrent ? " active" : ""}" type="button"` +
    ` data-git-checkout="${index}" data-git-remote="${branch.isRemote ? 1 : 0}"${disabledAttr()}>` +
    `<span class="git-row-main">` +
    `<span class="git-row-name">${escapeHtml(branch.name)}</span>` +
    `<span class="git-row-sub">${escapeHtml(detail)}</span>` +
    (worktreeFolder
      ? `<span class="git-badge is-worktree">${iconMarkup("folder-git-2")}${escapeHtml(worktreeFolder)}</span>`
      : "") +
    `</span>` +
    `<span class="git-row-side">${aside}</span>` +
    `</button>`
  );
};

const renderWorktreeRow = (
  worktree: SnowRemoteGitWorktree,
  index: number,
): string => `
  <div class="git-row git-worktree${worktree.bound ? " active" : ""}" data-git-bind="${index}" title="${escapeHtml(t("remote.git.worktreeBindHint"))}">
    <span class="git-row-main">
      <span class="git-row-name">${iconMarkup("folder-git-2")}${escapeHtml(worktree.worktreeName)}</span>
      <span class="git-row-sub">${iconMarkup("git-branch")}${escapeHtml(worktree.branchName || t("remote.git.detached"))}</span>
      ${worktree.isDirty ? `<span class="git-dirty" title="${escapeHtml(t("remote.git.worktreeDirty"))}"></span>` : ""}
      ${worktree.bound ? `<span class="git-badge is-accent">${escapeHtml(t("remote.git.worktreeBound"))}</span>` : ""}
    </span>
    <span class="git-row-side git-wt-actions">
      <button type="button" class="git-icon-btn" data-git-copy="${index}" aria-label="${escapeHtml(t("remote.git.worktreeCopyPath"))}">${iconMarkup("copy")}</button>
      <button type="button" class="git-icon-btn is-danger" data-git-remove="${index}" aria-label="${escapeHtml(t("remote.git.worktreeRemove"))}"${worktree.bound || busy ? " disabled" : ""}>${iconMarkup("trash-2")}</button>
      ${worktree.bound ? `<span class="git-check">${iconMarkup("check")}</span>` : ""}
    </span>
  </div>`;

const renderCreateForm = (): string => {
  if (createMode === "branch") {
    return (
      `<div class="git-form">` +
      `<div class="git-form-title">${iconMarkup("git-branch-plus")}<span>${escapeHtml(t("remote.git.createBranch"))}</span></div>` +
      `<input type="text" data-git-new-branch value="${escapeHtml(newBranchName)}"` +
      ` placeholder="${escapeHtml(t("remote.git.branchNamePlaceholder"))}" autocomplete="off" spellcheck="false" />` +
      `<div class="git-form-actions">` +
      `<button type="button" class="git-primary" data-git-submit="branch"${disabledAttr()}>${escapeHtml(t("remote.git.create"))}</button>` +
      `<button type="button" class="git-plain" data-git-cancel>${escapeHtml(t("remote.git.cancel"))}</button>` +
      `</div></div>`
    );
  }
  if (createMode !== "worktree") return "";
  const main = branches?.defaultMainBranch;
  return (
    `<div class="git-form">` +
    `<div class="git-form-title">${iconMarkup("folder-git-2")}<span>${escapeHtml(t("remote.git.createWorktree"))}</span></div>` +
    `<div class="git-form-label-row"><span class="git-form-label">${escapeHtml(t("remote.git.branchName"))}</span>` +
    `<button type="button" class="git-link-btn" data-git-generate>${iconMarkup("sparkles")}${escapeHtml(t("remote.git.generate"))}</button></div>` +
    `<div class="git-chips">${["feature/", "fix/", "task/", "test/"]
      .map(
        (prefix) =>
          `<button type="button" class="git-chipbtn" data-git-prefix="${prefix}">${prefix}</button>`,
      )
      .join("")}</div>` +
    `<input type="text" data-git-new-worktree value="${escapeHtml(newWorktreeBranch)}"` +
    ` placeholder="${escapeHtml(t("remote.git.branchNamePlaceholder"))}" autocomplete="off" spellcheck="false" />` +
    `<div class="git-form-label">${escapeHtml(t("remote.git.baseRef"))}</div>` +
    `<div class="git-chips">` +
    `<button type="button" class="git-chipbtn${newWorktreeBase === "HEAD" ? " active" : ""}" data-git-base="HEAD">HEAD</button>` +
    (main
      ? `<button type="button" class="git-chipbtn${newWorktreeBase === main ? " active" : ""}" data-git-base="${escapeHtml(main)}">${escapeHtml(main)}</button>`
      : "") +
    `</div>` +
    `<input type="text" data-git-base-input value="${escapeHtml(newWorktreeBase)}"` +
    ` placeholder="${escapeHtml(t("remote.git.baseRefPlaceholder"))}" autocomplete="off" spellcheck="false" />` +
    `<div class="git-form-actions">` +
    `<button type="button" class="git-primary" data-git-submit="worktree"${disabledAttr()}>${escapeHtml(t("remote.git.create"))}</button>` +
    `<button type="button" class="git-plain" data-git-cancel>${escapeHtml(t("remote.git.cancel"))}</button>` +
    `</div></div>`
  );
};

const renderBranchesList = (): string => {
  if (branchError) return gitEmpty(branchError, true);
  if (branchLoading && !branches) return gitEmpty(t("remote.git.loading"));
  if (!branches) return gitEmpty(t("remote.git.loading"));
  if (!branches.branches.length && !branches.worktrees.length) {
    return gitEmpty(t("remote.git.noBranches"));
  }

  const worktrees = branches.worktrees
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => worktreeMatches(item));
  const locals = branches.branches
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.isRemote && branchMatches(item));
  const remotes = branches.branches
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.isRemote && branchMatches(item));

  const removeTarget = pendingRemove
    ? branches.worktrees.find((item) => item.worktreeId === pendingRemove)
    : null;
  const confirmBar = removeTarget
    ? `<div class="git-confirm" role="alert">` +
      `<span>${escapeHtml(
        t("remote.git.worktreeRemoveConfirm", {
          name: removeTarget.worktreeName,
        }),
      )}</span>` +
      `<div class="git-confirm-actions">` +
      `<button type="button" class="git-danger" data-git-confirm-remove${disabledAttr()}>${escapeHtml(t("remote.git.worktreeRemoveConfirmAction"))}</button>` +
      `<button type="button" class="git-plain" data-git-cancel>${escapeHtml(t("remote.git.cancel"))}</button>` +
      `</div></div>`
    : "";

  const sections: string[] = [];
  if (worktrees.length > 0) {
    sections.push(
      `<div class="git-section">` +
        `<div class="git-section-title"><span>${escapeHtml(t("remote.git.worktrees"))}</span><span class="git-count">${worktrees.length}</span>` +
        (branches.boundWorktreeId
          ? `<button type="button" class="git-link-btn" data-git-unbind${disabledAttr()}>${escapeHtml(t("remote.git.worktreeUnbind"))}</button>`
          : "") +
        `</div>` +
        worktrees
          .map(({ item, index }) => renderWorktreeRow(item, index))
          .join("") +
        `</div>`,
    );
  }
  if (locals.length > 0) {
    sections.push(
      `<div class="git-section">` +
        `<div class="git-section-title"><span>${escapeHtml(t("remote.git.localBranches"))}</span><span class="git-count">${locals.length}</span></div>` +
        locals.map(({ item, index }) => renderBranchRow(item, index)).join("") +
        `</div>`,
    );
  }
  if (remotes.length > 0) {
    sections.push(
      `<div class="git-section">` +
        `<div class="git-section-title"><span>${escapeHtml(t("remote.git.remoteBranches"))}</span><span class="git-count">${remotes.length}</span></div>` +
        remotes
          .map(({ item, index }) => renderBranchRow(item, index))
          .join("") +
        `</div>`,
    );
  }
  if (!sections.length) return gitEmpty(t("remote.git.searchEmpty"));
  return confirmBar + sections.join("");
};

const renderBranchesTab = (): string => {
  const query = escapeHtml(branchQuery);
  const toolbar =
    `<div class="git-toolbar">` +
    `<div class="git-search">${iconMarkup("search")}` +
    `<input type="text" data-git-search value="${query}" placeholder="${escapeHtml(t("remote.git.searchPlaceholder"))}" autocomplete="off" spellcheck="false" />` +
    `<button type="button" class="git-search-clear" data-git-clear-search aria-label="${escapeHtml(t("remote.git.clearSearch"))}"${branchQuery ? "" : " hidden"}>${iconMarkup("x")}</button>` +
    `</div>` +
    `<button type="button" class="git-icon-btn${createMode === "branch" ? " active" : ""}" data-git-create="branch" aria-label="${escapeHtml(t("remote.git.createBranch"))}">${iconMarkup("git-branch-plus")}</button>` +
    `<button type="button" class="git-icon-btn${createMode === "worktree" ? " active" : ""}" data-git-create="worktree" aria-label="${escapeHtml(t("remote.git.createWorktree"))}">${iconMarkup("folder-git-2")}</button>` +
    `<button type="button" class="git-icon-btn" data-git-refresh aria-label="${escapeHtml(t("remote.git.refresh"))}">${iconMarkup("refresh-cw")}</button>` +
    `</div>` +
    renderCreateForm() +
    `<div id="gitList" class="git-list">${renderBranchesList()}</div>`;
  return toolbar;
};

// ── 变更 Tab ──────────────────────────────────────────────────────────────

const isStagedFile = (file: SnowRemoteGitFile): boolean =>
  file.indexStatus !== " " &&
  file.indexStatus !== "?" &&
  file.indexStatus !== "";

const isUnstagedFile = (file: SnowRemoteGitFile): boolean =>
  file.workdirStatus === "?" ||
  (file.workdirStatus !== " " && file.workdirStatus !== "");

const renderFileRow = (
  file: SnowRemoteGitFile,
  index: number,
  staged: boolean,
): string => {
  const code = staged ? file.indexStatus : file.workdirStatus;
  // 与桌面 GitFileList 一致：暂存用「+」、取消暂存用「-」，未暂存另给撤销入口。
  const actionKey = staged ? "unstage" : "stage";
  const actionLabel = staged ? t("remote.git.unstage") : t("remote.git.stage");
  return (
    `<div class="git-row git-file" data-git-open-diff="${index}" data-git-diff-staged="${staged ? 1 : 0}">` +
    `<span class="git-status-badge ${statusClass(code)}">${escapeHtml(code.trim() || "?")}</span>` +
    `<span class="git-row-main">` +
    `<span class="git-row-name" title="${escapeHtml(file.path)}">${escapeHtml(shortPath(file.path))}</span>` +
    (file.oldPath
      ? `<span class="git-row-sub">${escapeHtml(shortPath(file.oldPath))} →</span>`
      : "") +
    `</span>` +
    `<span class="git-row-side">` +
    `<button type="button" class="git-icon-btn git-file-toggle" data-git-${actionKey}="${index}" aria-label="${escapeHtml(actionLabel)}"${disabledAttr()}>${staged ? "-" : "+"}</button>` +
    (staged
      ? ""
      : `<button type="button" class="git-icon-btn git-file-discard" data-git-discard="${index}" aria-label="${escapeHtml(t("remote.git.discard"))}"${disabledAttr()}>${iconMarkup("undo-2")}</button>`) +
    `</span></div>`
  );
};

/** 提交框与撤销确认条：有可操作变更时渲染（提交框吸顶在 Tab 之下）。 */
const renderChangesHeader = (): string => {
  if (!status || !status.isRepo || statusError) return "";
  if (
    !status.files.some((file) => isStagedFile(file) || isUnstagedFile(file))
  ) {
    return "";
  }
  const stagedCount = status.files.filter(isStagedFile).length;
  const commitBox =
    `<div class="git-commit-box">` +
    `<textarea data-git-commit-input rows="2" maxlength="4000" placeholder="${escapeHtml(t("remote.git.commitPlaceholder"))}">${escapeHtml(commitMessage)}</textarea>` +
    `<button type="button" class="git-primary" data-git-commit${busy || !commitMessage.trim() || stagedCount === 0 ? " disabled" : ""}>${escapeHtml(busy ? t("remote.git.committing") : t("remote.git.commit"))}</button>` +
    `</div>`;

  const discardTarget = pendingDiscard
    ? status.files.find((file) => file.path === pendingDiscard)
    : null;
  const discardBar = discardTarget
    ? `<div class="git-confirm" role="alert">` +
      `<span>${escapeHtml(
        t("remote.git.discardConfirm", { path: shortPath(discardTarget.path) }),
      )}</span>` +
      `<div class="git-confirm-actions">` +
      `<button type="button" class="git-danger" data-git-confirm-discard${disabledAttr()}>${escapeHtml(t("remote.git.discardConfirmAction"))}</button>` +
      `<button type="button" class="git-plain" data-git-cancel>${escapeHtml(t("remote.git.cancel"))}</button>` +
      `</div></div>`
    : "";

  return commitBox + discardBar;
};

const renderChangesList = (): string => {
  if (statusError) return gitEmpty(statusError, true);
  if (statusLoading && !status) return gitEmpty(t("remote.git.loading"));
  if (!status) return gitEmpty(t("remote.git.loading"));
  if (!status.isRepo) return gitEmpty(t("remote.git.notRepo"));

  const stagedRows = status.files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => isStagedFile(file));
  const unstagedRows = status.files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => isUnstagedFile(file));

  if (!stagedRows.length && !unstagedRows.length) {
    return gitEmpty(t("remote.git.changesEmpty"));
  }

  const stagedSection =
    stagedRows.length > 0
      ? `<div class="git-section">` +
        `<div class="git-section-title"><span>${escapeHtml(t("remote.git.staged"))}</span><span class="git-count">${stagedRows.length}</span>` +
        `<button type="button" class="git-link-btn" data-git-unstage-all${disabledAttr()}>${escapeHtml(t("remote.git.unstageAll"))}</button>` +
        `</div>` +
        stagedRows
          .map(({ file, index }) => renderFileRow(file, index, true))
          .join("") +
        `</div>`
      : "";

  const unstagedSection =
    unstagedRows.length > 0
      ? `<div class="git-section">` +
        `<div class="git-section-title"><span>${escapeHtml(t("remote.git.unstaged"))}</span><span class="git-count">${unstagedRows.length}</span>` +
        `<button type="button" class="git-link-btn" data-git-stage-all${disabledAttr()}>${escapeHtml(t("remote.git.stageAll"))}</button>` +
        `</div>` +
        unstagedRows
          .map(({ file, index }) => renderFileRow(file, index, false))
          .join("") +
        `</div>`
      : "";

  const limitNote = status.statusLimitHit
    ? `<div class="git-note">${escapeHtml(
        t("remote.git.statusLimit", { count: status.files.length }),
      )}</div>`
    : "";

  return stagedSection + unstagedSection + limitNote;
};

const renderChangesTab = (): string =>
  renderChangesHeader() +
  `<div id="gitList" class="git-list">${renderChangesList()}</div>`;

// ── 差异视图 ──────────────────────────────────────────────────────────────

const buildDiffHtml = (content: string): string => {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let shown = 0;
  let inHunk = false;
  for (const line of lines) {
    if (shown >= MAX_DIFF_LINES) break;
    if (line.startsWith("@@")) inHunk = true;
    if (
      !inHunk &&
      (line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("similarity index ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to "))
    ) {
      continue;
    }
    let kind = "ctx";
    let sign = " ";
    let text = line;
    if (line.startsWith("@@")) {
      kind = "hunk";
      sign = "";
    } else if (line.startsWith("+")) {
      kind = "add";
      sign = "+";
      text = line.slice(1);
    } else if (line.startsWith("-")) {
      kind = "del";
      sign = "-";
      text = line.slice(1);
    } else if (line.startsWith("\\")) {
      kind = "note";
      sign = "";
    } else if (line.startsWith(" ")) {
      text = line.slice(1);
    }
    out.push(
      `<div class="git-diff-line ${kind}"><span class="git-diff-sign">${escapeHtml(sign)}</span><span class="git-diff-code">${escapeHtml(text)}</span></div>`,
    );
    shown += 1;
  }
  if (shown < lines.length) {
    out.push(
      `<div class="git-note">${escapeHtml(t("remote.git.diffTruncated"))}</div>`,
    );
  }
  return out.join("");
};

const renderDiffView = (view: DiffView): string => {
  const head =
    `<div class="git-diff-head">` +
    `<button type="button" class="git-icon-btn" data-git-diff-back aria-label="${escapeHtml(t("remote.git.back"))}">${iconMarkup("chevron-left")}</button>` +
    `<span class="git-diff-path" title="${escapeHtml(view.path)}">${escapeHtml(shortPath(view.path))}</span>` +
    `<span class="git-badge${view.staged ? " is-accent" : ""}">${escapeHtml(
      view.staged ? t("remote.git.diffStaged") : t("remote.git.diffUnstaged"),
    )}</span>` +
    `</div>`;

  if (view.loading) return head + gitEmpty(t("remote.git.diffLoading"));
  if (view.error) return head + gitEmpty(view.error, true);
  if (!view.result) return head;
  const result = view.result;
  if (result.isBinary) {
    return (
      head +
      `<div class="git-note">${escapeHtml(t("remote.git.diffBinary"))}</div>`
    );
  }
  if (result.error) {
    return (
      head + `<div class="git-note is-warn">${escapeHtml(result.error)}</div>`
    );
  }
  if (!result.content.trim()) {
    return (
      head +
      `<div class="git-note">${escapeHtml(
        result.untracked
          ? t("remote.git.diffUntracked")
          : t("remote.git.diffEmpty"),
      )}</div>`
    );
  }
  return (
    head +
    (result.truncated
      ? `<div class="git-note">${escapeHtml(t("remote.git.diffTruncated"))}</div>`
      : "") +
    `<div class="git-diff-body">${buildDiffHtml(result.content)}</div>`
  );
};

// ── 面板渲染与交互 ────────────────────────────────────────────────────────

const updateTabButtons = (): void => {
  document
    .querySelectorAll<HTMLButtonElement>("[data-git-tab]")
    .forEach((button) => {
      const active = button.dataset.gitTab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
};

/** 面板头实际高度决定 tabs / 提交框的吸顶偏移。 */
const syncStickyOffsets = (): void => {
  const panel = $("gitPanel");
  const head = panel.querySelector<HTMLElement>(".panel-head");
  if (!head) return;
  const height = head.offsetHeight;
  if (height > 0) panel.style.setProperty("--git-head-h", `${height}px`);
};

const renderGitPanel = (): void => {
  syncStickyOffsets();
  const body = $("gitPanelBody");
  updateTabButtons();
  renderGitChangesBadge();
  if (diffView) {
    body.innerHTML = renderDiffView(diffView);
    return;
  }
  body.innerHTML =
    tab === "branches" ? renderBranchesTab() : renderChangesTab();
  if (focusField) {
    const selector =
      focusField === "branch"
        ? "[data-git-new-branch]"
        : "[data-git-new-worktree]";
    body.querySelector<HTMLInputElement>(selector)?.focus();
    focusField = null;
  }
};

const renderGitList = (): void => {
  const list = document.getElementById("gitList");
  if (!list || tab !== "branches") {
    renderGitPanel();
    return;
  }
  list.innerHTML = renderBranchesList();
};

const switchTab = (next: GitTab): void => {
  if (tab === next) return;
  tab = next;
  createMode = null;
  pendingRemove = null;
  pendingDiscard = null;
  diffRequest += 1;
  diffView = null;
  branchQuery = "";
  updateTabButtons();
  $("gitPanel").scrollTop = 0;
  renderGitPanel();
  if (next === "branches") {
    void loadBranches();
  } else {
    void loadStatus();
  }
};

export const openGitPanel = (): void => {
  rememberOverlayTrigger($("gitChip"));
  tab = "branches";
  createMode = null;
  pendingRemove = null;
  pendingDiscard = null;
  diffRequest += 1;
  diffView = null;
  branchQuery = "";
  newBranchName = "";
  newWorktreeBranch = "";
  newWorktreeBase = "HEAD";
  commitMessage = "";
  updateTabButtons();
  openRemotePanel("gitPanel");
  renderGitPanel();
  void loadBranches();
  void refreshGitSummary(true);
};

const generateWorktreeBranch = (): void => {
  const date = new Date().toISOString().slice(5, 10).replace("-", "");
  const suffix = Math.random().toString(36).slice(2, 6);
  const exists = (name: string): boolean =>
    (branches?.branches ?? []).some(
      (branch) => !branch.isRemote && branch.name === name,
    ) || (branches?.worktrees ?? []).some((item) => item.branchName === name);
  let candidate = `feature/wt-${date}-${suffix}`;
  let counter = 1;
  while (exists(candidate)) {
    candidate = `feature/wt-${date}-${suffix}${counter++}`;
  }
  newWorktreeBranch = candidate;
  renderGitPanel();
  $("gitPanelBody")
    .querySelector<HTMLInputElement>("[data-git-new-worktree]")
    ?.focus();
};

const applyWorktreePrefix = (prefix: string): void => {
  newWorktreeBranch =
    prefix + newWorktreeBranch.replace(/^(feature|fix|task|test|temp)\//, "");
  renderGitPanel();
  $("gitPanelBody")
    .querySelector<HTMLInputElement>("[data-git-new-worktree]")
    ?.focus();
};

const submitCreate = (): void => {
  if (busy) return;
  if (createMode === "branch") {
    const name = newBranchName.trim();
    if (!name) {
      showNotice(t("remote.git.branchNameRequired"), true);
      return;
    }
    void runGitAction(
      async () => {
        await gitCreateBranch(name);
        createMode = null;
        newBranchName = "";
      },
      t("remote.git.branchCreated", { name }),
    );
    return;
  }
  if (createMode === "worktree") {
    const name = newWorktreeBranch.trim();
    const base = newWorktreeBase.trim() || "HEAD";
    if (!name) {
      showNotice(t("remote.git.branchNameRequired"), true);
      return;
    }
    void runGitAction(async () => {
      await gitCreateWorktree(name, base);
      createMode = null;
      newWorktreeBranch = "";
      newWorktreeBase = "HEAD";
    }, t("remote.git.worktreeCreated"));
  }
};

const checkoutBranch = (index: number, remote: boolean): void => {
  const branch = branches?.branches[index];
  if (!branch || branch.isCurrent) return;
  if (branch.worktreePath) {
    showNotice(t("remote.git.branchCheckedOut"), true);
    return;
  }
  void runGitAction(
    () => gitCheckout(branch.name, remote),
    t("remote.git.branchSwitched", { name: branch.name }),
  );
};

const bindWorktree = (index: number): void => {
  const worktree = branches?.worktrees[index];
  if (!worktree) return;
  void runGitAction(
    () => gitBindWorktree(worktree.worktreeId),
    t("remote.git.worktreeBoundNotice"),
  );
};

const unbindWorktree = (): void => {
  void runGitAction(
    () => gitBindWorktree(null),
    t("remote.git.worktreeUnboundNotice"),
  );
};

const copyWorktreePath = (index: number): void => {
  const worktree = branches?.worktrees[index];
  if (!worktree) return;
  void copyTextToClipboard(worktree.worktreePath).then((ok) => {
    showNotice(
      ok ? t("remote.git.worktreeCopyDone") : t("remote.git.copyFailed"),
      !ok,
    );
  });
};

const removeWorktree = (index: number): void => {
  const worktree = branches?.worktrees[index];
  if (!worktree || worktree.bound) return;
  pendingRemove = worktree.worktreeId;
  renderGitPanel();
};

const confirmRemoveWorktree = (): void => {
  const id = pendingRemove;
  if (!id || busy) return;
  pendingRemove = null;
  void runGitAction(
    () => gitRemoveWorktree(id),
    t("remote.git.worktreeRemoved"),
  );
};

const stageFile = (index: number): void => {
  const file = status?.files[index];
  if (!file) return;
  void runGitAction(() => gitStageFiles([file.path]));
};

const unstageFile = (index: number): void => {
  const file = status?.files[index];
  if (!file) return;
  void runGitAction(() => gitUnstageFiles([file.path]));
};

/** 撤销不可恢复：先弹确认条，确认后才走 gitDiscard。 */
const requestDiscard = (index: number): void => {
  const file = status?.files[index];
  if (!file || busy) return;
  pendingDiscard = file.path;
  pendingRemove = null;
  renderGitPanel();
  // 确认条在列表顶部，点击行可能在视口外：滚到中间保证可见。
  $("gitPanelBody")
    .querySelector<HTMLElement>("[data-git-confirm-discard]")
    ?.scrollIntoView({ block: "center" });
};

const confirmDiscard = (): void => {
  const path = pendingDiscard;
  if (!path || busy) return;
  pendingDiscard = null;
  void runGitAction(() => gitDiscardFiles([path]), t("remote.git.discarded"));
};

const submitCommit = (): void => {
  const message = commitMessage.trim();
  if (!message) {
    showNotice(t("remote.git.commitRequired"), true);
    return;
  }
  if (!status || status.stagedCount === 0) {
    showNotice(t("remote.git.commitNoStaged"), true);
    return;
  }
  void runGitAction(async () => {
    const result = await gitCommit(commitMessage);
    commitMessage = "";
    if (result.hash) {
      showNotice(t("remote.git.committed", { hash: result.hash }));
    } else {
      showNotice(t("remote.git.committedPlain"));
    }
  });
};

const openFileDiff = async (index: number, staged: boolean): Promise<void> => {
  const file = status?.files[index];
  if (!file) return;
  const request = ++diffRequest;
  diffView = {
    path: file.path,
    staged,
    loading: true,
    result: null,
    error: null,
  };
  $("gitPanel").scrollTop = 0;
  renderGitPanel();
  try {
    const result = await fetchGitDiff(file.path, staged);
    if (request !== diffRequest) return;
    diffView = {
      path: file.path,
      staged,
      loading: false,
      result,
      error: null,
    };
  } catch (error) {
    if (request !== diffRequest) return;
    diffView = {
      path: file.path,
      staged,
      loading: false,
      result: null,
      error: (error as Error).message || t("remote.git.diffLoadFailed"),
    };
  }
  renderGitPanel();
};

export const renderGit = (state: SnowRemoteState | null): void => {
  const key = state?.workspace?.directoryId ?? "";
  if (key !== directoryKey) {
    directoryKey = key;
    branchRequest += 1;
    statusRequest += 1;
    diffRequest += 1;
    summary = null;
    branches = null;
    status = null;
    branchLoading = false;
    statusLoading = false;
    branchError = null;
    statusError = null;
    createMode = null;
    pendingRemove = null;
    pendingDiscard = null;
    diffRequest += 1;
    diffView = null;
    newBranchName = "";
    newWorktreeBranch = "";
    newWorktreeBase = "HEAD";
    commitMessage = "";
    branchQuery = "";
    lastSummaryAt = 0;
    renderGitChip();
    renderGitChangesBadge();
    if (key && isGitPanelOpen()) {
      tab = "branches";
      updateTabButtons();
      renderGitPanel();
      void loadBranches();
    }
  }
  renderGitChangesBadge();
  if (key) void refreshGitSummary();
};

export const initGit = (): void => {
  $("gitChip").onclick = () => openGitPanel();

  document
    .querySelectorAll<HTMLButtonElement>("[data-git-tab]")
    .forEach((button) => {
      button.onclick = () => {
        const value = button.dataset.gitTab;
        if (value === "branches" || value === "changes") switchTab(value);
      };
    });

  const body = $("gitPanelBody");

  body.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    if (target.closest("[data-git-diff-back]")) {
      diffRequest += 1;
      diffView = null;
      renderGitPanel();
      return;
    }
    if (target.closest("[data-git-cancel]")) {
      createMode = null;
      pendingRemove = null;
      pendingDiscard = null;
      renderGitPanel();
      return;
    }
    if (target.closest("[data-git-clear-search]")) {
      branchQuery = "";
      const input = body.querySelector<HTMLInputElement>("[data-git-search]");
      if (input) input.value = "";
      const clear = body.querySelector<HTMLElement>("[data-git-clear-search]");
      if (clear) clear.hidden = true;
      renderGitList();
      return;
    }

    const createButton = target.closest<HTMLElement>("[data-git-create]");
    if (createButton) {
      const mode = createButton.dataset.gitCreate;
      if (mode !== "branch" && mode !== "worktree") return;
      createMode = createMode === mode ? null : mode;
      pendingRemove = null;
      pendingDiscard = null;
      if (createMode === "branch") newBranchName = "";
      focusField = createMode === "branch" ? "branch" : "worktree";
      renderGitPanel();
      return;
    }

    if (target.closest("[data-git-refresh]")) {
      if (tab === "branches") void loadBranches();
      else void loadStatus();
      void refreshGitSummary(true);
      return;
    }

    if (target.closest("[data-git-generate]")) {
      generateWorktreeBranch();
      return;
    }

    const prefixButton = target.closest<HTMLElement>("[data-git-prefix]");
    if (prefixButton) {
      applyWorktreePrefix(prefixButton.dataset.gitPrefix ?? "");
      return;
    }

    const baseButton = target.closest<HTMLElement>("[data-git-base]");
    if (baseButton) {
      newWorktreeBase = baseButton.dataset.gitBase ?? "HEAD";
      renderGitPanel();
      body.querySelector<HTMLInputElement>("[data-git-base-input]")?.focus();
      return;
    }

    const submitButton = target.closest<HTMLElement>("[data-git-submit]");
    if (submitButton) {
      submitCreate();
      return;
    }

    const copyButton = target.closest<HTMLElement>("[data-git-copy]");
    if (copyButton) {
      copyWorktreePath(Number(copyButton.dataset.gitCopy));
      return;
    }

    const removeButton = target.closest<HTMLElement>("[data-git-remove]");
    if (removeButton) {
      removeWorktree(Number(removeButton.dataset.gitRemove));
      return;
    }

    if (target.closest("[data-git-confirm-remove]")) {
      confirmRemoveWorktree();
      return;
    }

    if (target.closest("[data-git-unbind]")) {
      unbindWorktree();
      return;
    }

    const stageButton = target.closest<HTMLElement>("[data-git-stage]");
    if (stageButton) {
      stageFile(Number(stageButton.dataset.gitStage));
      return;
    }

    const unstageButton = target.closest<HTMLElement>("[data-git-unstage]");
    if (unstageButton) {
      unstageFile(Number(unstageButton.dataset.gitUnstage));
      return;
    }

    const discardButton = target.closest<HTMLElement>("[data-git-discard]");
    if (discardButton) {
      requestDiscard(Number(discardButton.dataset.gitDiscard));
      return;
    }

    if (target.closest("[data-git-confirm-discard]")) {
      confirmDiscard();
      return;
    }

    if (target.closest("[data-git-stage-all]")) {
      void runGitAction(() => gitStageAll());
      return;
    }

    if (target.closest("[data-git-unstage-all]")) {
      void runGitAction(() => gitUnstageAll());
      return;
    }

    if (target.closest("[data-git-commit]")) {
      submitCommit();
      return;
    }

    const diffRow = target.closest<HTMLElement>("[data-git-open-diff]");
    if (diffRow) {
      const staged = diffRow.dataset.gitDiffStaged === "1";
      void openFileDiff(Number(diffRow.dataset.gitOpenDiff), staged);
      return;
    }

    const bindRow = target.closest<HTMLElement>("[data-git-bind]");
    if (bindRow) {
      bindWorktree(Number(bindRow.dataset.gitBind));
      return;
    }

    const checkoutRow = target.closest<HTMLElement>("[data-git-checkout]");
    if (checkoutRow) {
      checkoutBranch(
        Number(checkoutRow.dataset.gitCheckout),
        checkoutRow.dataset.gitRemote === "1",
      );
    }
  });

  body.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-git-search]")) {
      branchQuery = (target as HTMLInputElement).value;
      const clear = body.querySelector<HTMLElement>("[data-git-clear-search]");
      if (clear) clear.hidden = branchQuery.length === 0;
      renderGitList();
      return;
    }
    if (target.matches("[data-git-new-branch]")) {
      newBranchName = (target as HTMLInputElement).value;
      return;
    }
    if (target.matches("[data-git-new-worktree]")) {
      newWorktreeBranch = (target as HTMLInputElement).value;
      return;
    }
    if (target.matches("[data-git-base-input]")) {
      newWorktreeBase = (target as HTMLInputElement).value;
      return;
    }
    if (target.matches("[data-git-commit-input]")) {
      commitMessage = (target as HTMLTextAreaElement).value;
      const button = body.querySelector<HTMLButtonElement>("[data-git-commit]");
      if (button) {
        button.disabled =
          busy || !commitMessage.trim() || (status?.stagedCount ?? 0) === 0;
      }
    }
  });

  body.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      if (target.matches("[data-git-search]") && branchQuery) {
        event.stopPropagation();
        branchQuery = "";
        (target as HTMLInputElement).value = "";
        const clear = body.querySelector<HTMLElement>(
          "[data-git-clear-search]",
        );
        if (clear) clear.hidden = true;
        renderGitList();
        return;
      }
      if (diffView) {
        event.stopPropagation();
        diffRequest += 1;
        diffView = null;
        renderGitPanel();
        return;
      }
      if (createMode || pendingRemove || pendingDiscard) {
        event.stopPropagation();
        createMode = null;
        pendingRemove = null;
        pendingDiscard = null;
        renderGitPanel();
      }
      return;
    }
    if (
      target.matches("[data-git-commit-input]") &&
      isSubmitEnter(event) &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      submitCommit();
      return;
    }
    if (
      isSubmitEnter(event) &&
      target.matches(
        "[data-git-new-branch], [data-git-new-worktree], [data-git-base-input]",
      )
    ) {
      event.preventDefault();
      submitCreate();
    }
  });
};
