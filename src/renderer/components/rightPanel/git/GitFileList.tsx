import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileMinus,
  FilePlus,
  FileEdit,
  FileText,
  FileX,
  FolderOpen,
  Plus,
  Terminal as TerminalIcon,
  Undo2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { GitFileStatus } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { getFileTypeIcon } from "../../../utils/fileIcons";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import type { GitConfirmAnchor } from "./GitConfirmBubble";

type GitFileListProps = {
  repoPath: string;
  files: GitFileStatus[];
  section: "staged" | "unstaged";
  selectedPaths: Set<string>;
  actionInProgress: string | null;
  /** 文件展示方式：平铺列表或按目录分组的树。 */
  viewMode?: "list" | "tree";
  onFileSelect: (
    file: GitFileStatus,
    e: React.MouseEvent,
    section: "staged" | "unstaged",
  ) => void;
  /** 双击文件：打开该文件的差异视图。 */
  onFileActivate: (file: GitFileStatus, section: "staged" | "unstaged") => void;
  onStageToggle: (
    files: GitFileStatus[],
    section: "staged" | "unstaged",
  ) => void;
  onStageAll?: () => void;
  onUnstageAll?: () => void;
  /** 放弃变更区全部修改（需上层弹二次确认浮层）。 */
  onDiscardAll?: (anchor: GitConfirmAnchor) => void;
  onDiscard?: (files: GitFileStatus[]) => void;
  onOpenFile?: (file: GitFileStatus) => void;
  /** 在文件所在目录打开终端。 */
  onOpenTerminal?: (cwd: string) => void;
};

const getStatusIcon = (status: string): React.ReactNode => {
  switch (status) {
    case "A":
      return <FilePlus size={13} strokeWidth={1.8} />;
    case "M":
      return <FileEdit size={13} strokeWidth={1.8} />;
    case "D":
      return <FileX size={13} strokeWidth={1.8} />;
    case "U":
      return <FileMinus size={13} strokeWidth={1.8} />;
    case "R":
      return <FileEdit size={13} strokeWidth={1.8} />;
    case "C":
      return <FilePlus size={13} strokeWidth={1.8} />;
    default:
      return <FileEdit size={13} strokeWidth={1.8} />;
  }
};

const getStatusColor = (status: string): string => {
  switch (status) {
    case "A":
      return "git-status-add";
    case "M":
      return "git-status-modify";
    case "D":
      return "git-status-delete";
    case "U":
      return "git-status-untracked";
    case "R":
      return "git-status-rename";
    default:
      return "git-status-modify";
  }
};

const getStatusLabel = (status: string): string => {
  switch (status) {
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "U":
      return "U";
    case "R":
      return "R";
    case "C":
      return "C";
    default:
      return status;
  }
};

type GitTreeFolder = {
  name: string;
  path: string;
  children: GitTreeFolder[];
  file?: GitFileStatus;
};

