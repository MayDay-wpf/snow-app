import {
  ChevronsLeft,
  ChevronsRight,
  CopyX,
  ExternalLink,
  Globe,
  Paintbrush,
  Terminal,
  X,
  XCircle,
} from "lucide-react";
import { useI18n } from "../../i18n";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../common/ContextMenu";

type RightPanelTabContextMenuProps = {
  /** 右键时的鼠标坐标（viewport 坐标）。 */
  x: number;
  y: number;
  /** 该 tab 是否允许关闭（Git 固定 tab 不可关闭）。 */
  isClosable: boolean;
  /** 关闭其他标签页（目标 tab 之外存在其他可关闭 tab 时提供）。 */
  onCloseOthers?: () => void;
  /** 关闭右侧标签页（目标 tab 右侧存在可关闭 tab 时提供）。 */
  onCloseToRight?: () => void;
  /** 关闭左侧标签页（目标 tab 左侧存在可关闭 tab 时提供）。 */
  onCloseToLeft?: () => void;
  /** 关闭所有标签页（tab 栏空白处右键，或存在可关闭 tab 时提供）。 */
  onCloseAllTabs?: () => void;
  /** 浏览器 tab 专属：在新窗口中打开该浏览器实例（打开后原 tab 关闭）。 */
  onOpenInNewWindow?: () => void;
  onNewTerminal: () => void;
  onNewBrowser: () => void;
  onNewDrawing: () => void;
  onCloseTab: () => void;
  onClose: () => void;
};

/**
 * 右侧面板 tab 的右键菜单：新建终端 / 新建浏览器 / 新建绘图工作台 / 关闭标签页
 * （含关闭其他、关闭右侧、关闭左侧、关闭所有）。定位在鼠标点击处，
 * 越界时自动收进视口；点击外部或按 Esc 关闭。
 */
export function RightPanelTabContextMenu({
  x,
  y,
  isClosable,
  onCloseOthers,
  onCloseToRight,
  onCloseToLeft,
  onCloseAllTabs,
  onOpenInNewWindow,
  onNewTerminal,
  onNewBrowser,
  onNewDrawing,
  onCloseTab,
  onClose,
}: RightPanelTabContextMenuProps): React.JSX.Element {
  const { t } = useI18n();

  const items: ContextMenuItem[] = [
    {
      id: "new-terminal",
      label: t("rightPanel.tabContextNewTerminal", {
        defaultValue: "New Terminal",
      }),
      icon: <Terminal size={13} strokeWidth={1.8} />,
      onClick: onNewTerminal,
    },
    {
      id: "new-browser",
      label: t("rightPanel.tabContextNewBrowser", {
        defaultValue: "New Browser",
      }),
      icon: <Globe size={13} strokeWidth={1.8} />,
      onClick: onNewBrowser,
    },
    {
      id: "new-drawing",
      label: t("rightPanel.tabContextNewDrawing", {
        defaultValue: "New Drawing",
      }),
      icon: <Paintbrush size={13} strokeWidth={1.8} />,
      onClick: onNewDrawing,
    },
  ];

  // 浏览器 tab 专属：把当前实例弹出到独立浏览器窗口（继承实例 id，
  // 原 tab 在打开成功后关闭）。
  if (onOpenInNewWindow) {
    items.push({
      id: "open-in-new-window",
      label: t("rightPanel.openInNewWindow", {
        defaultValue: "Open in new window",
      }),
      icon: <ExternalLink size={13} strokeWidth={1.8} />,
      onClick: onOpenInNewWindow,
    });
  }

  // 分隔线下方按 VS Code 习惯组织关闭类菜单项：
  // 关闭标签页 → 关闭其他 → 关闭右侧 → 关闭左侧 → 关闭所有。
  const footerItems: ContextMenuItem[] = [];
  if (isClosable) {
    footerItems.push({
      id: "close-tab",
      label: t("rightPanel.closeTab", { defaultValue: "Close tab" }),
      icon: <X size={13} strokeWidth={1.8} />,
      onClick: onCloseTab,
    });
  }
  if (onCloseOthers) {
    footerItems.push({
      id: "close-others",
      label: t("rightPanel.closeOtherTabs", {
        defaultValue: "Close other tabs",
      }),
      icon: <CopyX size={13} strokeWidth={1.8} />,
      onClick: onCloseOthers,
    });
  }
  if (onCloseToRight) {
    footerItems.push({
      id: "close-to-right",
      label: t("rightPanel.closeTabsToRight", {
        defaultValue: "Close tabs to the right",
      }),
      icon: <ChevronsRight size={13} strokeWidth={1.8} />,
      onClick: onCloseToRight,
    });
  }
  if (onCloseToLeft) {
    footerItems.push({
      id: "close-to-left",
      label: t("rightPanel.closeTabsToLeft", {
        defaultValue: "Close tabs to the left",
      }),
      icon: <ChevronsLeft size={13} strokeWidth={1.8} />,
      onClick: onCloseToLeft,
    });
  }
  if (onCloseAllTabs) {
    footerItems.push({
      id: "close-all-tabs",
      label: t("rightPanel.closeAllTabs", { defaultValue: "Close all tabs" }),
      icon: <XCircle size={13} strokeWidth={1.8} />,
      onClick: onCloseAllTabs,
    });
  }

  return (
    <ContextMenu
      x={x}
      y={y}
      items={items}
      footerItems={footerItems.length > 0 ? footerItems : undefined}
      onClose={onClose}
    />
  );
}
