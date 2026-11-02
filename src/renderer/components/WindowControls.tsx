import { Minus, Square, X, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";

/**
 * Windows 自定义窗口操作按钮组 (最小化 / 最大化 / 关闭)
 * 仅 Windows 平台渲染，已嵌入 TopBar 右侧卡片；
 * macOS 使用原生 traffic lights，不渲染此组件。
 */
export const WindowControlsButtons = (): React.JSX.Element => {
  const { t } = useI18n();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let active = true;

    window.snow.isWindowMaximized().then((maximized) => {
      if (active) {
        setIsMaximized(maximized);
      }
    });

    const dispose = window.snow.onWindowMaximizeStateChanged((maximized) => {
      setIsMaximized(maximized);
    });

    return () => {
      active = false;
      dispose();
    };
  }, []);

  const handleMinimize = (): void => {
    void window.snow.minimizeWindow();
  };

  const handleToggleMaximize = (): void => {
    void window.snow.toggleMaximizeWindow();
  };

  const handleClose = (): void => {
    void window.snow.closeWindow();
  };

  const MaximizeIcon = isMaximized ? Copy : Square;
  const minimizeLabel = t("windowControls.minimize", {
    defaultValue: "Minimize",
  });
  const maximizeLabel = isMaximized
    ? t("windowControls.restore", { defaultValue: "Restore" })
    : t("windowControls.maximize", { defaultValue: "Maximize" });
  const closeLabel = t("common.close", { defaultValue: "Close" });

  return (
    <div
      className="window-controls-buttons"
      aria-label={t("windowControls.ariaLabel", {
        defaultValue: "Window controls",
      })}
    >
      <button
        type="button"
        className="window-control-btn minimize-btn"
        aria-label={minimizeLabel}
        title={minimizeLabel}
        onClick={handleMinimize}
      >
        <Minus size={16} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className="window-control-btn maximize-btn"
        aria-label={maximizeLabel}
        title={maximizeLabel}
        onClick={handleToggleMaximize}
      >
        <MaximizeIcon size={14} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className="window-control-btn close-btn"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={handleClose}
      >
        <X size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
};
