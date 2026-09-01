import { Minus, Square, X, Copy } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Windows 自定义窗口操作按钮组 (最小化 / 最大化 / 关闭)
 * 仅 Windows 平台渲染，已嵌入 TopBar 右侧卡片；
 * macOS 使用原生 traffic lights，不渲染此组件。
 */
export const WindowControlsButtons = (): React.JSX.Element => {
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

  return (
    <div className="window-controls-buttons" aria-label="Window controls">
      <button
        type="button"
        className="window-control-btn minimize-btn"
        aria-label="Minimize"
        title="Minimize"
        onClick={handleMinimize}
      >
        <Minus size={16} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className="window-control-btn maximize-btn"
        aria-label={isMaximized ? "Restore" : "Maximize"}
        title={isMaximized ? "Restore" : "Maximize"}
        onClick={handleToggleMaximize}
      >
        <MaximizeIcon size={14} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className="window-control-btn close-btn"
        aria-label="Close"
        title="Close"
        onClick={handleClose}
      >
        <X size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
};
