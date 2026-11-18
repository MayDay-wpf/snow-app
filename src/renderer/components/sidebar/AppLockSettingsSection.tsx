import {
  LoaderCircle,
  LockKeyhole,
  QrCode,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Unlock,
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppLockTotpBinding, AppLockVerifyResult } from "../../../preload";
import { useAppLock } from "../../hooks/useAppLock";
import { useI18n } from "../../i18n";
import { ApiSettingsHintIcon } from "./apiSettings/ApiSettingsFieldLabel";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { CustomSelect } from "../common/CustomSelect";

const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 8;
const TOTP_CODE_LENGTH = 6;

const STATE_LOADING_DEFAULT = "Reading the status...";
const STATE_UNAVAILABLE_DEFAULT =
  "Failed to read the app lock status. Retrieve it again.";

const LOCK_DELAY_OPTIONS = [
  {
    value: "0",
    labelKey: "settings.appLockDelayImmediate",
    defaultLabel: "As soon as the window loses focus",
  },
  {
    value: "60000",
    labelKey: "settings.appLockDelay1m",
    defaultLabel: "1 minute after losing focus",
  },
  {
    value: "300000",
    labelKey: "settings.appLockDelay5m",
    defaultLabel: "5 minutes after losing focus",
  },
  {
    value: "600000",
    labelKey: "settings.appLockDelay10m",
    defaultLabel: "10 minutes after losing focus",
  },
];

type Notice = { tone: "error" | "success"; text: string } | null;

const digitsOnly = (value: string, maxLength: number): string =>
  value.replace(/\D/g, "").slice(0, maxLength);

