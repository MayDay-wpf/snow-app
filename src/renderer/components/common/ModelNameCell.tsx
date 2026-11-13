import { ModelBrandIcon } from "./ModelBrandIcon";

type ModelNameCellProps = {
  model: string;
};

/** 表格「模型」列：品牌图标 + 模型 ID 单行展示，样式与生图渠道表格一致。 */
export function ModelNameCell({
  model,
}: ModelNameCellProps): React.JSX.Element {
  const name = model.trim();
  return (
    <span className="model-name-cell" title={name || undefined}>
      {name ? (
        <ModelBrandIcon
          model={name}
          size={13}
          className="model-name-cell-icon"
        />
      ) : null}
      <span className="model-name-cell-id">{name || "-"}</span>
    </span>
  );
}
