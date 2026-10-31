import { ShieldX } from "lucide-react";
import { useI18n } from "../../../../../i18n";
import { ContentChips } from "../../../chatInput/ContentChips";
import { parseContentSegments } from "../../../chatInput/fileTagUtils";
import type { ToolRejection } from "./toolRejection";

type ToolRejectionNoticeProps = {
  rejection: ToolRejection;
};

export const ToolRejectionNotice = ({
  rejection,
}: ToolRejectionNoticeProps): React.JSX.Element => {
  const { t } = useI18n();

  return (
    <div className="tcn-rejection" role="note">
      <ShieldX size={12} className="tcn-rejection-icon" aria-hidden="true" />
      <span className="tcn-rejection-label">
        {t("toolCall.rejection.title", { defaultValue: "Rejected" })}
      </span>
      <span className="tcn-rejection-reason">
        {rejection.userProvided ? (
          // 理由可能是富文本：用户粘贴的图片 / 长文本以 chip 承载，按聊天区
          // 同款 chip 渲染，避免把 base64 与片段 JSON 原样显示出来。
          <ContentChips segments={parseContentSegments(rejection.reason)} />
        ) : (
          t("toolCall.rejection.noReason", {
            defaultValue: "No reason provided by the user",
          })
        )}
      </span>
    </div>
  );
};
