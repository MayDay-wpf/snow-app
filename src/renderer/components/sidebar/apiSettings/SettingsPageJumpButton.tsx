import { Settings } from "lucide-react";
import { APP_CONTROL_OPEN_SETTINGS_EVENT } from "../../../hooks/useAppControl";
import type { MainContentView } from "../../mainContent/types";

type SettingsPageJumpButtonProps = {
  /** 目标设置页。 */
  view: MainContentView;
  label: string;
  disabled?: boolean;
  /** 跳转前回调（如关闭所在弹窗）。 */
  onBeforeJump?: () => void;
};

/** 字段旁的直达入口：跳到维护该选项的设置页，样式与模型直达入口一致。 */
export function SettingsPageJumpButton({
  view,
  label,
  disabled = false,
  onBeforeJump,
}: SettingsPageJumpButtonProps): React.JSX.Element {
  const handleClick = (): void => {
    onBeforeJump?.();
    window.dispatchEvent(
      new CustomEvent(APP_CONTROL_OPEN_SETTINGS_EVENT, {
        detail: { view },
      }),
    );
  };

  return (
    <button
      className="model-settings-jump"
      type="button"
      disabled={disabled}
      onClick={handleClick}
    >
      <Settings size={11} strokeWidth={1.9} aria-hidden="true" />
      {label}
    </button>
  );
}
