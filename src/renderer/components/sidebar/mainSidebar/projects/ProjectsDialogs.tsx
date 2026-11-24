import { useMemo } from "react";

import { useI18n } from "../../../../i18n";
import { ConfirmDialog } from "../../../common/ConfirmDialog";
import { MigrateDirectoryDialog } from "../MigrateDirectoryDialog";
import { RelinkDirectoryDialog } from "../RelinkDirectoryDialog";
import { AddDirectoryMenuDialog } from "./dialogs/AddDirectoryMenuDialog";
import { AddLocalDirectoryDialog } from "./dialogs/AddLocalDirectoryDialog";
import { CloneRepositoryDialog } from "./dialogs/CloneRepositoryDialog";
import { CreateCollectionDialog } from "./dialogs/CreateCollectionDialog";
import { CreateProjectDialog } from "./dialogs/CreateProjectDialog";
import { LinkProjectsDialog } from "./dialogs/LinkProjectsDialog";
import { ProjectGridDialog } from "./dialogs/ProjectGridDialog";
import { RenameCollectionDialog } from "./dialogs/RenameCollectionDialog";
import type { ProjectsWorkspace } from "./useProjectsWorkspace";

type ProjectsDialogsProps = {
  workspace: ProjectsWorkspace;
};

export function ProjectsDialogs({
  workspace,
}: ProjectsDialogsProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    workspaceDirectories,
    addFlow,
    collections,
    dragAndDrop,
    deleteCollectionTarget,
    setDeleteCollectionTarget,
    confirmDeleteCollection,
    isSavingDirectory,
    isReorderingDirectories,
    isSwitchingDirectory,
    directoryError,
    activeDirectory,
    handleActivateDirectory,
    relinkTarget,
    setRelinkTarget,
    historyTarget,
    setHistoryTarget,
    handleRelinked,
    handleRelinkUndone,
    handleMigrated,
    isProjectGridOpen,
    setIsProjectGridOpen,
  } = workspace;

  const linkProjectsCandidates = useMemo(
    () =>
      workspaceDirectories.filter(
        (directory) =>
          directory.directoryId !== addFlow.linkProjectsSource?.directoryId,
      ),
    [addFlow.linkProjectsSource?.directoryId, workspaceDirectories],
  );

  const isActionLocked =
    isSavingDirectory || isReorderingDirectories || isSwitchingDirectory;

  return (
    <>
      <AddDirectoryMenuDialog
        onAddLocalDirectory={() =>
          addFlow.handleAddDirectoryModeSelect("local")
        }
        onAddSshDirectory={() => addFlow.handleAddDirectoryModeSelect("ssh")}
        onCloneRepository={addFlow.handleCloneRepoModeOpen}
        onClose={addFlow.closeAddMenu}
        onCreateCollection={addFlow.handleCreateCollectionModeOpen}
        onCreateProject={addFlow.handleCreateProjectModeOpen}
        open={addFlow.isAddMenuOpen}
        showCreateCollection={addFlow.collectionAddTargetId === null}
      />

      <CreateProjectDialog
        error={directoryError}
        isSubmitting={isSavingDirectory}
        name={addFlow.projectNameInput}
        onCancel={addFlow.handleCreateProjectCancel}
        onConfirm={() => void addFlow.handleCreateProjectConfirm()}
        onNameChange={addFlow.setProjectNameInput}
        open={addFlow.isCreateProjectOpen}
      />

      <CreateCollectionDialog
        error={directoryError}
        isSubmitting={isSavingDirectory}
        name={addFlow.createCollectionName}
        onCancel={addFlow.handleCreateCollectionCancel}
        onConfirm={() => void addFlow.handleCreateCollectionConfirm()}
        onNameChange={addFlow.setCreateCollectionName}
        open={addFlow.isCreateCollectionOpen}
      />

      <RenameCollectionDialog
        color={addFlow.renameCollectionColor}
        error={directoryError}
        isSubmitting={isSavingDirectory}
        name={addFlow.renameCollectionName}
        onCancel={addFlow.handleRenameCollectionCancel}
        onColorChange={addFlow.setRenameCollectionColor}
        onConfirm={() => void addFlow.handleRenameCollectionConfirm()}
        onNameChange={addFlow.setRenameCollectionName}
        open={addFlow.isRenameCollectionOpen}
      />

      <LinkProjectsDialog
        directories={linkProjectsCandidates}
        error={directoryError}
        isSubmitting={isSavingDirectory}
        name={addFlow.linkProjectsName}
        onCancel={addFlow.handleLinkProjectsCancel}
        onConfirm={() => void addFlow.handleLinkProjectsConfirm()}
        onNameChange={addFlow.setLinkProjectsName}
        onToggleDirectory={addFlow.handleLinkProjectsToggle}
        open={addFlow.isLinkProjectsOpen}
        selectedDirectoryIds={addFlow.linkProjectsSelection}
        sourceDirectory={addFlow.linkProjectsSource}
      />

      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("sidebar.deleteCollection", {
          defaultValue: "Delete",
        })}
        isConfirming={isSavingDirectory}
        message={t("sidebar.deleteCollectionConfirm", {
          defaultValue:
            "Are you sure you want to delete this collection? Projects inside it are not affected.",
        })}
        onCancel={() => setDeleteCollectionTarget(null)}
        onConfirm={() => void confirmDeleteCollection()}
        open={deleteCollectionTarget !== null}
        title={t("sidebar.deleteCollectionTitle", {
          defaultValue: "Delete collection",
        })}
        variant="danger"
      />

      <AddLocalDirectoryDialog
        error={directoryError}
        isDragging={addFlow.isDraggingLocalDirectory}
        isSubmitting={isSavingDirectory}
        onCancel={addFlow.handleAddLocalDirectoryCancel}
        onConfirm={() => void addFlow.handleAddLocalDirectoryConfirm()}
        onDragStateChange={addFlow.setIsDraggingLocalDirectory}
        onDropFiles={(files) => void addFlow.handleLocalDirectoryDrop(files)}
        onSelectFolder={() => void addFlow.handleSelectLocalDirectory()}
        open={addFlow.isAddLocalDialogOpen}
        path={addFlow.selectedLocalPath}
      />

      <CloneRepositoryDialog
        error={addFlow.cloneError}
        isAborting={addFlow.isCloneAborting}
        isSubmitting={addFlow.isCloneSubmitting}
        onAbort={addFlow.handleAbortActiveClone}
        onCancel={addFlow.handleCloneRepoCancel}
        onConfirm={() => void addFlow.handleCloneRepoConfirm()}
        onRepoUrlChange={addFlow.setCloneRepoUrl}
        onSelectFolder={() => void addFlow.handleSelectCloneDirectory()}
        open={addFlow.isCloneRepoOpen}
        parentPath={addFlow.cloneParentPath}
        progress={addFlow.cloneProgress}
        repoUrl={addFlow.cloneRepoUrl}
        targetPreview={addFlow.cloneTargetPreview}
      />

      <RelinkDirectoryDialog
        directory={relinkTarget}
        onCancel={() => setRelinkTarget(null)}
        onRelinked={handleRelinked}
      />

      <MigrateDirectoryDialog
        directory={historyTarget}
        onCancel={() => setHistoryTarget(null)}
        onMigrated={handleMigrated}
        onUndone={handleRelinkUndone}
      />

      <ProjectGridDialog
        activeDirectoryId={activeDirectory?.directoryId}
        collections={collections}
        dragAndDrop={dragAndDrop}
        isActionLocked={isActionLocked}
        onActivate={(directoryId) => {
          void handleActivateDirectory(directoryId);
          if (directoryId !== activeDirectory?.directoryId) {
            setIsProjectGridOpen(false);
          }
        }}
        onClose={() => setIsProjectGridOpen(false)}
        open={isProjectGridOpen}
        workspaceDirectories={workspaceDirectories}
      />
    </>
  );
}