const buildFileTree = (files: GitFileStatus[]): GitTreeFolder[] => {
  const root: GitTreeFolder = { name: "", path: "", children: [] };
  for (const file of files) {
    const segments = file.path.split(/[/\\]+/).filter(Boolean);
    let current = root;
    let acc = "";
    segments.forEach((segment, index) => {
      acc = acc ? `${acc}/${segment}` : segment;
      let child = current.children.find((node) => node.name === segment);
      if (!child) {
        child = { name: segment, path: acc, children: [] };
        current.children.push(child);
      }
      if (index === segments.length - 1) {
        child.file = file;
      }
      current = child;
    });
  }
  const sortNodes = (nodes: GitTreeFolder[]): void => {
    nodes.sort((a, b) => {
      const aIsFolder = a.file === undefined;
      const bIsFolder = b.file === undefined;
      if (aIsFolder !== bIsFolder) {
        return aIsFolder ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };
  sortNodes(root.children);
  return root.children;
};

const countTreeFiles = (node: GitTreeFolder): number => {
  if (node.file) {
    return 1;
  }
  return node.children.reduce((sum, child) => sum + countTreeFiles(child), 0);
};

type GitTreeRow =
  | { kind: "folder"; node: GitTreeFolder; depth: number; isExpanded: boolean }
  | { kind: "file"; file: GitFileStatus; depth: number };

const flattenTree = (
  nodes: GitTreeFolder[],
  collapsedDirs: Set<string>,
  depth = 0,
): GitTreeRow[] => {
  const rows: GitTreeRow[] = [];
  for (const node of nodes) {
    if (node.file) {
      rows.push({ kind: "file", file: node.file, depth });
      continue;
    }
    const isExpanded = !collapsedDirs.has(node.path);
    rows.push({ kind: "folder", node, depth, isExpanded });
    if (isExpanded) {
      rows.push(...flattenTree(node.children, collapsedDirs, depth + 1));
    }
  }
  return rows;
};

const INDENT_STEP = 14;
const INDENT_BASE = 12;
const treeIndent = (depth: number): React.CSSProperties | undefined =>
  depth > 0 ? { paddingLeft: INDENT_BASE + depth * INDENT_STEP } : undefined;

export const GitFileList = ({
  repoPath,
  files,
  section,
  selectedPaths,
  actionInProgress,
  viewMode = "list",
  onFileSelect,
  onFileActivate,
  onStageToggle,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
  onDiscard,
  onOpenFile,
  onOpenTerminal,
}: GitFileListProps): React.JSX.Element => {
  const { t } = useI18n();
  const isStaged = section === "staged";
  const headerLabel = isStaged ? t("git.stagedChanges") : t("git.changes");
  const headerCount = files.length;
  const fileTree = useMemo(() => buildFileTree(files), [files]);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const treeRows = useMemo(
    () => flattenTree(fileTree, collapsedDirs),
    [fileTree, collapsedDirs],
  );

  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: GitFileStatus;
  } | null>(null);
  // section 标题（变更 / 已暂存的变更）右键菜单：全部暂存 / 全部取消暂存。
  const [headerContextMenu, setHeaderContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  /** 将文件相对路径拼成仓库绝对路径（兼容 Windows 反斜杠与 SSH 仓库）。 */
  const resolveRepoPath = (dirPath: string): string => {
    const base = repoPath.replace(/[\\\\/]+$/, "");
    const sep = base.includes("\\\\") ? "\\\\" : "/";
    const dir = dirPath.replace(/[\\\\/]+$/, "");
    return dir ? `${base}${sep}${dir}` : base;
  };

  /** 将文件相对路径拼成仓库内的绝对文件路径（保持仓库分隔符风格）。 */
  const resolveRepoFilePath = (filePath: string): string => {
    const base = repoPath.replace(/[\\\\/]+$/, "");
    const sep = base.includes("\\\\") ? "\\\\" : "/";
    return `${base}${sep}${filePath}`;
  };

  /** 与行内按钮一致的多选语义：右键文件在选中集内时操作应用到全部选中。 */
  const getTargetFiles = (file: GitFileStatus): GitFileStatus[] => {
    if (selectedPaths.has(`${section}:${file.path}`)) {
      const selected = files.filter((f) =>
        selectedPaths.has(`${section}:${f.path}`),
      );
      return selected.length > 0 ? selected : [file];
    }
    return [file];
  };

  const buildMenuItems = (file: GitFileStatus): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    // 已删除（D）文件在磁盘上不存在，查看类操作不可用。
    const isDeleted = file.status === "D";
    if (onOpenFile) {
      items.push({
        id: "open",
        label: t("git.openFile"),
        icon: <FileText size={13} strokeWidth={1.8} />,
        disabled: isDeleted,
        onClick: () => {
          setContextMenu(null);
          onOpenFile(file);
        },
      });
    }
    items.push({
      id: "reveal",
      label: t("git.revealInExplorer", {
        defaultValue: "Show in Explorer",
      }),
      icon: <FolderOpen size={13} strokeWidth={1.8} />,
      disabled: isDeleted,
      onClick: () => {
        setContextMenu(null);
        void window.snow
          .showItemInFolder(resolveRepoFilePath(file.path))
          .catch(() => {
            // 打开文件管理器失败时静默忽略。
          });
      },
    });
    items.push({
      id: "stage-toggle",
      separator: true,
      label: isStaged ? t("git.unstageFile") : t("git.stageFile"),
      icon: isStaged ? (
        <FileMinus size={13} strokeWidth={1.8} />
      ) : (
        <Plus size={13} strokeWidth={1.8} />
      ),
      onClick: () => {
        setContextMenu(null);
        onStageToggle(getTargetFiles(file), section);
      },
    });
    if (!isStaged && onDiscard) {
      items.push({
        id: "discard",
        label: t("git.discardFile"),
        icon: <Undo2 size={13} strokeWidth={1.8} />,
        danger: true,
        onClick: () => {
          setContextMenu(null);
          onDiscard(getTargetFiles(file));
        },
      });
    }
    if (onOpenTerminal) {
      items.push({
        id: "open-terminal",
        separator: true,
        label: t("git.openInTerminal", {
          defaultValue: "Open in Terminal",
        }),
        icon: <TerminalIcon size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          const lastSep = Math.max(
            file.path.lastIndexOf("/"),
            file.path.lastIndexOf("\\\\"),
          );
          const dirPath = lastSep === -1 ? "" : file.path.slice(0, lastSep + 1);
          onOpenTerminal(resolveRepoPath(dirPath));
        },
      });
    }
    items.push({
      id: "copy-relative",
      separator: true,
      label: t("git.copyRelativePath", {
        defaultValue: "Copy Relative Path",
      }),
      icon: <Copy size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        void window.snow.writeClipboardText(file.path).catch(() => {
          // 剪贴板写入失败时静默忽略。
        });
      },
    });
    items.push({
      id: "copy-absolute",
      label: t("git.copyAbsolutePath", {
        defaultValue: "Copy Absolute Path",
      }),
      icon: <Copy size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        void window.snow
          .writeClipboardText(resolveRepoFilePath(file.path))
          .catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
      },
    });
    return items;
  };

  /** section 标题右键菜单：全部暂存 / 全部取消暂存（与标题栏按钮一致）。 */
  const buildHeaderMenuItems = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (isStaged) {
      items.push({
        id: "unstage-all",
        label: t("git.unstageAll"),
        icon: <FileMinus size={13} strokeWidth={1.8} />,
        onClick: () => {
          setHeaderContextMenu(null);
          onUnstageAll?.();
        },
      });
    } else {
      items.push({
        id: "stage-all",
        label: t("git.stageAll"),
        icon: <Plus size={13} strokeWidth={1.8} />,
        onClick: () => {
          setHeaderContextMenu(null);
          onStageAll?.();
        },
      });
      if (onDiscardAll) {
        items.push({
          id: "discard-all",
          label: t("git.discardAll"),
          icon: <Undo2 size={13} strokeWidth={1.8} />,
          danger: true,
          onClick: () => {
            const point = headerContextMenu;
            setHeaderContextMenu(null);
            onDiscardAll({
              left: point?.x ?? 0,
              right: point?.x ?? 0,
              bottom: point?.y ?? 0,
            });
          },
        });
      }
    }
    return items;
  };

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(`git-collapse-${section}`) === "true";
    } catch {
      return false;
    }
  });

  const toggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(`git-collapse-${section}`, String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const handleFileDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, file: GitFileStatus) => {
      const tag = {
        repoPath,
        path: file.path,
        section,
        status: file.status,
      };
      event.dataTransfer.setData("application/json", JSON.stringify(tag));
      event.dataTransfer.effectAllowed = "copy";
    },
    [repoPath, section],
  );

  const renderFileItem = (
    file: GitFileStatus,
    depth: number,
  ): React.JSX.Element => {
    const isSelected = selectedPaths.has(`${section}:${file.path}`);
    const lastSep = Math.max(
      file.path.lastIndexOf("/"),
      file.path.lastIndexOf("\\"),
    );
    const fileName = lastSep === -1 ? file.path : file.path.slice(lastSep + 1);
    const dirPath = lastSep === -1 ? "" : file.path.slice(0, lastSep + 1);
    return (
      <div
        key={`${section}-${file.path}`}
        className={`git-file-item${isSelected ? " selected" : ""}`}
        tabIndex={-1}
        style={treeIndent(depth)}
        onClick={(e) => onFileSelect(file, e, section)}
        onDoubleClick={() => onFileActivate(file, section)}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, file });
        }}
        draggable
        onDragStart={(event) => handleFileDragStart(event, file)}
      >
        <span className={`git-file-status ${getStatusColor(file.status)}`}>
          {getStatusLabel(file.status)}
        </span>
        <span
          className={`git-file-name${file.status === "D" ? " deleted" : ""}`}
          title={file.path}
        >
          {getFileTypeIcon(
            file.path.split("/").pop() ?? file.path,
            false,
            false,
            { size: 13, className: "git-file-type-icon" },
          )}
          <span className="git-file-name-text">{fileName}</span>
          {dirPath && viewMode === "list" && (
            <span className="git-file-path">{dirPath}</span>
          )}
        </span>
        <button
          type="button"
          className="git-file-action"
          onClick={(e) => {
            e.stopPropagation();
            const filesToToggle = isSelected
              ? files.filter((f) => selectedPaths.has(`${section}:${f.path}`))
              : [file];
            onStageToggle(filesToToggle, section);
          }}
          disabled={actionInProgress !== null}
          title={isStaged ? t("git.unstageFile") : t("git.stageFile")}
        >
          <span>{isStaged ? "-" : "+"}</span>
        </button>
        {!isStaged && onDiscard && (
          <button
            type="button"
            className="git-file-action git-discard-action"
            onClick={(e) => {
              e.stopPropagation();
              const filesToDiscard = isSelected
                ? files.filter((f) => selectedPaths.has(`${section}:${f.path}`))
                : [file];
              onDiscard(filesToDiscard);
            }}
            disabled={actionInProgress !== null}
            title={t("git.discardFile")}
          >
            <Undo2 size={12} strokeWidth={1.8} />
          </button>
        )}
        {onOpenFile && (
          <button
            type="button"
            className="git-file-action git-open-action"
            onClick={(e) => {
              e.stopPropagation();
              onOpenFile(file);
            }}
            disabled={actionInProgress !== null}
            title={t("git.openFile")}
          >
            <FileText size={12} strokeWidth={1.8} />
          </button>
        )}
      </div>
    );
  };

  const renderFolderRow = (row: {
    node: GitTreeFolder;
    depth: number;
    isExpanded: boolean;
  }): React.JSX.Element => {
    const { node, depth, isExpanded } = row;
    return (
      <div
        className="git-file-item git-tree-folder-row"
        key={`dir-${node.path}`}
        style={treeIndent(depth)}
        onClick={() => toggleDir(node.path)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleDir(node.path);
          }
        }}
        title={node.path}
      >
        <span className="git-tree-chevron">
          {isExpanded ? (
            <ChevronDown size={13} strokeWidth={1.8} />
          ) : (
            <ChevronRight size={13} strokeWidth={1.8} />
          )}
        </span>
        {getFileTypeIcon(node.name, true, isExpanded, {
          size: 13,
          className: "git-file-type-icon",
        })}
        <span className="git-file-name">
          <span className="git-file-name-text">{node.name}</span>
        </span>
        <span className="git-tree-folder-count">{countTreeFiles(node)}</span>
      </div>
    );
  };

  const renderTreeRow = (row: GitTreeRow): React.JSX.Element =>
    row.kind === "folder"
      ? renderFolderRow(row)
      : renderFileItem(row.file, row.depth);

  return (
    <div className="git-file-list">
      <div className="git-file-list-header">
        <div
          className="git-file-list-title"
          onClick={toggleCollapse}
          onContextMenu={(e) => {
            if (headerCount === 0) {
              return;
            }
            e.preventDefault();
            setHeaderContextMenu({ x: e.clientX, y: e.clientY });
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleCollapse();
            }
          }}
          title={collapsed ? t("git.expandSection") : t("git.collapseSection")}
        >
          <ChevronDown
            size={14}
            strokeWidth={1.8}
            className={`git-file-list-chevron${collapsed ? " collapsed" : ""}`}
          />
          <span className="git-file-list-label">{headerLabel}</span>
          {headerCount > 0 && (
            <span className="git-file-list-badge">{headerCount}</span>
          )}
        </div>
        <div className="git-file-list-actions">
          {isStaged
            ? headerCount > 0 && (
                <button
                  type="button"
                  className="git-file-list-action"
                  onClick={onUnstageAll}
                  disabled={actionInProgress !== null}
                  title={t("git.unstageAll")}
                >
                  <span>{"-"}</span>
                </button>
              )
            : headerCount > 0 && (
                <>
                  <button
                    type="button"
                    className="git-file-list-action"
                    onClick={onStageAll}
                    disabled={actionInProgress !== null}
                    title={t("git.stageAll")}
                  >
                    <Plus size={13} strokeWidth={1.8} />
                  </button>
                  {onDiscardAll && (
                    <button
                      type="button"
                      className="git-file-list-action danger"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        onDiscardAll({
                          left: rect.left,
                          right: rect.right,
                          bottom: rect.bottom,
                        });
                      }}
                      disabled={actionInProgress !== null}
                      title={t("git.discardAll")}
                    >
                      <Undo2 size={13} strokeWidth={1.8} />
                    </button>
                  )}
                </>
              )}
        </div>
      </div>
      <div className={`git-file-list-body${collapsed ? " collapsed" : ""}`}>
        <div className="git-file-list-body-inner">
          {files.length === 0 ? (
            <div className="git-file-list-empty">
              {isStaged ? t("git.noStagedChanges") : t("git.noChanges")}
            </div>
          ) : (
            <div className="git-file-list-items">
              {viewMode === "tree"
                ? treeRows.map((row) => renderTreeRow(row))
                : files.map((file) => renderFileItem(file, 0))}
            </div>
          )}
        </div>
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems(contextMenu.file)}
          onClose={() => setContextMenu(null)}
        />
      )}
      {headerContextMenu && (
        <ContextMenu
          x={headerContextMenu.x}
          y={headerContextMenu.y}
          items={buildHeaderMenuItems()}
          onClose={() => setHeaderContextMenu(null)}
        />
      )}
    </div>
  );
};
