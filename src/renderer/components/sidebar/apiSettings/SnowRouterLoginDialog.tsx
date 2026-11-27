import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  Copy,
  ExternalLink,
  Layers,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Modal } from "../../common/Modal";
import { useI18n } from "../../../i18n";
import type {
  OAuthLoginStart,
  OAuthLoginStatus,
  OAuthProviderInfo,
  OAuthRouterChannel,
} from "../../../../preload";

const POLL_INTERVAL_MS = 2000;
const DEFAULT_SERVER_URL = "https://kfccrazythursday.com";
// 地址变更后换 key，避免继续沿用本地调试时保存的地址。
const SERVER_URL_STORAGE_KEY = "snow-router-server-url-v2";

type Phase =
  | "idle"
  | "starting"
  | "waiting"
  | "channels"
  | "connecting"
  | "success"
  | "error";

type SnowRouterLoginDialogProps = {
  open: boolean;
  provider: OAuthProviderInfo;
  onBack: () => void;
  onClose: () => void;
  onCompleted: (status: OAuthLoginStatus) => void;
};

const readStoredServerUrl = (): string => {
  try {
    return window.localStorage.getItem(SERVER_URL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

const storeServerUrl = (value: string): void => {
  try {
    window.localStorage.setItem(SERVER_URL_STORAGE_KEY, value);
  } catch {
    // 本地存储不可用时忽略，不影响登录。
  }
};

export function SnowRouterLoginDialog({
  open,
  provider,
  onBack,
  onClose,
  onCompleted,
}: SnowRouterLoginDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [serverUrl, setServerUrl] = useState(
    () => readStoredServerUrl() || DEFAULT_SERVER_URL,
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<OAuthLoginStart | null>(null);
  const [status, setStatus] = useState<OAuthLoginStatus | null>(null);
  const [channels, setChannels] = useState<OAuthRouterChannel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [callbackInput, setCallbackInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const sessionRef = useRef<OAuthLoginStart | null>(null);
  const completedRef = useRef(false);
  const startingRef = useRef(false);

  const reset = useCallback(() => {
    sessionRef.current = null;
    completedRef.current = false;
    startingRef.current = false;
    setPhase("idle");
    setSession(null);
    setStatus(null);
    setChannels([]);
    setSelected(new Set());
    setError("");
    setCallbackInput("");
    setIsSubmitting(false);
    setCopied(false);
  }, []);

  useEffect(() => {
    if (open) {
      return;
    }
    const active = sessionRef.current;
    if (active) {
      void window.snow
        .cancelOAuthLogin(active.sessionId)
        .catch(() => undefined);
    }
    reset();
  }, [open, reset]);

  const applyStatus = useCallback(
    (next: OAuthLoginStatus) => {
      setStatus(next);
      if (next.status === "success") {
        const list = next.channels ?? [];
        setChannels(list);
        if (list.length === 0) {
          setError(
            t("settings.snowRouterNoChannels", {
              defaultValue:
                "This account has no available channels on the router.",
            }),
          );
          setPhase("error");
          return;
        }
        setSelected(new Set(list.map((channel) => channel.id)));
        setPhase("channels");
        return;
      }
      if (next.status === "error") {
        setError(next.error ?? "");
        setPhase("error");
        return;
      }
      if (next.status === "cancelled") {
        setError(
          t("settings.oauthCancelled", {
            defaultValue: "The sign-in session was cancelled.",
          }),
        );
        setPhase("error");
      }
    },
    [t],
  );

  // 等待浏览器授权完成。
  useEffect(() => {
    if (!open || phase !== "waiting" || !session) {
      return;
    }
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const next = await window.snow.getOAuthLoginStatus(session.sessionId);
        if (stopped || !next) {
          return;
        }
        if (
          next.status === "success" ||
          next.status === "error" ||
          next.status === "cancelled"
        ) {
          applyStatus(next);
        }
      } catch (pollError) {
        if (!stopped) {
          setError(
            pollError instanceof Error ? pollError.message : String(pollError),
          );
        }
      }
    };
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open, phase, session, applyStatus]);

  const handleStart = useCallback(async () => {
    if (startingRef.current) {
      return;
    }
    const normalized = serverUrl.trim() || DEFAULT_SERVER_URL;
    storeServerUrl(normalized);
    startingRef.current = true;
    setPhase("starting");
    setError("");
    try {
      const started = await window.snow.startOAuthLogin(
        provider.id,
        undefined,
        undefined,
        normalized,
      );
      sessionRef.current = started;
      setSession(started);
      setServerUrl(started.serverUrl || normalized);
      setPhase("waiting");
      if (started.authUrl) {
        window.open(started.authUrl, "_blank", "noopener,noreferrer");
      }
    } catch (startError) {
      setError(
        startError instanceof Error ? startError.message : String(startError),
      );
      // 地址填写错误时回到配置页，方便直接修改后重试。
      setPhase("idle");
    } finally {
      startingRef.current = false;
    }
  }, [provider.id, serverUrl]);

  const handleCopyLink = useCallback(async () => {
    if (!session) {
      return;
    }
    try {
      await navigator.clipboard.writeText(session.authUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [session]);

  const handleOpenBrowser = useCallback(() => {
    if (session) {
      window.open(session.authUrl, "_blank", "noopener,noreferrer");
    }
  }, [session]);

  const handleSubmitCallback = useCallback(async () => {
    if (!session || !callbackInput.trim()) {
      return;
    }
    setIsSubmitting(true);
    setError("");
    try {
      const next = await window.snow.submitOAuthCallback(
        session.sessionId,
        callbackInput.trim(),
      );
      applyStatus(next);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [session, callbackInput, applyStatus]);

  const toggleChannel = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const allSelected = useMemo(
    () => channels.length > 0 && selected.size === channels.length,
    [channels, selected],
  );

  const toggleAll = useCallback(() => {
    setSelected((current) => {
      if (current.size === channels.length) {
        return new Set();
      }
      return new Set(channels.map((channel) => channel.id));
    });
  }, [channels]);

  const handleConnect = useCallback(async () => {
    if (!session || selected.size === 0) {
      return;
    }
    setPhase("connecting");
    setError("");
    try {
      const next = await window.snow.finalizeSnowRouterLogin(
        session.sessionId,
        Array.from(selected),
      );
      setStatus(next);
      setChannels(next.channels ?? channels);
      if (!completedRef.current) {
        completedRef.current = true;
        onCompleted(next);
      }
      setPhase("success");
    } catch (connectError) {
      setError(
        connectError instanceof Error
          ? connectError.message
          : String(connectError),
      );
      setPhase("channels");
    }
  }, [session, selected, channels, onCompleted]);

  const exitTo = useCallback(
    (next: () => void) => {
      const active = sessionRef.current;
      if (active && phase !== "success") {
        void window.snow
          .cancelOAuthLogin(active.sessionId)
          .catch(() => undefined);
      }
      reset();
      next();
    },
    [phase, reset],
  );

  const handleClose = useCallback(() => exitTo(onClose), [exitTo, onClose]);
  const handleBack = useCallback(() => exitTo(onBack), [exitTo, onBack]);

  const isBusy = phase === "starting" || phase === "connecting" || isSubmitting;

  const renderChannels = (): React.JSX.Element => (
    <div className="oauth-login-body">
      <div className="oauth-login-status">
        <span>
          {t("settings.snowRouterChannelsHint", {
            defaultValue: "Choose the channels to connect.",
          })}
        </span>
      </div>
      <div className="snow-router-channel-list">
        {channels.map((channel) => {
          const checked = selected.has(channel.id);
          return (
            <label
              className={`snow-router-channel${checked ? " selected" : ""}`}
              key={channel.id}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleChannel(channel.id)}
              />
              <span className="snow-router-channel-body">
                <span className="snow-router-channel-head">
                  <strong>{channel.name}</strong>
                  {channel.hasKey ? (
                    <span className="snow-router-channel-badge">
                      {t("settings.snowRouterExistingKey", {
                        defaultValue: "Key ready",
                      })}
                    </span>
                  ) : null}
                </span>
                <span className="snow-router-channel-meta">
                  {channel.id}
                  {channel.ratio ? ` · ${channel.ratio}` : ""}
                  {` · ${t("settings.snowRouterModelCount", {
                    defaultValue: "{count} models",
                  }).replace("{count}", String(channel.models.length))}`}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {error ? <p className="oauth-login-error">{error}</p> : null}
    </div>
  );

  const renderBody = (): React.JSX.Element => {
    if (phase === "idle" || phase === "starting") {
      return (
        <div className="oauth-login-body">
          <div className="oauth-login-field">
            <label htmlFor="snow-router-server-url">
              {t("settings.snowRouterServerUrl", {
                defaultValue: "Router address",
              })}
            </label>
            <input
              id="snow-router-server-url"
              type="text"
              value={serverUrl}
              placeholder={DEFAULT_SERVER_URL}
              spellCheck={false}
              onChange={(event) => setServerUrl(event.target.value)}
              disabled={phase === "starting"}
            />
          </div>
          {phase === "starting" ? (
            <div className="oauth-login-status">
              <Loader2 size={14} className="spin" />
              <span>
                {t("settings.oauthStarting", {
                  defaultValue: "Preparing the sign-in session...",
                })}
              </span>
            </div>
          ) : null}
          {error ? <p className="oauth-login-error">{error}</p> : null}
        </div>
      );
    }

    if (phase === "waiting" && session) {
      return (
        <div className="oauth-login-body">
          <div className="oauth-login-status">
            <Loader2 size={14} className="spin" />
            <span>
              {t("settings.snowRouterWaiting", {
                defaultValue: "Waiting for the router sign-in to complete...",
              })}
            </span>
          </div>
          <div className="oauth-login-link">
            <input
              type="text"
              value={session.authUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              className="api-settings-action-btn secondary"
              type="button"
              onClick={() => void handleCopyLink()}
              title={t("settings.oauthCopyLink", { defaultValue: "Copy link" })}
            >
              <Copy size={14} />
              <span>
                {copied
                  ? t("settings.oauthCopied", { defaultValue: "Copied" })
                  : t("settings.oauthCopyLink", {
                      defaultValue: "Copy link",
                    })}
              </span>
            </button>
            <button
              className="api-settings-action-btn secondary"
              type="button"
              onClick={handleOpenBrowser}
              title={t("settings.oauthOpenBrowser", {
                defaultValue: "Open in browser",
              })}
            >
              <ExternalLink size={14} />
              <span>
                {t("settings.oauthOpenBrowser", {
                  defaultValue: "Open in browser",
                })}
              </span>
            </button>
          </div>
          <p className="oauth-login-hint">
            {session.manualMode
              ? t("settings.oauthManualNotice", {
                  defaultValue:
                    "The local callback port is unavailable. After signing in, copy the address bar URL from the browser and paste it below.",
                })
              : t("settings.snowRouterWaitingHint", {
                  defaultValue:
                    "Authorize Snow App in the opened page; the session completes automatically.",
                })}
          </p>
          <div className="oauth-login-field">
            <label htmlFor="snow-router-callback">
              {t("settings.oauthCallbackLabel", {
                defaultValue: "Callback URL",
              })}
            </label>
            <div className="oauth-login-link">
              <input
                id="snow-router-callback"
                type="text"
                value={callbackInput}
                placeholder={t("settings.oauthCallbackPlaceholder", {
                  defaultValue:
                    "Paste the callback URL (or authorization code) from the browser",
                })}
                onChange={(event) => setCallbackInput(event.target.value)}
                disabled={isSubmitting}
              />
              <button
                className="api-settings-action-btn secondary"
                type="button"
                onClick={() => void handleSubmitCallback()}
                disabled={isSubmitting || !callbackInput.trim()}
              >
                {isSubmitting ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <CheckCircle2 size={14} />
                )}
                <span>
                  {t("settings.oauthCallbackSubmit", {
                    defaultValue: "Submit",
                  })}
                </span>
              </button>
            </div>
          </div>
          {error ? <p className="oauth-login-error">{error}</p> : null}
        </div>
      );
    }

    if (phase === "channels" || phase === "connecting") {
      return renderChannels();
    }

    if (phase === "success") {
      const connected = status?.connectedProfiles ?? [];
      const skipped = status?.skippedProfiles ?? [];
      return (
        <div className="oauth-login-body">
          <div className="oauth-login-status success">
            <CheckCircle2 size={16} />
            <span>
              {t("settings.snowRouterConnected", {
                defaultValue: "Channels connected",
              })}
            </span>
          </div>
          <p className="oauth-login-hint">
            {t("settings.snowRouterConnectedDetail", {
              defaultValue: "Connected {created}; reused {kept}.",
            })
              .replace("{created}", String(connected.length))
              .replace("{kept}", String(skipped.length))}
          </p>
          {status?.serverUrl ? (
            <p className="oauth-login-hint">{status.serverUrl}</p>
          ) : null}
          {status?.email ? (
            <p className="oauth-login-hint">
              {t("settings.oauthAccount", { defaultValue: "Account" })}:{" "}
              {status.email}
            </p>
          ) : null}
        </div>
      );
    }

    return (
      <div className="oauth-login-body">
        <p className="oauth-login-error">
          {error ||
            t("settings.oauthFailed", {
              defaultValue: "Sign-in failed. Please try again.",
            })}
        </p>
        <p className="oauth-login-hint">
          {t("settings.oauthRetryHint", {
            defaultValue:
              "Start a new sign-in session to retry, or close this dialog.",
          })}
        </p>
      </div>
    );
  };

  const renderFooter = (): React.JSX.Element => {
    if (phase === "success") {
      return (
        <button
          className="api-settings-form-btn primary"
          type="button"
          onClick={handleClose}
        >
          <CheckCircle2 size={15} strokeWidth={1.9} />
          <span>{t("settings.oauthDone", { defaultValue: "Done" })}</span>
        </button>
      );
    }

    if (phase === "channels" || phase === "connecting") {
      return (
        <>
          <button
            className="api-settings-form-btn secondary"
            type="button"
            onClick={handleClose}
            disabled={phase === "connecting"}
          >
            <span>
              {t("settings.oauthCancel", { defaultValue: "Cancel sign-in" })}
            </span>
          </button>
          <button
            className="api-settings-form-btn secondary"
            type="button"
            onClick={toggleAll}
            disabled={phase === "connecting"}
          >
            <Layers size={15} strokeWidth={1.9} />
            <span>
              {allSelected
                ? t("settings.snowRouterClearAll", {
                    defaultValue: "Clear selection",
                  })
                : t("settings.snowRouterSelectAll", {
                    defaultValue: "Select all",
                  })}
            </span>
          </button>
          <button
            className="api-settings-form-btn primary"
            type="button"
            onClick={() => void handleConnect()}
            disabled={phase === "connecting" || selected.size === 0}
          >
            {phase === "connecting" ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <CheckCircle2 size={15} strokeWidth={1.9} />
            )}
            <span>
              {t("settings.snowRouterConnect", {
                defaultValue: "Connect selected",
              })}
            </span>
          </button>
        </>
      );
    }

    if (phase === "waiting") {
      return (
        <button
          className="api-settings-form-btn secondary"
          type="button"
          onClick={handleClose}
          disabled={isSubmitting}
        >
          <span>
            {t("settings.oauthCancel", { defaultValue: "Cancel sign-in" })}
          </span>
        </button>
      );
    }

    if (phase === "error") {
      return (
        <>
          <button
            className="api-settings-form-btn secondary"
            type="button"
            onClick={handleBack}
          >
            <ChevronLeft size={15} strokeWidth={1.9} />
            <span>{t("settings.oauthBack", { defaultValue: "Back" })}</span>
          </button>
          <button
            className="api-settings-form-btn primary"
            type="button"
            onClick={() => void handleStart()}
          >
            <RefreshCw size={15} strokeWidth={1.9} />
            <span>
              {t("settings.oauthRetry", { defaultValue: "Try again" })}
            </span>
          </button>
        </>
      );
    }

    return (
      <>
        <button
          className="api-settings-form-btn secondary"
          type="button"
          onClick={handleBack}
          disabled={isBusy}
        >
          <ChevronLeft size={15} strokeWidth={1.9} />
          <span>{t("settings.oauthBack", { defaultValue: "Back" })}</span>
        </button>
        <button
          className="api-settings-form-btn primary"
          type="button"
          onClick={() => void handleStart()}
          disabled={isBusy || !serverUrl.trim()}
        >
          {phase === "starting" ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <ExternalLink size={15} strokeWidth={1.9} />
          )}
          <span>
            {t("settings.oauthStart", { defaultValue: "Start sign-in" })}
          </span>
        </button>
      </>
    );
  };

  return (
    <Modal
      open={open}
      title={t("settings.snowRouterTitle", {
        defaultValue: "Snow AI Router sign-in",
      })}
      description={t("settings.snowRouterDescription", {
        defaultValue:
          "Connect the router account and import its channels as Snow App API profiles.",
      })}
      closeLabel={t("settings.close", { defaultValue: "Close" })}
      onClose={handleClose}
      closeDisabled={isBusy}
      className="oauth-login-dialog"
      footer={renderFooter()}
    >
      {renderBody()}
    </Modal>
  );
}
