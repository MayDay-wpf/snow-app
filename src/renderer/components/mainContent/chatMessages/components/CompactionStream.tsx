import { useLayoutEffect, useRef } from "react";
import { Minimize2, TriangleAlert, X } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { MarkdownBlock } from "./markdownRenderer";

type CompactionStreamProps = {
  isCompacting: boolean;
  /** 后台（异步）压缩进行中：只显示一条轻量横线提示。 */
  isBackgroundCompacting?: boolean;
  compactionPreview: string;
  compactionError: string | null;
  onDismissError?: () => void;
};

export const CompactionStream = ({
  isCompacting,
  isBackgroundCompacting = false,
  compactionPreview,
  compactionError,
  onDismissError,
}: CompactionStreamProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const compactionStreamRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (compactionStreamRef.current) {
      compactionStreamRef.current.scrollTop =
        compactionStreamRef.current.scrollHeight;
    }
  }, [compactionPreview]);

  if (!isCompacting && !compactionError && !isBackgroundCompacting) {
    return null;
  }

  return (
    <>
      {isBackgroundCompacting && !isCompacting ? (
        <div className="context-compaction-notice" aria-live="polite">
          <span className="context-compaction-notice-rule" aria-hidden="true" />
          <span className="context-compaction-notice-label context-compaction-notice-label--pending">
            <Minimize2 size={13} strokeWidth={1.8} aria-hidden="true" />
            <span className="context-compaction-notice-text">
              {t("chat.compactionBackground")}
            </span>
          </span>
          <span className="context-compaction-notice-rule" aria-hidden="true" />
        </div>
      ) : null}
      {isCompacting ? (
        <section className="context-compaction-stream" aria-live="polite">
          <header className="context-compaction-stream-title">
            <span className="context-compaction-stream-icon" aria-hidden="true">
              <Minimize2 size={15} strokeWidth={1.9} />
            </span>
            <span className="context-compaction-stream-heading">
              {t("chat.compactionGenerating")}
            </span>
          </header>
          <div
            className="context-compaction-stream-body"
            ref={compactionStreamRef}
          >
            {compactionPreview ? (
              <MarkdownBlock
                className="context-compaction-markdown"
                content={compactionPreview}
                streaming={isCompacting}
              />
            ) : (
              <div className="context-compaction-placeholder">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        </section>
      ) : null}
      {compactionError ? (
        // 压缩失败提示：与「上下文摘要」同一条横线样式，弱化呈现（警告色 +
        // 小字 + 两侧细线），不打断阅读；文案由 performCompaction 组装。
        <div className="context-compaction-notice" role="alert">
          <span className="context-compaction-notice-rule" aria-hidden="true" />
          <span
            className="context-compaction-notice-label"
            title={compactionError}
          >
            <TriangleAlert size={13} strokeWidth={1.8} aria-hidden="true" />
            <span className="context-compaction-notice-text">
              {compactionError}
            </span>
          </span>
          {onDismissError ? (
            <button
              type="button"
              className="context-compaction-notice-close"
              onClick={onDismissError}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : null}
          <span className="context-compaction-notice-rule" aria-hidden="true" />
        </div>
      ) : null}
    </>
  );
};
