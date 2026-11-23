import { GitBranch } from "lucide-react";
import { BranchSelector } from "../rightPanel/git/BranchSelector";
import { useConversationGitWorkspace } from "../rightPanel/git/useConversationGitWorkspace";
import { useGitStatus } from "../rightPanel/git/useGitStatus";

type TopBarBranchSelectorProps = {
  /** 当前工作区目录路径；为 git 仓库时展示分支切换下拉。 */
  repoPath?: string | null;
  /** 当前工作区目录 ID，用于加载独立工作树。 */
  directoryId?: string | null;
  /** 非 git 仓库（或状态未就绪）时回退展示的工作区名称。 */
  fallbackName?: string;
  /** 在指定路径打开终端。 */
  onOpenTerminal?: (cwd: string) => void;
  /** 右面板收起时为 true：下拉层附带「变更」Tab */
  showChangesTab?: boolean;
};

export const TopBarBranchSelector = ({
  repoPath,
  directoryId,
  fallbackName,
  onOpenTerminal,
  showChangesTab,
}: TopBarBranchSelectorProps): React.JSX.Element | null => {
  const workspace = useConversationGitWorkspace(repoPath, directoryId);
  const { status, refresh } = useGitStatus(workspace.workspacePath);

  if (workspace.workspacePath && status?.isRepo) {
    return (
      <BranchSelector
        repoPath={workspace.workspacePath}
        currentBranch={status.currentBranch}
        directoryId={workspace.directoryId}
        onOpenTerminal={onOpenTerminal}
        showChangesTab={showChangesTab}
        changesCount={status.files.length}
        onBranchChanged={() => {
          void refresh();
        }}
      />
    );
  }

  if (!fallbackName) {
    return null;
  }

  return (
    <span className="top-bar-branch-label" title={fallbackName}>
      <GitBranch size={13} strokeWidth={1.8} />
      <span>{fallbackName}</span>
    </span>
  );
};
