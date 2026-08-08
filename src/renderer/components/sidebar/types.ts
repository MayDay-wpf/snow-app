import type { MainContentView } from "../mainContent/types";
import type { WorkspaceDirectoryRecord } from "../../../preload";

export type SidebarContentKey = "main" | "settings" | "explorer";

export type SidebarContentProps = {
  activeMainView: MainContentView;
  activeDirectory?: WorkspaceDirectoryRecord | null;
  explorerDirectoryId?: string | null;
  onActiveDirectoryChange?: (
    directory: WorkspaceDirectoryRecord | null
  ) => void;
  onSelectMainView: (view: MainContentView) => void;
  onSwitchContent: (content: SidebarContentKey) => void;
  onSwitchToExplorer?: (directoryId: string) => void;
  onOpenSshWizard?: () => void;
  onOpenFile?: (
    filePath: string,
    fileName: string,
    isSsh?: boolean,
    sshSessionId?: string | null,
    focusLine?: number,
    sshWorkspaceRoot?: string,
    sshWorkspaceId?: string
  ) => void;
};
