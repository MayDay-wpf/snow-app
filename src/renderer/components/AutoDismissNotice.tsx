import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

type AutoDismissNoticeTone = "success" | "error" | "info" | "warning";

type AutoDismissNoticeProps = {
  message: string;
  tone?: AutoDismissNoticeTone;
  /** 显示时长（毫秒），自动消失与底部进度条共用 */
  durationMs?: number;
  onDismiss?: () => void;
};

type AutoDismissNoticeStyle = CSSProperties & {
  "--notice-duration": string;
};

const DEFAULT_DURATION_MS = 2000;

const noticeIcons: Record<AutoDismissNoticeTone, ReactNode> = {
  success: <CheckCircle2 size={15} strokeWidth={2} />,
  error: <AlertCircle size={15} strokeWidth={2} />,
  info: <Info size={15} strokeWidth={2} />,
  warning: <AlertTriangle size={15} strokeWidth={2} />,
};

export function AutoDismissNotice({
  message,
  tone = "info",
  durationMs = DEFAULT_DURATION_MS,
  onDismiss,
}: AutoDismissNoticeProps): React.JSX.Element | null {
  const resolvedDurationMs =
    Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : DEFAULT_DURATION_MS;

  // 回调走 ref：父组件重渲染换了新函数也不重置计时，否则提示会比进度条晚消失
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!message || !onDismissRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(
      () => onDismissRef.current?.(),
      resolvedDurationMs,
    );

    return () => window.clearTimeout(timeoutId);
  }, [message, resolvedDurationMs]);

  if (!message) {
    return null;
  }

  const noticeStyle: AutoDismissNoticeStyle = {
    "--notice-duration": `${resolvedDurationMs}ms`,
  };

  return createPortal(
    <div
      className={`auto-dismiss-notice ${tone}`}
      role="status"
      aria-live="polite"
      style={noticeStyle}
    >
      <span className="auto-dismiss-notice-icon">{noticeIcons[tone]}</span>
      <span className="auto-dismiss-notice-message">{message}</span>
      <span className="auto-dismiss-notice-progress" aria-hidden="true">
        {/* message 变化时重播进度条 */}
        <span className="auto-dismiss-notice-progress-fill" key={message} />
      </span>
    </div>,
    document.body,
  );
}
