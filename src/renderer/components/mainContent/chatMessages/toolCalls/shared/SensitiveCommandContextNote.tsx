import { useI18n } from "../../../../../i18n";

type ContextUsage = {
  contextMessages?: number;
  contextTruncated?: boolean;
  contextEmpty?: boolean;
  preferenceRecords?: number;
};

/** 判定所用的会话上下文与历史偏好说明；都未参与时不渲染。 */
export const SensitiveCommandContextNote = ({
  decision,
  className,
}: {
  decision: ContextUsage;
  className?: string;
}): React.JSX.Element | null => {
  const { t } = useI18n();

  const isContextEnabled =
    typeof decision.contextMessages === "number" ||
    decision.contextEmpty === true ||
    decision.contextTruncated === true;
  const preferenceCount = decision.preferenceRecords ?? 0;
  if (!isContextEnabled && preferenceCount <= 0) {
    return null;
  }

  const count = decision.contextMessages ?? 0;
  const contextLabel = !isContextEnabled
    ? ""
    : decision.contextEmpty
      ? decision.contextTruncated
        ? t("sensitiveCommand.decisionContextDropped")
        : t("sensitiveCommand.decisionContextEmpty")
      : decision.contextTruncated
        ? t("sensitiveCommand.decisionContextTruncated", { values: { count } })
        : t("sensitiveCommand.decisionContextUsed", { values: { count } });

  return (
    <>
      {contextLabel ? <span className={className}>{contextLabel}</span> : null}
      {preferenceCount > 0 ? (
        <span className={className}>
          {t("sensitiveCommand.decisionPreferencesUsed", {
            values: { count: preferenceCount },
          })}
        </span>
      ) : null}
    </>
  );
};
