import {
  ChevronRight,
  Folder,
  FolderPlus,
  Loader2,
  Plus,
  Server,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../../i18n";
import { shortcutEvents } from "../../shortcutEvents";
import type {
  WorkspaceDirectoryInput,
  WorkspaceDirectoryKind,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { FormDialog } from "../../common/FormDialog";
import { WorkspaceDirectoryList } from "./WorkspaceDirectoryList";
import type { CrossProjectNotificationGroup } from "./useCrossProjectNotifications";

type AddDirectoryMode = "" | WorkspaceDirectoryKind;
type ProjectsSectionProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  /** 跨项目通知（其他项目的运行中/需关注/已完成会话分组），用于项目条目徽标 */
  notificationGroups?: CrossProjectNotificationGroup[];
  onActiveDirectoryChange?: (
    directory: WorkspaceDirectoryRecord | null
  ) => void;
  onSwitchingDirectoryChange: (isSwitchingDirectory: boolean) => void;
  onSwitchContent?: (content: "main" | "explorer") => void;
  onSwitchToExplorer?: (directoryId: string) => void;
  onOpenSshWizard?: () => void;
};

const DIRECTORY_PAGE_SIZE = 12;

const createDirectoryId = (
  kind: WorkspaceDirectoryKind,
  path: string
): string => `${kind}:${path.trim()}`;

const getDirectoryName = (
  kind: WorkspaceDirectoryKind,
  path: string
): string => {
  const trimmedPath = path.trim();

  if (kind === "ssh") {
    return trimmedPath.replace(/^ssh:\/\//, "") || trimmedPath;
  }

  return trimmedPath.split(/[\\/]/).filter(Boolean).pop() || trimmedPath;
};

const toWorkspaceDirectoryInput = (
  path: string,
  kind: WorkspaceDirectoryKind,
  existingCount: number
): WorkspaceDirectoryInput => {
  const trimmedPath = path.trim();

  return {
    directoryId: createDirectoryId(kind, trimmedPath),
    name: getDirectoryName(kind, trimmedPath),
    path: trimmedPath,
    kind,
    isActive: true,
    sortOrder: existingCount,
    source: "manual",
  };
};

const toPersistableDirectoryInput = (
  directory: WorkspaceDirectoryRecord,
  sortOrder: number
): WorkspaceDirectoryInput => ({
  directoryId: directory.directoryId,
  name: directory.name,
  path: directory.path,
  kind: directory.kind,
  isActive: directory.isActive,
  sortOrder,
  source: directory.source,
});

export function ProjectsSection({
  activeDirectory: externalActiveDirectory,
  notificationGroups,
  onActiveDirectoryChange,
  onSwitchingDirectoryChange,
  onSwitchContent,
  onSwitchToExplorer,
  onOpenSshWizard,
}: ProjectsSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const [workspaceDirectories, setWorkspaceDirectories] = useState<
    WorkspaceDirectoryRecord[]
  >([]);
  const [isLoadingDirectories, setIsLoadingDirectories] = useState(true);
  const [isSavingDirectory, setIsSavingDirectory] = useState(false);
  const [isReorderingDirectories, setIsReorderingDirectories] = useState(false);
  const [isSwitchingDirectory, setIsSwitchingDirectory] = useState(false);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [addDirectoryMode, setAddDirectoryMode] =
    useState<AddDirectoryMode>("");
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryPage, setDirectoryPage] = useState(1);
  const [draggedDirectoryId, setDraggedDirectoryId] = useState<string | null>(
    null
  );
  const [dragOverDirectoryId, setDragOverDirectoryId] = useState<string | null>(
    null
  );
  const directoryListRef = useRef<HTMLDivElement | null>(null);
  const directoryLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const [projectNameInput, setProjectNameInput] = useState("");
  const createProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [isAddLocalDialogOpen, setIsAddLocalDialogOpen] = useState(false);
  const [selectedLocalPath, setSelectedLocalPath] = useState("");
  const [isDraggingLocalDirectory, setIsDraggingLocalDirectory] = useState(false);
  const localPathInputRef = useRef<HTMLInputElement | null>(null);

  const [isProjectsCollapsed, setIsProjectsCollapsed] = useState(() => {
    try {
      return localStorage.getItem("projects-section-collapsed") === "true";
    } catch {
      return false;
    }
  });

  const toggleProjectsCollapsed = (): void => {
    setIsProjectsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("projects-section-collapsed", String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
    // 收起时关闭可能打开的添加菜单，避免菜单残留在界面上
    if (!isProjectsCollapsed) {
      setIsAddMenuOpen(false);
      setAddDirectoryMode("");
    }
  };

  const activeDirectory = useMemo(
    () => workspaceDirectories.find((directory) => directory.isActive),
    [workspaceDirectories]
  );

  // 各项目通知计数：directoryId → 通知会话数（需关注/运行中/已完成）。
  // 当前项目的动态由对话列表展示，不参与徽标（hook 已排除）。
  const notificationCountByDirectory = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const group of notificationGroups ?? []) {
      counts[group.directoryId] = group.notifications.length;
    }
    return counts;
  }, [notificationGroups]);

  useEffect(() => {
    onActiveDirectoryChange?.(activeDirectory ?? null);
  }, [activeDirectory, onActiveDirectoryChange]);

  const updateSwitchingDirectory = useCallback(
    (nextIsSwitching: boolean): void => {
      setIsSwitchingDirectory(nextIsSwitching);
      onSwitchingDirectoryChange(nextIsSwitching);
    },
    [onSwitchingDirectoryChange]
  );

  // Mirror values into refs so the external-sync effect can read the latest
  // state without re-running on every internal change (which would cause an
  // infinite loop with the upward-sync effect above).
  const activeDirectoryIdRef = useRef<string | undefined>(undefined);
  activeDirectoryIdRef.current = activeDirectory?.directoryId;
  const isSwitchingRef = useRef(isSwitchingDirectory);
  isSwitchingRef.current = isSwitchingDirectory;
  // Tracks the last external directoryId we have already processed so we
  // only react to genuine external changes (e.g. global search), not to
  // our own internal changes echoing back through the parent.
  const lastSyncedExternalIdRef = useRef<string | null>(null);

  // Sync internal state when the active directory changes from outside
  // (e.g. via global search). Only fires on real external changes.
  useEffect(() => {
    if (!externalActiveDirectory) {
      return;
    }
    const externalId = externalActiveDirectory.directoryId;
    // Already processed this external ID
    if (externalId === lastSyncedExternalIdRef.current) {
      return;
    }
    // Internal state already matches
    if (externalId === activeDirectoryIdRef.current) {
      lastSyncedExternalIdRef.current = externalId;
      return;
    }
    // In the middle of a switch
    if (isSwitchingRef.current) {
      return;
    }
    lastSyncedExternalIdRef.current = externalId;
    void (async (): Promise<void> => {
      updateSwitchingDirectory(true);
      setDirectoryError(null);
      try {
        const directories = await window.snow.activateWorkspaceDirectory(
          externalId
        );
        setWorkspaceDirectories(directories);
      } catch (error) {
        setDirectoryError(
          error instanceof Error
            ? error.message
            : t("sidebar.activateDirectoryError", {
                defaultValue: "Failed to activate workspace directory",
              })
        );
      } finally {
        updateSwitchingDirectory(false);
      }
    })();
  }, [externalActiveDirectory, updateSwitchingDirectory, t]);

  const visibleDirectoryCount = directoryPage * DIRECTORY_PAGE_SIZE;
  const visibleDirectories = useMemo(
    () => workspaceDirectories.slice(0, visibleDirectoryCount),
    [visibleDirectoryCount, workspaceDirectories]
  );
  const hasMoreDirectories =
    visibleDirectoryCount < workspaceDirectories.length;

  const loadNextDirectoryPage = useCallback((): void => {
    setDirectoryPage((currentPage) => {
      const maxPage = Math.ceil(
        workspaceDirectories.length / DIRECTORY_PAGE_SIZE
      );

      return Math.min(currentPage + 1, Math.max(maxPage, 1));
    });
  }, [workspaceDirectories.length]);

  const loadWorkspaceDirectories = useCallback(async (): Promise<void> => {
    setDirectoryError(null);

    try {
      const directories = await window.snow.listWorkspaceDirectories();
      setWorkspaceDirectories(directories);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.loadDirectoriesError", {
              defaultValue: "Failed to load workspace directories",
            })
      );
    } finally {
      setIsLoadingDirectories(false);
    }
  }, [t]);

  useEffect(() => {
    void loadWorkspaceDirectories();
  }, [loadWorkspaceDirectories]);

  // Refresh the directory list whenever another part of the app (e.g. the
  // empty-chat greeting card or the SSH wizard) adds/activates/deletes a
  // workspace directory. The main process broadcasts
  // "workspace-directory-list:changed" after every mutation, so subscribing
  // here keeps the sidebar in sync without coupling components together.
  useEffect(() => {
    const unsubscribe = window.snow.onWorkspaceDirectoryListChanged(() => {
      void loadWorkspaceDirectories();
    });
    return unsubscribe;
  }, [loadWorkspaceDirectories]);

  useEffect(() => {
    setDirectoryPage(1);
  }, [workspaceDirectories.length]);

  useEffect(() => {
    if (!hasMoreDirectories) {
      return;
    }

    const sentinel = directoryLoadMoreRef.current;
    const scrollRoot = directoryListRef.current;

    if (!sentinel || !scrollRoot) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadNextDirectoryPage();
        }
      },
      {
        root: scrollRoot,
        rootMargin: "0px 0px 32px",
        threshold: 0.1,
      }
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [hasMoreDirectories, loadNextDirectoryPage, visibleDirectories.length]);

  const persistWorkspaceDirectory = async (
    item: WorkspaceDirectoryInput
  ): Promise<boolean> => {
    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const directories = await window.snow.upsertWorkspaceDirectory(item);
      setWorkspaceDirectories(directories);
      setIsAddMenuOpen(false);
      setAddDirectoryMode("");
      return true;
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.addDirectoryError", {
              defaultValue: "Failed to add workspace directory",
            })
      );
      return false;
    } finally {
      setIsSavingDirectory(false);
    }
  };

  const handleAddDirectoryModeSelect = (
    mode: WorkspaceDirectoryKind
  ): void => {
    setAddDirectoryMode(mode);
    setDirectoryError(null);
    setIsAddMenuOpen(false);

    if (mode === "ssh") {
      onOpenSshWizard?.();
      return;
    }

    setSelectedLocalPath("");
    setIsAddLocalDialogOpen(true);
  };

  const handleSelectLocalDirectory = async (): Promise<void> => {
    if (isSavingDirectory) return;

    setDirectoryError(null);
    try {
      const selectedPath = await window.snow.selectWorkspaceDirectory(
        t("sidebar.selectLocalDirectoryTitle", {
          defaultValue: "Select local workspace directory",
        })
      );
      if (selectedPath) setSelectedLocalPath(selectedPath);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.selectLocalDirectoryError", {
              defaultValue: "Failed to select local directory",
            })
      );
    }
  };

  const handleAddLocalDirectoryCancel = (): void => {
    if (isSavingDirectory) return;
    // 取消时返回上一级（选择添加方式），而不是直接关闭整个模态框
    setIsAddLocalDialogOpen(false);
    setSelectedLocalPath("");
    setIsDraggingLocalDirectory(false);
    setAddDirectoryMode("");
    setDirectoryError(null);
    setIsAddMenuOpen(true);
  };

  const handleLocalDirectoryDrop = async (
    event: React.DragEvent<HTMLDivElement>
  ): Promise<void> => {
    event.preventDefault();
    setIsDraggingLocalDirectory(false);
    setDirectoryError(null);

    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setDirectoryError(
        t("sidebar.localDirectoryDropSingleError", {
          defaultValue: "Drop exactly one folder.",
        })
      );
      return;
    }

    try {
      const entries = await window.snow.resolveDroppedFiles(files);
      const entry = entries[0];
      if (!entry?.isDirectory) {
        setDirectoryError(
          t("sidebar.localDirectoryDropTypeError", {
            defaultValue: "Only folders can be added here.",
          })
        );
        return;
      }
      setSelectedLocalPath(entry.path);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.selectLocalDirectoryError", {
              defaultValue: "Failed to select local directory",
            })
      );
    }
  };

  const handleAddLocalDirectoryConfirm = async (): Promise<void> => {
    const selectedPath = selectedLocalPath.trim();
    if (!selectedPath || isSavingDirectory) return;

    const didSave = await persistWorkspaceDirectory(
      toWorkspaceDirectoryInput(
        selectedPath,
        "local",
        workspaceDirectories.length
      )
    );
    if (didSave) {
      setIsAddLocalDialogOpen(false);
      setSelectedLocalPath("");
    }
  };

  const handleCreateProjectModeOpen = (): void => {
    setDirectoryError(null);
    setAddDirectoryMode("");
    setIsAddMenuOpen(false);
    setProjectNameInput("");
    setIsCreateProjectOpen(true);
    // 表单渲染后聚焦输入框
    requestAnimationFrame(() => {
      createProjectInputRef.current?.focus();
    });
  };

  const handleCreateProjectCancel = (): void => {
    if (isSavingDirectory) {
      return;
    }
    // 取消时返回上一级（选择添加方式），而不是直接关闭整个模态框
    setIsCreateProjectOpen(false);
    setProjectNameInput("");
    setDirectoryError(null);
    setIsAddMenuOpen(true);
  };

  // 创建项目：先让用户选择保存目录（父目录），再交由主进程/Rust 创建文件夹
  // 并作为活动项目写入工作区目录列表。
  const handleCreateProjectConfirm = async (): Promise<void> => {
    const projectName = projectNameInput.trim();
    if (!projectName || isSavingDirectory) {
      return;
    }

    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const parentPath = await window.snow.selectWorkspaceDirectory(
        t("sidebar.selectCreateProjectParentTitle", {
          defaultValue: "Choose a folder to save the new project",
        })
      );

      if (!parentPath) {
        return;
      }

      const directories = await window.snow.createWorkspaceProject(
        parentPath,
        projectName
      );
      setWorkspaceDirectories(directories);
      setIsCreateProjectOpen(false);
      setProjectNameInput("");
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.createProjectError", {
              defaultValue: "Failed to create project",
            })
      );
    } finally {
      setIsSavingDirectory(false);
    }
  };

  const handleActivateDirectory = async (
    directoryId: string
  ): Promise<void> => {
    if (!directoryId || directoryId === activeDirectory?.directoryId) {
      return;
    }

    updateSwitchingDirectory(true);
    setDirectoryError(null);

    try {
      const directories = await window.snow.activateWorkspaceDirectory(
        directoryId
      );
      setWorkspaceDirectories(directories);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.activateDirectoryError", {
              defaultValue: "Failed to activate workspace directory",
            })
      );
    } finally {
      updateSwitchingDirectory(false);
    }
  };

  const persistWorkspaceDirectoryOrder = async (
    orderedDirectories: WorkspaceDirectoryRecord[]
  ): Promise<void> => {
    setIsReorderingDirectories(true);
    setDirectoryError(null);

    try {
      const nextInputs = orderedDirectories.map((directory, index) =>
        toPersistableDirectoryInput(directory, index)
      );
      const directories = await window.snow.reorderWorkspaceDirectories(
        nextInputs
      );
      setWorkspaceDirectories(directories);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.reorderDirectoryError", {
              defaultValue: "Failed to reorder workspace directories",
            })
      );
    } finally {
      setIsReorderingDirectories(false);
    }
  };

  const handleDirectoryDragStart = (directoryId: string): void => {
    setDraggedDirectoryId(directoryId);
    setDragOverDirectoryId(null);
  };

  const handleDirectoryDragOver = (directoryId: string): void => {
    setDragOverDirectoryId(directoryId);
  };

  const handleDirectoryDragEnd = (): void => {
    setDraggedDirectoryId(null);
    setDragOverDirectoryId(null);
  };

  const handleDirectoryDrop = (targetDirectoryId: string): void => {
    if (!draggedDirectoryId || draggedDirectoryId === targetDirectoryId) {
      handleDirectoryDragEnd();
      return;
    }

    const sourceIndex = workspaceDirectories.findIndex(
      (directory) => directory.directoryId === draggedDirectoryId
    );
    const targetIndex = workspaceDirectories.findIndex(
      (directory) => directory.directoryId === targetDirectoryId
    );

    if (sourceIndex < 0 || targetIndex < 0) {
      handleDirectoryDragEnd();
      return;
    }

    const nextDirectories = [...workspaceDirectories];
    const [movedDirectory] = nextDirectories.splice(sourceIndex, 1);
    nextDirectories.splice(targetIndex, 0, movedDirectory);
    setWorkspaceDirectories(nextDirectories);
    handleDirectoryDragEnd();
    void persistWorkspaceDirectoryOrder(nextDirectories);
  };

  const handleDeleteDirectory = async (directoryId: string): Promise<void> => {
    if (!directoryId) {
      return;
    }

    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const directories = await window.snow.deleteWorkspaceDirectory(
        directoryId
      );
      setWorkspaceDirectories(directories);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.deleteDirectoryError", {
              defaultValue: "Failed to delete workspace directory",
            })
      );
    } finally {
      setIsSavingDirectory(false);
    }
  };

  // 重命名目录显示名：保留其余字段（directoryId/path/kind/isActive/
  // sortOrder/source），仅更新 name，不影响磁盘路径与排序。
  const handleRenameDirectory = async (
    directoryId: string,
    newName: string
  ): Promise<void> => {
    const directory = workspaceDirectories.find(
      (d) => d.directoryId === directoryId
    );
    if (!directory) {
      return;
    }

    setIsSavingDirectory(true);
    setDirectoryError(null);

    try {
      const directories = await window.snow.upsertWorkspaceDirectory({
        directoryId: directory.directoryId,
        name: newName,
        path: directory.path,
        kind: directory.kind,
        isActive: directory.isActive,
        sortOrder: directory.sortOrder,
        source: directory.source,
      });
      setWorkspaceDirectories(directories);
    } catch (error) {
      setDirectoryError(
        error instanceof Error
          ? error.message
          : t("sidebar.renameDirectoryError", {
              defaultValue: "Failed to rename workspace directory",
            })
      );
      // 向上抛出，让行内编辑保持错误可见（由列表在 finally 中退出编辑态）
      throw error;
    } finally {
      setIsSavingDirectory(false);
    }
  };

  const handleShowDetails = (directoryId: string): void => {
    const directory = workspaceDirectories.find(
      (d) => d.directoryId === directoryId
    );

    if (!directory) {
      return;
    }

    onSwitchToExplorer?.(directory.directoryId);
  };

  // 基于当前位置自上而下循环切换项目。
  // 找到当前激活目录的索引，切换到下一个（末尾则回到第一个）。
  const handleCycleProject = useCallback(() => {
    if (workspaceDirectories.length === 0) return;
    // 切换中或保存中时不响应，避免状态混乱
    if (isSwitchingDirectory || isSavingDirectory || isReorderingDirectories) {
      return;
    }

    const currentIndex = activeDirectory
      ? workspaceDirectories.findIndex(
          (d) => d.directoryId === activeDirectory.directoryId
        )
      : -1;

    // 无当前激活目录时切换到第一个
    if (currentIndex === -1) {
      void handleActivateDirectory(workspaceDirectories[0].directoryId);
      return;
    }

    const nextIndex = (currentIndex + 1) % workspaceDirectories.length;
    const nextDirectory = workspaceDirectories[nextIndex];
    if (nextDirectory && nextDirectory.directoryId !== activeDirectory?.directoryId) {
      void handleActivateDirectory(nextDirectory.directoryId);
    }
  }, [
    workspaceDirectories,
    activeDirectory,
    isSwitchingDirectory,
    isSavingDirectory,
    isReorderingDirectories,
    handleActivateDirectory,
  ]);

  // 订阅快捷键事件：Ctrl/Cmd+` 循环切换项目
  useEffect(() => {
    return shortcutEvents.on("cycle-project", () => {
      handleCycleProject();
    });
  }, [handleCycleProject]);

  return (
    <div className="sidebar-section">
      <div className="section-header">
        <button
          aria-expanded={!isProjectsCollapsed}
          className="section-toggle-btn"
          onClick={toggleProjectsCollapsed}
          type="button"
        >
          <ChevronRight
            className={
              isProjectsCollapsed
                ? ""
                : "section-toggle-chevron--open"
            }
            size={12}
          />
          <span className="section-title">
            {t("sidebar.projects", { defaultValue: "Projects" })}
          </span>
        </button>
        <div className="section-actions">
          {isLoadingDirectories || isSavingDirectory ? (
            <Loader2 className="spin" size={14} />
          ) : (
            <button
              aria-expanded={isAddMenuOpen}
              aria-haspopup="dialog"
              aria-label={t("sidebar.addDirectoryScheme", {
                defaultValue: "Add directory",
              })}
              className="icon-btn ghost"
              onClick={() => {
                setDirectoryError(null);
                setAddDirectoryMode("");
                setIsAddMenuOpen(true);
              }}
              type="button"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>
      <FormDialog
        closeLabel={t("sidebar.close", { defaultValue: "Close" })}
        onCancel={() => setIsAddMenuOpen(false)}
        open={isAddMenuOpen}
        showFooter={false}
        title={t("sidebar.chooseDirectoryScheme", {
          defaultValue: "Choose add method",
        })}
      >
        <div className="project-action-grid">
          <button
            className="project-action-card"
            onClick={handleCreateProjectModeOpen}
            type="button"
          >
            <span className="project-action-card-icon">
              <FolderPlus size={20} />
            </span>
            <span className="project-action-card-content">
              <strong>
                {t("sidebar.createProject", { defaultValue: "Create project" })}
              </strong>
              <span>
                {t("sidebar.createProjectDescription", {
                  defaultValue: "Create a new local project folder",
                })}
              </span>
            </span>
          </button>
          <button
            className="project-action-card"
            onClick={() => handleAddDirectoryModeSelect("local")}
            type="button"
          >
            <span className="project-action-card-icon">
              <Folder size={20} />
            </span>
            <span className="project-action-card-content">
              <strong>
                {t("sidebar.addLocalDirectory", {
                  defaultValue: "Add local directory",
                })}
              </strong>
              <span>
                {t("sidebar.addLocalDirectoryActionDescription", {
                  defaultValue: "Select or drop an existing local folder",
                })}
              </span>
            </span>
          </button>
          <button
            className="project-action-card"
            onClick={() => handleAddDirectoryModeSelect("ssh")}
            type="button"
          >
            <span className="project-action-card-icon">
              <Server size={20} />
            </span>
            <span className="project-action-card-content">
              <strong>
                {t("sidebar.addSshDirectory", {
                  defaultValue: "Add SSH directory",
                })}
              </strong>
              <span>
                {t("sidebar.addSshDirectoryActionDescription", {
                  defaultValue: "Connect and add a remote server directory",
                })}
              </span>
            </span>
          </button>
        </div>
      </FormDialog>
      <FormDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        closeLabel={t("sidebar.close", { defaultValue: "Close" })}
        confirmDisabled={!projectNameInput.trim()}
        confirmLabel={t("sidebar.createProjectConfirm", {
          defaultValue: "Create",
        })}
        initialFocusRef={createProjectInputRef}
        isSubmitting={isSavingDirectory}
        onCancel={handleCreateProjectCancel}
        onConfirm={() => void handleCreateProjectConfirm()}
        open={isCreateProjectOpen}
        title={t("sidebar.createProjectTitle", {
          defaultValue: "Create a new project",
        })}
      >
        <label className="form-dialog-field">
          <span className="form-dialog-label">
            {t("sidebar.createProjectNameLabel", {
              defaultValue: "Project name",
            })}
          </span>
          <input
            ref={createProjectInputRef}
            className="form-dialog-input"
            disabled={isSavingDirectory}
            maxLength={120}
            onChange={(event) => setProjectNameInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleCreateProjectConfirm();
              }
            }}
            placeholder={t("sidebar.createProjectNamePlaceholder", {
              defaultValue: "Project name",
            })}
            value={projectNameInput}
          />
        </label>
        {directoryError ? (
          <span className="form-dialog-error">{directoryError}</span>
        ) : null}
      </FormDialog>
      <FormDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        closeLabel={t("sidebar.close", { defaultValue: "Close" })}
        confirmDisabled={!selectedLocalPath.trim()}
        confirmLabel={t("sidebar.add", { defaultValue: "Add" })}
        initialFocusRef={localPathInputRef}
        isSubmitting={isSavingDirectory}
        onCancel={handleAddLocalDirectoryCancel}
        onConfirm={() => void handleAddLocalDirectoryConfirm()}
        open={isAddLocalDialogOpen}
        title={t("sidebar.addLocalDirectory", {
          defaultValue: "Add local directory",
        })}
      >
        <p className="form-dialog-description">
          {t("sidebar.addLocalDirectoryDescription", {
            defaultValue: "Select a local folder to add as a workspace directory.",
          })}
        </p>
        <div
          className={`form-dialog-drop-zone${
            isDraggingLocalDirectory ? " drag-over" : ""
          }`}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDraggingLocalDirectory(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setIsDraggingLocalDirectory(false);
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(event) => void handleLocalDirectoryDrop(event)}
        >
          <FolderPlus size={22} />
          <strong>
            {t("sidebar.localDirectoryDropTitle", {
              defaultValue: "Drop a folder here",
            })}
          </strong>
          <span>
            {t("sidebar.localDirectoryDropHint", {
              defaultValue: "Or use Select folder below",
            })}
          </span>
        </div>
        <label className="form-dialog-field">
          <span className="form-dialog-label">
            {t("sidebar.localDirectoryPathLabel", {
              defaultValue: "Folder path",
            })}
          </span>
          <div className="form-dialog-input-row">
            <input
              ref={localPathInputRef}
              className="form-dialog-input"
              placeholder={t("sidebar.localDirectoryPathPlaceholder", {
                defaultValue: "No folder selected",
              })}
              readOnly
              value={selectedLocalPath}
            />
            <button
              className="form-dialog-button cancel form-dialog-browse-button"
              disabled={isSavingDirectory}
              onClick={() => void handleSelectLocalDirectory()}
              type="button"
            >
              {t("sidebar.selectFolder", { defaultValue: "Select folder" })}
            </button>
          </div>
        </label>
        {directoryError ? (
          <span className="form-dialog-error">{directoryError}</span>
        ) : null}
      </FormDialog>

      {!isProjectsCollapsed ? (
        <div className="workspace-directory-card">
          <span className="workspace-directory-label">
            {t("sidebar.activeDirectory", {
              defaultValue: "Active directory",
            })}
          </span>
          <WorkspaceDirectoryList
            activeDirectoryId={activeDirectory?.directoryId}
            directoryListRef={directoryListRef}
            draggedDirectoryId={draggedDirectoryId}
            dragOverDirectoryId={dragOverDirectoryId}
            hasMoreDirectories={hasMoreDirectories}
            isActionLocked={
              isSavingDirectory || isReorderingDirectories || isSwitchingDirectory
            }
            isLoadingDirectories={isLoadingDirectories}
            loadMoreRef={directoryLoadMoreRef}
            notificationCountByDirectory={notificationCountByDirectory}
            onActivate={(directoryId) =>
              void handleActivateDirectory(directoryId)
            }
            onDelete={(directoryId) => void handleDeleteDirectory(directoryId)}
            onDragEnd={handleDirectoryDragEnd}
            onDragOver={handleDirectoryDragOver}
            onDragStart={handleDirectoryDragStart}
            onDrop={handleDirectoryDrop}
            onRename={handleRenameDirectory}
            onShowDetails={handleShowDetails}
            totalCount={workspaceDirectories.length}
            visibleDirectories={visibleDirectories}
            workspaceDirectories={workspaceDirectories}
          />
          {directoryError && !isCreateProjectOpen && !isAddLocalDialogOpen ? (
            <span className="workspace-directory-error">{directoryError}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
