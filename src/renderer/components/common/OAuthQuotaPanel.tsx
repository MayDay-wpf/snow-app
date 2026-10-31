import { AlertCircle, ChartPie, ChevronDown, RefreshCw } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import type {
  ApiConfigRecord,
  OAuthQuotaBucket,
  OAuthQuotaSnapshot,
} from "../../../preload";
import { useI18n } from "../../i18n";

type Translate = ReturnType<typeof useI18n>["t"];

type QuotaState = {
  snapshot: OAuthQuotaSnapshot | null;
  error: string | null;
  loading: boolean;
};

const OAUTH_SOURCE_PREFIX = "oauth-";
const EXPANDED_STORAGE_KEY = "snow:oauth-quota-expanded";
const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  max: "Max",
  team: "Team",
  go: "Go",
  enterprise: "Enterprise",
  ultra: "Ultra",
  ultra_lite: "Ultra Lite",
};

const EMPTY_QUOTA_STATE: QuotaState = {
  snapshot: null,
  error: null,
  loading: false,
};

/** 按档案保存的会话内配额状态，关闭菜单或切换视图后保留。 */
const quotaStates = new Map<string, QuotaState>();
const quotaListeners = new Set<() => void>();

const getQuotaState = (profileName: string): QuotaState =>
  quotaStates.get(profileName) ?? EMPTY_QUOTA_STATE;

const subscribeQuota = (listener: () => void): (() => void) => {
  quotaListeners.add(listener);
  return () => {
    quotaListeners.delete(listener);
  };
};

const patchQuotaState = (
  profileName: string,
  patch: Partial<QuotaState>,
): void => {
  quotaStates.set(profileName, { ...getQuotaState(profileName), ...patch });
  quotaListeners.forEach((listener) => listener());
};

/** 展开状态持久化；未存储过视为展开。 */
const readExpanded = (): boolean => {
  try {
    return localStorage.getItem(EXPANDED_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
};

const writeExpanded = (expanded: boolean): void => {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    // ignore storage errors
  }
};

const toErrorMessage = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^Error: /, "");

/** 手动查询配额；进行中时不重复发起。 */
const refreshQuota = async (profileName: string): Promise<void> => {
  if (getQuotaState(profileName).loading) {
    return;
  }
  patchQuotaState(profileName, { loading: true, error: null });
  try {
    const snapshot = await window.snow.getOAuthQuota(profileName);
    patchQuotaState(profileName, { snapshot, loading: false });
  } catch (cause) {
    patchQuotaState(profileName, {
      error: toErrorMessage(cause),
      loading: false,
    });
  }
};

/** source 为 oauth-<provider>，或 configJson 含 oauth / oauthPlugin 元数据。 */
const isOAuthApiConfig = (config: ApiConfigRecord): boolean => {
  if (config.source.startsWith(OAUTH_SOURCE_PREFIX)) {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(config.configJson || "{}");
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    if ("oauth" in parsed) {
      return true;
    }
    // configJson.oauthPlugin 是宿主为插件 OAuth 档案写入的建档标记（provider 非空），
    // 与 source 不同，它不会被编辑表单覆盖，因此也能识别历史档案里已被改写为
    // manual 的插件 OAuth 档案。
    const metadata = (parsed as { oauthPlugin?: unknown }).oauthPlugin;
    return (
      typeof metadata === "object" &&
      metadata !== null &&
      typeof (metadata as { provider?: unknown }).provider === "string"
    );
  } catch {
    return false;
  }
};

const formatDateTime = (timestampMs: number, locale: string): string =>
  new Date(timestampMs).toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

/** 剩余越少越醒目：>=50 主题色、>=20 琥珀、其余红。 */
const barTone = (remaining: number | null): string => {
  if (remaining === null) {
    return "";
  }
  if (remaining >= 50) {
    return "is-high";
  }
  return remaining >= 20 ? "is-mid" : "is-low";
};

const bucketLabel = (bucket: OAuthQuotaBucket, t: Translate): string => {
  switch (bucket.key) {
    case "five_hour":
      return t("chat.oauthQuota.window.fiveHour");
    case "weekly":
      return t("chat.oauthQuota.window.weekly");
    case "monthly":
      return t("chat.oauthQuota.window.monthly");
    case "seven_day":
      return t("chat.oauthQuota.window.sevenDay");
    case "seven_day_oauth_apps":
      return t("chat.oauthQuota.window.sevenDayOauthApps");
    case "seven_day_sonnet":
      return t("chat.oauthQuota.window.sevenDaySonnet");
    case "seven_day_opus":
      return t("chat.oauthQuota.window.sevenDayOpus");
    case "seven_day_cowork":
      return t("chat.oauthQuota.window.sevenDayCowork");
    case "model_weekly":
      return `${bucket.label} · ${t("chat.oauthQuota.window.weekly")}`;
    case "on_demand":
      return t("chat.oauthQuota.window.onDemand");
    case "shared":
      return t("chat.oauthQuota.window.shared");
    case "window":
      return bucket.label || t("chat.oauthQuota.window.window");
    default:
      return t("chat.oauthQuota.window.other");
  }
};

