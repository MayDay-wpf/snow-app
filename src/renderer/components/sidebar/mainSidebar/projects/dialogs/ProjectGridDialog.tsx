import {
  Check,
  GripVertical,
  Library,
  Link2,
  Link2Off,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";

import { useI18n } from "../../../../../i18n";
import { getFileTypeIcon } from "../../../../../utils/fileIcons";
import { useSshConnectionStatus } from "../../../../../ssh/sshConnectionStore";
import type {
  ProjectCollectionRecord,
  WorkspaceDirectoryRecord,
} from "../../../../../../preload";
import { FormDialog } from "../../../../common/FormDialog";
import { Tooltip } from "../../../../common/Tooltip";
import { buildDirectoryDisplayNames } from "../../directoryDisplayName";
import { getDirectoryIcon } from "../../WorkspaceDirectoryRow";
import type { DirectoryDragDropController } from "../useDirectoryDragDrop";

type ProjectGridDialogProps = {
  activeDirectoryId?: string;
  collections: ProjectCollectionRecord[];
  dragAndDrop: DirectoryDragDropController;
  isActionLocked: boolean;
  onActivate: (directoryId: string) => void;
  onClose: () => void;
  open: boolean;
  workspaceDirectories: WorkspaceDirectoryRecord[];
};

type ProjectGridGroup = {
  /** null 表示未入合集的顶层项目分组 */
  collection: ProjectCollectionRecord | null;
  directories: WorkspaceDirectoryRecord[];
};

/** 项目网格卡片里的 SSH 图标：订阅连接状态，配色与目录行一致。 */
function ProjectGridSshIcon({
  directory,
}: {
  directory: WorkspaceDirectoryRecord;
}): React.JSX.Element {
  return getDirectoryIcon(directory, {
    sshStatus: useSshConnectionStatus(directory),
    sshIconSize: 16,
  });
}

export function ProjectGridDialog({
  activeDirectoryId,
  collections,
  dragAndDrop,
  isActionLocked,
  onActivate,
  onClose,
  open,
  workspaceDirectories,
}: ProjectGridDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 每次打开重置搜索词，避免上次的过滤条件残留
  useEffect(() => {
    if (open) {
      setQuery("");
    }
  }, [open]);

  const displayNames = useMemo(
    () => buildDirectoryDisplayNames(workspaceDirectories),
    [workspaceDirectories],
  );

  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const directoryById = new Map(
      workspaceDirectories.map((directory) => [
        directory.directoryId,
        directory,
      ]),
    );

    const matches = (directory: WorkspaceDirectoryRecord): boolean => {
      if (!normalizedQuery) {
        return true;
      }
      const displayName =
        displayNames.get(directory.directoryId) ?? directory.name;
      return (
        directory.name.toLowerCase().includes(normalizedQuery) ||
        displayName.toLowerCase().includes(normalizedQuery) ||
        directory.path.toLowerCase().includes(normalizedQuery)
      );
    };

    const memberIds = new Set<string>();
    const collectionGroups: ProjectGridGroup[] = collections.map(
      (collection) => {
        const directories: WorkspaceDirectoryRecord[] = [];
        for (const directoryId of collection.memberDirectoryIds) {
          memberIds.add(directoryId);
          const directory = directoryById.get(directoryId);
          if (directory && matches(directory)) {
            directories.push(directory);
          }
        }
        return { collection, directories };
      },
    );

    // 顶层项目 = 全部项目 - 已入合集项目，与侧边栏层级保持一致
    const topLevelDirectories = workspaceDirectories.filter(
      (directory) =>
        !memberIds.has(directory.directoryId) && matches(directory),
    );

    if (normalizedQuery) {
      const result = collectionGroups.filter(
        (group) => group.directories.length > 0,
      );
      if (topLevelDirectories.length > 0) {
        result.push({ collection: null, directories: topLevelDirectories });
      }
      return result;
    }

    return [
      ...collectionGroups,
      { collection: null, directories: topLevelDirectories },
    ];
  }, [collections, displayNames, query, workspaceDirectories]);

  const matchedCount = groups.reduce(
    (total, group) => total + group.directories.length,
    0,
  );
  const isEmptyWorkspace = workspaceDirectories.length === 0;
  const hasCollectionGroups = groups.some((group) => group.collection !== null);

  const isDragEnabled = !isActionLocked && query.trim().length === 0;
  const draggedDirectoryId = dragAndDrop.draggedDirectoryId;
  const dragOverDirectoryId = dragAndDrop.dragOverDirectoryId;

  const collectionMemberInfo = useMemo(() => {
    const info = new Map<string, { color: string; linked: boolean }>();
    for (const collection of collections) {
      for (const directoryId of collection.memberDirectoryIds) {
        info.set(directoryId, {
          color: collection.color,
          linked: collection.linkedDirectoryIds.includes(directoryId),
        });
      }
    }
    return info;
  }, [collections]);

  const resolveDraggedId = (event: DragEvent<HTMLElement>): string | null =>
    draggedDirectoryId || event.dataTransfer.getData("text/plain") || null;

  const handleCardDragStart = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string,
  ): void => {
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", directoryId);
    dragAndDrop.handleDirectoryDragStart(directoryId);
  };

  const handleCardDragOver = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string,
  ): void => {
    if (!isDragEnabled || draggedDirectoryId === directoryId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    dragAndDrop.handleDirectoryDragOver(directoryId);
  };

  const handleCardDrop = (
    event: DragEvent<HTMLDivElement>,
    group: ProjectGridGroup,
    targetDirectoryId: string,
  ): void => {
    event.preventDefault();
    const sourceId = resolveDraggedId(event);
    if (!sourceId || sourceId === targetDirectoryId) {
      dragAndDrop.handleDirectoryDragEnd();
      return;
    }
    if (group.collection) {
      dragAndDrop.handleCollectionMemberDrop(
        group.collection.collectionId,
        targetDirectoryId,
        event.dataTransfer,
      );
      return;
    }
    dragAndDrop.handleDirectoryDrop(targetDirectoryId, event.dataTransfer);
  };

  const handleCollectionGroupDragOver = (
    event: DragEvent<HTMLDivElement>,
    collectionId: string,
  ): void => {
    if (event.defaultPrevented || !isDragEnabled || !draggedDirectoryId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dragAndDrop.handleCollectionDragOver(collectionId);
  };

  const handleCollectionGroupDrop = (
    event: DragEvent<HTMLDivElement>,
    collectionId: string,
  ): void => {
    if (event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    const sourceId = resolveDraggedId(event);
    if (!sourceId) {
      dragAndDrop.handleDirectoryDragEnd();
      return;
    }
    dragAndDrop.handleCollectionDrop(collectionId, sourceId);
  };

  const handleUngroupedDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || !isDragEnabled || !draggedDirectoryId) {
      return;
    }
    if (!collectionMemberInfo.has(draggedDirectoryId)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleUngroupedDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    const sourceId = resolveDraggedId(event);
    if (!sourceId) {
      dragAndDrop.handleDirectoryDragEnd();
      return;
    }
    dragAndDrop.handleDropOutside(sourceId);
  };

  const renderCard = (
    group: ProjectGridGroup,
    directory: WorkspaceDirectoryRecord,
  ): React.JSX.Element => {
    const isActive = directory.directoryId === activeDirectoryId;
    const displayName =
      displayNames.get(directory.directoryId) ?? directory.name;
    const memberInfo = group.collection
      ? collectionMemberInfo.get(directory.directoryId)
      : undefined;
    const isDragging = draggedDirectoryId === directory.directoryId;
    const isDragOver =
      !isDragging && dragOverDirectoryId === directory.directoryId;
    return (
      <div
        className={`project-grid-card-slot${isDragging ? " dragging" : ""}${
          isDragOver ? " drag-over" : ""
        }`}
        draggable={isDragEnabled}
        key={directory.directoryId}
        onDragEnd={dragAndDrop.handleDirectoryDragEnd}
        onDragOver={(event) => handleCardDragOver(event, directory.directoryId)}
        onDragStart={(event) =>
          handleCardDragStart(event, directory.directoryId)
        }
        onDrop={(event) => handleCardDrop(event, group, directory.directoryId)}
      >
        <button
          className={`project-grid-card${isActive ? " active" : ""}${
            memberInfo && !memberInfo.linked ? " unlinked" : ""
          }`}
          disabled={isActionLocked}
          onClick={() => onActivate(directory.directoryId)}
          title={directory.path}
          type="button"
        >
          {memberInfo ? (
            memberInfo.linked ? (
              <Tooltip
                content={t("sidebar.collectionLinkTitle", {
                  values: { name: group.collection?.name ?? "" },
                  defaultValue: "Linked project group: {{name}}",
                })}
                placement="top"
              >
                <span
                  aria-hidden="true"
                  className="project-grid-card-link-mark"
                  style={{ color: memberInfo.color }}
                >
                  <Link2 size={12} />
                </span>
              </Tooltip>
            ) : (
              <Tooltip
                content={t("sidebar.projectGridMemberUnlinked", {
                  defaultValue: "Unlinked — kept in the collection only",
                })}
                placement="top"
              >
                <span
                  aria-label={t("sidebar.projectGridMemberUnlinked", {
                    defaultValue: "Unlinked — kept in the collection only",
                  })}
                  className="project-grid-card-unlinked-mark"
                  role="img"
                >
                  <Link2Off size={12} />
                </span>
              </Tooltip>
            )
          ) : null}
          <span className="project-grid-card-icon">
            {directory.kind === "ssh" ? (
              <ProjectGridSshIcon directory={directory} />
            ) : (
              getFileTypeIcon(directory.name, true, directory.isActive, {
                size: 16,
              })
            )}
          </span>
          <span className="project-grid-card-body">
            <span className="project-grid-card-name">{displayName}</span>
            <span className="project-grid-card-path">{directory.path}</span>
          </span>
          {isDragEnabled ? (
            <span
              aria-label={t("sidebar.dragDirectory", {
                defaultValue: "Drag to reorder",
              })}
              className="project-grid-card-grip"
              role="img"
            >
              <GripVertical size={13} />
            </span>
          ) : null}
          {isActive ? (
            <Check className="project-grid-card-check" size={14} />
          ) : null}
        </button>
      </div>
    );
  };

  return (
    <FormDialog
      cardClassName="project-grid-dialog-card"
      closeLabel={t("sidebar.close", { defaultValue: "Close" })}
      initialFocusRef={searchInputRef}
      onCancel={onClose}
      open={open}
      showFooter={false}
      title={t("sidebar.projects", { defaultValue: "Projects" })}
    >
      <div className="project-grid-dialog">
        <div className="project-grid-search">
          <Search className="project-grid-search-icon" size={14} />
          <input
            aria-label={t("sidebar.searchProjects", {
              defaultValue: "Search projects",
            })}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("sidebar.searchProjects", {
              defaultValue: "Search projects",
            })}
            ref={searchInputRef}
            type="text"
            value={query}
          />
          {query ? (
            <button
              aria-label={t("sidebar.clearProjectSearch", {
                defaultValue: "Clear search",
              })}
              className="project-grid-search-clear"
              onClick={() => {
                setQuery("");
                searchInputRef.current?.focus();
              }}
              title={t("sidebar.clearProjectSearch", {
                defaultValue: "Clear search",
              })}
              type="button"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
        <div className="project-grid-scroll">
          {isEmptyWorkspace || matchedCount === 0 ? (
            <div className="project-grid-empty">
              {isEmptyWorkspace
                ? t("sidebar.noDirectories", {
                    defaultValue: "No directories",
                  })
                : t("sidebar.projectGridNoMatch", {
                    defaultValue: "No matching projects",
                  })}
            </div>
          ) : (
            groups.map((group) => {
              const collectionId = group.collection?.collectionId ?? null;
              const isGroupDragOver =
                collectionId !== null &&
                dragAndDrop.dragOverCollectionId === collectionId;
              const isDropOutTarget =
                collectionId === null &&
                isDragEnabled &&
                draggedDirectoryId !== null &&
                collectionMemberInfo.has(draggedDirectoryId);
              return (
                <div
                  className={`project-grid-group${
                    isGroupDragOver ? " drag-over" : ""
                  }${isDropOutTarget ? " drop-out-target" : ""}`}
                  key={collectionId ?? "__top-level__"}
                  onDragOver={
                    collectionId
                      ? (event) =>
                          handleCollectionGroupDragOver(event, collectionId)
                      : handleUngroupedDragOver
                  }
                  onDrop={
                    collectionId
                      ? (event) =>
                          handleCollectionGroupDrop(event, collectionId)
                      : handleUngroupedDrop
                  }
                >
                  {group.collection ? (
                    <div className="project-grid-group-header">
                      <Library
                        className="list-icon list-icon--collection"
                        size={13}
                      />
                      <span
                        aria-hidden="true"
                        className="project-collection-dot"
                        style={{ background: group.collection.color }}
                      />
                      <span className="project-grid-group-name">
                        {group.collection.name}
                      </span>
                      <span className="project-grid-group-count">
                        {group.directories.length}
                      </span>
                    </div>
                  ) : hasCollectionGroups ? (
                    <div className="project-grid-group-header">
                      <span className="project-grid-group-name">
                        {t("sidebar.projectGridUngrouped", {
                          defaultValue: "Ungrouped projects",
                        })}
                      </span>
                    </div>
                  ) : null}
                  <div className="project-grid-cards">
                    {group.directories.map((directory) =>
                      renderCard(group, directory),
                    )}
                  </div>
                  {group.directories.length === 0 ? (
                    <div className="project-grid-drop-hint">
                      {collectionId
                        ? t("sidebar.collectionEmpty", {
                            defaultValue:
                              "No projects yet — drag one here to add it",
                          })
                        : t("sidebar.projectGridUngroupedEmpty", {
                            defaultValue:
                              "No ungrouped projects — drop one here to move it out of its collection",
                          })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </FormDialog>
  );
}
