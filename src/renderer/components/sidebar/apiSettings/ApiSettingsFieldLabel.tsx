import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "../../common/Tooltip";

type ApiSettingsHintIconProps = {
  /** 悬停展开的说明；为空时不渲染图标。 */
  hint?: ReactNode;
};

/** 问号说明图标：说明文字收进 Tooltip，表单不再常驻一行小字。 */
export function ApiSettingsHintIcon({
  hint,
}: ApiSettingsHintIconProps): React.JSX.Element | null {
  if (!hint) {
    return null;
  }

  return (
    <span
      className="api-settings-hint-anchor"
      onClick={(event) => {
        // 仅用于悬停：拦住点击，避免在开关/按钮内误触发父级操作
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Tooltip content={hint}>
        <CircleHelp
          aria-hidden="true"
          className="api-settings-hint-icon"
          size={12}
          strokeWidth={2}
        />
      </Tooltip>
    </span>
  );
}

type ApiSettingsFieldLabelProps = {
  /** 字段标题文字。 */
  children: ReactNode;
  /** 字段说明：放在标题右侧的问号图标里。 */
  hint?: ReactNode;
};

/** API 配置字段标题：标题文字 + 可选问号说明图标。 */
export function ApiSettingsFieldLabel({
  children,
  hint,
}: ApiSettingsFieldLabelProps): React.JSX.Element {
  return (
    <span className="api-settings-field-label">
      <span className="api-settings-field-label-text">{children}</span>
      <ApiSettingsHintIcon hint={hint} />
    </span>
  );
}
