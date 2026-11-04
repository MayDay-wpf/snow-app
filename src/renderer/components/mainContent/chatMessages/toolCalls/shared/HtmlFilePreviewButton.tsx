import { Eye } from "lucide-react";
import { useI18n } from "../../../../../i18n";
import { useHtmlArtifactOpen } from "../../components/HtmlArtifactOpenContext";

const HTML_FILE_RE = /\.html?$/i;

type HtmlFilePreviewButtonProps = {
  filePath: string;
  /** 仅写入成功后显示。 */
  enabled: boolean;
};

/** 点击直接把 HTML 文件放到右侧内置浏览器打开（不再在会话流里渲染预览卡片）。 */
export const HtmlFilePreviewButton = ({
  filePath,
  enabled,
}: HtmlFilePreviewButtonProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const openHtmlArtifact = useHtmlArtifactOpen();
  if (!enabled || !HTML_FILE_RE.test(filePath)) {
    return null;
  }
  const label = t("toolCall.websearch.openInBrowser");
  return (
    <button
      type="button"
      className="tcn-html-preview-btn"
      title={label}
      aria-label={label}
      onClick={(event) => {
        // 阻止冒泡到工具卡片头部的展开/收起
        event.preventDefault();
        event.stopPropagation();
        openHtmlArtifact?.(filePath);
      }}
    >
      <Eye size={12} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
};