export function AppLockSettingsSection(): React.JSX.Element {
  const { t } = useI18n();
  const { state, loading, refresh, lockNow } = useAppLock();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const [binding, setBinding] = useState<AppLockTotpBinding | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [bindCode, setBindCode] = useState("");
  const [verifyValue, setVerifyValue] = useState("");
  // 开始绑定时的验证值：确认绑定时回传后端复核，避免中途改动输入绕过校验
  const pendingVerificationRef = useRef("");

  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [changePin, setChangePin] = useState("");
  const [changeConfirmPin, setChangeConfirmPin] = useState("");
  const [disablePin, setDisablePin] = useState("");
  const [unbindCode, setUnbindCode] = useState("");

  const ready = state !== null;
  const enabled = state?.enabled === true;
  const totpBound = state?.totpBound === true;

  useEffect(() => {
    if (!binding) {
      setQrDataUrl("");
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(binding.otpauthUri, {
      width: 360,
      margin: 1,
      errorCorrectionLevel: "M",
    }).then((value) => {
      if (!cancelled) {
        setQrDataUrl(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [binding]);

  const fail = useCallback((error: unknown): void => {
    setNotice({
      tone: "error",
      text: error instanceof Error ? error.message : String(error),
    });
  }, []);

  const describeResult = useCallback(
    (result: AppLockVerifyResult, incorrectText: string): string => {
      if (result.retryAfterMs > 0) {
        const seconds = Math.ceil(result.retryAfterMs / 1000);
        return t("settings.appLockCooldown", {
          values: { seconds },
          defaultValue: `Too many attempts. Try again in ${seconds}s`,
        });
      }
      if (result.remainingAttempts > 0) {
        return t("settings.appLockAttemptsLeft", {
          values: { count: result.remainingAttempts },
          defaultValue: `Incorrect. ${result.remainingAttempts} attempt(s) left`,
        });
      }
      return incorrectText;
    },
    [t],
  );

  const incorrectPin = useCallback(
    (): string =>
      t("settings.appLockWrongPin", { defaultValue: "Incorrect PIN" }),
    [t],
  );

  const incorrectCode = useCallback(
    (): string =>
      t("settings.appLockWrongCode", { defaultValue: "Incorrect code" }),
    [t],
  );

  const incorrectCredential = useCallback(
    (): string =>
      t("settings.appLockWrongCredential", {
        defaultValue: "Incorrect PIN or code",
      }),
    [t],
  );

  const stateUnavailable = useCallback((): Notice => {
    return {
      tone: "error",
      text: t("settings.appLockStateUnavailable", {
        defaultValue: STATE_UNAVAILABLE_DEFAULT,
      }),
    };
  }, [t]);

  const stateLabel = useCallback(
    (isOn: boolean, onLabel: string, offLabel: string): string => {
      if (ready) {
        return isOn ? onLabel : offLabel;
      }
      return loading
        ? t("settings.appLockStateLoading", {
            defaultValue: STATE_LOADING_DEFAULT,
          })
        : t("settings.appLockStateUnavailable", {
            defaultValue: STATE_UNAVAILABLE_DEFAULT,
          });
    },
    [loading, ready, t],
  );

  const handleDelayChange = async (value: string): Promise<void> => {
    const delayMs = Number.parseInt(value, 10);
    if (!Number.isFinite(delayMs)) {
      return;
    }
    setBusy(true);
    try {
      await window.snow.setAppLockDelay(delayMs);
      await refresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const handleRemoteUnlockChange = async (next: boolean): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await window.snow.setAppLockRemoteUnlock(next);
      await refresh();
      setNotice({
        tone: "success",
        text: next
          ? t("settings.appLockRemoteUnlockOn", {
              defaultValue: "Remote unlock with the authenticator enabled",
            })
          : t("settings.appLockRemoteUnlockOff", {
              defaultValue: "Remote unlock with the authenticator disabled",
            }),
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const handleLockNow = async (): Promise<void> => {
    setBusy(true);
    try {
      await lockNow();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const startBinding = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const current = await refresh();
      if (!current) {
        setNotice(stateUnavailable());
        return;
      }
      if (current.totpBound) {
        if (verifyValue.length === 0) {
          setNotice({
            tone: "error",
            text: t("settings.appLockVerifyRequired", {
              defaultValue: "Enter the current PIN or 6-digit code first",
            }),
          });
          return;
        }
        const verify = current.enabled
          ? await window.snow.verifyAppLockPin(verifyValue)
          : await window.snow.verifyAppLockTotp(verifyValue);
        if (!verify.ok) {
          setNotice({
            tone: "error",
            text: describeResult(
              verify,
              current.enabled ? incorrectPin() : incorrectCode(),
            ),
          });
          return;
        }
      }
      const next = await window.snow.beginAppLockTotpBinding();
      pendingVerificationRef.current = verifyValue;
      setBinding(next);
      setBindCode("");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const unbindTotp = async (): Promise<void> => {
    if (unbindCode.length !== TOTP_CODE_LENGTH) {
      setNotice({
        tone: "error",
        text: t("settings.appLockUnbindCodeRequired", {
          defaultValue: "Enter the 6-digit code from the authenticator",
        }),
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const current = await refresh();
      if (!current) {
        setNotice(stateUnavailable());
        return;
      }
      if (!current.totpBound) {
        setUnbindCode("");
        setNotice({
          tone: "success",
          text: t("settings.appLockTotpUnboundDone", {
            defaultValue: "Authenticator unbound and the app lock disabled",
          }),
        });
        return;
      }
      const result = await window.snow.clearAppLockTotp(unbindCode);
      if (!result.ok) {
        setNotice({
          tone: "error",
          text: describeResult(result, incorrectCode()),
        });
        return;
      }
      setVerifyValue("");
      setUnbindCode("");
      pendingVerificationRef.current = "";
      await refresh();
      setNotice({
        tone: "success",
        text: t("settings.appLockTotpUnboundDone", {
          defaultValue: "Authenticator unbound and the app lock disabled",
        }),
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const confirmBinding = async (): Promise<void> => {
    if (!binding) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const ok = await window.snow.confirmAppLockTotpBinding(
        binding.secret,
        bindCode,
        pendingVerificationRef.current,
      );
      if (!ok) {
        setNotice({
          tone: "error",
          text: t("settings.appLockTotpBindFailed", {
            defaultValue: "The code is incorrect. Check the clock and retry.",
          }),
        });
        return;
      }
      setBinding(null);
      setBindCode("");
      setVerifyValue("");
      pendingVerificationRef.current = "";
      await refresh();
      setNotice({
        tone: "success",
        text: t("settings.appLockTotpBoundDone", {
          defaultValue: "Google Authenticator bound",
        }),
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const enableLock = async (): Promise<void> => {
    if (newPin.length < PIN_MIN_LENGTH || newPin !== confirmPin) {
      setNotice({
        tone: "error",
        text:
          newPin !== confirmPin
            ? t("settings.appLockPinMismatch", {
                defaultValue: "The two PIN entries do not match",
              })
            : t("settings.appLockPinInvalid", {
                defaultValue: "PIN must be 4-8 digits",
              }),
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const current = await refresh();
      if (!current) {
        setNotice(stateUnavailable());
        return;
      }
      if (!current.totpBound) {
        setNotice({
          tone: "error",
          text: t("settings.appLockTotpRequired", {
            defaultValue:
              "Bind Google Authenticator before enabling the app lock.",
          }),
        });
        return;
      }
      if (!current.enabled) {
        await window.snow.enableAppLock(newPin);
        setNewPin("");
        setConfirmPin("");
      }
      await refresh();
      setNotice({
        tone: "success",
        text: t("settings.appLockEnabledDone", {
          defaultValue: "App lock enabled",
        }),
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const changeLockPin = async (): Promise<void> => {
    if (
      changePin.length < PIN_MIN_LENGTH ||
      changePin !== changeConfirmPin ||
      currentPin.length === 0
    ) {
      setNotice({
        tone: "error",
        text:
          changePin !== changeConfirmPin
            ? t("settings.appLockPinMismatch", {
                defaultValue: "The two PIN entries do not match",
              })
            : t("settings.appLockPinInvalid", {
                defaultValue: "PIN must be 4-8 digits",
              }),
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const current = await refresh();
      if (!current) {
        setNotice(stateUnavailable());
        return;
      }
      if (!current.enabled) {
        return;
      }
      const result = await window.snow.changeAppLockPin(currentPin, changePin);
      if (!result.ok) {
        setNotice({
          tone: "error",
          text: describeResult(result, incorrectCredential()),
        });
        return;
      }
      setCurrentPin("");
      setChangePin("");
      setChangeConfirmPin("");
      await refresh();
      setNotice({
        tone: "success",
        text: t("settings.appLockPinChanged", { defaultValue: "PIN updated" }),
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const disableLock = async (): Promise<void> => {
    if (disablePin.length === 0) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const current = await refresh();
      if (!current) {
        setNotice(stateUnavailable());
        return;
      }
      if (!current.enabled) {
        setDisablePin("");
        setNotice({
          tone: "success",
          text: t("settings.appLockDisabledDone", {
            defaultValue: "App lock disabled",
          }),
        });
        return;
      }
      const result = await window.snow.disableAppLock(disablePin);
      if (!result.ok) {
        setNotice({
          tone: "error",
          text: describeResult(result, incorrectCredential()),
        });
        return;
      }
      setDisablePin("");
      await refresh();
      setNotice({
        tone: "success",
        text: t("settings.appLockDisabledDone", {
          defaultValue: "App lock disabled",
        }),
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AutoDismissNotice
        message={notice?.text ?? ""}
        tone={notice?.tone ?? "info"}
        onDismiss={() => setNotice(null)}
      />

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.appLockTitle", { defaultValue: "App lock" })}
            <ApiSettingsHintIcon
              hint={t("settings.appLockInfo", {
                defaultValue:
                  "Lock Snow App behind a PIN. Locking only hides the interface with a frosted-glass cover - running sessions and enabled features keep working.",
              })}
            />
          </strong>
        </div>

        <div className="api-settings-form-body">
          <div className="settings-about-row">
            <span className="settings-item-description">
              {t("settings.appLockStatus", { defaultValue: "Lock status" })}
            </span>
            <span
              className={`app-lock-badge ${ready && enabled ? "is-on" : ""}`}
            >
              {stateLabel(
                enabled,
                t("settings.enabled", { defaultValue: "Enabled" }),
                t("settings.disabled", { defaultValue: "Disabled" }),
              )}
            </span>
          </div>

          <div className="settings-about-row">
            <span className="settings-item-description">
              {t("settings.appLockDelay", { defaultValue: "Lock timing" })}
            </span>
            <div className="settings-close-behavior-select">
              <CustomSelect
                value={String(state?.delayMs ?? 60000)}
                options={LOCK_DELAY_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey, {
                    defaultValue: option.defaultLabel,
                  }),
                }))}
                onChange={(value) => void handleDelayChange(value)}
                disabled={busy || !ready || !enabled}
              />
            </div>
          </div>

          {ready && enabled && (
            <div className="settings-update-actions">
              <button
                className="app-lock-action"
                type="button"
                onClick={() => void handleLockNow()}
                disabled={busy}
              >
                <LockKeyhole size={14} strokeWidth={1.8} />
                <span>
                  {t("settings.appLockLockNow", { defaultValue: "Lock now" })}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.appLockTotpTitle", {
              defaultValue: "Google Authenticator",
            })}
            <ApiSettingsHintIcon
              hint={t("settings.appLockTotpInfo", {
                defaultValue:
                  "Google Authenticator is the fallback when the PIN is lost, so binding it is required before the app lock can be enabled.",
              })}
            />
          </strong>
        </div>

        <div className="api-settings-form-body">
          <div className="settings-about-row">
            <span className="settings-item-description">
              {t("settings.appLockTotpStatus", {
                defaultValue: "Authenticator status",
              })}
            </span>
            <span
              className={`app-lock-badge ${ready && totpBound ? "is-on" : ""}`}
            >
              {stateLabel(
                totpBound,
                t("settings.appLockTotpBound", { defaultValue: "Bound" }),
                t("settings.appLockTotpUnbound", {
                  defaultValue: "Not bound",
                }),
              )}
            </span>
          </div>

          {ready && totpBound && binding === null && (
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.appLockRemoteUnlock", {
                  defaultValue:
                    "Unlock mobile remote control with the authenticator",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.appLockRemoteUnlockInfo", {
                    defaultValue:
                      "While on, the LAN and public remote pages accept a 6-digit authenticator code in place of the pairing token; while off, only the pairing link or token works.",
                  })}
                />
              </span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={state?.remoteUnlock === true}
                  disabled={busy}
                  onChange={(event) =>
                    void handleRemoteUnlockChange(event.target.checked)
                  }
                  hidden
                />
                <span className="toggle-slider" aria-hidden="true" />
              </label>
            </div>
          )}

          {!ready && (
            <div className="settings-update-actions">
              {loading && (
                <LoaderCircle
                  size={14}
                  strokeWidth={1.8}
                  className="tool-call-icon-spinning"
                />
              )}
              <span className="settings-item-description">
                {loading
                  ? t("settings.appLockStateReading", {
                      defaultValue:
                        "Reading the authenticator binding status...",
                    })
                  : t("settings.appLockStateUnavailable", {
                      defaultValue: STATE_UNAVAILABLE_DEFAULT,
                    })}
              </span>
              {!loading && (
                <button
                  className="app-lock-action"
                  type="button"
                  onClick={() => void refresh()}
                  disabled={busy}
                >
                  <RefreshCw size={14} strokeWidth={1.8} />
                  <span>{t("common.retry", { defaultValue: "Retry" })}</span>
                </button>
              )}
            </div>
          )}

          {ready && binding === null && (
            <>
              {totpBound && (
                <div className="settings-about-row">
                  <span className="settings-item-description">
                    {t("settings.appLockTotpRebindNeedPin", {
                      defaultValue: "Verify the current PIN before rebinding",
                    })}
                  </span>
                  <input
                    className="app-lock-settings-input"
                    type={enabled ? "password" : "text"}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={enabled ? PIN_MAX_LENGTH : TOTP_CODE_LENGTH}
                    value={verifyValue}
                    onChange={(event) =>
                      setVerifyValue(
                        digitsOnly(
                          event.target.value,
                          enabled ? PIN_MAX_LENGTH : TOTP_CODE_LENGTH,
                        ),
                      )
                    }
                    placeholder={
                      enabled
                        ? t("settings.appLockPinPlaceholder", {
                            defaultValue: "PIN",
                          })
                        : t("settings.appLockTotpCodePlaceholder", {
                            defaultValue: "6-digit code",
                          })
                    }
                  />
                </div>
              )}
              <div className="settings-update-actions">
                <button
                  className={`app-lock-action ${totpBound ? "" : "primary"}`}
                  type="button"
                  onClick={() => void startBinding()}
                  disabled={busy || (totpBound && verifyValue.length === 0)}
                >
                  <QrCode size={14} strokeWidth={1.8} />
                  <span>
                    {totpBound
                      ? t("settings.appLockTotpRebind", {
                          defaultValue: "Rebind authenticator",
                        })
                      : t("settings.appLockTotpBind", {
                          defaultValue: "Bind authenticator",
                        })}
                  </span>
                </button>
              </div>
              {totpBound && (
                <>
                  <div className="settings-about-row">
                    <span className="settings-item-description">
                      {t("settings.appLockUnbindVerify", {
                        defaultValue: "Unbind verification (6-digit code)",
                      })}
                      <ApiSettingsHintIcon
                        hint={t("settings.appLockTotpUnbindHint", {
                          defaultValue:
                            "Unbinding requires a code from the authenticator and also clears the PIN, so a forgotten PIN can always be reset here.",
                        })}
                      />
                    </span>
                    <input
                      className="app-lock-settings-input"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={TOTP_CODE_LENGTH}
                      value={unbindCode}
                      onChange={(event) =>
                        setUnbindCode(
                          digitsOnly(event.target.value, TOTP_CODE_LENGTH),
                        )
                      }
                      placeholder={t("settings.appLockTotpCodePlaceholder", {
                        defaultValue: "6-digit code",
                      })}
                    />
                  </div>
                  <div className="settings-update-actions">
                    <button
                      className="app-lock-action danger"
                      type="button"
                      onClick={() => void unbindTotp()}
                      disabled={busy || unbindCode.length !== TOTP_CODE_LENGTH}
                    >
                      <ShieldOff size={14} strokeWidth={1.8} />
                      <span>
                        {t("settings.appLockTotpUnbind", {
                          defaultValue: "Unbind authenticator",
                        })}
                      </span>
                    </button>
                  </div>
                </>
              )}
              {!totpBound && (
                <span className="settings-item-description">
                  {t("settings.appLockTotpRequired", {
                    defaultValue:
                      "Bind Google Authenticator before enabling the app lock.",
                  })}
                </span>
              )}
            </>
          )}

          {binding !== null && (
            <div className="app-lock-bind">
              <span className="settings-item-description">
                {t("settings.appLockTotpScan", {
                  defaultValue:
                    "Scan the QR code with Google Authenticator, or add the key manually.",
                })}
              </span>
              {qrDataUrl && (
                <img
                  className="app-lock-qr"
                  src={qrDataUrl}
                  alt={t("settings.appLockTotpQrAlt", {
                    defaultValue: "Authenticator QR code",
                  })}
                />
              )}
              <code className="app-lock-secret">{binding.secret}</code>
              <div className="settings-about-row">
                <span className="settings-item-description">
                  {t("settings.appLockTotpCode", {
                    defaultValue: "6-digit code",
                  })}
                </span>
                <input
                  className="app-lock-settings-input"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={TOTP_CODE_LENGTH}
                  value={bindCode}
                  onChange={(event) =>
                    setBindCode(
                      digitsOnly(event.target.value, TOTP_CODE_LENGTH),
                    )
                  }
                  placeholder="123456"
                />
              </div>
              <div className="settings-update-actions">
                <button
                  className="app-lock-action primary"
                  type="button"
                  onClick={() => void confirmBinding()}
                  disabled={busy || bindCode.length !== TOTP_CODE_LENGTH}
                >
                  {busy ? (
                    <LoaderCircle
                      size={14}
                      strokeWidth={1.8}
                      className="tool-call-icon-spinning"
                    />
                  ) : (
                    <ShieldCheck size={14} strokeWidth={1.8} />
                  )}
                  <span>
                    {t("settings.appLockTotpConfirm", {
                      defaultValue: "Confirm binding",
                    })}
                  </span>
                </button>
                <button
                  className="app-lock-action"
                  type="button"
                  onClick={() => {
                    setBinding(null);
                    setBindCode("");
                  }}
                  disabled={busy}
                >
                  <span>
                    {t("settings.cancel", { defaultValue: "Cancel" })}
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {enabled ? (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <strong>
              {t("settings.appLockManagePin", {
                defaultValue: "Change or disable the PIN",
              })}
              <ApiSettingsHintIcon
                hint={t("settings.appLockManagePinInfo", {
                  defaultValue:
                    "Both actions accept the current PIN or a 6-digit authenticator code. Disabling the lock keeps the authenticator binding.",
                })}
              />
            </strong>
          </div>

          <div className="api-settings-form-body">
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.appLockCurrentPin", {
                  defaultValue: "Current PIN or 6-digit code",
                })}
              </span>
              <input
                className="app-lock-settings-input"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PIN_MAX_LENGTH}
                value={currentPin}
                onChange={(event) =>
                  setCurrentPin(digitsOnly(event.target.value, PIN_MAX_LENGTH))
                }
                placeholder="••••"
              />
            </div>
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.appLockNewPin", { defaultValue: "New PIN" })}
              </span>
              <input
                className="app-lock-settings-input"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PIN_MAX_LENGTH}
                value={changePin}
                onChange={(event) =>
                  setChangePin(digitsOnly(event.target.value, PIN_MAX_LENGTH))
                }
                placeholder={t("settings.appLockPinHint", {
                  defaultValue: "4-8 digits",
                })}
              />
            </div>
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.appLockNewPinConfirm", {
                  defaultValue: "Confirm new PIN",
                })}
              </span>
              <input
                className="app-lock-settings-input"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PIN_MAX_LENGTH}
                value={changeConfirmPin}
                onChange={(event) =>
                  setChangeConfirmPin(
                    digitsOnly(event.target.value, PIN_MAX_LENGTH),
                  )
                }
                placeholder="••••"
              />
            </div>
            <div className="settings-update-actions">
              <button
                className="app-lock-action primary"
                type="button"
                onClick={() => void changeLockPin()}
                disabled={
                  busy ||
                  currentPin.length === 0 ||
                  changePin.length < PIN_MIN_LENGTH
                }
              >
                <ShieldCheck size={14} strokeWidth={1.8} />
                <span>
                  {t("settings.appLockChangePinAction", {
                    defaultValue: "Update PIN",
                  })}
                </span>
              </button>
            </div>

            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.appLockDisablePin", {
                  defaultValue: "PIN or 6-digit code to disable the lock",
                })}
              </span>
              <input
                className="app-lock-settings-input"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PIN_MAX_LENGTH}
                value={disablePin}
                onChange={(event) =>
                  setDisablePin(digitsOnly(event.target.value, PIN_MAX_LENGTH))
                }
                placeholder="••••"
              />
            </div>
            <div className="settings-update-actions">
              <button
                className="app-lock-action danger"
                type="button"
                onClick={() => void disableLock()}
                disabled={busy || disablePin.length === 0}
              >
                <Unlock size={14} strokeWidth={1.8} />
                <span>
                  {t("settings.appLockDisableAction", {
                    defaultValue: "Disable app lock",
                  })}
                </span>
              </button>
            </div>
          </div>
        </div>
      ) : totpBound ? (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <strong>
              {t("settings.appLockEnableTitle", {
                defaultValue: "Set a PIN and enable",
              })}
              <ApiSettingsHintIcon
                hint={t("settings.appLockEnableInfo", {
                  defaultValue:
                    "Choose a 4-8 digit PIN. The PIN is salted and hashed locally and is never stored in plain text.",
                })}
              />
            </strong>
          </div>

          <div className="api-settings-form-body">
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.appLockNewPin", { defaultValue: "New PIN" })}
              </span>
              <input
                className="app-lock-settings-input"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PIN_MAX_LENGTH}
                value={newPin}
                onChange={(event) =>
                  setNewPin(digitsOnly(event.target.value, PIN_MAX_LENGTH))
                }
                placeholder={t("settings.appLockPinHint", {
                  defaultValue: "4-8 digits",
                })}
              />
            </div>
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.appLockNewPinConfirm", {
                  defaultValue: "Confirm new PIN",
                })}
              </span>
              <input
                className="app-lock-settings-input"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PIN_MAX_LENGTH}
                value={confirmPin}
                onChange={(event) =>
                  setConfirmPin(digitsOnly(event.target.value, PIN_MAX_LENGTH))
                }
                placeholder="••••"
              />
            </div>
            <div className="settings-update-actions">
              <button
                className="app-lock-action primary"
                type="button"
                onClick={() => void enableLock()}
                disabled={busy || newPin.length < PIN_MIN_LENGTH}
              >
                {busy ? (
                  <LoaderCircle
                    size={14}
                    strokeWidth={1.8}
                    className="tool-call-icon-spinning"
                  />
                ) : (
                  <LockKeyhole size={14} strokeWidth={1.8} />
                )}
                <span>
                  {t("settings.appLockEnableAction", {
                    defaultValue: "Enable app lock",
                  })}
                </span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
