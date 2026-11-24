import { useCallback, useMemo, useState } from "react";

import type { WorkspaceDirectoryRecord } from "../../../../../preload";
import { useChatConversationContext } from "../../../mainContent/chatMessages";
import { useDirectoryDragDrop } from "./useDirectoryDragDrop";
import { useProjectAddFlow } from "./useProjectAddFlow";
import { useProjectCollections } from "./useProjectCollections";
import { useWorkspaceDirectories } from "./useWorkspaceDirectories";

type UseProjectsWorkspaceOptions = {
  externalActiveDirectory?: WorkspaceDirectoryRecord | null;
  onActiveDirectoryChange?: (
    directory: WorkspaceDirectoryRecord | null,
  ) => void;
  onSwitchingDirectoryChange: (isSwitchingDirectory: boolean) => void;
  onOpenSshWizard?: () => void;
};

export function useProjectsWorkspace({
  externalActiveDirectory,
  onActiveDirectoryChange,
  onSwitchingDirectoryChange,
  onOpenSshWizard,
}: UseProjectsWorkspaceOptions) {
  const { activeConversationId } = useChatConversationContext();

  const directories = useWorkspaceDirectories({
    externalActiveDirectory,
    onActiveDirectoryChange,
    onSwitchingDirectoryChange,
  });
  const {
    workspaceDirectories,
    setWorkspaceDirectories,
    activeDirectory,
    isLoadingDirectories,
    isSavingDirectory,
    setIsSavingDirectory,
    isReorderingDirectories,
    isSwitchingDirectory,
    directoryError,
    setDirectoryError,
    relinkTarget,
    setRelinkTarget,
    historyTarget,
    setHistoryTarget,
    loadWorkspaceDirectories,
    persistWorkspaceDirectory,
    persistWorkspaceDirectoryOrder,
    handleActivateDirectory,
    handleDeleteDirectory,
    handleRenameDirectory,
    handleShowRelinkHistory,
  } = directories;

  const collectionsApi = useProjectCollections({
    activeDirectoryId: activeDirectory?.directoryId,
    setDirectoryError,
    setIsSavingDirectory,
  });
  const {
    collections,
    setCollections,
    collectionMemberIds,
    expandedCollectionIds,
    handleToggleCollectionExpanded,
    deleteCollectionTarget,
    setDeleteCollectionTarget,
    loadProjectCollections,
    createCollection,
    updateCollectionColor,
    addProjectToCollection,
    setMemberLinked,
    renameCollection,
    confirmDeleteCollection,
    removeProjectFromCollection,
  } = collectionsApi;

  const addFlow = useProjectAddFlow({
    workspaceDirectories,
    setWorkspaceDirectories,
    persistWorkspaceDirectory,
    createCollection,
    updateCollectionColor,
    renameCollection,
    addProjectToCollection,
    setIsSavingDirectory,
    setDirectoryError,
    onOpenSshWizard,
  });

  const topLevelDirectories = useMemo(
    () =>
      workspaceDirectories.filter(
        (directory) => !collectionMemberIds.has(directory.directoryId),
      ),
    [collectionMemberIds, workspaceDirectories],
  );

  const dragAndDrop = useDirectoryDragDrop({
    workspaceDirectories,
    setWorkspaceDirectories,
    collections,
    setCollections,
    collectionMemberIds,
    setIsSavingDirectory,
    setDirectoryError,
    persistWorkspaceDirectoryOrder,
  });

  const [isProjectGridOpen, setIsProjectGridOpen] = useState(false);

  const isAddDialogsOpen =
    addFlow.isCreateProjectOpen ||
    addFlow.isAddLocalDialogOpen ||
    addFlow.isCloneRepoOpen ||
    addFlow.isCreateCollectionOpen ||
    addFlow.isRenameCollectionOpen ||
    addFlow.isLinkProjectsOpen;

  const openLinkProjects = useCallback(
    (directoryId: string): void => {
      const directory = workspaceDirectories.find(
        (item) => item.directoryId === directoryId,
      );
      if (!directory) {
        return;
      }
      addFlow.handleLinkProjectsOpen(directory);
    },
    [addFlow, workspaceDirectories],
  );

  const handleRelinked = useCallback((): void => {
    setRelinkTarget(null);
    setDirectoryError(null);
    void loadWorkspaceDirectories();
    void loadProjectCollections();
  }, [
    loadProjectCollections,
    loadWorkspaceDirectories,
    setDirectoryError,
    setRelinkTarget,
  ]);

  const handleRelinkUndone = useCallback((): void => {
    void loadWorkspaceDirectories();
    void loadProjectCollections();
  }, [loadProjectCollections, loadWorkspaceDirectories]);

  const handleMigrated = useCallback((): void => {
    setHistoryTarget(null);
    setDirectoryError(null);
    void loadWorkspaceDirectories();
    void loadProjectCollections();
  }, [
    loadProjectCollections,
    loadWorkspaceDirectories,
    setDirectoryError,
    setHistoryTarget,
  ]);

  const isActionLocked =
    isSavingDirectory || isReorderingDirectories || isSwitchingDirectory;

  return {
    activeDirectory,
    activeConversationId,
    workspaceDirectories,
    setWorkspaceDirectories,
    isLoadingDirectories,
    isSavingDirectory,
    setIsSavingDirectory,
    isReorderingDirectories,
    isSwitchingDirectory,
    isActionLocked,
    directoryError,
    setDirectoryError,
    relinkTarget,
    setRelinkTarget,
    historyTarget,
    setHistoryTarget,
    loadWorkspaceDirectories,
    persistWorkspaceDirectory,
    persistWorkspaceDirectoryOrder,
    handleActivateDirectory,
    handleDeleteDirectory,
    handleRenameDirectory,
    handleShowRelinkHistory,
    collections,
    setCollections,
    collectionMemberIds,
    expandedCollectionIds,
    handleToggleCollectionExpanded,
    deleteCollectionTarget,
    setDeleteCollectionTarget,
    loadProjectCollections,
    createCollection,
    updateCollectionColor,
    addProjectToCollection,
    setMemberLinked,
    renameCollection,
    confirmDeleteCollection,
    removeProjectFromCollection,
    addFlow,
    dragAndDrop,
    topLevelDirectories,
    isProjectGridOpen,
    setIsProjectGridOpen,
    isAddDialogsOpen,
    openLinkProjects,
    handleRelinked,
    handleRelinkUndone,
    handleMigrated,
  };
}

export type ProjectsWorkspace = ReturnType<typeof useProjectsWorkspace>;
