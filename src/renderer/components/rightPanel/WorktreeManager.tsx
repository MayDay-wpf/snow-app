import { useCallback, useEffect, useState, useRef } from "react";
import {
  GitBranch,
  Plus,
  RefreshCw,
  Trash2,
  ChevronDown,
  Copy,
  Check,
  Folder,
  Terminal,
  FolderGit2,
  X,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Info,
  Sparkles,
} from "lucide-react";
import type { GitWorktreeInfo } from "../../../preload";
import { useI18n } from "../../i18n";
import {
  formatDisplayPath,
  normalizePathForCompare,
} from "../../utils/formatDisplayPath";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { WorktreeBaseRefSelect } from "./git/WorktreeBaseRefSelect";

/** 提取末级工作树文件夹名称（如 chat, clone 等）。 */
const getFolderName = (p: string): string => {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
};

const normPath = (p: string | null | undefined): string =>
  p ? normalizePathForCompare(p) : "";

export function WorktreeManager({
  directoryId,
  onOpenTerminal,
}: {
  directoryId: string;
  onOpenTerminal?: (cwd: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [branchName, setBranchName] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [isCustomBaseRef, setIsCustomBaseRef] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removeTarget, setRemoveTarget] = useState<GitWorktreeInfo | null>(
    null,
  );
  const [showCreate, setShowCreate] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 错误提示 6 秒后自动清除
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), 6000);
    return () => clearTimeout(timer);
  }, [error]);
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("snow:git:worktree-collapsed") === "true";
    } catch {
      return false;
    }
  });

  const branchInputRef = useRef<HTMLInputElement>(null);
  const customRefInputRef = useRef<HTMLInputElement>(null);

  const handleGenerateBranchName = useCallback(
    (prefix = "feature/"): void => {
      const dateStr = new Date().toISOString().slice(5, 10).replace("-", "");
      const randomSuffix = Math.random().toString(36).substring(2, 6);
      let candidate = `${prefix}wt-${dateStr}-${randomSuffix}`;
      let counter = 1;
      while (worktrees.some((wt) => wt.branchName === candidate)) {
        candidate = `${prefix}wt-${dateStr}-${randomSuffix}${counter++}`;
      }
      setBranchName(candidate);
      setError("");
    },
    [worktrees],
  );

  const handleApplyPrefix = useCallback((prefix: string): void => {
    setBranchName((prev) => {
      const clean = prev.replace(/^(feature|fix|task|test|temp)\//, "");
      return `${prefix}${clean}`;
    });
    branchInputRef.current?.focus();
  }, []);

  const toggleCollapsed = (): void => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("snow:git:worktree-collapsed", String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  const refresh = useCallback((): void => {
    setError("");
    void window.snow
      .gitListWorktrees(directoryId)
      .then(setWorktrees)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [directoryId]);

  useEffect(() => refresh(), [refresh]);

  useEffect(() => {
    if (showCreate && !isCollapsed) {
      branchInputRef.current?.focus();
    }
  }, [showCreate, isCollapsed]);

  const notifyWorktreesChanged = (): void => {
    window.dispatchEvent(new Event("snow:worktrees-changed"));
  };

  const create = (): void => {
    if (!branchName.trim() || !baseRef.trim() || busy) return;
    setBusy(true);
    setError("");
    void window.snow
      .gitCreateWorktree(directoryId, branchName.trim(), baseRef.trim())
      .then((created) => {
        setWorktrees((items) => [
          ...items.filter((item) => item.worktreeId !== created.worktreeId),
          created,
        ]);
        notifyWorktreesChanged();
        setBranchName("");
        setShowCreate(false);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setBusy(false));
  };

  const remove = (): void => {
    const target = removeTarget;
    if (!target || busy) return;
    setBusy(true);
    setError("");
    void window.snow
      .gitRemoveWorktree(directoryId, target.worktreeId)
      .then(() => {
        setRemoveTarget(null);
        notifyWorktreesChanged();
        refresh();
      })
      .catch((cause: unknown) => {
        const rawDetail =
          cause instanceof Error ? cause.message : String(cause);
        const detail = rawDetail
          .replace(/^Error invoking remote method '[^']+':\s*/i, "")
          .replace(/^Error:\s*/i, "")
          .trim();
        setError(
          /dirty|modified|uncommitted|未提交|修改/i.test(detail)
            ? t("git.worktreeRemoveDirty")
            : detail || t("git.worktreeRemoveFailed"),
        );
      })
      .finally(() => setBusy(false));
  };

  const handleCopyPath = (id: string, path: string): void => {
    void window.snow.writeClipboardText(path).then(() => {
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1500);
    });
  };

  return (
    <section className="git-worktrees" aria-label={t("git.worktreesTitle")}>
      <header
        className="git-worktrees-header"
        onClick={toggleCollapsed}
        title={
          isCollapsed
            ? t("common.expand", { defaultValue: "展开工作树" })
            : t("common.collapse", { defaultValue: "折叠工作树" })
        }
      >
        <button
          type="button"
          className={`git-worktrees-collapse-btn ${isCollapsed ? "is-collapsed" : ""}`}
          aria-expanded={!isCollapsed}
          tabIndex={-1}
        >
          <ChevronDown size={13} />
        </button>
        <strong>
          <GitBranch size={13} className="worktree-header-icon" />
          <span>{t("git.worktreesTitle")}</span>
          {worktrees.length > 0 && (
            <span className="git-worktree-count-badge">{worktrees.length}</span>
          )}
        </strong>
        <div
          className="git-worktrees-header-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className={`git-worktrees-header-btn ${showCreate ? "is-active" : ""}`}
            onClick={() => {
              if (isCollapsed) setIsCollapsed(false);
              setShowCreate((v) => !v);
            }}
            title={showCreate ? t("common.cancel") : t("git.worktreeCreate")}
            aria-label={t("git.worktreeCreate")}
          >
            <Plus size={13} className={showCreate ? "rotate-45" : ""} />
          </button>
          <button
            type="button"
            className="git-worktrees-header-btn"
            onClick={refresh}
            title={t("git.worktreesRefresh")}
            aria-label={t("git.worktreesRefresh")}
          >
            <RefreshCw size={12} className={busy ? "spin" : ""} />
          </button>
        </div>
      </header>

      {!isCollapsed && (
        <div className="git-worktrees-body">
          {showCreate && (
            <form
              className="git-worktree-create-panel"
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
            >
              <div className="git-worktree-create-header">
                <span>{t("git.worktreeCreate")}</span>
                <button
                  type="button"
                  className="git-worktree-close-btn"
                  onClick={() => setShowCreate(false)}
                  title={t("common.cancel")}
                >
                  <X size={12} />
                </button>
              </div>

              <div className="git-worktree-create-fields">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span
                    style={{ fontSize: "10px", color: "var(--text-muted)" }}
                  >
                    {t("git.worktreeBranchName")}
                  </span>
                  <button
                    type="button"
                    className="branch-name-action-btn"
                    onClick={() => handleGenerateBranchName()}
                    title={t("git.worktreeBranchGenerate", {
                      defaultValue: "自动生成唯一分支名称",
                    })}
                  >
                    <Sparkles size={10} />
                    <span>
                      {t("git.worktreeBranchGenerate", {
                        defaultValue: "自动生成",
                      })}
                    </span>
                  </button>
                </div>

                <div className="branch-prefix-chips">
                  {["feature/", "fix/", "task/", "test/"].map((prefix) => (
                    <button
                      key={prefix}
                      type="button"
                      className="branch-prefix-chip"
                      onClick={() => handleApplyPrefix(prefix)}
                      title={t("git.worktreeBranchPrefixTooltip", {
                        values: { prefix },
                      })}
                    >
                      {prefix}
                    </button>
                  ))}
                </div>

                <input
                  ref={branchInputRef}
                  type="text"
                  aria-label={t("git.worktreeBranchName")}
                  placeholder={t("git.worktreeBranchNamePlaceholder")}
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setShowCreate(false);
                    }
                  }}
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                />

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: "2px",
                  }}
                >
                  <span
                    style={{ fontSize: "10px", color: "var(--text-muted)" }}
                  >
                    {t("git.worktreeBaseRefLabel", {
                      defaultValue: "起始基线 (分叉起点)",
                    })}
                  </span>
                </div>

                <div className="git-worktree-base-chips">
                  <button
                    type="button"
                    className={`git-worktree-base-chip${!isCustomBaseRef && baseRef.trim() === "HEAD" ? " active" : ""}`}
                    onClick={() => {
                      setIsCustomBaseRef(false);
                      setBaseRef("HEAD");
                    }}
                    title={t("git.worktreeBaseHeadTooltip", {
                      defaultValue: "基于当前分支状态创建，适合延续当前进度",
                    })}
                  >
                    <span>HEAD</span>
                    <span style={{ fontSize: "9px", opacity: 0.75 }}>
                      ({t("git.worktreeCurrentTag", { defaultValue: "当前" })})
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`git-worktree-base-chip${!isCustomBaseRef && baseRef.trim() === "main" ? " active" : ""}`}
                    onClick={() => {
                      setIsCustomBaseRef(false);
                      setBaseRef("main");
                    }}
                    title={t("git.worktreeBaseMainTooltip", {
                      defaultValue: "基于主干分支创建，环境纯净独立",
                    })}
                  >
                    <span>main</span>
                    <span style={{ fontSize: "9px", opacity: 0.75 }}>
                      ({t("git.worktreeMainTag", { defaultValue: "主干" })})
                    </span>
                  </button>
                </div>

                <div className="branch-ref-input-wrapper">
                  <WorktreeBaseRefSelect
                    value={baseRef}
                    isCustom={isCustomBaseRef}
                    currentBranch="HEAD"
                    mainBranch="main"
                    disabled={busy}
                    onSelect={(ref) => {
                      setIsCustomBaseRef(false);
                      setBaseRef(ref);
                    }}
                    onSelectCustom={() => {
                      setIsCustomBaseRef(true);
                      setTimeout(() => customRefInputRef.current?.focus(), 50);
                    }}
                  />

                  {isCustomBaseRef && (
                    <div
                      style={{ display: "flex", gap: "4px", marginTop: "2px" }}
                    >
                      <input
                        ref={customRefInputRef}
                        type="text"
                        aria-label={t("git.worktreeBaseRef")}
                        placeholder={t("git.worktreeBaseCustomPlaceholder", {
                          defaultValue: "输入 Commit Hash、Tag 或远程分支",
                        })}
                        value={baseRef === "HEAD" ? "" : baseRef}
                        onChange={(event) => setBaseRef(event.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setShowCreate(false);
                          }
                        }}
                        disabled={busy}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="branch-create-cancel-btn"
                        onClick={() => {
                          setIsCustomBaseRef(false);
                          setBaseRef("HEAD");
                        }}
                        title={t("git.worktreeBaseHeadTooltip", {
                          defaultValue: "恢复默认 HEAD",
                        })}
                      >
                        HEAD
                      </button>
                    </div>
                  )}
                </div>

                <div className="git-worktree-helper-text">
                  <Info
                    size={11}
                    style={{ flexShrink: 0, marginTop: "1px" }}
                    className="text-blue-400"
                  />
                  <span>
                    {baseRef.trim() === "HEAD"
                      ? t("git.worktreeBaseHeadHint", {
                          values: { branch: "HEAD" },
                          defaultValue:
                            "基于当前工作状态创建，适合延续当前进度",
                        })
                      : baseRef.trim() === "main" || baseRef.trim() === "master"
                        ? t("git.worktreeBaseMainHint", {
                            values: { branch: baseRef.trim() },
                            defaultValue:
                              "基于主干分支创建，纯净无污染，适合全新功能开发",
                          })
                        : t("git.worktreeBaseBranchHint", {
                            values: { branch: baseRef.trim() },
                            defaultValue: `基于 '${baseRef.trim()}' 创建`,
                          })}
                  </span>
                </div>
              </div>

              <div className="git-worktree-create-footer">
                <span className="git-worktree-create-hint">
                  {t("git.worktreeShareable")}
                </span>
                <div className="git-worktree-create-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setShowCreate(false)}
                    disabled={busy}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={busy || !branchName.trim() || !baseRef.trim()}
                  >
                    {busy ? (
                      <Loader2 size={12} className="spin" />
                    ) : (
                      <Plus size={12} />
                    )}
                    {t("git.worktreeCreate")}
                  </button>
                </div>
              </div>
            </form>
          )}

          {error ? (
            <div role="alert" className="git-worktrees-error">
              <AlertCircle size={13} className="flex-shrink-0" />
              <span className="flex-1 min-w-0">{error}</span>
              <button
                type="button"
                className="git-worktrees-error-close"
                onClick={() => setError("")}
                title={t("common.close", { defaultValue: "关闭提示" })}
              >
                <X size={11} />
              </button>
            </div>
          ) : null}

          {worktrees.length > 0 ? (
            <ul className="git-worktrees-list">
              {worktrees.map((item) => {
                const cleanedPath = formatDisplayPath(item.worktreePath);
                const folderName = getFolderName(cleanedPath);
                const isCopied = copiedId === item.worktreeId;
                const isMain =
                  normPath(item.worktreePath) === normPath(item.repositoryPath);
                const isCurrent =
                  normPath(item.worktreePath) === normPath(directoryId);

                return (
                  <li
                    key={item.worktreeId}
                    className={`git-worktree-card ${!item.isValid ? "is-invalid" : ""}`}
                  >
                    <div className="git-worktree-card-top">
                      <div
                        className="git-worktree-branch-badge"
                        title={item.branchName || t("git.graphDetachedHead")}
                      >
                        <GitBranch size={12} className="worktree-branch-icon" />
                        <strong>
                          {item.branchName || t("git.graphDetachedHead")}
                        </strong>
                      </div>

                      <div className="git-worktree-status-group">
                        {item.isDirty ? (
                          <span
                            className="worktree-status-badge is-dirty"
                            title={t("git.worktreeDirty")}
                          >
                            <AlertCircle size={10} />
                            {t("git.worktreeDirty")}
                          </span>
                        ) : item.isValid ? (
                          <span
                            className="worktree-status-badge is-clean"
                            title={t("git.graphWorktreeClean", {
                              defaultValue: "工作区干净",
                            })}
                          >
                            <CheckCircle2 size={10} />
                            {t("git.graphWorktreeClean", {
                              defaultValue: "干净",
                            })}
                          </span>
                        ) : (
                          <span
                            className="worktree-status-badge is-invalid"
                            title={t("git.worktreeInvalidPath")}
                          >
                            <AlertCircle size={10} />
                            {t("git.worktreeInvalidPath")}
                          </span>
                        )}
                      </div>

                      <div className="git-worktree-card-actions">
                        <button
                          type="button"
                          className={`git-worktree-action-btn ${isCopied ? "is-copied" : ""}`}
                          title={
                            isCopied
                              ? t("common.copied", {
                                  defaultValue: "已复制路径",
                                })
                              : t("git.copyWorktreePath", {
                                  defaultValue: "复制工作树路径",
                                })
                          }
                          aria-label={t("git.copyWorktreePath", {
                            defaultValue: "复制工作树路径",
                          })}
                          onClick={() =>
                            handleCopyPath(item.worktreeId, cleanedPath)
                          }
                        >
                          {isCopied ? (
                            <Check size={12} className="text-success" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>

                        <button
                          type="button"
                          className="git-worktree-action-btn"
                          title={t("plugins.openFolder", {
                            defaultValue: "在文件夹中显示",
                          })}
                          aria-label={t("plugins.openFolder", {
                            defaultValue: "在文件夹中显示",
                          })}
                          onClick={() => {
                            void window.snow
                              .showItemInFolder(cleanedPath)
                              .catch(() => {});
                          }}
                        >
                          <Folder size={12} />
                        </button>

                        {onOpenTerminal && (
                          <button
                            type="button"
                            className="git-worktree-action-btn"
                            title={t("git.openInTerminal", {
                              defaultValue: "在终端中打开",
                            })}
                            aria-label={t("git.openInTerminal", {
                              defaultValue: "在终端中打开",
                            })}
                            onClick={() => onOpenTerminal(cleanedPath)}
                          >
                            <Terminal size={12} />
                          </button>
                        )}

                        {!isMain && (
                          <button
                            type="button"
                            className={`git-worktree-action-btn is-danger${isCurrent ? " is-disabled" : ""}`}
                            disabled={busy || isCurrent}
                            title={
                              isCurrent
                                ? t("git.cannotRemoveCurrentWorktree", {
                                    defaultValue:
                                      "当前所在工作树无法删除，请先切换到其他分支或工作树",
                                  })
                                : t("git.worktreeRemove")
                            }
                            aria-label={t("git.worktreeRemove")}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!isCurrent) {
                                setRemoveTarget(item);
                              }
                            }}
                          >
                            {busy &&
                            removeTarget?.worktreeId === item.worktreeId ? (
                              <Loader2
                                size={12}
                                className="spin text-red-400"
                              />
                            ) : (
                              <Trash2 size={12} />
                            )}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="git-worktree-card-path">
                      <span className="worktree-folder-tag" title={folderName}>
                        <FolderGit2 size={10} />
                        {folderName}
                      </span>
                      <code title={cleanedPath}>{cleanedPath}</code>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="git-worktrees-empty-box">
              <FolderGit2 size={24} className="empty-icon" />
              <p>{t("git.worktreesEmpty")}</p>
              <button
                type="button"
                className="btn-empty-action"
                onClick={() => setShowCreate(true)}
              >
                <Plus size={12} />
                <span>{t("git.worktreeCreate")}</span>
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        variant="danger"
        title={t("git.worktreeRemoveTitle")}
        message={t("git.worktreeRemoveConfirm", {
          values: {
            branch:
              removeTarget?.branchName ?? removeTarget?.worktreePath ?? "",
          },
        })}
        confirmLabel={t("git.worktreeRemove")}
        cancelLabel={t("common.cancel")}
        isConfirming={busy}
        onConfirm={remove}
        onCancel={() => {
          if (!busy) setRemoveTarget(null);
        }}
      />
    </section>
  );
}
