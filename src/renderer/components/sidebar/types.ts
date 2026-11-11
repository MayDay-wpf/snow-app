import type { MainContentView } from "../mainContent/types";
import type { WorkspaceDirectoryRecord } from "../../../preload";

export type SidebarContentKey = "main" | "settings" | "explorer";

export type SidebarContentProps = {
  activeMainView: MainContentView;
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onActiveDirectoryChange?: (
    directory: WorkspaceDirectoryRecord | null,
  ) => void;
  onSelectMainView: (view: MainContentView) => void;
  onSwitchContent: (content: SidebarContentKey) => void;
  onSwitchToExplorer?: (directoryId: string) => void;
  /** 打开 SSH 连接向导；onCanceled 在向导被取消时回调（用于清理一次性状态）。 */
  onOpenSshWizard?: (options?: { onCanceled?: () => void }) => void;
  /** 打开 SSH 连接向导编辑已有远程目录的连接信息。 */
  onEditSshConnection?: (directory: WorkspaceDirectoryRecord) => void;
  /** 在指定路径打开终端（本地路径或 ssh:// 路径）；不传时使用当前活动目录。 */
  onOpenTerminal?: (cwd?: string) => void;
  onOpenFile?: (
    filePath: string,
    fileName: string,
    isSsh?: boolean,
    sshSessionId?: string | null,
    focusLine?: number,
    sshWorkspaceRoot?: string,
    sshWorkspaceId?: string,
  ) => void;
};
