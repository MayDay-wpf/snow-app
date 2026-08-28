import { useMemo } from "react";
import { ModelIcon, modelMappings } from "@lobehub/icons";
import { Bot } from "lucide-react";

type ModelBrandIconProps = {
  /** 模型名称，用于模糊匹配品牌图标。 */
  model: string;
  size?: number;
  className?: string;
  shape?: "circle" | "square";
};

/**
 * 模型品牌图标：按模型名模糊匹配 LobeHub 品牌图标，
 * 匹配失败时显示默认占位图标（中性圆底 + Bot），保证任何模型名都有视觉占位。
 *
 * 两种形态都会带上 `model-brand-icon` 基础类：LobeHub 的头像容器只输出 CSS 变量，
 * 真正的 flex 居中规则依赖其官方样式表（项目未引入），因此由该类在 styles.css 中补齐，
 * 否则内部 logo 会按内联元素坐在文字基线上，出现中心偏移。
 */
export function ModelBrandIcon({
  model,
  size = 16,
  className,
  shape = "circle",
}: ModelBrandIconProps): React.JSX.Element {
  // 与 ModelIcon 内部相同的匹配逻辑（keywords 正则，不区分大小写），
  // 仅用于判断是否有品牌图标可显示。
  const matched = useMemo(() => {
    const name = model.trim().toLowerCase();
    if (!name) {
      return false;
    }
    return modelMappings.some((item) =>
      item.keywords.some((keyword) => new RegExp(keyword, "i").test(name))
    );
  }, [model]);

  const rootClassName = [
    "model-brand-icon",
    matched ? null : "model-brand-icon-fallback",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (matched) {
    return (
      <ModelIcon
        model={model}
        size={size}
        shape={shape}
        className={rootClassName}
      />
    );
  }

  return (
    <span
      className={rootClassName}
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: shape === "circle" ? "50%" : Math.floor(size * 0.1),
      }}
    >
      <Bot size={Math.round(size * 0.62)} strokeWidth={1.8} />
    </span>
  );
}
