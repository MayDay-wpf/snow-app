import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useToolCardStyle, type ToolCardStyle } from "../utils/toolCardStyle";
import { AutoDismissNotice } from "./AutoDismissNotice";

const NOTICE_DURATION_MS = 1800;

const STYLE_LABEL_KEYS: Record<ToolCardStyle, string> = {
  classic: "chat.style.classic",
  chips: "chat.style.chips",
  minimal: "chat.style.minimal",
};

/** 循环切换会话记录显示方案时的自动消失提示。 */
export const TranscriptStyleNotice = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const style = useToolCardStyle();
  const [notice, setNotice] = useState<{
    nonce: number;
    style: ToolCardStyle;
  } | null>(null);
  const previousStyleRef = useRef(style);

  useEffect(() => {
    if (previousStyleRef.current === style) {
      return;
    }
    previousStyleRef.current = style;
    setNotice((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, style }));
  }, [style]);

  if (!notice) {
    return null;
  }

  return (
    <AutoDismissNotice
      key={notice.nonce}
      tone="info"
      durationMs={NOTICE_DURATION_MS}
      message={t("chat.style.switched", {
        defaultValue: "Transcript style: {{style}}",
        values: { style: t(STYLE_LABEL_KEYS[notice.style]) },
      })}
      onDismiss={() => setNotice(null)}
    />
  );
};
