import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderOpen,
  Key,
  Loader2,
  Lock,
  RefreshCw,
  Server,
  User,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../../i18n";
import { localizeSshError } from "../../../utils/sshErrorMessages";
import type {
  SshAuthMethod,
  SshConfigHost,
  SshConnectErrorCode,
  SshConnectParams,
  SshCredentialRecord,
  SshDirectoryEntry,
} from "../../../../preload";

type WizardStep = "connect" | "browse";

/** 连接失败展示状态：code 决定本地化文案，detail 展示原始技术原因。 */
type ConnectErrorState = {
  code: SshConnectErrorCode | null;
  message: string;
  detail?: string;
};

/** 错误码 -> i18n key 的映射，文案按当前界面语言展示。 */
const SSH_ERROR_I18N_KEYS: Record<SshConnectErrorCode, string> = {
  network: "sidebar.sshErrorNetwork",
  timeout: "sidebar.sshErrorTimeout",
  auth: "sidebar.sshErrorAuth",
  sftp: "sidebar.sshErrorSftp",
  invalid: "sidebar.sshErrorInvalid",
  unknown: "sidebar.sshErrorUnknown",
};

type SshConnectWizardProps = {
  onConfirm: (sshUrl: string) => void;
  onCancel: () => void;
};

type CredentialOption = {
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  hasSecret: boolean;
};

const normalizeRemotePath = (path: string): string => {
  const segments = path.trim().split("/").filter(Boolean);
  return segments.length > 0 ? `/${segments.join("/")}` : "/";
};

const buildSshUrl = (
  host: string,
  port: number,
  username: string,
  remotePath: string
): string =>
  `ssh://${username}@${host}:${port}${normalizeRemotePath(remotePath)}`;

