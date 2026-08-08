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
  /** 在指定路径打开终端（本地路径或 ssh:// 路径）；不传时使用当前活动目录。 */
  onOpenTerminal?: (cwd?: string) => void;
  onOpenFile?: (
    filePath: string,
    fileName: string,
    isSsh?: boolean,
    sshSessionId?: string | null,
    focusLine?: number
  ) => void;
};
