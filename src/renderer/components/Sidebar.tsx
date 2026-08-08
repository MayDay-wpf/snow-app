import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { MainSidebarContent } from "./sidebar/MainSidebarContent";
import { ProjectExplorerContent } from "./sidebar/ProjectExplorerContent";
import { SettingsSidebarContent } from "./sidebar/SettingsSidebarContent";
import { SETTINGS_VIEW_IDS } from "./sidebar/settingsItems";
import { shortcutEvents } from "./shortcutEvents";
import { APP_CONTROL_OPEN_SETTINGS_EVENT } from "../hooks/useAppControl";
import {
  appleLayoutTransition,
  useAppleThemeMotion,
} from "../hooks/useAppleThemeMotion";
import type { MainContentView } from "./mainContent/types";
import type { SidebarContentKey, SidebarContentProps } from "./sidebar/types";

type SidebarProps = {
  activeMainView: SidebarContentProps["activeMainView"];
  activeDirectory?: SidebarContentProps["activeDirectory"];
  isCollapsed: boolean;
  isResizing?: boolean;
  onActiveDirectoryChange?: SidebarContentProps["onActiveDirectoryChange"];
  onSelectMainView: SidebarContentProps["onSelectMainView"];
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

export const Sidebar = ({
  activeMainView,
  activeDirectory,
  isCollapsed,
  isResizing = false,
  onActiveDirectoryChange,
  onSelectMainView,
  onOpenSshWizard,
  onOpenFile,
}: SidebarProps): React.JSX.Element => {
  const { enabled: appleMotionEnabled, reducedMotion } = useAppleThemeMotion();
  const [activeContent, setActiveContent] = useState<SidebarContentKey>("main");
  const [explorerDirectoryId, setExplorerDirectoryId] = useState<string | null>(
    null
  );

  const handleSwitchContent = useCallback(
    (content: SidebarContentKey): void => {
      if (content === "explorer") {
        // explorerDirectoryId is set separately via onSwitchToExplorer
        setActiveContent("explorer");
        return;
      }
      setActiveContent(content);
    },
    []
  );

  const handleSwitchToExplorer = useCallback((directoryId: string): void => {
    setExplorerDirectoryId(directoryId);
    setActiveContent("explorer");
  }, []);

  // 订阅快捷键事件：Ctrl/Cmd+D 打开当前项目明细（Explorer 视图）。
  // 使用当前激活的工作区目录作为 explorer 目标。
  useEffect(() => {
    return shortcutEvents.on("open-project-explorer", () => {
      if (activeDirectory?.directoryId) {
        handleSwitchToExplorer(activeDirectory.directoryId);
      }
    });
  }, [activeDirectory, handleSwitchToExplorer]);

  useEffect(() => {
    const handler = (event: Event) => {
      setActiveContent("settings");
      // The event may carry a target settings view (e.g. opened from the
      // project codebase panel when the embedding configuration is missing),
      // so the sidebar can navigate directly to the right settings page.
      const detail = (event as CustomEvent<{ view?: string }>).detail;
      const view = detail?.view as MainContentView | undefined;
      if (view && SETTINGS_VIEW_IDS.has(view)) {
        onSelectMainView(view);
      }
    };
    window.addEventListener(APP_CONTROL_OPEN_SETTINGS_EVENT, handler);
    return () => {
      window.removeEventListener(APP_CONTROL_OPEN_SETTINGS_EVENT, handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sidebarProps: SidebarContentProps = {
    activeMainView,
    activeDirectory,
    explorerDirectoryId,
    onActiveDirectoryChange,
    onSelectMainView,
    onSwitchContent: handleSwitchContent,
    onSwitchToExplorer: handleSwitchToExplorer,
    onOpenSshWizard,
    onOpenFile,
  };

  return (
    <motion.aside
      className={`sidebar ${isCollapsed ? "collapsed" : ""}`}
      layout={appleMotionEnabled && !isResizing}
      transition={
        appleMotionEnabled ? appleLayoutTransition(reducedMotion) : undefined
      }
    >
      <div
        className={`sidebar-content-wrapper ${
          activeContent === "main" ? "" : "is-hidden"
        }`}
      >
        <MainSidebarContent {...sidebarProps} />
      </div>
      <div
        className={`sidebar-content-wrapper ${
          activeContent === "settings" ? "" : "is-hidden"
        }`}
      >
        <SettingsSidebarContent {...sidebarProps} />
      </div>
      <div
        className={`sidebar-content-wrapper ${
          activeContent === "explorer" ? "" : "is-hidden"
        }`}
      >
        <ProjectExplorerContent {...sidebarProps} />
      </div>
    </motion.aside>
  );
};