export function SshConnectWizard({
  onConfirm,
  onCancel,
}: SshConnectWizardProps): React.JSX.Element {
  const { t } = useI18n();

  const [step, setStep] = useState<WizardStep>("connect");

  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>("password");
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [rememberCredential, setRememberCredential] = useState(true);

  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<ConnectErrorState | null>(
    null
  );
  const [hostKeyChanged, setHostKeyChanged] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [remotePath, setRemotePath] = useState("/");
  const [pathHistory, setPathHistory] = useState<string[]>(["/"]);
  const [entries, setEntries] = useState<SshDirectoryEntry[]>([]);
  const [isLoadingEntries, setIsLoadingEntries] = useState(false);
  const [entriesError, setEntriesError] = useState<ConnectErrorState | null>(
    null
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const [savedCredentials, setSavedCredentials] = useState<CredentialOption[]>(
    []
  );
  const [showSavedList, setShowSavedList] = useState(false);
  // 本地 ~/.ssh/config 中解析出的主机条目，点击后自动填充表单
  const [configHosts, setConfigHosts] = useState<SshConfigHost[]>([]);
  const [showConfigList, setShowConfigList] = useState(false);
  const directoryRequestIdRef = useRef(0);
  const pendingNavigationPathRef = useRef<string | null>(null);
  const wizardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void window.snow.sshListCredentials().then((creds) => {
      const options: CredentialOption[] = creds.map((c) => ({
        label: `${c.username}@${c.host}:${c.port}`,
        host: c.host,
        port: c.port,
        username: c.username,
        authMethod: c.authMethod,
        privateKeyPath: c.privateKeyPath,
        hasSecret: !!c.encryptedSecret,
      }));
      setSavedCredentials(options);
    });
  }, []);

  useEffect(() => {
    void window.snow.sshListConfigHosts().then(setConfigHosts);
  }, []);

  /** 点击 SSH config 条目：用解析出的字段填充表单（保留用户已填内容）。 */
  const handleLoadConfigHost = (entry: SshConfigHost): void => {
    setHost(entry.host);
    setPort(entry.port);
    setUsername(entry.user ?? username);
    if (entry.identityFile) {
      setAuthMethod("privateKey");
      setPrivateKeyPath(entry.identityFile);
    } else {
      setAuthMethod("agent");
    }
    setPassword("");
    setPassphrase("");
    setShowConfigList(false);
  };

  const loadEntries = useCallback(
    async (path: string): Promise<boolean> => {
      if (!sessionId) {
        return false;
      }
      const normalizedPath = normalizeRemotePath(path);
      const requestId = ++directoryRequestIdRef.current;
      setIsLoadingEntries(true);
      setEntriesError(null);
      try {
        const result = await window.snow.sshListDirectory(
          sessionId,
          normalizedPath
        );
        if (requestId !== directoryRequestIdRef.current) {
          return false;
        }
        setEntries(
          result.map((entry) => ({
            ...entry,
            path: normalizeRemotePath(entry.path),
          }))
        );
        setRemotePath(normalizedPath);
        return true;
      } catch (err) {
        if (requestId !== directoryRequestIdRef.current) {
          return false;
        }
        const localized = localizeSshError(err, t);
        setEntriesError({
          code: null,
          message: localized.message,
          detail: localized.detail,
        });
        setEntries([]);
        return false;
      } finally {
        if (requestId === directoryRequestIdRef.current) {
          setIsLoadingEntries(false);
        }
      }
    },
    [sessionId, t]
  );

  useEffect(() => {
    if (step === "browse" && sessionId) {
      void loadEntries("/");
    }
  }, [step, sessionId, loadEntries]);

  useEffect(() => {
    return () => {
      if (sessionId) {
        void window.snow.sshDisconnect(sessionId);
      }
    };
  }, [sessionId]);

  const canConnect = useMemo(() => {
    if (!host.trim() || !username.trim()) {
      return false;
    }
    if (authMethod === "password") {
      return password.length > 0;
    }
    if (authMethod === "privateKey") {
      return !!privateKeyPath.trim();
    }
    return true;
  }, [host, username, authMethod, password, privateKeyPath]);

  const handleSelectPrivateKey = async (): Promise<void> => {
    const selected = await window.snow.sshSelectPrivateKey(
      t("sidebar.sshSelectPrivateKey", {
        defaultValue: "Select private key file",
      })
    );
    if (selected) {
      setPrivateKeyPath(selected);
    }
  };

  const handleLoadCredential = async (
    cred: CredentialOption
  ): Promise<void> => {
    setHost(cred.host);
    setPort(cred.port);
    setUsername(cred.username);
    setAuthMethod(cred.authMethod);
    setPrivateKeyPath(cred.privateKeyPath ?? "");
    setPassword("");
    setPassphrase("");
    setShowSavedList(false);

    if (cred.hasSecret) {
      const secret = await window.snow.sshGetDecryptedSecret(
        cred.host,
        cred.port,
        cred.username
      );
      if (secret) {
        if (cred.authMethod === "password") {
          setPassword(secret);
        } else {
          setPassphrase(secret);
        }
      }
    }
  };

  const handleConnect = async (
    hostKeyPolicy?: "replace"
  ): Promise<void> => {
    setIsConnecting(true);
    setConnectError(null);
    setHostKeyChanged(false);

    const params: SshConnectParams = {
      host: host.trim(),
      port,
      username: username.trim(),
      authMethod,
    };
    if (hostKeyPolicy) {
      params.hostKeyPolicy = hostKeyPolicy;
    }

    if (authMethod === "password") {
      params.password = password;
    } else if (authMethod === "privateKey") {
      params.privateKeyPath = privateKeyPath.trim();
      if (passphrase) {
        params.passphrase = passphrase;
      }
    }

    try {
      // 使用 sshConnectDetailed 直接消费结构化结果：contextBridge 序列化
      // Error 会丢弃自定义属性（code/detail），不能在失败时依赖 err.code。
      const result = await window.snow.sshConnectDetailed(params);
      if (!result.ok) {
        setHostKeyChanged(result.detail.includes("Host key changed"));
        setConnectError({
          code: result.code,
          message: t(SSH_ERROR_I18N_KEYS[result.code], {
            defaultValue: result.message,
          }),
          detail: result.detail,
        });
        return;
      }

      const id = result.sessionId;
      setSessionId(id);
      setHostKeyChanged(false);

      if (rememberCredential) {
        const secret =
          authMethod === "password" ? password : passphrase || undefined;
        await window.snow.sshSaveCredential({
          host: host.trim(),
          port,
          username: username.trim(),
          authMethod,
          privateKeyPath: privateKeyPath.trim() || undefined,
          secret,
        });
      }

      setStep("browse");
    } catch (err) {
      // 后续操作（如保存凭证）仍可能抛异常，兜底展示原始消息。
      const message =
        err instanceof Error
          ? err.message
          : t("sidebar.sshConnectError", {
              defaultValue: "Failed to connect to SSH server",
            });
      setHostKeyChanged(
        message.includes("Host key changed") ||
          message.startsWith("[SSH_HOST_KEY_CHANGED]")
      );
      setConnectError({
        code: null,
        message,
      });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleEntryClick = (
    entry: SshDirectoryEntry,
    event: React.MouseEvent<HTMLDivElement>
  ): void => {
    // The first click already opens a directory. Ignore the second click from
    // a double-click so a fast response cannot navigate into a same-named child.
    if (event.detail > 1) {
      return;
    }

    const entryPath = normalizeRemotePath(entry.path);
    if (entry.isDirectory) {
      if (
        entryPath === remotePath ||
        pendingNavigationPathRef.current === entryPath
      ) {
        setSelectedPath(entryPath);
        return;
      }

      pendingNavigationPathRef.current = entryPath;
      setSelectedPath(entryPath);
      void loadEntries(entryPath)
        .then((loaded) => {
          if (loaded) {
            setPathHistory((prev) =>
              prev[prev.length - 1] === entryPath ? prev : [...prev, entryPath]
            );
          }
        })
        .finally(() => {
          if (pendingNavigationPathRef.current === entryPath) {
            pendingNavigationPathRef.current = null;
          }
        });
    } else {
      setSelectedPath(entryPath);
    }
  };

  const handleBreadcrumbClick = (path: string): void => {
    const normalizedPath = normalizeRemotePath(path);
    pendingNavigationPathRef.current = normalizedPath;
    void loadEntries(normalizedPath)
      .then((loaded) => {
        if (loaded) {
          setPathHistory((prev) => {
            const index = prev.indexOf(normalizedPath);
            return index >= 0 ? prev.slice(0, index + 1) : prev;
          });
        }
      })
      .finally(() => {
        if (pendingNavigationPathRef.current === normalizedPath) {
          pendingNavigationPathRef.current = null;
        }
      });
  };

  const handleRefresh = (): void => {
    void loadEntries(normalizeRemotePath(remotePath));
  };

  const handleConfirm = (): void => {
    if (!selectedPath) {
      return;
    }
    const sshUrl = buildSshUrl(
      host.trim(),
      port,
      username.trim(),
      selectedPath
    );
    if (sessionId) {
      void window.snow.sshDisconnect(sessionId);
      setSessionId(null);
    }
    onConfirm(sshUrl);
  };

  const handleCancel = (): void => {
    if (sessionId) {
      void window.snow.sshDisconnect(sessionId);
    }
    onCancel();
  };

  const handleBack = (): void => {
    directoryRequestIdRef.current += 1;
    pendingNavigationPathRef.current = null;
    if (sessionId) {
      void window.snow.sshDisconnect(sessionId);
      setSessionId(null);
    }
    setStep("connect");
    setEntries([]);
    setSelectedPath(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      handleCancel();
    }
  };

  return (
    <div
      className="ssh-wizard-overlay"
      onKeyDown={handleKeyDown}
      ref={wizardRef}
      tabIndex={-1}
    >
      <div className="ssh-wizard-dialog">
        <div className="ssh-wizard-header">
          <div className="ssh-wizard-title">
            <Server size={16} />
            <span>
              {t("sidebar.sshWizardTitle", {
                defaultValue: "Add SSH Remote Directory",
              })}
            </span>
          </div>
          <button
            className="icon-btn ghost"
            onClick={handleCancel}
            type="button"
            aria-label={t("sidebar.sshWizardClose", {
              defaultValue: "Close",
            })}
          >
            <X size={16} />
          </button>
        </div>

        <div className="ssh-wizard-steps">
          <div
            className={`ssh-wizard-step-indicator${
              step === "connect" ? " active" : " done"
            }`}
          >
            <span className="ssh-wizard-step-number">
              {step === "connect" ? "1" : <Check size={12} />}
            </span>
            <span className="ssh-wizard-step-label">
              {t("sidebar.sshStepConnect", {
                defaultValue: "Connect",
              })}
            </span>
          </div>
          <div
            className={`ssh-wizard-step-line${
              step === "browse" ? " active" : ""
            }`}
          />
          <div
            className={`ssh-wizard-step-indicator${
              step === "browse" ? " active" : ""
            }`}
          >
            <span className="ssh-wizard-step-number">2</span>
            <span className="ssh-wizard-step-label">
              {t("sidebar.sshStepBrowse", {
                defaultValue: "Browse",
              })}
            </span>
          </div>
        </div>

        {step === "connect" ? (
          <div className="ssh-wizard-body">
            {savedCredentials.length > 0 ? (
              <div className="ssh-wizard-saved-section">
                <button
                  className="ssh-wizard-saved-toggle"
                  onClick={() => setShowSavedList((v) => !v)}
                  type="button"
                >
                  <Server size={13} />
                  <span>
                    {t("sidebar.sshSavedConnections", {
                      defaultValue: "Saved connections ({{count}})",
                      values: { count: savedCredentials.length },
                    })}
                  </span>
                  <ChevronRight
                    size={13}
                    style={{
                      transform: showSavedList ? "rotate(90deg)" : "none",
                      transition: "transform 0.15s",
                    }}
                  />
                </button>
                {showSavedList ? (
                  <div className="ssh-wizard-saved-list">
                    {savedCredentials.map((cred) => (
                      <button
                        className="ssh-wizard-saved-item"
                        key={cred.label}
                        onClick={() => void handleLoadCredential(cred)}
                        type="button"
                      >
                        <Server size={12} />
                        <span>{cred.label}</span>
                        <span className="ssh-wizard-saved-method">
                          {cred.authMethod}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {configHosts.length > 0 ? (
              <div className="ssh-wizard-saved-section">
                <button
                  className="ssh-wizard-saved-toggle"
                  onClick={() => setShowConfigList((v) => !v)}
                  type="button"
                >
                  <Key size={13} />
                  <span>
                    {t("sidebar.sshConfigSection", {
                      defaultValue: "Hosts from SSH config ({{count}})",
                      values: { count: configHosts.length },
                    })}
                  </span>
                  <ChevronRight
                    size={13}
                    style={{
                      transform: showConfigList ? "rotate(90deg)" : "none",
                      transition: "transform 0.15s",
                    }}
                  />
                </button>
                {showConfigList ? (
                  <div className="ssh-wizard-saved-list">
                    {configHosts.map((entry) => (
                      <button
                        className="ssh-wizard-saved-item"
                        key={entry.alias}
                        onClick={() => handleLoadConfigHost(entry)}
                        type="button"
                        title={
                          entry.identityFile
                            ? `IdentityFile: ${entry.identityFile}`
                            : undefined
                        }
                      >
                        <Server size={12} />
                        <span className="ssh-wizard-saved-name">
                          {entry.alias}
                        </span>
                        <span className="ssh-wizard-saved-method">
                          {entry.user ? `${entry.user}@` : ""}
                          {entry.host}:{entry.port}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="ssh-wizard-field-row">
              <div className="ssh-wizard-field">
                <label className="ssh-wizard-label">
                  {t("sidebar.sshHost", { defaultValue: "Host" })}
                </label>
                <div className="ssh-wizard-input-wrap">
                  <Server size={13} className="ssh-wizard-input-icon" />
                  <input
                    className="ssh-wizard-input"
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="example.com"
                    spellCheck={false}
                    type="text"
                    value={host}
                  />
                </div>
              </div>
              <div className="ssh-wizard-field ssh-wizard-field-port">
                <label className="ssh-wizard-label">
                  {t("sidebar.sshPort", { defaultValue: "Port" })}
                </label>
                <input
                  className="ssh-wizard-input ssh-wizard-input-port"
                  max={65535}
                  min={1}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val > 0 && val <= 65535) {
                      setPort(val);
                    }
                  }}
                  type="number"
                  value={port}
                />
              </div>
            </div>

            <div className="ssh-wizard-field">
              <label className="ssh-wizard-label">
                {t("sidebar.sshUsername", { defaultValue: "Username" })}
              </label>
              <div className="ssh-wizard-input-wrap">
                <User size={13} className="ssh-wizard-input-icon" />
                <input
                  className="ssh-wizard-input"
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="root"
                  spellCheck={false}
                  type="text"
                  value={username}
                />
              </div>
            </div>

            <div className="ssh-wizard-field">
              <label className="ssh-wizard-label">
                {t("sidebar.sshAuthMethod", {
                  defaultValue: "Authentication method",
                })}
              </label>
              <div className="ssh-wizard-segmented">
                <div
                  className="ssh-wizard-segmented-indicator"
                  data-pos={authMethod}
                />
                <button
                  className={`ssh-wizard-segmented-item${
                    authMethod === "password" ? " active" : ""
                  }`}
                  onClick={() => setAuthMethod("password")}
                  type="button"
                >
                  <Lock size={12} />
                  <span>
                    {t("sidebar.sshAuthPassword", {
                      defaultValue: "Password",
                    })}
                  </span>
                </button>
                <button
                  className={`ssh-wizard-segmented-item${
                    authMethod === "privateKey" ? " active" : ""
                  }`}
                  onClick={() => setAuthMethod("privateKey")}
                  type="button"
                >
                  <Key size={12} />
                  <span>
                    {t("sidebar.sshAuthPrivateKey", {
                      defaultValue: "Private key",
                    })}
                  </span>
                </button>
                <button
                  className={`ssh-wizard-segmented-item${
                    authMethod === "agent" ? " active" : ""
                  }`}
                  onClick={() => setAuthMethod("agent")}
                  type="button"
                >
                  <User size={12} />
                  <span>
                    {t("sidebar.sshAuthAgent", {
                      defaultValue: "SSH agent",
                    })}
                  </span>
                </button>
              </div>
            </div>

            {authMethod === "password" ? (
              <div className="ssh-wizard-field">
                <label className="ssh-wizard-label">
                  {t("sidebar.sshPassword", { defaultValue: "Password" })}
                </label>
                <div className="ssh-wizard-input-wrap">
                  <Lock size={13} className="ssh-wizard-input-icon" />
                  <input
                    className="ssh-wizard-input"
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="********"
                    spellCheck={false}
                    type={showPassword ? "text" : "password"}
                    value={password}
                  />
                  <button
                    className="ssh-wizard-input-toggle"
                    onClick={() => setShowPassword((v) => !v)}
                    type="button"
                  >
                    {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>
            ) : null}

            {authMethod === "privateKey" ? (
              <>
                <div className="ssh-wizard-field">
                  <label className="ssh-wizard-label">
                    {t("sidebar.sshPrivateKeyFile", {
                      defaultValue: "Private key file",
                    })}
                  </label>
                  <div className="ssh-wizard-input-wrap">
                    <Key size={13} className="ssh-wizard-input-icon" />
                    <input
                      className="ssh-wizard-input"
                      onChange={(e) => setPrivateKeyPath(e.target.value)}
                      placeholder="~/.ssh/id_rsa"
                      readOnly
                      spellCheck={false}
                      type="text"
                      value={privateKeyPath}
                    />
                    <button
                      className="ssh-wizard-input-browse"
                      onClick={() => void handleSelectPrivateKey()}
                      type="button"
                    >
                      <Folder size={13} />
                    </button>
                  </div>
                </div>
                <div className="ssh-wizard-field">
                  <label className="ssh-wizard-label">
                    {t("sidebar.sshPassphrase", {
                      defaultValue: "Passphrase (optional)",
                    })}
                  </label>
                  <div className="ssh-wizard-input-wrap">
                    <Lock size={13} className="ssh-wizard-input-icon" />
                    <input
                      className="ssh-wizard-input"
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="********"
                      spellCheck={false}
                      type={showPassphrase ? "text" : "password"}
                      value={passphrase}
                    />
                    <button
                      className="ssh-wizard-input-toggle"
                      onClick={() => setShowPassphrase((v) => !v)}
                      type="button"
                    >
                      {showPassphrase ? (
                        <EyeOff size={13} />
                      ) : (
                        <Eye size={13} />
                      )}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={rememberCredential}
                onChange={(e) => setRememberCredential(e.target.checked)}
              />
              <span className="toggle-slider" />
              <span>
                {t("sidebar.sshRememberCredential", {
                  defaultValue: "Remember credentials (encrypted)",
                })}
              </span>
            </label>

            {connectError ? (
              <div className="ssh-wizard-error" role="alert">
                <AlertCircle size={13} className="ssh-wizard-error-icon" />
                <div className="ssh-wizard-error-content">
                  <span>{connectError.message}</span>
                  {connectError.detail ? (
                    <span className="ssh-wizard-error-detail">
                      {t("sidebar.sshErrorDetail", {
                        defaultValue: "Reason",
                      })}
                      : {connectError.detail}
                    </span>
                  ) : null}
                </div>
                {hostKeyChanged ? (
                  <button
                    className="ssh-wizard-host-key-confirm"
                    disabled={isConnecting}
                    onClick={() => void handleConnect("replace")}
                    type="button"
                  >
                    {t("sidebar.sshTrustNewHostKey", {
                      defaultValue: "Trust new host key",
                    })}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="ssh-wizard-body ssh-wizard-browse-body">
            <div className="ssh-wizard-breadcrumb">
              {pathHistory.map((p, i) => (
                <span key={p} className="ssh-wizard-breadcrumb-item">
                  {i > 0 ? <ChevronRight size={11} /> : null}
                  <button
                    className="ssh-wizard-breadcrumb-btn"
                    onClick={() => handleBreadcrumbClick(p)}
                    type="button"
                  >
                    {p === "/" ? "/" : p.split("/").filter(Boolean).pop() || p}
                  </button>
                </span>
              ))}
              <button
                className="icon-btn ghost ssh-wizard-refresh"
                disabled={isLoadingEntries}
                onClick={handleRefresh}
                type="button"
                aria-label={t("sidebar.explorerRefresh", {
                  defaultValue: "Refresh",
                })}
              >
                {isLoadingEntries ? (
                  <Loader2 className="spin" size={13} />
                ) : (
                  <RefreshCw size={13} />
                )}
              </button>
            </div>

            {entriesError ? (
              <div className="ssh-wizard-error" role="alert">
                <AlertCircle size={13} className="ssh-wizard-error-icon" />
                <div className="ssh-wizard-error-content">
                  <span>{entriesError.message}</span>
                  {entriesError.detail ? (
                    <span className="ssh-wizard-error-detail">
                      {t("sidebar.sshErrorDetail", {
                        defaultValue: "Reason",
                      })}
                      : {entriesError.detail}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="ssh-wizard-entries">
              {isLoadingEntries && entries.length === 0 ? (
                <div className="ssh-wizard-loading">
                  <Loader2 className="spin" size={16} />
                  <span>
                    {t("sidebar.sshLoadingEntries", {
                      defaultValue: "Loading...",
                    })}
                  </span>
                </div>
              ) : entries.length === 0 ? (
                <span className="ssh-wizard-empty">
                  {t("sidebar.sshNoEntries", {
                    defaultValue: "Directory is empty",
                  })}
                </span>
              ) : (
                entries.map((entry) => {
                  const isSelected = selectedPath === entry.path;
                  return (
                    <div
                      className={`ssh-wizard-entry${
                        isSelected ? " selected" : ""
                      }${!entry.isDirectory ? " file" : ""}`}
                      key={entry.path}
                      onClick={(event) => handleEntryClick(entry, event)}
                      title={entry.path}
                    >
                      {entry.isDirectory ? (
                        isSelected ? (
                          <FolderOpen
                            size={14}
                            className="ssh-wizard-entry-icon"
                          />
                        ) : (
                          <Folder size={14} className="ssh-wizard-entry-icon" />
                        )
                      ) : (
                        <File size={14} className="ssh-wizard-entry-icon" />
                      )}
                      <span className="ssh-wizard-entry-name">
                        {entry.name}
                      </span>
                      {!entry.isDirectory ? (
                        <span className="ssh-wizard-entry-size">
                          {entry.size < 1024
                            ? `${entry.size} B`
                            : entry.size < 1024 * 1024
                            ? `${(entry.size / 1024).toFixed(1)} KB`
                            : `${(entry.size / (1024 * 1024)).toFixed(1)} MB`}
                        </span>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>

            <div className="ssh-wizard-selected-path">
              <span className="ssh-wizard-selected-label">
                {t("sidebar.sshSelectedPath", {
                  defaultValue: "Selected:",
                })}
              </span>
              <code>{selectedPath ?? remotePath}</code>
            </div>
          </div>
        )}

        <div className="ssh-wizard-footer">
          <button
            className="api-settings-form-btn secondary"
            onClick={handleCancel}
            type="button"
          >
            {t("sidebar.sshCancel", { defaultValue: "Cancel" })}
          </button>
          {step === "browse" ? (
            <button
              className="api-settings-form-btn secondary"
              onClick={handleBack}
              type="button"
            >
              <ArrowLeft size={14} />
              <span>{t("sidebar.sshBack", { defaultValue: "Back" })}</span>
            </button>
          ) : null}
          {step === "connect" ? (
            <button
              className="api-settings-form-btn primary"
              disabled={!canConnect || isConnecting}
              onClick={() => void handleConnect()}
              type="button"
            >
              {isConnecting ? (
                <Loader2 className="spin" size={14} />
              ) : (
                <ArrowRight size={14} />
              )}
              <span>
                {t("sidebar.sshConnect", { defaultValue: "Connect" })}
              </span>
            </button>
          ) : (
            <button
              className="api-settings-form-btn primary"
              disabled={!selectedPath}
              onClick={handleConfirm}
              type="button"
            >
              <Check size={14} />
              <span>
                {t("sidebar.sshConfirm", { defaultValue: "Confirm" })}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