type OAuthQuotaPanelProps = {
  config: ApiConfigRecord | null;
};

/** OAuth 订阅配额面板：非 OAuth 档案不渲染；配额仅手动刷新时查询。 */
export const OAuthQuotaPanel = ({
  config,
}: OAuthQuotaPanelProps): React.JSX.Element | null => {
  const { t, locale } = useI18n();
  const profileName = config?.profileName ?? "";
  const { snapshot, error, loading } = useSyncExternalStore(
    subscribeQuota,
    () => getQuotaState(profileName),
  );
  const [expanded, setExpanded] = useState<boolean>(readExpanded);

  const applyExpanded = (next: boolean): void => {
    setExpanded(next);
    writeExpanded(next);
  };

  /** 查询即展开，便于看到结果。 */
  const handleRefresh = (): void => {
    if (!expanded) {
      applyExpanded(true);
    }
    void refreshQuota(profileName);
  };

  if (!config || !isOAuthApiConfig(config)) {
    return null;
  }

  const plan = snapshot?.plan ?? null;
  const planLabel = plan ? (PLAN_LABELS[plan] ?? plan) : null;
  const groups = snapshot?.groups ?? [];

  return (
    <div className="oauth-quota">
      <div className="oauth-quota-header">
        <button
          className="oauth-quota-toggle"
          onClick={() => applyExpanded(!expanded)}
          aria-expanded={expanded}
          title={
            expanded
              ? t("chat.oauthQuota.collapse")
              : t("chat.oauthQuota.expand")
          }
          type="button"
        >
          <ChevronDown
            size={14}
            className={`oauth-quota-chevron${expanded ? "" : " is-collapsed"}`}
          />
          <ChartPie size={14} />
          <span className="oauth-quota-title">
            {t("chat.oauthQuota.title")}
          </span>
          {planLabel && <span className="oauth-quota-plan">{planLabel}</span>}
        </button>
        <button
          className="model-dropdown-action oauth-quota-refresh"
          onClick={handleRefresh}
          disabled={loading}
          title={t("chat.oauthQuota.refresh")}
          type="button"
        >
          <RefreshCw size={12} className={loading ? "spin" : undefined} />
          <span>{t("chat.oauthQuota.refresh")}</span>
        </button>
      </div>
      {expanded && (
        <div className="oauth-quota-body">
          {error && (
            <div className="oauth-quota-error" role="alert">
              <AlertCircle size={13} />
              <span>
                {t("chat.oauthQuota.failed", { values: { value: error } })}
              </span>
            </div>
          )}
          {snapshot && groups.length === 0 && (
            <div className="oauth-quota-status">
              {t("chat.oauthQuota.empty")}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.id} className="oauth-quota-group">
              <div className="oauth-quota-group-label">
                {group.id === "code_review"
                  ? t("chat.oauthQuota.group.codeReview")
                  : group.label}
              </div>
              {group.buckets.map((bucket, index) => {
                const label = bucketLabel(bucket, t);
                const remaining =
                  typeof bucket.remainingPercent === "number"
                    ? bucket.remainingPercent
                    : null;
                return (
                  <div
                    key={`${bucket.key}-${index}`}
                    className="oauth-quota-row"
                  >
                    <div className="oauth-quota-row-head">
                      <span className="oauth-quota-row-label">{label}</span>
                      <span className="oauth-quota-row-value">
                        {remaining === null
                          ? "--"
                          : t("chat.oauthQuota.remaining", {
                              values: { value: Math.round(remaining) },
                            })}
                      </span>
                    </div>
                    <div
                      className="oauth-quota-bar"
                      role="progressbar"
                      aria-label={label}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={remaining ?? undefined}
                    >
                      <div
                        className={`oauth-quota-bar-fill ${barTone(remaining)}`}
                        style={{ width: `${remaining ?? 0}%` }}
                      />
                    </div>
                    {typeof bucket.resetAtMs === "number" && (
                      <div className="oauth-quota-row-reset">
                        {t("chat.oauthQuota.resetAt", {
                          values: {
                            value: formatDateTime(bucket.resetAtMs, locale),
                          },
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {snapshot && (
            <div className="oauth-quota-footer">
              {t("chat.oauthQuota.fetchedAt", {
                values: { value: formatDateTime(snapshot.fetchedAtMs, locale) },
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
