import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { motion } from "motion/react";
import { ChatContent } from "./mainContent/ChatContent";
import { useI18n } from "../i18n";
import {
  appleLayoutTransition,
  useAppleThemeMotion,
} from "../hooks/useAppleThemeMotion";
import type { MainContentView } from "./mainContent/types";
import type { WorkspaceDirectoryRecord } from "../../preload";

// 所有设置面板均为低频视图，使用 React.lazy 按需加载，
// 避免首屏打包体积过大拖慢启动速度。
const ApiSettingsTreePanel = lazy(() =>
  import("./sidebar/ApiSettingsTreePanel").then((m) => ({
    default: m.ApiSettingsTreePanel,
  }))
);
const CodebaseSettingsPanel = lazy(() =>
  import("./sidebar/CodebaseSettingsPanel").then((m) => ({
    default: m.CodebaseSettingsPanel,
  }))
);
const CustomHeadersSettingsPanel = lazy(() =>
  import("./sidebar/CustomHeadersSettingsPanel").then((m) => ({
    default: m.CustomHeadersSettingsPanel,
  }))
);
const HooksSettingsPanel = lazy(() =>
  import("./sidebar/HooksSettingsPanel").then((m) => ({
    default: m.HooksSettingsPanel,
  }))
);
const McpSettingsPanel = lazy(() =>
  import("./sidebar/McpSettingsPanel").then((m) => ({
    default: m.McpSettingsPanel,
  }))
);
const ImportSettingsPanel = lazy(() =>
  import("./sidebar/ImportSettingsPanel").then((m) => ({
    default: m.ImportSettingsPanel,
  }))
);
const ImageGenSettingsPanel = lazy(() =>
  import("./sidebar/ImageGenSettingsPanel").then((m) => ({
    default: m.ImageGenSettingsPanel,
  }))
);
const ImageLibraryPanel = lazy(() =>
  import("./sidebar/ImageLibraryPanel").then((m) => ({
    default: m.ImageLibraryPanel,
  }))
);
const PrivacySettingsPanel = lazy(() =>
  import("./sidebar/PrivacySettingsPanel").then((m) => ({
    default: m.PrivacySettingsPanel,
  }))
);
const ProxyBrowserSettingsPanel = lazy(() =>
  import("./sidebar/ProxyBrowserSettingsPanel").then((m) => ({
    default: m.ProxyBrowserSettingsPanel,
  }))
);
const SensitiveCommandsPanel = lazy(() =>
  import("./sidebar/SensitiveCommandsPanel").then((m) => ({
    default: m.SensitiveCommandsPanel,
  }))
);
const SkillsSettingsPanel = lazy(() =>
  import("./sidebar/SkillsSettingsPanel").then((m) => ({
    default: m.SkillsSettingsPanel,
  }))
);
const SubAgentSettingsPanel = lazy(() =>
  import("./sidebar/SubAgentSettingsPanel").then((m) => ({
    default: m.SubAgentSettingsPanel,
  }))
);
const SystemPromptSettingsPanel = lazy(() =>
  import("./sidebar/SystemPromptSettingsPanel").then((m) => ({
    default: m.SystemPromptSettingsPanel,
  }))
);
const PersonalizationSettingsPanel = lazy(() =>
  import("./sidebar/personalization/PersonalizationSettingsPanel").then(
    (m) => ({
      default: m.PersonalizationSettingsPanel,
    })
  )
);
const TerminalSettingsPanel = lazy(() =>
  import("./sidebar/TerminalSettingsPanel").then((m) => ({
    default: m.TerminalSettingsPanel,
  }))
);
const ThemeSettingsPanel = lazy(() =>
  import("./sidebar/ThemeSettingsPanel").then((m) => ({
    default: m.ThemeSettingsPanel,
  }))
);
const KeyboardShortcutsSettingsPanel = lazy(() =>
  import("./sidebar/KeyboardShortcutsSettingsPanel").then((m) => ({
    default: m.KeyboardShortcutsSettingsPanel,
  }))
);
const UsageSettingsPanel = lazy(() =>
  import("./sidebar/usageSettings/UsageSettingsPanel").then((m) => ({
    default: m.UsageSettingsPanel,
  }))
);
const SystemLogsPanel = lazy(() =>
  import("./sidebar/systemLogs/SystemLogsPanel").then((m) => ({
    default: m.SystemLogsPanel,
  }))
);
const BrowserSettingsPanel = lazy(() =>
  import("./sidebar/browserSettings/BrowserSettingsPanel").then((m) => ({
    default: m.BrowserSettingsPanel,
  }))
);

type MainContentProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  activeView: MainContentView;
  isResizing?: boolean;
  onSelectView: (view: MainContentView) => void;
};

// 懒加载面板的 Suspense 兜底视图：
// 铺满主内容区并居中展示加载状态，避免分包加载期间出现白屏。
const LazyPanelFallback = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div className="main-content-loading" role="status" aria-live="polite">
      <Loader2 className="spin" size={22} aria-hidden="true" />
      <span>{t("common.loading")}</span>
    </div>
  );
};

export const MainContent = ({
  activeDirectory,
  activeView,
  isResizing = false,
  onSelectView,
}: MainContentProps): React.JSX.Element => {
  const { enabled: appleMotionEnabled, reducedMotion } = useAppleThemeMotion();
  return (
    <motion.main
      className="main-content"
      layout={appleMotionEnabled && !isResizing}
      transition={
        appleMotionEnabled ? appleLayoutTransition(reducedMotion) : undefined
      }
    >
      {activeView === "chat" ? (
        <ChatContent
          activeDirectory={activeDirectory}
          onNavigateToView={onSelectView}
        />
      ) : (
        <Suspense fallback={<LazyPanelFallback />}>
          {activeView === "api-settings" ? (
            <ApiSettingsTreePanel onClose={() => onSelectView("chat")} />
          ) : activeView === "imagegen-settings" ? (
            <ImageGenSettingsPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "image-library" ? (
            <ImageLibraryPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "browser-settings" ? (
            <BrowserSettingsPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "proxy-browser-settings" ? (
            <ProxyBrowserSettingsPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "codebase-settings" ? (
            <CodebaseSettingsPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "system-prompt-settings" ? (
            <SystemPromptSettingsPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "personalization-settings" ? (
            <PersonalizationSettingsPanel
              activeDirectory={activeDirectory}
              onClose={() => onSelectView("chat")}
            />
          ) : activeView === "custom-headers-settings" ? (
            <CustomHeadersSettingsPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "mcp-settings" ? (
            <McpSettingsPanel
              activeDirectory={activeDirectory}
              onClose={() => onSelectView("chat")}
            />
          ) : activeView === "import-settings" ? (
            <ImportSettingsPanel
              activeDirectory={activeDirectory}
              onClose={() => onSelectView("chat")}
            />
          ) : activeView === "skills-settings" ? (
            <SkillsSettingsPanel
              activeDirectory={activeDirectory}
              onClose={() => onSelectView("chat")}
            />
          ) : activeView === "sub-agent-settings" ? (
            <SubAgentSettingsPanel
              activeDirectory={activeDirectory}
              onClose={() => onSelectView("chat")}
            />
          ) : activeView === "sensitive-command-settings" ? (
            <SensitiveCommandsPanel
              activeDirectory={activeDirectory}
              onClose={() => onSelectView("chat")}
            />
          ) : activeView === "hooks-settings" ? (
            <HooksSettingsPanel
              activeDirectory={activeDirectory}
              onClose={() => onSelectView("chat")}
            />
          ) : activeView === "terminal-settings" ? (
            <TerminalSettingsPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "theme-settings" ? (
            <ThemeSettingsPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "privacy-settings" ? (
            <PrivacySettingsPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "keyboard-shortcuts-settings" ? (
            <KeyboardShortcutsSettingsPanel
              onClose={() => onSelectView("chat")}
            />
          ) : activeView === "usage-settings" ? (
            <UsageSettingsPanel onClose={() => onSelectView("chat")} />
          ) : activeView === "system-logs" ? (
            <SystemLogsPanel onClose={() => onSelectView("chat")} />
          ) : null}
        </Suspense>
      )}
    </motion.main>
  );
};
